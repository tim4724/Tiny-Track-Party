// The track-scoped bakes: sun shadow map, road light, silhouettes and the
// staged-blob machinery. TtpRendererImpl.h carries what the topic files share.
#include "TtpRendererImpl.h"

#include <algorithm>
#include <cstdio>
#include <atomic>
#include <chrono>
#include <utility>

#include <utils/Log.h>

// The car's ground shadow, shaped like the CAR. SceneRenderer._bakeCarShadow
// puts an orthographic camera over the model, renders a flat white mask on
// transparent, and reads it back for the blur; the same picture here comes from
// an offscreen RenderTarget rendered with renderStandaloneView — the blur is a
// second render pass rather than a CPU convolution, and the only readback is
// the small coverage probe that decides whether the bake landed at all.
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
            // BLIT_SRC: the coverage probe below reads this back, which
            // requires (and in a future Filament will assert) that COLOR0 was
            // created blit-readable — the ESM bake's note applies here too.
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                    | Texture::Usage::BLIT_SRC)
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
    // DID ANY COVERAGE ACTUALLY LAND? This starve is silent by construction:
    // an EMPTY layer whose baked bit is set draws nothing at all under that
    // car, while a CLEAR bit draws a plausible generic oval — so after the
    // fact no screenshot gate and no success log can tell the three states
    // apart. It is not hypothetical either: the R8 experiment recorded in
    // ensureDecalMaskArray put every car into exactly this state on the
    // PowerVR driver while the bake logged success.
    //
    // One central patch is the whole test. The ortho camera frames the model's
    // OWN aabb with 1.45 overscan, so the body covers the middle of the target
    // for every car in the kit; anything that renders nothing there rendered
    // nothing anywhere.
    bool covered = false;
    {
        struct CoverRead { std::vector<uint8_t> px; bool done = false; };
        constexpr int CW = 16;
        auto* rd = new CoverRead{
                std::vector<uint8_t>((size_t) CW * CW * 4, 0), false };
        Texture::PixelBufferDescriptor pbd(rd->px.data(), rd->px.size(),
                Texture::Format::RGBA, Texture::Type::UBYTE,
                [](void*, size_t, void* user) {
                    static_cast<CoverRead*>(user)->done = true;
                }, rd);
        mRenderer->readPixels(rt, (uint32_t) ((TW - CW) / 2),
                (uint32_t) ((TH - CW) / 2), CW, CW, std::move(pbd));
        // The ESM readback's pump, for its reasons: the GL backend completes
        // the copy on a fence it checks a tick after the flush, and Metal's
        // completion handler can land just as a wait returns.
        for (int t = 0; t < 8 && !rd->done; t++) mEngine->flushAndWait();
        if (rd->done) {
            // Coverage rides ALPHA (the sampler's note) — opaque glTF
            // materials write 1.0 there and the clear leaves 0.
            for (size_t i = 3; i < rd->px.size(); i += 4) {
                if (rd->px[i] > 8) { covered = true; break; }
            }
            delete rd;
        } else {
            // The read never landed, so the probe knows nothing. Trust the
            // bake over the probe: a false EMPTY would cost every car its
            // silhouette, which is worse than the starve this is hunting.
            covered = true;
        }
    }
    for (size_t i = 0; i < count; i++) scene->remove(entities[i]);
    mEngine->destroy(view);
    mEngine->destroy(rt);
    // The camera and scene go back BEFORE the coverage verdict, not after: an
    // early return between the two leaks exactly the case the probe exists to
    // catch, which would make a driver that renders nothing also a slow leak.
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    mEngine->destroy(scene);
    if (!covered) {
        // Bit left CLEAR on purpose: the generic oval is the honest fallback,
        // and a reload (or the next scene's rebake) is the cure.
        utils::slog.w << "bakeSilhouette layer " << maskLayer
                << " rendered EMPTY — bit left clear, this shape falls back to"
                   " the generic oval" << utils::io::endl;
        mEngine->destroy(tex);
        return;
    }

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
    // 80% OF A SCENE BUILD IS THIS FUNCTION on the Android reference box (570-607
    // of 711-749 ms), so its own parts have to be separable before anything can
    // be done about it. Same diagnostic-only deal as buildTrackScene's phases.
    //
    // AND THE SPLIT SAYS THE CPU IS DOING NOTHING. Recording each pass costs 0 ms;
    // the two `flushAndWait` calls below cost ~290 and ~227. This function does
    // not compute for half a second, it WAITS for the GPU to finish work it has
    // already submitted — on the thread that also runs the frame loop and the
    // relay's message pump, which is why a phone's tap queues behind it.
    //
    // It is written this way because each step reads the previous step's target
    // (blur two reads blur one, the vis pass reads the ESM, the road readback
    // reads it again), and draining the pipeline is the simplest way to order
    // that. The price was accepted when a build was a LOAD-TIME event — see the
    // road readback's own note, "the one hitch at load is already the documented
    // price of the bakes". A live lobby rebuilds on joins, picks and launch, so
    // that assumption no longer holds.
    std::vector<std::pair<const char*, double>> bakePhases;
    auto bakeAt = std::chrono::steady_clock::now();
    const auto bakeMark = [&](const char* name) {
        const auto now = std::chrono::steady_clock::now();
        bakePhases.emplace_back(name,
                std::chrono::duration<double, std::milli>(now - bakeAt).count());
        bakeAt = now;
    };
    // THE CASTERS ARE THE STATIC SCENE, AND CARS CAST NOTHING (setVisibleLayers
    // 0x02 below). So this whole bake is a function of the track and its biome:
    // rebuild the same track with a different FIELD — a phone joining, a launch
    // re-dressing the grid it was already previewing — and the depth render, the
    // 81-tap ESM blur and the ground's visibility decode all reproduce, bit for
    // bit, what is already resident. Measured on the Android reference box that
    // is 520 of a 700 ms build, and the build blocks the main thread for all of
    // it, inbound relay frames included.
    //
    // The same argument the silhouette layers already won one level up (see
    // releaseScene: "a bake is a fact about the kit rather than about this
    // race"), applied to the track. The KEY is the caller's — only the shim
    // knows what a scene is OF — and an empty one means "do not reuse", which is
    // what every caller that has not opted in gets.
    //
    // The road's vertex light is NOT skipped: the road MESH is new every build,
    // so its CUSTOM0 has to be refilled. That is the cheap half (~45 ms), and it
    // reads the ESM back out of the cached pixels rather than off the GPU again.
    // The two guards below (shadows off, a road with no verts) both DROP the
    // resident maps on purpose, so the reuse test has to clear them itself
    // rather than sit after them.
    if (!mBakeKey.empty() && mBakeKey == mBakedKey && mShadowMap
            && mShadowsEnabled && !mRoad.verts.empty() && mRenderer) {
        // THE ROAD'S LIGHT COMES WITH THE MAPS. Same track, so the road mesh was
        // rebuilt identically and its CUSTOM0 is the same bytes; uploading them
        // skips the ESM readback AND the per-vertex evaluation. The size test is
        // the belt to that braces: a road of a different length is not this
        // track's, whatever the key says, and the honest answer then is to
        // re-derive rather than to upload a fill that does not fit.
        if (mRoadLight.size() == mRoad.custom0.size() && !mRoadLight.empty() && mRoad.vb) {
            mRoad.custom0 = mRoadLight;
            mRoad.vb->setBufferAt(*mEngine, mRoad.custom0Slot,
                    VertexBuffer::BufferDescriptor(mRoad.custom0.data(),
                            mRoad.custom0.size() * sizeof(half4), nullptr));
        } else {
            refillRoadLight(tb);
        }
        mBakeKey.clear();   // CONSUMED — see the clear on the baking path below
        bakeMark("reused");
        utils::slog.i << "ttp shadow bake: REUSED " << mBakedKey.c_str()
                << " (" << (int) (bakePhases.back().second + 0.5) << " ms)" << utils::io::endl;
        return;
    }
    mBakedKey.clear();   // whatever is resident is about to stop being the truth
    mRoadLight.clear();
    // THROUGH replaceShadowMaps, NOT destroy: the previous build may have staged
    // a blob whose readback is still writing into one of these, and on GL it
    // routinely is. The ground's visibility bake rides this function (it needs
    // the same camera and the finished ESM), so its output resets on the same
    // early returns — a scene that bakes no map must not keep the last one's.
    replaceShadowMaps(nullptr, nullptr);
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
    bakeMark("setup");
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);
    bakeMark("depth");

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
                // RECORDING is free; the WAIT below is where the time goes.
                // Both halves are marked so the split cannot be misread as CPU
                // work — see the note on flushAndWait above.
                bakeMark("blurRecord");
                mRenderer->renderStandaloneView(qv);
                mRenderer->setClearOptions(eprev);
                // Both passes read a texture the next step destroys or writes.
                mEngine->flushAndWait();
                bakeMark("blurWait");
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
        // BLIT_SRC for the same reason the ESM carries it: exportBake reads this
        // map back so it can be persisted, and Filament warns (and will later
        // ASSERT) on a readPixels whose COLOR0 was not made blit-readable. The
        // warning is not cosmetic — what a readback of a non-BLIT_SRC target
        // returns is up to the driver, and this map is the ground's own sun
        // shadow, so a wrong one is a wrongly-lit floor rather than a crash.
        Texture* vis = Texture::Builder()
                .width(VIS_SM).height(VIS_SM).levels(1)
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                        | Texture::Usage::BLIT_SRC)
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
            bakeMark("visRecord");
            mRenderer->renderStandaloneView(vv);
            mRenderer->setClearOptions(vprev);
            mEngine->flushAndWait();
            bakeMark("visWait");
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
    if (esmOk) refillRoadLight(tb);
    mRoadLight = mRoad.custom0;   // for the next build of this same track
    bakeMark("roadLight");

    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    // CONSUMED, not merely read. The key is a statement about THIS build, so a
    // caller that reaches buildScene without making one must fall through to a
    // real bake rather than inherit the last caller's claim — there is one call
    // site today and this is what keeps a second one from being a silent, wrong
    // reuse of somebody else's shadows.
    mBakedKey = mBakeKey;   // the resident maps are now this key's
    mBakeKey.clear();
    {
        auto& line = utils::slog.i << "ttp shadow bake:";
        for (const auto& p : bakePhases) line << " " << p.first << " " << (int) (p.second + 0.5);
        line << utils::io::endl;
    }
}

