// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"
#include "TtpRendererKit.h"


bool TtpRenderer::trackFraming(TtpTrackFraming& out) const {
    if (!mTrack || mTrack->samples.empty()) return false;
    float3 lo = mTrack->samples[0].pos, hi = lo;
    for (const TrackBin::Sample& s : mTrack->samples) {
        lo = min(lo, s.pos);
        hi = max(hi, s.pos);
    }
    const float3 c = (lo + hi) * 0.5f, size = hi - lo;
    out.centerX = c.x; out.centerY = c.y; out.centerZ = c.z;
    out.sizeX = size.x; out.sizeY = size.y; out.sizeZ = size.z;
    out.fogTune = mTrack->fogTune;
    return true;
}

float TtpRenderer::maxOrbitDist(float radius, float height) const {
    if (!mTrack || mTrack->samples.empty()) return 0;
    TtpTrackFraming f{};
    trackFraming(f);
    const float ringY = f.centerY + height;
    float worst = 0;
    for (const TrackBin::Sample& s : mTrack->samples) {
        const float horiz = std::hypot(s.pos.x - f.centerX, s.pos.z - f.centerZ) + radius;
        const float d = std::hypot(horiz, s.pos.y - ringY);
        if (d > worst) worst = d;
    }
    return worst;
}

// The split-screen grid for n cells. The column scoring — including the hard
// landscape preference — lives in ttp_grid_cols (renderer/include/ttp_render.h)
// so that the renderer's viewport split and the runtime's per-cell camera aspect
// are one definition rather than copies that can disagree about where a cell is;
// the reasoning lives with it there.
//
// Both counts together because a caller wants the pair: cellRect tiles with
// them. Handing back the columns alone left the `(n + cols - 1) / cols` beside
// each caller, which is the shape of copy this grid has already drifted through
// once.
TtpRenderer::GridDims TtpRenderer::gridDims(uint32_t n) const {
    const uint32_t cols = ttp_grid_cols(n, mWidth, mHeight);
    return { cols, (n + cols - 1) / cols };
}

// Where cell i is drawn: its tile brought into the aspect band, with what that
// trims becoming a bar. Only one end can bind. Past the cap loses WIDTH; under
// the base loses HEIGHT, so a short cell still shows the base picture.
//
// The grid is fitted AS ONE PIECE and centred, so bars land on the screen's outer
// edges. Fitting each cell alone would put a gutter down the middle of a 2x2 on
// an ultrawide — the same pixels, arranged as a seam through the layout. Bars
// cost nothing to draw: the clear colour is black and the scene target is cleared
// whole by the frame's first view.
//
// Rounds rather than truncates: 16.0f/9.0f is 1.77777779, so a true 16:9 tile
// measures 1280 / BASE == 719.99997, and truncating would shave a row off every
// 16:9 display to satisfy a shape it already had.
//
// Bottom-left origin, because GL viewports are; row 0 is the TOP row, as the
// DOM HUD lays it out (Stage.js has the same rules, pinned to these).
TtpRenderer::CellRect TtpRenderer::cellRect(uint32_t n, uint32_t i) const {
    const GridDims g = gridDims(n);
    const uint32_t cols = g.cols, rows = g.rows;
    uint32_t cw = mWidth / cols, ch = mHeight / rows;
    const uint32_t capW = (uint32_t) std::lround((float) ch * CELL_MAX_ASPECT);
    if (capW < cw) {
        cw = capW;
    } else {
        const uint32_t baseH = (uint32_t) std::lround((float) cw / CELL_BASE_ASPECT);
        if (baseH < ch) ch = baseH;
    }
    // Centre what the columns and rows actually cover, so integer division can't
    // drift the grid off-centre by up to cols-1 (rows-1) pixels.
    const uint32_t x0 = (mWidth - cw * cols) / 2;
    const uint32_t y0 = (mHeight - ch * rows) / 2;
    const uint32_t col = i % cols, row = i / cols;
    return { (int32_t) (x0 + col * cw),
             (int32_t) (mHeight - y0 - (row + 1) * ch), cw, ch };
}

// The projection input for an n-cell layout: the shape of the rect a cell really
// renders into, which is the fitted one and never the raw tile.
//
// THE VERTICAL VIEW IS NOT A FUNCTION OF THE LAYOUT AT ALL, which is what this
// used to return a second number for. Every cell gets the rig's authored fov, so
// the only thing a split can do to the picture is widen it within the band, and
// the difference between a stacked pair and a side-by-side one is exactly the
// difference between two window shapes at one player. Three spellings of a
// height fraction shipped before that one: the cell against the SURFACE (the
// picture re-framed as a window resized), the cell against the SINGLE-CELL
// picture (same, once a letterbox bar existed to import), and the cell against
// the GRID (stable under resize, but it made the 2-player stack and the
// 2-player row two different cameras). See buildFrame.
float TtpRenderer::cellAspect(uint32_t n) const {
    const CellRect r = cellRect(n ? n : 1, 0);
    return (float) r.w / (float) (r.h ? r.h : 1u);
}

TtpCellRect TtpRenderer::cellRectTopLeft(uint32_t n, uint32_t i) const {
    if (i >= n) return TtpCellRect{ 0u, 0u, 0u, 0u };
    const CellRect r = cellRect(n, i);
    return TtpCellRect{ (uint32_t) r.x, (uint32_t) ((int32_t) mHeight - r.y - (int32_t) r.h),
                        r.w, r.h };
}

// The fog colour to hand Filament, pre-graded.
//
// FOG IS NOT A POST PASS HERE — surface_main.fs composites it inside every
// surface shader, right after material() returns — so with the grade moved into
// the materials (ttp_grade.inc) the value it blends toward has to be sRGB too,
// or every distant surface fades toward a colour that skipped the encode.
//
// The awkward part is the iblLuminance divide, and it is not avoidable: the
// shader's last step before compositing is `fogColor *= iblLuminance`, so what
// we hand over is the displayed colour PRE-DIVIDED by a scale Filament applies
// on the other side. Both factors are Filament's own (IndirectLight::getIntensity
// and Exposure::exposure of the camera), never a copy of its formula.
//
// What this CANNOT fix, and what a reader should know before judging a
// screenshot: the composite itself is now a lerp in gamma space. Fog reaches
// less far into the midtones than it did — around 0.05 sRGB at half opacity —
// across every fogged surface in the frame. That is the visible price of the
// move, and it is priced in the frame, not here.
float3 TtpRenderer::fogColorGraded(const Camera* cam) const {
    const float lum = (mAmbient && cam)
            ? mAmbient->getIntensity() * Exposure::exposure(*cam) : 0.0f;
    if (!(lum > 0.0f)) return gradeSrgb(mFogColor);
    return gradeSrgb(mFogColor * lum) / lum;
}

// Filament's exponential fog standing in for a three.js LINEAR ramp [near,
// far]. Fitted by least squares WEIGHTED BY SCREEN AREA (a ground plane at
// distance d covers ∝1/d² pixels, so the near half of the ramp carries most of
// the frame): onset a fifteenth of the span past `near`, density 1.85 over the
// span. At the shipped race profile (70 → 170) that is 77.5 / 0.0185 — mean
// |Δfog| 0.055 against the ramp, where fitting the far end alone crushed the
// middle and a uniform-weight fit under-fogged the near deck.
static View::FogOptions fogFor(float near, float far, const float3& color) {
    View::FogOptions fog{};
    fog.color = color;
    fog.heightFalloff = 0.0f;
    fog.cutOffDistance = 400.0f; // keeps the SKY_R dome unfogged (fog:false in the JS)
    if (!(far > near)) { fog.enabled = false; return fog; }
    const float span = far - near;
    fog.distance = near + 0.075f * span;
    fog.density = 1.85f / span;
    fog.enabled = true;
    return fog;
}

// The scene buffer (canvas-sized RGBA8 + depth) all the cells draw into, plus
// the one-triangle view that grades it onto the canvas. Creation only — the
// teardown half lives in resize(), because freeing a target the views still
// point at has to happen BETWEEN frames: doing it inside beginFrame/endFrame
// (which is where render() would notice a size change) aborts the module.
// Without vpresent.filamat this does nothing and the cells fall back to
// Filament's own post chain — an old asset set still renders, just slower.
void TtpRenderer::ensureSceneTarget() {
    if (!mPresentMaterial || !mWidth || !mHeight || mSceneRT) return;
    // RGBA8, holding sRGB. THE FORMAT FOLLOWS THE CONTENT, and the content
    // changed: the scene materials grade themselves now (ttp_grade.inc), so
    // what lands here is displayed colour, not radiance.
    //
    // This was R11F_G11F_B10F while the buffer held LINEAR, for a real reason —
    // a linear 8-bit step becomes a whole visible sRGB step once something
    // expands the darks, and the parity diff rose 4.0 → 4.5 mean |Δ| over the
    // frame catalogue purely from that. sRGB inverts the argument: eight bits
    // spent in sRGB are eight bits spent where the eye is, exactly the
    // quantisation the 8-bit canvas will apply anyway. Going the other way and
    // keeping the float buffer would have been WORSE than either, since B10F
    // carries a five-bit mantissa and an sRGB blue near 1.0 would step 4/255 —
    // banding in every sky gradient.
    //
    // Still four bytes a pixel either way. No alpha is used: the view is OPAQUE
    // and the present ignores it (blending reads source alpha, not destination).
    mSceneColor = Texture::Builder()
            .width(mWidth).height(mHeight).levels(1)
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE)
            .format(Texture::InternalFormat::RGBA8)
            .build(*mEngine);
    mSceneDepth = Texture::Builder()
            .width(mWidth).height(mHeight).levels(1)
            .usage(Texture::Usage::DEPTH_ATTACHMENT)
            .format(Texture::InternalFormat::DEPTH32F)
            .build(*mEngine);
    mSceneRT = RenderTarget::Builder()
            .texture(RenderTarget::AttachmentPoint::COLOR, mSceneColor)
            .texture(RenderTarget::AttachmentPoint::DEPTH, mSceneDepth)
            .build(*mEngine);

    if (!mPresentInstance) {
        mPresentInstance = mPresentMaterial->createInstance();
        // No exposure parameter any more — the grade is the scene materials'
        // (kGradeExposure / ttp_grade.inc), and this pass only antialiases.
        // The fullscreen triangle, in clip space (vertexDomain:device), exactly
        // as Filament builds its own: one triangle, no camera, no transform.
        static const math::float4 verts[3] = {
            { -1.0f, -1.0f, 1.0f, 1.0f },
            {  3.0f, -1.0f, 1.0f, 1.0f },
            { -1.0f,  3.0f, 1.0f, 1.0f },
        };
        static const uint16_t indices[3] = { 0, 1, 2 };
        mPresentVB = VertexBuffer::Builder()
                .vertexCount(3).bufferCount(1)
                .attribute(VertexAttribute::POSITION, 0,
                        VertexBuffer::AttributeType::FLOAT4, 0, sizeof(math::float4))
                .build(*mEngine);
        mPresentVB->setBufferAt(*mEngine, 0,
                VertexBuffer::BufferDescriptor(verts, sizeof(verts), nullptr));
        mPresentIB = IndexBuffer::Builder()
                .indexCount(3).bufferType(IndexBuffer::IndexType::USHORT)
                .build(*mEngine);
        mPresentIB->setBuffer(*mEngine,
                IndexBuffer::BufferDescriptor(indices, sizeof(indices), nullptr));
        mPresentQuad = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, mPresentInstance)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        mPresentVB, mPresentIB, 0, 3)
                .culling(false)          // clip-space verts: the box means nothing
                .castShadows(false).receiveShadows(false)
                .build(*mEngine, mPresentQuad);
        mPresentScene = mEngine->createScene();
        mPresentScene->addEntity(mPresentQuad);
        mPresentCameraEntity = utils::EntityManager::get().create();
        mPresentCamera = mEngine->createCamera(mPresentCameraEntity);
        mPresentCamera->setProjection(Camera::Projection::ORTHO, -1, 1, -1, 1, 0, 1);
        mPresentView = mEngine->createView();
        mPresentView->setScene(mPresentScene);
        mPresentView->setCamera(mPresentCamera);
        mPresentView->setPostProcessingEnabled(false); // we ARE the post chain
        mPresentView->setShadowingEnabled(false);
        mPresentView->setFrustumCullingEnabled(false);
    }
    TextureSampler sampler(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR);
    sampler.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    sampler.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mPresentInstance->setParameter("scene", mSceneColor, sampler);
    mPresentInstance->setParameter("texel",
            math::float2{ 1.0f / (float) mWidth, 1.0f / (float) mHeight });
    mPresentView->setViewport({ 0, 0, mWidth, mHeight });
}

// Between frames only (resize / teardown): the views and the present instance
// still reference these, so drop those references and let the driver drain
// before freeing.
void TtpRenderer::destroySceneTarget() {
    if (!mSceneRT) return;
    for (View* v : mCellViews) v->setRenderTarget(nullptr);
    mEngine->flushAndWait();
    mEngine->destroy(mSceneRT); mSceneRT = nullptr;
    mEngine->destroy(mSceneColor); mSceneColor = nullptr;
    mEngine->destroy(mSceneDepth); mSceneDepth = nullptr;
}

void TtpRenderer::ensureCells(uint32_t count) {
    while (mCellViews.size() < count) {
        View* v = mEngine->createView();
        utils::Entity camEnt = utils::EntityManager::get().create();
        Camera* cam = mEngine->createCamera(camEnt);
        v->setCamera(cam);
        v->setScene(mScene);
        // Nothing in this scene casts a Filament shadow (the sun's map is baked
        // once per track — see bakeShadowMap) and nothing refracts, but a View
        // defaults both systems ON and re-asks every frame, per cell. Say no
        // once instead.
        v->setShadowingEnabled(false);
        v->setScreenSpaceRefractionEnabled(false);
        // Post OFF, always: the cells write their own graded sRGB into the
        // shared scene buffer (ttp_grade.inc) and vpresent antialiases the lot
        // in ONE pass, instead of Filament's two per cell (see vpresent.mat).
        //
        // THERE USED TO BE A FALLBACK HERE — no vpresent.filamat meant
        // Filament's own chain with a linear tonemap and a 1.1 exposure — and
        // moving the grade into the materials is what removed it, not a tidy-up.
        // A shell serving these materials but not vpresent would now grade
        // twice, and there is no sensible middle: the scene buffer either holds
        // displayed colour or it does not. The whole .filamat set is produced by
        // one build-materials.sh run and fetched by one list in Display.js, so a
        // half-set was never a real configuration.
        v->setPostProcessingEnabled(false);
        mCellViews.push_back(v);
        mCellCameras.push_back(cam);
        mCellCameraEntities.push_back(camEnt);
    }
}

// ---------------------------------------------------------------------------
// The 2D cell overlay: the split-screen dividers and the per-player steer bar.
//
// The rule that admits these two and nothing else is in voverlay.mat, which also
// carries why they composite in sRGB. What lives here is the plumbing: a pool of
// unit quads through one ortho camera in PIXEL space, drawn straight onto the
// swap chain AFTER the present pass.
// ---------------------------------------------------------------------------

// 0xRRGGBB as it is written on screen. NOT srgbToLinear: this pass runs past the
// grade, so the value written IS the panel value (see voverlay.mat).
static float3 hudRgb(uint32_t rgb) {
    return { ((rgb >> 16) & 0xff) / 255.0f, ((rgb >> 8) & 0xff) / 255.0f,
             (rgb & 0xff) / 255.0f };
}

