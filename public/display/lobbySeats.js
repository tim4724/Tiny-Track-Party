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

// Headline under the seat grid (shared for the same no-drift reason).
// "joined", not "ready" — readiness is its own per-seat pill now.
export function seatCountText(n) {
  return n ? `${n} racer${n > 1 ? 's' : ''} joined` : 'Scan the QR code to join';
}
