// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include <algorithm>
#include <chrono>

#include "TtpRendererImpl.h"

#include <utils/Log.h>

TtpRenderer::TtpRenderer() = default;

bool TtpRenderer::init(backend::Backend backend, void* nativeWindow,
        uint32_t width, uint32_t height, uint8_t stereoEyes) {
    // The skid stamp pass only runs on frames that commit a trail segment, so
    // its FrameGraph depth transient (a deck-sized ~16 MB texture) sits unused
    // for a frame or two between passes. The texture cache's default max age
    // of 1 frame evicts it in that gap, and every stamp pass re-allocated it —
    // measured at ~33 allocations/s in an attract race. Four frames of age
    // covers the stamp cadence; idle transients still free, just 3 frames
    // later.
    Engine::Config engineConfig{};
    engineConfig.resourceAllocatorCacheMaxAge = 4;
    mStereoEyes = stereoEyes;
    if (stereoEyes) {
        // OVR_multiview stereo, decided at engine creation (Filament allows no
        // later switch). Costs nothing while no View sets stereo options —
        // measured on the box — but it does demand an SDK built with
        // FILAMENT_ENABLE_MULTIVIEW (build-runtime-android.sh's error text has
        // the whole story). The DRIVER side is a separate question, asked of
        // the built engine below: what gates multiview there is the
        // GL_OVR_multiview2 extension, not the feature level.
        engineConfig.stereoscopicType = backend::StereoscopicType::MULTIVIEW;
        engineConfig.stereoscopicEyeCount = stereoEyes;
    }
    Engine::Builder builder;
    builder.backend(backend)
            .config(&engineConfig)
            // The gpu-complete metric costs a glFenceSync EVERY FRAME plus a
            // dedicated thread blocked in fenceWait on it, and nothing reads
            // it — readGpuTimer consumes gpuFrameDuration, which is the TIMER
            // QUERY and survives this. A per-frame fence is exactly the kind
            // of kick-boundary pin that stops a tiler overlapping frame N+1's
            // vertex work with frame N's fill.
            .feature("engine.frame_info.disable_gpu_complete_metric", true)
            // VULKAN, and inert on every other backend. Filament's default is a
            // staging allocation, a vkCmdCopyBuffer and a pipeline barrier
            // either side of it for every buffer write that follows a read in
            // the same command buffer; on a UNIFIED-MEMORY device the buffer is
            // already mapped, so the bypass writes it with a plain memcpy and
            // the barrier pair — a pipeline drain on a tiler — goes away. That
            // pair is paid PER CELL, so a four-way split pays it four times:
            // measured -1.5 ms of a 40 ms 4P/1080 frame on the reference box,
            // interleaved, with the boards pixel-identical either way.
            //
            // Filament ships this OFF and calls it experimental. It is enabled
            // here as a MEASURED decision about one device family, not a
            // statement that the feature is finished upstream.
            .feature("backend.vulkan.enable_staging_buffer_bypass", true);
    if (stereoEyes) builder.featureLevel(backend::FeatureLevel::FEATURE_LEVEL_2);
    mEngine = builder.build();
    if (mEngine) {
        // The scenery is dozens of copies of a handful of GLBs — trees, boxes,
        // cones — and each instance was its own draw call. Filament can merge
        // identical primitives that share a MaterialInstance into one instanced
        // draw; three gets the same effect by merging its scenery into a single
        // mesh, which is most of why it issues 42 draws a frame where we issue
        // 111.
        mEngine->setAutomaticInstancingEnabled(true);
    }
    if (!mEngine) return false;
    // The driver's texture ceiling can sit UNDER the conservative default:
    // this box's GL driver reports 8192 while its Vulkan driver caps 2D
    // images at 4096, and a skid layer built past the cap is a
    // Texture::build PreconditionPanic in the middle of a scene build (which
    // the ARM EHABI unwinder then turns into a silent 100%-CPU hang rather
    // than an abort). Clamp rather than assign: the web surface hands in its
    // own measured GL_MAX_TEXTURE_SIZE before init, and a driver answering
    // more than the default must not raise it.
    mMaxTextureDim = (uint32_t) std::min<size_t>(mMaxTextureDim,
            Texture::getMaxTextureSize(*mEngine, Texture::Sampler::SAMPLER_2D));
    // THE DRIVER'S ANSWER, which the config above only asked for. A box without
    // GL_OVR_multiview2 leaves Filament's View::hasStereo() false, so it picks
    // the NON-stereo shader variants — while this renderer would still run its
    // two-eye passes into a 4-layer array and composite layers nothing wrote.
    // That fails silently and totally: the split renders BLACK in every cell,
    // HUD and all else intact. Clearing the request here is the whole fallback,
    // because every other gate (multiviewWants, ensureMultiviewTargets, the
    // vpresentmv build) already reads mStereoEyes.
    if (mStereoEyes
            && !mEngine->isStereoSupported(backend::StereoscopicType::MULTIVIEW)) {
        mStereoEyes = 0;
    }
    mSwapChain = mEngine->createSwapChain(nativeWindow);
    mRenderer = mEngine->createRenderer();
    // Clear the colour buffer at the start of a frame. It costs nothing (a load
    // action) and it defines the slivers no cell viewport covers: cell width is
    // floor(canvas/cols), so up to cols-1 columns belong to no view at all, and
    // the present pass reads them.
    Renderer::ClearOptions clear{};
    clear.clear = true;
    clear.clearColor = { 0.0f, 0.0f, 0.0f, 1.0f };
    mRenderer->setClearOptions(clear);
    mScene = mEngine->createScene();
    mView = mEngine->createView();
    mCameraEntity = utils::EntityManager::get().create();
    mCamera = mEngine->createCamera(mCameraEntity);
    mView->setCamera(mCamera);
    mView->setScene(mScene);
    mView->setPostProcessingEnabled(false);
    resize(width, height);
    return true;
}

void TtpRenderer::drain() {
    if (mEngine) mEngine->flushAndWait();
}

void TtpRenderer::resize(uint32_t width, uint32_t height) {
    mWidth = width;
    mHeight = height;
    mView->setViewport({ 0, 0, width, height });
    updateCamera();
    // Called between frames, which is the only safe place to swap the scene
    // buffer: render() must never find a size mismatch, so rebuild it here.
    destroySceneTarget();
    // The multiview array target follows the CELL size, which follows the
    // surface — same between-frames rule, rebuilt lazily by the frame path.
    destroyMultiviewTargets();
    // Only where the antialias pass will actually read it: with AA off (the
    // Android shell) this allocated a full-surface RGBA8+depth on EVERY
    // adaptive-scale move, for nothing — the frame path re-ensures it lazily
    // whenever post-processing is on (renderCells).
    if (mAntialias) ensureSceneTarget();
}

void TtpRenderer::updateCamera() {
    constexpr double ZOOM = 1.5;
    const double aspect = mHeight ? (double) mWidth / mHeight : 1.0;
    mCamera->setProjection(Camera::Projection::ORTHO,
            -aspect * ZOOM, aspect * ZOOM, -ZOOM, ZOOM, 0.0, 1.0);
}

bool TtpRenderer::provideAsset(const char* name, const uint8_t* bytes,
        uint32_t len) {
    if (!name || (!bytes && len)) return false;
    mAssets[name].assign(bytes, bytes + len);
    return true;
}

const std::vector<uint8_t>* TtpRenderer::asset(const char* name) const {
    const auto it = mAssets.find(name);
    return it == mAssets.end() ? nullptr : &it->second;
}