// Read the finished ESM back and refill the ROAD's baked vertex light.
//
// Split out because BOTH bake paths need it: the road MESH is rebuilt on every
// build even when the map that lights it is the one already resident, so a
// reused bake still has to refill CUSTOM0 on the new vertices.
void TtpRenderer::refillRoadLight(const TrackBin& tb) {
    if (mRoad.custom0.empty() || !mRoad.vb || !mShadowMap || !mRenderer) return;
    // Whatever was in flight is the PREVIOUS road's, and this build has just
    // replaced the mesh it would have been written into.
    dropRoadLightRead();
    const uint32_t W = mShadowMap->getWidth(0);
    const uint32_t H = mShadowMap->getHeight(0);
    RenderTarget* rrt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, mShadowMap)
            .build(*mEngine);
    if (!rrt) return;
    // Heap-owned, because it may well outlive this function — see RoadLightRead
    // for the backend where it always does. `done` is atomic: the completion
    // callback fires on a backend thread (Metal's completion queue, GL's driver
    // thread) while this one polls it.
    auto rd = std::make_unique<RoadLightRead>();
    rd->px.resize((size_t) W * H * 4);
    rd->rt = rrt;
    rd->w = W;
    rd->h = H;
    rd->serial = mBuildSerial;
    // RGBA + FLOAT: the one float readback combo all three backends accept
    // (WebGL2 guarantees exactly this pair for float targets; Metal maps it to
    // RGBA32Float).
    Texture::PixelBufferDescriptor pbd(rd->px.data(),
            rd->px.size() * sizeof(float),
            Texture::Format::RGBA, Texture::Type::FLOAT,
            [](void*, size_t, void* user) {
                static_cast<RoadLightRead*>(user)->done = true;
            }, rd.get());
    mRenderer->readPixels(rrt, 0, 0, W, H, std::move(pbd));
    // THE FAST PATH IS STILL THE FAST PATH. Metal and Vulkan complete inside
    // this pump, so they finish here with the road lit before the build returns
    // and nothing is ever deferred on them.
    for (int t = 0; t < 8 && !rd->done; t++) mEngine->flushAndWait();
    if (rd->done) {
        applyRoadLight(tb, rd->px.data(), W, H);
        mRoadLight = mRoad.custom0;   // for the next build of this same track
        mEngine->destroy(rrt);
        return;
    }
    // …and GL keeps it for the frame loop, where endFrame ticks the driver.
    // mRoadLight is deliberately NOT stamped here: it is the reuse path's copy
    // of a FINISHED fill, and an unshadowed one would be uploaded verbatim by
    // the next build of this same track. Left empty, that path re-reads instead.
    mRoadLightRead = std::move(rd);
}

