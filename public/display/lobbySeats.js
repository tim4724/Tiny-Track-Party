// Lobby seat grid — ONE renderer shared by the live lobby (main.js) and the
// gallery preview (TestHarness) so the seat markup can't drift between them.
// (display/index.html seeds the same open-seat markup statically for the pre-JS
// first paint — keep its `seat--open` placeholders in sync with the open branch
// here; this module is the source of truth.)
import { carThumbNode } from '../shared/carThumbs.js';
import { schematicSvg, cupTint, neutralTint, FIELD_TINT, starRow, lockGlyph } from '../shared/trackPicker.js';
import { seatGrid, cupSlot } from './NativeUiModel.js';

const { CAR_COLORS, CAR_MODELS } = window;

// Render the roster into `listEl`: one card per player, padded with open-seat
// placeholders to at least MAX_PLAYERS so the lobby card keeps a fixed size as
// players trickle in (locked to the race field size so the lobby grid and the
// grid that actually races never diverge). Each seat card shows the car that
// player picked (a real render) over their name in their livery colour:
//   { name, colorIndex, carIndex?, connected?, host?, ready? }
// carIndex falls back to colorIndex (the slot default before they pick);
// connected === false dims the seat; host appends the ★; ready lights the pill.
//
// WHICH seats and WHAT each one holds is the native UI model's seatGrid (the
// padding rule, the car-pick fallback, the model wrap) — this function is
// markup only. MAX_PLAYERS and the car-roster size are not passed: they were
// handed to the model once at boot (NativeUiModel.configure), so this file no
// longer holds a second copy of either.
export function renderSeats(listEl, seats) {
  // Runs on EVERY roster push (any player's car pick, ready toggle, join…), so
  // each seat carries a value signature and only the seats that actually changed
  // rebuild — recreating an unchanged seat re-runs its thumb's still→spin
  // cross-fade, a visible flicker across the whole grid. Mirrors the sig guard
  // on the lobby demo (main.js refreshLobbyDemo). The index.html placeholders
  // carry no signature, so the first render replaces them as before.
  const grid = seatGrid(seats);
  grid.forEach((p, i) => {
    const sig = JSON.stringify(p);
    const cur = listEl.children[i];
    if (cur && cur.dataset.sig === sig) return;
    const seat = buildSeat(p);
    seat.dataset.sig = sig;
    if (cur) cur.replaceWith(seat); else listEl.appendChild(seat);
  });
  while (listEl.children.length > grid.length) listEl.lastChild.remove();
}

function buildSeat(p) {
  const seat = document.createElement('div');
  if (!p.open) {
    seat.className = 'seat' + (p.off ? ' seat--off' : '') + (p.ready ? ' seat--ready' : '');
    seat.style.setProperty('--c', CAR_COLORS[p.colorIndex] || '#888');
    // the name itself carries the livery colour (via the seat's --c) — no dot
    const row = document.createElement('div');
    row.className = 'seat__name';
    const nm = document.createElement('span'); nm.className = 'seat__label';
    nm.textContent = p.name;
    row.appendChild(nm);
    // host marker — a black star pinned to the seat's top-right corner (the
    // same slot as the ready check; the host never readies, so they can't
    // collide). Out of the name so a long name can't push it off-screen.
    if (p.host) {
      const hs = document.createElement('span');
      hs.className = 'seat__host';
      hs.setAttribute('aria-label', 'Host');
      hs.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.1 6.47L12 17.9l-5.8 3.05 1.1-6.47-4.7-4.58 6.5-.95z"/></svg>';
      seat.appendChild(hs);
    }
    // each joined car rotates in spin mode, in lockstep via the shared clock
    seat.appendChild(carThumbNode(CAR_MODELS[p.modelIndex], { spin: true }));
    seat.appendChild(row);
    // readiness check — a circle checkmark pinned to the seat's top-right
    // corner (visibility-toggled in CSS, so it never shifts the seat layout).
    const rd = document.createElement('span');
    rd.className = 'seat__ready';
    rd.setAttribute('aria-label', 'Ready');
    rd.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.4 4.4L19 7" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    seat.appendChild(rd);
  } else {
    seat.className = 'seat seat--open';
    const ph = document.createElement('div'); ph.className = 'seat__open';
    const lab = document.createElement('div'); lab.className = 'seat__name';
    const nm = document.createElement('span'); nm.className = 'seat__label'; nm.textContent = 'Open';
    lab.appendChild(nm);
    seat.appendChild(ph); seat.appendChild(lab);
  }
  return seat;
}

