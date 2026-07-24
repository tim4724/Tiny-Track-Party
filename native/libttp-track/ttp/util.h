// Shared sim utilities — the C++ twin of public/display/engine/util.js.
// Dependency-free (mirrors the JS module's "no THREE, no DOM" contract).
#pragma once

#include <cstdint>

namespace ttp {

// Tiny seeded PRNG (mulberry32). The engine's item rolls and each AI bot's
// wander draw from their OWN instance (separate streams). Exact uint32 recipe
// from fp-profile §3.7 — uint32 multiply wraps identically to Math.imul, and
// unsigned >> is the logical >>>.
struct Mulberry32 {
  uint32_t a;
  explicit Mulberry32(uint32_t seed) : a(seed ? seed : 1u) {}  // (seed>>>0)||1

  double next() {                                   // → [0,1), like the JS closure
    a += 0x6D2B79F5u;                               // (a + k)|0
    uint32_t t = a;
    t = imul(t ^ (t >> 15), 1u | a);
    t = (t + imul(t ^ (t >> 7), 61u | t)) ^ t;
    return (double)(t ^ (t >> 14)) / 4294967296.0;  // ((t^(t>>>14))>>>0)/2^32
  }

  static uint32_t imul(uint32_t x, uint32_t y) { return x * y; }  // wraps == Math.imul
};

// Wrap a signed arclength gap to the shortest way round a closed lap of length
// `len`. util.js:20 uses Math.round → js_round (negative ties live here, the
// per-frame byte path). fp-profile §3.1.
double wrap_delta(double ds, double len);

// Wrap an arclength to [0, len). Double std::fmod idiom ((s % len) + len) % len,
// matching util.js:28 / Centerline.js:60. fp-profile §3.2.
double wrap_s(double s, double len);

}  // namespace ttp
