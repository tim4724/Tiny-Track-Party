// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"

TtpRenderer::TtpRenderer() = default;

bool TtpRenderer::init(backend::Backend backend, void* nativeWindow,
        uint32_t width, uint32_t height) {
    mEngine = Engine::create(backend);
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

void TtpRenderer::resize(uint32_t width, uint32_t height) {
    mWidth = width;
    mHeight = height;
    mView->setViewport({ 0, 0, width, height });
    updateCamera();
    // Called between frames, which is the only safe place to swap the scene
    // buffer: render() must never find a size mismatch, so rebuild it here.
    destroySceneTarget();
    ensureSceneTarget();
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
    const bool lit = !m.normals.empty() && mLitMaterial != nullptr;
    const bool uv = !m.uvs.empty();
    const uint8_t uvSlot = lit ? 2 : 1;
    VertexBuffer::Builder vbb;
    vbb.vertexCount((uint32_t) m.verts.size())
            .bufferCount((uint8_t) (1 + (lit ? 1 : 0) + (uv ? 1 : 0)))
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
    m.vb = vbb.build(*mEngine);
    m.vb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(
            m.verts.data(), m.verts.size() * sizeof(Vertex), nullptr));
    if (uv) {
        m.uvs.resize(m.verts.size(), math::float2{ 0, 0 });
        m.vb->setBufferAt(*mEngine, uvSlot, VertexBuffer::BufferDescriptor(
                m.uvs.data(), m.uvs.size() * sizeof(math::float2), nullptr));
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
            : lit ? mLitMaterial->getDefaultInstance()
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
    m.verts = {};
    m.idx = {};
    m.normals = {};
    m.quats = {};
    m.uvs = {};
    m.local = {};
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
        out.prScatter.push_back({ p.slot, p.w, p.s0, p.s1 });
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
void TtpRenderer::releaseScene() {
    if (!mEngine) return;
    // Retire every in-flight command first: the meshes' CPU copies go with
    // them below, and the driver must not still be reading a BufferDescriptor
    // that points into one.
    mEngine->flushAndWait();
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
    destroyMesh(mTrain);
    destroyMesh(mTrainKey);
    for (auto& m : mSmoke) destroyMesh(m);
    for (auto& m : mSignMeshes) destroyMesh(m);
    destroyMesh(mWater);
    destroyMesh(mWet);
    destroyMesh(mPlane);
    for (auto& m : mBirds) destroyMesh(m);
    for (auto& m : mKites) destroyMesh(m);
    // The rubber texture is per-track; the pass machinery around it is
    // engine-lifetime and just loses its target here.
    if (mSkidStampView) mSkidStampView->setRenderTarget(nullptr);
    if (mSkidRT) { mEngine->destroy(mSkidRT); mSkidRT = nullptr; }
    if (mSkidTex) { mEngine->destroy(mSkidTex); mSkidTex = nullptr; }
    mSkidLatHalf = 0;
    mSkidWipe = false;
    mSkidQuadCount = 0;
    mSkidMipsDirty = false;
    mSkidMipsAt = 0; // mTime restarts at 0 per scene; a stale stamp here would
                     // hold the refresh gate shut for the whole next race
    for (auto& m : mBurstMeshes) destroyMesh(m);
    for (auto& m : mBurstBalls) destroyMesh(m);
    destroyMesh(mPollen);
    for (auto& m : mRockets) destroyMesh(m);
    for (auto& m : mRocketFlames) destroyMesh(m);
    for (auto*& a : mCarAssets) dropAsset(a);
    // The decalMask layers die with the roster that produced them: they keep
    // their stale images but lose their baked bits, so the next scene's shadow
    // decals ride the generic layer until they rebake.
    mMaskLayerBakedBits &= (uint16_t) (1u << kMaskLayerGeneric);
    for (auto*& a : mCarGhostAssets) dropAsset(a);
    for (auto*& a : mSceneryAssets) dropAsset(a);
    for (auto*& a : mPropAssets) dropAsset(a);
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
    mRoadInstLast.clear();
    mDeckDecals.clear();
    if (mShadowMap) { mEngine->destroy(mShadowMap); mShadowMap = nullptr; }
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
    mHasTrain = false;
    mHillSf = 1;
    mTime = 0;
    mLastCar0 = {};
    mMonsterFootW = mMonsterFootL = 0;
    mMonsterWheels.clear();
    mMonsterWheelRadius = 0;
    mMonsterSkidWidth = 0;
    mBoxScale = 1.0f;
}

TtpRenderer::~TtpRenderer() {
    if (!mEngine) return;
    releaseScene();
    if (mBlendMaterial) mEngine->destroy(mBlendMaterial);
    if (mPointMaterial) mEngine->destroy(mPointMaterial);
    if (mCloudMaterial) mEngine->destroy(mCloudMaterial);
    if (mBurstMaterial) mEngine->destroy(mBurstMaterial);
    if (mGroundMaterial) mEngine->destroy(mGroundMaterial);
    if (mEsmMaterial) mEngine->destroy(mEsmMaterial);
    if (mBlurMaterial) mEngine->destroy(mBlurMaterial);
    if (mSkidStampView) mEngine->destroy(mSkidStampView);
    if (mSkidStampScene) mEngine->destroy(mSkidStampScene);
    if (!mSkidStampEnt.isNull()) {
        mEngine->destroy(mSkidStampEnt);
        utils::EntityManager::get().destroy(mSkidStampEnt);
    }
    if (mSkidStampMI) mEngine->destroy(mSkidStampMI);
    if (mSkidVB) mEngine->destroy(mSkidVB);
    if (mSkidIB) mEngine->destroy(mSkidIB);
    if (mSkidCam) {
        mEngine->destroyCameraComponent(mSkidCamEnt);
        utils::EntityManager::get().destroy(mSkidCamEnt);
    }
    if (mSkidNullTex) mEngine->destroy(mSkidNullTex);
    if (mSkidMaterial) mEngine->destroy(mSkidMaterial);
    if (mWhiteTex) mEngine->destroy(mWhiteTex);
    if (mDecalMaskArray) mEngine->destroy(mDecalMaskArray);
    if (mShadowMap) mEngine->destroy(mShadowMap);
    if (mGlbMaterial) mEngine->destroy(mGlbMaterial);
    if (mGlbFadeMaterial) mEngine->destroy(mGlbFadeMaterial);
    delete mResourceLoader;
    delete mStbProvider;
    if (mAssetLoader) gltfio::AssetLoader::destroy(&mAssetLoader);
    delete mNames; // outlives the loader: it holds the name components
    mNames = nullptr;
    if (mMatProvider) { mMatProvider->destroyMaterials(); delete mMatProvider; }
    destroySceneTarget();
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

