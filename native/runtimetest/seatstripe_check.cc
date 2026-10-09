// seatstripe_check — the player stripe's fit (ttp/seat_stripe.h) on the cars
// that ship. The fit is measured, not authored, so what this holds is that the
// measurement still says what the eye asked for on these four models:
//
//   * the three spoilered cars (Dash, Bolt, Carve) get a spoiler cut, and
//     Rumble, which has none, does not;
//   * the cut takes the spoiler and leaves the rear deck under it striped;
//   * Rumble's narrow body wears a visibly narrower stripe than the coupés.
//
// Usage: seatstripe_check <assetDir>   (public/assets/toycar)

#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "ttp/seat_stripe.h"

using ttp::rt::GlbMeshNode;
using ttp::rt::SeatStripe;

namespace {

int checked = 0, failed = 0;

void expect(bool ok, const std::string& what) {
  checked++;
  if (ok) return;
  failed++;
  std::fprintf(stderr, "FAIL %s\n", what.c_str());
}

std::vector<GlbMeshNode> load(const std::string& dir, const char* model) {
  std::ifstream in(dir + "/" + model + ".glb", std::ios::binary);
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return ttp::rt::read_glb_meshes(bytes.data(), bytes.size());
}

// Rear paint vertices on either side of the cut.
void countRear(const std::vector<GlbMeshNode>& nodes, const SeatStripe& s, int& cut, int& kept) {
  cut = kept = 0;
  const GlbMeshNode& body = nodes[0];
  for (const auto& p : body.prims) {
    for (size_t i = 0; i < p.pos.size() / 3; i++) {
      const float y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
      if (z < 0.2f || !ttp::rt::seat_stripe_paint(p.uv[i * 2], p.uv[i * 2 + 1])) continue;
      (z > s.cutZ && y > s.cutY ? cut : kept)++;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: seatstripe_check <assetDir>\n");
    return 2;
  }
  const std::string dir = argv[1];
  const char* spoilered[] = { "vehicle-racer-low", "vehicle-speedster", "vehicle-racer" };
  float coupe = 0;
  for (const char* m : spoilered) {
    const auto nodes = load(dir, m);
    expect(!nodes.empty(), std::string(m) + ": reads");
    if (nodes.empty()) continue;
    const SeatStripe s = ttp::rt::measure_seat_stripe(nodes);
    expect(s.cutZ < 1.0f && s.cutY < 1.0f, std::string(m) + ": has a spoiler cut");
    int cut = 0, kept = 0;
    countRear(nodes, s, cut, kept);
    expect(cut > 0, std::string(m) + ": the cut takes the spoiler's paint");
    expect(kept > 0, std::string(m) + ": the rear deck under the spoiler stays striped");
    if (std::string(m) == "vehicle-racer-low") coupe = s.half;
  }
  const auto rumble = load(dir, "vehicle-vintage-racer");
  expect(!rumble.empty(), "vehicle-vintage-racer: reads");
  if (!rumble.empty()) {
    const SeatStripe s = ttp::rt::measure_seat_stripe(rumble);
    expect(s.cutZ > 1.0f, "vehicle-vintage-racer: no spoiler, no cut");
    expect(s.half < 0.8f * coupe, "vehicle-vintage-racer: a narrower stripe than the coupe's");
  }
  std::printf("seatstripe: %d checks, %d failed\n", checked, failed);
  return failed ? 1 : 0;
}