// Apply a road-light readback that landed after its build had returned.
void TtpRenderer::collectRoadLight() {
    // Graves first: a parked read that has now completed can simply be freed.
    for (size_t i = mRoadLightGraves.size(); i-- > 0;) {
        if (mRoadLightGraves[i]->done) mRoadLightGraves.erase(mRoadLightGraves.begin() + (long) i);
    }
    if (!mRoadLightRead || !mRoadLightRead->done) return;
    const std::unique_ptr<RoadLightRead> rd = std::move(mRoadLightRead);
    if (rd->rt) mEngine->destroy(rd->rt);
    // STALE IS DROPPED, NOT APPLIED. A build that started while this was in
    // flight has a different road mesh, and CUSTOM0 sized for the old one would
    // be written over the new one's — the size test is the belt to that brace.
    if (rd->serial != mBuildSerial || !mTrack || !mRoad.vb) return;
    if (mRoad.custom0.size() != (size_t) mRoad.verts.size()) return;
    applyRoadLight(*mTrack, rd->px.data(), rd->w, rd->h);
    mRoadLight = mRoad.custom0;   // now it IS a finished fill; the reuse path may have it
}

// Forget a read still in flight. The buffer it would write into is this
// object's own, so it must outlive nothing — but the callback may still fire,
// so the object is only released once it has (or with the engine).
void TtpRenderer::dropRoadLightRead() {
    if (!mRoadLightRead) return;
    if (mRoadLightRead->rt) mEngine->destroy(mRoadLightRead->rt);
    mRoadLightRead->rt = nullptr;
    if (mRoadLightRead->done) { mRoadLightRead.reset(); return; }
    // Never landed and never will be wanted: hand it to the graveyard rather
    // than freeing a buffer the driver may yet write into.
    mRoadLightGraves.push_back(std::move(mRoadLightRead));
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
// fillRoadLight plus the upload it is useless without. Both bake paths end here
// — the one that just read the ESM off the GPU, and the one reusing a cached
// read — so the road can never be filled by one of them and uploaded by neither.
void TtpRenderer::applyRoadLight(const TrackBin& tb, const float* esm,
        uint32_t esmW, uint32_t esmH) {
    if (mRoad.custom0.empty() || !mRoad.vb) return;
    fillRoadLight(tb, esm, esmW, esmH);
    mRoad.vb->setBufferAt(*mEngine, mRoad.custom0Slot,
            VertexBuffer::BufferDescriptor(mRoad.custom0.data(),
                    mRoad.custom0.size() * sizeof(half4), nullptr));
}

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

// ── Derived bytes, kept between runs ────────────────────────────────────────
//
// WHY THIS CROSSES THE ABI AT ALL. The sun bake is 520 ms of GPU on the Android
// reference box and it is resolution-independent — the three sizes are compile
// -time constants (SM, ESM_SM, VIS_SM) and no viewport, window or render-scale
// value reaches it — so it is worth keeping between RUNS, not just between
// builds. The silhouettes are the same argument on a smaller number: five bakes
// cost ~330 ms of a launch's first build, a GPU render and a flushAndWait each.
// Keeping something between runs means a file, and a file is the shell's job
// (`ttp_abi.h`: the transport stays on the host side by design). So this hands
// over bytes and takes them back, and decides nothing about where they live.
//
// EVERY BLOB CARRIES ITS OWN KEY, and that is what makes a stale file harmless
// rather than invisible: import adopts the key it finds, and the next build's
// own key has to match it before anything is reused. What a key CANNOT cover is
// the engine that produced it — a shader edit reproduces the same
// `track|biome|showcase` and would silently serve shadows baked by the old
// vesm. That invalidation is the shell's, and it is why the file lives under a
// directory named for the installed binary rather than beside the track id.
//
// A SILHOUETTE IS KEYED PER MODEL, not per roster. The layers are baked per
// model already (mMaskLayerKey), so a set-keyed blob stored each layer once per
// SUBSET it appeared in — up to fifteen copies of the same 512 KB — and then
// missed outright whenever a lobby's roster covered fewer models than the blob
// that wrote it. One key per model is the same data with none of that.
namespace {
constexpr uint32_t kBakeMagic = 0x42505454u;  // 'TTPB', little-endian
// v2: the writing BACKEND rides the header and import refuses a foreign blob —
// see the flip note in finishBakeBlob. v1 blobs written under Vulkan are
// mirrored, so the bump also retires every v1 file.
constexpr uint32_t kBakeVersion = 2u;

constexpr uint32_t kMaskMagic = 0x4b53544du;  // 'MTSK', little-endian
// v3 is ONE LAYER PER BLOB, keyed by that layer's model. v2 was the whole set in
// one container, which is what the per-model keying above retires.
constexpr uint32_t kMaskVersion = 3u;
constexpr uint32_t kMaskKindModel = 0u;    // goes in any free model layer
constexpr uint32_t kMaskKindMonster = 1u;  // goes in kMaskLayerMonster, always

// The monster's silhouette is keyed by nothing — the truck never changes — so it
// takes a name no model FNV can collide with. Before v2 it had no key at all and
// re-baked on every launch, quietly inheriting the cost the model layers had
// already stopped paying.
const char* const kMonsterKey = "monster";

void putU32(std::vector<uint8_t>& out, uint32_t v) {
    out.insert(out.end(), (const uint8_t*) &v, (const uint8_t*) &v + 4);
}
void putF32(std::vector<uint8_t>& out, float v) {
    out.insert(out.end(), (const uint8_t*) &v, (const uint8_t*) &v + 4);
}
void putStr(std::vector<uint8_t>& out, const std::string& s) {
    putU32(out, (uint32_t) s.size());
    out.insert(out.end(), s.begin(), s.end());
}
bool takeU32(const uint8_t*& p, const uint8_t* end, uint32_t& v) {
    if ((size_t) (end - p) < 4) return false;
    std::memcpy(&v, p, 4); p += 4; return true;
}
bool takeF32(const uint8_t*& p, const uint8_t* end, float& v) {
    if ((size_t) (end - p) < 4) return false;
    std::memcpy(&v, p, 4); p += 4; return true;
}
bool takeStr(const uint8_t*& p, const uint8_t* end, std::string& v) {
    uint32_t n = 0;
    if (!takeU32(p, end, n) || (size_t) (end - p) < n) return false;
    v.assign((const char*) p, n);
    p += n;
    return true;
}

// A mask layer's key, from the bytes baked into it.
std::string maskKeyOf(uint64_t fnv, int backend) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%016llx|%d", (unsigned long long) fnv, backend);
    return buf;
}
}  // namespace

