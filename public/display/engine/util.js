// Shared engine utilities — dependency-free (no THREE, no DOM) so everything
// that loads in both the browser and the Node tests can import it.

// Tiny seeded PRNG (mulberry32). The engine's item rolls and each AI bot's
// wander draw from their OWN instance (separate streams) so a race is fully
// reproducible from its seed under a fixed dt — never the JS global RNG.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wrap a signed arclength gap to the shortest way round a closed lap of length
// `len`. Every (s, lat)-plane proximity test — oil/pad/box/banana triggers and
// the AI's hazard scan — measures its along-track distance through this.
export function wrapDelta(ds, len) {
  return ds - Math.round(ds / len) * len;
}

// Wrap an arclength (an absolute position or a signed gap) to [0, len) — the
// forward-going complement of wrapDelta. A negative input (a car behind, a
// cumulative s before the seam) comes back as the distance the long way round,
// which is what the rocket's "physically ahead" queries want.
export function wrapS(s, len) {
  return ((s % len) + len) % len;
}
