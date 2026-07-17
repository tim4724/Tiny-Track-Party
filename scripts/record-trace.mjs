// Golden-trace RECORDER for the native-port conformance oracle.
//
// Runs a fully seeded headless race (the same engine the display ships:
// public/display/engine/Game.js) and writes a JSONL trace:
//
//   line 1   header  { contractVersion, seed, trackId, dt, laps, roster,
//                      frames, snapshotEvery, engine }
//   line 2+  frame   { frame, inputs, events, hash [, snapshot] }
//
// Every frame carries an FNV-1a hash of the canonical-JSON snapshot, so a
// diverging port localises to the exact frame; the FULL snapshot is embedded
// every `snapshotEvery` frames (plus the last frame), so the diverging FIELD
// localises too. Inputs are what was actually applied that frame (bot
// controllers + optional scripted humans), which is why verify-trace.mjs can
// replay a trace without re-running any AI: the engine alone is under test.
//
// Determinism: no wall clock, no Math.random. The engine's item RNG is seeded
// via track.seed; each bot's AiController jitter stream is seeded from the
// header; JSON key order is fixed by canonicalStringify (recursive key sort).
// Same config in, byte-identical trace out — on the SAME JS engine. Math.sin/
// cos/atan2/exp/pow are implementation-approximated, so a different V8 (i.e. a
// different Node major) legitimately differs in the last bit and a trace only
// replays exactly under the engine that recorded it. The header's `engine`
// field records that engine ({ node, v8 }); CI pins the matching Node major
// (.github/workflows/test.yml).
//
// CLI:
//   node scripts/record-trace.mjs --track=tidepool --frames=600 [--seed=1]
//     [--bots=4] [--humans=0] [--laps=3] [--snapshot-every=60] [--out=file]
//
// Importable: recordTrace(config), buildRaceTrack, canonicalStringify, fnv1a,
// parseTrace, makeBots, scriptedHuman (the CLI's canned setup, exported so the
// committed fixtures under tests/fixtures/traces/ are exactly regenerable).

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { buildTrack, TRACKS } from '../public/display/TrackBuilder.js';
import { Game, CONTRACT_VERSION } from '../public/display/engine/Game.js';
import { AiController, AI_PERSONALITIES } from '../public/display/AiDriver.js';

// Fixed physics tick: the display's 60 Hz frame budget in ms. Stored in the
// header and re-used verbatim by the verifier, never recomputed.
export const TRACE_DT_MS = 16.667;

// ---- canonical JSON ----
// JSON.stringify with a DETERMINISTIC key order (recursive sort), so trace
// bytes never depend on object-construction order. Doubles round-trip exactly
// through JSON (shortest-representation), so parse(stringify(x)) === x.
export function canonicalStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalStringify(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}

// 32-bit FNV-1a over the UTF-8 bytes of a string, as 8 hex digits. Small,
// dependency-free, and trivial to reimplement bit-for-bit in C++.
export function fnv1a(str) {
  const bytes = new TextEncoder().encode(str);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- track construction ----
// Build a catalogue track the way the display races it: buildTrack geometry
// plus the furniture resolve (fraction-of-lap u -> arclength s) mirrored from
// display/main.js buildEntry — oils→hazards, pads (+ the auto loop-mouth
// launch strips), boxes, poles (+ builder autoPoles), authored bananas.
// Renderer-only fields (cones, cup theme) are left off: the engine never
// reads them, and the trace covers the ENGINE contract only.
export function buildRaceTrack(trackId, { laps = 3, seed = 1 } = {}) {
  const def = TRACKS[trackId];
  if (!def) throw new Error(`unknown trackId '${trackId}' (known: ${Object.keys(TRACKS).join(', ')})`);
  const b = buildTrack(def);
  b.trackId = trackId;
  b.totalLaps = laps;
  b.seed = seed >>> 0; // the engine's item-roll RNG seed (Game reads track.seed)
  const u2s = (u) => (((u % 1) + 1) % 1) * b.length;
  b.hazards = (def.oils || []).map((o) => ({
    s: u2s(o.u), lat: o.lat || 0,
    radius: o.radius != null ? o.radius : b.roadWidth * 0.2
  }));
  b.pads = (def.pads || []).map((p) => ({
    s: u2s(p.u), lat: p.lat || 0,
    radius: p.radius != null ? p.radius : b.roadWidth * 0.18
  }));
  const LOOP_PAD_LEN = 2.2; // world units along travel (mirrors main.js)
  for (const ls of (b.loopStarts || [])) {
    b.pads.push({
      s: (((ls.s - LOOP_PAD_LEN / 2) % b.length) + b.length) % b.length,
      lat: 0, shape: 'strip', halfLen: LOOP_PAD_LEN / 2, halfWidth: ls.width / 2
    });
  }
  b.boxes = (def.boxes || []).map((p) => ({
    s: u2s(p.u), lat: p.lat || 0,
    radius: p.radius != null ? p.radius : b.roadWidth * 0.09
  }));
  b.poles = (def.poles || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : 0.45 }))
    .concat(b.autoPoles || []);
  b.bananas = (def.bananas || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0 }));
  return b;
}

