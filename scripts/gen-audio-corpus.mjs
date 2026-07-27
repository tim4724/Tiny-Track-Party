// Generates tests/fixtures/audio-corpus.jsonl — the oracle for the display's
// AUDIO DECISIONS (public/display/audio/decide.js).
//
// WHY IT EXISTS NOW. docs/native-port/shared-cpp-plan.md P7 moves those decisions
// into C++. The repo's conformance rests on JS-RECORDED fixtures because they are
// the only CROSS-IMPLEMENTATION evidence that a port matches the JS it replaced,
// and the ratchet is one-way: gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs
// can no longer RUN, because their JS twins were deleted. So this records the
// command stream WHILE the JS that produces it still exists.
//
// EVERY INPUT IS COMMITTED. The generator reads only:
//   - tests/fixtures/traces/*.jsonl        the frozen golden traces
//   - public/display/engine/native/ttp_runtime.{mjs,wasm}   the shipped engine
//   - public/display/audio/decide.js       the layer under record
// so a clean clone at this commit reproduces the corpus byte for byte. There is
// no hidden state: the clock is a synthetic dt accumulator and the music RNG is
// a seeded mulberry32, both injected.
//
// TWO KINDS OF CASE, and they cover different things.
//
// 1. TRACE cases. Each golden trace is replayed through the SHIPPED wasm's C ABI
//    with every roster entry added as a human and the recorded inputs fed back —
//    the same construction tests/runtime-abi.test.js uses — and every frame's
//    snapshot hash is checked against the trace before any audio is decided. So
//    the world the decisions see is provably the recorded one, not a re-derived
//    approximation. Each trace is then re-run through the decision layer under
//    several AI/HUMAN SPLITS: the sim does not care which cars are "human" (the
//    inputs are scripted either way), but the audio does — the human cars are the
//    listeners AND the only voiced cars, so sweeping the split is what exercises
//    the distance curve at real, varied ranges.
//
//    Three of the eight traces are NOT replayable from Node and are left out:
//    skysnake stages a rocket and tidepool-schedule drives giveItem/useItem/
//    setCarStats, and the C ABI exports none of those (replay_cli calls the C++
//    objects directly, so only IT can drive them). Their sim state cannot be
//    reproduced here, and a trace whose hashes do not check is not evidence.
//    tidepool-ailive is the SAME race as tidepool-4bots (same track, seed and
//    roster — identical events), so it would add nothing but bytes.
//
// 2. SCRIPTED cases. Hand-authored, fully self-describing (each line carries its
//    own input), and aimed at exactly what the traces cannot reach: the knees of
//    the distance curve, the whole event table including the types no replayable
//    trace fires, the shared-scrub arbitration under contention, the voice
//    start/stop thresholds, the rocket jet lifecycle, and the music shuffle. The
//    test replays these straight out of the corpus with no wasm at all.
//
// PER-FRAME EMISSION ORDER is the shell's: a frame's race events are drained and
// decided first (that is where RaceSession fires them, inside update()), then the
// per-frame voice drive runs. `cmds` is that concatenation, in order.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-audio-corpus.mjs [--check | --stdout]
//   --check  re-derive and require the committed corpus to match, writing nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringify, fnv1a, mulberry32, MATHLIB } from './oracle-lib.mjs';
import { AudioDecider } from '../public/display/audio/decide.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/audio-corpus.jsonl');
const TRACE_DIR = path.join(ROOT, 'tests/fixtures/traces');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');

// Which traces, and which AI/human splits each is recorded under.
//   none      every car is a CPU racer — no listeners at all, so every world cue
//             is out of earshot and no car is voiced. The degenerate branch.
//   first     roster[0] is the human: one listener, one voiced car.
//   firstTwo  roster[0..1] are humans: two listeners, so nearestHumanDist is a
//             real minimum and two cars are voiced.
export const TRACES = [
  { file: 'tidepool-4bots-600f-seed42.jsonl', splits: ['none', 'first', 'firstTwo'] },
  { file: 'helix-3bots-1human-500f-seed7.jsonl', splits: ['none', 'first', 'firstTwo'] },
  { file: 'helix-session-jitter-3bots-1human-800f-seed7.jsonl', splits: ['first'] },
  { file: 'tidepool-session-beats-3bots-450f-seed21.jsonl', splits: ['first', 'firstTwo'] },
  { file: 'tidepool-session-ailive-4bots-900f-seed13.jsonl', splits: ['first'] },
];

