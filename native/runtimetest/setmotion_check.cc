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
//      the part (behind it included) or when two cars pull it opposite ways,
//      and rests when no car is in reach.
//   4. A HOP lifts only while a car is close, and never past its height.
//   5. THE SHIPPED PIECES SAY WHAT THEY MEAN: in every set-*.glb, each `anim_`
//      node parses with no unknown verb or key (a typo parses to a part that
//      stands still, and nothing else would notice), does something, and a
//      path names a chain of two or more distinct points.
//
// Usage: setmotion_check [public/assets/toycar]

#include <dirent.h>

#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <map>
#include <vector>
#include <string>

#include "ttp/glb_mesh.h"
#include "ttp/json_parse.h"
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

// 5. Every `anim_` node of one set piece.
void checkPiece(const std::string& path, const std::string& label) {
  std::ifstream f(path, std::ios::binary);
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::string json;
  ttp::Value doc;
  if (!ttp::rt::glb_json_chunk(bytes.data(), bytes.size(), json)
      || !ttp::json::Parser(json).parse(doc) || doc.type != ttp::Value::OBJ) {
    check(false, label + " reads as a GLB");
    return;
  }
  const ttp::Value* nodes = doc.find("nodes");
  if (!nodes) return;
  // Chains first: `path_<chain>_<k>` by their translation (siblings under the
  // piece's root, so their local spots are the loop's shape).
  std::map<std::string, std::vector<std::vector<double>>> chains;
  for (const ttp::Value& n : nodes->arr) {
    const ttp::Value* nm = n.find("name");
    if (!nm || nm->str.compare(0, 5, "path_") != 0) continue;
    const size_t us = nm->str.rfind('_');
    std::vector<double> t{ 0, 0, 0 };
    if (const ttp::Value* tr = n.find("translation")) {
      for (size_t i = 0; i < 3 && i < tr->arr.size(); i++) t[i] = tr->arr[i].num;
    }
    chains[nm->str.substr(5, us - 5)].push_back(t);
  }
  for (const ttp::Value& n : nodes->arr) {
    const ttp::Value* nm = n.find("name");
    if (!nm || !ttp::rt::is_set_motion_name(nm->str.c_str())) continue;
    SetMotion m;
    std::string unknown;
    ttp::rt::parse_set_motion(nm->str.c_str(), m, &unknown);
    const std::string who = label + " " + nm->str;
    check(unknown.empty(), who + " has no unknown verb or key (" + unknown + ")");
    check(m.any() || m.smoke, who + " does something");
    if (!m.path) continue;
    const auto c = chains.find(m.chain);
    double loop = 0;
    if (c != chains.end()) {
      const auto& p = c->second;
      for (size_t i = 0; i < p.size(); i++) {
        const auto& a = p[i];
        const auto& b = p[(i + 1) % p.size()];
        loop += std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])
                          + (a[2] - b[2]) * (a[2] - b[2]));
      }
    }
    check(c != chains.end() && c->second.size() >= 2 && loop > 1e-3,
          who + " rides a chain of two or more distinct points");
  }
}

}  // namespace

