// The licence texts the engine binary owes that have NO original in this tree:
// Filament's own, the third-party code Filament compiles into the archives the
// engine links, Emscripten's, and musl's (the C library inside the wasm).
//
//   node scripts/gen-upstream-licenses.mjs      (run by build-runtime-web.sh)
//
// DERIVED, NOT FETCHED. Each text is read out of the checkout the artifact is
// actually built from: the Filament fork at the commit `native/filament.pin`
// names, and the emsdk at the version `build-runtime-web.sh` installs. The web
// build runs this after both exist, so moving a pin regenerates the notices in
// the same commit, and tests/credits.test.js diffs the served copies against
// this derivation on any machine that has the checkouts.
//
// A licence text is only a notice while it is intact: every text below is
// written verbatim, and the only lines of ours in the bundle are the rules
// between texts that say which library each one belongs to.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets', 'licenses');
const readUnder = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// The third-party code Filament compiles into the libraries the engine LINKS
// (native/cmake/FilamentSdk.cmake links every installed archive and the linker
// dead-strips). This errs on inclusion: a library is here when a Filament
// target the engine uses references it, because what the strip happens to drop
// is not something a notice should rest on. `file` is the licence's path under
// third_party/<dir>; mikktspace keeps its licence as the header comment of its
// one source file, so that file is named and the comment block is taken.
//
// Left out, and why: abseil (FILAMENT_USE_ABSEIL_LOGGING is OFF), libwebp
// (FILAMENT_SUPPORTS_WEBP_TEXTURES is OFF), perfetto (OFF in Release builds),
// civetweb, glslang and the spirv tools (matc and matdbg: build-time tools,
// never the runtime), dawn (the WebGPU backend, which no platform here uses).
export const FILAMENT_BUNDLED = [
  { dir: 'cgltf', file: 'LICENSE', why: 'gltfio parses the GLB models' },
  { dir: 'draco', file: 'LICENSE', why: 'gltfio links the Draco mesh decoder' },
  // Also credited on its own row (the renderer calls it through the vendored
  // header); it stays here because it is in the archives too, and a notice
  // twice costs nothing.
  { dir: 'meshoptimizer', file: 'LICENSE', why: 'gltfio decodes EXT_meshopt_compression, and the renderer simplifies far forms' },
  { dir: 'zstd', file: 'LICENSE', why: 'the compressed material blobs, and gltfio' },
  { dir: 'basisu', file: 'LICENSE', why: 'the Basis Universal transcoder behind ktxreader, which gltfio links' },
  { dir: 'stb', file: 'LICENSE', why: 'gltfio decodes PNG and JPEG textures with stb_image' },
  { dir: 'libz', file: 'LICENSE', why: 'gltfio inflates its uber-archive of materials' },
  { dir: 'robin-map', file: 'LICENSE', why: 'the hash maps in every Filament library' },
  { dir: 'mikktspace', file: 'src/mikktspace.c', why: 'geometry builds the tangent frames gltfio asks for' },
  { dir: 'smol-v', file: 'LICENSE', why: 'filaflat decodes the Metal and Vulkan shaders on both TVs' },
  { dir: 'vkmemalloc', file: 'LICENSE.txt', why: 'the Vulkan backend on Android TV' },
];

