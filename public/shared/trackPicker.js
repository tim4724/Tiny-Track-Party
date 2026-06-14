// Track picker UI — schematic "map" thumbnails of each track, shown in the
// controller lobby as a tap strip (each tile a top-down map + name). The display
// ships a catalog of pre-computed SVG paths (see display/trackSchematic.js) in
// WELCOME; here we render them. Only the HOST changes the track, so `canPick`
// gates the taps — everyone else sees the strip read-only with the pick ringed.

const SVGNS = 'http://www.w3.org/2000/svg';

// Build one schematic <svg>: a wide casing path under a narrower road path (the
// toy "track ribbon" look) plus a dot at the start/finish line.
function schematicSvg(svg) {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', svg.viewBox || '0 0 100 100');
  el.setAttribute('class', 'track-map');
  el.setAttribute('aria-hidden', 'true');
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

// One map tile: schematic + name, ringed when it's the pick. Difficulty is shown
// per-cup as a tendency meter (see cupMeter), not badged on each track.
function trackTile(t, mine, canPick, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'track-opt' + (mine ? ' track-opt--mine' : '');
  if (mine) btn.setAttribute('aria-current', 'true');
  btn.setAttribute('aria-label', t.name);
  btn.disabled = !canPick;
  btn.appendChild(schematicSvg(t.svg || {}));
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

// Render the picker, one labelled section per cup.
//   stripEl : container for the cup sections
//   catalog : [{ id, name, svg, cup?, cupName?, cupDifficulty? }] (from the display)
//   selected: current track id (null = nothing ringed)
//   canPick : whether taps are live (host only)
//   onPick  : (id) => void
// Entries with no `cup` collapse into a single unlabelled group (older display / gallery),
// so the picker still renders if the catalog predates cups.
export function buildTrackPicker({ stripEl, catalog, selected, canPick, onPick }) {
  const list = catalog || [];
  const selId = list.some((t) => t.id === selected) ? selected : null; // null = nothing ringed
  if (!stripEl) return;
  stripEl.innerHTML = '';

  // Group by cup, preserving the catalog's (cup-ordered) sequence.
  const groups = [];
  const byCup = new Map();
  for (const t of list) {
    const key = t.cup || '';
    let g = byCup.get(key);
    if (!g) { g = { name: t.cupName || '', diff: t.cupDifficulty, items: [] }; byCup.set(key, g); groups.push(g); }
    g.items.push(t);
  }

  for (const g of groups) {
    const cup = document.createElement('div');
    cup.className = 'trackpick__cup';
    if (g.name) {
      const head = document.createElement('div');
      head.className = 'trackpick__cup-head';
      const name = document.createElement('span');
      name.className = 'trackpick__cup-name';
      name.textContent = g.name;
      head.appendChild(name);
      if (g.diff != null) head.appendChild(cupMeter(g.diff));
      cup.appendChild(head);
    }
    const grid = document.createElement('div');
    grid.className = 'trackpick__grid';
    g.items.forEach((t) => grid.appendChild(trackTile(t, t.id === selId, canPick, onPick)));
    cup.appendChild(grid);
    stripEl.appendChild(cup);
  }
}
