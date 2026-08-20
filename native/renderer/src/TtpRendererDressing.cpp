// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"
#include "TtpRendererKit.h"

#include <cstdio>

#include "ttp/kitfield.h"   // header-only; the renderer may not link libttp-runtime


// Trackside scenery — an EXACT replay of buildScenery's seeded streams (the
// same LCG, the same rand() consumption order, the same corridor clearance),
// so every tree/bush/boulder lands where the Three.js scatter puts it. Trees
// and bushes become gltfio instances (per-tree shade jitter is consumed from
// the stream but not applied — instances share materials); boulders are a
// merged vertex-tinted icosahedron mesh.
void TtpRenderer::buildScenery(const TrackBin& tb) {
    // NOT gated on having trees. The playroom is an indoor floor with none at
    // all (mix.tree = 0, so every roll lands on the "boulder" channel, which is
    // what its scattered toy bits ARE) — bailing here dropped that whole pass
    // and left the floor bare. The JS bails inside placeTree instead, and only
    // for a roll that actually wants a tree.
    if (tb.scDensity <= 0) return;
    uint32_t seed = tb.scSeed1;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    // No default half-width here: isClear measures each SAMPLE's own width, so a
    // track that narrows or widens is respected.
    const float MARGIN = 2.2f;
    const auto isClear = [&](float x, float z) {
        for (const auto& s : tb.samples) {
            const float half = s.width / 2 + MARGIN;
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < half * half) return false;
        }
        return true;
    };

    struct Placement { uint32_t model; float x, z, s, syJit, yaw, sink; };
    std::vector<Placement> placements;
    // placeTree with the exact rand order: pick, size, yaw, height jitter,
    // shade (consumed; unapplied — see above).
    const auto placeTree = [&](float x, float z, int forceModel, float forceS, float sink) {
        uint32_t model = 0;
        float s = forceS;
        if (forceModel < 0) {
            // No tree palette (the playroom): bail BEFORE drawing, exactly where
            // the JS does, so the shared rand stream stays in step.
            if (tb.scTrees.empty()) return;
            const double r = rnd();
            double acc = 0;
            model = tb.scTrees.back().model;
            float s0 = tb.scTrees.back().s0, s1 = tb.scTrees.back().s1;
            for (const auto& e : tb.scTrees) {
                acc += e.w;
                if (r < acc) { model = e.model; s0 = e.s0; s1 = e.s1; break; }
            }
            s = s0 + (float) rnd() * s1;
        } else {
            model = (uint32_t) forceModel;
        }
        const float yaw = (float) rnd() * 2.0f * (float) M_PI;
        const float syJit = 0.92f + (float) rnd() * 0.16f;
        (void) rnd(); // shade
        placements.push_back({ model, x, z, s, syJit, yaw, sink });
    };

    struct Boulder { float x, z, rr, sy, yaw; uint32_t grey; float shade; };
    std::vector<Boulder> boulders;
    for (float d = 0; d < tb.length; d += 7) {
        const TrackBin::Sample f = tb.frameAt(d);
        const float half = f.width / 2;
        for (const int side : { -1, 1 }) {
            if (rnd() > tb.scDensity) continue;
            const float lat = side * (half + 2.5f + (float) rnd() * 9.0f);
            const float x = f.pos.x + f.lat.x * lat + ((float) rnd() - 0.5f) * 3.0f;
            const float z = f.pos.z + f.lat.z * lat + ((float) rnd() - 0.5f) * 3.0f;
            if (!isClear(x, z)) continue;
            const double roll = rnd();
            if (roll < tb.scMixTree) {
                placeTree(x, z, -1, 0, 0);
                if (rnd() < 0.45) { // copse companions
                    const int extra = 1 + (int) std::floor(rnd() * 2);
                    for (int e = 0; e < extra; e++) {
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        const float r = 1.6f + (float) rnd() * 1.6f;
                        const float ex = x + std::cos(a) * r, ez = z + std::sin(a) * r;
                        if (isClear(ex, ez)) placeTree(ex, ez, -1, 0, 0);
                    }
                }
            } else if (roll < tb.scMixBush && tb.scHasBush) {
                const float bs = tb.scBush.s0 + (float) rnd() * tb.scBush.s1;
                placeTree(x, z, (int) tb.scBush.model, bs, tb.scBush.sink);
            } else if (!tb.scRocks.empty()) {
                // A biome may carry no boulder palette at all — the snow cup
                // dresses its verges with snow-capped kit rock instead, and
                // grey granite beside that reads as a different game.
                Boulder b;
                b.rr = tb.scRockS[0] + (float) rnd() * tb.scRockS[1];
                b.grey = tb.scRocks[(size_t) std::floor(rnd() * tb.scRocks.size())];
                b.shade = 0.92f + (float) rnd() * 0.16f;
                b.sy = 0.55f + (float) rnd() * 0.3f;
                b.yaw = (float) rnd() * 2.0f * (float) M_PI;
                b.x = x; b.z = z;
                boulders.push_back(b);
            }
        }
    }

    // Trees/bushes: one instanced asset per scenery model.
    mSceneryAssets.resize(tb.scModelCount, nullptr);
    mSceneryInstances.resize(tb.scModelCount);
    for (uint32_t m = 0; m < tb.scModelCount; m++) {
        size_t count = 0;
        for (const auto& p : placements) if (p.model == m) count++;
        if (!count) continue;
        const std::string name = "scenery" + std::to_string(m) + ".glb";
        mSceneryAssets[m] = loadInstancedProp(name.c_str(), count, mSceneryInstances[m]);
        if (!mSceneryAssets[m]) continue;
        // The kits ship several of these with metallicFactor 1, which under real
        // PBR renders them near-BLACK (a metal with only the SH ambient to
        // reflect). The JS never sees it — every scenery piece is Lambert
        // there — so force the same matte read on all of them.
        //
        // Biome recolour on top: buildScenery bakes theme tints into vertex
        // colours for UNTEXTURED models; here the same colours land on the
        // matching material instances (gltfio names them after the glTF
        // material). The JS's small per-tree shade jitter isn't reproduced —
        // these are shared instances.
        for (auto* inst : mSceneryInstances[m]) {
            MaterialInstance* const* mis = inst->getMaterialInstances();
            for (size_t i = 0; i < inst->getMaterialInstanceCount(); i++) {
                mis[i]->setParameter("metallicFactor", 0.0f);
                mis[i]->setParameter("roughnessFactor", 1.0f);
                if (m >= tb.modelTints.size()) continue;
                const char* nm = mis[i]->getName();
                for (const auto& t : tb.modelTints[m]) {
                    if (t.name == nm) {
                        mis[i]->setParameter("baseColorFactor",
                                float4{ srgbToLinear(t.rgb), 1.0f });
                    }
                }
            }
        }
        auto& tcm = mEngine->getTransformManager();
        size_t k = 0;
        for (const auto& p : placements) {
            if (p.model != m) continue;
            const mat4f xf = mat4f::translation(
                    float3{ p.x, groundSurfaceY(tb, p.x, p.z) - p.sink * p.s, p.z })
                    * mat4f::rotation(p.yaw, float3{ 0, 1, 0 })
                    * mat4f::scaling(float3{ p.s, p.s * p.syJit, p.s });
            tcm.setTransform(tcm.getInstance(mSceneryInstances[m][k]->getRoot()), xf);
            mShadowSpots.push_back({ p.x, p.z, 0.62f * p.s, 0.8f * p.s });
            k++;
        }
    }

    // Boulders: flat-shaded icosahedra, vertex-tinted greys.
    if (!boulders.empty()) {
        const float T = (1.0f + std::sqrt(5.0f)) / 2.0f;
        const float3 V[12] = {
            { -1, T, 0 }, { 1, T, 0 }, { -1, -T, 0 }, { 1, -T, 0 },
            { 0, -1, T }, { 0, 1, T }, { 0, -1, -T }, { 0, 1, -T },
            { T, 0, -1 }, { T, 0, 1 }, { -T, 0, -1 }, { -T, 0, 1 },
        };
        const int F[20][3] = {
            { 0, 11, 5 }, { 0, 5, 1 }, { 0, 1, 7 }, { 0, 7, 10 }, { 0, 10, 11 },
            { 1, 5, 9 }, { 5, 11, 4 }, { 11, 10, 2 }, { 10, 7, 6 }, { 7, 1, 8 },
            { 3, 9, 4 }, { 3, 4, 2 }, { 3, 2, 6 }, { 3, 6, 8 }, { 3, 8, 9 },
            { 4, 9, 5 }, { 2, 4, 11 }, { 6, 2, 10 }, { 8, 6, 7 }, { 9, 8, 1 },
        };
        const float INV = 1.0f / std::sqrt(1 + T * T);
        for (const Boulder& b : boulders) {
            const uint32_t col = packLinear(srgbToLinear(b.grey), b.shade);
            const float cy = std::cos(b.yaw), sy = std::sin(b.yaw);
            const float by = footprintY(tb, b.x, b.z, b.rr);
            for (const auto& face : F) {
                for (int vi = 0; vi < 3; vi++) {
                    float3 p = V[face[vi]] * INV;
                    p = { p.x * b.rr, p.y * b.rr * b.sy, p.z * b.rr };
                    const float rx = p.x * cy + p.z * sy, rz = -p.x * sy + p.z * cy;
                    mBoulders.verts.push_back({ b.x + rx, by + b.rr * 0.25f + p.y,
                                                b.z + rz, col });
                }
            }
        }
        mBoulders.idx.resize(mBoulders.verts.size());
        for (uint32_t i = 0; i < mBoulders.idx.size(); i++) mBoulders.idx[i] = i;
        accumulateNormals(mBoulders); // soup → flat faceted, the kit read
        buildMesh(mBoulders);
    }
}

// Trackside props (theme.props): a scattered set-dressing pass, instanced from
// the generated prop-*.glb kit pieces (scripts/gen-props.mjs). Own seeded
// stream — the scenery, clutter and landmark scatters are untouched by
// anything rolled here.
void TtpRenderer::buildProps(const TrackBin& tb) {
    if (tb.prModelCount == 0) return;
    uint32_t seed = tb.scSeed2 ^ 0x70726f70u; // "prop"
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const auto isClearP = [&](float x, float z, float m) {
        for (const auto& s : tb.samples) {
            const float half = s.width / 2 + m;
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < half * half) return false;
        }
        return true;
    };

    struct Placement { uint32_t slot; float x, y, z, s, yaw, h; };
    std::vector<Placement> placements;

    // Scattered pieces, the buildScenery idiom: a candidate every 9u per side,
    // rolled against density, kind picked by cumulative weight.
    if (tb.prDensity > 0 && !tb.prScatter.empty()) {
        for (float d = 0; d < tb.length; d += 9) {
            const TrackBin::Sample f = tb.frameAt(d);
            for (const int side : { -1, 1 }) {
                if (rnd() > tb.prDensity) continue;
                const float lat = side * (f.width / 2 + 2.8f + (float) rnd() * 8.0f);
                const float x = f.pos.x + f.lat.x * lat + ((float) rnd() - 0.5f) * 2.0f;
                const float z = f.pos.z + f.lat.z * lat + ((float) rnd() - 0.5f) * 2.0f;
                if (!isClearP(x, z, 1.0f)) continue;
                const double roll = rnd();
                double acc = 0;
                const TrackBin::PropStamp* e = &tb.prScatter.back();
                for (const auto& p : tb.prScatter) {
                    acc += p.w;
                    if (roll < acc) { e = &p; break; }
                }
                const float s = e->s0 + (float) rnd() * e->s1;
                // The roll is consumed either way, so a prop that faces the
                // road does not reshuffle the scatter behind it.
                const float spun = (float) rnd() * 2.0f * (float) M_PI;
                // Facing = square to the deck, looking across it: the lateral
                // axis, negated on the side the prop stands. Same frame the
                // procedural snowman used to face itself by.
                const float yaw = e->face
                        ? std::atan2(-f.lat.x * side, -f.lat.z * side) : spun;
                const float py = footprintY(tb, x, z, 0.45f * s);
                placements.push_back({ e->slot, x, py, z, s, yaw, 0.6f * s });
            }
        }
    }

    mPropAssets.resize(tb.prModelCount, nullptr);
    mPropInstances.resize(tb.prModelCount);
    auto& tcm = mEngine->getTransformManager();
    // The pools, and each model's OWN footprint. The scatter above cannot know
    // how big a model is — that is in the GLB and nowhere else — so the spacing
    // rule below cannot run until the assets are here. Pools are sized to the
    // candidates; what the rule then drops parks out of sight, which is the same
    // thing the item-box pool does with its spare entries.
    std::vector<float> reach(tb.prModelCount, 0.0f);  // half-footprint at scale 1
    for (uint32_t m = 0; m < tb.prModelCount; m++) {
        size_t count = 0;
        for (const auto& p : placements) if (p.slot == m) count++;
        if (!count) continue;
        const std::string name = "prop" + std::to_string(m) + ".glb";
        mPropAssets[m] = loadInstancedProp(name.c_str(), count, mPropInstances[m]);
        if (!mPropAssets[m]) continue;
        const filament::Aabb bb = mPropAssets[m]->getBoundingBox();
        reach[m] = 0.5f * std::max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
        // The buildScenery metal fix: the shared matte read on every piece.
        for (auto* inst : mPropInstances[m]) {
            MaterialInstance* const* mis = inst->getMaterialInstances();
            for (size_t i = 0; i < inst->getMaterialInstanceCount(); i++) {
                mis[i]->setParameter("metallicFactor", 0.0f);
                mis[i]->setParameter("roughnessFactor", 1.0f);
            }
        }
    }

    // NOTHING MAY MERGE INTO ANYTHING. Two props sharing a patch of ground read
    // as one broken object, and a prop standing inside a tree reads worse. The
    // scatter only ever checked its distance from the ROAD, which was enough
    // while every prop was a crate; a snowman beside a rock cluster beside a
    // train set is not.
    //
    // mShadowSpots is the record of what is already standing — every landmark,
    // tree and boulder pushed one before this ran — so it is both the test and
    // the place a kept prop registers itself.
    //
    // A loser is DROPPED, never nudged: the scatter's shape is its seeded
    // stream, and moving a placement walks it into the next one.
    const float CLEAR = 0.35f;   // daylight between two things that both stand
    std::vector<size_t> kept;
    for (size_t i = 0; i < placements.size(); i++) {
        const Placement& p = placements[i];
        const float pr = reach[p.slot] * p.s;   // what this prop covers
        bool clash = false;
        for (const float4& spot : mShadowSpots) {
            const float dx = p.x - spot.x, dz = p.z - spot.y;
            const float lim = pr + spot.z + CLEAR;
            if (dx * dx + dz * dz < lim * lim) { clash = true; break; }
        }
        if (clash) continue;
        kept.push_back(i);
        mShadowSpots.push_back({ p.x, p.z, pr, p.h });
    }

    // Pose what survived; park the rest under the floor.
    for (uint32_t m = 0; m < tb.prModelCount; m++) {
        if (!mPropAssets[m]) continue;
        size_t k = 0;
        for (const size_t i : kept) {
            const Placement& p = placements[i];
            if (p.slot != m) continue;
            const mat4f xf = mat4f::translation(float3{ p.x, p.y, p.z })
                    * mat4f::rotation(p.yaw, float3{ 0, 1, 0 })
                    * mat4f::scaling(float3{ p.s, p.s, p.s });
            tcm.setTransform(tcm.getInstance(mPropInstances[m][k]->getRoot()), xf);
            // A prop model may name ONE node "spin", and the renderer turns it
            // about its own origin every frame — which is how the toy train
            // drives its rails (scripts/gen-trainset.mjs). Collected here
            // because that is where the instances are; per frame it is one
            // transform each and nothing else in the set moves.
            for (size_t e = 0; e < mPropInstances[m][k]->getEntityCount(); e++) {
                const utils::Entity ent = mPropInstances[m][k]->getEntities()[e];
                const char* nm = mPropAssets[m]->getName(ent);
                if (nm && std::strcmp(nm, "spin") == 0) mPropSpins.push_back(ent);
            }
            k++;
        }
        for (; k < mPropInstances[m].size(); k++) {
            tcm.setTransform(tcm.getInstance(mPropInstances[m][k]->getRoot()),
                    mat4f::translation(float3{ 0, -100, 0 }));
        }
    }
}


