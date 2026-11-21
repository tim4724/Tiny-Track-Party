// obstacles — the scene's standing scenery as solid volume, for the lobby's
// lens (ttp/camera.h LensPlan).
//
// A coarse voxel shell of every scattered model, prop and set piece the
// renderer placed, filled from the triangles it draws (TtpRenderer::
// takeObstacles) and handed to the frame builder like the ground grid is.
// Voxels and not a box per piece: a gate, an arch or a pier bridge stands OVER
// the road, and its box would ban the road under it.
//
// It is a SHELL, the surfaces only. A lens inside a closed block has no voxel
// at its own place, but its line to anything outside crosses one, and that
// line is what the camera asks about.
//
// Header-only for the reason ground_grid.h is: the renderer fills it,
// libttp-runtime reads it, and they may not link each other.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>

#include "ttp/vecmath.h"

namespace ttp {
namespace rt {

struct Obstacles {
    static constexpr float kVoxel = 0.25f;
    // A block is 8 x 8 x 8 voxels, one bit each; only blocks holding a voxel exist.
    struct Block { uint64_t bits[8]; };
    std::vector<uint64_t> keys;   // sorted
    std::vector<Block> blocks;    // keys[i]'s

    bool empty() const { return keys.empty(); }

    bool solid(V3 p) const {
        if (keys.empty()) return false;
        const int x = cell(p.x), y = cell(p.y), z = cell(p.z);
        // A line is asked about a step at a time, so the last block answers most.
        const uint64_t key = blockKey(x, y, z);
        if (key != mAskedKey) {
            const auto it = std::lower_bound(keys.begin(), keys.end(), key);
            mAskedKey = key;
            mAsked = it != keys.end() && *it == key ? (int) (it - keys.begin()) : -1;
        }
        if (mAsked < 0) return false;
        const int bit = bitOf(x, y, z);
        return (blocks[(size_t) mAsked].bits[bit >> 6] >> (bit & 63)) & 1u;
    }

    // Filling: add every triangle, then seal() once.
    void add(V3 a, V3 b, V3 c) {
        const V3 ab = b - a, ac = c - a, bc = c - b;
        const float longest = std::sqrt(std::max({ dot(ab, ab), dot(ac, ac), dot(bc, bc) }));
        // Sampled on a lattice just under a voxel: a voxel the face only clips
        // can be missed, which is why a line is walked in half voxels
        // (wallBlocks). Finer costs the build its square and finds no more wall.
        const int n = std::max(1, (int) std::ceil(longest / (0.8f * kVoxel)));
        for (int i = 0; i <= n; i++) {
            for (int j = 0; j <= n - i; j++) {
                const V3 p = a + ab * ((float) i / n) + ac * ((float) j / n);
                const int x = cell(p.x), y = cell(p.y), z = cell(p.z);
                const uint64_t key = blockKey(x, y, z);
                if (key != mLastKey || !mLast) {
                    mLast = &mFill.try_emplace(key, Block{}).first->second;
                    mLastKey = key;
                }
                const int bit = bitOf(x, y, z);
                mLast->bits[bit >> 6] |= uint64_t{ 1 } << (bit & 63);
            }
        }
    }
    void seal() {
        keys.clear();
        blocks.clear();
        keys.reserve(mFill.size());
        for (const auto& kv : mFill) keys.push_back(kv.first);
        std::sort(keys.begin(), keys.end());
        blocks.reserve(keys.size());
        for (const uint64_t k : keys) blocks.push_back(mFill[k]);
        mFill.clear();
        mLast = nullptr;
        mAskedKey = ~uint64_t{ 0 };
    }

private:
    static int cell(float v) { return (int) std::floor(v / kVoxel); }
    // 21 bits an axis: the world is a few hundred units across.
    static uint64_t blockKey(int x, int y, int z) {
        const auto part = [](int v) { return (uint64_t) ((v >> 3) + (1 << 20)) & 0x1FFFFFu; };
        return part(x) << 42 | part(y) << 21 | part(z);
    }
    static int bitOf(int x, int y, int z) { return (x & 7) | (y & 7) << 3 | (z & 7) << 6; }

    std::unordered_map<uint64_t, Block> mFill;
    Block* mLast = nullptr;
    uint64_t mLastKey = 0;
    mutable int mAsked = -1;   // solid()'s last block (an index: a copy keeps it); no key reaches ~0
    mutable uint64_t mAskedKey = ~uint64_t{ 0 };
};

}  // namespace rt
}  // namespace ttp