// ── What this build could keep, and what it already holds ───────────────────

// What the NEXT build's silhouettes will be OF: one key per distinct car model
// the shell has already provided, plus the monster's. Empty when no car bytes
// are provided yet, which is what makes the window explicit — ask after
// provisioning.
std::vector<std::string> TtpRenderer::maskBlobKeys() const {
    std::vector<uint64_t> fnvs;
    for (uint32_t c = 0; c < 16; c++) {
        const auto it = mAssets.find("car" + std::to_string(c) + ".glb");
        if (it == mAssets.end() || it->second.empty()) continue;
        const uint64_t k = glbBytesKey(it->second);
        if (std::find(fnvs.begin(), fnvs.end(), k) == fnvs.end()) fnvs.push_back(k);
    }
    if (fnvs.empty()) return {};
    // Sorted so the same field in a different slot order names the same blobs.
    std::sort(fnvs.begin(), fnvs.end());
    const int backend = backendId();
    std::vector<std::string> keys;
    keys.reserve(fnvs.size() + 1);
    for (const uint64_t k : fnvs) keys.push_back(maskKeyOf(k, backend));
    keys.push_back(std::string(kMonsterKey) + "|" + std::to_string(backend));
    return keys;
}

bool TtpRenderer::blobResident(const std::string& key) const {
    if (key.empty()) return false;
    if (key == mBakedKey && mShadowMap) return true;
    // A mask layer is resident when a layer currently holds that model's bytes.
    // The monster's home is fixed, so its bit alone answers.
    const int backend = backendId();
    if (key == std::string(kMonsterKey) + "|" + std::to_string(backend)) {
        return (mMaskLayerBakedBits & (uint16_t) (1u << kMaskLayerMonster)) != 0;
    }
    for (int i = 0; i < kMaskLayerModels; i++) {
        if (!(mMaskLayerBakedBits & (uint16_t) (1u << i))) continue;
        if (maskKeyOf(mMaskLayerKey[i], backend) == key) return true;
    }
    return false;
}