/// The pinned Filament checkout on this machine, or null when it has never
/// been cloned here. Resolves the way native/scripts/filament-checkout.sh does:
/// FILAMENT_SRC if set, else the version-addressed clone under ~/Projects.
export function filamentCheckout() {
  const pin = fs.readFileSync(path.join(ROOT, 'native', 'filament.pin'), 'utf8');
  const commit = /^FILAMENT_COMMIT=([0-9a-f]{40})$/m.exec(pin)?.[1];
  if (!commit) throw new Error('native/filament.pin names no FILAMENT_COMMIT');
  const dir = process.env.FILAMENT_SRC
    || path.join(os.homedir(), 'Projects', `filament-${commit.slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, 'LICENSE'))) return null;
  const head = gitHead(dir);
  if (head && head !== commit) {
    throw new Error(`${dir} is at ${head.slice(0, 12)}, not the pinned ${commit.slice(0, 12)}`);
  }
  return { dir, commit };
}

// The commit a checkout sits at, read from .git without running git: a
// detached HEAD is the sha itself, a branch HEAD names the ref to read.
function gitHead(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const ref = /^ref: (.+)$/.exec(head);
    return ref ? fs.readFileSync(path.join(dir, '.git', ref[1]), 'utf8').trim() : head;
  } catch {
    return null;
  }
}

/// The installed Emscripten this tree builds with, or null when the emsdk is
/// not on this machine or is activated at another version (the web build
/// installs and activates the pinned one before it runs this).
export function emscriptenRoot() {
  const sh = fs.readFileSync(path.join(ROOT, 'native', 'scripts', 'build-runtime-web.sh'), 'utf8');
  const version = /^EMSDK_VERSION="([^"]+)"/m.exec(sh)?.[1];
  if (!version) throw new Error('build-runtime-web.sh pins no EMSDK_VERSION');
  const emsdk = process.env.EMSDK_DIR || process.env.EMSDK || path.join(os.homedir(), 'emsdk');
  const dir = path.join(emsdk, 'upstream', 'emscripten');
  const stamp = path.join(dir, 'emscripten-version.txt');
  if (!fs.existsSync(stamp)) return null;
  const installed = fs.readFileSync(stamp, 'utf8').trim().replace(/"/g, '');
  if (installed !== version) return null;
  return { dir, version };
}

const RULE = '='.repeat(72);

/// Filament's own licence and the bundle of its third-party ones, as
/// file name -> text, out of the pinned checkout.
export function deriveFilament({ dir, commit }) {
  const read = (rel) => readUnder(dir, rel);
  const parts = FILAMENT_BUNDLED.map(({ dir: lib, file, why }) => {
    const rel = `third_party/${lib}/${file}`;
    const text = file.endsWith('.c') ? headerComment(read(rel)) : read(rel);
    return `${RULE}\n${lib}: ${why}\n${rel} at ${commit}\n${RULE}\n\n${text.trim()}\n`;
  });
  const preamble = 'The third-party code Filament compiles into the engine binary, one verbatim\n'
    + 'licence text per library, read out of the Filament checkout this build was\n'
    + 'made from. Generated by scripts/gen-upstream-licenses.mjs; do not edit.\n\n';
  return {
    'filament-LICENSE.txt': read('LICENSE'),
    'filament-third-party-LICENSES.txt': preamble + parts.join('\n'),
  };
}

// The licence a source file carries as its leading comment: the first block
// comment that holds a copyright line, with the comment decoration stripped.
function headerComment(source) {
  const block = /\/\*\*?\s*\n((?:\s*\*.*\n)*?\s*\*\s*Copyright[\s\S]*?)\*\//.exec(source);
  if (!block) throw new Error('no copyright comment block at the head of the source');
  return block[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n');
}

/// Emscripten's licence and musl's copyright file, as file name -> text, out
/// of the installed emsdk.
export function deriveEmscripten({ dir }) {
  return {
    'emscripten-LICENSE.txt': readUnder(dir, 'LICENSE'),
    'musl-COPYRIGHT.txt': readUnder(dir, path.join('system', 'lib', 'libc', 'musl', 'COPYRIGHT')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filament = filamentCheckout();
  if (!filament) throw new Error('no pinned Filament checkout here; native/scripts/build-runtime-web.sh clones it');
  const emscripten = emscriptenRoot();
  if (!emscripten) throw new Error('no emsdk at the pinned version here; native/scripts/build-runtime-web.sh installs it');
  const texts = { ...deriveFilament(filament), ...deriveEmscripten(emscripten) };
  for (const [name, text] of Object.entries(texts)) {
    fs.writeFileSync(path.join(OUT, name), text);
  }
  console.log(`==> ${Object.keys(texts).join(', ')} -> public/assets/licenses`);
}
