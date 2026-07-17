// Mode picker UI — how the host picks what to race: 🎲 Random (an endless run
// of display-drawn tracks), a Cup (its 4 tracks back-to-back as a Grand Prix),
// or — from the panel a picked cup opens — one exact track (single race). Five
// compact tiles instead of the old 16-tile strip, so the lobby never scrolls. Rendered
// from the schematic catalog the display ships in WELCOME (each entry carries
// its cup + a top-down SVG path; see display/trackSchematic.js). Only the HOST
// picks, so `canPick` gates the taps — read-only rendering is for the gallery.

const SVGNS = 'http://www.w3.org/2000/svg';

// Each cup owns a COLOUR. Every cup tile wears its own all the time — the picker is a
// colour-coded set — and the PICKED one wears it loud: same hue, turned up. So colour
// says which cup, and intensity says which is picked. That's the lobby's existing
// idiom, not a new one: the car strip right above marks your pick by tinting it toward
// your livery and dropping a hard shadow under it (.car-opt--mine). Reusing it keeps
// the two rows speaking one language, and it needs no chrome colour of its own — a
// green ring said "green" louder than it said "picked", and fought the cup colour
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
// instead, one per cup: each is the paper-legible relative of what that biome looks
// like, except where the theme's own chrome rules forbid it (see rooftop). Keep them
// far apart in hue — telling one cup from another is the only job they have.
const CUP_COLOR = {
  beach:    '#E0C070',  // wet sand
  snow:     '#7FB2DC',  // ice blue — the biome's own white can't survive a paper mix
  backyard: '#7FBF63',  // lawn green
  canyon:   '#C4713F',  // terracotta; kept dark + dull so it can't be read as playroom
  // The toy box, NOT the orange plastic deck the biome is built from: pale red is
  // pink, and pink is vetoed in chrome. Purple is sanctioned (--purple, the item
  // colour), unclaimed by the other four, and still reads as a toy block.
  rooftop:  '#A259E6'
};
const CUP_COLOR_FALLBACK = CUP_COLOR.backyard;  // cup-less catalog: the old default green
// Random belongs to no cup, so it has no colour to turn up — a warm grey stands in,
// which is honest: "any biome" isn't one of them.
const NEUTRAL_COLOR = '#8C8398';

// How much colour a surface wears; `pct` is how much survives a mix with white.
// The ladder is the whole selection language, so the steps have to stay far apart:
const IDENT_TINT = 26;  // a cup tile at rest: enough to name the cup, quiet enough to ignore
const PANEL_TINT = 45;  // the open cup's track panel: a surface BEHIND cards, so deeper than one
const PICK_TINT  = 72;  // the pick: the same hue turned up loud. Nothing else in the picker is
export const FIELD_TINT = 26;  // exported: the display's cup slot paints the same minis

// Exported alongside schematicSvg: the display's cup slot tints its minis the same
// way, so the two surfaces can't drift.
export function cupTint(cupId, pct) {
  const c = CUP_COLOR[cupId] || CUP_COLOR_FALLBACK;
  return `color-mix(in srgb, ${c} ${pct}%, #fff)`;
}

// Build one schematic <svg>: a wide casing path under a narrower road path (the
// toy "track ribbon" look) plus a dot at the start/finish line. `fieldTint` (a CSS
// colour) paints the field behind the ribbon; omit to keep the CSS default.
// Exported: the display's lobby cup slot renders the same minis (renderCupSlot).
export function schematicSvg(svg, fieldTint) {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', svg.viewBox || '0 0 100 100');
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
      dot.setAttribute('r', '5');
      dot.setAttribute('class', 'track-map__start');
      el.appendChild(dot);
    }
  }
  return el;
}

// One exact-track tile (inside an open cup's panel): schematic + name. Picked, it
// fills with its cup's colour turned up — the same mark a picked cup tile wears, so
// "picked" looks identical wherever it lands. At rest it stays a plain white card:
// unlike a cup tile it doesn't need to announce its cup, because the cup-coloured
// panel it's sitting on already did. Difficulty is never badged per track — only the
// cup's tendency meter (cupMeter) hints at it.
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
// `tint` is the fill, and the caller has already resolved it: the cup's colour quiet
// at rest, loud when picked. Exactly ONE thing in the picker is ever `mine` — pick a
// track and its cup hands the mark down to it.
function modeTile({ label, glyph, sub, meter, mine, tint, canPick, onTap }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-opt' + (mine ? ' mode-opt--mine' : '');
  if (tint) btn.style.background = tint;
  if (mine) btn.setAttribute('aria-current', 'true');
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
//   selection : {mode:'track'|'cup'|'random', trackId?, cupId?} | null (nothing picked)
//   canPick   : whether taps are live (host only)
//   onPickMode: ({mode, trackId?, cupId?}) => void — also fired by a re-tap on
//               Random (the display re-rolls the draw), so don't filter it here.
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

  const grid = document.createElement('div');
  grid.className = 'modepick';

  const randomMine = sel.mode === 'random';
  grid.appendChild(modeTile({
    label: 'Random', glyph: '🎲', sub: 'endless',
    // Bare paper at rest — with no cup, there's no colour to name it by. Picked, it
    // takes the neutral grey so it still wears the same loud-fill mark as the cups.
    mine: randomMine,
    tint: randomMine ? `color-mix(in srgb, ${NEUTRAL_COLOR} ${PICK_TINT}%, #fff)` : null,
    canPick,
    onTap: () => pick({ mode: 'random' })  // re-tap re-rolls — deliberately not filtered
  }));

  for (const g of groups) {
    // A cup is picked only when the CUP itself is the pick. Picking one of its tracks
    // hands the mark down to that track tile and drops this one back to its resting
    // tint — the panel standing open below is what shows where the pick came from, so
    // the cup neither needs nor should wear a mark of its own.
    const mine = sel.mode === 'cup' && sel.cupId === g.id;
    grid.appendChild(modeTile({
      label: g.name, sub: `${g.items.length} races`,
      meter: g.diff != null ? cupMeter(g.diff) : null,
      mine,
      tint: cupTint(g.id, mine ? PICK_TINT : IDENT_TINT),
      canPick,
      onTap: () => pick({ mode: 'cup', cupId: g.id })
    }));
  }
  stripEl.appendChild(grid);

  const openCup = expanded != null ? byCup.get(expanded) : null;
  if (openCup) {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
    // Same tint as its cup tile above: the two read as one block of that cup's colour,
    // which is what ties the open panel back to the cup it belongs to. The track tiles
    // sitting on it keep their own (paler) schematic fields legible.
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
