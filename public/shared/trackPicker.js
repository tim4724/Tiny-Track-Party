// Mode picker UI — ONE grid of tiles, one per race the host can start: the five
// cups (each runs its four tracks back-to-back as a Grand Prix) and then the
// three random runs — the World Tour, a fixed card, or endless. Tap a tile, tap
// Start; there is nothing to open and nothing to drill into.
//
// It used to be a two-column browser: a list of cups on the left and a detail
// panel on the right offering the four tracks inside the open cup as EXACT
// single-race picks. The exact pick is gone and the panel went with it. The
// phone is a controller — it is held at arm's length, in a room where the
// interesting screen is the television — and a browse-then-choose page is more
// page than that hand has any use for. What a cup runs is the cup's business,
// and the TV shows it.
//
// Rendered from the schematic catalog in the display's retained LOBBY_UPDATE snapshot (each entry carries
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
// EXPORTED for the same reason CUP_COLOR is: a native TV shell draws this tile
// too, and it reads the wash back through `ttp_ui_neutral_tint_rgb` rather than
// re-typing the hex. Note it is NOT `CUP_COLOR_FALLBACK` — that one stands in for
// an UNKNOWN cup id and is a cup colour; this one is for a selection that belongs
// to no cup at all. Painting Random with the fallback dressed it in the Backyard
// cup's lawn green, which is the one thing "any biome" must not look like.
export const NEUTRAL_COLOR = '#8C8398';

// The run-length manifest (protocol.js RANDOM_RACES). Read at RENDER time, which
// makes it browser-only by construction — this module is imported by Node too
// (`gen-track-defs-header.mjs` and `tests/ui-model.test.js` read the cup colours
// out of it) and protocol.js is a classic script that publishes onto `window`,
// which those importers do not have. A missing manifest says so rather than
// yielding undefined.
const randomManifest = () => {
  const m = globalThis.RANDOM_RACES;
  if (!m) throw new Error('trackPicker: protocol.js must be loaded before the picker renders');
  return m;
};

// THE THREE RANDOM RUNS, which sit on the grid beside the cups as three tiles of
// their own. `randomRaces: 0` is endless (no last race; only a lobby return ends
// it); any other count is a fixed card drawn up front, which means points, a
// final race and a podium — a Grand Prix out of tracks nobody chose. The World
// Tour draws one track from EVERY unlocked cup, raced in the cups' own
// difficulty order, and carries no knobs at all: `{mode:'tour'}` is the pick.
//
// They were tiles in a PANEL until this pass, behind a single 🎲 Random row: the
// run length was a knob you had to open Random to find, and it sold the
// manifest's MAX as a fourth card beside these three. A length is not a mode,
// and a controller should not have a settings drawer in it — the three shapes
// worth telling apart are "a sampler", "a card" and "forever", and each is now
// one tap from the lobby. MAX went with the drawer; it stays the wire's ceiling
// (protocol.js RANDOM_RACES, clamped in selectModeWalk) and is no longer a
// choice the picker sells.
//
// A FUNCTION, not a const, for the reason `randomManifest` above is one.
//
// THE LENGTH IS THE MANIFEST'S and the label is built from the same number that
// sets it. The card was once a bare `4` here while the pick read
// RANDOM_RACES.DEFAULT — the two ends of one value in ONE file, disagreeing the
// moment the manifest moved.
// No 🎲 in any of it, though these three were one "🎲 Random" row before. The
// tile's trail is the row a cup fills with STARS, and an emoji glyph is taller
// than a star row on every platform that has one — so a dice here lifted the
// name above its neighbours' and the grid read as ragged
// (tests/e2e/lobby-tile-grid.spec.js measures exactly that). It is not needed:
// the grey these three wear IS "belongs to no cup", single-sourced with the
// display's own unknown-cup chips (NEUTRAL_COLOR), and they sit together.
const TOUR_LABEL = 'World Tour';
const randomRuns = () => {
  const m = randomManifest();
  return [
    { key: 'tour', label: TOUR_LABEL, sub: 'one per cup', pick: { mode: 'tour' } },
    { key: 'card', label: `${m.DEFAULT} Races`, sub: 'random draw', pick: { mode: 'random', randomRaces: m.DEFAULT } },
    { key: 'endless', label: 'Endless Run', sub: 'random draw', pick: { mode: 'random', randomRaces: 0 } }
  ];
};