// Near-field ground clutter — the flower patches, on their own rand2 stream
// (seed 5381-FNV) exactly like buildScenery's clutter pass. Only the 'flower'
// kind is ported; palettes with other kinds send no clutter config at all.
void TtpRenderer::buildClutter(const TrackBin& tb) {
    if (tb.clKinds.empty() || tb.clDensity <= 0) return;
    uint32_t seed = tb.scSeed2;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const float gy0 = tb.groundY;
    const float CL_MARGIN = 0.7f;
    const auto isClearC = [&](float x, float z) {
        for (const auto& s : tb.samples) {
            const float h = s.pos.y - gy0;
            const float half = s.width / 2 + CL_MARGIN + (h > 0.5f ? 0.6f + 0.8f * h : 0.0f);
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < half * half) return false;
        }
        return true;
    };
    int geoms = 0;
    const auto put = [&](Prim p, const mat4f& m, uint32_t hex, float shade) {
        const uint32_t c = packLinear(srgbToLinear(hex), shade);
        const uint32_t base = (uint32_t) mClutter.verts.size();
        for (const float3& v : p.v) {
            const float3 w = (m * float4{ v, 1 }).xyz;
            mClutter.verts.push_back({ w.x, w.y, w.z, c });
        }
        for (const uint32_t i : p.i) mClutter.idx.push_back(base + i);
        geoms++;
    };
    const auto T = [](float x, float y, float z) { return mat4f::translation(float3{ x, y, z }); };
    const auto SC = [](float x, float y, float z) { return mat4f::scaling(float3{ x, y, z }); };
    const auto RY = [](float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); };
    const auto RZ = [](float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); };

    for (float d = 0; d < tb.length && geoms < 700; d += 5) {
        const TrackBin::Sample f = tb.frameAt(d);
        const float half = f.width / 2;
        for (const int side : { -1, 1 }) {
            if (rnd() > tb.clDensity) continue;
            const float lat = side * (half + 1.3f + (float) rnd() * 3.4f);
            const float x = f.pos.x + f.lat.x * lat + ((float) rnd() - 0.5f) * 1.6f;
            const float z = f.pos.z + f.lat.z * lat + ((float) rnd() - 0.5f) * 1.6f;
            if (!isClearC(x, z)) continue;
            const float gy = groundSurfaceY(tb, x, z); // every piece stands on the relief
            const double r = rnd(); // weighted kind pick (one draw)
            double acc = 0;
            const TrackBin::ClutterKind* entry = &tb.clKinds.back();
            for (const auto& e : tb.clKinds) { acc += e.w; if (r < acc) { entry = &e; break; } }
            const auto pick = [&](const TrackBin::ClutterKind* e) {
                return e->tints.empty() ? 0xffffffu
                        : e->tints[(size_t) std::floor(rnd() * e->tints.size())];
            };
            if (entry->kind != 0) {
                // ---- the small kinds (CLUTTER_BUILDERS, verbatim draws) ----
                switch (entry->kind) {
                    case 1: { // shell — a squashed half-dome, tipped a touch
                        const float rr = 0.24f + (float) rnd() * 0.1f;
                        const float rz = 0.12f + (float) rnd() * 0.1f;
                        const float ry = (float) rnd() * 2.0f * (float) M_PI;
                        put(primSphereBand(rr, 8, 4, 0, (float) M_PI / 2),
                                T(x, gy + 0.03f, z) * RY(ry) * RZ(rz) * SC(1, 0.55f, 1.2f),
                                pick(entry), 0.96f + (float) rnd() * 0.1f);
                        break;
                    }
                    case 2: { // starfish — benched; buildStarfishModel holds the takes
                        const uint32_t hex = pick(entry);
                        const float a0 = (float) rnd() * 2.0f * (float) M_PI;
                        const float sc = 0.8f + (float) rnd() * 0.5f;
                        const PartFn emit = [&](const Prim& p, float lx, float ly,
                                float lz, uint32_t h2, float shade) {
                            Prim s2 = p;
                            for (auto& q : s2.v) q *= sc;
                            put(s2, T(x, gy, z) * RY(a0)
                                    * T(lx * sc, ly * sc, lz * sc), h2, shade);
                        };
                        buildStarfishModel(emit, mModelVariant[MODEL_STARFISH], hex);
                        break;
                    }
                    case 3: { // driftwood — two thin rods, kinked where they meet
                        const uint32_t hex = pick(entry);
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        put(applyPre(primCylinder(0.07f, 0.09f, 1.5f, 6),
                                    mat4f::rotation((float) M_PI / 2, float3{ 0, 0, 1 })),
                                T(x, gy + 0.08f, z) * RY(a), hex, 1.0f);
                        put(applyPre(primCylinder(0.05f, 0.06f, 0.9f, 6),
                                    mat4f::rotation((float) M_PI / 2, float3{ 0, 0, 1 })),
                                T(x + std::cos(a) * 0.55f, gy + 0.06f, z - std::sin(a) * 0.55f)
                                        * RY(a + 0.6f), hex, 0.92f);
                        break;
                    }
                    case 4: { // drift — a wind-blown snow heap
                        const float sx = 0.9f + (float) rnd() * 0.9f;
                        const float sy = 0.28f + (float) rnd() * 0.12f;
                        const float sz = 0.55f + (float) rnd() * 0.5f;
                        const float ry = (float) rnd() * 2.0f * (float) M_PI;
                        put(primIcoDetail(1.0f, 1), T(x, gy + 0.07f, z) * RY(ry) * SC(sx, sy, sz),
                                pick(entry), 0.97f + (float) rnd() * 0.06f);
                        break;
                    }
                    case 5: { // scrub — a dry sage tuft, sometimes two clumped
                        const int n2 = 1 + (rnd() < 0.4 ? 1 : 0);
                        for (int i = 0; i < n2; i++) {
                            const float rr = 0.3f + (float) rnd() * 0.18f;
                            const float sy = 0.55f + (float) rnd() * 0.2f;
                            const float ry = (float) rnd() * 2.0f * (float) M_PI;
                            put(primIco(rr), T(x + i * 0.5f, gy + 0.12f, z + i * 0.3f)
                                            * RY(ry) * SC(1, sy, 1),
                                    pick(entry), 0.9f + (float) rnd() * 0.2f);
                        }
                        break;
                    }
                    case 6: { // pebbles — a little cluster of rust stones
                        const int n2 = 3 + (int) std::floor(rnd() * 2);
                        for (int i = 0; i < n2; i++) {
                            const float rr = 0.09f + (float) rnd() * 0.09f;
                            const float ox = ((float) rnd() - 0.5f) * 0.7f;
                            const float oz = ((float) rnd() - 0.5f) * 0.7f;
                            put(primIco(rr), T(x + ox, gy + rr * 0.5f, z + oz),
                                    pick(entry), 0.9f + (float) rnd() * 0.2f);
                        }
                        break;
                    }
                    case 7: { // brick — a studded toy brick
                        const uint32_t hex = pick(entry);
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        put(primBox(0.62f, 0.3f, 0.34f), T(x, gy + 0.15f, z) * RY(a), hex, 1.0f);
                        for (const int sd : { -1, 1 }) {
                            put(primCylinder(0.09f, 0.09f, 0.1f, 8),
                                    T(x, gy, z) * RY(a) * T(sd * 0.15f, 0.34f, 0), hex, 1.06f);
                        }
                        break;
                    }
                    case 8: { // marble — a lost glass bead
                        put(primSphere(0.19f, 10, 7), T(x, gy + 0.19f, z), pick(entry), 1.05f);
                        break;
                    }
                    case 9: { // domino — white tile, dark midline, 3+5 pips
                        const float a = (float) rnd() * 2.0f * (float) M_PI;
                        const mat4f frame = T(x, gy, z) * RY(a);
                        put(primBox(0.56f, 0.12f, 1.06f), frame * T(0, 0.06f, 0), pick(entry), 1.0f);
                        put(primBox(0.58f, 0.025f, 0.06f), frame * T(0, 0.12f, 0), 0x3a3442, 1.0f);
                        static const float PIPS[8][2] = {
                            { 0, -0.28f }, { -0.14f, -0.15f }, { 0.14f, -0.41f },
                            { -0.14f, 0.15f }, { 0.14f, 0.15f }, { 0, 0.28f },
                            { -0.14f, 0.41f }, { 0.14f, 0.41f },
                        };
                        for (const auto& pip : PIPS) {
                            put(primCylinder(0.045f, 0.045f, 0.035f, 6),
                                    frame * T(pip[0], 0.128f, pip[1]), 0x3a3442, 1.0f);
                        }
                        break;
                    }
                    default: break;
                }
                continue;
            }
            // ---- flower patch (CLUTTER_BUILDERS.flower, verbatim draws) ----
            const int n = 3 + (int) std::floor(rnd() * 3);
            struct Bloom { float x, z, r; };
            std::vector<Bloom> spots;
            for (int i = 0; i < n; i++) {
                const float s = 0.85f + (float) rnd() * 0.45f;
                const float headR = 0.28f * s;
                float fx = 0, fz = 0;
                bool found = false;
                for (int t = 0; t < 6 && !found; t++) {
                    const float a = (float) rnd() * 2.0f * (float) M_PI;
                    const float rr = (float) rnd() * 0.9f;
                    const float px = x + std::cos(a) * rr, pz = z + std::sin(a) * rr;
                    bool ok = true;
                    for (const Bloom& sp : spots) {
                        if (std::hypot(px - sp.x, pz - sp.z) < headR + sp.r + 0.05f) { ok = false; break; }
                    }
                    if (ok) { fx = px; fz = pz; found = true; }
                }
                if (!found) continue;
                spots.push_back({ fx, fz, headR });
                const float h = (0.26f + (float) rnd() * 0.12f) * s;
                const uint32_t hex = entry->tints.empty() ? 0xffffffu
                        : entry->tints[(size_t) std::floor(rnd() * entry->tints.size())];
                const float ph = (float) rnd() * 2.0f * (float) M_PI;
                put(primCylinder(0.038f * s, 0.05f * s, h, 5), T(fx, gy + h / 2, fz),
                        0x4e8a44, 0.92f + (float) rnd() * 0.14f);
                for (int k = 0; k < 2; k++) {
                    const float la = ph + k * 2.4f + 0.7f;
                    put(primSphere(0.1f * s, 6, 4),
                            T(fx + std::cos(la) * 0.16f * s, gy + 0.03f, fz + std::sin(la) * 0.16f * s)
                                    * RY(-la) * SC(1.7f, 0.3f, 0.7f),
                            0x5a9a50, 0.9f + (float) rnd() * 0.12f);
                }
                for (int k = 0; k < 5; k++) {
                    const float pa = ph + ((float) k / 5) * 2.0f * (float) M_PI;
                    put(primSphere(0.09f * s, 6, 4),
                            T(fx + std::cos(pa) * 0.13f * s, gy + h + 0.02f * s, fz + std::sin(pa) * 0.13f * s)
                                    * RY(-pa) * RZ(0.4f) * SC(1.5f, 0.4f, 0.85f),
                            hex, 0.95f + (float) rnd() * 0.1f);
                }
                put(primSphere(0.08f * s, 6, 5), T(fx, gy + h + 0.03f * s, fz) * SC(1, 0.7f, 1),
                        0xf2c14e, 1.05f);
            }
        }
    }
    if (!mClutter.verts.empty()) {
        accumulateNormals(mClutter);
        buildMesh(mClutter, true, nullptr, 4, 2000);
    }
}

