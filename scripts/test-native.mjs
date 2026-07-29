#!/usr/bin/env node
// `npm run test:native` — the native conformance suite, built and run in one go.
//
// The two-command spelling in CLAUDE.md (`cmake --build native/build` then
// `ctest --test-dir native/build`) has two sharp edges that cost real time:
//
//   1. FORGETTING THE BUILD. `ctest` happily runs whatever binaries are sitting
//      in the tree, so skipping the build means a green suite that says nothing
//      about the C++ you just edited. That is the worst possible failure mode in
//      a repo whose entire discipline is "nothing drifts silently".
//   2. CTEST IS SERIAL BY DEFAULT. Measured on this tree: 6.16 s serial against
//      2.37 s at -j10, for 5.90 s vs 6.53 s of CPU. The suite is a few dozen
//      mostly-independent replay binaries, so the parallel run is nearly free.
//
// Extra args are passed through, so the usual filters still work:
//   npm run test:native -- -R raceflow
//   npm run test:native -- -R "^record_" --output-on-failure
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = 'native/build';

if (!fs.existsSync(path.join(ROOT, BUILD, 'CMakeCache.txt'))) {
  console.error('native/build is not configured — run `npm run setup` first.');
  process.exit(1);
}

const jobs = String(os.availableParallelism?.() ?? os.cpus().length);

try {
  execFileSync('cmake', ['--build', BUILD, '--parallel', jobs], { cwd: ROOT, stdio: 'inherit' });
} catch {
  process.exit(1);  // cmake already printed the error
}

// --output-on-failure by default: a conformance failure whose diff you have to
// re-run to see is a second round trip for no reason. A caller passing their own
// copy is harmless (ctest takes the flag twice).
const res = spawnSync('ctest', [
  '--test-dir', BUILD, '-j', jobs, '--output-on-failure', ...process.argv.slice(2),
], { cwd: ROOT, stdio: 'inherit' });
process.exit(res.status ?? 1);
