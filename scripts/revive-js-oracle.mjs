// Proves the retired JS engine can still be REVIVED and still produces the exact
// committed golden traces — i.e. that parity evidence is still renewable.
//
// WHY THIS IS A GATE AND NOT A CURIOSITY. The 8 traces under tests/fixtures/traces/
// are the only artifacts that prove the C++ sim reproduces the JS sim bit for bit,
// and they can never be re-recorded from C++ (that would prove C++ matches itself).
// The engine that produced them was deleted, so on the face of it the evidence is a
// one-way ratchet: every intended sim change burns some of it permanently, and no
// new parity fixture can ever be authored.
//
// That turns out to be false. The JS twin restores from git in one command and
// re-records all 8 fixtures byte-identically.
//
// It used to lean on modules that SURVIVED the engine's retirement — TrackBuilder,
// Centerline, engine/{Vec3,util,math} — which made it a decaying capability: it
// would work until one of those changed shape under it, then break silently. Those
// modules are gone too now (the C++ TrackBuilder is the only builder, and the
// browser holds no track geometry at all), so the oracle restores its WHOLE
// dependency set from git and depends on nothing live but engine/contract.js, which
// is a dozen lines of constants. It cannot rot from under itself any more.
//
// This script is what makes a failure loud. It is deliberately NOT a per-PR gate
// (it needs full git history and re-races ~10k frames); it runs on demand and on a
// schedule. When it starts failing, that is the signal to decide consciously whether
// to repair the twin or to accept that parity evidence is now frozen for good.
//
// It works in a THROWAWAY git worktree, so the committed fixtures are never at risk:
// record-fixtures.mjs writes straight into tests/fixtures/traces/, which is exactly
// what we do not want happening in the checkout you are working in.
//
// Usage: node scripts/revive-js-oracle.mjs [--base=<commit-ish>] [--keep]
//        npm run revive:js-oracle

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACES = path.join(ROOT, 'tests/fixtures/traces');

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
const keep = args.includes('--keep');
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
  const distinct = [...new Set(bases.values())];
  console.log(`reviving the JS oracle from ${distinct.join(', ')}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-js-oracle-'));
  const wt = path.join(tmp, 'wt');
  let added = false;
  try {
    // A detached worktree at the CURRENT head: surviving modules as they are today,
    // which is precisely what we are testing the twin against.
    git(ROOT, 'worktree', 'add', '--detach', wt, 'HEAD');
    added = true;

    for (const rel of REVIVE) {
      const blob = execFileSync('git', ['show', `${bases.get(rel)}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 28 });
      fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(wt, rel), blob);
    }
    console.log(`restored ${REVIVE.length} files into a throwaway worktree`);

    // Re-record the standard set. Inherits stdio so the recorder's own coverage
    // assertions (all 7 event kinds, all 4 spin causes) surface as they happen.
    execFileSync(process.execPath, ['scripts/record-fixtures.mjs'],
      { cwd: wt, stdio: 'inherit' });

    // ---- byte comparison against the committed fixtures.
    const reWt = path.join(wt, 'tests/fixtures/traces');
    const listed = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    const want = listed(TRACES);
    const got = listed(reWt);

    let bad = 0;
    for (const name of want) {
      if (!got.includes(name)) {
        // record-fixtures.mjs re-scans the endgame seed when an engine change moves
        // the race, and the seed is in the filename — so this is the shape a
        // legitimately-changed fixture set takes, not necessarily a broken oracle.
        console.error(`MISSING ${name} — the revived recorder did not produce it ` +
          `(endgame seed re-scanned? it is part of the filename)`);
        bad++;
        continue;
      }
      const a = fs.readFileSync(path.join(TRACES, name));
      const b = fs.readFileSync(path.join(reWt, name));
      if (a.equals(b)) {
        console.log(`  ok        ${name} (${a.length} bytes)`);
      } else {
        bad++;
        console.error(`  DIFFERS   ${name}: committed ${a.length} bytes, revived ${b.length}`);
      }
    }
    for (const name of got) {
      if (!want.includes(name)) {
        console.error(`EXTRA ${name} — revived recorder produced a fixture the tree ` +
          `does not carry`);
        bad++;
      }
    }

    if (bad) {
      console.error(`\n${bad} fixture(s) did not round-trip. Either the surviving modules ` +
        `have drifted under the twin (repair it, or accept that parity evidence is now ` +
        `frozen), or a sim change was intended and the committed traces no longer describe ` +
        `this engine.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nall ${want.length} fixtures re-recorded byte-identically — the JS ` +
      `oracle is alive and parity evidence is still renewable`);
  } finally {
    if (added && !keep) {
      try {
        git(ROOT, 'worktree', 'remove', '--force', wt);
      } catch (e) {
        console.error(`could not remove the temp worktree at ${wt}: ${e.message}`);
      }
    }
    if (keep) console.log(`--keep: left the worktree at ${wt}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