// ---------------------------------------------------------------------------
// The shipped engine's C ABI, in Node.
// ---------------------------------------------------------------------------
async function loadAbi() {
  if (!fs.existsSync(MJS)) {
    throw new Error('public/display/engine/native/ttp_runtime.mjs missing — '
      + 'run native/scripts/build-runtime-web.sh');
  }
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (name, ret, args) => M.cwrap(name, ret, args);
  return {
    M,
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', null, ['number', 'string', 'string']),
    start: cw('ttp_session_start', null, ['number', 'number']),
    update: cw('ttp_update', null, ['number', 'number']),
    input: cw('ttp_process_input', null, ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    events: cw('ttp_events_json', 'string', ['number']),
    carIds: cw('ttp_car_ids_json', 'string', ['number']),
    carWorldPos: cw('ttp_car_world_pos', 'number', ['number', 'string', 'number']),
    trackPoint: cw('ttp_track_point', 'number', ['number', 'number', 'number', 'number']),
    version: cw('ttp_version', 'string', []),
    dispose: cw('ttp_dispose', null, ['number']),
  };
}

// ---------------------------------------------------------------------------
// Replay one trace and capture, per frame, everything the audio decisions read.
// Split-independent by construction: positions are recorded for EVERY car, and
// which of them are listeners is decided later, per split.
// ---------------------------------------------------------------------------
function captureTrace(abi, file) {
  const lines = fs.readFileSync(path.join(TRACE_DIR, file), 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.math !== MATHLIB) throw new Error(`${file}: mathlib stamp ${header.math} != ${MATHLIB}`);
  const recs = lines.slice(1).map((l) => JSON.parse(l));
  if (recs.length !== header.frames) throw new Error(`${file}: frame count`);

  const isSession = header.driver === 'session';
  const countdown = header.countdown === undefined ? 3 : header.countdown;
  // makeDtStream, as replay_cli reproduces it (see native/replay/replay_cli.cc).
  const jj = header.dtJitter;
  const dtRng = mulberry32((jj && jj.jseed) ? jj.jseed : 1);
  const dtFor = (frame) => {
    if (!jj) return header.dt;
    let d = header.dt + (dtRng() * 2 - 1) * (jj.amp || 0);
    if (jj.spikeEvery && frame > 0 && frame % jj.spikeEvery === 0) d *= (jj.spikeScale === undefined ? 4 : jj.spikeScale);
    return d;
  };

  // The roster's JSON-scalar ids: the ABI needs `3` and `"cpu-bolt"` kept apart.
  const keyToId = new Map();
  for (const r of header.roster) keyToId.set(String(r.id), r.id);

  const vecPtr = abi.M._malloc(3 * 8);
  const vec = () => ({
    x: abi.M.HEAPF64[vecPtr >> 3],
    y: abi.M.HEAPF64[(vecPtr >> 3) + 1],
    z: abi.M.HEAPF64[(vecPtr >> 3) + 2],
  });

  const h = abi.begin(header.trackId, header.seed >>> 0, header.laps, null);
  if (!h) throw new Error(`${file}: ttp_session_begin failed`);
  // Everyone is added as a HUMAN and driven by the recorded inputs — the bots'
  // controls are in the trace, so the sim never has to re-derive them (and the
  // hash check below proves the state is identical either way).
  for (const r of header.roster) abi.addHuman(h, JSON.stringify(r.id), r.stats ? JSON.stringify(r.stats) : null);
  abi.start(h, isSession ? countdown : -1);

  const frames = [];
  let nowMs = 0;
  for (const rec of recs) {
    if (rec.inputs) {
      for (const [key, msg] of Object.entries(rec.inputs)) {
        const idJson = JSON.stringify(keyToId.get(key));
        let mask = 0;
        if (typeof msg.s === 'number') mask |= 1;
        if (typeof msg.b === 'number' || typeof msg.b === 'boolean') mask |= 2;
        if (typeof msg.u === 'number') mask |= 4;
        const b = typeof msg.b === 'boolean' ? (msg.b ? 1 : 0) : (msg.b || 0);
        abi.input(h, idJson, mask, msg.s || 0, b, msg.u || 0);
      }
    }
    const dt = dtFor(rec.frame);
    abi.update(h, dt);
    nowMs += dt;

    // Events first — that is the order RaceSession drains them in, and it is the
    // order the display's audio hears them in.
    const evs = JSON.parse(abi.events(h));
    const raceEvents = evs.filter((e) => !String(e.type || '').startsWith('_'));
    const expected = rec.events || [];
    if (canonicalStringify(raceEvents) !== canonicalStringify(expected)) {
      throw new Error(`${file} frame ${rec.frame}: events diverged from the trace\n`
        + `  trace:  ${canonicalStringify(expected)}\n  replay: ${canonicalStringify(raceEvents)}`);
    }
    // World points for the positioned events, read while the sim holds the state
    // that produced them (exactly where main.js reads them).
    const beats = [];
    for (const e of evs) {
      if (String(e.type || '').startsWith('_')) { beats.push({ beat: e }); continue; }
      let pos = null;
      if (e.type === 'rocket_expire') pos = abi.trackPoint(h, e.s, e.lat, vecPtr) ? vec() : null;
      else if (e.id != null) pos = abi.carWorldPos(h, JSON.stringify(e.id), vecPtr) ? vec() : null;
      beats.push({ event: e, pos });
    }
    // Every live car's world point, so each split can pick its own listeners.
    const livePos = [];
    if (beats.some((b) => b.event)) {
      for (const id of JSON.parse(abi.carIds(h))) {
        livePos.push({ id, pos: abi.carWorldPos(h, JSON.stringify(id), vecPtr) ? vec() : null });
      }
    }

    const snapText = abi.snapshot(h);
    const got = fnv1a(snapText);
    if (got !== rec.hash) {
      throw new Error(`${file} frame ${rec.frame}: snapshot hash ${got} != recorded ${rec.hash} — `
        + 'the replay is not reproducing the golden trace, so nothing recorded from it is evidence');
    }
    const snap = JSON.parse(snapText);
    const rockets = (snap.rockets || []).map((r) => ({
      id: r.id, pos: abi.trackPoint(h, r.s, r.lat, vecPtr) ? vec() : null,
    }));

    frames.push({ frame: rec.frame, nowMs, cars: snap.cars, rockets, beats, livePos });
  }
  abi.dispose(h);
  abi.M._free(vecPtr);
  return { header, frames };
}

// Run one capture through the decision layer under one AI/human split.
function decideTrace(capture, split) {
  const ids = capture.header.roster.map((r) => r.id);
  const humans = split === 'none' ? [] : split === 'first' ? ids.slice(0, 1) : ids.slice(0, 2);
  const aiIds = new Set(ids.filter((id) => !humans.includes(id)));
  const dec = new AudioDecider({ rng: () => { throw new Error('trace cases must not draw randomness'); } });
  const out = [];
  let ended = false;
  for (const f of capture.frames) {
    const cmds = [];
    for (const b of f.beats) {
      if (b.beat) {
        // Session beats. The countdown chimes; the GO beat starts the race song,
        // which is NOT recorded here (a trace header carries no biome, and the
        // shuffle is swept exhaustively in the scripted cases instead); the end
        // beat is where endRace kills the voices and the music.
        if (b.beat.type === '_countdown') cmds.push(...dec.countdown(b.beat.n));
        else if (b.beat.type === '_raceEnd') {
          ended = true;
          cmds.push(...dec.stopVoices(), ...dec.stopMusic());
        }
        continue;
      }
      const humanPositions = [];
      for (const c of f.livePos) if (!aiIds.has(c.id) && c.pos) humanPositions.push(c.pos);
      cmds.push(...dec.event(b.event, { pos: b.pos, humanPositions, aiIds, nowMs: f.nowMs }));
    }
    // raceEnded freezes the scene, so the per-frame drive stops with it.
    if (!ended) {
      cmds.push(...dec.frame({ cars: f.cars, rockets: f.rockets, aiIds, nowMs: f.nowMs }));
    }
    out.push({ case: 'trace', trace: capture.header.trackId, file: capture.file, split, frame: f.frame, cmds });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scripted cases. Each scenario is a fresh decider plus a list of steps; every
// step carries its own input, so the test replays them with no engine at all.
// ---------------------------------------------------------------------------
const P = (x, y, z) => ({ x, y, z });
// A human parked at the origin: the listener every scripted distance is measured from.
const ORIGIN = [P(0, 0, 0)];

// A car for frame() — only the fields the decisions read.
function car(id, o = {}) {
  return {
    id,
    pose: { pos: o.pos || P(0, 0, 0) },
    spd: o.spd === undefined ? 0 : o.spd,
    steer: o.steer === undefined ? 0 : o.steer,
    brake: o.brake === undefined ? 0 : o.brake,
    boostMul: o.boostMul === undefined ? 1 : o.boostMul,
    spin: o.spin === undefined ? 0 : o.spin,
    monster: !!o.monster,
    onWall: !!o.onWall,
  };
}

function scenarios() {
  const list = [];

  // -- the distance curve, at and around every knee ------------------------
  {
    const steps = [];
    // AUD_NEAR=8, AUD_FAR=34, AUD_CUT=64. The values on either side of each knee
    // are what pin the comparison operators (<= vs <) as well as the ramps.
    const ds = [0, 0.5, 4, 7.999999, 8, 8.000001, 12, 20, 26, 33.999999, 34,
                34.000001, 40, 50, 60, 63.999999, 64, 64.000001, 80, 1000];
    for (const d of ds) {
      // Straight down each axis and along a diagonal, so Math.hypot's three
      // components are all exercised rather than just x.
      const k = d / Math.sqrt(3);
      for (const pos of [P(d, 0, 0), P(0, d, 0), P(0, 0, d), P(k, k, k), P(-d, 0, 0)]) {
        steps.push({ kind: 'event', in: { e: { type: 'pickup', id: 'cpu-1' },
          ctx: { pos, humanPositions: ORIGIN, aiIds: ['cpu-1'], nowMs: 0 } } });
      }
    }
    // Two listeners: the nearer one must win, whichever order they arrive in.
    for (const d of [5, 12, 30, 50, 70]) {
      for (const humans of [[P(0, 0, 0), P(d * 2, 0, 0)], [P(d * 2, 0, 0), P(0, 0, 0)]]) {
        steps.push({ kind: 'event', in: { e: { type: 'pickup', id: 'cpu-1' },
          ctx: { pos: P(d, 0, 0), humanPositions: humans, aiIds: ['cpu-1'], nowMs: 0 } } });
      }
    }
    // No listeners at all, and a source with no position.
    steps.push({ kind: 'event', in: { e: { type: 'pickup', id: 'cpu-1' },
      ctx: { pos: P(1, 0, 0), humanPositions: [], aiIds: ['cpu-1'], nowMs: 0 } } });
    steps.push({ kind: 'event', in: { e: { type: 'pickup', id: 'cpu-1' },
      ctx: { pos: null, humanPositions: ORIGIN, aiIds: ['cpu-1'], nowMs: 0 } } });
    list.push({ name: 'curve-sweep', steps });
  }

  // -- the whole event table ------------------------------------------------
  {
    const steps = [];
    const RANGES = [
      ['own', P(0, 0, 0)],     // the player's own car: distance 0 -> the ceiling
      ['near', P(6, 0, 0)],    // inside AUD_NEAR
      ['mid', P(20, 0, 0)],    // on the main ramp
      ['far', P(50, 0, 0)],    // on the taper
      ['gone', P(200, 0, 0)],  // past AUD_CUT -> silent
      ['nopos', null],         // the car is already gone
    ];
    const EVENTS = [
      { type: 'pickup', item: 'boost' },
      { type: 'pickup', item: 'boost', finished: true },
      { type: 'item_use', item: 'banana' },
      { type: 'item_use', item: 'monster' },
      { type: 'item_use', item: 'rocket' },
      { type: 'item_use', item: 'boost' },
      { type: 'monster_end' },
      { type: 'spin', cause: 'banana' },
      { type: 'spin', cause: 'oil' },
      { type: 'spin', cause: 'monster' },
      { type: 'spin', cause: 'rocket' },
      { type: 'lap', lap: 2 },
      { type: 'finish' },
      { type: 'rocket_expire', s: 12, lat: 0 },
      { type: 'no_such_event' },
    ];
    let t = 0;
    for (const [, pos] of RANGES) {
      for (const owner of ['human-1', 'cpu-1']) {
        for (const e of EVENTS) {
          // Space every step past LAP_GAP_MS so the table is read without the lap
          // chime's throttle folding entries together (the throttle has its own
          // scenario below).
          t += 1000;
          steps.push({ kind: 'event', in: { e: { ...e, id: owner },
            ctx: { pos, humanPositions: ORIGIN, aiIds: ['cpu-1'], nowMs: t } } });
        }
      }
    }
    // Idless / global events play at the world-cue ceiling and count as human.
    for (const e of [{ type: 'lap' }, { type: 'finish' }, { type: 'pickup' }, { type: 'spin', cause: 'oil' }]) {
      t += 1000;
      steps.push({ kind: 'event', in: { e, ctx: { pos: null, humanPositions: ORIGIN, aiIds: ['cpu-1'], nowMs: t } } });
    }
    // The lap chime's 350 ms spacing, walked across the edge.
    for (const dt of [0, 100, 349, 350, 351, 1, 700]) {
      t += dt;
      steps.push({ kind: 'event', in: { e: { type: 'lap', id: 'human-1' },
        ctx: { pos: P(0, 0, 0), humanPositions: ORIGIN, aiIds: [], nowMs: t } } });
    }
    list.push({ name: 'event-table', steps });
  }

  // -- the shared curb-scrub throttle ---------------------------------------
  {
    const steps = [];
    const human = car('human-1', { pos: P(0, 0, 0) });
    const frame = (cars, nowMs) => steps.push({ kind: 'frame',
      in: { cars, rockets: [], aiIds: cars.filter((c) => c.id !== 'human-1').map((c) => c.id), nowMs } });
    // One scrubber, sweeping the speed gate (SCRUB_SPD_MIN = 0.35) — and note the
    // FIRST scrub of each frame set fires, then the 140 ms window closes.
    let t = 0;
    for (const spd of [0.2, 0.35, 0.351, 0.5, 0.9, 1.4]) {
      t += 200;
      frame([human, car('cpu-1', { pos: P(4, 0, 0), spd, onWall: true })], t);
    }
    // Contention: three scrubbers at different ranges. The loudest IN-SCENE one
    // owns the window, and it is the nearest, not the fastest.
    t += 200;
    frame([human,
      car('cpu-1', { pos: P(50, 0, 0), spd: 1.2, onWall: true }),
      car('cpu-2', { pos: P(10, 0, 0), spd: 0.4, onWall: true }),
      car('cpu-3', { pos: P(30, 0, 0), spd: 0.8, onWall: true })], t);
    // Order must not matter — same field, reversed.
    t += 200;
    frame([human,
      car('cpu-3', { pos: P(30, 0, 0), spd: 0.8, onWall: true }),
      car('cpu-2', { pos: P(10, 0, 0), spd: 0.4, onWall: true }),
      car('cpu-1', { pos: P(50, 0, 0), spd: 1.2, onWall: true })], t);
    // Below the FLOOR (past AUD_FAR the curve dips under AUD_FLOOR): out of the
    // competition entirely, even alone — a distant grind cannot claim the throttle.
    t += 200;
    frame([human, car('cpu-1', { pos: P(45, 0, 0), spd: 1.2, onWall: true })], t);
    t += 200;
    frame([human, car('cpu-1', { pos: P(200, 0, 0), spd: 1.2, onWall: true })], t);
    // The 140 ms window, walked across the edge with a scrub present every frame.
    for (const dt of [0, 50, 139, 140, 141, 10, 300]) {
      t += dt;
      frame([human, car('cpu-1', { pos: P(4, 0, 0), spd: 0.8, onWall: true })], t);
    }
    // The player's own car scrubbing: distance 0, so the ceiling.
    t += 500;
    frame([car('human-1', { pos: P(0, 0, 0), spd: 1.1, onWall: true })], t);
    // No listeners: nothing is in scene, so nothing scrubs.
    t += 500;
    steps.push({ kind: 'frame', in: { cars: [car('cpu-1', { pos: P(0, 0, 0), spd: 1.1, onWall: true })],
      rockets: [], aiIds: ['cpu-1'], nowMs: t } });
    list.push({ name: 'scrub-arbitration', steps });
  }

  // -- the per-car voice levels and their start/stop edges -------------------
  {
    const steps = [];
    let t = 0;
    const frame = (c) => { t += 16.667; steps.push({ kind: 'frame', in: { cars: [c], rockets: [], aiIds: [], nowMs: t } }); };
    // boost wind: silent at 1.0, full at the pad/item peak. 1.012 is the first
    // multiplier whose level clears VOICE_FLOOR (0.02 * 0.6).
    for (const boostMul of [1, 1.005, 1.012, 1.013, 1.1, 1.3, 1.6, 1.9]) frame(car('p', { boostMul }));
    // corner squeal: steer^2 through the speed gate, and silent while spinning.
    for (const spd of [0.4, 0.45, 0.5, 0.6, 0.75, 1.2]) {
      for (const steer of [0, 0.1, 0.4, 1, -1]) frame(car('p', { spd, steer }));
    }
    frame(car('p', { spd: 1, steer: 1, spin: 0.5 }));
    frame(car('p', { spd: 1, steer: 1, spin: 0 }));
    // brake skid: pressure through its own speed gate.
    for (const spd of [0.1, 0.2, 0.3, 0.6, 1]) {
      for (const brake of [0, 0.3, 1]) frame(car('p', { spd, brake }));
    }
    // engine: level rises with speed, and the monster transform swaps the timbre
    // modifier in and out mid-voice.
    for (const spd of [0, 0.02, 0.024, 0.025, 0.3, 1, 1.2, 1.8]) frame(car('p', { spd }));
    frame(car('p', { spd: 0.8, monster: true }));
    frame(car('p', { spd: 0.9, monster: true }));
    frame(car('p', { spd: 0.9, monster: false }));
    // A CPU car is never voiced, however hard it is driving.
    t += 16.667;
    steps.push({ kind: 'frame', in: { cars: [car('cpu-1', { spd: 1, steer: 1, brake: 1, boostMul: 1.6 })],
      rockets: [], aiIds: ['cpu-1'], nowMs: t } });
    list.push({ name: 'voice-thresholds', steps });
  }

  // -- the rocket jet, from launch to boom ----------------------------------
  {
    const steps = [];
    let t = 0;
    const human = car('human-1', { pos: P(0, 0, 0) });
    const frame = (rockets) => {
      t += 16.667;
      steps.push({ kind: 'frame', in: { cars: [human, car('cpu-1', { pos: P(90, 0, 0) })],
        rockets, aiIds: ['cpu-1'], nowMs: t } });
    };
    // One rocket flying in from out of earshot, past the listener, and away
    // again: the voice starts as it crosses AUD_CUT, tracks the curve, and stops
    // on the way out.
    for (let x = 100; x >= -100; x -= 5) frame([{ id: 1, pos: P(x, 0, 0) }]);
    // Two in the air at once, one of them vanishing (a hit) while the other flies on.
    frame([{ id: 2, pos: P(20, 0, 0) }, { id: 3, pos: P(5, 0, 0) }]);
    frame([{ id: 2, pos: P(15, 0, 0) }, { id: 3, pos: P(2, 0, 0) }]);
    frame([{ id: 2, pos: P(10, 0, 0) }]);          // 3 hit something: its jet must stop
    frame([]);                                     // 2 gone too
    frame([]);                                     // ... and staying gone emits nothing
    // A rocket with no resolvable world point plays at the ceiling.
    frame([{ id: 4, pos: null }]);
    frame([]);
    // Impacts. The target's own position decides the level, with the payoff floor.
    let te = t;
    const impact = (id, pos, aiIds) => {
      te += 500;
      steps.push({ kind: 'event', in: { e: { type: 'spin', cause: 'rocket', id },
        ctx: { pos, humanPositions: ORIGIN, aiIds, nowMs: te } } });
    };
    impact('human-1', P(0, 0, 0), ['cpu-1']);      // a human hit -> always full
    impact('human-1', P(500, 0, 0), ['cpu-1']);    // ... even far from the camera
    impact('cpu-1', P(2, 0, 0), ['cpu-1']);        // an AI point-blank
    impact('cpu-1', P(30, 0, 0), ['cpu-1']);       // an AI on the ramp -> the 0.45 floor
    impact('cpu-1', P(55, 0, 0), ['cpu-1']);       // an AI on the taper -> still the floor
    impact('cpu-1', P(500, 0, 0), ['cpu-1']);      // an AI out of earshot -> silent
    impact('cpu-1', null, ['cpu-1']);              // target already gone -> just play it
    // Whiffs: the self-destruct is scaled like every other world cue.
    for (const pos of [P(0, 0, 0), P(20, 0, 0), P(50, 0, 0), P(500, 0, 0), null]) {
      te += 500;
      steps.push({ kind: 'event', in: { e: { type: 'rocket_expire', s: 10, lat: 0.5 },
        ctx: { pos, humanPositions: ORIGIN, aiIds: ['cpu-1'], nowMs: te } } });
    }
    list.push({ name: 'rocket-lifecycle', steps });
  }

  // -- countdown beats, the join plink, and the voice lifecycle -------------
  {
    const steps = [];
    for (const n of [3, 2, 1, 0, -1, -2]) steps.push({ kind: 'countdown', in: { n } });
    for (const [count, inLobby] of [[1, true], [1, true], [2, true], [2, false], [3, false], [4, true], [3, true], [4, true]]) {
      steps.push({ kind: 'roster', in: { count, inLobby } });
    }
    // Voices live, then a forfeit takes one car's, then a full stop takes the
    // rest; the next frame rebuilds whatever is still driving.
    const cars = [car('p1', { spd: 1, steer: 0.8, brake: 0.5, boostMul: 1.5 }),
                  car('p2', { spd: 0.9, steer: 0.6 })];
    steps.push({ kind: 'frame', in: { cars, rockets: [{ id: 7, pos: P(3, 0, 0) }], aiIds: [], nowMs: 1000 } });
    steps.push({ kind: 'stopCar', in: { id: 'p1' } });
    steps.push({ kind: 'frame', in: { cars, rockets: [{ id: 7, pos: P(3, 0, 0) }], aiIds: [], nowMs: 1100 } });
    steps.push({ kind: 'stopVoices' });
    steps.push({ kind: 'frame', in: { cars, rockets: [{ id: 7, pos: P(3, 0, 0) }], aiIds: [], nowMs: 1200 } });
    steps.push({ kind: 'stopVoices' });
    steps.push({ kind: 'stopCar', in: { id: 'p2' } });
    list.push({ name: 'lifecycle', steps });
  }

  // -- the music shuffle ----------------------------------------------------
  // Seeded, so the pool pick, the no-repeat filter and the per-song LUFS trim are
  // all pinned. The shipped path passes no rng and draws from Math.random.
  {
    const steps = [];
    // Every biome key, then the fallback paths: an unlisted biome ('sunset' is
    // cupless and has no pool), an unknown name, and undefined.
    for (const biome of ['beach', 'playroom', 'snow', 'grass', 'canyon', 'sunset', 'no-such-biome', null]) {
      steps.push({ kind: 'music', in: { op: 'start', biome } });
    }
    // A 4-race cup through one biome: each race must avoid the song that just
    // played, so a 5-song pool rotates.
    for (let i = 0; i < 8; i++) steps.push({ kind: 'music', in: { op: 'start', biome: 'canyon' } });
    for (let i = 0; i < 8; i++) steps.push({ kind: 'music', in: { op: 'start', biome: 'grass' } });
    for (const op of ['pause', 'resume', 'stop']) steps.push({ kind: 'music', in: { op } });
    list.push({ name: 'music-shuffle', seed: 20260727, steps });
  }

  return list;
}

// Replay one scripted step. Shared with tests/audio-corpus.test.js, which drives
// the committed corpus back through the same switch.
export function applyStep(dec, step) {
  const i = step.in || {};
  switch (step.kind) {
    case 'frame':
      return dec.frame({ cars: i.cars, rockets: i.rockets, aiIds: new Set(i.aiIds), nowMs: i.nowMs });
    case 'event':
      return dec.event(i.e, { pos: i.ctx.pos, humanPositions: i.ctx.humanPositions,
        aiIds: new Set(i.ctx.aiIds), nowMs: i.ctx.nowMs });
    case 'countdown': return dec.countdown(i.n);
    case 'roster': return dec.roster(i.count, i.inLobby);
    case 'stopVoices': return dec.stopVoices();
    case 'stopCar': return dec.stopCar(i.id);
    case 'music':
      if (i.op === 'start') return dec.startMusic(i.biome);
      if (i.op === 'stop') return dec.stopMusic();
      if (i.op === 'pause') return dec.pauseMusic();
      if (i.op === 'resume') return dec.resumeMusic();
      throw new Error(`unknown music op '${i.op}'`);
    default: throw new Error(`unknown scripted step kind '${step.kind}'`);
  }
}

// ---------------------------------------------------------------------------
export async function buildCorpus() {
  const abi = await loadAbi();
  const ver = JSON.parse(abi.version());
  if (ver.mathlib !== MATHLIB) throw new Error(`shipped wasm mathlib ${ver.mathlib} != ${MATHLIB}`);

  const lines = [];
  let traceFrames = 0;
  for (const t of TRACES) {
    const cap = captureTrace(abi, t.file);
    cap.file = t.file;
    for (const split of t.splits) {
      for (const rec of decideTrace(cap, split)) {
        lines.push(canonicalStringify(rec));
        traceFrames++;
      }
    }
  }

  const scn = scenarios();
  let scriptedSteps = 0;
  for (const s of scn) {
    lines.push(canonicalStringify({ case: 'scenario', name: s.name, seed: s.seed === undefined ? null : s.seed, steps: s.steps.length }));
    const dec = new AudioDecider(s.seed === undefined
      ? { rng: () => { throw new Error(`scenario '${s.name}' must not draw randomness`); } }
      : { rng: mulberry32(s.seed) });
    s.steps.forEach((step, index) => {
      const cmds = applyStep(dec, step);
      lines.push(canonicalStringify({ case: 'scripted', name: s.name, step: index, kind: step.kind, in: step.in || null, cmds }));
      scriptedSteps++;
    });
  }

  const header = canonicalStringify({
    kind: 'audio',
    version: 1,
    math: MATHLIB,
    contractVersion: ver.contractVersion,
    traces: TRACES.length,
    traceFrames,
    scenarios: scn.length,
    scriptedSteps,
  });
  return { text: [header, ...lines].join('\n') + '\n', traceFrames, scriptedSteps, scenarios: scn.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { text, traceFrames, scriptedSteps, scenarios: nScn } = await buildCorpus();
  if (process.argv.includes('--stdout')) { process.stdout.write(text); process.exit(0); }
  if (process.argv.includes('--check')) {
    const have = fs.readFileSync(OUT, 'utf8');
    if (have !== text) {
      console.error(`${OUT}: re-derived corpus differs from the committed one`);
      process.exit(1);
    }
    console.log(`${OUT}: reproduced byte-identically (${traceFrames} trace frames, ${scriptedSteps} scripted steps)`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${traceFrames} trace frames over ${TRACES.length} traces, `
    + `${scriptedSteps} scripted steps over ${nScn} scenarios`);
}
