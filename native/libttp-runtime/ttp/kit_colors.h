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
    // floor by hand: the engine builds with -fno-builtin, where std::floor is a
    // call per use, and a uv is nowhere near the range a cast cannot hold.
    const auto fl = [](double t) { const double i = (double) (long long) t; return i > t ? i - 1 : i; };
    const double fx = (u - fl(u)) * w - 0.5, fy = (v - fl(v)) * h - 0.5;
    const double x0f = fl(fx), y0f = fl(fy);
    const double tx = fx - x0f, ty = fy - y0f;
    const int x0 = (int) x0f, y0 = (int) y0f;
    const auto at = [&](int x, int y) {
        return atlas + (size_t) (((y % h) + h) % h * w + ((x % w) + w) % w) * 3;
    };
    const uint8_t *p00 = at(x0, y0), *p10 = at(x0 + 1, y0), *p01 = at(x0, y0 + 1), *p11 = at(x0 + 1, y0 + 1);
    for (int k = 0; k < 3; k++) {
        const double c = (p00[k] * (1 - tx) + p10[k] * tx) * (1 - ty)
                + (p01[k] * (1 - tx) + p11[k] * tx) * ty;
        rgb[k] = (uint8_t) (c + 0.5);   // a blend of bytes is within 0..255: round to nearest
    }
}

inline void model_colors(const std::vector<rt::GlbMeshNode>& nodes,
        const uint8_t* atlas, int w, int h, Model& out) {
    int count = 0;
    for (const rt::GlbMeshNode& n : nodes) count = n.mesh + 1 > count ? n.mesh + 1 : count;
    out.meshStore.assign((size_t) count, Mesh{ 0, nullptr });
    out.primStore.resize((size_t) count);
    struct Kept { float u, v; uint8_t rgb[3]; bool set; };
    Kept kept[256] = {};
    for (const rt::GlbMeshNode& n : nodes) {
        if (n.mesh < 0 || out.meshStore[(size_t) n.mesh].prims) continue;   // decoded already
        std::vector<Prim>& prims = out.primStore[(size_t) n.mesh];
        for (const rt::GlbMeshPrim& p : n.prims) {
            const size_t verts = p.pos.size() / 3;
            out.rgbStore.emplace_back(verts * 3, (uint8_t) 255);
            uint8_t* rgb = out.rgbStore.back().data();
            if (p.textured && p.uv.size() == verts * 2) {
                // A model's vertices share a handful of uvs (a swatch's flat
                // half is one point), so the last sample of each is kept (the
                // sample is most of what a first bake costs on the TV box).
                for (size_t i = 0; i < verts; i++) {
                    const float u = p.uv[i * 2], v = p.uv[i * 2 + 1];
                    Kept& k = kept[((unsigned) (int) (u * 4096.0f) * 31u + (unsigned) (int) (v * 4096.0f)) & 255u];
                    if (!k.set || k.u != u || k.v != v) {
                        sample_atlas(atlas, w, h, u, v, k.rgb);
                        k.u = u;
                        k.v = v;
                        k.set = true;
                    }
                    rgb[i * 3] = k.rgb[0];
                    rgb[i * 3 + 1] = k.rgb[1];
                    rgb[i * 3 + 2] = k.rgb[2];
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
