// Mode picker UI — how the host picks what to race: a Cup (its 4 tracks
// back-to-back as a Grand Prix), 🎲 Random (a run of display-drawn tracks:
// endless, a fixed card, or the World Tour — one draw from every cup), or —
// from the panel a picked cup opens — one exact track (single race). Six
// compact tiles instead of the old 16-tile strip, so the lobby never scrolls. Rendered
// from the schematic catalog the display ships in WELCOME (each entry carries
// its cup + a top-down SVG path; see native/libttp-track/ttp/schematic.h). Only the HOST
// picks, so `canPick` gates the taps — read-only rendering is for the gallery.

const SVGNS = 'http://www.w3.org/2000/svg';

// Each cup owns a COLOUR, and it appears only on the PICKED tile — an unpicked one is
// plain white paper. That's the lobby's existing idiom rather than a new one: the car
// strip right above leaves its unpicked cars white and marks your pick by tinting it
// toward your livery with a hard shadow under it (.car-opt--mine). Reusing it verbatim
// keeps the two rows speaking one language, and it needs no chrome colour of its own —
// a green ring said "green" louder than it said "picked", and fought the cup colour
// underneath it.
//
// These are authored, not derived. They started life pulled from each biome's first
// horizon-hill colour — the same source the 3D world themes from — on the theory that
// the two surfaces then couldn't drift. That theory broke on two of five cups: those
// colours are chosen for their job on a 3D horizon, not for legibility as pale paper.
// Snow's is #EEF4F9, white in all but name, invisible on paper at any strength.
// Playroom's is #E66A5A, hot enough that any pale wash of it lands on chrome pink,
// which the theme vetoes. Clamping the pair into range took a saturation floor and a
// lightness cap, and *still* left playroom pink and nearly on top of canyon — two
// hacks to launder colours that were never meant for this job. So we author five
// instead, one per cup, each the paper-legible relative of what that biome looks like:
//
// EXPORTED, AND CODEGEN'D. This file is the AUTHORED source and stays so: the
// PHONE imports it and a phone has no wasm, so these cannot come from the ABI at
// runtime. But a native shell has no way to reach a JS module either, so
// `scripts/gen-track-defs-header.mjs` carries this table into `track_defs.h` and
// `ttp_ui_catalogue_json` hands each cup its colour — the same relationship
// `protocol.h` has with `protocol.js`. `tests/ui-model.test.js` is the drift
// gate, being the one place that can see the table and the wasm at once.
//
// Before that, the first TV shell simply retyped all five, under a comment
// saying nothing in the tree watched the two lists. It was right.
export const CUP_COLOR = {
  beach:    '#E0C070',  // wet sand
  snow:     '#7FB2DC',  // ice blue — the biome's own white can't survive a paper mix
  backyard: '#7FBF63',  // lawn green
  canyon:   '#C4713F',  // terracotta: dark and dull, where playroom's orange is bright
  // The biome's orange plastic deck. It lands near canyon's hue, which would matter if
  // the two were ever side by side — but only the picked cup is coloured at all, so no
  // two cup colours are ever on screen together. Brightness still separates them for
  // the one surface that does show them in sequence (the display's cup slot).
  rooftop:  '#F5842B'
};
// Cup-less catalogue: the old default green. Exported for the same reason.
export const CUP_COLOR_FALLBACK = CUP_COLOR.backyard;
// Random belongs to no cup, so it has no colour to turn up — a warm grey stands in,
// which is honest: "any biome" isn't one of them.
const NEUTRAL_COLOR = '#8C8398';

