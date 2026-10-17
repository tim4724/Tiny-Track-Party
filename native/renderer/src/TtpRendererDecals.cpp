// The road-shader channels — the skid raster, the car-shadow pass, deck decals and
// paint — plus their 3D markers. TtpRendererImpl.h carries what the topic
// files share.
#include "TtpRendererImpl.h"

#include <utils/Log.h>

#include <algorithm>


// Zero the rubber layer — the build-time init and the race-restart wipe. A
// memset of the CPU accumulation buffer, a whole-level-0 upload, and a mip
// regeneration. Deliberately not a GPU clear: a draw-less clear rides a pass
// the FrameGraph may cull (it did, on the A10X), and this layer has no
// passes at all any more — see the mSkidPix comment in TtpRenderer.h.
void TtpRenderer::clearSkidLayer() {
    if (!mSkidTex || mSkidPix.empty()) return;
    std::fill(mSkidPix.begin(), mSkidPix.end(), (uint8_t) 0);
    mSkidDirty.clear();
    // The CPU mip truth zeroes with it — generateMipmaps below zeroes the
    // GPU chain, and the two must agree before the next incremental refresh.
    for (auto& level : mSkidMips) std::fill(level.begin(), level.end(), (uint8_t) 0);
    mSkidMipDirty.clear();
    mSkidMipRects.clear();
    mSkidMipLevel = 0;
    const size_t bytes = mSkidPix.size();
    auto* zeros = new uint8_t[bytes]();
    mSkidTex->setImage(*mEngine, 0,
            Texture::PixelBufferDescriptor(zeros, bytes,
                    Texture::Format::R, Texture::Type::UBYTE,
                    [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                    nullptr));
    // The whole mip chain too. The GL backend clamps sampling to level 0
    // until the first generateMipmaps; Metal has no such clamp, so an
    // un-generated chain is garbage under the trilinear tap.
    mSkidTex->generateMipmaps(*mEngine);
}

// One stamp triangle into the CPU accumulation buffer: texel space, top-left
// fill rule (shared joint edges never double-ink — the same guarantee the GPU
// rasterizer gave the connected ribbons), ink linearly interpolated across
// the triangle and added with saturation (vskid.mat was blending:add on R8).
// x arrives UNWRAPPED (a segment near the seam runs past W); the write wraps
// per row. y is clamped-out rather than wrapped — the stamper's lat margin
// keeps real marks rows away from the CLAMP edge anyway.
void TtpRenderer::rasterSkidTri(const float2* p, const float* ink) {
    const int W = (int) mSkidTexW, H = (int) mSkidTexH;
    if (W <= 0 || H <= 0) return;
    const float area = (p[1].x - p[0].x) * (p[2].y - p[0].y)
                     - (p[2].x - p[0].x) * (p[1].y - p[0].y);
    if (area == 0.0f) return;
    // Winding-independent: flip to counter-clockwise once so the edge tests
    // and the top-left rule read the same for both triangles of a quad.
    const float2 a = p[0];
    const float2 b = area > 0 ? p[1] : p[2];
    const float2 c = area > 0 ? p[2] : p[1];
    const float ib = area > 0 ? ink[1] : ink[2];
    const float ic = area > 0 ? ink[2] : ink[1];
    const float inv = 1.0f / std::fabs(area);
    const int y0 = std::max(0, (int) std::ceil(
            std::min(a.y, std::min(b.y, c.y)) - 0.5f));
    const int y1 = std::min(H - 1, (int) std::floor(
            std::max(a.y, std::max(b.y, c.y)) - 0.5f + 1.0f));
    const int x0 = (int) std::ceil(std::min(a.x, std::min(b.x, c.x)) - 0.5f);
    const int x1 = (int) std::floor(std::max(a.x, std::max(b.x, c.x)) - 0.5f + 1.0f);
    // Edge functions at pixel centres (x+0.5, y+0.5); top-left rule: a pixel
    // exactly on an edge belongs to the triangle whose edge is top or left.
    const auto edge = [](const float2& e0, const float2& e1, float px, float py) {
        return (e1.x - e0.x) * (py - e0.y) - (e1.y - e0.y) * (px - e0.x);
    };
    const auto topLeft = [](const float2& e0, const float2& e1) {
        return (e0.y == e1.y && e1.x < e0.x) || e1.y > e0.y;
    };
    const bool tlAB = topLeft(a, b), tlBC = topLeft(b, c), tlCA = topLeft(c, a);
    // The wrapped x of the first column, once; each row counts on from it
    // rather than paying two software divides a texel on the armv7 box.
    const int wx0 = ((x0 % W) + W) % W;
    for (int y = y0; y <= y1; y++) {
        uint8_t* row = mSkidPix.data() + (size_t) y * W;
        const float py = (float) y + 0.5f;
        for (int x = x0, wx = wx0; x <= x1;
                x++, wx = (wx + 1 == W) ? 0 : wx + 1) {
            const float px = (float) x + 0.5f;
            const float eAB = edge(a, b, px, py);
            const float eBC = edge(b, c, px, py);
            const float eCA = edge(c, a, px, py);
            if ((eAB > 0 || (eAB == 0 && tlAB))
                    && (eBC > 0 || (eBC == 0 && tlBC))
                    && (eCA > 0 || (eCA == 0 && tlCA))) {
                // Barycentric ink: eBC weighs vertex a, eCA weighs b, eAB c.
                const float w = (ink[0] * eBC + ib * eCA + ic * eAB) * inv;
                const int sum = (int) row[wx]
                        + (int) std::lround(std::max(0.0f, w) * 255.0f);
                row[wx] = (uint8_t) std::min(255, sum);
            }
        }
    }
}

// UPLOAD EVENTS ARE THE COST, NOT UPLOAD BYTES. On the Android box's Vulkan
// driver every setImage is its own kick, and a 4P frame was issuing a dozen
// or two of them across the two deck layers (counted on the device log: 400
// to 870 rubber copies and 300 to 490 shadow copies per 60 frames, a few
// hundred texels each) for ~1.7 ms of a 17 ms 540-line frame. Sending every
// rubber rect of a frame as ONE copy — a hundred times the bytes — took a
// millisecond of that back. The barrier's stage masks (a fork arm that
// skipped the fragment-read wait), an in-flight reader (uploads into a twin
// that nothing samples) and the texture's shape (one level, no mip usage,
// half the rows) all measured null first. So a frame's rects are merged
// here by arclength until a merge would exceed a byte budget: cars in a
// pack share a copy, a lone car gets its own. The budget is the ONLY
// test — two rects need not touch to share a copy — because bytes were free
// at the sizes the one-copy arm reached (up to 650 KB in a frame); it is
// set where a merged copy stays a block of the layer rather than a strip of
// the whole lap.
static constexpr size_t kUploadEventTexels = 512 * 512;

void TtpRenderer::mergeUploadRects(std::vector<SkidRect>& rects) {
    if (rects.size() < 2) return;
    std::sort(rects.begin(), rects.end(),
            [](const SkidRect& a, const SkidRect& b) { return a.x0 < b.x0; });
    std::vector<SkidRect> out;
    out.reserve(rects.size());
    out.push_back(rects[0]);
    for (size_t i = 1; i < rects.size(); i++) {
        SkidRect& m = out.back();
        const SkidRect& r = rects[i];
        const SkidRect u{ std::min(m.x0, r.x0), std::min(m.y0, r.y0),
                          std::max(m.x1, r.x1), std::max(m.y1, r.y1) };
        if ((size_t) (u.x1 - u.x0) * (size_t) (u.y1 - u.y0) <= kUploadEventTexels) {
            m = u;
        } else {
            out.push_back(r);
        }
    }
    rects.swap(out);
}

// Push this frame's dirty rects into the texture. Each rect is a tight copy
// with its own free callback — the CPU buffer is mutated again next frame,
// and native drivers read uploads asynchronously, so handing them a pointer
// into mSkidPix would race. Unwrapped x splits at the lap seam here, once
// per rect. Merged first: see kUploadEventTexels.
void TtpRenderer::uploadSkidRects() {
    const int W = (int) mSkidTexW, H = (int) mSkidTexH;
    mergeUploadRects(mSkidDirty);
    for (const SkidRect& r : mSkidDirty) {
        const int y0 = std::max(0, r.y0), y1 = std::min(H, r.y1);
        if (y0 >= y1) continue;
        // A rect spanning the whole width (a teleport-length segment cannot
        // happen, but belt and braces) collapses to one full-width strip.
        int spans[2][2];
        int nSpans = 0;
        if (r.x1 - r.x0 >= W) {
            spans[nSpans][0] = 0; spans[nSpans][1] = W; nSpans = 1;
        } else {
            const int wx0 = ((r.x0 % W) + W) % W;
            const int wx1 = wx0 + (r.x1 - r.x0);
            if (wx1 <= W) {
                spans[nSpans][0] = wx0; spans[nSpans][1] = wx1; nSpans = 1;
            } else {                       // crosses the seam: two strips
                spans[0][0] = wx0; spans[0][1] = W;
                spans[1][0] = 0;   spans[1][1] = wx1 - W;
                nSpans = 2;
            }
        }
        for (int s = 0; s < nSpans; s++) {
            const int sx0 = spans[s][0], sx1 = spans[s][1];
            const int sw = sx1 - sx0, sh = y1 - y0;
            if (sw <= 0 || sh <= 0) continue;
            // The same PHYSICAL rect feeds the throttled mip refresh — one
            // wrap-split, owned here, so the two paths cannot disagree on it.
            mSkidMipDirty.push_back({ sx0, y0, sx1, y1 });
            auto* buf = new uint8_t[(size_t) sw * sh];
            for (int y = 0; y < sh; y++) {
                std::memcpy(buf + (size_t) y * sw,
                        mSkidPix.data() + (size_t) (y0 + y) * W + sx0,
                        (size_t) sw);
            }
            mSkidTex->setImage(*mEngine, 0, (uint32_t) sx0, (uint32_t) y0,
                    (uint32_t) sw, (uint32_t) sh,
                    Texture::PixelBufferDescriptor(buf, (size_t) sw * sh,
                            Texture::Format::R, Texture::Type::UBYTE,
                            [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                            nullptr));
        }
    }
    mSkidDirty.clear();
}

// The rubber layer's mip refresh: box-filter the accumulated dirty rects down
// the CPU chain and upload only those sub-rects, level by level. This REPLACED
// the throttled generateMipmaps, and the difference is not the filtering — the
// 2x2 average below is what the blit computed — it is what the driver was
// asked to do: a full-chain generateMipmaps on the 8192-wide layer is a dozen
// render passes re-filtering megatexels to update a few hundred, issued
// mid-frame, and on the reference Android box it measured as ~10 dropped
// frames per second on its own (live A/B, rubber gated whole vs on — the GPU
// MEDIAN did not move, which is why no frozen bench ever saw it). Rects are
// merged per level (a car's four wheels collapse to one rect within a couple
// of levels), so the deep chain is a handful of texel-sized uploads.
//
// Reads at a rect's edge reach one texel OUTSIDE it on odd boundaries; those
// neighbours did not change this round, and the CPU chain is kept globally
// consistent by construction, so what they hold is exactly what the filter
// wants. The seam is deliberately NOT wrapped — generateMipmaps never wrapped
// either, and the marks the stamper lays keep clear of the clamp rows.
//
// ONE LEVEL PER CALL. A pass used to land every level's copies in one frame,
// and on the Android box each copy is its own kick (kUploadEventTexels): the
// pass was the p95 of otherwise-quiet seconds — GPU p50 13.4 with p95 17.4
// and three skips in the second — twice a second at four cells. Spread over
// the chain's dozen frames it is a couple of copies a frame, like any other.
// The chain stays consistent: a level is always the filter of the level
// above as of an earlier frame, and the next pass recomputes every level
// under whatever changed since.
void TtpRenderer::refreshSkidMips() {
    if (!mSkidTex || mSkidMips.empty()) {
        mSkidMipDirty.clear(); mSkidMipRects.clear(); mSkidMipLevel = 0;
        return;
    }
    if (mSkidMipLevel == 0) {                    // start a pass
        if (mSkidMipDirty.empty()) return;
        mSkidMipRects.swap(mSkidMipDirty);
        mSkidMipDirty.clear();
        mSkidMipLevel = 1;
    }
    const int W0 = (int) mSkidTexW, H0 = (int) mSkidTexH;
    std::vector<SkidRect> rects = std::move(mSkidMipRects);
    mSkidMipRects.clear();
    {
        const size_t li = (size_t) mSkidMipLevel - 1;
        if (li >= mSkidMips.size() || rects.empty()) { mSkidMipLevel = 0; return; }
        const int l = mSkidMipLevel;
        const int sw = std::max(1, W0 >> (l - 1)), sh = std::max(1, H0 >> (l - 1));
        const int dw = std::max(1, W0 >> l), dh = std::max(1, H0 >> l);
        const uint8_t* src = li == 0 ? mSkidPix.data() : mSkidMips[li - 1].data();
        uint8_t* dst = mSkidMips[li].data();
        // Halve every rect, then merge overlaps — O(n²) over a handful.
        std::vector<SkidRect> next;
        for (const SkidRect& r : rects) {
            SkidRect d{ std::max(0, r.x0 >> 1), std::max(0, r.y0 >> 1),
                        std::min(dw, (r.x1 + 1) >> 1), std::min(dh, (r.y1 + 1) >> 1) };
            if (d.x0 >= d.x1 || d.y0 >= d.y1) continue;
            bool merged = false;
            for (SkidRect& m : next) {
                if (d.x0 <= m.x1 && m.x0 <= d.x1 && d.y0 <= m.y1 && m.y0 <= d.y1) {
                    m.x0 = std::min(m.x0, d.x0); m.y0 = std::min(m.y0, d.y0);
                    m.x1 = std::max(m.x1, d.x1); m.y1 = std::max(m.y1, d.y1);
                    merged = true;
                    break;
                }
            }
            if (!merged) next.push_back(d);
        }
        mergeUploadRects(next);
        for (const SkidRect& d : next) {
            for (int y = d.y0; y < d.y1; y++) {
                const uint8_t* row0 = src + (size_t) std::min(2 * y, sh - 1) * sw;
                const uint8_t* row1 = src + (size_t) std::min(2 * y + 1, sh - 1) * sw;
                uint8_t* drow = dst + (size_t) y * dw;
                // 2x+1 <= sw-1 for every x < sw/2, so the clamps only bind on
                // the tail. The interior is the same integer sum unclamped, which
                // the clamps kept scalar and which vectorises on armeabi-v7a.
                const int xe = std::min(d.x1, sw / 2);
                int x = d.x0;
                for (; x < xe; x++) {
                    drow[x] = (uint8_t) (((int) row0[2 * x] + row0[2 * x + 1]
                            + row1[2 * x] + row1[2 * x + 1] + 2) >> 2);
                }
                for (; x < d.x1; x++) {
                    const int sx0 = std::min(2 * x, sw - 1);
                    const int sx1 = std::min(2 * x + 1, sw - 1);
                    drow[x] = (uint8_t) (((int) row0[sx0] + row0[sx1]
                            + row1[sx0] + row1[sx1] + 2) >> 2);
                }
            }
            const int uw = d.x1 - d.x0, uh = d.y1 - d.y0;
            auto* buf = new uint8_t[(size_t) uw * uh];
            for (int y = 0; y < uh; y++) {
                std::memcpy(buf + (size_t) y * uw,
                        dst + (size_t) (d.y0 + y) * dw + d.x0, (size_t) uw);
            }
            mSkidTex->setImage(*mEngine, (size_t) l,
                    (uint32_t) d.x0, (uint32_t) d.y0, (uint32_t) uw, (uint32_t) uh,
                    Texture::PixelBufferDescriptor(buf, (size_t) uw * uh,
                            Texture::Format::R, Texture::Type::UBYTE,
                            [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                            nullptr));
        }
        mSkidMipRects = std::move(next);
        mSkidMipLevel = (mSkidMipRects.empty() || (size_t) mSkidMipLevel >= mSkidMips.size())
                ? 0 : mSkidMipLevel + 1;
    }
}


// ── The blob's SHAPE, per car model ─────────────────────────────────────────
//
// One model's outline, CAPTURED, rasterized top-down and FITTED, once.
//
// The GEOMETRY comes from `ttp/glb_mesh.h` — the same decode the merged draw
// groups already memoise off the same bytes, so this adds no parse — and the
// NODE TRANSFORMS come from the gltfio asset, matched by node name exactly as
// buildMergedCarGroups matches them. That split is deliberate: glb_mesh reads
// geometry and has no business knowing a scene hierarchy, and the renderer is
// the only thing here that holds one.
//
// **THE ASSET MUST BE AT ITS PARSE POSE.** This is the load path's to call and
// nobody else's: `getWorldTransform` answers where the car IS, and a car that
// has started racing is hundreds of units from the mask's frame, so a capture
// taken then rasterizes to nothing at all. That failure is silent on the glass
// — every car simply falls back to the default fit — which is why the capture
// is refused below rather than let through.
bool TtpRenderer::bakeCarFootprint(uint64_t key, const std::vector<uint8_t>& glb,
        gltfio::FilamentAsset* asset, const float3& bbMin, const float3& bbMax) {
    if (!key || !asset || !mEngine) return false;
    const std::vector<ttp::rt::GlbMeshNode>* nodes = glbMeshes(key, glb);
    if (!nodes || nodes->empty()) return false;
    const float halfX = (bbMax.x - bbMin.x) * 0.5f;
    const float halfZ = (bbMax.z - bbMin.z) * 0.5f;
    if (!(halfX > 0.0f) || !(halfZ > 0.0f)) return false;
    std::vector<float> xz;      // 2 floats per vertex, model (x, z)
    std::vector<uint32_t> idx;

    auto& tcm = mEngine->getTransformManager();
    for (const ttp::rt::GlbMeshNode& n : *nodes) {
        if (n.name.empty()) continue;
        const utils::Entity e = asset->getFirstEntityByName(n.name.c_str());
        if (e.isNull()) continue;
        const auto ti = tcm.getInstance(e);
        // A node the asset does not own under that name contributes nothing —
        // its geometry would land at the origin and print a blot in the middle
        // of the shadow, which is worse than the outline it was meant to add.
        if (!ti) continue;
        const mat4f wm = tcm.getWorldTransform(ti);
        for (const ttp::rt::GlbMeshPrim& p : n.prims) {
            const uint32_t base = (uint32_t) (xz.size() / 2);
            const size_t verts = p.pos.size() / 3;
            for (size_t v = 0; v < verts; v++) {
                const float3 wp = (wm * float4{ p.pos[v * 3], p.pos[v * 3 + 1],
                        p.pos[v * 3 + 2], 1.0f }).xyz;
                xz.push_back(wp.x);
                xz.push_back(wp.z);
            }
            for (const uint32_t i : p.idx) idx.push_back(base + i);
        }
    }
    // A CAPTURE OFF A POSED ASSET IS THE ONE MISTAKE THIS CANNOT SURVIVE, and
    // it is invisible downstream, so it is refused here instead: every roster
    // model is origin-centred at rest, so an outline whose extent does not
    // straddle the origin was measured somewhere out on the track.
    float lo = 1e30f, hi = -1e30f;
    for (size_t v = 0; v + 1 < xz.size(); v += 2) {
        lo = std::min(lo, xz[v]);
        hi = std::max(hi, xz[v]);
    }
    if (xz.empty() || lo > halfX || hi < -halfX) {
        utils::slog.w << "bakeCarFootprint: model " << (unsigned long long) key
                << " was not at its rest pose — outline refused" << utils::io::endl;
        return false;
    }
    ttp::rt::FootprintSpec spec;
    spec.w = kCarShadowMaskW;
    spec.h = kCarShadowMaskH;
    spec.overscan = mShadowTune.overscan;
    const std::vector<float> mask = ttp::rt::car_footprint_mask(xz.data(), xz.size() / 2,
            idx.data(), idx.size(), halfX, halfZ, spec);
    // An outline that came out blank is a FAILED bake, not a car with no
    // shadow. Leave the model absent from the store and it stamps the default
    // fit: a blank mask would fit to nothing, and no screenshot gate separates
    // that from a car that simply has no shadow.
    if (mask.empty()) {
        utils::slog.w << "carFootprint: empty outline for model "
                << (unsigned long long) key << " — the default fit stands in"
                << utils::io::endl;
        return false;
    }
    mCarShadowFits[key] = ttp::rt::fit_rounded_rect(mask, spec);
    return true;
}

// Which shape slot `i` stamps: its model's fit, or the default fit when the
// model has none — the fallback is a shape, not a blank. A car wearing the
// MONSTER keeps its own shape — the stamp just scales (kMonsterShadowScale).
ttp::rt::RoundedFit TtpRenderer::carShadowFitFor(size_t slot) const {
    ttp::rt::RoundedFit fit;
    const uint64_t key =
            mCarShadowMaskOfSlot.size() > slot ? mCarShadowMaskOfSlot[slot] : 0;
    const auto it = key ? mCarShadowFits.find(key) : mCarShadowFits.end();
    if (it != mCarShadowFits.end()) fit = it->second;
    fit.corner = std::min(1.0f, fit.corner);
    return fit;
}

// THE CAR SHADOW: a primitive per car slot over the pass's own vertex and
// index buffers (TtpRenderer.h, mCarShadowVb), every primitive empty until
// flushCarShadows fills them with this frame's strips. Culling off: the
// bounds would have to follow the cars, and the draw is a few dozen
// triangles. No polygon offset: the depth bias is vshadow.mat's vertex shrink.
void TtpRenderer::buildCarShadowDraws() {
    mCarShadowMi.clear();
    mCarShadowRange.assign(kCarShadowDraws, { 0, 0 });
    // Fresh instances know no stamp: the per-slot memory of what is bound
    // must forget too, or a rebuilt scene's instances never get a texture.
    mCarShadowStampBound.assign(kCarShadowDraws, ~0ull);
    // No mTrack test: the track is adopted after the road is built, and the
    // buffers need only the material.
    if (!mShadowMaterial) return;
    mCarShadowVb = VertexBuffer::Builder()
            .vertexCount((uint32_t) kCarShadowVtxCap)
            .bufferCount(2)
            .attribute(VertexAttribute::POSITION, 0, VertexBuffer::AttributeType::FLOAT3)
            .attribute(VertexAttribute::CUSTOM0, 1, VertexBuffer::AttributeType::HALF4)
            .build(*mEngine);
    mCarShadowIb = IndexBuffer::Builder()
            .indexCount((uint32_t) kCarShadowIdxCap)
            .bufferType(IndexBuffer::IndexType::UINT)
            .build(*mEngine);
    if (!mCarShadowVb || !mCarShadowIb) return;
    RenderableManager::Builder builder(kCarShadowDraws);
    builder.boundingBox({ float3{ 0.0f }, float3{ 1e4f } })
            .culling(false)
            .receiveShadows(false)
            .castShadows(false);
    for (size_t k = 0; k < kCarShadowDraws; k++) {
        MaterialInstance* mi = sceneInstance(mShadowMaterial);
        mCarShadowMi.push_back(mi);
        builder.material(k, mi)
               .geometry(k, RenderableManager::PrimitiveType::TRIANGLES, mCarShadowVb, mCarShadowIb, 0, 0);
    }
    mCarShadowEntity = utils::EntityManager::get().create();
    builder.build(*mEngine, mCarShadowEntity);
    mScene->addEntity(mCarShadowEntity);
}

void TtpRenderer::hideCarShadowDraws() {
    mCarShadowPos.clear();
    mCarShadowC0.clear();
    mCarShadowIdx.clear();
    mCarShadowRange.assign(kCarShadowDraws, { 0, 0 });
}

// Lay slot `slot`'s geometry and hand the shader the car's frame, fit and
// stamp. The box: the yawed quad's extents along and across the track plus
// the ramp, clamped to the deck's width (the shadow stops at the edge; the
// kerb is raised geometry and would hide it anyway). The geometry: the
// road's own triangles under that box, clipped to it (TtpRenderer.h,
// mCarShadowVb).
namespace {
// A clip vertex: (t, lat) along and across the ring cell, and the stamp's
// (u, v) there. Both pairs are affine over one road triangle (world position
// is affine in uv0 inside it, and the stamp's frame is affine in world), so
// linear interpolation along a clipped edge is exact for all four.
struct ClipV { float t, l, u, v; };
// Sutherland-Hodgman against one half-plane: keep where f(v) >= 0.
template <typename F>
int clipPoly(const ClipV* in, int n, ClipV* out, F f) {
    int m = 0;
    for (int i = 0; i < n; i++) {
        const ClipV& p = in[i];
        const ClipV& q = in[(i + 1) % n];
        const float fp = f(p), fq = f(q);
        if (fp >= 0.0f) out[m++] = p;
        if ((fp >= 0.0f) != (fq >= 0.0f)) {
            const float w = fp / (fp - fq);
            out[m++] = { p.t + (q.t - p.t) * w, p.l + (q.l - p.l) * w,
                         p.u + (q.u - p.u) * w, p.v + (q.v - p.v) * w };
        }
    }
    return m;
}
}  // namespace

void TtpRenderer::placeCarShadow(size_t slot, const float3& origin, const float3& fwd,
        const float3& right, float halfF, float halfR, float carS, float alpha,
        const ttp::rt::RoundedFit& fit) {
    if (slot >= mCarShadowMi.size() || !mTrack || !mCarShadowVb) return;
    const float L = mTrack->length;
    const int N = (int) mTrack->rings.size();
    if (L <= 0.0f || N < 2 || halfF <= 0.0f || halfR <= 0.0f) return;
    if (mRingLight.size() != (size_t) N) return;
    // The model's stamp first: its support box is what the geometry is
    // clipped to below.
    const uint64_t key = mCarShadowMaskOfSlot.size() > slot ? mCarShadowMaskOfSlot[slot] : 0;
    const CarShadowStamp* stamp = carShadowStamp(key, fit);
    if (!stamp) return;
    const float4 sup = stamp->support;
    const TrackBin::Sample f0 = mTrack->frameAt(carS);
    float cs = dot(f0.tangent(), fwd), sn = dot(f0.lat, fwd);
    const float nl = std::sqrt(cs * cs + sn * sn);
    if (nl > 1e-5f) { cs /= nl; sn /= nl; } else { cs = 1; sn = 0; }
    // The box only has to CONTAIN the stamp's quad (the (u, v) clip below is
    // the exact edge), so its margin is rounding slack, not the ramp.
    const float margin = 0.05f;
    const float reachS = std::fabs(halfF * cs) + std::fabs(halfR * sn) + margin;
    const float reachL = std::fabs(halfF * sn) + std::fabs(halfR * cs) + margin;
    const float carLat = dot(origin - f0.pos, f0.lat);
    const float h = f0.width * 0.5f;
    const float l0 = std::max(-h, carLat - reachL), l1 = std::min(h, carLat + reachL);
    if (l1 <= l0) return;
    const float ringLen = L / (float) N;
    const float s0 = carS - reachS, s1 = carS + reachS;   // unwrapped
    const int i0 = (int) std::floor(s0 / ringLen), i1 = (int) std::floor(s1 / ringLen);
    const uint32_t off = (uint32_t) mCarShadowIdx.size();
    // The stamp's (u, v) at a world point, vshadow.mat's own expression.
    const float invR2 = 0.5f / halfR, invF2 = 0.5f / halfF;
    const auto stampUV = [&](const float3& W, float& u, float& v) {
        const float3 d = W - origin;
        u = dot(d, right) * invR2 + 0.5f;
        v = dot(d, fwd) * invF2 + 0.5f;
    };
    TrackBin::DeckQuad q;
    bool full = false;   // the shared buffers' caps reached: the slot keeps what fits
    for (int ii = i0; ii <= i1 && ii - i0 <= 2 * kCarShadowRings && !full; ii++) {
        const int i = ((ii % N) + N) % N;
        const int j = (i + 1) % N;
        mTrack->deckQuadAt(i, q);
        // The box's share of this cell, as t along it.
        const float ta = std::max(0.0f, (s0 - (float) ii * ringLen) / ringLen);
        const float tb = std::min(1.0f, (s1 - (float) ii * ringLen) / ringLen);
        if (tb <= ta) continue;
        const math::half4& la = mRingLight[(size_t) i];
        const math::half4& lb = mRingLight[(size_t) j];
        const float4 lightA{ (float) la.x, (float) la.y, (float) la.z, (float) la.w };
        const float4 lightB{ (float) lb.x, (float) lb.y, (float) lb.z, (float) lb.w };
        for (int k = 0; k < 7 && !full; k++) {   // the deck's seven strips, bounds k..k+1
            if (std::max(q.bA[k + 1], q.bB[k + 1]) <= l0 || std::min(q.bA[k], q.bB[k]) >= l1) continue;
            // The cell's two triangles, (a@i, b@i, b@ni) and (a@i, b@ni, a@ni),
            // in (t, lat) with their world corners — the road's own soup.
            const float3 WAlo = q.posA + q.latA * q.bA[k], WAhi = q.posA + q.latA * q.bA[k + 1];
            const float3 WBlo = q.posB + q.latB * q.bB[k], WBhi = q.posB + q.latB * q.bB[k + 1];
            ClipV Alo{ 0.0f, q.bA[k], 0, 0 }, Ahi{ 0.0f, q.bA[k + 1], 0, 0 };
            ClipV Blo{ 1.0f, q.bB[k], 0, 0 }, Bhi{ 1.0f, q.bB[k + 1], 0, 0 };
            stampUV(WAlo, Alo.u, Alo.v); stampUV(WAhi, Ahi.u, Ahi.v);
            stampUV(WBlo, Blo.u, Blo.v); stampUV(WBhi, Bhi.u, Bhi.v);
            const ClipV* tris[2][3] = { { &Alo, &Ahi, &Bhi }, { &Alo, &Bhi, &Blo } };
            const float3* wtri[2][3] = { { &WAlo, &WAhi, &WBhi }, { &WAlo, &WBhi, &WBlo } };
            for (int tri = 0; tri < 2 && !full; tri++) {
                ClipV poly[12], tmp[12];
                int n = 3;
                for (int c = 0; c < 3; c++) poly[c] = *tris[tri][c];
                // The box in (t, lat) first — a cheap bound — then THE STAMP'S
                // OWN SUPPORT in (u, v): the field is zero outside it, and
                // every fragment the box adds beyond that is a fragment this
                // GPU pays for nothing (a yawed car's box is twice its quad,
                // and the ramp's margin on top of that).
                n = clipPoly(poly, n, tmp, [&](const ClipV& v) { return v.t - ta; });
                n = clipPoly(tmp, n, poly, [&](const ClipV& v) { return tb - v.t; });
                n = clipPoly(poly, n, tmp, [&](const ClipV& v) { return v.l - l0; });
                n = clipPoly(tmp, n, poly, [&](const ClipV& v) { return l1 - v.l; });
                n = clipPoly(poly, n, tmp, [&](const ClipV& v) { return v.u - sup.x; });
                n = clipPoly(tmp, n, poly, [&](const ClipV& v) { return sup.y - v.u; });
                n = clipPoly(poly, n, tmp, [&](const ClipV& v) { return v.v - sup.z; });
                n = clipPoly(tmp, n, poly, [&](const ClipV& v) { return sup.w - v.v; });
                if (n < 3) continue;
                if (mCarShadowPos.size() + (size_t) n > kCarShadowVtxCap
                        || mCarShadowIdx.size() + (size_t) (n - 2) * 3 > kCarShadowIdxCap) {
                    full = true;
                    break;
                }
                // Barycentric in (t, lat) — uv0 is affine over the triangle,
                // so this IS the map the rasterizer interpolates.
                const ClipV& P0 = *tris[tri][0]; const ClipV& P1 = *tris[tri][1]; const ClipV& P2 = *tris[tri][2];
                const float det = (P1.t - P0.t) * (P2.l - P0.l) - (P2.t - P0.t) * (P1.l - P0.l);
                if (std::fabs(det) < 1e-12f) continue;
                const uint32_t base = (uint32_t) mCarShadowPos.size();
                for (int c = 0; c < n; c++) {
                    const ClipV& v = poly[c];
                    const float w1 = ((v.t - P0.t) * (P2.l - P0.l) - (P2.t - P0.t) * (v.l - P0.l)) / det;
                    const float w2 = ((P1.t - P0.t) * (v.l - P0.l) - (v.t - P0.t) * (P1.l - P0.l)) / det;
                    const float w0 = 1.0f - w1 - w2;
                    mCarShadowPos.push_back(*wtri[tri][0] * w0 + *wtri[tri][1] * w1 + *wtri[tri][2] * w2);
                    const float4 lf = mix(lightA, lightB, v.t);
                    mCarShadowC0.push_back(math::half4{ lf.x, lf.y, lf.z, lf.w });
                }
                for (int c = 1; c + 1 < n; c++) {
                    mCarShadowIdx.push_back(base);
                    mCarShadowIdx.push_back(base + (uint32_t) c);
                    mCarShadowIdx.push_back(base + (uint32_t) c + 1);
                }
            }
        }
    }
    mCarShadowRange[slot] = { off, (uint32_t) mCarShadowIdx.size() - off };
    MaterialInstance* mi = mCarShadowMi[slot];
    mi->setParameter("origin", float4{ origin, 0.0f });
    mi->setParameter("fwd", float4{ fwd, 0.0f });
    mi->setParameter("right", float4{ right, 0.0f });
    if (mShadowSolid) {
        // TTP_DEBUG_SHADOW_SOLID: the fitted rect as an opaque black die-cut
        // at the ramp's half line, so placement, depth and seams can be
        // judged by eye on the TV with nothing soft to hide behind. The peak
        // doubled saturates the field at the half line; the band just under
        // 1 cuts there.
        mi->setParameter("extent", float4{ 1.0f / halfR, 1.0f / halfF, 2.0f, 1.0f });
        mi->setParameter("fill", float4{ 0.98f, 1.0f, 0.0f, 0.0f });
        mi->setParameter("ink", float4{ 0.0f, 0.0f, 0.0f, 0.0f });
    } else {
        mi->setParameter("extent", float4{ 1.0f / halfR, 1.0f / halfF, alpha, mShadowTune.cap });
        mi->setParameter("fill", float4{ mShadowTune.remapLo * mShadowTune.ao,
                mShadowTune.remapHi * mShadowTune.ao, 0.0f, 0.0f });
        mi->setParameter("ink", float4{ mShadowInkLinear, 0.0f });
    }
    // The model's stamp, rebound only when the slot's model changes.
    if (mCarShadowStampBound[slot] != key) {
        TextureSampler smp(TextureSampler::MinFilter::LINEAR_MIPMAP_LINEAR,
                TextureSampler::MagFilter::LINEAR);
        smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
        mi->setParameter("stamp", stamp->tex, smp);
        mCarShadowStampBound[slot] = key;
    }
}

// Upload this frame's strips (two events) and point each slot's primitive at
// its range; a slot nothing placed draws nothing.
void TtpRenderer::flushCarShadows() {
    if (!mCarShadowVb || !mCarShadowIb || mCarShadowEntity.isNull()) return;
    auto& rcm = mEngine->getRenderableManager();
    const auto ri = rcm.getInstance(mCarShadowEntity);
    if (!ri) return;
    if (!mCarShadowPos.empty()) {
        const size_t pb = mCarShadowPos.size() * sizeof(float3);
        void* pbuf = malloc(pb);
        std::memcpy(pbuf, mCarShadowPos.data(), pb);
        mCarShadowVb->setBufferAt(*mEngine, 0, VertexBuffer::BufferDescriptor(pbuf, pb,
                [](void* b, size_t, void*) { free(b); }));
        const size_t cb = mCarShadowC0.size() * sizeof(math::half4);
        void* cbuf = malloc(cb);
        std::memcpy(cbuf, mCarShadowC0.data(), cb);
        mCarShadowVb->setBufferAt(*mEngine, 1, VertexBuffer::BufferDescriptor(cbuf, cb,
                [](void* b, size_t, void*) { free(b); }));
        const size_t ib = mCarShadowIdx.size() * sizeof(uint32_t);
        void* ibuf = malloc(ib);
        std::memcpy(ibuf, mCarShadowIdx.data(), ib);
        mCarShadowIb->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(ibuf, ib,
                [](void* b, size_t, void*) { free(b); }));
    }
    for (size_t k = 0; k < mCarShadowRange.size() && k < kCarShadowDraws; k++) {
        rcm.setGeometryAt(ri, k, RenderableManager::PrimitiveType::TRIANGLES,
                mCarShadowVb, mCarShadowIb, mCarShadowRange[k].first, mCarShadowRange[k].second);
    }
}

// The stamp texture for one fit: RoundedRectEval's linear ramp field over the
// stamp's (u, v), the ramp the raster targeted (blur over the overscan box),
// 128 texels a side so the ramp is several texels wide, mip-mapped so a far
// stamp minifies without shimmer. The outermost texels are zero (the shape
// sits inside its overscan), so CLAMP samples outside the quad read nothing.
const TtpRenderer::CarShadowStamp* TtpRenderer::carShadowStamp(uint64_t key,
        const ttp::rt::RoundedFit& fit) {
    const auto it = mCarShadowStampTex.find(key);
    if (it != mCarShadowStampTex.end()) return &it->second;
    constexpr uint32_t N = 128;
    const float soft = std::max(1e-3f, mShadowTune.blur * 2.0f * mShadowTune.overscan);
    const ttp::rt::RoundedRectEval rr(mShadowTune.overscan,
            std::max(fit.corner, mShadowTune.cornerMin), soft,
            fit.fillXTail, fit.fillXNose, fit.fillZ);
    std::vector<float> f((size_t) N * N), g((size_t) N * N);
    for (uint32_t y = 0; y < N; y++) {
        for (uint32_t x = 0; x < N; x++) {
            const float u = ((float) x + 0.5f) / N, v = ((float) y + 0.5f) / N;
            f[(size_t) y * N + x] = rr.ramp(u, v);
        }
    }
    // A texel of blur (two 3x3 box passes, ~a gaussian of one texel): the
    // layer's read carried that much reconstruction, and it also smooths the
    // distance field's own creases along the corners' diagonals, which a
    // wide ramp printed as faint lines through the shadow.
    for (int pass = 0; pass < 2; pass++) {
        for (uint32_t y = 0; y < N; y++) {
            for (uint32_t x = 0; x < N; x++) {
                float acc = 0.0f;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        const int xx = std::min<int>(N - 1, std::max(0, (int) x + dx));
                        const int yy = std::min<int>(N - 1, std::max(0, (int) y + dy));
                        acc += f[(size_t) yy * N + xx];
                    }
                }
                g[(size_t) y * N + x] = acc / 9.0f;
            }
        }
        f.swap(g);
    }
    uint8_t* px = (uint8_t*) malloc((size_t) N * N);
    // The support: the texel box holding every non-zero texel, padded by one
    // so bilinear's reach at its edge still reads the ramp's foot.
    int x0 = (int) N, x1 = -1, y0 = (int) N, y1 = -1;
    for (uint32_t y = 0; y < N; y++) {
        for (uint32_t x = 0; x < N; x++) {
            // The outermost texels stay zero: CLAMP samples outside the quad read nothing.
            const float v = (x == 0 || y == 0 || x == N - 1 || y == N - 1) ? 0.0f : f[(size_t) y * N + x];
            const uint8_t b = (uint8_t) std::lround(std::min(1.0f, std::max(0.0f, v)) * 255.0f);
            px[(size_t) y * N + x] = b;
            if (b) {
                x0 = std::min(x0, (int) x); x1 = std::max(x1, (int) x);
                y0 = std::min(y0, (int) y); y1 = std::max(y1, (int) y);
            }
        }
    }
    float4 support{ 0.0f, 1.0f, 0.0f, 1.0f };
    if (x1 >= x0) {
        support = { (float) std::max(0, x0 - 1) / N, (float) std::min<int>(N, x1 + 2) / N,
                    (float) std::max(0, y0 - 1) / N, (float) std::min<int>(N, y1 + 2) / N };
    }
    Texture* tex = Texture::Builder()
            .width(N).height(N).levels(0xff)
            .format(Texture::InternalFormat::R8)
            .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE
                    | Texture::Usage::GEN_MIPMAPPABLE)
            .build(*mEngine);
    if (!tex) { free(px); return nullptr; }
    tex->setImage(*mEngine, 0, Texture::PixelBufferDescriptor(px, (size_t) N * N,
            Texture::Format::R, Texture::Type::UBYTE,
            [](void* b, size_t, void*) { free(b); }));
    tex->generateMipmaps(*mEngine);
    return &mCarShadowStampTex.emplace(key, CarShadowStamp{ tex, support }).first->second;
}

