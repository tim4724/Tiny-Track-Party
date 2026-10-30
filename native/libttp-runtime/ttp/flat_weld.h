// flat_weld — fewer vertices for a FLAT-SHADED kit mesh, for the same picture.
//
// A flat-shaded mesh stores every corner once per face it touches, so each
// face can carry its own normal, and the vertex stage lights the same light
// three times a triangle. Drawn with FLAT interpolation (vglbflat.mat) a
// triangle is lit by ONE corner, its provoking vertex, so the corners can be
// shared as long as every triangle's provoking corner carries that triangle's
// face normal. What it buys on the weakest box is the frame map's (the Fire TV
// section, docs/perf/androidtv-frame-map.md).
//
// HEADER-ONLY for the glb_mesh.h reason: the renderer consumes it and may not
// link libttp-runtime; the `flatweld` ctest executes it on every leg.
//
// TWO THINGS DECIDE THE PICTURE, and both are this file's to keep:
//
//   * WHICH CORNER PROVOKES is the backend's, not ours: GL / GLES / WebGL take
//     the LAST corner, Vulkan and Metal the FIRST, and Filament sets neither.
//     The caller says which (`provokingLast`); every triangle is rotated
//     cyclically, so its winding is kept.
//   * TRIANGLE ORDER IS A PICTURE where two faces lie in one plane and overlap
//     (a decal panel on its base): the depth test ties and the LATER triangle
//     wins. So a triangle with an earlier coplanar overlapping face is an
//     OVERLAY, and the overlays are kept in source order after every other
//     triangle. Only the front range
//     (`baseTris`) is free for a vertex-reuse reorder — which is where the
//     saving is: welded corners in source order buy almost nothing through a
//     small post-transform cache.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/glb_mesh.h"