// How LONG a Random run is, in tile order — the options in the panel Random
// opens, mirroring the exact-track panel a cup opens. `randomRaces: 0` is
// endless (no last race; only a lobby return ends it), any other count is a
// fixed card drawn up front, which means points, a final race and a podium —
// a Grand Prix out of tracks nobody chose.
// What the tile means on its own — a 4-race card, matching every cup beside it.
// Random used to mean ENDLESS, but a run with no finish line is a strange thing
// to hand a host who just tapped a tile: nothing on screen promises an end, and
// leaving one is a deliberate act. A card ends by itself, on a podium, and the
// panel is one tap away for the party that wants to keep going.
// The MANIFEST's (protocol.js RANDOM_RACES.DEFAULT), not a literal: this and
// display/Net.js are the two ends of one number, and they were two copies with
// nothing between them.
//
// A FUNCTION rather than a const, because this module is imported by Node too —
// `gen-track-defs-header.mjs` and `tests/ui-model.test.js` read the cup colours
// out of it — and protocol.js is a classic script that publishes onto `window`,
// which those importers do not have. Read at RENDER time it is browser-only by
// construction, and a missing manifest says so instead of yielding undefined.
const randomManifest = () => {
  const m = globalThis.RANDOM_RACES;
  if (!m) throw new Error('trackPicker: protocol.js must be loaded before the picker renders');
  return m;
};
const randomDefaultRaces = () => randomManifest().DEFAULT;

//
// BOTH FINITE LENGTHS ARE THE MANIFEST'S, and each LABEL is built from the
// same number it sets. The short card was once a bare `4` here while
// `randomDefaultRaces()` read `RANDOM_RACES.DEFAULT` — the two ends of one
// value in ONE file, disagreeing the moment the manifest moved: a host tapping
// Random would get the manifest's length, while the tile beside it still said
// "4 races" and set 4 on tap. Deriving them is what makes "a manifest number,
// not private copies" true rather than aspirational.
//
// A FUNCTION for the same reason `randomDefaultRaces` is one: this module is
// imported by Node (the track-defs codegen, ui-model.test.js) for its cup
// colours, and those importers have no `window` for protocol.js to publish on.
export const randomLengths = () => {
  const m = randomManifest();
  return [
    { randomRaces: m.DEFAULT, label: `${m.DEFAULT} races`, glyph: '?' },
    // The long card is the manifest's CEILING worn as an option: the widest
    // run the display accepts is also the longest one the picker sells, so
    // the two can never drift apart.
    { randomRaces: m.MAX, label: `${m.MAX} races`, glyph: '?' },
    { randomRaces: 0, label: 'Endless', glyph: '∞' }
  ];
};
const randomSub = (n) => (n ? `${n} races` : 'endless');

// The World Tour: one drawn track from EVERY cup, raced in the cups' own
// (difficulty) order — a sampler card, and what the bare 🎲 tile lands on, so
// it LEADS the panel the tile opens. It carries no knobs at all:
// `{mode:'tour'}` is the whole pick.
const TOUR_LABEL = 'World Tour';

// How much colour a surface wears; `pct` is how much survives a mix with white.
const PANEL_TINT = 45;  // the open cup's track panel: a surface behind cards, so deeper than they are
const PICK_TINT  = 72;  // the pick — the only tile that takes a fill at all
export const FIELD_TINT = 26;  // the schematic's field. Exported: the display's cup slot paints the same minis

const towardWhite = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, #fff)`;

// Exported alongside schematicSvg: the display's cup slot tints its minis the same
// way, so the two surfaces can't drift.
export function cupTint(cupId, pct) {
  return towardWhite(CUP_COLOR[cupId] || CUP_COLOR_FALLBACK, pct);
}

// The neutral "no cup" grey as a wash — exported for the display's cup slot,
// whose unknown-cup "?" chips wear it (same single source as the 🎲 tile's own
// fill above, so "belongs to no cup" is one colour everywhere).
export function neutralTint(pct) {
  return towardWhite(NEUTRAL_COLOR, pct);
}