bool TtpRenderer::buildMesh(Mesh& m, bool addToScene,
        MaterialInstance* materialInstance, uint8_t priority, uint32_t chunkTris) {
    if (m.verts.empty() || m.idx.empty() || m.idx.size() % 3) return false;
    static_assert(sizeof(Vertex) == 16, "unexpected vertex layout");
    // BAKED per-vertex light (the road under the baked-light vroad): CUSTOM0
    // replaces TANGENTS — the material reads no normal at draw time, and the
    // qtangent was a 16-byte fetch per vertex on the scene's biggest mesh.
    // m.normals stays populated; fillRoadLight reads it on the CPU instead.
    const bool baked = !m.custom0.empty();
    const bool lit = !baked && !m.normals.empty() && mLitMaterial != nullptr;
    const bool uv = !m.uvs.empty();
    const uint8_t uvSlot = lit ? 2 : 1;
    const uint8_t customSlot = (uint8_t) (1 + (lit ? 1 : 0) + (uv ? 1 : 0));
    VertexBuffer::Builder vbb;
    vbb.vertexCount((uint32_t) m.verts.size())
            .bufferCount((uint8_t)
                    (1 + (lit ? 1 : 0) + (uv ? 1 : 0) + (baked ? 1 : 0)))
            .attribute(VertexAttribute::POSITION, 0,
                    VertexBuffer::AttributeType::FLOAT3, 0, sizeof(Vertex))
            .attribute(VertexAttribute::COLOR, 0,
                    VertexBuffer::AttributeType::UBYTE4, 12, sizeof(Vertex))
            .normalized(VertexAttribute::COLOR);
    if (uv) {
        vbb.attribute(VertexAttribute::UV0, uvSlot,
                VertexBuffer::AttributeType::FLOAT2, 0, sizeof(math::float2));
    }
    if (lit) {
        // Lit shading needs the TANGENTS frame; derive qtangents from the
        // builder-supplied normals (arbitrary tangent — no normal maps here).
        vbb.attribute(VertexAttribute::TANGENTS, 1,
                VertexBuffer::AttributeType::FLOAT4, 0, sizeof(math::quatf));
    }
    if (baked) {
        vbb.attribute(VertexAttribute::CUSTOM0, customSlot,
                VertexBuffer::AttributeType::HALF4, 0, sizeof(math::half4));
    }
    m.vb = vbb.build(*mEngine);
    m.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
            m.verts.data(), m.verts.size() * sizeof(Vertex), nullptr));
    if (uv) {
        m.uvs.resize(m.verts.size(), math::float2{ 0, 0 });
        m.vb->setBufferAt(*mEngine, uvSlot, VertexBuffer::BufferDescriptor(
                m.uvs.data(), m.uvs.size() * sizeof(math::float2), nullptr));
    }
    if (baked) {
        m.custom0.resize(m.verts.size(), math::half4{ 1.0f, 1.0f, 1.0f, 1.0f });
        m.custom0Slot = customSlot;
        m.vb->setBufferAt(*mEngine, customSlot, VertexBuffer::BufferDescriptor(
                m.custom0.data(), m.custom0.size() * sizeof(math::half4),
                nullptr));
    }
    if (lit) {
        m.normals.resize(m.verts.size(), float3{ 0, 1, 0 });
        m.quats.resize(m.verts.size());
        geometry::SurfaceOrientation* so = geometry::SurfaceOrientation::Builder()
                .vertexCount(m.verts.size())
                .normals(m.normals.data())
                .build();
        if (so) {
            so->getQuats(m.quats.data(), m.quats.size());
            delete so;
        }
        m.vb->setBufferAt(*mEngine, 1, VertexBuffer::BufferDescriptor(
                m.quats.data(), m.quats.size() * sizeof(math::quatf), nullptr));
    }
    m.ib = IndexBuffer::Builder()
            .indexCount((uint32_t) m.idx.size())
            .bufferType(IndexBuffer::IndexType::UINT)
            .build(*mEngine);
    m.ib->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(
            m.idx.data(), m.idx.size() * sizeof(uint32_t), nullptr));
    // Real bounds, per renderable. These were a ±1000 stand-in for years —
    // harmless while nothing used them, fatal once the sun started casting
    // (Filament sizes the shadow frustum from the CASTERS' bounds, and a 2 km
    // cube of "road" stretched a 2048² map over the whole world) and useless
    // for culling. Meshes whose verts are rewritten in world space every frame
    // keep whatever their template spanned, which is exactly why culling is
    // opt-in: they must never be culled on a stale box.
    const auto boundsOf = [&](size_t idx0, size_t idxN) {
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (size_t k = idx0; k < idx0 + idxN; k++) {
            const Vertex& v = m.verts[m.idx[k]];
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        return filament::Box{ (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) };
    };
    MaterialInstance* const mi = materialInstance ? materialInstance
            : lit ? (mLitPlainMaterial ? mLitPlainMaterial : mLitMaterial)
                            ->getDefaultInstance()
                  : mMaterial->getDefaultInstance();
    const size_t triCount = m.idx.size() / 3;
    // One renderable, or a chain of them over ranges of the SAME buffers. The
    // road is the reason: a whole circuit in one draw is a whole circuit's
    // worth of vertices every frame, in every split-screen cell, however little
    // of it is on screen. Three chunks its ribbon for the same reason.
    const size_t perChunk = chunkTris ? std::min<size_t>(chunkTris, triCount) : triCount;
    for (size_t t0 = 0; t0 < triCount; t0 += perChunk) {
        const size_t n = std::min(perChunk, triCount - t0);
        utils::Entity e = utils::EntityManager::get().create();
        RenderableManager::Builder(1)
                .boundingBox(boundsOf(t0 * 3, n * 3))
                // Blend-pass draw order (default 4), for the few blended
                // sheets that must stack deterministically instead of by an
                // arbitrary depth sort.
                .priority(priority)
                .material(0, mi)
                .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                        m.vb, m.ib, t0 * 3, n * 3)
                // Frustum culling for everything. The bounds are real now, and
                // the few meshes that rewrite their vertices in world space
                // every frame (the ambient band) refresh theirs
                // in the same breath — see refreshBounds.
                // Pointing the camera at empty sky used to still cost 69 draw
                // calls; per-draw GPU cost is ~18 µs, so that was over a
                // millisecond of drawing nothing.
                .culling(true)
                .receiveShadows(false)
                .castShadows(false)
                .build(*mEngine, e);
        if (t0 == 0) m.entity = e; else m.chunks.push_back(e);
        if (addToScene) mScene->addEntity(e);
    }
    m.inScene = addToScene;
    return true;
}

// Only ever called from releaseScene(), which flushes first — so dropping the
// CPU copies here is safe even though their BufferDescriptors carry no release
// callback. Clearing them is not optional: every builder push_backs, so a mesh
// rebuilt over stale vectors comes out with its previous contents still in it
// (doubled geometry AND a leak, ~14 MB a race).
void TtpRenderer::destroyMesh(Mesh& m) {
    for (utils::Entity e : m.chunks) {
        mScene->remove(e);
        mEngine->destroy(e);
        utils::EntityManager::get().destroy(e);
    }
    m.chunks.clear();
    if (!m.entity.isNull()) {
        mScene->remove(m.entity);
        mEngine->destroy(m.entity);
        utils::EntityManager::get().destroy(m.entity);
        m.entity = {};
    }
    if (m.vb) { mEngine->destroy(m.vb); m.vb = nullptr; }
    if (m.ib) { mEngine->destroy(m.ib); m.ib = nullptr; }
    m.inScene = false;
    // The CPU copies are BURIED, not dropped — the driver may still be reading
    // them. See MeshGrave for the whole argument.
    buryMeshBuffers(m);
    m.custom0Slot = 0;
    m.local = {};
}

void TtpRenderer::buryMeshBuffers(Mesh& m) {
    // An empty mesh buries nothing: most of what releaseScene walks was never
    // built for this scene, and a grave per never-used slot would age a hundred
    // empty vectors every frame.
    if (m.verts.empty() && m.idx.empty() && m.normals.empty()
            && m.quats.empty() && m.uvs.empty() && m.custom0.empty()) {
        return;
    }
    MeshGrave g;
    g.verts = std::move(m.verts);
    g.idx = std::move(m.idx);
    g.normals = std::move(m.normals);
    g.quats = std::move(m.quats);
    g.uvs = std::move(m.uvs);
    g.custom0 = std::move(m.custom0);
    g.grace = kGraveGraceFrames;
    mGraves.push_back(std::move(g));
    // A moved-from vector is valid but unspecified; these are re-used by the
    // next build, so they are put back to a known empty rather than trusted.
    m.verts = {}; m.idx = {}; m.normals = {};
    m.quats = {}; m.uvs = {}; m.custom0 = {};
}

void TtpRenderer::ageGraves() {
    if (mGraves.empty()) return;
    for (MeshGrave& g : mGraves) {
        if (g.grace) g.grace--;
    }
    mGraves.erase(std::remove_if(mGraves.begin(), mGraves.end(),
            [](const MeshGrave& g) { return g.grace == 0; }), mGraves.end());
}

void TtpRenderer::drainGravesBlocking() {
    if (mGraves.empty()) return;
    // The one place the old fence still belongs: nobody is going to present the
    // frames these graves are waiting for, so waiting is the only way to know
    // the driver is done with them. Called on engine teardown, where a stall
    // costs nothing anyone can see.
    if (mEngine) mEngine->flushAndWait();
    mGraves.clear();
}

// The roster half of TrackBin, copied off the slots the shell handed over.
//
// This used to be a byte parser over "track.bin" — a version word, three
// parallel arrays and four length checks, mirrored by a writer in JS. The
// liveries arrive as plain structs now (libttp-runtime's parseRoster does the
// colour arithmetic once), so what is left is a copy.
void TtpRenderer::applyRoster(TrackBin& out, const std::vector<TtpRosterCar>& roster) {
    const size_t n = roster.size();
    out.carColors.resize(n);
    for (size_t i = 0; i < n; i++) {
        out.carColors[i] = roster[i].colorABGR;
    }
}