// ---- recording ----
// config: {
//   trackId, frames,                       required
//   seed = 1, laps = 3, dt = TRACE_DT_MS, snapshotEvery = 60,
//   bots = [{ id, skill, laneBias, aiSeed?, stats? }],
//   humans = [{ id, script(frame) -> {s,b,u} | null, stats? }]
// }
// Human scripts must be pure functions of the frame index (no clock, no
// randomness): their OUTPUT is recorded, so verify replays them exactly.
// Returns { header, records, text } — text is the exact JSONL file content.
export function recordTrace(config) {
  const {
    trackId, frames,
    seed = 1, laps = 3, dt = TRACE_DT_MS, snapshotEvery = 60,
    bots = [], humans = []
  } = config;
  if (!trackId || !Number.isInteger(frames) || frames <= 0) {
    throw new Error('recordTrace: config needs a trackId and a positive integer frames');
  }

  // Grid order matters (staggered spawn): humans first, then bots — the same
  // shape a live lobby produces. The roster records everything verify needs
  // to rebuild the Game (ids + stats); bot AI params ride along as metadata
  // (verify replays recorded inputs, it never re-runs the AI).
  const roster = [
    ...humans.map((h) => ({ id: h.id, kind: 'human', ...(h.stats ? { stats: h.stats } : {}) })),
    ...bots.map((b, i) => ({
      id: b.id, kind: 'bot',
      skill: b.skill != null ? b.skill : 0.9,
      laneBias: b.laneBias || 0,
      aiSeed: (b.aiSeed != null ? b.aiSeed : (seed * 31 + i + 1)) >>> 0,
      ...(b.stats ? { stats: b.stats } : {})
    }))
  ];
  const ids = roster.map((r) => r.id);
  // Uniqueness is checked on the String() forms: JSONL stores per-frame inputs
  // as object keys (always strings), and the verifier maps those keys back to
  // roster ids, so ids that collide once stringified (3 vs '3') could not
  // replay faithfully. This also catches plain duplicates.
  if (new Set(ids.map(String)).size !== ids.length) {
    throw new Error('recordTrace: car ids must be unique when compared as strings (JSONL input keys are strings)');
  }

  const header = {
    contractVersion: CONTRACT_VERSION,
    seed, trackId, dt, laps, roster, frames, snapshotEvery,
    // The JS engine that recorded this trace. Bit-exact replay is only
    // guaranteed on the same engine (transcendental Math.* results are
    // implementation-approximated and differ across V8 versions).
    engine: { node: process.versions.node, v8: process.versions.v8 }
  };

  const track = buildRaceTrack(trackId, { laps, seed });
  const pending = [];
  const game = new Game(
    roster.map((r) => (r.stats ? { id: r.id, stats: r.stats } : r.id)),
    track,
    { onEvent: (e) => pending.push(e) }
  );

  // One AiController per bot, seeded from the header — plus a capture wrapper
  // so the input driveBot applies lands in the frame record verbatim.
  const controllers = roster.filter((r) => r.kind === 'bot').map((r) => {
    const ai = new AiController({ skill: r.skill, laneBias: r.laneBias, seed: r.aiSeed });
    return { id: r.id, ai };
  });
  const scripts = humans.map((h) => ({ id: h.id, script: h.script }));

  const records = [];
  for (let frame = 0; frame < frames; frame++) {
    const inputs = {};
    for (const h of scripts) {
      const m = h.script ? h.script(frame) : null;
      if (!m) continue;
      const msg = {};
      if (typeof m.s === 'number') msg.s = m.s;
      if (typeof m.b === 'number' || typeof m.b === 'boolean') msg.b = m.b;
      if (typeof m.u === 'number') msg.u = m.u;
      inputs[h.id] = msg;
      game.processInput(h.id, msg);
    }
    for (const c of controllers) {
      const capture = { drive: (car, centerline, g) => {
        const m = c.ai.drive(car, centerline, g);
        inputs[c.id] = { s: m.s, b: m.b, u: m.u };
        return m;
      } };
      game.driveBot(c.id, capture); // false (finished/poseless) → no input recorded
    }
    game.update(dt);
    const events = pending.splice(0);
    const snapshot = game.getSnapshot();
    const rec = { frame, inputs, events, hash: fnv1a(canonicalStringify(snapshot)) };
    if ((snapshotEvery > 0 && frame % snapshotEvery === 0) || frame === frames - 1) {
      rec.snapshot = snapshot;
    }
    records.push(rec);
  }

  const text = [header, ...records].map(canonicalStringify).join('\n') + '\n';
  return { header, records, text };
}

