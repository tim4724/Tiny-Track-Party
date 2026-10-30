// The track-scoped bakes: the sun's visibility maps and the staged-blob
// machinery. TtpRendererImpl.h carries what the topic files share.
#include "TtpRendererImpl.h"

#include <algorithm>
#include <cstdio>
#include <atomic>
#include <chrono>
#include <utility>

#include <utils/Log.h>

// ── The frozen sun shadow ───────────────────────────────────────────────────
// Filament renders a shadow map per VIEW per frame. That is the right default
// for a scene with a moving sun, and exactly wrong here: nothing that casts
// ever moves, and a 4-way split-screen re-renders the identical 2048² depth
// pass four times a frame — once the single biggest cost of split-screen.
//
// So we render our own, once per static scene: an ortho camera down the sun's
// axis fitted to the track, a depth-only render target, and a layer-filtered
// view so only the casters land in it. That depth is filtered into an ESM, and
// the ESM is DECODED here, once, into the visibility maps the receivers tap —
// so the ESM itself is a local of this function and nothing samples it in a
// frame. Filament's own shadow machinery is off entirely.
void TtpRenderer::bakeShadowMap(const TrackBin& tb, const std::string& key) {
    // ITS PHASES ARE LOGGED (PhaseLog): on the Android reference box this is a
    // large slice of a cold static build, and its parts have to be separable
    // before anything can be done about it.
    //
    // IT RECORDS AND SUBMITS; IT NEVER WAITS. Each pass samples the target the
    // pass before it wrote, and each bake-local is destroyed straight after the
    // pass that last samples it. Filament orders both in its command stream — a
    // sample after the write it reads, a destroy after the last command using
    // it — so the GPU works the bake off behind this thread, which also runs the
    // frame loop and the relay's message pump. A `flushAndWait` between the blur
    // passes once held this thread for the whole GPU bake, and a phone's tap
    // queued behind it.
    //
    // The price is paid once per STATIC scene (buildScene): a join, a race launch
    // or a restart on the same track rebuilds the field alone and never reaches
    // here.
    PhaseLog bake;
    // THE CASTERS ARE THE STATIC SCENE, AND CARS CAST NOTHING (setVisibleLayers
    // 0x02 below), so the maps are a function of `key` and nothing in a build
    // of the same key could change them. They are resident here without
    // their scene after an IMPORT (importBlob adopts its blob's key — the cache
    // between runs being consumed) or a static build of this key that failed
    // after its bake. The deck's map is reused with the rest; it is keyed to the
    // road's track space, as much a function of the key as the casters are.
    // The two guards below (shadows off, a road with no verts) both DROP the
    // resident maps on purpose, so this test has to clear them itself rather
    // than sit after them.
    if (mShadowsEnabled && !mRoad.verts.empty() && mRenderer && blobResident(key)) {
        bake.mark("reused");
        utils::slog.i << "ttp shadow bake: REUSED " << key.c_str()
                << " (" << (int) (bake.phases.back().second + 0.5) << " ms)" << utils::io::endl;
        return;
    }
    mBakedKey.clear();   // whatever is resident is about to stop being the truth
    // THROUGH replaceVisMaps, NOT destroy: the previous build may have staged a
    // blob whose readback is still writing into one of these. A scene that
    // bakes no map must not keep the last one's.
    replaceVisMaps(nullptr, nullptr, nullptr);
    // Shadows off (headless automation — see setShadowsEnabled): leave the maps
    // null and let the established no-map path carry it (the binders' white
    // stand-in). A track whose road has no verts reaches the same state one
    // line below.
    if (!mShadowsEnabled) return;
    if (mRoad.verts.empty() || !mRenderer) return;
    constexpr uint32_t SM = 2048;
    // Fit: the road's own bounds, padded for the structures under it and the
    // gantry over it. A tight box is the whole point — texel size is what the
    // shadow's edge resolves to.
    float3 lo{ 1e30f }, hi{ -1e30f };
    for (const Vertex& v : mRoad.verts) {
        lo = min(lo, float3{ v.px, v.py, v.pz });
        hi = max(hi, float3{ v.px, v.py, v.pz });
    }
    lo -= float3{ 4.0f, 8.0f, 4.0f };
    hi += float3{ 4.0f, 8.0f, 4.0f };
    // The set pieces cast too, and they stand off the road. One poking past
    // the box writes its depth into the map's border texels, and CLAMP_TO_EDGE
    // then hands that border to every receiver beyond it: a shadow streaking
    // from the piece to the edge of the ground. So the box takes them in.
    for (const SetFoot& f : mSetFeet) {
        const float ex = std::fabs(f.ax) * f.hx + std::fabs(f.az) * f.hz;
        const float ez = std::fabs(f.az) * f.hx + std::fabs(f.ax) * f.hz;
        lo = min(lo, float3{ f.x - ex - 1.0f, lo.y, f.z - ez - 1.0f });
        hi = max(hi, float3{ f.x + ex + 1.0f, f.top + 1.0f, f.z + ez + 1.0f });
    }
    const float3 centre = (lo + hi) * 0.5f;
    // Distance to stand the light off at: the bounding-sphere radius still
    // decides that (it has to clear the geometry from any angle), but it no
    // longer decides the ortho BOX — see below.
    const float radius = length(hi - lo) * 0.5f;

    Texture* depth = Texture::Builder()
            .width(SM).height(SM).levels(1)
            .format(Texture::InternalFormat::DEPTH24)
            .usage(Texture::Usage::DEPTH_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .build(*mEngine);
    if (!depth) return;
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::DEPTH, depth)
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
    cam->lookAt(centre + kToSun * (radius * 2.0f), centre, float3{ 0, 0, 1 });
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
    // visibility bake's single bilinear tap. So 0.28: most of the sharpening, none of
    // the return of the texel grid. Pair it with ttp_sunvis.inc's kPenumbraWorld,
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
    // The decode's two numbers. The slope-scaled bias wants the COARSER of the
    // two axes; the depth scale is normalised depth per world unit, so a bias
    // expressed in metres means the same thing on a small circuit and a large
    // one. esm.map is filled once the blur has made it.
    SunEsm esm;
    esm.texel = std::max(vhi.x - vlo.x, vhi.y - vlo.y) / (float) SM;
    esm.depthScale = 1.0f
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
    bake.mark("setup");
    mRenderer->renderStandaloneView(view);
    mRenderer->setClearOptions(prev);
    bake.mark("depth");

    // World → shadow texture space. Read the matrices BEFORE the camera is
    // destroyed — doing it after is a use-after-free that shows up as a wasm
    // out-of-bounds trap three call frames deep, with nothing pointing back
    // here.
    //
    // Filter the raw depth into a blurred EXPONENTIAL map, then throw the depth
    // away. See vesm.mat: exp(-k·d) is linear under filtering, so the softness
    // is baked in here ONCE and the visibility bakes' decode is a single
    // bilinear tap per texel instead of an N-tap PCF. It also
    // means the map's resolution no longer sets the edge's softness — the blur
    // does — so ESM_SM can be well under the depth map's own size.
    // mPresentVB is the shared fullscreen triangle; without vpresent there is none.
    // ENSURED HERE, never left to another pass: the AA path is the only other
    // creator and both TV shells run AA off, so a quad some earlier pass
    // happened to create was a sun shadow that vanished whenever that pass
    // was skipped.
    ensurePresentQuad();
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
        constexpr uint32_t ESM_SM = 1024;

        // TWO PASSES, one per axis. Separating it is what makes a wide kernel
        // affordable: sigma is what the penumbra inherits, and a single-pass
        // square costs a row's taps SQUARED where two passes cost twice a row.
        //
        // The penumbra is specified in WORLD units so the edge is equally soft
        // on the smallest circuit and the largest; esm.texel converts it to
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
                        / std::max(1e-4f, esm.texel), 40.0f / 3.0f);

        // HALF float, not full. The decode is a single BILINEAR tap, and
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
        // per-tap exponential and the tap sum are computed at full precision
        // in the shader either way.
        Texture* out = Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R16F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine);
        // Ping target for the horizontal pass. Its own filtering matters: pass
        // two samples it at whole-texel offsets, so NEAREST would be exact, but
        // LINEAR costs nothing and forgives the half-texel rounding.
        Texture* tmp = out ? Texture::Builder()
                .width(ESM_SM).height(ESM_SM).levels(1)
                .format(Texture::InternalFormat::R16F)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
                .build(*mEngine) : nullptr;
        if (out && tmp) {
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
                { depth, true,  { 1.0f, 0.0f }, tmp },
                { tmp,   false, { 0.0f, 1.0f }, out },
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
                bake.mark("blur");
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
            esm.map = out;
        } else if (out) {
            mEngine->destroy(out);
        }
    }
    // The raw depth is spent either way. Without an ESM (R16F needs
    // EXT_color_buffer_float, and the fullscreen triangle needs vpresent) no
    // visibility map is baked, and the binders' white stand-in reads as fully
    // lit.
    mEngine->destroy(depth);

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

    // THE VISIBILITY MAPS: the exact ESM decode, evaluated ONCE over the
    // light's own grid by rendering the receivers through this same camera with
    // vvis.mat. A receiver then pays one bilinear R8 tap per fragment instead of
    // the whole chain — see vground.mat. The target texel grid is
    // shadowFromWorld's own [0,1]² by construction (same camera, same bias), so
    // no second transform exists to drift.
    //
    // TWO MAPS, because a light-space map is SINGLE-VALUED: it holds one surface
    // per texel. Drawing the structures into the ground's map would overwrite
    // the ground texels they cover as seen from the sun — which are exactly the
    // texels of their own cast shadow — and erase the shadow a free-standing
    // loop shaft throws on the ground. So the ground keeps a map of its own (one
    // surface, no depth buffer), and the structures and berms share a second,
    // DEPTH-TESTED so the surface nearest the sun wins each texel.
    //
    // 512²: the softness lives in the ESM (whose own floor measured at 512 —
    // 256 scallops), and these maps only re-sample it.
    const auto bakeVis = [&](std::initializer_list<const Mesh*> meshes,
            bool depthTested) -> Texture* {
        std::vector<BakeDraw> draws;
        for (const Mesh* m : meshes) {
            if (m->vb && m->ib && !m->idx.empty() && !m->custom0.empty()) {
                draws.push_back({ m->vb, m->ib, m->idx.size() });
            }
        }
        if (draws.empty()) return nullptr;
        MaterialInstance* vmi = mVisMaterial->createInstance();
        bindShadowMap(vmi, esm);
        Texture* vis = bakeR8(vmi, cam, 512, 512, draws, depthTested);
        mEngine->destroy(vmi);
        return vis;
    };
    if (esm.map) {
        if (mVisMaterial) {
            mVisMap = bakeVis({ &mGround }, false);
            mStructVisMap = bakeVis({ &mStructures, &mBerms }, true);
        }
        bake.mark("vis");
        bakeRoadVis(tb, esm);
        bake.mark("roadVis");
        mEngine->destroy(esm.map);   // the ESM was only ever the bakes' input
    }

    mEngine->destroy(view);
    mEngine->destroy(rt);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    mBakedKey = key;   // the resident maps are now this key's
    bake.print("ttp shadow bake:");
}

