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
const STATE_KEY = 'tinytrack_gallery_landmarks_v2';
const state = (() => {
  const d = { track: '', players: 1, view: 'race', spread: false, res: 'sharp', slow: false, fast: false, keys: true,
              tier: 'full', sort: 'size', item: '' };
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
const slowBtn = document.getElementById('lm-slow');
const fastBtn = document.getElementById('lm-fast');
const legend = document.getElementById('lm-legend');
let lm = null;   // the hook, once the frame has built its first scene
const linesOut = document.getElementById('lm-lines');
const tierBtn = document.getElementById('lm-tier');
const tourBtn = document.getElementById('lm-tour');
const scoreBtn = document.getElementById('lm-score');
const sortSel = document.getElementById('lm-sort');
const card = document.getElementById('lm-card');
const sum = document.getElementById('lm-sum');

// A LINK NAMES A PIECE. The hash carries the track, the model, which of its
// placements and the camera, and follows every step, so the address bar is
// always a link to what is on the stage: a review note can point at one piece
// from one side. A hash on arrival outranks this browser's remembered state.
const linked = new URLSearchParams(location.hash.slice(1));
for (const k of ['track', 'view', 'tier']) if (linked.get(k)) state[k] = linked.get(k);
let wantPiece = linked.get('piece'), wantPlace = +linked.get('n') || 0;
function link() {
  const m = lm && lm.landmarks()[lm.focused()];
  const q = new URLSearchParams({ track: state.track, view: state.view });
  if (m) q.set('piece', m.model.replace(/^set-/, ''));
  if (m && lm.placed()) q.set('n', String(lm.placed()));
  if (state.tier !== 'full') q.set('tier', state.tier);
  history.replaceState(null, '', '#' + q);
}

// WHAT A MODEL COSTS, off its own file: triangles, vertices and how many
// meshes it submits (a draw each before the renderer merges what it can),
// counted per node so a mesh stood twice counts twice. The lite tier's build
// of it is the file beside it that SOURCES.json lists, and a piece the lite
// tier leaves out says so on its set entry (tracks.js, `lite: false`).
const costs = new Map();
function costOf(file) {
  if (!costs.has(file)) {
    costs.set(file, fetch(`/assets/toycar/${file}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (!buf) return null;
      const dv = new DataView(buf);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
      const out = { tris: 0, verts: 0, draws: 0, bytes: buf.byteLength, moves: false };
      for (const n of json.nodes || []) {
        if (/^(spin|path_|anim_)/.test(n.name || '')) out.moves = true;
        if (n.mesh == null) continue;
        for (const pr of json.meshes[n.mesh].primitives) {
          const v = json.accessors[pr.attributes.POSITION].count;
          out.verts += v;
          out.tris += (pr.indices != null ? json.accessors[pr.indices].count : v) / 3;
          out.draws++;
        }
      }
      return out;
    }).catch(() => null));
  }
  return costs.get(file);
}
const sources = fetch('/assets/toycar/SOURCES.json').then((r) => r.json()).then((j) => j.models || {}).catch(() => ({}));
const tracksJs = import('/shared/tracks.js');
const kilo = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n)));
// A model's numbers for the list and the card: its full build, its lite build
// (null where the box draws the full one) and whether lite draws it at all.
const info = new Map();   // model -> { full, lite, liteOff }
async function loadInfo(marks) {
  const [src, { TRACKS }] = await Promise.all([sources, tracksJs]);
  const set = (TRACKS[state.track] && TRACKS[state.track].set) || [];
  await Promise.all(marks.filter((m) => !info.has(m.model)).map(async (m) => {
    const lite = src[`${m.model}-lite.glb`] ? await costOf(`${m.model}-lite.glb`) : null;
    info.set(m.model, { full: await costOf(`${m.model}.glb`), lite });
  }));
  for (const m of marks) {
    const rows = set.filter((e) => e.model === m.model);
    info.get(m.model).liteOff = rows.length > 0 && rows.every((e) => e.lite === false);
  }
}
// The lap score's seconds per model (its best-seen placement), once asked for.
let seen = null;   // model -> { seen, lap, why }

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
  if (state.tier === 'lite') q.set('detail', 'lite');
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
  slowBtn.classList.toggle('is-on', state.slow);
  fastBtn.classList.toggle('is-on', state.fast);
  tierBtn.classList.toggle('is-on', state.tier === 'lite');
  tierBtn.textContent = state.tier === 'lite' ? 'Tier: Lite' : 'Tier: Full';
  tourBtn.classList.toggle('is-on', !!tour);
  sortSel.value = state.sort;
}

// FAMILIES. A forest authored as twelve blocks, a stream as nine reaches: one
// idea, and twelve rows of it bury the heroes. Models that differ only in a
// trailing letter, compass point or ordinal fold under one heading, open while
// the focus is inside it.
const stem = (model) => model.replace(/-(?:[a-l]|ne|nw|se|sw|north|south|east|west|end|short|loop)$/, '').replace(/-b$/, '');
const ORDERS = {
  size: () => 0,                                   // the hook's own: biggest first
  lap: (a, b) => a.m.s - b.m.s,
  cost: (a, b) => placedTris(b.m) - placedTris(a.m),
  seen: (a, b) => (seen ? (seen.get(a.m.model)?.seen ?? 0) - (seen.get(b.m.model)?.seen ?? 0) : 0)
};
const trisOf = (m) => {
  const c = info.get(m.model);
  const of = c && (state.tier === 'lite' ? (c.liteOff ? null : c.lite || c.full) : c.full);
  return of ? of.tris : 0;
};
const placedTris = (m) => trisOf(m) * m.count;

function paintList() {
  list.innerHTML = '';
  const marks = lm.landmarks();
  if (!marks.length) {
    const p = document.createElement('p');
    p.className = 'legend__note';
    p.textContent = 'No landmarks on this track.';
    list.appendChild(p);
    card.replaceChildren();
    sum.textContent = '';
    return;
  }
  const at = lm.focused();
  // With SPREAD each cell frames the next landmark on: say which cell has which.
  const cellsOf = new Map();
  const cells = state.spread && PER_PIECE.has(state.view) ? lm.seats() : 1;
  for (let c = 0; c < cells; c++) {
    const i = (at + c) % marks.length;
    cellsOf.set(i, [...(cellsOf.get(i) || []), c + 1]);
  }
  const rows = marks.map((m, i) => ({ m, i }));
  rows.sort(ORDERS[state.sort] || ORDERS.size);
  // Families in the order their first member sorts.
  const fams = new Map();
  for (const r of rows) {
    const key = stem(r.m.model);
    fams.set(key, [...(fams.get(key) || []), r]);
  }
  const rowOf = ({ m, i }, inFam) => {
    const row = document.createElement('button');
    row.className = 'kit-row' + (inFam ? ' kit-row--member' : '')
      + (i === at ? ' kit-row--at' : cellsOf.has(i) ? ' kit-row--also' : '');
    const name = document.createElement('span');
    name.className = 'kit-row__name';
    name.textContent = m.label;
    name.title = m.model;
    const n = document.createElement('span');
    n.className = 'kit-row__tris';
    const c = info.get(m.model);
    const bits = [];
    if (cells > 1 && cellsOf.has(i)) bits.push('cell ' + cellsOf.get(i).join(','));
    if (seen && seen.has(m.model)) bits.push(seen.get(m.model).seen.toFixed(1) + 's');
    if (c && c.full) bits.push(state.tier === 'lite' && c.liteOff ? 'off' : kilo(trisOf(m)));
    bits.push('×' + m.count);
    n.textContent = bits.join(' · ');
    if (seen && seen.has(m.model) && seen.get(m.model).seen < POOR_S) n.classList.add('kit-row__tris--poor');
    row.append(name, n);
    row.addEventListener('click', () => { focus(i); frame.focus(); });
    return row;
  };
  for (const [key, members] of fams) {
    if (members.length < 3) { for (const r of members) list.appendChild(rowOf(r, false)); continue; }
    const open = members.some((r) => r.i === at);
    const head = document.createElement('button');
    head.className = 'kit-row kit-row--family' + (open ? ' is-open' : '');
    const name = document.createElement('span');
    name.className = 'kit-row__name';
    name.textContent = (open ? '▾ ' : '▸ ') + key.replace(/^set-/, '').replace(/-/g, ' ');
    const n = document.createElement('span');
    n.className = 'kit-row__tris';
    n.textContent = `${members.length} models · ${kilo(members.reduce((t, r) => t + placedTris(r.m), 0))}`;
    head.append(name, n);
    head.addEventListener('click', () => { focus(members[0].i); frame.focus(); });
    list.appendChild(head);
    if (open) for (const r of members) list.appendChild(rowOf(r, true));
  }
  const total = marks.reduce((t, m) => t + placedTris(m), 0);
  sum.textContent = `${marks.length} models · ${marks.reduce((t, m) => t + m.count, 0)} placed · ${kilo(total)} tris (${state.tier})`;
  paintCard(marks[at]);
  link();
  const on = list.querySelector('.kit-row--at');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

// THE FOCUSED PIECE'S CARD: what it is, where on the lap, what it costs in
// each tier, and how long a racer reads it once the lap has been scored.
const POOR_S = 3;   // under this a piece is barely read (see:landmarks' bar)
function paintCard(m) {
  const c = info.get(m.model) || {};
  const line = (label, text, cls) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = text;
    if (cls) dd.className = cls;
    div.append(dt, dd);
    return div;
  };
  const cost = (x) => (x ? `${kilo(x.tris)} tris · ${kilo(x.verts)} verts · ${x.draws} mesh${x.draws === 1 ? '' : 'es'}` : '…');
  const h = document.createElement('h2');
  h.textContent = m.label;
  const dl = document.createElement('dl');
  dl.className = 'lm-card__facts';
  dl.append(line('file', m.model + '.glb'));
  dl.append(line('full', cost(c.full) + (c.full && c.full.moves ? ' · moves' : '')));
  dl.append(line('lite', c.liteOff ? 'not drawn' : c.lite ? cost(c.lite) : c.full ? 'same as full' : '…'));
  const s = seen && seen.get(m.model);
  if (s) dl.append(line('read', `${s.seen.toFixed(1)} s of a ${Math.round(s.lap)} s lap${s.why ? ' · ' + s.why : ''}`, s.seen < POOR_S ? 'is-poor' : ''));
  card.replaceChildren(h, dl);
  if (m.count > 1) {
    const step = document.createElement('div');
    step.className = 'lm-card__step';
    const prev = document.createElement('button'), next = document.createElement('button');
    prev.className = next.className = 'ctrl';
    prev.textContent = '‹';
    next.textContent = '›';
    const out = document.createElement('span');
    out.textContent = `placement ${lm.placed() + 1} of ${m.count}`;
    prev.addEventListener('click', () => { place(-1); frame.focus(); });
    next.addEventListener('click', () => { place(1); frame.focus(); });
    step.append(prev, out, next);
    card.appendChild(step);
  }
}
function place(d) {
  if (!lm) return;
  lm.place(lm.placed() + d);
  paintList();
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
  seen = null;
  paintList();
  const marks = lm.landmarks();
  await loadInfo(marks);
  if (lm && lm.landmarks()[0]?.model === marks[0]?.model) paintList();
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
  paintRace();
}
// THE LAP SCORE, on the list: how long a racer READS each model over one
// autopiloted lap, counted in pixels off the stage's own picture (the hook's
// `see`, what `npm run see:landmarks` folds; its header argues the bar). The
// bar is that script's, authored for a 960x540 picture and scaled to this
// stage's. A model scores as its best placement; `hidden` is the time it would
// have read with the deck, the terrain and the cars out of the way.
const READ = { px: 800, h: 20, w: 960, lines: 540, every: 0.2 };
async function scoreLap() {
  if (!lm || scoreBtn.disabled) return;
  setTour(false);
  scoreBtn.disabled = true;
  scoreBtn.textContent = 'Driving…';
  try {
    const cell = { w: frame.clientWidth, h: frame.clientHeight };
    const minPx = READ.px * (cell.w * cell.h) / (READ.w * READ.lines), minH = READ.h * cell.h / READ.lines;
    const r = await lm.see({ every: READ.every, minPx, minH });
    const reads = (rows, i) => rows && rows.some((x) => x[0] === i && x[1] >= minPx && x[2] >= minH);
    seen = new Map();
    for (const p of r.pieces) {
      let on = 0, hid = 0;
      for (const f of r.frames) {
        if (reads(f.a, p.index)) on++;
        else if (reads(f.b, p.index)) hid++;
      }
      const was = seen.get(p.model);
      if (was && was.seen >= on * r.every) continue;
      seen.set(p.model, { seen: on * r.every, lap: r.frames.length * r.every,
                          why: hid ? `${(hid * r.every).toFixed(1)} s hidden` : '' });
    }
    state.sort = 'seen';
    save();
    paintButtons();
    restoreView();
    paintList();
  } finally {
    scoreBtn.disabled = false;
    scoreBtn.textContent = 'Score lap';
  }
}
// THE TOUR: every model on the track in the list's order, a few seconds each,
// then the next track. For leaning back and watching the catalogue go by.
const TOUR_MS = 6000;
let tour = 0;
function setTour(on) {
  clearInterval(tour);
  tour = on ? setInterval(async () => {
    if (!lm) return;
    const n = lm.landmarks().length;
    if (lm.focused() + 1 < n) step(1);
    else await stepTrack(1);
  }, TOUR_MS) : 0;
  paintButtons();
}
function setTier() {
  state.tier = state.tier === 'lite' ? 'full' : 'lite';
  save();
  paintButtons();
  load();
}
// A remembered view this build no longer has falls back to the default.
function restoreView() {
  try { lm.view(state.view); } catch (_) { state.view = 'race'; save(); paintButtons(); lm.view(state.view); }
  paintRace();
}
function setSpread(on) {
  state.spread = on;
  save();
  spreadBox.checked = on;
  if (lm) { lm.spread(on); paintList(); }
}
// Slow motion: the scene at a quarter of real time, to judge how a piece moves.
const SLOW = 0.25, FAST = 2;
const rate = () => (state.slow ? SLOW : state.fast ? FAST : 1);
function setSlow(on) {
  state.slow = on;
  if (on) state.fast = false;
  save();
  paintButtons();
  if (lm) lm.timeScale(rate());
}
// Double speed, to get round a lap to the stretch worth looking at.
function setFast(on) {
  state.fast = on;
  if (on) state.slow = false;
  save();
  paintButtons();
  if (lm) lm.timeScale(rate());
}
function stepTrack(d) {
  if (!lm) return;
  const opts = [...trackSel.options];
  const i = opts.findIndex((o) => o.value === trackSel.value);
  return setTrack(opts[(i + d + opts.length) % opts.length].value);
}

for (const b of playerBtns) b.addEventListener('click', () => { setPlayers(+b.dataset.players); frame.focus(); });
for (const b of viewBtns) b.addEventListener('click', () => { setView(b.dataset.view); frame.focus(); });
trackSel.addEventListener('change', () => { setTrack(trackSel.value); frame.focus(); });
spreadBox.addEventListener('change', () => { setSpread(spreadBox.checked); frame.focus(); });
slowBtn.addEventListener('click', () => { setSlow(!state.slow); frame.focus(); });
fastBtn.addEventListener('click', () => { setFast(!state.fast); frame.focus(); });
tierBtn.addEventListener('click', setTier);
tourBtn.addEventListener('click', () => { setTour(!tour); frame.focus(); });
scoreBtn.addEventListener('click', () => { scoreLap(); frame.focus(); });
sortSel.addEventListener('change', () => { state.sort = sortSel.value; save(); if (lm) paintList(); frame.focus(); });
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

// THE RACE VIEW'S TRANSPORT. The stage keeps every update it gave its race, so a
// moment is an update count: the slider and the keys seek to one (back is the
// same race wound again from its grid), and a note names the one it was taken at.
const raceBox = document.getElementById('lm-race');
const pauseBtn = document.getElementById('lm-pause');
const timeIn = document.getElementById('lm-time');
const clock = document.getElementById('lm-clock');
const camBtn = document.getElementById('lm-cam');
const savedOut = document.getElementById('lm-saved');
const tierOut = document.getElementById('lm-tier-out');
const inRace = () => !!lm && state.view === 'race' && lm.mode() === 'race';
function paintRace() {
  raceBox.hidden = state.view !== 'race';
  if (!inRace()) return;
  const r = lm.race(), t = r.seconds;
  pauseBtn.textContent = r.paused ? 'Play' : 'Pause';
  pauseBtn.classList.toggle('is-on', r.paused);
  camBtn.textContent = 'Cam: ' + r.cam.charAt(0).toUpperCase() + r.cam.slice(1);
  timeIn.max = String(r.max);
  if (document.activeElement !== timeIn) timeIn.value = String(r.step);
  clock.textContent = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  tierOut.textContent = `${state.tier === 'lite' ? 'Lite tier (Android TV)' : 'Full tier (web, Apple TV)'}${state.fast ? ' · 2x' : state.slow ? ' · slow' : ''}`;
}
setInterval(paintRace, 200);
function pause(on) {
  if (!inRace()) { setView('race'); return; }
  lm.pause(on);
  paintRace();
}
function seekBy(sec) {
  if (!inRace()) return;
  lm.seekBy(sec);
  paintRace();
}
function frameStep(d) {
  if (!inRace()) return;
  lm.pause(true);
  lm.seek(lm.race().step + d);
  paintRace();
}
function stepCam(d) {
  const cams = lm.raceCams();
  lm.raceCam(cams[(cams.indexOf(lm.race().cam) + d + cams.length) % cams.length]);
  paintRace();
}
pauseBtn.addEventListener('click', () => { pause(); frame.focus(); });
camBtn.addEventListener('click', () => { if (inRace()) stepCam(1); frame.focus(); });
timeIn.addEventListener('input', () => { if (inRace()) { lm.pause(true); lm.seek(+timeIn.value); } });
timeIn.addEventListener('change', () => { frame.focus(); paintRace(); });

// A REVIEW NOTE: the stage's picture at this moment, pins the viewer drops on
// it and what they wrote, posted to the dev server (scratch/review/) with
// where and when it was taken and which set piece each pin points at. A
// server that will not take it (a deployed preview) gets a download instead.
const noteDlg = document.getElementById('lm-note-dialog');
const noteImg = document.getElementById('lm-note-img');
const notePic = document.getElementById('lm-note-pic');
const notePins = document.getElementById('lm-note-pins');
const noteText = document.getElementById('lm-note-text');
let noteShot = null, pins = [];
function paintPins() {
  for (const n of notePic.querySelectorAll('.lm-note__pin')) n.remove();
  notePins.replaceChildren();
  pins.forEach((p, i) => {
    const dot = document.createElement('span');
    dot.className = 'lm-note__pin';
    dot.textContent = String(i + 1);
    dot.style.left = p.fx * 100 + '%';
    dot.style.top = p.fy * 100 + '%';
    notePic.appendChild(dot);
    const row = document.createElement('div');
    row.className = 'lm-note__row';
    const b = document.createElement('b');
    b.textContent = String(i + 1);
    const input = document.createElement('input');
    input.value = p.text;
    input.placeholder = 'What about this?';
    input.addEventListener('input', () => { p.text = input.value; });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ctrl';
    del.textContent = '×';
    del.title = 'Remove this pin';
    del.addEventListener('click', () => { pins.splice(i, 1); paintPins(); });
    row.append(b, input, del);
    notePins.appendChild(row);
  });
}
function openNote() {
  if (!lm || noteDlg.open) return;
  setTour(false);
  if (inRace()) lm.pause(true);
  noteShot = lm.shot();
  pins = [];
  noteImg.src = noteShot.png;
  noteText.value = '';
  paintPins();
  paintRace();
  noteDlg.showModal();
  noteText.focus();
}
notePic.addEventListener('click', (e) => {
  const r = noteImg.getBoundingClientRect();
  pins.push({ fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, text: '' });
  paintPins();
  notePins.lastElementChild.querySelector('input').focus();
});
// The picture with its pins drawn in, for a reader who has only the file.
function markedJpeg() {
  const c = document.createElement('canvas');
  c.width = noteShot.w;
  c.height = noteShot.h;
  const g = c.getContext('2d');
  g.drawImage(noteImg, 0, 0, c.width, c.height);
  const r = Math.max(10, c.height / 60);
  g.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  pins.forEach((p, i) => {
    const x = p.fx * c.width, y = p.fy * c.height;
    g.beginPath();
    g.arc(x, y, r, 0, 2 * Math.PI);
    g.fillStyle = '#ff2bd6';
    g.fill();
    g.lineWidth = Math.max(2, r / 5);
    g.strokeStyle = '#fff';
    g.stroke();
    g.fillStyle = '#fff';
    g.fillText(String(i + 1), x, y + 1);
  });
  return c.toDataURL('image/jpeg', 0.9);
}
function download(name, href) {
  const a = document.createElement('a');
  a.download = name;
  a.href = href;
  a.click();
}
let notes = 0;
async function saveNote() {
  if (!noteShot) return;
  const at = pins.map((p) => ({ x: Math.round(p.fx * noteShot.w), y: Math.round(p.fy * noteShot.h) }));
  const under = lm ? lm.under(at) : [];
  const item = round && round.items[itemAt];
  const body = {
    meta: { ...noteShot.meta, tier: state.tier, picture: { w: noteShot.w, h: noteShot.h }, link: location.href,
            review: item ? { round: round.round, item: item.id } : undefined },
    note: noteText.value.trim(),
    pins: pins.map((p, i) => ({ n: i + 1, ...at[i], text: p.text.trim(), piece: under[i] || null })),
    png: noteShot.png,
    marked: pins.length ? markedJpeg() : null
  };
  noteDlg.close();
  frame.focus();
  try {
    const res = await fetch('/api/review-note', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                  body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error);
    const { id, dir } = await res.json();
    savedOut.textContent = `${++notes} saved this visit. Last: ${dir}/${id}.json`;
  } catch (e) {
    const stem = `review-${body.meta.track}-${Date.now()}`;
    download(stem + (body.marked ? '-pins.jpg' : '.png'), body.marked || body.png);
    const { png: _png, marked: _marked, ...rest } = body;
    download(stem + '.json', URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' })));
    savedOut.textContent = `Not saved on the server (${e && e.message ? e.message : e}); downloaded instead.`;
  }
}
document.getElementById('lm-note').addEventListener('click', openNote);
document.getElementById('lm-note-save').addEventListener('click', saveNote);
document.getElementById('lm-note-cancel').addEventListener('click', () => { noteDlg.close(); frame.focus(); });
noteDlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); } });

// LOOKING ROUND. G is a free camera from wherever the picture is now, and back:
// in the race the race's own free cam (the race goes on under it), elsewhere
// the Free view, which opens at the eye of the view it leaves. O is the orbit
// round the focused piece, which a drag turns and the wheel zooms.
let viewBeforeFree = 'orbit';
function freeCam() {
  if (!lm) return;
  if (inRace()) { lm.raceCam(lm.race().cam === 'free' ? 'chase' : 'free'); paintRace(); return; }
  if (state.view === 'free') { setView(viewBeforeFree); return; }
  viewBeforeFree = state.view;
  setView('free');
}

// FULLSCREEN: the stage and this panel, with the header's camera buttons moved
// into the panel while it lasts. H hides the panel there for the whole picture.
const box = document.getElementById('lm-box');
const fullBtn = document.getElementById('lm-full');
const viewsGroup = document.getElementById('lm-views');
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else box.requestFullscreen().catch(() => { /* refused (no gesture): stay windowed */ });
}
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === box;
  if (on) document.getElementById('lm-fs').prepend(viewsGroup);
  else document.getElementById('lm-players').after(viewsGroup);
  legend.hidden = false;
  fullBtn.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
  fullBtn.classList.toggle('is-on', on);
});
fullBtn.addEventListener('click', () => { toggleFull(); frame.focus(); });

// THE REVIEW ROUND: a dev server with scratch/review/round.json lists its items
// here, to be judged on the live stage rather than off screenshots. An item's
// STOPS are where to judge it from, each naming a `track` and one of: a set
// piece (`piece`, its model, framed in `view`, orbit by default, at placement
// `place`), a spot on the lap (`s`, `lat`: the driver's view parked there) or a
// moment of the race (`step`, paused there, through race cam `cam`). The shape,
// by example: scripts/review-round.example.json. An item with no stops (an
// idea, a question) is only read here. Each of an item's `ask` gets an answer
// field. A verdict (Keep, Rework or Drop, a note and the answers, or the
// answers alone) is kept by the server in verdicts-<round>.json. Without a
// round, as on a deployed preview, there is no panel.
const reviewBox = document.getElementById('lm-review');
const DECISIONS = ['keep', 'rework', 'drop'];
let round = null, itemAt = -1, stopAt = -1, reviewSaid = '';
const drafts = new Map();   // item id -> a note typed and not yet saved with a verdict
const answerDrafts = new Map();   // item id -> its answers typed and not yet saved
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
fetch('/api/review-round').then((r) => (r.ok ? r.json() : null)).then((j) => {
  if (!j || !Array.isArray(j.items)) return;
  round = { ...j, verdicts: j.verdicts || {} };
  itemAt = round.items.findIndex((it) => it.id === state.item);
  paintReview();
}).catch(() => { /* no dev server: no panel */ });

function stopLabel(st) {
  const opt = [...trackSel.options].find((o) => o.value === st.track);
  const what = st.piece ? st.piece.replace(/^set-/, '').replace(/-/g, ' ') + (st.place ? ` #${st.place + 1}` : '')
    : st.s != null ? `s ${st.s}` : `step ${st.step}`;
  const view = st.step != null ? 'race' + (st.cam ? ' ' + st.cam : '') : st.s != null ? 'driver' : st.view || 'orbit';
  return `${opt ? opt.textContent : st.track} · ${what} · ${view}`;
}
function paintReview() {
  reviewBox.hidden = !round;
  if (!round) return;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const judged = round.items.filter((it) => round.verdicts[it.id]).length;
  const out = [el('h2', '', round.title || round.round),
               el('p', 'legend__note', `${judged} of ${round.items.length} judged · [ ] item`)];
  round.items.forEach((it, i) => {
    const row = el('button', 'kit-row' + (i === itemAt ? ' kit-row--at' : ''));
    const v = round.verdicts[it.id];
    const badge = v ? (v.decision ? upper(v.decision) : 'Answered') : '';
    row.append(el('span', 'kit-row__name', it.title || it.id),
               el('span', 'kit-row__tris' + (v && v.decision ? ' is-' + v.decision : ''), badge));
    row.addEventListener('click', () => { pickItem(i); frame.focus(); });
    out.push(row);
    if (i !== itemAt) return;
    const open = el('div', 'lm-review__item');
    if (it.text) open.append(el('p', '', it.text));
    // Each question gets its own answer, saved with the verdict (or alone:
    // an idea or a question needs no Keep / Rework / Drop).
    const asks = it.ask || [];
    const answers = answersOf(it);
    asks.forEach((q, n) => {
      const a = el('textarea', 'lm-review__answer');
      a.rows = 2;
      a.placeholder = 'Your answer';
      a.setAttribute('aria-label', q);
      a.value = answers[n] || '';
      a.addEventListener('input', () => { answers[n] = a.value; answerDrafts.set(it.id, answers); });
      open.append(el('p', 'lm-review__ask', q), a);
    });
    const stops = el('div', 'lm-review__stops seg');
    (it.stops || []).forEach((st, k) => {
      const b = el('button', 'ctrl' + (k === stopAt ? ' is-on' : ''), stopLabel(st));
      b.addEventListener('click', () => { goStop(k); frame.focus(); });
      stops.append(b);
    });
    const say = el('div', 'lm-race__row seg');
    for (const d of DECISIONS) {
      const b = el('button', 'ctrl' + (v && v.decision === d ? ' is-on' : ''), upper(d));
      b.dataset.decision = d;
      b.addEventListener('click', () => { judge(d); frame.focus(); });
      say.append(b);
    }
    if (asks.length) {
      const b = el('button', 'ctrl', 'Save answers');
      b.addEventListener('click', () => judge(v ? v.decision : null));
      say.append(b);
    }
    const note = el('textarea', 'lm-review__note');
    note.rows = 3;
    note.placeholder = 'Why? What should change?';
    note.value = drafts.has(it.id) ? drafts.get(it.id) : v ? v.note : '';
    note.addEventListener('input', () => drafts.set(it.id, note.value));
    // A note edited after the verdict is saved with it again.
    note.addEventListener('change', () => { if (round.verdicts[it.id]) judge(round.verdicts[it.id].decision); });
    open.append(stops, say, note, el('p', 'legend__note', reviewSaid));
    out.push(open);
  });
  reviewBox.replaceChildren(...out);
}
function pickItem(i) {
  if (!round || !round.items.length) return;
  itemAt = i;
  stopAt = -1;
  reviewSaid = '';
  state.item = round.items[i].id;
  save();
  paintReview();
  if ((round.items[i].stops || []).length) goStop(0);
}
function stepItem(d) {
  if (!round) return;
  const n = round.items.length;
  pickItem(itemAt < 0 ? (d > 0 ? 0 : n - 1) : (itemAt + d + n) % n);
}
async function goStop(k) {
  const st = round.items[itemAt].stops[k];
  if (!lm || !st) return;
  stopAt = k;
  paintReview();
  setTour(false);
  if (st.track && st.track !== state.track) await setTrack(st.track);
  if (st.step != null) {
    setView('race');
    lm.pause(true);
    lm.seek(st.step);
    if (st.cam) lm.raceCam(st.cam);
    paintRace();
  } else if (st.s != null) {
    lm.park(st.s, st.lat || 0);
    state.view = 'driver';
    save();
    paintButtons();
    paintRace();
  } else if (st.piece) {
    const i = lm.landmarks().findIndex((m) => m.model === st.piece || m.model === 'set-' + st.piece);
    if (i >= 0) { lm.focus(i); lm.place(st.place || 0); }
    setView(st.view || 'orbit');
  }
  paintList();
  // The list has scrolled the panel to the piece; the review is what is being read.
  reviewBox.querySelector('.kit-row--at')?.scrollIntoView({ block: 'start' });
}
// Verdicts post in order, so a note saved on blur cannot land after the
// decision clicked next.
let posting = Promise.resolve();
function answersOf(it) {
  if (answerDrafts.has(it.id)) return answerDrafts.get(it.id);
  const v = round.verdicts[it.id];
  return v && Array.isArray(v.answers) ? v.answers.slice() : [];
}
function judge(decision) {
  const it = round.items[itemAt];
  const v = round.verdicts[it.id];
  const note = drafts.has(it.id) ? drafts.get(it.id) : v ? v.note : '';
  const answers = answersOf(it);
  posting = posting.then(async () => {
    try {
      const res = await fetch('/api/review-verdict', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                       body: JSON.stringify({ round: round.round, id: it.id, decision, note, answers }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      round.verdicts[it.id] = j.verdict;
      drafts.delete(it.id);
      answerDrafts.delete(it.id);
      reviewSaid = `${decision ? upper(decision) : 'Answers'} saved in ${j.file}`;
    } catch (e) {
      reviewSaid = `Not saved (${e && e.message ? e.message : e})`;
    }
    paintReview();
  });
}

// THE PANEL'S WIDTH: its left edge drags (or takes the arrow keys while
// focused), from narrow enough to leave the stage most of the screen to wide
// enough to read a review item's questions; kept with the rest of the state.
const grip = document.getElementById('lm-grip');
const gripBox = document.getElementById('lm-box');
const PANEL_MIN = 200;
function setPanelWidth(w) {
  const max = Math.max(PANEL_MIN, gripBox.clientWidth * 0.7);
  state.panel = Math.round(Math.max(PANEL_MIN, Math.min(max, w)));
  gripBox.style.setProperty('--legend-w', state.panel + 'px');
}
if (state.panel) setPanelWidth(state.panel);
grip.addEventListener('pointerdown', (e) => {
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('is-dragging');
  const move = (ev) => setPanelWidth(gripBox.getBoundingClientRect().right - ev.clientX);
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.classList.remove('is-dragging');
    save();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
  e.preventDefault();
});
grip.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  setPanelWidth(legend.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24));
  save();
  e.preventDefault();
  e.stopPropagation();
});

// THE KEYS, few and the same in every view (the buttons do the rest).
// The free camera lives in the stage frame and reads that window's keys, so a
// camera key pressed while this page has focus is handed to it, and the arrows
// up and down fly it up and down as E and Q do.
const CAM_KEYS = { KeyW: 'KeyW', KeyA: 'KeyA', KeyS: 'KeyS', KeyD: 'KeyD', KeyQ: 'KeyQ', KeyE: 'KeyE',
                   ArrowUp: 'KeyE', ArrowDown: 'KeyQ' };
function camKey(e) {
  const code = CAM_KEYS[e.code];
  const w = frame.contentWindow;
  if (!code || !w || e.handedOn) return false;
  if (e.view === w && code === e.code) return false;   // the frame's own camera has it
  const ev = new KeyboardEvent(e.type, { code });
  ev.handedOn = true;                                  // not handed on again by the frame's listener
  w.dispatchEvent(ev);
  return true;
}
const typing = (t) => t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
function onKey(e) {
  if (noteDlg.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typing(e.target)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const race = inRace();
  if (camKey(e)) { e.preventDefault(); return; }
  if (k === ' ') pause();
  else if (k === 'g') freeCam();
  else if (k === 'o') setView('orbit');
  else if (race && k === 'c') stepCam(e.shiftKey ? -1 : 1);
  else if (race && (k === 'ArrowLeft' || k === 'ArrowRight')) seekBy((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 2));
  else if (race && (k === ',' || k === '.')) frameStep(k === ',' ? -1 : 1);
  else if (k === '[' || k === ']') stepItem(k === '[' ? -1 : 1);
  else if (k === 'f') toggleFull();
  else if (k === 'h' && document.fullscreenElement) legend.hidden = !legend.hidden;
  else if (k === 'n') openNote();
  else return;
  e.preventDefault();
}
function onKeyUp(e) {
  if (!typing(e.target) && camKey(e)) e.preventDefault();
}
window.addEventListener('keydown', onKey);
window.addEventListener('keyup', onKeyUp);

function init(h) {
  lm = h;
  frame.contentWindow.addEventListener('keydown', onKey);
  frame.contentWindow.addEventListener('keyup', onKeyUp);
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
  lm.timeScale(rate());
  restoreView();
  // A link's piece, once: the model it names and which of its placements.
  const i = wantPiece ? lm.landmarks().findIndex((m) => m.model === 'set-' + wantPiece) : -1;
  if (i >= 0) { lm.focus(i); lm.place(wantPlace); }
  wantPiece = null;
  seen = null;
  rebuild(() => {});
  paintReview();   // its stops name tracks, which have names now
}

paintButtons();
Gallery.initMobileOptionsToggle();
load();
