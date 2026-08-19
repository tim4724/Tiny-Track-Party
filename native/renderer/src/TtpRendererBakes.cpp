// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"

#include <atomic>

#include <utils/Log.h>

// The car's ground shadow, shaped like the CAR. SceneRenderer._bakeCarShadow
// puts an orthographic camera over the model, renders a flat white mask on
// transparent, and reads it back for the blur; the same picture here comes from
// an offscreen RenderTarget rendered with renderStandaloneView (no readback on
// this side, so the blur is a second render pass instead).
//
// The framing is the JS's: footprint × SHADOW_OVERSCAN, so the silhouette lands
// at footprint scale inside a quad with room for the penumbra tail. The camera
// looks UP from under the model rather than down on it: the outline is the same
// either way, and this is the handedness that makes the blob mesh's own UVs
// (u across → car right, v along → car forward) land unmirrored.
//
// Alpha is the coverage channel — opaque glTF materials write 1.0 there and the
// clear leaves 0 — which is why the bake needs no lights and doesn't care that
// an unlit car in an empty scene renders black.
void TtpRenderer::bakeSilhouette(gltfio::FilamentAsset* asset,
        const float3& bbMin, const float3& bbMax, int maskLayer) {
    if (!asset) return;
    bakeSilhouette(asset->getEntities(), asset->getEntityCount(), bbMin, bbMax,
            maskLayer);
}

