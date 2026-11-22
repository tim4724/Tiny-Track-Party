// Landmark gallery: each catalogue track's set pieces, through the live renderer.
//
// CHROME ONLY, like the asset gallery: the scene is the real display page
// (/?scenario=landmarks → display/TestHarness.js) in one full-bleed iframe, and
// every control reaches into that frame's `window.__landmarks` instead of
// reloading it. The landmark list, the poses and the split all come from the
// engine through that hook; nothing here knows where a piece stands.
import * as Gallery from './gallery-common.js';
import { MAX_BUFFER_H } from './display/Stage.js';
import { storedVolume } from './display/audio/bus.js';

// This page's own memory. gallery-common's state is shared by every gallery
// page, and a track or view picked here means nothing on the others.
// Sound is not remembered: every visit opens silent.
const STATE_KEY = 'tinytrack_gallery_landmarks_v2';
const state = (() => {
  const d = { track: '', players: 1, view: 'race', res: 'sharp', speed: 'normal', help: false, tab: 'review',
              tier: 'full', sort: 'size', item: '', sound: false, compare: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}'), sound: false }; } catch (_) { return d; }
})();
const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) { /* private mode */ } };

const frame = document.getElementById('lm-stage');
const trackSel = document.getElementById('lm-track');
const viewBtns = [...document.querySelectorAll('#lm-views [data-view]')];
const list = document.getElementById('lm-list');
const resSel = document.getElementById('lm-res');
const speedBtns = [...document.querySelectorAll('#lm-speed [data-speed]')];
const legend = document.getElementById('lm-legend');
let lm = null;   // the hook, once the frame has built its first scene
const linesOut = document.getElementById('lm-lines');
const tierBtn = document.getElementById('lm-tier');
const scoreBtn = document.getElementById('lm-score');
const sortSel = document.getElementById('lm-sort');
const card = document.getElementById('lm-card');
const sum = document.getElementById('lm-sum');
const frameB = document.getElementById('lm-stage-b');
const compareBtn = document.getElementById('lm-compare');
const diffBox = document.getElementById('lm-diff');
let lmB = null;   // Compare's lite stage, once built
// A model's own name: the lite tier's layout names a piece by the build it
// draws (`<model>-lite`).
const base = (model) => model.replace(/-lite$/, '');
// The tier the first stage draws: Full beside Compare's Lite, else the one picked.
const tier = () => (state.compare ? 'full' : state.tier);
let drawn = null;   // the tier the first stage has built, null while it builds another

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
  if (m) q.set('piece', base(m.model).replace(/^set-/, ''));
  if (m && lm.placed()) q.set('n', String(lm.placed()));
  if (tier() !== 'full') q.set('tier', tier());
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
    const b = base(m.model);
    const lite = src[`${b}-lite.glb`] ? await costOf(`${b}-lite.glb`) : null;
    info.set(m.model, { full: await costOf(`${b}.glb`), lite });
  }));
  for (const m of marks) {
    const rows = set.filter((e) => e.model === base(m.model));
    info.get(m.model).liteOff = rows.length > 0 && rows.every((e) => e.lite === false);
  }
}
// The lap score's seconds per model (its best-seen placement), once asked for.
let seen = null;   // model -> { seen, lap, why }

// RES. The game's render scale is adaptive (Stage._adaptScale): every scene
// build misses frames, the rule steps the buffer down a rung and climbs back
// only after a long clean stretch, so a gallery that rebuilds on every click
// spends most of its time on a soft picture. So the page NAMES the scale (the
// stage's `dpr`, which turns the mechanism off): this screen's own by default,
// or one rung of the game's ladder (render_scale.h's kScaleLadder, in lines) to
// see the picture a TV holding that rung shows. Auto leaves it to the game.
// All under the stage's own height cap, and re-fitted when the stage's box
// changes, since a rung is lines and a scale is a share of the box.
const RUNGS = [540, 720, 1080, 1620, 2160];
for (const [v, t] of [['sharp', 'Res: screen'], ['auto', 'Res: auto'], ...RUNGS.map((n) => [String(n), `Res: ${n}`])]) {
  const o = document.createElement('option');
  o.value = v;
  o.textContent = t;
  resSel.appendChild(o);
}
if (![...resSel.options].some((o) => o.value === state.res)) state.res = 'sharp';
function resScale() {
  if (state.res === 'auto') return null;
  const h = Math.max(frame.clientHeight, 1);
  const want = state.res === 'sharp' ? (window.devicePixelRatio || 1) : +state.res / h;
  return +Math.min(want, MAX_BUFFER_H / h).toFixed(3);
}
function setRes(v) {
  state.res = v;
  save();
  for (const h of [lm, lmB]) if (h) h.scale(resScale());
}
// The two stages are always the same size, so one is watched for both.
new ResizeObserver(() => { if (state.res !== 'auto') for (const h of [lm, lmB]) if (h) h.scale(resScale()); }).observe(frame);

