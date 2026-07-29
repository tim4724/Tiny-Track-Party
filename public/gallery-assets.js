// Asset gallery — everything the game draws, in one scene you fly yourself.
//
// This page is CHROME ONLY. The scene is the real display page in showroom mode
// (/?scenario=assets&track=showroom → display/TestHarness.js), hosted full-bleed
// in one interactive iframe, and every control here reaches into that frame's
// `window.__showroom` rather than reloading it: a biome is a scene rebuild
// (~50 ms) where a reload is the wasm, the GLBs and a Filament engine again.
//
// The other galleries are grids of frozen thumbnails, which is why they can drive
// their previews by URL. This one has a single live scene whose whole point is
// that you can move around in it, so it is the odd page out by design.
//
// WHAT IS LISTED IN THE LEGEND IS NOT AUTHORED HERE. The staged vocabulary comes
// from the C++ layer that stages it (ttp_showcase_inventory_json, read through
// the frame's bound biome ABI), the car models from the protocol manifest, and
// the always-loaded props from the module that fetches them. A hand-kept list on
// this page would be a fourth copy, and the first one to go stale.
import { PROP_MODELS } from '/display/render/Display.js';
import { ITEM_IDS } from '/display/engine/contract.js';

const Gallery = window.Gallery;
const state = Gallery.loadState();

// The procedural props with more than one take on them, and what each take is.
// AUTHORED HERE and nowhere else on this side: these are captions for a human
// choosing between shapes, and the shapes themselves are
// native/renderer/src/TtpRenderer.cpp's buildRocketModel / buildGnomeModel /
// buildTrainModel. Index in the array IS the variant number the ABI takes.
//
// `ships` mirrors TtpRenderer.h's mModelVariant defaults — the variant the game
// draws when nobody has picked one. It is a CAPTION, so it is a copy, and the
// only thing it can get wrong is which entry this page labels; the scene itself
// always comes from the C++ default. Index 0 is the pre-bench geometry on every
// row and is kept whether or not it won, because a comparison with no "what we
// had" in it is not a comparison.
const BENCH_MODELS = [
  // SLEEK AND MODERN, chosen after four rounds of toy shapes were turned down.
  // 1..3 share a palette (cool white, one grey, one graphite, NO BANDS) and
  // differ only in form. The banding is the part that matters most: it is what
  // made half the earlier attempts read as a traffic cone.
  { id: 'rocket', label: 'Rocket', ships: 1, scale: '9x (it ships at 0.2 units)',
    variants: ['0 · original — the toy rocket, red and cream, kept to compare against',
               '1 · cruise — PICKED: red hull, yellow ogive nose, three swept wings',
               '2 · stealth — the same object in flat facets, three angular blades',
               '3 · lance — long and slender, strakes down its length, not tail fins'] },
  { id: 'gnome', label: 'Garden gnome', ships: 1, scale: null,
    variants: ['0 · original — cone, ball, beard, hat',
               '1 · detailed — belt, arms, face, layered beard, brimmed hat',
               '2 · storybook — v1 plus a floppy hat, a lantern and a toadstool'] },
  { id: 'train', label: 'Wind-up train', ships: 1, scale: null,
    variants: ['0 · original — seven boxes and a cylinder',
               '1 · classic — smokebox, boiler bands, cowcatcher, lamp, rods',
               '2 · chunky — shorter and rounder, spoked wheels, big funnel'] }
];

const frame = document.getElementById('asset-stage');
const biomeSel = document.getElementById('asset-biome');
const itemSel = document.getElementById('asset-item');
const benchSel = document.getElementById('asset-bench');
const variantSel = document.getElementById('asset-variant');
const legendPanel = document.getElementById('asset-legend-panel');
const legendLists = document.getElementById('asset-legend-lists');
const homeBtn = document.getElementById('asset-home');

// The showroom's control surface, once the frame has built its scene. Same
// origin, so this is a property read; the poll is for the wasm + GLB load, which
// takes a beat longer than the iframe's own load event.
function showroom() {
  try { return frame.contentWindow && frame.contentWindow.__showroom; } catch (_) { return null; }
}
function biomeApi() {
  try { return frame.contentWindow && frame.contentWindow.__biomes; } catch (_) { return null; }
}
function whenReady(fn) {
  const tick = () => {
    const s = showroom();
    if (s && biomeApi()) fn(s);
    else setTimeout(tick, 120);
  };
  tick();
}

