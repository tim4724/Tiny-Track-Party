// The one place that decides HOW native/build gets configured, so `npm run
// setup` and the probe scripts cannot disagree about it.
//
// Before this existed the three probe:* scripts each spelled the configure out
// in package.json with the default generator, which meant a fresh worktree got
// a Make build tree (14.0 s cold) even on a machine with ninja (9.8 s) — and
// the generator is fixed for the life of the build directory, so that choice
// stuck until someone deleted it.
//
// ccache is NOT decided here: native/CMakeLists.txt picks it up itself, so it
// applies to CI and to hand-typed cmake invocations too.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const hasBin = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;

// Configure native/build if it is not already configured. Returns what happened
// — 'kept' | 'ninja' | 'make' — for the caller to word as it likes. A caller
// that wants to warn about the Make fallback needs to know the difference
// between choosing it and merely finding a tree that already made the choice.
//
// The generator is only ever passed on a FRESH directory: handing `-G Ninja` to
// an existing Make tree is a hard cmake error, and worktrees predating this
// script have exactly that tree.
export function configureNative(root, { buildDir = 'native/build' } = {}) {
  if (!hasBin('cmake')) throw new Error('cmake is not installed');
  if (fs.existsSync(path.join(root, buildDir, 'CMakeCache.txt'))) return 'kept';
  const ninja = hasBin('ninja');
  execFileSync('cmake', [
    '-S', 'native', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release',
    ...(ninja ? ['-G', 'Ninja'] : []),
  ], { cwd: root, stdio: 'pipe' });
  return ninja ? 'ninja' : 'make';
}

export function buildTarget(root, target, { buildDir = 'native/build' } = {}) {
  execFileSync('cmake', ['--build', buildDir, '--target', target, '--parallel'],
    { cwd: root, stdio: 'pipe' });
}
