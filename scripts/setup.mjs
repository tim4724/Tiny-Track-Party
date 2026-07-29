#!/usr/bin/env node
// `npm run setup` — make a FRESH WORKTREE ready to work in, and say what is and
// is not available afterwards.
//
// This exists because a new worktree has neither node_modules nor native/build,
// and nothing announced that: you found out when a command failed, and the
// failure named the missing thing only if you were lucky (tests/track.test.js
// skips with a build hint; most things just error). With ~70 worktrees on this
// machine at once that guessing game was paid over and over, by people and
// agents alike.
//
// It is DELIBERATELY not a build. It installs deps and configures CMake — the
// two things that are pure setup — and then reports. Rebuilding the engine wasm
// needs the Filament fork and emsdk, which is a different order of commitment
// (see native/scripts/build-runtime-web.sh), and the checked-in artifact means
// most work never needs it.
//
// Safe to re-run: every step is skipped when it is already satisfied.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNative, has as which } from './lib/native-cmake.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (p) => fs.existsSync(path.join(ROOT, p));

const notes = [];
const step = (label, fn) => {
  process.stdout.write(`  ${label} ... `);
  try {
    console.log(fn() || 'done');
  } catch (err) {
    console.log('FAILED');
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  }
};
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });

console.log(`\nTiny Track Party — worktree setup\n  ${ROOT}\n`);

// ---- 1. node dependencies ---------------------------------------------------
step('npm dependencies', () => {
  if (has('node_modules')) return 'already installed';
  run('npm', ['install', '--no-audit', '--no-fund']);
  return 'installed';
});

// ---- 2. the native build tree ----------------------------------------------
// Ninja when it is there: measured 9.8 s against Make's 14.0 s for a cold build,
// and it is what native/scripts/build-runtime-web.sh already uses. Configuring
// only, never building — `ctest` needs a build, but which targets you want
// depends on what you are doing, and the configure is the part that is pure
// setup.
step('native/build (cmake)', () => {
  if (!which('cmake')) {
    notes.push('cmake is not installed — `ctest`, the probes and the wasm build are unavailable.');
    return 'skipped (no cmake)';
  }
  const result = configureNative(ROOT);
  if (!which('ninja')) notes.push('ninja is not installed — cmake fell back to Make (~40% slower builds).');
  return result;
});

// ---- 3. report what the tree can and cannot do ------------------------------
if (!which('ccache')) {
  notes.push('ccache is not installed — a fresh worktree rebuilds from scratch (12 s vs 0.6 s).'
    + ' `brew install ccache` and re-run; native/CMakeLists.txt picks it up automatically.');
}
if (!has('public/display/engine/native/ttp_runtime.wasm')) {
  notes.push('the engine wasm is missing from the checkout — nothing that loads the display will run.');
}
// The e2e browser is a per-machine install, not a per-worktree one, so a missing
// one is worth saying once here rather than as a Playwright error per worktree.
const pwCache = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
if (!fs.existsSync(pwCache) && !fs.existsSync(path.join(process.env.HOME || '', '.cache/ms-playwright'))) {
  notes.push('no Playwright browser — run `npx playwright install chromium` before `npm run test:e2e`.');
}

console.log('\nReady:');
console.log('  npm test                        unit + wire-compat  (~5 s)');
console.log('  ctest --test-dir native/build   native conformance, 47 tests  (~6 s, after a build)');
console.log('  npm run test:e2e                Playwright  (~80 s)');
console.log('  npm run dev                     the server, watching');
console.log('\nEngine changes (native/) additionally need the Filament fork + emsdk:');
console.log('  native/scripts/build-runtime-web.sh   then commit the artifacts');
console.log('  npm run check:artifact                is the checked-in wasm current?  (~0.2 s)');

if (notes.length) {
  console.log('\nNotes:');
  for (const n of notes) console.log(`  - ${n}`);
}
console.log('');
