// /shadow-lab.html — the car contact shadow's tuning bench.
//
// A live race in an iframe with the shadow's knobs beside it, so the look is
// judged where it is actually seen: under a moving car, on asphalt, at the
// carShadow layer's real density. Every number it shows comes back from the
// engine (`ttp_display_shadow_tuning_json`), defaults included — nothing here
// re-types a constant, so the page cannot drift from the shipped look. Two
// tuning keys carry no control on purpose: `remapInShader` and `uploadWhole`
// are measurement arms driven from the console / `debug.ttp.shadow`, not
// look knobs anyone drags.
//
// WHY A PAGE AND NOT FIELDS ON THE WRENCH PANEL. shared/debugPanel.js is a URL
// editor: only `range` carries a `live` hook, every other field costs a reload,
// and a reload here throws away the race you were looking at. Three of these
// knobs are not ranges, and the mask readback below is not a form control at
// all.
//
// WHAT THE MASK CARDS ARE FOR, and it is the reason this page exists rather
// than a few sliders. A stamp lands in roughly 16 by 11 texels of the carShadow
// layer, under an opaque car, on dark asphalt. "That shape looks wrong" and
// "that shape is right but too small to read" are indistinguishable on the deck
// and want OPPOSITE fixes — one is a bake bug, the other is `grow` or the layer
// density. The cards show the mask the engine actually stamps, so the question
// is answered before any pixel-peering starts.
//
// Same-origin property access reaches into the frame (the display page sets
// frame-ancestors 'self'); there is no postMessage protocol, exactly as
// gallery-assets.js and the trailer editor already do it.

import { TRACK_LIST } from '/shared/tracks.js';

const $ = (id) => document.getElementById(id);
const CAR_NAMES = window.CAR_NAMES || [];

// ---- the scene the knobs are judged on -------------------------------------

// SOLO is the default because a shadow reads differently when you are the one
// steering — the own-car stamp is the one the eye actually tracks, and it was a
// user-caught defect twice. The bench arms are how the same tuning is checked
// at the cell counts where the trade was priced; `players=4` is where the blob
// bought 768x432 at 60 in the first place.
const SCENES = [
  { id: 'solo', label: '1P — drive it yourself', q: { solo: '' } },
  { id: 'bench1', label: '1P — autopiloted', q: { scenario: 'bench', players: '1' } },
  { id: 'bench2', label: '2P split — autopiloted', q: { scenario: 'bench', players: '2' } },
  { id: 'bench4', label: '4P split — autopiloted', q: { scenario: 'bench', players: '4' } },
];

// The state the page owns: which scene, which track, which car. Everything
// about the SHADOW lives in the engine and is read back, never mirrored here.
const scene = {
  id: SCENES[0].id,
  track: TRACK_LIST[0] ? TRACK_LIST[0].id : '',
  car: 0,
};

let frame = null;      // the display iframe
let display = null;    // its Display (the wasm edge), once booted
let defaults = null;   // the engine's shipped tuning

function sceneUrl() {
  const spec = SCENES.find((s) => s.id === scene.id) || SCENES[0];
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(spec.q)) q.set(k, v);
  if (spec.id === 'solo') q.set('solo', String(scene.car));
  if (scene.track) q.set('track', scene.track);
  // The cell dividers are ink lines across the picture and this page is looking
  // at ink on the deck; they are noise here and nowhere else.
  q.set('dividers', '0');
  return '/?' + q.toString();
}

function status(text, tone) {
  const el = $('status');
  el.textContent = text;
  el.style.background = tone === 'bad' ? 'var(--red)'
    : tone === 'good' ? 'var(--green)' : '';
  el.style.color = tone ? 'var(--paper)' : '';
}

// Rebuild the iframe and wait for the engine inside it. A fresh element rather
// than an src assignment: the display's boot is a one-shot path (?solo is a
// boot branch, not an API), so re-pointing a live frame would leave the old
// engine's globals up while the new one starts.
function loadScene() {
  display = null;
  status('loading…');
  const host = $('stage-frame');
  host.textContent = '';
  frame = document.createElement('iframe');
  frame.src = sceneUrl();
  frame.allow = 'fullscreen';
  host.appendChild(frame);
  waitForEngine();
}

