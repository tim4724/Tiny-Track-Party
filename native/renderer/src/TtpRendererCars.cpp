// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"


// Repaint the monster truck's CHASSIS (only) to one flat neutral, per instance.
//
// Every mesh in vehicle-monster-truck.glb shares a single `colormap` material,
// so there is no material-level handle on "the frame" — setting the base factor
// on the asset's instances repaints the tyres with it. The JS answer is to clone
// the material for the chassis mesh and null its map; the Filament equivalent is
// a per-PRIMITIVE instance on the chassis renderable, with the palette atlas
// swapped for a white 1×1 so the flat colour is the whole result.
void TtpRenderer::recolourMonsterChassis(gltfio::FilamentAsset* asset,
        const std::vector<gltfio::FilamentInstance*>& instances, const math::float4& rgba) {
    if (!asset) return;
    Texture* const white = whiteTexture();
    auto& rcm = mEngine->getRenderableManager();
    const TextureSampler smp(TextureSampler::MinFilter::NEAREST, TextureSampler::MagFilter::NEAREST);
    for (gltfio::FilamentInstance* inst : instances) {
        if (!inst) continue;
        const utils::Entity* ents = inst->getEntities();
        for (size_t k = 0; k < inst->getEntityCount(); k++) {
            const char* nm = asset->getName(ents[k]);
            if (!nm || std::strcmp(nm, "chassis") != 0) continue;
            const auto ri = rcm.getInstance(ents[k]);
            if (!ri) continue;
            for (size_t p = 0, n = rcm.getPrimitiveCount(ri); p < n; p++) {
                MaterialInstance* src = rcm.getMaterialInstanceAt(ri, p);
                if (!src) continue;
                MaterialInstance* own = MaterialInstance::duplicate(src, "monster-chassis");
                if (!own) continue;
                if (own->getMaterial()->hasParameter("baseColorFactor")) {
                    own->setParameter("baseColorFactor", rgba);
                }
                if (white && own->getMaterial()->hasParameter("baseColorMap")) {
                    own->setParameter("baseColorMap", white, smp);
                }
                mSceneMatInstances.push_back(own); // released with the scene
                rcm.setMaterialInstanceAt(ri, p, own);
            }
        }
    }
}

// gltfio's material provider, answered with the kit's OWN matte material — see
// vglb.mat for what that buys, and for why the parameter names below are a
// contract rather than a choice.
//
// It is an adapter, not a replacement: anything vglb cannot express goes to a
// real ubershader provider held beside it, so an asset that grows a normal map
// or a blend mode keeps rendering (just the old way). The kit's only regular
// visitors to that path are the GHOST twins, which glb.cc rewrites to alphaMode
// BLEND.
//
// It OWNS NEITHER MATERIAL. vglb is compiled by buildScene alongside every other
// .filamat and destroyed with the renderer; the ubershader cache belongs to the
// provider we delegate to. destroyMaterials/getMaterials therefore just forward,
// and freeing this object frees nothing twice.
namespace {

class TtpGlbMaterials : public gltfio::MaterialProvider {
public:
    TtpGlbMaterials(Material* material, Material* fade, Texture* white,
            gltfio::MaterialProvider* fallback)
            : mMaterial(material), mFade(fade), mWhite(white), mFallback(fallback) {}
    ~TtpGlbMaterials() override { delete mFallback; }

    // Everything vglb.mat can be, in one place. A config outside this is not an
    // error and not a warning — it is an asset that wants the full glTF surface
    // model, and gltfio already has a provider for that.
    // OUR MATERIAL FOR THIS CONFIG, or null to hand it to the ubershader. Both
    // entry points below go through here rather than re-stating the two halves
    // of the test, which would then have to be kept identical by inspection.
    Material* resolve(const gltfio::MaterialKey& c, const gltfio::UvMap& uvmap) const {
        Material* const m = pick(c);
        return (m && expressible(c, uvmap)) ? m : nullptr;
    }

    // OPAQUE takes vglb, BLEND takes vglbfade, and MASK is the one alpha mode
    // nothing in the kit uses — it would need an alpha-test material and a
    // maskThreshold, so it goes to the ubershader like any other feature we do
    // not have a material for.
    Material* pick(const gltfio::MaterialKey& c) const {
        if (c.alphaMode == gltfio::AlphaMode::OPAQUE) return mMaterial;
        if (c.alphaMode == gltfio::AlphaMode::BLEND) return mFade;
        return nullptr;
    }

