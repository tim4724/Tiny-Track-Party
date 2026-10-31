// The set pieces' moving parts: what an `anim_` node does (ttp/set_motion.h)
// and how it is drawn. TtpRendererImpl.h carries what the topic files share.
//
// THE TIER. A moving part is baked like the static dressing (kit colour x live
// factor x the matte light of its REST normals, one unlit vcolor mesh) but in
// its node's own frame, so one transform a frame moves it: no lit vertex, no
// instance buffer, a draw per visible part. The light stays frozen at the rest
// pose, which is why the verbs are spins about the part's own axis, sways,
// hops and small turns: the sun's horizontal share is a fifth of it
// (kToSun), so a 60 degree turn moves a wall's light by under 0.2 of the sun
// term, and a wheel turning about its axis keeps every face's light exact.
//
// THE SHADOW. The sun bake renders the gltfio originals at their rest pose,
// before the merge exists. A part that moves in place keeps that shadow (it is
// its footprint under the near-overhead sun); one that TRAVELS is taken out of
// the caster set before the bake (keepTravellersOutOfBake), or its shadow
// would stay behind where it was authored.
#include "TtpRendererImpl.h"
#include "../generated/kit_colors.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>

utils::Entity TtpRenderer::setAnimRoot(const gltfio::FilamentAsset* asset,
        utils::Entity ent, bool outermost) const {
    auto& tcm = mEngine->getTransformManager();
    utils::Entity root;
    for (auto ti = tcm.getInstance(ent); ti; ti = tcm.getInstance(tcm.getParent(ti))) {
        const utils::Entity e = tcm.getEntity(ti);
        if (!ttp::rt::is_set_motion_name(asset->getName(e))) continue;
        root = e;
        if (!outermost) break;
    }
    return root;
}

// A part travels if any `anim_` node over it does: one riding on a traveller
// (a wind-up key on a walking robot) leaves the bake with it.
void TtpRenderer::keepTravellersOutOfBake(const gltfio::FilamentAsset* asset,
        gltfio::FilamentInstance* inst) {
    auto& rcm = mEngine->getRenderableManager();
    auto& tcm = mEngine->getTransformManager();
    for (size_t i = 0; i < inst->getEntityCount(); i++) {
        const utils::Entity e = inst->getEntities()[i];
        if (!rcm.getInstance(e)) continue;
        for (auto ti = tcm.getInstance(e); ti; ti = tcm.getInstance(tcm.getParent(ti))) {
            const char* nm = asset->getName(tcm.getEntity(ti));
            ttp::rt::SetMotion m;
            if (ttp::rt::is_set_motion_name(nm) && ttp::rt::parse_set_motion(nm, m) && m.travels()) {
                setShadows(&e, 1, false, false);
                break;
            }
        }
    }
}

