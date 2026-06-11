// Lobby seat grid — ONE renderer shared by the live lobby (main.js) and the
// gallery preview (TestHarness) so the seat markup can't drift between them.
// (display/index.html seeds the same open-seat markup statically for the pre-JS
// first paint — keep its `seat--open` placeholders in sync with the open branch
// here; this module is the source of truth.)
import { carThumbNode } from '../shared/carThumbs.js';

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
      nm.textContent = p.name + (p.host ? '  ★' : '');
      row.appendChild(dot); row.appendChild(nm);
      // each joined car rotates in spin mode, in lockstep via the shared clock
      seat.appendChild(carThumbNode(CAR_MODELS[carIdx % CAR_MODELS.length], { spin: true }));
      seat.appendChild(row);
      // readiness pill — appended on every taken seat (visibility-toggled in
      // CSS) so a seat doesn't change height the moment its player readies up.
      const rd = document.createElement('span');
      rd.className = 'seat__ready';
      rd.textContent = 'READY';
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

// Headline under the seat grid (shared for the same no-drift reason).
// "joined", not "ready" — readiness is its own per-seat pill now.
export function seatCountText(n) {
  return n ? `${n} racer${n > 1 ? 's' : ''} joined` : 'Scan the QR code to join';
}
