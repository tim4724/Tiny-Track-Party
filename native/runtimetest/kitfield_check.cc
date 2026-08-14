// kitfield_check — the asset gallery's kit field (ttp/kitfield.h), driven directly.
//
// WHAT THIS IS. A BEHAVIOURAL gate like showcase_check, not conformance
// evidence: the field has no JS twin and no corpus, because nothing has ever
// stood 585 kit models on the ground before. What it holds is the properties the
// field is USELESS without, each of which is a bug you would otherwise only find
// by flying out there and squinting:
//
//   1. NOTHING OVERLAPS. Two models sharing a patch of ground read as one
//      object, which is exactly the judgement the field exists to support.
//   2. NOTHING REORDERS. The spots come back in the order the models went in,
//      because the chrome names what you are looking at by INDEX.
//   3. ROWS STAY INSIDE THEIR WIDTH, and a model too wide for a row still gets
//      one rather than wrapping for ever.
//   4. A FOOTPRINT-LESS MODEL STILL GETS GROUND. Several kit models measure
//      zero on an axis; without a floor they would pile up on one spot.
//
// Usage: kitfield_check   (no arguments)

#include <cstdio>
#include <string>
#include <vector>

#include "ttp/kitfield.h"

using ttp::rt::KitFootprint;
using ttp::rt::KitSpot;

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

// The cell a model actually occupies, floors included — the same rule the
// layout packs by, restated here so an overlap test cannot inherit the bug it
// is looking for from the code under test.
struct Cell {
  float x0, x1, z0, z1;
};

Cell cellOf(const KitFootprint& f, const KitSpot& s) {
  const float w = (f.w > ttp::rt::kKitMinCell ? f.w : ttp::rt::kKitMinCell) * 0.5f;
  const float d = (f.d > ttp::rt::kKitMinCell ? f.d : ttp::rt::kKitMinCell) * 0.5f;
  return { s.x - w, s.x + w, s.z - d, s.z + d };
}

bool overlaps(const Cell& a, const Cell& b) {
  // Touching edges are fine (the gap is what keeps them apart); only a real
  // interior overlap counts, so compare with a hair of tolerance.
  const float E = 1e-4f;
  return a.x0 < b.x1 - E && b.x0 < a.x1 - E && a.z0 < b.z1 - E && b.z0 < a.z1 - E;
}

// A stand-in for a kit: sizes that walk across the range the three kits really
// cover — a coin, a tree, a car, a whole loop piece — plus the degenerate ones.
std::vector<KitFootprint> sampleKit(size_t n) {
  std::vector<KitFootprint> out;
  const float w[] = { 0.4f, 1.0f, 2.2f, 3.6f, 8.0f, 0.0f, 12.0f, 1.7f };
  const float d[] = { 0.4f, 1.2f, 4.4f, 1.1f, 8.0f, 2.0f, 0.0f, 1.7f };
  for (size_t i = 0; i < n; i++) out.push_back({ w[i % 8], d[i % 8] });
  return out;
}

void testNoOverlap() {
  const std::vector<KitFootprint> kit = sampleKit(600);
  const std::vector<KitSpot> spots = ttp::rt::kit_field_layout(kit);
  check(spots.size() == kit.size(), "one spot per model");
  // O(n²) over 600 is nothing here, and it is the honest statement of the
  // property — a neighbours-only check would miss a row walking into the one
  // two above it, which is the failure a deep model actually causes.
  size_t hits = 0;
  for (size_t i = 0; i < spots.size(); i++) {
    for (size_t j = i + 1; j < spots.size(); j++) {
      if (overlaps(cellOf(kit[i], spots[i]), cellOf(kit[j], spots[j]))) hits++;
    }
  }
  check(hits == 0, "no two models stand on the same ground (" + std::to_string(hits) + " pairs)");
}

void testOrderAndRows() {
  const std::vector<KitFootprint> kit = sampleKit(200);
  const std::vector<KitSpot> spots = ttp::rt::kit_field_layout(kit);
  // Order: x runs forward within a row, and rows never go back. Compared on the
  // row's NEAR EDGE, not on the spot — a spot is a footprint centre, so a deep
  // model and a shallow one in the same row sit at different z by construction.
  bool forward = true, monotoneZ = true;
  for (size_t i = 1; i < spots.size(); i++) {
    const float base = cellOf(kit[i], spots[i]).z0, prev = cellOf(kit[i - 1], spots[i - 1]).z0;
    if (base < prev - 1e-4f) monotoneZ = false;
    if (base <= prev + 1e-4f && spots[i].x <= spots[i - 1].x) forward = false;
  }
  check(forward, "a row runs forward in the order the models were given");
  check(monotoneZ, "rows only ever advance");

  // Width: every cell inside the row width, and one model WIDER than a row
  // still gets a row of its own rather than looping.
  bool inside = true;
  for (size_t i = 0; i < spots.size(); i++) {
    if (cellOf(kit[i], spots[i]).x1 > ttp::rt::kKitRowWidth + 1e-3f) inside = false;
  }
  check(inside, "no model overruns the row width");

  const std::vector<KitFootprint> huge = { { 4.0f, 4.0f },
                                           { ttp::rt::kKitRowWidth * 2, 4.0f },
                                           { 4.0f, 4.0f } };
  const std::vector<KitSpot> hugeSpots = ttp::rt::kit_field_layout(huge);
  check(hugeSpots.size() == 3, "an over-wide model does not stall the pack");
  check(hugeSpots[1].z > hugeSpots[0].z, "…it takes a row of its own");
  check(hugeSpots[2].z > hugeSpots[1].z, "…and the next model starts a new one");
}

void testDegenerate() {
  check(ttp::rt::kit_field_layout({}).empty(), "an empty kit lays out empty");
  const std::vector<KitFootprint> flat(6, KitFootprint{ 0.0f, 0.0f });
  const std::vector<KitSpot> spots = ttp::rt::kit_field_layout(flat);
  bool apart = true;
  for (size_t i = 1; i < spots.size(); i++) {
    if (spots[i].x - spots[i - 1].x < ttp::rt::kKitMinCell) apart = false;
  }
  check(apart, "models with no measurable footprint still stand apart");
}

}  // namespace

int main() {
  testNoOverlap();
  testOrderAndRows();
  testDegenerate();

  std::printf("kitfield check: %d assertions, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
