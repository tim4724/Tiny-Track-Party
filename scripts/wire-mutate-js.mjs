// Proves the wire-compat gate can fail on the JS side of the boundary.
//
// scripts/wire-mutate.mjs breaks C++ and rebuilds the wasm. This is its twin for
// the producers the suite watches that need no build at all:
//
//   * public/display/Net.js   — the object the phone lives off. _publishLobby
//                               AUTHORS the LOBBY_UPDATE snapshot and roster()
//                               names every field in it.
//   * public/shared/names.js  — the name cap both pages apply.
//   * tests/wire-compat/relay.js — the model's OWN enforcement. A model that
//                               quietly stops enforcing prod's rules is the exact
//                               defect that makes testing against the permissive
//                               E2E stub worthless, so it gets mutated too.
//
// Every one of these was invisible to the suite until it stopped deep-equalling a
// snapshot literal it had just written: renaming `players` to `roster` in the real
// producer left both suites green (34/34), and so did applying the code-point fix
// the emoji test claimed it would announce. Those two are the first and sixth
// mutations below, and they are why this file exists.
//
// One mutation is deliberately a FIX rather than a break (names/codepoint-slice):
// a gate that says "when this lands, this assertion is what tells you it worked"
// has to go red when it lands. Red here means the claim is true.
//
// Usage: node scripts/wire-mutate-js.mjs [--only=<substring>] [--list]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['tests/wire-compat.test.js', 'tests/wire-fastlane.test.js'];

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');

// `expect` names the test whose title must appear as a FAILURE.
const MUTATIONS = [
  {
    name: 'display/renamed-players-key',
    kind: 'rename the roster key on the real producer',
    file: 'public/display/Net.js',
    find: '      players: this.roster(),',
    replace: '      roster: this.roster(),',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'display/roster-field-renamed',
    kind: 'rename a field inside a roster row',
    file: 'public/display/Net.js',
    find: '      ready: !!p.ready,',
    replace: '      isReady: !!p.ready,',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'display/roster-order-reversed',
    kind: 'reorder the roster on the JS side',
    file: 'public/display/Net.js',
    find: '    return this.flow.list().map((p) => ({',
    replace: '    return this.flow.list().reverse().map((p) => ({',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'display/peerindex-stringified',
    kind: 'retype the id the phone matches with ===',
    file: 'public/display/Net.js',
    find: '      peerIndex: p.peerIndex, name: p.name,',
    replace: '      peerIndex: String(p.peerIndex), name: p.name,',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'display/name-clamp-dropped',
    kind: 'stop re-clamping an untrusted HELLO name',
    file: 'public/display/Net.js',
    find: '        if (p && data.name) p.name = cleanName(data.name);',
    replace: '        if (p && data.name) p.name = String(data.name);',
    expect: 'an emoji name is the ONE place C++ loses data',
  },
  {
    name: 'names/codepoint-slice',
    kind: 'APPLY the code-point fix the emoji test promises to announce',
    file: 'public/shared/names.js',
    find: "  return (n == null ? '' : String(n)).trim().slice(0, NAME_MAX);",
    replace: "  return [...(n == null ? '' : String(n)).trim()].slice(0, NAME_MAX).join('');",
    expect: 'an emoji name is the ONE place C++ loses data',
  },
  {
    name: 'relay/host-only-guard-deleted',
    kind: 'make the model stop enforcing host-only set_state',
    file: 'tests/wire-compat/relay.js',
    find: "    if (index !== 0) return this._send(ws, { type: 'error', message: 'Only the host can set state' });\n",
    replace: '',
    expect: 'only slot 0 may publish the room snapshot',
  },
  {
    name: 'relay/state-cap-noop',
    kind: 'make the model stop enforcing the 16 KiB cap',
    file: 'tests/wire-compat/relay.js',
    find: "      return this._send(ws, { type: 'error', message: 'State too large' });",
    replace: '      void 0;',
    expect: 'a snapshot over the cap is REFUSED',
  },
  {
    name: 'relay/idle-drops-quiet-sockets',
    kind: 'restore the WRONG model of idleTimeout (drop application-idle sockets)',
    file: 'tests/wire-compat/relay.js',
    find: '      if (idleMs >= PING_AFTER_MS) {\n        ws._pingsSent++;\n        if (ws.autoPong) ws._idleSweeps = 0;\n      }',
    replace: '      if (idleMs >= PING_AFTER_MS) { ws._pingsSent++; }',
    expect: 'prod does NOT drop an application-idle socket',
  },
];

if (listOnly) {
  for (const m of MUTATIONS) console.log(`${m.name.padEnd(32)} ${m.kind}  ->  ${m.expect}`);
  process.exit(0);
}

const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;
if (!selected.length) {
  console.error(`no mutation matches --only=${only}`);
  process.exit(2);
}

// Originals captured up front, restored in a finally and on a signal — the files
// being patched are SHIPPING SOURCE, so a half-restored tree is not acceptable.
const originals = new Map();
for (const m of selected) {
  const abs = path.join(ROOT, m.file);
  if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs));
}
function restoreAll() {
  for (const [p, buf] of originals) {
    try { fs.writeFileSync(p, buf); } catch (e) { console.error(`RESTORE FAILED ${p}: ${e.message}`); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

function runSuites() {
  const r = spawnSync('node', ['--test', '--test-reporter=tap', ...SUITES],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const failures = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^not ok \d+ - (.*)$/);
    if (m) failures.push(m[1]);
  }
  return failures;
}

let exitCode = 0;
try {
  const base = runSuites();
  if (base.length) {
    console.error(`baseline suites are RED before any mutation (${base.length} failures) — fix that first`);
    for (const f of base) console.error(`  red: ${f}`);
    process.exit(2);
  }
  console.log('baseline green\n');

  for (const m of selected) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs).toString('utf8');
    if (!src.includes(m.find)) {
      console.log(`ANCHOR MISSING  ${m.name}  (${m.file})`);
      exitCode = 1;
      continue;
    }
    fs.writeFileSync(abs, src.replace(m.find, m.replace));
    const failures = runSuites();
    fs.writeFileSync(abs, src);

    const hit = failures.find((f) => f.includes(m.expect));
    console.log(`${hit ? 'CAUGHT ' : 'SILENT '} ${m.name.padEnd(32)} ${failures.length} test(s) red`);
    for (const f of failures) console.log(`           red: ${f}`);
    if (!hit) exitCode = 1;
  }
} finally {
  restoreAll();
}
console.log(exitCode === 0
  ? `\nAll ${selected.length} mutations were caught. The JS half of the gate bites.`
  : '\nAt least one mutation went UNDETECTED (or hit the wrong test) — a blind spot, or dead code.');
process.exit(exitCode);
