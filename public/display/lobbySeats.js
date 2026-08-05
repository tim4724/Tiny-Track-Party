// Lobby seat grid — ONE renderer shared by the live lobby (main.js) and the
// gallery preview (TestHarness) so the seat markup can't drift between them.
// (display/index.html seeds the same open-seat markup statically for the pre-JS
// first paint — keep its `seat--open` placeholders in sync with the open branch
// here; this module is the source of truth.)
import { carThumbNode } from '../shared/carThumbs.js';
import { schematicSvg, cupTint, neutralTint, FIELD_TINT } from '../shared/trackPicker.js';
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
//
// `padOrdinals` marks the seats held by a GAMEPAD on this TV, as "Pad 1"'s 1 (a
// phone's entry is null). It is a PARALLEL ARRAY rather than a field on the
// seat, for two reasons: which seats are local is knowable only to the shell
// (the room has no notion of one), and Seat/SeatCell carry no peerIndex to key
// it by. The zip is sound because the model's rows are the room's roster IN JOIN
// ORDER and seatGrid only APPENDS its open placeholders — so taken cell i is
// roster i. That contract is asserted below rather than assumed.
export function renderSeats(listEl, seats, padOrdinals = []) {
  listEl.innerHTML = '';
  let taken = -1;
  for (const p of seatGrid(seats)) {
    const seat = document.createElement('div');
    if (!p.open) {
      taken++;
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
      // Pad badge — the mirror of the host star, in the seat's own top-LEFT
      // corner: it says both "this seat is a controller on this TV" and WHICH
      // controller, which is the one thing a pad player cannot work out from
      // the screen (a phone player is holding the answer). The number is the
      // pad's, matching its default name.
      const ord = padOrdinals[taken];
      if (ord != null) {
        seat.dataset.pad = ord;   // the ping below finds a card by this
        const pd = document.createElement('span');
        pd.className = 'seat__pad';
        pd.setAttribute('aria-label', `Controller ${ord}`);
        // The SILHOUETTE only: at badge size a d-pad and face buttons drawn
        // inside it turn to mud, and the shape alone is what carries "pad".
        pd.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
          + '<path d="M8 7h8c3.6 0 6.5 2.9 6.5 6.5 0 2.2-1.8 4-4 4-1.3 0-2.5-.65-3.25-1.75L14.2 14.5H9.8l-1.05 1.25C8 16.85 6.8 17.5 5.5 17.5c-2.2 0-4-1.8-4-4C1.5 9.9 4.4 7 8 7z"/>'
          + '</svg>';
        const n = document.createElement('b');
        n.textContent = ord;
        pd.appendChild(n);
        seat.appendChild(pd);
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
    listEl.appendChild(seat);
  }
  // The zip's contract, made loud. If the model ever re-sorts the roster or
  // interleaves its placeholders, the badges would silently land on the wrong
  // cards — which is exactly the bug a pad player could not diagnose.
  if (padOrdinals.length && taken + 1 !== seats.length) {
    throw new Error(`seat grid drifted from the roster: ${taken + 1} taken cells, ${seats.length} seats`);
  }
}

// Right-rail cup slot (markup in display/index.html #cup-slot) — shared by the
// live lobby and the gallery preview for the same no-drift reason, both through
// renderLobbyPick below. Two states:
//   pre-pick : null / no `name`         → the slot is simply EMPTY
//   picked   : { name, races?, raceCount?, difficulty?, maps?, cupId? }
//              → the race card: red cup sticker over the picked circuits as mini
//              schematics (maps = [{ svg?, n?, q?, glyph?, cup? }] — 4 numbered
//              minis for a cup, 1 for an exact track, the tour's five per-cup
//              chips; cupId biome-tints their fields exactly like the phone
//              picker, a chip's own `cup` outranks it; a q chip shows `glyph`
//              or "?"), races pill + difficulty pips (0–4 filled; null hides
//              the meter)
export function renderCupSlot(slotEl, state) {
  const picked = !!(state && state.name);
  slotEl.querySelector('.cup-slot__pick').classList.toggle('hidden', !picked);
  if (!picked) return;
  slotEl.querySelector('.cup-sticker').textContent = state.name;
  const mapsEl = slotEl.querySelector('.cup-maps');
  // The model names the KNOWN circuits (a chip with q and no svg is an undrawn
  // race). A counted card shows one box per race, so boxes past the known maps
  // pad out as "?" placeholders — that's the random card's not-yet-drawn races.
  // A known chip whose schematic is missing (dev mid-rebuild) still just costs
  // its picture.
  const maps = (state.maps || []).filter((m) => m && (m.q || m.svg));
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
    if (m.q) {
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
export function renderLobbyPick(slotEl, pick, trackCatalog) {
  if (!slotEl) return;
  const svgOf = (id) => { const t = trackCatalog.find((e) => e.id === id); return t && t.svg; };
  const m = cupSlot(pick);
  renderCupSlot(slotEl, m && {
    name: NAME_COPY[m.nameKey] || m.name || '?',
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
      : m.maps.map((x) => ({ svg: x.trackId ? svgOf(x.trackId) : null, q: !x.trackId, n: x.n, cup: x.cup })),
    cupId: m.cupId   // biome-tints the mini fields, like the phone picker
  });
}