function waitForEngine() {
  const mine = frame;
  const started = Date.now();
  const tick = () => {
    if (frame !== mine) return;               // a newer scene took over
    let d;
    try { d = mine.contentWindow?.__scene?.display || null; } catch (_) { d = null; }
    // `built` is what says the wasm edge has a scene, not just an object: the
    // tuning calls reach into a renderer that may not exist yet otherwise.
    if (d && d.built) {
      display = d;
      status('live', 'good');
      render();
      return;
    }
    if (Date.now() - started > 40000) {
      status('engine did not come up', 'bad');
      return;
    }
    setTimeout(tick, 150);
  };
  tick();
}

// ---- the knobs -------------------------------------------------------------

// RANGES ARE THIS PAGE'S, defaults are the engine's. A slider's bounds are a UI
// affordance — how far it is useful to drag — and belong here; the value it
// starts at is a shipped constant and must not be, which is why every `value`
// below comes from `defaults` at build time.
const KNOBS = [
  { grp: 'Representation' },
  {
    key: 'mode', type: 'select', label: 'Shadow',
    options: [
      [0, 'Blob — every car (shipped)'],
      [1, 'Silhouette — every car'],
      [2, 'Hybrid — the old distance LOD'],
    ],
    hint: 'B toggles blob / silhouette',
  },
  {
    key: 'shape', type: 'select', label: 'Shape source',
    options: [
      [2, 'Rounded rect — fitted, 4 corners (shipped)'],
      [3, 'Fitted k-gon — convex hull'],
      [0, "Each car's own outline"],
      [1, 'One superellipse for all'],
    ],
    hint: 'the rect and the k-gon are evaluated once per texel; the masks are sampled 16x',
  },
  { key: 'polyEdges', type: 'range', min: 4, max: 10, step: 1, costly: true,
    hint: 'k-gon only — edges the fitted hull keeps; past ~8 the layer cannot show the difference' },
  { key: 'corner', type: 'range', min: 0, max: 1, step: 0.01,
    hint: 'corner rounding — scales the rect’s fitted radius, or the k-gon’s base radius' },

  { grp: 'Shape' },
  { key: 'grow', type: 'range', min: 0, max: 0.35, step: 0.005, costly: true,
    hint: 'dilate the outline — what keeps a wheel readable once the layer minifies it' },
  { key: 'blur', type: 'range', min: 0, max: 0.08, step: 0.001, costly: true,
    hint: 'the penumbra; a razor edge flickers under the raster’s sub-texel slide' },
  { key: 'overscan', type: 'range', min: 1.05, max: 2.2, step: 0.01, costly: true },

  { grp: 'Ink' },
  { key: 'ao', type: 'range', min: 0, max: 1, step: 0.005 },
  { key: 'cap', type: 'range', min: 0, max: 1, step: 0.005,
    hint: 'ceiling on two stacked shadows' },
  { key: 'loadGain', type: 'range', min: 0, max: 0.6, step: 0.005,
    hint: 'deepening at full body pitch' },
  { key: 'ink', type: 'colour', label: 'Colour' },

  { grp: 'Placement' },
  {
    key: 'stampProject', type: 'select', label: 'Probe surface',
    options: [
      [1, 'project() — what uv0 reads'],
      [0, 'deckFoot() — the analytic deck'],
    ],
    hint: 'the suspect behind a cornering ripple: the raster writes at one and the shader reads at the other',
  },

  // Both are fractions of the peak alpha, so they do not move when `Opacity`
  // does. The shipped band is WIDE (0.2..0.8): the tail clip is what keeps
  // the uv0 kinks from banding through the skirt, and the width is what keeps
  // the edge from faceting like the die-cut's narrow band did. An empty band
  // (hi <= lo) is "off" — the engine's own invariant.
  { grp: 'Edge' },
  { key: 'remapLo', type: 'range', min: 0, max: 0.8, step: 0.005,
    hint: 'where the tail is cut; an empty band (hi <= lo) is no cut at all' },
  { key: 'remapHi', type: 'range', min: 0, max: 1, step: 0.005,
    hint: 'the far end of the threshold band' },
  {
    key: 'smoothTap', type: 'select', label: 'Tap filter',
    options: [
      [1, 'bicubic B-spline — 4 fetches, C2'],
      [0, 'bilinear — the raw tap'],
    ],
    hint: 'bilinear’s gradient kinks at every texel boundary; the B-spline is what retires the texel-grid bands',
  },

  // THE FLICKER LIVES HERE. At the shipped 8 texels/u a car's whole stamp is
  // about 7 by 10 texels; the raster re-lands it at a new sub-texel offset
  // every frame, so its edge boils. Measured against a shadow-off baseline on
  // identical sim frames, density is the dominant lever — see the readout
  // below, which is why these two knobs carry one.
  { grp: 'Layer density' },
  { key: 'texelsPerU', type: 'range', min: 2, max: 48, step: 1, costly: true,
    hint: 'along the lap — clamps against the driver’s texture ceiling, so a long lap gets fewer than asked' },
  { key: 'rows', type: 'range', min: 32, max: 1024, step: 32, costly: true,
    hint: 'across the deck; every row is re-uploaded every frame' },
  { readout: 'layer' },
];