// The biome half of TrackBin, taken straight off the resolved theme.
//
// This used to arrive in track.bin, authored in the browser: ~120 colours and
// intensities per biome serialized into a flat tag/value block that a JS writer
// and this reader had to keep in lockstep by hand. The palette is C++ data now
// (libttp-runtime/ttp/theme.h), already resolved — the ambient kind's motion
// preset, the cloud/bird/plane defaults and the per-track ambient patch are all
// folded in — so this is a copy, not a decode, and there is no defaulting left
// to disagree about.
//
// The field names are kept verbatim from the payload they replace, so every
// reader downstream (buildRoadMesh, buildScenery, the sky dome, the fog bands)
// is untouched by the move.
void TtpRenderer::applyTheme(TrackBin& out, const ttp::rt::Theme& th) {
    out.pal[0] = th.road.asphalt; out.pal[1] = th.road.line; out.pal[2] = th.road.dash;
    out.pal[3] = th.road.kerbA;   out.pal[4] = th.road.kerbB;
    out.pal[5] = th.road.skirt;   out.pal[6] = th.road.shoulder;
    out.kerbW = th.road.kerbW;
    out.kerbH = th.road.kerbH;
    out.edgeLines = th.road.edgeLines;

    out.sky[0] = th.sky[0]; out.sky[1] = th.sky[1]; out.sky[2] = th.sky[2];
    out.fog = th.fog;
    out.hillShape = th.hillShape;
    out.hillColors = th.hills;

    // Scenery models are named in the theme and indexed here: the index IS the
    // scenery<i>.glb slot the shell provided them in (ttp_theme_scenery_models
    // hands out the same list, in the same order).
    const ttp::rt::ScenerySpec& sc = th.scenery;
    const auto modelIndex = [&](const std::string& m) -> uint32_t {
        for (size_t i = 0; i < sc.models.size(); i++) if (sc.models[i] == m) return (uint32_t) i;
        return 0;
    };
    out.scDensity = sc.density;
    out.scMixTree = sc.mixTree;
    out.scMixBush = sc.mixBush;
    out.scTrees.clear();
    for (const ttp::rt::TreeSpec& t : sc.trees) {
        out.scTrees.push_back({ modelIndex(t.model), t.w, t.s0, t.s1 });
    }
    out.scHasBush = sc.hasBush;
    if (sc.hasBush) {
        out.scBush = { modelIndex(sc.bush.model), sc.bush.s0, sc.bush.s1, sc.bush.sink };
    }
    out.scRocks = sc.rocks;
    out.scRockS[0] = sc.rockS[0];
    out.scRockS[1] = sc.rockS[1];
    out.scModelCount = (uint32_t) sc.models.size();
    out.clDensity = sc.clutterDensity;
    out.clKinds.clear();
    for (const ttp::rt::ClutterSpec& c : sc.clutter) out.clKinds.push_back({ c.kind, c.w, c.tints });

    // Props ride the same slot contract (ttp_theme_prop_models / prop<i>.glb).
    out.prModelCount = (uint32_t) th.props.models.size();
    out.prDensity = th.props.scatterDensity;
    out.prScatter.clear();
    for (const ttp::rt::PropStamp& p : th.props.scatter) {
        out.prScatter.push_back({ p.slot, p.w, p.s0, p.s1, p.face });
    }

    out.lmKinds = th.landmarks;
    out.structureCol = th.structure;

    out.groundKind = th.groundKind;
    out.fogTune = th.fogTune;
    out.keyCol = th.key.color;
    out.keyIntensity = th.key.intensity;
    out.hemiSky = th.hemi.sky;
    out.hemiGround = th.hemi.ground;
    out.hemiIntensity = th.hemi.intensity;
    out.cloudCount = th.clouds.count;
    out.cloudOpacity = th.clouds.opacity;
    out.cloudScale = th.clouds.scale;
    out.cloudAspect = th.clouds.aspect;
    out.cloudTint = th.clouds.tint;
    out.gateCol = th.gate;
    out.gantryPylon = th.gantry.pylon;
    out.gantryFinial = th.gantry.finial;
    out.gantryHasRings = th.gantry.hasRings;
    out.gantryRings = th.gantry.rings;
    out.boostCol = th.boost;
    out.hasWater = th.hasWater;
    if (th.hasWater) {
        out.waterFoam = th.water.foam;
        out.waterShallow = th.water.shallow;
        out.waterDeep = th.water.deep;
        out.waterWet = th.water.wet;
        out.shoreSeed = th.water.shoreSeed;
    }
    out.hazeCount = th.haze.count;
    out.hazeOpacity = th.haze.opacity;
    out.hazeTint = th.haze.tint;
    out.hazeScale = th.haze.scale;
    out.ambKind = th.ambient.kind;
    out.ambCount = th.ambient.count;
    out.ambSize = th.ambient.size;
    out.ambOpacity = th.ambient.opacity;
    out.ambTint = th.ambient.tint;
    out.ambFall = th.ambient.fall;
    out.ambWind = th.ambient.wind;
    out.ambBob = th.ambient.bob;
    out.ambBand = th.ambient.band;
    out.birdCount = th.birds.count;
    out.birdTint = th.birds.tint;
    out.birdSize = th.birds.size;
    out.birdY = th.birds.y;
    out.birdRc = th.birds.rc;
    out.birdRb = th.birds.rb;
    out.birdSpeed = th.birds.speed;
    out.birdFlap = th.birds.flap;
    out.birdFlapHz = th.birds.flapHz;
    out.birdDys = th.birds.dys;
    out.kiteCount = th.kites.count;
    out.kiteSize = th.kites.size;
    out.kiteY = th.kites.y;
    out.kiteTints = th.kites.tints;
    out.hasPlane = th.hasPlane;
    if (th.hasPlane) {
        out.planeTint = th.plane.tint;
        out.planeSize = th.plane.size;
        out.planeY = th.plane.y;
        out.planeA0 = th.plane.a0;
        out.planeRc = th.plane.rc;
        out.planeRb = th.plane.rb;
        out.planeSpeed = th.plane.speed;
        out.planeBank = th.plane.bank;
    }
    out.balloonPanels = th.balloon.panels;
    out.balloonY = th.balloon.y;
    out.balloonSize = th.balloon.size;
    out.hasIce = th.hasIce;
    if (th.hasIce) { out.iceSheet = th.ice.sheet; out.iceFrost = th.ice.frost; }

    out.modelTints.clear();
    for (const std::vector<ttp::rt::MatTint>& model : th.modelTints) {
        std::vector<TrackBin::MatTint> pairs;
        for (const ttp::rt::MatTint& t : model) pairs.push_back({ t.name, t.rgb });
        out.modelTints.push_back(std::move(pairs));
    }
}

// The geometry half of TrackBin, taken straight off the built track.
//
// This used to arrive in track.bin, serialized by a SECOND implementation of the
// track builder that ran in JS on every race. There is one builder now, it runs
// here, and the object below is the same ttp::RaceTrack the sim is racing on —
// so the road the player drives and the road they see cannot disagree.
//
// Everything narrows double -> float: the renderer's whole vertex path is float,
// and the sim's doubles never come back the other way.
void TtpRenderer::fillGeometry(TrackBin& out, const ttp::RaceTrack& geo) {
    out.roadWidth = (float) geo.roadWidth;
    out.groundY = (float) geo.groundY;
    out.length = (float) geo.length;
    out.closed = geo.closed;

    out.samples.resize(geo.samples.size());
    for (size_t i = 0; i < geo.samples.size(); i++) {
        const ttp::OutSample& s = geo.samples[i];
        TrackBin::Sample& d = out.samples[i];
        d.pos = { (float) s.pos.x, (float) s.pos.y, (float) s.pos.z };
        d.lat = { (float) s.lateral.x, (float) s.lateral.y, (float) s.lateral.z };
        d.up = { (float) s.up.x, (float) s.up.y, (float) s.up.z };
        d.width = (float) s.width;
        d.s = (float) s.s;
    }

    out.boxes.clear();
    for (const ttp::Box& b : geo.boxes) out.boxes.push_back({ (float) b.s, (float) b.lat });

    out.pads.clear();
    out.zones.clear();
    for (const ttp::Pad& p : geo.pads) {
        if (p.strip) {
            out.pads.push_back({ 1u, (float) p.s, (float) p.lat,
                                 (float) p.halfLen, (float) p.halfWidth });
            // Bare-asphalt blanking around a launch strip: the road's dashes and
            // edge lines stop short of it, with a small margin so the paint does
            // not graze the chevrons.
            out.zones.push_back({ (float) p.s, (float) (p.halfLen + kStripMargin) });
        } else {
            out.pads.push_back({ 0u, (float) p.s, (float) p.lat, (float) p.radius, 0.0f });
        }
    }

    out.oils.clear();
    for (const ttp::Hazard& h : geo.hazards) {
        // Cone count is fixed: no shipped track authors one, and the codegen
        // (gen-track-defs-header.mjs) refuses a furniture entry that carries
        // `cones` rather than silently dropping it.
        out.oils.push_back({ (float) h.s, (float) h.lat, (float) h.radius, kOilCones });
    }

    // Ghost poles are collision proxies for supports that are already drawn
    // elsewhere (bridge pillars, loop shafts) — meshing them would double them up.
    out.poles.clear();
    for (const ttp::Pole& p : geo.poles) {
        if (p.ghost) continue;
        out.poles.push_back({ (float) p.s, (float) p.lat, (float) p.radius });
    }

    out.pillars.clear();
    for (const ttp::Pillar& p : geo.pillars) {
        out.pillars.push_back({ (float) p.x, (float) p.z, (float) p.baseY,
                                (float) p.topY, (float) p.radius });
    }

    out.supportPosts.clear();
    for (const ttp::SupportPost& p : geo.supportPosts) {
        out.supportPosts.push_back({ (float) p.x, (float) p.z, (float) p.radius,
                { (float) p.contactPos.x, (float) p.contactPos.y, (float) p.contactPos.z },
                { (float) p.contactUp.x, (float) p.contactUp.y, (float) p.contactUp.z } });
    }

    out.berms.clear();
    out.berms.reserve(geo.hills.size());
    for (const std::vector<ttp::HillRing>& run : geo.hills) {
        std::vector<TrackBin::BermRing> rings;
        rings.reserve(run.size());
        for (const ttp::HillRing& r : run) {
            rings.push_back({ (float) r.cx, (float) r.cz, (float) r.lx, (float) r.lz,
                              (float) r.halfW, (float) r.topL, (float) r.topR });
        }
        out.berms.push_back(std::move(rings));
    }

    // The scatter streams' seeds. These are a function of the GEOMETRY — the
    // built length, rounded to the centimetre and spelled as a decimal string,
    // hashed three ways — so they are derived here rather than sent. Reproducing
    // the JS exactly matters: a different seed reshuffles every tree, landmark
    // and clutter piece on every track.
    //
    // NOTE the string is length ALONE. The JS read `track.id || track.name`
    // first, but buildTrack's output object carried neither, so that prefix was
    // always empty and the shipped scatter has only ever depended on length.
    {
        const double rounded = std::floor(geo.length * 100.0 + 0.5); // JS Math.round
        char digits[32];
        std::snprintf(digits, sizeof digits, "%.0f", rounded);
        uint32_t s1 = 2166136261u, s2 = 5381u, s3 = 51966u; // scatter, clutter, landmarks
        for (const char* c = digits; *c; ++c) {
            const uint32_t ch = (uint32_t) (unsigned char) *c;
            s1 = (s1 ^ ch) * 16777619u;
            s2 = (s2 ^ ch) * 16777619u;
            s3 = (s3 ^ ch) * 16777619u;
        }
        out.scSeed1 = s1;
        out.scSeed2 = s2;
        out.lmSeed = s3;
    }
}