// A stage's address: the scenario on this page's track and split, in `t` (the
// tier) at the page's named scale; the game's sound only in the first.
function stageUrl(t, sound) {
  const q = new URLSearchParams({ scenario: 'landmarks', players: String(state.players) });
  if (state.track) q.set('track', state.track);
  if (t === 'lite') q.set('detail', 'lite');
  if (state.res !== 'auto') q.set('dpr', String(resScale()));
  if (sound) q.set('sfx', '1');
  return '/?' + q;
}
const errText = (e) => (e && e.message ? e.message : String(e));
function load() {
  lm = null;
  frame.src = stageUrl(tier(), true);
  // A first build that fails says so, and forgets the remembered track so the
  // next load falls back to the catalogue's first rather than failing the same way.
  whenReady(frame, init, (e) => {
    state.track = '';
    save();
    list.replaceChildren(el('p', 'legend__note', `The scene did not build (${errText(e)}). Reload to try the first track.`));
  });
}

// Only a stage's CURRENT page: right after a reload the frame still holds the
// last one, hook and all, until the new document commits.
function hook(f) {
  try {
    const w = f.contentWindow;
    return w && w.location.href === f.src ? w.__landmarks : null;
  } catch (_) { return null; }
}
// Per stage, a newer load (or an unload) abandons the wait of the one before.
const loads = new Map();
const nextLoad = (f) => { loads.set(f, (loads.get(f) || 0) + 1); return loads.get(f); };
function whenReady(f, fn, failed) {
  const gen = nextLoad(f);
  const tick = () => {
    if (gen !== loads.get(f)) return;
    const h = hook(f);
    if (h) h.ready().then(() => { if (gen === loads.get(f)) fn(h); }).catch(failed);
    else setTimeout(tick, 120);
  };
  tick();
}
// A DOM element with a class and its text, for the panels built in code.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// The camera button that is lit. A race has three of its own: its free and top
// cameras light Free and Top, and a looped stretch of it lights Drive past.
function litView() {
  if (!lm || state.view !== 'race' || lm.mode() !== 'race') return state.view;
  const r = lm.race();
  return r.cam !== 'chase' ? r.cam : r.loop ? 'past' : 'race';
}
// The race is offered at one, two and four players: the splits a racer sees.
function paintViews() {
  const lit = litView();
  for (const b of viewBtns) {
    b.classList.toggle('is-on', b.dataset.view === lit && (!b.dataset.players || +b.dataset.players === state.players));
  }
}
function paintButtons() {
  paintViews();
  resSel.value = state.res;
  for (const b of speedBtns) b.classList.toggle('is-on', b.dataset.speed === state.speed);
  tierBtn.classList.toggle('is-on', state.tier === 'lite');
  tierBtn.textContent = state.tier === 'lite' ? 'Tier: Lite' : 'Tier: Full';
  tierBtn.disabled = state.compare;   // Compare shows both
  compareBtn.textContent = state.compare ? 'Compare: on' : 'Compare: off';
  compareBtn.setAttribute('aria-pressed', String(state.compare));
  sortSel.value = state.sort;
}

