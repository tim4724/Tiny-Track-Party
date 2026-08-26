// Proves the conformance gates can FAIL. Breaks the engine on purpose, one edit at a
// time, and requires the named ctest to go red for each.
//
// WHY. A green suite says nothing about whether it would notice a regression, and
// this is not a theoretical worry — it has already happened twice in this tree,
// both times in gates written deliberately and reviewed:
//
//   * abi_check replayed the tidepool trace, whose four bots NEVER BRAKE. Deleting
//     the brake bit from ttp_process_input left all 600 frames hashing correctly.
//   * catalogue_sweep's first draft ran 400 frames, about 12% of a lap. The cars
//     never reached a second corner, so most of every track went unraced while the
//     gate looked like it covered twenty tracks.
//
// Both were found by doing this by hand. Doing it by hand does not scale and does not
// survive the next contributor, so it lives here.
//
// A mutation that no test catches is not automatically a bug — it can mean the code
// is genuinely unreachable, as Game::collidePole was before hazard_check existed. It
// means SOMETHING is wrong: a blind gate, or dead code. Both are worth knowing.
//
// TWO TRAPS, both learned the hard way:
//   1. mtime granularity. Patch, build and restore inside the same second and the
//      build system may not recompile — a mutation you never compiled looks
//      "undetected", and worse, a STALE object from the previous mutation can make
//      the next one look "detected". Every patch here is followed by an explicit
//      touch with a forward timestamp.
//   2. Restore is not optional. The tree must be pristine even if a build hangs or
//      the process is interrupted, so originals are captured up front, restored in a
//      finally, and re-restored on SIGINT/SIGTERM.
//
// Usage: node scripts/mutation-check.mjs [--only=<substring>] [--list] [--build-dir=<d>]
//        npm run mutation-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');
const BUILD = path.join(ROOT, (args.find((a) => a.startsWith('--build-dir=')) || '')
  .slice('--build-dir='.length) || 'native/build/mutation');