// Grass-biome landmarks — verbatim placement streams (seed 51966-FNV) and the
// track.js builders' numbers: the gnome, the doghouse, the picnic spread.
static_assert(MODEL_COUNT == 4, "TtpRenderer::mModelVariant is sized to ModelId");

void TtpRenderer::setModelVariant(const char* model, int variant) {
    const int id = modelIdByName(model);
    if (id < 0) return;
    const int n = modelVariantCount(id);
    mModelVariant[id] = variant < 0 ? 0 : (variant >= n ? n - 1 : variant);
}

void TtpRenderer::setModelBench(const char* model) { mBenchModel = modelIdByName(model); }

void TtpRenderer::setKitField(int count) { mKitFieldCount = count > 0 ? count : 0; }

// The kit field's own ground, appended to the ground sheet so it costs no
// material and no draw call of its own — the same tiling surface, a hair higher.
//
// The lift is what makes it a CLEAR surface rather than a patch of world: the
// beach biome's sea covers everything past its shore radius, which is every
// piece of ground far enough out to hold a field, so without this the whole
// browser reads through a blue sheet. Raised, the field stands on a sandbar and
// the sea closes around it. On a dry biome the lift is invisible.
void TtpRenderer::kitFieldApron(Mesh& ground, float groundY, float tile, uint32_t col) const {
    if (mKitFieldMaxX <= mKitFieldMinX) return;   // no field in this build
    const float m = ttp::rt::kKitFieldClear * 0.5f;
    const float x0 = mKitFieldMinX - m, x1 = mKitFieldMaxX + m;
    const float z0 = mKitFieldMinZ - m, z1 = mKitFieldMaxZ + m;
    const float y = groundY + ttp::rt::kKitFieldLift;
    const uint32_t base = (uint32_t) ground.verts.size();
    ground.verts.push_back({ x0, y, z0, col });
    ground.verts.push_back({ x1, y, z0, col });
    ground.verts.push_back({ x0, y, z1, col });
    ground.verts.push_back({ x1, y, z1, col });
    ground.uvs.insert(ground.uvs.end(),
            { { x0 / tile, z0 / tile }, { x1 / tile, z0 / tile },
              { x0 / tile, z1 / tile }, { x1 / tile, z1 / tile } });
    ground.normals.insert(ground.normals.end(), 4, float3{ 0, 1, 0 });
    ground.idx.insert(ground.idx.end(),
            { base, base + 2, base + 1, base + 1, base + 2, base + 3 });
}

// The KIT FIELD: every model the gallery handed over, standing on clear ground
// beside the track. Not scenery and not a bench — those two stage what the game
// draws, and this stages what it COULD, which is why it takes no theme, gets no
// scatter and reads its models straight out of the shell's fetch list.
//
// Where it goes is derived, not authored: past the track's own footprint AND
// past the terrain grid, so the field cannot land on the road whatever track the
// gallery is holding, and lands on ground that is FLAT — two models on a
// hillside are two models at different heights, and comparing them is the whole
// point.
void TtpRenderer::buildKitField(const TrackBin& tb) {
    mKitLayout = "[]";
    mKitFieldMinX = mKitFieldMinZ = 0.0f;
    mKitFieldMaxX = mKitFieldMaxZ = -1.0f;   // inverted: no field
    if (mKitFieldCount <= 0) return;

    // Pass one: load them all and measure. The footprint has to come off the
    // loaded asset — a GLB's AABB is not in the fetch list, and the pack cannot
    // start until every model has one.
    mKitAssets.assign((size_t) mKitFieldCount, nullptr);
    std::vector<std::vector<gltfio::FilamentInstance*>> roots((size_t) mKitFieldCount);
    std::vector<ttp::rt::KitFootprint> foot((size_t) mKitFieldCount);
    std::vector<filament::Aabb> boxes((size_t) mKitFieldCount);
    for (int i = 0; i < mKitFieldCount; i++) {
        const std::string name = "kit" + std::to_string(i) + ".glb";
        mKitAssets[(size_t) i] = loadInstancedProp(name.c_str(), 1, roots[(size_t) i]);
        if (!mKitAssets[(size_t) i]) continue;
        const filament::Aabb bb = mKitAssets[(size_t) i]->getBoundingBox();
        boxes[(size_t) i] = bb;
        foot[(size_t) i] = { bb.max.x - bb.min.x, bb.max.z - bb.min.z };
        // The kits ship plenty of models at metallicFactor 1, which under real
        // PBR renders near-BLACK — the same trap buildScenery documents, and a
        // candidate judged black is a candidate rejected for the wrong reason.
        for (auto* in : roots[(size_t) i]) {
            MaterialInstance* const* mis = in->getMaterialInstances();
            for (size_t m = 0; m < in->getMaterialInstanceCount(); m++) {
                mis[m]->setParameter("metallicFactor", 0.0f);
                mis[m]->setParameter("roughnessFactor", 1.0f);
            }
        }
    }

    // Past the track's own extent AND past the terrain grid, whichever reaches
    // further. Out there groundSurfaceY answers the flat ground height, which is
    // what a field is for: two models on a hillside are two models at different
    // heights, and the whole point is to compare them.
    float maxX = 0.0f, minZ = 0.0f;
    for (const auto& s : tb.samples) {
        maxX = std::max(maxX, s.pos.x);
        minZ = std::min(minZ, s.pos.z);
    }
    const float ox = std::max(maxX, mTerrainX1) + ttp::rt::kKitFieldStandoff;
    const float oz = minZ;

    const std::vector<ttp::rt::KitSpot> spots = ttp::rt::kit_field_layout(foot);
    auto& tcm = mEngine->getTransformManager();
    mKitFieldMinX = mKitFieldMaxX = ox;
    mKitFieldMinZ = mKitFieldMaxZ = oz;
    std::string json = "[";
    for (int i = 0; i < mKitFieldCount; i++) {
        const size_t k = (size_t) i;
        const float x = ox + spots[k].x, z = oz + spots[k].z;
        // The APRON's height, not the terrain's: the field is placed past the
        // terrain grid precisely so the ground under it is flat, and it stands
        // on its own sheet (kitFieldApron) rather than on the world's.
        const float y = tb.groundY + ttp::rt::kKitFieldLift;
        // The ground the field covers, for whatever else wants to keep off it
        // (the horizon ring does). Each model's own cell, not its centre.
        mKitFieldMinX = std::min(mKitFieldMinX, x - foot[k].w * 0.5f);
        mKitFieldMaxX = std::max(mKitFieldMaxX, x + foot[k].w * 0.5f);
        mKitFieldMinZ = std::min(mKitFieldMinZ, z - foot[k].d * 0.5f);
        mKitFieldMaxZ = std::max(mKitFieldMaxZ, z + foot[k].d * 0.5f);
        if (mKitAssets[k] && !roots[k].empty()) {
            // Seat it on its own AABB: the spot is where the model's FOOTPRINT
            // centres and the ground is where its underside sits, neither of
            // which is where its origin happens to be.
            const filament::Aabb& bb = boxes[k];
            const mat4f xf = mat4f::translation(float3{
                    x - (bb.min.x + bb.max.x) * 0.5f, y - bb.min.y,
                    z - (bb.min.z + bb.max.z) * 0.5f });
            tcm.setTransform(tcm.getInstance(roots[k][0]->getRoot()), xf);
        }
        // Keys sorted, like every JSON this ABI answers. A model that failed to
        // load still gets its entry: the chrome indexes this list by the same
        // order it provided, so a hole would shift every name after it.
        char buf[192];
        std::snprintf(buf, sizeof(buf),
                "%s{\"d\":%.3f,\"h\":%.3f,\"w\":%.3f,\"x\":%.3f,\"y\":%.3f,\"z\":%.3f}",
                i ? "," : "", (double) foot[k].d,
                (double) (boxes[k].max.y - boxes[k].min.y), (double) foot[k].w,
                (double) x, (double) y, (double) z);
        json += buf;
    }
    mKitLayout = json + "]";
}