// After the static merge (buildDressingMerge), which leaves every slot under an
// `anim_` node to this. A part whose bake fails keeps its gltfio draw, standing
// still and live-lit, and the scene budget's live-dressing gate names it.
void TtpRenderer::buildSetMovers() {
    mSetMovers.clear();
    mSetPaths.clear();
    if (!mScene || !mBakeRig.valid) return;
    auto& rcm = mEngine->getRenderableManager();
    auto& tcm = mEngine->getTransformManager();
    for (size_t m = 0; m < mSetAssets.size() && m < mSetInstances.size(); m++) {
        const gltfio::FilamentAsset* asset = mSetAssets[m];
        if (!asset) continue;
        const auto keyIt = mAssetMeshKey.find(asset);
        if (keyIt == mAssetMeshKey.end()) continue;
        const auto meshIt = mGlbMeshCache.find(keyIt->second);
        if (meshIt == mGlbMeshCache.end()) continue;
        const ttp::kitcolors::Model* const colorModel = ttp::kitcolors::find(keyIt->second);
        for (size_t k = 0; k < mSetInstances[m].size(); k++) {
            gltfio::FilamentInstance* const inst = mSetInstances[m][k];
            if (!inst) continue;
            const utils::Entity* ents = inst->getEntities();
            const size_t nEnt = inst->getEntityCount();
            // This placement's paths: `path_<chain>_<k>` empties, in k order.
            std::map<std::string, std::map<int, float3>> chains;
            for (size_t e = 0; e < nEnt; e++) {
                const char* nm = asset->getName(ents[e]);
                if (!nm || std::strncmp(nm, "path_", 5) != 0) continue;
                const char* us = std::strrchr(nm, '_');
                if (us <= nm + 4) continue;
                chains[std::string(nm + 5, us)][std::atoi(us + 1)] =
                        tcm.getWorldTransform(tcm.getInstance(ents[e]))[3].xyz;
            }
            std::map<std::string, int> pathOf;
            const float baseY = tcm.getWorldTransform(tcm.getInstance(inst->getRoot()))[3].y;
            for (const auto& [name, pts] : chains) {
                if (pts.size() < 2) continue;
                // A `drape` chain lies on the drawn ground as a `drape` part
                // does (appendBaked): lifted by the land under each point over
                // the placement's foot, so a slide down a terrain hill follows
                // the grid's chords instead of the curve they cut across.
                const bool drape = mTrack && name.compare(0, 5, "drape") == 0;
                SetPath sp;
                for (const auto& [i, p] : pts) {
                    sp.pts.push_back(p);
                    if (drape) sp.pts.back().y += groundSurfaceY(*mTrack, p.x, p.z) - baseY;
                }
                sp.at.push_back(0);
                for (size_t i = 1; i <= sp.pts.size(); i++) {
                    sp.at.push_back(sp.at.back()
                            + length(sp.pts[i % sp.pts.size()] - sp.pts[i - 1]));
                }
                if (!(sp.at.back() > 1e-4f)) continue;   // every point on one spot: no loop
                // A leg below the piece's base is meant to be out of sight
                // (the chute's swim home): say so if the ground there no
                // longer covers it, which a reshaped terrain could do.
                for (size_t i = 0; i < sp.pts.size(); i++) {
                    const float3 a = sp.pts[i], b = sp.pts[(i + 1) % sp.pts.size()];
                    for (int k = 0; k <= 8; k++) {
                        const float3 q = a + (b - a) * (k / 8.0f);
                        if (q.y < baseY - 0.05f && q.y > groundY(q.x, q.z)) {
                            utils::slog.w << "set motion: path " << name.c_str()
                                    << " shows above the ground below its piece" << utils::io::endl;
                            i = sp.pts.size();
                            break;
                        }
                    }
                }
                pathOf[name] = (int) mSetPaths.size();
                mSetPaths.push_back(std::move(sp));
            }
            // Every `anim_` node moves what hangs under it up to the next one:
            // a node inside another rides on it (a key turning in a walking
            // robot's back), so the outer ones are built first and each inner
            // one remembers the mover it rides.
            std::map<utils::Entity, size_t> moverOf;
            std::vector<std::pair<int, size_t>> order;   // (anim nodes over it, entity slot)
            for (size_t e = 0; e < nEnt; e++) {
                if (setAnimRoot(asset, ents[e], false) != ents[e]) continue;
                int depth = 0;
                for (auto ti = tcm.getInstance(tcm.getParent(tcm.getInstance(ents[e]))); ti;
                        ti = tcm.getInstance(tcm.getParent(ti))) {
                    depth += ttp::rt::is_set_motion_name(asset->getName(tcm.getEntity(ti))) ? 1 : 0;
                }
                order.push_back({ depth, e });
            }
            std::stable_sort(order.begin(), order.end());
            for (const auto& slot : order) {
                const size_t e = slot.second;
                const utils::Entity node = ents[e];
                const char* nodeName = asset->getName(node);
                ttp::rt::SetMotion motion;
                std::string unknown;
                ttp::rt::parse_set_motion(nodeName, motion, &unknown);
                if (!unknown.empty()) {
                    utils::slog.w << "set motion: " << nodeName << " has an unknown "
                            << unknown.c_str() << utils::io::endl;
                }
                const mat4f rest = tcm.getWorldTransform(tcm.getInstance(node));
                // Everything drawn under the node, baked into ONE mesh in its frame.
                std::vector<utils::Entity> parts;
                for (size_t i = 0; i < nEnt; i++) {
                    if (rcm.getInstance(ents[i]) && setAnimRoot(asset, ents[i], false) == node) {
                        parts.push_back(ents[i]);
                    }
                }
                if (parts.empty()) continue;
                // The mover this one rides, if any (built already: outer first):
                // the nearest `anim_` node over it that became one (a node with
                // nothing drawn of its own makes none, so its riders ride on
                // past it).
                int rides = -1;
                for (auto ti = tcm.getInstance(tcm.getParent(tcm.getInstance(node)));
                        ti && rides < 0; ti = tcm.getInstance(tcm.getParent(ti))) {
                    const auto it = moverOf.find(tcm.getEntity(ti));
                    if (it != moverOf.end()) rides = (int) it->second;
                }
                // The path a part's far-form box must cover: a traveller's own,
                // or the one the traveller it rides goes round (a robot's legs).
                int lodPath = -1;
                float3 lodOrigin = rest[3].xyz;
                if (motion.path) {
                    const auto p = pathOf.find(motion.chain);
                    if (p != pathOf.end()) lodPath = p->second;
                } else if (rides >= 0) {
                    lodPath = mSetMovers[(size_t) rides].lodPath;
                    lodOrigin = mSetMovers[(size_t) rides].lodOrigin;
                }
                MergedGroup g;
                Mesh& mesh = g.baked;
                mesh.weld = true;
                // A far form like the static runs' (chooseLods); a part that
                // travels measures to the box its whole loop sweeps (below).
                mesh.simplify = true;
                const mat4f toNode = inverse(rest);
                bool ok = colorModel != nullptr;
                for (const utils::Entity src : parts) {
                    if (!ok) break;
                    const char* nm = asset->getName(src);
                    // By name, like mergeInstancedSet: two nodes of one name
                    // on different meshes (composed kit trees) are ambiguous.
                    const ttp::rt::GlbMeshNode* found = nullptr;
                    for (const auto& n : meshIt->second) {
                        if (!nm || n.name != nm) continue;
                        if (found && found->mesh != n.mesh) { found = nullptr; break; }
                        found = &n;
                    }
                    if (!found || found->mesh < 0
                            || (uint32_t) found->mesh >= colorModel->meshCount) { ok = false; break; }
                    const ttp::kitcolors::Mesh& colors = colorModel->meshes[found->mesh];
                    const auto& prims = found->prims;
                    const auto ri = rcm.getInstance(src);
                    if (colors.primCount != prims.size() || rcm.getPrimitiveCount(ri) != prims.size()) {
                        ok = false;
                        break;
                    }
                    const mat4f xf = tcm.getWorldTransform(tcm.getInstance(src));
                    const mat3f nm3 = transpose(inverse(mat3f{ xf[0].xyz, xf[1].xyz, xf[2].xyz }));
                    const mat4f into = toNode * xf;
                    for (size_t p = 0; p < prims.size() && ok; p++) {
                        const ttp::rt::GlbMeshPrim& sp = prims[p];
                        const MaterialInstance* mi = rcm.getMaterialInstanceAt(ri, p);
                        if (colors.prims[p].vertexCount * 3 != sp.pos.size()
                                || sp.normal.size() != sp.pos.size() || !mi
                                || !mi->getMaterial()->hasParameter("baseColorFactor")) {
                            ok = false;
                            break;
                        }
                        // The live factor is display-encoded (bakeMergedRun's note).
                        const float3 fe = mi->getParameter<float4>("baseColorFactor").xyz;
                        const float3 factor{ srgbChannel(fe.x), srgbChannel(fe.y), srgbChannel(fe.z) };
                        const uint8_t* rgb = colors.prims[p].rgb;
                        const uint32_t base = (uint32_t) mesh.verts.size();
                        for (size_t i = 0; i < sp.pos.size() / 3; i++) {
                            const float4 pos{ sp.pos[i * 3], sp.pos[i * 3 + 1], sp.pos[i * 3 + 2], 1 };
                            const float3 pl = (into * pos).xyz;
                            const float3 nw = normalize(nm3 * float3{ sp.normal[i * 3],
                                    sp.normal[i * 3 + 1], sp.normal[i * 3 + 2] });
                            const float3 lin = float3{ srgbChannel(rgb[i * 3] / 255.0f),
                                    srgbChannel(rgb[i * 3 + 1] / 255.0f),
                                    srgbChannel(rgb[i * 3 + 2] / 255.0f) } * factor;
                            mesh.verts.push_back({ pl.x, pl.y, pl.z,
                                    packShown(lin * bakedMatteLight(nw), 1.0f) });
                        }
                        for (const uint32_t ix : sp.idx) mesh.idx.push_back(base + ix);
                    }
                }
                if (!ok || !buildMesh(mesh)) {
                    utils::slog.w << "set motion: " << (nodeName ? nodeName : "?")
                            << " did not bake; it stands still" << utils::io::endl;
                    destroyMesh(mesh);
                    continue;
                }
                // chooseLods measures to a WORLD box: the rest pose's, which an
                // in-place motion never strays far from; for a traveller (or a
                // part riding one), every spot of its loop with the part's
                // reach round its traveller's origin, turned any way.
                for (LodRange& r : mLods) {
                    if (r.entity != mesh.entity) continue;
                    float3 lo{ 1e30f }, hi{ -1e30f };
                    float reach = 0;
                    for (int c = 0; c < 8; c++) {
                        const float3 p{ (c & 1) ? r.hi.x : r.lo.x, (c & 2) ? r.hi.y : r.lo.y,
                                        (c & 4) ? r.hi.z : r.lo.z };
                        const float3 w = (rest * float4{ p, 1 }).xyz;
                        lo = min(lo, w);
                        hi = max(hi, w);
                        reach = std::max(reach, length(w - lodOrigin));
                    }
                    if (lodPath >= 0) {
                        lo = float3{ 1e30f };
                        hi = float3{ -1e30f };
                        for (const float3& q : mSetPaths[(size_t) lodPath].pts) {
                            lo = min(lo, q - reach);
                            hi = max(hi, q + reach);
                        }
                    }
                    r.lo = lo;
                    r.hi = hi;
                }
                // The originals' layer: a traveller's already lacks the caster bit.
                if (const auto ri = rcm.getInstance(mesh.entity)) {
                    rcm.setLayerMask(ri, 0xFF, rcm.getLayerMask(rcm.getInstance(parts[0])));
                }
                for (const utils::Entity src : parts) mScene->remove(src);
                g.ent = mesh.entity;
                g.feat = kFeatDressing;
                g.sources = parts;
                SetMover mv;
                mv.ent = g.ent;
                mv.rest = rest;
                // A `drape` part stands where the ground is drawn, as the
                // draped parts round it do (appendBaked).
                if (motion.drape && mTrack && !motion.travels()) {
                    mv.rest[3].y += groundSurfaceY(*mTrack, rest[3].x, rest[3].z) - baseY;
                }
                mv.scale = length(rest[0].xyz);
                const float inv = mv.scale > 0 ? 1.0f / mv.scale : 1.0f;
                mv.restInv = transpose(mat3f{ rest[0].xyz * inv, rest[1].xyz * inv, rest[2].xyz * inv });
                // Out of step per placement and per part: the part's spot and
                // the node's slot, so the same track always moves the same; a
                // part in step (`o`) counts from its placement's root instead,
                // the spot every part of the placement shares.
                const auto spot = [](const float3& p) {
                    return (uint32_t) (int32_t) std::lround(p.x * 16) * 73856093u
                            ^ (uint32_t) (int32_t) std::lround(p.z * 16) * 19349663u;
                };
                mv.phase = ttp::rt::set_motion_part_phase(motion,
                        spot(rest[3].xyz) ^ (uint32_t) e * 83492791u,
                        spot(tcm.getWorldTransform(tcm.getInstance(inst->getRoot()))[3].xyz));
                if (motion.path) {
                    const auto p = pathOf.find(motion.chain);
                    if (p != pathOf.end()) {
                        mv.path = p->second;
                    } else {
                        // Already out of the sun bake as a traveller: it
                        // stands still with no shadow, so it must be loud.
                        utils::slog.w << "set motion: " << nodeName << " rides path "
                                << motion.chain.c_str() << ", which has no loop; it stands still"
                                << utils::io::endl;
                        motion.path = false;
                    }
                }
                mv.lodPath = lodPath;
                mv.lodOrigin = lodOrigin;
                if (rides >= 0) {
                    mv.parent = rides;
                    mv.onParent = inverse(mSetMovers[(size_t) rides].rest) * mv.rest;
                }
                mv.motion = std::move(motion);
                mMergedDress.push_back(std::move(g));
                moverOf[node] = mSetMovers.size();
                mSetMovers.push_back(std::move(mv));
            }
        }
    }
}

