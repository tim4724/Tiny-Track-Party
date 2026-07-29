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

const frame = document.getElementById('asset-stage');
const biomeSel = document.getElementById('asset-biome');
const itemSel = document.getElementById('asset-item');
const driveBox = document.getElementById('asset-drive');
const legendBox = document.getElementById('asset-legend');
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

Gallery.bindCheckbox(state, 'asset-drive', 'assetDrive', () => {
  const s = showroom();
  if (s) s.drive(!!state.assetDrive);
});

// The legend is chrome, not scene state — it never touches the frame.
Gallery.bindCheckbox(state, 'asset-legend', 'assetLegend', () => {
  legendPanel.hidden = !state.assetLegend;
});
if (state.assetLegend === undefined) state.assetLegend = true;
legendBox.checked = !!state.assetLegend;
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
  const parts = [
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
  // The two things a single frame genuinely cannot show, said plainly rather
  // than left as a gap someone has to notice: the slick markers swap with the
  // biome, and the moving half of the kit only exists while cars are running.
  foot.textContent = 'Cones become wet-floor signs in a water biome, and oil slicks '
    + 'become ice in the snow. Skids, dust, item bursts and the monster truck need Drive.';
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

  buildLegend();

  // Re-apply what the page remembers. The frame booted on the track's own look
  // with the field parked, so this is the one place the two can disagree.
  // Re-picking the biome it already built is free (Stage keys its rebuild on
  // every input to the scene, the look included).
  s.biome(state.assetBiome);
  if (state.assetItem) s.item(state.assetItem);
  if (state.assetDrive) s.drive(true);
  driveBox.checked = !!state.assetDrive;
});

Gallery.initMobileOptionsToggle();
