// set_motion — what a set piece's moving parts do: the `anim_` node grammar and
// the closed-form pose each verb gives at a time.
//
// THE GRAMMAR. A set-piece GLB node whose name starts `anim_` moves, with
// everything under it (TtpRendererMotion.cpp draws it). The name is verbs joined
// by `+`, each with optional `:key=value` parameters, and anything after a `#`
// is a tag that only makes the name unique:
//
//   anim_spin:a=x:w=2.5          turn about the node's own x axis at 2.5 rad/s
//   anim_sway:a=y:d=25:p=1.8     swing +-25 degrees about y, a 1.8 s period
//   anim_bob:h=0.25:p=3          rise and fall 0.25 units every 3 s
//   anim_bob:h=0.1:p=0.5:b=1     bounce 0.1 units every 0.5 s (a skip, a trampoline)
//   anim_sway:a=z:d=30:p=8:r=0.75   a GESTURE: lift 30 degrees and back once in
//                                the first quarter of every 8 s, then rest
//   anim_waddle+watch+hop#2      a penguin: rock, turn to the cars, hop
//   anim_path:c=chute:p=7.5:o=0.33   ride the closed path `chute`, a third on
//   anim_smoke                   (mesh-less) where a chimney's smoke rises from
//   anim_flutter:p=2             CLOTH in wind: a flag, a pennant, a windsock
//   anim_flutter:a=y:p=2.4       ... a feather banner, held all the way up its pole
//   anim_drape+flutter           ... on a pole that stands on terrain
//   anim_smoke:s=2.5             ... puffs two and a half times a chimney's (a stack)
//
// An `anim_` node inside another rides on it: it moves in its parent's moving
// frame (a wind-up key turning in a walking robot's back). A path rides
// nothing: its loop is where the piece stands.
//
// A path is the empties `path_<chain>_<k>` of the same GLB, k = 0, 1, ... in
// order, closed back to 0; a chain named `drape...` lies on the ground as the
// renderer draws it (each point lifted by the land under it over the piece's
// foot, like a `drape` part), so a traveller on a terrain hill stays on its
// drawn slope. A traveller may also spin, bob and waddle in its own frame on
// the way (`anim_path:c=run+spin:a=z:w=-4+bob:h=0.3:p=0.7`, a ball bouncing
// down a run; a walking penguin rocks from foot to foot); the other verbs are in-place and a
// path ignores them. `drape` moves nothing: an in-place part on a piece built
// on its own terrain (SET_GROUND) stands on the ground as the renderer draws
// it, lifted by the land under its pivot over the piece's foot as the `drape`
// parts round it are, so a flag stays on the top of its draped pole where the
// grid's chords stray off the curve the piece was built on. Lengths are the
// node's own units (a GLB's grow and the placement's scale carry them); radii
// are WORLD units, because they are about cars. Keys: a axis (x|y|z), w rad/s,
// d degrees, p seconds, h height, r radius (watch, hop), c chain, o phase
// offset (0..1), f facing for a path (0 rest, 1 yaw, 2 full), s size (smoke),
// n segments (flutter).
//
// FLUTTER is the one verb that bends its part. The part is a cloth built flat
// and held at its node's pivot (a point of the hoist); the renderer finds its
// fly (the long way off the pivot; with `a`, the way across that axis, for a
// cloth taller than it flies), cuts it into `n` segments across the fly and
// carries each cut on a bone of its own, so a ripple runs from the hoist to
// the free end: every joint bends a little about the hoist line (`d` degrees,
// out of the cloth's plane) and dips a little in the plane, each a beat
// behind the joint before it, under a gust that swells and slackens and a
// wind that veers. `p` is the cloth's slow beat, what a sway of it would have
// taken; the ripple runs twice in it. No two terms share a period, so it
// never comes round like a pendulum, and every cloth keeps a phase of its
// own: a row of flags does not fly in step. Where a part is one rigid draw
// (the lite tier) it swings whole on its first joint's bend. A plate
// swinging on a `sway` read as a board on a hinge.
// r on a sway or a bob is its REST: the share of its period it stands still.
// A sway with a rest swings ONE way (0 to d and back, eased at both ends)
// instead of either side of its rest pose: a cow lifts its head from the
// grass and lowers it again. A bob is one-sided already, so its rest only
// adds the pause: a ball bounces and lands. A one-way sway with a rest
// is also the one move a person makes of their own: one small move and a
// rest, never a whole-body rock (a body that moves rides something: a swing,
// a ring). b 1 makes a bob BOUNCE (fast off the ground, slow at the top)
// instead of a smooth rise and fall.
// On a path `o` is where it starts round its loop; on sway, bob or waddle it
// puts the part IN STEP: it counts from its placement's clock, not its own,
// `o` of a cycle on, so parts of one piece keep time (a robot's legs and body,
// a snake's tail joints). Without it every part keeps a phase of its own.
// On a spin `o` PINS the turn to the scene clock, `o` of a turn at t = 0, the
// clock a path runs on: a screw lift's flight stays under the marbles riding
// their path up it.
//
// EVERY POSE IS A PURE FUNCTION of the scene clock, a per-node phase and where
// the cars are now. Nothing accumulates, so nothing needs resetting between
// races, an undrawn wind cannot drift it, and the two renderers agree.
//
// Header-only for kitfield.h's reason: the renderer needs it and may not link
// libttp-runtime (native/CLAUDE.md); `setmotion` ctests it.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