// ── The visibility bakes' one shape ─────────────────────────────────────────
//
// NO WAIT: nothing reads these back inside the build, and Filament orders the
// pass against everything destroyed after it — the ESM, the caller's instance
// and buffers (the tap happens in a later frame's draw, the blob's read on a
// later frame beat).
Texture* TtpRenderer::bakeR8(MaterialInstance* mi, Camera* cam, uint32_t w, uint32_t h,
        const std::vector<BakeDraw>& draws, bool depthTested) {
    // BLIT_SRC: the blob export reads the map back, and a readPixels whose
    // COLOR0 was not made blit-readable returns whatever the driver likes.
    Texture* vis = Texture::Builder()
            .width(w).height(h).levels(1)
            .format(Texture::InternalFormat::R8)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                    | Texture::Usage::BLIT_SRC)
            .build(*mEngine);
    if (!vis) return nullptr;
    Texture* zbuf = depthTested ? Texture::Builder()
            .width(w).height(h).levels(1)
            .format(Texture::InternalFormat::DEPTH24)
            .usage(Texture::Usage::DEPTH_ATTACHMENT)
            .build(*mEngine) : nullptr;
    mi->setDepthWrite(zbuf != nullptr);
    mi->setDepthCulling(zbuf != nullptr);
    Scene* sc = mEngine->createScene();
    std::vector<utils::Entity> ents;
    for (const BakeDraw& d : draws) {
        const utils::Entity e = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, mi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        d.vb, d.ib, 0, d.count)
                .culling(false).castShadows(false).receiveShadows(false)
                .build(*mEngine, e);
        sc->addEntity(e);
        ents.push_back(e);
    }
    RenderTarget::Builder rtb;
    rtb.texture(RenderTarget::AttachmentPoint::COLOR, vis);
    if (zbuf) rtb.texture(RenderTarget::AttachmentPoint::DEPTH, zbuf);
    RenderTarget* rt = rtb.build(*mEngine);
    View* v = mEngine->createView();
    v->setScene(sc);
    v->setCamera(cam);
    v->setViewport({ 0, 0, w, h });
    v->setRenderTarget(rt);
    v->setPostProcessingEnabled(false);
    v->setShadowingEnabled(false);
    v->setFrustumCullingEnabled(false);
    const Renderer::ClearOptions prev = mRenderer->getClearOptions();
    Renderer::ClearOptions co{};
    co.clear = true;
    // FULLY LIT where no receiver lands. The light-space maps' margin rows are
    // caster-free (the ESM fit reserved them), and the deck map's rows outside
    // its own lat span are never sampled under CLAMP_TO_EDGE — but a cleared
    // target must not start as ink either way.
    co.clearColor = { 1, 1, 1, 1 };
    mRenderer->setClearOptions(co);
    mRenderer->renderStandaloneView(v);
    mRenderer->setClearOptions(prev);
    mEngine->destroy(v);
    mEngine->destroy(rt);
    if (zbuf) mEngine->destroy(zbuf);
    for (utils::Entity e : ents) {
        sc->remove(e);
        mEngine->destroy(e);
        utils::EntityManager::get().destroy(e);
    }
    mEngine->destroy(sc);
    return vis;
}