    static bool expressible(const gltfio::MaterialKey& c, const gltfio::UvMap& uvmap) {
        return !c.unlit && !c.useSpecularGlossiness
                && !c.hasNormalTexture && !c.hasOcclusionTexture && !c.hasEmissiveTexture
                && !c.hasMetallicRoughnessTexture
                && !c.hasClearCoat && !c.hasSheen && !c.hasTransmission && !c.hasVolume
                && !c.hasSpecular && !c.hasIOR && !c.enableDiagnostics
                // vglb reads getUV0(), so a base colour parked on Filament's
                // second uv set would sample the wrong channel silently.
                && (!c.hasBaseColorTexture || uvmap[c.baseColorUV] == gltfio::UvSet::UV0);
    }

    Material* getMaterial(gltfio::MaterialKey* config, gltfio::UvMap* uvmap,
            const char* label) override {
        gltfio::constrainMaterial(config, uvmap);
        if (Material* m = resolve(*config, *uvmap)) return m;
        return mFallback->getMaterial(config, uvmap, label);
    }

    MaterialInstance* createMaterialInstance(gltfio::MaterialKey* config, gltfio::UvMap* uvmap,
            const char* label, const char* extras) override {
        gltfio::constrainMaterial(config, uvmap);
        Material* const mat = resolve(*config, *uvmap);
        if (!mat) {
            return mFallback->createMaterialInstance(config, uvmap, label, extras);
        }
        // The label is the glTF MATERIAL name, and it has to survive: the
        // scenery recolour matches theme tints against MaterialInstance::getName().
        MaterialInstance* mi = mat->createInstance(label);
        if (!mi) return nullptr;
        mi->setDoubleSided(config->doubleSided);
        mi->setCullingMode(config->doubleSided ? MaterialInstance::CullingMode::NONE
                                               : MaterialInstance::CullingMode::BACK);
        // The one sampler, resolved before the first draw — Filament draws with
        // every sampler bound, and gltfio only overwrites this when the glTF
        // material carries a texture at all.
        const TextureSampler smp(TextureSampler::MinFilter::LINEAR,
                TextureSampler::MagFilter::LINEAR);
        if (mWhite) mi->setParameter("baseColorMap", mWhite, smp);
        // gltfio only writes this when the source declared a uv transform, and
        // the shader multiplies by it unconditionally — so it has to start as
        // something, and zero would collapse every uv to the atlas origin.
        mi->setParameter("baseColorUvMatrix", math::mat3f());
        return mi;
    }

    // vglb needs uv0 whether or not the primitive carries one; nothing here
    // reads vertex colour, so a mesh that has none is not given a dummy.
    bool needsDummyData(VertexAttribute attrib) const noexcept override {
        return attrib == VertexAttribute::UV0 || mFallback->needsDummyData(attrib);
    }

    // Both of these are the cache's, and the cache is the fallback's — vglb is a
    // renderer-scope material like vlit or vroad, not something a client may
    // take ownership of here.
    size_t getMaterialsCount() const noexcept override { return mFallback->getMaterialsCount(); }
    const Material* const* getMaterials() const noexcept override {
        return mFallback->getMaterials();
    }
    void destroyMaterials() override { mFallback->destroyMaterials(); }

private:
    Material* const mMaterial;   // opaque; null falls the whole kit back
    Material* const mFade;       // alphaMode BLEND — the ghost twins
    Texture* const mWhite;
    gltfio::MaterialProvider* const mFallback;
};

}  // namespace