// ---- controls ---------------------------------------------------------------

for (const id of ITEM_IDS) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `Item: ${id}`;
  itemSel.appendChild(o);
}

// A forced item is a fresh session (the roulette override is fixed at
// construction), so the field goes back to the grid when it changes — which is
// also where it should be when nobody is driving.
Gallery.bindSelect(state, 'asset-item', 'assetItem', () => {
  const s = showroom();
  if (s) s.item(state.assetItem || null);
});

// ---- the model bench --------------------------------------------------------
// Two controls that answer two different questions. BENCH stands every take on
// one prop in a row so they can be compared; VARIANT picks which one the scene
// is actually built with, so the winner can then be seen where it belongs —
// among the landmarks, at the size it ships, in whichever biome. Judging a
// shape only on the bench is how you end up keeping the one that looks best in
// a row and worst on a track.

for (const m of BENCH_MODELS) {
  const o = document.createElement('option');
  o.value = m.id;
  o.textContent = `Bench: ${m.label}`;
  benchSel.appendChild(o);
}

// The variant picker only ever offers the BENCHED model's takes: a single
// dropdown that changed meaning depending on another dropdown would be worse
// than no dropdown, so with the bench off this one is empty and disabled.
function syncVariantOptions() {
  const m = BENCH_MODELS.find((b) => b.id === state.assetBench);
  variantSel.innerHTML = '';
  variantSel.disabled = !m;
  if (!m) {
    const o = document.createElement('option');
    o.textContent = 'Variant: bench off';
    variantSel.appendChild(o);
    return;
  }
  m.variants.forEach((label, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    // Just the name in the dropdown; the header is one row and a full sentence
    // in it pushes every other control off a laptop screen. What each variant
    // actually IS is the legend's job, and the legend is beside it.
    o.textContent = `In use: ${label.split(' — ')[0]}`;
    variantSel.appendChild(o);
  });
  variantSel.value = String((state.assetVariants || {})[m.id] || 0);
}

Gallery.bindSelect(state, 'asset-bench', 'assetBench', () => {
  syncVariantOptions();
  buildLegend();
  const s = showroom();
  if (s) s.bench(state.assetBench || '');
});

variantSel.addEventListener('change', () => {
  const m = BENCH_MODELS.find((b) => b.id === state.assetBench);
  if (!m) return;
  const v = parseInt(variantSel.value, 10) || 0;
  state.assetVariants = { ...(state.assetVariants || {}), [m.id]: v };
  Gallery.saveState(state);
  buildLegend();
  const s = showroom();
  if (s) s.variant(m.id, v);
});

Gallery.bindCheckbox(state, 'asset-drive', 'assetDrive', () => {
  const s = showroom();
  if (s) s.drive(!!state.assetDrive);
});

// The legend is chrome, not scene state — it never touches the frame. Defaulted
// ON before binding, since bindCheckbox reads the box's state FROM `state` (an
// unset key would open the page with the legend hidden and the toggle ticked).
if (state.assetLegend === undefined) state.assetLegend = true;
Gallery.bindCheckbox(state, 'asset-legend', 'assetLegend', () => {
  legendPanel.hidden = !state.assetLegend;
});
legendPanel.hidden = !state.assetLegend;

homeBtn.addEventListener('click', () => {
  const s = showroom();
  if (s) s.home();
  // The camera keys live in the FRAME's document, so hand focus back or the
  // first W after clicking would be typed at this button.
  frame.focus();
});

// ---- the legend -------------------------------------------------------------

function list(title, items, note) {
  if (!items || !items.length) return null;
  const box = document.createElement('div');
  box.className = 'legend__group';
  const h = document.createElement('h2');
  h.textContent = `${title} · ${items.length}`;
  box.appendChild(h);
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  box.appendChild(ul);
  if (note) {
    const p = document.createElement('p');
    p.className = 'legend__note';
    p.textContent = note;
    box.appendChild(p);
  }
  return box;
}

