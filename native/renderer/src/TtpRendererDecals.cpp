// Split from the original single-file TtpRenderer.cpp along its subsystem
// seams; TtpRendererImpl.h carries what the topic files share. Pure code
// motion — behaviour, member set and ABI are unchanged.
#include "TtpRendererImpl.h"


// The silhouette store for the road-shader shadow decals: one array layer per
// car slot, one for the monster, one generic. Engine-lifetime (layers are
// rebaked per scene — mMaskLayerBakedBits says which hold the current scene's
// bake); created on first use and bound to every vroad instance, because a
// declared sampler must be bound even while no masked decal references it.
Texture* TtpRenderer::ensureDecalMaskArray() {
    if (mDecalMaskArray || !mEngine) return mDecalMaskArray;
    mDecalMaskArray = Texture::Builder()
            .width(kMaskCellW).height(kMaskCellH).depth(kMaskLayers).levels(1)
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

// The rubber layer's engine-lifetime half: ONE offscreen pass over the
// per-track R8 accumulation texture, adding this frame's committed trail
// segments. There is no decay pass — ink is permanent until the restart
// wipe, which is a plain clear on this same pass. Everything is
// vertexDomain:device — the camera exists only because a View requires one.
bool TtpRenderer::ensureSkidLayer() {
    if (mSkidStampView) return true;
    if (!mEngine || !mRenderer || !mSkidMaterial) return false;
    mSkidCamEnt = utils::EntityManager::get().create();
    mSkidCam = mEngine->createCamera(mSkidCamEnt);

    // The stamp buffers: a fixed pool of 4-column quads (the mesh pool's old
    // feather profile — outer columns zero ink), fully rewritten on any frame
    // that commits a segment. Unused slots stay all-zero, which is a
    // zero-area quad the rasterizer never touches, so the index count can be
    // the full capacity and nothing tracks a live range.
    mSkidVerts.assign((size_t) kSkidQuadCap * 8, { 0, 0, 0, 0 });
    mSkidVB = VertexBuffer::Builder()
            .vertexCount(kSkidQuadCap * 8).bufferCount(1)
            .attribute(VertexAttribute::POSITION, 0,
                    VertexBuffer::AttributeType::FLOAT3, 0, sizeof(Vertex))
            .attribute(VertexAttribute::COLOR, 0,
                    VertexBuffer::AttributeType::UBYTE4, 12, sizeof(Vertex))
            .normalized(VertexAttribute::COLOR)
            .build(*mEngine);
    auto* idx = new std::vector<uint32_t>((size_t) kSkidQuadCap * 18);
    for (uint32_t q = 0; q < kSkidQuadCap; q++) {
        const uint32_t b = q * 8;      // rear b..b+3, front b+4..b+7 (L→R)
        uint32_t* dst = idx->data() + (size_t) q * 18;
        for (uint32_t k = 0; k < 3; k++) { // one quad per column pair
            const uint32_t r = b + k, f = b + 4 + k;
            const uint32_t src[6] = { r, f + 1, r + 1, r, f, f + 1 };
            std::copy(src, src + 6, dst + k * 6);
        }
    }
    mSkidIB = IndexBuffer::Builder()
            .indexCount((uint32_t) idx->size())
            .bufferType(IndexBuffer::IndexType::UINT)
            .build(*mEngine);
    mSkidIB->setBuffer(*mEngine, IndexBuffer::BufferDescriptor(
            idx->data(), idx->size() * sizeof(uint32_t),
            [](void*, size_t, void* user) { delete (std::vector<uint32_t>*) user; },
            idx));
    mSkidStampMI = mSkidMaterial->createInstance();
    mSkidStampEnt = utils::EntityManager::get().create();
    RenderableManager::Builder(1)
            .boundingBox({ { -1, -1, 0 }, { 1, 1, 1 } })
            .material(0, mSkidStampMI)
            .geometry(0, RenderableManager::PrimitiveType::TRIANGLES,
                    mSkidVB, mSkidIB, 0, kSkidQuadCap * 18)
            .culling(false).castShadows(false).receiveShadows(false)
            .build(*mEngine, mSkidStampEnt);
    mSkidStampScene = mEngine->createScene();
    mSkidStampScene->addEntity(mSkidStampEnt);

    View* v = mEngine->createView();
    v->setScene(mSkidStampScene);
    v->setCamera(mSkidCam);
    v->setPostProcessingEnabled(false);
    v->setShadowingEnabled(false);
    v->setFrustumCullingEnabled(false);
    // BlendMode stays OPAQUE (the default). TRANSLUCENT looked like the
    // "preserve the target" switch, but it also composites the view's draws
    // as premultiplied SRC_OVER — overriding vskid's additive blend, so every
    // stamp REPLACED the ink under its footprint (a light mark punched a hole
    // through a dark one, and each stamp's zero-ink skirt gnawed the previous
    // stamp's edge into a sawtooth). Preservation comes from ClearOptions
    // (clear=false, discard=false) at the render call, not from the blend mode.
    mSkidStampView = v;
    return true;
}

// Bound to every vroad instance, because a declared sampler must be bound even
// while no track (or no vskid material) gives it anything to hold — same rule
// as the decal mask above. skidLatHalf 0 is what actually disables the tap.
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
    // angles instead of trilinear mush. Until the first generateMipmaps lands
    // Filament clamps sampling to level 0 on its own (RenderTarget attachment
    // sets the texture's LOD range), so there is no window on ungenerated mips.
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
        mRoadInst->setParameter("shadowTexel", 0.0f);
        mRoadInst->setParameter("decalCount", 0);
        mRoadInst->setParameter("paintCount", 0);
        mRoadInst->setParameter("trackLength", 0.0f);
        mRoadInst->setParameter("invTrackLength", 0.0f);
        mRoadInst->setParameter("chunkMid", 0.0f);
        if (Texture* arr = ensureDecalMaskArray()) bindDecalMask(mRoadInst, arr);
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
        float halfSpan, float L, DeckDecal* out, int cap) {
    int n = 0;
    for (const DeckDecal& d : src) {
        if (n >= cap) break;
        float ds = d.rect.x - mid;
        if (L > 0.0f) ds -= L * std::floor(ds / L + 0.5f);
        // A MASKED stamp is rotated in track space (rect.zw are its halves in
        // the CAR's frame), so its axis-aligned reach is the half-diagonal plus
        // the shader's cull slack — rect.z alone dropped a rotated stamp's
        // corner from the neighbouring chunk while its fragments still wanted
        // it, which pops the shape at chunk seams. Mirrors vroad.mat's masked
        // `bound` exactly. Unmasked entries — pads, repairs, auras — keep the
        // plain half-extent they always had.
        const float reach = d.texrot.w > 0.5f
                ? std::sqrt(d.rect.z * d.rect.z + d.rect.w * d.rect.w) + 0.25f
                : d.rect.z;
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
    };
    for (RoadChunk& ch : mRoadChunks) {
        writeTo(ch.mi, (ch.sMin + ch.sMax) * 0.5f, (ch.sMax - ch.sMin) * 0.5f);
    }
    // The whole-lap fallback instance, when the chunk pass produced nothing.
    if (mRoadChunks.empty() && mRoadInst) {
        writeTo(mRoadInst, 0.0f, L > 0.0f ? L : 1.0e9f);
    }
}

