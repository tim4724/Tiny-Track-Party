#include "ttp/trackbuilder.h"

#include <cmath>
#include <limits>
#include <utility>
#include <vector>

#include "ttp/centerline.h"
#include "ttp/contract.h"
#include "ttp/jsmath.h"
#include "ttp/vec3.h"
#include "ttp_fd.h"

namespace ttp {
namespace {

// TrackBuilder.js constants (unscaled units unless noted).
constexpr double SCALE = 2.0;
constexpr double ROAD_WIDTH = 2.5;       // default drivable width (fallback)
constexpr double DS = 0.25;              // centreline sample step
constexpr double PI = 3.141592653589793; // Math.PI (0x400921fb54442d18)
constexpr double DEG = PI / 180.0;
constexpr double BANK_RAMP = 0.35;
// The sand strip narrows on the INSIDE of a corner too tight to carry it: that
// side's far edge, sand included, keeps |k| * (half-width + sand) under
// SAND_FOLD_MAX, and the strip eases in and out over SAND_EASE world units
// either side. The outside of a corner never folds, so it keeps the full strip.
// A first estimate without the kerb: narrowFolds then measures the drawn
// ribbon, kerb included, and takes off what still folds.
constexpr double SAND_FOLD_MAX = 0.85;
constexpr double SAND_EASE = 6.0;
// The strip lies only on road that lies on the land: a deck whose up leans
// further than this (a loop, a wall ride, a steep bank) carries none.
constexpr double ON_GROUND_UP = 0.9;
constexpr double GROUND_RUN_MIN = 4 * SAND_EASE;
constexpr double SYM_REACH = 3 * SAND_EASE;   // to a loop: past the ease's reach (erosion + tent), and its pad's length
// Two strands of one road side by side (sandWidths): STRAND_GAP is what stays
// between their strips (both kerbs and a little land), and a strand is
// another one STRAND_ARC of lap away, at most STRAND_LEVEL above or below.
constexpr double STRAND_GAP = 1.5, STRAND_ARC = 20.0, STRAND_LEVEL = 1.0;
// narrowFolds: the step it walks the ribbon at, how far under a limit it
// narrows a strip back to (so the next pass finds it clear), and how many
// passes it may take.
constexpr double FOLD_STEP = 0.1, FOLD_SPARE = 0.03;
constexpr int FOLD_PASSES = 8;
const double kInf = std::numeric_limits<double>::infinity();

// SMOOTHERSTEP (Perlin, C2 ends) and smoothstep (C1 ends) — the exact JS forms.
inline double smootherstep(double t) { return t * t * t * (t * (t * 6 - 15) + 10); }
inline double smoothstep(double t) { return t * t * (3 - 2 * t); }
inline double bankWindow(double f) {
  return f < BANK_RAMP ? smootherstep(f / BANK_RAMP)
       : f > 1 - BANK_RAMP ? smootherstep((1 - f) / BANK_RAMP) : 1.0;
}

// Plan-frame basis at heading th (dmath sin/cos → vendored fdlibm).
inline double dirX(double th) { return -ttp_fd_sin(th); }
inline double dirZ(double th) { return ttp_fd_cos(th); }
inline double latX(double th) { return -ttp_fd_cos(th); }
inline double latZ(double th) { return -ttp_fd_sin(th); }

// Support-post probe: relation of a post (x,z,radius,baseY,topY) to one sample.
// Post/PostHit and the entry point are declared in trackbuilder.h — the geometry
// audit measures with this exact function rather than a copy of it.
PostHit postAtSample(const OutSample& sm, const Post& post) {
  if (sm.up.y < 0.9) return {false, 0, 0, 0};
  if (sm.pos.y < post.baseY - 0.5 || sm.pos.y > post.topY - 0.5) return {false, 0, 0, 0};
  double dx = post.x - sm.pos.x, dz = post.z - sm.pos.z;
  double tl = ttp_fd_hypot(sm.tangent.x, sm.tangent.z);
  if (tl == 0.0) tl = 1.0;                                   // dmath.hypot(...) || 1
  double tan = (dx * sm.tangent.x + dz * sm.tangent.z) / tl;
  if (std::fabs(tan) > post.radius + 0.35) return {false, 0, 0, 0};
  double ll = ttp_fd_hypot(sm.lateral.x, sm.lateral.z);
  if (ll == 0.0) ll = 1.0;
  double lat = (dx * sm.lateral.x + dz * sm.lateral.z) / ll;
  return {true, lat, tan, sm.width / 2 + post.radius - std::fabs(lat)};
}

double intrusionOf(const Post& post, const std::vector<OutSample>& samples) {
  double worst = -kInf;
  for (const auto& s : samples) {
    PostHit hit = postAtSample(s, post);
    if (hit.valid) worst = js_max(worst, hit.intrusion);
  }
  return worst;
}

// ---- Shared finalize: frames, pillars, hills, support posts, autoPoles, the
// startU relabel. Fed by both the segment walk and the waypoint sampler.
// The sand strip, per sample and per side (0 left, 1 right: -lateral and
// +lateral), between the asphalt and the kerb: `full` wherever the road allows
// it, narrowed (SAND_FOLD_MAX) on the inside of a corner too tight to carry it,
// and none on raised road (a bridge, a deck on pillars), where the kerbs stand
// at the asphalt's edge. The allowance is ERODED over SAND_EASE then averaged
// over as much (below): each averaged value is at most the allowance at its own
// sample, so the ease never reaches into the corner or onto the bridge it eases
// toward.
// All zero for a track without sand.
struct SandSides { std::vector<double> at[2]; };

SandSides sandWidths(const std::vector<Vec3>& worldPts, const std::vector<Vec3>& tangents,
                     const std::vector<double>& widths, const std::vector<char>& raised,
                     const std::vector<char>& loops, double full, const SpanDef* off, int nOff,
                     const std::vector<double>* cap) {
  const int n = (int) worldPts.size();
  SandSides out;
  out.at[0].assign(n, 0.0);
  out.at[1].assign(n, 0.0);
  if (!(full > 0)) return out;
  std::vector<double> cum(n, 0.0);
  for (int i = 1; i < n; i++) cum[i] = cum[i - 1] + worldPts[i].distanceTo(worldPts[i - 1]);
  const double ring = cum[n - 1] + worldPts[n - 1].distanceTo(worldPts[0]);
  const auto wrap = [n](int i) { return (i % n + n) % n; };
  std::vector<double> allowed[2] = { std::vector<double>(n), std::vector<double>(n) };
  const auto ahead = [&](int i, int j) { double d = cum[j] - cum[i]; return d < 0 ? d + ring : d; };
  for (int i = 0; i < n; i++) {
    // The bend over KERB_FOLD_WINDOW, the span `track_fold` reads: from one
    // sample to the next the spline's curvature wobbles (it steps at every
    // knot), and a hairpin read at that scale lost a strip it had room for.
    int a = wrap(i - 1), b = wrap(i + 1);
    for (int g = 0; g < n / 4 && ahead(a, i) < KERB_FOLD_WINDOW / 2; g++) a = wrap(a - 1);
    for (int g = 0; g < n / 4 && ahead(i, b) < KERB_FOLD_WINDOW / 2; g++) b = wrap(b + 1);
    const double ds = ahead(a, i) + ahead(i, b);
    // The bend IN THE PLAN, the only kind that folds a kerb: over a hop's
    // crest the tangent turns too, and read whole, a jump on a gentle bend
    // took the inside's strip off as if it were a hairpin.
    const double ha = ttp_fd_hypot(tangents[a].x, tangents[a].z), hb = ttp_fd_hypot(tangents[b].x, tangents[b].z);
    double turn = 0, k = 0;
    if (ha > 1e-9 && hb > 1e-9) {
      const double ax = tangents[a].x / ha, az = tangents[a].z / ha, bx = tangents[b].x / hb, bz = tangents[b].z / hb;
      turn = ax * bz - az * bx;   // > 0: the corner turns toward +lateral, its inside
      k = std::fabs(ttp_fd_atan2(turn, ax * bx + az * bz)) / ds;
    }
    double room = k > 1e-9 ? SAND_FOLD_MAX / k - widths[i] / 2 : full;
    for (int side = 0; side < 2; side++) {
      const bool inside = side == 1 ? turn > 0 : turn < 0;
      double a = inside ? js_max(0.0, js_min(full, room)) : full;
      // A stretch authored without sand allows none: the same erosion and
      // average then ease the strip out before it and back in after it.
      for (int o = 0; o < nOff; o++)
        if (cum[i] >= off[o].from * ring && cum[i] <= off[o].to * ring) a = 0.0;
      if (raised[i]) a = 0.0;
      allowed[side][i] = js_min(a, cap[side][i]);
    }
  }
  // Two strands running side by side at one level share what lies between
  // them: each takes at most half of what is left once both asphalts and
  // STRAND_GAP (both kerbs and a little land) are taken, on the side facing
  // the other, or all of it beside a strand off the ground (a loop's mouth, a
  // ramp), which carries no strip but still has its asphalt and kerb there. A
  // strand passing over or under (a bridge) is another level.
  for (int i = 0; i < n; i++) {
    if (raised[i]) continue;
    const double hx = -tangents[i].z, hz = tangents[i].x, hl = ttp_fd_hypot(hx, hz);
    if (!(hl > 0)) continue;
    for (int j = 0; j < n; j++) {
      double ds = std::fabs(cum[j] - cum[i]);
      if (js_min(ds, ring - ds) < STRAND_ARC) continue;
      if (std::fabs(worldPts[j].y - worldPts[i].y) > STRAND_LEVEL) continue;
      const double dx = worldPts[j].x - worldPts[i].x, dz = worldPts[j].z - worldPts[i].z;
      const double reach = widths[i] / 2 + widths[j] / 2 + 2 * full + STRAND_GAP;
      if (dx * dx + dz * dz >= reach * reach) continue;
      const double d = ttp_fd_hypot(dx, dz);
      const double left = d - widths[i] / 2 - widths[j] / 2 - STRAND_GAP;
      const double share = js_max(0.0, raised[j] ? left : left / 2);
      const int side = (dx * hx + dz * hz) > 0 ? 1 : 0;
      allowed[side][i] = js_min(allowed[side][i], share);
    }
  }
  // Toward a loop both sides come down together: within SYM_REACH of one
  // each side takes the narrower of the two, so the centre line does not
  // swerve under the launch pad at its mouth. (Only a loop: a bridge's mouth
  // keeps each side's own ease, and the land the world stands on beside it.)
  {
    // arclength to the nearest loop sample, either way round the ring
    std::vector<double> nearOff(n, kInf);
    for (int i = 0; i < n; i++) if (loops[i]) nearOff[i] = 0;
    for (int k = 1; k <= 2 * n; k++) {
      const int i = k % n, p = (k - 1) % n;
      nearOff[i] = js_min(nearOff[i], nearOff[p] + worldPts[i].distanceTo(worldPts[p]));
    }
    for (int k = 2 * n - 1; k >= 0; k--) {
      const int i = k % n, q = (k + 1) % n;
      nearOff[i] = js_min(nearOff[i], nearOff[q] + worldPts[i].distanceTo(worldPts[q]));
    }
    for (int i = 0; i < n; i++)
      if (nearOff[i] <= SYM_REACH) allowed[0][i] = allowed[1][i] = js_min(allowed[0][i], allowed[1][i]);
  }
  // The eroded allowance is then averaged under a TENT SAND_EASE either side
  // (two box passes of half that, as one kernel), which makes the ease C1: a
  // single box ramps linearly, and its kinks put spikes in the curvature of
  // the centre line, which moves with the two strips' difference
  // (finalizeTrack). Both are taken over ARCLENGTH, each sample weighted by the
  // road it stands for: the samples are unevenly spaced, and an ease by sample
  // count bends wherever the spacing changes.
  const double h = SAND_EASE;
  const auto dist = [&](int i, int j) {   // arclength from sample i to sample j, the short way round
    double d = cum[j] - cum[i];
    if (d > ring / 2) d -= ring;
    if (d < -ring / 2) d += ring;
    return std::fabs(d);
  };
  std::vector<double> weight(n);
  for (int i = 0; i < n; i++) weight[i] = (dist(wrap(i - 1), i) + dist(i, wrap(i + 1))) / 2;
  for (int side = 0; side < 2; side++) {
    std::vector<double> eroded(n);
    for (int i = 0; i < n; i++) {
      double m = allowed[side][i];
      for (int d = 1; d < n && dist(i, wrap(i + d)) <= h; d++) m = js_min(m, allowed[side][wrap(i + d)]);
      for (int d = 1; d < n && dist(i, wrap(i - d)) <= h; d++) m = js_min(m, allowed[side][wrap(i - d)]);
      eroded[i] = m;
    }
    for (int i = 0; i < n; i++) {
      double acc = eroded[i] * weight[i], wsum = weight[i];
      for (int sgn = -1; sgn <= 1; sgn += 2) {
        for (int d = 1; d < n; d++) {
          const int j = wrap(i + sgn * d);
          const double t = 1 - dist(i, j) / h;
          if (t <= 0) break;
          acc += eroded[j] * weight[j] * t;
          wsum += weight[j] * t;
        }
      }
      out.at[side][i] = acc / wsum;
    }
  }
  return out;
}

// The ribbon as drawn, before it is final: where the kerb's far edge (the
// widest kerb any biome draws, KERB_MAX) would fall behind the asphalt's centre
// line by more than KERB_FOLD_MAX of its advance over KERB_FOLD_WINDOW, or the
// driven surface's by more than SURFACE_FOLD_MAX over SURFACE_FOLD_WINDOW
// (edge_fold, the measure `track_fold` judges by), cap that side's strip there
// to what brings it back under, or halve the other side's where it has none
// (its strip is what moved the centre line). The SAND_FOLD_MAX estimate keeps
// most corners clear on the first pass; this catches what it reads low: a
// spline's peak between samples, and the curvature the centre line's own shift
// adds. False once no cap falls: nothing folds, or what folds has no strip
// either side to take from.
bool narrowFolds(const std::vector<Vec3>& pts, const std::vector<Vec3>& tangents, const std::vector<Vec3>& ups,
                 const std::vector<double>& widths, const SandSides& sandAt, std::vector<double>* cap) {
  const int n = (int) pts.size();
  std::vector<Sample> cs(n);
  double s = 0;
  for (int i = 0; i < n; i++) {
    if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
    Sample& c = cs[i];
    c.pos = pts[i]; c.tangent = tangents[i]; c.up = ups[i];
    c.lateral = tangents[i].clone().cross(ups[i]).normalize();
    c.width = widths[i]; c.sandL = sandAt.at[0][i]; c.sandR = sandAt.at[1][i]; c.s = s;
  }
  const double length = s + pts[n - 1].distanceTo(pts[0]);
  Centerline cl(cs, length);
  // The kerb's far edge over a bend, and the driven surface's edge at any scale.
  struct Rule { double window, past, limit; };
  const Rule rules[] = { { KERB_FOLD_WINDOW, KERB_MAX, KERB_FOLD_MAX }, { SURFACE_FOLD_WINDOW, 0.0, SURFACE_FOLD_MAX } };
  bool any = false;
  for (const Rule& rule : rules)
  for (double t = 0; t < length; t += FOLD_STEP) {
    const EdgeFold folds = edge_fold(cl, t, rule.window, rule.past);
    for (int side = 0; side < 2; side++) {
      const double fold = folds.side[side];
      if (fold <= rule.limit) continue;
      int lo = 0, hi = n - 1;   // the last sample at or before t
      while (lo < hi) { const int m = (lo + hi + 1) / 2; if (cs[m].s <= t) lo = m; else hi = m - 1; }
      for (int k = lo; k <= lo + 1; k++) {
        const int i = k % n;
        const double strip = sandAt.at[side][i];
        if (strip > 0.05) {
          // On an arc the fold is the far edge's reach from the asphalt's
          // centre over the radius, so it shrinks in proportion to that reach:
          // take off just what brings it a little under the limit. Halving
          // here took a hairpin's inside to a sliver it had room to carry
          // three times over.
          const double reach = (widths[i] - sandAt.at[0][i] - sandAt.at[1][i]) / 2 + strip + rule.past;
          const double aim = rule.limit - FOLD_SPARE;
          cap[side][i] = js_min(cap[side][i], js_max(0.0, strip - reach * (fold - aim) / fold));
          any = true;
        } else if (sandAt.at[1 - side][i] > 0) {
          cap[1 - side][i] = js_min(cap[1 - side][i], sandAt.at[1 - side][i] / 2);
          any = true;
        }
      }
    }
  }
  return any;
}

RaceTrack finalizeTrack(std::vector<Vec3> worldPts, std::vector<double> widths,
                        std::vector<double> banks, std::vector<char> pillarFlags,
                        std::vector<char> hillFlags, std::vector<int> loopEntryIdx,
                        double trackWidth, bool startGate, double startU,
                        double sand, const SpanDef* sandOff, int nSandOff) {
  double gap = worldPts.back().distanceTo(worldPts.front());
  bool closed = gap < 0.5;
  if (worldPts.size() > 3 && worldPts.back().distanceTo(worldPts.front()) < DS) {
    worldPts.pop_back(); widths.pop_back(); banks.pop_back();
    pillarFlags.pop_back(); hillFlags.pop_back();
  }

  for (auto& p : worldPts) p.multiplyScalar(SCALE);
  for (auto& w : widths) w *= SCALE;
  for (int pass = 0; pass < 3; pass++) {
    std::vector<double> w = widths;                          // slice()
    int len = (int)widths.size();
    for (int i = 0; i < len; i++)
      widths[i] = 0.5 * w[i] + 0.25 * (w[(i - 1 + len) % len] + w[(i + 1) % len]);
  }

  int n = (int)worldPts.size();

  // Tangents via central differences around the closed ring.
  std::vector<Vec3> tangents;
  tangents.reserve(n);
  for (int i = 0; i < n; i++)
    tangents.push_back(worldPts[(i + 1) % n].clone().sub(worldPts[(i - 1 + n) % n]).normalize());

  // Parallel transport an `up` vector around the ring (rotation-minimizing frame).
  const auto transportUps = [&]() {
    std::vector<Vec3> ups;
    Vec3 up(0, 1, 0);
    up.addScaledVector(tangents[0], -up.dot(tangents[0]));
    if (up.lengthSq() < 1e-6) { up = Vec3(0, 0, 1); up.addScaledVector(tangents[0], -tangents[0].z); }
    up.normalize();
    ups.push_back(up.clone());
    for (int i = 1; i < n; i++) {
      Vec3 axis = tangents[i - 1].clone().cross(tangents[i]);
      double sinv = axis.length();
      if (sinv > 1e-8) {
        axis.multiplyScalar(1.0 / sinv);
        up.applyAxisAngle(axis, ttp_fd_atan2(sinv, js_max(-1.0, js_min(1.0, tangents[i - 1].dot(tangents[i])))));
      }
      up.addScaledVector(tangents[i], -up.dot(tangents[i])).normalize();
      ups.push_back(up.clone());
    }
    // Banking + roll, then unwind the residual holonomy evenly across the ring.
    for (int i = 0; i < n; i++) if (banks[i] != 0.0) ups[i].applyAxisAngle(tangents[i], banks[i]);
    Vec3 t0 = tangents[0];
    double resid = ttp_fd_atan2(ups[n - 1].clone().cross(ups[0]).dot(t0), ups[n - 1].dot(ups[0]));
    for (int i = 0; i < n; i++) {
      up.copy(ups[i]).applyAxisAngle(tangents[i], resid * ((double)i / (double)n));
      ups[i].copy(up);
    }
    return ups;
  };
  std::vector<Vec3> ups = transportUps();

  // The kerbs stand out by each side's own strip, and the centre line moves to
  // the middle between them, so a sample stays kerb-to-kerb symmetric about its
  // pos: the asphalt's own centre sits (sandL - sandR) / 2 along its lateral.
  // Only road lying on the land carries one: none on pillars, nor where the
  // deck leans past ON_GROUND_UP (a loop, a wall, a steep bank).
  std::vector<char> offGround(n);
  for (int i = 0; i < n; i++) offGround[i] = pillarFlags[i] || ups[i].y < ON_GROUND_UP;
  // A loop is off the land from its entry, where it is still nearly level,
  // to where it comes back down.
  std::vector<char> loops(n, 0);
  for (int e : loopEntryIdx) {
    bool inverted = false;
    for (int k = 0; k < n; k++) {
      const int i = (e + k) % n;
      if (ups[i].y < ON_GROUND_UP) inverted = true;
      else if (inverted) break;
      offGround[i] = loops[i] = 1;
    }
  }
  // A run of ground between two off it shorter than GROUND_RUN_MIN has no room
  // to ease a strip in and out again: it would only bulge the kerb and return.
  {
    int first = -1;
    for (int i = 0; i < n && first < 0; i++) if (offGround[i]) first = i;
    if (first >= 0) {
      for (int k = 1; k < n;) {
        const int a = (first + k) % n;
        if (offGround[a]) { k++; continue; }
        int len = 0;
        double arc = 0;
        while (k + len < n && !offGround[(first + k + len) % n]) {
          const int c = (first + k + len) % n;
          arc += worldPts[c].distanceTo(worldPts[(c + 1) % n]);
          len++;
        }
        if (arc < GROUND_RUN_MIN) for (int d = 0; d < len; d++) offGround[(first + k + d) % n] = 1;
        k += len;
      }
    }
  }
  const std::vector<Vec3> basePts = worldPts, baseTangents = tangents, baseUps = ups;
  const std::vector<double> baseWidths = widths;
  std::vector<double> cap[2] = { std::vector<double>(n, kInf), std::vector<double>(n, kInf) };
  SandSides sandAt;
  for (int pass = 0;; pass++) {
    worldPts = basePts; tangents = baseTangents; ups = baseUps; widths = baseWidths;
    sandAt = sandWidths(worldPts, tangents, widths, offGround, loops, sand * SCALE, sandOff, nSandOff, cap);
    bool shifted = false;
    for (int i = 0; i < n; i++) {
      widths[i] += sandAt.at[0][i] + sandAt.at[1][i];
      const double shift = (sandAt.at[1][i] - sandAt.at[0][i]) / 2;
      if (shift == 0.0) continue;
      // along the deck's own lateral, so on a banked bend the centre line
      // stays on the deck's plane
      const Vec3 lateral = tangents[i].clone().cross(ups[i]).normalize();
      worldPts[i].addScaledVector(lateral, shift);
      shifted = true;
    }
    // Narrow even where nothing moved: strips the same both sides fold a
    // tight bend's inside kerb just the same.
    if (shifted) {
      for (int i = 0; i < n; i++)
        tangents[i] = worldPts[(i + 1) % n].clone().sub(worldPts[(i - 1 + n) % n]).normalize();
      ups = transportUps();
    }
    if (pass == FOLD_PASSES || !narrowFolds(worldPts, tangents, ups, widths, sandAt, cap)) break;
  }

  std::vector<OutSample> samples;
  samples.reserve(n);
  double s = 0, minY = kInf, minEdgeY = kInf;
  for (int i = 0; i < n; i++) {
    Vec3 tangent = tangents[i], u = ups[i];
    Vec3 lateral = tangent.clone().cross(u).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    minY = js_min(minY, worldPts[i].y);
    minEdgeY = js_min(minEdgeY, worldPts[i].y - std::fabs(lateral.y) * widths[i] / 2);
    OutSample sm;
    sm.pos = worldPts[i].clone();
    sm.tangent = tangent;
    sm.up = u;
    sm.lateral = lateral;
    sm.s = s;
    sm.width = widths[i];
    sm.sandL = sandAt.at[0][i];
    sm.sandR = sandAt.at[1][i];
    sm.pillars = pillarFlags[i] != 0;
    sm.hillable = hillFlags[i] != 0;
    samples.push_back(sm);
  }
  double length = s + worldPts[n - 1].distanceTo(worldPts[0]);

  std::vector<LoopStart> loopStarts;
  for (int idx : loopEntryIdx) loopStarts.push_back({samples[idx].s, samples[idx].width});

  double groundY = js_min(minY - 0.3, minEdgeY - 0.12);

  const double POST_CLEAR = 0.15, POST_DEEP = 0.5;

  // ---- Support pillars under raised bridge/ramp segments.
  std::vector<Pillar> pillars;
  bool anyPillars = false;
  for (const auto& p : samples) if (p.pillars) { anyPillars = true; break; }
  if (anyPillars) {
    const double SPACING = 3.2, MIN_H = 0.7, RADIUS = 0.5, TUCK = 0.3, EMBED = 0.1,
                 LEVEL_GAP = 1.0, MARGIN = 0.3;
    double acc = SPACING;
    for (int i = 0; i < n; i++) {
      if (i > 0) acc += worldPts[i].distanceTo(worldPts[i - 1]);
      const OutSample& smp = samples[i];
      if (!smp.pillars || acc < SPACING) continue;
      if (smp.up.y < 0.7) continue;
      acc = 0;
      double topY = smp.pos.y - TUCK;
      if (topY - groundY < MIN_H) continue;
      bool onRoad = false;
      for (int j = 0; j < n; j++) {
        if (smp.pos.y - samples[j].pos.y < LEVEL_GAP) continue;
        double dx = samples[j].pos.x - smp.pos.x, dz = samples[j].pos.z - smp.pos.z;
        double clear = samples[j].width / 2 + RADIUS + MARGIN;
        if (dx * dx + dz * dz < clear * clear) { onRoad = true; break; }
      }
      if (onRoad) continue;
      double intr = intrusionOf({smp.pos.x, smp.pos.z, RADIUS, groundY - EMBED, topY}, samples);
      if (intr > -POST_CLEAR && intr < POST_DEEP) continue;
      pillars.push_back({smp.pos.x, smp.pos.z, groundY - EMBED, topY, RADIUS});
    }
  }

  // ---- Grass hills (berms) under raised, NON-pillared road.
  std::vector<std::vector<HillRing>> hills;
  {
    const double HILL_MIN = 0.15, MIN_RUN = 1.0, TUCK = 0.15, EDGE = 0.25,
                 LEVEL_GAP = 1.0, REACH = 3.2, ARC_GUARD = 12;
    auto isHill = [&](int i) -> bool {
      const OutSample& s = samples[i];
      if (!s.hillable || s.pos.y - groundY < HILL_MIN) return false;
      for (int j = 0; j < n; j++) {
        if (s.pos.y - samples[j].pos.y < LEVEL_GAP) continue;
        double ds = std::fabs(s.s - samples[j].s);
        if (js_min(ds, length - ds) < ARC_GUARD) continue;
        double dx = samples[j].pos.x - s.pos.x, dz = samples[j].pos.z - s.pos.z;
        double clear = samples[j].width / 2 + REACH;
        if (dx * dx + dz * dz < clear * clear) return false;
      }
      return true;
    };
    int i = 0;
    while (i < n) {
      if (!isHill(i)) { i++; continue; }
      int a = i;
      while (i < n && isHill(i)) i++;
      int b = i - 1;
      if (samples[b].s - samples[a].s < MIN_RUN) continue;
      int lo = (int)js_max(0.0, (double)(a - 1)), hi = (int)js_min((double)(n - 1), (double)(b + 1));
      std::vector<HillRing> rings;
      for (int k = lo; k <= hi; k++) {
        const OutSample& sk = samples[k];
        double lx = sk.lateral.x, lz = sk.lateral.z;
        double ll = ttp_fd_hypot(lx, lz);
        if (ll < 1e-6) { lx = 1; lz = 0; } else { lx /= ll; lz /= ll; }
        bool feather = (k < a || k > b);
        double halfW = sk.width / 2 + EDGE;
        double slope = ll < 1e-6 ? 0.0 : sk.lateral.y / ll;
        auto top = [&](double sign) -> double {
          return feather ? groundY : js_max(groundY, sk.pos.y + sign * slope * halfW - TUCK);
        };
        rings.push_back({sk.pos.x, sk.pos.z, lx, lz, halfW, top(-1), top(1)});
      }
      hills.push_back(std::move(rings));
    }
  }

  // ---- Loop support shafts bracing each 360° loop's lower-outer flank.
  std::vector<SupportPost> supportPosts;
  {
    const double RAD = 0.36, OFFSET = 0.45;
    std::vector<std::pair<int, int>> crowns;
    int curIdx = -1;
    for (int i = 0; i < n; i++) {
      if (samples[i].up.y < 0.3) {
        if (curIdx < 0) { crowns.push_back({i, i}); curIdx = (int)crowns.size() - 1; }
        else crowns[curIdx].second = i;
      } else curIdx = -1;
    }
    for (const auto& cr : crowns) {
      int a0 = cr.first, b0 = cr.second;
      if (b0 - a0 < 4) continue;
      int a = a0, b = b0;
      while (a > 0 && samples[a].pos.y > 0.6) a--;
      while (b < n - 1 && samples[b].pos.y > 0.6) b++;
      double cx = 0, cz = 0;
      int cnt = 0;
      for (int i = a; i <= b; i++) { cx += samples[i].pos.x; cz += samples[i].pos.z; cnt++; }
      cx /= cnt; cz /= cnt;
      int apex = a;
      for (int i = a; i <= b; i++) if (samples[i].pos.y > samples[apex].pos.y) apex = i;
      int ranges[2][2] = {{a, apex}, {apex, b}};
      for (int rr = 0; rr < 2; rr++) {
        int lo = ranges[rr][0], hi = ranges[rr][1];
        bool haveBest = false;
        int bestI = -1;
        double bestSc = 0;
        for (int i = lo; i <= hi; i++) {
          const OutSample& s2 = samples[i];
          if (s2.pos.y < 1.5 || s2.pos.y > 3.2 || s2.up.y < 0.3) continue;
          double sc = std::fabs(s2.up.y - 0.5);
          if (!haveBest || sc < bestSc) { haveBest = true; bestSc = sc; bestI = i; }
        }
        if (!haveBest) continue;
        const OutSample& c = samples[bestI];
        double ox = c.pos.x - cx, oz = c.pos.z - cz;
        double ol = ttp_fd_hypot(ox, oz);
        if (ol == 0.0) ol = 1.0;
        ox /= ol; oz /= ol;
        bool placed = false;
        double px = 0, pz = 0;
        for (double off = OFFSET; off <= OFFSET + 0.61; off += 0.15) {
          double x = c.pos.x + ox * off, z = c.pos.z + oz * off;
          if (intrusionOf({x, z, RAD, groundY, c.pos.y}, samples) <= -POST_CLEAR) {
            placed = true; px = x; pz = z; break;
          }
        }
        if (!placed) continue;
        SupportPost sp;
        sp.x = px; sp.z = pz; sp.radius = RAD; sp.baseY = groundY;
        sp.contactPos = Vec3(c.pos.x, c.pos.y, c.pos.z);
        sp.contactUp = Vec3(c.up.x, c.up.y, c.up.z);
        supportPosts.push_back(sp);
      }
    }
  }

  // ---- Collision poles for supports standing IN a drivable corridor.
  std::vector<AutoPole> autoPoles;
  {
    struct APost { double x, z, radius, baseY, topY; };
    std::vector<APost> posts;
    for (const auto& p : pillars) posts.push_back({p.x, p.z, p.radius, p.baseY, p.topY});
    for (const auto& p : supportPosts) posts.push_back({p.x, p.z, p.radius, p.baseY, p.contactPos.y});
    for (const auto& post : posts) {
      bool haveRun = false;
      double runS = 0, runLat = 0, runTan = 0, runIntr = 0, runLastS = 0;
      auto flush = [&]() {
        if (haveRun && runIntr >= 0.25) autoPoles.push_back({runS, runLat, post.radius});
        haveRun = false;
      };
      for (int j = 0; j < n; j++) {
        const OutSample& sm = samples[j];
        PostHit hit = postAtSample(sm, {post.x, post.z, post.radius, post.baseY, post.topY});
        if (!hit.valid) continue;
        if (haveRun && sm.s - runLastS > 1.0) flush();
        if (!haveRun) {
          haveRun = true; runS = sm.s; runLat = hit.lat; runTan = hit.tan;
          runIntr = hit.intrusion; runLastS = sm.s;
        } else {
          runLastS = sm.s;
          runIntr = js_max(runIntr, hit.intrusion);
          if (std::fabs(hit.tan) < std::fabs(runTan)) { runS = sm.s; runLat = hit.lat; runTan = hit.tan; }
        }
      }
      flush();
    }
  }

  // ---- Move the start/finish line (startU, a fraction of the lap). Relabels only.
  std::vector<OutSample> ring;
  if (startU != 0.0) {
    double target = std::fmod(std::fmod(startU, 1.0) + 1.0, 1.0) * length;
    int k = 0;
    double bd = kInf;
    for (int i = 0; i < n; i++) {
      double d = std::fabs(samples[i].s - target);
      if (d < bd) { bd = d; k = i; }
    }
    double off = samples[k].s;
    auto reS = [&](double sv) -> double { double t = sv - off; return t < 0 ? t + length : t; };
    for (auto& l : loopStarts) l.s = reS(l.s);
    for (auto& p : autoPoles) p.s = reS(p.s);
    for (auto& sm : samples) sm.s = reS(sm.s);
    ring.assign(samples.begin() + k, samples.end());
    ring.insert(ring.end(), samples.begin(), samples.begin() + k);
  } else {
    ring = std::move(samples);
  }

  RaceTrack rt;
  rt.version = CONTRACT_VERSION;
  rt.startGate = startGate;
  rt.pillars = std::move(pillars);
  rt.hills = std::move(hills);
  rt.loopStarts = std::move(loopStarts);
  rt.supportPosts = std::move(supportPosts);
  rt.autoPoles = std::move(autoPoles);
  rt.samples = std::move(ring);
  rt.length = length;
  rt.closed = closed;
  rt.gap = gap;
  rt.roadWidth = trackWidth * SCALE;
  rt.sand = sand * SCALE;
  rt.groundY = groundY;
  return rt;
}

// ---- Segment DSL walk (buildTrack).
RaceTrack buildTrackSegments(const TrackDef& def) {
  double trackWidth = (def.width != 0.0) ? def.width : ROAD_WIDTH;  // (desc.width) || ROAD_WIDTH
  double startU = def.startU;

  double rollAcc = 0;
  auto segWidth = [&](const SegDef& seg, double f) -> double {
    if (seg.widthKind == 0) return trackWidth;
    if (seg.widthKind == 2) return seg.w0 + (seg.w1 - seg.w0) * f;
    return seg.w0;
  };
  auto segBank = [&](const SegDef& seg, double f) -> double {
    if (seg.bank == 0.0) return 0.0;                              // !seg.bank
    double sign = seg.kind == SegKind::Arc ? js_sign(seg.angle != 0.0 ? seg.angle : 1.0) : 1.0;
    return seg.bank * DEG * bankWindow(f) * sign;
  };
  auto segTwist = [&](const SegDef& seg, double f) -> double {
    double rollTerm = (seg.roll != 0.0) ? seg.roll * DEG * smootherstep(f) : 0.0;
    return segBank(seg, f) + rollAcc + rollTerm;
  };

  double X = 0, Z = 0, theta = 0, elev = 0;
  std::vector<Vec3> worldPts{Vec3(0, 0, 0)};
  std::vector<double> widths{trackWidth}, banks{0.0};
  std::vector<char> pillarFlags{0}, hillFlags{0};
  std::vector<int> loopEntryIdx;

  for (int si = 0; si < def.nSegs; si++) {
    const SegDef& seg = def.segs[si];
    if (seg.kind == SegKind::Straight) {
      double len = seg.length, rise = seg.rise;                  // rise || 0 (raw, 0 if absent)
      int N = (int)js_max(1.0, js_round(len / DS));
      double dx = dirX(theta), dz = dirZ(theta);
      double x0 = X, z0 = Z, y0 = elev;
      for (int i = 1; i <= N; i++) {
        double f = (double)i / (double)N;
        // graded: the cubic Hermite from (0, slope g0) to (rise, slope g1)
        double y = seg.graded
            ? rise * (f * f * (3 - 2 * f)) + len * (seg.g0 * (f * (f - 1) * (f - 1)) + seg.g1 * (f * f * (f - 1)))
            : rise * smootherstep(f);
        worldPts.push_back(Vec3(x0 + dx * len * f, y0 + y, z0 + dz * len * f));
        widths.push_back(segWidth(seg, f));
        banks.push_back(segTwist(seg, f));
        pillarFlags.push_back(seg.pillars ? 1 : 0);
        hillFlags.push_back((!seg.pillars && seg.rise != 0.0) ? 1 : 0);
      }
      X = x0 + dx * len; Z = z0 + dz * len; elev = y0 + rise;
    } else if (seg.kind == SegKind::Arc) {
      double R = seg.radius, ang = seg.angle * DEG, rise = seg.rise;
      double sg = js_sign(ang);
      double sgn = (sg != 0.0) ? sg : 1.0;                       // Math.sign(ang) || 1
      double A = std::fabs(ang);
      double x0 = X, z0 = Z, y0 = elev, th0 = theta;
      int N = (int)js_max(1.0, js_round(R * A / DS));
      for (int i = 1; i <= N; i++) {
        double f = (double)i / (double)N, th = th0 + ang * f;
        worldPts.push_back(Vec3(x0 + R * sgn * (latX(th0) - latX(th)),
                                y0 + rise * smootherstep(f),
                                z0 + R * sgn * (latZ(th0) - latZ(th))));
        widths.push_back(segWidth(seg, f));
        banks.push_back(segTwist(seg, f));
        pillarFlags.push_back(seg.pillars ? 1 : 0);
        hillFlags.push_back(0);
      }
      X = x0 + R * sgn * (latX(th0) - latX(th0 + ang));
      Z = z0 + R * sgn * (latZ(th0) - latZ(th0 + ang));
      theta = th0 + ang; elev = y0 + rise;
    } else {  // SegKind::Loop
      loopEntryIdx.push_back((int)worldPts.size() - 1);
      double r = seg.radius;
      double vert = seg.over ? 1.0 : -1.0;                       // over===false ? -1 : 1
      double drift = seg.drift;                                  // drift || 0
      double dx = dirX(theta), dz = dirZ(theta), lx = latX(theta), lz = latZ(theta);
      double x0 = X, z0 = Z, y0 = elev;
      if (drift != 0.0) {
        int N = (int)js_max(16.0, js_round(2 * PI * r / DS));
        for (int i = 1; i <= N; i++) {
          double f = (double)i / (double)N, phi = 2 * PI * f, off = drift * smoothstep(f);
          double fwd = r * ttp_fd_sin(phi);
          worldPts.push_back(Vec3(x0 + dx * fwd + lx * off,
                                  y0 + vert * r * (1 - ttp_fd_cos(phi)),
                                  z0 + dz * fwd + lz * off));
          widths.push_back(segWidth(seg, f));
          banks.push_back(segTwist(seg, f));
          pillarFlags.push_back(seg.pillars ? 1 : 0);
          hillFlags.push_back(0);
        }
        X = x0 + lx * drift; Z = z0 + lz * drift;
      } else {
        int N = (int)js_max(8.0, js_round(PI * r / DS));
        for (int i = 1; i <= N; i++) {
          double f = (double)i / (double)N, phi = PI * f;
          double fwd = r * ttp_fd_sin(phi);
          worldPts.push_back(Vec3(x0 + dx * fwd, y0 + vert * r * (1 - ttp_fd_cos(phi)), z0 + dz * fwd));
          widths.push_back(segWidth(seg, f));
          banks.push_back(segTwist(seg, f));
          pillarFlags.push_back(seg.pillars ? 1 : 0);
          hillFlags.push_back(0);
        }
        theta += PI;
        elev = y0 + vert * 2 * r;
      }
    }
    if (seg.roll != 0.0) rollAcc = std::fmod(rollAcc + seg.roll * DEG, 2 * PI);
  }

  return finalizeTrack(std::move(worldPts), std::move(widths), std::move(banks),
                       std::move(pillarFlags), std::move(hillFlags), std::move(loopEntryIdx),
                       trackWidth, true, startU, def.sand, def.sandOff, def.nSandOff);
}

// ---- Waypoint centripetal Catmull-Rom sampler (buildSplineTrack).
RaceTrack buildSplineTrack(const TrackDef& def) {
  double startU = def.startU;
  int m = def.nWpts;
  double trackWidth = (def.width != 0.0) ? def.width : ROAD_WIDTH;
  auto at = [&](int i) -> const WptDef& { return def.wpts[((i % m) + m) % m]; };
  auto P = [&](int i) -> Vec3 { const WptDef& p = at(i); return Vec3(p.x, p.y, p.z); };  // p.y already 0-defaulted
  auto knot = [&](double ti, const Vec3& a, const Vec3& b) -> double {
    return ti + std::sqrt(js_max(1e-6, a.distanceTo(b)));
  };
  std::vector<Vec3> worldPts;
  std::vector<double> widths, banks;
  std::vector<char> pillarFlags, hillFlags;
  for (int i = 0; i < m; i++) {
    Vec3 p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    double t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    int SUB = (int)js_max(8.0, std::ceil(p1.distanceTo(p2) / DS));
    double wRawA = at(i).w, wRawB = at(i + 1).w;
    double wA = (wRawA != 0.0) ? wRawA : trackWidth;            // at(i).w || trackWidth
    double wB = (wRawB != 0.0) ? wRawB : trackWidth;
    double bA = at(i).bank * DEG, bB = at(i + 1).bank * DEG;    // (bank || 0) * DEG (raw 0-default)
    bool bridge = at(i).bridge || at(i + 1).bridge;
    for (int k = 0; k < SUB; k++) {
      double frac = (double)k / (double)SUB, t = t1 + (t2 - t1) * frac;
      // Barry-Goldman pyramid; a2 feeds both b1 (by ref) and b2 (cloned).
      Vec3 a1 = p0; a1.multiplyScalar((t1 - t) / (t1 - t0)).addScaledVector(p1, (t - t0) / (t1 - t0));
      Vec3 a2 = p1; a2.multiplyScalar((t2 - t) / (t2 - t1)).addScaledVector(p2, (t - t1) / (t2 - t1));
      Vec3 a3 = p2; a3.multiplyScalar((t3 - t) / (t3 - t2)).addScaledVector(p3, (t - t2) / (t3 - t2));
      a1.multiplyScalar((t2 - t) / (t2 - t0)).addScaledVector(a2, (t - t0) / (t2 - t0));   // b1 = a1 in place
      Vec3 b2 = a2; b2.multiplyScalar((t3 - t) / (t3 - t1)).addScaledVector(a3, (t - t1) / (t3 - t1));
      a1.multiplyScalar((t2 - t) / (t2 - t1)).addScaledVector(b2, (t - t1) / (t2 - t1));   // c = b1 in place
      double cy = a1.y;
      worldPts.push_back(a1);
      widths.push_back(wA + (wB - wA) * frac);
      banks.push_back(bA + (bB - bA) * frac);
      pillarFlags.push_back(bridge ? 1 : 0);
      hillFlags.push_back((!bridge && cy > 0.075) ? 1 : 0);
    }
  }
  return finalizeTrack(std::move(worldPts), std::move(widths), std::move(banks),
                       std::move(pillarFlags), std::move(hillFlags), std::vector<int>{},
                       trackWidth, true, startU, def.sand, def.sandOff, def.nSandOff);
}

// The lateral offset of the asphalt's centre from the centre line at arclength
// s (OutSample::asphaltMid, interpolated): what an authored `lat` is measured
// from.
double asphaltMidAt(const RaceTrack& rt, double s) {
  const std::vector<OutSample>& sm = rt.samples;
  const int n = (int) sm.size();
  if (n == 0) return 0.0;
  if (rt.length > 0) s = std::fmod(std::fmod(s, rt.length) + rt.length, rt.length);
  // the last sample at or before s (the ring starts at s = 0), then on to the
  // next (round the seam)
  int lo = 0, hi = n - 1;
  while (lo < hi) {
    const int m = (lo + hi + 1) / 2;
    if (sm[m].s <= s) lo = m; else hi = m - 1;
  }
  const OutSample& a = sm[lo];
  const OutSample& c = sm[(lo + 1) % n];
  double span = c.s - a.s;
  if (span <= 0) span += rt.length;
  const double f = span > 0 ? js_min(1.0, js_max(0.0, (s - a.s) / span)) : 0.0;
  return a.asphaltMid() + (c.asphaltMid() - a.asphaltMid()) * f;
}

// ---- Furniture resolve: descriptor (fraction-of-lap u) → arclength s.
// An authored `lat` is from the ASPHALT's centre, which stands off the centre
// line wherever one side carries more strip than the other (asphaltMidAt), so
// a pad, a box or an oil stays where it was put on the asphalt.
void resolveFurniture(RaceTrack& b, const TrackDef& def) {
  double len = b.length;
  auto u2s = [&](double u) -> double { return std::fmod(std::fmod(u, 1.0) + 1.0, 1.0) * len; };
  auto mid = [&](double s) -> double { return asphaltMidAt(b, s); };
  const double LOOP_PAD_LEN = 2.2, OIL_RADIUS_FRAC = 0.2, PAD_RADIUS_FRAC = 0.18,
               BOX_RADIUS_FRAC = 0.09, POLE_RADIUS = 0.45;

  b.hazards.clear();
  for (int i = 0; i < def.nOils; i++) {
    const FurnDef& o = def.oils[i];
    double radius = o.hasRadius ? o.radius : b.roadWidth * OIL_RADIUS_FRAC;
    b.hazards.push_back({u2s(o.u), o.lat + mid(u2s(o.u)), radius});
  }
  b.pads.clear();
  for (int i = 0; i < def.nPads; i++) {
    const FurnDef& p = def.pads[i];
    double radius = p.hasRadius ? p.radius : b.roadWidth * PAD_RADIUS_FRAC;
    b.pads.push_back({u2s(p.u), p.lat + mid(u2s(p.u)), false, radius, 0, 0});
  }
  for (const auto& ls : b.loopStarts) {
    double sc = std::fmod(std::fmod(ls.s - LOOP_PAD_LEN / 2, len) + len, len);
    b.pads.push_back({sc, mid(sc), true, 0, LOOP_PAD_LEN / 2, ls.width / 2});
  }
  b.boxes.clear();
  for (int i = 0; i < def.nBoxes; i++) {
    const FurnDef& p = def.boxes[i];
    double radius = p.hasRadius ? p.radius : b.roadWidth * BOX_RADIUS_FRAC;
    b.boxes.push_back({u2s(p.u), p.lat + mid(u2s(p.u)), radius});
  }
  b.poles.clear();
  for (int i = 0; i < def.nPoles; i++) {
    const FurnDef& p = def.poles[i];
    double radius = p.hasRadius ? p.radius : POLE_RADIUS;
    b.poles.push_back({u2s(p.u), p.lat + mid(u2s(p.u)), radius, false});
  }
  for (const auto& ap : b.autoPoles) b.poles.push_back({ap.s, ap.lat, ap.radius, true});
  if (b.sand > 0) {  // the gantry draws these; ghost keeps buildPoles off them
    b.poles.push_back({0, mid(0) - sand_gantry_lat(b.roadWidth), GANTRY_POST_RADIUS, true});
    b.poles.push_back({0, mid(0) + sand_gantry_lat(b.roadWidth), GANTRY_POST_RADIUS, true});
  }
  b.bananas.clear();
  for (int i = 0; i < def.nBananas; i++) {
    const BananaDef& p = def.bananas[i];
    b.bananas.push_back({u2s(p.u), p.lat + mid(u2s(p.u))});
  }
  b.kickers.clear();
  for (int i = 0; i < def.nKickers; i++) b.kickers.push_back({u2s(def.kickers[i].u)});
}

}  // namespace

EdgeFold edge_fold(Centerline& cl, double s, double window, double past) {
  const auto at = [](const Frame& g, double lat) { return g.pos.clone().addScaledVector(g.lateral, lat); };
  const Frame a = cl.sampleAt(s - window / 2), b = cl.sampleAt(s + window / 2), f = cl.sampleAt(s);
  const double centre = at(b, b.asphaltMid()).sub(at(a, a.asphaltMid())).dot(f.tangent);
  EdgeFold fold = { { 0.0, 0.0 } };
  if (!(centre > 1e-9)) return fold;
  for (int side = 0; side < 2; side++) {
    const double sg = side ? 1.0 : -1.0;
    const double edge = at(b, sg * (b.width / 2 + past)).sub(at(a, sg * (a.width / 2 + past))).dot(f.tangent);
    fold.side[side] = 1 - edge / centre;
  }
  return fold;
}

PostHit post_at_sample(const OutSample& sm, const Post& post) {
  return postAtSample(sm, post);
}

RaceTrack build_race_track(const TrackDef& def, int laps, uint32_t seed) {
  RaceTrack b = def.isSpline ? buildSplineTrack(def) : buildTrackSegments(def);
  b.trackId = def.id;
  b.totalLaps = laps;
  b.seed = seed;  // seed >>> 0 (caller passes the normalized value)
  resolveFurniture(b, def);
  return b;
}

}  // namespace ttp