async function buildLegend() {
  const api = biomeApi();
  if (!api) return;
  const inv = api.showcaseInventory();
  const models = window.CAR_MODELS || [];
  const names = window.CAR_NAMES || [];
  legendLists.innerHTML = '';
  const benched = BENCH_MODELS.find((b) => b.id === state.assetBench);
  const parts = [
    // The bench first when it is on, because when it is on it IS the scene —
    // the row replaces the landmark set, so a legend still leading with the
    // seventeen kinds would be describing a scene that is not there.
    benched && list(`Bench · ${benched.label}`, benched.variants,
        'Listed left to right as the camera lands on them. '
        + (benched.scale ? `Staged at ${benched.scale}. ` : '')
        + '"In use" picks which one the game is actually built with, so the '
        + 'winner can be checked where it belongs before anyone commits to it.'),
    list('Cars', models.map((m, i) => `${names[i] || m} · ${m}`),
         'Parked on the grid, one seat per livery.'),
    list('Props', PROP_MODELS),
    list('Scenery', inv.scenery),
    list('Landmarks', inv.landmarks),
    list('Clutter', inv.clutter),
    list('Air', inv.fliers)
  ];
  for (const p of parts) if (p) legendLists.appendChild(p);
  // The DIRECTORY against what is staged. A gallery that only lists what it
  // draws can never tell you about the model it does not — and an unused GLB in
  // the kit is either dead weight to delete or something someone forgot to
  // wire up, and both are worth seeing. /api/assets is the folder itself, so
  // this cannot drift the way a checked-in list would.
  try {
    const res = await fetch('/api/assets');
    if (res.ok) {
      const staged = new Set([...models, ...PROP_MODELS, ...inv.scenery]);
      const spare = (await res.json()).assets.filter((a) => !staged.has(a));
      const el = list('In the kit, not staged', spare,
                      'Present under /assets/toycar, drawn by nothing.');
      if (el) legendLists.appendChild(el);
    }
  } catch (_) { /* the legend is worth having without the diff */ }
  const foot = document.createElement('p');
  foot.className = 'legend__note';
  // What a single frame genuinely cannot show, said plainly rather than left as
  // a gap someone has to notice: the slick markers swap with the biome, and the
  // moving half of the kit only exists while cars are running. The three things
  // a race used to be the only way to see are named here because they are
  // staged BY THE PARKED STATE (native/libttp-runtime/ttp/showcase.h) and go
  // away again under Drive, which is otherwise a surprise.
  foot.textContent = 'Cones become wet-floor signs in a water biome, and oil slicks '
    + 'become ice in the snow. Parked, the showroom stands all four monster trucks on '
    + 'the back half of the grid and a pair of rockets just past the boost pads ahead '
    + 'of you; the slicks, cones, pillars and dropped bananas are down the back '
    + 'straight. Skids, dust and item bursts still need Drive.';
  legendLists.appendChild(foot);
}

// ---- boot -------------------------------------------------------------------

whenReady((s) => {
  const api = biomeApi();
  biomeSel.innerHTML = '';
  // The biome ORDER is the C++ table's, which is the order every other biome
  // picker in the project shows (ttp_theme_biome_name).
  for (const name of api.names) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = `Biome: ${name}`;
    biomeSel.appendChild(o);
  }
  if (!api.has(state.assetBiome)) state.assetBiome = api.names[0];
  biomeSel.value = state.assetBiome;
  Gallery.bindSelect(state, 'asset-biome', 'assetBiome', () => {
    const live = showroom();
    if (live) live.biome(state.assetBiome);
  });

  syncVariantOptions();
  buildLegend();

  // Re-apply what the page remembers. The frame booted on the track's own look
  // with the field parked, so this is the one place the two can disagree.
  // Re-picking the biome it already built is free (Stage keys its rebuild on
  // every input to the scene, the look included).
  //
  // ORDER MATTERS ONLY IN THAT THE LAST ONE WINS THE AWAIT: each of these is a
  // scene rebuild, and Stage collapses a burst of them into one build off the
  // final state. So push the variants BEFORE the bench, and the bench before
  // the biome, and the single build that results has all three.
  for (const [m, v] of Object.entries(state.assetVariants || {})) s.variant(m, v);
  if (state.assetBench) s.bench(state.assetBench);
  s.biome(state.assetBiome);
  if (state.assetItem) s.item(state.assetItem);
  if (state.assetDrive) s.drive(true);
});

Gallery.initMobileOptionsToggle();
