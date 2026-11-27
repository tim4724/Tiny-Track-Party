// TEMPORARY: controls for tuning the road strip of a cup, live. Each sets one
// of the renderer's strip overrides (TtpRenderer::debugSandDust, kStripStep
// on) and rebuilds the scene; the values also land in that display's URL, so
// a reload keeps them and the URL is what to hand back for writing into
// theme.cc. Two homes: an overlay on the display itself (?striptune=1), and
// /strip-compare.html, which lays one set under each of five framed displays.
// Delete with the overrides once the strips are settled.
import { CUPS } from '../shared/tracks.js';

const FIRST = 13; // kStripStep
// [url key, label, kind, min, max, step]; lengths are metres in the engine, cm here.
const KNOBS = [
  ['stripstep', 'Step height (cm)', 'cm', -10, 10, 0.5],
  ['striprut', 'Tyre mark strength', 'num', 0, 5, 0.1],
  ['stripdust', 'Dust cloud', 'bool'],
  ['stripslope', 'Cross slope (cm)', 'cm', 0, 30, 1],
  ['stripsink', 'Tyre sink (cm)', 'cm', 0, 10, 0.5],
  ['stripcolor', 'Strip colour', 'color'],
  ['striprutcolor', 'Tyre mark colour', 'color'],
  ['stripedge', 'Edge band colour', 'color'],
  ['stripshade', 'Slope shade strength', 'num', 0, 12, 0.5],
  // the cup's dust as multiples of the renderer's authored cloud (theme.road.dust)
  ['stripdustrate', 'Dust amount (x)', 'num', 0, 3, 0.1],
  ['stripdustlife', 'Dust duration (x)', 'num', 0, 3, 0.1],
  ['stripduststart', 'Dust puff size at start (x)', 'num', 0, 3, 0.1],
  ['stripdustend', 'Dust puff size at end (x)', 'num', 0, 3, 0.1],
  ['stripdustrise', 'Dust rise (x)', 'num', 0, 3, 0.1],
  // shown as the mix itself: theme.road.dust[5] is twice this over 100
  ['stripdustwhite', 'Dust tint (%): -100 black, 0 strip colour, 100 white', 'pct', -100, 100, 5],
  ['stripdustalpha', 'Dust opacity (x)', 'num', 0, 2, 0.1],
  // the body's spring over the step: the car's, not the cup's (one value for all)
  ['stripspringk', 'Body spring stiffness (higher = faster bounce)', 'num', 100, 800, 20],
  ['stripspringd', 'Body spring damping (lower = bouncier)', 'num', 2, 40, 1],
];
// [biome, label, the cup that wears it]
export const BIOMES = [['beach', 'Beach', 'beach'], ['snow', 'Snow', 'snow'], ['grass', 'Backyard', 'backyard'],
  ['canyon', 'Canyon', 'canyon'], ['playroom', 'Playroom', 'rooftop']];
// The one knob that is the SIM's: how much the strip slows a car, in percent
// (CUPS' stripSpeed, set live through window.__stripSpeed). The tuned oval is
// in no cup, so it takes the slow-down of the cup whose biome it is dressed in.
const SLOW = 'stripslow';
const KEYS = [...KNOBS.map(([key]) => key), SLOW];

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  Object.assign(n.style, style);
  if (text != null) n.textContent = text;
  return n;
};
const hex = (n) => Math.round(n).toString(16).padStart(6, '0');

// The strip values a display's URL carries, as a query string.
export const stripQuery = (win) => win.location.search.slice(1).split('&')
  .filter((p) => KEYS.some((key) => p.startsWith(key + '='))).join('&');

