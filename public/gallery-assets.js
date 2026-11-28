// Asset gallery — the kit, stood on flat pads, one colour per biome.
//
// This page is CHROME ONLY. The scene is the real display page in showroom mode
// (/?scenario=assets&track=showroom → display/TestHarness.js), hosted full-bleed
// in one interactive iframe. Filters reach into that frame's window.__showroom
// rather than reloading it: a mask is a scene rebuild, and a reload is the wasm,
// the GLBs and a Filament engine again.
//
// Category NAMES come from the inventory JSON (ttp_showcase_inventory_json), in
// bit order, so a chip cannot drift from the C++ list. Bit i is 1<<i.
import * as Gallery from './gallery-common.js';
const state = Gallery.loadState();

const LABELS = {
  cars: 'Cars',
  items: 'Items',
  scenery: 'Scenery',
  props: 'Props',
  landmarks: 'Landmarks',
  clutter: 'Clutter',
  set: 'Set pieces'
};

const frame = document.getElementById('asset-stage');
const filters = document.getElementById('asset-filters');
const places = document.getElementById('asset-places');
const homeBtn = document.getElementById('asset-home');
// Which pad the camera is framing. null is Home, the opening pad.
let place = null;

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

function markPlace() {
  homeBtn.setAttribute('aria-pressed', place ? 'false' : 'true');
  for (const b of places.querySelectorAll('button[data-pad]')) {
    b.setAttribute('aria-pressed', b.dataset.pad === place ? 'true' : 'false');
  }
}

whenReady((s) => {
  const api = biomeApi();
  const inventory = api.showcaseInventory(0x7f);
  const categories = inventory.categories || [];
  let mask = (typeof state.assetMask === 'number') ? (state.assetMask >>> 0) : 0x7f;
  filters.replaceChildren();
  const LABELS_PAD = { kit: 'Kit' };
  for (const pad of inventory.pads || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctrl';
    btn.dataset.pad = pad.name;
    btn.textContent = LABELS_PAD[pad.name]
      || pad.name.charAt(0).toUpperCase() + pad.name.slice(1);
    btn.addEventListener('click', () => {
      place = pad.name;
      markPlace();
      const live = showroom();
      if (live) live.goto(pad.name);
    });
    places.append(btn);
  }
  markPlace();
  categories.forEach((name, i) => {
    const bit = 1 << i;
    const id = `asset-cat-${name}`;
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = (mask & bit) !== 0;
    input.addEventListener('change', () => {
      mask = input.checked ? (mask | bit) : (mask & ~bit);
      state.assetMask = mask;
      Gallery.saveState(state);
      const live = showroom();
      if (live) live.filter(mask);
    });
    label.append(input, document.createTextNode(` ${LABELS[name] || name}`));
    const group = document.createElement('div');
    group.className = 'group';
    group.append(label);
    filters.append(group);
  });
  // The frame's first build is the full kit. A remembered filter rebuilds.
  if (mask !== 0x7f) s.filter(mask);
  else s.home();
});

homeBtn.addEventListener('click', () => {
  place = null;
  markPlace();
  const s = showroom();
  if (s) s.home();
});

Gallery.initMobileOptionsToggle();
