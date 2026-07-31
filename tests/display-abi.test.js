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
  for (const name of ['create', 'asset', 'resize', 'build', 'reroster',
                      'release', 'bind',
                      'cells', 'cell_rects', 'cell_cards', 'dividers',
                      'camera', 'look', 'fog', 'shadows',
                      'hold', 'frame', 'burst', 'hud', 'profile', 'profile_names',
                      'biome', 'showcase']) {
    assert.equal(typeof M[`_ttp_display_${name}`], 'function',
      `_ttp_display_${name} is not exported — the browser would fail at the cwrap call`);
  }
});

test('the cell-overlay setters are a safe no-op with no display', async () => {
  const M = await load();
  // Same contract as cell_rects above, and the same reason it matters: Stage.js
  // pushes these from _loop, which starts running before boot() has resolved a
  // display for it. ttp_abi.h says an absent singleton is a no-op, not a trap.
  assert.doesNotThrow(() => {
    M.cwrap('ttp_display_cell_cards', null, ['number'])(0x3);
    M.cwrap('ttp_display_dividers', null, ['number'])(0);
  });
});

test('the heap views the display edge reads are on the Module', async () => {
  const M = await load();
  // HEAPF32: the packed cell rects. HEAPF64: the profile block. HEAPU8: the
  // asset upload. All three are EXPORTED_RUNTIME_METHODS in native/CMakeLists
  // — with -sASSERTIONS=0 a missing one is plain `undefined`, i.e. a TypeError
  // in the render loop rather than a build error.
  for (const view of ['HEAP32', 'HEAPU32', 'HEAPF32', 'HEAPF64', 'HEAPU8']) {
    assert.ok(M[view] && typeof M[view].subarray === 'function', `Module.${view}`);
  }
  assert.equal(typeof M._malloc, 'function');
  assert.equal(typeof M._free, 'function');
});