// ── The DECK's sun-visibility bake ──────────────────────────────────────────
//
// One draw of the road, rasterized by its OWN uv0 into a track-space R8 map.
// vroadvis.mat carries the whole argument for why the deck needs a map at all
// and why it cannot be the light's grid; this is the plumbing.
//
// NO READBACK inside the build: the ESM stays on the GPU and is sampled by the
// bake shader, where it used to be pulled to the CPU so the road's vertex light
// could evaluate the same decode per vertex.
void TtpRenderer::bakeRoadVis(const TrackBin& tb, const SunEsm& esm) {
    mRoadVisLatHalf = 0;
    if (!mRoadVisMaterial || !mRenderer || !mRoad.ib
            || mRoad.verts.empty() || mRoad.uvs.size() < mRoad.verts.size()
            || mRoad.custom0.size() < mRoad.verts.size()) {
        return;
    }
    // The DECK's own half-span. Not the rubber layer's maxHalf + 0.7: an
    // off-deck lat has to clamp ONTO the deck edge here, not into a margin.
    float maxHalf = tb.roadWidth * 0.5f;
    for (const TrackBin::Sample& r : tb.rings) maxHalf = std::max(maxHalf, r.width * 0.5f);
    if (!(maxHalf > 0.0f) || !(tb.length > 1.0f)) return;

    // SIZED FROM THE PENUMBRA, not from the deck's texel budget: ~13 texels/u
    // on both axes puts ~8 texels across ttp_sunvis.inc's kPenumbraWorld, which
    // is smooth under a bilinear tap. The width cap is what
    // binds on a long lap (as it does for the rubber layer), and where it binds
    // the map simply gets coarser ALONG the track — the axis the old per-vertex
    // term was already fine on, since the rings are 0.48 u apart.
    const uint32_t W = (uint32_t) std::min((float) mMaxTextureDim,
            std::max(512.0f, std::round(tb.length * 13.0f)));
    const uint32_t H = (uint32_t) std::min(256.0f,
            std::max(64.0f, std::round(2.0f * maxHalf * 13.0f)));

    // The bake mesh: the road's own topology, with POSITION already in clip
    // space (track uv) and custom0 carrying what the fragment needs. Built here
    // and destroyed below — it is a few hundred KB for one draw.
    // HEAP-OWNED, WITH A RELEASE CALLBACK, and this is not defensive. A
    // BufferDescriptor over a LOCAL is a use-after-free that no flush covers:
    // the upload is asynchronous, so the driver may read these bytes long after
    // this function has returned and its stack is gone. Measured on the Android
    // box, where it cost the whole render loop — the warm launch built its
    // scene, emitted one readout and then presented nothing more.
    //
    // Same law the blob import already carries ("AN IMPORT OWNS ITS PIXELS") and
    // the same one mRoad's own CPU copies obey by living for the whole run.
    const size_t nv = mRoad.verts.size();
    float* pos = new float[nv * 3];
    float* probe = new float[nv * 4];
    const auto freeFloats = [](void* buf, size_t, void*) {
        delete[] static_cast<float*>(buf);
    };
    const float invLen = 1.0f / tb.length;
    const float invLat = 0.5f / maxHalf;
    for (size_t i = 0; i < nv; i++) {
        const float2 tc = mRoad.uvs[i];
        // OFF-DECK STRIPS CARRY OFF_DECK_LAT AND CLIP THEMSELVES OUT. The deck
        // flag is a per-quad constant, so such a quad has all four corners far
        // outside the viewport and is dropped whole.
        pos[i * 3 + 0] = tc.x * invLen * 2.0f - 1.0f;
        pos[i * 3 + 1] = (tc.y * invLat + 0.5f) * 2.0f - 1.0f;
        pos[i * 3 + 2] = 0.0f;
        const float3 wp{ mRoad.verts[i].px, mRoad.verts[i].py, mRoad.verts[i].pz };
        const float4 uv = mShadowFromWorld * float4{ wp, 1.0f };
        probe[i * 4 + 0] = uv.x;
        probe[i * 4 + 1] = uv.y;
        probe[i * 4 + 2] = uv.z;
        probe[i * 4 + 3] = mRoad.custom0[i].w;   // the NoL the deck draws with
    }
    VertexBuffer* vb = VertexBuffer::Builder()
            .vertexCount((uint32_t) nv).bufferCount(2)
            .attribute(VertexAttribute::POSITION, 0, VertexBuffer::AttributeType::FLOAT3)
            .attribute(VertexAttribute::CUSTOM0, 1, VertexBuffer::AttributeType::FLOAT4)
            .build(*mEngine);
    if (!vb) { delete[] pos; delete[] probe; return; }
    vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
            pos, nv * 3 * sizeof(float), freeFloats));
    vb->setBufferAt(*mEngine, 1, VertexBuffer::BufferDescriptor(
            probe, nv * 4 * sizeof(float), freeFloats));

    MaterialInstance* mi = mRoadVisMaterial->createInstance();
    bindShadowMap(mi, esm);
    utils::Entity camEnt = utils::EntityManager::get().create();
    Camera* cam = mEngine->createCamera(camEnt);
    cam->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);
    Texture* vis = bakeR8(mi, cam, W, H, { { vb, mRoad.ib, mRoad.idx.size() } }, false);
    mEngine->destroyCameraComponent(camEnt);
    utils::EntityManager::get().destroy(camEnt);
    mEngine->destroy(mi);
    mEngine->destroy(vb);   // its descriptors free themselves
    if (!vis) return;
    mRoadVisMap = vis;
    mRoadVisLatHalf = maxHalf;
}