// ── Staging: snapshot the metadata, issue the reads ─────────────────────────

bool TtpRenderer::issueRead(StagedBlob& blob, Texture* tex, bool asFloat, int layer) {
    if (!tex || !mRenderer) return false;
    const Texture::Type type = asFloat ? Texture::Type::FLOAT : Texture::Type::UBYTE;
    const uint32_t bytesPerChannel = asFloat ? 4u : 1u;
    const uint32_t W = tex->getWidth(0), H = tex->getHeight(0);
    RenderTarget::Builder rtb;
    rtb.texture(RenderTarget::AttachmentPoint::COLOR, tex);
    // An ARRAY slice, the same way bakeSilhouette renders into one.
    if (layer >= 0) rtb.layer(RenderTarget::AttachmentPoint::COLOR, (uint32_t) layer);
    RenderTarget* rt = rtb.build(*mEngine);
    if (!rt) return false;
    // THE DESTINATION IS THE StagedRead's OWN BUFFER from the start, because a
    // read that does not finish here keeps being written into after this returns
    // — so the buffer may not be moved, resized or freed on the way out.
    auto rd = std::make_unique<StagedRead>();
    rd->tex = tex;
    rd->layer = layer;
    rd->asFloat = asFloat;
    rd->w = W;
    rd->h = H;
    rd->rt = rt;
    rd->px.resize((size_t) W * H * 4 * bytesPerChannel);
    Texture::PixelBufferDescriptor pbd(rd->px.data(), rd->px.size(),
            Texture::Format::RGBA, type,
            [](void*, size_t, void* user) { static_cast<StagedRead*>(user)->done = true; },
            rd.get());
    mRenderer->readPixels(rt, 0, 0, W, H, std::move(pbd));
    blob.reads.push_back(std::move(rd));
    return true;
}

bool TtpRenderer::stageBlob(const std::string& key) {
    if (key.empty() || !mEngine || !mRenderer) return false;
    // Already staged, finished or not: staging twice would issue a second set of
    // reads into a second buffer and finish whichever raced.
    for (const auto& s : mStaged) {
        if (s->key == key) return true;
    }
    auto blob = std::make_unique<StagedBlob>();
    blob->key = key;
    // ROWS GO BACK THE OTHER WAY ON OPENGL ALONE, and this is a documented
    // Filament fact rather than a guess (Renderer.h, readPixels): "OpenGL only:
    // if issuing a readPixels on a RenderTarget backed by a Texture that had
    // data uploaded to it via setImage, the data returned from readPixels will
    // be y-flipped with respect to the setImage call." The GL backend flips
    // every readback "to match our API" (OpenGLDriver.cpp) while Vulkan and
    // Metal copy storage rows verbatim — so on those backends a readback IS
    // setImage order already, and applying the GL flip mirrors the map. A blob
    // is read one way and uploaded the other, so on GL somebody has to flip;
    // doing it here means the file is in the writing backend's setImage order
    // and import stays a straight upload. The header carries the backend and
    // import refuses a foreign blob, so the two sides of the round trip can
    // never disagree about which convention the bytes are in.
    //
    // The mirror is invisible in every way that matters until you look: the map
    // still covers the track, still has the right shape, and is simply upside
    // down — which reads on screen as a shadow that has been rotated onto the
    // wrong side of the circuit. applyRoadLight never hits any of this because
    // it consumes the readback directly, in the readback's own orientation, and
    // never round-trips.
    blob->flip = mEngine->getBackend() == Engine::Backend::OPENGL;

    // WHICH KIND, decided by what the engine is holding rather than by an
    // argument: only one key can be the resident bake's, and a silhouette's is
    // not a scene key. A caller that names neither gets a refusal.
    if (!mBakedKey.empty() && key == mBakedKey) {
        if (!mShadowMap) return false;
        blob->mask = false;
        // EVERYTHING THAT IS NOT A READBACK, NOW. A staged blob that read these
        // at finish time would pair this build's pixels with a later build's
        // matrices — which is the whole reason the split exists.
        putU32(blob->head, kBakeMagic);
        putU32(blob->head, kBakeVersion);
        putU32(blob->head, (uint32_t) mEngine->getBackend());
        putStr(blob->head, mBakedKey);
        putF32(blob->head, mShadowTexel);
        putF32(blob->head, mShadowDepthScale);
        for (int c = 0; c < 4; c++) {
            for (int r = 0; r < 4; r++) putF32(blob->head, mShadowFromWorld[c][r]);
        }
        putU32(blob->tail, (uint32_t) mRoadLight.size());
        blob->tail.insert(blob->tail.end(), (const uint8_t*) mRoadLight.data(),
                (const uint8_t*) mRoadLight.data() + mRoadLight.size() * sizeof(math::half4));
        // BOTH MAPS OR NEITHER. The visibility map used to be optional here,
        // which was harmless while every read landed inside the call — and
        // silently shipped a blob with no vis map the moment one did not.
        if (!issueRead(*blob, mShadowMap, /*asFloat=*/true, -1)) return false;
        if (mVisMap && !issueRead(*blob, mVisMap, /*asFloat=*/false, -1)) {
            retireStaged(*blob);
            return false;
        }
        mStaged.push_back(std::move(blob));
        return true;
    }

    // A silhouette layer. Which layer currently holds this key is what says
    // whether there is anything to stage at all.
    const int backend = backendId();
    int layer = -1;
    uint32_t kind = kMaskKindModel;
    if (key == std::string(kMonsterKey) + "|" + std::to_string(backend)) {
        if (!(mMaskLayerBakedBits & (uint16_t) (1u << kMaskLayerMonster))) return false;
        layer = kMaskLayerMonster;
        kind = kMaskKindMonster;
    } else {
        for (int i = 0; i < kMaskLayerModels && layer < 0; i++) {
            if (!(mMaskLayerBakedBits & (uint16_t) (1u << i))) continue;
            if (maskKeyOf(mMaskLayerKey[i], backend) == key) layer = i;
        }
        if (layer < 0) return false;
    }
    if (!mDecalMaskArray) return false;
    blob->mask = true;
    putU32(blob->head, kMaskMagic);
    putU32(blob->head, kMaskVersion);
    putU32(blob->head, (uint32_t) mEngine->getBackend());
    putU32(blob->head, (uint32_t) kMaskCellW);
    putU32(blob->head, (uint32_t) kMaskCellH);
    putU32(blob->head, kind);
    putStr(blob->head, key);
    if (!issueRead(*blob, mDecalMaskArray, /*asFloat=*/false, layer)) return false;
    mStaged.push_back(std::move(blob));
    return true;
}

