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
import { configureNative, hasBin } from './lib/native-cmake.mjs';

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

console.log(`\nTiny Track Party — worktree setup\n  ${ROOT}\n`);

// ---- 1. node dependencies ---------------------------------------------------
step('npm dependencies', () => {
  if (has('node_modules')) return 'already installed';
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'pipe' });
  return 'installed';
});

// ---- 2. the native build tree ----------------------------------------------
// Ninja when it is there: measured 9.8 s against Make's 14.0 s for a cold build,
// and it is what native/scripts/build-runtime-web.sh already uses. Configuring
// only, never building — `ctest` needs a build, but which targets you want
// depends on what you are doing, and the configure is the part that is pure
// setup.
step('native/build (cmake)', () => {
  if (!hasBin('cmake')) {
    notes.push('cmake is not installed — `ctest`, the probes and the wasm build are unavailable.');
    return 'skipped (no cmake)';
  }
  // Only warn when this run actually settled for Make. An existing tree made
  // that choice at some earlier point and cannot be talked out of it now.
  const made = configureNative(ROOT);
  if (made === 'make') {
    notes.push('ninja is not installed — cmake fell back to Make (14.0 s vs 9.8 s per cold build),'
      + ' and the generator is fixed for the life of native/build.');
  }
  return { kept: 'already configured', ninja: 'configured (Ninja)', make: 'configured (Make)' }[made];
});

// ---- 3. report what the tree can and cannot do ------------------------------
if (!hasBin('ccache')) {
  // The launcher is baked into CMakeCache.txt at configure time, so installing
  // ccache later does nothing until the build tree is re-made — say so, rather
  // than leaving someone to wonder why nothing got faster.
  notes.push('ccache is not installed — a from-scratch native/build costs 14.0 s instead of 0.63 s.'
    + ' `brew install ccache`, then `rm -rf native/build && npm run setup` to pick it up.');
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

// Asked rather than remembered. A hand-typed count is wrong the first time a
// ctest is added and nothing ever tells you — this banner claimed 47 for a tree
// that had 48. `ctest -N` only lists, needs no build, and costs ~13 ms.
const ctestCount = (() => {
  try {
    const out = execFileSync('ctest', ['--test-dir', path.join(ROOT, 'native/build'), '-N'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/Total Tests:\s*(\d+)/);
    return m ? `${m[1]} tests` : 'the conformance suite';
  } catch {
    return 'the conformance suite';  // not configured (the step above said so)
  }
})();

// Orders of magnitude, not measurements — the point is which of these you can
// put in a tight loop and which one you go and do something else during. A
// figure precise enough to be checked is a figure that rots: the e2e line here
// read "~90 s" against a suite that measures over two minutes.
console.log('\nReady:');
console.log('  npm test                        unit + wire-compat  (seconds)');
console.log(`  npm run test:native             native conformance, ${ctestCount}  (seconds, build included)`);
console.log('  npm run test:e2e                Playwright  (a few minutes)');
console.log('  npm run dev                     the server, watching');
console.log('  npm run build:tvos [device|simulator]   the Apple TV app, engine + bundle included');
console.log('\nEngine changes (native/) additionally need the Filament fork + emsdk (both fetched automatically, pinned by native/filament.pin):');
console.log('  native/scripts/build-runtime-web.sh   then commit the artifacts');
console.log('  npm run check:artifact                is the checked-in wasm current?  (instant)');

if (notes.length) {
  console.log('\nNotes:');
  for (const n of notes) console.log(`  - ${n}`);
}
console.log('');