// How much colour a surface wears; `pct` is how much survives a mix with white.
const PICK_TINT  = 72;  // the pick, worn loud
const REST_TINT  = 20;  // every OTHER cup tile: enough colour to name the cup, quiet enough that the pick still shouts
// The schematic's field. Exported, and the one tint here that leaves JS: the
// display's cup slot paints the same minis, and the C++ ui model serves it as
// cupFieldTintPct() — tests/ui-model.test.js pins the two equal.
export const FIELD_TINT = 26;

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
      // No `r` here: `.track-map__start` sets it from --track-map-start-r, so
      // the radius comes from the same place the strokes do (theme.css).
      dot.setAttribute('class', 'track-map__start');
      el.appendChild(dot);
    }
  }
  return el;
}

// The couch's star badge — a row of `max` die-cut stars, `n` of them earned.
// Shared with the display's lobby (theme.css owns the look; stars are RED —
// amber is vetoed in chrome and celebration is red).
export function starRow(n, max = 3) {
  const row = document.createElement('span');
  row.className = 'starrow';
  row.setAttribute('aria-label', `${n} of ${max} stars`);
  for (let i = 0; i < max; i++) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'star' + (i < n ? '' : ' star--off'));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M12 2.6l2.8 5.9 6.3.8-4.6 4.4 1.2 6.3L12 17l-5.7 3 1.2-6.3L2.9 9.3l6.3-.8z');
    s.appendChild(p);
    row.appendChild(s);
  }
  return row;
}

// A drawn padlock (no emoji: platform lock glyphs are coloured and clash with
// the sticker ink). Shared with the display's shelf, like starRow.
export function lockGlyph() {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'lock-glyph');
  s.setAttribute('aria-hidden', 'true');
  const shackle = document.createElementNS(SVGNS, 'path');
  shackle.setAttribute('d', 'M7 11V8a5 5 0 0 1 10 0v3');
  const body = document.createElementNS(SVGNS, 'rect');
  body.setAttribute('x', '5'); body.setAttribute('y', '10.5');
  body.setAttribute('width', '14'); body.setAttribute('height', '10.5');
  body.setAttribute('rx', '2.6');
  s.appendChild(shackle);
  s.appendChild(body);
  return s;
}

// One TILE of the grid: the name over its trail (stars for a cup, the run's
// shape for a random tile, unlock progress for a locked cup).
//
// Split into BUILD and DRESS on purpose. The whole picker used to be rebuilt
// from scratch on every render, which meant the tile you were pressing was
// destroyed by its own tap — the :active press never got to play, so the cups
// were the one control on the page that did not answer a touch. Now the tiles
// are built once per catalogue and re-dressed in place, exactly as the car
// strip does it (shared/carPicker.js), so the element you press outlives the
// press.
function buildTile(label, locked) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-opt';
  btn.setAttribute('aria-label', label);
  if (locked) btn.appendChild(lockGlyph());
  const lab = document.createElement('span');
  lab.className = 'mode-opt__name';
  // SET as two lines, not wrapped into them: the last word goes below the rest,
  // so every cup reads "<Biome>" over "Cup" and the six tiles are one shape.
  // Left to wrap, the short names sat on one line and the long ones on two, and
  // the grid read as ragged however it was aligned. The tile reserves the second
  // line either way (controller.css .mode-opt), so this costs no height.
  // aria-label on the button carries the name unbroken.
  const cut = label.lastIndexOf(' ');
  // The space stays IN the text (a trailing space before a break renders as
  // nothing), so the tile still reads "Beach Cup" to a text search — dropping it
  // gave "BeachCup", which every by-text locator in the suite stopped matching.
  if (cut > 0) lab.append(label.slice(0, cut + 1), document.createElement('br'), label.slice(cut + 1));
  else lab.textContent = label;
  btn.appendChild(lab);
  return btn;
}

// Everything that changes without changing the tile's SHAPE: which mark it
// wears, what its trail says, and what a tap does. `mine` marks the current pick
// with its own colour.
function dressTile(btn, { trail, locked, mine, tint, pickTint, canPick, onTap }) {
  btn.classList.toggle('mode-opt--mine', !!mine);
  btn.classList.toggle('mode-opt--locked', !!locked);
  // EVERY tile wears its cup's colour, so the grid reads as the ladder it is
  // rather than six identical white cards. That means the fill can no longer BE
  // the pick mark the way it was when only one tile had one — the mark is now
  // the STEP UP in the same hue, PICK_TINT against REST_TINT, which is a
  // stronger signal than a colour/no-colour split and keeps a cup one colour
  // wherever it appears. A locked cup takes no fill at all: it is not a choice.
  btn.style.background = locked ? '' : (mine ? pickTint : tint) || '';
  if (mine) btn.setAttribute('aria-current', 'true');
  else btn.removeAttribute('aria-current');
  btn.disabled = !canPick;
  // The padlock rides INSIDE the trail, not beside it: the tile centres its
  // content, and a padlock in a column of its own centred the count without it.
  // It is built once (buildTile) and re-homed here, because the trail element
  // itself is replaced on every dress.
  const old = btn.querySelector('.starrow, .mode-opt__sub');
  const lock = btn.querySelector('.lock-glyph');   // may be inside `old`
  if (old) old.remove();
  if (trail) {
    if (lock) trail.insertBefore(lock, trail.firstChild);
    btn.appendChild(trail);
  } else if (lock) btn.appendChild(lock);
  btn.onclick = (canPick && onTap) ? onTap : null;
}