// Parse a JSONL trace back into { header, records }.
export function parseTrace(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('parseTrace: trace needs a header line + at least one frame');
  const header = JSON.parse(lines[0]);
  const records = lines.slice(1).map((l) => JSON.parse(l));
  return { header, records };
}

// ---- the CLI's canned setup (exported so fixtures are regenerable) ----

// n bots drawn from the shipped persona ladder (cycling), ids cpu-<name>.
export function makeBots(n, seed = 1) {
  return Array.from({ length: n }, (_, i) => {
    const p = AI_PERSONALITIES[i % AI_PERSONALITIES.length];
    const suffix = i >= AI_PERSONALITIES.length ? `-${Math.floor(i / AI_PERSONALITIES.length) + 1}` : '';
    return { id: `cpu-${p.name.toLowerCase()}${suffix}`, skill: p.skill, laneBias: p.laneBias, aiSeed: (seed * 31 + i + 1) >>> 0 };
  });
}

// A deterministic scripted "human": weaves a sine steer, stabs the brake on a
// fixed cadence, and bumps the ACTION counter now and then (fires any held
// item). Pure function of the frame index — no clock, no randomness. It does
// NOT follow the track (it kisses walls and curbs), which is deliberate: wall
// scrub and curb wash are engine paths the well-behaved bots rarely exercise.
export function scriptedHuman(index = 0) {
  const phase = index * 17;
  return {
    id: `human-${index + 1}`,
    script: (frame) => ({
      s: Math.sin((frame + phase) / 40) * 0.6,
      b: (frame + phase) % 240 < 25 ? 1 : 0,
      u: Math.floor(frame / 300) & 255
    })
  };
}

// ---- thin CLI wrapper ----
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognised argument: ${a}`);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.track || !a.frames) {
    console.error('usage: node scripts/record-trace.mjs --track=<id> --frames=<n> [--seed=1] [--bots=4] [--humans=0] [--laps=3] [--snapshot-every=60] [--out=file]');
    process.exit(2);
  }
  const seed = Number(a.seed ?? 1);
  const config = {
    trackId: a.track,
    frames: Number(a.frames),
    seed,
    laps: Number(a.laps ?? 3),
    snapshotEvery: Number(a['snapshot-every'] ?? 60),
    bots: makeBots(Number(a.bots ?? 4), seed),
    humans: Array.from({ length: Number(a.humans ?? 0) }, (_, i) => scriptedHuman(i))
  };
  const { text, records } = recordTrace(config);
  if (a.out) {
    fs.mkdirSync(path.dirname(a.out), { recursive: true });
    fs.writeFileSync(a.out, text);
    const snaps = records.filter((r) => r.snapshot !== undefined).length;
    console.log(`wrote ${a.out}: ${records.length} frames, ${snaps} full snapshots, ${Buffer.byteLength(text)} bytes`);
  } else {
    process.stdout.write(text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
