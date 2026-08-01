// Centerline — a closed polyline
// of oriented frames (pos, tangent, up, lateral) with cumulative arclength,
// interpolated with a non-uniform Catmull-Rom spline. Every method mirrors the
// JS operation order exactly; the scratch-buffer reuse is an allocation
// optimization only (results identical), but the Newton loop's step/clamp/break
// ORDER and the `|| 1e-6` falsy-guards on segment spans DO change results and
// are transliterated faithfully. See docs/native-port/fp-profile.md.
#pragma once

#include <cstddef>
#include <limits>
#include <vector>

#include "ttp/vec3.h"

namespace ttp {

struct Frame {
  Vec3 pos, tangent, up, lateral;
  double width = 0.0;
};

struct Sample {
  Vec3 pos, tangent, up, lateral;
  double width = 0.0;
  double s = 0.0;
};

struct ProjectResult {
  double s;
  double lat;
  Frame frame;
};

class Centerline {
 public:
  Centerline(std::vector<Sample> samples, double length);

  // Interpolated frame at arclength s (a fresh frame the caller owns).
  Frame sampleAt(double s);

  // Project a world point onto the centreline near arclength sHint. Returns the
  // foot's accumulated (NOT wrapped) arclength, the signed lateral offset, and
  // the frame there.
  ProjectResult projectNear(const Vec3& point, double sHint,
                            double maxStep = std::numeric_limits<double>::infinity());

  // Drivable width at arclength s (reads through the pooled probe frame).
  double widthAt(double s);

  const std::vector<Sample>& samples() const { return samples_; }
  double length() const { return length_; }

 private:
  int seg(double s) const;                 // Centerline.js _seg
  Frame& sampleInto(double s, Frame& out); // Centerline.js _sampleInto

  std::vector<Sample> samples_;
  double length_;

  // Where seg() landed last time. A HINT, never an answer: seg validates it and
  // falls back to the full binary search, so the value it returns does not
  // depend on it and a stale or wrong hint costs a branch, not a bug. That is
  // what makes it safe to carry across calls and across races — and it is why it
  // may be `mutable` under a const seg(). See seg() for why it pays.
  mutable int lastSeg_ = 0;

  // Reusable scratch, exactly as the JS module pools it.
  Vec3 mB_, mC_, d_;
  Frame scratch_;
};

}  // namespace ttp
