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

// Render the picker.
//   stripEl : container for the tap tiles
//   catalog : [{ id, name, svg }] (from the display)
//   selected: current track id (null = nothing ringed)
//   canPick : whether taps are live (host only)
//   onPick  : (id) => void
export function buildTrackPicker({ stripEl, catalog, selected, canPick, onPick }) {
  const list = catalog || [];
  const selId = list.some((t) => t.id === selected) ? selected : null; // null = nothing ringed

  if (stripEl) {
    stripEl.innerHTML = '';
    list.forEach((t) => {
      const mine = t.id === selId;
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
      stripEl.appendChild(btn);
    });
  }
}