namespace ttp {
namespace rt {

struct SetMotion {
  bool spin = false, sway = false, bob = false, waddle = false, watch = false,
       hop = false, path = false, smoke = false, drape = false, flutter = false;
  char spinAxis = 'y';
  float spinRate = 1.0f;                     // rad/s, signed
  bool spinPinned = false;                   // `o` on a spin: its turn at t = 0, not a phase of its own
  float spinTurn = 0.0f;
  char swayAxis = 'z';
  float swayDeg = 25.0f, swayPeriod = 2.0f;  // a sway under ~20 degrees does not read
  float swayRest = -1.0f;                    // < 0: either side, no rest
  float bobHeight = 0.2f, bobPeriod = 3.0f, bobRest = 0.0f;
  bool bobBounce = false;
  float waddleDeg = 12.0f, waddlePeriod = 0.9f;
  float watchRadius = 26.0f, watchDeg = 60.0f;
  float hopRadius = 9.0f, hopHeight = 0.35f, hopPeriod = 0.5f;
  std::string chain;
  float pathPeriod = 8.0f, pathOffset = 0.0f;
  int pathFace = 2;
  bool inStep = false;   // `o` on an in-place verb: phase = the placement's + `step`
  float step = 0.0f;
  float smokeScale = 1.0f;                   // the puffs' size and rise, a chimney's at 1
  float flutterDeg = 14.0f, flutterPeriod = 2.0f;   // a joint's bend, the cloth's slow beat
  int flutterJoints = 4;                     // segments along the fly (kFlutterMax at most)
  char flutterHoist = 0;                     // `a`: the hoist's axis; 0 reads it off the cloth
  // A part that TRAVELS leaves the sun bake: a shadow baked at its rest spot
  // would stay behind. One that moves in place keeps its rest-pose shadow, which
  // under the near-overhead sun is its footprint.
  bool travels() const { return path; }
  bool any() const { return spin || sway || bob || waddle || watch || hop || path || flutter; }
};
constexpr int kFlutterMax = 8;

inline bool is_set_motion_name(const char* name) {
  return name && std::strncmp(name, "anim_", 5) == 0;
}

// False for a name that is not `anim_...`. An unknown verb or key is skipped,
// so a newer asset still loads on an older renderer, standing still; each one
// is appended to `unknown` (when given), which is how the asset gate and the
// renderer's log catch a typo that would otherwise just stand still.
inline bool parse_set_motion(const char* name, SetMotion& m, std::string* unknown = nullptr) {
  m = SetMotion{};
  if (!is_set_motion_name(name)) return false;
  std::string s(name + 5);
  if (const size_t hash = s.find('#'); hash != std::string::npos) s.resize(hash);
  const auto bad = [&](const std::string& what) {
    if (unknown) *unknown += (unknown->empty() ? "" : ", ") + what;
  };
  size_t at = 0;
  while (at <= s.size()) {
    size_t end = s.find('+', at);
    if (end == std::string::npos) end = s.size();
    const std::string verb = s.substr(at, end - at);
    at = end + 1;
    size_t colon = verb.find(':');
    const std::string v = verb.substr(0, colon);
    bool* on = v == "spin" ? &m.spin : v == "sway" ? &m.sway : v == "bob" ? &m.bob
             : v == "waddle" ? &m.waddle : v == "watch" ? &m.watch : v == "hop" ? &m.hop
             : v == "path" ? &m.path : v == "smoke" ? &m.smoke : v == "drape" ? &m.drape
             : v == "flutter" ? &m.flutter : nullptr;
    if (!on) {
      bad("verb '" + v + "'");
      continue;
    }
    *on = true;
    while (colon != std::string::npos) {
      const size_t next = verb.find(':', colon + 1);
      const std::string kv = verb.substr(colon + 1,
          next == std::string::npos ? std::string::npos : next - colon - 1);
      colon = next;
      const size_t eq = kv.find('=');
      const char key = eq == 1 ? kv[0] : 0;   // keys are one letter: `deg=` is not `d=`
      const std::string val = eq == std::string::npos ? "" : kv.substr(eq + 1);
      const float f = std::strtof(val.c_str(), nullptr);
      const char axis = val.empty() ? 'y' : val[0];
      bool known = true;
      if (v == "spin") {
        if (key == 'a') m.spinAxis = axis; else if (key == 'w') m.spinRate = f;
        else if (key == 'o') { m.spinPinned = true; m.spinTurn = f; } else known = false;
      } else if (key == 'o' && (v == "sway" || v == "bob" || v == "waddle")) {
        m.inStep = true;
        m.step = f;
      } else if (v == "sway") {
        if (key == 'a') m.swayAxis = axis; else if (key == 'd') m.swayDeg = f;
        else if (key == 'p' && f > 0) m.swayPeriod = f;
        else if (key == 'r') m.swayRest = std::min(0.95f, std::max(0.0f, f)); else known = false;
      } else if (v == "bob") {
        if (key == 'h') m.bobHeight = f; else if (key == 'p' && f > 0) m.bobPeriod = f;
        else if (key == 'r') m.bobRest = std::min(0.95f, std::max(0.0f, f));
        else if (key == 'b') m.bobBounce = f != 0; else known = false;
      } else if (v == "waddle") {
        if (key == 'd') m.waddleDeg = f; else if (key == 'p' && f > 0) m.waddlePeriod = f;
        else known = false;
      } else if (v == "watch") {
        if (key == 'r') m.watchRadius = f; else if (key == 'd') m.watchDeg = f; else known = false;
      } else if (v == "hop") {
        if (key == 'r') m.hopRadius = f; else if (key == 'h') m.hopHeight = f;
        else if (key == 'p' && f > 0) m.hopPeriod = f; else known = false;
      } else if (v == "path") {
        if (key == 'c' && !val.empty()) m.chain = val;
        else if (key == 'p' && f > 0) m.pathPeriod = f;
        else if (key == 'o') m.pathOffset = f; else if (key == 'f') m.pathFace = (int) f;
        else known = false;
      } else if (v == "smoke") {
        if (key == 's' && f > 0) m.smokeScale = f; else known = false;
      } else if (v == "flutter") {
        if (key == 'd') m.flutterDeg = f; else if (key == 'p' && f > 0) m.flutterPeriod = f;
        else if (key == 'a' && (axis == 'x' || axis == 'y' || axis == 'z')) m.flutterHoist = axis;
        else if (key == 'n') m.flutterJoints = std::min(kFlutterMax, std::max(2, (int) f));
        else known = false;
      } else {
        known = false;
      }
      if (!known) bad("key '" + kv + "' of " + v);
    }
  }
  if (m.spinAxis != 'x' && m.spinAxis != 'y' && m.spinAxis != 'z') {
    bad("spin axis");
    m.spinAxis = 'y';
  }
  if (m.swayAxis != 'x' && m.swayAxis != 'y' && m.swayAxis != 'z') {
    bad("sway axis");
    m.swayAxis = 'z';
  }
  if (m.path && m.chain.empty()) bad("path without a chain");
  return true;
}

// A phase in [0, 1) from a seed (the renderer hashes the placement and the
// node), so copies of one part move out of step.
inline float set_motion_phase(uint32_t seed) {
  seed ^= seed >> 16; seed *= 0x7feb352du;
  seed ^= seed >> 15; seed *= 0x846ca68bu;
  seed ^= seed >> 16;
  return (float) (seed >> 8) / 16777216.0f;
}

// A part's phase: its own (`own`, hashed from its spot and slot) or, in step
// (`o`), its placement's (`placement`, hashed from the spot every part of the
// placement shares) plus its offset, so the in-step parts share one clock.
inline float set_motion_part_phase(const SetMotion& m, uint32_t own, uint32_t placement) {
  if (!m.inStep) return set_motion_phase(own);
  const float u = set_motion_phase(placement) + m.step;
  return u - std::floor(u);
}

// One car as the part sees it: its horizontal offset in the part's REST frame
// (x forward, z to the side; any length) and its distance in world units.
struct SetMotionCar { float x, z, dist; };

// The in-place pose: angles in radians about the part's own axes, lift in its
// own units. The renderer composes rest * T(0, lift, 0) * Ry(yaw) * sway * spin
// * Rx(roll).
struct SetMotionPose { float yaw = 0, sway = 0, spin = 0, roll = 0, lift = 0; };

inline float set_motion_falloff(float d, float r, float inner) {
  if (r <= 0) return 0;
  const float t = std::min(1.0f, std::max(0.0f, (r - d) / (r - inner)));
  return t * t * (3 - 2 * t);
}

// One swing out and back, eased at both ends, in the first (1 - rest) of a
// period, then still: 0 at rest, 1 at the top. `u` is the clock in periods.
inline float set_motion_once(float u, float rest) {
  constexpr float TAU = 6.28318530718f;
  const float a = 1 - rest;
  u -= std::floor(u);
  return u < a ? 0.5f - 0.5f * std::cos(TAU * u / a) : 0.0f;
}

inline SetMotionPose set_motion_pose(const SetMotion& m, float t, float phase,
    const SetMotionCar* cars, size_t nCars) {
  constexpr float TAU = 6.28318530718f, DEG = 0.0174532925f;
  SetMotionPose p;
  if (m.spin) p.spin = m.spinRate * t + (m.spinPinned ? m.spinTurn : phase) * TAU;
  if (m.sway) {
    p.sway = m.swayRest < 0 ? m.swayDeg * DEG * std::sin(TAU * (t / m.swayPeriod + phase))
                            : m.swayDeg * DEG * set_motion_once(t / m.swayPeriod + phase, m.swayRest);
  }
  if (m.bob) {
    const float u = t / m.bobPeriod + phase;
    p.lift += m.bobHeight * (m.bobBounce ? std::fabs(std::sin(0.5f * TAU * u))
                             : m.bobRest > 0 ? set_motion_once(u, m.bobRest)
                                             : 0.5f - 0.5f * std::cos(TAU * u));
  }
  if (m.waddle) {
    const float w = TAU * (t / m.waddlePeriod + phase);
    p.roll = m.waddleDeg * DEG * std::sin(w);
    p.lift += 0.05f * std::fabs(std::cos(w));   // up on each foot as it rocks over
  }
  if (m.watch && nCars) {
    // Each car in reach asks for its own bearing, clamped, and faded out over
    // the 60 degrees behind the part; the turn is the weighted mean of those
    // asks, divided by at least 1 so it fades in with the first car. Every term
    // is continuous in where the cars are, so no pair of cars (one ahead, one
    // behind, or abreast on either side) can flip the head between frames.
    // Averaging DIRECTIONS instead lets opposed cars cancel to a sideways
    // resultant that jumps to the clamp.
    const float lim = m.watchDeg * DEG;
    float num = 0, sum = 0;
    for (size_t i = 0; i < nCars; i++) {
      const float w = set_motion_falloff(cars[i].dist, m.watchRadius, 0.4f * m.watchRadius);
      if (w <= 0 || cars[i].x * cars[i].x + cars[i].z * cars[i].z < 1e-8f) continue;
      const float to = std::atan2(-cars[i].z, cars[i].x);   // a turn about +y takes +x toward -z
      const float front = std::min(1.0f, std::max(0.0f, (3.14159265f - std::fabs(to)) / (60 * DEG)));
      num += w * front * std::min(lim, std::max(-lim, to));
      sum += w * front;
    }
    p.yaw = num / std::max(1.0f, sum);
  }
  if (m.hop && nCars) {
    float near = 0;
    for (size_t i = 0; i < nCars; i++) {
      near = std::max(near, set_motion_falloff(cars[i].dist, m.hopRadius, 0.35f * m.hopRadius));
    }
    p.lift += m.hopHeight * near * std::fabs(std::sin(3.14159265f * (t / m.hopPeriod + phase)));
  }
  return p;
}

// ---- flutter ---------------------------------------------------------------

// A cloth's own frame, in its node's (pivot at the origin): `u` along the fly,
// `h` along the hoist (the line a ripple bends about), `n` its normal, and
// how far it reaches along `u`.
struct SetFlutterFrame {
  float u[3] = { 1, 0, 0 }, h[3] = { 0, 1, 0 }, n[3] = { 0, 0, 1 };
  float len = 0;
};

// The frame of a cloth from its vertices (`stride` floats apart): the fly is
// the way it spreads most and the normal the way it spreads least, so a
// plate built along any two axes, kinked or chamfered, reads the same (a hung
// pennant's fly points down); one near as tall as it flies flies sideways.
// `hoist` ('x', 'y', 'z') names the hoist's axis instead, and the fly is the
// wider way across it.
namespace flutter_detail {
// The two unit axes across `w` the points spread along most (`wide`) and
// least (`thin`), from their covariance.
inline void across(const double cov[3][3], const double* w, double* wide, double* thin) {
  const int least = std::fabs(w[0]) < std::fabs(w[1]) ? (std::fabs(w[0]) < std::fabs(w[2]) ? 0 : 2)
                                                       : (std::fabs(w[1]) < std::fabs(w[2]) ? 1 : 2);
  double e1[3] = { 0, 0, 0 }, e2[3];
  e1[least] = 1;
  const double d1 = e1[0] * w[0] + e1[1] * w[1] + e1[2] * w[2];
  for (int a = 0; a < 3; a++) e1[a] -= d1 * w[a];
  const double l1 = std::sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
  for (double& v : e1) v /= l1;
  e2[0] = w[1] * e1[2] - w[2] * e1[1];
  e2[1] = w[2] * e1[0] - w[0] * e1[2];
  e2[2] = w[0] * e1[1] - w[1] * e1[0];
  double a11 = 0, a12 = 0, a22 = 0;
  for (int a = 0; a < 3; a++) {
    for (int b = 0; b < 3; b++) {
      a11 += e1[a] * cov[a][b] * e1[b];
      a12 += e1[a] * cov[a][b] * e2[b];
      a22 += e2[a] * cov[a][b] * e2[b];
    }
  }
  const double at = 0.5 * std::atan2(2 * a12, a11 - a22);
  const double cs = std::cos(at), sn = std::sin(at);
  for (int a = 0; a < 3; a++) {
    wide[a] = cs * e1[a] + sn * e2[a];
    thin[a] = cs * e2[a] - sn * e1[a];
  }
}
}  // namespace flutter_detail

inline SetFlutterFrame set_motion_flutter_frame(const float* xyz, size_t count, size_t stride,
    char hoist = 0) {
  SetFlutterFrame f;
  if (!count) return f;
  double c[3] = { 0, 0, 0 }, cov[3][3] = {};
  for (size_t i = 0; i < count; i++) for (int a = 0; a < 3; a++) c[a] += xyz[i * stride + a];
  for (double& v : c) v /= (double) count;
  for (size_t i = 0; i < count; i++) {
    for (int a = 0; a < 3; a++) {
      for (int b = 0; b < 3; b++) {
        cov[a][b] += (xyz[i * stride + a] - c[a]) * (xyz[i * stride + b] - c[b]);
      }
    }
  }
  double u[3] = { 0.62, 0.48, 0.62 }, h[3] = { 0, 0, 0 }, n[3];
  if (hoist == 'x' || hoist == 'y' || hoist == 'z') {
    h[hoist - 'x'] = 1;
    flutter_detail::across(cov, h, u, n);
  } else {
    // The covariance's largest axis, by power iteration.
    for (int it = 0; it < 48; it++) {
      double v[3];
      for (int a = 0; a < 3; a++) v[a] = cov[a][0] * u[0] + cov[a][1] * u[1] + cov[a][2] * u[2];
      const double l = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      if (!(l > 1e-12)) break;
      for (int a = 0; a < 3; a++) u[a] = v[a] / l;
    }
    flutter_detail::across(cov, u, h, n);
    // A cloth near as tall as it flies has no longer way to speak of (a kit
    // flag, a kinked slab: the axes come out anywhere in its plane), and it
    // flies sideways: the fly is the level way across its plane.
    const auto spread = [&](const double* w) {
      double v = 0;
      for (int a = 0; a < 3; a++) for (int b = 0; b < 3; b++) v += w[a] * cov[a][b] * w[b];
      return v;
    };
    const double level[3] = { n[2], 0, -n[0] };   // n x up
    const double ll = std::sqrt(level[0] * level[0] + level[2] * level[2]);
    if (spread(h) > 0.5 * spread(u) && ll > 0.4) {
      for (int a = 0; a < 3; a++) u[a] = level[a] / ll;
      h[0] = n[1] * u[2] - n[2] * u[1];
      h[1] = n[2] * u[0] - n[0] * u[2];
      h[2] = n[0] * u[1] - n[1] * u[0];
    }
  }
  if (u[0] * c[0] + u[1] * c[1] + u[2] * c[2] < 0) for (double& v : u) v = -v;   // off the pivot
  n[0] = u[1] * h[2] - u[2] * h[1];
  n[1] = u[2] * h[0] - u[0] * h[2];
  n[2] = u[0] * h[1] - u[1] * h[0];
  double len = 0;
  for (size_t i = 0; i < count; i++) {
    len = std::max(len, xyz[i * stride] * u[0] + xyz[i * stride + 1] * u[1] + xyz[i * stride + 2] * u[2]);
  }
  for (int a = 0; a < 3; a++) {
    f.u[a] = (float) u[a];
    f.h[a] = (float) h[a];
    f.n[a] = (float) n[a];
  }
  f.len = (float) len;
  return f;
}

// How joint `k` of a cloth bends at `t` (0 is the hoist): `out` about the
// hoist line, the ripple running down the fly, and `dip` about the cloth's
// normal, its edge rising and falling; radians. Bounded by 1.5 and 0.9 of
// the part's `d`.
inline void set_motion_flutter_bend(const SetMotion& m, float t, float phase, int k,
    float& out, float& dip) {
  constexpr float TAU = 6.28318530718f, DEG = 0.0174532925f;
  const int n = m.flutterJoints;
  // The ripple runs twice a beat; the phase is spread over the gust's and the
  // veer's longer ones too.
  const float u = 2.0f * t / m.flutterPeriod + 9.0f * phase;
  const float lag = (float) k / (1.2f * (float) n);   // a ripple a little longer than the cloth
  const float gust = 0.6f + 0.25f * std::sin(TAU * (0.23f * u + 0.37f))
                     + 0.15f * std::sin(TAU * (0.41f * u + 0.11f));
  // The hoist is held, the free end whips.
  const float grow = k == 0 ? 0.5f : 0.6f + 0.4f * (float) k / (float) std::max(1, n - 1);
  const float amp = m.flutterDeg * DEG * gust * grow;
  out = amp * (0.72f * std::sin(TAU * (u - lag))
               + 0.28f * std::sin(TAU * (1.71f * u - 1.37f * lag) + 1.9f));
  dip = 0.9f * amp * std::sin(TAU * (0.83f * u - 0.9f * lag) + 0.8f);
  if (k == 0) out += 0.5f * m.flutterDeg * DEG * std::sin(TAU * (0.13f * u + 0.6f));   // the wind veers
}

// Where each cut of the cloth is at `t`: joint j (0..n, n the free end) at
// `pos` in the node's frame, turned by `rot` (column-major). A vertex that
// stood on cut j, at `v`, stands at pos + rot (v - (j / n) len u): the
// segments keep their length, so the cloth bends and never stretches.
struct SetFlutterJoint { float pos[3]; float rot[9]; };

namespace flutter_detail {
// r = Rodrigues(axis, angle) * v
inline void turn(const float* axis, float angle, const float* v, float* r) {
  const float c = std::cos(angle), s = std::sin(angle);
  const float d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const float x[3] = { axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2],
                       axis[0] * v[1] - axis[1] * v[0] };
  for (int a = 0; a < 3; a++) r[a] = v[a] * c + x[a] * s + axis[a] * d * (1 - c);
}
// r = turn(h, out) turn(n, dip) v
inline void bend(const SetFlutterFrame& f, float out, float dip, const float* v, float* r) {
  float w[3];
  turn(f.n, dip, v, w);
  turn(f.h, out, w, r);
}
}  // namespace flutter_detail

inline void set_motion_flutter_joints(const SetMotion& m, const SetFlutterFrame& f, float t,
    float phase, SetFlutterJoint* joints) {
  const int n = m.flutterJoints;
  float out[kFlutterMax + 1], dip[kFlutterMax + 1];   // each SEGMENT's heading: the bends summed
  float so = 0, sd = 0;
  for (int k = 0; k < n; k++) {
    float o, d;
    set_motion_flutter_bend(m, t, phase, k, o, d);
    out[k] = so += o;
    dip[k] = sd += d;
  }
  float at[3] = { 0, 0, 0 };
  const float seg = f.len / (float) n;
  for (int j = 0; j <= n; j++) {
    // A cut turns with the mean of the two segments it joins.
    const int a = std::max(0, j - 1), b = std::min(n - 1, j);
    const float o = 0.5f * (out[a] + out[b]), d = 0.5f * (dip[a] + dip[b]);
    SetFlutterJoint& q = joints[j];
    for (int c = 0; c < 3; c++) {
      q.pos[c] = at[c];
      const float e[3] = { c == 0 ? 1.0f : 0.0f, c == 1 ? 1.0f : 0.0f, c == 2 ? 1.0f : 0.0f };
      flutter_detail::bend(f, o, d, e, q.rot + 3 * c);
    }
    if (j < n) {
      float dir[3];
      flutter_detail::bend(f, out[j], dip[j], f.u, dir);
      for (int c = 0; c < 3; c++) at[c] += seg * dir[c];
    }
  }
}

// How far round its path a traveller is, as a fraction of the loop in [0, 1).
inline float set_motion_path_at(const SetMotion& m, float t) {
  const float u = t / m.pathPeriod + m.pathOffset;
  return u - std::floor(u);
}

}  // namespace rt
}  // namespace ttp