const LABELS = {
  corner: 'Corner', grow: 'Grow', blur: 'Blur', overscan: 'Overscan', ao: 'Opacity', cap: 'Cap',
  loadGain: 'Load gain', remapLo: 'Tail cut', remapHi: 'Tail band',
  texelsPerU: 'Texels / unit', rows: 'Rows', polyEdges: 'Edges',
};

const fmt = (k, v) => (k === 'rows' || k === 'texelsPerU' ? String(v) : Number(v).toFixed(3));
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

// Send one knob. PARTIAL by design — the ABI keeps every key not mentioned, so
// a drag never has to carry the other twelve and cannot clobber one.
function push(patch) {
  if (!display) return;
  display.setShadowTuning(patch);
  refreshValues();
}

let current = null;

function refreshValues() {
  if (!display) return;
  const t = display.shadowTuning();
  current = t.current || {};
  defaults = defaults || t.defaults || {};
  paintLayerReadout(t.layer);
  for (const el of document.querySelectorAll('[data-key]')) {
    const k = el.dataset.key;
    if (!(k in current)) continue;
    const knob = el.closest('.knob');
    if (!knob) continue;
    const out = knob.querySelector('.val');
    // A select already SAYS its value in the option it is showing; repeating it
    // as a number beside the label just reads as a stray 0.000.
    if (out) out.textContent = el.tagName === 'SELECT' ? ''
      : k === 'ink' ? hex(current[k]) : fmt(k, current[k]);
    knob.classList.toggle('moved', current[k] !== defaults[k]);
  }
  drawMasks();
}