// Right-rail cup slot (markup in display/index.html #cup-slot) — shared by the
// live lobby and the gallery preview for the same no-drift reason, both through
// renderLobbyPick below. Two states:
//   pre-pick : null / no `name`         → the slot is simply EMPTY
//   picked   : { name, races?, raceCount?, difficulty?, maps?, cupId? }
//              → the race card: red cup sticker over the picked circuits as mini
//              schematics (maps = [{ svg?, n?, q?, glyph?, cup?, locked? }] — 4
//              numbered minis for a cup, 1 for an exact track, the tour's five
//              per-cup chips; cupId biome-tints their fields exactly like the
//              phone picker, a chip's own `cup` outranks it; a q chip shows
//              `glyph` or "?"; a locked chip is the tour's teaser for a locked
//              cup — padlock on sunken paper, counted by no races pill), races
//              pill + difficulty pips (0–4 filled; null hides the meter)
export function renderCupSlot(slotEl, state) {
  const picked = !!(state && state.name);
  slotEl.querySelector('.cup-slot__pick').classList.toggle('hidden', !picked);
  if (!picked) return;
  slotEl.querySelector('.cup-sticker').textContent = state.name;
  // The couch's star badge for this pick (cup cards only; null hides it —
  // the tour, random and exact-track cards carry none).
  const starsEl = slotEl.querySelector('.cup-stars');
  starsEl.classList.toggle('hidden', state.stars == null);
  starsEl.textContent = '';
  if (state.stars != null) starsEl.appendChild(starRow(state.stars));
  const mapsEl = slotEl.querySelector('.cup-maps');
  // The model names the KNOWN circuits (a chip with q and no svg is an undrawn
  // race). A counted card shows one box per race, so boxes past the known maps
  // pad out as "?" placeholders — that's the random card's not-yet-drawn races.
  // A known chip whose schematic is missing (dev mid-rebuild) still just costs
  // its picture.
  const maps = (state.maps || []).filter((m) => m && (m.q || m.svg || m.locked));
  if (state.raceCount) while (maps.length < state.raceCount) maps.push({ q: true });
  mapsEl.textContent = '';
  mapsEl.classList.toggle('hidden', !maps.length);
  mapsEl.classList.toggle('cup-maps--one', maps.length === 1);
  mapsEl.classList.toggle('cup-maps--five', maps.length === 5);
  mapsEl.classList.toggle('cup-maps--many', maps.length >= 6);
  const tint = state.cupId ? cupTint(state.cupId, FIELD_TINT) : undefined;
  for (const m of maps) {
    const tile = document.createElement('div');
    tile.className = 'cup-maps__tile';
    if (m.locked) {
      // The tour's teaser for a locked cup: padlock on sunken paper. It shows
      // the ladder's locked rung without selling it as a race — the races pill
      // never counts it.
      tile.classList.add('cup-maps__tile--locked');
      tile.appendChild(lockGlyph());
    } else if (m.q) {
      // An undrawn race: its own cup's wash when the chip names one (the
      // tour), the picker's neutral grey when the cup is unknown too (a
      // random run's later races). Never the card-level tint — an unknown
      // must not borrow the drawn race's colour. The glyph is "?" unless the
      // chip says otherwise (endless carries ∞).
      tile.classList.add('cup-maps__tile--q');
      tile.style.background = m.cup ? cupTint(m.cup, FIELD_TINT) : neutralTint(FIELD_TINT);
      const q = document.createElement('span');
      q.textContent = m.glyph || '?';
      tile.appendChild(q);
    } else {
      tile.appendChild(schematicSvg(m.svg, m.cup ? cupTint(m.cup, FIELD_TINT) : tint));
    }
    if (m.n != null) {
      const n = document.createElement('span');
      n.className = 'cup-maps__n';
      n.textContent = m.n;
      tile.appendChild(n);
    }
    mapsEl.appendChild(tile);
  }
  const races = slotEl.querySelector('.cup-races');
  races.textContent = state.races || '';
  races.classList.toggle('hidden', !state.races);
  const meter = slotEl.querySelector('.cup-meter');
  meter.classList.toggle('hidden', state.difficulty == null);
  meter.querySelectorAll('i').forEach((pip, i) => pip.classList.toggle('is-on', i < (state.difficulty || 0)));
}