void TtpRenderer::ensureOverlay() {
    if (mOverlayView || !mOverlayMaterial) return;
    // The unit quad every element scales out of. Positions only — the material
    // needs no vertex colour, and its one varying is derived from the position.
    static const float3 verts[4] = {
        { 0, 0, -1 }, { 1, 0, -1 }, { 1, 1, -1 }, { 0, 1, -1 },
    };
    static const uint16_t indices[6] = { 0, 1, 2, 0, 2, 3 };
    mOverlayVB = VertexBuffer::Builder()
            .vertexCount(4).bufferCount(1)
            .attribute(VertexAttribute::POSITION, 0,
                    VertexBuffer::AttributeType::FLOAT3, 0, sizeof(float3))
            .build(*mEngine);
    mOverlayVB->setBufferAt(*mEngine, 0,
            VertexBuffer::BufferDescriptor(verts, sizeof(verts), nullptr));
    mOverlayIB = IndexBuffer::Builder()
            .indexCount(6).bufferType(IndexBuffer::IndexType::USHORT)
            .build(*mEngine);
    mOverlayIB->setBuffer(*mEngine,
            IndexBuffer::BufferDescriptor(indices, sizeof(indices), nullptr));

    mOverlayScene = mEngine->createScene(); // deliberately lightless
    mOverlayCameraEntity = utils::EntityManager::get().create();
    mOverlayCamera = mEngine->createCamera(mOverlayCameraEntity);
    mOverlayView = mEngine->createView();
    mOverlayView->setScene(mOverlayScene);
    mOverlayView->setCamera(mOverlayCamera);
    // TRANSLUCENT is what makes this an OVERLAY: the view blends onto whatever
    // the present pass already put on the canvas instead of replacing it.
    mOverlayView->setBlendMode(View::BlendMode::TRANSLUCENT);
    mOverlayView->setPostProcessingEnabled(false); // we are past the grade
    mOverlayView->setShadowingEnabled(false);
    mOverlayView->setFrustumCullingEnabled(false);
}

MaterialInstance* TtpRenderer::overlayQuad(float x, float y, float w, float h) {
    if (!mOverlayMaterial || w <= 0 || h <= 0) return nullptr;
    ensureOverlay();
    if (mOverlayQuads.size() <= mOverlayUsed) {
        OverlayQuad q;
        q.mi = mOverlayMaterial->createInstance();
        q.entity = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox({ { 0, 0, 0 }, { 1, 1, 1 } })
                .material(0, q.mi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        mOverlayVB, mOverlayIB, 0, 6)
                .culling(false)
                .castShadows(false).receiveShadows(false)
                .build(*mEngine, q.entity);
        mOverlayQuads.push_back(q);
    }
    OverlayQuad& q = mOverlayQuads[mOverlayUsed++];
    if (!q.inScene) { mOverlayScene->addEntity(q.entity); q.inScene = true; }
    // ttp_grid_cell measures from the TOP left, like the DOM and like every
    // consumer of the answer; the ortho camera below is ordinary GL, measuring
    // from the bottom. This is the one flip — the same one the cell viewports
    // make. It costs the shapes nothing: both are symmetric about their own
    // horizontal midline, so the material never has to know which way is up.
    auto& tcm = mEngine->getTransformManager();
    tcm.setTransform(tcm.getInstance(q.entity),
            mat4f::translation(float3{ x, (float) mHeight - y - h, 0 })
                    * mat4f::scaling(float3{ w, h, 1 }));
    q.mi->setParameter("size", float2{ w, h });
    return q.mi;
}

void TtpRenderer::drawOverlay(const TtpFrameInput& input) {
    const uint32_t before = mOverlayUsed;
    mOverlayUsed = 0;
    if (mOverlayMaterial && input.hudCount && mWidth && mHeight) {
        // Every size here is a fraction of something this function can measure:
        // the cell and the canvas for the bar, the canvas alone for the rules.
        // No UI unit crosses the
        // ABI — a TV shell cannot supply one honestly, knowing neither the
        // panel's size nor the couch's distance, so the ttp_display_ui_scale
        // this used to take was only ever devicePixelRatio under another name.
        const float4 ink{ hudRgb(TTP_HUD_INK), 1.0f };
        const float3 surface = hudRgb(TTP_HUD_SURFACE);
        const uint32_t n = input.hudCount;

        // .cell-divider — a 4 px ink rule down every seam that has cells on both
        // sides, SPANNING THE WHOLE CANVAS, deduplicated exactly as the DOM's
        // loop was: one rule per distinct cell edge, not one per cell.
        //
        // The seam positions come from cellRectTopLeft, the band-fitted grid the
        // shell is also handed. For every layout this game can produce that is
        // the same number ttp_grid_cell gave (a 2-column seam is at W/2 either
        // way, and 3+ columns needs 5 players), so this is about being derived
        // from one grid rather than two, not about moving a line.
        //
        // The SPAN stays the canvas, and that is deliberate rather than an
        // oversight: clipping the rules to the picture is visibly wrong on the
        // STACKED PAIR, which is not an exotic layout but the ordinary 2-player
        // one — a 16:9 surface splits into two 3.56:1 tiles, each capped back to
        // CELL_MAX_ASPECT, so the picture is inset with bars either side and the
        // rule between the two views would stop short of the screen edges.
        // tests/e2e/flow.spec.js samples that seam row and holds this.
        //
        // An edge is a seam when it has cells on BOTH sides, which is not the
        // same as "away from the border": the grid is centred, so column 0
        // starts past 0 whenever there are side bars. Testing `> 0` drew a rule
        // down the picture's left edge on the ordinary 2-player pair. The grid is
        // uniform, so "has a cell to its left" is just "is not the smallest x".
        if (input.flags & TTP_FRAME_DIVIDERS) {
            uint32_t xs[8], ys[8], nx = 0, ny = 0;
            uint32_t x0 = UINT32_MAX, y0 = UINT32_MAX;
            for (uint32_t i = 0; i < n; i++) {
                const TtpCellRect r = cellRectTopLeft(n, i);
                if (r.x < x0) x0 = r.x;
                if (r.y < y0) y0 = r.y;
            }
            for (uint32_t i = 0; i < n; i++) {
                const TtpCellRect r = cellRectTopLeft(n, i);
                bool seen = false;
                for (uint32_t k = 0; k < nx; k++) seen = seen || xs[k] == r.x;
                if (r.x > x0 && !seen && nx < 8) xs[nx++] = r.x;
                seen = false;
                for (uint32_t k = 0; k < ny; k++) seen = seen || ys[k] == r.y;
                if (r.y > y0 && !seen && ny < 8) ys[ny++] = r.y;
            }
            // rgba(42, 39, 53, 0.88) — the ink, let through by the tiniest bit.
            const float4 rule{ ink.xyz, 0.88f };
            // Weight off the CANVAS, like the span: the rule belongs to the
            // whole surface, not to one cell. The floor is rasterization — a
            // sub-pixel rule fades out rather than thinning.
            const float ruleW = std::max(1.0f, (float) mHeight * (4.0f / 1080.0f));
            for (uint32_t k = 0; k < nx; k++) {
                if (MaterialInstance* mi = overlayQuad(xs[k] - ruleW * 0.5f, 0,
                            ruleW, (float) mHeight)) {
                    mi->setParameter("shape", float3{ 0, 0, 0 });
                    mi->setParameter("fill", float3{ 0, 0, 0 });
                    mi->setParameter("ink", rule);
                    mi->setParameter("surface", surface);
                    mi->setParameter("bar", surface);
                }
            }
            for (uint32_t k = 0; k < ny; k++) {
                if (MaterialInstance* mi = overlayQuad(0, ys[k] - ruleW * 0.5f,
                            (float) mWidth, ruleW)) {
                    mi->setParameter("shape", float3{ 0, 0, 0 });
                    mi->setParameter("fill", float3{ 0, 0, 0 });
                    mi->setParameter("ink", rule);
                    mi->setParameter("surface", surface);
                    mi->setParameter("bar", surface);
                }
            }
        }

        // .cell-steer — display.css's composition (270 x 34, 4 border, 3 tick,
        // 20 clear of the bottom) against a 1080-line panel, times BAR_SCALE.
        // BAR_SCALE is the only knob: scale the shape, never re-proportion the
        // numbers.
        static constexpr float BAR_SCALE = 1.7f;
        const TtpCellHudInput* hud = ttp_frame_hud(&input);
        for (uint32_t i = 0; i < n; i++) {
            if (!(hud[i].flags & TTP_HUD_STEER_BAR)) continue;
            const TtpCellRect cell = cellRectTopLeft(n, i);
            // A SHARE OF THE SCREEN'S HEIGHT, damped by how much of that height
            // this cell owns. Height because that is what a split actually takes
            // away: stack two players and each gets half the screen, so each
            // bar should be smaller — but not HALF as small. Straight proportion
            // made the one-player bar twice the split one, which read oversized
            // on a full screen while the split bars were right.
            //
            // The geometric mean of the two heights is that damping (sqrt of the
            // cell's share) written so it stays RESOLUTION-INDEPENDENT: double
            // the panel's pixels and every bar doubles with it. A sqrt over the
            // cell's absolute pixels would not — it would quietly halve the bar
            // on a 4K set, which is the devicePixelRatio trap this layer already
            // refuses once.
            //
            // cellRectTopLeft is the band-fitted grid, never the raw tile.
            const float unit = BAR_SCALE
                    * std::sqrt((float) cell.h * (float) mHeight) / 1080.0f;
            const float barW = 270 * unit, barH = 34 * unit;
            const float border = 4 * unit, tick = 3 * unit, clear = 20 * unit;
            const float innerW = barW - 2 * border, innerH = barH - 2 * border;
            MaterialInstance* mi = overlayQuad(cell.x + (cell.w - barW) * 0.5f,
                    cell.y + cell.h - clear - barH, barW, barH);
            if (!mi) continue;
            // The livery this cell's car wears, straight off the roster the
            // renderer baked its model from — the shell never restates it.
            float3 bar = surface;
            if (mTrack && hud[i].car >= 0
                    && (size_t) hud[i].car < mTrack->carColors.size()) {
                const uint32_t abgr = mTrack->carColors[hud[i].car];
                bar = hudRgb(((abgr & 0xff) << 16) | (abgr & 0xff00)
                        | ((abgr >> 16) & 0xff));
            }
            // .cell-steer__fill: half the interior wide, centred, translated by
            // 50 % of ITS OWN width per unit of tilt — so full lock puts the
            // fill's edge on the interior's edge and never past it.
            mi->setParameter("shape", float3{ barH * 0.5f, border, tick });
            mi->setParameter("fill",
                    float3{ border + innerW * (0.25f + 0.25f * hud[i].steer),
                            innerW * 0.5f, innerH * 0.5f });
            mi->setParameter("ink", ink);
            mi->setParameter("surface", surface);
            mi->setParameter("bar", bar);
        }
    }
    // Retire what this frame did not claim. Scene membership, not a parked
    // transform: the pool outlives every split it ever drew.
    for (uint32_t i = mOverlayUsed; i < before && i < mOverlayQuads.size(); i++) {
        if (!mOverlayQuads[i].inScene) continue;
        mOverlayScene->remove(mOverlayQuads[i].entity);
        mOverlayQuads[i].inScene = false;
    }
    if (mOverlayUsed && mOverlayView) {
        mOverlayView->setViewport({ 0, 0, mWidth, mHeight });
        mOverlayCamera->setProjection(Camera::Projection::ORTHO,
                0, (double) mWidth, 0, (double) mHeight, 0, 2);
    }
}

// Diagnostic frame profiler. std::chrono::steady_clock is what emscripten maps
// to performance.now(); on the native shells it is the monotonic clock. A dozen
// reads a frame is far below the noise of what it measures.
static double ttpNowMs() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

const char* const* TtpRenderer::profileNames() {
    static const char* names[] = { "cars", "world", "skids", "ambient",
            "beginFrame", "cellSetup", "cellRender", "present", "endFrame",
            "total", nullptr };
    return names;
}