// FAMILIES. A forest authored as twelve blocks, a stream as nine reaches: one
// idea, and twelve rows of it bury the heroes. Models that differ only in a
// trailing letter, compass point or ordinal fold under one heading, open while
// the focus is inside it.
const stem = (model) => base(model).replace(/-(?:[a-l]|ne|nw|se|sw|north|south|east|west|end|short|loop)$/, '').replace(/-b$/, '');
const ORDERS = {
  size: () => 0,                                   // the hook's own: biggest first
  lap: (a, b) => a.m.s - b.m.s,
  cost: (a, b) => placedTris(b.m) - placedTris(a.m),
  seen: (a, b) => (seen ? (seen.get(a.m.model)?.seen ?? 0) - (seen.get(b.m.model)?.seen ?? 0) : 0)
};
const trisOf = (m) => {
  const c = info.get(m.model);
  const of = c && (tier() === 'lite' ? (c.liteOff ? null : c.lite || c.full) : c.full);
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
      + (i === at ? ' kit-row--at' : '');
    const name = document.createElement('span');
    name.className = 'kit-row__name';
    name.textContent = m.label;
    name.title = m.model;
    const n = document.createElement('span');
    n.className = 'kit-row__tris';
    const c = info.get(m.model);
    const bits = [];
    if (seen && seen.has(m.model)) bits.push(seen.get(m.model).seen.toFixed(1) + 's');
    if (c && c.full) bits.push(tier() === 'lite' && c.liteOff ? 'off' : kilo(trisOf(m)));
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
  sum.textContent = `${marks.length} models · ${marks.reduce((t, m) => t + m.count, 0)} placed · ${kilo(total)} tris (${tier()})`;
  paintCard(marks[at]);
  link();
  const on = list.querySelector('.kit-row--at');
  if (on) on.scrollIntoView({ block: 'nearest' });
  if (state.compare) drawDiff();
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
  dl.append(line('file', base(m.model) + '.glb'));
  dl.append(line('full', cost(c.full) + (c.full && c.full.moves ? ' · moves' : '')));
  dl.append(line('lite', c.liteOff ? 'not drawn' : c.lite ? cost(c.lite) : c.full ? 'same as full' : '…'));
  const s = seen && seen.get(m.model);
  if (s) dl.append(line('read', `${s.seen.toFixed(1)} s of a ${Math.round(s.lap)} s lap${s.why ? ' · ' + s.why : ''}`, s.seen < POOR_S ? 'is-poor' : ''));
  const go = document.createElement('button');
  go.className = 'ctrl lm-card__go';
  go.textContent = '▶ Drive past';
  go.title = 'The race through this piece, on a loop (P)';
  go.addEventListener('click', () => { drivePast(); frame.focus(); });
  card.replaceChildren(h, dl, go);
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
// A piece picked by hand is no longer the review stop's.
function leaveStop() {
  if (stopAt < 0) return;
  stopAt = -1;
  paintReview();
}
function place(d) {
  if (!lm) return;
  lm.place(lm.placed() + d);
  leaveStop();
  paintList();
}

function focus(i) {
  if (!lm) return;
  lm.focus(i);
  leaveStop();
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
// The race keeps running (or stays paused) under its own free and top cameras,
// so from a race Free and Top are those, and Race is the way back to the chase
// rig. Leaving for a framed view parks the field on the grid again.
function setView(v) {
  if (v === 'past') { drivePast(); return; }
  if (inRace() && (v === 'free' || v === 'top' || (v === 'race' && lm.race().cam !== 'chase'))) {
    lm.raceCam(v === 'race' ? 'chase' : v);
    paintRace();
    return;
  }
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
// The other tier on the standing stage.
function setTier() {
  if (!lm || state.compare) return;
  state.tier = state.tier === 'lite' ? 'full' : 'lite';
  save();
  paintButtons();
  return retier();
}
// The first stage built again in the tier it should draw (tier()), where it
// stood: the track, the view and the focused piece, found again by its model,
// since a tier that leaves pieces out renumbers the rest.
function retier() {
  if (!lm) return;
  const m = lm.landmarks()[lm.focused()], n = lm.placed();
  drawn = null;
  return rebuild(async () => {
    drawn = await lm.detail(tier());
    const i = m ? lm.landmarks().findIndex((x) => base(x.model) === base(m.model)) : -1;
    if (i >= 0) { lm.focus(i); lm.place(n); }
  });
}
// A remembered view this build no longer has falls back to the default.
function restoreView() {
  try { lm.view(state.view); } catch (_) { state.view = 'race'; save(); paintButtons(); lm.view(state.view); }
  paintRace();
}
// THE SCENE CLOCK'S RATE, one of three: a quarter of real time to judge how a
// piece moves, real time, and double to get round a lap to the stretch worth
// looking at. Always one of them lit, so the way back to real time shows.
const SPEEDS = { slow: 0.25, normal: 1, fast: 2 };
const rate = () => SPEEDS[state.speed] || 1;
function setSpeed(v) {
  state.speed = v;
  save();
  paintButtons();
  for (const h of [lm, lmB]) if (h) h.timeScale(rate());
}
function stepSpeed(d) {
  const all = Object.keys(SPEEDS);
  setSpeed(all[(all.indexOf(state.speed) + d + all.length) % all.length]);
}
// A race button names its split; the views that frame one piece want one cell.
async function pickView(v, players) {
  if (!lm) return;
  if (players && players !== state.players) {
    if (state.view !== 'race') setView('race');
    await setPlayers(players);
    paintRace();
    return;
  }
  setView(v);
  if ((v === 'high' || v === 'orbit') && state.players > 1) await setPlayers(1);
}
for (const b of viewBtns) b.addEventListener('click', () => { pickView(b.dataset.view, +b.dataset.players || 0); frame.focus(); });
trackSel.addEventListener('change', () => { setTrack(trackSel.value); frame.focus(); });
for (const b of speedBtns) b.addEventListener('click', () => { setSpeed(b.dataset.speed); frame.focus(); });
tierBtn.addEventListener('click', () => { setTier(); frame.focus(); });
compareBtn.addEventListener('click', () => { setCompare(!state.compare); frame.focus(); });
scoreBtn.addEventListener('click', () => { scoreLap(); frame.focus(); });
sortSel.addEventListener('change', () => { state.sort = sortSel.value; save(); if (lm) paintList(); frame.focus(); });
resSel.addEventListener('change', () => { setRes(resSel.value); frame.focus(); });
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
const loopBtn = document.getElementById('lm-loop');
const inRace = () => !!lm && state.view === 'race' && lm.mode() === 'race';
function paintRace() {
  // A drag on the stage takes the free camera by itself (the stage's own doing).
  if (lm && lm.mode() === 'free' && state.view !== 'free') {
    viewBeforeFree = state.view;
    state.view = 'free';
    save();
    paintButtons();
  }
  raceBox.hidden = state.view !== 'race';
  if (!inRace()) return;
  const r = lm.race(), t = r.seconds;
  pauseBtn.textContent = r.paused ? 'Play' : 'Pause';
  pauseBtn.classList.toggle('is-on', r.paused);
  camBtn.textContent = 'Cam: ' + r.cam.charAt(0).toUpperCase() + r.cam.slice(1);
  timeIn.max = String(r.max);
  if (document.activeElement !== timeIn) timeIn.value = String(r.step);
  clock.textContent = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  loopBtn.hidden = !r.loop;
  paintViews();
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
// DRIVE PAST: the race through a spot of the lap on a loop (the stage's
// `drivePast`), which is how a piece is met. The spot is the review stop's when
// that names one, otherwise the focused piece's placement.
function drivePast() {
  if (!lm) return;
  const st = round && itemAt >= 0 && (round.items[itemAt].stops || [])[stopAt];
  lm.drivePast(st && st.s != null ? st.s : undefined);
  state.view = 'race';
  save();
  paintButtons();
  paintRace();
}
loopBtn.addEventListener('click', () => { if (lm) lm.drivePast(false); paintRace(); frame.focus(); });
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
    meta: { ...noteShot.meta, tier: tier(), picture: { w: noteShot.w, h: noteShot.h }, link: location.href,
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
  else trackSel.closest('.group').after(viewsGroup);
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
// moment of the race (`step`, paused there, through race cam `cam`; the free
// one from `eye`, `yaw` and `pitch`, as a note saves its camera). The shape,
// by example: scripts/review-round.example.json. An item with no stops (an
// idea, a question) is only read here. Each of an item's `ask` gets an answer
// field. A verdict (Keep, Rework or Drop, a note and the answers, or the
// answers alone) is kept by the server in verdicts-<round>.json. Without a
// round, as on a deployed preview, there is no panel.
const reviewBox = document.getElementById('lm-review');
const piecesBox = document.getElementById('lm-pieces');
const tabsBox = document.getElementById('lm-tabs');
const tabBtns = [...tabsBox.querySelectorAll('[data-tab]')];
const helpBtn = document.getElementById('lm-help');
const keysBox = document.getElementById('lm-keys');
const DECISIONS = ['keep', 'rework', 'drop'];
let round = null, itemAt = -1, stopAt = -1, reviewSaid = '';
let listOpen = false;   // the round's list rather than the picked item
// WHAT WAS TYPED AND NOT YET SAVED WITH A VERDICT, per item: a note and the
// answers. Kept in this browser under the round's name, so a reload (or a
// crashed tab) loses nothing; a saved verdict takes its item out.
const DRAFTS_KEY = 'tinytrack_gallery_review_drafts_v1';
const drafts = new Map(), answerDrafts = new Map();
function keepDrafts() {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ round: round.round, notes: [...drafts], answers: [...answerDrafts] }));
  } catch (_) { /* private mode */ }
}
function loadDrafts() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFTS_KEY) || 'null');
    if (!d || d.round !== round.round) return;
    for (const [k, v] of d.notes || []) drafts.set(k, v);
    for (const [k, v] of d.answers || []) answerDrafts.set(k, v);
  } catch (_) { /* unreadable: start clean */ }
}
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
fetch('/api/review-round').then((r) => (r.ok ? r.json() : null)).then((j) => {
  if (!j || !Array.isArray(j.items)) return;
  round = { ...j, verdicts: j.verdicts || {} };
  loadDrafts();
  itemAt = round.items.findIndex((it) => it.id === state.item);
  paintReview();
}).catch(() => { /* no dev server: no panel */ });