void TtpRenderer::buildLandmarks(const TrackBin& tb) {
    // The BENCH has no landmark set behind it — it replaces one — so it must
    // not be gated on the theme listing kinds the way everything below is.
    if (tb.lmKinds.empty() && mBenchModel < 0) return;
    uint32_t seed = tb.lmSeed;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (double) seed / 4294967296.0;
    };
    const float gy = tb.groundY;
    const auto isClear = [&](float x, float z, float m) {
        for (const auto& s : tb.samples) {
            const float h = s.pos.y - gy;
            const float lim = s.width / 2 + m + (h > 0.5f ? 0.6f + 0.8f * h : 0.0f);
            const float dx = x - s.pos.x, dz = z - s.pos.z;
            if (dx * dx + dz * dz < lim * lim) return false;
        }
        return true;
    };
    struct Foot { float x, z, r; };
    std::vector<Foot> placed;
    // Pieces painted PER FACE (the ball's panels, the umbrella's gores) have to
    // be vertex soup, so accumulateNormals would flat-shade them — where the JS
    // keeps the sphere's own smooth normals through paintFaces/toNonIndexed.
    // Their analytic normals are recorded here and written back afterwards.
    std::vector<std::pair<uint32_t, float3>> smoothNormals;
    const auto smooth = [&](uint32_t idx, const mat4f& m, const float3& localDir) {
        const mat3f nm = transpose(inverse(m.upperLeft()));
        smoothNormals.emplace_back(idx, normalize(nm * normalize(localDir)));
    };
    const auto clearSpot = [&](float x, float z, float m) {
        if (!isClear(x, z, m)) return false;
        for (const auto& p : placed) {
            const float dx = x - p.x, dz = z - p.z, lim = m + p.r;
            if (dx * dx + dz * dz < lim * lim) return false;
        }
        return true;
    };
    struct Spot { float x, z, yaw; bool ok; };
    const auto findSpot = [&](float s0, float off, float m) -> Spot {
        for (float s = s0; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + off);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!clearSpot(x, z, m)) continue;
            placed.push_back({ x, z, m });
            mTerrainFlats.push_back({ x, z, m + 1.0f }); // clearing in the relief
            const float fx = -f.lat.x * side, fz = -f.lat.z * side;
            return { x, z, std::atan2(fx, fz), true };
        }
        return { 0, 0, 0, false };
    };
    const auto findSpotMid = [&](float m) -> Spot {
        float mx = 0, mz = 0;
        for (const auto& s : tb.samples) { mx += s.pos.x; mz += s.pos.z; }
        mx /= tb.samples.size(); mz /= tb.samples.size();
        for (int ring = 0; ring < 9; ring++) {
            const float rr = ring * 3.5f;
            const int n = ring == 0 ? 1 : 8;
            const float a0 = (float) rnd() * 2.0f * (float) M_PI;
            for (int k = 0; k < n; k++) {
                const float a = a0 + ((float) k / n) * 2.0f * (float) M_PI;
                const float px = mx + std::cos(a) * rr, pz = mz + std::sin(a) * rr;
                if (!clearSpot(px, pz, m)) continue;
                placed.push_back({ px, pz, m });
                mTerrainFlats.push_back({ px, pz, m + 1.0f }); // clearing in the relief
                return { px, pz, (float) rnd() * 2.0f * (float) M_PI, true };
            }
        }
        return { 0, 0, 0, false };
    };
    const auto has = [&](uint32_t k) {
        return std::find(tb.lmKinds.begin(), tb.lmKinds.end(), k) != tb.lmKinds.end();
    };
    // part(): pre-transformed prim → local offset → yaw → world, flat colour.
    const auto part = [&](const Prim& prim, float lx, float ly, float lz,
            const Spot& sp, uint32_t hex, float shade = 1.0f) {
        const mat4f m = mat4f::translation(float3{ sp.x, gy, sp.z })
                * mat4f::rotation(sp.yaw, float3{ 0, 1, 0 })
                * mat4f::translation(float3{ lx, ly, lz });
        const uint32_t c = packLinear(srgbToLinear(hex), shade);
        const uint32_t base = (uint32_t) mLandmarks.verts.size();
        for (const float3& v : prim.v) {
            const float3 w = (m * float4{ v, 1 }).xyz;
            mLandmarks.verts.push_back({ w.x, w.y, w.z, c });
        }
        for (const uint32_t i : prim.i) mLandmarks.idx.push_back(base + i);
    };
    const auto rotX = [](float a) { return mat4f::rotation(a, float3{ 1, 0, 0 }); };
    const auto rotY = [](float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); };
    const auto rotZ = [](float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); };

    // A model builder emits in its OWN local frame; this binds one to a placed
    // spot so the builder never learns where it stands (see buildRocketModel).
    const auto at = [&](const Spot& sp) {
        return [&, sp](const Prim& prim, float lx, float ly, float lz,
                uint32_t hex, float shade) { part(prim, lx, ly, lz, sp, hex, shade); };
    };

    // ---- the MODEL BENCH ---------------------------------------------------
    // Every variant of one model, in a row on the verge, all facing the road.
    // The row replaces the landmark set entirely: this is a scene for judging
    // one thing, and a doghouse behind the middle gnome is a thumb on the
    // scale. Stand on the road opposite the middle of it and the whole row is
    // side by side at near-equal distance, which is the only way a shape
    // argument gets settled.
    if (mBenchModel >= 0 && mBenchModel < MODEL_COUNT) {
        constexpr float BENCH_S0 = 26, BENCH_OFF = 4.2f;
        // Spacing is per model for the same reason the COUNT is: the rocket
        // row is one entry longer than the others AND is a narrow object, so at
        // the gnome's spacing it would run far enough up the straight to have
        // to be viewed from a distance where the shapes stop resolving — which
        // is the one thing a bench may not do.
        const float BENCH_STEP = mBenchModel == MODEL_ROCKET ? 5.6f
                : mBenchModel == MODEL_STARFISH ? 4.6f : 7.0f;
        // The ROCKET ships at 0.2 world units — a fist. Judged at that size a
        // bench tells you nothing but which one is a dot, so its row is blown
        // up and the legend says by how much. The STARFISH is clutter-sized
        // (about a unit across) and flat on the ground besides, so it gets the
        // same treatment at 3x — the row's viewpoint, not a lift, handles the
        // flatness. Nothing else is rescaled.
        const float scale = mBenchModel == MODEL_ROCKET ? 9.0f
                : mBenchModel == MODEL_STARFISH ? 3.0f : 1.0f;
        const float lift = mBenchModel == MODEL_ROCKET ? 3.1f : 0.0f;
        // A PRESENTATION YAW off square, per model, because "facing the road"
        // is not the same as "the angle this shape reads at". A gnome is a
        // front elevation and wants none; a locomotive seen nose-on is a dark
        // rectangle with a lamp on it, and everything the detail went into —
        // the boiler bands, the rods, the wheels, the cab — is edge-on to the
        // viewer. Three quarters is the angle a toy train is photographed at.
        const float present = mBenchModel == MODEL_TRAIN ? 0.85f : 0.0f;
        const int nv = modelVariantCount(mBenchModel);
        for (int v = 0; v < nv; v++) {
            // LAID OUT BACKWARDS ALONG THE TRACK, on purpose. The row faces the
            // road, so the only place it can be read from is the far verge —
            // and from there the track runs right to left. Placing v0 at the
            // FAR end puts it on the left of the one shot this whole mode
            // exists to produce, which is the order the legend lists them in.
            const float s = BENCH_S0 + (float) (nv - 1 - v) * BENCH_STEP;
            if (s > tb.length - 10) break;
            const TrackBin::Sample f = tb.frameAt(s);
            const float lat = f.width / 2 + BENCH_OFF;
            const Spot sp{ f.pos.x + f.lat.x * lat, f.pos.z + f.lat.z * lat,
                           std::atan2(-f.lat.x, -f.lat.z) + present, true };
            mShadowSpots.push_back({ sp.x, sp.z, 1.6f, 1.6f });
            const PartFn emit = [&, sp, scale, lift](const Prim& prim, float lx,
                    float ly, float lz, uint32_t hex, float shade) {
                Prim s2 = prim;
                if (scale != 1.0f) for (auto& q : s2.v) q *= scale;
                part(s2, lx * scale, ly * scale + lift, lz * scale, sp, hex, shade);
            };
            if (mBenchModel == MODEL_ROCKET) buildRocketModel(emit, v);
            else if (mBenchModel == MODEL_GNOME) buildGnomeModel(emit, v);
            else if (mBenchModel == MODEL_STARFISH)
                buildStarfishModel(emit, v, 0xe4784f); // the beach theme's first tint
            else {
                buildTrainModel(emit, v);
                // The key rides behind the loco rather than on it, which is
                // where the render loop puts it in play.
                const PartFn keyEmit = [&, sp](const Prim& prim, float lx, float ly,
                        float lz, uint32_t hex, float shade) {
                    part(prim, lx, ly + 0.9f, lz - 1.9f, sp, hex, shade);
                };
                buildTrainKeyModel(keyEmit, v);
            }
        }
        if (!mLandmarks.verts.empty()) {
            accumulateNormals(mLandmarks);
            buildMesh(mLandmarks);
        }
        return;
    }

    // The kinds run in buildLandmarks' SOURCE order (not id order): several
    // share one rand stream, so the draw order is part of the contract.

    // Both offshore pieces take their bearing from the LOWEST island of the
    // horizon ring: the tower dominates a low silhouette instead of poking out
    // of a tall dune. Anchors are authored coords — the hills' push-out scales
    // them (mHillSf), exactly as setTrack has already scaled the ring.
    const float3* lowest = nullptr;
    for (const float3& a : mHillAnchors) {
        if (!lowest || a.z < lowest->z) lowest = &a; // .z carries `top`
    }
    if (has(ttp::rt::LM_LIGHTHOUSE) && lowest) { // lighthouse — banded tower on its island
        constexpr float LH = 1.75f; // LH_SCALE (~16.5u tall)
        const Spot at{ lowest->x * mHillSf, lowest->y * mHillSf, 0, true };
        const float baseY = lowest->z - 0.8f; // sunk into the island crown
        const auto seg = [&](float r0, float r1, float h, float cy, uint32_t hex,
                int radial = 10) {
            part(primCylinder(r0 * LH, r1 * LH, h * LH, radial), 0, baseY + cy * LH, 0,
                    at, hex);
        };
        static const uint32_t BANDS[4] = { 0xf5efe2, 0xe4604a, 0xf5efe2, 0xe4604a };
        for (int i = 0; i < 4; i++) {
            const float h = 1.9f, r0 = 1.22f - (i + 1) * 0.09f, r1 = 1.22f - i * 0.09f;
            seg(r0, r1, h, i * h + h / 2, BANDS[i]);
        }
        seg(1.05f, 1.05f, 0.32f, 7.76f, 0x5c6470); // gallery deck
        seg(0.62f, 0.62f, 0.85f, 8.35f, 0xffd98a); // lamp room — warm, reads lit
        part(primCone(0.85f * LH, 0.9f * LH, 10), 0, baseY + 9.2f * LH, 0, at, 0xb2453a);
    }
    if (has(ttp::rt::LM_SAILBOAT) && mShoreFn) { // sailboat — anchored out in the shallows
        // A third of the way round from the lighthouse's island, so the two
        // never share a sight-line; radius = the shoreline ON THAT BEARING
        // plus an open-water margin.
        const float ba = (lowest ? std::atan2(lowest->y, lowest->x) : 0.0f) + 2.3f;
        const float br = mShoreFn(ba) + 22.0f;
        const float bx = std::cos(ba) * br, bz = std::sin(ba) * br;
        const float wy = gy + 0.12f; // rides ON the water sheet (WATER_LIFT)
        const float yaw = (float) rnd() * 2.0f * (float) M_PI;
        constexpr float HEEL = 0.09f; // a sailing boat leans
        const mat4f frame = mat4f::translation(float3{ bx, wy, bz })
                * rotY(yaw) * rotZ(HEEL);
        const auto bpart = [&](Prim prim, float lx, float ly, float lz, uint32_t hex) {
            const mat4f m = frame * mat4f::translation(float3{ lx, ly, lz });
            const uint32_t c = packLinear(srgbToLinear(hex), 1.0f);
            const uint32_t base = (uint32_t) mLandmarks.verts.size();
            for (const float3& v : prim.v) {
                const float3 w = (m * float4{ v, 1 }).xyz;
                mLandmarks.verts.push_back({ w.x, w.y, w.z, c });
            }
            for (const uint32_t i : prim.i) mLandmarks.idx.push_back(base + i);
        };
        // Right-triangle sail: a thin 3-prism, base dropped to y=0 and SHEARED
        // so the apex sits over the `lead` base corner — that edge becomes the
        // vertical luff, the way a sail actually hangs.
        const auto sail = [&](float sy, float sz, float lead) {
            // THREE's thetaStart π/2 lands the SAME three corners as ours (a
            // reordering, not a rotation), so only the rotateZ carries over.
            Prim g = applyPre(primCylinder(1, 1, 0.09f, 3), rotZ((float) M_PI / 2));
            const float k = (lead * 0.866f * sz) / (1.5f * sy);
            for (float3& v : g.v) {
                float3 p{ v.x, v.y * sy, v.z * sz };
                p.y += 0.5f * sy;
                p.z += k * p.y;
                v = p;
            }
            return g;
        };
        bpart(primBox(1.7f, 0.55f, 4.4f), 0, 0.2f, -0.6f, 0xd94f3d);   // hull
        bpart(applyPre(primBox(1.2f, 0.55f, 1.2f), rotY((float) M_PI / 4)),
                0, 0.2f, 1.6f, 0xd94f3d);                              // pointed stem
        bpart(primBox(1.9f, 0.34f, 4.6f), 0, 0.62f, -0.6f, 0xf7f5ee);  // gunwale band
        bpart(applyPre(primBox(1.34f, 0.34f, 1.34f), rotY((float) M_PI / 4)),
                0, 0.62f, 1.7f, 0xf7f5ee);
        bpart(primBox(1.05f, 0.5f, 1.5f), 0, 1.04f, -1.2f, 0xf3e9d8);  // cabin
        bpart(primBox(1.2f, 0.1f, 1.65f), 0, 1.33f, -1.2f, 0xd94f3d);  // cabin roof
        bpart(primCylinder(0.07f, 0.1f, 5.8f, 6), 0, 2.9f, 0.3f, 0x8a6f4d); // mast
        bpart(applyPre(primCylinder(0.06f, 0.06f, 2.5f, 6), rotX((float) M_PI / 2)),
                0, 1.55f, -0.85f, 0x8a6f4d);                           // boom
        bpart(sail(2.53f, 1.31f, 1), 0, 1.55f, -0.915f, 0xf7f5ee);     // main
        bpart(primBox(0.11f, 0.42f, 1.7f), 0, 2.3f, -0.69f, 0xd94f3d); // racing band
        bpart(sail(2.27f, 1.115f, -1), 0, 1.0f, 1.386f, 0xfdf8ec);     // jib
        bpart(applyPre(primCone(0.26f, 0.7f, 3), rotX(-(float) M_PI / 2)
                    * mat4f::scaling(float3{ 1, 1, 0.5f })),
                0, 5.85f, -0.1f, 0xd94f3d);                            // masthead pennant
    }

    if (has(ttp::rt::LM_HOODOO)) { // hoodoo — a balanced-rock family trackside (canyon)
        const uint32_t* rocks = tb.scRocks.data();
        const auto hoodoo = [&](float hx, float hz, float T) {
            const float radii[4] = { 0.20f * T, 0.15f * T, 0.115f * T, 0.095f * T };
            const float hts[3] = { 0.30f * T, 0.24f * T, 0.19f * T };
            float cy = 0;
            for (int li = 0; li < 3; li++) {
                const float ry = (float) rnd() * 2.0f * (float) M_PI;
                const Spot at{ hx, hz, 0, true };
                part(applyPre(primCylinder(radii[li + 1], radii[li], hts[li], 8), rotY(ry)),
                        0, cy + hts[li] / 2 - 0.15f, 0, at, rocks[li % 3],
                        0.9f + (float) rnd() * 0.18f);
                cy += hts[li];
            }
            const float ry = (float) rnd() * 2.0f * (float) M_PI;
            const Spot at{ hx, hz, 0, true };
            // Sequenced: C++ leaves argument evaluation order unspecified, and
            // these two draws must come off the stream in the JS's order.
            const uint32_t capCol = rocks[(size_t) std::floor(rnd() * 3)];
            const float capShade = 0.95f + (float) rnd() * 0.15f;
            part(applyPre(primIco(0.24f * T),
                        rotY(ry) * mat4f::scaling(float3{ 1, 0.62f, 0.88f })),
                    0, cy + 0.1f * T - 0.15f, 0, at, capCol, capShade);
        };
        for (float s = 35; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 6.5f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 5)) continue;
            const float3 tan = f.tangent();
            hoodoo(x, z, 8.6f); // the tall one
            hoodoo(x + tan.x * 3.8f + f.lat.x * side * 1.6f,
                   z + tan.z * 3.8f + f.lat.z * side * 1.6f, 5.4f);
            hoodoo(x - tan.x * 3.2f + f.lat.x * side * 2.2f,
                   z - tan.z * 3.2f + f.lat.z * side * 2.2f, 3.6f);
            placed.push_back({ x, z, 6 });
            mShadowSpots.push_back({ x, z, 2.4f, 6.0f });
            break; // one family is a landmark; a forest of them is scenery
        }
    }

    // NO has(4). The snowman that stood here was procedural, and the snow biome
    // plants the Holiday Kit's own instead (theme.cc, the prop scatter) — so the
    // geometry went with the placement rather than sitting here unreachable. The
    // KIND is still in LandmarkKind: renumbering that enum would rewrite every
    // biome's recorded landmark list to say nothing new.

    if (has(ttp::rt::LM_BLOCKS)) { // blocks — giant alphabet blocks (playroom)
        static const uint32_t TONES[3] = { 0xe66a5a, 0x5a8fd8, 0xf2c14e };
        const auto block = [&](float bx, float bz, float size, float cy, float yaw,
                uint32_t hex) {
            const Spot at{ bx, bz, yaw, true };
            part(primBox(size, size, size), 0, cy + size / 2, 0, at, hex,
                    0.97f + (float) rnd() * 0.06f);
            // Face panels: lighter plates proud of the four sides + the top
            // (a plain cube reads as a shipping crate).
            const float pw = size * 0.72f, t = 0.05f, off = size / 2 + t / 2 - 0.01f;
            const float PL[5][6] = {
                { off, 0, 0, t, pw, pw }, { -off, 0, 0, t, pw, pw },
                { 0, 0, off, pw, pw, t }, { 0, 0, -off, pw, pw, t },
                { 0, off, 0, pw, t, pw },
            };
            for (const auto& p : PL) {
                part(applyPre(primBox(p[3], p[4], p[5]),
                            mat4f::translation(float3{ p[0], p[1], p[2] })),
                        0, cy + size / 2, 0, at, 0xf7ead2, 0.98f);
            }
        };
        for (float s = 55; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 6.0f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 5)) continue;
            const float3 tan = f.tangent();
            block(x, z, 3.2f, 0, (float) rnd() * 0.6f, TONES[0]);
            block(x + tan.x * 3.4f + f.lat.x * side * 1.3f,
                  z + tan.z * 3.4f + f.lat.z * side * 1.3f,
                  2.6f, 0, 0.5f + (float) rnd() * 0.5f, TONES[1]);
            block(x + tan.x * 0.4f, z + tan.z * 0.4f, 2.4f, 3.2f,
                  (float) rnd() * (float) M_PI * 0.5f, TONES[2]);
            placed.push_back({ x, z, 5.5f });
            mShadowSpots.push_back({ x, z, 2.2f, 3.2f });
            break;
        }
    }

    if (has(ttp::rt::LM_DUCK)) { // duck — a chunky bath-toy spectator (playroom)
        constexpr uint32_t YELLOW = 0xf6cf46, BILL = 0xf2953c;
        for (float s = 30; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 4.2f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 3)) continue;
            const float fx = -f.lat.x * side, fz = -f.lat.z * side;
            const Spot sp{ x, z, std::atan2(fx, fz), true };
            part(applyPre(primIcoDetail(1.5f, 1),
                        mat4f::scaling(float3{ 1.1f, 0.82f, 1.35f })),
                    0, 1.2f, -0.2f, sp, YELLOW); // chesty hull
            for (const int sd : { -1, 1 }) { // wing slabs against the hull
                part(applyPre(primIcoDetail(0.8f, 1),
                            rotZ(sd * 0.22f) * rotX(-0.38f)
                                    * mat4f::scaling(float3{ 0.3f, 0.66f, 1.2f })),
                        sd * 1.44f, 1.55f, -0.45f, sp, YELLOW, 0.94f);
            }
            part(applyPre(primCone(0.55f, 1.1f, 6), rotX(-(float) M_PI / 2 - 0.65f)),
                    0, 1.75f, -1.85f, sp, YELLOW, 0.98f); // tail flicks up and aft
            part(primIcoDetail(0.9f, 1), 0, 2.72f, 0.7f, sp, YELLOW, 1.02f); // head
            part(applyPre(primIcoDetail(0.5f, 1),
                        mat4f::scaling(float3{ 1.7f, 0.45f, 1.15f })),
                    0, 2.55f, 1.5f, sp, BILL); // one broad smiling paddle
            for (const int sd : { -1, 1 }) { // eyes wide apart on the sides
                part(primIcoDetail(0.14f, 1), sd * 0.68f, 2.99f, 1.23f, sp, 0x343a44);
            }
            placed.push_back({ x, z, 3 });
            mShadowSpots.push_back({ x, z, 1.6f, 2.7f });
            break;
        }
    }

    if (has(ttp::rt::LM_BALL)) { // ball — the classic panelled play ball (playroom)
        constexpr float BR = 1.5f;
        static const uint32_t PANELS[6] = { 0xdf4a3c, 0xf5f2ea, 0x3f6fd1,
                                            0xf5f2ea, 0xf2c14e, 0xf5f2ea };
        for (float s = 85; s < tb.length - 10; s += 3) {
            const TrackBin::Sample f = tb.frameAt(s);
            if (f.pos.y - gy > 0.8f) continue;
            const int side = rnd() < 0.5 ? -1 : 1;
            const float lat = side * (f.width / 2 + 4.8f);
            const float x = f.pos.x + f.lat.x * lat, z = f.pos.z + f.lat.z * lat;
            if (!isClear(x, z, 2.8f)) continue;
            // Panels are painted PER FACE by centroid longitude (per-vertex
            // lerping smears the seams) with white polar caps cut at a whole
            // latitude ring, then the ball is tilted — a settled ball never
            // sits pole-up, and the tilt is what makes the panels read.
            const Prim sph = primSphere(BR, 14, 10);
            const float rz = 0.35f + (float) rnd() * 0.4f;
            const float ry = (float) rnd() * 2.0f * (float) M_PI;
            const mat4f m = mat4f::translation(float3{ x, gy + BR * 0.92f, z })
                    * rotY(ry) * rotZ(rz);
            constexpr float CAP_LAT = (float) M_PI / 6;
            for (size_t t = 0; t + 2 < sph.i.size(); t += 3) {
                const float3 a = sph.v[sph.i[t]], b = sph.v[sph.i[t + 1]];
                const float3 c = sph.v[sph.i[t + 2]];
                const float3 ctr = (a + b + c) / 3.0f;
                const float polar = std::acos(ctr.y / std::max(1e-6f, length(ctr)));
                const uint32_t hex = (polar < CAP_LAT || polar > (float) M_PI - CAP_LAT)
                        ? 0xf5f2eau
                        : PANELS[(size_t) std::floor(
                                ((std::atan2(ctr.z, ctr.x) + (float) M_PI)
                                        / (2 * (float) M_PI)) * 6) % 6];
                const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                const uint32_t base = (uint32_t) mLandmarks.verts.size();
                for (const float3& v : { a, b, c }) {
                    const float3 w = (m * float4{ v, 1 }).xyz;
                    smooth((uint32_t) mLandmarks.verts.size(), m, v);
                    mLandmarks.verts.push_back({ w.x, w.y, w.z, col });
                }
                mLandmarks.idx.insert(mLandmarks.idx.end(), { base, base + 1, base + 2 });
            }
            placed.push_back({ x, z, 2.5f });
            mShadowSpots.push_back({ x, z, 1.5f, 3.0f });
            break;
        }
    }

    if (has(ttp::rt::LM_UMBRELLA)) { // umbrella — a day at the beach
        const Spot sp = findSpot(45, 5.2f, 4);
        if (sp.ok) {
            constexpr float TILT = 0.2f; // leans gently toward the road
            // The pole runs UP INTO the dome, so the fabric hangs off its stick.
            part(applyPre(primCylinder(0.07f, 0.09f, 4.1f, 8),
                        rotX(TILT) * mat4f::translation(float3{ 0, 2.05f, 0 })),
                    0, 0, 0, sp, 0xf0e6d4);
            // Canopy: coral/cream gores by longitude, per face. TWO shells —
            // the landmark material is single-sided, so a lone dome vanishes
            // from below; a smaller inner copy with flipped winding lines it.
            for (const bool inner : { false, true }) {
                const Prim dome = primSphereBand(inner ? 1.97f : 2.0f, 20, 5,
                        0, (float) M_PI / 2.15f);
                const mat4f m = mat4f::translation(float3{ sp.x, gy, sp.z })
                        * rotY(sp.yaw) * rotX(TILT)
                        * mat4f::translation(float3{ 0, 3.06f, 0 })
                        * mat4f::scaling(float3{ 1, 0.62f, 1 });
                for (size_t t = 0; t + 2 < dome.i.size(); t += 3) {
                    const float3 a = dome.v[dome.i[t]], b = dome.v[dome.i[t + 1]];
                    const float3 c = dome.v[dome.i[t + 2]];
                    const float3 ctr = (a + b + c) / 3.0f;
                    const int gore = (int) std::floor(
                            ((std::atan2(ctr.z, ctr.x) + (float) M_PI)
                                    / (2 * (float) M_PI)) * 10) % 2;
                    const uint32_t col = packLinear(
                            srgbToLinear(gore ? 0xe4604a : 0xf7f0e2),
                            inner ? 0.72f : 1.0f);
                    const uint32_t base = (uint32_t) mLandmarks.verts.size();
                    for (const float3& v : { a, b, c }) {
                        const float3 w = (m * float4{ v, 1 }).xyz;
                        smooth((uint32_t) mLandmarks.verts.size(), m, inner ? -v : v);
                        mLandmarks.verts.push_back({ w.x, w.y, w.z, col });
                    }
                    if (inner) {
                        mLandmarks.idx.insert(mLandmarks.idx.end(),
                                { base, base + 2, base + 1 }); // faces down/inward
                    } else {
                        mLandmarks.idx.insert(mLandmarks.idx.end(),
                                { base, base + 1, base + 2 });
                    }
                }
            }
            part(applyPre(primSphere(0.11f, 8, 6),
                        rotX(TILT) * mat4f::translation(float3{ 0, 4.36f, 0 })),
                    0, 0, 0, sp, 0xe4604a); // finial caps the crown
            part(primBox(2.7f, 0.06f, 1.5f), 2.5f, 0.05f, 0.5f, sp, 0x5fc4b8);  // towel
            part(primBox(2.7f, 0.075f, 0.34f), 2.5f, 0.05f, 1.05f, sp, 0xf7f0e2);
            part(primBox(0.7f, 0.5f, 0.45f), -2.1f, 0.27f, 0.4f, sp, 0xd8463f); // cooler
            part(primBox(0.74f, 0.14f, 0.49f), -2.1f, 0.59f, 0.4f, sp, 0xf5f0e2);
            mShadowSpots.push_back({ sp.x, sp.z, 2.2f, 4.4f });
        }
    }

    if (has(ttp::rt::LM_SANDCASTLE)) { // sandcastle — a bucket-castle at sandbox scale
        Spot sp = findSpotMid(3.2f);
        if (!sp.ok) sp = findSpot(80, 6.0f, 3.2f);
        if (sp.ok) {
            static const uint32_t SAND[2] = { 0xe8d49e, 0xdfc98e };
            constexpr float S = 0.44f;
            const float KR = 0.8f * S, KH = 1.9f * S;
            part(primCylinder(KR * 0.94f, KR, KH, 10), 0, KH / 2, 0, sp, SAND[0], 1.02f);
            part(primCylinder(KR * 0.98f, KR * 0.94f, 0.1f * S, 10),
                    0, KH + 0.05f * S, 0, sp, SAND[1]);
            for (int mi = 0; mi < 6; mi++) { // the crenellations
                const float ma = ((float) mi / 6) * 2.0f * (float) M_PI + 0.26f;
                part(applyPre(primBox(0.34f * S, 0.3f * S, 0.16f * S), rotY(-ma)),
                        std::cos(ma) * KR * 0.82f, KH + 0.22f * S,
                        std::sin(ma) * KR * 0.82f, sp, SAND[1], 1.04f);
            }
            const auto tower = [&](float lx, float lz, float r, float h) {
                part(primCylinder(r * 0.92f, r, h, 10), lx, h / 2, lz, sp, SAND[0], 1.02f);
                part(primCone(r * 1.08f, r * 0.9f, 10), lx, h + r * 0.42f, lz, sp,
                        SAND[1], 0.96f);
            };
            for (const int tx2 : { 1, -1 }) {
                for (const int tz2 : { 1, -1 }) {
                    tower(tx2 * 1.35f * S, tz2 * 1.35f * S, 0.5f * S, 1.2f * S);
                }
            }
            const float W[4][4] = { { 0, 1.35f * S, 1.9f * S, 0.3f * S },
                                    { 0, -1.35f * S, 1.9f * S, 0.3f * S },
                                    { 1.35f * S, 0, 0.3f * S, 1.9f * S },
                                    { -1.35f * S, 0, 0.3f * S, 1.9f * S } };
            for (const auto& w : W) { // curtain walls
                part(primBox(w[2], 0.75f * S, w[3]), w[0], 0.37f * S, w[1], sp,
                        SAND[0], 0.94f);
            }
            part(primBox(0.5f * S, 0.5f * S, 0.12f * S), 0, 0.25f * S, 1.5f * S,
                    sp, 0x6b5a3e); // dark gateway
            const float SH[3][2] = { { 0.8f, 2.1f }, { 2.4f, 2.4f }, { 4.2f, 2.2f } };
            for (const auto& sh : SH) { // shells dotted around the base
                part(applyPre(primSphereBand(0.16f * S, 8, 4, 0, (float) M_PI / 2),
                            rotY(sh[0]) * mat4f::scaling(float3{ 1, 0.5f, 1.15f })),
                        std::cos(sh[0]) * sh[1] * S, 0.02f,
                        std::sin(sh[0]) * sh[1] * S, sp, 0xecc8b4, 1.02f);
            }
            part(primCylinder(0.03f, 0.03f, 0.8f * S, 6), 0, KH + 0.6f * S, 0, sp, 0x8a6f4d);
            part(applyPre(primCone(0.16f * S, 0.5f * S, 3), rotZ(-(float) M_PI / 2)),
                    0.3f * S, KH + 0.85f * S, 0, sp, 0xd94f3d); // pennant
            mShadowSpots.push_back({ sp.x, sp.z, 1.4f, 1.2f });
        }
    }

    if (has(ttp::rt::LM_WINDMILL)) { // windmill — a western water-pump derrick with a spinning rotor
        const Spot sp = findSpot(70, 13 + (float) rnd() * 5, 5);
        if (sp.ok) {
            constexpr float H = 10.5f; // hub height
            constexpr uint32_t TIMBER = 0x9a7050, STEEL = 0xc6cbd6;
            // Four legs leaning in from a 2.7-square base to a 0.7-square top.
            for (const int sx2 : { 1, -1 }) {
                for (const int sz2 : { 1, -1 }) {
                    const float3 dir{ (0.35f - 1.35f) * sx2, H, (0.35f - 1.35f) * sz2 };
                    const float len = length(dir);
                    const quatf q = quatf::fromDirectedRotation(float3{ 0, 1, 0 },
                            normalize(dir));
                    part(applyPre(primCylinder(0.1f, 0.15f, len, 6),
                                mat4f(q) * mat4f::translation(float3{ 0, len / 2, 0 })),
                            1.35f * sx2, 0, 1.35f * sz2, sp, TIMBER,
                            0.94f + ((sx2 + sz2 + 2) % 3) * 0.04f);
                }
            }
            for (const float bh : { 3.6f, 7.0f }) { // two brace frames
                const float hw = 1.35f + (0.35f - 1.35f) * (bh / H);
                const float B[4][4] = { { 0, hw, hw * 2 + 0.2f, 0.09f },
                                        { 0, -hw, hw * 2 + 0.2f, 0.09f },
                                        { hw, 0, 0.09f, hw * 2 + 0.2f },
                                        { -hw, 0, 0.09f, hw * 2 + 0.2f } };
                for (const auto& b : B) {
                    part(primBox(b[2], 0.09f, b[3]), b[0], bh, b[1], sp, TIMBER, 0.9f);
                }
            }
            part(primBox(1.35f, 0.14f, 1.35f), 0, H + 0.07f, 0, sp, TIMBER, 1.05f);
            part(primBox(0.45f, 0.4f, 0.8f), 0, H + 0.35f, 0.05f, sp, STEEL, 0.9f);
            part(primBox(0.08f, 0.08f, 1.6f), 0, H + 0.35f, -0.95f, sp, STEEL, 0.85f);
            part(primBox(0.05f, 0.75f, 0.9f), 0, H + 0.42f, -1.85f, sp, 0xd8463f);
            // The rotor is its own mesh — the render loop spins it about the
            // facing axis (the JS registers it with the per-track anim list).
            {
                const auto rpart = [&](const Prim& prim, uint32_t hex, float shade) {
                    const uint32_t c = packLinear(srgbToLinear(hex), shade);
                    const uint32_t base = (uint32_t) mWindmill.verts.size();
                    for (const float3& v : prim.v) {
                        mWindmill.verts.push_back({ v.x, v.y, v.z, c });
                    }
                    for (const uint32_t i : prim.i) mWindmill.idx.push_back(base + i);
                };
                rpart(applyPre(primCylinder(0.22f, 0.22f, 0.2f, 10),
                            rotX((float) M_PI / 2)), STEEL, 1.05f);
                for (int bi = 0; bi < 12; bi++) { // 12 flat blades fanned in XY
                    rpart(applyPre(primBox(0.3f, 1.8f, 0.04f),
                                rotZ(((float) bi / 12) * 2.0f * (float) M_PI)
                                        * mat4f::translation(float3{ 0, 1.1f, 0 })),
                            STEEL, 0.92f + (bi % 3) * 0.05f);
                }
                rpart(applyPre(primTorusArc(1.95f, 0.045f, 6, 28, 2.0f * (float) M_PI),
                            rotX((float) M_PI / 2)), STEEL, 0.88f); // the outer band
                accumulateNormals(mWindmill);
                buildMesh(mWindmill);
                const float fx = std::sin(sp.yaw), fz = std::cos(sp.yaw);
                mWindmillBase = mat4f::translation(
                        float3{ sp.x + fx * 0.75f, gy + H + 0.35f, sp.z + fz * 0.75f })
                        * mat4f::rotation(sp.yaw, float3{ 0, 1, 0 });
            }
            mShadowSpots.push_back({ sp.x, sp.z, 2.0f, 10.5f });
        }
    }

    if (has(ttp::rt::LM_CABIN)) { // cabin — a log cabin with smoke curling from the chimney
        const Spot sp = findSpot(65, 10 + (float) rnd() * 5, 5);
        if (sp.ok) {
            constexpr uint32_t LOG = 0x8a6142, LOG2 = 0x7a5438, SNOWC = 0xf3f7fb;
            for (int row = 0; row < 5; row++) { // log courses
                const float ly = 0.26f + row * 0.5f;
                for (const float zoff : { 1.8f, -1.8f }) { // front/back along local X
                    part(applyPre(primCylinder(0.26f, 0.26f, 5.0f, 7),
                                rotZ((float) M_PI / 2)),
                            0, ly, zoff, sp, row % 2 ? LOG : LOG2,
                            0.97f + (row % 3) * 0.03f);
                }
                for (const float xoff : { 2.3f, -2.3f }) { // sides, half a course up
                    part(applyPre(primCylinder(0.26f, 0.26f, 4.0f, 7),
                                rotX((float) M_PI / 2)),
                            xoff, ly + 0.25f, 0, sp, row % 2 ? LOG2 : LOG,
                            0.96f + (row % 2) * 0.04f);
                }
            }
            for (int gi = 0; gi < 3; gi++) { // gable ends shorten toward the ridge
                const float ly = 2.76f + gi * 0.48f;
                for (const float zoff : { 1.8f, -1.8f }) {
                    part(applyPre(primCylinder(0.24f, 0.24f, 3.4f - gi * 1.1f, 7),
                                rotZ((float) M_PI / 2)),
                            0, ly, zoff, sp, gi % 2 ? LOG : LOG2);
                }
            }
            for (const int sd : { -1, 1 }) { // snow-heaped roof slabs
                part(applyPre(primBox(3.05f, 0.22f, 5.4f), rotZ(sd * 0.6f)),
                        sd * -1.2f, 3.6f, 0, sp, SNOWC);
            }
            part(applyPre(primCylinder(0.18f, 0.18f, 5.45f, 7), rotX((float) M_PI / 2)),
                    0, 4.32f, 0, sp, SNOWC, 0.98f); // snow-capped ridge log
            part(primBox(0.9f, 1.5f, 0.14f), 0.95f, 0.75f, 1.98f, sp, 0x4a3a2e);  // door
            part(primBox(0.78f, 0.68f, 0.14f), -1.0f, 1.35f, 1.98f, sp, 0xffd98a); // lit window
            part(primBox(0.92f, 0.1f, 0.16f), -1.0f, 1.74f, 1.99f, sp, 0x4a3a2e);  // lintel
            part(primBox(0.55f, 2.3f, 0.55f), -0.95f, 3.5f, -0.95f, sp, 0x9fa8ba); // chimney
            part(primBox(0.68f, 0.14f, 0.68f), -0.95f, 4.68f, -0.95f, sp, 0xb9c1d0);
            // Chimney smoke: three soft puffs rising, growing and fading on a
            // staggered loop (the JS sprites, as blend quads billboarded per cell).
            {
                const float cy2 = std::cos(sp.yaw), sy2 = std::sin(sp.yaw);
                mSmokeOrigin = { sp.x + (-0.95f) * cy2 + (-0.95f) * sy2,
                                 gy + 4.75f,
                                 sp.z - (-0.95f) * sy2 + (-0.95f) * cy2 };
                if (mBlendMaterial) {
                    mSmoke.resize(3);
                    const BlurKernel blur(6.0f);
                    // 8px cells: the 6px blur spreads the disc edge over ~12px
                    // of the 64×64 field, so every gradient still gets a sample.
                    constexpr int NX = 8, NY = 8;
                    for (Mesh& m : mSmoke) {
                        for (int j = 0; j <= NY; j++) {
                            for (int k = 0; k <= NX; k++) {
                                const float px = (float) k / NX * 64.0f;
                                const float py = (float) j / NY * 64.0f;
                                const float cov = blur.coverage(px, py,
                                        [](float bx, float by) {
                                            const float dx = bx - 32, dy = by - 32;
                                            return dx * dx + dy * dy <= 18 * 18;
                                        });
                                m.verts.push_back({ (float) k / NX - 0.5f,
                                                    0.5f - (float) j / NY, 0,
                                                    packLinear(srgbToLinear(0xeef2f6),
                                                            1.0f, cov) });
                            }
                        }
                        for (int j = 0; j < NY; j++) {
                            for (int k = 0; k < NX; k++) {
                                const uint32_t b = (uint32_t) (j * (NX + 1) + k);
                                const uint32_t n = b + (uint32_t) (NX + 1);
                                m.idx.insert(m.idx.end(), { b, n, b + 1, b + 1, n, n + 1 });
                            }
                        }
                        buildMesh(m, true, mBlendMaterial->getDefaultInstance(), 5);
                    }
                }
            }
            mShadowSpots.push_back({ sp.x, sp.z, 3.0f, 4.3f });
        }
    }

    if (has(ttp::rt::LM_GNOME)) { // gnome
        const Spot sp = findSpot(30, 3.4f, 2.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 0.9f, 1.2f });
            buildGnomeModel(at(sp), mModelVariant[MODEL_GNOME]);
        }
    }
    if (has(ttp::rt::LM_DOGHOUSE)) { // doghouse
        const float off = 8 + (float) rnd() * 3;
        const Spot sp = findSpot(60, off, 3.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 2.3f, 1.4f });
            const uint32_t WALL = 0xc4573f, ROOF = 0x5e4434, TRIM = 0xf5f0e2, DARK = 0x3a3040;
            part(primBox(2.3f, 1.5f, 2.6f), 0, 0.75f, 0, sp, WALL);
            part(applyPre(primBox(1.64f, 1.64f, 2.55f), rotZ((float) M_PI / 4)), 0, 1.5f, 0, sp, WALL, 0.98f);
            for (const int sd : { -1, 1 })
                part(applyPre(primBox(1.85f, 0.13f, 3.0f), rotZ(sd * -(float) M_PI / 4)),
                        sd * 0.62f, 2.08f, 0, sp, ROOF);
            part(applyPre(primBox(0.26f, 0.26f, 3.05f), rotZ((float) M_PI / 4)), 0, 2.7f, 0, sp, ROOF, 1.12f);
            part(primBox(1.0f, 0.98f, 0.1f), 0, 0.49f, 1.31f, sp, TRIM);
            part(applyPre(primCylinder(0.5f, 0.5f, 0.1f, 12), rotX((float) M_PI / 2)), 0, 0.98f, 1.31f, sp, TRIM);
            part(primBox(0.84f, 0.84f, 0.12f), 0, 0.42f, 1.33f, sp, DARK);
            part(applyPre(primCylinder(0.42f, 0.42f, 0.12f, 12), rotX((float) M_PI / 2)), 0, 0.84f, 1.33f, sp, DARK);
            part(primCylinder(0.32f, 0.26f, 0.2f, 10), 1.35f, 0.1f, 1.7f, sp, 0xd8463f);
            const float boneYaw = 0.7f;
            part(applyPre(primCylinder(0.07f, 0.07f, 0.55f, 6), rotY(boneYaw) * rotZ((float) M_PI / 2)),
                    -1.15f, 0.08f, 1.55f, sp, 0xf3ecdc);
            for (const int be : { -1, 1 }) for (const int bs : { -1, 1 }) {
                part(applyPre(primSphere(0.09f, 6, 5),
                        rotY(boneYaw) * mat4f::translation(float3{ be * 0.28f, 0, bs * 0.07f })),
                        -1.15f, 0.09f, 1.55f, sp, 0xf3ecdc);
            }
        }
    }
    if (has(ttp::rt::LM_PICNIC)) { // picnic
        Spot sp = findSpotMid(3.2f);
        if (!sp.ok) sp = findSpot(95, 4.8f, 3.2f);
        if (sp.ok) {
            mShadowSpots.push_back({ sp.x, sp.z, 2.1f, 0.4f });
            // Blanket: 5×5 chequer grid, thrown slightly askew.
            const Spot bsp = { sp.x, sp.z, sp.yaw + 0.26f, true };
            const float CELL = 3.4f / 5;
            for (int gx = 0; gx < 5; gx++) for (int gz = 0; gz < 5; gz++) {
                // paintFaces keys checks on centroid/0.68 — same parity here
                const uint32_t col = ((gx + gz) % 2) ? 0xd8463f : 0xf5f0e2;
                Prim q = primBox(CELL, 0.06f, CELL);
                part(q, -1.7f + (gx + 0.5f) * CELL, 0.04f, -1.7f + (gz + 0.5f) * CELL, bsp, col);
            }
            part(primBox(0.85f, 0.55f, 0.55f), 0.7f, 0.3f, 0.6f, sp, 0x8a6f4d);
            part(applyPre(primTorusArc(0.3f, 0.05f, 8, 14, (float) M_PI), rotY((float) M_PI / 2)),
                    0.7f, 0.57f, 0.6f, sp, 0x6e563c);
            part(primBox(0.72f, 0.5f, 0.5f), -0.85f, 0.29f, -0.7f, sp, 0xd8463f);
            part(primBox(0.76f, 0.14f, 0.54f), -0.85f, 0.6f, -0.7f, sp, 0xf5f0e2);
            part(primCylinder(0.22f, 0.22f, 0.04f, 12), -0.35f, 0.07f, 0.9f, sp, 0xf7f5ee);
            part(primCylinder(0.22f, 0.22f, 0.04f, 12), 0.55f, 0.07f, -0.55f, sp, 0xf7f5ee);
        }
    }

    if (has(ttp::rt::LM_CRAYONS)) { // crayons — four fat wax sticks spilled, a fifth thrown across
        const Spot sp = findSpot(110, 4.4f, 3);
        if (sp.ok) {
            static const uint32_t COLS[5] = { 0xd8463f, 0x3f6fd1, 0x3fa14e,
                                              0xf2a83c, 0x8a76d8 };
            const float a0 = (float) rnd() * 2.0f * (float) M_PI; // the spill's heading
            const float px2 = std::sin(a0), pz2 = std::cos(a0);   // spread axis
            for (int i = 0; i < 5; i++) {
                const bool onTop = i == 4;
                const float ai = onTop ? a0 + 1.25f
                                       : a0 + ((float) rnd() - 0.5f) * 0.2f;
                const float off = onTop ? 0.15f : (i - 1.5f) * 0.6f;
                const float slide = onTop ? 0.0f : ((float) rnd() - 0.5f) * 0.8f;
                const float ox = px2 * off + std::cos(ai) * slide;
                const float oz = pz2 * off - std::sin(ai) * slide;
                const float lift = onTop ? 0.33f : 0.0f;
                const Spot at{ sp.x, sp.z, 0, true };
                const auto make = [&](Prim g, uint32_t hex, float shade) {
                    part(applyPre(g, rotY(ai) * rotZ((float) M_PI / 2)),
                            ox, 0.17f + lift, oz, at, hex, shade);
                };
                make(primCylinder(0.16f, 0.16f, 2.3f, 9), COLS[i], 1.0f);
                make(applyPre(primCone(0.16f, 0.42f, 9),
                            mat4f::translation(float3{ 0, 1.36f, 0 })), COLS[i], 1.08f);
                make(primCylinder(0.18f, 0.18f, 1.3f, 9), COLS[i], 0.88f); // paper band
            }
            mShadowSpots.push_back({ sp.x, sp.z, 1.4f, 0.4f });
        }
    }

    if (has(ttp::rt::LM_BOOKS)) { // books — three stacked picture books, spines askew
        const Spot sp = findSpot(130, 8 + (float) rnd() * 3, 3);
        if (sp.ok) {
            static const uint32_t COVERS[3] = { 0x3f6fd1, 0xd8463f, 0x3fa14e };
            float ty = 0;
            for (int i = 0; i < 3; i++) {
                const float w = 2.6f - i * 0.35f, d = 1.9f - i * 0.22f, h = 0.42f;
                const float a = ((float) rnd() - 0.5f) * 0.7f;
                const Spot at{ sp.x, sp.z, a, true };
                part(primBox(w - 0.18f, h - 0.13f, d - 0.12f), 0.06f, ty + h / 2, 0,
                        at, 0xf7f5ee);
                part(primBox(w, 0.07f, d), 0, ty + h - 0.035f, 0, at, COVERS[i]);
                part(primBox(w, 0.07f, d), 0, ty + 0.035f, 0, at, COVERS[i], 0.94f);
                part(primBox(0.1f, h, d), -w / 2 + 0.05f, ty + h / 2, 0, at,
                        COVERS[i], 0.88f);
                ty += h;
            }
            mShadowSpots.push_back({ sp.x, sp.z, 1.5f, 1.3f });
        }
    }

    // NO LM_TRAIN. The wind-up loco that ran an oval here is the Holiday Kit's
    // own train set now — a composed model on the playroom's prop scatter
    // (scripts/gen-trainset.mjs, theme.cc) — so the oval, its sleepers and the
    // per-frame walk went with the placement. buildTrainModel SURVIVES in
    // TtpRendererKit.h: it is the asset gallery's model bench, which is where
    // retired shapes live.

    if (!mLandmarks.verts.empty()) {
        accumulateNormals(mLandmarks);
        for (const auto& [idx, n] : smoothNormals) {
            if (idx < mLandmarks.normals.size()) mLandmarks.normals[idx] = n;
        }
        buildMesh(mLandmarks);
    }
}