// Unit UV-sphere (widthSegments × heightSegments, THREE.SphereGeometry layout):
// used by the sky dome and hill domes. Appends transformed verts
// with a per-vertex colour callback into a Mesh.
void TtpRenderer::appendSphere(Mesh& mesh, int wseg, int hseg,
        const std::function<float3(const float3&)>& transform,
        const std::function<uint32_t(const float3&)>& colorAt, bool lit) {
    auto& verts = mesh.verts;
    auto& idx = mesh.idx;
    const uint32_t base = (uint32_t) verts.size();
    for (int iy = 0; iy <= hseg; iy++) {
        const float v = (float) iy / hseg;
        const float phi = v * (float) M_PI;
        for (int ix = 0; ix <= wseg; ix++) {
            const float u = (float) ix / wseg;
            const float theta = u * 2.0f * (float) M_PI;
            const float3 p = { -std::cos(theta) * std::sin(phi), std::cos(phi),
                               std::sin(theta) * std::sin(phi) };
            const float3 w = transform(p);
            verts.push_back({ w.x, w.y, w.z, colorAt(p) });
            if (lit) mesh.normals.push_back(p); // unit-sphere dir ≈ good enough
        }
    }
    const int stride = wseg + 1;
    for (int iy = 0; iy < hseg; iy++) {
        for (int ix = 0; ix < wseg; ix++) {
            const uint32_t a = base + iy * stride + ix;
            const uint32_t b = a + stride;
            idx.insert(idx.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
}

// Area-weighted per-vertex normal accumulation: soup faces come out flat,
// shared-ring surfaces smooth — the toy read either way.
void TtpRenderer::accumulateNormals(Mesh& m) {
    m.normals.assign(m.verts.size(), float3{ 0, 0, 0 });
    for (size_t i = 0; i + 2 < m.idx.size(); i += 3) {
        const Vertex& A = m.verts[m.idx[i]];
        const Vertex& B = m.verts[m.idx[i + 1]];
        const Vertex& C = m.verts[m.idx[i + 2]];
        const float3 a{ A.px, A.py, A.pz }, b{ B.px, B.py, B.pz }, c{ C.px, C.py, C.pz };
        const float3 n = cross(b - a, c - a); // area-weighted
        m.normals[m.idx[i]] += n;
        m.normals[m.idx[i + 1]] += n;
        m.normals[m.idx[i + 2]] += n;
    }
    for (float3& n : m.normals) {
        const float len = length(n);
        n = len > 1e-9f ? n / len : float3{ 0, 1, 0 };
    }
}

Texture* TtpRenderer::whiteTexture() {
    if (!mWhiteTex) {
        static const uint8_t WHITE[4] = { 255, 255, 255, 255 };
        mWhiteTex = Texture::Builder()
                .width(1).height(1).levels(1)
                .format(Texture::InternalFormat::SRGB8_A8)
                .sampler(Texture::Sampler::SAMPLER_2D)
                .build(*mEngine);
        if (mWhiteTex) {
            mWhiteTex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(
                    WHITE, sizeof(WHITE), Texture::Format::RGBA, Texture::Type::UBYTE));
        }
    }
    return mWhiteTex;
}

// Shadow opt-in. buildMesh and gltfio disagree on the default (mesh: neither,
// glTF: both), so every renderable that matters says so explicitly — see the
// caster/receiver note in buildTrackScene for who is in which set.
void TtpRenderer::setMeshShadows(Mesh& m, bool cast, bool receive) {
    if (m.entity.isNull()) return;
    setShadows(&m.entity, 1, cast, receive);
    if (!m.chunks.empty()) setShadows(m.chunks.data(), m.chunks.size(), cast, receive);
}

// Re-derive a mesh's bounds from its CPU vertices. Cheap (these pools are
// thousands of verts, not the road's hundred thousand) and the price of letting
// a mesh whose geometry moves every frame still be frustum-culled.
void TtpRenderer::refreshBounds(Mesh& m) {
    if (m.entity.isNull() || m.verts.empty()) return;
    auto& rcm = mEngine->getRenderableManager();
    const auto range = [&](utils::Entity e, size_t i0, size_t n) {
        const auto ri = rcm.getInstance(e);
        if (!ri) return;
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (size_t k = i0; k < i0 + n && k < m.idx.size(); k++) {
            const Vertex& v = m.verts[m.idx[k]];
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        if (hi.x < lo.x) return;
        rcm.setAxisAlignedBoundingBox(ri,
                { (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) });
    };
    if (m.chunks.empty()) {
        // One renderable = every vertex belongs to it, so walk `verts` directly.
        // Going through `idx` visits each vertex once per triangle that uses it
        // — 840 scattered loads for the car blob's 165 points — and buys nothing
        // when there is no index range to respect. (Measured 15.6 µs vs 2.7 µs
        // per blob in wasm, and every conformDecal ends in one of these.)
        const auto ri = rcm.getInstance(m.entity);
        if (!ri) return;
        float3 lo{ 1e30f }, hi{ -1e30f };
        for (const Vertex& v : m.verts) {
            lo = min(lo, float3{ v.px, v.py, v.pz });
            hi = max(hi, float3{ v.px, v.py, v.pz });
        }
        if (hi.x < lo.x) return;
        rcm.setAxisAlignedBoundingBox(ri,
                { (lo + hi) * 0.5f, max((hi - lo) * 0.5f, float3{ 1e-3f }) });
    } else {
        const size_t per = m.idx.size() / (m.chunks.size() + 1);
        range(m.entity, 0, per);
        for (size_t c = 0; c < m.chunks.size(); c++) range(m.chunks[c], (c + 1) * per, per);
    }
}

void TtpRenderer::setMeshCulling(Mesh& m, bool enable) {
    if (m.entity.isNull()) return;
    auto& rcm = mEngine->getRenderableManager();
    const auto set = [&](utils::Entity e) {
        const auto ri = rcm.getInstance(e);
        if (ri) rcm.setCulling(ri, enable);
    };
    set(m.entity);
    for (utils::Entity e : m.chunks) set(e);
}

// Scene membership as the on/off switch, instead of a transform that parks the
// thing 1000 units underground.
//
// Parking is invisible but not free: an entity in the Scene pays a full
// FScene::prepare slot — a double-precision world transform, a frustum test, a
// UBO slot, a draw command and its place in the sort — and it pays it ONCE PER
// CELL. A 4-way split HAD ~126 permanently-parked renderables (the four car
// ghosts, the monster rigs and their ghosts, the item boxes and their fade
// twins, the banana/rocket/blob pools, the impact bursts, the boost streaks and
// discs), so that was ~500 prepare slots a frame spent on things nobody can
// see. FScene::prepare only walks SET bits, so removing an entity costs it
// exactly nothing — every one of those pools now rides these helpers.
//
// Both helpers are edge-triggered — the flag is the last state pushed, so a
// pool that stays parked for a whole race issues one remove and nothing else.
void TtpRenderer::setMeshInScene(Mesh& m, bool on) {
    if (m.entity.isNull() || m.inScene == on) return;
    m.inScene = on;
    if (on) {
        mScene->addEntity(m.entity);
        for (utils::Entity e : m.chunks) mScene->addEntity(e);
    } else {
        mScene->remove(m.entity);
        for (utils::Entity e : m.chunks) mScene->remove(e);
    }
}

void TtpRenderer::setInstanceInScene(gltfio::FilamentInstance* inst, uint8_t& state, bool on) {
    if (!inst || state == (on ? 1 : 0)) return;
    state = on ? 1 : 0;
    if (on) mScene->addEntities(inst->getEntities(), inst->getEntityCount());
    else mScene->removeEntities(inst->getEntities(), inst->getEntityCount());
}

void TtpRenderer::setAssetInScene(gltfio::FilamentAsset* asset, uint8_t& state, bool on) {
    if (!asset || state == (on ? 1 : 0)) return;
    state = on ? 1 : 0;
    if (on) mScene->addEntities(asset->getEntities(), asset->getEntityCount());
    else mScene->removeEntities(asset->getEntities(), asset->getEntityCount());
}

void TtpRenderer::setShadows(const utils::Entity* e, size_t n, bool cast, bool receive) {
    auto& rcm = mEngine->getRenderableManager();
    for (size_t i = 0; i < n; i++) {
        const auto ri = rcm.getInstance(e[i]);
        if (!ri) continue;
        // Layer bit 1 IS the caster set: it is what bakeShadowMap's view filters
        // on. Bit 0 (every renderable's default) stays set, so the main views
        // are unaffected. The engine's own flags follow along for the day
        // Filament's shadows come back for something dynamic.
        rcm.setLayerMask(ri, 0x02, cast ? 0x02 : 0x00);
        rcm.setCastShadows(ri, cast);
        rcm.setReceiveShadows(ri, receive);
    }
}

// ---------------------------------------------------------------------------
// Merged draw groups — the design note is in TtpRenderer.h. This file holds
// the shared machinery; what to merge is decided beside what it merges
// (rebuildCarMerge in TtpRendererCars.cpp, buildDressingMerge in
// TtpRendererDressing.cpp).
// ---------------------------------------------------------------------------

uint64_t TtpRenderer::glbBytesKey(const std::vector<uint8_t>& glb) {
    // FNV-1a over the bytes: the same bytes are the same model, which is the
    // whole grouping rule. Never 0 — every caller reserves 0 for "none".
    uint64_t key = 14695981039346656037ull;
    for (const uint8_t b : glb) { key ^= b; key *= 1099511628211ull; }
    return key ? key : 1;
}

const std::vector<ttp::rt::GlbMeshNode>* TtpRenderer::glbMeshes(uint64_t key,
        const std::vector<uint8_t>& glb) {
    auto it = mGlbMeshCache.find(key);
    if (it == mGlbMeshCache.end()) {
        it = mGlbMeshCache.emplace(key,
                ttp::rt::read_glb_meshes(glb.data(), glb.size())).first;
        if (it->second.empty()) {
            // The fallback is silent on the glass (the originals keep drawing),
            // so say it here: a kit model this reader cannot decode is a model
            // whose copies stay one draw each.
            utils::slog.w << "glbMeshes: undecodable GLB (" << glb.size()
                    << " bytes) — its copies stay unmerged" << utils::io::endl;
        }
    }
    return it->second.empty() ? nullptr : &it->second;
}

bool TtpRenderer::buildMergedGroup(std::vector<MergedGroup>& out,
        const std::vector<utils::Entity>& sources,
        const std::vector<ttp::rt::GlbMeshPrim>& prims, bool dynamic,
        uint8_t feat) {
    if (sources.size() < 2 || prims.empty() || !mScene) return false;
    auto& rcm = mEngine->getRenderableManager();
    auto& tcm = mEngine->getTransformManager();
    const auto ri0 = rcm.getInstance(sources[0]);
    // The parsed geometry and the loaded renderable must agree about the
    // primitive count, every primitive needs normals for vglb's TANGENTS, and
    // every slot needs a material to share — any miss keeps the originals.
    if (!ri0 || rcm.getPrimitiveCount(ri0) != prims.size()) return false;
    for (const auto& p : prims) {
        if (p.pos.empty() || p.normal.size() != p.pos.size()
                || p.idx.empty() || p.idx.size() % 3) {
            return false;
        }
    }
    for (size_t p = 0; p < prims.size(); p++) {
        if (!rcm.getMaterialInstanceAt(ri0, p)) return false;
    }

    const size_t maxInst =
            std::min<size_t>(64, mEngine->getMaxAutomaticInstances());

    // GROUP BY LOCALITY, NOT BY ARRAY ORDER. A merged group is ONE renderable
    // carrying ONE bounding box that spans every instance in it, so a group
    // whose copies are scattered around the whole circuit can never be rejected
    // by a cell's frustum: every copy is submitted to every cell, and at four
    // cells that is paid four times. Ordering by position and cutting a chunk
    // when its span would exceed kMergeSpan keeps each box local, so the
    // culling that merging used to defeat works on merged groups again.
    //
    // The cut is on SPAN rather than a fixed world grid: a grid splits two
    // copies a unit apart across a boundary and merges nothing in a sparse
    // region, while the span guard adapts to whatever density the track has.
    // Dynamic groups (the cars, the cone pool) are grouped from their transforms
    // at BUILD time and drift afterwards; mirrorMergedGroup re-folds their box
    // every frame, so drift costs culling, never correctness.
    static constexpr float kMergeSpan = 16.0f;
    std::vector<std::vector<utils::Entity>> runs;
    {
        std::vector<size_t> order(sources.size());
        for (size_t i = 0; i < order.size(); i++) order[i] = i;
        std::vector<float3> at(sources.size(), float3{ 0 });
        for (size_t i = 0; i < sources.size(); i++) {
            const auto ti = tcm.getInstance(sources[i]);
            if (ti) at[i] = tcm.getWorldTransform(ti)[3].xyz;
        }
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
            const int az = (int) std::floor(at[a].z / kMergeSpan);
            const int bz = (int) std::floor(at[b].z / kMergeSpan);
            if (az != bz) return az < bz;
            return at[a].x < at[b].x;
        });
        // Cut into runs: maxInst instances, or the moment the run's own box
        // would outgrow kMergeSpan on any axis.
        std::vector<utils::Entity> run;
        float3 rmn{ 0 }, rmx{ 0 };
        for (const size_t i : order) {
            const float3 pWorld = at[i];
            const float3 nmn = run.empty() ? pWorld : min(rmn, pWorld);
            const float3 nmx = run.empty() ? pWorld : max(rmx, pWorld);
            const float3 span = nmx - nmn;
            if (!run.empty() && (run.size() >= maxInst
                    || std::max({ span.x, span.y, span.z }) > kMergeSpan)) {
                runs.push_back(std::move(run));
                run.clear();
                rmn = pWorld; rmx = pWorld;
            } else {
                rmn = nmn; rmx = nmx;
            }
            run.push_back(sources[i]);
        }
        if (!run.empty()) runs.push_back(std::move(run));
    }

    for (const std::vector<utils::Entity>& chunk : runs) {
        const size_t n = chunk.size();
        if (n < 2) continue;   // a straggler of one keeps its original draw
        MergedGroup g;
        g.dynamic = dynamic;
        g.feat = feat;
        g.sources = chunk;
        g.xf.assign(n, mat4f{});
        float r2 = 0;
        for (const auto& sp : prims) {
            MergedPrim mp;
            const size_t nv = sp.pos.size() / 3;
            mp.pos.resize(nv);
            for (size_t i = 0; i < nv; i++) {
                mp.pos[i] = { sp.pos[i * 3], sp.pos[i * 3 + 1], sp.pos[i * 3 + 2] };
                r2 = std::max(r2, dot(mp.pos[i], mp.pos[i]));
            }
            std::vector<float3> normals(nv);
            for (size_t i = 0; i < nv; i++) {
                normals[i] = { sp.normal[i * 3], sp.normal[i * 3 + 1],
                               sp.normal[i * 3 + 2] };
            }
            mp.quats.resize(nv);
            geometry::SurfaceOrientation* so = geometry::SurfaceOrientation::Builder()
                    .vertexCount(nv).normals(normals.data()).build();
            if (so) {
                so->getQuats(mp.quats.data(), nv);
                delete so;
            }
            // UV0 is required by vglb; an untextured model rides its
            // baseColorFactor over the provider's white 1x1, so zeros are
            // exactly what gltfio's own dummy buffer would sample.
            mp.uvs.assign(nv, math::float2{ 0, 0 });
            if (sp.uv.size() == nv * 2) {
                for (size_t i = 0; i < nv; i++) {
                    mp.uvs[i] = { sp.uv[i * 2], sp.uv[i * 2 + 1] };
                }
            }
            mp.idx = sp.idx;
            mp.vb = VertexBuffer::Builder()
                    .vertexCount((uint32_t) nv)
                    .bufferCount(3)
                    .attribute(VertexAttribute::POSITION, 0,
                            VertexBuffer::AttributeType::FLOAT3)
                    .attribute(VertexAttribute::TANGENTS, 1,
                            VertexBuffer::AttributeType::FLOAT4)
                    .attribute(VertexAttribute::UV0, 2,
                            VertexBuffer::AttributeType::FLOAT2)
                    .build(*mEngine);
            mp.ib = IndexBuffer::Builder()
                    .indexCount((uint32_t) mp.idx.size())
                    .bufferType(IndexBuffer::IndexType::UINT)
                    .build(*mEngine);
            g.prims.push_back(std::move(mp));
            // Descriptors AFTER the move: they point into the vectors' heap
            // storage, which the move carried over intact.
            MergedPrim& fp = g.prims.back();
            fp.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
                    fp.pos.data(), fp.pos.size() * sizeof(float3), nullptr));
            fp.vb->setBufferAt(*mEngine, 1, VertexBuffer::BufferDescriptor(
                    fp.quats.data(), fp.quats.size() * sizeof(math::quatf), nullptr));
            fp.vb->setBufferAt(*mEngine, 2, VertexBuffer::BufferDescriptor(
                    fp.uvs.data(), fp.uvs.size() * sizeof(math::float2), nullptr));
            fp.ib->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(
                    fp.idx.data(), fp.idx.size() * sizeof(uint32_t), nullptr));
        }
        g.radius = std::sqrt(r2);
        // Initial transforms and box off the sources' CURRENT world transforms
        // — final for the dressing, re-mirrored every frame for the cars.
        float3 mn, mx;
        mirrorMergedGroup(g, mn, mx);
        g.ibuf = InstanceBuffer::Builder(n)
                .localTransforms(g.xf.data())
                .build(*mEngine);
        g.ent = utils::EntityManager::get().create();
        // Identity transform on the renderable itself: the instance transforms
        // ARE world transforms, so the box below is world space too.
        tcm.create(g.ent);
        Box box;
        box.set(mn, mx);
        RenderableManager::Builder b(g.prims.size());
        b.boundingBox(box)
                .culling(true)
                // Neither the cars nor the per-copy dressing are shadow casters
                // (each carries its own baked ground blob; see setShadows at
                // their load sites).
                .castShadows(false)
                .receiveShadows(false)
                // Whatever layer the originals sit on — bit 0, or their
                // feature-group bit when a sweep already tagged the scene.
                .layerMask(0xFF, rcm.getLayerMask(ri0))
                .instances(n, g.ibuf);
        for (size_t p = 0; p < g.prims.size(); p++) {
            b.geometry(p, RenderableManager::PrimitiveType::TRIANGLES,
                    g.prims[p].vb, g.prims[p].ib);
            b.material(p, rcm.getMaterialInstanceAt(ri0, p));
        }
        b.build(*mEngine, g.ent);
        mScene->addEntity(g.ent);
        // The originals leave the scene; their entities (and every transform
        // behaviour riding them) stay.
        for (size_t i = 0; i < n; i++) mScene->remove(g.sources[i]);
        out.push_back(std::move(g));
    }
    return true;
}

