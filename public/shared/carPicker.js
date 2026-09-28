// Car picker UI — the controller's "pick your ride" layout, shared by the live
// controller (controller/main.js) and its gallery preview (TestHarness) so the
// two can't drift. ONE grid: every car is a tile carrying its render, its name
// and its four stat ratings, each named in its own row. Tap one. Styling lives
// in controller.css (.carpick / .car-opt).
//
// It used to be a HERO card — one big spinning render of the SELECTED car with
// its stats beside it — over a strip of small stills. That shape came from the
// two-column lobby and cost the page half its width to show four thumbnails and
// then a fifth, bigger copy of one of them. Worse, it could only ever show ONE
// car's stats, so choosing between four cars meant tapping through all four and
// holding the ratings in your head. They exist to be COMPARED, and the grid is
// the first layout on this phone that lets you compare them.
//
// Content is passed in as `cars: [{ id, name, stats }]` — the live controller
// feeds it straight from the relay's room snapshot (so the phone bundles no car
// data of its own), and the gallery falls back to the window globals. Thumbnails
// load by id from the web host (carThumbs.js), never over the relay.

import { carThumbNode, releaseSpin } from './carThumbs.js';

// Retire a layer by fading it OVER its replacement instead of cutting to it.
// NOT a fade toward the paper: the replacement is already underneath at full
// opacity, so the pixel beneath the fade is never the page. `outClass` takes the
// layer out of the flow (controller.css) so the incoming one owns the layout
// from its first frame and nothing below either of them moves.
//
// What is swapped here is a tile's RENDER — the picked car turns on a turntable
// and the rest hold their still, so a pick changes the render mode of two tiles.
// The tile itself is never rebuilt, which is what lets the one under the thumb
// outlive its own press.
//
// Only the spin→still direction comes through here; see the caller for why the
// other one cuts.
function retireLayer(old, outClass) {
  // Off the shared spin clock first: a layer that is still registered while it
  // fades keeps the clock turning, and the incoming turntable would then pick
  // up the outgoing car's ANGLE instead of starting from its own still.
  releaseSpin(old);
  old.classList.add(outClass);
  old.setAttribute('aria-hidden', 'true');
  const done = () => old.remove();
  // Its OWN fade ending, not a child's: animationend bubbles, so anything that
  // animates inside the layer would otherwise cut the fade short.
  old.addEventListener('animationend', (e) => { if (e.target === old) done(); });
  // Reduced motion runs no animation, so there is no end to wait for — and a
  // layer left lying over the live one would eat every tap.
  setTimeout(done, 400);
}

// Resolve the car list from the window globals (gallery / no-snapshot fallback).
function carsFromWindow() {
  const models = (typeof window !== 'undefined' && window.CAR_MODELS) || [];
  const names = (typeof window !== 'undefined' && window.CAR_NAMES) || [];
  const resolve = (typeof window !== 'undefined' && window.carStats) || null;
  return models.map((id, i) => ({ id, name: names[i] || ('Car ' + (i + 1)), stats: resolve ? resolve(i) : {} }));
}

// Stats read as a RATING — a named row and five pips, so many of them lit.
// Normalised across the WHOLE roster: the engine stats are multipliers/weights
// with awkward absolute ranges, so what a pip count says is "against the other
// three", never an absolute. Every row is "more = more" (a full Weight rating =
// heaviest) so they read consistently.
//
// Five pips, two to five of them lit — the scale is chosen for the ROSTER it
// has to describe. Every car is built around exactly one hole (protocol.js:
// Bolt cannot turn, Carve cannot top out, Rumble cannot launch, Dash has none),
// so a scale that cannot say "weak" cannot say what a car IS. A floor of three
// could not: it left three rungs, and Weight rated three of the four cars
// identically. Two of five reads weak, which is true and is the pick's whole
// point; nothing rates one or zero, so no car reads broken.
//
// Five is also the resolution the format can carry. The reason to leave a
// continuous fill was that a bar between 66% and 100%, on four separate tiles,
// is a difference the eye has to MEASURE — pips are counted instead, and past
// six or seven of them counting turns back into measuring.
const STAT_PIPS = 5;
const STAT_PIP_FLOOR = 2;
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
    const sorted = vals.slice().sort((a, b) => b - a);
    const lo = sorted[sorted.length - 1];
    const span = (sorted[0] - lo) || 1;
    // A full rating means CLEARLY the roster's best, not best by a pricing step:
    // unless the leader is ahead of second place by ≥30% of the row's spread,
    // pad the top of the scale so a near-tied lead rates high but not full.
    const gap = sorted.length > 1 ? sorted[0] - sorted[1] : span;
    return { lo, span: span + Math.max(0, 0.3 * span - gap) };
  });
}
// STAT_PIP_FLOOR..STAT_PIPS: the roster's weakest in a row lights two of five.
function statPips(stats, row, d) {
  const norm = ((stats[row.key] || d.lo) - d.lo) / d.span;
  return STAT_PIP_FLOOR + Math.round(norm * (STAT_PIPS - STAT_PIP_FLOOR));
}
// The block's SHAPE — four NAMED rows, each a label and five unlit pips. Every
// car has the same four in the same order, so it is built once per roster and
// only the lit count moves (dressStatPips), which is what lets the tile you
// pressed outlive its own press.
//
// The name rides IN the row. It was a key in the page's foot for a while, on
// the theory that a quarter-width tile has no room to head each row — it has,
// at this size, and the foot's version made the reader carry four words from
// the bottom of the page up to four unlabelled bars on four separate tiles. A
// label on its own row costs a few characters and answers on the spot.
function buildStatPips() {
  const wrap = document.createElement('div');
  wrap.className = 'car-opt__stats';
  for (const row of STAT_ROWS) {
    const lab = document.createElement('span');
    lab.className = 'stat__lab';
    lab.textContent = row.lab;
    wrap.appendChild(lab);
    // The row's value is the pip COUNT, so the rating is announced as one label
    // rather than as five anonymous boxes; dressStatPips rewrites it.
    const pips = document.createElement('span');
    pips.className = 'stat__pips';
    pips.setAttribute('role', 'img');
    for (let k = 0; k < STAT_PIPS; k++) pips.appendChild(document.createElement('i'));
    wrap.appendChild(pips);
  }
  return wrap;
}
// A car with no stats at all (an older display's roster) rates every row at the
// floor rather than leaving the last car's showing.
function dressStatPips(wrap, stats, dom) {
  const rows = wrap.querySelectorAll('.stat__pips');
  STAT_ROWS.forEach((row, k) => {
    const lit = stats ? statPips(stats, row, dom[k]) : STAT_PIP_FLOOR;
    rows[k].setAttribute('aria-label', `${row.lab} ${lit} of ${STAT_PIPS}`);
    rows[k].querySelectorAll('i').forEach((pip, n) => pip.classList.toggle('is-on', n < lit));
  });
}