void TtpRenderer::ensureAssetLoader() {
    if (mAssetLoader) return;
    gltfio::MaterialProvider* uber = gltfio::createUbershaderProvider(mEngine,
            UBERARCHIVE_DEFAULT_DATA, UBERARCHIVE_DEFAULT_SIZE);
    // vglb.filamat absent (an older asset set) leaves the ubershader in place on
    // its own, which is what every shell did before this material existed.
    mMatProvider = mGlbMaterial
            ? (gltfio::MaterialProvider*) new TtpGlbMaterials(
                    mGlbMaterial, mGlbFadeMaterial, whiteTexture(), uber)
            : uber;
    gltfio::AssetConfiguration ac{};
    ac.engine = mEngine;
    ac.materials = mMatProvider;
    // Node names, which gltfio only records when handed a manager. Without
    // one getName() is nullptr everywhere and every name-driven rule below
    // (chassis recolour, monster wheels, the "skip the wheels" graft-seat
    // measurement) no-ops without a word.
    mNames = new utils::NameComponentManager(utils::EntityManager::get());
    ac.names = mNames;
    mAssetLoader = gltfio::AssetLoader::create(ac);
    gltfio::ResourceConfiguration rc{};
    rc.engine = mEngine;
    rc.gltfPath = nullptr;
    rc.normalizeSkinningWeights = true;
    mResourceLoader = new gltfio::ResourceLoader(rc);
    mStbProvider = gltfio::createStbProvider(mEngine);
    mResourceLoader->addTextureProvider("image/png", mStbProvider);
    mResourceLoader->addTextureProvider("image/jpeg", mStbProvider);
}

// The kit GLBs reference their texture by EXTERNAL uri (Textures/colormap.png)
// — the shell provides those bytes under that exact name; register them so
// loadResources finds them (no filesystem here). mAssets outlives the loader,
// so the descriptors carry no release callback.
void TtpRenderer::registerAssetUris(filament::gltfio::FilamentAsset* asset) {
    const char* const* uris = asset->getResourceUris();
    for (size_t u = 0; u < asset->getResourceUriCount(); u++) {
        const auto res = mAssets.find(uris[u]);
        if (res != mAssets.end()) {
            mResourceLoader->addResourceData(uris[u],
                    gltfio::ResourceLoader::BufferDescriptor(
                            res->second.data(), res->second.size(), nullptr));
        }
    }
}