// The frame, split along the profiler's own zones. Each phase is a private
// method; what crosses a phase boundary crosses as a parameter, so the seam is
// readable off the signature. Behaviour is unchanged from the single-body form.
void TtpRenderer::renderCars(const TtpFrameInput& input, const TtpCarInput* cars,
        uint32_t nCars, std::vector<float3>& carPosW, std::vector<DeckDecal>& auraDecals) {
    auto& tcm = mEngine->getTransformManager();
    for (uint32_t i = 0; i < nCars; i++) {
        const TtpCarInput& c = cars[i];
        float3 fwd = { c.forward.x, c.forward.y, c.forward.z };
        float3 up = { c.up.x, c.up.y, c.up.z };
        float3 right = normalize(cross(up, fwd));
        // ── Ground conform: SIT THE CAR ON THE DECK ─────────────────────────
        // The contract pose rides the smooth CENTRELINE, and its up is the
        // TRACK FRAME's — neither of which is the surface the car stands on
        // once the deck twists or crests inside the car's own wheelbase. Posed
        // straight off it, a rigid body floats one corner and buries another,
        // worst exactly where the road is most interesting.
        //
        // So probe the deck under the four wheels and fit the body to what is
        // found: normal from the corner spans, heading re-squared into that
        // plane, seated on their mean. Roll and pitch were never corrected
        // before — only height was — which is why no amount of height tuning
        // ever landed all four wheels.
        //
        // THE PROBE IS AN EVALUATION, NOT A SEARCH. The deck is a ruled surface
        // parameterised by (s, lat) (TrackBin's note), the sim hands its own
        // (s, lat) across in the contract, and `deckFoot` walks that seed to the
        // wheel's own foot by Gauss-Newton. Nothing in the path picks a nearest
        // triangle or a nearest ring, so nothing in it can HOP — which is the
        // whole lesson of the previous attempt at this: it fitted the same plane
        // to four project() probes, and the probes' discrete segment pick put
        // about 0.4 degrees of lean noise per frame into the body on Skyline.
        //
        // NOTHING HERE IS DAMPED, deliberately. A filter was what the old
        // raycast needed, because it read TRIANGLES and stepped at every deck
        // seam; it bought smoothness with lag, and lag on a hill drags the car
        // behind its own contract position. The analytic surface is smooth to
        // begin with, so the seat is a pure function of the pose with no state
        // to ring, lag or re-seed. If a filter ever looks necessary here again,
        // the probe is what is wrong.
        //
        // The old straight-down raycast is gone with it, along with the `stunt`
        // gate that faded it out past ~14 degrees of roll — a gate that existed
        // only because a vertical ray is meaningless on a rolled deck, i.e. it
        // withdrew the correction exactly where it was needed. deckFoot answers
        // at any roll, loop walls included.
        float3 carPos = { c.pos.x, c.pos.y, c.pos.z };
        float3 wheelDeck[4]{};     // deck point under each wheel — fl, fr, bl, br
        float3 seatMid{};          // the fitted plane's origin (mean of the four)
        bool seated = false;
        // `hasWheelOff` is the four wheel nodes having been found on the model.
        // Without them there is nothing to fit a plane THROUGH, so such a car
        // keeps the contract pose untouched rather than falling back to a
        // cruder conform — and it would already be missing its wheel animation
        // entirely, which is the louder symptom.
        if (mHasTrack && mTrack && i < mCarWheels.size() && mCarWheels[i].hasWheelOff) {
            constexpr float RIDE_HEIGHT = -0.004f;
            CarWheels& rw = mCarWheels[i];
            float3 deck[4];
            bool ok = true;
            for (int k = 0; k < 4; k++) {
                // Where this wheel stands, carried out along the body's axes.
                // Its HEIGHT is dropped: we want the deck under the wheel, and
                // deckFoot answers along the surface normal anyway.
                const float3 off = rw.wheelOff[k];
                const float3 wpos = carPos + right * off.x + fwd * off.z;
                float ws = c.trackS, wl = c.trackLat;   // the car's own spot: the seed
                mTrack->deckFoot(wpos, ws, wl);
                deck[k] = mTrack->deckPoint(ws, wl);
                ok = ok && std::isfinite(deck[k].x) && std::isfinite(deck[k].y)
                        && std::isfinite(deck[k].z);
            }
            // Wheels are ordered fl, fr, bl, br, so these two spans are the
            // body's own axes measured ON the deck.
            const float3 spanF = ok ? (deck[0] + deck[1]) - (deck[2] + deck[3]) : float3{};
            const float3 spanR = ok ? (deck[1] + deck[3]) - (deck[0] + deck[2]) : float3{};
            float3 n = cross(spanF, spanR);
            const float nl = length(n);
            if (nl > 1e-5f) {
                n /= nl;
                if (dot(n, up) < 0) n = -n;
                up = n;
                // Re-square the heading into the fitted plane: the car's travel
                // direction is authoritative, only its lean is not.
                const float3 f2 = fwd - up * dot(fwd, up);
                if (length(f2) > 1e-4f) fwd = normalize(f2);
                right = normalize(cross(up, fwd));
                // Sit on the MEAN of the four contacts. That is the right seat
                // only because the wheels below have travel: with a rigid axle
                // the mean sinks the body into a crest, which is what the old
                // code's `max(mid, yC)` guard was patching around. The body
                // takes the smooth best fit and each wheel takes its own
                // residual, which is also how the real thing works.
                const float3 mid = (deck[0] + deck[1] + deck[2] + deck[3]) * 0.25f;
                carPos = mid + up * RIDE_HEIGHT;
                for (int k = 0; k < 4; k++) wheelDeck[k] = deck[k];
                seatMid = mid;
                seated = true;
                // The residual, free: how far each contact still sits off the
                // fitted plane. On a deck that twists inside one wheelbase no
                // pose can take this to zero, so it is the honest size of the
                // compromise — and it is what the wheel travel below absorbs.
                float worst = 0;
                for (int k = 0; k < 4; k++) {
                    worst = std::max(worst, std::fabs(dot(deck[k] - mid, up)));
                }
                rw.wheelGap = worst;
            } else {
                rw.wheelGap = 0;   // or the readback reports the last good frame's
            }
            // The probes were carried out along the CONTRACT axes and the fit
            // then replaced them. Re-probing against the fitted axes would move
            // the answer by the square of the warp angle — under a millimetre on
            // anything in the catalogue — so this stays a single step, and stays
            // a pure function of the frame's input.
        }
        // Jitter diagnostics (ttp_display_debug_decals). Second differences: a
        // car driving smoothly over a smooth deck has a near-constant first
        // difference, so what survives differencing twice is frame-to-frame
        // wobble. `upJitter` is the number the previous attempt at this needed
        // and did not have — position was checked against the contract pose and
        // agreed, but the contract pose has NO NORMAL to check the other half
        // against, and the lean was the half that was wrong.
        if (i < mCarWheels.size()) {
            CarWheels& rw = mCarWheels[i];
            const float3 raw{ c.pos.x, c.pos.y, c.pos.z };
            const float3 step = carPos - rw.prevPos, rawStep = raw - rw.prevRaw;
            const float3 upStep = up - rw.prevUp;
            if (rw.hasPrev) {
                rw.jitter = length(step - rw.prevStep);
                rw.rawJitter = length(rawStep - rw.prevRawStep);
                rw.upJitter = length(upStep - rw.prevUpStep);
            }
            rw.prevStep = step;       rw.prevPos = carPos;
            rw.prevRawStep = rawStep; rw.prevRaw = raw;
            rw.prevUpStep = upStep;   rw.prevUp = up;
            rw.hasPrev = true;
        }
        carPosW[i] = carPos;
        float carS = 0, carLat = 0;   // this car's spot on the ribbon, projected once
        const mat4f m{ float4{ right, 0 }, float4{ up, 0 }, float4{ fwd, 0 },
                       float4{ carPos, 1 } };
        if (mCarAssets.size() > i && mCarAssets[i]) {
            static const mat4f FLIP = mat4f::rotation(M_PI, float3{ 0, 1, 0 });
            // Spin-out whirl (oil, lightning): the JS yaws the whole model by
            // c.spin on top of its base yaw (car.rotation.y = baseYaw + spin).
            const mat4f base = (c.spin != 0)
                    ? m * mat4f::rotation(c.spin, float3{ 0, 1, 0 }) * FLIP
                    : m * FLIP;
            // Body lean + weight transfer — SceneRenderer setCarPose, with one
            // deliberate departure: the JS smoothed lean 0.2/frame, which made
            // the steering cue's wall-clock lag double at 30 fps; lean is now
            // dt-based at 13.4/s (the same curve at 60 fps). Pitch
            // from d(spd)/dt of the NORMALIZED spd over PITCH_ACCEL_NORM 0.8,
            // dive gated on real brake (×3, saturates at 1/3 pedal), damped at
            // PITCH_RATE 6/s.
            //
            // The BODY leans, the wheels do NOT: a car banking into a corner
            // rolls on its springs while its tyres stay planted. The JS gets
            // that by reparenting the four wheel nodes (and any exposed axle
            // rod) off the body onto the car group before rolling the body.
            // Here the whole asset hangs off one root transform, so instead
            // the root carries the lean and each wheel's local transform
            // cancels it back out (`bodyRot` below) — the wheel nodes are
            // direct children of the body node with an IDENTITY local frame in
            // every kit GLB, so the plain inverse is the right cancel. Leaning
            // the wheels too was the "whole car tilts on steering" tell.
            mat4f bodyRot{};    // R: the lean/dive the body wears
            mat4f popScale{};   // S: monster morph spring (uniform, commutes)
            if (mCarWheels.size() > i) {
                CarWheels& w = mCarWheels[i];
                w.lean += (c.steer * 0.05f - w.lean)
                        * (1.0f - std::exp(-13.4f * input.dt));
                const float dspd = (c.spd - w.prevSpd) / std::max(input.dt, 1e-3f);
                w.prevSpd = c.spd;
                const float pitchAmt = std::max(-1.0f, std::min(1.0f, dspd / 0.8f));
                w.accelNorm = pitchAmt > 0 ? pitchAmt : 0;
                const float diveGate = std::min(1.0f, c.brake * 3.0f);
                const float pitchTarget = -pitchAmt
                        * (pitchAmt < 0 ? 0.08f * diveGate : 0.03f);
                w.pitch += (pitchTarget - w.pitch)
                        * (1.0f - std::exp(-6.0f * input.dt));
                bodyRot = mat4f::rotation(w.pitch * w.pitchSign, float3{ 1, 0, 0 })
                        * mat4f::rotation(w.lean, float3{ 0, 0, 1 });
                // Morph pop (MonsterRig): on a monster edge the WHOLE rig
                // (chassis + grafted body — this pose feeds both) springs
                // 0.5→1 over POP_TIME 0.34 s with the 1.70158 ease-out-back
                // overshoot. (The JS shrink-out animates the outgoing rig,
                // which here parks instantly — both edges pop in.)
                const bool monNow = c.monster > 0.5f;
                if (monNow != w.monsterOn) w.popT = 0.34f;
                w.monsterOn = monNow;
                if (w.popT > 0) {
                    w.popT -= input.dt;
                    const float t = 1.0f - std::max(0.0f, w.popT) / 0.34f;
                    const float u = t - 1.0f;
                    const float k = 1.70158f;
                    const float s = 0.5f + 0.5f * (1.0f + u * u * ((k + 1) * u + k));
                    popScale = mat4f::scaling(float3{ s });
                }
            }
            // Flat = road-aligned, no lean (the monster chassis and its tyres
            // ride this); pose = the leaning body the car model wears.
            const mat4f flat = base * popScale;
            mat4f pose = base * bodyRot * popScale;
            // bodyRot is a product of two rotations, so its inverse is its
            // transpose. filament's inverse() is the general pivoting
            // Gauss-Jordan (~1.4 µs in wasm); the transpose is a few loads.
            const mat4f bodyRotInv = transpose(bodyRot);
            // Monster occlusion fade — SceneRenderer's _monsterBlocksView rule
            // verbatim: in front of the camera, nearer than that cell's own
            // car, and within MONSTER_BLOCK_DIST (3.0) of it. The JS ghosts it
            // PER CELL, and so do we: the test runs per view into a bitmask and
            // the per-view pass below swaps solid/ghost between render() calls
            // (single-threaded, so each cell sees its own state — the same
            // trick the cloud billboards use). A global swap used to ghost the
            // truck in every cell, including its own driver's.
            uint32_t blockMask = 0;
            if (c.monster > 0.5f && input.viewCount > 0) {
                const TtpViewInput* vws = ttp_frame_views(&input);
                const float3 mon = carPos;
                for (uint32_t vi = 0; vi < input.viewCount && vi < input.carCount; vi++) {
                    if (vi == i) continue;
                    const float3 camP = { vws[vi].world[12], vws[vi].world[13], vws[vi].world[14] };
                    const float3 f = float3{ cars[vi].pos.x, cars[vi].pos.y, cars[vi].pos.z } - camP;
                    const float3 mv = mon - camP;
                    if (dot(mv, f) <= 0) continue;               // behind the camera
                    if (dot(mv, mv) >= dot(f, f)) continue;      // beyond the car
                    const float3 d = mon - (camP + f);
                    if (dot(d, d) < 3.0f * 3.0f) blockMask |= (1u << vi);
                }
            }
            const bool isMonster = c.monster > 0.5f
                    && mMonsterInstances.size() > i && mMonsterInstances[i];
            // MonsterRig graft: the kit chassis (cab collapsed) rides the pose;
            // the player's own car body — WHEELS STRIPPED — seats the cab slot,
            // bottom-aligned to the slot floor plus MOUNT_LIFT. (The old code
            // lifted the whole car, own wheels and all, by a flat 0.42.)
            //
            // The rig rides FLAT: the JS grafts the body in as a child node and
            // leans only that, so the truck's own chassis and fat tyres stay
            // planted. The graft's lean therefore composes AFTER the mount —
            // it pivots about the cab slot, not about the car's road origin.
            const mat4f rigPose = flat;
            if (isMonster) {
                pose = flat * mat4f::translation(mCarWheels[i].monsterMount) * bodyRot;
            } else if (c.monster > 0.5f && (mMonsterInstances.size() <= i || !mMonsterInstances[i])) {
                pose = pose * mat4f::scaling(float3{ 1.45f, 1.35f, 1.45f }); // no GLB fallback
            }
            // Solid placement now; the per-view pass re-swaps the blocked cells.
            //
            // The monster rig, its ghost and the car's own ghost only exist for
            // one item, so they live OUT of the scene until this car actually
            // needs them (setInstanceInScene / setAssetInScene are edge
            // triggered). Parking them underground instead cost ~78 prepare
            // slots per cell, every frame, for a race in which nobody picks the
            // truck up. `wantGhosts` is deliberately the whole frame's worth:
            // the per-cell pass below decides WHICH cells see the ghost, but
            // membership has to cover any cell that might.
            const bool wantGhosts = isMonster && blockMask != 0;
            if (mMonsterIn.size() > i) {
                setInstanceInScene(mMonsterInstances.size() > i ? mMonsterInstances[i] : nullptr,
                        mMonsterIn[i], isMonster);
            }
            if (mMonsterGhostIn.size() > i) {
                setInstanceInScene(mMonsterGhostInstances.size() > i ? mMonsterGhostInstances[i] : nullptr,
                        mMonsterGhostIn[i], wantGhosts);
            }
            if (mCarGhostIn.size() > i) {
                setAssetInScene(mCarGhostAssets.size() > i ? mCarGhostAssets[i] : nullptr,
                        mCarGhostIn[i], wantGhosts);
            }
            // DECAL ISOLATION (debug): collapse the body to a point so the deck
            // stamp is the only thing left on the road. Applied to the
            // TRANSFORM, not to scene membership, so nothing about the stamp
            // changes — it is built from the pose above and never reads these
            // matrices back.
            const mat4f hide = mat4f::scaling(float3{ 0, 0, 0 });
            if (isMonster && mMonsterInstances.size() > i && mMonsterInstances[i]) {
                tcm.setTransform(tcm.getInstance(mMonsterInstances[i]->getRoot()),
                        mHideCars ? rigPose * hide : rigPose);
            }
            tcm.setTransform(tcm.getInstance(mCarAssets[i]->getRoot()),
                    mHideCars ? pose * hide : pose);
            if (mMonsterViews.size() > i) {
                MonsterView& mv = mMonsterViews[i];
                mv.on = isMonster;
                mv.mask = blockMask;
                mv.rig = rigPose;
                mv.body = pose;
            }
            // Wheel cosmetics (SceneRenderer's readability numbers): roll from
            // the car's REAL travel this frame (ds/r × WHEEL_SPIN_SCALE 0.4 —
            // the marshalled spd is NORMALIZED and can't drive it), fronts yaw
            // ±0.5 rad with steerYaw. Teleport-sized jumps don't spin the wheels.
            if (mCarWheels.size() > i) {
                constexpr float WHEEL_TURN_MAX = 0.5f;
                constexpr float WHEEL_SPIN_SCALE = 0.4f;
                constexpr float WHEEL_RADIUS = 0.13f;
                constexpr float ROLL_SEG_MAX = 1.5f;
                CarWheels& w = mCarWheels[i];
                const float3 posW = carPos;
                float ds = 0;
                if (w.hasLastPos) {
                    const float3 d = posW - w.lastPos;
                    const float len = length(d);
                    ds = len * (dot(d, fwd) >= 0 ? 1.0f : -1.0f);
                }
                w.lastPos = posW;
                w.hasLastPos = true;
                w.lastDs = ds; // the boost streaks cycle at this real travel speed
                // While the monster is up its own fat tyres are the ones on the
                // ground, so the roll accumulates at THEIR radius (the JS swaps
                // c.wheelRadius to the rig's for the same reason).
                const float radius = (isMonster && mMonsterWheelRadius > 0)
                        ? mMonsterWheelRadius : WHEEL_RADIUS;
                if (std::fabs(ds) < ROLL_SEG_MAX) {
                    w.roll += (ds / radius) * WHEEL_SPIN_SCALE;
                    w.roll = std::fmod(std::fmod(w.roll + (float) M_PI, 2.0f * (float) M_PI)
                            + 2.0f * (float) M_PI, 2.0f * (float) M_PI) - (float) M_PI;
                }
                // Steer yaw is about the wheel's local +Y, and the pose's
                // half-turn is ITSELF about Y — so unlike the roll axis, this
                // one is NOT flipped and takes the JS's angle as-is. Negating
                // it steered the front wheels the wrong way.
                // The angle comes off `steerYaw`, not `steer`: the sim turns by
                // |s|^STEER_EXPO, so the raw tilt has the wheels leading the car
                // everywhere but the two ends. Full lock is untouched (both are
                // 1 there); this only takes the slack out of the middle.
                // ttp_render.h has why the ANGLE itself stays exaggerated.
                // A phone's steer lands at the wire rate, so the raw value is a
                // staircase the render frame rate makes visible on the wheels.
                // Damp toward it with a ~50 ms time constant — enough to bridge
                // one input interval — dt-based like `lean` above so the lag
                // doesn't double at 30 fps. Purely cosmetic: the sim keeps
                // turning by the raw value.
                w.steerYawS += (c.steerYaw - w.steerYawS)
                        * (1.0f - std::exp(-20.0f * input.dt));
                const float yaw = w.steerYawS * WHEEL_TURN_MAX;
                const mat4f rollM = mat4f::rotation(w.roll * w.rollSign, float3{ 1, 0, 0 });
                const mat4f steerRoll = mat4f::rotation(yaw, float3{ 0, 1, 0 }) * rollM;
                // ── SUSPENSION TRAVEL ───────────────────────────────────────
                // The body wears the best-fit plane; each wheel takes the bit
                // of the deck that plane could not reach. This is not polish —
                // it is the only thing that CAN close the gap: where the deck
                // twists inside one wheelbase the four contacts are not
                // coplanar (TrackBin's ruled-surface note), so a rigid axle set
                // must leave a corner in the air however the body is posed.
                //
                // Undamped, like the seat above: the contact is a smooth
                // function of the pose, so a spring here would only add lag and
                // a state that can ring. The clamp is a guard against a
                // pathological deck, not a suspension rate — if it ever
                // saturates in ordinary racing, the fit is what to look at.
                //
                // Written into the node's LOCAL translation, which lives inside
                // the asset's own scaled hierarchy, hence assetScale; and its
                // +Y survives the pose's half-turn about Y untouched. It goes in
                // before bodyRotInv, so the travel direction is lean-cancelled
                // with the wheel and stays along the car's own up.
                constexpr float TRAVEL_MAX = 0.08f;
                float travelLocal[4] = { 0, 0, 0, 0 };
                // `seated` already implies the wheel offsets were measured —
                // the fit above cannot run without them.
                if (seated) {
                    for (int k = 0; k < 4; k++) {
                        const float3 seat = carPos + right * w.wheelOff[k].x
                                + fwd * w.wheelOff[k].z;
                        const float t = dot(wheelDeck[k] - seat, up);
                        travelLocal[k] = std::min(TRAVEL_MAX, std::max(-TRAVEL_MAX, t))
                                / std::max(1e-4f, w.assetScale);
                    }
                }
                // MonsterRig strips the car's own wheels (and any exposed axle
                // rod) before grafting the body onto the monster chassis — so
                // collapse them while the transform is up, or the little tyres
                // hang in mid-air beside the big ones.
                const auto spin = [&](utils::Entity e, const float3& t, const mat4f& r,
                        float dy) {
                    if (e.isNull()) return;
                    mat4f local = isMonster ? mat4f::scaling(float3{ 1e-4f }) : r;
                    local[3] = float4{ t + float3{ 0, dy, 0 }, 1 };
                    // …and undo the body's lean/dive: the root above carries it,
                    // but tyres stay planted on the road (see `bodyRot`).
                    tcm.setTransform(tcm.getInstance(e), bodyRotInv * local);
                };
                spin(w.fl, w.flT, steerRoll, travelLocal[0]);
                spin(w.fr, w.frT, steerRoll, travelLocal[1]);
                spin(w.bl, w.blT, rollM, travelLocal[2]);
                spin(w.br, w.brT, rollM, travelLocal[3]);
                // The axle ROD spans both rear wheels, so it can only follow
                // their mean — an axle is not a wheel and has nowhere else to
                // go once they part.
                if (!w.axle.isNull()) {
                    spin(w.axle, w.axleT, mat4f{},
                            (travelLocal[2] + travelLocal[3]) * 0.5f);
                }
                // …and the rig's own wheels, which are the ones actually
                // touching the road while the monster is up. Same roll clock,
                // this rig's axis sign, and nothing to collapse.
                if (isMonster && mMonsterWheels.size() > i) {
                    const MonsterWheels& mw = mMonsterWheels[i];
                    const mat4f mRoll = mat4f::rotation(w.roll * mw.rollSign, float3{ 1, 0, 0 });
                    const mat4f mSteer = mat4f::rotation(yaw, float3{ 0, 1, 0 }) * mRoll;
                    const auto turn = [&](utils::Entity e, const float3& t, const mat4f& r) {
                        if (e.isNull()) return;
                        mat4f local = r;
                        local[3] = float4{ t, 1 };
                        tcm.setTransform(tcm.getInstance(e), local);
                    };
                    turn(mw.fl, mw.flT, mSteer);
                    turn(mw.fr, mw.frT, mSteer);
                    turn(mw.bl, mw.blT, mRoll);
                    turn(mw.br, mw.brT, mRoll);
                }
            }
        } else if (!mCars[i].entity.isNull()) {
            tcm.setTransform(tcm.getInstance(mCars[i].entity), m);
        }
        // Ground shadow: a MASKED road-shader decal riding the road-aligned
        // pose basis (it follows whatever the car drives — bank, hill, loop
        // deck), spun by the spin-out whirl so the silhouette tracks the car
        // (the JS shadow's rotated right/forward axes). A monster swaps to its
        // own footprint.
        {
            const mat4f bm = (c.spin != 0)
                    ? m * mat4f::rotation(c.spin, float3{ 0, 1, 0 })
                    : m;
            float sx = 1, sz = 1;
            const bool monsterBlob = c.monster > 0.5f && mMonsterFootW > 0
                    && mCarWheels.size() > i;
            if (monsterBlob) {
                sx = mMonsterFootW / mCarWheels[i].footW;
                sz = mMonsterFootL / mCarWheels[i].footL;
            }
            // Load shift: the harder the body pitches, the closer the chassis
            // presses to the road (JS aoMat.opacity = 0.55 + AO_LOAD_GAIN·k).
            // Carried across as the RELATIVE gain it was, 0.08/0.55, so it still
            // deepens the blob by 15% at full pitch now that the base opacity
            // comes from the light rig instead of from that 0.55.
            const float load = mCarWheels.size() > i
                    ? std::min(1.0f, std::fabs(mCarWheels[i].pitch) / 0.08f) : 0.0f;
            // The car's spot on the deck, shared with the boost disc below:
            // both decals hang off the same origin and the same road frame.
            // It comes from the SIM now (ttp_render.h), not from projecting the
            // rendered position back onto the ribbon — the sim knows it exactly
            // and a projection could only lose precision and add a discrete
            // pick. Wrapped here because the decal arrays are periodic in s.
            carS = std::fmod(c.trackS, mTrack->length);
            if (carS < 0) carS += mTrack->length;
            carLat = c.trackLat;
            // The skid trails still project (they stamp into uv0's own field,
            // kinks and all) and seeded their ring hint off this car's. Keep
            // that seed alive now that the car itself does not project.
            if (mDecalProjHint.size() <= i) mDecalProjHint.resize(i + 1, -1);
            mDecalProjHint[i] = mTrack->ringHint(carS);
            if (mRoadInst && mDecalMaskArray
                    && (int) mDeckDecals.size() < kMaxDeckDecals) {
                // SHADED INTO THE ROAD, like the aura below: the shadow's
                // fragment IS a road fragment, so nothing floats and nothing
                // can slice the bottom of a tyre — the band a lifted sheet
                // paints across every wheel from a low camera, because ALL
                // blended geometry draws after ALL opaque geometry (Filament's
                // pass bits outrank renderable priority) and the sheet wins
                // the depth test in front of the tyre's bottom slice.
                const float fw = mCarWheels.size() > i ? mCarWheels[i].footW : 0.95f;
                const float fl = mCarWheels.size() > i ? mCarWheels[i].footL : 2.0f;
                // The blob quad's halves in the CAR's frame: forward in rect.z,
                // right in rect.w (the shader divides its rotated components by
                // exactly these).
                const float halfF = fl * sz * 1.45f * 0.5f;
                const float halfR = fw * sx * 1.45f * 0.5f;
                // Heading against the track frame at carS. `bm` already carries
                // the spin-out whirl, so the silhouette keeps whirling.
                const TrackBin::Sample f0 = mTrack->frameAt(carS);
                const float3 fwdW = bm[2].xyz;
                float cs = dot(f0.tangent(), fwdW), sn = dot(f0.lat, fwdW);
                const float nl = std::sqrt(cs * cs + sn * sn);
                if (nl > 1e-5f) { cs /= nl; sn /= nl; } else { cs = 1; sn = 0; }
                const int layer = mForceMaskLayer >= 0 ? mForceMaskLayer
                        : (monsterBlob
                        ? (((mMaskLayerBakedBits >> kMaskLayerMonster) & 1u)
                                ? kMaskLayerMonster : kMaskLayerGeneric)
                        : ((i < (uint32_t) kMaskLayerMonster
                                && ((mMaskLayerBakedBits >> i) & 1u))
                                ? (int) i : kMaskLayerGeneric));
                // THE PLANE THE MASK PROJECTS ONTO IS THE ONE THE CAR SITS ON:
                // the best fit through its own four wheel contacts, not the
                // track frame's tangent plane at the centreline. On a flat or
                // purely banked deck the two are the same plane. Where the deck
                // crests or twists they are not, and a rigid stamp projected
                // from the wrong one foreshortens across the footprint — the
                // shadow stretching on a crest and shearing on a twist, which
                // is exactly "skewed on non-planar segments". Fitting it to the
                // contacts halves the deviation for free, because the seating
                // above has already paid for the probes.
                //
                // A plane it must stay: painting the silhouette in curvilinear
                // (s, lat) instead bends it around every corner, and the
                // per-triangle kinks of the interpolated uv0 field ripple
                // through its sharp edge. Track space only BOUNDS the stamp.
                const float3 aUp = seated ? up : f0.up;
                const float3 aPos = seated ? seatMid : (f0.pos + f0.lat * carLat);
                // `fwdW` carries the spin-out whirl, so the silhouette whirls.
                float3 wF = fwdW - aUp * dot(fwdW, aUp);
                wF = length(wF) > 1e-5f ? normalize(wF)
                                        : normalize(f0.tangent() * cs + f0.lat * sn);
                const float3 wR = normalize(cross(aUp, wF));
                const float3 wp = aPos;
                // MEASURED CULL WINDOW. The shader rejects fragments in TRACK
                // SPACE before it projects, and the reach it needs there is an
                // ARCLENGTH — which the stamp's own half-diagonal is not. The
                // deck's iso-arclength lines FAN on a bend, so off the
                // centreline a world step spans R/(R−lat) more arclength; the
                // constant that used to stand here therefore closed INSIDE the
                // stamp and cut its nose or tail along a ring plane, with the
                // cut sliding as the car swept the corner. Through a FLAT bend
                // the deck is a plane and the stamp's world projection is
                // rigid, so the cull is the only thing that can reshape it.
                //
                // So measure it: run the stamp's four corners through the same
                // surface the seat uses and take the widest each way. The halves
                // ride in the w slots of the two axis vectors, read by the
                // shader AND by foldToChunk — keep those two in step.
                float halfSw = 0, halfLw = 0;
                for (int k = 0; k < 4; k++) {
                    const float3 corner = aPos + wF * ((k & 1) ? halfF : -halfF)
                            + wR * ((k & 2) ? halfR : -halfR);
                    float ks = c.trackS, kl = c.trackLat;
                    mTrack->deckFoot(corner, ks, kl);
                    halfSw = std::max(halfSw, std::fabs(ks - c.trackS));
                    halfLw = std::max(halfLw, std::fabs(kl - c.trackLat));
                }
                // A hair of slack, so the window is never the VISIBLE edge: the
                // stamp's own feather is (0.72→0.98 in vroad.mat), and a cull
                // that lands inside the feather prints as a hard line.
                halfSw += 0.05f;
                halfLw += 0.05f;
                mDeckDecals.push_back({
                        float4{ carS, carLat, halfF, halfR },
                        float4{ kCarBlobInk.x, kCarBlobInk.y, kCarBlobInk.z,
                                kCarBlobAO * (1.0f + (0.08f / 0.55f) * load) },
                        // `shape` is the profile decals' (inner/ellipse/knee/
                        // chevrons) and the masked path reads none of it, so it
                        // carries the GROUND CONFORM's numbers out to
                        // ttp_display_debug_decals instead — the worst wheel gap
                        // and the pose jitter, which the conform running AFTER
                        // the sim's snapshot puts beyond every other readback.
                        // Filter on `masked` before believing these four.
                        float4{ mCarWheels.size() > i ? mCarWheels[i].wheelGap : 0.0f,
                                mCarWheels.size() > i ? mCarWheels[i].jitter : 0.0f,
                                mCarWheels.size() > i ? mCarWheels[i].rawJitter : 0.0f,
                                mCarWheels.size() > i ? mCarWheels[i].upJitter : 0.0f },
                        float4{ sn, cs, (float) layer, 1.0f },
                        float4{ wp.x, wp.y, wp.z, 0 },
                        float4{ wF.x, wF.y, wF.z, halfSw },
                        float4{ wR.x, wR.y, wR.z, halfLw } });
            }
        }
        // Boost wind streaks (SceneRenderer STREAK_*): while boosting, cycle
        // each streak front (0.7) → back (−2.4) past the body at the car's
        // real travel speed (+3 floor), sin(π·progress) opacity envelope at
        // peak 0.15 × (0.5 + 0.5k). Respawns draw a per-car LCG (the JS uses
        // Math.random — character parity, not per-pixel). Alpha lands in the
        // centre vertex; the per-view pass orients the billboards.
        if (mCarBasis.size() < nCars) mCarBasis.resize(nCars);
        if (mCarBasisInv.size() < nCars) mCarBasisInv.resize(nCars);
        if (mCarBasis.size() > i) { mCarBasis[i] = m; mCarBasisInv[i] = inverse(m); }
        if (mStreaks.size() >= (i + 1) * 4 && mStreakSeed.size() > i) {
            const bool on = c.boostMul > 1.001f;
            CarWheels* cwp = mCarWheels.size() > i ? &mCarWheels[i] : nullptr;
            const float dtc = std::max(input.dt, 1e-3f);
            const float wspd = cwp
                    ? std::min(std::fabs(cwp->lastDs), 1.5f) / dtc + 3.0f : 8.0f;
            const float kk = std::min(1.0f, (c.boostMul - 1.0f) / 0.6f);
            const float fw = cwp ? cwp->footW : 0.95f;
            uint32_t& sr = mStreakSeed[i];
            const auto rnd = [&]() {
                sr = sr * 1664525u + 1013904223u;
                return (float) ((double) sr / 4294967296.0);
            };
            constexpr float FRONT = 0.7f, BACK = -2.4f, SPAN = FRONT - BACK;
            for (int s = 0; s < 4; s++) {
                Streak& st = mStreaks[i * 4 + s];
                Mesh& sm = mStreakMeshes[i * 4 + s];
                if (sm.entity.isNull()) continue;
                float alpha = 0;
                if (!on) {
                    st.dead = true;
                } else {
                    if (st.dead) {
                        st.z = FRONT + rnd() * SPAN * 0.8f;
                        st.x = (rnd() < 0.5f ? -1.0f : 1.0f) * (0.45f + rnd() * 0.4f) * fw;
                        st.y = 0.1f + rnd() * 0.3f;
                        st.len = 0.6f + rnd() * 0.5f;
                        st.dead = false;
                    }
                    st.z -= wspd * input.dt;
                    if (st.z < BACK) {
                        st.dead = true;
                    } else {
                        const float p = std::min(1.0f,
                                std::max(0.0f, (FRONT - st.z) / SPAN));
                        alpha = std::sin((float) M_PI * p) * 0.15f * (0.5f + 0.5f * kk);
                    }
                }
                if (alpha != st.alpha) {
                    // The JS animates the material's opacity, which scales the
                    // whole blurred texture — so scale every baked vertex alpha.
                    st.alpha = alpha;
                    const float k2 = std::min(1.0f, std::max(0.0f, alpha));
                    for (size_t vi = 0; vi < sm.verts.size() && vi < sm.local.size(); vi++) {
                        const uint32_t au = (uint32_t) std::lround(sm.local[vi].a * k2);
                        sm.verts[vi].abgr = (sm.verts[vi].abgr & 0x00ffffffu) | (au << 24);
                    }
                    sm.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                            sm.verts.data(), sm.verts.size() * sizeof(Vertex), nullptr));
                }
                // A dead streak leaves the scene (edge-triggered) rather than
                // parking underground — see setMeshInScene for what a parked
                // slot costs per cell.
                setMeshInScene(sm, !st.dead && st.alpha > 0.0f);
            }
        }
        // Boost pool: the JS breathes both the opacity (min(0.85, 0.7 + k·0.3)
        // × pulse) and the radius ((footW+footL)/2 × (1.25 + k·1.4) × 0.5).
        // SHADED INTO THE ROAD: the aura's fragment IS a road fragment, at the
        // road's own depth, so there is no lift, no chord sag to clear and no
        // render order to get wrong. Into the held-back aura list (see
        // auraDecals in render(), which has the compositing order and why).
        if (c.boostMul > 1.001f) {
            const float k = c.boostMul - 1.0f;
            const float pulse = 0.9f + 0.1f * std::sin(mTime * 11.0f);
            const float sc = (1.25f + k * 1.4f) * (0.94f + 0.08f * pulse);
            const float fw = mCarWheels.size() > i ? mCarWheels[i].footW : 0.95f;
            const float fl = mCarWheels.size() > i ? mCarWheels[i].footL : 2.0f;
            const float outerR = (fw + fl) * 0.5f * sc * 0.5f;
            float alpha = std::min(0.85f, 0.7f + k * 0.3f) * pulse;
            // The JS alpha holds a 0.7 floor right down to the gate above, and
            // as a decal that reads worse than the mesh it mirrors: the mix
            // REPLACES what is under it, so when the sim's linear fade crossed
            // 1.001 a ~0.7-alpha disc vanished in ONE frame — a hard blink at
            // every boost's end, most visible where launch-pad boosts die in a
            // pack. Ramp the last stretch of the fade (k 0.12 -> 0 = the final
            // quarter second at BOOST_FADE 0.5) to zero instead; above that the
            // look is untouched.
            alpha *= std::min(1.0f, k * (1.0f / 0.12f));
            addDeckDecal(carS, carLat, outerR, outerR, mBoostDiskLin, alpha,
                    0.72f, 0.94f, true, &auraDecals);
        }
    }
}