int main(int argc, char** argv) {
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
  // Two cars: one ahead and one behind sliding past the part side by side, and
  // two abreast on opposite sides sliding forward. Averaged directions cancel
  // to a sideways resultant here and flip the head to the clamp in one step.
  const float lanes[][4] = { { 8, -8, 1, 1 }, { 8, -8, 1, -1 }, { 0, 0, 8, -8 } };
  for (const auto& l : lanes) {
    worst = 0;
    for (int i = 0; i <= 2000; i++) {
      const float s = -10 + i * 0.01f;   // 0.01 u a step, under a frame of driving
      SetMotionCar two[2];
      for (int k = 0; k < 2; k++) {
        const float x = l[k] != 0 ? l[k] : s, z = l[k] != 0 ? s * l[2 + k] : l[2 + k];
        two[k] = SetMotionCar{ x, z, std::sqrt(x * x + z * z) };
      }
      const float y = ttp::rt::set_motion_pose(m, 0, 0, two, 2).yaw;
      check(std::fabs(y) <= 60 * DEG + 1e-5f, "the clamp holds with two cars");
      if (i) worst = std::max(worst, std::fabs(y - prev));
      prev = y;
    }
    check(worst < 2 * DEG, "two cars on opposite sides never snap the head (worst step "
          + std::to_string(worst / DEG) + " deg)");
  }

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

  // 6. A gesture moves out and back once in its share of the period, never
  // past its angle and never the other way, and rests for the rest; a
  // bouncing bob touches down every period and never passes its height.
  check(ttp::rt::parse_set_motion("anim_gesture:a=x:d=50:p=4:k=0.25#arm", m)
            && m.gesture && m.gestureAxis == 'x' && near(m.gestureDeg, 50)
            && near(m.gesturePeriod, 4) && near(m.gestureShare, 0.25f), "gesture parameters");
  float most = 0, least = 0, still = 0;
  for (int i = 0; i < 800; i++) {
    const float g = ttp::rt::set_motion_pose(m, i * 0.01f, 0, nullptr, 0).gesture;
    most = std::max(most, g);
    least = std::min(least, g);
    if (i * 0.01f > 1.0f + 1e-4f && i * 0.01f < 4.0f - 1e-4f) still = std::max(still, std::fabs(g));
  }
  check(most > 49 * DEG && most <= 50 * DEG + 1e-6f && least >= 0, "a gesture reaches its angle, one way");
  check(still == 0, "a gesture rests outside its share");
  check(near(ttp::rt::set_motion_pose(m, 0.5f, 0, nullptr, 0).gesture, 50 * DEG, 1e-4f),
        "a gesture peaks halfway through its move");
  ttp::rt::parse_set_motion("anim_bob:h=0.2:p=0.5:b=1", m);
  float high = 0;
  for (int i = 0; i < 100; i++) high = std::max(high, ttp::rt::set_motion_pose(m, i * 0.01f, 0, nullptr, 0).lift);
  check(m.bobBounce && high > 0.19f && high <= 0.2f + 1e-6f, "a bounce never passes its height");
  check(near(ttp::rt::set_motion_pose(m, 1.0f, 0, nullptr, 0).lift, 0, 1e-5f)
            && near(ttp::rt::set_motion_pose(m, 0.25f, 0, nullptr, 0).lift, 0.2f, 1e-5f),
        "a bounce lands every period and tops out between");

  check(ttp::rt::parse_set_motion("anim_swing+sway:deg=30", m) && m.sway && near(m.swayDeg, 25),
        "a typo'd verb or key changes nothing");
  std::string unknown;
  ttp::rt::parse_set_motion("anim_swing+sway:deg=30:d=22", m, &unknown);
  check(unknown == "verb 'swing', key 'deg=30' of sway" && near(m.swayDeg, 22),
        "and is reported (" + unknown + ")");
  unknown.clear();
  ttp::rt::parse_set_motion("anim_waddle+watch:r=30+hop:r=14:h=0.4#3", m, &unknown);
  check(unknown.empty(), "the penguin reports nothing");

  // 5. The shipped pieces.
  int pieces = 0;
  if (argc > 1) {
    if (DIR* d = opendir(argv[1])) {
      while (const dirent* e = readdir(d)) {
        const std::string name = e->d_name;
        if (name.compare(0, 4, "set-") != 0 || name.size() < 8
            || name.compare(name.size() - 4, 4, ".glb") != 0) continue;
        checkPiece(std::string(argv[1]) + "/" + name, name);
        pieces++;
      }
      closedir(d);
    }
    check(pieces > 0, std::string("set pieces found under ") + argv[1]);
  }

  std::printf("setmotion: %d checks, %d failures, %d pieces\n", checks, failures, pieces);
  return failures ? 1 : 0;
}