// Mirror the sources' current world transforms into g.xf and fold the union
// world box of the instances (each bounded by g.radius under its own scale).
// A source mid-teardown keeps its last mirrored transform; the rebuild that
// follows a roster change replaces the group.
void TtpRenderer::mirrorMergedGroup(MergedGroup& g, float3& mn, float3& mx) {
    auto& tcm = mEngine->getTransformManager();
    mn = float3{ 1e30f, 1e30f, 1e30f };
    mx = -mn;
    for (size_t i = 0; i < g.sources.size(); i++) {
        const auto ti = tcm.getInstance(g.sources[i]);
        if (ti) g.xf[i] = tcm.getWorldTransform(ti);
        const float3 t = g.xf[i][3].xyz;
        const float s = std::sqrt(std::max({ dot(g.xf[i][0].xyz, g.xf[i][0].xyz),
                dot(g.xf[i][1].xyz, g.xf[i][1].xyz),
                dot(g.xf[i][2].xyz, g.xf[i][2].xyz) }));
        const float r = g.radius * s;
        mn = min(mn, t - float3{ r });
        mx = max(mx, t + float3{ r });
    }
}

void TtpRenderer::destroyMergedGroups(std::vector<MergedGroup>& groups) {
    if (!mEngine) {
        groups.clear();
        return;
    }
    auto& em = utils::EntityManager::get();
    for (MergedGroup& g : groups) {
        if (!g.ent.isNull()) {
            mScene->remove(g.ent);
            mEngine->destroy(g.ent);
            em.destroy(g.ent);
        }
        for (MergedPrim& p : g.prims) {
            if (p.vb) mEngine->destroy(p.vb);
            if (p.ib) mEngine->destroy(p.ib);
        }
        // After the renderable — the buffer must outlive it.
        if (g.ibuf) mEngine->destroy(g.ibuf);
        // The originals come back: a REBUILD decides afresh what to merge, and
        // whatever it leaves unmerged has to draw again.
        for (utils::Entity e : g.sources) {
            if (em.isAlive(e)) mScene->addEntity(e);
        }
    }
    groups.clear();
}

