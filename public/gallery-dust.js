// The dust off each cup's road strip, side by side: one framed display per
// biome on the strip oval (shared/devTracks.js `strip`), a few cars in its one
// view, each holding a lane of its own (the strip showcase, ttp_runtime.cc), and
// the strip tuner's controls under it (display/stripTuner.js). The page's hash
// carries the cars, where they drive (as monster trucks or not), the dust's
// spread, the camera, the detail tier, the hidden cups and every changed
// value, so a reload keeps the session.
import { BIOMES, stripControls, stripQuery } from '/display/stripTuner.js';

const saved = new URLSearchParams(location.hash.slice(1));
let cars = saved.get('cars') || '3';
let mode = saved.get('mode') || 'strip-on';
let monster = saved.get('monster') === '1';   // the field drives as monster trucks
// The showcase kind every display runs (ttp_item_showcase).
const kind = () => mode + (monster ? '+monster' : '');
let cam = saved.get('cam') || 'chase';
// How far a turn or a slide throws the dust outward (the renderer's kDustDrift
// knob, the same in every biome); empty keeps the authored value.
let spread = saved.get('spread') || '';
const DRIFT = 7;   // its index in ttp_display_debug_sand_dust
// The detail tier the displays draw (?detail=): the lite tier's dust is its
// own (TtpRenderer.h, kSandPuffs). Empty keeps the tier they draw unasked.
let detail = saved.get('detail') || '';
// Snow's and Playroom's strips throw no dust (theme.cc), so they start hidden;
// the tuner's dust switch turns theirs on.
const hidden = new Set(saved.has('hide') ? saved.get('hide').split(',').filter(Boolean) : ['snow', 'playroom']);
const values = new Map(BIOMES.map(([biome]) => [biome, saved.get(biome) || '']));   // each cup's changed values
const frames = [];   // [biome, iframe]

const save = () => {
  const h = new URLSearchParams({ cars, mode, cam, hide: [...hidden].join(',') });
  if (spread) h.set('spread', spread);
  if (monster) h.set('monster', '1');
  if (detail) h.set('detail', detail);
  for (const [biome, q] of values) if (q) h.set(biome, q);
  history.replaceState(null, '', '#' + h);
};

// One player (the camera's car) and the rest CPU fill, on the race scenario.
const src = (biome) => '/?' + new URLSearchParams({ test: '1', scenario: 'racing', track: 'strip', biome,
  players: '1', bots: String(cars - 1), seed: '1', showcase: kind(), laps: '999', hud: '0' })
  + (detail ? '&detail=' + detail : '') + (values.get(biome) ? '&' + values.get(biome) : '');

// The camera: the first car's chase cell, or the lobby's, which draws no cells
// and cuts between the race's battles and chases (Stage._syncCells, CAM.COVERAGE).
const aim = (win) => {
  const scene = win.__scene;
  if (!scene) return;
  scene.soloCam = scene.coverage = cam === 'lobby';
};
const spreadInput = document.getElementById('spread'), spreadVal = document.getElementById('spread-val');
const paintSpread = (v) => { spreadInput.value = v; spreadVal.textContent = Number(v).toFixed(2); };
// Pushes the page's spread to a display; with none set, shows the authored one.
const throwOut = (win) => {
  const display = win.__scene?.display;
  if (!display) return;
  const authored = display.debugSandDust(DRIFT, -1);
  if (spread) display.debugSandDust(DRIFT, Number(spread));
  else paintSpread(authored);
};
if (spread) paintSpread(spread);

const cells = document.getElementById('cells');
const show = document.getElementById('show');
for (const [biome, label] of BIOMES) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const title = document.createElement('h2');
  title.textContent = label;
  const frame = document.createElement('iframe');
  const controls = document.createElement('div');
  controls.className = 'controls';
  // Every load of the display (the first, a reset's, a change of cars) gets
  // fresh controls; the empty frame's own load is not one.
  frame.addEventListener('load', () => {
    if (!frame.src) return;
    const win = frame.contentWindow;
    const note = () => { values.set(biome, stripQuery(win)); save(); };
    controls.replaceChildren(stripControls(win, () => win.__scene, note));
    note();
    // A framed preview holds its first frame for the gallery's sake
    // (TestHarness holdFrame): set it running in the page's mode (a reset
    // reloads the one it was opened in), and drop the corner buttons, which
    // are sized for a television.
    const wait = setInterval(() => {
      if (!win.__preview) return;
      clearInterval(wait);
      win.__preview.play();
      win.__showcase(kind());
      aim(win);
      throwOut(win);
      paintDetail(win.__scene.detail);
      win.document.getElementById('corner-btns').style.display = 'none';
    }, 200);
  });
  // A hidden cup takes no room and loads nothing until it is first shown.
  const toggle = document.createElement('button');
  toggle.textContent = label;
  const lay = () => {
    const on = !hidden.has(biome);
    toggle.classList.toggle('on', on);
    cell.hidden = !on;
    if (on && !frame.src) frame.src = src(biome);
  };
  toggle.addEventListener('click', () => {
    if (!hidden.delete(biome)) hidden.add(biome);
    lay();
    frame.contentWindow.__showcase?.(kind());   // the mode may have changed while it was hidden
    save();
  });
  show.append(toggle);
  frames.push([biome, frame]);
  cell.append(title, frame, controls);
  cells.append(cell);
  lay();
}

// A row of buttons that picks one value; `pick` hears the new one. Answers
// its painter, which lights the button of the value it is given.
function choice(attr, get, pick) {
  const buttons = [...document.querySelectorAll(`[data-${attr}]`)];
  const paint = (now = get()) => buttons.forEach((b) => b.classList.toggle('on', b.dataset[attr] === now));
  for (const b of buttons) b.addEventListener('click', () => { pick(b.dataset[attr]); paint(); save(); });
  paint();
  return paint;
}
// Where the cars drive: the strip showcase's three modes, switched live.
choice('mode', () => mode, (m) => {
  mode = m;
  for (const [, frame] of frames) frame.contentWindow.__showcase?.(kind());
});
const monsterBtn = document.getElementById('monster');
monsterBtn.classList.toggle('on', monster);
monsterBtn.addEventListener('click', () => {
  monster = !monster;
  monsterBtn.classList.toggle('on', monster);
  for (const [, frame] of frames) frame.contentWindow.__showcase?.(kind());
  save();
});
spreadInput.addEventListener('input', () => {
  spread = spreadInput.value;
  paintSpread(spread);
  for (const [, frame] of frames) if (frame.src) throwOut(frame.contentWindow);
  save();
});
choice('cam', () => cam, (c) => {
  cam = c;
  for (const [, frame] of frames) if (frame.src) aim(frame.contentWindow);
});
// How many: a new field, so every display that has loaded races again.
choice('cars', () => cars, (n) => {
  if (n === cars) return;
  cars = n;
  for (const [biome, frame] of frames) if (frame.src) frame.src = src(biome);
});
// The tier: another world, so every display that has loaded builds again.
// With none asked for, the button lit is the tier a display says it draws.
const paintDetail = choice('detail', () => detail, (d) => {
  if (d === detail) return;
  detail = d;
  for (const [biome, frame] of frames) if (frame.src) frame.src = src(biome);
});
save();

document.getElementById('copy').addEventListener('click', () => {
  const text = [...values].filter(([, q]) => q).map(([biome, q]) => `${biome}: ${q}`).join('\n');
  navigator.clipboard.writeText(text || 'nothing changed');
});