const subSpan = (text) => {
  const s = document.createElement('span');
  s.className = 'mode-opt__sub';
  s.textContent = text;
  return s;
};

// What the badges mean, as a quiet key in the page's TOP RIBBON: one star for
// finishing the cup, two for a top-3 human, three for a win. Built once and
// never touched again — the stars mean the same thing whatever is picked.
function starLegend() {
  const legend = document.createElement('div');
  legend.className = 'star-legend';
  for (const [n, word] of [[1, 'finish'], [2, 'top 3'], [3, 'win']]) {
    const item = document.createElement('span');
    item.className = 'star-legend__item';
    item.appendChild(starRow(n));
    const t = document.createElement('span');
    t.textContent = word;
    item.appendChild(t);
    legend.appendChild(item);
  }
  return legend;
}

// Render the picker into `gridEl` — ONE grid of tiles, nothing under it. Each
// tile is a race the host can start: the cups in ladder order (each runs its own
// 4-race Grand Prix, the locked one in place and unpickable), then the three
// random runs.
//   keyEl     : where the star key goes — the page's top ribbon, filled once
//   catalog   : [{ id, name, svg, cup, cupName, cupDifficulty }] (from the display)
//   progress  : the snapshot's progress key — {cups:[{id,stars,locked,
//               unlockDone?,unlockNeed?}]} | null (absent = a
//               fresh couch drawn starless and nothing locked phone-side; the
//               display enforces the real lock either way)
//   selection : {mode:'cup'|'random'|'tour', cupId?, randomRaces?} | null
//   canPick   : whether taps are live (host only)
//   onPickMode: ({mode, cupId?, randomRaces?}) => void — every random-family tap
//               fires, same pick or not: each one deals fresh track(s) on the
//               display, so don't filter them.
export function buildModePicker({ gridEl, keyEl, catalog, progress, selection,
                                  canPick, onPickMode }) {
  if (!gridEl) return;
  // This runs on EVERY room snapshot push (any player's car pick or ready
  // toggle re-renders the host's lobby), so skip when nothing it renders
  // changed. By value: the snapshot re-sends the catalogue as a fresh object
  // each push. Same signature-guard idiom as buildCarPicker.
  const sig = JSON.stringify([catalog, progress, selection, !!canPick]);
  if (gridEl.dataset.sig === sig) return;
  gridEl.dataset.sig = sig;
  // NOTHING here is torn down and rebuilt. Keeping the pressed ELEMENT alive was
  // not enough: the tiles used to be carried across a `gridEl.innerHTML = ''`,
  // and that momentary DETACH cancels the running :active transition outright —
  // measurably, the tile emitted transitionstart then transitioncancel and never
  // restarted, so a tap on a cup was the one tap on this page that answered
  // nothing. The grid and the foot now stay attached across every render.
  //
  // The general rule this is an instance of: a re-render is driven by a room
  // snapshot arriving, which is to say by the network, at a moment the player's
  // finger is on the glass. So a render may only ever DRESS what is already
  // there. Rebuilding is a visible interruption of the player's own input.
  const list = catalog || [];
  const sel = selection || {};
  const pick = (m) => onPickMode && onPickMode(m);

  // Group by cup, preserving the catalog's (cup-ordered) sequence. A track with
  // no cup cannot be raced from here at all — the exact-track pick was this
  // picker's only way to name one, and every shipped track belongs to a cup.
  const groups = [];
  const byCup = new Map();
  for (const t of list) {
    if (!t.cup) continue;
    let g = byCup.get(t.cup);
    if (!g) { g = { id: t.cup, name: t.cupName || t.cup, items: [] }; byCup.set(t.cup, g); groups.push(g); }
    g.items.push(t);
  }

  // The couch's progression, absent-tolerant: a fresh couch draws starless.
  const progressCups = (progress && progress.cups) || [];
  const progressOf = (id) => progressCups.find((c) => c.id === id) || null;
  const lockedOf = (id) => { const p = progressOf(id); return !!(p && p.locked); };
  const starsOf = (id) => { const p = progressOf(id); return p ? p.stars : 0; };

  // The length a random pick is CURRENTLY at. A selection with no length at all
  // (a phone whose stored pick predates them) takes the default, so 0 has to be
  // tested for rather than falsy-checked — it's endless, not "unset".
  const randomRaces = Number.isInteger(sel.randomRaces) ? sel.randomRaces : randomManifest().DEFAULT;

  // ---- the tiles --------------------------------------------------------------
  // Descriptors first, DOM second: the tiles' shape (how many, what they are
  // called, which is locked) is what decides whether the grid can be reused, and
  // everything else is dressing applied to whatever is already there.
  const tiles = groups.map((g) => {
    const locked = lockedOf(g.id);
    const p = progressOf(g.id);
    return {
      key: g.id, label: g.name, locked,
      // A locked tile trails its unlock progress; an open one its stars.
      trail: () => (locked ? subSpan(`${(p && p.unlockDone) || 0}/${(p && p.unlockNeed) || 0}`)
        : starRow(starsOf(g.id))),
      mine: !locked && sel.mode === 'cup' && sel.cupId === g.id,
      tint: cupTint(g.id, REST_TINT),
      pickTint: cupTint(g.id, PICK_TINT),
      // A locked cup is not a choice: it takes no tap at all. It used to open an
      // unlock pitch in the detail panel; with the panel gone that pitch is one
      // line in the foot, which needs no tap to read.
      onTap: locked ? null : () => pick({ mode: 'cup', cupId: g.id })
    };
  });
  // The random runs sit AFTER the cups: the cups are the game's own ladder and
  // read in difficulty order, so anything in front of them cut that order in
  // half. Last, they read as what they are — what you reach for once the named
  // cups aren't what you want.
  for (const r of randomRuns()) {
    tiles.push({
      key: r.key, label: r.label, locked: false,
      trail: () => subSpan(r.sub),
      // The endless tile owns length 0 and the card tile owns every other
      // length, rather than the card matching its own number: the display
      // clamps to the manifest's ceiling and could echo a length no tile sells,
      // and an unmarked grid is worse than a tile whose label rounds.
      mine: r.key === 'tour' ? sel.mode === 'tour'
        : sel.mode === 'random' && (r.key === 'endless' ? randomRaces === 0 : randomRaces !== 0),
      // Belonging to no cup, they have no colour of their own — a neutral grey
      // stands in so they still wear the same fill-and-drop mark the cups do.
      tint: towardWhite(NEUTRAL_COLOR, REST_TINT),
      pickTint: towardWhite(NEUTRAL_COLOR, PICK_TINT),
      // Not filtered on the same pick: every random-family tap deals fresh
      // track(s) on the display, which is the whole gesture.
      onTap: () => pick({ ...r.pick })
    });
  }

  // Reuse the existing tiles whenever their shape is unchanged — which is every
  // render that is only a pick moving, i.e. every render a TAP causes. That is
  // what lets the pressed tile outlive its own press.
  const gridSig = JSON.stringify(tiles.map((t) => [t.key, t.label, t.locked]));
  let grid = gridEl.querySelector('.racelist');
  if (!grid || grid.dataset.sig !== gridSig) {
    const fresh = document.createElement('div');
    fresh.className = 'racelist';
    fresh.dataset.sig = gridSig;
    for (const t of tiles) fresh.appendChild(buildTile(t.label, t.locked));
    if (grid) gridEl.replaceChild(fresh, grid); else gridEl.insertBefore(fresh, gridEl.firstChild);
    grid = fresh;
  }
  tiles.forEach((t, i) => dressTile(grid.children[i], { ...t, trail: t.trail(), canPick }));

  // ---- the key ----------------------------------------------------------------
  // Built ONCE into the page's top ribbon and never touched again: the stars
  // mean the same thing whatever is picked, so it is the one thing on this page
  // that is not a function of the room. Up there rather than under the grid
  // because the grid is what the page is for and the ribbon already exists.
  //
  // A prose line explaining how to open the locked cup used to sit beside it.
  // The locked tile already wears a padlock and its own count, which is the
  // whole of what the sentence added, one page-width lower down.
  if (keyEl && !keyEl.firstChild) keyEl.appendChild(starLegend());
}
