// setmotion_check — the set pieces' `anim_` grammar and poses (ttp/set_motion.h).
//
// A BEHAVIOURAL gate like kitfield_check: the motion has no JS twin and no
// corpus. What it holds is what a moving part is useless or ugly without:
//
//   1. THE NAMES PARSE as the builders write them, a tag and an unknown verb
//      included, and a name that is not `anim_` is not a part.
//   2. A POSE IS A FUNCTION of its inputs: no hidden state, so an undrawn wind
//      and a restarted race see the same thing.
//   3. A TURN TO WATCH never passes its clamp, never snaps when a car circles
//      the part (behind it included), and rests when no car is in reach.
//   4. A HOP lifts only while a car is close, and never past its height.
//
// Usage: setmotion_check   (no arguments)

#include <cmath>
#include <cstdio>
#include <string>

#include "ttp/set_motion.h"

using ttp::rt::SetMotion;
using ttp::rt::SetMotionCar;
using ttp::rt::SetMotionPose;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& what) {
  checks++;
  if (!ok) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
  }
}

bool near(float a, float b, float eps = 1e-5f) { return std::fabs(a - b) <= eps; }

}  // namespace

int main() {
  constexpr float DEG = 0.0174532925f;
  SetMotion m;

  // 1. The grammar.
  check(!ttp::rt::parse_set_motion("Cube.003", m), "a plain node is not a part");
  check(!ttp::rt::parse_set_motion(nullptr, m), "no name is not a part");
  check(ttp::rt::parse_set_motion("anim_waddle+watch+hop#7", m)
            && m.waddle && m.watch && m.hop && !m.spin && !m.path, "the penguin's verbs");
  check(ttp::rt::parse_set_motion("anim_spin:a=x:w=-2.5", m)
            && m.spin && m.spinAxis == 'x' && near(m.spinRate, -2.5f), "spin with axis and rate");
  check(ttp::rt::parse_set_motion("anim_sway:a=y:d=30:p=1.6#3", m)
            && m.sway && m.swayAxis == 'y' && near(m.swayDeg, 30) && near(m.swayPeriod, 1.6f),
        "sway parameters, tag dropped");
  check(ttp::rt::parse_set_motion("anim_path:c=chute:p=7.5:o=0.33:f=1", m)
            && m.path && m.chain == "chute" && near(m.pathPeriod, 7.5f)
            && near(m.pathOffset, 0.33f) && m.pathFace == 1 && m.travels(), "a path traveller");
  check(ttp::rt::parse_set_motion("anim_wobble+bob:h=0.3:q=9", m)
            && m.bob && near(m.bobHeight, 0.3f) && !m.travels(), "an unknown verb and key are skipped");
  check(ttp::rt::parse_set_motion("anim_spin:a=q", m) && m.spinAxis == 'y', "a bad axis falls back to y");
  check(ttp::rt::parse_set_motion("anim_smoke", m) && m.smoke && !m.any(), "smoke is a marker, not a motion");

  // 2. Purity and the clock.
  ttp::rt::parse_set_motion("anim_waddle+watch+hop", m);
  const SetMotionCar car{ 3, 1, 4 };
  const SetMotionPose a = ttp::rt::set_motion_pose(m, 12.3f, 0.4f, &car, 1);
  const SetMotionPose b = ttp::rt::set_motion_pose(m, 12.3f, 0.4f, &car, 1);
  check(a.yaw == b.yaw && a.roll == b.roll && a.lift == b.lift, "a pose is a function of its inputs");
  ttp::rt::parse_set_motion("anim_spin:w=2", m);
  check(near(ttp::rt::set_motion_pose(m, 3, 0, nullptr, 0).spin
                 - ttp::rt::set_motion_pose(m, 1, 0, nullptr, 0).spin, 4), "spin turns at its rate");
  ttp::rt::parse_set_motion("anim_path:p=4:o=0.75", m);
  for (float t : { 0.0f, 0.99f, 1.0f, 7.3f, 1e4f }) {
    const float u = ttp::rt::set_motion_path_at(m, t);
    check(u >= 0 && u < 1, "a path position stays in [0, 1) at t=" + std::to_string(t));
  }

  // 3. Watching.
  ttp::rt::parse_set_motion("anim_watch:r=20:d=60", m);
  check(ttp::rt::set_motion_pose(m, 0, 0, nullptr, 0).yaw == 0, "no car, no turn");
  const SetMotionCar far{ 0, 5, 25 };
  check(ttp::rt::set_motion_pose(m, 0, 0, &far, 1).yaw == 0, "a car out of reach is ignored");
  const SetMotionCar ahead{ 5, 0, 5 };
  check(near(ttp::rt::set_motion_pose(m, 0, 0, &ahead, 1).yaw, 0), "a car dead ahead is looked at straight");
  const SetMotionCar side{ 0, -5, 5 };   // -z is where +x turns to under a +y turn
  check(near(ttp::rt::set_motion_pose(m, 0, 0, &side, 1).yaw, 60 * DEG, 1e-4f), "the turn stops at its clamp");
  const SetMotionCar behind{ -5, 0, 5 };
  check(near(ttp::rt::set_motion_pose(m, 0, 0, &behind, 1).yaw, 0, 1e-4f), "a car behind fades the turn out");
  float prev = 0, worst = 0;
  for (int i = 0; i <= 3600; i++) {
    const float th = (float) i / 3600.0f * 6.28318530718f;
    const SetMotionCar c{ 6 * std::cos(th), -6 * std::sin(th), 6 };
    const float y = ttp::rt::set_motion_pose(m, 0, 0, &c, 1).yaw;
    check(std::fabs(y) <= 60 * DEG + 1e-5f, "the clamp holds round the circle");
    if (i) worst = std::max(worst, std::fabs(y - prev));
    prev = y;
  }
  check(worst < 2 * DEG, "a car circling the part never snaps its head (worst step "
        + std::to_string(worst / DEG) + " deg)");

  // 4. Hopping.
  ttp::rt::parse_set_motion("anim_hop:r=8:h=0.4", m);
  check(ttp::rt::set_motion_pose(m, 0.25f, 0, nullptr, 0).lift == 0, "no car, no hop");
  const SetMotionCar close{ 1, 0, 1 };
  float top = 0;
  for (int i = 0; i < 200; i++) {
    top = std::max(top, ttp::rt::set_motion_pose(m, i * 0.01f, 0, &close, 1).lift);
  }
  check(top > 0.3f && top <= 0.4f + 1e-6f, "a close car makes it hop, never past its height");
  const SetMotionCar gone{ 9, 0, 9 };
  check(ttp::rt::set_motion_pose(m, 0.25f, 0, &gone, 1).lift == 0, "a car past the radius stops the hops");

  std::printf("setmotion: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
