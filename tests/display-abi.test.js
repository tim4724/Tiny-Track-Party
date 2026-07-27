'use strict';
// The DISPLAY half of the runtime C ABI, as the browser will find it in the
// SHIPPED module (public/display/engine/native/ttp_runtime.{mjs,wasm}).
//
// WHY A SEPARATE GATE. Everything behind ttp_display.h needs a GL surface, so
// unlike the sim and party ABIs it cannot be replayed here: ttp_display_create
// wants a canvas, and Filament wants a real WebGL2 context behind it. What CAN
// be proved in Node is the part that breaks silently — the SHAPE of the surface
// the shell binds to. Display.js cwraps these names at construction and reads
// the packed answer out of Module.HEAPF32; a rename, a dropped export or a
// trimmed EXPORTED_RUNTIME_METHODS list all fail at that first call in a
// browser, mid-race, where nothing in CI is looking. native/ ctest can't see it
// either: it never links the emscripten module.
//
// The LAYOUT itself (which grid, which rect) is gated in C++, by frame_check's
// cell-rect table — it runs on all four legs, wasm-under-node included, and the
// shell no longer has a second opinion to compare against since Stage.js's
// bestGrid twin was deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

// The artifacts are CHECKED IN and the game is native-only, so a missing module
// is a broken checkout, not an unbuilt optional extra.
for (const f of [MJS, WASM]) {
  if (!fs.existsSync(f)) {
    throw new Error(`${path.relative(ROOT, f)} missing — run native/scripts/build-runtime-web.sh`);
  }
}

let modPromise = null;
const load = () => (modPromise = modPromise
  || import(pathToFileURL(MJS).href).then((m) => m.default()));

test('the shipped module exports the display ABI the shell binds to', async () => {
  const M = await load();
  // Every name Display.js cwraps. cwrap('missing') does not throw until the
  // call, so check the exports themselves.
  for (const name of ['create', 'asset', 'resize', 'build', 'release', 'bind',
                      'cells', 'cell_rects', 'camera', 'look', 'fog', 'shadows',
                      'hold', 'frame', 'burst', 'profile', 'profile_names']) {
    assert.equal(typeof M[`_ttp_display_${name}`], 'function',
      `_ttp_display_${name} is not exported — the browser would fail at the cwrap call`);
  }
});

test('the heap views the display edge reads are on the Module', async () => {
  const M = await load();
  // HEAPF32: the packed cell rects. HEAPF64: the profile block. HEAPU8: the
  // asset upload. All three are EXPORTED_RUNTIME_METHODS in native/CMakeLists
  // — with -sASSERTIONS=0 a missing one is plain `undefined`, i.e. a TypeError
  // in the render loop rather than a build error.
  for (const view of ['HEAPF32', 'HEAPF64', 'HEAPU8']) {
    assert.ok(M[view] && typeof M[view].subarray === 'function', `Module.${view}`);
  }
  assert.equal(typeof M._malloc, 'function');
  assert.equal(typeof M._free, 'function');
});

test('ttp_display_cell_rects is a safe no-op with no display', async () => {
  const M = await load();
  // ttp_abi.h: an unknown/absent handle is a safe no-op, and this one is asked
  // on the HUD path every frame. Headless there is no display at all (no
  // ttp_display_create can succeed without a canvas), which is the same state
  // the browser is in for the frames before boot() resolves.
  const cellRects = M.cwrap('ttp_display_cell_rects', 'number', ['number', 'number']);
  const ptr = M._malloc(8 * 4 * 4);
  try {
    const f32 = M.HEAPF32;
    for (let i = 0; i < 8 * 4; i++) f32[(ptr >> 2) + i] = -1;
    assert.equal(cellRects(ptr, 8), 0, 'no display means no cells');
    assert.equal(cellRects(0, 8), 0, 'a null buffer is not written through');
    assert.equal(cellRects(ptr, 0), 0, 'room for nothing writes nothing');
    for (let i = 0; i < 8 * 4; i++) {
      assert.equal(M.HEAPF32[(ptr >> 2) + i], -1, `slot ${i} was left alone`);
    }
  } finally {
    M._free(ptr);
  }
});
