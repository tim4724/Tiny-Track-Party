// Proves the wire-compat gate can FAIL.
//
// A gate nobody has watched fail is not a gate. tests/wire-compat.test.js and
// tests/wire-fastlane.test.js assert against the SHIPPED wasm, so the only honest
// way to break them is to break the C++ and rebuild — which is what this does:
// patch one line under native/, rebuild ttp_runtime_web, swap the artifact into
// public/display/engine/native/, run the two suites, require the named one to go
// red, then put everything back.
//
// Sibling of scripts/mutation-check.mjs (which does the same for ctest) and of
// scripts/wire-mutate-js.mjs (the same idea for the JS producers, no rebuild). It
// inherits both of mutation-check's hard-won rules:
//   1. mtime granularity — every patch is followed by a forward touch, or ninja
//      may not recompile and an unbuilt mutation looks "undetected".
//   2. restore is not optional — originals are captured up front, restored in a
//      finally, and re-restored on SIGINT/SIGTERM. That includes the CHECKED-IN
//      wasm artifacts, which are the whole point of this suite.
//
// The rebuild is deliberately WITHOUT -DFILAMENT_SDK: sim + party only, which is
// exactly what CI's wasm leg builds and everything these two suites touch. The
// suites are re-run against a baseline build of the same configuration first, so
// a "red" result can never be an artifact of the renderer being absent.
//
// Usage: node scripts/wire-mutate.mjs [--only=<substring>] [--list]
// Env:   EMSDK_DIR (default ~/emsdk)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CPP_MUTATIONS as MUTATIONS } from './wire-mutations.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMSDK_DIR = process.env.EMSDK_DIR || process.env.EMSDK || path.join(process.env.HOME, 'emsdk');
const BUILD = path.join(ROOT, 'native/build/wire-mutation');
const OUTDIR = path.join(ROOT, 'public/display/engine/native');
const SUITES = ['tests/wire-compat.test.js', 'tests/wire-fastlane.test.js'];

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');

// The mutations live in scripts/wire-mutations.mjs — shared with the JS harness
// and read by tests/wire-mutation-anchors.test.js, which fails on every `npm test`
// when an anchor or an expected test title stops existing. That check is not
// optional bookkeeping: these harnesses run on demand, so a rotted anchor here is
// a gate that silently stopped being run at all.
if (listOnly) {
  for (const m of MUTATIONS) console.log(`${m.name.padEnd(34)} ${m.kind}  ->  ${m.expect}`);
  process.exit(0);
}

const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;
if (!selected.length) {
  console.error(`no mutation matches --only=${only}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Restore machinery. Captured BEFORE anything is touched.
// ---------------------------------------------------------------------------
const originals = new Map();     // abs path -> Buffer
function capture(p) {
  if (!originals.has(p)) originals.set(p, fs.readFileSync(p));
}
function restoreAll() {
  for (const [p, buf] of originals) {
    try { fs.writeFileSync(p, buf); } catch (e) { console.error(`RESTORE FAILED ${p}: ${e.message}`); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

const ARTIFACTS = ['ttp_runtime.mjs', 'ttp_runtime.wasm'].map((f) => path.join(OUTDIR, f));
for (const a of ARTIFACTS) capture(a);
for (const m of selected) capture(path.join(ROOT, m.file));

// ---------------------------------------------------------------------------
function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-lc', cmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

const EMENV = `source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null 2>&1`;

function buildWasm() {
  const configure = `${EMENV} && emcmake cmake -S "${ROOT}/native" -B "${BUILD}" -G Ninja -DCMAKE_BUILD_TYPE=Release`;
  const build = `${EMENV} && cmake --build "${BUILD}" --target ttp_runtime_web --parallel`;
  let r = sh(configure);
  if (r.status !== 0) return { ok: false, log: r.stdout + r.stderr };
  r = sh(build);
  if (r.status !== 0) return { ok: false, log: r.stdout + r.stderr };
  return { ok: true, log: '' };
}

function installBuiltArtifacts() {
  for (const f of ['ttp_runtime.mjs', 'ttp_runtime.wasm']) {
    fs.copyFileSync(path.join(BUILD, f), path.join(OUTDIR, f));
  }
}

// Run both suites and return the set of FAILING test titles.
function runSuites() {
  const r = sh(`node --test --test-reporter=tap ${SUITES.join(' ')}`);
  const failures = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^not ok \d+ - (.*)$/);
    if (m) failures.push(m[1]);
  }
  return { ok: r.status === 0, failures, log: r.stdout + r.stderr };
}

function touchForward(p) {
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(p, t, t);
}

// ---------------------------------------------------------------------------
let exitCode = 0;
try {
  console.log('==> baseline: building ttp_runtime_web WITHOUT the Filament SDK (CI\'s wasm configuration)');
  const b = buildWasm();
  if (!b.ok) {
    console.error(b.log.split('\n').slice(-40).join('\n'));
    throw new Error('baseline build failed');
  }
  installBuiltArtifacts();
  const base = runSuites();
  if (!base.ok) {
    console.error(base.log.split('\n').slice(-60).join('\n'));
    throw new Error(`baseline suites are RED before any mutation (${base.failures.length} failures) — fix that first`);
  }
  console.log('    baseline green\n');

  const results = [];
  for (const m of selected) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs).toString('utf8');
    if (!src.includes(m.find)) throw new Error(`${m.name}: anchor not found in ${m.file}\n  ${m.find}`);
    fs.writeFileSync(abs, src.replace(m.find, m.replace));
    touchForward(abs);

    process.stdout.write(`==> ${m.name.padEnd(34)} (${m.kind}) ... `);
    const built = buildWasm();
    let verdict;
    if (!built.ok) {
      verdict = { caught: false, why: 'BUILD FAILED', failures: [] };
      console.log('BUILD FAILED');
      console.error(built.log.split('\n').slice(-25).join('\n'));
    } else {
      installBuiltArtifacts();
      const run = runSuites();
      const hit = run.failures.find((f) => f.includes(m.expect));
      verdict = { caught: !!hit, failures: run.failures };
      console.log(hit ? `CAUGHT by "${hit}"` : `NOT CAUGHT (failures: ${run.failures.length})`);
      if (!hit) exitCode = 1;
      for (const f of run.failures) console.log(`      red: ${f}`);
    }
    results.push({ ...m, ...verdict });

    // Put the source back before the next mutation so they never compound.
    fs.writeFileSync(abs, src);
    touchForward(abs);
  }

  console.log('\n---- summary ----');
  for (const r of results) {
    console.log(`${r.caught ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.failures.length} test(s) red`);
  }
  console.log(exitCode === 0
    ? `\nAll ${results.length} mutations were caught. The gate bites.`
    : '\nAt least one mutation went UNDETECTED — a blind spot in the wire suite, or dead code.');
} catch (e) {
  console.error('\n' + e.message);
  exitCode = 2;
} finally {
  restoreAll();
  console.log('\n(sources and public/display/engine/native artifacts restored)');
}
process.exit(exitCode);
