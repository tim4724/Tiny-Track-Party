#include "ttp/trackbuilder.h"

#include <cmath>
#include <limits>
#include <utility>
#include <vector>

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
RaceTrack finalizeTrack(std::vector<Vec3> worldPts, std::vector<double> widths,
                        std::vector<double> banks, std::vector<char> pillarFlags,
                        std::vector<char> hillFlags, std::vector<int> loopEntryIdx,
                        double trackWidth, bool startGate, double startU) {
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
  Vec3 up(0, 1, 0);
  up.addScaledVector(tangents[0], -up.dot(tangents[0]));
  if (up.lengthSq() < 1e-6) { up = Vec3(0, 0, 1); up.addScaledVector(tangents[0], -tangents[0].z); }
  up.normalize();
  std::vector<Vec3> ups;
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
        worldPts.push_back(Vec3(x0 + dx * len * f, y0 + rise * smootherstep(f), z0 + dz * len * f));
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
                       trackWidth, true, startU);
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
                       trackWidth, true, startU);
}

// ---- Furniture resolve: descriptor (fraction-of-lap u) → arclength s.
void resolveFurniture(RaceTrack& b, const TrackDef& def) {
  double len = b.length;
  auto u2s = [&](double u) -> double { return std::fmod(std::fmod(u, 1.0) + 1.0, 1.0) * len; };
  const double LOOP_PAD_LEN = 2.2, OIL_RADIUS_FRAC = 0.2, PAD_RADIUS_FRAC = 0.18,
               BOX_RADIUS_FRAC = 0.09, POLE_RADIUS = 0.45;

  b.hazards.clear();
  for (int i = 0; i < def.nOils; i++) {
    const FurnDef& o = def.oils[i];
    double radius = o.hasRadius ? o.radius : b.roadWidth * OIL_RADIUS_FRAC;
    b.hazards.push_back({u2s(o.u), o.lat, radius});
  }
  b.pads.clear();
  for (int i = 0; i < def.nPads; i++) {
    const FurnDef& p = def.pads[i];
    double radius = p.hasRadius ? p.radius : b.roadWidth * PAD_RADIUS_FRAC;
    b.pads.push_back({u2s(p.u), p.lat, false, radius, 0, 0});
  }
  for (const auto& ls : b.loopStarts) {
    double sc = std::fmod(std::fmod(ls.s - LOOP_PAD_LEN / 2, len) + len, len);
    b.pads.push_back({sc, 0, true, 0, LOOP_PAD_LEN / 2, ls.width / 2});
  }
  b.boxes.clear();
  for (int i = 0; i < def.nBoxes; i++) {
    const FurnDef& p = def.boxes[i];
    double radius = p.hasRadius ? p.radius : b.roadWidth * BOX_RADIUS_FRAC;
    b.boxes.push_back({u2s(p.u), p.lat, radius});
  }
  b.poles.clear();
  for (int i = 0; i < def.nPoles; i++) {
    const FurnDef& p = def.poles[i];
    double radius = p.hasRadius ? p.radius : POLE_RADIUS;
    b.poles.push_back({u2s(p.u), p.lat, radius, false});
  }
  for (const auto& ap : b.autoPoles) b.poles.push_back({ap.s, ap.lat, ap.radius, true});
  b.bananas.clear();
  for (int i = 0; i < def.nBananas; i++) {
    const BananaDef& p = def.bananas[i];
    b.bananas.push_back({u2s(p.u), p.lat});
  }
}

}  // namespace

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
