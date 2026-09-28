// The road-shader channels — skid and carShadow rasters, deck decals and
// paint — plus their 3D markers. TtpRendererImpl.h carries what the topic
// files share.
#include "TtpRendererImpl.h"

#include <utils/Log.h>

#include <algorithm>


// The silhouette store for the road-shader shadow decals: one array layer per
// car MODEL (claimMaskLayer keys them by the GLB's bytes, so the eight-car
// grid's four models cost four layers), one for the monster, one generic.
// Engine-lifetime (layers are rebaked per scene — mMaskLayerBakedBits says
// which hold the current scene's bake); created on first use and bound to
// every vroad instance, because a declared sampler must be bound even while no
// masked decal references it.
Texture* TtpRenderer::ensureDecalMaskArray() {
    if (mDecalMaskArray || !mEngine) return mDecalMaskArray;
    mDecalMaskArray = Texture::Builder()
            .width(kMaskCellW).height(kMaskCellH).depth(kMaskLayers).levels(1)
            // RGBA8, deliberately NOT R8: the R8 version (a quarter of the
            // tap bytes) was tried and the TRANSLUCENT silhouette bake into
            // an R8 array layer renders ZERO coverage on the PowerVR driver
            // — bake logs success, sample reads nothing, and the generic
            // UPLOADED layer keeps working, so every car shadow silently
            // became the fallback oval. vvis's R8 is not a counter-example:
            // that bake is an OPAQUE view. Coverage rides ALPHA.
            .format(Texture::InternalFormat::RGBA8)
            .sampler(Texture::Sampler::SAMPLER_2D_ARRAY)
            // UPLOADABLE for the generic layer's setImage, COLOR_ATTACHMENT for
            // the bakes that render into the car layers.
            .usage(Texture::Usage::COLOR_ATTACHMENT | Texture::Usage::SAMPLEABLE
                    | Texture::Usage::UPLOADABLE)
            .build(*mEngine);
    if (!mDecalMaskArray) return nullptr;
    // The generic layer, at the cell's own resolution. The other layers stay
    // unwritten until a bake lands; nothing samples a layer whose baked bit
    // is clear.
    const std::vector<float> a = superellipseMaskPixels(kMaskCellW, kMaskCellH);
    auto* px = new std::vector<uint8_t>((size_t) kMaskCellW * kMaskCellH * 4, 255);
    for (size_t i = 0; i < a.size(); i++) {
        (*px)[i * 4 + 3] = (uint8_t) std::lround(
                std::min(1.0f, std::max(0.0f, a[i])) * 255.0f);
    }
    mDecalMaskArray->setImage(*mEngine, 0, 0, 0, (uint32_t) kMaskLayerGeneric,
            kMaskCellW, kMaskCellH, 1,
            Texture::PixelBufferDescriptor(px->data(), px->size(),
                    Texture::Format::RGBA, Texture::Type::UBYTE,
                    [](void*, size_t, void* user) { delete (std::vector<uint8_t>*) user; },
                    px));
    mMaskLayerBakedBits |= (uint16_t) (1u << kMaskLayerGeneric);
    return mDecalMaskArray;
}

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
    for (int y = y0; y <= y1; y++) {
        uint8_t* row = mSkidPix.data() + (size_t) y * W;
        const float py = (float) y + 0.5f;
        for (int x = x0; x <= x1; x++) {
            const float px = (float) x + 0.5f;
            const float eAB = edge(a, b, px, py);
            const float eBC = edge(b, c, px, py);
            const float eCA = edge(c, a, px, py);
            if ((eAB > 0 || (eAB == 0 && tlAB))
                    && (eBC > 0 || (eBC == 0 && tlBC))
                    && (eCA > 0 || (eCA == 0 && tlCA))) {
                // Barycentric ink: eBC weighs vertex a, eCA weighs b, eAB c.
                const float w = (ink[0] * eBC + ib * eCA + ic * eAB) * inv;
                const int wx = ((x % W) + W) % W;
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
// test — two rects need not touch to share a copy, unlike the eight-texel
// neighbourhood the shadow layer used to require — because bytes were free
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
                for (int x = d.x0; x < d.x1; x++) {
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

// Which vroad arrived? Two INDEPENDENT capability probes: the current blob
// carries BOTH — the hybrid shadow LOD's masked arrays (near cars) and the
// carShadow tap (everyone else) — and each path keys on its own probe, so a
// blob with only one half still draws that half. hasParameter is a name
// lookup — called at build, at debug switches, and once per uploadDeckDecals,
// so it is not worth a cached bool that could go stale across provideAsset.
bool TtpRenderer::roadHasMaskLoop() const {
    return mRoadMaterial && mRoadMaterial->hasParameter("maskRect");
}
bool TtpRenderer::roadHasCarShadow() const {
    return mRoadMaterial && mRoadMaterial->hasParameter("carShadow");
}

// The carShadow sampler must be bound on every vroad instance from creation
// (Filament draws with every sampler resolved); the 1x1 zero the skid layer
// keeps is the right null here too. maskInk.w = 0 is what actually disables
// the tap.
void TtpRenderer::bindCarShadow(MaterialInstance* mi, Texture* t) {
    if (!mi) return;
    if (!t) t = mSkidNullTex;   // bindSkidLayer has made it by the time any
    if (!t) return;             // road instance exists (see roadInstance)
    // LINEAR both ways, single level — the masked loop's silhouette was a
    // no-mip LOD-0 sample too, so minification behaves exactly as it did.
    TextureSampler smp(TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    // REPEAT along s carries the lap wrap; CLAMP across lat parks the kerbs'
    // and underside's out-of-band v on edge rows the raster never writes —
    // the rubber layer's exact contract, on the rubber layer's exact span.
    smp.setWrapModeS(TextureSampler::WrapMode::REPEAT);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("carShadow", t, smp);
}

// ── The blob's SHAPE, per car model ─────────────────────────────────────────
//
// The spec the current tuning asks for. One place, so a bake and a re-bake
// cannot disagree about the frame they drew in.
static ttp::rt::FootprintSpec footprintSpecOf(const CarShadowTuning& t, int W, int H) {
    ttp::rt::FootprintSpec spec;
    spec.w = W;
    spec.h = H;
    spec.overscan = t.overscan;
    spec.grow = t.grow;
    spec.blur = t.blur;
    return spec;
}

// Rasterize a captured outline at the current tuning. Pure: geometry in, mask
// out, no asset and no scene — which is what lets a tuning drag re-derive every
// model's shape without going near a car that has since driven off.
bool TtpRenderer::rasterCarOutline(uint64_t key) {
    const auto it = mCarOutlines.find(key);
    if (it == mCarOutlines.end()) return false;
    const CarOutline& o = it->second;
    std::vector<float> mask = ttp::rt::car_footprint_mask(o.xz.data(), o.xz.size() / 2,
            o.idx.data(), o.idx.size(), o.halfX, o.halfZ,
            footprintSpecOf(mShadowTune, kCarShadowMaskW, kCarShadowMaskH));
    // An outline that came out blank is a FAILED bake, not a car with no
    // shadow. Leave the model absent from the store and it falls back to the
    // superellipse — the same discipline bakeSilhouette's coverage probe
    // enforces on the GPU side, and for the same reason: a blank mask draws as
    // nothing at all and no screenshot gate separates the two.
    if (mask.empty()) {
        utils::slog.w << "carFootprint: empty outline for model "
                << (unsigned long long) key << " — the superellipse stands in"
                << utils::io::endl;
        mCarShadowMasks.erase(key);
        return false;
    }
    // FIT THE CHEAP SHAPES TO THE SAME CAPTURE, so the analytic paths are
    // per-car too. One pass each, here, and nothing at all in the raster —
    // which is the whole reason both are parameterised. The polygon fits the
    // raw projected vertices rather than the mask: the hull wants the
    // geometry, not pixels of it.
    //
    // THE FIT MEASURES A SHARP RASTER, never the blurred display mask: blur
    // is the LOOK, and at the shipped width it closes the very gap the fit
    // exists to see — an open-wheeler's detached rear wheels bridged above
    // the 0.5 threshold, and Rumble's tail read full-width.
    ttp::rt::FootprintSpec fitSpec =
            footprintSpecOf(mShadowTune, kCarShadowMaskW, kCarShadowMaskH);
    fitSpec.blur = 0.0f;
    const std::vector<float> fitMask = ttp::rt::car_footprint_mask(
            o.xz.data(), o.xz.size() / 2, o.idx.data(), o.idx.size(),
            o.halfX, o.halfZ, fitSpec);
    it->second.fit = ttp::rt::fit_rounded_rect(
            fitMask.empty() ? mask : fitMask, fitSpec);
    it->second.poly = ttp::rt::fit_convex_poly_lobes(o.xz.data(), o.xz.size() / 2,
            o.idx.data(), o.idx.size(),
            o.halfX, o.halfZ, mShadowTune.polyEdges, mask,
            footprintSpecOf(mShadowTune, kCarShadowMaskW, kCarShadowMaskH));
    mCarShadowMasks[key] = std::move(mask);
    return true;
}

// One model's outline, CAPTURED and then rasterized.
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
// — every car simply falls back to the superellipse — which is why the outline
// is captured once, here, and re-rasterized from the copy for ever after.
bool TtpRenderer::bakeCarFootprint(uint64_t key, const std::vector<uint8_t>& glb,
        gltfio::FilamentAsset* asset, const float3& bbMin, const float3& bbMax) {
    if (!key || !asset || !mEngine) return false;
    const std::vector<ttp::rt::GlbMeshNode>* nodes = glbMeshes(key, glb);
    if (!nodes || nodes->empty()) return false;
    CarOutline o;
    o.halfX = (bbMax.x - bbMin.x) * 0.5f;
    o.halfZ = (bbMax.z - bbMin.z) * 0.5f;
    if (!(o.halfX > 0.0f) || !(o.halfZ > 0.0f)) return false;

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
            const uint32_t base = (uint32_t) (o.xz.size() / 2);
            const size_t verts = p.pos.size() / 3;
            for (size_t v = 0; v < verts; v++) {
                const float3 wp = (wm * float4{ p.pos[v * 3], p.pos[v * 3 + 1],
                        p.pos[v * 3 + 2], 1.0f }).xyz;
                o.xz.push_back(wp.x);
                o.xz.push_back(wp.z);
            }
            for (const uint32_t i : p.idx) o.idx.push_back(base + i);
        }
    }
    // A CAPTURE OFF A POSED ASSET IS THE ONE MISTAKE THIS CANNOT SURVIVE, and
    // it is invisible downstream, so it is refused here instead: every roster
    // model is origin-centred at rest, so an outline whose extent does not
    // straddle the origin was measured somewhere out on the track.
    float lo = 1e30f, hi = -1e30f;
    for (size_t v = 0; v + 1 < o.xz.size(); v += 2) {
        lo = std::min(lo, o.xz[v]);
        hi = std::max(hi, o.xz[v]);
    }
    if (o.xz.empty() || lo > o.halfX || hi < -o.halfX) {
        utils::slog.w << "bakeCarFootprint: model " << (unsigned long long) key
                << " was not at its rest pose — outline refused" << utils::io::endl;
        return false;
    }
    mCarOutlines[key] = std::move(o);
    return rasterCarOutline(key);
}

// Which outline slot `i` stamps: this slot's model, or the shared superellipse
// whenever the tuning asks for it or the bake did not land. A car wearing the
// MONSTER keeps its own shape — the stamp just scales (kMonsterShadowScale).
TtpRenderer::StampShape TtpRenderer::carShadowShapeFor(size_t slot) const {
    StampShape out;
    const uint64_t key =
            mCarShadowMaskOfSlot.size() > slot ? mCarShadowMaskOfSlot[slot] : 0;
    const auto outline = key ? mCarOutlines.find(key) : mCarOutlines.end();
    // THE ANALYTIC SHAPE reads no mask; what it needs is this model's FIT, and
    // the generic default when the model has none — the fallback is a shape,
    // not a blank. `corner` scales the fitted radius (1 = as fitted), so the
    // slider always does something AND the cars stay different from each other.
    if (mShadowTune.shape == kShadowShapeRounded
            || mShadowTune.shape == kShadowShapePoly) {
        if (outline != mCarOutlines.end()) out.fit = outline->second.fit;
        out.fit.corner = std::min(1.0f, out.fit.corner * mShadowTune.corner);
        // The polygon when it is asked for AND this model has one; a failed
        // fit leaves the fitted rect standing in — a shape, never a blank.
        if (mShadowTune.shape == kShadowShapePoly
                && outline != mCarOutlines.end()
                && outline->second.poly[0].count >= 3) {
            out.poly = &outline->second.poly[0];
            if (outline->second.poly[1].count >= 3) {
                out.poly2 = &outline->second.poly[1];
            }
        }
        return out;
    }
    if (mShadowTune.shape == kShadowShapeCar && key) {
        const auto it = mCarShadowMasks.find(key);
        if (it != mCarShadowMasks.end() && !it->second.empty()) {
            out.mask = &it->second;
            return out;
        }
    }
    out.mask = &mCarShadowMask;
    return out;
}

// Re-derive every mask at the current tuning, FROM THE CAPTURED OUTLINES and
// never from the assets — the cars have long since driven away from the pose an
// outline has to be measured in (mCarOutlines says what that costs). Only the
// tuning ABI calls it: four models at 256x512 supersampled is a few
// milliseconds, nothing against a scene build and unthinkable inside a frame.
void TtpRenderer::rebakeCarShadowMasks() {
    mCarShadowMask = superellipseMaskPixels(kCarShadowMaskW, kCarShadowMaskH);
    mCarShadowMasks.clear();
    for (const auto& [key, outline] : mCarOutlines) {
        (void) outline;
        rasterCarOutline(key);
    }
}

TtpRenderer::ShadowLayerInfo TtpRenderer::shadowLayerInfo() const {
    ShadowLayerInfo o;
    o.w = (int) mCarShadowW;
    o.h = (int) mCarShadowH;
    if (mTrack && mTrack->length > 0.0f) o.texelsPerU = mCarShadowW / mTrack->length;
    if (mSkidLatHalf > 0.0f) o.texelsPerLat = mCarShadowH / (2.0f * mSkidLatHalf);
    // A car's stamp, in texels — its footprint times the overscan the quad
    // carries. Off the FIRST slot that has a measured footprint, because the
    // roster's models are within a few percent of each other and this is a
    // readout, not a per-car fact.
    for (const CarWheels& w : mCarWheels) {
        if (!(w.footW > 0.0f) || !(w.footL > 0.0f)) continue;
        o.stampTexelsS = w.footL * mShadowTune.overscan * o.texelsPerU;
        o.stampTexelsLat = w.footW * mShadowTune.overscan * o.texelsPerLat;
        break;
    }
    return o;
}

bool TtpRenderer::shadowLayerWindow(int x, int y, int w, int h,
        std::vector<uint8_t>& out) const {
    const int LW = (int) mCarShadowW, LH = (int) mCarShadowH;
    if (LW <= 0 || LH <= 0 || mCarShadowPix.empty()) return false;
    if (w <= 0 || h <= 0) return false;
    out.assign((size_t) w * h, 0);
    for (int j = 0; j < h; j++) {
        const int sy = y + j;
        if (sy < 0 || sy >= LH) continue;
        const uint8_t* src = mCarShadowPix.data() + (size_t) sy * LW;
        uint8_t* dst = out.data() + (size_t) j * w;
        for (int i = 0; i < w; i++) {
            // x wraps: the layer is periodic along the lap, and a stamp near
            // the seam is exactly the case worth being able to look at.
            dst[i] = src[(((x + i) % LW) + LW) % LW];
        }
    }
    return true;
}

TtpRenderer::ShadowMaskView TtpRenderer::shadowMaskView(size_t slot) {
    ShadowMaskView v;
    v.w = kCarShadowMaskW;
    v.h = kCarShadowMaskH;
    const uint64_t key = mCarShadowMaskOfSlot.size() > slot
            ? mCarShadowMaskOfSlot[slot] : 0;
    // THE ANALYTIC SHAPE HAS NO MASK, so one is drawn here for the readback
    // alone. Without it the tuning page would show an oval while the deck drew
    // a rounded rect, which is exactly the kind of quiet lie this readback
    // exists to prevent. Never on a frame path — the ABI is once per drag.
    if (mShadowTune.shape == kShadowShapeRounded
            || mShadowTune.shape == kShadowShapePoly) {
        // THROUGH THE SAME SELECTOR AND EVALUATOR THE RASTER USES, or the page
        // would show one shape for every car while the deck drew a different
        // one per model — which is the exact class of quiet lie this readback
        // exists to catch, and it did catch it once.
        const StampShape sh = carShadowShapeFor(slot);
        mAnalyticPreview.resize((size_t) kCarShadowMaskW * kCarShadowMaskH);
        for (int y = 0; y < kCarShadowMaskH; y++) {
            for (int x = 0; x < kCarShadowMaskW; x++) {
                mAnalyticPreview[(size_t) y * kCarShadowMaskW + x] =
                        analyticCoverage(sh,
                                (x + 0.5f) / kCarShadowMaskW,
                                (y + 0.5f) / kCarShadowMaskH, 0.02f);
            }
        }
        v.px = mAnalyticPreview.data();
        v.model = key;
        v.generic = false;
        return v;
    }
    if (mShadowTune.shape == kShadowShapeCar && key) {
        const auto it = mCarShadowMasks.find(key);
        if (it != mCarShadowMasks.end() && !it->second.empty()) {
            v.px = it->second.data();
            v.model = key;
            v.generic = false;
            return v;
        }
    }
    // The slot's model is still reported when the superellipse stands in, so a
    // reader can tell "no such slot" from "this model's outline did not bake".
    v.model = key;
    if (!mCarShadowMask.empty()) v.px = mCarShadowMask.data();
    return v;
}

// Apply a tuning. The masks re-bake whenever their SHAPE inputs moved, and the
// layer pair re-allocates whenever its DENSITY did; everything else is read
// fresh by the next frame and costs nothing to change.
void TtpRenderer::setShadowTuning(const CarShadowTuning& t) {
    const bool reshape = t.overscan != mShadowTune.overscan
            || t.grow != mShadowTune.grow
            || t.blur != mShadowTune.blur
            || t.polyEdges != mShadowTune.polyEdges;
    const bool resize = t.texelsPerU != mShadowTune.texelsPerU
            || t.rows != mShadowTune.rows;
    mShadowTune = t;
    if (reshape || mCarShadowMask.empty()) rebakeCarShadowMasks();
    if (resize && mTrack) buildCarShadowLayer(mTrack->length);
    // AND PUSH THE UNIFORMS, or the ink, the cap and the tail cut are read off
    // whatever the last LAYER BUILD left on the material. Without this every
    // one of those four knobs was silently inert unless a density knob happened
    // to move with it — which cost a measurement: an arm that changed the tail
    // cut alone measured byte-identical to the arm before it, and the arm that
    // moved the cut into the raster was left double-cutting.
    applyShadowInk();
}


// The CAR-SHADOW layer — the texture path that replaced vroad's masked uniform
// loop, only when the served blob carries the tap. It rides the rubber layer's
// lat span (mSkidLatHalf) so the shader's one uv serves both taps, which is why
// the track build calls this from inside the rubber layer's own guard.
//
// A PAIR, both zeroed now (a fresh texture holds garbage — the lobby-speckle
// lesson): the per-frame upload alternates between them so it never lands on
// the texture the driver is reading (uploadCarShadow has the whole argument).
//
// W targets `texelsPerU` texels/u of arclength — coarse against the rubber's 80
// on purpose, because the stamp is a pre-blurred blob and the WHOLE level
// re-uploads every frame, so W bounds that event's size (512 KB at the 4096
// cap). Raising either density is therefore a per-frame upload cost and not
// only a memory one, which is why both are knobs a person has to drag on the
// tuning page rather than constants somebody picked.
//
// Re-entrant: the tuning ABI calls it again when a density moves, so it drops
// whatever pair it already had first.
void TtpRenderer::buildCarShadowLayer(float trackLength) {
    if (!mEngine || !roadHasCarShadow()) return;
    for (auto*& t : mCarShadowTex) {
        if (t) { mEngine->destroy(t); t = nullptr; }
    }
    mCarShadowW = mCarShadowH = 0;
    if (!(trackLength > 1.0f)) return;
    // THE DENSITY IS THE FLICKER, so the ceiling is the driver's and not a
    // number picked here. At the shipped 8 texels/u a car's whole stamp is
    // about 7 by 10 texels, the raster re-lands it at a new sub-texel offset
    // every frame, and the edge boils — measured as 3.5x the temporal energy
    // the masked silhouette put in the same band. The lat rows and the width
    // both buy that back; what they cost is the whole-level upload, which is
    // why both are knobs on /shadow-lab.html rather than a constant.
    mCarShadowH = (uint32_t) std::max(16, std::min(1024, mShadowTune.rows));
    mCarShadowW = (uint32_t) std::min((float) mMaxTextureDim, std::max(1024.0f,
            std::round(trackLength * std::max(1.0f, mShadowTune.texelsPerU))));
    if (mCarShadowMask.empty()) rebakeCarShadowMasks();
    bool ok = true;
    for (int t = 0; t < 2 && ok; t++) {
        mCarShadowTex[t] = Texture::Builder()
                .width(mCarShadowW).height(mCarShadowH).levels(1)
                .format(Texture::InternalFormat::R8)
                // UPLOAD-ONLY, like the rubber: no COLOR_ATTACHMENT, ever
                // (the A10X RT law — see mSkidPix).
                .usage(Texture::Usage::SAMPLEABLE | Texture::Usage::UPLOADABLE)
                .build(*mEngine);
        if (!mCarShadowTex[t]) { ok = false; break; }
        const size_t bytes = (size_t) mCarShadowW * mCarShadowH;
        auto* zeros = new uint8_t[bytes]();
        mCarShadowTex[t]->setImage(*mEngine, 0,
                Texture::PixelBufferDescriptor(zeros, bytes,
                        Texture::Format::R, Texture::Type::UBYTE,
                        [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                        nullptr));
    }
    if (ok) {
        mCarShadowPix.assign((size_t) mCarShadowW * mCarShadowH, 0);
        mCarShadowDirty.clear();
        // Both textures and the CPU buffer are zero here, so the pair starts
        // agreed and the dirty-rect upload has nothing to catch up on. The
        // history MUST go with them: a rect measured against the old layer's
        // width would upload the wrong strip of the new one.
        for (auto& l : mCarShadowWas) l.clear();
        mCarShadowWasAt = 0;
        // 1, not 0: the instances below bind tex[0], so the FIRST upload must
        // land on tex[1] — starting at 0 respecified the very texture the
        // driver was reading, once per scene, which is the exact in-flight
        // conflict the pair exists to avoid.
        mCarShadowPing = 1;
        mCarShadowUpload = false;
        applyShadowInk();
        if (mRoadInst) bindCarShadow(mRoadInst, mCarShadowTex[0]);
        for (RoadChunk& rc : mRoadChunks) {
            if (rc.mi) bindCarShadow(rc.mi, mCarShadowTex[0]);
        }
    } else {
        // No layer, no tap: maskInk.w stays 0, so the deck simply draws no car
        // shadows — the same benign state a shell with no vroad at all is in.
        for (auto*& t : mCarShadowTex) {
            if (t) { mEngine->destroy(t); t = nullptr; }
        }
        mCarShadowW = mCarShadowH = 0;
        applyShadowInk();
    }
}

// The shadow's colour, its coverage cap and the shader's tail-cut remap, onto
// every live road instance. One funnel, because these are three parameters on
// two materials that must never be set from different places with different
// ideas of the current tuning.
void TtpRenderer::applyShadowInk() {
    mShadowInkLinear = srgbToLinear(mShadowTune.ink);
    if (!roadHasCarShadow()) return;
    const math::float4 v = shadowInkParam(mCarShadowTex[0] != nullptr);
    const math::float4 remap = shadowRemapParam();
    const auto set = [&](MaterialInstance* mi) {
        if (!mi) return;
        mi->setParameter("maskInk", v);
        if (mi->getMaterial()->hasParameter("carShadowRemap")) {
            mi->setParameter("carShadowRemap", remap);
        }
    };
    set(mRoadInst);
    for (RoadChunk& rc : mRoadChunks) set(rc.mi);
}


// Zero the rects the last raster touched. The layer is TRANSIENT — the cars
// re-stamp every frame — so this runs at the top of renderCars whether or not
// any car will stamp again (a car that vanished must leave nothing behind).
// x is unwrapped (a stamp near the seam runs past W); the memset wraps.
void TtpRenderer::eraseCarShadow() {
    if (mCarShadowPix.empty()) { mCarShadowDirty.clear(); return; }
    const int W = (int) mCarShadowW, H = (int) mCarShadowH;
    for (const SkidRect& r : mCarShadowDirty) {
        const int y0 = std::max(0, r.y0), y1 = std::min(H, r.y1);
        const int span = std::min(W, r.x1 - r.x0);
        if (y0 >= y1 || span <= 0) continue;
        const int wx0 = ((r.x0 % W) + W) % W;
        const int first = std::min(span, W - wx0);
        for (int y = y0; y < y1; y++) {
            uint8_t* row = mCarShadowPix.data() + (size_t) y * W;
            std::memset(row + wx0, 0, (size_t) first);
            if (first < span) std::memset(row, 0, (size_t) (span - first));
        }
        mCarShadowUpload = true;
    }
    // Hand this list to the upload's history before dropping it: what the erase
    // just zeroed is a region that changed, and the ping-pong's other texture
    // has not seen it yet (mCarShadowWas).
    mCarShadowWas[mCarShadowWasAt & 1] = std::move(mCarShadowDirty);
    mCarShadowWasAt++;
    mCarShadowDirty.clear();
}

// One triangle of a car-shadow stamp: texel space, the same top-left rule and
// per-row x wrap as rasterSkidTri, but instead of a flat interpolated ink it
// carries the silhouette's (u, v) per vertex — linear per triangle, exactly
// what the GPU would interpolate — and samples the CPU superellipse bilinearly
// at each covered texel. Saturating ADD like the rubber; the cap on the summed
// result is the shader's (CarShadowTuning::cap via maskInk.w), not the raster's.
// y clamps to [1, H-2]: the outer rows are the CLAMP rows the shader's
// out-of-band v relies on staying empty.
// The one analytic evaluator — the raster and the readback preview both come
// here, so the tuning page can never show a shape the deck is not drawing.
float TtpRenderer::analyticCoverage(const StampShape& s, float u, float v,
        float soft) const {
    if (s.poly) {
        const float r = kPolyCornerBase * mShadowTune.corner;
        float cov = ttp::rt::convex_poly_coverage(u, v, mShadowTune.overscan,
                *s.poly, r, soft);
        // The waist's second lobe: the UNION is what puts the pinch back.
        if (s.poly2) {
            cov = std::max(cov, ttp::rt::convex_poly_coverage(u, v,
                    mShadowTune.overscan, *s.poly2, r, soft));
        }
        return cov;
    }
    return ttp::rt::rounded_rect_coverage(u, v, mShadowTune.overscan,
            s.fit.corner, soft, s.fit.fillXTail, s.fit.fillXNose, s.fit.fillZ);
}

void TtpRenderer::rasterCarShadowTri(const float2* p, const float2* uv, float alpha,
        const StampShape& shape) {
    if (mStampW <= 0 || mStampH <= 0) return;
    if (!shape.mask && mShadowTune.shape != kShadowShapeRounded
            && mShadowTune.shape != kShadowShapePoly) return;
    if (shape.mask && shape.mask->empty()) return;
    const float area = (p[1].x - p[0].x) * (p[2].y - p[0].y)
                     - (p[2].x - p[0].x) * (p[1].y - p[0].y);
    if (area == 0.0f) return;
    const float2 a = p[0];
    const float2 b = area > 0 ? p[1] : p[2];
    const float2 c = area > 0 ? p[2] : p[1];
    const float2 ua = uv[0];
    const float2 ub = area > 0 ? uv[1] : uv[2];
    const float2 uc = area > 0 ? uv[2] : uv[1];
    const float inv = 1.0f / std::fabs(area);
    // Clipped to the SCRATCH; the layer's own row clamp and the x wrap are the
    // composite's job now (rasterCarShadowStamp).
    const int y0 = std::max(mStampY0, (int) std::ceil(
            std::min(a.y, std::min(b.y, c.y)) - 0.5f));
    const int y1 = std::min(mStampY0 + mStampH - 1, (int) std::floor(
            std::max(a.y, std::max(b.y, c.y)) - 0.5f + 1.0f));
    const int x0 = std::max(mStampX0, (int) std::ceil(
            std::min(a.x, std::min(b.x, c.x)) - 0.5f));
    const int x1 = std::min(mStampX0 + mStampW - 1, (int) std::floor(
            std::max(a.x, std::max(b.x, c.x)) - 0.5f + 1.0f));
    const auto edge = [](const float2& e0, const float2& e1, float px, float py) {
        return (e1.x - e0.x) * (py - e0.y) - (e1.y - e0.y) * (px - e0.x);
    };
    const auto topLeft = [](const float2& e0, const float2& e1) {
        return (e0.y == e1.y && e1.x < e0.x) || e1.y > e0.y;
    };
    // Clamped bilinear over the CPU silhouette — the sampler's CLAMP_TO_EDGE,
    // in floats (the mask's own border is already ~0 from the bake blur).
    const auto mask = [&](float u, float v) {
        const float fx = u * (float) kCarShadowMaskW - 0.5f;
        const float fy = v * (float) kCarShadowMaskH - 0.5f;
        const int mx0 = (int) std::floor(fx), my0 = (int) std::floor(fy);
        const float tx = fx - (float) mx0, ty = fy - (float) my0;
        const auto at = [&](int x, int y) {
            x = std::min(kCarShadowMaskW - 1, std::max(0, x));
            y = std::min(kCarShadowMaskH - 1, std::max(0, y));
            return (*shape.mask)[(size_t) y * kCarShadowMaskW + x];
        };
        const float t0 = at(mx0, my0) + (at(mx0 + 1, my0) - at(mx0, my0)) * tx;
        const float t1 = at(mx0, my0 + 1) + (at(mx0 + 1, my0 + 1) - at(mx0, my0 + 1)) * tx;
        return t0 + (t1 - t0) * ty;
    };
    const bool tlAB = topLeft(a, b), tlBC = topLeft(b, c), tlCA = topLeft(c, a);
    // The mask's uv GRADIENT per layer texel, constant over the triangle — a
    // 2x2 box filter's step. One point sample per texel under per-frame
    // sub-texel slide is what breathes at a hard edge; four samples half a
    // texel apart are the filter the minification never had.
    const float ex1 = b.x - a.x, ey1 = b.y - a.y;
    const float ex2 = c.x - a.x, ey2 = c.y - a.y;
    const float du1 = ub.x - ua.x, dv1 = ub.y - ua.y;
    const float du2 = uc.x - ua.x, dv2 = uc.y - ua.y;
    const float det = ex1 * ey2 - ex2 * ey1;
    const float id = det != 0.0f ? 1.0f / det : 0.0f;
    const float dudx = (du1 * ey2 - du2 * ey1) * id, dvdx = (dv1 * ey2 - dv2 * ey1) * id;
    const float dudy = (du2 * ex1 - du1 * ex2) * id, dvdy = (dv2 * ex1 - dv1 * ex2) * id;
    // THE ANALYTIC SHAPE NEEDS NO FILTER, which is most of why it is cheaper:
    // the edge ramp is sized from the texel footprint the gradients above
    // already give, so ONE evaluation is already antialiased where a mask needs
    // four taps to be. Half a texel of ramp, in the stamp's own units.
    // THE STORED RAMP WANTS TO BE WIDE, not tight to the texel. The shader
    // takes the tail cut on the INTERPOLATED value, so a smooth field gives a
    // sub-texel edge position that slides continuously (the signed-distance
    // trick); a ramp sized to half a texel quantises the edge to the grid
    // instead and measured 30% MORE flicker than the masks. So the floor is the
    // texel footprint — below it the raster would alias — and the target is the
    // same softness `blur` gives a mask, converted into the footprint's own
    // units (the mask is `w` wide and its footprint 1/overscan of that).
    const bool analytic = shape.mask == nullptr;
    const float texelRamp = 0.5f * mShadowTune.overscan
            * (std::fabs(dudx) + std::fabs(dudy)
             + std::fabs(dvdx) + std::fabs(dvdy));
    const float soft = analytic
            ? std::max(1e-3f, std::max(texelRamp,
                    mShadowTune.blur * 2.0f * mShadowTune.overscan))
            : 0.0f;
    for (int y = y0; y <= y1; y++) {
        float* row = mStampCov.data() + (size_t) (y - mStampY0) * mStampW;
        const float py = (float) y + 0.5f;
        for (int x = x0; x <= x1; x++) {
            const float px = (float) x + 0.5f;
            const float eAB = edge(a, b, px, py);
            const float eBC = edge(b, c, px, py);
            const float eCA = edge(c, a, px, py);
            if ((eAB > 0 || (eAB == 0 && tlAB))
                    && (eBC > 0 || (eBC == 0 && tlBC))
                    && (eCA > 0 || (eCA == 0 && tlCA))) {
                // Barycentric uv: eBC weighs vertex a, eCA weighs b, eAB c.
                const float w0 = eBC * inv, w1 = eCA * inv, w2 = eAB * inv;
                const float mu = ua.x * w0 + ub.x * w1 + uc.x * w2;
                const float mv = ua.y * w0 + ub.y * w1 + uc.y * w2;
                const float cov = analytic
                        ? analyticCoverage(shape, mu, mv, soft)
                        : 0.25f
                            * (mask(mu - 0.25f * (dudx + dudy), mv - 0.25f * (dvdx + dvdy))
                             + mask(mu + 0.25f * (dudx - dudy), mv + 0.25f * (dvdx - dvdy))
                             + mask(mu - 0.25f * (dudx - dudy), mv - 0.25f * (dvdx - dvdy))
                             + mask(mu + 0.25f * (dudx + dudy), mv + 0.25f * (dvdx + dvdy)));
                // MAX, never add: two triangles of one stamp may both claim a
                // texel on their shared edge (mStampCov says why), and adding
                // there is the diagonal banding.
                float& dst = row[x - mStampX0];
                dst = std::max(dst, std::max(0.0f, cov * alpha));
            }
        }
    }
}

// One car's stamp into the layer. `sl` is the SIX deckFoot-projected points
// the cull-window measurement in renderCars already computes — the four
// corners plus the two long-edge midpoints — as (s, lat), s ABSOLUTE (the
// fold to unwrapped texel x happens here, against carS). Rasterized as TWO
// warped quads (four triangles): the deck's bending of track space then
// lives INSIDE each half-stamp, where it is second-order — the worst
// catalogue corner bows a straight car edge by ~L²/8R ≈ 0.13 u over the full
// stamp, and slicing once halves the sag to well under a texel. The
// per-triangle diagonal is the same linearization the GPU applies to uv0
// itself, so there is no finer truth to chase.
void TtpRenderer::rasterCarShadowStamp(const float2* sl, float carS, float alpha,
        const StampShape& shape) {
    if (!mTrack || mCarShadowPix.empty() || mSkidLatHalf <= 0.0f) return;
    if (!shape.mask && mShadowTune.shape != kShadowShapeRounded
            && mShadowTune.shape != kShadowShapePoly) return;
    const float L = mTrack->length;
    if (L <= 0.0f) return;
    const float texW = (float) mCarShadowW, texH = (float) mCarShadowH;
    const float u0 = (carS - L * std::floor(carS / L)) / L;
    float2 tp[6], tuv[6];
    for (int k = 0; k < 6; k++) {
        float ds = sl[k].x - carS;
        ds -= L * std::round(ds / L);           // the short way round the lap
        tp[k] = { (u0 + ds / L) * texW,
                  (sl[k].y / mSkidLatHalf * 0.5f + 0.5f) * texH };
        // The silhouette source frame: u across the car (left edge k<3, right
        // k>=3), v along it (fk -1, 0, +1 → 0, 0.5, 1), so v = 1 is the NOSE.
        // The superellipse is symmetric in both axes and could not be mirrored
        // by a handedness mistake; a per-car FOOTPRINT can, and getting v
        // backwards is the one sign that shows on a symmetric car — which is
        // why car_footprint.h states the convention and a ctest pins it.
        tuv[k] = { k < 3 ? 0.0f : 1.0f, (float) (k % 3) * 0.5f };
    }
    // The stamp's rect, one texel padded — next frame's erase, this frame's
    // upload flag, and the scratch's own extent. Computed BEFORE rasterizing
    // now, because the triangles resolve into that scratch.
    float xmin = tp[0].x, xmax = tp[0].x, ymin = tp[0].y, ymax = tp[0].y;
    for (int k = 1; k < 6; k++) {
        xmin = std::min(xmin, tp[k].x); xmax = std::max(xmax, tp[k].x);
        ymin = std::min(ymin, tp[k].y); ymax = std::max(ymax, tp[k].y);
    }
    SkidRect r{ (int) std::floor(xmin) - 1, (int) std::floor(ymin) - 1,
                (int) std::ceil(xmax) + 1, (int) std::ceil(ymax) + 1 };

    // ONE STAMP, RESOLVED BY MAX, THEN ADDED ONCE. mStampCov carries the whole
    // argument; the short version is that four triangles sharing three edges
    // cannot be allowed to accumulate into each other.
    const int H = (int) mCarShadowH;
    mStampX0 = r.x0;
    mStampY0 = r.y0;
    mStampW = r.x1 - r.x0;
    mStampH = r.y1 - r.y0;
    if (mStampW <= 0 || mStampH <= 0) return;
    mStampCov.assign((size_t) mStampW * mStampH, 0.0f);
    static const int quads[2][4] = { { 0, 1, 4, 3 }, { 1, 2, 5, 4 } };
    for (const auto& q : quads) {
        const float2 t1[3] = { tp[q[0]], tp[q[1]], tp[q[2]] };
        const float2 u1[3] = { tuv[q[0]], tuv[q[1]], tuv[q[2]] };
        rasterCarShadowTri(t1, u1, alpha, shape);
        const float2 t2[3] = { tp[q[0]], tp[q[2]], tp[q[3]] };
        const float2 u2[3] = { tuv[q[0]], tuv[q[2]], tuv[q[3]] };
        rasterCarShadowTri(t2, u2, alpha, shape);
    }
    // COMPOSITE. The layer's outer rows stay empty (the shader's CLAMP relies
    // on it), x wraps at the lap seam, and the optional raster-side tail cut is
    // taken HERE — on the resolved coverage, once, rather than per triangle.
    const bool cut = !mShadowTune.remapInShader
            && mShadowTune.remapHi > mShadowTune.remapLo;  // empty band = no cut
    const float lo = mShadowTune.remapLo * mShadowTune.ao;
    const float hi = mShadowTune.remapHi * mShadowTune.ao;
    for (int sy = 0; sy < mStampH; sy++) {
        const int y = mStampY0 + sy;
        if (y < 1 || y > H - 2) continue;
        const float* src = mStampCov.data() + (size_t) sy * mStampW;
        uint8_t* row = mCarShadowPix.data() + (size_t) y * (int) mCarShadowW;
        for (int sx = 0; sx < mStampW; sx++) {
            float a = src[sx];
            if (a <= 0.0f) continue;
            if (cut) {
                const float t = std::min(1.0f, std::max(0.0f,
                        (a - lo) / std::max(1e-4f, hi - lo)));
                a *= t * t * (3.0f - 2.0f * t);
            }
            const int add = (int) std::lround(a * 255.0f);
            if (add <= 0) continue;
            const int wx = (((mStampX0 + sx) % (int) mCarShadowW)
                    + (int) mCarShadowW) % (int) mCarShadowW;
            row[wx] = (uint8_t) std::min(255, (int) row[wx] + add);
        }
    }
    mCarShadowUpload = true;
    for (SkidRect& m : mCarShadowDirty) {
        if (r.x0 <= m.x1 + 8 && m.x0 <= r.x1 + 8
                && r.y0 <= m.y1 + 8 && m.y0 <= r.y1 + 8) {
            m.x0 = std::min(m.x0, r.x0); m.y0 = std::min(m.y0, r.y0);
            m.x1 = std::max(m.x1, r.x1); m.y1 = std::max(m.y1, r.y1);
            return;
        }
    }
    mCarShadowDirty.push_back(r);
}

// The frame's upload, into the texture of the pair the driver is NOT reading,
// then every road instance re-pointed at it. The swap IS the ping-pong — by the
// time a texture takes its next upload, the last frame that referenced it has
// left the queue, so the driver never has to ghost or stall a respecified
// in-flight texture. The skid layer used to dodge the same hazard with a ~30 Hz
// throttle instead; that was measured a null and dropped (see the skid block in
// TtpRendererFrame), and it was never an option here anyway — shadows track
// cars, so a throttled one lags the body it belongs to.
//
// **THE STAMPS' OWN RECTS, NOT THE WHOLE LEVEL, and that is the difference
// between this channel costing 3 ms of frame thread and costing a fraction of
// one.** The layer covers a whole lap by the whole deck; the cars occupy a few
// thousand texels of it. Sending all of it, every frame, was ~2.9 ms of CPU on
// the Android reference box at four players — measured by ablating the channel
// (`TTP_DEBUG_NO_DECAL_BLOB`), and it is a memcpy plus the driver's own copy of
// megabytes that did not change.
//
// The comment that used to stand here argued the other way, on the skid layer's
// finding that the driver bills upload stalls per EVENT and not per byte. That
// was measured when this layer was 384 KB; it does not survive the density the
// flicker fix needed, and the events are far fewer than the 16-24 it feared
// because the rects MERGE (a pack sits in one place).
//
// THREE FRAMES OF RECTS, because of the ping-pong: this texture was last
// correct two frames ago, and what changed since is this frame's stamps, last
// frame's (which this frame's erase zeroed) and the one before that's. Miss one
// and each texture keeps the other's stale stamps — the shadow strobes between
// two positions. `uploadWhole` is the A/B arm that put the number above on the
// board and is kept for the next box.
//
// The copies are mandatory: the CPU buffer is mutated again next frame and
// native drivers read uploads asynchronously.
void TtpRenderer::uploadCarShadow() {
    if (!mCarShadowTex[0] || !mCarShadowUpload || mCarShadowPix.empty()) return;
    mCarShadowUpload = false;
    Texture* t = !mCarShadowTex[1]
            ? mCarShadowTex[0] : mCarShadowTex[mCarShadowPing & 1];
    const int W = (int) mCarShadowW, H = (int) mCarShadowH;

    if (mShadowTune.uploadWhole) {
        const size_t bytes = mCarShadowPix.size();
        auto* buf = new uint8_t[bytes];
        std::memcpy(buf, mCarShadowPix.data(), bytes);
        t->setImage(*mEngine, 0,
                Texture::PixelBufferDescriptor(buf, bytes,
                        Texture::Format::R, Texture::Type::UBYTE,
                        [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                        nullptr));
    } else {
        // The union of the three frames, merged under the copy budget
        // (kUploadEventTexels): a pack shares one event.
        std::vector<SkidRect> rects;
        const auto add = [&](const SkidRect& r) {
            if (r.x1 > r.x0 && r.y1 > r.y0) rects.push_back(r);
        };
        for (const SkidRect& r : mCarShadowDirty) add(r);
        for (const auto& list : mCarShadowWas) {
            for (const SkidRect& r : list) add(r);
        }
        mergeUploadRects(rects);
        for (const SkidRect& r : rects) {
            const int y0 = std::max(0, r.y0), y1 = std::min(H, r.y1);
            if (y0 >= y1) continue;
            // Unwrapped x splits at the lap seam, exactly as uploadSkidRects
            // does it — same layer shape, same rule.
            int spans[2][2];
            int nSpans = 0;
            if (r.x1 - r.x0 >= W) {
                spans[0][0] = 0; spans[0][1] = W; nSpans = 1;
            } else {
                const int wx0 = ((r.x0 % W) + W) % W;
                const int wx1 = wx0 + (r.x1 - r.x0);
                if (wx1 <= W) {
                    spans[0][0] = wx0; spans[0][1] = wx1; nSpans = 1;
                } else {
                    spans[0][0] = wx0; spans[0][1] = W;
                    spans[1][0] = 0;   spans[1][1] = wx1 - W;
                    nSpans = 2;
                }
            }
            for (int s = 0; s < nSpans; s++) {
                const int sx0 = spans[s][0], sw = spans[s][1] - sx0;
                const int sh = y1 - y0;
                if (sw <= 0 || sh <= 0) continue;
                auto* buf = new uint8_t[(size_t) sw * sh];
                for (int y = 0; y < sh; y++) {
                    std::memcpy(buf + (size_t) y * sw,
                            mCarShadowPix.data() + (size_t) (y0 + y) * W + sx0,
                            (size_t) sw);
                }
                t->setImage(*mEngine, 0, (uint32_t) sx0, (uint32_t) y0,
                        (uint32_t) sw, (uint32_t) sh,
                        Texture::PixelBufferDescriptor(buf, (size_t) sw * sh,
                                Texture::Format::R, Texture::Type::UBYTE,
                                [](void* b, size_t, void*) { delete[] (uint8_t*) b; },
                                nullptr));
            }
        }
    }
    for (RoadChunk& ch : mRoadChunks) bindCarShadow(ch.mi, t);
    if (mRoadInst) bindCarShadow(mRoadInst, t);
    mCarShadowPing ^= 1;
}

// Bound to every vroad instance, because a declared sampler must be bound even
// while no track gives it anything to hold — same rule as the decal mask
// above. skidLatHalf 0 is what actually disables the tap.
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

// The shared receiver instance, created on first use so the road (built before
// the bake) can already reference it; bindShadowMap fills it in afterwards.
// The deck's own instance. It exists so the road can carry decal uniforms that
// the structures and berms — which share litShadowInstance() — must not see, and
// so the road can require a uv0 channel they do not have.
MaterialInstance* TtpRenderer::roadInstance() {
    if (!mRoadMaterial) return litShadowInstance();  // no vroad served
    if (!mRoadInst) {
        mRoadInst = sceneInstance(mRoadMaterial);
        // Absent on the baked-light vroad (see fillRoadLight); an old blob
        // still carries the live ESM decode.
        if (mRoadMaterial->hasParameter("shadowTexel")) {
            mRoadInst->setParameter("shadowTexel", 0.0f);
        }
        if (roadHasMaskLoop()) mRoadInst->setParameter("maskCount", 0);
        mRoadInst->setParameter("profCount", 0);
        mRoadInst->setParameter("paintCount", 0);
        mRoadInst->setParameter("trackLength", 0.0f);
        mRoadInst->setParameter("invTrackLength", 0.0f);
        mRoadInst->setParameter("chunkMid", 0.0f);
        // The silhouette array feeds the masked loop's NEAR-car stamps; the
        // far cars' carShadow tap stays off until a track builds the layer
        // (maskInk.w = 0 is the tap's disable).
        if (roadHasMaskLoop()) {
            if (Texture* arr = ensureDecalMaskArray()) bindDecalMask(mRoadInst, arr);
        }
        bindSkidLayer(mRoadInst);
        if (roadHasCarShadow()) {
            bindCarShadow(mRoadInst, mCarShadowTex[0]);
            mRoadInst->setParameter("maskInk",
                    shadowInkParam(mCarShadowTex[0] != nullptr));
            if (mRoadInst->getMaterial()->hasParameter("carShadowRemap")) {
                mRoadInst->setParameter("carShadowRemap", shadowRemapParam());
            }
        }
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
            float4{ 0, 0, 0, 0 }, {}, {}, {} };
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
// of the list, which is why each caller orders its list by priority.
int TtpRenderer::foldToChunk(const std::vector<DeckDecal>& src, float mid,
        float halfSpan, float L, DeckDecal* out, int cap, DecalKind kind) {
    int n = 0;
    for (const DeckDecal& d : src) {
        if (n >= cap) break;
        // texrot.w is the masked flag on the gathered entry. It does not reach
        // the GPU any more — the two lists ARE the distinction there — but it
        // is still what tells the two folds apart, and what
        // ttp_display_debug_decals reads.
        const bool masked = d.texrot.w > 0.5f;
        // 1 = fold-visible masked (a NEAR car under the hybrid LOD);
        // 2 = texture-carried (far), pushed for the debug readback only —
        // it must fold into NEITHER list.
        const bool foldMasked = masked && d.texrot.w < 1.5f;
        if (kind == DecalKind::Masked && !foldMasked) continue;
        if (kind == DecalKind::Profile && masked) continue;
        float ds = d.rect.x - mid;
        if (L > 0.0f) ds -= L * std::floor(ds / L + 0.5f);
        // A MASKED stamp is rotated in track space (rect.zw are its halves in
        // the CAR's frame), so its arclength reach is measured per frame and
        // ridden in wfwd.w — vroad.mat's maskRect.zw, and it must be THE
        // SAME NUMBER: a chunk that folds on a shorter reach than the shader
        // culls on drops a corner the fragments still want, which pops the
        // shape at chunk seams. Unmasked entries — pads, repairs, auras — keep
        // the plain half-extent they always had.
        const float reach = d.texrot.w > 0.5f ? d.wfwd.w : d.rect.z;
        if (std::fabs(ds) > halfSpan + reach) continue;
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

    // tb, not mTrack: buildTrackScene only adopts the bin at the very end, so
    // during the build mTrack is still the track this one replaces.
    const float L = tb.length;
    const auto writeTo = [&](MaterialInstance* mi, float mid, float halfSpan) {
        DeckDecal sel[kMaxChunkPaint];
        const int n = foldToChunk(paint, mid, halfSpan, L, sel, kMaxChunkPaint);
        if (n > 0) {
            float4 rect[kMaxChunkPaint], col[kMaxChunkPaint], shape[kMaxChunkPaint];
            for (int i = 0; i < n; i++) {
                rect[i] = sel[i].rect; col[i] = sel[i].color; shape[i] = sel[i].shape;
            }
            mi->setParameter("paintRect", rect, (size_t) n);
            mi->setParameter("paintColor", col, (size_t) n);
            mi->setParameter("paintShape", shape, (size_t) n);
        }
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
    // Statics FIRST: the array is composited in order, so a car's aura and its
    // contact shadow land over the pad or slick they are crossing, which is the
    // order the separate meshes used to get from their render priorities.
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
    // TWO FOLDS, TWO LISTS. A masked entry and a profile entry share no uniform
    // array in vroad any more (see kMaxMaskedDeckDecals), so each channel gets
    // its own fold, its own cap and its own "unchanged" comparison — a chunk can
    // overflow one and not the other, and one concatenated compare would then
    // rewrite both every frame.
    //
    // The BOXES in front of the loops (one per list — see below) are the union
    // of the reject windows the loops actually test — r.zw for a profile
    // stamp, the measured reach in the w slots for a masked one — so a
    // fragment one rejects had nothing to draw. Build one from anything the
    // folds DROPPED and it clips a stamp that is not there; build it from the
    // wrong bound and it clips one that is.
    // The masked fold is gated on the blob declaring the arrays, because a
    // setParameter against a parameter the material does not declare would
    // abort. The current vroad declares them: they carry the hybrid shadow
    // LOD's NEAR cars, beside the far cars' carShadow layer (renderCars
    // rasterizes, uploadCarShadow ships).
    const bool maskLoop = roadHasMaskLoop();
    const auto uploadTo = [&](MaterialInstance* mi, float mid, float halfSpan,
            std::vector<DeckDecal>& lastMask, std::vector<DeckDecal>& lastProf) {
        DeckDecal mask[kMaxMaskedDeckDecals], prof[kMaxProfileDeckDecals];
        // CAPS_HALF halves only the PROFILE fold here: the masked fold's cap
        // must equal the pick budget (renderCars halves that one), or the
        // fold overflows and a near car loses its shadow outright.
        const int profCap = (mDecalDebug & kDebugDecalCapsHalf)
                ? kMaxProfileDeckDecals / 2 : kMaxProfileDeckDecals;
        const int nm = maskLoop ? foldToChunk(mDeckDecalsLast, mid, halfSpan, L,
                mask, kMaxMaskedDeckDecals, DecalKind::Masked) : 0;
        const int np = foldToChunk(mDeckDecalsLast, mid, halfSpan, L, prof,
                profCap, DecalKind::Profile);
        const bool maskSame = (size_t) nm == lastMask.size()
                && (nm == 0 || std::memcmp(mask, lastMask.data(),
                        nm * sizeof(DeckDecal)) == 0);
        const bool profSame = (size_t) np == lastProf.size()
                && (np == 0 || std::memcmp(prof, lastProf.data(),
                        np * sizeof(DeckDecal)) == 0);
        if (maskSame && profSame) return;
        lastMask.assign(mask, mask + nm);
        lastProf.assign(prof, prof + np);

        // ONE BOX PER LIST. They cluster in different places — the masked
        // entries follow the pack, the profile ones are bolted to the track —
        // so a single union spans the gap between the two clusters and every
        // fragment in that gap walks both loops for nothing.
        float4 pBounds{ 1e9f, -1e9f, 1e9f, -1e9f };
        float4 mBounds{ 1e9f, -1e9f, 1e9f, -1e9f };
        const auto widen = [](float4& b, const float4& rect, float bS, float bL) {
            b.x = std::min(b.x, rect.x - bS);
            b.y = std::max(b.y, rect.x + bS);
            b.z = std::min(b.z, rect.y - bL);
            b.w = std::max(b.w, rect.y + bL);
        };

        if (np > 0) {
            float4 rect[kMaxProfileDeckDecals], col[kMaxProfileDeckDecals],
                    shape[kMaxProfileDeckDecals];
            for (int i = 0; i < np; i++) {
                rect[i] = prof[i].rect; col[i] = prof[i].color; shape[i] = prof[i].shape;
                widen(pBounds, prof[i].rect, prof[i].rect.z, prof[i].rect.w);
            }
            mi->setParameter("profRect", rect, (size_t) np);
            mi->setParameter("profColor", col, (size_t) np);
            mi->setParameter("profShape", shape, (size_t) np);
        }
        if (nm > 0) {
            float4 rect[kMaxMaskedDeckDecals], wpos[kMaxMaskedDeckDecals],
                    wfwd[kMaxMaskedDeckDecals], wright[kMaxMaskedDeckDecals];
            for (int i = 0; i < nm; i++) {
                const DeckDecal& d = mask[i];
                // THE REJECT WINDOW IS ONE vec4: centre in xy, the MEASURED
                // track-space reaches in zw — the same wfwd.w / wright.w
                // foldToChunk reads, packed here so the shader's cull and the
                // fold cannot drift apart. The stamp's world halves stop
                // crossing at all: each axis is premultiplied by its own
                // reciprocal half instead, so the shader's projection is two
                // dots and no divides (the invSkidLatSpan trade).
                rect[i] = float4{ d.rect.x, d.rect.y, d.wfwd.w, d.wright.w };
                // THE SILHOUETTE LAYER RIDES IN THE ANCHOR'S SPARE w. It was
                // texrot.z while one mixed list carried both kinds; texrot is
                // now readback-only (the debug accessor reads mDeckDecalsLast,
                // not these uniforms) and does not cross to the GPU at all.
                wpos[i] = float4{ d.wpos.x, d.wpos.y, d.wpos.z, d.texrot.z };
                const float invF = 1.0f / std::max(d.rect.z, 1e-5f);
                const float invR = 1.0f / std::max(d.rect.w, 1e-5f);
                // The peak alpha rides the forward axis's freed w; the ink
                // RGB is ONE colour for every car shadow (CarShadowTuning::
                // ink), so it crosses once as maskInk below rather than as a
                // per-entry array the loop would pay for by DECLARED SIZE.
                wfwd[i] = float4{ d.wfwd.x * invF, d.wfwd.y * invF,
                                  d.wfwd.z * invF, d.color.w };
                wright[i] = float4{ d.wright.x * invR, d.wright.y * invR,
                                    d.wright.z * invR, 0.0f };
                widen(mBounds, d.rect, d.wfwd.w, d.wright.w);
            }
            mi->setParameter("maskRect", rect, (size_t) nm);
            mi->setParameter("maskWPos", wpos, (size_t) nm);
            mi->setParameter("maskWFwd", wfwd, (size_t) nm);
            mi->setParameter("maskWRight", wright, (size_t) nm);
            // w = the carShadow TAP's enable+cap, NOT zero: this per-frame
            // write predates the hybrid and used to be harmless — zeroing it
            // here silently killed the far blobs on every chunk that carried
            // a near car (the user's own chunk, always).
            mi->setParameter("maskInk",
                    shadowInkParam(roadHasCarShadow() && mCarShadowTex[0]));
        }
        if (np > 0) mi->setParameter("profBounds", pBounds);
        // The BOUNDS0 probe: same writes, impossible box (ttp_display.h).
        if (nm > 0) {
            mi->setParameter("maskBounds",
                    (mDecalDebug & kDebugDecalMaskBounds0)
                            ? float4{ 1e9f, -1e9f, 1e9f, -1e9f } : mBounds);
        }
        mi->setParameter("profCount", np);
        // The MASK_COUNT0 probe: every write above lands on its shipped
        // schedule, only the count the loop reads is zeroed (ttp_display.h).
        if (maskLoop) {
            mi->setParameter("maskCount",
                    (mDecalDebug & kDebugDecalMaskCount0) ? 0 : nm);
        }
    };
    if (!mRoadChunks.empty()) {
        for (RoadChunk& ch : mRoadChunks) {
            uploadTo(ch.mi, (ch.sMin + ch.sMax) * 0.5f, (ch.sMax - ch.sMin) * 0.5f,
                    ch.lastMask, ch.lastProf);
        }
    } else if (mRoadInst) {
        // Degenerate: the deck material exists but the chunk pass produced
        // nothing. One "chunk" spanning the whole lap keeps the decals drawing
        // (its wrap constants are set at build, like the chunks').
        uploadTo(mRoadInst, 0.0f, L > 0.0f ? L : 1.0e9f,
                mRoadInstLastMask, mRoadInstLastProf);
    }
    applyRoadDebug();   // no-op unless a caller asked for an ablation
}

MaterialInstance* TtpRenderer::litShadowInstance() {
    if (!mLitShadowInst && mLitMaterial) {
        mLitShadowInst = sceneInstance(mLitMaterial);
        mLitShadowInst->setParameter("shadowTexel", 0.0f);
    }
    return mLitShadowInst;
}

void TtpRenderer::bindShadowMap(MaterialInstance* mi) {
    if (!mi) return;
    // A sampler must be bound even when a track baked no map (Filament draws
    // with every sampler resolved), so keep the 1×1 white around for it.
    Texture* tex = mShadowMap ? mShadowMap : whiteTexture();
    if (!tex) return;
    TextureSampler smp(TextureSampler::MinFilter::LINEAR, TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("shadowMap", tex, smp);
    mi->setParameter("shadowFromWorld", mShadowFromWorld);

    // Sampling step + the normal offset that keeps a curving deck from
    // shadowing itself (three refits the same guard to its texel size).
    mi->setParameter("shadowTexel", mShadowMap ? mShadowTexel : 0.0f);
    mi->setParameter("shadowK", kShadowEsmK);
    mi->setParameter("shadowDepthScale", mShadowDepthScale);
}

// The DECK's baked sun-visibility map (vroadvis.mat), in TRACK space. White
// with a 0 lat span = fully lit, for a track that baked no map — the same
// no-branch fallback the old shadowTexel-0 early-out gave, and what a road
// material predating this parameter keeps doing.
//
// The sampler is CLAMP on BOTH axes, and clamping v is what carries the kerbs:
// an off-deck fragment's OFF_DECK_LAT lands on the outermost deck column and
// inherits its shadow. u clamps rather than repeats because the map covers the
// lap exactly once and a wrap would fold the finish line's shadow onto the
// start line's.
void TtpRenderer::bindRoadVisMap(MaterialInstance* mi) {
    if (!mi || !mi->getMaterial()->hasParameter("sunVis")) return;
    Texture* tex = mRoadVisMap ? mRoadVisMap : whiteTexture();
    if (!tex) return;
    TextureSampler smp(TextureSampler::MinFilter::LINEAR,
            TextureSampler::MagFilter::LINEAR);
    smp.setWrapModeS(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    smp.setWrapModeT(TextureSampler::WrapMode::CLAMP_TO_EDGE);
    mi->setParameter("sunVis", tex, smp);
    mi->setParameter("invSunVisLatSpan", roadVisLatSpan());
}

// The GROUND's baked sun-visibility map (vvis.mat) — its uv is
// shadowFromWorld's own output, so the matrix rides along with the texture.
// White = fully lit, for a track that baked no map — the same no-branch
// fallback the old shadowTexel-0 early-out provided. A shell still serving
// the PRE-BAKE vground blob (the one carrying the ESM parameters) gets the
// full bindShadowMap treatment instead, and draws exactly what it used to.
void TtpRenderer::bindVisMap(MaterialInstance* mi) {
    if (!mi) return;
    if (!mi->getMaterial()->hasParameter("visMap")) { bindShadowMap(mi); return; }
    Texture* tex = mVisMap ? mVisMap : whiteTexture();
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