// ---------------------------------------------------------------------------
// The mutations. `expect` names the ctest that MUST turn red — the gate whose whole
// job is this behaviour. Others may also fail; that is fine and not asserted, since
// which extra gates trip is an implementation detail (and for leak-shaped mutations,
// partly the allocator's business).
//
// Spread across every layer on purpose: a harness that only mutated the newest code
// would tell us nothing about whether the ORIGINAL gates still bite.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  // ---- mathlib + serializer: the foundations everything else trusts.
  {
    name: 'mathlib/sin-perturbed',
    file: 'native/vendor/fdlibm/src/s_sin.c',
    find: 'return __kernel_sin(x,z,0);',
    replace: 'return __kernel_sin(x,z,0) * 1.0000000000000002;',
    expect: 'mathlib_corpus',
  },
  {
    name: 'serializer/shortest-form-dropped',
    file: 'native/libttp-json/ttp/jsonnum.cc',
    find: 'EcmaScriptConverter().ToShortest(v, &sb);',
    replace: 'EcmaScriptConverter().ToPrecision(v, 17, &sb);',
    expect: 'serializer',
  },

  // ---- track geometry.
  {
    name: 'centerline/sample-off-by-one',
    file: 'native/libttp-track/ttp/centerline.cc',
    find: 'const Sample& pD = a[idx(i + 2)];',
    replace: 'const Sample& pD = a[idx(i + 3)];',
    expect: 'track_sampler',
  },

  // ---- the sim core.
  {
    name: 'sim/steer-scrub-weakened',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'STEER_SCRUB = 0.28',
    replace: 'STEER_SCRUB = 0.27',
    expect: 'replay_tidepool-4bots-600f-seed42',
  },
  {
    name: 'sim/pole-collision-never-runs',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'for (Car* c : list) for (const PoleRt& p : poles_) collidePole(*c, p);',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'sim/pole-min-keep-removed',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'if (c.v < POLE_MIN_KEEP * c.vmax) c.v = POLE_MIN_KEEP * c.vmax;',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'sim/stage-banana-does-nothing',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'bananas_.push_back(b);',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'ai/corner-margin-nudged',
    file: 'native/libttp-sim/ttp/ai_driver.cc',
    find: 'CORNER_MARGIN = 1.25',
    replace: 'CORNER_MARGIN = 1.26',
    expect: 'catalogue_sweep',
  },
  {
    // The PR #40 bug, reinstated: a racing line memoized against a RECYCLED
    // Centerline* address. race_isolation forces the collision, so it is the gate
    // that must fail deterministically.
    name: 'ai/racing-line-keyed-by-recycled-pointer',
    file: 'native/libttp-sim/ttp/ai_driver.cc',
    find: '  RacingLine& line = game.racingLine();',
    replace: [
      '  RacingLine& line = [&]() -> RacingLine& {',
      '    static std::vector<std::pair<Centerline*, std::unique_ptr<RacingLine>>> cache;',
      '    Centerline* key = const_cast<Centerline*>(game.centerline());',
      '    for (auto& kv : cache) if (kv.first == key) return *kv.second;',
      '    cache.emplace_back(key, std::make_unique<RacingLine>(*key));',
      '    return *cache.back().second;',
      '  }();',
    ].join('\n'),
    expect: 'race_isolation',
  },

  // ---- the cup layer.
  {
    name: 'gp/points-table-changed',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'POINTS_BY_RANK[4] = {9, 6, 3, 1}',
    replace: 'POINTS_BY_RANK[4] = {9, 6, 4, 1}',
    expect: 'grandprix',
  },
  {
    name: 'gp/latest-race-tiebreak-dropped',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'return latest(a.playerId) < latest(b.playerId);',
    replace: 'return false;',
    expect: 'grandprix',
  },
  {
    name: 'gp/unseated-row-loses-its-undefined',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'nm.seatNull = (seat == nullptr);',
    replace: 'nm.seatNull = false;',
    expect: 'grandprix',
  },

  // ---- the party layer.
  {
    name: 'room/sticky-host-reconcile-skipped',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: 'if (to == "lobby" || to == "results") reconcileStickyHost();',
    replace: '',
    expect: 'roomflow',
  },
  {
    // The participant set the abandoned-race policy and the "joining" rows both
    // read. A dropped seat is being HELD, not waiting — forget that and a blipped
    // party's own ghost seats start counting as people waiting for the next race.
    name: 'room/dropped-seat-stops-being-a-participant',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: 'bool active = discHas(p.peerIndex);  // a dropped seat is a participant, held',
    replace: 'bool active = false;',
    expect: 'abi',
  },
  {
    name: 'framing/encode-drops-a-field',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: 'm.set("maxClients", Value::Num(maxClients));',
    replace: 'm.set("maxClient5", Value::Num(maxClients));',
    expect: 'framing',
  },
  {
    name: 'fastlane/rtt-ewma-skips-smoothing',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: 'else srtt_ = srtt_ + (rtt - srtt_) * RTT_ALPHA;',
    replace: 'else srtt_ = rtt;',
    expect: 'fastlane',
  },

  // ---- the session policy, whose corpus exists mostly FOR the branches nothing
  // else in the tree covers. Each of these was a real hole before it: the
  // rejection guards were untested (wire-compat drives the accepted paths only),
  // and the claim path had no coverage anywhere.
  {
    // Ready survives race -> lobby, so the pick behind a standing ready flag must
    // not shift. Drop this and a ready player can silently swap cars.
    name: 'session/ready-seat-stops-locking-its-car-pick',
    file: 'native/libttp-party/ttp/session.cc',
    find: '  if (ready) return false;\n  if (!(state == RoomState::LOBBY || !inRace)) return false;',
    replace: '  if (!(state == RoomState::LOBBY || !inRace)) return false;',
    expect: 'session',
  },
  {
    // The bulky track schematics ride the LOBBY snapshot only — nothing about the
    // other eleven keys hints at it, and shipping them every publish is how the
    // room silently exceeds the relay's 16 KiB cap.
    name: 'session/track-chooser-rides-every-snapshot',
    file: 'native/libttp-party/ttp/session.cc',
    find: '  if (lobby) copyKey(out, chooser, "tracks");\n  else out.set("tracks", Value::Null());',
    replace: '  copyKey(out, chooser, "tracks");',
    expect: 'session',
  },
  {
    // rejoinToken is an INTEGER or it is nothing (session.h). Drop the TYPE half
    // of that and every non-number reads Value's zero-initialised `num`, so a
    // JSON null claims seat 0 again — the exact quirk this layer stopped
    // carrying. The corpus keeps the null, bool, string, array and object
    // inputs, so it has plenty to kill this with.
    name: 'session/rejoin-token-accepts-any-json-type-again',
    file: 'native/libttp-party/ttp/session.cc',
    find: '  if (!v || v->type != Value::NUM) return false;',
    replace: '  if (!v) return false;',
    expect: 'session',
  },
  {
    // The heartbeat is an in-flight FLAG, not an echo AGE. Swap it and a
    // background tab whose ticks ran minutes apart reconnects a healthy socket.
    name: 'session/heartbeat-reads-echo-age-instead-of-the-flag',
    file: 'native/libttp-party/ttp/session.cc',
    find: '  if (hbPending && now - hbSentAt > kHeartbeatDeadMs) {',
    replace: '  if (now - hbSentAt > kHeartbeatDeadMs) {',
    expect: 'session',
  },
  {
    // The claim QR's URL: ?claim= must go BEFORE the fragment or the reconnect
    // lands on a relay shard that has never heard of the room.
    name: 'session/claim-url-appends-after-the-fragment',
    file: 'native/libttp-party/ttp/session.cc',
    find: '  return base + sep + "claim=" +\n         framing::encode_uri_component(js_number_to_string(peerIndex)) + frag;',
    replace: '  return base + frag + sep + "claim=" +\n         framing::encode_uri_component(js_number_to_string(peerIndex));',
    expect: 'session',
  },

  // ---- the track map + its snapshot codec.
  {
    // RDP runs on the SMOOTH sub-integer path and only THEN rounds. Round first
    // and every straight jitters by +/-0.5, which defeats the simplification and
    // blows the byte budget.
    name: 'schematic/rdp-runs-on-already-rounded-points',
    file: 'native/libttp-track/ttp/schematic.cc',
    find: '    return z0(js_fixed(js_max(0.0, js_min(VIEW - 1.0, n)), 1));',
    replace: '    return z0(js_fixed(js_max(0.0, js_min(VIEW - 1.0, n)), 0));',
    expect: 'schematic',
  },
  {
    // toFixed is not printf: it picks the integer minimizing |n/10^f - x| and
    // breaks ties away from zero. Truncating instead moves points by up to 0.1.
    name: 'schematic/tofixed-truncates-instead-of-rounding',
    file: 'native/libttp-track/ttp/schematic.cc',
    find: '  const std::string t = fixedText(v, digits);\n  return std::strtod(t.c_str(), nullptr);',
    replace: '  double p = 1; for (int i = 0; i < digits; i++) p *= 10;\n  return std::trunc(v * p) / p;',
    expect: 'schematic',
  },

  // ---- the display runtime (libttp-runtime), which had NO gate at all until
  // runtime_check: it lived in runtime/ttp_display.cc behind the Filament SDK,
  // so every leg compiled around it and every ctest looked straight past it.
  {
    name: 'camera/chase-damping-not-frame-rate-independent',
    file: 'native/libttp-runtime/ttp/camera.cc',
    find: 'const float aPos = 1 - std::exp(-(CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt);',
    replace: 'const float aPos = (CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt;',
    expect: 'runtime_check',
  },
  {
    name: 'framing/lobby-orbit-stops-clearing-the-bbox',
    file: 'native/libttp-runtime/ttp/framing.cc',
    find: 'f.bbAx = halfX + BBOX_CLEARANCE;',
    replace: 'f.bbAx = halfX;',
    expect: 'runtime_check',
  },
  // The frame BUILDER, which runtime_check does not reach — it calls the camera,
  // framing and grid primitives itself and never runs the block that assembles a
  // frame out of them. frame_check is that gate.
  {
    name: 'frame/cell-aspect-transposed',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    // The overview/lobby rigs derive the aspect from the surface (the race cams
    // take the caller's cell aspect instead — a cell is a tile of the LETTERBOXED
    // picture, which only the renderer knows). frame_check drives both.
    find: ': (float) d.width / (float) (d.height ? d.height : 1);',
    replace: ': (float) (d.height ? d.height : 1) / (float) d.width;',
    expect: 'frame_builder',
  },
  {
    name: 'frame/outlived-hold-drives-behind-the-overlay',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    find: 'if (d.hold) for (size_t i = 0; i < cars.size(); i++) atRest(outCars[i]);',
    replace: '',
    expect: 'frame_builder',
  },
  {
    name: 'frame/roster-slot-taken-by-insertion-order',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    find: 'if (d.roster[i] == cp->id) { cars[i] = cp.get(); break; }',
    replace: 'cars[i] = cp.get();',
    expect: 'frame_builder',
  },
  {
    name: 'frame/unarmed-banana-drawn',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    find: 'if (now < b.liveAt) continue;',
    replace: '',
    expect: 'frame_builder',
  },

  // ---- the camera BASIS and the split-screen LENS. Both run on every race
  // frame and both were unpinned until 2026-07-29: every assertion that touched
  // them built its `want` by calling them, so the wiring was gated and the
  // functions were not. All four mutations below left the WHOLE 48-test suite
  // green. frame_check's testCameraMath now asserts the definition instead —
  // hand-computed conventions plus the algebra a look-at basis must satisfy.
  {
    name: 'camera/z-basis-reversed',
    file: 'native/libttp-runtime/ttp/vecmath.h',
    // The Z column points from the target BACK to the eye (a camera looks down
    // -Z). Flipping it renders the world backwards and leaves the basis
    // perfectly orthonormal, which is why lengths and angles cannot catch it.
    find: 'V3 z = eye - target;',
    replace: 'V3 z = target - eye;',
    expect: 'frame_builder',
  },
  {
    name: 'camera/basis-mirrored',
    file: 'native/libttp-runtime/ttp/vecmath.h',
    // Handedness alone: still orthonormal, still pointing the right way.
    find: 'const V3 y = cross(z, x);',
    replace: 'const V3 y = cross(x, z);',
    expect: 'frame_builder',
  },
  {
    name: 'camera/ref-aspect-moved',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    // What "the single-player reference" IS. Move it and every cell draws the
    // car at the wrong size, consistently, so nothing looks obviously broken.
    find: 'REF_ASPECT = 16.0f / 9.0f',
    replace: 'REF_ASPECT = 4.0f / 3.0f',
    expect: 'frame_builder',
  },
  {
    name: 'camera/frame-lock-exponent',
    file: 'native/libttp-runtime/ttp/frame_builder.cc',
    // How the width fraction enters the lens. Identity at widthFrac == 1, so a
    // single-player check can never see it — only a split cell can.
    find: 'FRAME_LOCK = 1.0f',
    replace: 'FRAME_LOCK = 2.0f',
    expect: 'frame_builder',
  },
  {
    name: 'sim/removed-car-keeps-its-finish',
    file: 'native/libttp-sim/ttp/game.cc',
    // raceOver() is finishedOrder_.size() >= cars_.size(), so a finished car
    // that leaves must come off BOTH sides. Losing this ends the race a car
    // early the first time someone crosses the line and then drops — which is
    // an ordinary mid-race disconnect, not a corner case. Green across all 48
    // tests until abi_check grew the sequence that can see it.
    find: 'if (i >= 0) finishedOrder_.erase(finishedOrder_.begin() + i);',
    replace: '',
    expect: 'abi',
  },

  // ---- the audio decisions. Three halves of one gate: the distance curve every
  // world cue is scaled by, the voice start/stop EDGE (which the traces exercise
  // 5900 times and no scripted case could), and the music trim — the one number
  // in this layer that a port is tempted to DERIVE rather than copy. Deriving it
  // with the vendored fdlibm pow is the exact mistake the corpus was re-recorded
  // to make catchable, and it is caught on the very first music pick.
  {
    name: 'audio/impact-loses-its-payoff-floor',
    file: 'native/libttp-runtime/ttp/audio.cc',
    find: 'return a > 0 ? js_max(0.45, a) : 0;',
    replace: 'return a;',
    expect: 'audio',
  },
  {
    name: 'audio/voice-stop-is-not-an-edge',
    file: 'native/libttp-runtime/ttp/audio.cc',
    find: 'if (level <= VOICE_FLOOR) {',
    replace: 'if (level <= VOICE_FLOOR) { { Command z; z.kind = Command::VOICE_STOP; z.name = cue;'
      + ' z.id = id; out.push_back(z); return; }',
    expect: 'audio',
  },
  {
    name: 'audio/music-trim-derived-with-pow',
    file: 'native/libttp-runtime/ttp/audio.cc',
    // One song's trim, as ttp_fd_pow(10, (-19.2 - -15.3) / 20) computes it: one
    // ULP below the literal V8's `10 ** x` produced and the corpus recorded.
    // Spelled as the number rather than as the pow CALL because a linkage
    // specification is illegal at block scope, so the honest mutation would not
    // compile — and a mutation that does not compile proves nothing.
    find: '212, -15.3, 0.6382634861905488)',
    replace: '212, -15.3, 0.63826348619054873)',
    expect: 'audio',
  },

  // ---- the party C ABI marshalling (ttp_party.cc).
  {
    name: 'party-abi/add-player-drops-game-fields',
    file: 'native/runtime/ttp_party.cc',
    find: 'if (ok && f.type == Value::OBJ) fields = f.obj;',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'party-abi/event-queue-not-drained',
    file: 'native/runtime/ttp_party.cc',
    find: '  rh->events.clear();',
    replace: '',
    expect: 'abi',
  },
  {
    // The one place the party ABI reads the sim: who is holding a car. Lose it
    // and every racer reads as a late joiner waiting for the next race.
    name: 'party-abi/active-order-never-sees-the-cars',
    file: 'native/runtime/ttp_party.cc',
    find: 'for (const auto& c : g->cars()) active.push_back(c->id);',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'party-abi/classify-mislabels-bad-frames',
    file: 'native/runtime/ttp_party.cc',
    find: 'out.set("route", Value::Str("none"));',
    replace: 'out.set("route", Value::Str("message"));',
    expect: 'abi',
  },

  // ---- the C ABI marshalling.
  {
    name: 'abi/brake-bit-never-marshalled',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'if (mask & 2) { in.hasB = true; in.b = b; }',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'abi/car-world-pos-wrong-component',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'out3[0] = c->pose.pos.x;',
    replace: 'out3[0] = 0;',
    expect: 'abi',
  },
  {
    name: 'abi/standings-emit-empty-name',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'if (!st.seatNull) {',
    replace: 'if (true) {',
    expect: 'abi',
  },
  // The bots the SHIPPED game races are constructed here and driven inside
  // ttp_update. Until the ai-live trace joined the abi check, every fixture
  // added its cars as humans and replayed recorded inputs, so this whole
  // construction could be wrong with all 32 tests green.
  {
    name: 'abi/bot-persona-lane-bias-dropped',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'STEER_GAIN, b.laneBias,',
    replace: 'STEER_GAIN, 0.0,',
    expect: 'abi',
  },

  // ---- the adaptive render scale's STATE. The RULE beside it was assertion-
  // gated from the day it was written; this half was three shells' hand-written
  // bookkeeping until it moved into C++, and nothing anywhere could execute it.
  // Every mutation below is a bug one of those shells actually had.
  {
    // The ceiling is the BAND's. Left at a baked-in 1.0, a HiDPI browser prices
    // frames drawn at 2.0 as though they cost that at 1.0 — poisoning the cost
    // model's first observation — and halves a canvas nobody asked it to touch.
    name: 'render-scale/ceiling-not-adopted',
    file: 'native/libttp-runtime/ttp/render_scale_controller.cc',
    find: 'if (limits.max > 0.0) point_.scale = limits.max;',
    replace: '',
    expect: 'render_scale',
  },
  {
    // The panel period is learned off the TICK series, which runs at the panel's
    // rate whether or not a frame drew. Learned off presents, a box skipping two
    // ticks in three reports a 20 Hz panel and is judged against a budget three
    // times too generous.
    name: 'render-scale/floor-learned-from-presents',
    file: 'native/libttp-runtime/ttp/render_scale_controller.cc',
    find: 'floorMs_ = presentBaseline(floorMs_, r.frame.p05);',
    replace: 'floorMs_ = presentBaseline(floorMs_, r.present.p05);',
    expect: 'render_scale',
  },
  {
    // The window that decided a move describes the OLD buffer. Kept, it judges
    // the new resolution on the old one's frames for the next two seconds, which
    // is how a controller talks itself into a second step it does not need.
    name: 'render-scale/window-kept-across-a-move',
    file: 'native/libttp-runtime/ttp/render_scale_controller.cc',
    find: '  mon.reset();',
    replace: '',
    expect: 'render_scale',
  },
  {
    // A scene build drops the cost model's observation: a fit whose two points
    // straddle a scene change measures a slope belonging to neither, and the
    // rule then refuses to probe (a refused FIT is evidence, not missing data).
    name: 'render-scale/scene-keeps-the-fit',
    file: 'native/libttp-runtime/ttp/render_scale_controller.cc',
    find: '  prev_ = RenderScaleSample{0.0, 0.0};\n}',
    replace: '}',
    expect: 'render_scale',
  },
  {
    // 60 fps IS the bar. Dividing by the raw fastest present instead reads a
    // 120 Hz laptop holding a solid 60 as "a whole period late" every window —
    // and this is the arm that may only step DOWN, so it walks a machine doing
    // nothing wrong from 2160 lines to 1080 and never gives them back.
    name: 'render-scale/late-ratio-vs-raw-floor',
    file: 'native/libttp-runtime/ttp/render_scale.h',
    find: 'const double bar = std::max(cost.presentFloorMs, 1000.0 / kAnchorHz);',
    replace: 'const double bar = cost.presentFloorMs;',
    expect: 'render_scale',
  },
  {
    // The present series is what a skip storm shows up in; the tick series is a
    // flat vsync period straight through one. Folding presents as ticks is the
    // shape both TV shells' readouts had before the split.
    name: 'perf/present-series-folded-as-ticks',
    file: 'native/libttp-runtime/ttp/perf_stats.cc',
    find: '  r.present = foldPresents(ring_);',
    replace: '  r.present = foldOne(ring_, &Sample::intervalMs);',
    expect: 'perf',
  },
];

