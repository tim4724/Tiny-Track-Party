// Landmark gallery: each catalogue track's set pieces, through the live renderer.
//
// CHROME ONLY, like the asset gallery: the scene is the real display page
// (/?scenario=landmarks → display/TestHarness.js) in one full-bleed iframe, and
// every control reaches into that frame's `window.__landmarks` instead of
// reloading it. The landmark list, the poses and the split all come from the
// engine through that hook; nothing here knows where a piece stands.
import * as Gallery from './gallery-common.js';
import { MAX_BUFFER_H } from './display/Stage.js';

// This page's own memory. gallery-common's state is shared by every gallery
// page, and a track or view picked here means nothing on the others.
const STATE_KEY = 'tinytrack_gallery_landmarks_v1';
const state = (() => {
  const d = { track: '', players: 1, view: 'driver', spread: false, res: 'sharp' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch (_) { return d; }
})();
const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) { /* private mode */ } };

const frame = document.getElementById('lm-stage');
const trackSel = document.getElementById('lm-track');
const playerBtns = [...document.querySelectorAll('#lm-players [data-players]')];
const viewBtns = [...document.querySelectorAll('#lm-views [data-view]')];
const spreadBox = document.getElementById('lm-spread');
const list = document.getElementById('lm-list');
const resBtn = document.getElementById('lm-res');
let lm = null;   // the hook, once the frame has built its first scene
const linesOut = document.getElementById('lm-lines');

// RES. The game's render scale is adaptive (Stage._adaptScale): every scene
// build misses frames, the rule steps the buffer down a rung and climbs back
// only after a long clean stretch, so a gallery that rebuilds on every click
// spends most of its time on a soft picture. Sharp names the scale (`dpr`, the
// switch that turns the mechanism off) as this screen's own, under the stage's
// own height cap (a named scale is a request that would pass it); Auto leaves
// it out to show what the game does. Either is a fresh load of the stage.
let loads = 0;   // a newer load abandons the wait of the one before
function load() {
  lm = null;
  loads++;
  const q = new URLSearchParams({ scenario: 'landmarks', players: String(state.players) });
  if (state.track) q.set('track', state.track);
  if (state.res === 'sharp') {
    const cap = MAX_BUFFER_H / Math.max(frame.clientHeight, 1);
    q.set('dpr', String(+Math.min(window.devicePixelRatio || 1, cap).toFixed(3)));
  }
  frame.src = '/?' + q;
  whenReady(init);
}

// Only the stage's CURRENT page: right after a reload the frame still holds the
// last one, hook and all, until the new document commits.
function hook() {
  try {
    const w = frame.contentWindow;
    return w && w.location.href === frame.src ? w.__landmarks : null;
  } catch (_) { return null; }
}
// A first build that fails says so, and forgets the remembered track so the next
// load falls back to the catalogue's first rather than failing the same way.
function whenReady(fn) {
  const gen = loads;
  const tick = () => {
    if (gen !== loads) return;
    const h = hook();
    if (h) {
      h.ready().then(() => { if (gen === loads) fn(h); }).catch((e) => {
        state.track = '';
        save();
        const p = document.createElement('p');
        p.className = 'legend__note';
        p.textContent = `The scene did not build (${e && e.message ? e.message : e}). Reload to try the first track.`;
        list.replaceChildren(p);
      });
    } else setTimeout(tick, 120);
  };
  tick();
}

// The views that frame a landmark per cell, which SPREAD changes.
const PER_PIECE = new Set(['driver', 'glance', 'high', 'orbit']);

function paintButtons() {
  for (const b of playerBtns) b.classList.toggle('is-on', +b.dataset.players === state.players);
  for (const b of viewBtns) b.classList.toggle('is-on', b.dataset.view === state.view);
  spreadBox.checked = state.spread;
  resBtn.textContent = state.res === 'sharp' ? 'Res: Sharp' : 'Res: Auto';
}