void TtpRenderer::uploadDeckDecals() {
    // Statics FIRST: the array is composited in order, so a car's aura and its
    // contact shadow land over the pad or slick they are crossing, which is the
    // order the separate meshes used to get from their render priorities.
    if (!mStaticDeckDecals.empty()) {
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
    const auto uploadTo = [&](MaterialInstance* mi, float mid, float halfSpan,
            std::vector<DeckDecal>& last) {
        DeckDecal sel[kMaxDeckDecals];
        const int n = foldToChunk(mDeckDecalsLast, mid, halfSpan, L, sel,
                kMaxDeckDecals);
        if ((size_t) n == last.size()
                && (n == 0 || std::memcmp(sel, last.data(), n * sizeof(DeckDecal)) == 0)) {
            return;
        }
        last.assign(sel, sel + n);
        if (n > 0) {
            float4 rect[kMaxDeckDecals], col[kMaxDeckDecals], shape[kMaxDeckDecals],
                    trot[kMaxDeckDecals], wpos[kMaxDeckDecals], wfwd[kMaxDeckDecals],
                    wright[kMaxDeckDecals];
            for (int i = 0; i < n; i++) {
                rect[i] = sel[i].rect; col[i] = sel[i].color; shape[i] = sel[i].shape;
                trot[i] = sel[i].texrot;
                wpos[i] = sel[i].wpos; wfwd[i] = sel[i].wfwd; wright[i] = sel[i].wright;
            }
            mi->setParameter("decalRect", rect, (size_t) n);
            mi->setParameter("decalColor", col, (size_t) n);
            mi->setParameter("decalShape", shape, (size_t) n);
            mi->setParameter("decalTexRot", trot, (size_t) n);
            mi->setParameter("decalWPos", wpos, (size_t) n);
            mi->setParameter("decalWFwd", wfwd, (size_t) n);
            mi->setParameter("decalWRight", wright, (size_t) n);
        }
        mi->setParameter("decalCount", n);
    };
    if (!mRoadChunks.empty()) {
        for (RoadChunk& ch : mRoadChunks) {
            uploadTo(ch.mi, (ch.sMin + ch.sMax) * 0.5f, (ch.sMax - ch.sMin) * 0.5f,
                    ch.last);
        }
    } else if (mRoadInst) {
        // Degenerate: the deck material exists but the chunk pass produced
        // nothing. One "chunk" spanning the whole lap keeps the decals drawing
        // (its wrap constants are set at build, like the chunks').
        uploadTo(mRoadInst, 0.0f, L > 0.0f ? L : 1.0e9f, mRoadInstLast);
    }
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

// Oil slicks + warning cones. The slick is TrackProps' dark translucent disc
// (0x161425 @ 0.7); the cones ring it exactly like _buildHazards (n on
// radius×1.05, half-step offset, clamped inside the kerb). (Authored poles are
// concrete posts — see buildStructures.)
//
// The slick itself is a road-shader stamp (buildStaticDeckDecals); this builds
// its 3D markers only.
void TtpRenderer::buildOils(const TrackBin& tb) {
    if ((tb.oils.empty() && tb.poles.empty())) return;
    // Cones: hazard rings + gate poles, one instanced pool.
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
