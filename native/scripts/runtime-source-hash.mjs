// runtime-source-hash — the one definition of "which sources produce
// public/display/engine/native/ttp_runtime.{mjs,wasm}", and their SHA-256.
//
// The game is native-only: those two artifacts ARE the engine, they are checked
// into the repo (no build step in the preview deploy), and nothing about editing
// C++ forces a rebuild. So conformance can be green against sources while the
// shipped wasm is something older — silently, because ctest tests the sources and
// npm test tests the artifact.
//
// build-runtime-web.sh writes this hash into BUILD_STAMP.json next to the
// artifacts; tests/native-artifact.test.js recomputes it and fails when they
// disagree. Byte-comparing a rebuilt wasm would be the stronger check but is not
// available: emcc output is not reproducible across emsdk versions, and CI's
// pinned version differs from a dev machine's.
//
// Used by both, so the file list can never fork between them.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Everything the ttp_runtime_web target compiles or links, plus the build recipe.
// A directory is walked recursively; only files with a build-relevant extension
// count, so VENDOR.md and friends do not churn the hash.
const ROOTS = [
  'native/CMakeLists.txt',
  'native/cmake',
  'native/runtime',
  'native/renderer',
  'native/libttp-json',
  'native/libttp-sim',
  'native/libttp-party',
  'native/libttp-track',
  'native/vendor/fdlibm',
  'native/vendor/double-conversion',
  'native/scripts/build-runtime-web.sh',
];

// .mat and .js are in here because the artifacts include the renderer: its
// materials compile to the .filamat blobs shipped alongside the wasm, and
// gl_map_buffer_stubs.js is linked into the module by --js-library.
const EXTS = new Set(['.c', '.cc', '.cpp', '.h', '.hh', '.hpp', '.inc', '.txt',
                      '.cmake', '.sh', '.mat', '.js']);

function walk(abs, rel, out) {
  const st = fs.statSync(abs);
  if (st.isFile()) {
    if (EXTS.has(path.extname(abs))) out.push(rel);
    return;
  }
  for (const name of fs.readdirSync(abs).sort()) {
    walk(path.join(abs, name), `${rel}/${name}`, out);
  }
}

// Repo-relative paths of every file that feeds the runtime module, sorted.
export function runtimeSourceFiles(repoRoot) {
  const out = [];
  for (const r of ROOTS) walk(path.join(repoRoot, r), r, out);
  out.sort();
  return out;
}

// SHA-256 over "<path>\n<bytes>" per file, in sorted path order — so a rename
// changes the hash as surely as an edit does.
export function runtimeSourceHash(repoRoot) {
  const h = createHash('sha256');
  for (const rel of runtimeSourceFiles(repoRoot)) {
    h.update(rel);
    h.update('\n');
    h.update(fs.readFileSync(path.join(repoRoot, rel)));
  }
  return h.digest('hex');
}

// `node native/scripts/runtime-source-hash.mjs [--files]` — the shell build
// script consumes the bare hash on stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  if (process.argv.includes('--files')) {
    for (const f of runtimeSourceFiles(repoRoot)) console.log(f);
  } else {
    console.log(runtimeSourceHash(repoRoot));
  }
}