// Build one schematic <svg>: a wide casing path under a narrower road path (the
// toy "track ribbon" look) plus a dot at the start/finish line. `fieldTint` (a CSS
// colour) paints the field behind the ribbon; omit to keep the CSS default.
// Exported: the display's lobby cup slot renders the same minis (renderCupSlot).
export function schematicSvg(svg, fieldTint) {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', svg.viewBox || '0 0 256 256');
  el.setAttribute('class', 'track-map');
  el.setAttribute('aria-hidden', 'true');
  if (fieldTint) el.style.background = fieldTint;
  if (svg.d) {
    const casing = document.createElementNS(SVGNS, 'path');
    casing.setAttribute('d', svg.d);
    casing.setAttribute('class', 'track-map__casing');
    const road = document.createElementNS(SVGNS, 'path');
    road.setAttribute('d', svg.d);
    road.setAttribute('class', 'track-map__road');
    el.appendChild(casing);
    el.appendChild(road);
    if (svg.start) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', svg.start.x);
      dot.setAttribute('cy', svg.start.y);
      dot.setAttribute('r', '13'); // ~2.56× the old r=5 for the 0 0 256 256 viewBox
      dot.setAttribute('class', 'track-map__start');
      el.appendChild(dot);
    }
  }
  return el;
}

// One exact-track tile (inside an open cup's panel): schematic + name. White at rest;
// picked, it fills with its cup's colour turned up — the same mark a picked cup tile
// wears, so "picked" looks identical wherever it lands in the picker. Difficulty is
// never badged per track — only the cup's tendency meter (cupMeter) hints at it.
function trackTile(t, mine, canPick, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'track-opt' + (mine ? ' track-opt--mine' : '');
  if (mine) {
    btn.setAttribute('aria-current', 'true');
    btn.style.background = cupTint(t.cup, PICK_TINT);
  }
  btn.setAttribute('aria-label', t.name);
  btn.disabled = !canPick;
  btn.appendChild(schematicSvg(t.svg || {}, cupTint(t.cup, FIELD_TINT)));
  const lab = document.createElement('span');
  lab.className = 'track-opt__name';
  lab.textContent = t.name;
  btn.appendChild(lab);
  if (canPick && onPick) btn.addEventListener('click', () => onPick(t.id));
  return btn;
}

// A cup's difficulty TENDENCY as a 4-pip meter (the first `level` pips filled, 1–4). A
// lean for the whole cup, not a per-track rating; CSS colour-ramps the filled pips.
function cupMeter(level) {
  const lv = Math.max(1, Math.min(4, level | 0));
  const meter = document.createElement('span');
  meter.className = 'trackpick__cup-meter';
  meter.dataset.level = String(lv);
  meter.setAttribute('aria-label', `difficulty ${lv} of 4`);
  for (let i = 0; i < 4; i++) {
    const pip = document.createElement('i');
    if (i < lv) pip.className = 'is-on';
    meter.appendChild(pip);
  }
  return meter;
}

// One compact mode tile (🎲 Random or a cup): name line (optional glyph), the
// cup's tendency meter, and a small hint ("4 races" / "endless"). No track art —
// the panel a picked cup opens below is where the tracks show.
// `pickTint` is this tile's own colour, worn ONLY when it's the pick — at rest every
// tile is white paper. Exactly ONE thing in the picker is ever `mine`: pick a track
// and its cup hands the mark down to it.
function modeTile({ label, glyph, sub, meter, mine, pickTint, canPick, onTap }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-opt' + (mine ? ' mode-opt--mine' : '');
  if (mine) {
    btn.setAttribute('aria-current', 'true');
    if (pickTint) btn.style.background = pickTint;
  }
  btn.setAttribute('aria-label', label);
  btn.disabled = !canPick;
  const lab = document.createElement('span');
  lab.className = 'mode-opt__name';
  if (glyph) {
    const g = document.createElement('span');
    g.setAttribute('aria-hidden', 'true');
    g.textContent = `${glyph} `;
    lab.appendChild(g);
  }
  lab.append(label);
  btn.appendChild(lab);
  if (meter) btn.appendChild(meter);
  const hint = document.createElement('span');
  hint.className = 'mode-opt__sub';
  hint.textContent = sub;
  btn.appendChild(hint);
  if (canPick && onTap) btn.addEventListener('click', onTap);
  return btn;
}