// The lobby right-rail cup slot, straight from a PICK ({ mode, cupId, trackId,
// randomRaces } — the room's stored pick, or the shape a preview wants to show).
// Pre-pick the slot is empty; post-pick it shows the race card (cup / exact
// track / random / tour).
//
// The card's CONTENT is uiModel.cupSlot's — which name, how many races, the
// difficulty pips, which circuits to draw as minis and how they're numbered (an
// undrawn race is a trackId-less chip). It hands back keys plus data (never
// composed copy), so the few English strings and the schematic lookup are all
// that live here. `trackCatalog` supplies the baked mini-maps by id.
const RACES_COPY = { one: () => '1 race', endless: () => 'endless', count: (n) => `${n} races` };
const NAME_COPY = { random: 'Random', tour: 'World Tour' };
// `progress` is the snapshot's progress shape ({cups:[{id,stars,…}]}) or null —
// it dresses the card with the couch's stars, merged SHELL-SIDE so the frozen
// ui corpus's cupSlot answers stay untouched (stars are not catalogue data).
// Only a CUP card wears one: the stars are the cups' reward arc, so the tour,
// random and exact-track cards all go bare.
export function renderLobbyPick(slotEl, pick, trackCatalog, progress) {
  if (!slotEl) return;
  const svgOf = (id) => { const t = trackCatalog.find((e) => e.id === id); return t && t.svg; };
  const starsFor = (m) => {
    if (!progress || !m) return null;
    if (m.nameKey === 'cup' && m.cupId) {
      const row = (progress.cups || []).find((c) => c.id === m.cupId);
      return row ? row.stars : 0;
    }
    return null;
  };
  const m = cupSlot(pick);
  renderCupSlot(slotEl, m && {
    name: NAME_COPY[m.nameKey] || m.name || '?',
    stars: starsFor(m),
    races: RACES_COPY[m.racesKey](m.raceCount),
    // raceCount sizes the maps grid (renderCupSlot pads a counted card's
    // not-yet-drawn races with "?" boxes); endless is a single ∞ box. RANDOM
    // only — a cup's racesKey is 'count' too, and a cup card must never pad
    // (a chip with a missing schematic just costs its picture, not a "?").
    raceCount: m.nameKey === 'random' && m.racesKey === 'count' ? m.raceCount : null,
    difficulty: m.difficulty,
    // Random spoils nothing: a counted card is raceCount grey "?" boxes (an
    // empty list here — renderCupSlot's raceCount padding builds them all)
    // and endless is one grey box carrying ∞; even the drawn race 1 isn't the
    // card's to sell. A veil here rather than in the model — the frozen ui
    // corpus pins cupSlot's random answers to the drawn chip.
    maps: m.nameKey === 'random' ? (m.racesKey === 'endless' ? [{ q: true, glyph: '∞' }] : [])
      : m.maps.map((x) => ({ svg: x.trackId ? svgOf(x.trackId) : null, q: !x.trackId && !x.locked,
        n: x.n, cup: x.cup, locked: x.locked })),
    cupId: m.cupId   // biome-tints the mini fields, like the phone picker
  });
}

// The "Cups" shelf in the lobby's bottom-right corner — one row per cup with
// the couch's stars, the locked cup trailing its unlock progress instead.
// `cups` is the wasm-stamped catalogue's cups list (or a preview's synthesis):
// [{id, name, stars, locked, unlockDone?, unlockNeed?}]. It sits under the
// "Up next" card so the stars read beside the pick they dress.
export function renderCupShelf(shelfEl, cups) {
  if (!shelfEl) return;
  shelfEl.textContent = '';
  if (!cups || !cups.length) { shelfEl.classList.add('hidden'); return; }
  shelfEl.classList.remove('hidden');
  const label = document.createElement('span');
  label.className = 'pill cup-shelf__label';
  label.textContent = 'Cups';
  shelfEl.appendChild(label);
  for (const c of cups) {
    const row = document.createElement('div');
    row.className = 'cup-shelf__row' + (c.locked ? ' cup-shelf__row--locked' : '');
    if (c.locked) {
      row.appendChild(lockGlyph());
    } else {
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = cupTint(c.id, 100);
      row.appendChild(dot);
    }
    const nm = document.createElement('span');
    nm.className = 'cup-shelf__name';
    // Short names: every cup is one on this shelf, so " Cup" says nothing and
    // the two-column chips have no room for it.
    nm.textContent = (c.name || '').replace(/ Cup$/, '');
    row.appendChild(nm);
    if (c.locked) {
      const b = document.createElement('b');
      b.textContent = `${c.unlockDone || 0}/${c.unlockNeed || 0}`;
      row.appendChild(b);
    } else {
      row.appendChild(starRow(c.stars || 0));
    }
    shelfEl.appendChild(row);
  }
}