// THE PANEL'S BODIES: the review round, where there is one, the track's
// pieces, and under Compare what Lite changes. And the keys, folded away
// until asked for.
function paintTabs() {
  const has = (t) => (t === 'review' ? !!round : t === 'diff' ? state.compare : true);
  const tab = has(state.tab) ? state.tab : 'pieces';
  tabsBox.hidden = !round && !state.compare;
  for (const b of tabBtns) {
    b.classList.toggle('is-on', b.dataset.tab === tab);
    b.hidden = !has(b.dataset.tab);
  }
  reviewBox.hidden = tab !== 'review';
  piecesBox.hidden = tab !== 'pieces';
  diffBox.hidden = tab !== 'diff';
  keysBox.hidden = !state.help;
  helpBtn.classList.toggle('is-on', state.help);
}
function setTab(t) {
  state.tab = t;
  save();
  paintTabs();
  if (t === 'pieces') list.querySelector('.kit-row--at')?.scrollIntoView({ block: 'nearest' });
}
function setHelp(on) {
  state.help = on;
  save();
  paintTabs();
}
for (const b of tabBtns) b.addEventListener('click', () => { setTab(b.dataset.tab); frame.focus(); });
helpBtn.addEventListener('click', () => { setHelp(!state.help); frame.focus(); });

