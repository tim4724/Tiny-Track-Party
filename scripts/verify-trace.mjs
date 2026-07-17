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
import { buildRaceTrack, canonicalStringify, fnv1a, parseTrace } from './record-trace.mjs';

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

// Bit-exact replay is only guaranteed on the JS engine AND platform that
// recorded the trace: transcendental Math.* results are
// implementation-approximated, differ across V8 versions, and differ across
// architectures on the same V8 (per-arch codegen of V8's compiled fdlibm).
// When a divergence is reported under a different engine or platform than
// the header records, suspect that mismatch before the sim.
export function engineMatches(header) {
  const rec = header.engine;
  if (!rec) return false; // pre-engine-stamp trace: provenance unknown
  return rec.os === process.platform && rec.arch === process.arch &&
    rec.node.split('.')[0] === process.versions.node.split('.')[0];
}

function engineHint(header) {
  if (engineMatches(header)) return '';
  const rec = header.engine;
  const recorded = rec
    ? `Node ${rec.node} (V8 ${rec.v8}) on ${rec.os}/${rec.arch}`
    : 'an unknown engine (header predates the engine stamp)';
  return ` [engine/platform mismatch: trace recorded on ${recorded}, ` +
    `replaying on Node ${process.versions.node} (V8 ${process.versions.v8}) ` +
    `on ${process.platform}/${process.arch}; transcendental Math.* differs ` +
    `across V8 versions and across architectures, so this divergence is ` +
    `expected. Replay on the recording platform or re-record there.]`;
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
  const game = new Game(
    header.roster.map((r) => (r.stats ? { id: r.id, stats: r.stats } : r.id)),
    track,
    { onEvent: (e) => pending.push(e) }
  );

  // JSON object keys are ALWAYS strings, but roster ids keep their real JSON
  // types (numeric peerIndex in live-shaped rosters). Map each per-frame input
  // key back to the declared roster id, or processInput would silently miss
  // the cars Map (keyed by the original id) and every input would be dropped.
  // recordTrace guarantees the String() forms are unique.
  const idByKey = new Map(header.roster.map((r) => [String(r.id), r.id]));

  for (const rec of records) {
    // Replay exactly what the recorder applied. Ids are unique per frame, so
    // application order across cars cannot matter (processInput only writes
    // that car's own input latch).
    for (const [key, msg] of Object.entries(rec.inputs || {})) {
      const id = idByKey.get(key);
      if (id === undefined) {
        return {
          ok: false, frame: rec.frame, path: `inputs.${key}`, expected: undefined, actual: msg,
          message: `frame ${rec.frame}: input for '${key}', which is not in the header roster (corrupted trace)`
        };
      }
      game.processInput(id, msg);
    }
    game.update(header.dt);
    const events = pending.splice(0);
    const snapshot = game.getSnapshot();

    if (rec.snapshot !== undefined) {
      const d = firstDiff(rec.snapshot, snapshot, 'snapshot');
      if (d) {
        return {
          ok: false, frame: rec.frame, path: d.path, expected: d.expected, actual: d.actual,
          message: `frame ${rec.frame}: ${d.path} diverged (recorded ${JSON.stringify(d.expected)}, replay ${JSON.stringify(d.actual)})` + engineHint(header)
        };
      }
    }
    const de = firstDiff(rec.events || [], events, 'events');
    if (de) {
      return {
        ok: false, frame: rec.frame, path: de.path, expected: de.expected, actual: de.actual,
        message: `frame ${rec.frame}: ${de.path} diverged (recorded ${JSON.stringify(de.expected)}, replay ${JSON.stringify(de.actual)})` + engineHint(header)
      };
    }
    const hash = fnv1a(canonicalStringify(snapshot));
    if (hash !== rec.hash) {
      return {
        ok: false, frame: rec.frame, path: null, expected: rec.hash, actual: hash,
        message: `frame ${rec.frame}: snapshot hash diverged (recorded ${rec.hash}, replay ${hash}); ` +
          `no full snapshot stored this frame — nearest field-level diff is at the next stored snapshot (every ${header.snapshotEvery} frames)` + engineHint(header)
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
