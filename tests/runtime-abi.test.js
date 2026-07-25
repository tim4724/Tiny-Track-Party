'use strict';
// Runtime C ABI conformance gate. Loads the browser wasm module
// (public/display/engine/native/ttp_runtime.mjs, built by native/scripts/
// build-runtime-web.sh) in Node and replays the committed INPUT-REPLAY fixture
// tidepool-4bots-600f-seed42.jsonl THROUGH THE ABI, demanding bit-for-bit
// agreement every frame:
//   fnv1a(ttp_snapshot_json) === recorded hash   (canonical serializer end-to-end)
//   ttp_events_json race events deep-equal recorded events
//
// The fixture was recorded on a BARE Game (no session, no countdown), so the
// bots are added as HUMANS (no internal AI) and every recorded input is fed via
// ttp_process_input; ttp_session_start(h, -1) selects the no-countdown, racing-
// from-frame-0 mode that is bare-Game-equivalent. This proves the ABI wiring +
// the M3 canonical serializer in Node before any browser adapter work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');
const FIXTURE = path.join(ROOT, 'tests/fixtures/traces/tidepool-4bots-600f-seed42.jsonl');

// The artifacts are CHECKED IN and the game is native-only, so a missing module
// is a broken checkout, not an unbuilt optional extra. This used to skip; skipping
// meant the one suite that exercises the SHIPPED engine could quietly not run.
for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

// FNV-1a over UTF-8 bytes, lowercase 8-hex — identical to record-trace.mjs.
function fnv1a(str) {
  const bytes = new TextEncoder().encode(str);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

test('runtime ABI replays the tidepool input fixture bit-for-bit', async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const Module = await factory();
  const cw = (name, ret, args) => Module.cwrap(name, ret, args);
  const abi = {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addHuman: cw('ttp_add_human', 'void', ['number', 'string', 'string']),
    start: cw('ttp_session_start', 'void', ['number', 'number']),
    update: cw('ttp_update', 'void', ['number', 'number']),
    input: cw('ttp_process_input', 'void',
      ['number', 'string', 'number', 'number', 'number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    events: cw('ttp_events_json', 'string', ['number']),
    racing: cw('ttp_racing', 'number', ['number']),
    version: cw('ttp_version', 'string', []),
    dispose: cw('ttp_dispose', 'void', ['number']),
  };

  // The version blob the adapter sanity-checks against.
  const ver = JSON.parse(abi.version());
  assert.equal(ver.contractVersion, 2, 'contractVersion');
  assert.equal(ver.mathlib, 'fdlibm-openlibm-0.8.7', 'mathlib stamp');

  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const recs = lines.slice(1).map((l) => JSON.parse(l));
  assert.equal(recs.length, header.frames, 'fixture frame count');

  // Rebuild the JSON-scalar id for a recorded input key (String(id) form). The
  // roster carries the original id type (numeric vs string), which the ABI's
  // JSON-scalar contract needs to distinguish `3` from `"cpu-bolt"`.
  const keyToId = new Map();
  for (const r of header.roster) keyToId.set(String(r.id), r.id);

  const h = abi.begin(header.trackId, header.seed >>> 0, header.laps, null);
  assert.ok(h > 0, 'session_begin returned a handle');
  for (const r of header.roster) abi.addHuman(h, JSON.stringify(r.id), null);
  abi.start(h, -1); // no countdown: racing from frame 0, bare-Game-equivalent
  assert.equal(abi.racing(h), 1, 'racing immediately in no-countdown mode');

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
    abi.update(h, header.dt);

    const snap = abi.snapshot(h);
    assert.equal(fnv1a(snap), rec.hash, `frame ${rec.frame}: snapshot hash`);

    // ttp_events_json also carries reconstructed session beats (_countdown /
    // _raceStart / _raceEnd); the fixture records only the engine's race events,
    // so drop the synthetic underscore-typed ones before comparing.
    const events = JSON.parse(abi.events(h)).filter((e) => !String(e.type || '').startsWith('_'));
    assert.deepEqual(events, rec.events || [], `frame ${rec.frame}: events`);
  }

  abi.dispose(h);
});