// A stop's name on its button. The track is said only where an item's stops
// are on more than one.
function stopLabel(st, withTrack) {
  const opt = [...trackSel.options].find((o) => o.value === st.track);
  const what = st.piece ? st.piece.replace(/^set-/, '').replace(/-/g, ' ') + (st.place ? ` #${st.place + 1}` : '')
    : st.s != null ? `s ${st.s}` : `step ${st.step}`;
  const view = st.step != null ? 'race' + (st.cam ? ' ' + st.cam : '') : st.s != null ? 'parked' : st.view || 'orbit';
  return `${withTrack ? (opt ? opt.textContent : st.track) + ' · ' : ''}${upper(what)} · ${view}`;
}
function paintReview() {
  paintTabs();
  if (!round) return;
  const badgeOf = (v) => (v ? (v.decision ? upper(v.decision) : 'Answered') : '');
  const n = round.items.length;
  const it = !listOpen && round.items[itemAt];
  if (!it) {
    const judged = round.items.filter((x) => round.verdicts[x.id]).length;
    const bar = el('div', 'lm-review__bar');
    bar.append(el('i'));
    bar.firstChild.style.width = (n ? 100 * judged / n : 0) + '%';
    const out = [el('h2', '', round.title || round.round), el('p', 'legend__note', `${judged} of ${n} judged`), bar];
    round.items.forEach((x, i) => {
      const v = round.verdicts[x.id];
      const row = el('button', 'kit-row lm-review__row' + (i === itemAt ? ' kit-row--at' : ''));
      row.append(el('span', 'kit-row__name', x.title || x.id),
                 el('span', 'kit-row__tris' + (v && v.decision ? ' is-' + v.decision : ''),
                    badgeOf(v) || (drafts.get(x.id) ? 'Draft' : '')));
      row.addEventListener('click', () => { pickItem(i); frame.focus(); });
      out.push(row);
    });
    reviewBox.replaceChildren(...out);
    return;
  }
  const v = round.verdicts[it.id];
  const nav = el('div', 'lm-review__nav');
  const prev = el('button', 'ctrl', '‹'), next = el('button', 'ctrl', '›'), all = el('button', 'ctrl', 'All items');
  prev.title = 'Previous item ([)';
  next.title = 'Next item (])';
  prev.addEventListener('click', () => { stepItem(-1); frame.focus(); });
  next.addEventListener('click', () => { stepItem(1); frame.focus(); });
  all.addEventListener('click', () => { listOpen = true; paintReview(); frame.focus(); });
  nav.append(prev, el('span', '', `${itemAt + 1} of ${n}`), next, el('span', 'lm-gap'), all);
  const open = el('div', 'lm-review__item');
  const head = el('h2', '', it.title || it.id);
  if (v) head.append(el('span', 'lm-review__badge' + (v.decision ? ' is-' + v.decision : ''), badgeOf(v)));
  open.append(head);
  if (it.text) open.append(el('p', '', it.text));
  // Where to judge it from, and the race through the stop that is lit.
  const its = it.stops || [];
  if (its.length) {
    const stops = el('div', 'lm-review__stops seg');
    const tracks = new Set(its.map((st) => st.track)).size > 1;
    its.forEach((st, k) => {
      const b = el('button', 'ctrl' + (k === stopAt ? ' is-on' : ''), stopLabel(st, tracks));
      b.addEventListener('click', () => { goStop(k); frame.focus(); });
      stops.append(b);
    });
    const go = el('button', 'ctrl', '▶ Drive past');
    go.dataset.go = 'past';
    go.title = 'The race through this stop, on a loop (P)';
    go.disabled = !!its[stopAt] && its[stopAt].step != null;   // a race moment is one already
    go.addEventListener('click', () => { drivePast(); frame.focus(); });
    stops.append(go);
    open.append(el('h3', '', 'Look'), stops);
  }
  // Each question gets its own answer, saved with the verdict (or alone:
  // an idea or a question needs no Keep / Rework / Drop).
  const asks = it.ask || [];
  const answers = answersOf(it);
  if (asks.length) open.append(el('h3', '', asks.length > 1 ? 'Questions' : 'Question'));
  asks.forEach((q, k) => {
    const a = el('textarea', 'lm-review__answer');
    a.rows = 2;
    a.placeholder = 'Your answer';
    a.setAttribute('aria-label', q);
    a.value = answers[k] || '';
    a.addEventListener('input', () => { answers[k] = a.value; answerDrafts.set(it.id, answers); keepDrafts(); });
    open.append(el('p', 'lm-review__ask', q), a);
  });
  const say = el('div', 'lm-review__say seg');
  for (const d of DECISIONS) {
    const b = el('button', 'ctrl' + (v && v.decision === d ? ' is-on' : ''), upper(d));
    b.dataset.decision = d;
    b.addEventListener('click', () => { judge(d); frame.focus(); });
    say.append(b);
  }
  const note = el('textarea', 'lm-review__note');
  note.rows = 4;
  note.placeholder = 'Why? What should change?';
  note.value = drafts.has(it.id) ? drafts.get(it.id) : v ? v.note : '';
  note.addEventListener('input', () => { drafts.set(it.id, note.value); keepDrafts(); });
  // A note edited after the verdict is saved with it again.
  note.addEventListener('change', () => { if (round.verdicts[it.id]) judge(round.verdicts[it.id].decision); });
  open.append(el('h3', '', 'Verdict'), note, say);
  if (asks.length) {
    const b = el('button', 'ctrl', 'Save answers');
    b.addEventListener('click', () => judge(v ? v.decision : null));
    open.append(b);
  }
  const unsaved = drafts.has(it.id) || answerDrafts.has(it.id);
  open.append(el('p', 'legend__note', reviewSaid || (unsaved ? 'Draft kept in this browser; a verdict saves it.' : '')));
  reviewBox.replaceChildren(nav, open);
}
function pickItem(i) {
  if (!round || !round.items.length) return;
  itemAt = i;
  stopAt = -1;
  listOpen = false;
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
  if (st.track && st.track !== state.track) await setTrack(st.track);
  if (st.step != null) {
    setView('race');
    lm.pause(true);
    lm.seek(st.step);
    if (st.cam) lm.raceCam(st.cam, st);
    paintRace();
  } else if (st.s != null) {
    lm.park(st.s, st.lat || 0);
    state.view = 'driver';
    save();
    paintButtons();
    paintRace();
  } else if (st.piece) {
    const i = lm.landmarks().findIndex((m) => base(m.model) === st.piece || base(m.model) === 'set-' + st.piece);
    if (i >= 0) { lm.focus(i); lm.place(st.place || 0); }
    setView(st.view || 'orbit');
  }
  paintList();
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
      keepDrafts();
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
  else if (k === 'p') drivePast();
  else if (k === '?') setHelp(!state.help);
  else if (k === 'm') stepSpeed(e.shiftKey ? -1 : 1);
  else if (race && k === 'c') stepCam(e.shiftKey ? -1 : 1);
  else if (race && (k === 'ArrowLeft' || k === 'ArrowRight')) seekBy((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 2));
  else if (race && (k === ',' || k === '.')) frameStep(k === ',' ? -1 : 1);
  else if (k === '[' || k === ']') stepItem(k === '[' ? -1 : 1);
  else if (k === 'f') toggleFull();
  else if (k === 'h' && document.fullscreenElement) legend.hidden = !legend.hidden;
  else if (k === 'n') openNote();
  else if (k === 'v') { state.sound = !state.sound; save(); syncSound(); }
  else if (k === 'b') setCompare(!state.compare);
  else return;
  e.preventDefault();
}
function onKeyUp(e) {
  if (!typing(e.target) && camKey(e)) e.preventDefault();
}
window.addEventListener('keydown', onKey);
window.addEventListener('keyup', onKeyUp);