namespace ttp {
namespace rt {

// Every triangle's three corner normals bitwise equal — the one case where
// flat interpolation of ANY corner equals today's per-vertex light. Needs
// normals; an empty prim is not flat.
inline bool prim_all_flat(const GlbMeshPrim& p) {
    if (p.idx.empty() || p.normal.size() != p.pos.size()) return false;
    for (size_t t = 0; t + 2 < p.idx.size(); t += 3) {
        const float* n0 = &p.normal[p.idx[t] * 3];
        if (std::memcmp(n0, &p.normal[p.idx[t + 1] * 3], 12)
                || std::memcmp(n0, &p.normal[p.idx[t + 2] * 3], 12)) {
            return false;
        }
    }
    return true;
}

// Per glTF mesh index: 1 when every primitive of that mesh is all-flat, 0
// otherwise (a mesh no node wears included).
inline std::vector<char> flat_meshes(const std::vector<GlbMeshNode>& nodes) {
    std::vector<char> flat;
    for (const GlbMeshNode& n : nodes) {
        if (n.mesh < 0) continue;
        if ((size_t) n.mesh >= flat.size()) flat.resize(n.mesh + 1, 0);
        flat[n.mesh] = std::all_of(n.prims.begin(), n.prims.end(), prim_all_flat);
    }
    return flat;
}

// The suffix a flat mesh's cloned material is named with; the renderer's
// material provider hands such a material the flat-interpolated program.
inline constexpr const char* kFlatMaterialSuffix = "#flat";

// The same GLB with every primitive of an ALL-FLAT mesh (flat_meshes) moved
// onto its own clone of its material, named `<name>#flat`, so the loader gives
// those primitives their own material instance while every other mesh (the
// smooth wheels sharing the kit's one `colormap`) keeps the original. Geometry
// is untouched. {} when nothing is flat or the bytes do not parse — the caller
// then loads the original.
inline std::vector<uint8_t> flat_material_glb(const uint8_t* bytes, size_t len,
        const std::vector<GlbMeshNode>& nodes) {
    std::string text;
    if (!glb_json_chunk(bytes, len, text)) return {};
    Value doc;
    if (!json::Parser(text).parse(doc) || doc.type != Value::OBJ) return {};
    const std::vector<char> flatMesh = flat_meshes(nodes);
    Value* meshes = nullptr;
    Value* materials = nullptr;
    for (auto& kv : doc.obj) {
        if (kv.first == "meshes" && kv.second.type == Value::ARR) meshes = &kv.second;
        if (kv.first == "materials" && kv.second.type == Value::ARR) materials = &kv.second;
    }
    if (!meshes || !materials) return {};
    std::unordered_map<int, int> cloneOf;   // source material -> its #flat clone
    for (size_t m = 0; m < meshes->arr.size() && m < flatMesh.size(); m++) {
        if (!flatMesh[m] || meshes->arr[m].type != Value::OBJ) continue;
        for (auto& kv : meshes->arr[m].obj) {
            if (kv.first != "primitives" || kv.second.type != Value::ARR) continue;
            for (Value& prim : kv.second.arr) {
                const Value* mat = prim.type == Value::OBJ ? prim.find("material") : nullptr;
                if (!mat || mat->type != Value::NUM) continue;
                const int src = (int) mat->num;
                if (src < 0 || (size_t) src >= materials->arr.size()) continue;
                auto it = cloneOf.find(src);
                if (it == cloneOf.end()) {
                    Value clone = materials->arr[src];
                    const Value* name = clone.find("name");
                    clone.set("name", Value::Str(
                            (name && name->type == Value::STR ? name->str : std::string())
                            + kFlatMaterialSuffix));
                    materials->push(std::move(clone));
                    it = cloneOf.emplace(src, (int) materials->arr.size() - 1).first;
                }
                prim.set("material", Value::Num(it->second));
            }
        }
    }
    if (cloneOf.empty()) return {};
    return glb_with_json(bytes, len, ordered_stringify(doc));
}

// A welded flat prim: `prim.idx` is the overlay-free front range (`baseTris`
// triangles, reorderable) followed by the overlays in source order.
struct FlatWeld {
    GlbMeshPrim prim;
    size_t baseTris = 0;
};

namespace flatweld_detail {

struct V3 { double x, y, z; };
inline V3 at(const std::vector<float>& p, uint32_t i) {
    return { p[i * 3], p[i * 3 + 1], p[i * 3 + 2] };
}
inline V3 sub(V3 a, V3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
inline double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) {
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}

constexpr double kDegenerate = 1e-12;   // |cross| below this is no area
constexpr double kCoplanarEps = 1e-5;   // world units off the plane

// Triangle t of p: its corners and, once, its unit plane (ok = it has area).
// The overlay pass is quadratic, so the plane is not recomputed per pair.
struct Tri { V3 v[3]; V3 n; double d; bool ok; };
inline Tri tri(const GlbMeshPrim& p, size_t t) {
    Tri a{ { at(p.pos, p.idx[t * 3]), at(p.pos, p.idx[t * 3 + 1]), at(p.pos, p.idx[t * 3 + 2]) },
           {}, 0, false };
    const V3 n = cross(sub(a.v[1], a.v[0]), sub(a.v[2], a.v[0]));
    const double len = std::sqrt(dot(n, n));
    a.ok = len >= kDegenerate;
    if (a.ok) {
        a.n = { n.x / len, n.y / len, n.z / len };
        a.d = dot(a.n, a.v[0]);
    }
    return a;
}

// Does b lie in a's plane (within kCoplanarEps) AND share area with it? A
// separating-axis test in that plane that only counts a positive overlap, so
// two faces of one quad (an edge in common) do not.
inline bool on_plane_overlap(const Tri& a, const Tri& b) {
    if (!a.ok) return false;
    const V3 n = a.n;
    for (int k = 0; k < 3; k++) {
        if (std::fabs(dot(n, b.v[k]) - a.d) > kCoplanarEps) return false;
    }
    for (const Tri* t : { &a, &b }) {
        for (int e = 0; e < 3; e++) {
            const V3 axis = cross(n, sub(t->v[(e + 1) % 3], t->v[e]));
            double amin = 1e300, amax = -1e300, bmin = 1e300, bmax = -1e300;
            for (int k = 0; k < 3; k++) {
                const double pa = dot(axis, a.v[k]), pb = dot(axis, b.v[k]);
                amin = std::fmin(amin, pa); amax = std::fmax(amax, pa);
                bmin = std::fmin(bmin, pb); bmax = std::fmax(bmax, pb);
            }
            const double alen = std::sqrt(dot(axis, axis));
            if (std::fmin(amax, bmax) - std::fmax(amin, bmin) <= kCoplanarEps * alen) return false;
        }
    }
    return true;
}

// Either way round, so a sliver's noisy plane cannot hide a large face on it.
inline bool coplanar_overlap(const Tri& a, const Tri& b) {
    return on_plane_overlap(a, b) || on_plane_overlap(b, a);
}

// WHICH CORNER CARRIES THE FACE NORMAL (the rotation below then puts it where
// the backend reads). A SLOT is one welded (position, uv), and a triangle may
// carry its normal at any of its three. Two triangles of one face normal
// carrying it at one slot share a vertex, and the first normal at a slot rides
// the vertex the slot has anyway, so what costs a vertex is every FURTHER
// normal at a slot: a twin. Per normal, its slots must hit every one of its
// triangles, so the assignment is one hitting set per normal, the sets
// overlapping as little as can be found. A corner picked in visiting order
// lets that order decide how many twins a body emits.
//
// Integer keys and ordered containers throughout: the pick must come out the
// same on every platform, since the index buffer is the picture.

constexpr uint32_t kNoFace = ~0u;   // a zero-area triangle: claims no corner

struct Triple { uint32_t s[3]; };   // one triangle's corner slots

// The cost of a normal's hitting set against the others': PAID slots (held
// by another normal, a twin each), then size (a free slot used here is one
// fewer for the rest).
struct HitCost { uint32_t paid = 0, size = 0; };
inline bool operator<(HitCost a, HitCost b) {
    return a.paid != b.paid ? a.paid < b.paid : a.size < b.size;
}
inline HitCost operator+(HitCost a, HitCost b) { return { a.paid + b.paid, a.size + b.size }; }

// Branch and bound for one normal's min-cost hitting set, from a feasible
// INCUMBENT that bounds it. The first leaf no dearer than the incumbent is
// taken even at equal cost: that is what walks the assignment off the
// greedy's plateau. The node budget is ONE per assignment, shared by every
// search of every round: a hang guard for a model this has never met, sized
// well above what the roster spends, past which every search keeps the best
// it has (its incumbent, for a search that starts past it). A node costs the
// normal's triples, so the guard bounds the search.
constexpr size_t kHitNodes = 1 << 15;

// What every search of one assignment shares: the node count kHitNodes caps,
// and two slot-sized flag arrays, all zero between searches (`chosen` unwinds
// as a search returns; `taken`, the bound's, is cleared per node over the
// normal's own triples).
struct HitScratch {
    size_t spent = 0;
    std::vector<char> chosen, taken;
    explicit HitScratch(size_t nSlots) : chosen(nSlots, 0), taken(nSlots, 0) {}
};

struct HitSearch {
    const std::vector<Triple>& fam;
    const std::vector<uint32_t>& use;   // the OTHER normals holding each slot
    HitScratch& x;
    std::vector<uint32_t> cur, best;
    HitCost bestCost;
    bool replaced = false;

