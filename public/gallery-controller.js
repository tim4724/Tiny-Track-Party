'use strict';

// Every phone-shaped screen in one flat grid, ordered by the player's journey
// through a real session: name entry -> lobby -> countdown -> drive -> finish.
// perColor cards swap the `color` URL param when the view-as selector changes,
// so the player's own car livery can be previewed across all 8 colors.
//
// Card shape:
//   { key, title, perColor?, url? }
// `url` points the iframe somewhere other than the controller page — the
// device chooser lives on the DISPLAY page but only ever renders phone-sized
// (it's the wrong-link fork), so it previews here among the phone screens.
var CONTROLLER_CARDS = [
  { key: 'device-choice',   title: 'Device chooser', url: '/display/index.html?scenario=device-choice' },
  { key: 'name',            title: 'Name input' },
  { key: 'name-connecting', title: 'Connecting…' },
  { key: 'lobby-host',      title: 'Lobby (host)',    perColor: true },
  { key: 'lobby-waiting',   title: 'Lobby (waiting)', perColor: true },
  { key: 'lobby-joining',   title: 'Lobby (late joiner)', perColor: true },
  { key: 'help',            title: 'How to drive',    perColor: true },
  { key: 'motion-blocked',  title: 'Motion blocked',  perColor: true },
  { key: 'countdown',       title: 'Countdown',       perColor: true, replayable: true },
  { key: 'playing',         title: 'Driving',         perColor: true },
  { key: 'paused',          title: 'Paused',          perColor: true },
  { key: 'finished',        title: 'Finished',        perColor: true },
  { key: 'results',         title: 'Results',         perColor: true },
  { key: 'conn-lost',        title: 'Connection lost' },
  { key: 'conn-screen-gone', title: 'Big screen gone' },
  { key: 'conn-replaced',    title: 'Seat replaced' }
];

var state = Gallery.loadState();

// Controller uses its own cards-per-row key so switching pages doesn't clobber
// the display page's preference. view-as covers all MAX_PLAYERS car colours.
var MAX_PLAYERS = 4;
var CTRL_MAX_COLS = 8;
var stored = parseInt(state.controllerCardsPerRow, 10);
state.controllerCardsPerRow = Math.max(1, Math.min(stored || 7, CTRL_MAX_COLS));

function clampViewAs(v) { return Math.max(0, Math.min(v || 0, MAX_PLAYERS - 1)); }
state.viewAs = clampViewAs(parseInt(state.viewAs, 10) || 0);

function dims() {
  var d = Gallery.computeControllerDims(state);
  return { logical: { w: d.iframeW, h: d.iframeH }, chromePx: d.chromePx };
}

var allCards = [];
// Per-color cards paired with their scenario def, so view-as changes can
// retarget each iframe with a new `color` param instead of re-rendering.
var perColorCards = [];

function cardURL(c) {
  if (c.url) return c.url;
  var colorIdx = c.perColor ? state.viewAs : 0;
  return Gallery.controllerURL(c.key, colorIdx);
}

function cardTag(c) {
  if (c.perColor) return Gallery.PLAYER_COLOR_NAMES[state.viewAs];
  return '';
}

var lazyIo = null;
function render() {
  Gallery.resetQueue();
  if (lazyIo) { lazyIo.disconnect(); lazyIo = null; }
  for (var d0 = 0; d0 < allCards.length; d0++) if (allCards[d0]._destroy) allCards[d0]._destroy();
  var host = document.getElementById('controller-rows');
  host.innerHTML = '';

  var strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.controllerCardsPerRow);

  allCards = [];
  perColorCards = [];
  var d = dims();
  for (var i = 0; i < CONTROLLER_CARDS.length; i++) {
    var c = CONTROLLER_CARDS[i];
    var card = Gallery.makeCard({
      title: c.title,
      tag: cardTag(c),
      frameClass: 'controller',
      logical: d.logical,
      chromePx: d.chromePx,
      url: cardURL(c),
      replayable: !!c.replayable
    });
    strip.appendChild(card);
    allCards.push(card);
    if (c.perColor) perColorCards.push({ card: card, scenario: c });
  }
  host.appendChild(strip);
  lazyIo = Gallery.lazyMount(allCards);
}

// view-as swaps the `color` param on each per-color card's iframe in place —
// non-per-color cards (name input, connecting) are left alone.
function updateViewAs() {
  var c = state.viewAs;
  var tag = Gallery.PLAYER_COLOR_NAMES[c];
  var viewAsEl = document.getElementById('view-as-player');
  if (viewAsEl && viewAsEl.value !== String(c)) viewAsEl.value = String(c);
  for (var i = 0; i < perColorCards.length; i++) {
    var item = perColorCards[i];
    item.card._setUrl(cardURL(item.scenario));
    item.card._setLabel(item.scenario.title, tag);
  }
}

// Device / orientation / chrome don't change iframe URLs — just re-layout
// the existing cards so the loaded content is preserved.
function updateDims() {
  var d = dims();
  for (var i = 0; i < allCards.length; i++) {
    if (allCards[i]._applyDims) allCards[i]._applyDims(d.logical, d.chromePx);
  }
}
function updateLayout() {
  var strips = document.querySelectorAll('.scenario-strip');
  for (var i = 0; i < strips.length; i++) {
    strips[i].style.setProperty('--row-cols', state.controllerCardsPerRow);
  }
}

Gallery.bindSelect(state, 'controller-device', 'controllerDevice', updateDims);
Gallery.bindSelect(state, 'controller-orientation', 'controllerOrientation', updateDims);
Gallery.bindCheckbox(state, 'controller-chrome', 'controllerBrowserChrome', updateDims);
Gallery.bindSelect(state, 'view-as-player', 'viewAs', updateViewAs, function(v) {
  return clampViewAs(parseInt(v, 10) || 0);
});
Gallery.bindSelect(state, 'cards-per-row', 'controllerCardsPerRow', updateLayout, function(v) {
  return Math.max(1, Math.min(parseInt(v, 10) || 7, CTRL_MAX_COLS));
});

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
