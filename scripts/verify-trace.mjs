// Golden-trace VERIFIER for the native-port conformance oracle.
//
// Re-runs the sim from a trace's header + recorded per-frame inputs (see
// scripts/record-trace.mjs for the format) and diffs the result against the
// recorded frames. Because the recorder and this verifier drive the SAME
// JS engine with the SAME operation order, the expectation is EXACT float
// equality — any difference at all is a real divergence. The future C++
// engine gets conformance-tested by implementing this same replay loop
// against the committed fixtures under tests/fixtures/traces/.
//
// Per frame, in order:
//   1. stored full snapshot (every Kth frame): deep-compared field by field
//      → a divergence reports the exact field path;
//   2. events: deep-compared every frame;
//   3. snapshot hash: compared every frame → a divergence between snapshot
//      frames still localises to its exact frame (path unknown until the
//      next stored snapshot).
//
// Result: { ok: true, frames } or
//   { ok: false, frame, path, expected, actual, message }
// where `frame` is the FIRST divergent frame and `path` the first divergent
// field path in canonical (sorted-key) order, or null for a hash-only miss.
//
// CLI: node scripts/verify-trace.mjs <trace.jsonl> [more.jsonl ...]

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Game, CONTRACT_VERSION } from '../public/display/engine/Game.js';
import { RaceSession } from '../public/display/RaceSession.js';
import { AiController } from '../public/display/AiDriver.js';
import { MATHLIB } from '../public/display/engine/math.js';
import {
  applyStage, applyScheduleOps, buildRaceTrack, canonicalStringify, fnv1a,
  makeDtStream, parseTrace
} from './record-trace.mjs';