// ── Finishing: splice the landed pixels into the snapshot ───────────────────

void TtpRenderer::finishBakeBlob(StagedBlob& blob) {
    const StagedRead& esmRead = *blob.reads[0];
    const uint32_t ew = esmRead.w, eh = esmRead.h;
    const size_t texels = (size_t) ew * eh;
    if (esmRead.px.size() < texels * 16) return;
    // The ESM is R16F and comes back as RGBA float, so the R channel is taken
    // and re-narrowed to the half it is stored as — 2 MB rather than the 16 MB
    // the readback itself needs, and the same bits the texture holds.
    std::vector<math::half> esm(texels);
    const float* src = (const float*) esmRead.px.data();
    for (uint32_t y = 0; y < eh; y++) {
        const float* row = src + (size_t) (blob.flip ? eh - 1 - y : y) * ew * 4;
        math::half* dst = esm.data() + (size_t) y * ew;
        for (uint32_t x = 0; x < ew; x++) dst[x] = math::half(row[x * 4]);
    }

    std::vector<uint8_t>& out = blob.bytes;
    out = blob.head;
    putU32(out, ew);
    putU32(out, eh);
    out.insert(out.end(), (const uint8_t*) esm.data(),
            (const uint8_t*) esm.data() + texels * sizeof(math::half));

    const uint32_t vw = blob.reads.size() > 1 ? blob.reads[1]->w : 0;
    const uint32_t vh = blob.reads.size() > 1 ? blob.reads[1]->h : 0;
    putU32(out, vw);
    putU32(out, vh);
    if (vw && vh) {
        const std::vector<uint8_t>& visRGBA = blob.reads[1]->px;
        std::vector<uint8_t> vis((size_t) vw * vh);
        for (uint32_t y = 0; y < vh; y++) {          // GL-flipped, as above
            const uint8_t* row = visRGBA.data() + (size_t) (blob.flip ? vh - 1 - y : y) * vw * 4;
            uint8_t* dst = vis.data() + (size_t) y * vw;
            for (uint32_t x = 0; x < vw; x++) dst[x] = row[x * 4];
        }
        out.insert(out.end(), vis.begin(), vis.end());
    }
    out.insert(out.end(), blob.tail.begin(), blob.tail.end());
}

void TtpRenderer::finishMaskBlob(StagedBlob& blob) {
    const StagedRead& read = *blob.reads[0];
    const size_t cell = (size_t) kMaskCellW * kMaskCellH * 4;
    if (read.px.size() < cell) return;
    std::vector<uint8_t>& out = blob.bytes;
    out = blob.head;
    for (int y = 0; y < kMaskCellH; y++) {
        const uint8_t* row = read.px.data()
                + (size_t) (blob.flip ? kMaskCellH - 1 - y : y) * kMaskCellW * 4;
        out.insert(out.end(), row, row + (size_t) kMaskCellW * 4);
    }
}

void TtpRenderer::retireStaged(StagedBlob& blob) {
    for (auto& rd : blob.reads) {
        if (rd->rt) mEngine->destroy(rd->rt);
        rd->rt = nullptr;
        // A READ THAT NEVER LANDED IS LEAKED ON PURPOSE. The driver may still
        // hold a pointer into that buffer and there is no tick left that will
        // fire the callback, so freeing it here is a write into freed storage
        // later. RoadLightRead makes the same trade at teardown and says so.
        if (!rd->done) (void) rd.release();
    }
    blob.reads.clear();
}