void TtpRenderer::renderWorld(const TtpFrameInput& input, const TtpCarInput* cars,
        uint32_t nCars, const std::vector<float3>& carPosW, std::vector<DeckDecal>& auraDecals) {
    auto& tcm = mEngine->getTransformManager();

    // Clouds drift slowly east, wrapping outside the playfield. The JS drifts
    // 0.7 u/s in AUTHORED space (r ≈ 180–294) and wraps at ±300; these clouds
    // were pushed out by k = 405/r, so both the drift and the wrap scale by
    // the same k or the two panes' clouds shear apart over a race.
    // Cloud drift is CLOSED-FORM off the marshalled scene clock (x0 + 0.7·T,
    // wrapped over the 600u period) — incremental accumulation would carry a
    // phase offset from whenever this renderer booted vs the driving scene.
    // (mCloudPos holds the authored INITIAL; the per-view pass adds drift.)

    // Hot-air balloon: a very slow lap of the horizon at cloud height
    // (stepBalloon — bearing 2.4 + t·0.012, thermal breathe sin(t·0.11)·1.4),
    // pushed past the fog cutoff with the cloud trick (JS fog:false).
    if (!mBalloon.entity.isNull()) {
        const float r = 112.0f * mHillSf;
        const float k = r < SKY_BAND ? SKY_BAND / r : 1.0f;
        const float a = 2.4f + mTime * 0.012f;
        const float y = mBalloonY + std::sin(mTime * 0.11f) * 1.4f;
        tcm.setTransform(tcm.getInstance(mBalloon.entity),
                mat4f::translation(float3{ std::cos(a) * r * k, y * k, std::sin(a) * r * k })
                * mat4f::scaling(float3{ mBalloonSize * k }));
    }

    // The paper dart glides its lazy banked circle (stepPaperPlane), riding the
    // hill push-out like the balloon. (The birds and kites are SPRITES — they
    // re-aim per cell, down with the cloud billboards.)
    if (mTrack && !mPlane.entity.isNull()) {
        const TrackBin& t = *mTrack;
        const float ph = mTime * t.planeSpeed;
        const float cx = std::cos(t.planeA0) * t.planeRc * mHillSf;
        const float cz = std::sin(t.planeA0) * t.planeRc * mHillSf;
        const float3 p{ cx + std::cos(ph) * t.planeRb,
                        t.planeY + std::sin(ph * 2.1f) * 1.1f, // long shallow swoops
                        cz + std::sin(ph) * t.planeRb };
        const float yaw = std::atan2(-std::sin(ph), std::cos(ph));
        tcm.setTransform(tcm.getInstance(mPlane.entity),
                mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                * mat4f::rotation(t.planeBank + std::sin(mTime * 0.7f) * 0.12f,
                        float3{ 0, 0, 1 })
                * mat4f::scaling(float3{ t.planeSize }));
    }

    // The wind-up train trundles its stadium oval (two straights along local X
    // at z = ±RT, run CCW), nose along the tangent, key winding as it goes.
    if (mHasTrain) {
        // The path is trainAt()'s, which is also what the sleepers were laid
        // along — see the note there. This used to be a second copy of the same
        // piecewise walk, with its own RT and LT.
        const TrainAt t = trainAt(std::fmod(mTime * 1.9f, trainPerim())); // ~1.9 u/s
        const float lpx = t.x, lpz = t.z, dx = t.dx, dz = t.dz;
        const float co = mTrainCos, so = mTrainSin;
        const mat4f pose = mat4f::translation(float3{
                    mTrainCentre.x + lpx * co + lpz * so, mTrainCentre.y,
                    mTrainCentre.z - lpx * so + lpz * co })
                * mat4f::rotation(std::atan2(dx * co + dz * so, -dx * so + dz * co),
                        float3{ 0, 1, 0 });
        if (!mTrain.entity.isNull()) tcm.setTransform(tcm.getInstance(mTrain.entity), pose);
        if (!mTrainKey.entity.isNull()) {
            tcm.setTransform(tcm.getInstance(mTrainKey.entity),
                    pose * mat4f::translation(float3{ 0, 1.8f, -0.85f })
                    * mat4f::rotation(mTime * 2.6f, float3{ 0, 1, 0 }));
        }
    }

    // Chimney smoke: each puff rises, grows and dissolves over ~6 s, staggered
    // in thirds. Billboarded toward this frame's first camera (they're tiny and
    // far; a per-cell re-aim isn't worth the extra state).
    if (!mSmoke.empty() && input.viewCount > 0) {
        const TtpViewInput& v0 = ttp_frame_views(&input)[0];
        const float3 camP{ v0.world[12], v0.world[13], v0.world[14] };
        for (size_t i = 0; i < mSmoke.size(); i++) {
            if (mSmoke[i].entity.isNull()) continue;
            const float u = std::fmod(mTime * 0.16f + (float) i / 3, 1.0f);
            const float3 p{ mSmokeOrigin.x + u * 1.7f
                                    + std::sin(mTime * 0.8f + i * 2.1f) * 0.15f,
                            mSmokeOrigin.y + u * 3.4f, mSmokeOrigin.z };
            const float w = 0.7f + u * 2.2f;
            // The JS fades the sprite's opacity; ours bakes alpha into the mesh,
            // so shrink to nothing at the ends instead (same read at this size).
            const float fade = 0.42f * std::min(1.0f, u * 5) * (1 - u) / 0.42f;
            const float yaw = std::atan2(camP.x - p.x, camP.z - p.z);
            tcm.setTransform(tcm.getInstance(mSmoke[i].entity),
                    mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                    * mat4f::scaling(float3{ w * fade, w * 0.62f * fade, 1 }));
        }
    }

    // The windmill's multi-blade rotor spins about its facing axis.
    if (!mWindmill.entity.isNull()) {
        tcm.setTransform(tcm.getInstance(mWindmill.entity),
                mWindmillBase * mat4f::rotation(mTime * 0.85f, float3{ 0, 0, 1 }));
    }

    // Kickable cones — TrackProps._stepCones, with the kick test upgraded from
    // that port's car-centre disc (r 0.7, which punted signs ~0.4 u off the
    // door panels) to the car's own oriented collision rectangle. A marker
    // standing within KICK_MARGIN of the body (on the SAME deck) is punted
    // away from the contact point; it arcs, tumbles, bounces off the local
    // road surface with friction, is shoved back inside the kerbs, and on
    // settling topples onto its side and stays down.
    if (!mConeStates.empty() && mTrack) {
        constexpr float KICK_MARGIN = 0.15f, KICK_Y = 1.0f, KICK_MIN = 2.5f, KICK_GAIN = 6.0f;
        constexpr float KICK_UP = 2.6f, GRAVITY = 16.0f, RESTITUTION = 0.42f;
        constexpr float FRICTION = 0.6f, SETTLE = 0.4f, TOPPLE = 7.0f;
        constexpr float EDGE_MARGIN = 0.35f, WALL_RESTITUTION = 0.5f;
        // Lowest point of the cone's silhouette under `q`, relative to its
        // origin: the minimum over the base rim and the apex (a cone touches
        // the ground nowhere else), matching the JS's sampled-vertex scan.
        const auto groundOffset = [](const ConeState& cs, const quatf& q) {
            float lo = 1e9f;
            for (int k = 0; k < 12; k++) {
                const float a = (float) k * (2.0f * (float) M_PI / 12);
                const float3 v{ std::cos(a) * cs.radius, cs.loY, std::sin(a) * cs.radius };
                lo = std::min(lo, (q * v).y);
            }
            lo = std::min(lo, (q * float3{ 0, cs.hiY, 0 }).y);
            return std::min(0.0f, lo);
        };
        // A cone lying on its side rests on its SLANT, so its axis pitches up
        // toward the base by ψ = asin(r / h): aim the axis along the lean with
        // the apex dipped ψ below horizontal.
        const auto coneFlatPose = [](const ConeState& cs) {
            const float3 axis = cs.quat * float3{ 0, 1, 0 };
            const float hl = std::sqrt(axis.x * axis.x + axis.z * axis.z);
            float dx, dz;
            if (hl > 1e-3f) { dx = axis.x / hl; dz = axis.z / hl; }
            else {
                const float sl = std::sqrt(cs.spinAxis.x * cs.spinAxis.x
                        + cs.spinAxis.z * cs.spinAxis.z);
                const float n = sl > 1e-6f ? sl : 1.0f;
                dx = cs.spinAxis.z / n; dz = -cs.spinAxis.x / n;
            }
            const float psi = std::asin(std::min(1.0f,
                    cs.radius / std::max(1e-3f, cs.hiY - cs.loY)));
            const float3 target{ dx * std::cos(psi), -std::sin(psi), dz * std::cos(psi) };
            return quatf::fromDirectedRotation(normalize(axis), normalize(target)) * cs.quat;
        };
        const auto rotateTowards = [](const quatf& q, const quatf& t, float maxAngle) {
            const float d = std::fabs(q.x * t.x + q.y * t.y + q.z * t.z + q.w * t.w);
            const float ang = 2.0f * std::acos(std::min(1.0f, d));
            if (ang < 1e-6f) return t;
            return normalize(slerp(q, t, std::min(1.0f, maxAngle / ang)));
        };
        for (size_t ci = 0; ci < mConeStates.size(); ci++) {
            ConeState& cs = mConeStates[ci];
            const bool isSign = mSignMeshes.size() > ci && !mSignMeshes[ci].entity.isNull();
            if (!isSign && (mConeInstances.size() <= ci || !mConeInstances[ci])) continue;
            auto inst = isSign ? tcm.getInstance(mSignMeshes[ci].entity)
                               : tcm.getInstance(mConeInstances[ci]->getRoot());
            if (!cs.airborne) {
                const bool toppling = cs.hasFlat;
                if (cs.hasFlat) {
                    cs.quat = rotateTowards(cs.quat, cs.flatTarget, TOPPLE * input.dt);
                    if (cs.hasRest) cs.pos.y = cs.restRoadY - groundOffset(cs, cs.quat);
                    const float d = std::fabs(cs.quat.x * cs.flatTarget.x
                            + cs.quat.y * cs.flatTarget.y + cs.quat.z * cs.flatTarget.z
                            + cs.quat.w * cs.flatTarget.w);
                    if (2.0f * std::acos(std::min(1.0f, d)) < 1e-3f) cs.hasFlat = false;
                }
                for (uint32_t i = 0; i < nCars && i < carPosW.size(); i++) {
                    const TtpCarInput& c = cars[i];
                    if (c.spd < 0.05f) continue; // a stationary car doesn't kick
                    const float dx = cs.pos.x - carPosW[i].x, dz = cs.pos.z - carPosW[i].z;
                    if (std::fabs(cs.pos.y - carPosW[i].y) >= KICK_Y) continue; // same deck only
                    // Marker origin in the car's body frame (XZ yaw only), then
                    // the closest point on its collision rectangle — the same
                    // clamp construction the sim's collidePole runs in reverse.
                    const float fl = std::sqrt(c.forward.x * c.forward.x
                            + c.forward.z * c.forward.z);
                    const float fn = fl > 1e-6f ? fl : 1.0f;
                    const float fx = c.forward.x / fn, fz = c.forward.z / fn;
                    const float lx = dx * fx + dz * fz;   // along the body
                    const float ly = -dx * fz + dz * fx;  // across it
                    const float qx = std::max(-c.halfLen, std::min(c.halfLen, lx));
                    const float qy = std::max(-c.halfWid, std::min(c.halfWid, ly));
                    const float ex = lx - qx, ey = ly - qy;
                    const float e2 = ex * ex + ey * ey;
                    if (e2 >= KICK_MARGIN * KICK_MARGIN) continue;
                    float dirx, dirz;
                    if (e2 < 1e-4f) {
                        // Origin inside the body: punt straight along the travel.
                        dirx = fx; dirz = fz;
                    } else {
                        // Away from the contact point, so a nose hit punts
                        // forward and a side-swipe shoves sideways.
                        const float len = std::sqrt(e2);
                        dirx = (ex * fx - ey * fz) / len;
                        dirz = (ex * fz + ey * fx) / len;
                    }
                    const float power = KICK_MIN + KICK_GAIN * c.spd;
                    cs.vel = { dirx * power, KICK_UP, dirz * power };
                    cs.spinAxis = normalize(float3{ -dirz, 0, dirx });
                    cs.spinRate = power * 2.2f;
                    cs.airborne = true;
                    cs.hasFlat = false; // re-kicked mid-topple → tumble afresh
                    break;
                }
                // A settled cone hasn't moved since its topple eased out — only
                // write the transform while something is actually changing (a
                // kick doesn't move it THIS frame; the airborne pass writes).
                if (toppling || !cs.posed) {
                    cs.posed = true;
                    tcm.setTransform(inst, mat4f::translation(cs.pos) * mat4f(cs.quat));
                }
                continue;
            }
            cs.vel.y -= GRAVITY * input.dt;
            cs.pos += cs.vel * input.dt;
            cs.quat = normalize(quatf::fromAxisAngle(cs.spinAxis, cs.spinRate * input.dt)
                    * cs.quat);
            // Settle onto the road WHERE IT LANDED, not the spawn height: sample
            // the ribbon at the cone's current (s, lat) and use it for both the
            // floor and the kerb clamp.
            const float3 homeP = cs.home[3].xyz;
            const TrackBin::Sample f0 = mTrack->frameAt(cs.homeS);
            const float along = dot(cs.pos - homeP, f0.tangent());
            const TrackBin::Sample f = mTrack->frameAt(cs.homeS + along);
            const float latOff = dot(cs.pos - f.pos, f.lat);
            const float roadY = f.pos.y + f.lat.y * latOff;
            cs.restRoadY = roadY;
            cs.hasRest = true;
            const float gOff = groundOffset(cs, cs.quat);
            if (cs.pos.y + gOff <= roadY) {
                cs.pos.y = roadY - gOff;
                if (cs.vel.y < 0) cs.vel.y = -cs.vel.y * RESTITUTION;
                cs.vel.x *= FRICTION;
                cs.vel.z *= FRICTION;
                cs.spinRate *= FRICTION;
                if (cs.vel.y < SETTLE
                        && (cs.vel.x * cs.vel.x + cs.vel.z * cs.vel.z) < SETTLE * SETTLE) {
                    cs.vel = {};
                    cs.spinRate = 0;
                    cs.airborne = false;
                    cs.flatTarget = coneFlatPose(cs); // topple onto its side
                    cs.hasFlat = true;
                }
            }
            const float edge = f.width / 2 - EDGE_MARGIN;
            if (std::fabs(latOff) > edge) {
                const float sgn = latOff > 0 ? 1.0f : -1.0f;
                cs.pos += f.lat * (sgn * edge - latOff);
                const float vLat = dot(cs.vel, f.lat);
                if (vLat * sgn > 0) cs.vel += f.lat * (-vLat * (1 + WALL_RESTITUTION));
            }
            tcm.setTransform(inst, mat4f::translation(cs.pos) * mat4f(cs.quat));
        }
    }

    // Ambient drift is entirely in vpoint.mat now (motion + the camera-box
    // wrap + both fades); its whole per-frame cost is the `time` uniform,
    // set in renderAmbient beside the sprite-size fit.

    // Furniture reconcile: boxes hide when collected (respawn = state flips
    // back), bananas place the first N pool entries at their track positions.
    // Idle motion (box spin + bob) runs on the marshalled scene clock (mTime,
    // set at the top of render()).
    if (mTrack) {
        // Gold emissive throb (TrackProps _stepBoxes): synchronized across
        // boxes — 0xffd23f at 0.16 + 0.18·(0.5 + 0.5·sin(4.5t)).
        if (!mBoxGlowMats.empty()) {
            const float pulse = 0.16f + 0.18f * (0.5f + 0.5f * std::sin(mTime * 4.5f));
            const float3 gold = srgbToLinear(0xffd23f) * pulse;
            // mBoxGlowMats holds every emissive-bearing instance across both
            // pools (the fade twins carry it too, or a box would drop its glow
            // on the frame it is grabbed — the one frame anyone is looking at
            // it), resolved once at load rather than string-probed here.
            for (MaterialInstance* gm : mBoxGlowMats) gm->setParameter("emissiveFactor", gold);
        }
        const uint32_t* boxStates = ttp_frame_box_states(&input);
        const uint32_t nBoxes = std::min<uint32_t>(input.boxCount,
                (uint32_t) std::min(mBoxInstances.size(), mBoxXf.size()));
        if (mBoxCollectT.size() < nBoxes) mBoxCollectT.assign(nBoxes, 0.0f);
        if (mBoxPrevAvail.size() < nBoxes) mBoxPrevAvail.assign(nBoxes, 1);
        // Collect burst (TrackProps): a grabbed box GROWS (→2.1×) while it fades,
        // spinning up 2.2×. That is the authored beat, and it can finally be
        // rendered as authored — the BLEND twin carries the alpha the solid
        // instance has no channel for, so the growth reads as a poof dispersing
        // instead of a box inflating in the road. The old `pop` tail is gone
        // with it: it only ever existed to stand in for this alpha.
        constexpr float POOF = 0.2f;
        for (uint32_t i = 0; i < nBoxes; i++) {
            auto inst = tcm.getInstance(mBoxInstances[i]->getRoot());
            gltfio::FilamentInstance* fadeInst =
                    mBoxFadeInstances.size() > i ? mBoxFadeInstances[i] : nullptr;
            const bool avail = boxStates[i] != 0;
            // With no BLEND twin there is nothing to fade, and a grow with no
            // fade is the box inflating — so skip the burst and just go.
            if (!avail && mBoxPrevAvail[i]) mBoxCollectT[i] = fadeInst ? POOF : 0.0f;
            mBoxPrevAvail[i] = avail ? 1 : 0;
            // Hover: the box's BASE floats BOX_FLOAT 0.18 over the deck and
            // bobs ±BOX_BOB_AMP 0.07 at ω 3.0 with the 0.9·i phase stagger.
            const float bob = 0.18f + 0.07f * std::sin(mTime * 3.0f + 0.9f * i);
            const mat4f hover = mBoxXf[i] * mat4f::translation(float3{ 0, bob, 0 });
            float alpha = 1.0f; // the box's own opacity, and its blob's
            // A collected box LEAVES the scene (and its fade twin only enters
            // it for the poof) — membership, not an underground park.
            const bool poofing = !avail && mBoxCollectT[i] > 0 && fadeInst;
            if (mBoxIn.size() > i) {
                setInstanceInScene(mBoxInstances[i], mBoxIn[i], avail);
            }
            if (fadeInst && mBoxFadeIn.size() > i) {
                setInstanceInScene(fadeInst, mBoxFadeIn[i], poofing);
            }
            if (poofing) {
                mBoxCollectT[i] = std::max(0.0f, mBoxCollectT[i] - input.dt);
                alpha = mBoxCollectT[i] / POOF;                  // 1 → 0
                const float grow = 1.0f + (1.0f - alpha) * 1.1f; // 1 → 2.1
                tcm.setTransform(tcm.getInstance(fadeInst->getRoot()),
                        hover * mat4f::rotation(mTime * 1.6f * 2.2f, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ mBoxScale * grow }));
                MaterialInstance* const* mats = fadeInst->getMaterialInstances();
                for (size_t mi = 0; mi < fadeInst->getMaterialInstanceCount(); mi++) {
                    if (mats[mi]->getMaterial()->hasParameter("baseColorFactor")) {
                        mats[mi]->setParameter("baseColorFactor",
                                math::float4{ 1, 1, 1, alpha });
                    }
                }
            } else if (!avail) {
                alpha = 0.0f;
            } else {
                mBoxCollectT[i] = 0;
                // Idle (TrackProps _stepBoxes): spin 1.6 rad/s in unison.
                tcm.setTransform(inst, hover
                        * mat4f::rotation(mTime * 1.6f, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ mBoxScale }));
            }
            // The box's contact-shadow stamp fades with it. buildStaticDeckDecals
            // pushes one decal per box FIRST and in box order, so entry i is box
            // i's stamp; rewriting its alpha in place dirties the chunk's memcmp
            // only while a poof is actually running.
            if (i < mStaticDeckDecals.size() && i < (uint32_t) kMaxStaticDeckDecals) {
                mStaticDeckDecals[i].color.w = kBlobShadowAlpha * alpha;
            }
        }
        // Ground blob under each dynamic prop (TrackProps shares one blob
        // shape, scaled 0.7 for a banana and 0.95 for a rocket): a road-shader
        // stamp like the boost aura, so it has no lift either. Its falloff is
        // the shape the JS baked into its texture (makeBlobShadowTexture:
        // 1 -> 0.82 at 0.55 of the radius -> 0 at the rim), which is exactly
        // what the stamp's inner/knee pair describes. f came from
        // frameAt(item.s), so the arclength is already exact — no need to
        // project the world point back onto the curve.
        const auto placeBlob = [&](const TrackBin::Sample& f, float lat, float scale) {
            const float r = 0.3f * scale;
            addDeckDecal(f.s, lat, r, r, srgbToLinear(0x1c1a18), kBlobShadowAlpha,
                    /*inner=*/0.55f, /*kneeAlpha=*/0.82f, /*ellipse=*/true);
        };
        const TtpBananaInput* bananas = ttp_frame_bananas(&input);
        for (uint32_t j = 0; j < (uint32_t) mBananaInstances.size(); j++) {
            const bool live = j < input.bananaCount;
            if (mBananaIn.size() > j) {
                setInstanceInScene(mBananaInstances[j], mBananaIn[j], live);
            }
            if (!live) continue;
            const TrackBin::Sample bf = mTrack->frameAt(bananas[j].s);
            placeBlob(bf, bananas[j].lat, 0.7f);
            tcm.setTransform(tcm.getInstance(mBananaInstances[j]->getRoot()),
                    bf.basis(bananas[j].lat));
        }
        const TtpRocketInput* rockets = ttp_frame_rockets(&input);
        std::vector<float3> nowRockets;
        for (uint32_t j = 0; j < (uint32_t) mRockets.size(); j++) {
            if (mRockets[j].entity.isNull()) continue;
            auto inst = tcm.getInstance(mRockets[j].entity);
            const bool haveFlame = mRocketFlames.size() > j
                    && !mRocketFlames[j].entity.isNull();
            if (j >= input.rocketCount) {
                setMeshInScene(mRockets[j], false);
                if (haveFlame) setMeshInScene(mRocketFlames[j], false);
                continue;
            }
            setMeshInScene(mRockets[j], true);
            // Nose (local +Y) along the travel tangent, ROCKET_HOVER 0.32
            // above the deck, whizz-rolling about its axis at 9 rad/s.
            const TrackBin::Sample f = mTrack->frameAt(rockets[j].s);
            placeBlob(f, rockets[j].lat, 0.95f);
            const float3 tanv = f.tangent();
            const float3 p = f.pos + f.lat * rockets[j].lat + f.up * 0.32f;
            nowRockets.push_back(p);
            const mat4f rocketXf = mat4f{ float4{ f.lat, 0 }, float4{ tanv, 0 },
                    float4{ cross(f.lat, tanv), 0 }, float4{ p, 1 } }
                    * mat4f::rotation(mTime * 9.0f, float3{ 0, 1, 0 });
            tcm.setTransform(inst, rocketXf);
            if (haveFlame) {
                // STEADY. The flame used to pulse (the JS jittered its
                // opacity, this scaled it) — at the size a rocket reads on a TV
                // that is not a flicker, it is noise: too small to see as fire
                // and too busy to ignore. A constant flame is the clearer cue.
                setMeshInScene(mRocketFlames[j], true);
                tcm.setTransform(tcm.getInstance(mRocketFlames[j].entity), rocketXf);
            }
        }
        // A sim reset (fixture scrubbing) teleports every car — clear the
        // rocket trackers so the count drop can't fire a stale-position burst,
        // and wipe the skid layer (the JS cleared marks + patina on restart;
        // here the wipe is one unconditional clear).
        if (input.carCount > 0) {
            // A RESET teleports the whole field; a lone car jumping is a
            // RESPAWN (off the deck, back to the line). The detector once
            // watched car 0 alone, and car 0 is a roster seat — usually a
            // human — so every fall wiped the whole track's rubber mid-race.
            // Two witnesses (first and last car) separate the cases; a solo
            // field keeps the single-witness behaviour, which is the fixture
            // scrubbing this block was built for.
            const float3 c0 = { cars[0].pos.x, cars[0].pos.y, cars[0].pos.z };
            const TtpCarInput& cn = cars[input.carCount - 1];
            const float3 cN = { cn.pos.x, cn.pos.y, cn.pos.z };
            const bool jumped0 = length(c0 - mLastCar0) > 5.0f;
            const bool jumpedN = input.carCount == 1 || length(cN - mLastCarN) > 5.0f;
            if (jumped0 && jumpedN) {
                mPrevRockets.clear();
                mPrevRocketCount = 0;
                for (Burst& b : mBursts) b.t = -1;
                if (mSkidTex) {
                    for (WheelTrail& t : mWheelTrails) t = {};
                    mSkidWipe = true; // the next stamp pass clears the layer
                }
            }
            mLastCar0 = c0;
            mLastCarN = cN;
        }
        // Detonations, as the engine reported them this frame.
        //
        // This used to be INFERRED from rocketCount dropping, and the burst was
        // pinned to the rocket's last known spot. That is exactly wrong for a
        // HIT: the rocket detonates on a car, the car drives on, and the burst
        // is left behind — so the victim's own chase camera, the one view
        // guaranteed to be pointed at it, is the only view that never sees it.
        // The events say which case it is, so the fireball can ride the car out
        // like the JS does (TrackProps IMPACT_FOLLOW) while the shockwave ring
        // stays put at the impact point.
        const TtpBurstInput* bursts = ttp_frame_bursts(&input);
        for (uint32_t bi = 0; bi < input.burstCount; bi++) {
            Burst* slot = nullptr;
            for (Burst& b : mBursts) { if (b.t < 0) { slot = &b; break; } }
            if (!slot) break; // two at once is already more than reads
            const TtpBurstInput& ev = bursts[bi];
            if (ev.car >= 0 && (uint32_t) ev.car < nCars && (size_t) ev.car < carPosW.size()) {
                // On the car body, like spawnImpact's carGroup.position + up·0.3.
                const TtpCarInput& hit = cars[ev.car];
                slot->pos = carPosW[ev.car]
                        + float3{ hit.up.x, hit.up.y, hit.up.z } * 0.3f;
                slot->car = ev.car;
            } else {
                const TrackBin::Sample f = mTrack->frameAt(ev.s);
                slot->pos = f.pos + f.lat * ev.lat + f.up * 0.3f;
                slot->car = -1;
            }
            slot->ball = slot->pos;
            slot->t = 0;
        }
        mPrevRockets = std::move(nowRockets);
        mPrevRocketCount = input.rocketCount;
        for (int bi = 0; bi < 2; bi++) {
            Burst& b = mBursts[bi];
            if (mBurstMeshes[bi].entity.isNull()) continue;
            auto ringI = tcm.getInstance(mBurstMeshes[bi].entity);
            auto ballI = tcm.getInstance(mBurstBalls[bi].entity);
            constexpr float DUR = 0.7f, FLASH = 0.5f; // IMPACT_TIME / IMPACT_FLASH_TIME
            if (b.t >= 0) {
                b.t += input.dt;
                if (b.t >= DUR) b.t = -1;
            }
            if (b.t < 0) {
                setMeshInScene(mBurstMeshes[bi], false);
                setMeshInScene(mBurstBalls[bi], false);
                continue;
            }
            // The fireball chases the car it hit as that car spins away
            // (TrackProps IMPACT_FOLLOW 10/s); the ring stays at the impact.
            if (b.car >= 0 && (uint32_t) b.car < nCars && (size_t) b.car < carPosW.size()) {
                const TtpCarInput& hit = cars[b.car];
                const float3 target = carPosW[b.car]
                        + float3{ hit.up.x, hit.up.y, hit.up.z } * 0.3f;
                b.ball += (target - b.ball) * std::min(1.0f, 10.0f * input.dt);
            }
            // Ring: IMPACT_RING_R0 0.25 → R1 2.0 on the JS ease-out
            // (1-(1-t)²), half-width held at IMPACT_RING_W 0.05 the whole way,
            // alpha IMPACT_RING_OPACITY 0.55 tapering to nothing.
            const float tr = b.t / DUR;
            const float R = 0.25f + 1.75f * (1.0f - (1.0f - tr) * (1.0f - tr));
            setMeshInScene(mBurstMeshes[bi], true);
            tcm.setTransform(ringI, mat4f::translation(b.pos));
            if (mBurstRingMats[bi]) {
                mBurstRingMats[bi]->setParameter("ring", math::float2{ R, 0.05f });
                mBurstRingMats[bi]->setParameter("tint",
                        math::float4{ 1, 1, 1, 0.55f * (1.0f - tr) });
            }
            // Ball: pops to IMPACT_FLASH_R 0.62 in ~0.1 s and then HOLDS that
            // size while its brightness dies — a fireball that shrank instead
            // read as a balloon deflating.
            const float tf = std::min(1.0f, b.t / FLASH);
            const bool ballUp = b.t < FLASH;
            setMeshInScene(mBurstBalls[bi], ballUp);
            if (ballUp) {
                tcm.setTransform(ballI, mat4f::translation(b.ball)
                        * mat4f::scaling(float3{ 0.62f
                                * (0.5f + 0.5f * std::min(1.0f, tf * 5.0f)) }));
                if (mBurstBallMats[bi]) {
                    const float a = tf < 0.25f ? 1.0f
                            : std::max(0.0f, 1.0f - (tf - 0.25f) / 0.75f);
                    mBurstBallMats[bi]->setParameter("tint", math::float4{ 1, 1, 1, a });
                }
            }
        }
    }

    // Auras FIRST among the dynamics (under every shadow and blob — see the
    // auraDecals note in render() for why the mesh era's aura-over-shadow order
    // inverts under a mix composite), then the frame's one decal upload. This
    // sits after the world block so a banana's or rocket's stamp lands on the
    // frame its prop appears, not one frame late. uploadDeckDecals still puts
    // the statics ahead of all of it, so an aura keeps landing over the pad or
    // slick it crosses.
    if (!auraDecals.empty()) {
        const size_t room = (size_t) std::max(0,
                kMaxDeckDecals - (int) mDeckDecals.size());
        mDeckDecals.insert(mDeckDecals.begin(), auraDecals.begin(),
                auraDecals.begin() + std::min(room, auraDecals.size()));
    }
    uploadDeckDecals();
}

