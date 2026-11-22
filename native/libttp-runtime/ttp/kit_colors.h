// kit_colors — every vertex's BASE COLOUR for one kit model, so the renderer
// can fold a static copy's light into its vertices at scene build without the
// GPU sampling the atlas.
//
// WHY A VERTEX SAMPLE IS EXACT. The kit's atlas (scripts/gen-colormap.mjs) is
// a grid of swatches, each a flat half beside a near-linear ramp down the
// other, and every kit face's UV triangle is a POINT or a VERTICAL LINE inside
// one half. So the texture sampled at a vertex and interpolated across the
// triangle is the picture the fragment shader draws.
//
// The colour is the TEXTURE half of vglb.mat's ttpGlbBaseColor: the atlas's
// own sRGB bytes, sampled the way the GPU samples them (REPEAT, linear; the
// scene is authored in display space, so the bytes are the albedo), and white
// for an untextured material. The baseColorFactor is NOT folded in: the biome
// recolours untextured models by overriding it on the live instance, so the
// renderer multiplies the factor it reads back at bake time.
//
// Header-only for glb_mesh.h's reason: the renderer consumes it, and a ctest
// can run it without a Filament SDK. The sample is in doubles and rounds to
// nearest, the arithmetic the table this replaced was generated with.
#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

#include "ttp/glb_mesh.h"

namespace ttp {
namespace kitcolors {

struct Prim { uint32_t vertexCount; const uint8_t* rgb; };
struct Mesh { uint32_t primCount; const Prim* prims; };
// One model's colours, indexed by glTF MESH index (GlbMeshNode::mesh). Owns
// what the views above point into, so it is built in place and never copied.
struct Model {
    uint32_t meshCount = 0;
    const Mesh* meshes = nullptr;
    std::vector<Mesh> meshStore;
    std::vector<std::vector<Prim>> primStore;
    std::vector<std::vector<uint8_t>> rgbStore;
    Model() = default;
    Model(const Model&) = delete;
    Model& operator=(const Model&) = delete;
};

// The atlas (`w` x `h` RGB bytes, top row first) at (u, v), into rgb[3].
inline void sample_atlas(const uint8_t* atlas, int w, int h, float u, float v, uint8_t* rgb) {
    const auto wrap = [](double t) { return t - std::floor(t); };
    const double fx = wrap(u) * w - 0.5, fy = wrap(v) * h - 0.5;
    const double x0f = std::floor(fx), y0f = std::floor(fy);
    const double tx = fx - x0f, ty = fy - y0f;
    const int x0 = (int) x0f, y0 = (int) y0f;
    const auto at = [&](int x, int y) {
        return atlas + (size_t) (((y % h) + h) % h * w + ((x % w) + w) % w) * 3;
    };
    const uint8_t *p00 = at(x0, y0), *p10 = at(x0 + 1, y0), *p01 = at(x0, y0 + 1), *p11 = at(x0 + 1, y0 + 1);
    for (int k = 0; k < 3; k++) {
        const double c = (p00[k] * (1 - tx) + p10[k] * tx) * (1 - ty)
                + (p01[k] * (1 - tx) + p11[k] * tx) * ty;
        rgb[k] = (uint8_t) std::floor(std::fmin(255.0, std::fmax(0.0, c)) + 0.5);
    }
}

inline void model_colors(const std::vector<rt::GlbMeshNode>& nodes,
        const uint8_t* atlas, int w, int h, Model& out) {
    int count = 0;
    for (const rt::GlbMeshNode& n : nodes) count = n.mesh + 1 > count ? n.mesh + 1 : count;
    out.meshStore.assign((size_t) count, Mesh{ 0, nullptr });
    out.primStore.resize((size_t) count);
    for (const rt::GlbMeshNode& n : nodes) {
        if (n.mesh < 0 || out.meshStore[(size_t) n.mesh].prims) continue;   // decoded already
        std::vector<Prim>& prims = out.primStore[(size_t) n.mesh];
        for (const rt::GlbMeshPrim& p : n.prims) {
            const size_t verts = p.pos.size() / 3;
            out.rgbStore.emplace_back(verts * 3, (uint8_t) 255);
            uint8_t* rgb = out.rgbStore.back().data();
            if (p.textured && p.uv.size() == verts * 2) {
                for (size_t i = 0; i < verts; i++) {
                    sample_atlas(atlas, w, h, p.uv[i * 2], p.uv[i * 2 + 1], rgb + i * 3);
                }
            }
            prims.push_back({ (uint32_t) verts, rgb });
        }
        // A mesh with no primitives keeps a non-null `prims` too: the guard above.
        static const Prim kNone{ 0, nullptr };
        out.meshStore[(size_t) n.mesh] = { (uint32_t) prims.size(), prims.empty() ? &kNone : prims.data() };
    }
    out.meshCount = (uint32_t) count;
    out.meshes = out.meshStore.data();
}

}  // namespace kitcolors
}  // namespace ttp
