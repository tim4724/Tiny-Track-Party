// The car field: slot bodies and the body pool, ghosts, mask layers and the
// merged draws. TtpRendererImpl.h carries what the topic files share.
#include "TtpRendererImpl.h"

#include <utils/Log.h>


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
    // No `gltfPath`: it only resolves RELATIVE uris against a base file and
    // there is no filesystem here (the shell hands every byte over by name, see
    // addResourceData below), so the `rc{}` zero is already the right answer.
    // The field is UTILS_DEPRECATED upstream and scheduled for removal — setting
    // it to nullptr bought nothing and cost a warning on every renderer build.
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
    // ALREADY PARSED? The body a previous scene left parked is this model's, is
    // already uploaded, and needs no re-dressing (mBodyPool says why). Putting
    // its entities back in the scene is the whole of the reuse — everything
    // below this point runs identically for a fresh parse and a parked one,
    // because all of it reads the asset rather than the bytes.
    const uint64_t modelKey = glbBytesKey(glb);
    gltfio::FilamentAsset* asset = takeAsset(modelKey);
    if (!asset) {
        asset = mAssetLoader->createAsset(glb.data(), (uint32_t) glb.size());
        if (!asset) return false;
        registerAssetUris(asset);
        if (!mResourceLoader->loadResources(asset)) {
            mAssetLoader->destroyAsset(asset);
            return false;
        }
        asset->releaseSourceData();
        snapshotRestPose(asset);
    }
    mScene->addEntities(asset->getEntities(), asset->getEntityCount());
    // Cars neither cast nor catch the sun shadow (they carry a ground blob) —
    // gltfio opts renderables in by default, the JS opts them out.
    setShadows(asset->getEntities(), asset->getEntityCount(), false, false);
    mCarAssets[index] = asset;
    // The merged draw groups: remember which MODEL this slot wears (the bytes
    // are the identity — same rule as the silhouette layers), decode its
    // meshes once per model, and let the next frame regroup the field.
    if (mCarModelKey.size() <= index) mCarModelKey.resize(index + 1, 0);
    mCarModelKey[index] = modelKey;
    glbMeshes(modelKey, glb);   // per-model mesh decode; already memoised by key
    mCarMergeDirty = true;

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
    // Each wheel's own seat in the POSED body frame — the four points the
    // ground conform probes the deck under, and where the suspension travel is
    // applied. The conform used to straddle a wheel TRACK taken off the asset
    // AABB, which is the body's full width and so stands wider than the wheels
    // do; these are the wheels themselves.
    if (!w.fl.isNull() && !w.fr.isNull() && !w.bl.isNull() && !w.br.isNull()) {
        // WORLD transforms: the wheel nodes' local translations sit inside the
        // asset's own scaled hierarchy, so the local delta isn't in world units.
        // The asset root is identity at load, so world here IS asset-root space.
        const auto wp = [&](utils::Entity e) {
            return tcm.getWorldTransform(tcm.getInstance(e))[3].xyz;
        };
        const float3 fm = (wp(w.fl) + wp(w.fr)) * 0.5f, bm = (wp(w.bl) + wp(w.br)) * 0.5f;
        const float wb = length(fm - bm);   // wheelbase, world units
        if (wb > 0.2f) {
            // Into the POSED frame: the kit models face −Z and the pose applies
            // a half-turn about Y (FLIP), so x and z negate, y is untouched.
            const utils::Entity order[4] = { w.fl, w.fr, w.bl, w.br };
            for (int k = 0; k < 4; k++) {
                const float3 p = wp(order[k]);
                w.wheelOff[k] = { -p.x, p.y, -p.z };
            }
            // World units per node-local unit, so a travel computed in world
            // units can be written back into a local translation. Measured on
            // the wheelbase, the span least likely to be degenerate.
            const float localWb = length((w.flT + w.frT) * 0.5f - (w.blT + w.brT) * 0.5f);
            if (localWb > 1e-4f) w.assetScale = wb / localWb;
            w.hasWheelOff = true;
        }
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
        // Ground-shadow silhouette, off THIS model, while it still sits at
        // rest — into the decalMask layer this GLB owns. claimMaskLayer hands
        // back a layer already holding these bytes (nothing to do: eight cars
        // share four models) or a freshly claimed one with its baked bit
        // cleared, which is the signal to bake.
        const int ml = claimMaskLayer(index, glb);
        if (ml >= 0 && ml < kMaskLayerMonster
                && !((mMaskLayerBakedBits >> ml) & 1u)) {
            bakeSilhouette(asset, bb.min, bb.max, ml);
        }
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
            // Rolling radius — the tyre's reach AHEAD of its own contact patch,
            // which is how far renderSkids may run the ribbon without the ink
            // leaving the wheel's ground silhouette. Off the z half-extent (the
            // rolling direction; x is the tread width), the monster rig's
            // mMonsterWheelRadius measured the same quantity first.
            if (box.halfExtent.z > 0) {
                w.wheelRadius = std::max(0.04f, box.halfExtent.z);
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
    mBodyRest.erase(a);
    mAssetLoader->destroyAsset(a);
    a = nullptr;
}

// The parse pose, kept and put back — mBodyRest says why a reuse needs it.
//
// EVERY node, not the handful the frame loop currently writes: the question a
// reuse has to answer is what a fresh createAsset would have guaranteed, and
// that is the whole hierarchy. Costs one mat4 per node, once per parse.
void TtpRenderer::snapshotRestPose(gltfio::FilamentAsset* a) {
    if (!a) return;
    auto& tcm = mEngine->getTransformManager();
    RestPose rest;
    rest.nodes.reserve(a->getEntityCount());
    for (size_t i = 0; i < a->getEntityCount(); i++) {
        const auto ti = tcm.getInstance(a->getEntities()[i]);
        rest.nodes.push_back(ti ? tcm.getTransform(ti) : mat4f{});
    }
    const auto ri = tcm.getInstance(a->getRoot());
    rest.root = ri ? tcm.getTransform(ri) : mat4f{};
    mBodyRest[a] = std::move(rest);
}

void TtpRenderer::restoreRestPose(gltfio::FilamentAsset* a) {
    const auto it = a ? mBodyRest.find(a) : mBodyRest.end();
    // A miss is not a state to have an answer for: everything that reaches here
    // came out of the pool, both parse paths snapshot, and both destroys erase.
    if (it == mBodyRest.end()) return;
    auto& tcm = mEngine->getTransformManager();
    const RestPose& rest = it->second;
    for (size_t i = 0; i < a->getEntityCount() && i < rest.nodes.size(); i++) {
        const auto ti = tcm.getInstance(a->getEntities()[i]);
        if (ti) tcm.setTransform(ti, rest.nodes[i]);
    }
    const auto ri = tcm.getInstance(a->getRoot());
    if (ri) tcm.setTransform(ri, rest.root);
}

// Park a parsed body instead of destroying it — see mBodyPool.
//
// This is dropAsset minus the destroy: OUT OF THE SCENE, which is what makes a
// parked body invisible and inert, but still owned by the loader that made it
// and still holding its uploaded buffers — and minus the rest-pose erase, on
// purpose: the snapshot is what takeAsset hands the body back with. A key of 0 means "we never learned
// what model this was", which is not something to file under any model.
void TtpRenderer::parkAsset(uint64_t key, gltfio::FilamentAsset*& a) {
    if (!a) return;
    if (!key || mBodyPoolCount >= kBodyPoolMax) { dropAsset(a); return; }
    mScene->removeEntities(a->getEntities(), a->getEntityCount());
    mBodyPool[key].push_back(a);
    mBodyPoolCount++;
    a = nullptr;
}

gltfio::FilamentAsset* TtpRenderer::takeAsset(uint64_t key) {
    if (!key) return nullptr;
    const auto it = mBodyPool.find(key);
    if (it == mBodyPool.end() || it->second.empty()) return nullptr;
    gltfio::FilamentAsset* a = it->second.back();
    it->second.pop_back();
    mBodyPoolCount--;
    if (it->second.empty()) mBodyPool.erase(it);
    // Parked is not parsed: the body still wears the last frame's pose, and
    // every caller's next move assumes it does not (mBodyRest). One funnel, so
    // that is answered here rather than at each reuse site.
    restoreRestPose(a);
    return a;
}

void TtpRenderer::drainBodyPool() {
    for (auto& [key, list] : mBodyPool) {
        for (gltfio::FilamentAsset* a : list) dropAsset(a);
    }
    mBodyPool.clear();
    mBodyPoolCount = 0;
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
// Which silhouette layer slot `c` draws from, keyed by the BYTES of its GLB.
//
// A HASH, not a byte compare against the other slots' blobs, because the claim
// has to outlive the slot the bytes first arrived on: a re-roster drops one
// slot's asset and builds another, and a layer whose model is still being
// driven elsewhere must not be rebaked or recycled underneath it.
//
// Leaves the baked bit CLEAR on a fresh claim — that is how the caller knows
// to bake, and it is also the honest state if the bake then fails.
int TtpRenderer::claimMaskLayer(uint32_t c, const std::vector<uint8_t>& glb) {
    if (glb.empty()) return kMaskLayerGeneric;
    const uint64_t key = glbBytesKey(glb);  // never 0 — 0 marks "never claimed"
    if (mMaskLayerOfSlot.size() <= c) {
        mMaskLayerOfSlot.resize(c + 1, kMaskLayerGeneric);
    }
    // Already baked, same model: share it. This is the common case — the grid
    // is eight cars over four models — and it is also what makes a re-dress
    // into a model someone else drives cost nothing at all.
    for (int L = 0; L < kMaskLayerModels; L++) {
        if (mMaskLayerKey[L] == key && ((mMaskLayerBakedBits >> L) & 1u)) {
            mMaskLayerOfSlot[c] = L;
            return L;
        }
    }
    // Otherwise take a layer no OTHER live slot is reading. Unbaked layers
    // qualify by construction; a stale one (its model left the roster on a
    // re-dress) is recycled rather than leaked.
    bool used[kMaskLayerModels] = {};
    for (size_t k = 0; k < mMaskLayerOfSlot.size(); k++) {
        if (k == c || k >= mCarAssets.size() || !mCarAssets[k]) continue;
        const int L = mMaskLayerOfSlot[k];
        if (L >= 0 && L < kMaskLayerModels) used[L] = true;
    }
    for (int L = 0; L < kMaskLayerModels; L++) {
        if (used[L]) continue;
        mMaskLayerKey[L] = key;
        mMaskLayerBakedBits &= (uint16_t) ~(1u << L);
        mMaskLayerOfSlot[c] = L;
        return L;
    }
    // More distinct models live than there are layers. Can only happen if the
    // roster outgrew kMaskLayerModels without the gate being raised, so say so
    // once rather than let a generic oval pass for a silhouette.
    utils::slog.w << "claimMaskLayer: no free layer for slot " << c
            << " — falling back to the generic oval" << utils::io::endl;
    mMaskLayerOfSlot[c] = kMaskLayerGeneric;
    return kMaskLayerGeneric;
}

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

// The inverse of buildCarSlot + buildCarGhost,
// for one slot of a LIVE scene (reroster). Sizes are left alone — the field's
// shape is the scene's, and a re-roster never changes it.
void TtpRenderer::destroyCarSlot(uint32_t c) {
    // The merged car groups may share this asset's material instances and hold
    // its node entities as instance sources, so they go FIRST — the drop below
    // would leave them referencing destroyed objects. The other cars' original
    // renderables come back with the teardown and the next frame regroups.
    destroyMergedGroups(mMergedCars);
    mCarMergeDirty = true;
    // PARKED, like a scene release — this is the CAR PICK path, so the body
    // being dismissed is very often the one the next pick asks for back.
    if (mCarAssets.size() > c) {
        parkAsset(mCarModelKey.size() > c ? mCarModelKey[c] : 0, mCarAssets[c]);
    }
    if (mCarGhostAssets.size() > c) {
        parkAsset(mCarGhostKey.size() > c ? mCarGhostKey[c] : 0, mCarGhostAssets[c]);
    }
    if (mCarModelKey.size() > c) mCarModelKey[c] = 0;
    if (mCarGhostKey.size() > c) mCarGhostKey[c] = 0;
    if (mCarGhostIn.size() > c) mCarGhostIn[c] = 0;
    // The baked bit STAYS. Layers are keyed by model now, so this slot's
    // layer is very likely still being read by another car, and clearing it
    // would drop that car to the generic oval for no reason. claimMaskLayer
    // recycles a layer that really has gone unused; releaseScene clears the
    // lot when the roster that produced them dies.
    if (mMaskLayerOfSlot.size() > c) mMaskLayerOfSlot[c] = kMaskLayerGeneric;
    if (mCars.size() > c) destroyMesh(mCars[c]);
    if (mCarWheels.size() > c) mCarWheels[c] = CarWheels{};
    if (mMonsterViews.size() > c) mMonsterViews[c] = MonsterView{};
}

bool TtpRenderer::reroster(const std::vector<TtpRosterCar>& roster,
        const std::vector<uint32_t>& remodel,
        const std::vector<uint32_t>& redress) {
    if (!mTrack || roster.size() != mTrack->carColors.size()) return false;
    applyRoster(*mTrack, roster); // colours, in place
    for (uint32_t c : remodel) {
        if (c >= roster.size()) return false;
        destroyCarSlot(c);
        if (!buildCarSlot(*mTrack, c)) return false;
        pumpTextures(); // bind the body's decodes before the ghost queues its own
        buildCarGhost(c);
    }
    for (uint32_t c : redress) {
        if (c >= roster.size()) return false;
        // Same model, new livery: only what WEARS it. The GLB body keeps its
        // own paint — a livery is the box marker's (GLB-less slots) to show.
        if ((mCarAssets.size() <= c || !mCarAssets[c]) && !buildCarSlot(*mTrack, c)) return false;
    }
    pumpTextures();
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
    // Keyed by the GHOST's own bytes, not the body's: it is a different
    // container (the 50%-alpha clone), so it is a different model to the pool.
    const uint64_t ghostKey = glbBytesKey(ghost->second);
    gltfio::FilamentAsset* ga = takeAsset(ghostKey);
    if (!ga) {
        ga = mAssetLoader->createAsset(
                ghost->second.data(), (uint32_t) ghost->second.size());
        if (!ga) return;
        registerAssetUris(ga);
        if (!mResourceLoader->loadResources(ga)) {
            mAssetLoader->destroyAsset(ga);
            return;
        }
        ga->releaseSourceData();
        snapshotRestPose(ga);
    }
    if (mCarGhostKey.size() <= c) mCarGhostKey.resize(c + 1, 0);
    mCarGhostKey[c] = ghostKey;
    mScene->addEntities(ga->getEntities(), ga->getEntityCount());
    setShadows(ga->getEntities(), ga->getEntityCount(), false, false);
    auto& tcmG = mEngine->getTransformManager();
    tcmG.setTransform(tcmG.getInstance(ga->getRoot()),
            mat4f::translation(float3{ 0, -1000, 0 }));
    // The ghost body is only ever shown as the GRAFTED monster body, and
    // MonsterRig strips the car's wheels before seating it — collapse them
    // once here (this instance's wheels are never animated).
    // Unconditional, and it has to be: a parked ghost comes back at its PARSE
    // pose (takeAsset), so the collapse is undone on every reuse. The
    // scale is absolute rather than relative, and the translation it preserves is
    // read back out of the transform it is about to overwrite — which works only
    // because the scale zeroes no row. Noted so nobody makes it relative.
    for (const char* wn : { "wheel-fl", "wheel-fr", "wheel-bl", "wheel-br", "axle" }) {
        const utils::Entity we = ga->getFirstEntityByName(wn);
        if (we.isNull()) continue;
        const auto wi = tcmG.getInstance(we);
        mat4f local = mat4f::scaling(float3{ 1e-4f });
        local[3] = tcmG.getTransform(wi)[3];
        tcmG.setTransform(wi, local);
    }
    mCarGhostAssets[c] = ga;
    pumpTextures();
}

// Regroup the whole field into merged draws: per MODEL (the bytes are the
// identity), per distinct MESH (the per-side wheel pairs share one, so all
// four wheels of every car of a model land in two groups), one instanced
// renderable whose transforms mirror the gltfio nodes every frame
// (updateMergedTransforms). Runs lazily off mCarMergeDirty — addCar fires per
// slot, and grouping mid-roster would rebuild eight times for one launch.
//
// The GHOST twins stay out: they are four assets on a different material
// (vglbfade), parked at -1000 except while a monster is occluding someone.
void TtpRenderer::rebuildCarMerge() {
    destroyMergedGroups(mMergedCars);
    if (!mScene || !mEngine) return;
    auto& rcm = mEngine->getRenderableManager();
    // Slots by model.
    std::unordered_map<uint64_t, std::vector<uint32_t>> byModel;
    for (uint32_t c = 0; c < mCarAssets.size(); c++) {
        if (!mCarAssets[c] || c >= mCarModelKey.size() || !mCarModelKey[c]) continue;
        byModel[mCarModelKey[c]].push_back(c);
    }
    for (const auto& [key, slots] : byModel) {
        const auto it = mGlbMeshCache.find(key);
        if (it == mGlbMeshCache.end() || it->second.empty()) continue;
        // Node names by mesh, so shared-mesh nodes join one group.
        std::unordered_map<int, std::vector<const ttp::rt::GlbMeshNode*>> byMesh;
        for (const auto& n : it->second) {
            if (!n.name.empty()) byMesh[n.mesh].push_back(&n);
        }
        for (const auto& [mesh, nodes] : byMesh) {
            std::vector<utils::Entity> sources;
            for (const uint32_t c : slots) {
                for (const auto* n : nodes) {
                    const utils::Entity e =
                            mCarAssets[c]->getFirstEntityByName(n->name.c_str());
                    if (!e.isNull() && rcm.getInstance(e)) sources.push_back(e);
                }
            }
            buildMergedGroup(mMergedCars, sources, nodes[0]->prims,
                    /*dynamic=*/true, kFeatCars);
        }
    }
}
