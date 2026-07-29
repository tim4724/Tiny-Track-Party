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

export const has = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;

// Configure native/build if it is not already configured. Returns a short
// description of what happened, for the caller to print.
//
// The generator is only ever passed on a FRESH directory: handing `-G Ninja` to
// an existing Make tree is a hard cmake error, and worktrees predating this
// script have exactly that tree.
export function configureNative(root, { buildDir = 'native/build' } = {}) {
  if (!has('cmake')) throw new Error('cmake is not installed');
  const abs = path.join(root, buildDir);
  if (fs.existsSync(path.join(abs, 'CMakeCache.txt'))) return 'already configured';
  const ninja = has('ninja');
  execFileSync('cmake', [
    '-S', 'native', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release',
    ...(ninja ? ['-G', 'Ninja'] : []),
  ], { cwd: root, stdio: 'pipe' });
  return ninja ? 'configured (Ninja)' : 'configured (Make)';
}

export function buildTarget(root, target, { buildDir = 'native/build' } = {}) {
  execFileSync('cmake', ['--build', buildDir, '--target', target, '--parallel'],
    { cwd: root, stdio: 'pipe' });
}