void TtpRenderer::renderSkids(const TtpFrameInput& input, const TtpCarInput* cars,
        uint32_t nCars) {

    // Skid trails — the SkidMarks.js channels (slip past SKID_THRESH, curb
    // scrub, spin-out scribbles, brake bite, launch scratch) driving STAMPS
    // into the track-space rubber texture instead of a pooled world mesh.
    // Each marking wheel is projected to (s, lat), grows a connected ribbon
    // there — the stamp's rear edge is the previous stamp's front edge — and
    // commits a segment once it spans SKID_SEG_MIN. Ink is PERMANENT until
    // the race-restart wipe — there is no decay pass, by decision: the layer's
    // steady-state GPU cost is then just this pass's tiny quads, the throttled
    // mip refresh below, and vroad's one tap, and a racing line rubbers in over
    // the laps like a real toy track.
    //
    // What the mesh pool had that this deliberately does not: the live stamp
    // that stretched to the tyre every frame. Additive accumulation cannot
    // rewrite, so a trail trails the tyre by up to SKID_SEG_MIN — which is
    // why SEG_MIN is small. The pool's 0.25 was a RING-BUFFER budget
    // (slots × length = seconds of rubber); no pool, no budget, and 0.25 cost
    // the look twice over: arcs came out as quarter-unit straight facets
    // (~10° corners on a donut), and marks popped in a visible chunk at a
    // time behind the tyre. At 0.06 a marking wheel commits roughly every
    // frame at speed, so the facets shrink to per-frame travel and the trail
    // hugs the tyre. Per-frame stamp count is bounded by wheels, not by
    // SEG_MIN, so this costs nothing.
    if (mSkidTex && mTrack && !mWheelTrails.empty()) {
        constexpr float SKID_MAX_OPACITY = 0.28f, SKID_THRESH = 0.2f;
        constexpr float SKID_SEG_MIN = 0.06f, SKID_SEG_MAX = 1.5f;
        constexpr float SKID_EDGE_DOT = 0.3f, SKID_BRAKE_MIN = 0.6f;
        constexpr float SKID_LAUNCH_MIN = 0.5f;
        constexpr float SKID_ATTACK = 0.1f;  // s from nothing to full strength
        constexpr float SKID_RELEASE = 0.4f; // s from full strength to nothing
        const float L = mTrack->length;
        const auto wrapS = [&](float d) {
            return (L > 0) ? d - L * std::round(d / L) : d;
        };
        // One committed segment → one 4-column stamp in DEVICE space over the
        // rubber texture (x = s/L into [-1,1], y = lat/latHalf), plus a copy
        // shifted one full lap so a segment straddling the start line lands on
        // both sides. The copy is usually entirely off-viewport and clips for
        // free. Corner s-values arrive RELATIVE to the segment's own centre so
        // the lap wrap is taken once, not per corner.
        const auto stamp = [&](float midS, const float2& rL, const float2& rR,
                const float2& fL, const float2& fR, float strength) {
            if (mSkidQuadCount + 2 > kSkidQuadCap) return;
            const float peak = SKID_MAX_OPACITY * std::min(1.0f, strength);
            const uint32_t rr = (uint32_t) std::lround(peak * 255.0f);
            const uint32_t ink = 0xff000000u | rr;
            const float u0 = (L > 0) ? (midS - L * std::floor(midS / L)) / L : 0.0f;
            const float2 e[2][2] = { { rL, rR }, { fL, fR } };
            // The outer columns ARE the tyre's contact width and the ink
            // columns sit one small step inside, so the whole footprint —
            // skirt included — is exactly the wheel and the flat core is most
            // of it. The ramp is pure anti-aliasing, sized to the texel
            // footprint ALONG THE MARK'S WIDTH DIRECTION: a straight mark's
            // edges are resolved by the fine lat axis and stay crisp, while a
            // slalom's diagonal segments alias against the coarser s axis and
            // widen to what a smooth diagonal actually needs. One isotropic
            // ramp was tried both ways first: sized to the coarse axis it
            // smeared the straights, sized under a texel the diagonals came
            // out as a staircase. (And the width itself is not the knob: a
            // fraction-of-width feather ate the core into a smear, a skirt
            // OUTSIDE the width read as marks wider than the wheels.)
            const float2 rw{ rR.x - rL.x, rR.y - rL.y };
            const float wlen = std::sqrt(rw.x * rw.x + rw.y * rw.y);
            float ramp = 1.3f * mSkidTexelLat;
            if (wlen > 1e-5f) {
                const float ws = rw.x / wlen, wl = rw.y / wlen;
                ramp = 1.3f * std::sqrt(ws * ws * mSkidTexelS * mSkidTexelS
                        + wl * wl * mSkidTexelLat * mSkidTexelLat);
            }
            Vertex* v = &mSkidVerts[(size_t) mSkidQuadCount * 8];
            for (int ed = 0; ed < 2; ed++) {
                const float2& a = e[ed][0];
                const float2& b = e[ed][1];
                float2 d{ b.x - a.x, b.y - a.y };
                const float len = std::sqrt(d.x * d.x + d.y * d.y);
                const float k2 = len > 1e-5f ? std::min(0.4f, ramp / len) : 0.0f;
                d.x *= k2; d.y *= k2;
                const float2 cols[4] = { a, { a.x + d.x, a.y + d.y },
                                         { b.x - d.x, b.y - d.y }, b };
                for (int k = 0; k < 4; k++) {
                    Vertex& o = v[ed * 4 + k];
                    o.px = (u0 + cols[k].x / std::max(L, 1e-3f)) * 2.0f - 1.0f;
                    o.py = cols[k].y / mSkidLatHalf;
                    o.pz = 0.0f;
                    o.abgr = (k == 0 || k == 3) ? (ink & 0xff000000u) : ink;
                }
            }
            Vertex* w = v + 8;
            const float shift = (u0 > 0.5f) ? -2.0f : 2.0f;
            for (int k = 0; k < 8; k++) {
                w[k] = v[k];
                w[k].px += shift;
            }
            mSkidQuadCount += 2;
        };
        for (uint32_t i = 0; i < nCars; i++) {
            const TtpCarInput& c = cars[i];
            if (mCarWheels.size() <= i) continue;
            if (mWheelTrails.size() < (size_t) (i + 1) * 4) continue;
            CarWheels& cw = mCarWheels[i];
            WheelTrail* trails = &mWheelTrails[i * 4];
            const float spd = c.spd; // NORMALIZED v/vmax, like the JS snapshot
            const bool scrub = c.scrub > 0.5f;
            if (spd <= 0.05f && !scrub) {
                for (int wi = 0; wi < 4; wi++) trails[wi].seeded = false;
                continue;
            }
            const float3 fwd = { c.forward.x, c.forward.y, c.forward.z };
            const float3 up = { c.up.x, c.up.y, c.up.z };
            const float3 posW = { c.pos.x, c.pos.y, c.pos.z };
            const float turn = std::min(1.0f, std::fabs(c.steer));
            const bool spinning = std::fabs(c.spin) > 0.05f;
            const float slip = scrub ? 1.0f
                    : std::max(0.0f, (turn - SKID_THRESH) / (1.0f - SKID_THRESH));
            const float brakeBite = (c.brake > SKID_BRAKE_MIN && spd > 0.25f)
                    ? (c.brake - SKID_BRAKE_MIN) / (1.0f - SKID_BRAKE_MIN) : 0.0f;
            const float launch = (cw.accelNorm > SKID_LAUNCH_MIN && spd < 0.5f)
                    ? std::min(1.0f, (cw.accelNorm - SKID_LAUNCH_MIN) / (1.0f - SKID_LAUNCH_MIN))
                            * (1.0f - spd / 0.5f) * 0.6f : 0.0f;
            const float raw = (scrub || spinning) ? 1.0f
                    : std::min(1.0f, std::max(slip * 1.3f, std::max(brakeBite, launch)));
            // Attack over SKID_ATTACK, release over the slower SKID_RELEASE
            // (SkidMarks.js released only — it attacked in a single frame).
            // The RELEASE is load-bearing: a scuff that stops dead leaves a
            // DASH, because bots weaving down a bendy stretch cross the scuff
            // threshold every few frames, and every dip would end the ribbon.
            // Holding the strength through the dips keeps one trail that fades.
            // The ATTACK is what makes a mark read as being LAID DOWN, because
            // `raw` is all but binary in practice: the phone's brake is a 0/1,
            // so `brakeBite` is only ever exactly 1.0, and `slip * 1.3`
            // saturates at a steer input of 0.815 that any real corner passes.
            // Unramped, every scuff arrived at peak ink already formed. A tenth
            // of a second is roughly the first car length getting dark.
            cw.skidHold = raw > cw.skidHold
                    ? std::min(raw, cw.skidHold + input.dt / SKID_ATTACK)
                    : std::max(raw, cw.skidHold - input.dt / SKID_RELEASE);
            const float strength = cw.skidHold;
            // Wheel contact patches from the posed wheel nodes (whirl included,
            // lean/dive not — JS wheels are children of the yawed car, not the
            // leaning body). project() takes them to (s, lat); no deck drop and
            // no ridge lift any more — the stamp is paint in the road's own
            // shader, so there is nothing to hover above the facets.
            static const mat4f FLIP = mat4f::rotation(M_PI, float3{ 0, 1, 0 });
            const float3 right = normalize(cross(up, fwd));
            const mat4f m2{ float4{ right, 0 }, float4{ up, 0 }, float4{ fwd, 0 },
                            float4{ posW, 1 } };
            const mat4f poseSpun = (c.spin != 0)
                    ? m2 * mat4f::rotation(c.spin, float3{ 0, 1, 0 }) * FLIP
                    : m2 * FLIP;
            // While the monster transform is up the car's own wheels are scaled
            // to nothing and the RIG's fat tyres are the ones on the road, so
            // the trails come off THEIR contact points and carry THEIR width.
            // The rig rides the same `base` frame the car does (rigPose = flat),
            // so its rest translations live in this very local space.
            const bool onRig = c.monster > 0.5f && mMonsterWheels.size() > i
                    && !mMonsterWheels[i].bl.isNull();
            const MonsterWheels* mwp = onRig ? &mMonsterWheels[i] : nullptr;
            const float3 wlocal[4] = {
                mwp ? mwp->flT : cw.flT, mwp ? mwp->frT : cw.frT,
                mwp ? mwp->blT : cw.blT, mwp ? mwp->brT : cw.brT,
            };
            // The four-wheel channel releases on the same taper, so the fronts
            // fade out with the rears instead of stopping mid-mark.
            cw.skidAllHold = (scrub || spinning) ? 1.0f
                    : std::max(0.0f, cw.skidAllHold - input.dt / SKID_RELEASE);
            const bool marksAll = cw.skidAllHold > 0.02f;
            if (!marksAll) { trails[0].seeded = false; trails[1].seeded = false; }
            const float halfW = (mwp && mMonsterSkidWidth > 0
                    ? mMonsterSkidWidth : cw.skidWidth) / 2;
            for (int wi = marksAll ? 0 : 2; wi < 4; wi++) {
                WheelTrail& st = trails[wi];
                const float3 gp = (poseSpun * float4{ wlocal[wi], 1 }).xyz;
                if (st.projHint < 0 && mDecalProjHint.size() > i) {
                    st.projHint = mDecalProjHint[i]; // seed from the car
                }
                float ws = 0, wl = 0;
                mTrack->project(gp, up, ws, wl, &st.projHint);
                const float2 cur{ ws, wl };
                if (!st.seeded) {
                    st.last = cur;
                    st.seeded = true;
                    st.hasEdge = false;
                    continue;
                }
                const float2 seg{ wrapS(cur.x - st.last.x), cur.y - st.last.y };
                const float dist = std::sqrt(seg.x * seg.x + seg.y * seg.y);
                if (dist > SKID_SEG_MAX || strength <= 0.02f) {
                    // Teleport, or not marking. Re-anchor on the wheel EVERY
                    // frame while quiet, not just once it has moved a segment:
                    // a parked `last` up to SEG_MIN behind the tyre made the
                    // next scuff's first stamp span the whole gap in one frame
                    // at full ink — at the pool era's SEG_MIN 0.25, a brake
                    // tap POPPED a mark 0.19 u long out of 0.075 u of travel,
                    // on a car 0.88 u long.
                    st.last = cur;
                    st.hasEdge = false;
                    continue;
                }
                if (dist < SKID_SEG_MIN) continue; // grows silently until commit
                const float2 dir{ seg.x / dist, seg.y / dist };
                if (st.hasEdge
                        && st.dir.x * dir.x + st.dir.y * dir.y < SKID_EDGE_DOT) {
                    st.hasEdge = false; // sharp bend: don't stretch back to it
                }
                const float2 perp{ -dir.y * halfW, dir.x * halfW };
                // The rear edge reuses the previous stamp's front edge verbatim
                // (shared joint edges keep bends watertight); its s arrives
                // relative to `cur` so the wrap is consistent across the joint.
                float2 rL, rR;
                if (st.hasEdge) {
                    rL = st.edgeL;
                    rR = st.edgeR;
                } else {
                    rL = { st.last.x - perp.x, st.last.y - perp.y };
                    rR = { st.last.x + perp.x, st.last.y + perp.y };
                }
                const float2 fL{ cur.x - perp.x, cur.y - perp.y };
                const float2 fR{ cur.x + perp.x, cur.y + perp.y };
                const auto rel = [&](const float2& p) {
                    return float2{ wrapS(p.x - cur.x), p.y };
                };
                stamp(cur.x, rel(rL), rel(rR), rel(fL), rel(fR), strength);
                st.edgeL = fL;
                st.edgeR = fR;
                st.hasEdge = true;
                st.dir = dir;
                st.last = cur;
            }
        }
        // The GPU pass — the ONLY recurring cost of the whole layer: a
        // handful of tiny quads on frames that committed a segment, nothing
        // at all otherwise. The restart wipe rides the same pass as a clear
        // (the staging pool is zeroed after every draw, so a wipe with no
        // fresh stamps clears and draws nothing).
        if ((mSkidWipe || mSkidQuadCount > 0) && mSkidStampView && mSkidTex) {
            const Renderer::ClearOptions prev = mRenderer->getClearOptions();
            Renderer::ClearOptions co{};
            co.clear = mSkidWipe;
            co.clearColor = { 0, 0, 0, 0 };
            co.discard = false; // the whole point is what the target holds
            mRenderer->setClearOptions(co);
            if (mSkidQuadCount > 0) {
                mSkidVB->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                        mSkidVerts.data(), mSkidVerts.size() * sizeof(Vertex),
                        nullptr));
            }
            // The target lives only for this pass: attached any longer and the
            // Metal backend samples the texture as zero — the WHY is at the
            // build-time wipe in TtpRendererTrack.cpp.
            RenderTarget* rt = RenderTarget::Builder()
                    .texture(RenderTarget::AttachmentPoint::COLOR, mSkidTex)
                    .build(*mEngine);
            if (rt) {
                mSkidStampView->setRenderTarget(rt);
                mRenderer->renderStandaloneView(mSkidStampView);
                mSkidStampView->setRenderTarget(nullptr);
                mEngine->destroy(rt);
            }
            if (mSkidQuadCount > 0) {
                std::memset(mSkidVerts.data(), 0,
                        (size_t) mSkidQuadCount * 8 * sizeof(Vertex));
                mSkidQuadCount = 0;
            }
            mSkidWipe = false;
            mRenderer->setClearOptions(prev);
            mSkidMipsDirty = true;
        }
        // Refresh the rubber layer's mip chain, throttled. The tap filters
        // trilinear (bindSkidLayer): without mips, the deck ahead minifies a
        // 16k-wide layer through single-texel lookups and every mark
        // SCINTILLATES in motion, which the eye reads as the track itself
        // flickering. Regenerating on every stamp frame would be a per-frame
        // pass over megatexels — the exact recurring cost this layer's design
        // refuses — so it runs at most ~7 Hz; a fresh mark is under the car at
        // mip 0 for those 150 ms, where no one can see the difference.
        if (mSkidMipsDirty && mSkidTex && mTime - mSkidMipsAt > 0.15f) {
            mSkidTex->generateMipmaps(*mEngine);
            mSkidMipsDirty = false;
            mSkidMipsAt = mTime;
        }
    }

}

