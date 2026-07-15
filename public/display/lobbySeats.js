// Lobby seat grid — ONE renderer shared by the live lobby (main.js) and the
// gallery preview (TestHarness) so the seat markup can't drift between them.
// (display/index.html seeds the same open-seat markup statically for the pre-JS
// first paint — keep its `seat--open` placeholders in sync with the open branch
// here; this module is the source of truth.)
import { carThumbNode } from '../shared/carThumbs.js';
import { schematicSvg } from '../shared/trackPicker.js';

const { CAR_COLORS, CAR_MODELS, MAX_PLAYERS } = window;

// Render the roster into `listEl`: one card per player, padded with open-seat
// placeholders to at least MAX_PLAYERS so the lobby card keeps a fixed size as
// players trickle in (locked to the race field size so the lobby grid and the
// grid that actually races never diverge). Each seat shows the car that player
// picked (a real render), ringed + dotted in their livery. `seats` entries:
//   { name, colorIndex, carIndex?, connected?, host?, ready? }
// carIndex falls back to colorIndex (the slot default before they pick);
// connected === false dims the seat; host appends the ★; ready lights the pill.
export function renderSeats(listEl, seats) {
  listEl.innerHTML = '';
  const total = Math.max(MAX_PLAYERS, seats.length);
  for (let i = 0; i < total; i++) {
    const p = seats[i];
    const seat = document.createElement('div');
    if (p) {
      seat.className = 'seat' + (p.connected === false ? ' seat--off' : '') + (p.ready ? ' seat--ready' : '');
      seat.style.setProperty('--c', CAR_COLORS[p.colorIndex] || '#888');
      const carIdx = (p.carIndex == null ? p.colorIndex : p.carIndex);
      const row = document.createElement('div');
      row.className = 'seat__name';
      const dot = document.createElement('span'); dot.className = 'seat__dot';
      const nm = document.createElement('span'); nm.className = 'seat__label';
      nm.textContent = p.name;
      row.appendChild(dot); row.appendChild(nm);
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
      seat.appendChild(carThumbNode(CAR_MODELS[carIdx % CAR_MODELS.length], { spin: true }));
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
    listEl.appendChild(seat);
  }
}

// Right-rail cup slot (markup in display/index.html #cup-slot) — shared by the
// live lobby (renderLobbyPick in main.js) and the gallery preview for the same
// no-drift reason. Two states:
//   pre-pick : { hostName? }             → dashed slot, "<host> picks the cup…"
//   picked   : { name, races?, difficulty?, maps? } → the race card: red cup
//              sticker over the picked circuits as mini schematics (maps =
//              [{ svg, n? }] — 4 numbered minis for a cup, 1 for an exact
//              track / the random draw), races pill + difficulty pips
//              (0–4 filled; null hides the meter)
export function renderCupSlot(slotEl, state) {
  const picked = !!(state && state.name);
  slotEl.querySelector('.cup-slot__empty').classList.toggle('hidden', picked);
  slotEl.querySelector('.cup-slot__pick').classList.toggle('hidden', !picked);
  if (!picked) {
    // textContent — the host name is player-supplied, never markup.
    slotEl.querySelector('.cup-slot__empty').textContent = (state && state.hostName)
      ? `${state.hostName} picks the cup on their phone…`
      : 'Pick the cup on a phone…';
    return;
  }
  slotEl.querySelector('.cup-sticker').textContent = state.name;
  const mapsEl = slotEl.querySelector('.cup-maps');
  const maps = (state.maps || []).filter((m) => m && m.svg);
  mapsEl.textContent = '';
  mapsEl.classList.toggle('hidden', !maps.length);
  mapsEl.classList.toggle('cup-maps--one', maps.length === 1);
  for (const m of maps) {
    const tile = document.createElement('div');
    tile.className = 'cup-maps__tile';
    tile.appendChild(schematicSvg(m.svg));
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