// The game's sound in the stage (?sfx=1): the race's voices and the track's
// song, at the shared volume, or silent with the Sound button off. The stage's
// AudioContext is unlocked from the viewer's own clicks and keys here.
function syncSound() {
  let a;
  try { a = frame.contentWindow.__audio; } catch (_) { return; }
  if (!a) return;
  if (state.sound && a.resume) a.resume();
  if (a.master) a.master.gain.value = state.sound ? storedVolume() : 0;
  const b = document.getElementById('lm-sound');
  b.textContent = state.sound ? 'Sound: on' : 'Sound: off';
  b.classList.toggle('active', state.sound);
}
document.getElementById('lm-sound').addEventListener('click', () => { state.sound = !state.sound; save(); syncSound(); });
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => syncSound(), true);

// COMPARE: the first stage in Full beside a second in Lite (the first built
// again in Full where it stood in Lite), or back to the one stage in the tier
// picked. Each stage is a whole renderer, so the GPU draws the scene twice.
const stagesBox = document.getElementById('lm-stages');
const boxB = document.getElementById('lm-stage-b-box');
function setCompare(on) {
  state.compare = on;
  camLead = 'a';
  wantFree = on;   // Compare opens on the free camera
  if (on) state.tab = 'diff';
  else if (state.tab === 'diff') state.tab = round ? 'review' : 'pieces';
  save();
  boxB.hidden = !on;
  stagesBox.classList.toggle('is-compare', on);
  paintButtons();
  paintTabs();
  lmB = null;
  diff = null;
  diffOf = null;
  if (on) {
    frameB.src = stageUrl('lite', false);
    whenReady(frameB, (h) => {
      lmB = h;
      h.timeScale(rate());
      const win = frameB.contentWindow;
      for (const ev of ['pointerdown', 'wheel', 'keydown']) win.addEventListener(ev, () => { camLead = 'b'; }, true);
      win.addEventListener('keydown', onKey);
      win.addEventListener('keyup', onKeyUp);
      drawDiff();
    },
              (e) => diffBox.replaceChildren(el('p', 'legend__note', `The lite stage did not build (${errText(e)}).`)));
  } else {
    nextLoad(frameB);   // abandons a load still waiting
    frameB.src = 'about:blank';
  }
  drawDiff();
  return retier();
}

// THE LITE STAGE FOLLOWS THE FIRST, every frame: the first's track and split
// (each a scene build here too, one at a time), then its moment (the stage's
// `follow`: the view, the race at the first's own updates, and the camera,
// every cell's look and parked car and the free camera's eye). So whatever
// moved the first (a button, a key, a drag in it, a review stop) moves both,
// and the two pictures differ by the tier. It takes the moment a frame late
// at most. What it cannot follow is the renderer's own clock: a set piece
// that moves, or the clouds, run on each stage's own since its build.
// THE CAMERA IS SHARED BOTH WAYS: the stage last dragged, scrolled or keyed
// in (`camLead`) leads the free camera, so either one flies both; a drag in
// the lite stage's view takes its free camera and the first stage's with it.
// The lite stage leads only when its camera MOVED since it was handed the
// first's (`handed`): a camera it merely holds must not keep the first in the
// free view a button or G has just left. The view and the race stay the
// first stage's.
let busyB = null;
let camLead = 'a';
let wantFree = false;
let handed = null;
const sameEye = (p, q) => !!p && !!q && p.yaw === q.yaw && p.pitch === q.pitch
  && p.eye.x === q.eye.x && p.eye.y === q.eye.y && p.eye.z === q.eye.z;