void TtpRenderer::renderAmbient(const TtpFrameInput& input) {

    // Ambient sprite size. THREE.Points are sized in SCREEN space — its shader
    // is `gl_PointSize = size * (canvasHeight/2) / distance` — so a particle's
    // world extent works out to `size × rows × tan(fov/2)`, where `rows` is the
    // split-screen row count. That layout term is an accident of three using the
    // WHOLE canvas height while rendering into a cell, and it means the same
    // theme draws snow twice as big in a 4-player race as in a 1-player one.
    // Matching it is the parity goal, so we fit the same number each frame; if
    // the three side ever loses the quirk, this collapses to a constant.
    if (mPollenMat) {
        const uint32_t vc = input.viewCount;
        const uint32_t rows = vc ? (vc + (uint32_t) std::ceil(std::sqrt((double) vc)) - 1)
                        / (uint32_t) std::ceil(std::sqrt((double) vc))
                : 1u;
        const float fov = vc ? ttp_frame_views(&input)[0].fov : 50.0f;
        mPollenMat->setParameter("halfSize",
                mAmbSize * (float) rows * std::tan(fov * (float) M_PI / 360.0f));
        mPollenMat->setParameter("time", mTime); // drives the shader-side drift
    }

    // Frame pacing. beginFrame() drops a frame when the GPU is behind — it waits
    // on a fence from two frames ago, and on WEB that fence signals late enough
    // that it dropped ~38% of frames on an idle GPU. The cost is a stale canvas
    // while the page keeps ticking at full rate: the visible framerate falls but
    // the rAF-counting fps meter still reads 60, which is exactly what a stutter
    // with no explanation looks like. In a browser the pacing is already done
    // for us — rAF fires on the compositor's schedule and stops firing when we
    // can't keep up — so we take the choice the API offers: "when beginFrame()
    // returns false, the caller has the choice to either skip the frame ... or
    // proceed as though true was returned" (Renderer.h). Native shells keep the
    // skipper; they have a real display pipeline behind them and no rAF.
    // The 2D cell overlay's geometry for this frame — placed before beginFrame,
    // since it edits scene membership, and drawn after the present pass below.
    drawOverlay(input);

}