// The controls for the display in `win` (its URL, its `getScene()`), as one
// element of rows. `onChange` hears every edit.
export function stripControls(win, getScene, onChange = () => {}) {
  const body = el('div', {});
  let timer = 0;
  const note = (key, urlValue) => {
    const u = new URL(win.location.href);
    u.searchParams.set(key, urlValue);
    win.history.replaceState(null, '', u);
    out.value = stripQuery(win);
    onChange();
  };
  const set = (i, key, engineValue, urlValue) => {
    const scene = getScene();
    scene.display.debugSandDust(FIRST + i, engineValue);
    note(key, urlValue);
    clearTimeout(timer);
    timer = setTimeout(() => { scene._sceneSig = null; scene._rebuild(); }, 120);
  };

  const refresh = []; // one per knob: show the built scene's value
  KNOBS.forEach(([key, label, kind, min, max, step], i) => {
    const row = el('label', { display: 'block', margin: '0.5em 0' });
    const top = el('div', { display: 'flex', justifyContent: 'space-between' });
    const readout = el('span', { fontVariantNumeric: 'tabular-nums' });
    top.append(el('span', {}, label), readout);
    const input = el('input', { width: '100%', height: kind === 'color' ? '2.2em' : '1.8em', margin: 0 });
    if (kind === 'bool') {
      input.type = 'checkbox';
      Object.assign(input.style, { width: '1.5em', height: '1.5em' });
      input.addEventListener('change', () => set(i, key, input.checked ? 1 : 0, input.checked ? '1' : '0'));
      refresh.push((v) => { input.checked = v > 0.5; });
      top.append(input);
      row.append(top);
    } else if (kind === 'color') {
      input.type = 'color';
      input.addEventListener('input', () => {
        readout.textContent = input.value;
        set(i, key, parseInt(input.value.slice(1), 16), input.value.slice(1));
      });
      refresh.push((v) => { input.value = '#' + hex(v); readout.textContent = input.value; });
      row.append(top, input);
    } else {
      const k = kind === 'cm' ? 100 : kind === 'pct' ? 50 : 1;
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.addEventListener('input', () => {
        readout.textContent = (+input.value).toFixed(1);
        set(i, key, +input.value / k, input.value);
      });
      refresh.push((v) => { input.value = v * k; readout.textContent = (v * k).toFixed(1); });
      row.append(top, input);
    }
    body.append(row);
  });

  // The slow-down: no rebuild, the next frame drives with it.
  const params = new URLSearchParams(win.location.search);
  const cup = CUPS.find((c) => c.id === (BIOMES.find(([b]) => b === params.get('biome')) || [])[2]);
  const slowRow = el('label', { display: 'block', margin: '0.5em 0' });
  const slowTop = el('div', { display: 'flex', justifyContent: 'space-between' });
  const slowOut = el('span', { fontVariantNumeric: 'tabular-nums' });
  slowTop.append(el('span', {}, 'Slow-down on the strip (%)'), slowOut);
  const slow = el('input', { width: '100%', height: '1.8em', margin: 0 });
  slow.type = 'range';
  slow.min = 0; slow.max = 60; slow.step = 5;
  slow.value = params.get(SLOW) ?? (cup ? Math.round((1 - cup.stripSpeed) * 100) : 25);
  const drive = () => { slowOut.textContent = slow.value; win.__stripSpeed?.(1 - slow.value / 100); };
  slow.addEventListener('input', () => { drive(); note(SLOW, slow.value); });
  slowRow.append(slowTop, slow);
  body.append(slowRow);

  const out = el('input', { width: '100%', font: '0.8em ui-monospace, monospace', marginTop: '0.4em', boxSizing: 'border-box' });
  out.readOnly = true;
  out.placeholder = 'changed values appear here';
  out.value = stripQuery(win);
  out.addEventListener('focus', () => out.select());
  const reset = el('button', { marginTop: '0.5em', padding: '0.35em 0.8em', font: 'inherit', cursor: 'pointer' },
    'Reset to the cup\'s');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    const u = new URL(win.location.href);
    KEYS.forEach((key) => u.searchParams.delete(key));
    win.location.href = u.href;
  });
  body.append(out, reset);

  // The controls show what the scene was BUILT with (NaN = ask, set nothing),
  // which exists once the first build has finished.
  const wait = setInterval(() => {
    const scene = getScene();
    if (!scene || !scene.display || !scene.display.built) return;
    clearInterval(wait);
    refresh.forEach((show, i) => show(scene.display.debugSandDust(FIRST + i, NaN)));
    drive();
  }, 200);
  return body;
}

// ?striptune=1: the controls as an always-on overlay on this display, with a
// row of buttons to change the cup.
export function initStripTuner(scene) {
  const box = el('div', {
    position: 'fixed', top: '5rem', right: '1rem', zIndex: 70, width: '26rem', maxWidth: 'calc(100vw - 2rem)',
    padding: '1rem 1.2rem', borderRadius: '1rem', background: 'rgba(255,255,255,0.94)', color: '#1c2333',
    font: '600 1.05rem/1.3 system-ui, sans-serif',
  });
  const head = el('div', { display: 'flex', justifyContent: 'space-between', cursor: 'pointer', fontSize: '1.2rem' },
    'Road strip');
  const body = el('div', { marginTop: '0.6rem' });
  body.hidden = window.innerWidth < 900;
  head.addEventListener('click', () => { body.hidden = !body.hidden; });
  box.append(head, body);

  // The cup on screen: a reload under ?biome=, without the last cup's overrides.
  const biomes = el('div', { display: 'flex', gap: '0.3rem', marginBottom: '0.6rem' });
  const now = new URLSearchParams(location.search).get('biome');
  for (const [biome, label] of BIOMES) {
    const b = el('button', { flex: 1, padding: '0.45rem 0', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer',
      borderRadius: '0.5rem', border: '2px solid #1c2333',
      background: biome === now ? '#1c2333' : '#fff', color: biome === now ? '#fff' : '#1c2333' }, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      const u = new URL(location.href);
      KEYS.forEach((key) => u.searchParams.delete(key));
      u.searchParams.set('biome', biome);
      location.href = u.href;
    });
    biomes.append(b);
  }
  body.append(biomes, stripControls(window, () => scene));
  document.body.append(box);
}