// First differing field path between two plain-JSON values, or null if equal.
// Objects walk in sorted key order (canonical order, matching the trace
// bytes); floats compare with !== (exact; JSON round-trips doubles exactly,
// and 0 === -0 keeps JSON's sign-of-zero erasure from false-alarming).
export function firstDiff(expected, actual, path = '') {
  if (expected === actual) return null;
  const te = expected === null ? 'null' : typeof expected;
  const ta = actual === null ? 'null' : typeof actual;
  if (te !== 'object' || ta !== 'object') return { path, expected, actual };
  const ae = Array.isArray(expected), aa = Array.isArray(actual);
  if (ae !== aa) return { path, expected, actual };
  if (ae) {
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      const d = firstDiff(expected[i], actual[i], `${path}[${i}]`);
      if (d) return d;
    }
    if (expected.length !== actual.length) {
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const k of keys) {
    const d = firstDiff(expected[k], actual[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

// Traces are engine- and platform-independent: the sim's transcendentals go
// through engine/math.js (fdlibm WASM), not V8's Math.*. The ONE provenance
// replay depends on is the mathlib build stamped in the header — a trace
// recorded with a different (or no) mathlib stamp predates the current build
// and must be re-recorded, not chased as a sim bug.
export function mathMatches(header) {
  return header.math === MATHLIB;
}

function mathHint(header) {
  if (mathMatches(header)) return '';
  return ` [mathlib mismatch: trace recorded with ${header.math ?? 'V8 Math.* (pre-mathlib header)'}, ` +
    `replaying with ${MATHLIB}; transcendental results differ between mathlib builds, ` +
    `so this divergence is expected — re-record the trace.]`;
}

// Verify a parsed trace ({ header, records }) or raw JSONL text.
export function verifyTrace(trace) {
  const { header, records } = typeof trace === 'string' ? parseTrace(trace) : trace;

  if (header.contractVersion !== CONTRACT_VERSION) {
    return {
      ok: false, frame: -1, path: 'header.contractVersion',
      expected: header.contractVersion, actual: CONTRACT_VERSION,
      message: `trace was recorded against contract v${header.contractVersion}, engine is v${CONTRACT_VERSION} — re-record`
    };
  }
  if (records.length !== header.frames) {
    return {
      ok: false, frame: -1, path: 'header.frames',
      expected: header.frames, actual: records.length,
      message: `header says ${header.frames} frames, trace carries ${records.length}`
    };
  }

  const track = buildRaceTrack(header.trackId, { laps: header.laps, seed: header.seed });
  const pending = [];
  const isSession = header.driver === 'session';
  let raceEndResults;
  let session = null;
  let game;
  if (isSession) {
    session = new RaceSession(
      header.roster.map((r) => ({ peerIndex: r.id, stats: r.stats })),
      track,
      { onRaceEvent: (e) => pending.push(e), onRaceEnd: (r) => { raceEndResults = r; } }
    );
    game = session.engine;
    applyStage(game, header.stage);
    session.startCountdown(header.countdown);
  } else {
    game = new Game(
      header.roster.map((r) => (r.stats ? { id: r.id, stats: r.stats } : r.id)),
      track,
      { onEvent: (e) => pending.push(e) }
    );
    applyStage(game, header.stage);
  }

  // AI-LIVE traces: the recorded bot inputs are not just replayed — each bot's
  // AiController is reconstructed from the roster and re-run every frame, and
  // its output must MATCH the recorded input bit-for-bit before it is applied.
  // A diverging AI port therefore localises to the exact frame and bot, before
  // it ever moves a car.
  const aiLive = !!header.aiLive;
  const controllers = aiLive
    ? header.roster.filter((r) => r.kind === 'bot').map((r) => ({
        id: r.id,
        ai: new AiController({ skill: r.skill, laneBias: r.laneBias, seed: r.aiSeed })
      }))
    : [];
  const botKeys = new Set(header.roster.filter((r) => r.kind === 'bot').map((r) => String(r.id)));

  // JSON object keys are ALWAYS strings, but roster ids keep their real JSON
  // types (numeric peerIndex in live-shaped rosters). Map each per-frame input
  // key back to the declared roster id, or processInput would silently miss
  // the cars Map (keyed by the original id) and every input would be dropped.
  // recordTrace guarantees the String() forms are unique. A scheduled rekey
  // re-maps on the same frame boundary the recorder did.
  const idByKey = new Map(header.roster.map((r) => [String(r.id), r.id]));

  const dtFor = makeDtStream(header);
  let lastRacing = false;

  for (const rec of records) {
    applyScheduleOps(game, header.schedule, rec.frame, (oldId, newId) => {
      idByKey.delete(String(oldId));
      idByKey.set(String(newId), newId);
      if (botKeys.delete(String(oldId))) botKeys.add(String(newId));
      for (const c of controllers) if (String(c.id) === String(oldId)) c.id = newId;
    });

    // Replay exactly what the recorder applied: humans (and, in input-replay
    // traces, bots) from the recorded inputs; ids are unique per frame and
    // input latches are car-local, so application order across cars cannot
    // matter. In ai-live traces bot inputs come from the re-run AI below.
    for (const [key, msg] of Object.entries(rec.inputs || {})) {
      if (aiLive && botKeys.has(key)) continue;
      const id = idByKey.get(key);
      if (id === undefined) {
        return {
          ok: false, frame: rec.frame, path: `inputs.${key}`, expected: undefined, actual: msg,
          message: `frame ${rec.frame}: input for '${key}', which is not in the header roster (corrupted trace)`
        };
      }
      if (session) session.processInput(id, msg); else game.processInput(id, msg);
    }
    if (aiLive && (!session || session.racing)) {
      for (const c of controllers) {
        let derived;
        const capture = { drive: (car, centerline, g) => {
          const m = c.ai.drive(car, centerline, g);
          derived = { s: m.s, b: m.b, u: m.u };
          return m;
        } };
        game.driveBot(c.id, capture);
        const recorded = (rec.inputs || {})[String(c.id)];
        const d = firstDiff(recorded, derived, `inputs.${String(c.id)}`);
        if (d) {
          return {
            ok: false, frame: rec.frame, path: d.path, expected: d.expected, actual: d.actual,
            message: `frame ${rec.frame}: AI-LIVE divergence for bot '${String(c.id)}': ` +
              `${d.path} (recorded ${JSON.stringify(d.expected)}, re-run AI produced ${JSON.stringify(d.actual)})` + mathHint(header)
          };
        }
      }
    }

    const dtF = dtFor(rec.frame);
    if (session) session.update(dtF); else game.update(dtF);

    if (session) {
      // The session's own beats are part of the contract: racing flips and the
      // end-of-race results must land on the recorded frames, exactly.
      const expectedRacing = rec.racing;
      if (session.racing !== lastRacing) {
        if (expectedRacing !== session.racing) {
          return {
            ok: false, frame: rec.frame, path: 'racing', expected: expectedRacing, actual: session.racing,
            message: `frame ${rec.frame}: session.racing flipped to ${session.racing} but the trace ${expectedRacing === undefined ? 'records no flip' : `records ${expectedRacing}`}`
          };
        }
        lastRacing = session.racing;
      } else if (expectedRacing !== undefined) {
        return {
          ok: false, frame: rec.frame, path: 'racing', expected: expectedRacing, actual: lastRacing,
          message: `frame ${rec.frame}: trace records a racing flip to ${expectedRacing} that did not happen on replay`
        };
      }
      const gotEnd = raceEndResults; raceEndResults = undefined;
      const de = firstDiff(rec.raceEnd, gotEnd, 'raceEnd');
      if (de) {
        return {
          ok: false, frame: rec.frame, path: de.path, expected: de.expected, actual: de.actual,
          message: `frame ${rec.frame}: raceEnd diverged (recorded ${JSON.stringify(de.expected)}, replay ${JSON.stringify(de.actual)})` + mathHint(header)
        };
      }
    }

    const events = pending.splice(0);
    const snapshot = game.getSnapshot();

    if (rec.snapshot !== undefined) {
      const d = firstDiff(rec.snapshot, snapshot, 'snapshot');
      if (d) {
        return {
          ok: false, frame: rec.frame, path: d.path, expected: d.expected, actual: d.actual,
          message: `frame ${rec.frame}: ${d.path} diverged (recorded ${JSON.stringify(d.expected)}, replay ${JSON.stringify(d.actual)})` + mathHint(header)
        };
      }
    }
    const de = firstDiff(rec.events || [], events, 'events');
    if (de) {
      return {
        ok: false, frame: rec.frame, path: de.path, expected: de.expected, actual: de.actual,
        message: `frame ${rec.frame}: ${de.path} diverged (recorded ${JSON.stringify(de.expected)}, replay ${JSON.stringify(de.actual)})` + mathHint(header)
      };
    }
    const hash = fnv1a(canonicalStringify(snapshot));
    if (hash !== rec.hash) {
      return {
        ok: false, frame: rec.frame, path: null, expected: rec.hash, actual: hash,
        message: `frame ${rec.frame}: snapshot hash diverged (recorded ${rec.hash}, replay ${hash}); ` +
          `no full snapshot stored this frame — nearest field-level diff is at the next stored snapshot (every ${header.snapshotEvery} frames)` + mathHint(header)
      };
    }
  }

  return { ok: true, frames: records.length };
}

// Convenience: verify a trace file on disk.
export function verifyTraceFile(file) {
  return verifyTrace(fs.readFileSync(file, 'utf8'));
}

// ---- thin CLI wrapper ----
function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/verify-trace.mjs <trace.jsonl> [more.jsonl ...]');
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const r = verifyTraceFile(f);
    if (r.ok) {
      console.log(`PASS ${f} (${r.frames} frames, exact)`);
    } else {
      failed++;
      console.error(`FAIL ${f}: ${r.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
