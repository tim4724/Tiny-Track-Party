// Car picker UI — the controller's "pick your ride" layout, shared by the live
// controller (controller/main.js) and its gallery preview (TestHarness) so the
// two can't drift. Two parts:
//   • a big HERO preview of the SELECTED car — a spinning render, its name, and
//     handling stat bars (so only the chosen car's stats are shown, not all at
//     once);
//   • a compact STRIP of every model as a small still thumbnail you tap to pick.
// Styling lives in controller.css (.car-hero / .carpick / .car-opt).
//
// Content is passed in as `cars: [{ id, name, stats }]` — the live controller
// feeds it straight from the relay's room snapshot (so the phone bundles no car
// data of its own), and the gallery falls back to the window globals. Thumbnails
// load by id from the web host (carThumbs.js), never over the relay.

import { carThumbNode } from './carThumbs.js';

// Resolve the car list from the window globals (gallery / no-snapshot fallback).
function carsFromWindow() {
  const models = (typeof window !== 'undefined' && window.CAR_MODELS) || [];
  const names = (typeof window !== 'undefined' && window.CAR_NAMES) || [];
  const resolve = (typeof window !== 'undefined' && window.carStats) || null;
  return models.map((id, i) => ({ id, name: names[i] || ('Car ' + (i + 1)), stats: resolve ? resolve(i) : {} }));
}

// Stat bars read in the player's livery. Each bar is normalised across the WHOLE
// roster — the engine stats are multipliers/weights with awkward absolute ranges,
// so the roster-lowest car shows a 2/3 bar and the highest a full bar. Every row
// is "more = more" (a full Weight bar = heaviest) so they read consistently. The
// floor sits high (66%, not 0) on purpose: these are all hero cars — every one
// should read as genuinely capable at everything, with the real spread shown as
// the top third of the bar, never as an empty/"broken" stat.
const STAT_BAR_FLOOR = 0.66;
const STAT_ROWS = [
  { lab: 'Speed', key: 'vmax' },
  { lab: 'Accel', key: 'accel' },
  { lab: 'Handling', key: 'turn' }, // turn drives both yaw rate and cornering grip (see protocol.CAR_STATS)
  { lab: 'Weight', key: 'mass' }
];
function statDomain(cars) {
  return STAT_ROWS.map(({ key }) => {
    const vals = cars.map((c) => c.stats && c.stats[key]).filter((v) => v != null);
    if (!vals.length) return { lo: 0, span: 1 };
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return { lo, span: (hi - lo) || 1 };
  });
}
function statBarsNode(stats, dom) {
  const wrap = document.createElement('div');
  wrap.className = 'car-opt__stats';
  if (!stats) return wrap;
  STAT_ROWS.forEach((row, k) => {
    const d = dom[k];
    // STAT_BAR_FLOOR..100%: the weakest stat still reads as half-full, not empty.
    const pct = Math.round((STAT_BAR_FLOOR + (1 - STAT_BAR_FLOOR) * (((stats[row.key] || d.lo) - d.lo) / d.span)) * 100);
    const r = document.createElement('div'); r.className = 'stat';
    const lab = document.createElement('span'); lab.className = 'stat__lab'; lab.textContent = row.lab;
    const bar = document.createElement('span'); bar.className = 'stat__bar';
    const fill = document.createElement('i'); fill.style.width = pct + '%';
    bar.appendChild(fill); r.appendChild(lab); r.appendChild(bar);
    wrap.appendChild(r);
  });
  return wrap;
}

// Render the picker into the given elements. heroEl gets the big selected-car
// preview + stats; stripEl gets the tap-to-pick thumbnails. Tapping a strip tile
// calls onPick(i). Either element may be omitted. `canPick: false` renders the
// strip read-only (tiles disabled) — a READY player's car is locked until they
// un-ready, mirroring the trackPicker's gate. `cars` is the display-authoritative
// roster; omit to fall back to the window globals (gallery).
export function buildCarPicker({ heroEl, stripEl, selected, onPick, canPick = true, cars }) {
  const list = (cars && cars.length) ? cars : carsFromWindow();
  const count = list.length || 4;
  const sel = Math.max(0, Math.min(selected | 0, count - 1));
  const dom = statDomain(list);
  const nameOf = (i) => (list[i] && list[i].name) || ('Car ' + (i + 1));
  const idOf = (i) => list[i] && list[i].id;

  if (heroEl) {
    heroEl.innerHTML = '';
    const view = document.createElement('div'); view.className = 'car-hero__view';
    view.appendChild(carThumbNode(idOf(sel), { spin: true })); // only the chosen car spins
    const info = document.createElement('div'); info.className = 'car-hero__info';
    const nm = document.createElement('div'); nm.className = 'car-hero__name'; nm.textContent = nameOf(sel);
    info.appendChild(nm);
    info.appendChild(statBarsNode(list[sel] && list[sel].stats, dom));
    heroEl.appendChild(view); heroEl.appendChild(info);
  }

  if (stripEl) {
    stripEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const mine = i === sel;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'car-opt' + (mine ? ' car-opt--mine' : '');
      btn.disabled = !canPick;
      if (mine) btn.setAttribute('aria-current', 'true');
      btn.setAttribute('aria-label', nameOf(i));
      btn.appendChild(carThumbNode(idOf(i), { spin: false })); // strip tiles are stills (cheap; hero draws the eye)
      if (canPick && onPick) btn.addEventListener('click', () => onPick(i));
      stripEl.appendChild(btn);
    }
  }
}