bool TtpRenderer::loadCarAsset(uint32_t index, const std::vector<uint8_t>& glb) {
    ensureAssetLoader();
    gltfio::FilamentAsset* asset =
            mAssetLoader->createAsset(glb.data(), (uint32_t) glb.size());
    if (!asset) return false;
    registerAssetUris(asset);
    if (!mResourceLoader->loadResources(asset)) {
        mAssetLoader->destroyAsset(asset);
        return false;
    }
    asset->releaseSourceData();
    mScene->addEntities(asset->getEntities(), asset->getEntityCount());
    // Cars neither cast nor catch the sun shadow (they carry a ground blob) —
    // gltfio opts renderables in by default, the JS opts them out.
    setShadows(asset->getEntities(), asset->getEntityCount(), false, false);
    mCarAssets[index] = asset;

    // Wheel handles for the per-frame steer/roll cosmetics. Original local
    // translations are kept so the animation rotates each wheel IN PLACE.
    if (mCarWheels.size() <= index) mCarWheels.resize(index + 1);
    CarWheels& w = mCarWheels[index];
    auto& tcm = mEngine->getTransformManager();
    const auto grab = [&](const char* name, utils::Entity& e, float3& t) {
        e = asset->getFirstEntityByName(name);
        if (!e.isNull()) {
            const mat4f local = tcm.getTransform(tcm.getInstance(e));
            t = local[3].xyz;
        }
    };
    grab("wheel-fl", w.fl, w.flT);
    grab("wheel-fr", w.fr, w.frT);
    grab("wheel-bl", w.bl, w.blT);
    grab("wheel-br", w.br, w.brT);
    grab("axle", w.axle, w.axleT);
    // Roll/pitch axis sign, measured exactly as addCar does: the node's local
    // +X in the POSED frame (the kit models face −Z, so the pose's half-turn
    // flips it). Positive rotation about the POSED +X rolls the wheel forward
    // and noses the body down — apply the raw angle about the model-local axis
    // and both run BACKWARDS (the wheels visibly span the wrong way).
    if (!w.bl.isNull()) {
        const mat4f local = tcm.getTransform(tcm.getInstance(w.bl));
        const float3 axis = (mat4f::rotation(M_PI, float3{ 0, 1, 0 }) * local)[0].xyz;
        w.rollSign = axis.x >= 0 ? 1.0f : -1.0f;
    }
    w.pitchSign = w.rollSign; // same posed frame (the body carries no extra yaw)
    // Wheelbase = front-axle mid → rear-axle mid, the span the ground-conform
    // probes straddle (addCar measures the same distance off the posed model).
    if (!w.fl.isNull() && !w.fr.isNull() && !w.bl.isNull() && !w.br.isNull()) {
        // WORLD transforms: the wheel nodes' local translations sit inside the
        // asset's own scaled hierarchy, so the local delta isn't in world units.
        const auto wp = [&](utils::Entity e) {
            return tcm.getWorldTransform(tcm.getInstance(e))[3].xyz;
        };
        const float3 fm = (wp(w.fl) + wp(w.fr)) * 0.5f, bm = (wp(w.bl) + wp(w.br)) * 0.5f;
        const float wb = length(fm - bm);
        if (wb > 0.2f) w.wheelbase = wb;
    }
    // MonsterRig graft seat: bbox of the body with the WHEELS (and axle) taken
    // off, centred on the kit's cab slot in x/z and bottom-aligned to the slot
    // floor plus MOUNT_LIFT (−0.07, which drops the cab onto the suspension
    // rods). The slot is a fixed property of vehicle-monster-truck.glb — the
    // cab shares its vertex buffer with the chassis (the split is index-only),
    // so its runtime AABB spans the whole body and can't be measured here.
    {
        constexpr float SLOT_MIN_Y = 0.4375f, SLOT_CX = 0.0f, SLOT_CZ = -0.03125f;
        constexpr float MOUNT_LIFT = -0.07f;
        auto& rcm = mEngine->getRenderableManager();
        float3 lo{ 1e9f }, hi{ -1e9f };
        for (size_t k = 0; k < asset->getEntityCount(); k++) {
            const utils::Entity e = asset->getEntities()[k];
            const char* nm = asset->getName(e);
            if (nm && (std::strncmp(nm, "wheel", 5) == 0 || std::strcmp(nm, "axle") == 0)) continue;
            const auto ri = rcm.getInstance(e);
            if (!ri) continue;
            const filament::Box bx = rcm.getAxisAlignedBoundingBox(ri);
            const mat4f wm = tcm.getWorldTransform(tcm.getInstance(e));
            for (int sx = -1; sx <= 1; sx += 2)
                for (int sy = -1; sy <= 1; sy += 2)
                    for (int sz = -1; sz <= 1; sz += 2) {
                        const float3 corner = bx.center
                                + bx.halfExtent * float3{ (float) sx, (float) sy, (float) sz };
                        const float3 wp = (wm * float4{ corner, 1 }).xyz;
                        lo = min(lo, wp);
                        hi = max(hi, wp);
                    }
        }
        if (hi.y > lo.y) {
            w.monsterMount = { SLOT_CX - (lo.x + hi.x) * 0.5f,
                               (SLOT_MIN_Y - lo.y) + MOUNT_LIFT,
                               SLOT_CZ - (lo.z + hi.z) * 0.5f };
        }
    }
    // Footprint (blob shadow + boost-disk sizing) from the asset AABB — the JS
    // measures the posed proto's Box3 the same way.
    const filament::Aabb bb = asset->getBoundingBox();
    if (bb.max.x > bb.min.x) {
        w.footW = bb.max.x - bb.min.x;
        w.footL = bb.max.z - bb.min.z;
        w.bbMin = bb.min;
        w.bbMax = bb.max;
        // Ground-shadow silhouette, off THIS model, while it still sits at
        // rest — into decalMask layer `index` for the road-shader shadow decal.
        bakeSilhouette(asset, bb.min, bb.max,
                index < (uint32_t) kMaskLayerMonster ? (int) index : -1);
    }
    // Tyre-contact width for the skid ribbons: min(0.24, max(0.06,
    // min(wheelBox.x, wheelBox.z))) — SceneRenderer addCar's measurement.
    if (!w.bl.isNull()) {
        auto& rcm = mEngine->getRenderableManager();
        const auto ri = rcm.getInstance(w.bl);
        if (ri) {
            const filament::Box box = rcm.getAxisAlignedBoundingBox(ri);
            const float wx = box.halfExtent.x * 2, wz = box.halfExtent.z * 2;
            if (wx > 0 && wz > 0) {
                w.skidWidth = std::min(0.24f, std::max(0.06f, std::min(wx, wz)));
            }
        }
    }
    return true;
}