bool TtpRenderer::readInFlight(const Texture* tex) const {
    for (const auto& s : mStaged) {
        for (const auto& rd : s->reads) {
            if (rd->tex == tex && !rd->done) return true;
        }
    }
    return false;
}

void TtpRenderer::drainTexGraves() {
    for (size_t i = mTexGraves.size(); i-- > 0;) {
        if (readInFlight(mTexGraves[i])) continue;
        mEngine->destroy(mTexGraves[i]);
        mTexGraves.erase(mTexGraves.begin() + (long) i);
    }
}

void TtpRenderer::collectStagedBlobs() {
    if (!mEngine) return;
    for (auto& s : mStaged) {
        if (s->finished || s->reads.empty()) continue;
        bool all = true;
        for (const auto& rd : s->reads) {
            if (!rd->done) { all = false; break; }
        }
        if (!all) continue;
        if (s->mask) finishMaskBlob(*s); else finishBakeBlob(*s);
        s->finished = true;
        retireStaged(*s);
    }
    // A blob that finished with no bytes produced nothing worth keeping (a short
    // read); drop it rather than leave the caller asking about it forever.
    for (size_t i = mStaged.size(); i-- > 0;) {
        if (mStaged[i]->finished && mStaged[i]->bytes.empty()) {
            mStaged.erase(mStaged.begin() + (long) i);
        }
    }
    drainTexGraves();
}

bool TtpRenderer::takeStagedBlob(const std::string& key, std::vector<uint8_t>& out) {
    for (size_t i = 0; i < mStaged.size(); i++) {
        if (mStaged[i]->key != key) continue;
        if (!mStaged[i]->finished || mStaged[i]->bytes.empty()) return false;
        out = std::move(mStaged[i]->bytes);
        mStaged.erase(mStaged.begin() + (long) i);
        return true;
    }
    return false;
}

// ── Import ──────────────────────────────────────────────────────────────────
//
// SELF-DESCRIBING, so there is one entry point and no store argument: the magic
// says which kind of blob these bytes are, and a caller that hands over the
// wrong file gets a refusal rather than a misparse. A blob the engine refuses is
// a MISS, never an error — the scene makes the thing again.

std::string TtpRenderer::importBlob(const uint8_t* bytes, uint32_t len) {
    if (!bytes || len < 16 || !mEngine) return std::string();
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + len;
    uint32_t magic = 0;
    if (!takeU32(p, end, magic)) return std::string();
    if (magic == kBakeMagic) return importBakeBlob(p, end);
    if (magic == kMaskMagic) return importMaskBlob(p, end);
    return std::string();
}

std::string TtpRenderer::importBakeBlob(const uint8_t* p, const uint8_t* end) {
    uint32_t version = 0, backend = 0;
    if (!takeU32(p, end, version) || version != kBakeVersion) return std::string();
    // A blob is in its WRITER's setImage order (see the flip note in stageBlob),
    // and nothing here can re-orient bytes whose convention it cannot know — so
    // a blob from another backend (the boot canary flipping a device between
    // Vulkan and GL) is refused and the scene rebakes.
    if (!takeU32(p, end, backend)
            || backend != (uint32_t) mEngine->getBackend()) return std::string();
    std::string key;
    if (!takeStr(p, end, key)) return std::string();
    // ALREADY RESIDENT. Uploading two textures to arrive where we are costs the
    // ~50 ms this whole path exists to avoid.
    if (key == mBakedKey && mShadowMap) return key;

    float texel = 0, depthScale = 0;
    if (!takeF32(p, end, texel) || !takeF32(p, end, depthScale)) return std::string();
    math::mat4f fromWorld;
    for (int c = 0; c < 4; c++) {
        for (int r = 0; r < 4; r++) {
            if (!takeF32(p, end, fromWorld[c][r])) return std::string();
        }
    }
    uint32_t ew = 0, eh = 0;
    if (!takeU32(p, end, ew) || !takeU32(p, end, eh) || !ew || !eh) return std::string();
    const size_t esmBytes = (size_t) ew * eh * sizeof(math::half);
    if ((size_t) (end - p) < esmBytes) return std::string();
    const uint8_t* esmSrc = p;
    p += esmBytes;
    uint32_t vw = 0, vh = 0;
    if (!takeU32(p, end, vw) || !takeU32(p, end, vh)) return std::string();
    const size_t visBytes = (size_t) vw * vh;
    if ((size_t) (end - p) < visBytes) return std::string();
    const uint8_t* visSrc = p;
    p += visBytes;
    uint32_t roadCount = 0;
    if (!takeU32(p, end, roadCount)) return std::string();
    const size_t roadBytes = (size_t) roadCount * sizeof(math::half4);
    if ((size_t) (end - p) < roadBytes) return std::string();
    const uint8_t* roadSrc = p;

    // UPLOADABLE IS NOT OPTIONAL HERE, and its absence does not report: a
    // setImage into a texture that lacks it hangs this driver outright, with no
    // panic and no log — the bake's own ESM never needed the bit because it is
    // RENDERED into, never uploaded. COLOR_ATTACHMENT stays because the road's
    // fallback readback still builds a RenderTarget over this texture.
    Texture* esm = Texture::Builder()
            .width(ew).height(eh).levels(1)
            .format(Texture::InternalFormat::R16F)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                    | Texture::Usage::UPLOADABLE | Texture::Usage::BLIT_SRC)
            .build(*mEngine);
    if (!esm) return std::string();
    {
        Texture::PixelBufferDescriptor pbd(malloc(esmBytes), esmBytes,
                Texture::Format::R, Texture::Type::HALF,
                [](void* buf, size_t, void*) { free(buf); });
        std::memcpy(pbd.buffer, esmSrc, esmBytes);
        esm->setImage(*mEngine, 0, std::move(pbd));
    }
    Texture* vis = nullptr;
    if (vw && vh) {
        vis = Texture::Builder()
                .width(vw).height(vh).levels(1)
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                        | Texture::Usage::UPLOADABLE | Texture::Usage::BLIT_SRC)
                .build(*mEngine);
        if (vis) {
            Texture::PixelBufferDescriptor pbd(malloc(visBytes), visBytes,
                    Texture::Format::R, Texture::Type::UBYTE,
                    [](void* buf, size_t, void*) { free(buf); });
            std::memcpy(pbd.buffer, visSrc, visBytes);
            vis->setImage(*mEngine, 0, std::move(pbd));
        }
    }
    // Only now is the old set replaced: a blob that failed any check above must
    // leave a resident bake alone rather than half-destroy it.
    replaceShadowMaps(esm, vis);
    mShadowTexel = texel;
    mShadowDepthScale = depthScale;
    mShadowFromWorld = fromWorld;
    mRoadLight.assign((const math::half4*) roadSrc,
            (const math::half4*) roadSrc + roadCount);
    mBakedKey = key;
    return key;
}

