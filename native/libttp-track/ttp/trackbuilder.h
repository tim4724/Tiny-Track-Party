// TrackBuilder — the C++ twin of public/display/TrackBuilder.js. Integrates a
// track DEFINITION (a segment DSL walk OR a waypoint Catmull-Rom spline) into a
// drivable centreline of oriented frames, then runs the shared furniture resolve
// (oils/pads/boxes/poles/bananas + auto loop-launch strips + ghost collision
// poles). A bit-exact transliteration per docs/native-port/fp-profile.md:
//   - double only, no float temporaries; one operation order (§1);
//   - transcendentals through the vendored fdlibm (ttp_fd_sin/cos/atan2/hypot),
//     Math.sqrt stays std::sqrt (§2);
//   - Math.round -> js_round, Math.min/max/sign -> js_* (jsmath.h, §3.1/§3.4);
//     the `x || default` falsy guards are reproduced with `!= 0.0` tests (§3.5b).
// The DEFS are carried from the JS catalogue by scripts/gen-track-defs-header.mjs
// (generated/track_defs.h); build_race_track mirrors record-trace.mjs
// buildRaceTrack (buildTrack + trackId/totalLaps/seed + resolveFurniture).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "ttp/vec3.h"

namespace ttp {

// ---- track DEFINITION PODs (populated by generated/track_defs.h) ------------

enum class SegKind { Straight, Arc, Loop };

struct SegDef {
  SegKind kind;
  double length;   // straight run length (unscaled)
  double radius;   // arc / loop radius
  double angle;    // arc turn (degrees; >0 left)
  double rise;     // elevation delta over the segment (`rise || 0`)
  double bank;     // peak bank (degrees; falsy -> 0)
  double roll;     // heartline roll (degrees; falsy -> 0)
  double drift;    // loop lateral drift (`drift || 0`)
  bool over;       // loop vertical sense: true=up (default), false (over===false)=down
  int widthKind;   // 0 none (track default), 1 scalar w0, 2 taper [w0,w1]
  double w0, w1;
  bool pillars;
};

struct WptDef {
  double x, z, y;  // plan position + elevation (`y || 0`)
  double w;        // width override, 0 = absent (`w || trackWidth`)
  double bank;     // degrees (`bank || 0`)
  bool bridge;
};

struct FurnDef {   // oil / pad / box / pole descriptor
  double u, lat;
  bool hasRadius;  // radius != null in the JS (absent -> a roadWidth-scaled default)
  double radius;
};

struct BananaDef { double u, lat; };

struct TrackDef {
  const char* id;
  // THE THREE FIELDS BELOW ARE NOT BUILDER INPUT. Nothing in this library reads
  // any of them; they ride along because the catalogue is where each is
  // AUTHORED, and carrying them here is what keeps one source for three shells.
  // The alternative — and what the tree did until they were added — is every
  // shell bundling its own copy of the display names and its own spelling of
  // the tendency rule, which is the drift the codegen exists to stop.

  // Display name (public/shared/tracks.js `name`), for pickers and boards.
  const char* name;
  // The CUP this track belongs to (CUPS), or nullptr for a dev-only surface
  // that no cup lists. The tag the biome resolves from
  // (libttp-runtime/ttp/theme.h).
  const char* cup;
  // Difficulty as a LEVEL, 1 (Easy) .. 4 (Expert), 2 for anything unlabelled.
  // The catalogue authors a word; the codegen resolves it, because the only
  // reader is the cup tendency (ttp::rt::ui::cupTendency) and it wants a number.
  int difficulty;
  bool isSpline;
  const SegDef* segs; int nSegs;
  const WptDef* wpts; int nWpts;
  double width;    // trackWidth = (desc.width) || ROAD_WIDTH
  double startU;   // desc.startU ?? 0
  const FurnDef* oils; int nOils;
  const FurnDef* pads; int nPads;
  const FurnDef* boxes; int nBoxes;
  const FurnDef* poles; int nPoles;
  const BananaDef* bananas; int nBananas;
};

// A CUP: a curated, ordered set of tracks, and the catalogue's own arrangement.
// Populated by generated/track_defs.h like TrackDef, and read by nothing in
// this library for the same reason — cups are a UI grouping, not builder input.
// It lives beside TrackDef because it is authored in the same file
// (public/shared/tracks.js CUPS) and codegen'd by the same script.
struct CupDef {
  const char* id;
  const char* name;
  const char* const* tracks; int nTracks;  // ids, easiest -> hardest
  // An AUTHORED tendency override, or 0 for "derive it from the tracks".
  int difficulty;
};

// ---- built-track OUTPUT (the augmented race-track object) --------------------
// Field sets mirror docs/native-port/contract/race-track.schema.json.

struct OutSample {
  Vec3 pos, tangent, up, lateral;
  double s = 0.0;
  double width = 0.0;
  bool pillars = false;
  bool hillable = false;
};

struct Hazard { double s, lat, radius; };          // cones never present on shipped tracks
struct Box { double s, lat, radius; };
struct Banana { double s, lat; };
struct LoopStart { double s, width; };

struct Pad {                                        // disc OR strip (shape:'strip')
  double s, lat;
  bool strip;
  double radius;                                    // disc only
  double halfLen, halfWidth;                        // strip only
};

struct Pole {                                       // authored (ghost=false) + autoPoles (ghost=true)
  double s, lat, radius;
  bool ghost;
};

struct AutoPole { double s, lat, radius; };         // top-level autoPoles; serialize ghost:true

struct Pillar { double x, z, baseY, topY, radius; };
struct HillRing { double cx, cz, lx, lz, halfW, topL, topR; };
struct SupportPost {
  double x, z, radius, baseY;
  Vec3 contactPos, contactUp;
};

struct RaceTrack {
  int version;
  bool startGate;
  std::vector<Pillar> pillars;
  std::vector<std::vector<HillRing>> hills;
  std::vector<LoopStart> loopStarts;
  std::vector<SupportPost> supportPosts;
  std::vector<AutoPole> autoPoles;
  std::vector<OutSample> samples;   // centerline.samples (== ring)
  double length;
  bool closed;
  double gap;
  double roadWidth;
  double groundY;
  std::string trackId;
  int totalLaps;
  uint32_t seed;
  std::vector<Hazard> hazards;
  std::vector<Pad> pads;
  std::vector<Box> boxes;
  std::vector<Pole> poles;
  std::vector<Banana> bananas;
};

// buildTrack + identity + resolveFurniture, matching record-trace.mjs
// buildRaceTrack(trackId, {laps, seed}).
RaceTrack build_race_track(const TrackDef& def, int laps, uint32_t seed);

// ---- support-post corridor probe (exposed for the geometry audit) -----------
// The gate the builder itself uses to decide whether a bridge pillar or loop
// shaft intrudes into a drivable corridor, and so whether it needs a ghost
// collision pole. scripts/audit-tracks.mjs reports the NEAR misses — a post
// intruding a couple of centimetres is an invisible wall behind the kerb — and
// it has to ask with THIS function: a hand-synced copy of the measure is exactly
// how the radial-intrusion bug once slipped its own regression test.
struct Post { double x, z, radius, baseY, topY; };
struct PostHit { bool valid; double lat, tan, intrusion; };
PostHit post_at_sample(const OutSample& sm, const Post& post);

}  // namespace ttp
