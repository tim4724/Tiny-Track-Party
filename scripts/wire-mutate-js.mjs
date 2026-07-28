// Proves the wire-compat gate can fail on the JS side of the boundary.
//
// scripts/wire-mutate.mjs breaks C++ and rebuilds the wasm. This is its twin for
// the producers the suite watches that need no build at all: public/display/Net.js
// (the shell's half of the retained snapshot), public/shared/names.js (the name
// cap both pages apply) and tests/wire-compat/relay.js (the relay model's OWN
// enforcement). The list itself, and why each entry is there, lives in
// scripts/wire-mutations.mjs — shared with the C++ harness and read by
// tests/wire-mutation-anchors.test.js so a dead anchor cannot sit here unnoticed.
//
// Usage: node scripts/wire-mutate-js.mjs [--only=<substring>] [--list]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JS_MUTATIONS as MUTATIONS } from './wire-mutations.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['tests/wire-compat.test.js', 'tests/wire-fastlane.test.js'];

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');

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