    HitSearch(const std::vector<Triple>& f, const std::vector<uint32_t>& u,
            std::vector<uint32_t> incumbent, HitScratch& scratch)
            : fam(f), use(u), x(scratch), best(std::move(incumbent)) {
        for (uint32_t s : best) bestCost = bestCost + costOf(s);
    }
    HitCost costOf(uint32_t s) const { return { use[s] ? 1u : 0u, 1 }; }

    void rec(HitCost cost) {
        if (++x.spent > kHitNodes) return;
        std::vector<char>& chosen = x.chosen;
        std::vector<char>& taken = x.taken;
        // The unhit triples, and a bound on what is left: pairwise-disjoint
        // unhit triples each need a slot of their own, a paid one when all
        // three of theirs are held.
        const Triple* first = nullptr;
        HitCost lb;
        for (const Triple& tr : fam) {
            if (chosen[tr.s[0]] || chosen[tr.s[1]] || chosen[tr.s[2]]) continue;
            if (!first) first = &tr;
            if (taken[tr.s[0]] || taken[tr.s[1]] || taken[tr.s[2]]) continue;
            HitCost c = costOf(tr.s[0]);
            for (int k = 1; k < 3; k++) if (costOf(tr.s[k]) < c) c = costOf(tr.s[k]);
            lb = lb + c;
            for (uint32_t s : tr.s) taken[s] = 1;
        }
        for (const Triple& tr : fam) {
            for (uint32_t s : tr.s) taken[s] = 0;
        }
        if (!first) {
            if (cost < bestCost || (!replaced && !(bestCost < cost))) {
                best = cur;
                bestCost = cost;
                replaced = true;
            }
            return;
        }
        const HitCost reach = cost + lb;
        if (bestCost < reach || (replaced && !(reach < bestCost))) return;
        // Branch on the first unhit triple, its free slots first.
        uint32_t order[3] = { first->s[0], first->s[1], first->s[2] };
        std::stable_sort(order, order + 3,
                [&](uint32_t a, uint32_t b) { return costOf(a) < costOf(b); });
        for (uint32_t s : order) {
            chosen[s] = 1;
            cur.push_back(s);
            rec(cost + costOf(s));
            cur.pop_back();
            chosen[s] = 0;
        }
    }
};

inline std::vector<uint32_t> hitting_set(const std::vector<Triple>& fam,
        const std::vector<uint32_t>& use, const std::vector<uint32_t>& incumbent,
        HitScratch& scratch) {
    HitSearch h(fam, use, incumbent, scratch);
    h.rec({});
    std::sort(h.best.begin(), h.best.end());
    return h.best;
}

// Rounds re-solve until one changes nothing; the cap cuts a plateau cycle,
// should one ever form.
constexpr int kAssignRounds = 8;

// The corner each triangle carries its face normal at (-1 for no area), given
// each corner's slot and each triangle's face normal id. Greedy first: the
// (slot, normal) pair at a slot no normal holds yet, else the pair serving
// the most unassigned triangles. Then every normal's set is re-solved in turn
// against the others' until a round changes nothing.
inline std::vector<int> assign_face_corners(const std::vector<uint32_t>& slot,
        const std::vector<uint32_t>& face, size_t nSlots, size_t nNormals) {
    const size_t nt = face.size();
    std::vector<std::vector<Triple>> fam(nNormals);
    std::map<std::pair<uint32_t, uint32_t>, std::vector<uint32_t>> pairs;   // (slot, normal)
    size_t left = 0;
    for (size_t t = 0; t < nt; t++) {
        if (face[t] == kNoFace) continue;
        fam[face[t]].push_back({ { slot[t * 3], slot[t * 3 + 1], slot[t * 3 + 2] } });
        for (int k = 0; k < 3; k++) pairs[{ slot[t * 3 + k], face[t] }].push_back((uint32_t) t);
        left++;
    }
    std::vector<std::vector<uint32_t>> held(nNormals);   // each normal's slots
    std::vector<uint32_t> use(nSlots, 0);                // normals holding each slot
    std::vector<char> assigned(nt, 0);
    // Each pick rescans every (slot, normal) pair: quadratic like the overlay
    // pass, and like it paid once per model.
    while (left) {
        auto best = pairs.end();
        size_t bestGain = 0;
        bool bestFree = false;
        for (auto it = pairs.begin(); it != pairs.end(); ++it) {
            size_t gain = 0;
            for (uint32_t t : it->second) gain += !assigned[t];
            if (!gain) continue;
            const bool free = use[it->first.first] == 0;
            if (best == pairs.end() || (free && !bestFree) || (free == bestFree && gain > bestGain)) {
                best = it; bestGain = gain; bestFree = free;
            }
        }
        held[best->first.second].push_back(best->first.first);
        use[best->first.first]++;
        for (uint32_t t : best->second) assigned[t] = 1;
        left -= bestGain;
    }
    for (auto& h : held) std::sort(h.begin(), h.end());
    HitScratch scratch(nSlots);
    for (int round = 0; round < kAssignRounds; round++) {
        bool changed = false;
        for (size_t n = 0; n < nNormals; n++) {
            for (uint32_t s : held[n]) use[s]--;
            std::vector<uint32_t> h = hitting_set(fam[n], use, held[n], scratch);
            for (uint32_t s : h) use[s]++;
            if (h != held[n]) {
                held[n] = std::move(h);
                changed = true;
            }
        }
        if (!changed) break;
    }
    std::vector<int> pick(nt, -1);
    for (size_t t = 0; t < nt; t++) {
        if (face[t] == kNoFace) continue;
        const std::vector<uint32_t>& h = held[face[t]];
        for (int k = 0; k < 3 && pick[t] < 0; k++) {
            if (std::binary_search(h.begin(), h.end(), slot[t * 3 + k])) pick[t] = k;
        }
    }
    return pick;
}

}  // namespace flatweld_detail

// Weld an all-flat prim (prim_all_flat) on bitwise (position, uv). Each
// triangle carries its face normal at the corner
// flatweld_detail::assign_face_corners gives it, and is rotated so that corner
// sits where the backend reads: the slot's own vertex when no normal has it
// yet, else the vertex that slot already lights for this normal, else a twin. A zero-area triangle draws
// nothing and claims no corner. Returns an empty prim for input that is not
// all-flat.
inline FlatWeld weld_flat_prim(const GlbMeshPrim& sp, bool provokingLast) {
    // Declarations, not a using-directive: an includer may have a V3 of its own.
    using flatweld_detail::Tri;
    using flatweld_detail::coplanar_overlap;
    using flatweld_detail::kNoFace;
    FlatWeld out;
    if (!prim_all_flat(sp)) return out;
    const size_t nt = sp.idx.size() / 3;
    const bool hasUv = sp.uv.size() == sp.pos.size() / 3 * 2;

    // Overlays: an earlier triangle shares its plane and some of its area.
    // Quadratic, once per model (the renderer memoises the weld).
    std::vector<Tri> tris(nt);
    for (size_t t = 0; t < nt; t++) tris[t] = flatweld_detail::tri(sp, t);
    std::vector<char> overlay(nt, 0);
    for (size_t j = 0; j < nt; j++) {
        for (size_t i = 0; i < j && !overlay[j]; i++) {
            if (coplanar_overlap(tris[i], tris[j])) overlay[j] = 1;
        }
    }

    // Slots and face normals as ids in order of first appearance, keyed on
    // their bytes (the maps are looked up, never walked).
    std::unordered_map<std::string, uint32_t> slotOf, normalOf;
    std::vector<uint32_t> slot(nt * 3), face(nt, kNoFace);
    for (size_t t = 0; t < nt; t++) {
        for (int k = 0; k < 3; k++) {
            const uint32_t v = sp.idx[t * 3 + k];
            std::string key((const char*) &sp.pos[v * 3], 12);
            if (hasUv) key.append((const char*) &sp.uv[v * 2], 8);
            slot[t * 3 + k] = slotOf.emplace(key, (uint32_t) slotOf.size()).first->second;
        }
        if (!tris[t].ok) continue;   // zero area: draws nothing, claims nothing
        const std::string key((const char*) &sp.normal[sp.idx[t * 3] * 3], 12);
        face[t] = normalOf.emplace(key, (uint32_t) normalOf.size()).first->second;
    }
    const std::vector<int> pick = flatweld_detail::assign_face_corners(
            slot, face, slotOf.size(), normalOf.size());

    GlbMeshPrim& w = out.prim;
    const auto emit = [&](uint32_t v, const float* n) {
        w.pos.insert(w.pos.end(), &sp.pos[v * 3], &sp.pos[v * 3] + 3);
        w.normal.insert(w.normal.end(), n, n + 3);
        if (hasUv) w.uv.insert(w.uv.end(), &sp.uv[v * 2], &sp.uv[v * 2] + 2);
        return (uint32_t) (w.pos.size() / 3 - 1);
    };
    constexpr uint32_t kNoVertex = ~0u;
    std::vector<uint32_t> first(slotOf.size(), kNoVertex);  // the vertex a slot has anyway
    std::vector<char> lights(slotOf.size(), 0);              // ...and whether it carries a normal yet
    std::map<std::pair<uint32_t, uint32_t>, uint32_t> lit;   // (slot, normal) -> its vertex
    const int readSlot = provokingLast ? 2 : 0;
    std::vector<uint32_t> base, over;
    for (size_t t = 0; t < nt; t++) {
        const uint32_t* c = &sp.idx[t * 3];
        const float* n = &sp.normal[c[0] * 3];
        uint32_t corner[3];
        for (int k = 0; k < 3; k++) {
            uint32_t& f = first[slot[t * 3 + k]];
            if (f == kNoVertex) f = emit(c[k], n);
            corner[k] = f;
        }
        auto& dst = overlay[t] ? over : base;
        if (pick[t] < 0) {
            dst.insert(dst.end(), corner, corner + 3);
            continue;
        }
        const uint32_t s = slot[t * 3 + pick[t]];
        auto it = lit.find({ s, face[t] });
        if (it == lit.end()) {
            uint32_t id;
            if (!lights[s]) {
                id = first[s];
                std::memcpy(&w.normal[id * 3], n, 12);
                lights[s] = 1;
            } else {
                id = emit(c[pick[t]], n);   // a twin
            }
            it = lit.emplace(std::make_pair(s, face[t]), id).first;
        }
        corner[pick[t]] = it->second;
        // Rotate (a, b, c) -> (b, c, a) until the face corner sits in the slot
        // the backend reads; a cyclic rotation keeps the winding.
        const int shift = (pick[t] - readSlot + 3) % 3;
        for (int k = 0; k < 3; k++) dst.push_back(corner[(k + shift) % 3]);
    }
    out.baseTris = base.size() / 3;
    w.idx = std::move(base);
    w.idx.insert(w.idx.end(), over.begin(), over.end());
    return out;
}

}  // namespace rt
}  // namespace ttp
