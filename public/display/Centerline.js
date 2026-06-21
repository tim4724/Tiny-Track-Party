// Centerline — a closed polyline of oriented frames (pos, tangent, up, lateral)
// with cumulative arclength, interpolated with a non-uniform Catmull-Rom spline.
// Constructed by TrackBuilder from the welded + smoothed world points; importable
// standalone for tests or tools that don't need the full track-building pipeline.

// A drivable centerline: closed polyline of frames (pos, tangent, up, lateral)
// with cumulative arclength. sampleAt(s) interpolates, wrapping at the lap line.
//
// Position is interpolated with a CATMULL-ROM spline (not linearly): the raw
// polyline is an inscribed polygon, so linear interp makes the car travel in
// straight chords that kink at every vertex — its heading rotates smoothly but
// its path direction jumps ~1° at each sample, an ~10 Hz shimmy through curves.
// The spline gives a C1-smooth path, and we return its OWN derivative as the
// tangent so the car's facing and its direction of travel agree by construction.
//
// Allocation: the per-frame physics calls sampleAt/projectNear several times per
// car, so the math runs through scratch buffers (this._m*, this._d, this._scratch)
// rather than minting throwaway Vector3s. sampleAt still returns a FRESH frame the
// caller owns; only the transient internals are pooled. projectNear's Newton loop —
// historically the hottest allocator (up to 9 sampleAt calls per car per frame) —
// reuses one scratch frame for every probe and allocates only the frame it returns.
// Scratch vectors are cloned off a real sample position so this module stays free
// of a direct three import (TrackBuilder owns the only Vector3 constructor).
export class Centerline {
  constructor(samples, length) {
    this.samples = samples;     // [{pos, tangent, up, lateral, width, s}]
    this.length = length;
    // Reusable scratch — cloned off an existing Vector3 so we need no three import.
    if (samples && samples.length) {
      const v = () => samples[0].pos.clone();
      this._mB = v(); this._mC = v(); // Catmull-Rom finite-difference tangents
      this._d = v();                  // (point − frame) difference for dot products
      this._scratch = this._frame();  // one persistent frame for projectNear's loop
    }
  }

  // A fresh frame object with its own Vector3s. The shape sampleAt returns.
  _frame() {
    const v = () => this.samples[0].pos.clone();
    return { pos: v(), tangent: v(), up: v(), lateral: v(), width: 0 };
  }

  // Largest index i with samples[i].s <= s (capped at n−1, the wrap segment).
  // Binary search over the monotonic cumulative arclengths — same result the old
  // linear scan produced, but log(n) instead of O(n) per sample.
  _seg(s) {
    const a = this.samples;
    let lo = 0, hi = a.length - 1, i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].s <= s) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return i;
  }

  // Interpolate the frame at arclength s INTO the caller-owned `out` (whose pos,
  // tangent, up, lateral are existing Vector3s we overwrite). Returns `out`.
  _sampleInto(s, out) {
    const len = this.length;
    s = ((s % len) + len) % len;
    const a = this.samples, n = a.length;
    const i = this._seg(s);

    // Four-point stencil around the segment [i, i+1], wrapping the closed loop.
    // Arclengths are unwrapped relative to the segment start so they stay
    // monotonic across the start/finish seam.
    const idx = (k) => ((k % n) + n) % n;
    const pA = a[idx(i - 1)], pB = a[i], pC = a[idx(i + 1)], pD = a[idx(i + 2)];
    const sB = pB.s;
    let sA = pA.s, sC = pC.s, sD = pD.s;
    while (sA > sB) sA -= len;
    while (sC < sB) sC += len;
    while (sD < sC) sD += len;

    const h = (sC - sB) || 1e-6;
    const u = (s - sB) / h, u2 = u * u, u3 = u2 * u;
    // Non-uniform Catmull-Rom = cubic Hermite with finite-difference tangents
    // (per unit arclength) at the two knots; tangents scaled by the segment span.
    const mB = this._mB.copy(pC.pos).sub(pA.pos).multiplyScalar(h / ((sC - sA) || 1e-6));
    const mC = this._mC.copy(pD.pos).sub(pB.pos).multiplyScalar(h / ((sD - sB) || 1e-6));
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out.pos.copy(pB.pos).multiplyScalar(h00)
      .addScaledVector(mB, h10).addScaledVector(pC.pos, h01).addScaledVector(mC, h11);
    // Derivative of the same curve → tangent (motion direction == facing).
    const g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1;
    const g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
    out.tangent.copy(pB.pos).multiplyScalar(g00)
      .addScaledVector(mB, g10).addScaledVector(pC.pos, g01).addScaledVector(mC, g11).normalize();

    const f = u;
    out.up.copy(pB.up).lerp(pC.up, f).normalize();
    out.lateral.copy(out.tangent).cross(out.up).normalize();
    out.width = (pB.width != null) ? pB.width + (pC.width - pB.width) * f : undefined;
    return out;
  }

  sampleAt(s) {
    return this._sampleInto(s, this._frame());
  }

  // Project a world POINT onto the centreline near a known arclength `sHint`, returning
  // the foot's arclength `s`, the signed lateral offset, and the frame there. Used by the
  // physics to integrate a car in WORLD space and read its road coordinates back (so a
  // neutral car traces a dead-straight world line — integrating in curvilinear (s,lat)
  // instead bows it through a curvature reversal). A car moves little per frame, so Newton
  // from sHint converges in a couple of steps: minimise |P−C(s)|², i.e. drive the along-
  // tangent error g(s)=(P−C(s))·T(s) to 0. The step uses the fixed approximation g'=−1;
  // the true g'=−1+curvature·lat, so it converges when curvature < 1/|lat| — easily met by
  // the shipped tracks (R_min≈5.9, lat_max≈1.8 → g'≈−0.7, ~0.45×/step). A future track with
  // R<2 at full width would converge slowly; raise the loop cap if you add one. `s` stays
  // near sHint (accumulated, NOT wrapped) so lap counters keep growing across the seam.
  //
  // `maxStep` HARD-bounds |s − sHint| so the search can only ever land on the LOCAL strand.
  // Where two strands cross in world space (a figure-8 bridge) they are ~half a lap apart
  // in arclength, so a window of a couple of units makes a wrong-strand snap impossible by
  // construction — not merely unlikely. Pass the physical per-frame reach (≈ v·dt + margin).
  projectNear(point, sHint, maxStep = Infinity) {
    const lo = sHint - maxStep, hi = sHint + maxStep;
    let s = sHint;
    for (let i = 0; i < 8; i++) { // 8 gives headroom over the ~0.45×/step convergence; most calls early-break
      const f = this._sampleInto(s, this._scratch); // pooled probe — never escapes
      const along = this._d.copy(point).sub(f.pos).dot(f.tangent);
      s += along;
      if (s < lo) s = lo; else if (s > hi) s = hi; // clamp every step: never leave the local strand
      if (Math.abs(along) < 1e-6) break;
    }
    const frame = this.sampleAt(s); // fresh frame the caller owns
    return { s, lat: this._d.copy(point).sub(frame.pos).dot(frame.lateral), frame };
  }

  // Drivable width at arclength s (world units). Convenience over sampleAt for callers
  // that only need the width (the renderer's per-ring sweep, the physics curb clamp).
  // Reads through the pooled probe frame — the number escapes, the frame doesn't.
  widthAt(s) { return this._sampleInto(s, this._scratch).width; }
}