// ---------------------------------------------------------------------------
const run = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts });

function configure() {
  if (fs.existsSync(path.join(BUILD, 'CMakeCache.txt'))) return;
  console.log(`configuring ${path.relative(ROOT, BUILD)} (Release, first run only)`);
  const r = run('cmake', ['-S', 'native', '-B', BUILD, '-DCMAKE_BUILD_TYPE=Release']);
  if (r.status !== 0) {
    console.error(r.stdout || '', r.stderr || '');
    throw new Error('cmake configure failed');
  }
}

function build() {
  const r = run('cmake', ['--build', BUILD, '--parallel']);
  return { ok: r.status === 0, log: `${r.stdout || ''}${r.stderr || ''}` };
}

// A forward timestamp, so no build system can mistake a patched file for an old one.
function touchForward(file) {
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
}

function ctestPasses(name) {
  const r = run('ctest', ['--test-dir', BUILD, '-R', `^${name}$`, '--output-on-failure']);
  const ran = /tests passed|tests failed|No tests were found/.test(`${r.stdout}${r.stderr}`);
  if (!ran) {
    console.error(`${r.stdout || ''}${r.stderr || ''}`);
    throw new Error(`ctest did not report on '${name}' — is that a real test name?`);
  }
  if (/No tests were found/.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`no ctest named '${name}'`);
  }
  return r.status === 0;
}

