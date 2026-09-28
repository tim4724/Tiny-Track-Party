'use strict';
// Cross-layer config drift guards. The sim engine (native/libttp-sim/ttp/game.*)
// is standalone C++ — it cannot import public/shared/protocol.js — so a few
// shared-in-concept constants are duplicated there as fallbacks/benchmarks rather
// than carried across. These tests are the tripwire: if the protocol-side value
// moves, the engine-side constant must move in the same commit.
//
// Each constant is guarded TWICE, on purpose:
//   (a) against the C++ SOURCE TEXT — always runs, needs no build, and points at
//       the file a developer actually edits;
//   (b) against the LIVE wasm engine — proves the constant really reaches the
//       shipped snapshot (skipped when the wasm artifacts are not built).
// The source-text guards are deliberately literal: a reformat FAILS them loudly
// rather than silently matching nothing, which is the right failure direction for
// a tripwire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const protocol = require('../public/shared/protocol.js');

const ROOT = path.join(__dirname, '..');
const GAME_CC = path.join(ROOT, 'native/libttp-sim/ttp/game.cc');
const GAME_H = path.join(ROOT, 'native/libttp-sim/ttp/game.h');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

const skip = fs.existsSync(MJS) && fs.existsSync(WASM)
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

// The controller's two steering modules, loaded live rather than scraped: both
// are browser ES modules written to import headlessly (see their headers).
let tilt, gate;
test.before(async () => {
  tilt = await import(pathToFileURL(path.join(ROOT, 'public/controller/TiltInput.js')).href);
  gate = await import(pathToFileURL(path.join(ROOT, 'public/controller/InputGate.js')).href);
});

