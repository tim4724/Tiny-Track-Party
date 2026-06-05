// Track gallery — one card per named track, each an iframe loading the real
// display in track-preview mode (/?test=1&scenario=track&track=<id>): the whole
// layout under a slowly orbiting overview camera with a small AI field driving
// it. Reuses the shared Gallery helpers (card factory, lazy mount, AR scaling).
//
// This is an ES module (so it can import the track catalogue directly) but it
// still leans on the classic-script `window.Gallery` loaded just before it.
import { TRACKS, TRACK_ORDER } from '/shared/tracks.js';

const Gallery = window.Gallery;
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

  const strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.trackCardsPerRow);

  allCards = [];
  const d = dims();
  for (const id of TRACK_ORDER) {
    const t = TRACKS[id];
    if (!t) continue;
    const card = Gallery.makeCard({
      title: t.name,
      tag: t.difficulty || '',
      frameClass: 'display',
      logical: d,
      url: cardURL(id)
    });
    // colour-code the difficulty chip and drop the blurb under the preview.
    const tagEl = card.querySelector('.card-title .tag');
    if (tagEl && t.difficulty) tagEl.classList.add('diff-' + t.difficulty.toLowerCase());
    if (t.blurb) {
      const blurb = document.createElement('p');
      blurb.className = 'track-blurb';
      blurb.textContent = t.blurb;
      card.appendChild(blurb);
    }
    strip.appendChild(card);
    allCards.push(card);
  }
  host.appendChild(strip);
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
