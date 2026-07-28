// Mode picker UI — how the host picks what to race: a Cup (its 4 tracks
// back-to-back as a Grand Prix), 🎲 Random (a run of display-drawn tracks,
// endless or a fixed card), or — from the panel a picked cup opens — one exact
// track (single race). Six
// compact tiles instead of the old 16-tile strip, so the lobby never scrolls. Rendered
// from the schematic catalog the display ships in WELCOME (each entry carries
// its cup + a top-down SVG path; see display/trackSchematic.js). Only the HOST
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
const CUP_COLOR = {
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
const CUP_COLOR_FALLBACK = CUP_COLOR.backyard;  // cup-less catalog: the old default green
// Random belongs to no cup, so it has no colour to turn up — a warm grey stands in,
// which is honest: "any biome" isn't one of them.
const NEUTRAL_COLOR = '#8C8398';

// How LONG a Random run is, in tile order — the options in the panel Random
// opens, mirroring the exact-track panel a cup opens. `randomRaces: 0` is
// endless (no last race; only a lobby return ends it), any other count is a
// fixed card drawn up front, which means points, a final race and a podium —
// a Grand Prix out of tracks nobody chose.
export const RANDOM_LENGTHS = [
  { randomRaces: 4, label: '4 races', sub: 'then a podium' },
  { randomRaces: 0, label: 'Endless', sub: 'no last race' }
];
// What the tile means on its own — a 4-race card, matching every cup beside it.
// Random used to mean ENDLESS, but a run with no finish line is a strange thing
// to hand a host who just tapped a tile: nothing on screen promises an end, and
// leaving one is a deliberate act. A card ends by itself, on a podium, and the
// panel is one tap away for the party that wants to keep going.
export const RANDOM_DEFAULT_RACES = 4;
const randomSub = (n) => (n ? `${n} races` : 'endless');

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
//   selection : {mode:'track'|'cup'|'random', trackId?, cupId?, randomRaces?} | null
//   canPick   : whether taps are live (host only)
//   onPickMode: ({mode, trackId?, cupId?, randomRaces?}) => void — also fired by a
//               re-tap on Random (the display re-rolls the draw), so don't filter it here.
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

  // The length a Random tap carries: whatever it's already set to, so tapping the
  // tile re-rolls the draw without also resetting the run's shape. A selection
  // with no length at all (a phone whose stored pick predates them) takes the
  // default, so 0 has to be tested for rather than falsy-checked — it's endless,
  // not "unset".
  const randomRaces = sel.mode === 'random' && Number.isInteger(sel.randomRaces)
    ? sel.randomRaces : RANDOM_DEFAULT_RACES;

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
    label: 'Random', glyph: '🎲', sub: randomSub(randomRaces),
    mine: sel.mode === 'random',
    // Belonging to no cup, it has no colour of its own — a neutral grey stands in so it
    // still wears the same fill-and-drop mark the cups do.
    pickTint: towardWhite(NEUTRAL_COLOR, PICK_TINT),
    canPick,
    onTap: () => pick({ mode: 'random', randomRaces })  // re-tap re-rolls — deliberately not filtered
  }));
  stripEl.appendChild(grid);

  // Picked Random opens a panel of its own, in the same slot and the same inset
  // surface a cup's four tracks open into — one panel position, so the picker
  // never grows a second place to look. Where a cup panel asks WHICH track, this
  // one asks HOW LONG.
  if (sel.mode === 'random') {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
    panel.style.background = towardWhite(NEUTRAL_COLOR, PANEL_TINT);
    const opts = document.createElement('div');
    opts.className = 'modepick__opts';
    for (const o of RANDOM_LENGTHS) {
      opts.appendChild(modeTile({
        label: o.label, sub: o.sub,
        mine: randomRaces === o.randomRaces,
        pickTint: towardWhite(NEUTRAL_COLOR, PICK_TINT),
        canPick,
        onTap: () => pick({ mode: 'random', randomRaces: o.randomRaces })
      }));
    }
    panel.appendChild(opts);
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
