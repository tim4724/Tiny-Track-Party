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
//   anim_waddle+watch+hop#2      a penguin: rock, turn to the cars, hop
//   anim_path:c=chute:p=7.5:o=0.33   ride the closed path `chute`, a third on
//   anim_smoke                   (mesh-less) where a chimney's smoke rises from
//
// An `anim_` node inside another rides on it: it moves in its parent's moving
// frame (a wind-up key turning in a walking robot's back). A path rides
// nothing: its loop is where the piece stands.
//
// A path is the empties `path_<chain>_<k>` of the same GLB, k = 0, 1, ... in
// order, closed back to 0. A traveller may also spin and bob in its own frame
// on the way (`anim_path:c=wash+spin:a=z:w=-4+bob:h=0.3:p=0.7`, a tumbleweed);
// the other verbs are in-place and a path ignores them. Lengths are the node's own units (a GLB's grow and the
// placement's scale carry them); radii are WORLD units, because they are about
// cars. Keys: a axis (x|y|z), w rad/s, d degrees, p seconds, h height, r radius,
// c chain, o phase offset (0..1), f facing for a path (0 rest, 1 yaw, 2 full).
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
       hop = false, path = false, smoke = false;
  char spinAxis = 'y';
  float spinRate = 1.0f;                     // rad/s, signed
  char swayAxis = 'z';
  float swayDeg = 25.0f, swayPeriod = 2.0f;  // a sway under ~20 degrees does not read
  float bobHeight = 0.2f, bobPeriod = 3.0f;
  float waddleDeg = 12.0f, waddlePeriod = 0.9f;
  float watchRadius = 26.0f, watchDeg = 60.0f;
  float hopRadius = 9.0f, hopHeight = 0.35f, hopPeriod = 0.5f;
  std::string chain;
  float pathPeriod = 8.0f, pathOffset = 0.0f;
  int pathFace = 2;
  bool inStep = false;   // `o` on an in-place verb: phase = the placement's + `step`
  float step = 0.0f;
  // A part that TRAVELS leaves the sun bake: a shadow baked at its rest spot
  // would stay behind. One that moves in place keeps its rest-pose shadow, which
  // under the near-overhead sun is its footprint.
  bool travels() const { return path; }
  bool any() const { return spin || sway || bob || waddle || watch || hop || path; }
};

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
             : v == "path" ? &m.path : v == "smoke" ? &m.smoke : nullptr;
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
        if (key == 'a') m.spinAxis = axis; else if (key == 'w') m.spinRate = f; else known = false;
      } else if (key == 'o' && (v == "sway" || v == "bob" || v == "waddle")) {
        m.inStep = true;
        m.step = f;
      } else if (v == "sway") {
        if (key == 'a') m.swayAxis = axis; else if (key == 'd') m.swayDeg = f;
        else if (key == 'p' && f > 0) m.swayPeriod = f; else known = false;
      } else if (v == "bob") {
        if (key == 'h') m.bobHeight = f; else if (key == 'p' && f > 0) m.bobPeriod = f;
        else known = false;
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

inline SetMotionPose set_motion_pose(const SetMotion& m, float t, float phase,
    const SetMotionCar* cars, size_t nCars) {
  constexpr float TAU = 6.28318530718f, DEG = 0.0174532925f;
  SetMotionPose p;
  if (m.spin) p.spin = m.spinRate * t + phase * TAU;
  if (m.sway) p.sway = m.swayDeg * DEG * std::sin(TAU * (t / m.swayPeriod + phase));
  if (m.bob) p.lift += m.bobHeight * (0.5f - 0.5f * std::cos(TAU * (t / m.bobPeriod + phase)));
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

// How far round its path a traveller is, as a fraction of the loop in [0, 1).
inline float set_motion_path_at(const SetMotion& m, float t) {
  const float u = t / m.pathPeriod + m.pathOffset;
  return u - std::floor(u);
}

}  // namespace rt
}  // namespace ttp
