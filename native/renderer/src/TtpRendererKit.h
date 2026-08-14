#pragma once
// The primitive/model kit the set-dressing, track and frame files share:
// unit prims, the bench/landmark model ids, and the toy-train path helpers.
// Split out of the original single-file TtpRenderer.cpp; header-inline so each
// including file sees one definition and no TU exports a symbol.
#include "TtpRendererImpl.h"

// Minimal primitive soup generators for the landmark builders (THREE-geometry
// layouts: primitives centred like their THREE counterparts). Verts append as
// {pos} + a caller-side transform + flat colour.
using PrimVerts = std::vector<float3>;
struct Prim { PrimVerts v; std::vector<uint32_t> i; };

// Per-FACE vertices, like THREE.BoxGeometry. Sharing the 8 corners let
// accumulateNormals average the three face normals into each corner, so every
// box came out SMOOTH-shaded — a gradient across each wall instead of six flat
// tones (the doghouse's brown was the tell).
inline Prim primBox(float w, float h, float d) {
    Prim p;
    const float x = w / 2, y = h / 2, z = d / 2;
    const float3 c[8] = { { -x, -y, -z }, { x, -y, -z }, { -x, y, -z }, { x, y, -z },
                          { -x, -y, z }, { x, -y, z }, { -x, y, z }, { x, y, z } };
    static const uint32_t FACE[6][6] = {
        { 0,2,1, 1,2,3 }, { 4,5,6, 5,7,6 }, { 0,1,4, 1,5,4 },
        { 2,6,3, 3,6,7 }, { 0,4,2, 2,4,6 }, { 1,3,5, 3,7,5 },
    };
    for (const auto& f : FACE) {
        uint32_t map[8];
        bool has[8] = {};
        for (int k = 0; k < 6; k++) {
            const uint32_t src = f[k];
            if (!has[src]) {
                map[src] = (uint32_t) p.v.size();
                p.v.push_back(c[src]);
                has[src] = true;
            }
            p.i.push_back(map[src]);
        }
    }
    return p;
}
inline Prim primCylinder(float rTop, float rBot, float h, int seg) {
    Prim p;
    for (int j = 0; j <= seg; j++) {
        const float a = (float) j / seg * 2.0f * (float) M_PI;
        p.v.push_back({ std::cos(a) * rBot, -h / 2, std::sin(a) * rBot });
        p.v.push_back({ std::cos(a) * rTop, h / 2, std::sin(a) * rTop });
    }
    for (int j = 0; j < seg; j++) {
        const uint32_t a = j * 2, b = a + 1, c2 = a + 2, d = a + 3;
        p.i.insert(p.i.end(), { a, c2, b, b, c2, d });
    }
    // Caps get their OWN rim vertices (THREE.CylinderGeometry does the same):
    // sharing the wall's rim rounds the top edge off into the side.
    const uint32_t capBase = (uint32_t) p.v.size();
    for (int j = 0; j <= seg; j++) {
        const float a = (float) j / seg * 2.0f * (float) M_PI;
        p.v.push_back({ std::cos(a) * rBot, -h / 2, std::sin(a) * rBot });
        p.v.push_back({ std::cos(a) * rTop, h / 2, std::sin(a) * rTop });
    }
    const uint32_t botC = (uint32_t) p.v.size(); p.v.push_back({ 0, -h / 2, 0 });
    const uint32_t topC = (uint32_t) p.v.size(); p.v.push_back({ 0, h / 2, 0 });
    for (int j = 0; j < seg; j++) {
        p.i.insert(p.i.end(), { botC, capBase + (uint32_t) j * 2,
                capBase + (uint32_t) (j + 1) * 2 });
        p.i.insert(p.i.end(), { topC, capBase + (uint32_t) (j + 1) * 2 + 1,
                capBase + (uint32_t) j * 2 + 1 });
    }
    return p;
}
inline Prim primCone(float r, float h, int seg) { return primCylinder(0.001f, r, h, seg); }
inline Prim primIco(float r) {
    Prim p;
    const float T = (1.0f + std::sqrt(5.0f)) / 2.0f;
    const float3 V[12] = { { -1, T, 0 }, { 1, T, 0 }, { -1, -T, 0 }, { 1, -T, 0 },
                           { 0, -1, T }, { 0, 1, T }, { 0, -1, -T }, { 0, 1, -T },
                           { T, 0, -1 }, { T, 0, 1 }, { -T, 0, -1 }, { -T, 0, 1 } };
    const int F[20][3] = { { 0,11,5 },{ 0,5,1 },{ 0,1,7 },{ 0,7,10 },{ 0,10,11 },
                           { 1,5,9 },{ 5,11,4 },{ 11,10,2 },{ 10,7,6 },{ 7,1,8 },
                           { 3,9,4 },{ 3,4,2 },{ 3,2,6 },{ 3,6,8 },{ 3,8,9 },
                           { 4,9,5 },{ 2,4,11 },{ 6,2,10 },{ 8,6,7 },{ 9,8,1 } };
    const float inv = r / std::sqrt(1 + T * T);
    // SOUP, not shared corners: PolyhedronGeometry flat-shades at detail 0
    // (computeVertexNormals per face), and the faceted read is the point —
    // boulders, pebbles, scrub and the hoodoo caps all want it.
    for (const auto& f : F) {
        for (const int k : { 0, 1, 2 }) {
            p.i.push_back((uint32_t) p.v.size());
            p.v.push_back(V[f[k]] * inv);
        }
    }
    return p;
}
// One level of THREE.IcosahedronGeometry's subdivision (detail 1): each face
// split into four, every vertex pushed back onto the sphere.
inline Prim primIcoDetail(float r, int detail) {
    Prim p = primIco(1.0f);
    if (detail <= 0) { for (float3& v : p.v) v = v * r; return p; }
    for (int d = 0; d < detail; d++) {
        Prim q;
        // SHARE the corners: PolyhedronGeometry normalizes its normals once it
        // subdivides (detail > 0), so the result reads as a smooth ball, and
        // shared corners are what let accumulateNormals average into that.
        std::unordered_map<uint64_t, uint32_t> seen;
        const auto vert = [&](const float3& v) {
            const auto key = [](float f) { return (uint64_t) (uint32_t) std::lround(f * 100000.0f); };
            const uint64_t k = key(v.x) * 73856093ull ^ key(v.y) * 19349663ull ^ key(v.z) * 83492791ull;
            const auto it = seen.find(k);
            if (it != seen.end()) return it->second;
            const uint32_t idx = (uint32_t) q.v.size();
            q.v.push_back(v);
            seen[k] = idx;
            return idx;
        };
        for (size_t t = 0; t + 2 < p.i.size(); t += 3) {
            const float3 a = p.v[p.i[t]], b = p.v[p.i[t + 1]], c = p.v[p.i[t + 2]];
            const float3 ab = normalize((a + b) * 0.5f);
            const float3 bc = normalize((b + c) * 0.5f);
            const float3 ca = normalize((c + a) * 0.5f);
            const uint32_t ia = vert(a), ib = vert(b), ic = vert(c);
            const uint32_t iab = vert(ab), ibc = vert(bc), ica = vert(ca);
            for (const uint32_t k : { ia, iab, ica, iab, ib, ibc, ica, ibc, ic, iab, ibc, ica }) {
                q.i.push_back(k);
            }
        }
        p = q;
    }
    for (float3& v : p.v) v = v * r;
    return p;
}