void TtpRenderer::renderCells(const TtpFrameInput& input, double& tMark) {
    auto& tcm = mEngine->getTransformManager();
    const TtpViewInput* views = ttp_frame_views(&input);
    if (input.viewCount == 0) {
        mRenderer->render(mView);
    } else {
        // Split-screen: same cell grid as the display (bestGrid ≈ square-ish,
        // row 0 on top — flipped here because GL viewports are bottom-left).
        mProfile[kProfCellSetup] = 0; mProfile[kProfCellRender] = 0;
        ensureSceneTarget();
        ensureCells(input.viewCount);
        for (uint32_t i = 0; i < input.viewCount; i++) {
            // A CELL gets its tile of the fitted grid; an OVERVIEW gets the
            // surface entire. The frame says which (TTP_FRAME_OVERVIEW) rather
            // than this guessing from viewCount, which is 1 for both.
            const CellRect rect = (input.flags & TTP_FRAME_OVERVIEW)
                    ? CellRect{ 0, 0, mWidth, mHeight }
                    : cellRect(input.viewCount, i);
            View* v = mCellViews[i];
            Camera* cam = mCellCameras[i];
            // Every cell into the one scene buffer, each in its own sub-rect.
            // Filament drops the colour clear after the first view of a frame
            // (depth still clears per view), so the cells accumulate instead of
            // wiping each other — the same thing three does with one target and
            // per-cell viewport + scissor.
            v->setRenderTarget(mSceneRT);
            v->setViewport({ rect.x, rect.y, rect.w, rect.h });
            mat4f world;
            std::memcpy(&world, views[i].world, sizeof(world));
            cam->setModelMatrix(world);
            cam->setProjection(views[i].fov, views[i].aspect,
                    views[i].nearZ, views[i].farZ, Camera::Fov::VERTICAL);
            // Fog rides the VIEW: the race cells, the lobby's perimeter orbit
            // and the overview each run their own ramp, and the gallery runs
            // none (fogFar <= fogNear).
            v->setFogOptions(fogFor(views[i].fogNear, views[i].fogFar, fogColorGraded(cam)));
            // Per-cell monster fade: a truck looming in front of THIS cell's
            // car swaps to its 50%-alpha ghost (chassis + grafted body), while
            // every other cell — including the monster driver's own — keeps it
            // solid. Same between-render() trick as the cloud billboards.
            for (size_t mi = 0; mi < mMonsterViews.size(); mi++) {
                const MonsterView& mv = mMonsterViews[mi];
                if (!mv.on) continue;
                const bool ghost = (mv.mask >> i) & 1u;
                static const mat4f GPARK = mat4f::translation(float3{ 0, -1000, 0 });
                const bool haveRigGhost = mMonsterGhostInstances.size() > mi
                        && mMonsterGhostInstances[mi];
                const bool haveBodyGhost = mCarGhostAssets.size() > mi && mCarGhostAssets[mi];
                const bool useGhost = ghost && haveRigGhost && haveBodyGhost;
                if (mMonsterInstances.size() > mi && mMonsterInstances[mi]) {
                    tcm.setTransform(tcm.getInstance(mMonsterInstances[mi]->getRoot()),
                            useGhost ? GPARK : mv.rig);
                }
                if (haveRigGhost) {
                    tcm.setTransform(tcm.getInstance(mMonsterGhostInstances[mi]->getRoot()),
                            useGhost ? mv.rig : GPARK);
                }
                if (mCarAssets.size() > mi && mCarAssets[mi]) {
                    tcm.setTransform(tcm.getInstance(mCarAssets[mi]->getRoot()),
                            useGhost ? GPARK : mv.body);
                }
                if (haveBodyGhost) {
                    tcm.setTransform(tcm.getInstance(mCarGhostAssets[mi]->getRoot()),
                            useGhost ? mv.body : GPARK);
                }
            }
            // Fliers ride the same per-cell billboard trick as the clouds.
            // Birds circle their roosts with a wing-beat that squashes the
            // glyph's height (SceneRenderer's flap); kites bob around their
            // anchors and sway on the string.
            if (mTrack && !mBirds.empty()) {
                const TrackBin& t = *mTrack;
                for (size_t bi = 0; bi < mBirds.size(); bi++) {
                    if (mBirds[bi].entity.isNull()) continue;
                    const float a0 = ((float) bi / 4) * 2.0f * (float) M_PI + (bi % 3) * 0.8f;
                    const float dy = (bi % 3) * 2.5f;
                    const float ph0 = bi * 2.1f, sp = 0.82f + (bi % 4) * 0.12f;
                    const float ph = ph0 + mTime * t.birdSpeed * sp;
                    const float3 p{
                        std::cos(a0) * t.birdRc * mHillSf + std::cos(ph) * t.birdRb,
                        t.birdY + dy * t.birdDys + std::sin(ph * 2.3f) * 0.9f,
                        std::sin(a0) * t.birdRc * mHillSf + std::sin(ph) * t.birdRb };
                    const float beat = 0.5f + 0.5f * std::sin(
                            (mTime * sp * t.birdFlapHz + ph0) * 2.0f * (float) M_PI);
                    const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                    tcm.setTransform(tcm.getInstance(mBirds[bi].entity),
                            mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                            * mat4f::scaling(float3{ t.birdSize,
                                    t.birdSize * 0.5f * (1 - t.birdFlap * 0.48f * beat), 1 }));
                }
            }
            if (mTrack && !mKites.empty()) {
                const TrackBin& t = *mTrack;
                for (size_t ki = 0; ki < mKites.size(); ki++) {
                    if (mKites[ki].entity.isNull()) continue;
                    const float a0 = 0.9f + ki * 2.6f, r = 105.0f + ki * 18.0f;
                    const float ph = ki * 1.7f;
                    const float3 p{
                        std::cos(a0) * r * mHillSf + std::sin(mTime * 0.55f + ph) * 2.2f,
                        t.kiteY + std::sin(mTime * 0.85f + ph * 2) * 1.6f
                                + std::sin(mTime * 2.1f + ph) * 0.35f,
                        std::sin(a0) * r * mHillSf + std::cos(mTime * 0.5f + ph) * 2.2f };
                    const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                    const float roll = std::sin(mTime * 0.9f + ph) * 0.14f;
                    tcm.setTransform(tcm.getInstance(mKites[ki].entity),
                            mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                            * mat4f::rotation(roll, float3{ 0, 0, 1 })
                            * mat4f::scaling(float3{ t.kiteSize }));
                }
            }
            // Dust banks drift faster than the clouds above them (wind shear
            // sells "dust", not "low cloud"), wrapping outside the hill ring.
            for (size_t hi = 0; hi < mHaze.size(); hi++) {
                if (mHaze[hi].entity.isNull()) continue;
                const float wrap = 300.0f * mHillSf;
                float3 p = mHazePos[hi];
                p.x = std::fmod(std::fmod(p.x + 2.2f * mTime + wrap, 2 * wrap)
                        + 2 * wrap, 2 * wrap) - wrap;
                p.x *= 1.0f; p.z *= mHillSf;
                const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                tcm.setTransform(tcm.getInstance(mHaze[hi].entity),
                        mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 }));
            }
            // Per-view cloud billboards: single-threaded rendering executes
            // each render() immediately, so re-aiming the sprites between
            // cells gives every camera its own facing (the JS sprite way).
            for (size_t ci = 0; ci < mClouds.size(); ci++) {
                if (mClouds[ci].entity.isNull()) continue;
                // Push the AUTHORED position out to the SKY_BAND unfogged
                // band along its current direction (drift moves it in
                // authored space, like the JS). Size keeps the k^0.55
                // softening CALIBRATED AT THE 405 BAND, rescaled to the
                // farther SKY_BAND so the angular look is unchanged.
                float3 p0 = mCloudPos[ci];
                p0.x = std::fmod(std::fmod(p0.x + 0.7f * mTime + 300.0f, 600.0f)
                        + 600.0f, 600.0f) - 300.0f; // JS drift, closed-form
                const float len = std::max(1.0f, length(p0));
                const float k = SKY_BAND / len;
                const float3 p = p0 * k;
                const float sk = std::pow(405.0f / len, 0.55f) * (SKY_BAND / 405.0f);
                const float yaw = std::atan2(world[3].x - p.x, world[3].z - p.z);
                mEngine->getTransformManager().setTransform(
                        mEngine->getTransformManager().getInstance(mClouds[ci].entity),
                        mat4f::translation(p) * mat4f::rotation(yaw, float3{ 0, 1, 0 })
                        * mat4f::scaling(float3{ sk }));
            }
            // Boost streaks: AXIAL billboards (streakBillboard) — spin each
            // about its length axis (local Z) so the face (+Y) turns toward
            // THIS cell's camera; a fixed quad is edge-on from dead astern.
            for (size_t si = 0; si < mStreakMeshes.size(); si++) {
                Mesh& sm = mStreakMeshes[si];
                if (sm.entity.isNull()) continue;
                auto& tcmV = mEngine->getTransformManager();
                auto sInst = tcmV.getInstance(sm.entity);
                const Streak& st = mStreaks[si];
                const size_t car = si / 4;
                // A dead streak was already removed from the scene by the
                // update pass — nothing to park, nothing to write.
                if (!sm.inScene || mCarBasis.size() <= car
                        || mCarBasisInv.size() <= car) {
                    continue;
                }
                const mat4f& P = mCarBasis[car];
                // The inverse is the car's, not the cell's — cached per car per
                // frame above rather than recomputed for each of the four cells.
                const float3 camL = (mCarBasisInv[car]
                        * float4{ world[3].x, world[3].y, world[3].z, 1 }).xyz;
                const float3 vv = camL - float3{ st.x, st.y, st.z };
                const float beta = std::atan2(-vv.x, vv.y);
                tcmV.setTransform(sInst,
                        P * mat4f::translation(float3{ st.x, st.y, st.z })
                          * mat4f::rotation(beta, float3{ 0, 0, 1 })
                          * mat4f::scaling(float3{ 0.07f, 1.0f, st.len }));
            }
            mProfile[kProfCellSetup] += ttpNowMs() - tMark; tMark = ttpNowMs();
            mRenderer->render(v);
            mProfile[kProfCellRender] += ttpNowMs() - tMark; tMark = ttpNowMs();
        }
        // One pass for the whole canvas: grade, sRGB, FXAA, done.
        if (mSceneRT) mRenderer->render(mPresentView);
    }
    // The cell overlay goes on LAST, over the graded canvas — see voverlay.mat
    // for why it is past the grade and not inside it.
    if (mOverlayUsed && mOverlayView) mRenderer->render(mOverlayView);
}

