// Restores the retired JS twins — the sim, the track builder, and the vector/math
// primitives underneath both — into a THROWAWAY git worktree, so a frozen oracle
// generator can be run against them without the dead files landing in the checkout
// you are working in.
//
// WHO STILL NEEDS THIS. `scripts/gen-{math,trackbuilder,track-sampler}-corpus.mjs`.
// Those three corpora are the last cross-implementation evidence in the tree — their
// JS oracles have never been re-emitted from C++ — so re-deriving one means running
// its generator against the twin, and this is how you get a twin. The golden traces
// are NOT on that list: their JS-parity claim was spent deliberately and they are
// regression evidence now (`tests/fixtures/traces/README.md`), so their recorders
// restore here as history rather than as a route to new parity evidence.
//
// It restores its WHOLE dependency set from git and leans on nothing live but
// engine/contract.js, which is a dozen lines of constants. That is deliberate: while
// it leaned on surviving modules (TrackBuilder, Centerline, engine/{Vec3,util,math})
// it was a decaying capability, working until one of them changed shape underneath
// it. It cannot rot from under itself any more.
//
// Usage: node scripts/revive-js-oracle.mjs [--base=<commit-ish>]
//        npm run revive:js-oracle
// The worktree is LEFT IN PLACE and its path printed; you go and work in it, then
// remove it with the command printed alongside.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything the JS oracle needs that no longer exists in the tree: the sim, the
// track builder it races on, the vector/math primitives underneath both, and the
// recorder that drives them. Each is restored from its OWN retirement commit —
// they were retired in two waves, and hardcoding one base would restore a file
// from a tree where it had not been written yet (or had already moved on).
const REVIVE = [
  // wave 1: the sim
  'public/display/engine/Game.js',
  'public/display/AiDriver.js',
  'public/display/RaceSession.js',
  'scripts/record-trace.mjs',
  'scripts/record-fixtures.mjs',
  // wave 2: the builder + the primitives, retired when the renderer stopped
  // needing a JS-side track build
  'public/display/TrackBuilder.js',
  'public/display/Centerline.js',
  'public/display/engine/Vec3.js',
  'public/display/engine/math.js',
  'public/display/engine/util.js',
];

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith('--base='));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// The commit that DELETED a file; its parent is the last one that had it. Derived
// per file rather than hardcoded, so a rebase, a second retirement wave, or a file
// that moves between waves cannot silently point this at the wrong tree.
// --base=<commit-ish> overrides for every file at once (an escape hatch for a
// history this cannot walk).
function resolveBase(rel) {
  if (baseArg) return baseArg.slice('--base='.length);
  const sha = git(ROOT, 'log', '--diff-filter=D', '--format=%H', '-1', '--', rel);
  if (!sha) {
    throw new Error(`cannot find the commit that deleted ${rel} — ` +
      'pass --base=<commit-ish> explicitly (shallow clone? needs fetch-depth: 0)');
  }
  return `${sha}^`;
}

function main() {
  const bases = new Map(REVIVE.map((rel) => [rel, resolveBase(rel)]));
  console.log(`reviving the JS oracle from ${[...new Set(bases.values())].join(', ')}`);

  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-js-oracle-')), 'wt');
  // A detached worktree at the CURRENT head: surviving modules as they are today,
  // which is what the restored twins have to work against.
  git(ROOT, 'worktree', 'add', '--detach', wt, 'HEAD');

  for (const rel of REVIVE) {
    const blob = execFileSync('git', ['show', `${bases.get(rel)}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 28 });
    fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), blob);
  }

  console.log(`restored ${REVIVE.length} files into ${wt}\n` +
    `run the generator there, take the corpus it writes, then:\n` +
    `  git worktree remove --force ${wt}`);
}

main();
