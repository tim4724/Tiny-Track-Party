#include "ttp/centerline.h"

#include <cmath>

namespace ttp {

// (x) || 1e-6 : JS logical-OR falls through to 1e-6 when x is falsy, i.e. +0 OR
// -0 (and NaN, which never occurs on the sim path). `d != 0.0` is false for both
// signed zeros, so it reproduces the guard. Centerline.js:75,79,80.
static inline double or_eps(double d) { return d != 0.0 ? d : 1e-6; }

Centerline::Centerline(std::vector<Sample> samples, double length)
    : samples_(std::move(samples)), length_(length) {
  // Scratch frames start as copies of an existing sample position, matching the
  // JS `samples[0].pos.clone()` seed; every field is fully overwritten per call,
  // so the seed value is inconsequential.
}

// Largest index i with samples[i].s <= s (capped at n-1, the wrap segment).
// Binary search; midpoint via int >> 1 (operands small non-negative).
int Centerline::seg(double s) const {
  const auto& a = samples_;
  int lo = 0, hi = (int)a.size() - 1, i = 0;
  while (lo <= hi) {
    int mid = (lo + hi) >> 1;
    if (a[mid].s <= s) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return i;
}

Frame& Centerline::sampleInto(double s, Frame& out) {
  double len = length_;
  s = std::fmod(std::fmod(s, len) + len, len);   // ((s % len) + len) % len
  const auto& a = samples_;
  int n = (int)a.size();
  int i = seg(s);

  // Four-point stencil around [i, i+1], wrapping the closed loop. Index wrap is
  // INT math ((k % n) + n) % n (fp-profile §3.2).
  auto idx = [n](int k) { return ((k % n) + n) % n; };
  const Sample& pA = a[idx(i - 1)];
  const Sample& pB = a[i];
  const Sample& pC = a[idx(i + 1)];
  const Sample& pD = a[idx(i + 2)];
  double sB = pB.s;
  double sA = pA.s, sC = pC.s, sD = pD.s;
  while (sA > sB) sA -= len;
  while (sC < sB) sC += len;
  while (sD < sC) sD += len;

  double h = or_eps(sC - sB);
  double u = (s - sB) / h, u2 = u * u, u3 = u2 * u;
  // Non-uniform Catmull-Rom = cubic Hermite with finite-difference tangents.
  Vec3& mB = mB_.copy(pC.pos).sub(pA.pos).multiplyScalar(h / or_eps(sC - sA));
  Vec3& mC = mC_.copy(pD.pos).sub(pB.pos).multiplyScalar(h / or_eps(sD - sB));
  double h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
  double h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  out.pos.copy(pB.pos).multiplyScalar(h00)
      .addScaledVector(mB, h10).addScaledVector(pC.pos, h01).addScaledVector(mC, h11);
  // Derivative of the same curve → tangent (motion direction == facing).
  double g00 = 6 * u2 - 6 * u, g10 = 3 * u2 - 4 * u + 1;
  double g01 = -6 * u2 + 6 * u, g11 = 3 * u2 - 2 * u;
  out.tangent.copy(pB.pos).multiplyScalar(g00)
      .addScaledVector(mB, g10).addScaledVector(pC.pos, g01).addScaledVector(mC, g11).normalize();

  double f = u;
  out.up.copy(pB.up).lerp(pC.up, f).normalize();
  out.lateral.copy(out.tangent).cross(out.up).normalize();
  // Tracks always carry widths (pB.width != null in JS), so no undefined branch.
  out.width = pB.width + (pC.width - pB.width) * f;
  return out;
}

Frame Centerline::sampleAt(double s) {
  Frame out;
  sampleInto(s, out);
  return out;
}

ProjectResult Centerline::projectNear(const Vec3& point, double sHint, double maxStep) {
  double lo = sHint - maxStep, hi = sHint + maxStep;
  double s = sHint;
  for (int i = 0; i < 8; i++) {
    Frame& f = sampleInto(s, scratch_);            // pooled probe — never escapes
    double along = d_.copy(point).sub(f.pos).dot(f.tangent);
    s += along;
    if (s < lo) s = lo; else if (s > hi) s = hi;   // clamp every step
    if (std::fabs(along) < 1e-6) break;
  }
  Frame frame = sampleAt(s);                        // fresh frame the caller owns
  double lat = d_.copy(point).sub(frame.pos).dot(frame.lateral);
  return {s, lat, frame};
}

double Centerline::widthAt(double s) {
  return sampleInto(s, scratch_).width;
}

}  // namespace ttp