function toFree() {
  if (inRace()) {
    if (lm.race().cam !== 'free') { lm.raceCam('free'); paintRace(); }
  } else if (state.view !== 'free') {
    viewBeforeFree = state.view;
    setView('free');
  }
}
function followTick() {
  requestAnimationFrame(followTick);
  if (!state.compare || !lm || !lmB || busyB) return;
  const build = lmB.trackId() !== lm.trackId() ? lmB.track(lm.trackId())
    : lmB.seats() !== lm.seats() ? lmB.players(lm.seats()) : null;
  if (build) {
    busyB = build.catch(() => {}).then(() => { busyB = null; });
    return;
  }
  if (wantFree) { wantFree = false; toFree(); }
  const b = camLead === 'b' && lmB.moment().free;
  if (b && !sameEye(b, handed)) {
    if (!lm.moment().free) toFree();
    lm.freeAt(b);
  }
  const m = lm.moment();
  lmB.follow(m);
  handed = m.free;
  if (drawn === 'full' && (!diffOf || diffOf.a !== lm.layout() || diffOf.b !== lmB.layout())) paintDiff();
}
requestAnimationFrame(followTick);

// THE DIFFERENCES (Compare's tab): what the lite tier changes on this track,
// off the two stages' own answers. Per set piece: its placements in each
// stage's layout and the triangles of the file each draws (Lite's build where
// it has one), ranked by what Lite saves over every placement; a click frames
// it in both stages, at a placement Lite leaves out where it leaves one out.
// Then the scenery and props Lite swaps for a lite build (a stamp each: the
// scatter is not counted per model), the land it leaves out (tracks.js,
// `lite: false`), and what the renderer changes in Lite on every track, each
// with where in the code; native/renderer/CLAUDE.md, "The detail tier", is
// that list, and the order here is the one its comments' savings suggest.
const LITE_RENDERER = [
  ['Coarser tiles: the static scene in fewer, larger draws', 'TtpRendererTrack.cpp, buildStatic'],
  ['Small things leave a cell: a run of scatter or props, or a chunk of clutter, once it covers only a few pixels of that cell',
   'TtpRendererDressing.cpp, buildDressingMerge; TtpRendererFrame.cpp, chooseCuts'],
  ['Far forms swap in nearer: a looser gate with no haze term, simplified without holding each shade',
   'TtpRendererFrame.cpp, chooseLods; TtpRenderer.cpp, farForm'],
  ['A coarser sky dome: fewer rings and spokes', 'TtpRendererTrack.cpp, the sky dome'],
  ['Octagonal ground-shadow discs', 'TtpRendererTrack.cpp, the ground shadows'],
  ['Ground rock without its strata: a facet is plain rock, still shaded by its own normal', 'TtpRendererTrack.cpp, setRockParams'],
  ['Mesas without their pale seams', 'TtpRendererTrack.cpp, the mesa rings'],
  ['A moving set piece draws a part at a time, not as one skinned draw', 'TtpRendererMotion.cpp, THE SKIN'],
  ['No ambient life: a cup\'s petals or motes', 'ttp/theme.cc, resolve_theme']
];
let diff = null, diffOf = null, diffGen = 0;
async function paintDiff() {
  const a = lm.layout(), b = lmB.layout(), track = lm.trackId();
  diffOf = { a, b };
  const gen = ++diffGen;
  const at = (p) => `${base(p.model)} ${p.u} ${p.lat}`;
  const kept = new Map(b.pieces.map((p) => [at(p), p.model]));
  const by = new Map();   // model -> its placements in Full, the file Lite draws, those Lite leaves out
  a.pieces.forEach((p, i) => {
    const r = by.get(p.model) || { model: p.model, n: 0, as: null, out: [] };
    const as = kept.get(at(p));
    r.n++;
    if (as) r.as = as;
    else r.out.push(i);
    by.set(p.model, r);
  });
  const labels = new Map(lm.landmarks().map((m) => [m.model, m.label]));
  const { scenery, props } = lmB.models();
  const swaps = [...new Set([...scenery, ...props])].filter((m) => m !== base(m));
  const { TRACKS } = await tracksJs;
  const pieces = [];
  let full = 0, lite = 0, out = 0;
  for (const r of by.values()) {
    const f = await costOf(`${r.model}.glb`);
    if (!f) continue;
    const l = r.as ? (await costOf(`${r.as}.glb`)) || f : null;
    const saved = f.tris * r.n - (l ? l.tris * (r.n - r.out.length) : 0);
    full += f.tris * r.n;
    lite += l ? l.tris * (r.n - r.out.length) : 0;
    out += r.out.length;
    if (saved > 0 || r.out.length) {
      pieces.push({ model: r.model, label: labels.get(r.model) || r.model, n: r.n, out: r.out, saved,
                    full: f.tris, lite: r.as && r.as !== r.model && l ? l.tris : null });
    }
  }
  pieces.sort((x, y) => y.saved - x.saved);
  const stamps = [];
  for (const m of swaps) {
    const f = await costOf(`${base(m)}.glb`), l = await costOf(`${m}.glb`);
    if (f && l) stamps.push({ model: base(m), full: f.tris, lite: l.tris });
  }
  stamps.sort((x, y) => (y.full - y.lite) - (x.full - x.lite));
  const land = ((TRACKS[track] && TRACKS[track].land) || []).filter((l) => l.lite === false);
  if (gen !== diffGen) return;
  diff = { track, pieces, full, lite, out, placed: a.pieces.length, stamps, land };
  drawDiff();
}
function drawDiff() {
  if (!state.compare) { diffBox.replaceChildren(); return; }
  if (!lm || !diff || diff.track !== lm.trackId()) {
    diffBox.replaceChildren(el('p', 'legend__note', lmB ? 'Reading the two tiers…' : 'Building the lite stage…'));
    return;
  }
  const d = diff;
  const minus = (n) => '−' + kilo(n);
  const row = (tag, name, what, saved) => {
    const r = el(tag, 'kit-row lm-diff__row');
    r.append(el('span', 'kit-row__name', name), el('span', 'kit-row__tris', what),
             el('span', 'kit-row__tris lm-diff__saved', saved));
    return r;
  };
  const share = d.full ? Math.round(100 * (d.full - d.lite) / d.full) : 0;
  const out = [el('h2', '', 'What Lite changes here'),
               el('p', 'legend__note', `Set pieces: ${kilo(d.full)} tris in Full, ${kilo(d.lite)} in Lite (−${share}%) · `
                 + `${d.out} of ${d.placed} placed left out`),
               el('h3', '', 'Set pieces')];
  if (!d.pieces.length) out.push(el('p', 'legend__note', 'Lite draws every piece as Full does.'));
  const m = lm.landmarks()[lm.focused()];
  for (const p of d.pieces) {
    const what = p.out.length === p.n ? `left out ×${p.n}`
      : [p.lite != null ? `${kilo(p.full)} → ${kilo(p.lite)} ×${p.n}` : '',
         p.out.length ? `${p.out.length} of ${p.n} left out` : ''].filter(Boolean).join(', ');
    const r = row('button', p.label, what, minus(p.saved));
    if (m && m.model === p.model) r.classList.add('kit-row--at');
    r.title = `${p.model}: frame it in both stages (orbit)`;
    r.addEventListener('click', () => { frameDiff(p); frame.focus(); });
    out.push(r);
  }
  if (d.stamps.length) {
    out.push(el('h3', '', 'Scenery and props, a stamp each'));
    for (const s of d.stamps) out.push(row('div', s.model, `${kilo(s.full)} → ${kilo(s.lite)}`, minus(s.full - s.lite)));
  }
  if (d.land.length) {
    const kinds = new Map();
    for (const l of d.land) kinds.set(l.kind, (kinds.get(l.kind) || 0) + 1);
    out.push(el('h3', '', 'Land'),
             el('p', 'lm-diff__all', `${d.land.length} landform${d.land.length === 1 ? '' : 's'} left out: `
               + [...kinds].map(([k, n]) => `${k} ×${n}`).join(', ')));
  }
  out.push(el('h3', '', 'On every track (the renderer)'));
  const ul = el('ul', 'lm-diff__all');
  for (const [text, where] of LITE_RENDERER) {
    const li = el('li', '', text);
    li.title = where;
    ul.append(li);
  }
  out.push(ul, el('p', 'legend__note', 'Pieces are ranked by the triangles Lite saves over every placement. '
    + 'Hover a renderer line for where it is in the code.'));
  diffBox.replaceChildren(...out);
}
// A Differences row: its piece in both stages, at the first placement Lite
// leaves out where it leaves one out; in the orbit view, or under the free
// camera where that is on (it moves over the piece and stays free).
async function frameDiff(p) {
  if (!lm) return;
  if (state.view !== 'free' && !(inRace() && lm.race().cam === 'free')) await pickView('orbit');
  const i = lm.landmarks().findIndex((m) => m.model === p.model);
  if (i < 0) return;
  lm.focus(i);
  if (p.out.length) lm.place(lm.landmarks()[i].indices.indexOf(p.out[0]));
  leaveStop();
  paintList();
}

function init(h) {
  lm = h;
  syncSound();
  // A click in the stage builds its audio bus at full volume (main.js's own
  // window listener, registered first), so the level is set again after it.
  for (const ev of ['pointerdown', 'keydown']) frame.contentWindow.addEventListener(ev, () => syncSound());
  frame.contentWindow.addEventListener('keydown', onKey);
  for (const ev of ['pointerdown', 'wheel', 'keydown']) frame.contentWindow.addEventListener(ev, () => { camLead = 'a'; }, true);
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
  lm.timeScale(rate());
  restoreView();
  // A link's piece, once: the model it names and which of its placements.
  const i = wantPiece ? lm.landmarks().findIndex((m) => base(m.model) === 'set-' + wantPiece) : -1;
  if (i >= 0) { lm.focus(i); lm.place(wantPlace); }
  wantPiece = null;
  seen = null;
  // Compare turned on or off while the stage was loading wants the other tier.
  drawn = frame.contentWindow.__scene.detail;
  if (drawn !== tier()) retier();
  else rebuild(() => {});
  paintReview();   // its stops name tracks, which have names now
}

paintButtons();
paintTabs();
Gallery.initMobileOptionsToggle();
load();
if (state.compare) setCompare(true);