// Mirror the gltfio nodes' world transforms into the instance buffers, and
// keep each dynamic group's cull box honest. Runs once per frame after the
// car seating, and again per CELL while a monster is on (the ghost swap parks
// transforms per cell — renderCells).
void TtpRenderer::updateMergedTransforms() {
    if (mMergedCars.empty() && mMergedDress.empty()) return;
    auto& rcm = mEngine->getRenderableManager();
    for (auto* vec : { &mMergedCars, &mMergedDress }) {
        for (MergedGroup& g : *vec) {
            if (!g.dynamic || !g.ibuf) continue;
            float3 mn, mx;
            mirrorMergedGroup(g, mn, mx);
            g.ibuf->setLocalTransforms(g.xf.data(), g.xf.size(), 0);
            const auto ri = rcm.getInstance(g.ent);
            if (ri && mx.x >= mn.x) {
                Box box;
                box.set(mn, mx);
                rcm.setAxisAlignedBoundingBox(ri, box);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Feature ablation (debugFeatureMask — see the header for why it is layers).
// ---------------------------------------------------------------------------

// Move a renderable off the default layer bit onto its feature's. It has to be
// a MOVE: bit 0 is set on everything and every view draws it, so a renderable
// keeping bit 0 would still draw with its own group hidden. mGroundProxy is the
// one renderable that already clears bit 0 (it exists for the bake only) and is
// deliberately in no group, so nothing here can hand it to a main view.
void TtpRenderer::tagEntities(const utils::Entity* e, size_t n, uint8_t bit) {
    auto& rcm = mEngine->getRenderableManager();
    for (size_t i = 0; i < n; i++) {
        const auto ri = rcm.getInstance(e[i]);
        if (!ri) continue;
        rcm.setLayerMask(ri, (uint8_t) (0x01 | bit), bit);
    }
}

void TtpRenderer::tagMesh(const Mesh& m, uint8_t bit) {
    if (!m.entity.isNull()) tagEntities(&m.entity, 1, bit);
    if (!m.chunks.empty()) tagEntities(m.chunks.data(), m.chunks.size(), bit);
}

void TtpRenderer::tagFeatures() {
    auto meshes = [&](std::initializer_list<const Mesh*> ms, uint8_t bit) {
        for (const Mesh* m : ms) tagMesh(*m, bit);
    };
    auto meshVec = [&](const std::vector<Mesh>& v, uint8_t bit) {
        for (const Mesh& m : v) tagMesh(m, bit);
    };
    auto instVec = [&](const std::vector<gltfio::FilamentInstance*>& v, uint8_t bit) {
        for (gltfio::FilamentInstance* in : v) {
            if (in) tagEntities(in->getEntities(), in->getEntityCount(), bit);
        }
    };

    // The deck the race is driven on — decals, laid rubber and deck paint all
    // ride its fragment shader, so this bit carries them too.
    tagMesh(mRoad, kFeatRoad);

    // The world the deck stands in. mGroundProxy stays out (see tagEntities).
    meshes({ &mGround, &mSky, &mHills, &mWater, &mWet, &mStructures, &mBerms,
             &mGroundShadows, &mGantry }, kFeatTerrain);

    // Set dressing: everything scattered beside the track.
    meshes({ &mBoulders, &mLandmarks, &mWindmill, &mClutter }, kFeatDressing);
    meshVec(mSmoke, kFeatDressing);
    meshVec(mSignMeshes, kFeatDressing);
    instVec(mConeInstances, kFeatDressing);
    for (const auto& per : mSceneryInstances) instVec(per, kFeatDressing);
    for (const auto& per : mPropInstances) instVec(per, kFeatDressing);

    // The sky's moving furniture — all billboards, all re-aimed per cell.
    meshVec(mClouds, kFeatSky);
    meshVec(mHaze, kFeatSky);
    meshVec(mBirds, kFeatSky);
    meshVec(mKites, kFeatSky);
    meshes({ &mPlane, &mBalloon }, kFeatSky);

    // The field.
    meshVec(mCars, kFeatCars);
    meshVec(mStreakMeshes, kFeatCars);
    for (gltfio::FilamentAsset* a : mCarAssets) {
        if (a) tagEntities(a->getEntities(), a->getEntityCount(), kFeatCars);
    }
    for (gltfio::FilamentAsset* a : mCarGhostAssets) {
        if (a) tagEntities(a->getEntities(), a->getEntityCount(), kFeatCars);
    }
    instVec(mMonsterInstances, kFeatCars);
    instVec(mMonsterGhostInstances, kFeatCars);

    // The merged draw groups carry their family's bit — each replaced a set of
    // renderables that would have been tagged with exactly it.
    for (const MergedGroup& g : mMergedCars) {
        if (!g.ent.isNull()) tagEntities(&g.ent, 1, g.feat);
    }
    for (const MergedGroup& g : mMergedDress) {
        if (!g.ent.isNull()) tagEntities(&g.ent, 1, g.feat);
    }

    // Items and the transient pools.
    tagMesh(mPollen, kFeatEffects);
    meshVec(mRockets, kFeatEffects);
    meshVec(mRocketFlames, kFeatEffects);
    for (const Mesh& m : mBurstMeshes) tagMesh(m, kFeatEffects);
    for (const Mesh& m : mBurstBalls) tagMesh(m, kFeatEffects);
    instVec(mBoxInstances, kFeatEffects);
    instVec(mBoxFadeInstances, kFeatEffects);
    instVec(mBananaInstances, kFeatEffects);
}

// The road shader's channels, switched by the uniforms that already gate them.
// Called once per frame from uploadDeckDecals — after it, so the decal count it
// just wrote is the one being overridden.
void TtpRenderer::applyRoadDebug() {
    if (mRoadMask == kFeatRoadAll) return;
    const float texel = mShadowMap ? mShadowTexel : 0.0f;
    const auto set = [&](MaterialInstance* mi) {
        if (!mi) return;
        if (!(mRoadMask & kFeatRoadDecals)) {
            // Both shadow halves ride this arm, each behind its own
            // capability probe: the masked loop through maskCount, the
            // carShadow tap through maskInk.w. The tap's raster + upload
            // drop out on the same bit in renderCars.
            if (roadHasMaskLoop()) mi->setParameter("maskCount", 0);
            if (roadHasCarShadow()) {
                mi->setParameter("maskInk", math::float4{ kCarBlobInk.x,
                        kCarBlobInk.y, kCarBlobInk.z, 0.0f });
            }
            mi->setParameter("profCount", 0);
        }
        if (!(mRoadMask & kFeatRoadPaint)) mi->setParameter("paintCount", 0);
        if (!(mRoadMask & kFeatRoadRubber)) mi->setParameter("skidLatHalf", 0.0f);
        // The baked-light vroad has no live sun channel left to ablate — the
        // road's matte light became vertex data at track build (fillRoadLight),
        // so this arm's ROAD half is structurally zero now; the ground's tap
        // below still toggles. An OLD vroad blob keeps the knob.
        if (mi->getMaterial()->hasParameter("shadowTexel")) {
            mi->setParameter("shadowTexel",
                    (mRoadMask & kFeatRoadShadow) ? texel : 0.0f);
        }
    };
    for (RoadChunk& ch : mRoadChunks) set(ch.mi);
    set(mRoadInst);
    // The GROUND's tap rides the same arm — and under the baked-light vroad it
    // is the arm's only live half: the road's sun visibility became vertex
    // data at track build (fillRoadLight), so nothing per-frame is left to
    // toggle there. The ground's only knob IS the texture — white reads as
    // fully lit.
    if (mGroundInst && mGroundMaterial && mGroundMaterial->hasParameter("visMap")
            && !(mRoadMask & kFeatRoadShadow)) {
        Texture* w = whiteTexture();
        if (w) {
            TextureSampler smp(TextureSampler::MinFilter::LINEAR,
                    TextureSampler::MagFilter::LINEAR);
            mGroundInst->setParameter("visMap", w, smp);
        }
    }
}

void TtpRenderer::debugFeatureMask(uint32_t mask) {
    mFeatureMask = (uint8_t) (mask & kFeatAll);
    mRoadMask = mask & kFeatRoadAll;
    mFogOn = (mask & kFeatFog) != 0;
    // The merge ablation: flipping it marks both families dirty and the lazy
    // sites take the groups apart (restoring the originals) or regroup.
    const bool mergeOff = (mask & kFeatNoMerge) != 0;
    if (mergeOff != mMergeOff) {
        mMergeOff = mergeOff;
        mCarMergeDirty = true;
        mDressMergeDirty = true;
    }
    // Re-tag on every call rather than once: a scene built after the first call
    // (a Grand Prix's next track, a biome rebuild) arrives untagged, and an
    // ablation sweep that silently stopped ablating would read as "this feature
    // is free".
    if (!mScene) return;
    tagFeatures();
    mFeatureTagged = true;
    // uploadDeckDecals only writes a chunk whose folded list CHANGED, so a
    // channel switched back on would stay off for the rest of the run. Forget
    // what each chunk was last handed and let the next frame rewrite it.
    //
    // The whole-lap fallback instance goes through the same restore, because
    // applyRoadDebug already overrides it alongside the chunks: leaving it out
    // here would strand ITS channels off for good on the no-chunk path.
    const auto restore = [&](MaterialInstance* mi, int paintN,
            std::vector<DeckDecal>& lastMask, std::vector<DeckDecal>& lastProf) {
        lastMask.clear();
        lastProf.clear();
        if (!mi) return;
        mi->setParameter("skidLatHalf", mSkidTex ? mSkidLatHalf : 0.0f);
        mi->setParameter("invSkidLatSpan",
                (mSkidTex && mSkidLatHalf > 0.0f) ? 0.5f / mSkidLatHalf : 0.0f);
        if (mi->getMaterial()->hasParameter("shadowTexel")) {
            mi->setParameter("shadowTexel", mShadowMap ? mShadowTexel : 0.0f);
        }
        // The carShadow tap back on (the masked arrays restore themselves
        // through the cleared lastMask on the next uploadDeckDecals; the tap
        // has no per-frame writer, so its restore is here).
        if (roadHasCarShadow()) {
            mi->setParameter("maskInk", math::float4{ kCarBlobInk.x,
                    kCarBlobInk.y, kCarBlobInk.z,
                    mCarShadowTex[0] ? kCarShadowCap : 0.0f });
        }
        mi->setParameter("paintCount", paintN);   // written once per track
    };
    for (RoadChunk& ch : mRoadChunks) restore(ch.mi, ch.paintN, ch.lastMask, ch.lastProf);
    restore(mRoadInst, mRoadInstPaintN, mRoadInstLastMask, mRoadInstLastProf);
    // The ground's map is overridden by the same arm (applyRoadDebug), so a
    // mask switched back on has to restore it here too or it stays lit.
    if (mGroundInst) bindVisMap(mGroundInst);
}

// A MaterialInstance owned by the scene: recorded for releaseScene().
MaterialInstance* TtpRenderer::sceneInstance(Material* m) {
    MaterialInstance* mi = m->createInstance();
    mSceneMatInstances.push_back(mi);
    return mi;
}

// Tear the scene down to bare engine + materials + provided bytes. The game
// rebuilds through here on every race: a Grand Prix chains four tracks, and
// even a restart on the SAME track wants the skid ribbons, kicked cones and
// collected boxes back at their starting state. Everything below is scene
// scope; the engine, swap chain, views, cameras, the three materials, the
// glTF loaders and mAssets all survive.
int TtpRenderer::backendId() const {
    return mEngine ? (int) mEngine->getBackend() : 0;
}

void TtpRenderer::releaseScene() {
    if (!mEngine) return;
    const auto tRelease = std::chrono::steady_clock::now();
    // A released scene is unsettled by definition — the next build re-arms.
    if (mSettleFence) { mEngine->destroy(mSettleFence); mSettleFence = nullptr; }
    mSettled = false;
    // NO FENCE HERE, and the danger it used to answer has not gone away: the
    // meshes' CPU copies are handed to Filament as raw pointers, so the driver
    // must not still be reading a BufferDescriptor into one when it is freed.
    // This used to drain the whole pipeline to guarantee that — 24-205 ms on the
    // Android box against 6-8 ms of actual teardown, paid on every rebuild.
    // destroyMesh BURIES those buffers instead (see MeshGrave): same guarantee,
    // and this returns immediately.
    // Merged groups first, while their source entities are still alive to be
    // handed back to the scene (the asset drops below take them out again,
    // properly, on their own path). The parsed-geometry cache stays — it is
    // keyed by the kit's bytes, which do not change between scenes.
    destroyMergedGroups(mMergedCars);
    destroyMergedGroups(mMergedDress);
    mCarMergeDirty = false;
    mDressMergeDirty = false;
    // NOT mCarModelKey — the park below needs it to know what each body IS, and
    // it is cleared with the slots at the end of this function instead. Clearing
    // it here parked every body under key 0, which parkAsset reads as "unknown
    // model" and destroys: the pool would have been silently inert.
    mAssetMeshKey.clear();
    destroyMesh(mRoad);
    destroyMesh(mGround);
    destroyMesh(mGroundProxy);
    destroyMesh(mSky);
    destroyMesh(mHills);
    destroyMesh(mBalloon);
    for (auto& m : mCars) destroyMesh(m);
    destroyMesh(mGantry);
    for (auto& m : mStreakMeshes) destroyMesh(m);
    for (auto& m : mClouds) destroyMesh(m);
    destroyMesh(mBoulders);
    destroyMesh(mLandmarks);
    destroyMesh(mGroundShadows);
    destroyMesh(mClutter);
    destroyMesh(mStructures);
    destroyMesh(mBerms);
    for (auto& m : mHaze) destroyMesh(m);
    destroyMesh(mWindmill);
    for (auto& m : mSmoke) destroyMesh(m);
    for (auto& m : mSignMeshes) destroyMesh(m);
    destroyMesh(mWater);
    destroyMesh(mWet);
    destroyMesh(mPlane);
    for (auto& m : mBirds) destroyMesh(m);
    for (auto& m : mKites) destroyMesh(m);
    // The rubber texture and its CPU accumulation buffer are per-track
    // (sized by lap length); the 1x1 null tap texture is engine-lifetime.
    if (mSkidTex) { mEngine->destroy(mSkidTex); mSkidTex = nullptr; }
    std::vector<uint8_t>().swap(mSkidPix); // megabytes — actually release
    std::vector<std::vector<uint8_t>>().swap(mSkidMips); // likewise, ~a third more
    mSkidMipDirty.clear();
    mSkidDirty.clear();
    mSkidTexW = mSkidTexH = 0;
    mSkidLatHalf = 0;
    mSkidWipe = false;
    mSkidMipsDirty = false;
    mSkidMipsAt = 0; // mTime restarts at 0 per scene; a stale stamp here would
                     // hold the refresh gate shut for the whole next race
    mSkidUpAt = 0;   // ditto for the level-0 upload throttle
    // The car-shadow layer is per-track like the rubber (its width is the lap
    // length); the CPU superellipse (mCarShadowMask) is engine-lifetime — the
    // shape never changes.
    for (auto*& t : mCarShadowTex) {
        if (t) { mEngine->destroy(t); t = nullptr; }
    }
    std::vector<uint8_t>().swap(mCarShadowPix);
    mCarShadowDirty.clear();
    mCarShadowW = mCarShadowH = 0;
    mCarShadowPing = 0;
    mCarShadowUpload = false;
    for (auto& m : mBurstMeshes) destroyMesh(m);
    for (auto& m : mBurstBalls) destroyMesh(m);
    destroyMesh(mPollen);
    for (auto& m : mRockets) destroyMesh(m);
    for (auto& m : mRocketFlames) destroyMesh(m);
    // PARKED, NOT DESTROYED — see mBodyPool. The next build's field is usually
    // the same one, and parsing these back is the biggest phase it would pay.
    for (size_t i = 0; i < mCarAssets.size(); i++) {
        parkAsset(i < mCarModelKey.size() ? mCarModelKey[i] : 0, mCarAssets[i]);
    }
    // THE BAKED BITS SURVIVE THE SCENE. They used to die with the roster,
    // because a layer belonged to a grid SLOT and the next race could put a
    // different model in it. Layers belong to a MODEL now and are keyed by the
    // GLB's own bytes, so a bake is a fact about the kit rather than about
    // this race: claimMaskLayer re-checks the key and rebakes only what
    // genuinely changed. A cup's four races therefore pay the silhouette
    // bakes once — two render passes and a flushAndWait each — instead of
    // once per race, and no car spends the opening of race 2 on the generic
    // oval waiting for its rebake.
    for (size_t i = 0; i < mCarGhostAssets.size(); i++) {
        parkAsset(i < mCarGhostKey.size() ? mCarGhostKey[i] : 0, mCarGhostAssets[i]);
    }
    mCarModelKey.clear();   // both pools have what they need now
    mCarGhostKey.clear();
    for (auto*& a : mSceneryAssets) dropAsset(a);
    for (auto*& a : mPropAssets) dropAsset(a);
    for (auto*& a : mKitAssets) dropAsset(a);
    dropAsset(mBoxAsset);
    dropAsset(mBoxFadeAsset);
    dropAsset(mBananaAsset);
    dropAsset(mConeAsset);
    dropAsset(mMonsterAsset);
    dropAsset(mMonsterGhostAsset);
    if (mResourceLoader) mResourceLoader->evictResourceData(); // decoded glTF source cache
    for (auto* mi : mSceneMatInstances) mEngine->destroy(mi);
    mSceneMatInstances.clear();
    mLitShadowInst = nullptr; // was one of those — never dangle into the next build
    mRoadInst = nullptr;      // ditto: the deck's own instance is scene-scoped too
    mRoadChunks.clear();      // and so is every per-chunk instance
    mRoadInstLastMask.clear();
    mRoadInstLastProf.clear();
    mDeckDecals.clear();
    // THE SUN BAKE SURVIVES THE SCENE, on the same argument as the silhouette
    // layers above and for a bigger prize: its casters are the STATIC scene and
    // cars cast nothing, so a rebuild that changed only the field re-renders a
    // bit-identical map. Dropping them here is what made every join and every
    // launch pay the 81-tap blur again (520 ms of a 700 ms build on the Android
    // box). bakeShadowMap owns them now: it reuses them when its key says the
    // statics did not move, and destroys them itself when it says they did.
    for (utils::Entity e : { mSun, mFill }) {
        if (!e.isNull()) {
            mScene->remove(e);
            mEngine->destroy(e);
            utils::EntityManager::get().destroy(e);
        }
    }
    mSun = {};
    mFill = {};
    if (mAmbient) { mScene->setIndirectLight(nullptr); mEngine->destroy(mAmbient); mAmbient = nullptr; }
    if (mSkybox) { mScene->setSkybox(nullptr); mEngine->destroy(mSkybox); mSkybox = nullptr; }

    // Pools and per-scene state, back to their constructed values.
    mCars.clear();
    mCarAssets.clear();
    mCarGhostAssets.clear();
    mCarWheels.clear();
    mMonsterViews.clear();
    mMonsterInstances.clear();
    mMonsterGhostInstances.clear();
    mBoxInstances.clear();
    mBoxFadeInstances.clear();
    mBananaInstances.clear();
    mConeInstances.clear();
    mSceneryAssets.clear();
    mSceneryInstances.clear();
    mPropAssets.clear();
    mPropInstances.clear();
    mPropSpins.clear();
    mKitAssets.clear();
    mBoxXf.clear();
    mGroundInst = nullptr; // a scene instance; sceneInstance() owns the teardown
    mBoxCollectT.clear();
    mBoxPrevAvail.clear();
    mCarGhostIn.clear();
    mMonsterIn.clear();
    mMonsterGhostIn.clear();
    mBananaIn.clear();
    mBoxIn.clear();
    mBoxFadeIn.clear();
    mBoxGlowMats.clear(); // the box assets own them (dropAsset above) — handles only
    mConeStates.clear();
    mSignMeshes.clear();
    mStreaks.clear();
    mStreakMeshes.clear();
    mStreakSeed.clear();
    mCarBasis.clear();
    mCarBasisInv.clear();
    mRockets.clear();
    mRocketFlames.clear();
    mPrevRockets.clear();
    mPrevRocketCount = 0;
    for (Burst& b : mBursts) b = {};
    // The instances themselves are scene-scoped (sceneInstance), already
    // destroyed above — just drop the dangling handles.
    for (int bi = 0; bi < 2; bi++) { mBurstRingMats[bi] = nullptr; mBurstBallMats[bi] = nullptr; }
    mClouds.clear();
    mCloudPos.clear();
    mHaze.clear();
    mHazePos.clear();
    mBirds.clear();
    mKites.clear();
    mSmoke.clear();
    mShadowSpots.clear();
    mPollenMat = nullptr; // a scene-scope instance — sceneInstance() destroyed it
    if (mGroundTex) { mEngine->destroy(mGroundTex); mGroundTex = nullptr; }
    if (mAmbFloorTex) { mEngine->destroy(mAmbFloorTex); mAmbFloorTex = nullptr; }
    mWheelTrails.clear();
    mGroundBands.clear();
    mHillAnchors.clear();
    mShoreFn = nullptr;
    mTrack.reset();
    mHasTrack = false;
    mHillSf = 1;
    mTime = 0;
    mLastCar0 = {};
    mLastCarN = {};
    mMonsterFootW = mMonsterFootL = 0;
    mMonsterWheels.clear();
    mMonsterWheelRadius = 0;
    mMonsterSkidWidth = 0;
    mBoxScale = 1.0f;
    // `graves` is the standing guard on the burial: it climbs during a build,
    // which presents no frames, and must be back at 0 at rest. A number that
    // stays up is CPU copies of whole scenes never being freed.
    utils::slog.i << "ttp release: graves " << (int) mGraves.size() << " teardown "
            << (int) (std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - tRelease).count() + 0.5)
            << " ms" << utils::io::endl;
}

TtpRenderer::~TtpRenderer() {
    if (!mEngine) return;
    releaseScene();
    // The engine is going away, so no frame will ever age these out. This is
    // the one teardown that still has to pay the fence — and the only one where
    // nobody can see it.
    drainGravesBlocking();
    // The parked bodies go with the loader that made them, and only here: a
    // scene release parks, it does not destroy.
    drainBodyPool();
    // A road-light readback that never landed is LEAKED on purpose, exactly as
    // the old inline version leaked its own: the driver may still hold a pointer
    // into that buffer, and there is no tick left to complete it. The difference
    // is the count — this is at most a couple of buffers once, at teardown,
    // where it used to be one per build that outran its readback, forever.
    for (auto& g : mRoadLightGraves) (void) g.release();
    if (mRoadLightRead && !mRoadLightRead->done) (void) mRoadLightRead.release();
    if (mBlendMaterial) mEngine->destroy(mBlendMaterial);
    if (mPointMaterial) mEngine->destroy(mPointMaterial);
    if (mCloudMaterial) mEngine->destroy(mCloudMaterial);
    if (mBurstMaterial) mEngine->destroy(mBurstMaterial);
    if (mGroundMaterial) mEngine->destroy(mGroundMaterial);
    if (mEsmMaterial) mEngine->destroy(mEsmMaterial);
    if (mBlurMaterial) mEngine->destroy(mBlurMaterial);
    if (mSkidNullTex) mEngine->destroy(mSkidNullTex);
    if (mWhiteTex) mEngine->destroy(mWhiteTex);
    if (mDecalMaskArray) mEngine->destroy(mDecalMaskArray);
    if (mShadowMap) mEngine->destroy(mShadowMap);
    if (mVisMap) mEngine->destroy(mVisMap);
    if (mGlbMaterial) mEngine->destroy(mGlbMaterial);
    if (mGlbFadeMaterial) mEngine->destroy(mGlbFadeMaterial);
    delete mResourceLoader;
    delete mStbProvider;
    if (mAssetLoader) gltfio::AssetLoader::destroy(&mAssetLoader);
    delete mNames; // outlives the loader: it holds the name components
    mNames = nullptr;
    if (mMatProvider) { mMatProvider->destroyMaterials(); delete mMatProvider; }
    destroySceneTarget();
    destroyMultiviewTargets();
    if (mMvPresentView) mEngine->destroy(mMvPresentView);
    if (mMvPresentScene) mEngine->destroy(mMvPresentScene);
    if (mMvPresentQuad) {
        mEngine->destroy(mMvPresentQuad);
        utils::EntityManager::get().destroy(mMvPresentQuad);
    }
    if (mPresentMvInstance) mEngine->destroy(mPresentMvInstance);
    if (mPresentMvMaterial) mEngine->destroy(mPresentMvMaterial);
    for (int p = 0; p < 2; p++) {
        if (mMvCameras[p]) {
            mEngine->destroyCameraComponent(mMvCameraEntities[p]);
            utils::EntityManager::get().destroy(mMvCameraEntities[p]);
            mMvCameras[p] = nullptr;
        }
        if (mMvViews[p]) { mEngine->destroy(mMvViews[p]); mMvViews[p] = nullptr; }
    }
    if (mPresentView) mEngine->destroy(mPresentView);
    if (mPresentScene) mEngine->destroy(mPresentScene);
    if (mPresentCamera) {
        mEngine->destroyCameraComponent(mPresentCameraEntity);
        utils::EntityManager::get().destroy(mPresentCameraEntity);
    }
    if (mPresentQuad) {
        mEngine->destroy(mPresentQuad);
        utils::EntityManager::get().destroy(mPresentQuad);
    }
    if (mPresentVB) mEngine->destroy(mPresentVB);
    if (mPresentIB) mEngine->destroy(mPresentIB);
    if (mPresentInstance) mEngine->destroy(mPresentInstance);
    if (mPresentMaterial) mEngine->destroy(mPresentMaterial);
    for (OverlayQuad& q : mOverlayQuads) {
        mEngine->destroy(q.entity);
        utils::EntityManager::get().destroy(q.entity);
        if (q.mi) mEngine->destroy(q.mi);
    }
    mOverlayQuads.clear();
    if (mOverlayView) mEngine->destroy(mOverlayView);
    if (mOverlayScene) mEngine->destroy(mOverlayScene);
    if (mOverlayCamera) {
        mEngine->destroyCameraComponent(mOverlayCameraEntity);
        utils::EntityManager::get().destroy(mOverlayCameraEntity);
    }
    if (mOverlayVB) mEngine->destroy(mOverlayVB);
    if (mOverlayIB) mEngine->destroy(mOverlayIB);
    if (mOverlayMaterial) mEngine->destroy(mOverlayMaterial);
    if (mMaterial) mEngine->destroy(mMaterial);
    if (mLitMaterial) mEngine->destroy(mLitMaterial);
    if (mLitPlainMaterial) mEngine->destroy(mLitPlainMaterial);
    if (mVisMaterial) mEngine->destroy(mVisMaterial);
    if (mRoadMaterial) mEngine->destroy(mRoadMaterial);
    for (size_t i = 0; i < mCellViews.size(); i++) {
        mEngine->destroy(mCellViews[i]);
        mEngine->destroyCameraComponent(mCellCameraEntities[i]);
        utils::EntityManager::get().destroy(mCellCameraEntities[i]);
    }
    mEngine->destroy(mView);
    mEngine->destroy(mScene);
    mEngine->destroy(mRenderer);
    mEngine->destroy(mSwapChain);
    mEngine->destroyCameraComponent(mCameraEntity);
    utils::EntityManager::get().destroy(mCameraEntity);
    Engine::destroy(&mEngine);
}