function buildControls() {
  const host = $('controls');
  host.textContent = '';

  // The scene picker first: it is the only thing here that costs a reload, and
  // burying it under the knobs made that surprising.
  const sceneGrp = group(host, 'Scene');
  select(sceneGrp, 'What is racing', SCENES.map((s) => [s.id, s.label]), scene.id, (v) => {
    scene.id = v;
    loadScene();
  });
  select(sceneGrp, 'Track', TRACK_LIST.map((t) => [t.id, t.name]), scene.track, (v) => {
    scene.track = v;
    loadScene();
  });
  select(sceneGrp, 'Your car', CAR_NAMES.map((n, i) => [String(i), n]), String(scene.car), (v) => {
    scene.car = Number(v);
    if (scene.id === 'solo') loadScene();
  });

  let grp = host;
  for (const k of KNOBS) {
    if (k.grp) { grp = group(host, k.grp); continue; }
    if (k.note) {
      const n = document.createElement('p');
      n.className = 'grp-note';
      n.textContent = k.note;
      grp.appendChild(n);
      continue;
    }
    if (k.readout === 'layer') { layerReadout(grp); continue; }
    if (k.type === 'range') range(grp, k);
    else if (k.type === 'select') {
      // A boolean knob rides a two-option select; send it back as one.
      const isBool = typeof current[k.key] === 'boolean';
      select(grp, k.label, k.options, isBool ? (current[k.key] ? 1 : 0) : current[k.key],
        (v) => push({ [k.key]: isBool ? Number(v) === 1 : Number(v) }), k);
    }
    else if (k.type === 'colour') colour(grp, k);
  }

  // Isolation + reset. These are the warp bench's keys, on buttons, because
  // this page is driven with one hand on the arrow keys.
  const tools = group(host, 'Tools');
  const row = document.createElement('div');
  row.className = 'row';
  button(row, 'Hide cars', () => display && display.debugHideCars(hideCars = !hideCars));
  button(row, 'Wipe rubber', () => display && display.debugWipeSkids());
  button(row, 'Reset', () => defaults && push({ ...defaults }));
  button(row, 'Copy JSON', copyJson);
  tools.appendChild(row);

  // THE LAYER ITSELF, which is the only view of this channel with no camera and
  // no shader in the way. Three wrong diagnoses of one artifact went by without
  // it: banding on the deck could be the raster, the sampling or the grade, and
  // only this says which. If it is in here it is the WRITE; if this is clean and
  // the deck is not, it is the READ.
  const layer = group(host, 'The layer itself');
  const lc = document.createElement('canvas');
  lc.id = 'layer-view';
  lc.width = 96; lc.height = 96;
  layer.appendChild(lc);
  const ln = document.createElement('p');
  ln.id = 'layer-view-note';
  ln.textContent = 'What the raster wrote, around your car. One stamp peaks at '
    + 'ao x 255; brighter than that is two writes overlapping.';
  layer.appendChild(ln);

  // The masks the engine is actually stamping.
  const masks = group(host, 'Baked masks');
  const wrap = document.createElement('div');
  wrap.id = 'masks';
  masks.appendChild(wrap);
  const note = document.createElement('p');
  note.id = 'masks-note';
  note.textContent = 'One card per distinct car model, as the layer stamps it. '
    + 'Nose points up. A red border means the outline bake did not land and the '
    + 'superellipse is standing in.';
  masks.appendChild(note);
}

function group(host, title) {
  const g = document.createElement('div');
  g.className = 'grp';
  const h = document.createElement('h2');
  h.textContent = title;
  g.appendChild(h);
  host.appendChild(g);
  return g;
}

function knobShell(host, key, label, hint, costly) {
  const k = document.createElement('div');
  k.className = 'knob' + (costly ? ' costly' : '');
  const top = document.createElement('div');
  top.className = 'knob-top';
  const name = document.createElement('span');
  name.textContent = label;
  if (hint) name.title = hint;
  const val = document.createElement('span');
  val.className = 'val';
  top.append(name, val);
  k.appendChild(top);
  host.appendChild(k);
  return k;
}

function range(host, spec) {
  const label = spec.label || LABELS[spec.key] || spec.key;
  const k = knobShell(host, spec.key, label, spec.hint, spec.costly);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = spec.min;
  input.max = spec.max;
  input.step = spec.step;
  input.value = current[spec.key];
  input.dataset.key = spec.key;
  // `input` fires per pixel of drag. The three costly knobs re-bake masks or
  // re-allocate a texture pair, so they commit on `change` — otherwise a single
  // drag across the rail issues a hundred re-allocations and the tab stalls.
  input.addEventListener(spec.costly ? 'change' : 'input',
    () => push({ [spec.key]: Number(input.value) }));
  k.appendChild(input);
}

function colour(host, spec) {
  const k = knobShell(host, spec.key, spec.label || spec.key, spec.hint, false);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = hex(current[spec.key]);
  input.dataset.key = spec.key;
  input.addEventListener('change', () => push({ [spec.key]: parseInt(input.value.slice(1), 16) }));
  k.appendChild(input);
}

function select(host, label, options, value, onPick, spec) {
  const k = knobShell(host, spec ? spec.key : label, label, spec && spec.hint, false);
  const sel = document.createElement('select');
  sel.className = 'field';
  if (spec) sel.dataset.key = spec.key;
  for (const [v, text] of options) {
    const opt = document.createElement('option');
    opt.value = String(v);
    opt.textContent = text;
    sel.appendChild(opt);
  }
  sel.value = String(value);
  sel.addEventListener('change', () => onPick(sel.value));
  k.appendChild(sel);
  return sel;
}