// glTF assets own their instances — drop the entities from the scene first
// so nothing dangles between destroyAsset() and the next build. Was a lambda
// local to releaseScene() until destroyCarSlot() needed it too.
void TtpRenderer::dropAsset(gltfio::FilamentAsset*& a) {
    if (!a) return;
    mScene->removeEntities(a->getEntities(), a->getEntityCount());
    mAssetLoader->destroyAsset(a);
    a = nullptr;
}

// Texture decodes ride the provider's async queue even on the synchronous
// loadResources path — finished textures only ATTACH on a queue pump (the
// sync path pumps at the START of the next load, so without this the last
// assets' textures never bind and those cars render black).
void TtpRenderer::pumpTextures() {
    if (mStbProvider) {
        mStbProvider->waitForCompletion();
        mResourceLoader->asyncUpdateLoad();
    }
}

// One car slot's body: the real GLB when the shell provided "car<c>.glb"
// (gltfio + ubershaders, textures via stb), else a roster-coloured box
// marker. Split out of buildTrackScene so reroster() can rebuild one slot.
bool TtpRenderer::buildCarSlot(const TrackBin& tb, uint32_t c) {
    const auto glb = mAssets.find("car" + std::to_string(c) + ".glb");
    if (glb != mAssets.end() && loadCarAsset(c, glb->second)) return true;
    Mesh& m = mCars[c];
    destroyMesh(m); // a re-dress replaces the live marker; empty on a fresh build
    const uint32_t col = (tb.carColors.size() > c) ? tb.carColors[c] : 0xff888888u;
    const float HL = 0.62f, HW = 0.36f, Y0 = 0.06f, Y1 = 0.62f;
    for (const float y : { Y0, Y1 }) {
        m.verts.push_back({ -HW, y, -HL, col });
        m.verts.push_back({  HW, y, -HL, col });
        m.verts.push_back({ -HW, y,  HL, col });
        m.verts.push_back({  HW, y,  HL, col });
    }
    m.idx = { 0,1,2, 1,3,2,  4,6,5, 5,6,7,   // bottom, top
              0,2,4, 2,6,4,  1,5,3, 3,5,7,   // sides
              2,3,6, 3,7,6,  0,4,1, 1,4,5 }; // front, back
    return buildMesh(m);
}

// The inverse of buildCarSlot + buildCarGhost + buildCarPlate,
// for one slot of a LIVE scene (reroster). Sizes are left alone — the field's
// shape is the scene's, and a re-roster never changes it.
void TtpRenderer::destroyCarSlot(uint32_t c) {
    if (mCarAssets.size() > c) dropAsset(mCarAssets[c]);
    if (mCarGhostAssets.size() > c) dropAsset(mCarGhostAssets[c]);
    if (mCarGhostIn.size() > c) mCarGhostIn[c] = 0;
    // The decalMask layer holds the OLD car until the re-dress rebakes it;
    // clearing the bit sends the shadow decal to the generic layer meanwhile.
    if (c < (uint32_t) kMaskLayerMonster) {
        mMaskLayerBakedBits &= (uint16_t) ~(1u << c);
    }
    if (mCars.size() > c) destroyMesh(mCars[c]);
    if (mPlates.size() > c) destroyMesh(mPlates[c]);
    if (mCarWheels.size() > c) mCarWheels[c] = CarWheels{};
    if (mMonsterViews.size() > c) mMonsterViews[c] = MonsterView{};
}