// Instanced prop pool (item boxes, bananas): one shared GLB, `count` instances,
// each posed independently via its root. Unused pool entries park underground.
gltfio::FilamentAsset* TtpRenderer::loadInstancedProp(const char* assetName,
        size_t count, std::vector<gltfio::FilamentInstance*>& out,
        bool shareMaterials) {
    const auto it = mAssets.find(assetName);
    if (it == mAssets.end() || count == 0) return nullptr;
    ensureAssetLoader();
    out.assign(count, nullptr);
    gltfio::FilamentAsset* asset = mAssetLoader->createInstancedAsset(
            it->second.data(), (uint32_t) it->second.size(), out.data(), count);
    if (!asset) { out.clear(); return nullptr; }
    registerAssetUris(asset);
    if (!mResourceLoader->loadResources(asset)) {
        mAssetLoader->destroyAsset(asset);
        out.clear();
        return nullptr;
    }
    asset->releaseSourceData();
    for (auto* inst : out) {
        mScene->addEntities(inst->getEntities(), inst->getEntityCount());
        // Props and scenery are not shadow casters in the JS either (each
        // floating prop carries its own baked contact blob instead).
        setShadows(inst->getEntities(), inst->getEntityCount(), false, false);
    }
    // The merged draw groups: decode this model's meshes once (keyed by its
    // bytes) and let the next frame regroup the dressing. Pools this covers
    // that buildDressingMerge does NOT merge (the item boxes and their fade
    // twins) just carry an unused cache entry.
    const uint64_t meshKey = glbBytesKey(it->second);
    mAssetMeshKey[asset] = meshKey;
    glbMeshes(meshKey, it->second);
    mDressMergeDirty = true;
    // Point every instance at instance 0's materials. gltfio hands each
    // FilamentInstance its own MaterialInstance so they can be tinted apart —
    // we tint per MODEL, not per instance (the box fade pool is the one
    // exception, and opts out via shareMaterials) — and that alone stops Filament's
    // automatic instancing from batching them, since it needs identical
    // geometry AND the same MaterialInstance. Fifty trees were fifty draw
    // calls; three merges its scenery into one mesh for the same reason.
    auto& rcm = mEngine->getRenderableManager();
    if (shareMaterials && out.size() > 1 && out[0]) {
        const size_t nEnt = out[0]->getEntityCount();
        for (size_t i = 1; i < out.size(); i++) {
            if (!out[i] || out[i]->getEntityCount() != nEnt) continue;
            for (size_t e = 0; e < nEnt; e++) {
                const auto ri0 = rcm.getInstance(out[0]->getEntities()[e]);
                const auto ri = rcm.getInstance(out[i]->getEntities()[e]);
                if (!ri0 || !ri) continue;
                const size_t prims = std::min(rcm.getPrimitiveCount(ri),
                        rcm.getPrimitiveCount(ri0));
                for (size_t p = 0; p < prims; p++) {
                    rcm.setMaterialInstanceAt(ri, p, rcm.getMaterialInstanceAt(ri0, p));
                }
            }
        }
    }
    return asset;
}