// Bound to every vroad instance, because a declared sampler must be bound even
// while no track gives it anything to hold. skidLatHalf 0 is what actually
// disables the tap.
void TtpRenderer::bindSkidLayer(MaterialInstance* mi) {
    if (!mSkidNullTex) {
        mSkidNullTex = Texture::Builder()
                .width(1).height(1).levels(1)
                .format(Texture::InternalFormat::R8)
                .build(*mEngine);
        if (mSkidNullTex) {
            auto* px = new uint8_t[1]{ 0 };
            mSkidNullTex->setImage(*mEngine, 0,
                    Texture::PixelBufferDescriptor(px, 1,
                            Texture::Format::R, Texture::Type::UBYTE,
                            [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                            nullptr));
        }
    }
    Texture* t = mSkidTex ? mSkidTex : mSkidNullTex;
    if (!t) return;
    // Trilinear + anisotropic: the deck ahead minifies this layer hard, and a
    // no-mip LINEAR tap made every mark scintillate in motion (deck-wide
    // temporal aliasing). Aniso keeps the marks readable at the road's grazing
    // angles instead of trilinear mush. There is no window on ungenerated
    // mips: the build-time wipe generates the chain off the cleared level 0
    // (the GL backend's own level-0 clamp covered this, Metal's does not
    // exist — see the wipe in TtpRendererTrack.cpp).
    TextureSampler smp(t == mSkidTex
                    ? TextureSampler::MinFilter::LINEAR_MIPMAP_LINEAR
                    : TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    // 4, the same as the ground textures. MEASURED (M1 Max, ANGLE-Metal,
    // EXT_disjoint_timer_query, countdown/skyline, 4 cells, 6400x3600 — 12x a
    // 1080p frame, interleaved 9 reps): the whole mip+trilinear+aniso change is
    // INSIDE the noise against the un-mipped LINEAR tap it replaced, at aniso 8
    // as well as 4. Fill is not what this frame is made of (it is submission
    // bound, with a large resolution-independent intercept), so there was no
    // per-fragment cost to trade away. 4 rather than 8 only because it is the
    // house value and leaves margin on weak GPUs, which this bench cannot speak
    // for. Do not "optimise" this tap without re-measuring — it does not show.
    smp.setAnisotropy(4);
    // REPEAT along s carries the lap wrap; CLAMP across lat parks the kerbs'
    // and underside's out-of-band v on an edge row the stamper never writes.
    smp.setWrapModeS(TextureSampler::WrapMode::REPEAT);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("skidLayer", t, smp);
    mi->setParameter("skidLatHalf", mSkidTex ? mSkidLatHalf : 0.0f);
    mi->setParameter("invSkidLatSpan",
            (mSkidTex && mSkidLatHalf > 0.0f) ? 0.5f / mSkidLatHalf : 0.0f);
    // rgb = the pool's SKID_COLOR, converted by the same srgbToLinear as
    // everything else; a = the cap on summed ink — two crossing trails darken
    // (1-(1-a)^2 composited to ~0.48 when they were meshes), a donut spot
    // saturates there instead of going black.
    mi->setParameter("skidColor",
            math::float4{ srgbToLinear(0x241f1c), 0.48f });
}

// The deck's own instance, created on first use so the road (built before the
// bake) can already reference it; bindRoadVisMap fills its map in afterwards.
MaterialInstance* TtpRenderer::roadInstance() {
    if (!mRoadMaterial) return nullptr;  // no vroad served: bare vertex colours
    if (!mRoadInst) {
        mRoadInst = sceneInstance(mRoadMaterial);
        mRoadInst->setParameter("profCount", 0);
        mRoadInst->setParameter("paintCount", 0);
        mRoadInst->setParameter("trackLength", 0.0f);
        mRoadInst->setParameter("invTrackLength", 0.0f);
        mRoadInst->setParameter("chunkMid", 0.0f);
        bindSkidLayer(mRoadInst);
    }
    return mRoadInst;
}

// ONE entry, laid out once. Both deck channels and every producer build the
// same aggregate — the shader reads rect/color/shape identically whichever
// array it came from — so the layout is written here and nowhere else.
TtpRenderer::DeckDecal TtpRenderer::makeStamp(float s, float lat,
        float halfS, float halfLat, const float3& col, float alpha,
        float inner, float knee, bool ellipse, int chevrons) {
    return {
            float4{ s, lat, std::max(halfS, 1e-4f), std::max(halfLat, 1e-4f) },
            float4{ col.x, col.y, col.z, alpha },
            float4{ inner, ellipse ? 1.0f : 0.0f, knee, (float) chevrons },
            /*car=*/0.0f };
}

void TtpRenderer::addDeckDecal(float s, float lat, float halfS, float halfLat,
        const float3& linCol, float alpha, float inner, float kneeAlpha, bool ellipse,
        std::vector<DeckDecal>* out) {
    std::vector<DeckDecal>& dst = out ? *out : mDeckDecals;
    if ((int) dst.size() >= kMaxDeckDecals) return;
    dst.push_back(makeStamp(s, lat, halfS, halfLat, linCol, alpha, inner, kneeAlpha,
            ellipse, /*chevrons=*/0));
}

// The deck's fixed furniture, as stamps: the item-box contact shadows and the
// oil slicks, both DISCS. These used to be separate meshes floating 0.004 to
// 0.014 above the road; shading them into it removes the lift and the meshes
// both. Each keeps the profile its mesh baked into vertex alpha, so nothing
// about the look is re-derived here.
void TtpRenderer::buildStaticDeckDecals(const TrackBin& tb) {
    mStaticDeckDecals.clear();
    const auto pushDisc = [&](float s, float lat, float r,
            const float3& col, float alpha, float inner, float knee) {
        if ((int) mStaticDeckDecals.size() >= kMaxStaticDeckDecals) return;
        mStaticDeckDecals.push_back(makeStamp(s, lat, r, r, col, alpha, inner, knee,
                /*ellipse=*/true, /*chevrons=*/0));
    };

    // Item-box contact shadows: 1 -> 0.82 at 0.55r. FIRST, one per box in box
    // order — the collect fade in render() rewrites entry i's alpha in place,
    // so box i must stay decal i.
    const float3 BOXSH = srgbToLinear(0x1c1a18);
    for (const TrackBin::Box& b : tb.boxes) {
        pushDisc(b.s, b.lat, 0.3f, BOXSH, kBlobShadowAlpha, 0.55f, 0.82f);
    }

    // The patches and the pads are deck PAINT now — see buildDeckPaint.

    // Oil slicks. A dark-blue water puddle on the beach (ONE flat disc — the
    // shallow-cyan fill and a banded mini-sea were both rejected), a pale
    // glacial sheet on snow, the dark film everywhere else. The rim ring the
    // mesh drew as a second annulus is folded into the profile — it was always
    // just a brighter edge.
    // The slick is FULLY OPAQUE: the tint is pre-blended against the asphalt
    // here at what used to be the stamp's alpha (the shader mixes in linear
    // too), so ice and asphalt keep their old on-screen shade — the beach
    // values are the newer dark-blue call, not a preserved shade — while
    // lines and wear no longer ghost through.
    const bool wet = tb.hasWater, ice = tb.hasIce;
    const float3 oilTint = wet ? srgbToLinear(tb.waterDeep) * 0.35f
            : srgbToLinear(ice ? tb.iceSheet : 0x161425);
    const float oilMix = wet ? 0.9f : ice ? 0.45f : 0.7f;
    const float3 OILC = mix(srgbToLinear(tb.pal[0]), oilTint, oilMix);
    for (const TrackBin::Oil& o : tb.oils) {
        pushDisc(o.s, o.lat, o.radius, OILC, 1.0f, 0.96f, 1.0f);
    }
}

// Which of `src` reaches the chunk centred on `mid`, folded into that chunk's
// own frame. ONE copy of the lap wrap for both deck channels: the arclength is
// PERIODIC, so an entry is in range if its footprint reaches this span measured
// the short way round, and folding x here is what lets the shader take the wrap
// out of its per-entry test (a subtract and a compare). Fills up to `cap` in
// list order and returns how many landed — an overflowing chunk keeps the HEAD
// of the list, which is why each caller orders its list by priority. A CAR
// entry (the contact shadow's readback row) is skipped: the carShadow layer
// draws it, and folded into the profile list it would draw a second time.
int TtpRenderer::foldToChunk(const std::vector<DeckDecal>& src, float mid,
        float halfSpan, float L, DeckDecal* out, int cap) {
    int n = 0;
    for (const DeckDecal& d : src) {
        if (n >= cap) break;
        if (d.car > 0.5f) continue;
        float ds = d.rect.x - mid;
        if (L > 0.0f) ds -= L * std::floor(ds / L + 0.5f);
        if (std::fabs(ds) > halfSpan + d.rect.z) continue;
        out[n] = d;
        out[n].rect.x = ds;
        n++;
    }
    return n;
}

// THE DECK'S OWN PAINT: the asphalt patches (ttp/wear.h) and the boost pads,
// onto the chunks that carry them.
//
// WHY THESE ARE NOT DECALS. The decal loop runs AFTER the rubber tap, which is
// right for everything laid ON the deck — a contact shadow, a boost aura or an
// oil film composites over laid rubber the way it would over asphalt. A repair
// and a painted pad ARE the deck, so rubber has to run across them: as opaque
// decals they blanked the ink under their own footprint and left clean holes
// punched in the racing line wherever the track had been repaired or marked.
// The deck's lane dashes already behaved correctly for free, being vertex
// colour on the road mesh — this channel is what puts pads and repairs on that
// same side of the ink.
//
// The entry layout is EXACTLY the decal layout (rect, colour, shape), which is
// what lets vroad paint both channels through one shared function: a pad must
// not look different for having changed sides.
//
// Written STRAIGHT TO THE CHUNK INSTANCES rather than into a list: none of this
// moves, and each chunk keeps only its own, so it is off every per-frame path
// (uploadDeckDecals re-packs its list every frame).
void TtpRenderer::buildDeckPaint(const TrackBin& tb, const ttp::rt::WearPlan& wear) {
    // A patch is the deck's own asphalt shifted a shade. The shade scales in
    // sRGB space, not linear, on purpose: the authored 0.86/1.10 are PERCEPTUAL
    // steps (a linear scale of the same factor darkens visibly harder), and the
    // patch look was approved with exactly these values.
    const auto shadeHex = [](uint32_t hex, float k) -> uint32_t {
        const auto m = [&](uint32_t c) {
            return (uint32_t) std::min(255.0f, std::round((float) c * k));
        };
        return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
    };

    // The track-wide list. PADS FIRST, repairs after — order here is SELECTION
    // PRIORITY, because a chunk that overflows kMaxChunkPaint keeps the head of
    // the list: decoration falls off the end, never a boost pad, which is a
    // marker the player drives at. Compositing order does not compete for the
    // slot, because the two can never overlap in the first place — the planner
    // keeps a patch 4u of ARCLENGTH clear of a pad (wear.cc, asserted by
    // wear_check), which is wider than their half-lengths put together, since a
    // repair under a pad reads as a broken pad.
    std::vector<DeckDecal> paint;
    const auto add = [&](float s, float lat, float halfS, float halfLat,
            const float3& col, float inner, bool ellipse, int chevrons) {
        paint.push_back(makeStamp(s, lat, halfS, halfLat, col, /*alpha=*/1.0f,
                inner, /*knee=*/1.0f, ellipse, chevrons));
    };
    // Boost pads. The disc's flat fill and hard edge are its profile; the cream
    // chevrons ride the shader's segment distance instead of the stroked
    // geometry they used to be.
    const ttp::rt::BoostShades boost = ttp::rt::boost_shades(tb.boostCol);
    for (const TrackBin::Pad& pad : tb.pads) {
        if (pad.kind == 1) {
            // 5 across x 2 along, not one chevron stretched over the full lane.
            // Three columns over a five-metre lane made each mark two and a half
            // times wider than it was deep, so the pair read as two flat waves
            // rather than as chevron paint; five brings it to 1.4.
            add(pad.s, pad.lat, pad.p0, pad.p1, srgbToLinear(boost.strip),
                    0.99f, /*ellipse=*/false, /*chevrons=*/52);
        } else {
            // FLAT PAINT, NOT A GLOW. The mesh drew a radial gradient (light core,
            // base at 0.7, dark rim) and reproducing that as a soft profile came
            // out as an emissive saucer — which is the exact read this tree
            // already rejected once: a marker on the road grounds itself with a
            // flat fill and a hard edge, not a gradient. So the disc is solid to
            // 0.9 and then falls off over a tenth of its radius, which is an
            // antialiased edge rather than a feather.
            add(pad.s, pad.lat, pad.p0, pad.p0, srgbToLinear(boost.base),
                    0.97f, /*ellipse=*/true, /*chevrons=*/13);
        }
    }
    // The repairs (ttp/wear.h): the deck's own asphalt shifted a shade.
    for (const ttp::rt::WearMark& w : wear.marks) {
        add(w.s, w.lat, w.halfS, w.halfLat, srgbToLinear(shadeHex(tb.pal[0], w.shade)),
                0.96f, /*ellipse=*/false, /*chevrons=*/0);
    }

    // tb, not mTrack: buildStatic only adopts the bin at the very end, so
    // during the build mTrack is still the track this one replaces.
    const float L = tb.length;
    // The BOX in front of the loop is the union of the per-entry reject
    // windows (uploadDeckDecals builds the profile list's the same way): a
    // fragment outside it would have rejected every entry, so the box is exact.
    const auto writeTo = [&](MaterialInstance* mi, float mid, float halfSpan) {
        DeckDecal sel[kMaxChunkPaint];
        const int n = foldToChunk(paint, mid, halfSpan, L, sel, kMaxChunkPaint);
        float4 box{ 1e9f, -1e9f, 1e9f, -1e9f };
        if (n > 0) {
            float4 rect[kMaxChunkPaint], col[kMaxChunkPaint], shape[kMaxChunkPaint];
            for (int i = 0; i < n; i++) {
                rect[i] = sel[i].rect; col[i] = sel[i].color; shape[i] = sel[i].shape;
                const float4& r = sel[i].rect;
                box.x = std::min(box.x, r.x - r.z);
                box.y = std::max(box.y, r.x + r.z);
                box.z = std::min(box.z, r.y - r.w);
                box.w = std::max(box.w, r.y + r.w);
            }
            mi->setParameter("paintRect", rect, (size_t) n);
            mi->setParameter("paintColor", col, (size_t) n);
            mi->setParameter("paintShape", shape, (size_t) n);
        }
        mi->setParameter("paintBounds", box);
        mi->setParameter("paintCount", n);
        return n;
    };
    for (RoadChunk& ch : mRoadChunks) {
        ch.paintN = writeTo(ch.mi, (ch.sMin + ch.sMax) * 0.5f, (ch.sMax - ch.sMin) * 0.5f);
    }
    // The whole-lap fallback instance, when the chunk pass produced nothing.
    if (mRoadChunks.empty() && mRoadInst) {
        mRoadInstPaintN = writeTo(mRoadInst, 0.0f, L > 0.0f ? L : 1.0e9f);
    }
}

void TtpRenderer::uploadDeckDecals() {
    // Statics FIRST: the array is composited in order, so an aura or a prop's
    // blob lands over the box shadow or slick it is crossing, which is the
    // order the separate meshes used to get from their render priorities. The
    // car shadows are not in this array: vroad taps their layer before the
    // whole list, so they sit under the statics too.
    if (!mStaticDeckDecals.empty() && !(mDecalDebug & kDebugNoDecalStatics)) {
        mDeckDecals.insert(mDeckDecals.begin(),
                mStaticDeckDecals.begin(), mStaticDeckDecals.end());
    }
    // The composited list moves into mDeckDecalsLast (debugDeckDecals' view of
    // this frame) by swap, and the emptied buffer becomes next frame's scratch —
    // the old deep copy existed only to feed that debug accessor.
    mDeckDecalsLast.swap(mDeckDecals);
    mDeckDecals.clear();
    const float L = mTrack ? mTrack->length : 0.0f;

    // PER CHUNK, not per road. A fragment only ever needs the decals near its own
    // arclength, and the road is already split into ~35u chunks for culling, so
    // handing each chunk its own short list is what keeps the loop off the 99% of
    // the deck that has nothing on it. The statics never move, and the dynamics
    // (auras, item blobs) cross 1–2 chunks — so each chunk's folded list is
    // compared to what it was last handed, and an unchanged chunk (which in a
    // steady frame is every chunk) writes no uniforms at all.
    //
    // The BOX in front of the loop is the union of the reject windows the loop
    // actually tests — r.zw per stamp — so a fragment it rejects had nothing
    // to draw. Build it from anything the fold DROPPED and it clips a stamp
    // that is not there; build it from the wrong bound and it clips one that
    // is.
    const auto uploadTo = [&](MaterialInstance* mi, float mid, float halfSpan,
            std::vector<DeckDecal>& lastProf) {
        DeckDecal prof[kMaxProfileDeckDecals];
        const int profCap = (mDecalDebug & kDebugDecalCapsHalf)
                ? kMaxProfileDeckDecals / 2 : kMaxProfileDeckDecals;
        const int np = foldToChunk(mDeckDecalsLast, mid, halfSpan, L, prof, profCap);
        const bool profSame = (size_t) np == lastProf.size()
                && (np == 0 || std::memcmp(prof, lastProf.data(),
                        np * sizeof(DeckDecal)) == 0);
        if (profSame) return;
        lastProf.assign(prof, prof + np);

        float4 pBounds{ 1e9f, -1e9f, 1e9f, -1e9f };
        if (np > 0) {
            float4 rect[kMaxProfileDeckDecals], col[kMaxProfileDeckDecals],
                    shape[kMaxProfileDeckDecals];
            for (int i = 0; i < np; i++) {
                rect[i] = prof[i].rect; col[i] = prof[i].color; shape[i] = prof[i].shape;
                const float4& r = prof[i].rect;
                pBounds.x = std::min(pBounds.x, r.x - r.z);
                pBounds.y = std::max(pBounds.y, r.x + r.z);
                pBounds.z = std::min(pBounds.z, r.y - r.w);
                pBounds.w = std::max(pBounds.w, r.y + r.w);
            }
            mi->setParameter("profRect", rect, (size_t) np);
            mi->setParameter("profColor", col, (size_t) np);
            mi->setParameter("profShape", shape, (size_t) np);
            mi->setParameter("profBounds", pBounds);
        }
        mi->setParameter("profCount", np);
    };
    if (!mRoadChunks.empty()) {
        for (RoadChunk& ch : mRoadChunks) {
            uploadTo(ch.mi, (ch.sMin + ch.sMax) * 0.5f, (ch.sMax - ch.sMin) * 0.5f,
                    ch.lastProf);
        }
    } else if (mRoadInst) {
        // Degenerate: the deck material exists but the chunk pass produced
        // nothing. One "chunk" spanning the whole lap keeps the decals drawing
        // (its wrap constants are set at build, like the chunks').
        uploadTo(mRoadInst, 0.0f, L > 0.0f ? L : 1.0e9f, mRoadInstLastProf);
    }
    applyRoadDebug();   // no-op unless a caller asked for an ablation
}

// The structures' and berms' instance of the static-receiver material: their
// colour is the vertex's, so the albedo is white (their uvs are zero). Made on
// first ask because the structures are built before the ground; the bake binds
// its visibility map afterwards.
MaterialInstance* TtpRenderer::staticInstance() {
    if (!mStaticInst && mGroundMaterial) {
        Texture* w = whiteTexture();
        if (!w) return nullptr;
        mStaticInst = sceneInstance(mGroundMaterial);
        mStaticInst->setParameter("albedo", w, TextureSampler(
                TextureSampler::MinFilter::NEAREST, TextureSampler::MagFilter::NEAREST));
        bindVisMap(mStaticInst, nullptr);
    }
    return mStaticInst;
}

// The bake passes' five shadow parameters (ttp_sunvis.inc), by name.
void TtpRenderer::bindShadowMap(MaterialInstance* mi, const SunEsm& esm) {
    TextureSampler smp(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("shadowMap", esm.map, smp);
    mi->setParameter("shadowFromWorld", mShadowFromWorld);
    // Sampling step for the slope-scaled bias (three refits the same guard to
    // its texel size).
    mi->setParameter("shadowTexel", esm.texel);
    mi->setParameter("shadowK", kShadowEsmK);
    mi->setParameter("shadowDepthScale", esm.depthScale);
}

// The DECK's baked sun-visibility map (vroadvis.mat), in TRACK space. White
// with a 0 lat span = fully lit, for a track that baked no map.
//
// The sampler is CLAMP on BOTH axes, and clamping v is what carries the kerbs:
// an off-deck fragment's OFF_DECK_LAT lands on the outermost deck column and
// inherits its shadow. u clamps rather than repeats because the map covers the
// lap exactly once and a wrap would fold the finish line's shadow onto the
// start line's.
void TtpRenderer::bindRoadVisMap(MaterialInstance* mi) {
    if (!mi) return;
    Texture* tex = mRoadVisMap ? mRoadVisMap : whiteTexture();
    if (!tex) return;
    // Level 0 only, on purpose: a mip chain on this 4k-wide map, sampled
    // trilinear, measured a null on the Android box (2026-10-14, 4P 720
    // pretzel, three interleaved pairs) and softens the far shadow.
    TextureSampler smp(TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("sunVis", tex, smp);
    mi->setParameter("invSunVisLatSpan", roadVisLatSpan());
}

// A static receiver's baked sun-visibility map (vvis.mat) — its uv is
// shadowFromWorld's own output, so the matrix rides along with the texture.
// Null binds white = fully lit: a track that baked no map, or the ablation arm.
void TtpRenderer::bindVisMap(MaterialInstance* mi, Texture* map) {
    if (!mi) return;
    Texture* tex = map ? map : whiteTexture();
    if (!tex) return;
    TextureSampler smp(TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("visMap", tex, smp);
    mi->setParameter("shadowFromWorld", mShadowFromWorld);
}

// Oil slicks + warning cones. The slick is TrackProps' dark translucent disc
// (0x161425 @ 0.7); the cones ring it exactly like _buildHazards (n on
// radius×1.05, half-step offset, clamped inside the kerb). (Authored poles are
// concrete posts — see buildStructures.)
//
// The slick itself is a road-shader stamp (buildStaticDeckDecals); this builds
// its 3D markers only.
void TtpRenderer::buildOils(const TrackBin& tb) {
    if (tb.oils.empty()) return;
    // Cones: hazard rings, one instanced pool.
    struct ConeSpot { float s, lat; };
    std::vector<ConeSpot> spots;
    const float coneEdge = tb.roadWidth / 2 - 0.35f;
    for (const TrackBin::Oil& o : tb.oils) {
        const uint32_t n = o.cones ? o.cones : 4;
        const float ring = o.radius * 1.05f;
        for (uint32_t i = 0; i < n; i++) {
            const float a = (i + 0.5f) * (2.0f * (float) M_PI / n);
            const float lat = o.lat + std::sin(a) * ring;
            spots.push_back({ o.s + std::cos(a) * ring,
                    std::max(-coneEdge, std::min(coneEdge, lat)) });
        }
    }
    if (!spots.empty() && tb.hasWater) {
        // Beach: the slick's markers are folding "wet floor" signs, not cones —
        // two safety-yellow panels hinged at a ridge and splayed at the base,
        // and on each outward face the "slippery road" pictogram every driver
        // already knows (MUTCD W8-5): a car head-on over two snaking skid
        // tracks, in black on the safety yellow.
        constexpr float WETSIGN_H = 0.46f;
        constexpr float RIDGE = 1.0f, SPLAY = 0.30f;      // proto: ridge y, foot half-splay
        const float S = WETSIGN_H / RIDGE;                 // scaled to the marker height
        const float L = std::sqrt(RIDGE * RIDGE + SPLAY * SPLAY);
        const float Wp = L * 0.66f, topHW = Wp * 0.33f, botHW = Wp * 0.50f;
        constexpr float TD = 0.05f;
        constexpr float TAU = 2.0f * (float) M_PI;
        // ---- the shell ------------------------------------------------------
        // A MOULDED panel, not a cut card: rounded corners, and a shallow
        // chamfer running the whole way round the face. The chamfer is what
        // sells it — the face is flat, so under a single key light it can only
        // ever be one shade; a band angled out of that plane is the only thing
        // on the panel that catches the light differently.
        constexpr float R_TOP = 0.10f, R_BOT = 0.06f;   // corner radii, in panel units
        constexpr float BEV = 0.024f, BEVD = 0.012f;    // chamfer: wide and shallow
        constexpr int ARC = 4, NPT = 4 * (ARC + 1);     // outline: 4 rounded corners
        constexpr float FACE_W = TD / 2, LIP_W = FACE_W - BEVD, BACK_W = -TD / 2;
        // Hinge barrel over the ridge, wide enough to swallow both panel tops —
        // the detail that reads "one folding sign" rather than "two boards".
        constexpr float HINGE_R = 0.042f, HINGE_HW = 0.150f;
        constexpr int HINGE_SEG = 8;
        constexpr uint32_t PANEL_FACE = 0xf6c400, PANEL_BEV = 0xefb70e,
                           PANEL_WALL = 0xd9a300;
        struct Pt { float u, v; };
        // ---- the pictogram --------------------------------------------------
        // In panel units (u across, v up the panel, origin at its centre), laid
        // on planes a hair proud of the face: ink first, then the cut-outs a
        // hair proud of THAT, so the depth test alone stacks them. The cut-outs
        // are painted in PANEL_FACE — being the face's own yellow is the whole
        // trick, so they must never drift apart.
        constexpr uint32_t INK = 0x141414;
        constexpr float Z = FACE_W + 0.004f, ZCUT = FACE_W + 0.007f;
        // The car, head-on, sized off the PANEL WIDTH — all the room there is.
        // Wide and low (~6:5 including tyres); a squarer silhouette reads as a
        // tower. What makes it a CAR at size is the two cut-outs, the
        // windscreen and the headlamps: without them it is a black blob
        // whatever the outline does. The whole symbol sits a touch low so its
        // top and bottom margins LOOK equal — the panel leans away at the top,
        // where an equal margin subtends less.
        constexpr float CAR_Y = 0.135f;                     // car centre up the panel
        constexpr float TYRE_V = -0.18f, SILL = -0.105f, SHOULDER = 0.04f, ROOF = 0.18f;
        constexpr float ROOF_HW = 0.122f, SHLD_HW = 0.215f; // cabin, flaring down to the body
        constexpr float BODY_LO = 0.205f;                   // body tucks in a touch at the bumper
        constexpr float TYRE_LO = 0.100f, TYRE_HI = 0.185f; // wheel tabs, yellow showing between
        constexpr float SCR_HI = 0.152f, SCR_LO = 0.058f;   // windscreen, inset in the cabin
        constexpr float SCR_HW_HI = 0.108f, SCR_HW_LO = 0.168f;
        constexpr float LAMP_U = 0.140f, LAMP_V = -0.036f, LAMP_R = 0.042f;
        // The tracks: no longer than the car is tall — this is a car with skid
        // marks, not skid marks with a car on top. Only the SPLAY is mirrored;
        // the wobble is common to both, because these are one car's two tyres
        // and they swing left and right together. Mirroring the wobble too made
        // the pair pinch and splay like a bowtie, which no skid does.
        constexpr float TRACK_V0 = -0.01f, TRACK_V1 = -0.35f;
        constexpr float TRACK_U0 = 0.085f, TRACK_U1 = 0.185f;
        constexpr float SPLAY_EXP = 1.25f;                  // fans late: close under the car
        constexpr float WOB = 0.058f, WAVES = 1.45f;
        constexpr float WOB_FADE = 0.72f;                   // straight run-out at the tail
        // One width end to end. A taper into a flared foot was tried and read
        // as a paint drip rather than a tyre print — and it is the stroke that
        // caps the wobble, since the ribbon folds on the inside of its own
        // bends once the turn radius (~1/(WOB·WAVES²)) drops under the
        // half-stroke. Even and thin buys the wobble its room.
        constexpr float STROKE = 0.020f;
        mSignMeshes.resize(spots.size());
        mConeStates.resize(spots.size());
        auto& tcm = mEngine->getTransformManager();
        for (size_t i = 0; i < spots.size(); i++) {
            Mesh& m = mSignMeshes[i];
            const auto panel = [&](int sd) {
                // Panel frame: foot → ridge is "up", the sign's width is x.
                const float3 up = normalize(float3{ 0, RIDGE, -(float) sd * SPLAY });
                const float3 wide{ (float) sd, 0, 0 };
                const float3 nrm = normalize(cross(wide, up));
                const float3 org{ 0, RIDGE / 2 * S, (float) sd * SPLAY / 2 * S };
                const auto vert = [&](float u, float v, float w) {
                    const float3 p = org + wide * (u * S) + up * (v * S) + nrm * (w * S);
                    return p;
                };
                const float hl = L / 2;
                const auto face = [&](const float3& a, const float3& b, const float3& c,
                        const float3& d, uint32_t hex) {
                    const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { a, b, c, d }) m.verts.push_back({ p.x, p.y, p.z, col });
                    m.idx.insert(m.idx.end(), { base, base + 2, base + 1,
                                                base + 1, base + 2, base + 3 });
                };
                const auto tri3 = [&](const float3& a, const float3& b, const float3& c,
                        uint32_t hex) {
                    const uint32_t col = packLinear(srgbToLinear(hex), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { a, b, c }) m.verts.push_back({ p.x, p.y, p.z, col });
                    m.idx.insert(m.idx.end(), { base, base + 1, base + 2 });
                };
                // Rounded-trapezoid outline, CCW in (u, v) seen from the face.
                const auto rounded = [](float tw, float bw, float h, float rT, float rB, Pt* out) {
                    const Pt cor[4] = { { -tw, h }, { -bw, -h }, { bw, -h }, { tw, h } };
                    const float rad[4] = { rT, rB, rB, rT };
                    int n = 0;
                    for (int c = 0; c < 4; c++) {
                        const Pt prev = cor[(c + 3) & 3], at = cor[c], next = cor[(c + 1) & 3];
                        float au = prev.u - at.u, av = prev.v - at.v;
                        float bu = next.u - at.u, bv = next.v - at.v;
                        const float la = std::sqrt(au * au + av * av);
                        const float lb = std::sqrt(bu * bu + bv * bv);
                        au /= la; av /= la; bu /= lb; bv /= lb;
                        const float dotv = std::max(-1.0f, std::min(1.0f, au * bu + av * bv));
                        const float half = std::acos(dotv) / 2;         // half the interior angle
                        const float r = rad[c];
                        const float back = r / std::tan(half);          // tangent point set-back
                        float xu = au + bu, xv = av + bv;               // inward bisector
                        const float lx = std::sqrt(xu * xu + xv * xv);
                        xu /= lx; xv /= lx;
                        const float hub = r / std::sin(half);           // corner → arc centre
                        const float cu = at.u + xu * hub, cv = at.v + xv * hub;
                        const float a0 = std::atan2(at.v + av * back - cv, at.u + au * back - cu);
                        float a1 = std::atan2(at.v + bv * back - cv, at.u + bu * back - cu);
                        while (a1 - a0 > (float) M_PI) a1 -= TAU;   // sweep the short way
                        while (a1 - a0 < -(float) M_PI) a1 += TAU;
                        for (int k = 0; k <= ARC; k++) {
                            const float a = a0 + (a1 - a0) * k / ARC;
                            out[n++] = { cu + std::cos(a) * r, cv + std::sin(a) * r };
                        }
                    }
                };
                // The face outline is the shell's, inset by the chamfer width.
                // Offsetting the SLANTED sides needs the true perpendicular
                // step, not a plain shave off the half-width.
                const float slope = (botHW - topHW) / (-2 * hl);
                const float perp = BEV * std::sqrt(1 + slope * slope);
                Pt shell[NPT], flat[NPT];
                rounded(topHW, botHW, hl, R_TOP, R_BOT, shell);
                rounded(topHW - slope * BEV - perp, botHW + slope * BEV - perp, hl - BEV,
                        R_TOP - BEV, R_BOT - BEV, flat);
                // Ring between two loops; the first must be the nearer one, which
                // is what puts the winding the right way out.
                const auto ring = [&](const Pt* A, float za, const Pt* B, float zb, uint32_t hex) {
                    for (int k = 0; k < NPT; k++) {
                        const int k2 = (k + 1) % NPT;
                        face(vert(A[k].u, A[k].v, za), vert(A[k2].u, A[k2].v, za),
                             vert(B[k].u, B[k].v, zb), vert(B[k2].u, B[k2].v, zb), hex);
                    }
                };
                const auto fanFill = [&](const Pt* P, float z, uint32_t hex, bool outward) {
                    for (int k = 1; k + 1 < NPT; k++) {
                        const float3 a = vert(P[0].u, P[0].v, z);
                        const float3 b = vert(P[k].u, P[k].v, z);
                        const float3 c = vert(P[k + 1].u, P[k + 1].v, z);
                        if (outward) tri3(a, b, c, hex); else tri3(a, c, b, hex);
                    }
                };
                fanFill(flat, FACE_W, PANEL_FACE, true);        // the printed face
                ring(flat, FACE_W, shell, LIP_W, PANEL_BEV);    // chamfer
                ring(shell, LIP_W, shell, BACK_W, PANEL_WALL);  // side wall
                fanFill(shell, BACK_W, PANEL_WALL, false);      // inside of the A
                const auto band = [&](float vT, float hwT, float vB, float hwB,
                        float z, uint32_t hex) {
                    face(vert(-hwT, CAR_Y + vT, z), vert(hwT, CAR_Y + vT, z),
                         vert(-hwB, CAR_Y + vB, z), vert(hwB, CAR_Y + vB, z), hex);
                };
                band(ROOF, ROOF_HW, SHOULDER, SHLD_HW, Z, INK);  // cabin, flaring outward
                band(SHOULDER, SHLD_HW, SILL, BODY_LO, Z, INK);  // body + grille
                for (const float sd2 : { -1.0f, 1.0f }) {        // wheel tabs under the sill
                    const float a = sd2 < 0 ? -TYRE_HI : TYRE_LO;
                    const float b = sd2 < 0 ? -TYRE_LO : TYRE_HI;
                    face(vert(a, CAR_Y + SILL, Z), vert(b, CAR_Y + SILL, Z),
                         vert(a, CAR_Y + TYRE_V, Z), vert(b, CAR_Y + TYRE_V, Z), INK);
                }
                band(SCR_HI, SCR_HW_HI, SCR_LO, SCR_HW_LO, ZCUT, PANEL_FACE); // windscreen
                const auto lamp = [&](float cu) {
                    constexpr int SEG = 12;
                    const uint32_t col = packLinear(srgbToLinear(PANEL_FACE), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    const float3 c0 = vert(cu, CAR_Y + LAMP_V, ZCUT);
                    m.verts.push_back({ c0.x, c0.y, c0.z, col });
                    for (int j = 0; j <= SEG; j++) {
                        const float a = (float) j / SEG * TAU;
                        const float3 p = vert(cu + std::cos(a) * LAMP_R,
                                CAR_Y + LAMP_V + std::sin(a) * LAMP_R, ZCUT);
                        m.verts.push_back({ p.x, p.y, p.z, col });
                    }
                    for (uint32_t j = 0; j < SEG; j++) {
                        m.idx.insert(m.idx.end(), { base, base + 1 + j, base + 2 + j });
                    }
                };
                lamp(-LAMP_U);
                lamp(LAMP_U);
                // Each track is swept PERPENDICULAR to its own path, so the
                // stroke keeps its weight through the curves instead of
                // squashing wherever the path runs diagonally.
                const auto skid = [&](float sd2) {
                    constexpr int SEG = 26;
                    constexpr float DV = TRACK_V1 - TRACK_V0;   // v is linear in t
                    constexpr float TAIL = 1.0f - WOB_FADE;
                    float pu = 0, pv = 0, pnu = 0, pnv = 0;
                    for (int j = 0; j <= SEG; j++) {
                        const float t = (float) j / SEG;
                        const float ph = t * WAVES * TAU;
                        const float fan = std::pow(t, SPLAY_EXP);
                        const float ease = t < WOB_FADE ? 1.0f : (1.0f - t) / TAIL;
                        const float dease = t < WOB_FADE ? 0.0f : -1.0f / TAIL;
                        const float wob = WOB * ease * std::sin(ph);
                        const float u = sd2 * (TRACK_U0 + (TRACK_U1 - TRACK_U0) * fan) + wob;
                        const float v = TRACK_V0 + DV * t;
                        const float dfan = t > 0 ? SPLAY_EXP * std::pow(t, SPLAY_EXP - 1) : 0.0f;
                        const float du = sd2 * (TRACK_U1 - TRACK_U0) * dfan
                                + WOB * (dease * std::sin(ph)
                                        + ease * WAVES * TAU * std::cos(ph));
                        const float inv = STROKE / std::sqrt(du * du + DV * DV);
                        const float nu = DV * inv, nv = -du * inv; // |n| = half-stroke, to the left
                        if (j) {
                            face(vert(pu + pnu, pv + pnv, Z), vert(pu - pnu, pv - pnv, Z),
                                 vert(u + nu, v + nv, Z), vert(u - nu, v - nv, Z), INK);
                        }
                        pu = u; pv = v; pnu = nu; pnv = nv;
                    }
                };
                skid(-1.0f);
                skid(1.0f);
            };
            panel(1);
            panel(-1);
            // The hinge, in the SIGN's own frame (x across, y up off the road,
            // z fore-aft) rather than either panel's: it belongs to both. Both
            // panel tops land exactly on (0, RIDGE, 0), so a barrel there
            // swallows the seam.
            {
                const auto barrel = [&](float x, float a) {
                    return float3{ x * S, (RIDGE + std::sin(a) * HINGE_R) * S,
                                   std::cos(a) * HINGE_R * S };
                };
                for (int k = 0; k < HINGE_SEG; k++) {
                    const float a0 = (float) k / HINGE_SEG * TAU;
                    const float a1 = (float) (k + 1) / HINGE_SEG * TAU;
                    const float3 A = barrel(-HINGE_HW, a0), B = barrel(HINGE_HW, a0);
                    const float3 C = barrel(-HINGE_HW, a1), D = barrel(HINGE_HW, a1);
                    const uint32_t col = packLinear(srgbToLinear(PANEL_WALL), 1.0f);
                    const uint32_t base = (uint32_t) m.verts.size();
                    for (const float3& p : { A, B, C, D }) {
                        m.verts.push_back({ p.x, p.y, p.z, col });
                    }
                    m.idx.insert(m.idx.end(), { base, base + 1, base + 2,
                                                base + 1, base + 3, base + 2 });
                    // Knuckle ends, so the barrel is a closed solid.
                    for (const float end : { -HINGE_HW, HINGE_HW }) {
                        const float3 hub{ end * S, RIDGE * S, 0 };
                        const float3 p0 = barrel(end, a0), p1 = barrel(end, a1);
                        const uint32_t cb = (uint32_t) m.verts.size();
                        for (const float3& p : { hub, p0, p1 }) {
                            m.verts.push_back({ p.x, p.y, p.z, col });
                        }
                        if (end < 0) m.idx.insert(m.idx.end(), { cb, cb + 1, cb + 2 });
                        else         m.idx.insert(m.idx.end(), { cb, cb + 2, cb + 1 });
                    }
                }
            }
            accumulateNormals(m);
            buildMesh(m);
            const TrackBin::Sample f = tb.frameAt(spots[i].s);
            // Cones are radial, but the A-frame has a front and a back: stand it
            // on the road normal with its faces along the track.
            const mat4f home = f.basis(spots[i].lat);
            mConeStates[i].home = home;
            mConeStates[i].quat = mat3f(home.upperLeft()).toQuaternion();
            mConeStates[i].pos = home[3].xyz;
            mConeStates[i].homeS = spots[i].s;
            mConeStates[i].radius = botHW * S;
            mConeStates[i].loY = 0;
            mConeStates[i].hiY = (RIDGE + HINGE_R) * S; // the barrel is the high point now
            tcm.setTransform(tcm.getInstance(m.entity), home);
        }
    } else if (!spots.empty()) {
        mConeAsset = loadInstancedProp("item-cone.glb", spots.size(), mConeInstances);
        if (mConeAsset) {
            auto& tcm = mEngine->getTransformManager();
            mConeStates.resize(spots.size());
            // Silhouette proxy for the ground clamp: a cone's lowest point under
            // any rotation is on its base rim or at the apex, so those points
            // alone reproduce the JS's sampled-vertex _groundOffset exactly.
            float coneR = 0.1f, coneLo = 0.0f, coneHi = 0.3f;
            {
                const filament::Aabb bb = mConeAsset->getBoundingBox();
                if (bb.max.y > bb.min.y) {
                    coneLo = bb.min.y;
                    coneHi = bb.max.y;
                    coneR = std::max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5f;
                }
            }
            for (size_t i = 0; i < spots.size(); i++) {
                const TrackBin::Sample f = tb.frameAt(spots[i].s);
                const mat4f home = f.basis(spots[i].lat);
                mConeStates[i].home = home;
                mConeStates[i].quat = mat3f(home.upperLeft()).toQuaternion();
                mConeStates[i].pos = home[3].xyz;
                mConeStates[i].homeS = spots[i].s;
                mConeStates[i].radius = coneR;
                mConeStates[i].loY = coneLo;
                mConeStates[i].hiY = coneHi;
                tcm.setTransform(tcm.getInstance(mConeInstances[i]->getRoot()), home);
            }
        }
    }
}