// WHAT THE DENSITY BOUGHT, AND WHAT IT COSTS — the two facts the knobs above
// cannot show on their own. The width clamps against the driver's texture
// ceiling, so asking for more texels/u on a long lap silently gets fewer; and
// TEXELS UNDER A STAMP is the number the flicker turns on, because an edge
// re-landed at a new sub-texel offset every frame can only hold still if there
// are enough of them. The upload is the whole level, re-sent every frame — the
// price of every texel added.
function layerReadout(host) {
  const p = document.createElement('p');
  p.id = 'layer-readout';
  host.appendChild(p);
}

function paintLayerReadout(layer) {
  const p = $('layer-readout');
  if (!p) return;
  if (!layer || !layer.w) { p.textContent = 'No layer yet — start a race.'; return; }
  const mb = (layer.uploadBytes / (1024 * 1024)).toFixed(2);
  // The stamp count is only known once a car has been measured, which is after
  // the scene builds — say so rather than printing a confident 0 x 0.
  const stamp = layer.stampTexelsS > 0
    ? `A car's stamp lands on ${layer.stampTexelsLat.toFixed(0)} x `
      + `${layer.stampTexelsS.toFixed(0)} of them. `
    : 'Stamp size once a car is on track. ';
  p.textContent = `${layer.w}x${layer.h} — ${layer.texelsPerU.toFixed(1)} texels/u `
    + `along, ${layer.texelsPerLat.toFixed(1)} across. ${stamp}`
    + `${mb} MB re-uploaded every frame.`;
  // Below ~16 texels along a stamp is where the measured flicker sets in. An
  // unknown count is not a warning.
  p.classList.toggle('tight', layer.stampTexelsS > 0 && layer.stampTexelsS < 16);
}

function button(host, text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn sm';
  b.textContent = text;
  b.addEventListener('click', onClick);
  host.appendChild(b);
  return b;
}

let hideCars = false;

// The tuning as the engine reports it, ready to paste into CarShadowTuning's
// defaults. Only the keys that MOVED — a diff is what a person carries back
// into the header, and a full dump buries it.
function copyJson() {
  if (!current || !defaults) return;
  const moved = {};
  for (const k of Object.keys(current)) {
    if (current[k] !== defaults[k]) moved[k] = current[k];
  }
  const text = JSON.stringify(moved, null, 2);
  navigator.clipboard?.writeText(text).then(
    () => status(Object.keys(moved).length ? 'copied the diff' : 'nothing moved', 'good'),
    () => status('clipboard refused', 'bad'));
}

// ---- the baked masks -------------------------------------------------------

// The cards are built the moment the lab goes live, which is BEFORE the race
// has loaded its cars — at that point every slot is empty and the only mask is
// the generic oval. There is no event for "the outlines baked" (they land
// inside a scene build, per model, whenever a roster first names one), so the
// page watches instead, at a rate a person cannot notice and a frame does not
// care about. `sig` is what stops it repainting four canvases every second.
let maskSig = '';

function watchMasks() {
  setInterval(() => {
    if (!display) return;
    let sig = '';
    try {
      for (let s = 0; s < 8; s++) {
        const m = display.shadowMask(s);
        sig += (m && m.model ? m.model : '-') + (m && m.generic ? 'g' : '') + ',';
      }
    } catch (_) { return; }
    if (sig === maskSig) return;
    maskSig = sig;
    drawMasks();
    // The density readout has the same problem the cards do — it is first
    // painted before any car has been measured, so its stamp count is unknown
    // until one is. Same signal, same beat.
    try { paintLayerReadout(display.shadowTuning().layer); } catch (_) { /* between scenes */ }
  }, 1000);
}