// ── Derived bytes, kept between runs ────────────────────────────────────────
//
// WHY THIS CROSSES THE ABI AT ALL. The sun bake is most of a scene build's GPU
// time on the Android reference box and it is resolution-independent — its
// sizes are a function of the track and the device's texture ceiling, and no
// viewport, window or render-scale value reaches it — so it is worth keeping
// between RUNS, not just between builds. Keeping something between runs means
// a file, and a file is the shell's job (`ttp_abi.h`: the transport stays on
// the host side by design). So this hands over bytes and takes them back, and
// decides nothing about where they live.
//
// A BLOB CARRIES EXACTLY WHAT THE RUNTIME SHADERS SAMPLE: the three visibility
// maps and the two numbers that address them (shadowFromWorld, the deck map's
// lat span). The ESM is a bake intermediate and never leaves bakeShadowMap.
//
// EVERY BLOB CARRIES ITS OWN KEY, and that is what makes a stale file harmless
// rather than invisible: import adopts the key it finds, and the next build's
// own key has to match it before anything is reused. What a key CANNOT cover is
// the engine that produced it — a shader edit reproduces the same
// key and would silently serve shadows baked by the old
// vesm. That invalidation is the shell's GENERATION, which ttp/blobstore.h
// folds into the file's NAME so a new binary cannot even name the old blob.
namespace {
constexpr uint32_t kBakeMagic = 0x42505454u;  // 'TTPB', little-endian
// v2: the writing BACKEND rides the header and import refuses a foreign blob —
// see the flip note in stageBlob. v1 blobs written under Vulkan are mirrored,
// so the bump also retires every v1 file.
// v3: the road's baked vertex light left the tail.
// v4: the ESM left the blob; it carries the three visibility maps instead
// (ground, structures, deck), each as width, height and R8 rows.
constexpr uint32_t kBakeVersion = 4u;

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

}  // namespace

