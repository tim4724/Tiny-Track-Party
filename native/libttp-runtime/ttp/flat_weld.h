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
#include <string>
#include <unordered_map>
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

}  // namespace flatweld_detail

// Weld an all-flat prim (prim_all_flat) on bitwise (position, uv). Each
// triangle keeps a corner whose normal is its face's — one already lit for
// that face, else a free one, else a twin of its first corner, which later
// faces of that normal reuse — and is rotated so that corner provokes. A
// zero-area triangle draws nothing and claims no corner. Returns an empty prim
// for input that is not all-flat.
inline FlatWeld weld_flat_prim(const GlbMeshPrim& sp, bool provokingLast) {
    // Declarations, not a using-directive: an includer may have a V3 of its own.
    using flatweld_detail::Tri;
    using flatweld_detail::coplanar_overlap;
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

    GlbMeshPrim& w = out.prim;
    std::vector<char> holdsFace;   // a welded corner already provokes for its normal
    // Every welded vertex at one (position, uv): the first, then its twins.
    std::unordered_map<std::string, std::vector<uint32_t>> ids;
    const auto emit = [&](uint32_t v, const float* n) {
        w.pos.insert(w.pos.end(), &sp.pos[v * 3], &sp.pos[v * 3] + 3);
        w.normal.insert(w.normal.end(), n, n + 3);
        if (hasUv) w.uv.insert(w.uv.end(), &sp.uv[v * 2], &sp.uv[v * 2] + 2);
        holdsFace.push_back(0);
        return (uint32_t) holdsFace.size() - 1;
    };
    const int slot = provokingLast ? 2 : 0;
    std::vector<uint32_t> base, over;
    for (size_t t = 0; t < nt; t++) {
        const uint32_t* c = &sp.idx[t * 3];
        const float* face = &sp.normal[c[0] * 3];
        std::vector<uint32_t>* twins[3];   // each corner's welded vertices
        uint32_t corner[3];
        for (int k = 0; k < 3; k++) {
            std::string key((const char*) &sp.pos[c[k] * 3], 12);
            if (hasUv) key.append((const char*) &sp.uv[c[k] * 2], 8);
            twins[k] = &ids[key];   // node-based: the pointer survives a rehash
            if (twins[k]->empty()) twins[k]->push_back(emit(c[k], face));
            corner[k] = twins[k]->front();
        }
        auto& dst = overlay[t] ? over : base;
        if (!tris[t].ok) {   // zero area: draws nothing, claims nothing
            dst.insert(dst.end(), corner, corner + 3);
            continue;
        }
        int pick = -1;
        for (int k = 0; k < 3 && pick < 0; k++) {
            for (uint32_t id : *twins[k]) {
                if (holdsFace[id] && !std::memcmp(&w.normal[id * 3], face, 12)) {
                    corner[k] = id;
                    pick = k;
                    break;
                }
            }
        }
        for (int k = 0; k < 3 && pick < 0; k++) {
            if (!holdsFace[corner[k]]) pick = k;
        }
        if (pick < 0) {   // every corner provokes for another face: a twin
            corner[0] = emit(c[0], face);
            twins[0]->push_back(corner[0]);
            pick = 0;
        }
        std::memcpy(&w.normal[corner[pick] * 3], face, 12);
        holdsFace[corner[pick]] = 1;
        // Rotate (a, b, c) -> (b, c, a) until the face corner sits in the slot
        // the backend reads; a cyclic rotation keeps the winding.
        const int shift = (pick - slot + 3) % 3;
        for (int k = 0; k < 3; k++) dst.push_back(corner[(k + shift) % 3]);
    }
    out.baseTris = base.size() / 3;
    w.idx = std::move(base);
    w.idx.insert(w.idx.end(), over.begin(), over.end());
    return out;
}

}  // namespace rt
}  // namespace ttp