// Render the picker into `gridEl` — one tile per car, each carrying its render,
// its name and its four stat ratings. Tapping one calls onPick(i). `canPick: false`
// renders it read-only (tiles disabled) — a READY player's car is locked until
// they un-ready, mirroring the race picker's gate. `cars` is the
// display-authoritative roster; omit to fall back to the window globals
// (gallery).
export function buildCarPicker({ gridEl, selected, onPick, canPick = true, cars }) {
  if (!gridEl) return;
  const list = (cars && cars.length) ? cars : carsFromWindow();
  const count = list.length || 4;
  const sel = Math.max(0, Math.min(selected | 0, count - 1));
  const nameOf = (i) => (list[i] && list[i].name) || ('Car ' + (i + 1));
  const idOf = (i) => list[i] && list[i].id;
  // Every room snapshot re-sends the catalogue as a FRESH object, and this runs
  // on every push — so change is detected by value, not identity, and an
  // unchanged part is left alone. Rebuilding a thumb re-runs its still→spin
  // cross-fade, which reads as a flicker on every phone whenever anyone in the
  // room touches anything.
  const listSig = JSON.stringify(list.map((c) => [c.id, c.name, c.stats]));

  // BUILT per roster, DRESSED per pick — the same split the race page's grid
  // uses (shared/trackPicker.js), and here for the same reason: a render is
  // driven by a room snapshot arriving, which is to say by the network, at a
  // moment the player's finger is on the glass. A tile that is rebuilt is the
  // tile you are pressing being destroyed by its own tap. `canPick` is in the
  // signature because it changes the tiles' `disabled`, which is shape.
  if (gridEl.dataset.sig !== listSig + '|' + !!canPick) {
    gridEl.dataset.sig = listSig + '|' + !!canPick;
    gridEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'car-opt';
      btn.disabled = !canPick;
      btn.setAttribute('aria-label', nameOf(i));
      // The render hangs off a box of its own so the outgoing one has something
      // to be absolutely positioned in while it fades (.carthumb--out).
      const view = document.createElement('div');
      view.className = 'car-opt__view';
      btn.appendChild(view);
      const nm = document.createElement('span');
      nm.className = 'car-opt__name';
      nm.textContent = nameOf(i);
      btn.appendChild(nm);
      btn.appendChild(buildStatPips());
      if (canPick && onPick) btn.addEventListener('click', () => onPick(i));
      gridEl.appendChild(btn);
    }
  }

  const dom = statDomain(list);
  for (let i = 0; i < gridEl.children.length; i++) {
    const btn = gridEl.children[i];
    const mine = i === sel;
    btn.classList.toggle('car-opt--mine', mine);
    if (mine) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
    dressStatPips(btn.querySelector('.car-opt__stats'), list[i] && list[i].stats, dom);
    // Only YOUR car turns; the rest hold their calm still. That is the roster's
    // own rule (carThumbs.js) and it is also what keeps the strips off the wire:
    // a spin downloads a 24-frame sprite sheet, so four spinning tiles would
    // fetch four of them over the room's wifi to say one thing.
    //
    // A render cannot be re-dressed — a still and a turntable are different
    // nodes — so it is SWAPPED, and the swap cross-fades: the outgoing one lies
    // over the incoming one and fades off it, so a tile never shows an empty
    // frame. `data-spin` is what makes that a change of MODE; the live node is
    // the one not on its way out. The tile around it is untouched, which is why
    // the tile you pressed still gets to finish its press.
    const view = btn.querySelector('.car-opt__view');
    const shown = view.querySelector('.carthumb:not(.carthumb--out)');
    if (!shown || shown.dataset.spin !== String(mine)) {
      const fresh = carThumbNode(idOf(i), { spin: mine });
      fresh.dataset.spin = String(mine);
      view.insertBefore(fresh, view.firstChild);
      // Only ONE direction has anything to cross-fade. Going to the turntable
      // the incoming layer opens on frame 0, which is the very still the
      // outgoing layer is holding — identical pixels, so a fade dissolves
      // nothing and merely composites the car's translucent ground shadow
      // twice, darkening the tile for its length. Coming back the outgoing
      // turntable is stopped at whatever angle it reached, so that swap is a
      // real change of image and still fades.
      if (shown) { if (mine) shown.remove(); else retireLayer(shown, 'carthumb--out'); }
    }
  }
}