// The sea ring (theme.water): a flat ring around the play field whose radial
// vertex-colour bands sell the read — a bright foam line at the shore, then
// turquoise shallows deepening to blue out past the fog — plus the wet-sand
// glaze hugging the inside of the waterline. The shoreline is per-ANGLE, fitted
// to the track's own convex support (fitWater/shorelineFn), so an oval circuit
// gets an oval island and the surf never floods the road.
void TtpRenderer::buildWater(const TrackBin& tb) {
    if (!tb.hasWater || !mBlendMaterial) return;
    constexpr float WATER_INNER = 135.0f, WATER_LIFT = 0.12f;
    constexpr float WATER_SHADE = 1.0f; // the flat sheet's constant Lambert term
    // 144 spokes = 2.5° steps: chord sag at the shore radius is ~0.03u and the
    // sharpest crinkle harmonic (29·a) still gets ~5 samples per cycle.
    constexpr int SEG = 144;
    constexpr float SHORE_MARGIN = 26, SHORE_WOBBLE = 22, SHORE_CRINKLE = 2.6f;
    constexpr float SHORE_FADE = 220, SWASH_RANGE = 0.62f, SWASH_ZONE = 20;
    // [radius, colour param (0..2 = foam→shallow→deep), alpha]
    static const float BANDS[9][3] = {
        { WATER_INNER,        0,     0    },
        { WATER_INNER + 1.2f, 0,     0.9f },
        { WATER_INNER + 4.0f, 0,     0.92f },
        { WATER_INNER + 4.4f, 0.8f,  0.88f },
        { WATER_INNER + 9,    0.9f,  0.86f },
        { WATER_INNER + 20,   1,     0.95f },
        { WATER_INNER + 60,   1.55f, 1 },
        { WATER_INNER + 180,  2,     1 },
        { 2600,               2,     1 },
    };
    static const float WET[5][2] = { // [radius, alpha]
        { WATER_INNER - 13,   0 },
        { WATER_INNER - 8.5f, 0.10f },
        { WATER_INNER - 8.0f, 0.24f },
        { WATER_INNER - 2,    0.42f },
        { WATER_INNER + 2.5f, 0.5f },
    };
    static const float SHORE_H[4][2] = { { 2, 1 }, { 3, 0.72f }, { 5, 0.44f }, { 7, 0.26f } };
    static const float CRINKLE_H[3][2] = { { 11, 1 }, { 17, 0.62f }, { 29, 0.34f } };
    static const float SWASH_H[3][2] = { { 3, 1 }, { 7, 0.55f }, { 13, 0.3f } };

    uint32_t seed = tb.shoreSeed;
    const auto rnd = [&]() {
        seed = seed * 1664525u + 1013904223u;
        return (float) ((double) seed / 4294967296.0);
    };
    float shorePh[4], crinklePh[3], swashPh[3];
    for (float& p : shorePh) p = rnd() * 2.0f * (float) M_PI;
    for (float& p : crinklePh) p = rnd() * 2.0f * (float) M_PI;
    for (float& p : swashPh) p = rnd() * 2.0f * (float) M_PI;
    const auto harm = [](const float (*h)[2], int n, const float* ph, float a) {
        float sum = 0, w = 0;
        for (int i = 0; i < n; i++) { sum += h[i][1] * std::sin(h[i][0] * a + ph[i]); w += h[i][1]; }
        return sum / w;
    };
    // Convex support of the track's samples at this bearing + the lobes/crinkle.
    const auto shoreAt = [&](float a) {
        const float cx = std::cos(a), cz = std::sin(a);
        float support = 0;
        for (const auto& s : tb.samples) {
            support = std::max(support, s.pos.x * cx + s.pos.z * cz);
        }
        return support + SHORE_MARGIN
                + SHORE_WOBBLE * (0.5f + 0.5f * harm(SHORE_H, 4, shorePh, a))
                + SHORE_CRINKLE * harm(CRINKLE_H, 3, crinklePh, a);
    };
    mShoreFn = shoreAt; // the sailboat anchors off the same curve
    std::vector<float> cosA(SEG + 1), sinA(SEG + 1), shoreR(SEG + 1), swashF(SEG + 1);
    float outer = 0;
    for (int si = 0; si <= SEG; si++) {
        const float a = (float) (si % SEG) / SEG * 2.0f * (float) M_PI;
        cosA[si] = std::cos(a); sinA[si] = std::sin(a);
        shoreR[si] = shoreAt(a);
        swashF[si] = 1 + SWASH_RANGE * harm(SWASH_H, 3, swashPh, a);
        outer = std::max(outer, shoreR[si]);
    }
    const float y = tb.groundY + WATER_LIFT;
    const float3 foam = srgbToLinear(tb.waterFoam);
    const float3 shallow = srgbToLinear(tb.waterShallow);
    const float3 deep = srgbToLinear(tb.waterDeep);
    const auto ringMesh = [&](Mesh& m, const std::function<float(int)>& radiusAt,
            int rings, bool fade, float lift,
            const std::function<uint32_t(int)>& colAt) {
        for (int ri = 0; ri < rings; ri++) {
            const float off = radiusAt(ri) - WATER_INNER;
            // The outline relaxes back to a circle as the water deepens — out
            // past the fog the far rings only need to reach the sky.
            const float t = fade ? std::min(1.0f, std::fabs(off) / SHORE_FADE) : 0.0f;
            const float sw = std::max(0.0f, 1 - std::fabs(off) / SWASH_ZONE);
            const uint32_t c = colAt(ri);
            for (int si = 0; si <= SEG; si++) {
                const float r = shoreR[si] * (1 - t) + outer * t
                        + off * (1 + (swashF[si] - 1) * sw);
                m.verts.push_back({ cosA[si] * r, y + lift, sinA[si] * r, c });
            }
        }
        const uint32_t verts = SEG + 1;
        for (int ri = 0; ri + 1 < rings; ri++) {
            for (int si = 0; si < SEG; si++) {
                const uint32_t a = ri * verts + si, b = a + verts;
                m.idx.insert(m.idx.end(), { a, a + 1, b, a + 1, b + 1, b });
            }
        }
    };
    // Damp sand first (it draws under the sea), then the sheet.
    {
        const uint32_t wet = tb.waterWet;
        ringMesh(mWet, [](int ri) { return WET[ri][0]; }, 5, false, -0.05f, [&](int ri) {
            return packLinear(srgbToLinear(wet), 1.0f, WET[ri][1]);
        });
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-1.0f, -1.0f);
        buildMesh(mWet, true, mi, 1);
    }
    {
        ringMesh(mWater, [](int ri) { return BANDS[ri][0]; }, 9, true, 0.0f, [&](int ri) {
            const float t = BANDS[ri][1];
            const float3 c = t <= 1 ? mix(foam, shallow, t) : mix(shallow, deep, t - 1);
            return packLinear(c, WATER_SHADE, BANDS[ri][2]);
        });
        // The JS sheet is Lambert, but it's FLAT and horizontal, so its shading
        // is one constant — folded into the vertex colours instead, since the
        // lit material family isn't a blending one. WATER_SHADE is that
        // constant, matched against the live pane.
        MaterialInstance* mi = sceneInstance(mBlendMaterial);
        mi->setPolygonOffset(-1.0f, -1.0f);
        buildMesh(mWater, true, mi, 2); // after the wet sand, before every flier
    }
}