// UV sphere over a PHI RANGE (THREE.SphereGeometry's phiStart/phiLength args):
// the seashell is the top half of a squashed dome.
inline Prim primSphereBand(float r, int ws, int hs, float phi0, float phiLen) {
    Prim p;
    for (int iy = 0; iy <= hs; iy++) {
        const float phi = phi0 + (float) iy / hs * phiLen;
        for (int ix = 0; ix <= ws; ix++) {
            const float th = (float) ix / ws * 2.0f * (float) M_PI;
            p.v.push_back({ -std::cos(th) * std::sin(phi) * r, std::cos(phi) * r,
                            std::sin(th) * std::sin(phi) * r });
        }
    }
    const int stride = ws + 1;
    for (int iy = 0; iy < hs; iy++) {
        for (int ix = 0; ix < ws; ix++) {
            const uint32_t a = iy * stride + ix, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}

inline Prim primSphere(float r, int ws, int hs) {
    Prim p;
    for (int iy = 0; iy <= hs; iy++) {
        const float phi = (float) iy / hs * (float) M_PI;
        for (int ix = 0; ix <= ws; ix++) {
            const float th = (float) ix / ws * 2.0f * (float) M_PI;
            p.v.push_back({ -std::cos(th) * std::sin(phi) * r, std::cos(phi) * r,
                            std::sin(th) * std::sin(phi) * r });
        }
    }
    const int stride = ws + 1;
    for (int iy = 0; iy < hs; iy++) {
        for (int ix = 0; ix < ws; ix++) {
            const uint32_t a = iy * stride + ix, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}
inline Prim primTorusArc(float R, float tube, int tubeSeg, int radSeg, float arc) {
    Prim p;
    for (int j = 0; j <= radSeg; j++) {
        const float u = (float) j / radSeg * arc;
        for (int k = 0; k <= tubeSeg; k++) {
            const float v = (float) k / tubeSeg * 2.0f * (float) M_PI;
            p.v.push_back({ (R + tube * std::cos(v)) * std::cos(u),
                            tube * std::sin(v),
                            (R + tube * std::cos(v)) * std::sin(u) });
        }
    }
    const int stride = tubeSeg + 1;
    for (int j = 0; j < radSeg; j++) {
        for (int k = 0; k < tubeSeg; k++) {
            const uint32_t a = j * stride + k, b = a + stride;
            p.i.insert(p.i.end(), { a, b, a + 1, a + 1, b, b + 1 });
        }
    }
    return p;
}
inline Prim applyPre(Prim p, const mat4f& m) {
    for (auto& v : p.v) v = (m * float4{ v, 1 }).xyz;
    return p;
}

// A flat PLATE: a convex outline in the (y,z) plane, extruded by `t` along x.
//
// The one shape neither a box nor a cylinder makes — a fin, a cowcatcher, a
// hat brim, a nameplate. Every model that wanted one before either did without
// or spent a rotated box on it, which is why the rocket's fins were rectangles
// standing straight up rather than anything swept. Outline points are (y, z)
// and must be convex and consistently wound; the material culls nothing, so a
// backwards winding costs shading, not visibility.
inline Prim primPlate(const std::vector<std::pair<float, float>>& yz, float t) {
    Prim p;
    const uint32_t n = (uint32_t) yz.size();
    if (n < 3) return p;
    const float h = t / 2;
    for (int side = 0; side < 2; side++) {
        for (const auto& q : yz) p.v.push_back({ side ? h : -h, q.first, q.second });
    }
    for (uint32_t k = 1; k + 1 < n; k++) {
        p.i.insert(p.i.end(), { 0u, k + 1, k });                    // -x face
        p.i.insert(p.i.end(), { n, n + k, n + k + 1 });             // +x face
    }
    for (uint32_t k = 0; k < n; k++) {                              // the rim
        const uint32_t a = k, b = (k + 1) % n;
        p.i.insert(p.i.end(), { a, b, n + b, a, n + b, n + a });
    }
    return p;
}

// ---------------------------------------------------------------------------
// MODEL VARIANTS — the takes on each of the props worth looking at closely.
//
// WHY THESE ARE FUNCTIONS AND NOT INLINE IN buildLandmarks. Two callers need
// the same geometry from different frames: the landmark placer, which stands
// ONE of them wherever its clearance search lands, and the MODEL BENCH, which
// stands ALL of them in a row so they can be judged against each other. A
// model authored inline in the placer can only ever be seen in the place the
// placer chose, next to nothing to compare it with — which is how the rocket
// shipped as four rectangles and a cone for as long as it did.
//
// Everything emits through a `part` callback in the model's OWN local frame
// (y up, +z forward, origin on the ground for the standing models and at the
// body centre for the rocket, whose +y is its nose). Placement, yaw and world
// offset are the caller's.
//
// VARIANT 0 IS ALWAYS THE PRE-BENCH GEOMETRY, byte for byte. That is what
// makes the bench a decision rather than a fait accompli: the row's first entry
// is the thing being argued against, and picking it was always a legitimate
// outcome. It is not what ships — the picks are mModelVariant's defaults.
// ---------------------------------------------------------------------------

using PartFn = std::function<void(const Prim&, float, float, float, uint32_t, float)>;

enum ModelId { MODEL_ROCKET = 0, MODEL_GNOME = 1, MODEL_TRAIN = 2, MODEL_STARFISH = 3,
               MODEL_COUNT = 4 };

// How many takes each model has. PER MODEL, because they are not all being
// asked the same question: the gnome and the train were asked "how much
// detail", which two answers bracket, while the rocket and the starfish are
// being asked "what SHAPE", and that needs as many entries as there are shapes
// worth arguing about. A single count for all would either starve one row or
// pad the others with a duplicate.
inline int modelVariantCount(int id) {
    return id == MODEL_STARFISH ? 5 : id == MODEL_ROCKET ? 4 : 3;
}

// Model ids are a URL param and a dropdown value, so they are spelled, not
// numbered. Unknown names answer -1 (the caller leaves the bench off).
inline int modelIdByName(const char* name) {
    if (!name || !*name) return -1;
    const std::string n = name;
    if (n == "rocket") return MODEL_ROCKET;
    if (n == "gnome") return MODEL_GNOME;
    if (n == "train") return MODEL_TRAIN;
    if (n == "starfish") return MODEL_STARFISH;
    return -1;
}

inline const mat4f rotXm(float a) { return mat4f::rotation(a, float3{ 1, 0, 0 }); }
inline const mat4f rotYm(float a) { return mat4f::rotation(a, float3{ 0, 1, 0 }); }
inline const mat4f rotZm(float a) { return mat4f::rotation(a, float3{ 0, 0, 1 }); }

// ---- the wind-up train ----------------------------------------------------
// buildTrainModel below still draws the loco, for the asset gallery's model
// bench alone. The stadium oval it used to trundle — the path, the sleepers,
// the gauge they were laid to and the per-frame walk — went when the playroom's
// train became the Holiday Kit's own set on its own rails (theme.cc).

// ---- rocket ---------------------------------------------------------------
// SLEEK AND MODERN, decided after four rounds of toy shapes were turned down.
// v1 "cruise" is the one that was picked and is what ships; 2 and 3 are the
// other two readings of the same brief, kept for comparison.
//
// THE RULE IS "NO BANDS", not "no colour", and that distinction is the whole
// lesson of this file. Every attempt before these inherited red-and-cream
// BANDING from v0, and banding is why so many of them read as a traffic cone or
// a lighthouse whatever shape they were given — it was a palette problem being
// solved as a shape problem for four rounds. The picked one is red and yellow
// and still reads as a machine, because the colour changes where the OBJECT
// changes: nose, body, tail, wings. A stripe is what a toy has; a change of
// part is what a machine has.
//
// Colour zones are LARGE and there are never more than three hues on one model.
//
// ONE CONSTRAINT STILL SHAPES ALL OF THEM: TtpRenderer::render whizz-rolls a
// rocket about its travel axis at 9 rad/s, so anything not rotationally
// symmetric WHIRLS. Fins at 90 or 120 degrees read as a still object because
// the eye cannot tell one blade from the next; a pair of wings or a stripe down
// one side reads as a propeller. Everything here is on the axis, three-fold or
// four-fold.
//
// Ship scale is 0.2 world units and it is only ever seen crossing the screen at
// speed, so VALUE is the other thing that matters: the body stays near-white on
// all three, because the thing it flies over is dark asphalt and a mid-grey
// missile disappears into it.

inline void buildRocketModel(const PartFn& part, int variant) {
    constexpr uint32_t SHELL = 0xeef1f5,   // cool near-white — the body, always
                       GREY = 0x9aa3b0,    // mid, for the second zone
                       GRAPHITE = 0x3d4453;// dark, for tails and blades
    constexpr uint32_t RED = 0xe6492d, CREAM = 0xfff3e0, DARK = 0x37414f;
    // Nose is local +Y; the renderer lays that along the direction of travel.
    if (variant <= 0) {
        // v0 — the original toy rocket, kept as the thing to argue against and
        // as the only place that red-and-cream survives.
        part(primCylinder(0.07f, 0.085f, 0.2f, 14), 0, 0, 0, RED, 1.0f);
        part(primCone(0.07f, 0.17f, 14), 0, 0.185f, 0, CREAM, 1.0f);
        for (int i = 0; i < 3; i++) {
            const float a = (float) i * (2.0f * (float) M_PI / 3);
            part(applyPre(primBox(0.012f, 0.085f, 0.07f), rotYm((float) M_PI / 2 - a)),
                    std::cos(a) * 0.085f, -0.055f, std::sin(a) * 0.085f, DARK, 1.0f);
        }
        return;
    }
    if (variant == 1) {
        // v1 "cruise" — THE PICK, and now in the game's own colours: a red
        // parallel body, a yellow OGIVE nose (a stretched sphere, so there is
        // no crease where a cone would meet the tube), a deep-red boat-tail and
        // THREE swept wings.
        //
        // Red and yellow rather than the grey it was drawn in, and the no-bands
        // rule is what keeps that from sliding back into the traffic cone every
        // earlier attempt turned into: these are four PARTS in two hues, not
        // stripes painted across one shape. The wings are yellow because they
        // are the thinnest thing on it and the first to be lost against a dark
        // deck; the nose is yellow because that is the end you want to read
        // when it is coming at you.
        constexpr uint32_t HULL = 0xe6492d, TRIM = 0xf2c14e, DEEP = 0xa8382a;
        part(primCylinder(0.078f, 0.078f, 0.240f, 12), 0, 0, 0, HULL, 1.0f);
        part(applyPre(primSphere(0.078f, 12, 8),
                    mat4f::scaling(float3{ 1.0f, 1.9f, 1.0f })), 0, 0.120f, 0, TRIM, 1.0f);
        part(primCylinder(0.078f, 0.056f, 0.055f, 18), 0, -0.1475f, 0, DEEP, 1.0f);
        // Kept SMALL: they sit on the back third of the body and reach about
        // half a body-radius past it, which is enough to read as wings without
        // becoming the widest thing about the object. Three at 120 degrees is
        // rotationally symmetric enough that the 9 rad/s roll reads as a still
        // object rather than a propeller.
        const Prim wing = primPlate({ { -0.052f, 0.068f }, { -0.164f, 0.068f },
                                      { -0.170f, 0.130f }, { -0.100f, 0.122f } }, 0.012f);
        for (int i = 0; i < 3; i++) {
            part(applyPre(wing, rotYm((float) i * (2.0f * (float) M_PI / 3))), 0, 0, 0,
                    TRIM, 1.0f);
        }
        return;
    }
    if (variant == 2) {
        // v2 "stealth" — the same class of object built out of FLAT PLANES
        // instead of curves: six-sided body and nose, so it catches the light in
        // facets rather than a smooth gradient, with three hard angular blades.
        // The difference from v1 is entirely geometric — same palette, same
        // proportions, no curve anywhere.
        part(primCylinder(0.072f, 0.090f, 0.235f, 6), 0, 0, 0, SHELL, 1.0f);
        part(primCone(0.072f, 0.175f, 6), 0, 0.205f, 0, GRAPHITE, 1.0f);
        part(primCylinder(0.090f, 0.066f, 0.050f, 6), 0, -0.1425f, 0, GREY, 1.0f);
        const Prim fin = primPlate({ { -0.030f, 0.076f }, { -0.150f, 0.086f },
                                     { -0.168f, 0.170f } }, 0.014f);
        for (int i = 0; i < 3; i++) {
            part(applyPre(fin, rotYm((float) i * (2.0f * (float) M_PI / 3))), 0, 0, 0,
                    GRAPHITE, 1.0f);
        }
        return;
    }
    // v3 "lance" — long and slender, and finned along its LENGTH rather than at
    // the tail: four narrow strakes running most of the body. That puts the
    // widest part of the outline in the middle instead of at one end, which is
    // the one proportion none of the eleven shapes before this had.
    part(primCylinder(0.060f, 0.070f, 0.300f, 16), 0, 0, 0, SHELL, 1.0f);
    part(primCone(0.060f, 0.175f, 16), 0, 0.2375f, 0, GRAPHITE, 1.0f);
    part(primCylinder(0.070f, 0.052f, 0.045f, 16), 0, -0.1725f, 0, GRAPHITE, 1.0f);
    const Prim strake = primPlate({ { 0.105f, 0.062f }, { -0.135f, 0.068f },
                                    { -0.135f, 0.101f }, { 0.088f, 0.079f } }, 0.010f);
    for (int i = 0; i < 4; i++) {
        part(applyPre(strake, rotYm((float) i * (float) M_PI / 2)), 0, 0, 0, GREY, 1.0f);
    }
}

// ---- garden gnome ---------------------------------------------------------
// Origin on the ground, facing +z. ~2.7 units tall at v0.
inline void buildGnomeModel(const PartFn& part, int variant) {
    constexpr uint32_t COAT = 0x3b6fb0, BOOT = 0x4a3a2e, SKIN = 0xf0c8a2,
                       NOSE = 0xe8a87e, HAIR = 0xf5f2ea, HAT = 0xd8463f,
                       GOLD = 0xf2c14e, INK = 0x2a2735, ROSY = 0xe89a86;
    if (variant <= 0) {
        // v0 — what shipped: cone, ball, beard, hat. No arms, no face.
        part(primCone(0.62f, 1.3f, 10), 0, 0.65f, 0, COAT, 1.0f);
        for (const int sd : { -1, 1 })
            part(primIcoDetail(0.13f, 1), sd * 0.24f, 0.09f, 0.14f, BOOT, 1.0f);
        part(primSphere(0.36f, 12, 9), 0, 1.42f, 0, SKIN, 1.0f);
        part(primIcoDetail(0.1f, 1), 0, 1.4f, 0.35f, NOSE, 1.0f);
        Prim beard = primIcoDetail(0.32f, 1);
        for (auto& v : beard.v) { v.y *= 1.2f; v.z *= 0.62f; }
        part(beard, 0, 1.12f, 0.18f, HAIR, 1.0f);
        part(applyPre(primCone(0.42f, 1.25f, 10), rotXm(-0.12f)), 0, 2.1f, -0.04f, HAT, 1.0f);
        return;
    }

    // Shared between v1 and v2: the body, the face and the beard. Only the hat
    // and what he is holding change.
    for (const int sd : { -1, 1 }) {
        part(primIcoDetail(0.155f, 1), sd * 0.25f, 0.11f, 0.13f, BOOT, 1.0f);
        part(primIcoDetail(0.095f, 1), sd * 0.25f, 0.075f, 0.29f, BOOT, 0.92f);
    }
    part(primCone(0.64f, 1.28f, 14), 0, 0.64f, 0, COAT, 1.0f);
    part(primTorusArc(0.375f, 0.072f, 8, 22, 2.0f * (float) M_PI), 0, 0.62f, 0, BOOT, 1.0f);
    part(primBox(0.17f, 0.15f, 0.07f), 0, 0.62f, 0.40f, GOLD, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(applyPre(primCylinder(0.085f, 0.105f, 0.44f, 9), rotZm(sd * 0.62f)),
                sd * 0.31f, 0.82f, 0.07f, COAT, 1.0f);
        part(primSphere(0.10f, 9, 7), sd * 0.50f, 0.63f, 0.13f, SKIN, 1.0f);
    }
    part(primSphere(0.36f, 14, 10), 0, 1.42f, 0, SKIN, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(primSphere(0.046f, 8, 6), sd * 0.135f, 1.505f, 0.305f, INK, 1.0f);
        part(primIcoDetail(0.078f, 1), sd * 0.225f, 1.40f, 0.255f, ROSY, 1.0f);
        part(primIcoDetail(0.10f, 1), sd * 0.125f, 1.305f, 0.305f, HAIR, 1.0f);
    }
    part(primIcoDetail(0.115f, 1), 0, 1.40f, 0.335f, NOSE, 1.0f);
    {
        Prim b1 = primIcoDetail(0.335f, 1);
        for (auto& v : b1.v) { v.y *= 1.15f; v.z *= 0.62f; }
        part(b1, 0, 1.14f, 0.18f, HAIR, 1.0f);
        Prim b2 = primIcoDetail(0.245f, 1);
        for (auto& v : b2.v) { v.y *= 1.20f; v.z *= 0.60f; }
        part(b2, 0, 0.88f, 0.215f, HAIR, 0.97f);
        part(primIcoDetail(0.15f, 1), 0, 0.70f, 0.235f, HAIR, 0.94f);
    }

    if (variant == 1) {
        // v1 "detailed" — the same gnome, finished: a brimmed hat that sits on
        // the head rather than balancing on it.
        part(primCylinder(0.50f, 0.545f, 0.09f, 16), 0, 1.66f, 0, HAT, 1.0f);
        part(applyPre(primCone(0.44f, 1.20f, 14), rotXm(-0.14f)), 0, 2.28f, -0.02f, HAT, 1.0f);
        part(primSphere(0.085f, 8, 6), 0, 2.874f, -0.104f, HAT, 0.95f);
        return;
    }

    // v2 "storybook" — v1 plus the two things that turn an ornament into a
    // character: a tall FLOPPY hat with a bend in it, and something in his hand.
    part(primCylinder(0.48f, 0.545f, 0.09f, 16), 0, 1.66f, 0, HAT, 1.0f);
    part(applyPre(primCylinder(0.30f, 0.46f, 0.78f, 14), rotXm(-0.10f)), 0, 2.09f, -0.02f, HAT, 1.0f);
    part(applyPre(primCone(0.31f, 0.95f, 12), rotXm(-0.62f)), 0, 2.62f, -0.30f, HAT, 0.97f);
    part(primSphere(0.095f, 8, 6), 0, 2.90f, -0.79f, HAIR, 1.0f);
    // The lantern, hung off the right hand on a wire hoop.
    part(applyPre(primTorusArc(0.10f, 0.018f, 6, 14, (float) M_PI), rotZm((float) M_PI / 2)),
            0.50f, 0.50f, 0.13f, INK, 1.0f);
    part(primBox(0.20f, 0.24f, 0.20f), 0.50f, 0.30f, 0.13f, GOLD, 1.0f);
    part(primBox(0.24f, 0.05f, 0.24f), 0.50f, 0.43f, 0.13f, INK, 1.0f);
    part(primBox(0.24f, 0.05f, 0.24f), 0.50f, 0.17f, 0.13f, INK, 1.0f);
    // A toadstool at his other foot — the thing every garden gnome is sold with.
    part(primCylinder(0.075f, 0.095f, 0.26f, 10), -0.62f, 0.13f, 0.32f, HAIR, 1.0f);
    part(applyPre(primSphere(0.21f, 12, 8), mat4f::scaling(float3{ 1.0f, 0.62f, 1.0f })),
            -0.62f, 0.27f, 0.32f, HAT, 1.0f);
    for (int i = 0; i < 4; i++) {
        const float a = (float) i * (float) M_PI / 2 + 0.4f;
        part(primSphere(0.035f, 6, 5), -0.62f + std::cos(a) * 0.11f, 0.375f,
                0.32f + std::sin(a) * 0.11f, HAIR, 1.0f);
    }
}

// ---- wind-up train --------------------------------------------------------
// Origin on the ground at the loco's centre, facing +z (the direction of
// travel). The winding key is a second mesh and gets its own builder.
inline void buildTrainModel(const PartFn& part, int variant) {
    constexpr uint32_t BODY = 0x3b6fb0, TRIM = 0xd8463f, GOLD = 0xf2c14e,
                       IRON = 0x2f2b38, GLASS = 0x2a3550, STEEL = 0x4a4653;
    const float PI2 = (float) M_PI / 2;
    if (variant <= 0) {
        // v0 — what shipped: seven boxes and a cylinder.
        part(primBox(1.0f, 0.36f, 2.4f), 0, 0.52f, 0, BODY, 1.0f);
        part(applyPre(primCylinder(0.44f, 0.44f, 1.45f, 12), rotXm(PI2)), 0, 1.02f, 0.45f, TRIM, 1.0f);
        part(primBox(1.05f, 0.95f, 0.85f), 0, 1.15f, -0.85f, BODY, 1.0f);
        part(primBox(1.15f, 0.16f, 1.0f), 0, 1.72f, -0.85f, TRIM, 1.0f);
        part(primCylinder(0.14f, 0.2f, 0.5f, 10), 0, 1.62f, 0.95f, GOLD, 1.0f);
        part(primSphere(0.18f, 10, 7), 0, 1.5f, 0.25f, GOLD, 1.0f);
        for (const int sd : { -1, 1 }) for (const float wz : { 0.65f, -0.65f }) {
            part(applyPre(primCylinder(0.3f, 0.3f, 0.14f, 12), rotZm(PI2)),
                    sd * 0.56f, 0.3f, wz, IRON, 1.0f);
        }
        return;
    }

    if (variant == 1) {
        // v1 "classic" — the same loco with the parts a loco actually has: a
        // smokebox and its door, boiler bands, a flared funnel, a lamp, glazed
        // cab windows, buffers, a cowcatcher and wheels with hubs and a rod.
        part(primBox(1.06f, 0.24f, 2.50f), 0, 0.40f, 0, IRON, 1.0f);
        part(primBox(1.22f, 0.09f, 2.42f), 0, 0.545f, 0, BODY, 1.0f);
        part(applyPre(primCylinder(0.44f, 0.46f, 1.52f, 18), rotXm(PI2)), 0, 1.02f, 0.40f, TRIM, 1.0f);
        for (const float bz : { 0.02f, 0.80f }) {
            part(applyPre(primCylinder(0.475f, 0.475f, 0.085f, 18), rotXm(PI2)),
                    0, 1.02f, bz, GOLD, 1.0f);
        }
        part(applyPre(primCylinder(0.455f, 0.455f, 0.24f, 18), rotXm(PI2)), 0, 1.02f, 1.24f, IRON, 1.0f);
        part(applyPre(primCylinder(0.325f, 0.325f, 0.07f, 16), rotXm(PI2)), 0, 1.02f, 1.375f, STEEL, 1.0f);
        part(primBox(0.075f, 0.56f, 0.04f), 0, 1.02f, 1.405f, GOLD, 1.0f);
        part(primBox(0.56f, 0.075f, 0.04f), 0, 1.02f, 1.405f, GOLD, 1.0f);
        part(primCylinder(0.155f, 0.135f, 0.46f, 14), 0, 1.55f, 0.92f, IRON, 1.0f);
        part(primCylinder(0.235f, 0.165f, 0.16f, 14), 0, 1.82f, 0.92f, IRON, 1.0f);
        part(primSphere(0.20f, 12, 9), 0, 1.44f, 0.26f, GOLD, 1.0f);
        part(primCylinder(0.05f, 0.05f, 0.16f, 8), 0, 1.60f, 0.26f, GOLD, 1.0f);
        part(primCylinder(0.045f, 0.045f, 0.22f, 8), 0.20f, 1.54f, -0.10f, GOLD, 1.0f);
        part(primBox(1.04f, 0.96f, 0.86f), 0, 1.16f, -0.86f, BODY, 1.0f);
        for (const int sd : { -1, 1 }) {
            part(primBox(0.045f, 0.44f, 0.46f), sd * 0.53f, 1.32f, -0.86f, GLASS, 1.0f);
        }
        part(primBox(0.42f, 0.38f, 0.05f), 0, 1.34f, -0.44f, GLASS, 1.0f);
        part(primBox(1.26f, 0.06f, 1.10f), 0, 1.655f, -0.86f, GOLD, 1.0f);
        part(primBox(1.20f, 0.11f, 1.04f), 0, 1.735f, -0.86f, TRIM, 1.0f);
        part(applyPre(primCylinder(0.13f, 0.13f, 0.17f, 12), rotXm(PI2)), 0, 1.44f, 1.44f, GOLD, 1.0f);
        part(applyPre(primCylinder(0.095f, 0.095f, 0.05f, 12), rotXm(PI2)), 0, 1.44f, 1.53f, 0xfff3e0, 1.0f);
        for (const int sd : { -1, 1 }) {
            part(applyPre(primCylinder(0.075f, 0.075f, 0.18f, 8), rotXm(PI2)),
                    sd * 0.38f, 0.50f, 1.47f, IRON, 1.0f);
        }
        // Cowcatcher: a raked plate each side of the centreline.
        for (const int sd : { -1, 1 }) {
            part(applyPre(primPlate({ { 0.30f, 0.0f }, { -0.24f, 0.0f },
                                      { -0.24f, 0.46f }, { 0.16f, 0.30f } }, 0.07f),
                        rotYm(sd * 0.42f)), sd * 0.20f, 0.36f, 1.32f, IRON, 1.0f);
        }
        for (const int sd : { -1, 1 }) {
            for (const float wz : { 0.62f, -0.62f }) {
                part(applyPre(primCylinder(0.34f, 0.34f, 0.13f, 16), rotZm(PI2)),
                        sd * 0.58f, 0.34f, wz, IRON, 1.0f);
                part(applyPre(primCylinder(0.20f, 0.20f, 0.15f, 12), rotZm(PI2)),
                        sd * 0.60f, 0.34f, wz, TRIM, 1.0f);
                part(applyPre(primCylinder(0.065f, 0.065f, 0.17f, 8), rotZm(PI2)),
                        sd * 0.62f, 0.34f, wz, GOLD, 1.0f);
            }
            part(applyPre(primCylinder(0.20f, 0.20f, 0.11f, 14), rotZm(PI2)),
                    sd * 0.56f, 0.22f, 1.16f, IRON, 1.0f);
            part(primBox(0.055f, 0.10f, 1.30f), sd * 0.68f, 0.50f, 0, STEEL, 1.0f);
        }
        return;
    }

    // v2 "chunky" — a different toy rather than a busier one: shorter, taller
    // and rounder, the way a wooden pull-along reads, with spoked wheels and a
    // funnel you can see from the far side of the track.
    part(primBox(1.16f, 0.28f, 2.10f), 0, 0.44f, 0, IRON, 1.0f);
    part(applyPre(primCylinder(0.56f, 0.58f, 1.30f, 20), rotXm(PI2)), 0, 1.10f, 0.30f, TRIM, 1.0f);
    part(applyPre(primCylinder(0.60f, 0.60f, 0.13f, 20), rotXm(PI2)), 0, 1.10f, 0.92f, GOLD, 1.0f);
    part(applyPre(primSphere(0.575f, 14, 10), mat4f::scaling(float3{ 1, 1, 0.55f })),
            0, 1.10f, 1.00f, TRIM, 1.0f);
    part(applyPre(primCylinder(0.30f, 0.30f, 0.08f, 16), rotXm(PI2)), 0, 1.10f, 1.30f, GOLD, 1.0f);
    part(primCylinder(0.20f, 0.17f, 0.52f, 16), 0, 1.72f, 0.72f, IRON, 1.0f);
    part(primCylinder(0.34f, 0.21f, 0.22f, 16), 0, 2.06f, 0.72f, IRON, 1.0f);
    part(primSphere(0.26f, 14, 10), 0, 1.62f, 0.10f, GOLD, 1.0f);
    part(applyPre(primSphere(0.62f, 14, 10), mat4f::scaling(float3{ 1, 1, 0.86f })),
            0, 1.26f, -0.76f, BODY, 1.0f);
    part(primBox(1.24f, 1.02f, 0.92f), 0, 1.16f, -0.76f, BODY, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(primBox(0.05f, 0.46f, 0.50f), sd * 0.62f, 1.34f, -0.76f, GLASS, 1.0f);
    }
    part(primBox(1.36f, 0.13f, 1.06f), 0, 1.79f, -0.76f, GOLD, 1.0f);
    part(primSphere(0.13f, 10, 8), 0, 1.90f, -0.76f, TRIM, 1.0f);
    // The bell, on a yoke over the boiler.
    part(primCylinder(0.055f, 0.13f, 0.17f, 10), 0, 1.62f, 0.46f, GOLD, 1.0f);
    // Chunky spoked wheels: a tyre, a hub and six spokes turned about the axle.
    for (const int sd : { -1, 1 }) {
        for (const float wz : { 0.58f, -0.58f }) {
            part(applyPre(primCylinder(0.42f, 0.42f, 0.16f, 18), rotZm(PI2)),
                    sd * 0.62f, 0.42f, wz, IRON, 1.0f);
            part(applyPre(primCylinder(0.35f, 0.35f, 0.17f, 18), rotZm(PI2)),
                    sd * 0.635f, 0.42f, wz, GOLD, 1.0f);
            for (int k = 0; k < 6; k++) {
                part(applyPre(primBox(0.19f, 0.62f, 0.10f),
                            rotXm((float) k * (float) M_PI / 6)),
                        sd * 0.645f, 0.42f, wz, TRIM, 1.0f);
            }
            part(applyPre(primCylinder(0.10f, 0.10f, 0.19f, 10), rotZm(PI2)),
                    sd * 0.65f, 0.42f, wz, IRON, 1.0f);
        }
    }
}

// The winding key. v0 is what shipped; the others give it a shaft collar and a
// proper bow, since on the bench it is the part nearest the viewer.
inline void buildTrainKeyModel(const PartFn& part, int variant) {
    constexpr uint32_t GOLD = 0xf2c14e, IRON = 0x2f2b38;
    if (variant <= 0) {
        part(applyPre(primCylinder(0.07f, 0.07f, 0.5f, 8),
                    mat4f::translation(float3{ 0, 0.25f, 0 })), 0, 0, 0, GOLD, 1.0f);
        for (const int sd : { -1, 1 })
            part(primBox(0.5f, 0.3f, 0.09f), sd * 0.28f, 0.62f, 0, GOLD, 0.95f);
        return;
    }
    part(applyPre(primCylinder(0.075f, 0.075f, 0.52f, 10),
                mat4f::translation(float3{ 0, 0.26f, 0 })), 0, 0, 0, GOLD, 1.0f);
    part(primCylinder(0.13f, 0.13f, 0.07f, 12), 0, 0.10f, 0, IRON, 1.0f);
    part(primCylinder(0.11f, 0.11f, 0.06f, 12), 0, 0.55f, 0, IRON, 1.0f);
    for (const int sd : { -1, 1 }) {
        part(applyPre(primTorusArc(0.20f, 0.055f, 8, 16, (float) M_PI),
                    rotZm(sd > 0 ? 0.0f : (float) M_PI) * rotXm((float) M_PI / 2)),
                sd * 0.20f, 0.70f, 0, GOLD, 1.0f);
        part(primBox(0.34f, 0.10f, 0.075f), sd * 0.17f, 0.70f, 0, GOLD, 0.95f);
    }
}

// ---- starfish -------------------------------------------------------------
// Beach clutter. Origin on the ground at the hub's centre, unit scale — the
// clutter site applies its own random yaw and 0.8..1.3 size, the bench its
// presentation scale. The tint comes from the theme's clutter entry, so unlike
// the builders above the hue is an argument, not a constexpr.
inline void buildStarfishModel(const PartFn& part, int variant, uint32_t hex) {
    // NOT "PI2": buildTrainModel's PI2 is a quarter turn, and these builders
    // get copy-pasted between.
    const float TAU = 2.0f * (float) M_PI;
    if (variant <= 0) {
        // v0 — what shipped: a pentagon hub and five squashed cone spikes.
        part(primCylinder(0.11f, 0.13f, 0.09f, 5), 0, 0.045f, 0, hex, 1.0f);
        for (int k = 0; k < 5; k++) {
            part(applyPre(primCone(0.1f, 0.44f, 5),
                        rotYm(((float) k / 5) * TAU)
                                * mat4f::translation(float3{ 0, 0.045f, 0.28f })
                                * mat4f::scaling(float3{ 1, 0.45f, 1 })
                                * rotXm((float) M_PI / 2)),
                    0, 0, 0, hex, 0.94f + (k % 2) * 0.08f);
        }
        return;
    }
    if (variant == 1) {
        // v1 "plump" — the soft-toy read: a domed centre and five fat rounded
        // arms, ellipsoids overlapping the dome so there is no gap at the hub,
        // each tipped a touch nose-up like a cushion's corner.
        part(applyPre(primSphere(0.20f, 12, 8), mat4f::scaling(float3{ 1, 0.55f, 1 })),
                0, 0.10f, 0, hex, 1.06f);
        for (int k = 0; k < 5; k++) {
            part(applyPre(primSphere(0.16f, 10, 7),
                        rotYm(((float) k / 5) * TAU)
                                * mat4f::translation(float3{ 0, 0.095f, 0.30f })
                                * rotXm(-0.15f)
                                * mat4f::scaling(float3{ 0.72f, 0.42f, 1.75f })),
                    0, 0, 0, hex, 1.0f);
        }
        return;
    }
    if (variant == 2) {
        // v2 "sea star" — the real animal resting: arms taper from a wide root
        // and curl up at the tip, with a row of lighter freckle bumps down each
        // arm's back. The most parts on the row.
        part(applyPre(primSphere(0.19f, 12, 8), mat4f::scaling(float3{ 1, 0.5f, 1 })),
                0, 0.085f, 0, hex, 1.04f);
        for (int k = 0; k < 5; k++) {
            const mat4f armF = rotYm(((float) k / 5) * TAU);
            // The arm: a frustum lying along z, squashed flat, bowed up so the
            // tip leaves the sand.
            part(applyPre(primCylinder(0.035f, 0.13f, 0.52f, 7),
                        armF * mat4f::translation(float3{ 0, 0.09f, 0.30f })
                                * rotXm((float) M_PI / 2 - 0.22f)
                                * mat4f::scaling(float3{ 1, 1, 0.5f })),
                    0, 0, 0, hex, 0.98f + (k % 2) * 0.04f);
            // The upturned tip.
            part(applyPre(primSphere(0.048f, 8, 6),
                        armF * mat4f::translation(float3{ 0, 0.155f, 0.545f })),
                    0, 0, 0, hex, 1.02f);
            // Freckles along the back.
            for (int b = 0; b < 2; b++) {
                part(applyPre(primSphere(0.026f, 6, 5),
                            armF * mat4f::translation(
                                    float3{ 0, 0.115f + b * 0.012f, 0.17f + b * 0.15f })),
                        0, 0, 0, hex, 1.18f);
            }
        }
        return;
    }
    if (variant == 4) {
        // v4 "smooth" — the pick: the original's five-arm silhouette with the
        // hub removed, blunt tips, and the whole thing a flat low slab on the
        // sand. ONE soup prim on purpose: five overlapping frustum arms were
        // tried first and their coincident top surfaces creased the centre —
        // a single extruded outline has no surface to fight.
        Prim p;
        constexpr int ARMS = 5, PTS = ARMS * 4; // 3-point blunt tip + 1 valley
        constexpr float H = 0.06f, INSET = 0.9f;
        float ox[PTS], oz[PTS];
        for (int k = 0; k < ARMS; k++) {
            const float a = (float) k / ARMS * TAU;
            const float ta[4] = { a - 0.14f, a, a + 0.14f, a + (float) M_PI / ARMS };
            const float tr[4] = { 0.43f, 0.47f, 0.43f, 0.18f };
            for (int j = 0; j < 4; j++) {
                ox[k * 4 + j] = std::cos(ta[j]) * tr[j];
                oz[k * 4 + j] = std::sin(ta[j]) * tr[j];
            }
        }
        // Wall vertex pairs, wrap-duplicated like primCylinder's — same axis
        // convention and winding, so the two can be compared line for line.
        for (int j = 0; j <= PTS; j++) {
            const int i = j % PTS;
            p.v.push_back({ ox[i], 0, oz[i] });
            p.v.push_back({ ox[i] * INSET, H, oz[i] * INSET });
        }
        for (int j = 0; j < PTS; j++) {
            const uint32_t a = j * 2, b = a + 1, c2 = a + 2, d = a + 3;
            p.i.insert(p.i.end(), { a, c2, b, b, c2, d });
        }
        // Flat top: its own rim verts so the edge stays crisp, fanned from the
        // centroid at the same height — no peak, per the pick.
        const uint32_t capBase = (uint32_t) p.v.size();
        for (int j = 0; j <= PTS; j++) {
            const int i = j % PTS;
            p.v.push_back({ ox[i] * INSET, H, oz[i] * INSET });
        }
        const uint32_t mid = (uint32_t) p.v.size();
        p.v.push_back({ 0, H, 0 });
        for (int j = 0; j < PTS; j++)
            p.i.insert(p.i.end(), { mid, capBase + (uint32_t) j + 1, capBase + (uint32_t) j });
        part(p, 0, 0, 0, hex, 1.0f);
        return;
    }
    // v3 "die-cut" — the Sticker Bash read: one chunky five-point star, a flat
    // extrusion whose top ring pulls in and rises to a low peak, so it shades
    // like a puffy sticker. A lighter centre dot echoes the animal's disc.
    {
        Prim p;
        constexpr int N = 10; // outer/inner points, alternating
        constexpr float RO = 0.5f, RI = 0.235f, H = 0.12f, INSET = 0.76f, APEX = 0.17f;
        // Wall vertex pairs (bottom, top), wrap-duplicated like primCylinder so
        // the top edge stays crisp against its own cap.
        for (int j = 0; j <= N; j++) {
            const float a = (float) (j % N) / N * TAU;
            const float r = (j % 2 == 0) ? RO : RI;
            p.v.push_back({ std::cos(a) * r, 0, std::sin(a) * r });
            p.v.push_back({ std::cos(a) * r * INSET, H, std::sin(a) * r * INSET });
        }
        for (int j = 0; j < N; j++) {
            const uint32_t a = j * 2, b = a + 1, c2 = a + 2, d = a + 3;
            p.i.insert(p.i.end(), { a, c2, b, b, c2, d });
        }
        const uint32_t capBase = (uint32_t) p.v.size();
        for (int j = 0; j <= N; j++) {
            const float a = (float) (j % N) / N * TAU;
            const float r = ((j % 2 == 0) ? RO : RI) * INSET;
            p.v.push_back({ std::cos(a) * r, H, std::sin(a) * r });
        }
        const uint32_t apex = (uint32_t) p.v.size();
        p.v.push_back({ 0, APEX, 0 });
        for (int j = 0; j < N; j++)
            p.i.insert(p.i.end(), { apex, capBase + (uint32_t) j + 1, capBase + (uint32_t) j });
        part(p, 0, 0, 0, hex, 1.0f);
    }
    part(applyPre(primSphere(0.085f, 10, 7), mat4f::scaling(float3{ 1, 0.5f, 1 })),
            0, 0.165f, 0, hex, 1.14f);
}