// Render the picker into `stripEl`.
//   catalog   : [{ id, name, svg, cup, cupName, cupDifficulty }] (from the display)
//   selection : {mode:'track'|'cup'|'random'|'tour', trackId?, cupId?, randomRaces?} | null
//   canPick   : whether taps are live (host only)
//   onPickMode: ({mode, trackId?, cupId?, randomRaces?}) => void — every
//               random-family tap fires, same pick or not: each one deals fresh
//               track(s) on the display, so don't filter them.
// A catalog whose entries predate cups collapses to a flat grid of exact picks.
export function buildModePicker({ stripEl, catalog, selection, canPick, onPickMode }) {
  if (!stripEl) return;
  stripEl.innerHTML = '';
  const list = catalog || [];
  const sel = selection || {};
  const pick = (m) => onPickMode && onPickMode(m);

  // Group by cup, preserving the catalog's (cup-ordered) sequence.
  const groups = [];
  const byCup = new Map();
  for (const t of list) {
    if (!t.cup) continue;
    let g = byCup.get(t.cup);
    if (!g) { g = { id: t.cup, name: t.cupName || t.cup, diff: t.cupDifficulty, items: [] }; byCup.set(t.cup, g); groups.push(g); }
    g.items.push(t);
  }

  // Cup-less catalog (older display / gallery): no modes to offer — flat exact picks.
  if (!groups.length) {
    const grid = document.createElement('div');
    grid.className = 'trackpick__grid';
    for (const t of list) grid.appendChild(trackTile(t, t.id === sel.trackId, canPick, (id) => pick({ mode: 'track', trackId: id })));
    stripEl.appendChild(grid);
    return;
  }

  // Which cup's exact-track panel is open: the picked cup, or the cup owning an
  // exact-picked track. Derived, not stored — every tap that changes it changes
  // the selection too. Random keeps the panel closed.
  const ownerOf = (id) => { const t = list.find((x) => x.id === id); return t ? t.cup : null; };
  const expanded = sel.mode === 'cup' ? sel.cupId : sel.mode === 'track' ? ownerOf(sel.trackId) : null;

  // Random and the World Tour are one FAMILY: both live on the 🎲 tile, whose
  // panel offers the run lengths and the tour side by side.
  const randomFamily = sel.mode === 'random' || sel.mode === 'tour';
  // The length a Random tap carries: whatever it's already set to, so tapping
  // the main tile re-rolls the draw without also resetting the run's shape. A
  // selection with no length at all (a phone whose stored pick predates them, or
  // a tour pick — the display echoes the tour's own race count, which is not a
  // run length) takes the default, so 0 has to be tested for rather than
  // falsy-checked — it's endless, not "unset".
  const randomRaces = sel.mode === 'random' && Number.isInteger(sel.randomRaces)
    ? sel.randomRaces : randomDefaultRaces();

  const grid = document.createElement('div');
  grid.className = 'modepick';

  for (const g of groups) {
    grid.appendChild(modeTile({
      label: g.name, sub: `${g.items.length} races`,
      meter: g.diff != null ? cupMeter(g.diff) : null,
      // Picked only when the CUP itself is the pick: picking one of its TRACKS hands
      // the mark down to that track tile and leaves this one white. The panel standing
      // open below is what shows where the pick came from, so the cup neither needs
      // nor should wear a mark of its own.
      mine: sel.mode === 'cup' && sel.cupId === g.id,
      pickTint: cupTint(g.id, PICK_TINT),
      canPick,
      onTap: () => pick({ mode: 'cup', cupId: g.id })
    }));
  }

  // Random sits AFTER the cups: the cups are the game's own ladder and read in
  // difficulty order, so a tile in front of them cut that order in half. Last, it
  // reads as what it is — the thing you reach for once the five named cups aren't
  // what you want.
  grid.appendChild(modeTile({
    label: 'Random', glyph: '🎲', sub: sel.mode === 'random' ? randomSub(randomRaces) : TOUR_LABEL.toLowerCase(),
    mine: randomFamily,
    // Belonging to no cup, it has no colour of its own — a neutral grey stands in so it
    // still wears the same fill-and-drop mark the cups do.
    pickTint: towardWhite(NEUTRAL_COLOR, PICK_TINT),
    canPick,
    // From outside the family the tile lands on its DEFAULT, the World Tour.
    // Inside it, it re-sends the current pick — which, like every family tap,
    // deals fresh track(s) on the display.
    onTap: () => pick(sel.mode === 'random'
      ? { mode: 'random', randomRaces }
      : { mode: 'tour' })
  }));
  stripEl.appendChild(grid);

  // A picked Random opens a panel of its own, in the same slot, the same inset
  // surface AND the same tile grid a cup's four tracks open into — four tiles
  // in a row, each a "?" square where a schematic would sit, so swapping a cup
  // for Random moves nothing on the phone. Where a cup panel asks WHICH track,
  // this one asks WHAT KIND OF RUN: the tour (the tile's default, so it leads),
  // then the two lengths and endless.
  if (randomFamily) {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
    panel.style.background = towardWhite(NEUTRAL_COLOR, PANEL_TINT);
    const tgrid = document.createElement('div');
    tgrid.className = 'trackpick__grid';
    const qTile = ({ label, glyph, mine, onTap }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'track-opt' + (mine ? ' track-opt--mine' : '');
      if (mine) {
        btn.setAttribute('aria-current', 'true');
        btn.style.background = towardWhite(NEUTRAL_COLOR, PICK_TINT);
      }
      btn.setAttribute('aria-label', label);
      btn.disabled = !canPick;
      const box = document.createElement('span');
      box.className = 'track-map track-map--q';
      box.style.background = towardWhite(NEUTRAL_COLOR, FIELD_TINT);
      if (glyph) {
        const g = document.createElement('span');
        g.textContent = glyph;
        box.appendChild(g);
      } else {
        // No glyph = the tour's ring, DRAWN rather than typed: no circle
        // codepoint matches the ∞'s ink weight across the fonts phones fall
        // back to, so the theme draws one that does (.track-map--q > i).
        box.appendChild(document.createElement('i'));
      }
      btn.appendChild(box);
      const lab = document.createElement('span');
      lab.className = 'track-opt__name';
      lab.textContent = label;
      btn.appendChild(lab);
      if (canPick && onTap) btn.addEventListener('click', onTap);
      return btn;
    };
    tgrid.appendChild(qTile({
      // No glyph: the tour wears the drawn ring — a plain circle in the same
      // ink family as ? and ∞, where the globe emoji clashed with the sticker
      // look and rendered differently on every phone.
      label: TOUR_LABEL,
      mine: sel.mode === 'tour',
      onTap: () => pick({ mode: 'tour' })
    }));
    for (const o of randomLengths()) {
      tgrid.appendChild(qTile({
        label: o.label, glyph: o.glyph,
        mine: sel.mode === 'random' && randomRaces === o.randomRaces,
        onTap: () => pick({ mode: 'random', randomRaces: o.randomRaces })
      }));
    }
    panel.appendChild(tgrid);
    stripEl.appendChild(panel);
  }

  const openCup = expanded != null ? byCup.get(expanded) : null;
  if (openCup) {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
    // The cup's colour, and the panel is the only place it shows when the pick is one
    // of the TRACKS (that hands the mark down, leaving the cup tile white) — so this
    // wash is what ties the four tracks back to the cup they belong to. Pitched between
    // the white tiles on it and the louder fill of the picked one.
    panel.style.background = cupTint(openCup.id, PANEL_TINT);
    const tgrid = document.createElement('div');
    tgrid.className = 'trackpick__grid';
    for (const t of openCup.items) {
      tgrid.appendChild(trackTile(t, sel.mode === 'track' && t.id === sel.trackId, canPick,
        (id) => pick({ mode: 'track', trackId: id })));
    }
    panel.appendChild(tgrid);
    stripEl.appendChild(panel);
  }
}