void TtpRenderer::bakeSilhouette(const utils::Entity* entities, size_t count,
        const float3& bbMin, const float3& bbMax, int maskLayer) {
    if (!entities || !count || !mRenderer || bbMax.x <= bbMin.x) return;
    // The bake feeds vroad's masked decal loop — since the hybrid shadow LOD,
    // the NEAR cars' true silhouettes (far cars ride the CPU-rasterized
    // carShadow layer, whose source is the CPU superellipse). The gate is a
    // capability check: a vroad without the masked arrays has no reader, so
    // the two render passes and the flushAndWait per car, per scene, are
    // skipped. A slot outside the array or a missing blur material likewise
    // means there is nothing to bake into.
    ensurePresentQuad();
    if (maskLayer < 0 || maskLayer >= kMaskLayers || !roadHasMaskLoop()
            || !mBlurMaterial || !mPresentVB || !mPresentIB
            || !ensureDecalMaskArray()) {
        // LOGGED, because this starve is invisible: the generic-superellipse
        // fallback draws a plausible oval and no automated gate can tell it
        // from the baked silhouette — only a player two units from their own
        // car can (it cost two rounds of that player's eye to find). Name the
        // reason so the NEXT starve is one logcat read.
        utils::slog.w << "bakeSilhouette skipped layer " << maskLayer
                << " maskLoop=" << (int) roadHasMaskLoop()
                << " blur=" << (mBlurMaterial != nullptr)
                << " quad=" << (mPresentVB != nullptr)
                << utils::io::endl;
        return;
    }
    // 128 was the pixelation: a hard-edged 128-px mask softened by a 25-tap
    // gaussian resolves its edge in about five quantised steps, and those steps
    // are the banding in the blob's gradient. 256 plus the bake-time blur below
    // gives the hardware something smooth to interpolate, and still only costs
    // ~0.5 MB a car.
    constexpr int TW = 256;
    const float hw = (bbMax.x - bbMin.x) * 0.5f * 1.45f;
    const float hl = (bbMax.z - bbMin.z) * 0.5f * 1.45f;
    if (hw <= 0 || hl <= 0) return;
    const int TH = std::max(16, (int) std::lround(TW * (hl / hw)));
    Texture* tex = Texture::Builder()
            .width((uint32_t) TW).height((uint32_t) TH).levels(1)
            .format(Texture::InternalFormat::RGBA8)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .build(*mEngine);
    if (!tex) return;
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, tex)
            .build(*mEngine);
    Scene* scene = mEngine->createScene();
    utils::Entity camEnt = utils::EntityManager::get().create();
    Camera* cam = mEngine->createCamera(camEnt);
    View* view = mEngine->createView();
    const float cx = (bbMin.x + bbMax.x) * 0.5f, cz = (bbMin.z + bbMax.z) * 0.5f;
    const float h = (bbMax.y - bbMin.y) + 2.0f;
    scene->addEntities(entities, count);
    cam->setProjection(Camera::Projection::ORTHO, -hw, hw, -hl, hl, 0.01, h);
    cam->lookAt({ cx, bbMin.y - 1.0f, cz }, { cx, bbMax.y, cz }, { 0, 0, -1 });
    view->setScene(scene);
    view->setCamera(cam);
    view->setViewport({ 0, 0, (uint32_t) TW, (uint32_t) TH });
    view->setRenderTarget(rt);
    view->setPostProcessingEnabled(false); // tone mapping would eat the alpha
    view->setShadowingEnabled(false);
    view->setBlendMode(View::BlendMode::TRANSLUCENT); // OPAQUE forces alpha to 1
    const Renderer::ClearOptions prev = mRenderer->getClearOptions();
    Renderer::ClearOptions co{};
    co.clearColor = { 0, 0, 0, 0 };
    co.clear = true;
    mRenderer->setClearOptions(co);
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);
    for (size_t i = 0; i < count; i++) scene->remove(entities[i]);
    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    mEngine->destroy(scene);

    // Blur it ONCE, here, instead of rebuilding the penumbra with a 25-tap
    // gaussian in every fragment of every frame (see vblur.mat) — straight
    // into the decalMask array layer the road-shader shadow decal samples.
    // The cell is a fixed kMaskCellW x kMaskCellH, so the bake stretches into
    // it and the decal stretches it back onto the footprint rect — net
    // identity.
    RenderTarget* art = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, mDecalMaskArray)
            .layer(RenderTarget::AttachmentPoint::COLOR, (uint32_t) maskLayer)
            .build(*mEngine);
    if (art) {
        MaterialInstance* bmi = mBlurMaterial->createInstance();
        TextureSampler ssmp(TextureSampler::MinFilter::LINEAR,
                TextureSampler::MagFilter::LINEAR);
        ssmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        ssmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        bmi->setParameter("src", tex, ssmp);
        bmi->setParameter("texel",
                math::float2{ 1.0f / (float) TW, 1.0f / (float) TH });
        // PENUMBRA WIDTH, and it is a look decision as much as a filtering one.
        // At 0.9 the kernel spans about a source texel, and the mask is
        // stretched across ~250 screen pixels on a close chase cam — so the
        // silhouette arrived with a one-pixel edge, effectively a hard cutout.
        // A razor edge has no slack: the stamp is a rigid plane projected onto
        // the deck, so wherever the deck bends or twists that projection
        // reshapes, and a hard edge renders every bit of that reshaping
        // crisply. A contact shadow has a penumbra; giving it one both looks
        // right and absorbs the projection's own movement instead of drawing
        // it. vblur's kernel is scale-invariant (its sigma is in tap units, so
        // taps stay 0.5 sigma apart at any radius) — widening costs no taps,
        // and it is bake-time work either way, so this number is free to tune.
        // Both ends have been walked: 0.9 read as a hard cutout, 4.0 read as
        // too soft for a contact shadow. 2.0 is the landing — still a bit over
        // twice the original penumbra, enough to absorb the projection's own
        // movement, without the blob losing the car's shape.
        bmi->setParameter("radius", 2.0f); // kernel spacing in source texels
        utils::Entity bq = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, bmi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        mPresentVB, mPresentIB, 0, 3)
                .culling(false).castShadows(false).receiveShadows(false)
                .build(*mEngine, bq);
        Scene* bs = mEngine->createScene();
        bs->addEntity(bq);
        utils::Entity bcamEnt = utils::EntityManager::get().create();
        Camera* bcam = mEngine->createCamera(bcamEnt);
        bcam->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);
        View* bv = mEngine->createView();
        bv->setScene(bs);
        bv->setCamera(bcam);
        bv->setViewport({ 0, 0, (uint32_t) kMaskCellW, (uint32_t) kMaskCellH });
        bv->setRenderTarget(art);
        bv->setPostProcessingEnabled(false);
        bv->setShadowingEnabled(false);
        bv->setFrustumCullingEnabled(false);
        bv->setBlendMode(View::BlendMode::TRANSLUCENT); // the mask IS alpha
        Renderer::ClearOptions bco{};
        bco.clear = true;
        bco.clearColor = { 0, 0, 0, 0 };
        const Renderer::ClearOptions bprev = mRenderer->getClearOptions();
        mRenderer->setClearOptions(bco);
        mRenderer->renderStandaloneView(bv);
        mMaskLayerBakedBits |= (uint16_t) (1u << maskLayer);
        utils::slog.d << "bakeSilhouette layer " << maskLayer << " baked (bits 0x"
                << utils::io::hex << mMaskLayerBakedBits << utils::io::dec
                << ")" << utils::io::endl;
        mRenderer->setClearOptions(bprev);
        mEngine->flushAndWait(); // `tex` dies next; let the pass read it first
        mEngine->destroy(bv);
        mEngine->destroy(art);
        mEngine->destroy(bs);
        mEngine->destroy(bq);
        utils::EntityManager::get().destroy(bq);
        mEngine->destroyCameraComponent(bcamEnt);
        utils::EntityManager::get().destroy(bcamEnt);
        mEngine->destroy(bmi);
    }
    mEngine->destroy(tex);
}

