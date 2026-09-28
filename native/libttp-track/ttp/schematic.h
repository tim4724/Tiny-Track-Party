// schematic — the top-down track MAP and its snapshot codec, in C++.
//
// Geometry -> bytes, with no platform anywhere in it. Three things, and they are three different jobs:
//
//   schematic(track)  project a built track's centreline to the X/Z plane and
//                     fit it into a padded 256-unit square as one closed SVG
//                     path. Runs OFFLINE (the maps are baked), and is what a TV
//                     shell with no baked JS would call.
//   pack(d, eps)      the transport codec: simplify with Ramer-Douglas-Peucker,
//                     quantize each survivor to two bytes, base64. A full loop is
//                     ~877 points (~180 KiB of SVG text), far past the relay's
//                     16 KiB set_state cap; packed, the whole 20-track catalogue
//                     lands ~3.9 KiB.
//   unpack(b64)       the phone's half, back to {viewBox, d, start}.
//
// unpack is here for completeness and for the round-trip gate, NOT because a
// shell needs it: phones stay on the JS controller on all three TV platforms, so
// public/shared/schematicCodec.js's unpackSchematic is the one that ships to a
// player. The display's half — pack — is what moved.
//
// FLOATING POINT. The projection is JS Number arithmetic and rounds through
// Number.prototype.toFixed, which is NOT printf: toFixed picks the integer n
// minimizing |n/10^f - x| and breaks ties AWAY from zero, which is exactly
// double-conversion's ToFixed (the same code V8 runs). js_fixed in schematic.cc
// is that call, and the round trip back through strtod reproduces JS's `+(x).toFixed(1)`
// bit for bit. No transcendental appears here except sqrt, which is exact per
// IEEE-754, and hypot on the degenerate-chord path.
//
// CONFORMANCE. tests/fixtures/schematic-corpus.jsonl carries, per shipped track,
// the schematic public/shared/trackSchematics.js was BAKED with (JS-produced,
// committed, and already gated against the live geometry by tests/track.test.js)
// plus the packed bytes packSchematic produced from it. tracktest/
// schematic_check.cc rebuilds each track through this library's own TrackBuilder
// and demands both back. That makes it JS-RECORDED cross-implementation
// evidence, not a C++ self-portrait.
#pragma once

#include <string>
#include <vector>

#include "ttp/trackbuilder.h"

namespace ttp {
namespace schematic {

// The viewBox square == the uint8 range: a coordinate IS a byte, so the pack
// step is an identity map rather than a rescale.
inline constexpr int VIEW = 256;
// Inset (~12% of VIEW) so the stroke and the start dot never clip at the edge.
inline constexpr int PAD = 30;
// The RDP tolerance, tuned for FIDELITY rather than size: the max deviation (in
// viewBox units, ~px at a 256-wide render) a kept point may sit from the true
// curve. We have the byte budget, so it sits low enough (~74 pts/track) that
// straight segments reproduce the real shape.
inline constexpr double EPS = 0.35;

struct Point {
  double x = 0, y = 0;
};

// World -> map projection, so an overlay (the track-preview minimap) can plot
// LIVE positions onto the same schematic: mapX = offX + (worldX - minX)*scale.
// Pure extra data; a phone that reads only viewBox/d/start ignores it.
struct Projection {
  double minX = 0, minZ = 0, scale = 0, offX = 0, offZ = 0;
};

struct Schematic {
  std::string viewBox;      // always "0 0 256 256"
  std::string d;            // "M x y L x y ... Z", or "" for a track with no samples
  bool hasStart = false;    // false == JS null (no samples at all)
  Point start;
  // A sample-less track answers with NO proj key at all, not a zeroed one — the
  // JS early return builds a three-key object. Faithful, because a shell that
  // tests for the key would otherwise plot live positions through a scale of 0.
  bool hasProj = false;
  Projection proj;
};

// Project a built track to its top-down map. Reads track.samples (the
// centreline's), x across and z down — any consistent orientation reads fine as
// a schematic.
Schematic build(const RaceTrack& track);

// The snapshot codec. `d` is a schematic's path; the RDP runs on the SMOOTH
// sub-integer points and only the survivors are rounded to bytes, because
// rounding first would jitter straights by +/-0.5 and defeat the simplification.
std::string pack(const std::string& d, double eps = EPS);

// The phone's half: straight segments between the kept points, NO spline. The
// full-res source is itself a dense polyline, so at EPS's resolution the kept
// points already trace the true shape. (A Catmull-Rom fillet was tried and
// reverted: RDP spaces points too unevenly for a spline, and any spline IMPOSES
// a rounded look the original does not have.) The viewBox is constant and
// `start` is just the first point, so neither is transmitted.
Schematic unpack(const std::string& b64);

// A path's points back out of its "M x y L x y ... Z" text. Exposed because two
// callers outside this module read paths: the conformance check
// (tracktest/schematic_check.cc) and the ABI's ttp_schematic_points_json, which
// parses `d` for the shells that cannot hand it to an SVG attribute.
std::vector<Point> points_of(const std::string& d);

}  // namespace schematic
}  // namespace ttp
