// Track gallery — one SECTION per cup, each card an iframe loading the real display
// in track-preview mode (/?scenario=track&track=<id>): the whole layout under a
// slowly orbiting overview camera with a small AI field driving it (+ the live
// minimap).
//
import { TRACKS, CUPS } from '/shared/tracks.js';

import * as Gallery from './gallery-common.js';
const state = Gallery.loadState();

// Tracks use their own columns key so this page doesn't clobber the display /
// controller galleries' layout preference. Tracks render wide (16:9) → 2 up.
const TRACK_DEFAULT_COLS = 2;
const TRACK_MAX_COLS = 4;
const storedCols = parseInt(state.trackCardsPerRow, 10);
state.trackCardsPerRow = Math.max(1, Math.min(storedCols || TRACK_DEFAULT_COLS, TRACK_MAX_COLS));
state.showCenterline = !!state.showCenterline;

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

function cardURL(id) {
  return Gallery.displayURL(state, 'track', {
    track: id,
    centerline: state.showCenterline ? 1 : undefined // qs() drops undefined → omitted when off
  });
}

let allCards = [];
let lazyIo = null;

function render() {
  Gallery.resetQueue();
  if (lazyIo) { lazyIo.disconnect(); lazyIo = null; }
  for (const c of allCards) if (c._destroy) c._destroy();
  const host = document.getElementById('track-rows');
  host.innerHTML = '';

  allCards = [];
  const d = dims();
  const addCard = (strip, id, name, tag) => {
    const card = Gallery.makeCard({
      title: name,
      tag,
      frameClass: 'display',
      logical: d,
      url: cardURL(id),
      animated: true // every track preview is a slowly orbiting turntable
    });
    strip.appendChild(card);
    allCards.push(card);
  };

  for (const cup of CUPS) {
    const h = document.createElement('h2');
    h.className = 'rail-title';
    h.textContent = cup.name;
    host.appendChild(h);

    const strip = document.createElement('div');
    strip.className = 'scenario-strip';
    strip.style.setProperty('--row-cols', state.trackCardsPerRow);
    for (const id of cup.tracks) if (TRACKS[id]) addCard(strip, id, TRACKS[id].name, '· shipped');
    host.appendChild(strip);
  }
  lazyIo = Gallery.lazyMount(allCards);
}

// AR change only affects frame geometry — re-layout existing cards in place.
function updateDims() {
  const d = dims();
  for (const c of allCards) if (c._applyDims) c._applyDims(d, 0);
}
function updateLayout() {
  document.querySelectorAll('.scenario-strip')
    .forEach((s) => s.style.setProperty('--row-cols', state.trackCardsPerRow));
}

Gallery.bindSelect(state, 'display-ar', 'displayAR', updateDims);
Gallery.bindSelect(state, 'cards-per-row', 'trackCardsPerRow', updateLayout, (v) =>
  Math.max(1, Math.min(parseInt(v, 10) || TRACK_DEFAULT_COLS, TRACK_MAX_COLS)));
// Centerline toggle changes the iframe URL (?centerline=…) → rebuild the cards.
Gallery.bindCheckbox(state, 'show-centerline', 'showCenterline', render);

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
