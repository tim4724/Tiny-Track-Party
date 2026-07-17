// Mode picker UI — how the host picks what to race: 🎲 Random (an endless run
// of display-drawn tracks), a Cup (its 4 tracks back-to-back as a Grand Prix),
// or — from the panel a picked cup opens — one exact track (single race). Five
// compact tiles instead of the old 16-tile strip, so the lobby never scrolls. Rendered
// from the schematic catalog the display ships in WELCOME (each entry carries
// its cup + a top-down SVG path; see display/trackSchematic.js). Only the HOST
// picks, so `canPick` gates the taps — read-only rendering is for the gallery.

import { themeForCup } from './themes.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// How much cup colour the open cup's tile + its track panel wear (see biomeTint).
// Both wear the SAME value so the tile and the panel under it read as one block of
// that cup's colour. It sits well ABOVE the schematic field's 26%: the panel has to
// hold its own against the near-white paper it's stamped on, while the field only
// has to tint the inside of a white tile that already has its own ink outline. The
// tiles then read as light cards ON the panel, which is the depth order we want.
const PANEL_TINT = 45;

// The picker themes each cup by its biome so a panel reads at a glance as grass /
// sand / desert / toy-box. The hue comes from the biome's first horizon-hill colour
// (grass green, beach sand, canyon terracotta, playroom block-red) — the same source
// of truth the 3D world themes from, so the two can't drift. Cups with no biome fall
// back to grass (the canonical pale green, matching the old default).
//
// Those colours are picked for their job on a 3D horizon, not for legibility on
// paper, so we CLAMP them into a range that survives a white mix — but only at the
// ends, and never the hue. Snow's hill colour is #EEF4F9, white in all but name:
// mixed onto the near-white paper it vanished at any strength, which is what made an
// open cup's track panel so hard to see. The lightness cap plus the saturation floor
// turn it into a pale but unmistakable blue. Everything else keeps its own weight,
// deliberately: canyon (hue 21°) and playroom (hue 7°) are only 14° apart, so it is
// canyon's DARKER, duller terracotta against playroom's hot salmon that tells the two
// cups apart. Normalising them to a common lightness collapses them into the same
// pink — tried, and worse than the problem it solved. `pct` is how much of the
// clamped colour survives the mix: ~26% for the schematic FIELD (the ground the
// ribbon sits on), PANEL_TINT for the open cup's tile + panel.
// Exported alongside schematicSvg: the display's cup slot tints its minis the same
// way, so the two surfaces can't drift.
const TINT_SAT_FLOOR = 0.5;   // below this a biome mixes down to grey paper, not a colour
const TINT_LIGHT_CAP = 0.72;  // above this it mixes down to plain paper (snow's problem)

export function biomeTint(cupId, pct) {
  const [h, s, l] = rgbToHsl(themeForCup(cupId).hills[0] >>> 0);
  const sat = Math.max(s, TINT_SAT_FLOOR) * 100;
  const light = Math.min(l, TINT_LIGHT_CAP) * 100;
  return `color-mix(in srgb, hsl(${h.toFixed(1)}deg ${sat.toFixed(1)}% ${light.toFixed(1)}%) ${pct}%, #fff)`;
}

// 0xRRGGBB -> [hue °, saturation 0..1, lightness 0..1].
function rgbToHsl(int) {
  const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6)
          : max === g ? 60 * ((b - r) / d + 2)
          :             60 * ((r - g) / d + 4);
  return [(h + 360) % 360, s, l];
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

// One exact-track tile (inside an open cup's panel): schematic + name, ringed
// when it's the pick. Difficulty is never badged per track — only the cup's
// tendency meter (cupMeter) hints at it.
function trackTile(t, mine, canPick, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'track-opt' + (mine ? ' track-opt--mine' : '');
  if (mine) btn.setAttribute('aria-current', 'true');
  btn.setAttribute('aria-label', t.name);
  btn.disabled = !canPick;
  btn.appendChild(schematicSvg(t.svg || {}, biomeTint(t.cup, 26)));
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
// Two independent signals, never conflated: the FILL is the cup's biome colour and
// says "this cup's panel is open below" (`tint`), while the green RING says "this is
// the pick" (`mine`) — the same ring the track tiles use, so one selected look covers
// every option. A cup open for an exact pick is tinted but unringed; the ring is on
// the track tile inside it.
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
//   selection : {mode:'track'|'cup'|'random', trackId?, cupId?} | null (nothing ringed)
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

  grid.appendChild(modeTile({
    // Random draws from every biome, so it has no cup colour to wear: bare paper + the ring.
    label: 'Random', glyph: '🎲', sub: 'endless',
    mine: sel.mode === 'random', canPick,
    onTap: () => pick({ mode: 'random' })  // re-tap re-rolls — deliberately not filtered
  }));

  for (const g of groups) {
    grid.appendChild(modeTile({
      label: g.name, sub: `${g.items.length} races`,
      meter: g.diff != null ? cupMeter(g.diff) : null,
      mine: sel.mode === 'cup' && sel.cupId === g.id,
      tint: expanded === g.id ? biomeTint(g.id, PANEL_TINT) : null,
      canPick,
      onTap: () => pick({ mode: 'cup', cupId: g.id })
    }));
  }
  stripEl.appendChild(grid);

  const openCup = expanded != null ? byCup.get(expanded) : null;
  if (openCup) {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
    // Same tint as the cup tile above it: the two read as one block of that cup's
    // colour, which is what says "these are that cup's tracks". The white track
    // tiles sitting on it keep their own (stronger) schematic fields legible.
    panel.style.background = biomeTint(openCup.id, PANEL_TINT);
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