// Put one stored layer back and CLAIM it, so the build's own claimMaskLayer
// finds that model already held and skips its bake — the very path a second race
// on one field already takes.
std::string TtpRenderer::importMaskBlob(const uint8_t* p, const uint8_t* end) {
    uint32_t version = 0, backend = 0, w = 0, h = 0, kind = 0;
    if (!takeU32(p, end, version) || version != kMaskVersion) return std::string();
    // A blob is in its writer's byte order and nothing here can re-orient it.
    if (!takeU32(p, end, backend)
            || backend != (uint32_t) mEngine->getBackend()) return std::string();
    if (!takeU32(p, end, w) || w != (uint32_t) kMaskCellW) return std::string();
    if (!takeU32(p, end, h) || h != (uint32_t) kMaskCellH) return std::string();
    if (!takeU32(p, end, kind)) return std::string();
    std::string key;
    if (!takeStr(p, end, key)) return std::string();
    const size_t cell = (size_t) kMaskCellW * kMaskCellH * 4;
    if ((size_t) (end - p) < cell) return std::string();
    if (blobResident(key)) return key;
    if (!ensureDecalMaskArray()) return std::string();

    int slot = -1;
    if (kind == kMaskKindMonster) {
        slot = kMaskLayerMonster;   // one fixed home, because nothing else may live there
    } else {
        for (int i = 0; i < kMaskLayerModels && slot < 0; i++) {
            if (!(mMaskLayerBakedBits & (uint16_t) (1u << i))) slot = i;
        }
        if (slot < 0) return std::string();   // every model layer is spoken for this build
    }
    // The key carries the FNV the claim test compares against; a key this
    // build's own maskBlobKeys could not have produced is not one it can claim.
    uint64_t fnv = 0;
    if (kind != kMaskKindMonster) {
        if (std::sscanf(key.c_str(), "%016llx", (unsigned long long*) &fnv) != 1) return std::string();
    }
    // THE DESCRIPTOR OWNS ITS PIXELS, exactly as importBakeBlob's two uploads do:
    // the caller's bytes only have to survive the CALL, and the upload outlives
    // it. A no-op destructor over those bytes plus a flushAndWait stood here
    // instead and looked equivalent — what it actually drew is in
    // native/renderer/CLAUDE.md, under the blob rules.
    Texture::PixelBufferDescriptor pbd(malloc(cell), cell,
            Texture::Format::RGBA, Texture::Type::UBYTE,
            [](void* buf, size_t, void*) { free(buf); });
    std::memcpy(pbd.buffer, p, cell);
    mDecalMaskArray->setImage(*mEngine, 0, 0, 0, (uint32_t) slot,
            (uint32_t) kMaskCellW, (uint32_t) kMaskCellH, 1, std::move(pbd));
    if (kind != kMaskKindMonster) mMaskLayerKey[slot] = fnv;
    mMaskLayerBakedBits |= (uint16_t) (1u << slot);
    return key;
}

// Swap the resident maps, keeping any texture a staged read is still writing
// into alive until it lands. Destroying one under an outstanding readPixels is a
// write into freed storage — invisible on the backends that finish inside the
// pump, which is every backend that does not need this path.
void TtpRenderer::replaceShadowMaps(Texture* esm, Texture* vis) {
    for (Texture* old : { mShadowMap, mVisMap }) {
        if (!old) continue;
        if (readInFlight(old)) mTexGraves.push_back(old); else mEngine->destroy(old);
    }
    mShadowMap = esm;
    mVisMap = vis;
}