// A window of the layer around the player's car, drawn as ink on paper like the
// mask cards. Track space, so x is along the lap and y across the deck.
function drawLayer() {
  const cv = $('layer-view');
  if (!cv || !display) return;
  let win, peak = 0;
  try {
    const L = display.shadowTuning().layer;
    if (!L || !L.w) return;
    const car = display.debugDecals().filter((c) => c.masked > 0)[0];
    if (!car) return;
    const lat = L.h / (2 * L.texelsPerLat), len = L.w / L.texelsPerU;
    const cx = Math.round(((car.s % len) + len) % len / len * L.w);
    const cy = Math.round((car.lat / lat * 0.5 + 0.5) * L.h);
    const N = 96;
    win = display.shadowLayer(cx - N / 2, cy - N / 2, N, N);
  } catch (_) { return; }
  if (!win || !win.px) return;
  const raw = atob(win.px);
  cv.width = win.w; cv.height = win.h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(win.w, win.h);
  for (let i = 0; i < win.w * win.h; i++) {
    const v = raw.charCodeAt(i);
    peak = Math.max(peak, v);
    img.data[i * 4] = 0x2a; img.data[i * 4 + 1] = 0x27;
    img.data[i * 4 + 2] = 0x35; img.data[i * 4 + 3] = v;
  }
  ctx.putImageData(img, 0, 0);
  const note = $('layer-view-note');
  if (note && current) {
    const one = Math.round((current.ao || 0) * 255);
    note.textContent = `peak ${peak} of ${one} for one stamp`
      + (peak > one + 4 ? ' — OVER: two writes overlap here.'
                        : ' — no overlapping writes.');
    note.classList.toggle('tight', peak > one + 4);
  }
}

function drawMasks() {
  const host = $('masks');
  if (!host || !display) return;
  // One card per distinct MODEL, not per slot: the grid is eight cars over four
  // models and four copies of one outline says nothing extra.
  const seen = new Set();
  const cards = [];
  for (let slot = 0; slot < 8; slot++) {
    let m;
    try { m = display.shadowMask(slot); } catch (_) { break; }
    if (!m || !m.px || !m.w) continue;
    const id = m.model + (m.generic ? '-generic' : '');
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({ slot, m });
  }
  host.textContent = '';
  for (const { slot, m } of cards) {
    const card = document.createElement('div');
    card.className = 'mask' + (m.generic ? ' generic' : '');
    const cv = document.createElement('canvas');
    cv.width = m.w;
    cv.height = m.h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(m.w, m.h);
    const bytes = atob(m.px);
    // Coverage drawn as INK ON PAPER, the way the deck composites it — a
    // white-on-black readout inverts the thing being judged.
    for (let i = 0; i < m.w * m.h; i++) {
      const a = bytes.charCodeAt(i);
      img.data[i * 4] = 0x2a;
      img.data[i * 4 + 1] = 0x27;
      img.data[i * 4 + 2] = 0x35;
      img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    card.appendChild(cv);
    const cap = document.createElement('span');
    cap.textContent = CAR_NAMES[slot] || ('slot ' + slot);
    card.appendChild(cap);
    host.appendChild(card);
  }
  if (!cards.length) {
    const p = document.createElement('p');
    p.id = 'masks-note';
    p.textContent = 'No car slots yet — start a race.';
    host.appendChild(p);
  }
}

// ---- keys ------------------------------------------------------------------

// The frame owns the keyboard while you are driving, so these are the page's
// own and deliberately do not collide with the display's (WASD, Enter, R, Q).
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (!display) return;
  const k = e.key.toLowerCase();
  if (k === 'b') {
    push({ mode: current.mode === 0 ? 1 : 0 });
    render();
  } else if (k === 'h') {
    display.debugHideCars(hideCars = !hideCars);
  } else if (k === 'k') {
    display.debugWipeSkids();
  }
});

// ---- boot ------------------------------------------------------------------

function render() {
  if (!display) return;
  const t = display.shadowTuning();
  current = t.current || {};
  defaults = t.defaults || {};
  buildControls();
  maskSig = '';       // a fresh scene re-bakes; make the watcher repaint
  refreshValues();
}

loadScene();
watchMasks();
// The layer changes every frame; a slow beat is enough to see structure in it
// and costs nothing a person would notice.
setInterval(() => { if (display) drawLayer(); }, 500);
