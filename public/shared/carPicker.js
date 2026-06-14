// Car picker UI — the controller's "pick your ride" layout, shared by the live
// controller (controller/main.js) and its gallery preview (TestHarness) so the
// two can't drift. Two parts:
//   • a big HERO preview of the SELECTED car — a spinning render, its name, and
//     handling stat bars (so only the chosen car's stats are shown, not all at
//     once);
//   • a compact STRIP of every model as a small still thumbnail you tap to pick.
// Styling lives in controller.css (.car-hero / .carpick / .car-opt).

import { carThumbNode } from './carThumbs.js';

const MODELS = (typeof window !== 'undefined' && window.CAR_MODELS) || [];
const NAMES = (typeof window !== 'undefined' && window.CAR_NAMES) || [];
const carName = (i) => NAMES[i] || ('Car ' + (i + 1));

// Stat bars read in the player's livery. Each bar is normalised across the WHOLE
// roster — the engine stats are multipliers/weights with awkward absolute ranges,
// so the roster-lowest car shows a HALF bar and the highest a full bar. Every row
// is "more = more" (a full Weight bar = heaviest) so they read consistently. The
// domain comes from CAR_STATS, not hardcoded, so retuning the table reshapes the
// bars automatically. The floor sits at 50% (not 0) on purpose: every car should
// look capable at everything, with differences shown as the top half of the bar —
// no stat ever reads as empty/"broken", however wide or narrow the real spread is.
const STAT_BAR_FLOOR = 0.50;
const STAT_ROWS = [
  { lab: 'Speed', key: 'vmax' },
  { lab: 'Accel', key: 'accel' },
  { lab: 'Handling', key: 'turn' }, // turn drives both yaw rate and cornering grip (see protocol.CAR_STATS)
  { lab: 'Weight', key: 'mass' }
];
function statDomain() {
  const stats = (typeof window !== 'undefined' && window.CAR_STATS) || [];
  return STAT_ROWS.map(({ key }) => {
    const vals = stats.map((s) => s[key]);
    if (!vals.length) return { lo: 0, span: 1 };
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return { lo, span: (hi - lo) || 1 };
  });
}
function statBarsNode(carIndex) {
  const resolve = (typeof window !== 'undefined' && window.carStats) || null;
  const wrap = document.createElement('div');
  wrap.className = 'car-opt__stats';
  const st = resolve ? resolve(carIndex) : null;
  if (!st) return wrap;
  const dom = statDomain();
  STAT_ROWS.forEach((row, k) => {
    const d = dom[k];
    // STAT_BAR_FLOOR..100%: the weakest stat still reads as half-full, not empty.
    const pct = Math.round((STAT_BAR_FLOOR + (1 - STAT_BAR_FLOOR) * ((st[row.key] - d.lo) / d.span)) * 100);
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
// calls onPick(i). Either element may be omitted.
export function buildCarPicker({ heroEl, stripEl, selected, onPick }) {
  const count = MODELS.length || 4;
  const sel = Math.max(0, Math.min(selected | 0, count - 1));

  if (heroEl) {
    heroEl.innerHTML = '';
    const view = document.createElement('div'); view.className = 'car-hero__view';
    view.appendChild(carThumbNode(MODELS[sel], { spin: true })); // only the chosen car spins
    const info = document.createElement('div'); info.className = 'car-hero__info';
    const nm = document.createElement('div'); nm.className = 'car-hero__name'; nm.textContent = carName(sel);
    info.appendChild(nm);
    info.appendChild(statBarsNode(sel));
    heroEl.appendChild(view); heroEl.appendChild(info);
  }

  if (stripEl) {
    stripEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const mine = i === sel;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'car-opt' + (mine ? ' car-opt--mine' : '');
      if (mine) btn.setAttribute('aria-current', 'true');
      btn.setAttribute('aria-label', carName(i));
      btn.appendChild(carThumbNode(MODELS[i], { spin: false })); // strip tiles are stills (cheap; hero draws the eye)
      if (onPick) btn.addEventListener('click', () => onPick(i));
      stripEl.appendChild(btn);
    }
  }
}