function paintList() {
  list.innerHTML = '';
  const marks = lm.landmarks();
  if (!marks.length) {
    const p = document.createElement('p');
    p.className = 'legend__note';
    p.textContent = 'No landmarks on this track.';
    list.appendChild(p);
    return;
  }
  const at = lm.focused();
  // With SPREAD each cell frames the next landmark on: say which cell has which.
  const cellsOf = new Map();
  const cells = state.spread && PER_PIECE.has(state.view) ? lm.seats() : 1;
  for (let k = 0; k < cells; k++) {
    const i = (at + k) % marks.length;
    cellsOf.set(i, [...(cellsOf.get(i) || []), k + 1]);
  }
  marks.forEach((m, i) => {
    const row = document.createElement('button');
    row.className = 'kit-row' + (i === at ? ' kit-row--at' : cellsOf.has(i) ? ' kit-row--also' : '');
    const name = document.createElement('span');
    name.className = 'kit-row__name';
    name.textContent = m.label;
    name.title = m.model;
    const n = document.createElement('span');
    n.className = 'kit-row__tris';
    n.textContent = (cells > 1 && cellsOf.has(i) ? 'cell ' + cellsOf.get(i).join(',') + ' · ' : '') + '×' + m.count;
    row.append(name, n);
    row.addEventListener('click', () => { focus(i); frame.focus(); });
    list.appendChild(row);
  });
}

function focus(i) {
  if (!lm) return;
  lm.focus(i);
  paintList();
}
const step = (d) => lm && focus(lm.focused() + d);

// The two rebuilding controls: a new track or a new split is a scene build in
// the frame, which the hook queues in order; the list repaints once it lands.
async function rebuild(fn) {
  if (!lm) return;
  await fn();
  paintList();
}
function setTrack(id) {
  if (!lm) return;
  state.track = id;
  trackSel.value = id;
  save();
  return rebuild(() => lm.track(id));
}
function setPlayers(n) {
  if (!lm) return;
  state.players = n;
  save();
  paintButtons();
  return rebuild(() => lm.players(n));
}
function setView(v) {
  state.view = v;
  save();
  paintButtons();
  if (!lm) return;
  lm.view(v);
  paintList();
}
// A remembered view this build no longer has falls back to the default.
function restoreView() {
  try { lm.view(state.view); } catch (_) { state.view = 'driver'; save(); paintButtons(); lm.view(state.view); }
}
function stepTrack(d) {
  if (!lm) return;
  const opts = [...trackSel.options];
  const i = opts.findIndex((o) => o.value === trackSel.value);
  setTrack(opts[(i + d + opts.length) % opts.length].value);
}

for (const b of playerBtns) b.addEventListener('click', () => { setPlayers(+b.dataset.players); frame.focus(); });
for (const b of viewBtns) b.addEventListener('click', () => { setView(b.dataset.view); frame.focus(); });
trackSel.addEventListener('change', () => { setTrack(trackSel.value); frame.focus(); });
spreadBox.addEventListener('change', () => {
  state.spread = spreadBox.checked;
  save();
  if (lm) { lm.spread(state.spread); paintList(); }
  frame.focus();
});
resBtn.addEventListener('click', () => {
  state.res = state.res === 'sharp' ? 'auto' : 'sharp';
  save();
  paintButtons();
  load();
});
// How many lines the stage is drawing right now, so a drop under Auto shows.
setInterval(() => {
  linesOut.textContent = lm ? `${lm.lines()} lines` : '';
}, 500);
document.getElementById('lm-prev').addEventListener('click', () => { step(-1); frame.focus(); });
document.getElementById('lm-next').addEventListener('click', () => { step(1); frame.focus(); });

// Keys work from either document: after a click the FRAME has focus (so WASD
// flies the free camera), and the arrows and digits must still reach here.
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowUp') stepTrack(-1);
  else if (e.key === 'ArrowDown') stepTrack(1);
  else if (e.key >= '1' && e.key <= '4') setPlayers(+e.key);
  else return;
  e.preventDefault();
}
window.addEventListener('keydown', onKey);

function init(h) {
  lm = h;
  frame.contentWindow.addEventListener('keydown', onKey);
  // Grouped by cup, in catalogue order; once, a Res reload keeps it.
  const groups = new Map();
  for (const t of trackSel.options.length ? [] : lm.tracks()) {
    if (!groups.has(t.cupName)) {
      const g = document.createElement('optgroup');
      g.label = t.cupName;
      groups.set(t.cupName, g);
      trackSel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    groups.get(t.cupName).appendChild(o);
  }
  state.track = lm.trackId();
  trackSel.value = state.track;
  save();
  lm.spread(state.spread);
  restoreView();
  paintList();
}

paintButtons();
Gallery.initMobileOptionsToggle();
load();