// Fliers: gulls/vultures/geese circling their roosts (theme.birds), kites
// bobbing on their strings over the shore (theme.kites) and the playroom's
// paper dart (theme.paperPlane). The JS birds/kites are canvas SPRITES; here
// their glyphs are built as real geometry in the sprite's unit quad (the
// canvas maps isotropically once the sprite's own aspect is applied), and the
// render loop yaws them to face each cell's camera like the clouds.
void TtpRenderer::buildFliers(const TrackBin& tb) {
    if (!mBlendMaterial) return;
    // Round-capped polyline stroke in CANVAS pixels, mapped into the quad by
    // `toLocal`.
    const auto stroke = [&](Mesh& m, const std::vector<float2>& pts, float halfW,
            uint32_t col, const std::function<float3(float2)>& toLocal) {
        const auto push = [&](float2 p) {
            const float3 v = toLocal(p);
            m.verts.push_back({ v.x, v.y, v.z, col });
        };
        for (size_t i = 0; i + 1 < pts.size(); i++) {
            const float2 a = pts[i], b = pts[i + 1];
            const float2 d = b - a;
            const float len = std::sqrt(d.x * d.x + d.y * d.y);
            if (len < 1e-5f) continue;
            const float2 n{ -d.y / len * halfW, d.x / len * halfW };
            const uint32_t base = (uint32_t) m.verts.size();
            push(a + n); push(b + n); push(a - n); push(b - n);
            m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                        base + 1, base + 3, base + 2 });
        }
        // Round caps + joins: a fan at every vertex keeps corners closed.
        for (const float2& p : pts) {
            const uint32_t base = (uint32_t) m.verts.size();
            push(p);
            constexpr int SEG = 8;
            for (int k = 0; k <= SEG; k++) {
                const float a = (float) k / SEG * 2.0f * (float) M_PI;
                push(p + float2{ std::cos(a) * halfW, std::sin(a) * halfW });
            }
            for (int k = 0; k < SEG; k++) {
                m.idx.insert(m.idx.end(), { base, base + 1 + (uint32_t) k,
                                            base + 2 + (uint32_t) k });
            }
        }
    };
    const auto quadratic = [](float2 a, float2 c, float2 b, int seg,
            std::vector<float2>& out) {
        for (int i = 1; i <= seg; i++) {
            const float t = (float) i / seg, u = 1 - t;
            out.push_back(a * (u * u) + c * (2 * u * t) + b * (t * t));
        }
    };

    // Birds: 4 sprites of a 2:1 double-arc glyph (64×32 canvas, 4.5px stroke).
    if (tb.birdCount > 0) {
        mBirds.resize(std::min(tb.birdCount, 4u));
        const uint32_t col = packLinear(srgbToLinear(tb.birdTint), 1.0f, 1.0f);
        const auto toLocal = [](float2 p) {
            return float3{ (p.x - 32.0f) / 64.0f, (16.0f - p.y) / 32.0f, 0 };
        };
        std::vector<float2> path{ { 6, 22 } };
        quadratic({ 6, 22 }, { 20, 6 }, { 32, 18 }, 8, path);
        quadratic({ 32, 18 }, { 44, 6 }, { 58, 22 }, 8, path);
        for (Mesh& m : mBirds) {
            stroke(m, path, 2.25f, col, toLocal);
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return;
        }
    }

    // Kites: a filled diamond, a lazy-S tail and two little bows (64² canvas).
    if (tb.kiteCount > 0) {
        mKites.resize(std::min(tb.kiteCount, 2u));
        const auto toLocal = [](float2 p) {
            return float3{ (p.x - 32.0f) / 64.0f, (32.0f - p.y) / 64.0f, 0 };
        };
        for (size_t i = 0; i < mKites.size(); i++) {
            Mesh& m = mKites[i];
            const uint32_t tint = tb.kiteTints.empty()
                    ? 0xffffffu : tb.kiteTints[i % tb.kiteTints.size()];
            const uint32_t col = packLinear(srgbToLinear(tint), 1.0f, 1.0f);
            const uint32_t colT = packLinear(srgbToLinear(tint), 1.0f, 0.9f);
            const float2 D[4] = { { 32, 2 }, { 48, 18 }, { 32, 40 }, { 16, 18 } };
            const uint32_t base = (uint32_t) m.verts.size();
            for (const float2& p : D) {
                const float3 v = toLocal(p);
                m.verts.push_back({ v.x, v.y, v.z, col });
            }
            m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                        base, base + 2, base + 3 });
            std::vector<float2> tail{ { 32, 40 } };
            quadratic({ 32, 40 }, { 40, 48 }, { 32, 53 }, 5, tail);
            quadratic({ 32, 53 }, { 24, 58 }, { 30, 62 }, 5, tail);
            stroke(m, tail, 1.2f, colT, toLocal);
            for (const float2& b : { float2{ 36, 47 }, float2{ 27, 57 } }) {
                stroke(m, { b, b }, 2.6f, col, toLocal);
            }
            if (!buildMesh(m, true, mBlendMaterial->getDefaultInstance())) return;
        }
    }

    // Paper dart: three flat triangles (two dihedral-V wings + a hanging keel),
    // nose +Z, unit-sized — the render loop scales and banks it. Both windings
    // stand in for the JS material's DoubleSide.
    if (tb.hasPlane) {
        static const float3 TRIS[9] = {
            { 0, 0, 0.55f }, { 0, 0.02f, -0.5f }, { -0.42f, 0.17f, -0.5f },
            { 0, 0, 0.55f }, { 0.42f, 0.17f, -0.5f }, { 0, 0.02f, -0.5f },
            { 0, 0, 0.55f }, { 0, -0.2f, -0.42f }, { 0, 0.02f, -0.5f },
        };
        const uint32_t col = packLinear(srgbToLinear(tb.planeTint), 1.0f);
        for (const float3& v : TRIS) mPlane.verts.push_back({ v.x, v.y, v.z, col });
        for (uint32_t t = 0; t < 3; t++) {
            mPlane.idx.insert(mPlane.idx.end(), { t * 3, t * 3 + 1, t * 3 + 2,
                                                  t * 3, t * 3 + 2, t * 3 + 1 });
        }
        accumulateNormals(mPlane);
        buildMesh(mPlane);
    }
}