bool TtpRenderer::render(const TtpFrameInput& input) {
    if (input.version != TTP_FRAME_INPUT_VERSION) return false;
    // Every wall-clock cosmetic phases off the DRIVING scene's clock — an own
    // accumulated clock would drift by the boot-time difference between the
    // two renderers (the balloon hung at a different bearing).
    mTime = input.sceneT;
    const double tFrame0 = ttpNowMs();
    double tMark = tFrame0;

    // Cars follow the contract poses: basis (right, up, forward) + pos. GLB
    // assets get an extra half-turn — Kenney vehicles are modelled facing -Z
    // (same fix as the Three.js renderer's base yaw).
    const TtpCarInput* cars = ttp_frame_cars(&input);
    const uint32_t nCars = std::min<uint32_t>(input.carCount, (uint32_t) mCars.size());
    // Conformed car positions, kept for the props that test against the car's
    // RENDERED spot (cone kicks) rather than the raw contract pose.
    std::vector<float3> carPosW(nCars);
    // Boost auras, held back until after the loop (per-car interleaving would
    // break the order for two overlapping cars) and composited UNDER every
    // contact shadow. The mesh era layered the aura OVER the shadow, but that
    // premise was ADDITIVE blending: glow added over ink left the ink visible
    // through it. A decal mix REPLACES what is under it, so the same order
    // ERASED the shadow for a boost's whole life and handed it back at the
    // gate — the shadow blinking in and out with every boost. Ink over glow is
    // the mix-composite spelling of the same look: the disc still glows around
    // the car, and the shadow stays put through it.
    std::vector<DeckDecal> auraDecals;
    renderCars(input, cars, nCars, carPosW, auraDecals);
    mProfile[kProfCars] = ttpNowMs() - tMark; tMark += mProfile[kProfCars];
    renderWorld(input, cars, nCars, carPosW, auraDecals);
    mProfile[kProfWorld] = ttpNowMs() - tMark; tMark += mProfile[kProfWorld];
    renderSkids(input, cars, nCars);
    mProfile[kProfSkids] = ttpNowMs() - tMark; tMark += mProfile[kProfSkids];
    renderAmbient(input);
    mProfile[kProfAmbient] = ttpNowMs() - tMark; tMark += mProfile[kProfAmbient];
    const bool pace = mRenderer->beginFrame(mSwapChain);
    mProfile[kProfBeginFrame] = ttpNowMs() - tMark; tMark += mProfile[kProfBeginFrame];
#if defined(__EMSCRIPTEN__)
    (void) pace;
#else
    if (!pace) return false; // legit frame skip — canvas is STALE
#endif

    renderCells(input, tMark);
    mProfile[kProfPresent] = ttpNowMs() - tMark; tMark = ttpNowMs();
    mRenderer->endFrame();
    mProfile[kProfEndFrame] = ttpNowMs() - tMark;
    mProfile[kProfTotal] = ttpNowMs() - tFrame0;
    return true;
}