// ── What this build could keep, and what it already holds ───────────────────

// RESIDENT means the VISIBILITY MAPS are, for this key: they are what the
// receivers sample, and the bake's reuse test, import and export all ask this.
// The structures' map is not required — a track with no structures has none.
bool TtpRenderer::blobResident(const std::string& key) const {
    if (key.empty()) return false;
    return key == mBakedKey && mVisMap && mRoadVisMap;
}

// ── Staging: snapshot the metadata, issue the reads ─────────────────────────

bool TtpRenderer::issueRead(StagedBlob& blob, Texture* tex) {
    if (!tex || !mRenderer) return false;
    const uint32_t W = tex->getWidth(0), H = tex->getHeight(0);
    RenderTarget* rt = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, tex)
            .build(*mEngine);
    if (!rt) return false;
    // THE DESTINATION IS THE StagedRead's OWN BUFFER from the start, because a
    // read that does not finish here keeps being written into after this returns
    // — so the buffer may not be moved, resized or freed on the way out.
    auto rd = std::make_unique<StagedRead>();
    rd->tex = tex;
    rd->w = W;
    rd->h = H;
    rd->rt = rt;
    rd->px.resize((size_t) W * H * 4);
    Texture::PixelBufferDescriptor pbd(rd->px.data(), rd->px.size(),
            Texture::Format::RGBA, Texture::Type::UBYTE,
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
    // Only the resident bake's key names anything to stage; any other key gets
    // a refusal.
    if (!blobResident(key)) return false;
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
    // wrong side of the circuit.
    blob->flip = mEngine->getBackend() == Engine::Backend::OPENGL;

    // EVERYTHING THAT IS NOT A READBACK, NOW. A staged blob that read these
    // at finish time would pair this build's pixels with a later build's
    // matrices — which is the whole reason the split exists.
    putU32(blob->head, kBakeMagic);
    putU32(blob->head, kBakeVersion);
    putU32(blob->head, (uint32_t) mEngine->getBackend());
    putStr(blob->head, mBakedKey);
    for (int c = 0; c < 4; c++) {
        for (int r = 0; r < 4; r++) putF32(blob->head, mShadowFromWorld[c][r]);
    }
    putF32(blob->head, mRoadVisLatHalf);
    // ONE READ PER MAP, in the blob's order. An absent map (a track with no
    // structures) is an empty read that has already landed, so it writes as
    // 0 x 0 and the order never shifts.
    for (Texture* map : { mVisMap, mStructVisMap, mRoadVisMap }) {
        if (!map) {
            blob->reads.push_back(std::make_unique<StagedRead>());
            blob->reads.back()->done = true;
        } else if (!issueRead(*blob, map)) {
            retireStaged(*blob);
            return false;
        }
    }
    mStaged.push_back(std::move(blob));
    return true;
}