// Frozen sun shadow, baked ONCE at scene build (the JS renderer bakes its
// shadow map once per track — moving casters carry blobs instead): darken road
// verts occluded from the sun by ELEVATED road geometry (loop/bridge decks) or
// the gantry. Grid-pruned ray/triangle tests keep the bake to a few ms; the
// road VB re-uploads once with the darkened colours.
// ── The frozen sun shadow map ────────────────────────────────────────────────
// Filament renders a shadow map per VIEW per frame. That is the right default
// for a scene with a moving sun, and exactly wrong here: nothing that casts
// ever moves, and a 4-way split-screen re-renders the identical 2048² depth
// pass four times a frame (measured at 1.29 ms per extra cell — the single
// biggest cost in split-screen). The JS renders one map in setTrack, freezes it
// with `shadowMap.autoUpdate = false`, and reuses it for every cell.
//
// So we render our own, once, at scene build: an ortho camera down the sun's
// axis fitted to the track, a depth-only render target, and a layer-filtered
// view so only the casters land in it. The lit materials sample it themselves
// (bindShadowMap hands them the texture and the matrix); Filament's own shadow
// machinery is off entirely, which also drops the per-fragment cascade logic.
//
// Caster set and fit are three's: the fixed track geometry, framed to the road
// bbox grown by the tallest structure, at the same 2048² and the same
// ~2.5-texel normal bias.
void TtpRenderer::bakeShadowMap(const TrackBin& tb) {
    if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
    // The ground's visibility bake rides this function (it needs the same
    // camera and the finished ESM), so its output resets on the same early
    // returns — a scene that bakes no map must not keep the last one's.
    if (mVisMap) { mEngine->destroy(mVisMap); mVisMap = nullptr; }
    // Shadows off (headless automation — see setShadowsEnabled): leave the map
    // null and let the established no-map path carry it. Everything downstream
    // already handles this, because a track whose road has no verts reaches the
    // same state one line below.
    if (!mShadowsEnabled) return;
    if (mRoad.verts.empty() || !mRenderer) return;
    constexpr uint32_t SM = 2048;
    // Fit: the road's own bounds, padded for the structures under it and the
    // gantry over it. A tight box is the whole point — texel size is what the
    // shadow's edge resolves to (three refits its ortho box per track for the
    // same reason).
    float3 lo{ 1e30f }, hi{ -1e30f };
    for (const Vertex& v : mRoad.verts) {
        lo = min(lo, float3{ v.px, v.py, v.pz });
        hi = max(hi, float3{ v.px, v.py, v.pz });
    }
    lo -= float3{ 4.0f, 8.0f, 4.0f };
    hi += float3{ 4.0f, 8.0f, 4.0f };
    const float3 centre = (lo + hi) * 0.5f;
    const float3 toSun = kToSun; // theme.key's axis — see TtpRendererImpl.h
    // Distance to stand the light off at: the bounding-sphere radius still
    // decides that (it has to clear the geometry from any angle), but it no
    // longer decides the ortho BOX — see below.
    const float radius = length(hi - lo) * 0.5f;

    mShadowMap = Texture::Builder()
            .width(SM).height(SM).levels(1)
            .format(Texture::InternalFormat::DEPTH24)
            .usage(Texture::Usage::DEPTH_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .build(*mEngine);
    if (!mShadowMap) return;
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::DEPTH, mShadowMap)
            .build(*mEngine);
    utils::Entity camEnt = utils::EntityManager::get().create();
    Camera* cam = mEngine->createCamera(camEnt);
    View* view = mEngine->createView();
    // Aim first, THEN fit the box to what the light actually sees.
    //
    // The ortho used to be a square ±radius, i.e. sized to the bounding SPHERE.
    // A track is nothing like a sphere: skysnake's footprint in the light's own
    // axes is 58.7 x 115.4, so a 127.5 x 127.5 box spent well over half its
    // texels on empty floor, and the shadow edge resolved to 0.062 world units
    // when it could resolve to 0.029. Project the eight bbox corners through the
    // real view matrix (rather than deriving the basis by hand and getting
    // lookAt's convention wrong) and take the extents.
    cam->lookAt(centre + toSun * (radius * 2.0f), centre, float3{ 0, 0, 1 });
    float2 vlo{ 1e30f }, vhi{ -1e30f };
    float dNear = 1e30f, dFar = -1e30f;
    {
        const mat4f V{ cam->getViewMatrix() };
        for (int c = 0; c < 8; c++) {
            const float3 corner{ (c & 1) ? hi.x : lo.x, (c & 2) ? hi.y : lo.y,
                                 (c & 4) ? hi.z : lo.z };
            const float3 p = (V * float4{ corner, 1.0f }).xyz;
            vlo = min(vlo, float2{ p.x, p.y });
            vhi = max(vhi, float2{ p.x, p.y });
            // View space looks down -Z, so distance from the light is -z.
            dNear = std::min(dNear, -p.z);
            dFar = std::max(dFar, -p.z);
        }
    }
    // Half-width of the shadow's soft edge, as a Gaussian sigma in WORLD units.
    // The bake blur below is sized from it, and so is the frustum margin here,
    // because a kernel that reaches past the map's border smears it.
    //
    // THE KNEE IS HERE. Once the kernel stopped being a comb (see vesm.mat) the
    // old 0.55 was simply too wide: a deck's shadow arrived as a smear that no
    // longer described the deck. Sweeping it on skysnake's loop, 10-90 edge
    // width against a fixed camera ran 9.4 px at 0.55, 6.8 at 0.39, 5.6 at
    // 0.28, 5.0 at 0.19 — and below 0.28 the ramp's smoothness falls apart
    // (normalised roughness 0.086 -> 0.099 -> 0.202) while barely narrowing,
    // because a penumbra thinner than a couple of ESM texels cannot survive the
    // runtime's single bilinear tap. So 0.28: most of the sharpening, none of
    // the return of the texel grid. Pair it with vlit/vground's kPenumbraWorld,
    // which floors the width from the receiver side and was halved to match.
    constexpr float kPenumbraSigmaWorld = 0.28f;
    // Margin so the bake blur never reaches off the edge of the map. Outside it
    // CLAMP_TO_EDGE repeats the border texel, which would smear whatever the
    // outermost row happens to hold inward by the kernel's whole reach. Four
    // texels covers the sampling itself; 3.5 sigma covers the blur, and the blur
    // is specified in WORLD units so that half has to be too.
    const float2 margin{
        std::max((vhi.x - vlo.x) / (float) SM * 4.0f, kPenumbraSigmaWorld * 3.5f),
        std::max((vhi.y - vlo.y) / (float) SM * 4.0f, kPenumbraSigmaWorld * 3.5f) };
    vlo -= margin;
    vhi += margin;
    cam->setProjection(Camera::Projection::ORTHO,
            vlo.x, vhi.x, vlo.y, vhi.y,
            std::max(0.0f, dNear - 1.0f), dFar + 1.0f);
    // The slope-scaled bias below wants the COARSER of the two axes.
    mShadowTexel = std::max(vhi.x - vlo.x, vhi.y - vlo.y) / (float) SM;
    // Normalised depth per world unit, so a bias expressed in metres means the
    // same thing on a small circuit and a large one.
    mShadowDepthScale = 1.0f
            / std::max(1.0f, (dFar + 1.0f) - std::max(0.0f, dNear - 1.0f));
    view->setScene(mScene);
    view->setCamera(cam);
    view->setViewport({ 0, 0, SM, SM });
    view->setRenderTarget(rt);
    view->setPostProcessingEnabled(false);
    view->setShadowingEnabled(false);
    // Casters only. NOTE THE 0xff: View::setVisibleLayers MERGES rather than
    // assigns — mVisibleLayers = (mVisibleLayers & ~select) | (values & select),
    // starting from 0x1 — so a select of 0x02 leaves bit 0 SET, and since the
    // test is a plain AND against a layer mask that is 0x1 on every renderable
    // by default, this pass used to render the ENTIRE SCENE into the depth map.
    // Two things came of that: the careful caster set below (elevated road, the
    // gantry, the structures, the berms) was decorative, and every pool that is
    // posed per frame — the car GLBs, their ghosts, the monster rigs, the item
    // boxes, the bananas — was still sitting at its IDENTITY transform when the
    // bake ran, so their stacked silhouette got burnt into the map at the world
    // origin. That is the mystery blob on the ground at (0, 0) on every track.
    view->setVisibleLayers(0xff, 0x02);
    const Renderer::ClearOptions prev = mRenderer->getClearOptions();
    Renderer::ClearOptions co{};
    co.clear = true;
    mRenderer->setClearOptions(co);
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);

    // World → shadow texture space. Read the matrices BEFORE the camera is
    // destroyed — doing it after is a use-after-free that shows up as a wasm
    // out-of-bounds trap three call frames deep, with nothing pointing back
    // here.
    //
    // Filter the raw depth into a blurred EXPONENTIAL map, then throw the depth
    // away. See vesm.mat: exp(-k·d) is linear under filtering, so the softness
    // is baked in here ONCE and the runtime lookup is a single bilinear tap
    // instead of an N-tap PCF in every lit fragment of every cell. It also
    // means the map's resolution no longer sets the edge's softness — the blur
    // does — so ESM_SM can be well under the depth map's own size.
    // mPresentVB is the shared fullscreen triangle; without vpresent there is none.
    bool esmOk = false;
    if (mEsmMaterial && mPresentVB && mPresentIB) {
        // A QUARTER of the depth map's size. The blur, not the resolution, sets
        // how soft the edge is (see vesm.mat), so this only has to be fine
        // enough that a texel is small next to the penumbra it carries. Pass one
        // still reads every depth texel, so what lands here is an already-smooth
        // field and storing it coarsely costs almost nothing: 2048 -> 1024 left
        // the ramp identical (10-90 width 6.5 px both ways, roughness 0.035 vs
        // 0.036) and the contour indistinguishable, for a quarter of the memory
        // — 16 MB -> 4 MB resident, and a bake peak of 16 MB rather than 40.
        //
        // The floor is real, though. Walking it down on glacier, whose elevated
        // deck throws a long shadow past a row of pillars: 512 is still smooth,
        // 256 SCALLOPS the contour visibly. What matters is sigma measured in
        // THESE texels, so sharpening the penumbra walks toward that floor from
        // the other side: glacier is the catalogue's coarsest map and now
        // carries about 1.6 of them. Re-checked at the sharpened sigma, 1024 and
        // 2048 render that contour indistinguishably (mean 0.12/255 apart, and
        // the visibility field itself is smooth in both), so the quarter of the
        // memory stands. Sharpen much further and this has to go back up.
        // Runtime is a single bilinear tap at any of these sizes.
        constexpr uint32_t ESM_SM = 1024;

        // TWO PASSES, one per axis. Separating it is what makes a wide kernel
        // affordable: sigma is what the penumbra inherits, and reaching a useful
        // sigma with the old single-pass square would have cost (6·sigma)²
        // taps a texel. Two 81-tap passes cost 162.
        //
        // The penumbra is specified in WORLD units so the edge is equally soft
        // on the smallest circuit and the largest; mShadowTexel converts it to
        // the map's own grid. vesm then takes one tap per texel — see the long
        // note there for why anything sparser bands, which is the entire reason
        // this is a uniform and not a spacing.
        //
        // The clamp is vesm's R/3: across the catalogue sigma runs 3.2 texels
        // (glacier) to 6.4 (skyline), so it never binds today. If a future
        // track's light frustum came out finer still, this truncates its
        // Gaussian at 3 sigma-worth of taps — a slightly tighter penumbra —
        // rather than stretching the taps back out into a comb.
        const float sigmaTexels = std::min(kPenumbraSigmaWorld
                        / std::max(1e-4f, mShadowTexel), 40.0f / 3.0f);

        // HALF float, not full. The runtime lookup is a single BILINEAR tap, and
        // filtering a 32-bit float texture is not universal: on the web it needs
        // OES_texture_float_linear, and on Metal it needs an Apple GPU family
        // above 3 — the Apple TV 4K (1st gen) is an A10X, which reports exactly
        // MTLGPUFamilyApple3. There is no error when it is missing; the sampler
        // silently point-samples, so the ESM's own 1024² texels show through as
        // a blocky shadow edge while the same build looks smooth on desktop GL.
        // Half-float filtering is core in WebGL2 and available on every Apple
        // family, so this is the portable choice rather than a concession.
        //
        // The range is safe: the stored value is exp(-k·d) with kShadowEsmK 8,
        // so it spans [e^-8, 1] = [3.4e-4, 1] — comfortably inside half's
        // normals, at ~0.1% RELATIVE error, which is nothing against a penumbra
        // that ramps over several texels. Only the STORED field is half; the
        // per-tap exponential and the 81-tap sum are computed at full precision
        // in the shader either way. Halves the resident cost again, 4 MB -> 2 MB.
        Texture* esm = Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R16F)
                // BLIT_SRC: the road's light bake reads this back with
                // Renderer::readPixels, which requires (will assert, in a
                // future Filament) that COLOR0 was created blit-readable.
                .usage(Texture::Usage::COLOR_ATTACHMENT
                        | Texture::Usage::SAMPLEABLE | Texture::Usage::BLIT_SRC)
                .build(*mEngine);
        // Ping target for the horizontal pass. Its own filtering matters: pass
        // two samples it at whole-texel offsets, so NEAREST would be exact, but
        // LINEAR costs nothing and forgives the half-texel rounding.
        Texture* tmp = esm ? Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R16F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine) : nullptr;
        if (esm && tmp) {
            // The fullscreen triangle, its scene and its camera are the same for
            // both passes; only the material instance and the target differ.
            utils::Entity q = utils::EntityManager::get().create();
            Scene* qs = mEngine->createScene();
            utils::Entity qcamEnt = utils::EntityManager::get().create();
            Camera* qcam = mEngine->createCamera(qcamEnt);
            qcam->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);

            TextureSampler nsmp(TextureSampler::MinFilter::NEAREST,
                    TextureSampler::MagFilter::NEAREST);
            nsmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            nsmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            TextureSampler lsmp(TextureSampler::MinFilter::LINEAR,
                    TextureSampler::MagFilter::LINEAR);
            lsmp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
            lsmp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);

            const Renderer::ClearOptions eprev = mRenderer->getClearOptions();
            Renderer::ClearOptions eco{};
            eco.clear = true;
            eco.clearColor = { 1, 0, 0, 0 }; // exp(0) = fully lit outside the map

            // src, its sampler, its size, the axis, and whether src is raw depth.
            const struct { Texture* src; bool depth; float2 dir; Texture* dst; }
                    passes[2] = {
                { mShadowMap, true,  { 1.0f, 0.0f }, tmp },
                { tmp,        false, { 0.0f, 1.0f }, esm },
            };
            for (const auto& p : passes) {
                MaterialInstance* emi = mEsmMaterial->createInstance();
                emi->setParameter("src", p.src, p.depth ? nsmp : lsmp);
                emi->setParameter("k", kShadowEsmK);
                const float srcSize = (float) (p.depth ? SM : ESM_SM);
                emi->setParameter("texel", float2{ 1.0f / srcSize, 1.0f / srcSize });
                emi->setParameter("dir", p.dir);
                // sigma is in SOURCE texels, and the two passes have
                // different sources: pass one reads the depth map, pass two
                // reads this material's own 1/4-scale output.
                emi->setParameter("sigma", sigmaTexels
                        * (p.depth ? 1.0f : (float) ESM_SM / (float) SM));
                emi->setParameter("fromDepth", p.depth ? 1.0f : 0.0f);
                RenderableManager::Builder(1)
                        .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                        .material(0, emi)
                        .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                                mPresentVB, mPresentIB, 0, 3)
                        .culling(false).castShadows(false).receiveShadows(false)
                        .build(*mEngine, q);
                qs->addEntity(q);
                RenderTarget* ert = RenderTarget::Builder()
                        .texture(RenderTarget::AttachmentPoint::COLOR, p.dst)
                        .build(*mEngine);
                View* qv = mEngine->createView();
                qv->setScene(qs);
                qv->setCamera(qcam);
                qv->setViewport({ 0, 0, ESM_SM, ESM_SM });
                qv->setRenderTarget(ert);
                qv->setPostProcessingEnabled(false);
                qv->setShadowingEnabled(false);
                qv->setFrustumCullingEnabled(false);
                mRenderer->setClearOptions(eco);
                mRenderer->renderStandaloneView(qv);
                mRenderer->setClearOptions(eprev);
                // Both passes read a texture the next step destroys or writes.
                mEngine->flushAndWait();
                mEngine->destroy(qv);
                mEngine->destroy(ert);
                qs->remove(q);
                mEngine->destroy(q); // the renderable, not the entity
                mEngine->destroy(emi);
            }
            utils::EntityManager::get().destroy(q);
            mEngine->destroy(qs);
            mEngine->destroyCameraComponent(qcamEnt);
            utils::EntityManager::get().destroy(qcamEnt);
            mEngine->destroy(tmp);
            mEngine->destroy(mShadowMap); // 2048² DEPTH24 -> ESM_SM² R16F
            mShadowMap = esm;
            esmOk = true;
        } else if (esm) {
            mEngine->destroy(esm);
        }
    }
    if (!esmOk) {
        // R16F needs EXT_color_buffer_float, and vpresent has to be present for
        // the fullscreen triangle. Without both, the raw depth map is still
        // sitting in mShadowMap — but the samplers now do an ESM lookup, which
        // is meaningless on depth. Drop it: bindShadowMap then binds the 1x1
        // white stand-in with shadowTexel 0, which reads as "fully lit".
        if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
    }

    // Clip → texture space. x and y are the usual half-scale; z needs a NEGATIVE
    // one, and getting that wrong is why no track has ever had a correct baked
    // sun shadow.
    //
    // Both halves of the convention were measured rather than assumed:
    //   - getProjectionMatrix() returns clip z in [-1,1] (near = -1). Pushing
    //     the road's eight bbox corners through it prints z/w spanning
    //     [-0.19, +0.19] — dead centred on zero, not inside [0,1].
    //   - the map itself holds REVERSED depth, 1 at the light. Rendering our
    //     computed z and the stored texel into two channels and fitting one
    //     against the other over the whole road gives stored = -0.87·ours + 0.93,
    //     i.e. stored ≈ 1 - ours.
    // So the row is -0.5·z + 0.5: near (-1) → 1, far (+1) → 0.
    //
    // The old matrix left z alone, believing it already arrived as reversed
    // [0,1]. Half of every track then fell below zero and took sunVisibility's
    // out-of-range early-out (fully lit, by accident), and the half above it
    // compared a [0, 0.19] value against a [0.5, 0.6] one and came back fully
    // shadowed. A FLAT track lands entirely on the lit side and looks correct
    // for free, which is why this survived: only a track that climbs straddles
    // zero, and then you get skysnake's hard-edged half-dark road.
    const mat4f lightViewProj{ cam->getProjectionMatrix() * cam->getViewMatrix() };
    const mat4f bias{ float4{ 0.5f, 0, 0, 0 }, float4{ 0, 0.5f, 0, 0 },
                      float4{ 0, 0, -0.5f, 0 }, float4{ 0.5f, 0.5f, 0.5f, 1 } };
    mShadowFromWorld = bias * lightViewProj;

    // The GROUND's visibility map: the exact runtime ESM decode, evaluated
    // ONCE over the light's own grid by rendering the real ground mesh
    // through this same camera with vvis.mat. vground then pays one bilinear
    // R8 tap per fragment instead of the whole chain — see both materials.
    // The target texel grid is shadowFromWorld's own [0,1]² by construction
    // (same camera, same bias), so no second transform exists to drift.
    //
    // 512²: the softness lives in the ESM (whose own floor measured at 512 —
    // 256 scallops), and this map only re-samples it; 0.25 MB resident.
    if (esmOk && mVisMaterial && mGround.vb && mGround.ib
            && !mGround.idx.empty()) {
        constexpr uint32_t VIS_SM = 512;
        Texture* vis = Texture::Builder()
                .width(VIS_SM).height(VIS_SM).levels(1)
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine);
        if (vis) {
            MaterialInstance* vmi = mVisMaterial->createInstance();
            // The five shadow parameters, by the names every receiver shares.
            bindShadowMap(vmi);
            // Explicit rather than read from a scene light: the throwaway
            // scene below has none, and this is the vector the live scene's
            // frameUniforms.lightDirection carries (Track's sun is built
            // from the same constant).
            vmi->setParameter("sunDir", toSun);
            utils::Entity ge = utils::EntityManager::get().create();
            RenderableManager::Builder(1)
                    .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                    .material(0, vmi)
                    .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                            mGround.vb, mGround.ib, 0, mGround.idx.size())
                    .culling(false).castShadows(false).receiveShadows(false)
                    .build(*mEngine, ge);
            Scene* gs = mEngine->createScene();
            gs->addEntity(ge);
            RenderTarget* vrt = RenderTarget::Builder()
                    .texture(RenderTarget::AttachmentPoint::COLOR, vis)
                    .build(*mEngine);
            View* vv = mEngine->createView();
            vv->setScene(gs);
            vv->setCamera(cam);
            vv->setViewport({ 0, 0, VIS_SM, VIS_SM });
            vv->setRenderTarget(vrt);
            vv->setPostProcessingEnabled(false);
            vv->setShadowingEnabled(false);
            vv->setFrustumCullingEnabled(false);
            const Renderer::ClearOptions vprev = mRenderer->getClearOptions();
            Renderer::ClearOptions vco{};
            vco.clear = true;
            // Fully lit where the ground does not reach — the margin rows the
            // ESM fit reserved are caster-free, so CLAMP_TO_EDGE extending
            // the border outward answers what the old out-of-frustum
            // early-out did.
            vco.clearColor = { 1, 1, 1, 1 };
            mRenderer->setClearOptions(vco);
            mRenderer->renderStandaloneView(vv);
            mRenderer->setClearOptions(vprev);
            mEngine->flushAndWait();
            mEngine->destroy(vv);
            mEngine->destroy(vrt);
            gs->remove(ge);
            mEngine->destroy(ge);
            utils::EntityManager::get().destroy(ge);
            mEngine->destroy(gs);
            mEngine->destroy(vmi);
            mVisMap = vis;
        }
    }

    // ── The ROAD's baked vertex light ────────────────────────────────────
    // vroad's materialVertex used to run the whole matte-light split per road
    // vertex PER FRAME (a mat4 multiply, a vertex texture tap, a log, a sqrt,
    // two smoothsteps — on the scene's biggest mesh), and every input is
    // static per track. Read the finished ESM back once and evaluate the
    // identical function on the CPU into the road's CUSTOM0 attribute. The
    // readback is asynchronous on every backend; this is track build, and the
    // one hitch at load is already the documented price of the bakes.
    if (esmOk && !mRoad.custom0.empty() && mRoad.vb && mShadowMap) {
        const uint32_t W = mShadowMap->getWidth(0);
        const uint32_t H = mShadowMap->getHeight(0);
        if (RenderTarget* rrt = RenderTarget::Builder()
                .texture(RenderTarget::AttachmentPoint::COLOR, mShadowMap)
                .build(*mEngine)) {
            // Heap-owned so a readback that somehow never lands cannot write
            // through a dead stack frame; the never-done path leaks it on
            // purpose, and the road keeps the unshadowed fill from build.
            // `done` is atomic: the completion callback fires on a backend
            // thread (Metal's completion queue, GL's driver thread) while
            // this thread polls it across flushAndWait pumps.
            struct EsmRead { std::vector<float> px; std::atomic<bool> done{ false }; };
            auto* rd = new EsmRead;
            rd->px.resize((size_t) W * H * 4);
            // RGBA + FLOAT: the one float readback combo all three backends
            // accept (WebGL2 guarantees exactly this pair for float targets;
            // Metal maps it to RGBA32Float).
            Texture::PixelBufferDescriptor pbd(rd->px.data(),
                    rd->px.size() * sizeof(float),
                    Texture::Format::RGBA, Texture::Type::FLOAT,
                    [](void*, size_t, void* user) {
                        static_cast<EsmRead*>(user)->done = true;
                    }, rd);
            mRenderer->readPixels(rrt, 0, 0, W, H, std::move(pbd));
            // The GL backend completes the copy on a fence it checks a tick
            // after the flush, and Metal's completion handler can land just
            // as a wait returns — so pump a few times rather than once.
            for (int t = 0; t < 8 && !rd->done; t++) mEngine->flushAndWait();
            if (rd->done) {
                fillRoadLight(tb, rd->px.data(), W, H);
                mRoad.vb->setBufferAt(*mEngine, mRoad.custom0Slot,
                        VertexBuffer::BufferDescriptor(mRoad.custom0.data(),
                                mRoad.custom0.size() * sizeof(half4), nullptr));
                delete rd;
            }
            mEngine->destroy(rrt);
        }
    }

    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
}