namespace {
mat4f axisTurn(char axis, float a) {
    return mat4f::rotation(a, axis == 'x' ? float3{ 1, 0, 0 }
            : axis == 'z' ? float3{ 0, 0, 1 } : float3{ 0, 1, 0 });
}
} // namespace

void TtpRenderer::stepSetMovers(const std::vector<float3>& carPosW) {
    if (mSetMovers.empty()) return;
    auto& tcm = mEngine->getTransformManager();
    // The point `s` along a closed path (arclength, any value).
    const auto pathPoint = [](const SetPath& p, float s) {
        const float loop = p.at.back();
        s -= std::floor(s / loop) * loop;
        const size_t n = p.pts.size();
        size_t i = (size_t) (std::upper_bound(p.at.begin(), p.at.end(), s) - p.at.begin());
        i = i ? std::min(i - 1, n - 1) : 0;
        const float seg = p.at[i + 1] - p.at[i];
        const float t = seg > 0 ? (s - p.at[i]) / seg : 0;
        return p.pts[i] + (p.pts[(i + 1) % n] - p.pts[i]) * t;
    };
    // Where each mover is this frame, for the ones riding it (outer first).
    mSetMoverNow.resize(mSetMovers.size());
    for (size_t k = 0; k < mSetMovers.size(); k++) {
        const SetMover& mv = mSetMovers[k];
        mSetMoverNow[k] = mv.rest;
        const auto ti = tcm.getInstance(mv.ent);
        if (!ti) continue;
        const ttp::rt::SetMotion& m = mv.motion;
        if (m.path && mv.path >= 0) {
            // Along the path at a steady pace, facing along it. The heading is
            // the chord across a short window, so a corner turns the part
            // round instead of flipping it.
            const SetPath& p = mSetPaths[(size_t) mv.path];
            const float s = ttp::rt::set_motion_path_at(m, mTime) * p.at.back();
            const float3 at = pathPoint(p, s);
            float3 fwd = pathPoint(p, s + 0.4f) - pathPoint(p, s - 0.4f);
            mat3f rot{ mv.rest[0].xyz / mv.scale, mv.rest[1].xyz / mv.scale,
                       mv.rest[2].xyz / mv.scale };
            if (m.pathFace == 1) fwd.y = 0;
            if (m.pathFace > 0 && dot(fwd, fwd) > 1e-8f) {
                const float3 x = normalize(fwd);
                // Back up; straight up or down, the back faces the way the
                // part was tipping from (its rest +X behind a climb, ahead of
                // a dive), which is where world-up's projection was heading.
                float3 up{ 0, 1, 0 };
                if (std::fabs(x.y) > 0.995f) up = rot[0] * (x.y > 0 ? -1.0f : 1.0f);
                const float3 y = normalize(up - x * dot(up, x));
                rot = mat3f{ x, y, cross(x, y) };
            }
            mat4f w{ float4{ rot[0] * mv.scale, 0 }, float4{ rot[1] * mv.scale, 0 },
                     float4{ rot[2] * mv.scale, 0 }, float4{ at, 1 } };
            // A traveller may also bob, spin and waddle in its own frame as it
            // goes: a tumbleweed bounces and rolls along its path, a walking
            // penguin rocks from foot to foot.
            if (m.spin || m.bob || m.waddle) {
                const ttp::rt::SetMotionPose pose = ttp::rt::set_motion_pose(m, mTime, mv.phase,
                        nullptr, 0);
                w = w * mat4f::translation(float3{ 0, pose.lift, 0 });
                if (m.spin) w = w * axisTurn(m.spinAxis, pose.spin);
                if (pose.roll != 0) w = w * mat4f::rotation(pose.roll, float3{ 1, 0, 0 });
            }
            mSetMoverNow[k] = w;
            tcm.setTransform(ti, w);
            continue;
        }
        size_t n = 0;
        if (m.watch || m.hop) {
            mSetMotionCars.resize(carPosW.size());
            const float3 o = mv.rest[3].xyz;
            for (const float3& c : carPosW) {
                const float3 d = c - o;
                const float dist = length(d);
                if (!(dist < std::max(m.watch ? m.watchRadius : 0.0f, m.hop ? m.hopRadius : 0.0f))) {
                    continue;
                }
                const float3 l = mv.restInv * d;
                mSetMotionCars[n++] = { l.x, l.z, dist };
            }
        }
        const ttp::rt::SetMotionPose pose = ttp::rt::set_motion_pose(m, mTime, mv.phase,
                mSetMotionCars.data(), n);
        mat4f local = mat4f::translation(float3{ 0, pose.lift, 0 });
        if (pose.yaw != 0) local = local * mat4f::rotation(pose.yaw, float3{ 0, 1, 0 });
        if (m.sway) local = local * axisTurn(m.swayAxis, pose.sway);
        if (m.spin) local = local * axisTurn(m.spinAxis, pose.spin);
        if (pose.roll != 0) local = local * mat4f::rotation(pose.roll, float3{ 1, 0, 0 });
        const mat4f base = mv.parent >= 0 ? mSetMoverNow[(size_t) mv.parent] * mv.onParent : mv.rest;
        mSetMoverNow[k] = base * local;
        tcm.setTransform(ti, mSetMoverNow[k]);
    }
}

// Three soft puffs rising, growing and fading on a staggered loop (the JS
// sprites, as blend quads billboarded per cell); renderWorld moves them.
void TtpRenderer::buildSmokePuffs(const float3& origin) {
    mSmokeOrigin = origin;
    if (!mBlendMaterial) return;
    mSmoke.resize(3);
    const BlurKernel blur(6.0f);
    // 8px cells: the 6px blur spreads the disc edge over ~12px of the 64x64
    // field, so every gradient still gets a sample.
    constexpr int NX = 8, NY = 8;
    for (Mesh& m : mSmoke) {
        for (int j = 0; j <= NY; j++) {
            for (int k = 0; k <= NX; k++) {
                const float px = (float) k / NX * 64.0f;
                const float py = (float) j / NY * 64.0f;
                const float cov = blur.coverage(px, py, [](float bx, float by) {
                    const float dx = bx - 32, dy = by - 32;
                    return dx * dx + dy * dy <= 18 * 18;
                });
                // Wood-smoke grey: every chimney is on the snow cup, where a
                // white puff is one more snowflake.
                m.verts.push_back({ (float) k / NX - 0.5f, 0.5f - (float) j / NY, 0,
                                    packShown(srgbToLinear(0x8d949e), 1.0f, cov) });
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