bool TtpRenderer::reroster(const std::vector<TtpRosterCar>& roster,
        const std::vector<uint32_t>& remodel,
        const std::vector<uint32_t>& redress) {
    if (!mTrack || roster.size() != mTrack->carColors.size()) return false;
    applyRoster(*mTrack, roster); // colours/names/plate heights, in place
    for (uint32_t c : remodel) {
        if (c >= roster.size()) return false;
        destroyCarSlot(c);
        if (!buildCarSlot(*mTrack, c)) return false;
        pumpTextures(); // bind the body's decodes before the ghost queues its own
        buildCarGhost(c);
        if (!buildCarPlate(*mTrack, c)) return false;
    }
    for (uint32_t c : redress) {
        if (c >= roster.size()) return false;
        // Same model, new livery/name: only what WEARS them. The GLB body
        // keeps its own paint — a livery is the plate's (and, for a slot
        // with no GLB, the box marker's) to show.
        if (!buildCarPlate(*mTrack, c)) return false;
        if ((mCarAssets.size() <= c || !mCarAssets[c]) && !buildCarSlot(*mTrack, c)) return false;
    }
    pumpTextures();
    return true;
}

// One car's rear name plate, rebuilt whole — buildTrackScene dresses every
// slot with it, reroster() re-dresses one. Reads the roster fields off `tb`
// (the build's local bin, or the retained mTrack on a re-roster) and the
// wheel measurements loadCarAsset grabbed; GLB-less slots carry no plate.
bool TtpRenderer::buildCarPlate(const TrackBin& tb, uint32_t c) {
    if (!mBlendMaterial || mPlates.size() <= c) return true;
    destroyMesh(mPlates[c]); // a re-dress replaces the live plate; empty on a fresh build
    if (mCarAssets.size() <= c || !mCarAssets[c] || mCarWheels.size() <= c) return true;
    // 5 wide × 9 rows (bit 4 = leftmost column): rows 0–6 are the cap band
    // (uppercase fills it), lowercase sits on rows 2–6 with ascenders up to
    // row 0 and descenders on rows 7–8.
    static const uint8_t PL[26][9] = {
        { 0,0, 0x0E,0x01,0x0F,0x11,0x0F, 0,0 },              // a
        { 0x10,0x10, 0x1E,0x11,0x11,0x11,0x1E, 0,0 },        // b
        { 0,0, 0x0E,0x11,0x10,0x11,0x0E, 0,0 },              // c
        { 0x01,0x01, 0x0F,0x11,0x11,0x11,0x0F, 0,0 },        // d
        { 0,0, 0x0E,0x11,0x1F,0x10,0x0E, 0,0 },              // e
        { 0x06,0x09, 0x08,0x1C,0x08,0x08,0x08, 0,0 },        // f
        { 0,0, 0x0F,0x11,0x11,0x0F,0x01, 0x01,0x0E },        // g
        { 0x10,0x10, 0x1E,0x11,0x11,0x11,0x11, 0,0 },        // h
        { 0x04,0x00, 0x0C,0x04,0x04,0x04,0x0E, 0,0 },        // i
        { 0x02,0x00, 0x06,0x02,0x02,0x02,0x02, 0x12,0x0C },  // j
        { 0x10,0x10, 0x12,0x14,0x18,0x14,0x12, 0,0 },        // k
        { 0x0C,0x04, 0x04,0x04,0x04,0x04,0x0E, 0,0 },        // l
        { 0,0, 0x1A,0x15,0x15,0x15,0x15, 0,0 },              // m
        { 0,0, 0x1E,0x11,0x11,0x11,0x11, 0,0 },              // n
        { 0,0, 0x0E,0x11,0x11,0x11,0x0E, 0,0 },              // o
        { 0,0, 0x1E,0x11,0x11,0x1E,0x10, 0x10,0x10 },        // p
        { 0,0, 0x0F,0x11,0x11,0x0F,0x01, 0x01,0x01 },        // q
        { 0,0, 0x16,0x19,0x10,0x10,0x10, 0,0 },              // r
        { 0,0, 0x0F,0x10,0x0E,0x01,0x1E, 0,0 },              // s
        { 0x08,0x08, 0x1C,0x08,0x08,0x09,0x06, 0,0 },        // t
        { 0,0, 0x11,0x11,0x11,0x13,0x0D, 0,0 },              // u
        { 0,0, 0x11,0x11,0x11,0x0A,0x04, 0,0 },              // v
        { 0,0, 0x11,0x11,0x15,0x15,0x0A, 0,0 },              // w
        { 0,0, 0x11,0x0A,0x04,0x0A,0x11, 0,0 },              // x
        { 0,0, 0x11,0x11,0x11,0x0F,0x01, 0x01,0x0E },        // y
        { 0,0, 0x1F,0x02,0x04,0x08,0x1F, 0,0 },              // z
    };
    static const uint8_t PF[26][7] = {
        { 0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11 },  // A
        { 0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E },  // B
        { 0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E },  // C
        { 0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E },  // D
        { 0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F },  // E
        { 0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10 },  // F
        { 0x0E, 0x11, 0x10, 0x13, 0x11, 0x11, 0x0F },  // G
        { 0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11 },  // H
        { 0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E },  // I
        { 0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C },  // J
        { 0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11 },  // K
        { 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F },  // L
        { 0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11 },  // M
        { 0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11 },  // N
        { 0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E },  // O
        { 0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10 },  // P
        { 0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D },  // Q
        { 0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11 },  // R
        { 0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E },  // S
        { 0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04 },  // T
        { 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E },  // U
        { 0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04 },  // V
        { 0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A },  // W
        { 0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11 },  // X
        { 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04 },  // Y
        { 0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F },  // Z
    };
    Mesh& m = mPlates[c];
    const CarWheels& cw = mCarWheels[c];
    const std::string name = (tb.carNames.size() > c) ? tb.carNames[c] : "";
    // ABGR roster colour → sRGB rgb
    const uint32_t abgr = (tb.carColors.size() > c) ? tb.carColors[c] : 0xff888888u;
    const uint32_t rgb = ((abgr & 0xff) << 16) | (abgr & 0xff00) | ((abgr >> 16) & 0xff);
    const float3 livery = srgbToLinear(rgb);
    const float3 white = { 1, 1, 1 };
    // visible plate: capped to the car's rear, JS 232:92 aspect
    const float W = std::min(0.2f, cw.footW * 0.92f);
    const float H = W * (92.0f / 232.0f);
    // Hand-tuned rear-panel height for this model when the payload
    // carries one (SceneRenderer's PLATE_Y), else the old fraction.
    const float authored = (tb.carPlateY.size() > c) ? tb.carPlateY[c] : -1.0f;
    const float cy = authored >= 0 ? authored
            : cw.bbMin.y + 0.46f * (cw.bbMax.y - cw.bbMin.y);
    const float cz = cw.bbMax.z + 0.008f;
    // rounded-rect layer (plate local: x MIRRORED so the face reads
    // correctly from BEHIND the car — the chase cam looks along −z)
    const auto roundRect = [&](float hw, float hh, float r, float z,
            const float3& col) {
        const uint32_t cc = packLinear(col, 1.0f);
        std::vector<float2> ring;
        const float qx[4] = { hw - r, -(hw - r), -(hw - r), hw - r };
        const float qy[4] = { hh - r, hh - r, -(hh - r), -(hh - r) };
        const float a0[4] = { 0, (float) M_PI / 2, (float) M_PI, 3 * (float) M_PI / 2 };
        for (int k = 0; k < 4; k++) {
            for (int j = 0; j <= 3; j++) {
                const float a = a0[k] + (float) j / 3 * (float) M_PI / 2;
                ring.push_back({ qx[k] + std::cos(a) * r, qy[k] + std::sin(a) * r });
            }
        }
        const uint32_t base = (uint32_t) m.verts.size();
        m.verts.push_back({ 0, cy, cz + z, cc });
        for (const float2& q : ring) {
            m.verts.push_back({ -q.x, cy + q.y, cz + z, cc });
        }
        const uint32_t NR = (uint32_t) ring.size();
        for (uint32_t j = 0; j < NR; j++) {
            m.idx.insert(m.idx.end(),
                    { base, base + 1 + j, base + 1 + (j + 1) % NR });
        }
    };
    const float pad = W * (6.0f / 232.0f), rr = W * (16.0f / 232.0f);
    roundRect(W / 2, H / 2, rr, 0, white);
    roundRect(W / 2 - pad, H / 2 - pad, rr * 0.75f, 0.0015f, livery);
    // name — white pixel glyphs, auto-fit to the field width. The cap
    // band is 42% of the plate height, matching the JS's 54px Fredoka
    // on its 92px plate (the old 50% ran visibly large).
    if (!name.empty()) {
        const uint32_t nc = packLinear(white, 1.0f);
        const float maxW = W - 2 * pad - W * (24.0f / 232.0f);
        float px = (0.42f * H) / 7.0f;
        const float tw = (float) (name.size() * 6 - 1);
        if (tw * px > maxW) px = maxW / tw;
        // The pose's half-turn maps asset-local +x to the viewer's
        // RIGHT, so the first glyph starts at −x — laying it out from
        // +x downward printed the name mirrored.
        const float x0 = -tw * px / 2;
        const float y0 = cy - 3.5f * px;
        for (size_t ci2 = 0; ci2 < name.size(); ci2++) {
            const char ch = name[ci2];
            const uint8_t* g = nullptr;
            uint8_t rows = 7;
            if (ch >= 'A' && ch <= 'Z') g = PF[ch - 'A'];
            else if (ch >= 'a' && ch <= 'z') { g = PL[ch - 'a']; rows = 9; }
            if (!g) continue;
            for (int row = 0; row < rows; row++) {
                for (int cx = 0; cx < 5; cx++) {
                    if (!((g[row] >> (4 - cx)) & 1)) continue;
                    const float gx = x0 + ((float) (ci2 * 6 + cx)) * px;
                    const float gy = y0 + (float) (6 - row) * px;
                    const uint32_t b = (uint32_t) m.verts.size();
                    m.verts.push_back({ gx, gy, cz + 0.003f, nc });
                    m.verts.push_back({ gx + px, gy, cz + 0.003f, nc });
                    m.verts.push_back({ gx, gy + px, cz + 0.003f, nc });
                    m.verts.push_back({ gx + px, gy + px, cz + 0.003f, nc });
                    m.idx.insert(m.idx.end(),
                            { b, b + 1, b + 2, b + 1, b + 3, b + 2 });
                }
            }
        }
    }
    if (!buildMesh(m)) return false;
    auto& tcmP = mEngine->getTransformManager();
    tcmP.setTransform(tcmP.getInstance(m.entity),
            mat4f::translation(float3{ 0, -1000, 0 }));
    return true;
}