// Support structures + berms — track.js buildPoles / buildPillars /
// buildLoopPoles / buildHills. The port used to stand an item-CONE at every
// authored pole, which is neither the right shape nor the right thing: these
// are matte concrete posts. The berms are the grass the JS lofts under a
// raised, non-pillared deck; without them the elevated section floats over a
// hole in the world with its grey skirt hanging out (that's the "missing green
// hill" under gate0's overpass).
void TtpRenderer::buildStructures(const TrackBin& tb) {
    const float3 STRUCT = srgbToLinear(tb.structureCol);
    const uint32_t sc = packLinear(STRUCT, 1.0f);
    // Vertical cylinder, optionally with its top clipped to a plane (the loop
    // shafts meet the deck's angled underside flush instead of poking through).
    const auto column = [&](float x, float z, float r, float y0, float y1,
            const float3* planeP, const float3* planeN) {
        constexpr int SEG = 12;
        const uint32_t base = (uint32_t) mStructures.verts.size();
        const auto topAt = [&](float vx, float vz) {
            if (!planeP || !planeN || std::fabs(planeN->y) < 1e-4f) return y1;
            const float py = planeP->y
                    - (planeN->x * (vx - planeP->x) + planeN->z * (vz - planeP->z)) / planeN->y;
            return std::min(y1, py);
        };
        for (int j = 0; j <= SEG; j++) {
            const float a = (float) j / SEG * 2.0f * (float) M_PI;
            const float vx = x + std::cos(a) * r, vz = z + std::sin(a) * r;
            mStructures.verts.push_back({ vx, y0, vz, sc });
            mStructures.verts.push_back({ vx, topAt(vx, vz), vz, sc });
        }
        for (int j = 0; j < SEG; j++) {
            const uint32_t a0 = base + (uint32_t) j * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
            mStructures.idx.insert(mStructures.idx.end(), { a0, b0, a1, b0, b1, a1 });
        }
        const uint32_t cap = (uint32_t) mStructures.verts.size();
        mStructures.verts.push_back({ x, topAt(x, z), z, sc });
        for (int j = 0; j < SEG; j++) {
            mStructures.idx.insert(mStructures.idx.end(),
                    { cap, base + (uint32_t) j * 2 + 1, base + ((uint32_t) j + 1) * 2 + 1 });
        }
    };

    for (const TrackBin::Pillar& p : tb.pillars) {
        column(p.x, p.z, p.radius, p.baseY, std::max(p.baseY + 0.1f, p.topY), nullptr, nullptr);
    }
    // Poles: from the road surface (EMBED 0.06 below) up to just under the deck
    // crossing overhead (TUCK 0.34), or POST_UP 2.0 above the road with nothing
    // over them — buildPoles' own search over the centreline samples.
    for (const TrackBin::Pole& p : tb.poles) {
        const TrackBin::Sample f = tb.frameAt(p.s);
        const float3 base = f.pos + f.lat * p.lat;
        float topY = base.y + 2.0f, bestD = 1e30f;
        for (const TrackBin::Sample& s : tb.samples) {
            if (s.pos.y - base.y < 1.5f) continue;
            const float dx = s.pos.x - base.x, dz = s.pos.z - base.z;
            const float d = dx * dx + dz * dz;
            if (d < 4.0f && d < bestD) { bestD = d; topY = s.pos.y - 0.34f; }
        }
        column(base.x, base.z, p.radius, base.y - 0.06f,
                std::max(base.y - 0.06f + 0.3f, topY), nullptr, nullptr);
    }
    // Loop shafts: built tall from the lawn, then cut to the road's underside.
    for (const TrackBin::Post& p : tb.supportPosts) {
        const float3 n = p.cUp;
        const float3 planeP = p.cPos - n * 0.34f; // deck thickness
        column(p.x, p.z, p.radius, tb.groundY - 0.1f, p.cPos.y + 1.0f, &planeP, &n);
    }
    if (!mStructures.verts.empty()) {
        accumulateNormals(mStructures);
        if (!buildMesh(mStructures, true, litShadowInstance())) return;
    }

    // Berms: consecutive cross-section rings stitched into a grass surface that
    // meets the road underside and flares down to the lawn (buildHills verbatim
    // — left slope, top, right slope; flare grows with height for a constant
    // slope angle).
    const float gy = tb.groundY;
    const auto corners = [&](const TrackBin::BermRing& r, float3 out[4]) {
        const float flare = 0.6f + 0.8f * std::max(0.0f, std::max(r.topL, r.topR) - gy);
        const float hw = r.halfW, ox = r.lx, oz = r.lz;
        out[0] = { r.cx - ox * (hw + flare), gy, r.cz - oz * (hw + flare) };
        out[1] = { r.cx - ox * hw, r.topL, r.cz - oz * hw };
        out[2] = { r.cx + ox * hw, r.topR, r.cz + oz * hw };
        out[3] = { r.cx + ox * (hw + flare), gy, r.cz + oz * (hw + flare) };
    };
    const auto quad = [&](const float3& a, const float3& b, const float3& c, const float3& d) {
        const uint32_t base = (uint32_t) mBerms.verts.size();
        for (const float3& p : { a, b, c, d }) {
            mBerms.verts.push_back({ p.x, p.y, p.z,
                    packLinear(groundColorAt(p.x), 1.0f) });
        }
        mBerms.idx.insert(mBerms.idx.end(), { base, base + 1, base + 2, base, base + 2, base + 3 });
    };
    // Rings arrive at the sim's 0.25u sample step; every second one is enough.
    // 0.5u is the road ribbon's own chord scale (0.48), and the berm top hides
    // under a 0.34u-thick deck, so the extra chord sag can't poke through.
    for (const auto& run : tb.berms) {
        if (run.size() < 2) continue;
        float3 A[4], B[4];
        corners(run[0], A);
        for (size_t i = 1; i < run.size(); i++) {
            if (i % 2 && i + 1 < run.size()) continue;
            corners(run[i], B);
            quad(A[0], A[1], B[1], B[0]); // left slope
            quad(A[1], A[2], B[2], B[1]); // top, under the road
            quad(A[2], A[3], B[3], B[2]); // right slope
            for (int k = 0; k < 4; k++) A[k] = B[k];
        }
    }
    if (!mBerms.verts.empty()) {
        accumulateNormals(mBerms);
        buildMesh(mBerms, true, litShadowInstance());
    }
}

// One instanced-asset family (a scenery model, a prop model, the cone pool)
// into merged draw groups: per distinct MESH, one instanced renderable over
// every copy. Entity slots are consistent across gltfio instances — the
// material sharing in loadInstancedProp already relies on exactly that — and
// slots map to parsed geometry by the NODE NAME, refusing a model whose names
// are ambiguous across meshes (nothing in the kit is; the refusal keeps a
// future asset honest rather than half-merged).
void TtpRenderer::mergeInstancedSet(const gltfio::FilamentAsset* asset,
        const std::vector<gltfio::FilamentInstance*>& insts, bool dynamic) {
    if (!asset || insts.size() < 2 || !mEngine) return;
    const auto keyIt = mAssetMeshKey.find(asset);
    if (keyIt == mAssetMeshKey.end()) return;
    const auto meshIt = mGlbMeshCache.find(keyIt->second);
    if (meshIt == mGlbMeshCache.end() || meshIt->second.empty()) return;
    // A model with an animated "spin" node (the toy train) moves under a
    // static merge; mirror it per frame instead. The node itself may carry no
    // mesh, so ask the ASSET, not the parse.
    if (!const_cast<gltfio::FilamentAsset*>(asset)
                ->getFirstEntityByName("spin").isNull()) {
        dynamic = true;
    }
    auto& rcm = mEngine->getRenderableManager();
    const size_t nEnt = insts[0] ? insts[0]->getEntityCount() : 0;
    if (!nEnt) return;
    for (auto* in : insts) {
        if (!in || in->getEntityCount() != nEnt) return;
    }
    std::unordered_map<int, std::vector<size_t>> slotsByMesh;
    for (size_t e = 0; e < nEnt; e++) {
        const utils::Entity ent = insts[0]->getEntities()[e];
        if (!rcm.getInstance(ent)) continue;
        const char* nm = asset->getName(ent);
        if (!nm) return;
        const ttp::rt::GlbMeshNode* found = nullptr;
        for (const auto& n : meshIt->second) {
            if (n.name == nm) {
                if (found && found->mesh != n.mesh) return;
                found = &n;
            }
        }
        if (!found) return;
        slotsByMesh[found->mesh].push_back(e);
    }
    for (const auto& [mesh, slots] : slotsByMesh) {
        const ttp::rt::GlbMeshNode* node = nullptr;
        for (const auto& n : meshIt->second) {
            if (n.mesh == mesh) { node = &n; break; }
        }
        std::vector<utils::Entity> sources;
        for (auto* in : insts) {
            for (const size_t e : slots) sources.push_back(in->getEntities()[e]);
        }
        buildMergedGroup(mMergedDress, sources, node->prims, dynamic,
                kFeatDressing);
    }
}

// The per-copy dressing, regrouped: the instanced scenery and prop models
// (static — their placements are the scene's), and the cone pool (dynamic — a
// kicked cone tumbles through its root transform, which the mirror follows).
// The merged boulder/landmark/clutter sheets are already one renderable each
// and stay as they are; the item-box pools stay unmerged too — the fade twins
// deliberately hold PER-INSTANCE materials, which is the one thing a shared
// instanced draw cannot express.
void TtpRenderer::buildDressingMerge() {
    destroyMergedGroups(mMergedDress);
    if (!mScene) return;
    for (size_t m = 0; m < mSceneryAssets.size() && m < mSceneryInstances.size(); m++) {
        mergeInstancedSet(mSceneryAssets[m], mSceneryInstances[m], false);
    }
    for (size_t m = 0; m < mPropAssets.size() && m < mPropInstances.size(); m++) {
        mergeInstancedSet(mPropAssets[m], mPropInstances[m], false);
    }
    mergeInstancedSet(mConeAsset, mConeInstances, true);
}