// ---- the packed HUD's item codes (ttp_hud.h) --------------------------------
// A held item crosses to the shell as a CODE now, not a string, so the browser
// keeps a mirror of the sim's roll table (ITEM_IDS in display/engine/contract.js
// — which is ALSO what an ITEM message puts on the wire for the phone). Two
// lists, and nothing but this test between them: reorder ttp::ITEM_IDS and every
// phone's USE button relabels itself silently, with the ctests still green
// (native/runtimetest/hud_check.cc pins the C++ half to itself, and neither the
// corpus nor E2E can see a browser array). ttp_item_id exists to be read from
// here (native/runtime/ttp_runtime.h).
test('the item codes in the packed HUD decode to the ids the browser knows', async () => {
  const M = await load();
  assert.equal(typeof M._ttp_item_id, 'function',
    '_ttp_item_id is not exported — the HUD block would decode against nothing');
  const idOf = M.cwrap('ttp_item_id', 'string', ['number']);
  const ptrOf = M.cwrap('ttp_item_id', 'number', ['number']); // '' and NULL read alike as a string
  const { ITEM_IDS } = await import(pathToFileURL(
    path.join(ROOT, 'public/display/engine/contract.js')).href);

  // TTP_ITEM_BOOST is 1, not 0: the code is the roll table's index PLUS ONE, so
  // 0 is free to mean "empty slot" without a sentinel that looks like an item.
  ITEM_IDS.forEach((id, i) => {
    assert.equal(idOf(i + 1), id, `TTP_ITEM_* code ${i + 1} is "${id}" on both sides`);
  });
  assert.equal(ITEM_IDS.length, 4, 'the roll table is four wide (TTP_ITEM_BOOST..MONSTER)');
  assert.equal(ptrOf(0), 0, 'TTP_ITEM_NONE has no id — an empty slot is not an item');
  assert.equal(ptrOf(-1), 0, 'TTP_ITEM_UNKNOWN names nothing this build can draw');
  assert.equal(ptrOf(ITEM_IDS.length + 1), 0, 'nothing past the end of the table');
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

// ---- the biome ABI (ttp_theme.h) --------------------------------------------
// The other half of a scene build, and the half that CAN be exercised headless:
// it needs no GL surface, because it is plain data. native/ ctest proves the
// tables (theme_check) and the marshalling (abi_check); what only this file can
// see is that the SHIPPED artifact still exports them — the biome ABI sits
// OUTSIDE the Filament gate in native/CMakeLists.txt, so a build that dropped it
// would still link, still race, and lose the HUD boost accent, the ?biome=
// dropdown and the race music's pool key in the browser.
test('the shipped module exports the biome ABI, and resolves through it', async () => {
  const M = await load();
  for (const name of ['biome_count', 'biome_name', 'has_biome', 'biome_for_cup',
                      'biome_for_track', 'boost_icon', 'hill_color', 'scenery_models']) {
    assert.equal(typeof M[`_ttp_theme_${name}`], 'function',
      `_ttp_theme_${name} is not exported — shared/biomes.js would fail at the cwrap call`);
  }
  const nameAt = M.cwrap('ttp_theme_biome_name', 'string', ['number']);
  const names = [];
  for (let i = 0, n = M.cwrap('ttp_theme_biome_count', 'number', [])(); i < n; i++) {
    names.push(nameAt(i));
  }
  // The ORDER is what the ?biome= dropdown shows, so it is pinned, not just the set.
  assert.deepEqual(names, ['grass', 'sunset', 'beach', 'canyon', 'snow', 'playroom']);

  const forTrack = M.cwrap('ttp_theme_biome_for_track', 'string', ['string']);
  assert.equal(forTrack('tidepool'), 'beach', 'a track resolves through its own cup');
  assert.equal(forTrack('gym'), 'grass', 'a dev-only track falls back to grass');

  // Every biome must name a race-music pool that exists, or a race in it plays
  // the fallback song silently. This is the ONE place the two halves meet: the
  // pool keys come from audio/musicCatalogue.js (the catalogue's authored home
  // — it moved there when the decide.js oracle was retired), the biome names are
  // C++. Read straight from the data rather than through Audio.js, which does
  // not re-export it: the device half performs commands and holds no table.
  const { RACE_MUSIC } = await import(pathToFileURL(
    path.join(ROOT, 'public/display/audio/musicCatalogue.js')).href);
  const unpooled = names.filter((b) => !RACE_MUSIC[b] || !RACE_MUSIC[b].length);
  assert.deepEqual(unpooled, ['sunset'],
    'sunset is the one cupless biome with no pool of its own (it falls back); '
    + 'any other name here means a cup races to the wrong music');

  // The two colours a shell still draws itself, and the model list it fetches by.
  const boostIcon = M.cwrap('ttp_theme_boost_icon', 'number', ['string']);
  assert.equal(boostIcon('grass') >>> 0, 0x1ba192, 'the grass HUD boost chip stroke');
  assert.equal(boostIcon('nope') >>> 0, boostIcon('grass') >>> 0, 'unknown biome -> grass');
  const hill = M.cwrap('ttp_theme_hill_color', 'number', ['string', 'number']);
  assert.equal(hill('playroom', 0) >>> 0, 0xe66a5a, "the playroom's swatch colour");
  const models = M.cwrap('ttp_theme_scenery_models', 'string', ['string']);
  assert.deepEqual(JSON.parse(models('beach')), ['palm-tall', 'palm-bend']);
});

// ---- the asset gallery stages every model in the kit -------------------------
// The showcase layer's own gate is native/ (the `showcase` ctest, which holds it
// to the biome tables); what only this file can see is the two things that meet
// OUTSIDE C++ — the shipped artifact exporting these entry points, and the union
// they answer with against the GLBs actually sitting in public/assets/toycar.
//
// That second half is the point of /gallery-assets.html itself, and it is worth
// having as a test rather than only as a panel someone looks at: a kit model
// nothing plants is either dead weight or a wiring job left unfinished, and
// neither announces itself.
test('the asset showroom stages every scenery GLB in the kit', async () => {
  const M = await load();
  for (const name of ['ttp_theme_showcase_models', 'ttp_showcase_inventory_json']) {
    assert.equal(typeof M[`_${name}`], 'function',
      `_${name} is not exported — gallery-assets.js would fail at the cwrap call`);
  }
  const staged = JSON.parse(M.cwrap('ttp_theme_showcase_models', 'string', [])());

  // Every biome's own list, unioned by hand here rather than trusted from the
  // same function under test.
  const nameAt = M.cwrap('ttp_theme_biome_name', 'string', ['number']);
  const models = M.cwrap('ttp_theme_scenery_models', 'string', ['string']);
  const want = new Set();
  for (let i = 0, n = M.cwrap('ttp_theme_biome_count', 'number', [])(); i < n; i++) {
    for (const m of JSON.parse(models(nameAt(i)))) want.add(m);
  }
  assert.deepEqual([...want].filter((m) => !staged.includes(m)), [],
    'a biome plants a model the asset gallery never shows');

  // And the directory: everything under the kit is either a car, a prop the
  // renderer always loads, or one of the staged scenery models.
  const CARS = ['vehicle-racer-low', 'vehicle-speedster', 'vehicle-racer', 'vehicle-vintage-racer'];
  const PROPS = ['item-box', 'item-banana', 'item-cone', 'vehicle-monster-truck'];
  const kit = fs.readdirSync(path.join(ROOT, 'public/assets/toycar'))
    .filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
  const drawnBy = new Set([...CARS, ...PROPS, ...staged]);
  assert.deepEqual(kit.filter((m) => !drawnBy.has(m)), [],
    'a GLB in public/assets/toycar is drawn by nothing — delete it, or plant it');

  const inv = JSON.parse(M.cwrap('ttp_showcase_inventory_json', 'string', [])());
  assert.deepEqual(inv.scenery, staged, 'the legend lists what the build stages');
  assert.equal(inv.landmarks.length, 17, 'every hero landmark kind is staged');
  assert.ok(inv.clutter.includes('dominoes') && inv.fliers.includes('hot-air balloon'),
    'the legend spans kinds no single biome carries');
});

// ---- the CPU roster is one table ---------------------------------------------
test('aiPersonas.js has not drifted from the wasm persona table', async () => {
  const M = await load();
  // The runtime path no longer holds a copy: main.js reads the table out of
  // ttp_race_personas_json (libttp-sim's own ttp::AI_PERSONALITIES) and
  // configures it straight back. public/display/aiPersonas.js survives only for
  // the test surfaces that need it synchronously — the gallery harness grids a
  // persona per slot before any wasm call — so it is a second spelling of a
  // shipped table, and this is the check that stops it drifting. It used to be
  // held by a prose "keep in sync" comment and nothing else.
  const want = JSON.parse(M.cwrap('ttp_race_personas_json', 'string', [])());
  const { AI_PERSONALITIES } = await import(pathToFileURL(
    path.join(ROOT, 'public/display/aiPersonas.js')).href);
  assert.equal(AI_PERSONALITIES.length, want.length, 'the roster changed size');
  AI_PERSONALITIES.forEach((p, i) => {
    assert.equal(p.name, want[i].name, `persona ${i} name`);
    assert.equal(p.caution, want[i].caution, `persona ${i} (${p.name}) caution`);
    assert.equal(p.laneBias, want[i].laneBias, `persona ${i} (${p.name}) laneBias`);
  });
});
