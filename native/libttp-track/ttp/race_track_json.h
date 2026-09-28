// race_track_json — the ONE serializer for the augmented race-track object
// (docs/native-port/contract/race-track.schema.json), in two number spellings.
//
// WHY ONE FILE AND NOT TWO. Two callers want this tree:
//
//   * trackbuilder_check diffs it against tests/fixtures/trackbuilder-corpus.jsonl
//     — the FROZEN, JS-recorded oracle — in "hexJSON", where every number is
//     x<16-hex big-endian IEEE-754 bits> so no decimal formatting sits on either
//     side of the comparison.
//   * ttp_track_json hands it to the Node authoring + codegen scripts, which want
//     ordinary JSON.parse-able decimals.
//
// Same tree, same key order, same array shapes; only the number spelling differs.
// Keeping them in one place is what lets the ABI's serializer inherit the frozen
// corpus's evidence: if this walk ever stops matching what the retired JS builder
// emitted, the corpus check goes red, and it is the SAME walk the scripts read.
// (The decimal spelling carries its own proof separately — js_number_to_string is
// gated byte-for-byte by the 52,357-case json-number corpus.)
//
// Key order is SORTED at every level, matching canonicalStringify — the order the
// corpus was recorded in, and the order JSON.stringify-with-sorted-keys produces.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "ttp/trackbuilder.h"
#include "ttp/vec3.h"

namespace ttp {
namespace rtjson {

// How to spell a double. Called once per number on a once-per-track path, so the
// indirection is free; nothing here is on a frame path.
using NumFn = void (*)(std::string&, double);

// x<16 lowercase hex> — the frozen corpus encoding.
void hex_number(std::string& out, double v);

// Ordinary JSON decimals, for a tree that will be JSON.parse'd.
//
// This is js_number_to_string (JSON.stringify's shortest round-tripping form)
// with ONE deliberate deviation: negative zero is written "-0", where
// JSON.stringify writes "0". JSON.parse reads "-0" back as -0, so the deviation
// makes the round trip exact; without it every -0 in the geometry — and the
// builder produces them, on any sample whose lateral or tangent has a zeroed
// component approached from below — silently becomes +0 on the far side.
//
// Nothing compares these bytes against a JS-recorded fixture (the frozen corpus
// is hexJSON), so matching JSON.stringify byte-for-byte buys nothing here, while
// losing a sign bit buys a class of "why does the tool disagree with the engine"
// that is very hard to see. Exactness wins.
void decimal_number(std::string& out, double v);

class Writer {
 public:
  explicit Writer(NumFn num) : num_(num) {}

  // One top-level key's VALUE. Returns "" for a key this serializer cannot emit,
  // which is how the corpus check turns schema drift into a hard error instead of
  // a silent skip.
  std::string topKey(const RaceTrack& b, const std::string& key) const;

  // The whole object: every top-level key, in sorted order.
  std::string object(const RaceTrack& b) const;

  // Sample windows, exposed so a centerline mismatch can be localized to the
  // diverging 64-sample chunk rather than reported as one opaque hash.
  void samples(std::string& o, const std::vector<OutSample>& v, size_t from, size_t to) const;

  // Furniture arrays, exposed for the same reason (a direct diff beats a hash).
  std::string hazards(const std::vector<Hazard>& v) const;
  std::string boxes(const std::vector<Box>& v) const;
  std::string bananas(const std::vector<Banana>& v) const;
  std::string pads(const std::vector<Pad>& v) const;
  std::string poles(const std::vector<Pole>& v) const;
  std::string autoPoles(const std::vector<AutoPole>& v) const;

 private:
  void n(std::string& o, double v) const { num_(o, v); }
  void vec(std::string& o, const Vec3& v) const;
  void sample(std::string& o, const OutSample& s) const;

  NumFn num_;
};

}  // namespace rtjson
}  // namespace ttp