function main() {
  const selected = MUTATIONS.filter((m) => !only || m.name.includes(only));
  if (listOnly) {
    for (const m of MUTATIONS) console.log(`${m.name}  ->  ${m.expect}`);
    return;
  }
  if (!selected.length) throw new Error(`--only=${only} matched no mutation`);

  // Refuse to run over uncommitted work in the files we are about to vandalise.
  // Restore is robust, but "robust" is not a promise worth betting someone's edits on.
  const targets = [...new Set(selected.map((m) => m.file))];
  const dirty = run('git', ['status', '--porcelain', '--', ...targets]).stdout.trim();
  if (dirty) {
    console.error(`refusing to run: uncommitted changes in files this script mutates\n${dirty}`);
    console.error('commit or stash them first.');
    process.exitCode = 2;
    return;
  }

  configure();
  const baseline = build();
  if (!baseline.ok) {
    console.error(baseline.log);
    throw new Error('baseline build failed — fix the tree before mutation-checking');
  }

  const originals = new Map();
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    originals.set(rel, fs.readFileSync(abs));
  }
  const restoreAll = () => {
    for (const [rel, buf] of originals) {
      const abs = path.join(ROOT, rel);
      fs.writeFileSync(abs, buf);
      touchForward(abs);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { restoreAll(); process.exit(130); });
  }

  const results = [];
  try {
    for (const m of selected) {
      const abs = path.join(ROOT, m.file);
      const src = originals.get(m.file).toString();
      if (!src.includes(m.find)) {
        const note = m.optional ? 'skipped (anchor moved)' : 'ANCHOR MISSING';
        results.push({ ...m, status: note });
        console.log(`${note.padEnd(22)} ${m.name}`);
        continue;
      }

      fs.writeFileSync(abs, src.replace(m.find, m.replace));
      touchForward(abs);

      const b = build();
      let status;
      if (!b.ok) {
        // A mutation that will not compile proves nothing either way.
        status = m.optional ? 'skipped (no compile)' : 'DID NOT COMPILE';
      } else {
        status = ctestPasses(m.expect) ? 'NOT CAUGHT' : 'caught';
      }
      results.push({ ...m, status });
      console.log(`${status.padEnd(22)} ${m.name}  ->  ${m.expect}`);

      fs.writeFileSync(abs, originals.get(m.file));
      touchForward(abs);
    }
  } finally {
    restoreAll();
  }

  // The tree is back; prove the suite is green again, so a mutation can never be
  // left behind silently.
  const after = build();
  if (!after.ok) {
    console.error(after.log);
    throw new Error('post-restore build failed — the tree may not be pristine, check git status');
  }

  const bad = results.filter((r) => r.status === 'NOT CAUGHT' || r.status === 'ANCHOR MISSING' ||
    r.status === 'DID NOT COMPILE');
  const caught = results.filter((r) => r.status === 'caught').length;
  const skipped = results.filter((r) => r.status.startsWith('skipped')).length;

  console.log(`\n${caught}/${selected.length} mutations caught` +
    (skipped ? `, ${skipped} skipped` : '') + (bad.length ? `, ${bad.length} PROBLEMS` : ''));

  if (bad.length) {
    console.error('\nEach of these means a blind gate or dead code:');
    for (const r of bad) console.error(`  ${r.status}: ${r.name} (expected ${r.expect} to fail)`);
    process.exitCode = 1;
  }
}

main();
