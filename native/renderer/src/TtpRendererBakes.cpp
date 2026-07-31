// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"

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
    // The bake only has one consumer now — the road shader's masked decal —
    // so a slot outside the array, a missing road material or a missing blur
    // material all mean there is nothing to bake into: the decal rides the
    // generic layer instead.
    if (maskLayer < 0 || maskLayer >= kMaskLayers || !mRoadMaterial
            || !mBlurMaterial || !mPresentVB || !mPresentIB
            || !ensureDecalMaskArray()) {
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
        bmi->setParameter("radius", 0.9f); // kernel spacing in source texels
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
    const float3 toSun = normalize(float3{ 2.0f, 12.0f, 1.5f }); // theme.key, as the JS places it
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

        Texture* esm = Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R32F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine);
        // Ping target for the horizontal pass. Its own filtering matters: pass
        // two samples it at whole-texel offsets, so NEAREST would be exact, but
        // LINEAR costs nothing and forgives the half-texel rounding.
        Texture* tmp = esm ? Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R32F)
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
            mEngine->destroy(mShadowMap); // 2048² DEPTH24 -> 2048² R32F
            mShadowMap = esm;
            esmOk = true;
        } else if (esm) {
            mEngine->destroy(esm);
        }
    }
    if (!esmOk) {
        // R32F needs EXT_color_buffer_float, and vpresent has to be present for
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

    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
}