// One car's ghost body (the 50%-alpha occlusion twin), loaded with its own
// decode pump — see the ordering note where buildTrackScene calls it. Also
// reroster()'s, after the slot's solid body reloads. Best-effort: a missing
// or unparseable ghost just means no monster occlusion fade for that car.
void TtpRenderer::buildCarGhost(uint32_t c) {
    if (mCarAssets.size() <= c || !mCarAssets[c]) return;
    if (mCarGhostIn.size() > c) mCarGhostIn[c] = 1; // in scene below; frame 1 re-parks it
    const auto ghost = mAssets.find("car" + std::to_string(c) + "-ghost.glb");
    if (ghost == mAssets.end()) return;
    gltfio::FilamentAsset* ga = mAssetLoader->createAsset(
            ghost->second.data(), (uint32_t) ghost->second.size());
    if (!ga) return;
    registerAssetUris(ga);
    if (!mResourceLoader->loadResources(ga)) {
        mAssetLoader->destroyAsset(ga);
        return;
    }
    ga->releaseSourceData();
    mScene->addEntities(ga->getEntities(), ga->getEntityCount());
    setShadows(ga->getEntities(), ga->getEntityCount(), false, false);
    auto& tcmG = mEngine->getTransformManager();
    tcmG.setTransform(tcmG.getInstance(ga->getRoot()),
            mat4f::translation(float3{ 0, -1000, 0 }));
    // The ghost body is only ever shown as the GRAFTED monster body, and
    // MonsterRig strips the car's wheels before seating it — collapse them
    // once here (this instance's wheels are never animated).
    for (const char* wn : { "wheel-fl", "wheel-fr", "wheel-bl", "wheel-br", "axle" }) {
        const utils::Entity we = ga->getFirstEntityByName(wn);
        if (we.isNull()) continue;
        const auto wi = tcmG.getInstance(we);
        mat4f local = mat4f::scaling(float3{ 1e-4f });
        local[3] = tcmG.getTransform(wi)[3];
        tcmG.setTransform(wi, local);
    }
    mCarGhostAssets[c] = ga;
    if (mStbProvider) {
        mStbProvider->waitForCompletion();
        mResourceLoader->asyncUpdateLoad();
    }
}