// The runtime C ABI, same cwrap conventions as tests/runtime-abi.test.js (ids
// cross as JSON scalars; null stats = the engine benchmark car).
async function loadAbi() {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const Module = await factory();
  const cw = (name, ret, args) => Module.cwrap(name, ret, args);
  return {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', 'void', ['number', 'string', 'string']),
    start: cw('ttp_session_start', 'void', ['number', 'number']),
    update: cw('ttp_update', 'void', ['number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    dispose: cw('ttp_dispose', 'void', ['number']),
    getSteerExpo: cw('ttp_get_steer_expo', 'number', []),
    manifest: cw('ttp_protocol_manifest_json', 'string', []),
    maxReconnectAttempts: cw('ttp_framing_max_reconnect_attempts', 'number', []),
  };
}

// One benchmark car on a catalogue track, stepped once, as a snapshot. `laps` is
// passed through verbatim, so laps = 0 exercises the engine's own fallback.
async function benchmarkCarSnap(abi, laps) {
  const h = abi.begin('tidepool', 42, laps, null);
  assert.ok(h > 0, 'session_begin returned a handle');
  abi.addHuman(h, '1', null); // null stats = the engine's benchmark defaults
  abi.start(h, -1);           // no countdown: racing from frame 0
  abi.update(h, 1000 / 60);
  const car = JSON.parse(abi.snapshot(h)).cars[0];
  abi.dispose(h);
  return car;
}

test('engine totalLaps fallback matches protocol TOTAL_LAPS (C++ source)', () => {
  const src = fs.readFileSync(GAME_CC, 'utf8');
  const m = /totalLaps_\(track\.totalLaps \? track\.totalLaps : (\d+)\)/.exec(src);
  assert.ok(m, 'found the totalLaps fallback in game.cc (regex still matches the source)');
  assert.equal(Number(m[1]), protocol.TOTAL_LAPS,
    'game.cc `track.totalLaps ? track.totalLaps : N` fallback drifted from protocol.TOTAL_LAPS');
});

test('engine benchmark collision footprint matches the protocol reference car (C++ source)', () => {
  // A stats-less car gets the engine benchmark (ttp::Stats' member defaults).
  // protocol.CAR_STATS holds the per-model footprints measured from the Kenney
  // meshes; index 0 (Dash) is the reference body both sides were authored against.
  const src = fs.readFileSync(GAME_H, 'utf8');
  const m = /struct Stats \{[^}]*halfLen = ([\d.]+), halfWid = ([\d.]+);/.exec(src);
  assert.ok(m, 'found ttp::Stats defaults in game.h (regex still matches the source)');
  const ref = protocol.carStats(0);
  assert.equal(Number(m[1]), ref.halfLen, 'ttp::Stats::halfLen drifted from protocol.CAR_STATS[0]');
  assert.equal(Number(m[2]), ref.halfWid, 'ttp::Stats::halfWid drifted from protocol.CAR_STATS[0]');
});

test('the live wasm engine ships those same values', { skip }, async () => {
  const abi = await loadAbi();

  // laps = 0 is "the track carries no totalLaps", so the engine fallback applies.
  const fallback = await benchmarkCarSnap(abi, 0);
  assert.equal(fallback.totalLaps, protocol.TOTAL_LAPS,
    'live engine totalLaps fallback drifted from protocol.TOTAL_LAPS');

  // Sanity: an explicit lap count is still honoured (the fallback is a fallback,
  // not a hard-coded value).
  const explicit = await benchmarkCarSnap(abi, protocol.TOTAL_LAPS + 2);
  assert.equal(explicit.totalLaps, protocol.TOTAL_LAPS + 2, 'explicit laps must win over the fallback');

  const ref = protocol.carStats(0);
  assert.equal(fallback.halfLen, ref.halfLen, 'live engine benchmark halfLen drifted from protocol.CAR_STATS[0]');
  assert.equal(fallback.halfWid, ref.halfWid, 'live engine benchmark halfWid drifted from protocol.CAR_STATS[0]');
  assert.equal(fallback.monster, false, 'sanity: the snapshot footprint is unmultiplied (not the x1.3 monster body)');
});

// ---------------------------------------------------------------------------
// The steering contract: protocol.js STEER vs the three files that spend it.
//
// STEER_EXPO (the sim), ROLL_LOCK (the phone) and the CONTROL gate's dead-band
// are one design, and the third is ARITHMETIC over the first two. Before the
// manifest existed that was stated only in prose, in a file that owns none of
// the numbers it reasons about — so tuning the steering curve in C++ left a
// controller comment quietly describing a car that no longer exists.
//
// Four links, all machine-checked, and only the first two live here:
//   1. TiltInput/InputGate  == the manifest        (this file, below)
//   2. InputGate's derivation still closes          (this file, below)
//   3. protocol.h           == protocol.js          (protocol-corpus + `protocol` ctest)
//   4. game.cc              == protocol.h           (the same ctest's own assertion)
// Plus the belt-and-braces guard this file already applies to everything else:
// read the value back out of the SHIPPED wasm, not just the sources.
// ---------------------------------------------------------------------------

test('TiltInput spends the manifest steering numbers', () => {
  const S = protocol.STEER;
  assert.equal(tilt.ROLL_LOCK, S.ROLL_LOCK_DEG, 'TiltInput ROLL_LOCK drifted from protocol.STEER.ROLL_LOCK_DEG');
  assert.equal(tilt.DEADZONE, S.DEADZONE, 'TiltInput DEADZONE drifted from protocol.STEER.DEADZONE');
  assert.equal(tilt.SMOOTH, S.SMOOTH, 'TiltInput SMOOTH drifted from protocol.STEER.SMOOTH');
});

test('InputGate spends the manifest steering numbers', () => {
  const S = protocol.STEER;
  assert.equal(gate.DEFAULT_STEER_THRESHOLD, S.GATE_THRESHOLD,
    'InputGate DEFAULT_STEER_THRESHOLD drifted from protocol.STEER.GATE_THRESHOLD');
  assert.equal(gate.DEFAULT_STRONG_THRESHOLD, S.STRONG_THRESHOLD,
    'InputGate DEFAULT_STRONG_THRESHOLD drifted from protocol.STEER.STRONG_THRESHOLD');
  assert.equal(gate.DEFAULT_SEND_INTERVAL_MS, S.SEND_INTERVAL_MS,
    'InputGate DEFAULT_SEND_INTERVAL_MS drifted from protocol.STEER.SEND_INTERVAL_MS');
  assert.equal(gate.DEFAULT_SEND_MIN_INTERVAL_MS, S.SEND_MIN_INTERVAL_MS,
    'InputGate DEFAULT_SEND_MIN_INTERVAL_MS drifted from protocol.STEER.SEND_MIN_INTERVAL_MS');
});

test('the send pacing tiers are ordered and respect the platform message cap', () => {
  const S = protocol.STEER;
  // The two-tier band has to be a band: strong above the news gate, or every
  // change is "strong" and the baseline cadence never applies to anything.
  assert.ok(S.STRONG_THRESHOLD > S.GATE_THRESHOLD,
    `STRONG_THRESHOLD ${S.STRONG_THRESHOLD} must exceed GATE_THRESHOLD ${S.GATE_THRESHOLD}`);
  // The floor is a floor: the urgent tier may not be slower than the baseline.
  assert.ok(S.SEND_MIN_INTERVAL_MS <= S.SEND_INTERVAL_MS,
    'SEND_MIN_INTERVAL_MS must not exceed SEND_INTERVAL_MS');
  // The hard cap honours the strictest platform message budget in sight:
  // AirConsole (a possible future platform) allows 25 messages a second.
  assert.ok(1000 / S.SEND_MIN_INTERVAL_MS <= 25,
    `SEND_MIN_INTERVAL_MS ${S.SEND_MIN_INTERVAL_MS} allows ${1000 / S.SEND_MIN_INTERVAL_MS}/s, over the 25/s platform cap`);
});

test("InputGate's dead-band derivation still closes over the manifest", () => {
  const S = protocol.STEER;
  const t = S.GATE_THRESHOLD;

  // Lower bound — the gate must ENGAGE. A phone lying still twitches
  // SENSOR_NOISE_FLOOR_DEG at the quiet end; over ROLL_LOCK_DEG that is a
  // fraction of full steer, and TiltInput's one-pole SMOOTH takes roughly half
  // of it back out. A threshold under what survives calls every idle sample a
  // change, so the gate passes everything and saves nothing.
  const survivingNoise = (gate.SENSOR_NOISE_FLOOR_DEG / S.ROLL_LOCK_DEG) * S.SMOOTH;
  assert.ok(t >= survivingNoise,
    `gate threshold ${t} is under the ${survivingNoise} of sensor wobble that survives `
    + `ROLL_LOCK_DEG=${S.ROLL_LOCK_DEG} and SMOOTH=${S.SMOOTH} — the gate would never engage`);

  // Upper bound — the gate must not HIDE too much. Worst case is |s| -> 1, where
  // the display's expo gain peaks at EXPO itself.
  assert.ok(t * S.EXPO <= gate.STEER_ERROR_BUDGET,
    `gate threshold ${t} at the display's peak expo gain ${S.EXPO} hides ${t * S.EXPO} of `
    + `steer authority, over the ${gate.STEER_ERROR_BUDGET} budget`);

  // And the band has to be a band: a floor above the ceiling means no threshold
  // satisfies both, i.e. the four numbers no longer describe one design.
  assert.ok(survivingNoise * S.EXPO <= gate.STEER_ERROR_BUDGET,
    'no gate threshold can satisfy both bounds — the steering manifest is self-contradictory');
});

// ---------------------------------------------------------------------------
// The presence contract: protocol.js LIVENESS vs the files that spend it.
//
// The phone's ping cadence and the window it judges a missing PONG against are
// one design, and those two numbers lived in two different files with nothing
// but a comment between them — the exact failure mode the steering manifest
// above was built to end. A tvOS shell would have picked its own and nobody
// would have noticed until a party.
//
// The block also carries a DECISION: presence is the relay's answer, so no
// window in it drops a seat. The last test here is what keeps a second opinion
// from growing back.
//
// Four links, and the first three are here:
//   1. controller/Net.js + display/Net.js == the manifest   (source text)
//   2. the windows are internally consistent               (arithmetic)
//   3. protocol.h == protocol.js                (protocol-corpus + `protocol` ctest)
// There used to be a fourth, pinning sessionModel.js's restated constants to the
// manifest. That file was the session oracle and went with the port; the C++ it
// became reads the windows out of protocol.h, which link 3 already gates.
// The source-text guards are literal on purpose: a reformat fails them loudly
// rather than silently matching nothing.
// ---------------------------------------------------------------------------
const CTRL_NET = path.join(ROOT, 'public/controller/Net.js');
const DISPLAY_NET = path.join(ROOT, 'public/display/Net.js');

test('the two shells read their presence windows off the manifest', () => {
  const ctrl = fs.readFileSync(CTRL_NET, 'utf8');
  const disp = fs.readFileSync(DISPLAY_NET, 'utf8');
  const pairs = [
    [ctrl, 'controller/Net.js', 'PING_INTERVAL_MS', 'LIVENESS.PING_INTERVAL_MS'],
    [ctrl, 'controller/Net.js', 'PONG_TIMEOUT_MS', 'LIVENESS.PONG_TIMEOUT_MS'],
    [disp, 'display/Net.js', 'LIVENESS_TICK_MS', 'LIVENESS.TICK_MS'],
    // No drop window on this list: presence is the relay's answer, so the
    // display reads no per-controller timeout at all. The assertion that it
    // reads none is below.
    // CREATE_TIMEOUT_MS no longer appears here: the create watchdog's delay
    // rides the arm-create-watchdog effect, read from protocol.h's
    // LIVENESS_CREATE_TIMEOUT_MS inside the wasm — which link 3 gates.
  ];
  for (const [src, where, name, expr] of pairs) {
    assert.match(src, new RegExp(`const ${name} = ${expr.replace('.', '\\.')};`),
      `${where}: ${name} must read ${expr}, not restate a number`);
  }
  // The abandoned-race grace keeps its E2E override, which is an override OF a
  // manifest number rather than a second declaration of one.
  assert.match(disp, /const ABANDONED_RACE_GRACE_MS = window\.__abandonGraceMs \|\| LIVENESS\.ABANDONED_RACE_GRACE_MS;/,
    'display/Net.js: the abandoned-race grace must fall back to the manifest');
});

test('the RANDOM run length is read off the manifest by both ends', () => {
  // Two numbers the phone's picker and the display's resolver have to agree on,
  // and they were TWO PRIVATE COPIES with nothing between them —
  // `RANDOM_DEFAULT_RACES = 4` declared once in shared/trackPicker.js and again
  // in display/Net.js. That is the arrangement this file exists to catch, and it
  // sat there because neither copy was ever named here.
  //
  // The display's half moved into the wasm with the mode pick (ttp_net.cc's
  // normRandomRaces reads protocol.h's RANDOM_RACES_*, which link 3 pins to the
  // manifest), so the JS check now covers the picker alone and the C++ source
  // text is pinned below the same way the game.cc constants are above.
  const picker = fs.readFileSync(path.join(ROOT, 'public/shared/trackPicker.js'), 'utf8');
  assert.doesNotMatch(picker, /RANDOM_(DEFAULT|MAX)_RACES\s*=\s*\d/,
    'shared/trackPicker.js: a literal run length — read it from the manifest\'s RANDOM_RACES');
  assert.match(picker, /RANDOM_RACES/, 'shared/trackPicker.js: must read the manifest block');

  // ZERO IS A LEGAL LENGTH and means ENDLESS, so the clamp is a ceiling and not
  // a range check. A falsy test there silently turns endless into four races.
  const netCc = fs.readFileSync(path.join(ROOT, 'native/runtime/ttp_net.cc'), 'utf8');
  assert.match(netCc,
    /v->num >= 0 && v->num <= protocol::RANDOM_RACES_MAX/,
    'ttp_net.cc: normRandomRaces must admit 0 explicitly and clamp against the manifest MAX');
  assert.doesNotMatch(netCc, /RANDOM_RACES_(DEFAULT|MAX)\s*=\s*\d/,
    'ttp_net.cc: a literal run length — read protocol.h');
});

test('the presence windows still describe one design', () => {
  const L = protocol.LIVENESS;
  // The phone's chip must swallow at least two missed pings, or one dropped
  // packet blinks "no signal" at a player who never left.
  assert.ok(L.PONG_TIMEOUT_MS >= 3 * L.PING_INTERVAL_MS,
    `a ${L.PONG_TIMEOUT_MS}ms pong window is under three ${L.PING_INTERVAL_MS}ms pings — a single hiccup would read as a dead link`);
  // The display's own canary must be SLACKER than the phone's chip, because
  // with the fastlane carrying inputs its socket sees only the heartbeat
  // itself, and its answer is a forced reconnect rather than a repaint.
  assert.ok(L.HEARTBEAT_DEAD_MS > L.PONG_TIMEOUT_MS,
    'the display self-heartbeat window must be wider than the phone-side pong window');
  // The self-heartbeat is the only detector left, so the tick has to be at
  // least as fast as the one window it enforces.
  assert.ok(L.TICK_MS <= L.HEARTBEAT_DEAD_MS,
    'the liveness tick is slower than the self-heartbeat window it enforces');
  // The abandoned-race grace only starts once every racer has already been
  // dropped, so it has to outlast the relay's own idle timeout by a margin or
  // the room bounces to the lobby before a returning party can scan back in.
  // The relay's number is not ours to declare, so this holds it against the
  // slowest window we DO declare.
  assert.ok(L.ABANDONED_RACE_GRACE_MS >= 2 * L.HEARTBEAT_DEAD_MS,
    'the abandoned-race grace is too close to the detection windows to be a grace at all');
});

test('the display runs no silence detector of its own', () => {
  // THE RULE: presence is the relay's answer, from peer_joined to peer_left.
  // This is the assertion that the display did not quietly grow a second
  // opinion again — a per-seat silence window here and Party-Sockets' cap
  // (which counts LIVE SOCKETS) disagree about who is in the room, and the
  // half that is wrong is always ours: a seat we dropped still fills a relay
  // slot, so the reconnect QR we offer for it is answered "Room is full".
  const disp = fs.readFileSync(DISPLAY_NET, 'utf8');
  assert.doesNotMatch(disp, /LIVENESS\.TIMEOUT_MS|timeoutMs\s*:/,
    'display/Net.js: a per-controller drop window is back — presence belongs to the relay');
  const netCc = fs.readFileSync(path.join(ROOT, 'native/runtime/ttp_net.cc'), 'utf8');
  assert.doesNotMatch(netCc, /flow->expiredPeers\(/,
    'ttp_net.cc: the silence sweep is back — a seat is dropped by peer_left and by nothing else');
});

test('the C++ mirror of the presence contract matches the manifest', () => {
  const src = fs.readFileSync(path.join(ROOT, 'native/libttp-party/ttp/protocol.h'), 'utf8');
  for (const [key, want] of Object.entries(protocol.LIVENESS)) {
    const m = new RegExp(`LIVENESS_${key} = ([\\d.]+);`).exec(src);
    assert.ok(m, `protocol.h still declares LIVENESS_${key}`);
    assert.equal(Number(m[1]), want, `protocol.h LIVENESS_${key} drifted from protocol.LIVENESS.${key}`);
  }
});

// The manifest a NON-JS shell reads. A tvOS or Android TV shell cannot import
// protocol.js and (in Kotlin's case) cannot include protocol.h either, so
// ttp_protocol_manifest_json is its only honest source for the car tables, the
// tilt contract and the presence windows — and if it and protocol.js ever
// disagree, every shell that trusted it is wrong in a way nothing on the web
// would notice.
//
// The VALUES are already gated elsewhere and this does not restate that:
// protocol.js -> protocol-corpus.jsonl (codegen-freshness) -> protocol.h (the
// `protocol` ctest) -> the export (abi_check, on every leg). What that chain
// cannot see is a key nobody listed. gen-protocol-corpus.mjs names the constants
// it records ONE BY ONE, so a constant added to protocol.js and not added there
// is absent from the corpus, absent from protocol.h, and absent from what a
// shell is handed — with every existing check still green.
//
// Hence deepEqual against the WHOLE export surface, which is the one assertion
// in the tree that would go red on that omission.
test('the live wasm ships the whole shared manifest, and it matches protocol.js', { skip }, async () => {
  const abi = await loadAbi();
  const got = JSON.parse(abi.manifest());
  const { carStats, ...want } = protocol;  // carStats is a function, not a constant
  assert.deepEqual(got, want,
    'ttp_protocol_manifest_json drifted from public/shared/protocol.js — a port shell would read the stale side');
});

test('the schematic codec tolerance is the manifest number everywhere', () => {
  // The codec module is loaded standalone by the phone, so it spells the value
  // itself; this is the pin that makes that spelling safe. The C++ pair
  // (schematic.h EPS == protocol.h SCHEMATIC_EPS) is abi_check's.
  const codec = fs.readFileSync(path.join(ROOT, 'public/shared/schematicCodec.js'), 'utf8');
  assert.match(codec, new RegExp(`export const SCHEMATIC_EPS = ${protocol.SCHEMATIC_EPS};`),
    'schematicCodec.js SCHEMATIC_EPS drifted from the manifest');
});

test('both JS transports default to the wasm retry budget', { skip }, async () => {
  const abi = await loadAbi();
  const budget = abi.maxReconnectAttempts();
  // The kit is a shared fork and keeps its own literal; the native adapter
  // reads the wasm. One number, three spellings, one test.
  const kit = fs.readFileSync(path.join(ROOT, 'partyplug/PartyConnection.js'), 'utf8');
  assert.match(kit, new RegExp(`maxReconnectAttempts\\) \\|\\| ${budget};`),
    'partyplug/PartyConnection.js retry default drifted from relay_framing.h');
  const adapter = fs.readFileSync(path.join(ROOT, 'public/display/NativePartyConnection.js'), 'utf8');
  assert.match(adapter, /\|\| fn\.maxReconnectAttempts\(\)/,
    'NativePartyConnection must read the budget off the wasm, not re-type it');
});

test('the live wasm engine ships the manifest steering exponent', { skip }, async () => {
  const abi = await loadAbi();
  // Read before anything calls ttp_set_steer_expo, so this is game.cc's own
  // default arriving in the browser — the number the shipped game actually
  // steers with, not a source literal.
  assert.equal(abi.getSteerExpo(), protocol.STEER.EXPO,
    'the shipped wasm steering exponent drifted from protocol.STEER.EXPO');
});
