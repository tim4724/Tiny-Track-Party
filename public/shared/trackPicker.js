// Mode picker UI — how the host picks what to race: 🎲 Random (one race on a
// display-drawn track), a Cup (its 4 tracks back-to-back as a Grand Prix), or —
// from the panel a picked cup opens — one exact track (single race). Five big
// tiles instead of the old 16-tile strip, so the lobby never scrolls. Rendered
// from the schematic catalog the display ships in WELCOME (each entry carries
// its cup + a top-down SVG path; see display/trackSchematic.js). Only the HOST
// picks, so `canPick` gates the taps — read-only rendering is for the gallery.

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

// One big mode tile (🎲 Random or a cup). `body` fills the art slot (die glyph /
// 2×2 mini-maps); `open` marks the cup whose exact-track panel is showing while
// the ring sits on a track tile below it.
function modeTile({ label, sub, body, meter, mine, open, canPick, onTap }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-opt' + (mine ? ' mode-opt--mine' : open ? ' mode-opt--open' : '');
  if (mine) btn.setAttribute('aria-current', 'true');
  btn.setAttribute('aria-label', label);
  btn.disabled = !canPick;
  btn.appendChild(body);
  const lab = document.createElement('span');
  lab.className = 'mode-opt__name';
  lab.textContent = label;
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

  const die = document.createElement('span');
  die.className = 'mode-opt__die';
  die.textContent = '🎲';
  die.setAttribute('aria-hidden', 'true');
  grid.appendChild(modeTile({
    label: 'Random', sub: '1 race', body: die,
    mine: sel.mode === 'random', open: false, canPick,
    onTap: () => pick({ mode: 'random' })  // re-tap re-rolls — deliberately not filtered
  }));

  for (const g of groups) {
    const maps = document.createElement('span');
    maps.className = 'mode-opt__maps';
    maps.setAttribute('aria-hidden', 'true');
    for (const t of g.items.slice(0, 4)) maps.appendChild(schematicSvg(t.svg || {}));
    grid.appendChild(modeTile({
      label: g.name, sub: `${g.items.length} races`, body: maps,
      meter: g.diff != null ? cupMeter(g.diff) : null,
      mine: sel.mode === 'cup' && sel.cupId === g.id,
      open: expanded === g.id, canPick,
      onTap: () => pick({ mode: 'cup', cupId: g.id })
    }));
  }
  stripEl.appendChild(grid);

  const openCup = expanded != null ? byCup.get(expanded) : null;
  if (openCup) {
    const panel = document.createElement('div');
    panel.className = 'modepick__tracks';
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