// ── Finishing: splice the landed pixels into the snapshot ───────────────────

// Each map comes back as RGBA bytes; the R channel is what the texture holds.
// A short read leaves the bytes empty, and collectStagedBlobs drops the blob.
void TtpRenderer::finishBakeBlob(StagedBlob& blob) {
    std::vector<uint8_t>& out = blob.bytes;
    out = blob.head;
    for (const auto& rd : blob.reads) {
        const uint32_t w = rd->w, h = rd->h;
        if (rd->px.size() < (size_t) w * h * 4) { out.clear(); return; }
        putU32(out, w);
        putU32(out, h);
        for (uint32_t y = 0; y < h; y++) {          // GL-flipped, see stageBlob
            const uint8_t* row = rd->px.data() + (size_t) (blob.flip ? h - 1 - y : y) * w * 4;
            for (uint32_t x = 0; x < w; x++) out.push_back(row[x * 4]);
        }
    }
}

void TtpRenderer::retireStaged(StagedBlob& blob) {
    for (auto& rd : blob.reads) {
        if (rd->rt) mEngine->destroy(rd->rt);
        rd->rt = nullptr;
        // A READ THAT NEVER LANDED IS LEAKED ON PURPOSE. The driver may still
        // hold a pointer into that buffer and there is no tick left that will
        // fire the callback, so freeing it here is a write into freed storage
        // later.
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
        finishBakeBlob(*s);
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
// SELF-DESCRIBING, so there is no store argument: a caller that hands over
// the wrong file gets a refusal on the magic rather than a misparse. A blob the
// engine refuses is a MISS, never an error — the scene makes the thing again.
//
// Each map's size is the BLOB's, never recomputed: the deck map's width
// depends on the device's texture ceiling, and the sampler is in normalized uv,
// so any size the writer chose samples correctly.

std::string TtpRenderer::importBlob(const uint8_t* bytes, uint32_t len) {
    if (!bytes || len < 16 || !mEngine) return std::string();
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + len;
    uint32_t magic = 0, version = 0, backend = 0;
    if (!takeU32(p, end, magic) || magic != kBakeMagic) return std::string();
    if (!takeU32(p, end, version) || version != kBakeVersion) return std::string();
    // A blob is in its WRITER's setImage order (see the flip note in stageBlob),
    // and nothing here can re-orient bytes whose convention it cannot know — so
    // a blob from another backend (the boot canary flipping a device between
    // Vulkan and GL) is refused and the scene rebakes.
    if (!takeU32(p, end, backend)
            || backend != (uint32_t) mEngine->getBackend()) return std::string();
    std::string key;
    if (!takeStr(p, end, key)) return std::string();
    // ALREADY RESIDENT. Uploading the maps to arrive where we are costs the
    // time this whole path exists to avoid.
    if (blobResident(key)) return key;

    math::mat4f fromWorld;
    for (int c = 0; c < 4; c++) {
        for (int r = 0; r < 4; r++) {
            if (!takeF32(p, end, fromWorld[c][r])) return std::string();
        }
    }
    float latHalf = 0;
    if (!takeF32(p, end, latHalf)) return std::string();
    // Ground, structures, deck — stageBlob's order. Parsed whole before a
    // texture exists, so a short blob costs nothing to refuse.
    struct Map { uint32_t w = 0, h = 0; const uint8_t* src = nullptr; } maps[3];
    for (Map& m : maps) {
        if (!takeU32(p, end, m.w) || !takeU32(p, end, m.h)) return std::string();
        // The bake's own cap, and what keeps w * h from wrapping a 32-bit
        // size_t on a corrupt header.
        if (m.w > mMaxTextureDim || m.h > mMaxTextureDim) return std::string();
        const size_t n = (size_t) m.w * m.h;
        if ((size_t) (end - p) < n) return std::string();
        m.src = p;
        p += n;
    }
    if (!maps[0].w || !maps[0].h || !maps[2].w || !maps[2].h) return std::string();

    // UPLOADABLE IS NOT OPTIONAL HERE, and its absence does not report: a
    // setImage into a texture that lacks it hangs this driver outright, with no
    // panic and no log. COLOR_ATTACHMENT and BLIT_SRC stay because an imported
    // map can be EXPORTED again (a store emptied under a resident bake — what
    // check:blob-cache drives), and issueRead builds a RenderTarget over it.
    //
    // THE DESCRIPTORS OWN THEIR PIXELS: the caller's bytes only have to survive
    // the CALL, and the upload outlives it (native/renderer/CLAUDE.md, under
    // the blob rules, has what a borrowed buffer drew).
    Texture* tex[3] = {};
    for (int i = 0; i < 3; i++) {
        const Map& m = maps[i];
        if (!m.w || !m.h) continue;
        tex[i] = Texture::Builder()
                .width(m.w).height(m.h).levels(1)
                .format(Texture::InternalFormat::R8)
                .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                        | Texture::Usage::UPLOADABLE | Texture::Usage::BLIT_SRC)
                .build(*mEngine);
        if (!tex[i]) {
            for (Texture* t : tex) if (t) mEngine->destroy(t);
            return std::string();
        }
        const size_t n = (size_t) m.w * m.h;
        Texture::PixelBufferDescriptor pbd(malloc(n), n,
                Texture::Format::R, Texture::Type::UBYTE,
                [](void* buf, size_t, void*) { free(buf); });
        std::memcpy(pbd.buffer, m.src, n);
        tex[i]->setImage(*mEngine, 0, std::move(pbd));
    }
    // Only now is the old set replaced: a blob that failed any check above must
    // leave a resident bake alone rather than half-destroy it.
    //
    // AND ANY SCENE NOT OF THIS KEY GOES FIRST. A release keeps the static
    // scene, so a track change offers the new key's blob while the old scene's
    // receivers still sample the maps this is about to destroy — as does a
    // scene whose key a latch dropped. The build that follows is of the offered
    // key and would release it anyway; doing it here means no live instance
    // outlives its texture.
    if (key != mStaticKey) releaseScene();
    replaceVisMaps(tex[0], tex[1], tex[2]);
    mShadowFromWorld = fromWorld;
    mRoadVisLatHalf = latHalf;
    mBakedKey = key;
    return key;
}

// Swap the resident maps, keeping any texture a staged read is still writing
// into alive until it lands. Destroying one under an outstanding readPixels is a
// write into freed storage, and every backend's reads land on a later frame.
//
// The receivers' instances still point at the OLD textures until the next
// static build binds the new ones — which is why importBlob releases a resident
// static scene of another key before it swaps, and a bake only runs inside a
// static build, so no live instance outlives this swap.
void TtpRenderer::replaceVisMaps(Texture* ground, Texture* structures, Texture* road) {
    for (Texture* old : { mVisMap, mStructVisMap, mRoadVisMap }) {
        if (!old) continue;
        if (readInFlight(old)) mTexGraves.push_back(old); else mEngine->destroy(old);
    }
    mVisMap = ground;
    mStructVisMap = structures;
    mRoadVisMap = road;
}