// ── The road's matte light, evaluated ONCE ──────────────────────────────────
// The CPU twin of ttpMatteLight (ttp_shade.inc) for the ROAD's vertices: the
// 2-band SH ambient, the sun's N·L term, and sunVisibility's ESM decode —
// minus the fwidth AA floor, exactly the term vvis.mat's bake drops
// (TTP_SHADE_VERTEX), because it guarded SCREEN-space aliasing and the road's
// 0.48 u rings interpolate finer than the 0.6 u penumbra. A fix in
// ttp_shade.inc must reach this function: same arithmetic, two languages.
//
// frameUniforms replication, verified against the pinned fork
// (ColorPassDescriptorSet.cpp): iblSH is the IndirectLight builder's
// coefficients copied UNSCALED; iblLuminance is ibl intensity × exposure;
// lightColorIntensity is { colour, lux × exposure }; lightDirection is the
// negated light direction, i.e. kToSun. No camera here ever calls
// setExposure, so every view shares the default exposure read off mCamera —
// if that ever changes, this bake must follow it.
void TtpRenderer::fillRoadLight(const TrackBin& tb, const float* esm,
        uint32_t esmW, uint32_t esmH) {
    const size_t n = mRoad.custom0.size();
    if (!n || mRoad.normals.size() < n || mRoad.verts.size() < n) return;
    const MatteRig rig = matteRig(tb);
    const float exposure = Exposure::exposure(*mCamera);
    const float3 sunTint = rig.sunColor
            * (rig.sunLux * exposure * (1.0f / (float) M_PI));
    const float iblLum = rig.hemiLux * exposure;
    const float k = kShadowEsmK;
    // ttp_shade.inc's kPenumbraWorld — the C++ twin of the shader constant
    // (named there as this function's twin; change both).
    constexpr float kPenumbraWorld = 0.6f;
    const float w = kPenumbraWorld * mShadowDepthScale * k;
    const auto smoothstep = [](float a, float b, float x) {
        const float t = std::min(1.0f, std::max(0.0f, (x - a) / (b - a)));
        return t * t * (3.0f - 2.0f * t);
    };
    // One clamped bilinear R tap of the readback — the ESM sampler's
    // CLAMP_TO_EDGE + LINEAR, in floats. ROW ORDER: Filament's readPixels
    // hands rows back TOP row first on every backend (the GL driver flips
    // glReadPixels' bottom-up rows "to match our API"; Metal's memory order
    // is already top-down), while shadowFromWorld's uv is GL-style (v = 0 at
    // the picture's bottom) — so v flips here, the same correction
    // uvToRenderTargetUV applies for the shader on the non-GL backends.
    // tests/render-target-uv.test.js audits .mat files only; the gate for
    // THIS read is visual — a wrong flip moves every climbing track's deck
    // shadow to the mirrored half of the light frustum on all backends.
    const auto tap = [&](float u, float v) {
        const float fx = u * (float) esmW - 0.5f;
        const float fy = (1.0f - v) * (float) esmH - 0.5f;
        const int x0 = (int) std::floor(fx), y0 = (int) std::floor(fy);
        const float tx = fx - (float) x0, ty = fy - (float) y0;
        const auto at = [&](int x, int y) {
            x = std::min((int) esmW - 1, std::max(0, x));
            y = std::min((int) esmH - 1, std::max(0, y));
            return esm[((size_t) y * esmW + x) * 4]; // RGBA rows; R = exp(-k·d)
        };
        const float a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const float b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        return a + (b - a) * ty;
    };
    for (size_t i = 0; i < n; i++) {
        const float3 nrm = mRoad.normals[i];
        const float3 wp{ mRoad.verts[i].px, mRoad.verts[i].py, mRoad.verts[i].pz };
        const float NoL = std::min(1.0f, std::max(0.0f, dot(nrm, kToSun)));
        // sunVisibility, line for line (minus the fwidth floor). esm == null
        // is the shader's shadowTexel-0 early-out: fully lit.
        float vis = 1.0f;
        if (esm) {
            const float4 uv = mShadowFromWorld * float4{ wp, 1.0f };
            // No perspective divide: ortho light, w == 1 (see ttp_shade.inc).
            if (!(uv.x < 0.0f || uv.x > 1.0f || uv.y < 0.0f || uv.y > 1.0f
                    || uv.z <= 0.0f || uv.z >= 1.0f)) {
                const float slope = std::min(12.0f, std::max(1.0f,
                        std::sqrt(std::max(0.0f, 1.0f - NoL * NoL))
                                / std::max(NoL, 0.12f)));
                const float biasW = mShadowTexel * 2.0f * slope;
                const float occ = tap(uv.x, uv.y);
                const float raw = uv.z * k + std::log(std::max(occ, 1e-30f));
                const float biasN = std::max(biasW * mShadowDepthScale * k, w);
                const float v = smoothstep(-w, w, raw + biasN);
                vis = 1.0f + (v - 1.0f) * smoothstep(0.05f, 0.40f, NoL);
            }
        }
        // ttpMatteAmbient + ttpMatteSunTerm × vis (sh2/sh3 are zero — the
        // hemisphere has no horizontal band).
        const float3 amb = max(rig.sh0 + rig.sh1 * nrm.y, float3{ 0.0f }) * iblLum;
        const float3 light = amb + sunTint * (NoL * vis);
        mRoad.custom0[i] = half4{ light.x, light.y, light.z, 1.0f };
    }
}
