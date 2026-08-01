
// Every display screen in one flat grid, ordered by the player's journey
// through a real session. Cards-per-row is set by the header control.
//
// Card shape:
//   { key, title, hostVariant?, animated?, replayable? }
// hostVariant cards swap their `host` URL param when the host selector changes
// (no iframe rebuild) so the ★ host marker can be previewed per slot.

import * as Gallery from './gallery-common.js';
var DISPLAY_CARDS = [
  { key: 'welcome',     title: 'Welcome' },
  { key: 'lobby-loading', title: 'Lobby (loading)' },
  { key: 'lobby-empty', title: 'Lobby (waiting)', animated: true },
  { key: 'lobby',       title: 'Lobby (track picked)',  hostVariant: true, animated: true, params: { picked: 'track',  track: 'driftwood' } },
  { key: 'lobby',       title: 'Lobby (tour picked)',   hostVariant: true, animated: true, params: { picked: 'tour' } },
  { key: 'lobby',       title: 'Lobby (random picked)', hostVariant: true, animated: true, params: { picked: 'random', track: 'powder' } },
  { key: 'countdown', title: 'Countdown', replayable: true },
  { key: 'racing',    title: 'Race',      animated: true },
  { key: 'rocket',    title: 'Rocket strike', animated: true },
  { key: 'monster',   title: 'Monster truck', animated: true },
  { key: 'paused',    title: 'Paused' },
  { key: 'reconnect', title: 'Reconnect' },
  { key: 'finished',  title: 'Player finished' },
  { key: 'results',   title: 'Results' },
  { key: 'intermission', title: 'Cup intermission' },
  { key: 'podium',    title: 'Cup podium' }
];

var state = Gallery.loadState();

// Display uses its own cards-per-row + players keys so switching between the
// display and controller pages doesn't clobber each other's preference.
var MAX_PLAYERS = 4;
var DISPLAY_MAX_COLS = 5;
var DISPLAY_DEFAULT_COLS = 3;
var DISPLAY_DEFAULT_PLAYERS = MAX_PLAYERS;
var stored = parseInt(state.displayCardsPerRow, 10);
state.displayCardsPerRow = Math.max(1, Math.min(stored || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
state.displayPlayers = Math.max(1, Math.min(parseInt(state.displayPlayers, 10) || DISPLAY_DEFAULT_PLAYERS, MAX_PLAYERS));
state.players = state.displayPlayers;

function clampViewAs(v) { return Math.max(0, Math.min(v || 0, MAX_PLAYERS - 1)); }
state.viewAs = clampViewAs(parseInt(state.viewAs, 10) || 0);

function dims() { return Gallery.DISPLAY_AR_DIMS[state.displayAR] || Gallery.DISPLAY_AR_DIMS['16x9']; }

var allCards = [];
// Host-variant cards paired with their scenario def, so host changes can
// retarget each iframe with a new `host` param instead of re-rendering.
var hostVariantCards = [];

function cardURL(c) {
  var extra = null;
  if (c.params) { extra = {}; for (var k in c.params) extra[k] = c.params[k]; }
  if (c.hostVariant) { extra = extra || {}; extra.host = state.viewAs; }
  return extra ? Gallery.displayURL(state, c.key, extra) : Gallery.displayURL(state, c.key);
}

function cardTag(c) {
  if (c.hostVariant) return Gallery.PLAYER_COLOR_NAMES[state.viewAs];
  if (c.animated) return 'live';
  return '';
}

var lazyIo = null;
function render() {
  Gallery.resetQueue();
  if (lazyIo) { lazyIo.disconnect(); lazyIo = null; }
  for (var d0 = 0; d0 < allCards.length; d0++) if (allCards[d0]._destroy) allCards[d0]._destroy();
  var host = document.getElementById('display-rows');
  host.innerHTML = '';

  var strip = document.createElement('div');
  strip.className = 'scenario-strip';
  strip.style.setProperty('--row-cols', state.displayCardsPerRow);

  allCards = [];
  hostVariantCards = [];
  var d = dims();
  for (var i = 0; i < DISPLAY_CARDS.length; i++) {
    var c = DISPLAY_CARDS[i];
    var card = Gallery.makeCard({
      title: c.title,
      tag: cardTag(c),
      frameClass: 'display',
      logical: d,
      url: cardURL(c),
      replayable: !!c.replayable,
      animated: !!c.animated
    });
    strip.appendChild(card);
    allCards.push(card);
    if (c.hostVariant) hostVariantCards.push({ card: card, scenario: c });
  }
  host.appendChild(strip);
  lazyIo = Gallery.lazyMount(allCards);
}

// Host change swaps the `host` param on each host-variant card's iframe in
// place. Non-host-variant cards are left alone.
function updateViewAs() {
  var c = state.viewAs;
  var tag = Gallery.PLAYER_COLOR_NAMES[c];
  var viewAsEl = document.getElementById('view-as-player');
  if (viewAsEl && viewAsEl.value !== String(c)) viewAsEl.value = String(c);
  for (var i = 0; i < hostVariantCards.length; i++) {
    var item = hostVariantCards[i];
    item.card._setUrl(cardURL(item.scenario));
    item.card._setLabel(item.scenario.title, tag);
  }
}

// AR change only affects frame geometry — re-layout existing cards.
function updateDims() {
  var d = dims();
  for (var i = 0; i < allCards.length; i++) {
    if (allCards[i]._applyDims) allCards[i]._applyDims(d, 0);
  }
}
function updateLayout() {
  var strips = document.querySelectorAll('.scenario-strip');
  for (var i = 0; i < strips.length; i++) {
    strips[i].style.setProperty('--row-cols', state.displayCardsPerRow);
  }
}

Gallery.bindSelect(state, 'display-ar', 'displayAR', updateDims);
Gallery.bindSelect(state, 'player-count', 'displayPlayers', function() {
  state.players = state.displayPlayers;
  render();
}, function(v) { return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_PLAYERS, MAX_PLAYERS)); });
Gallery.bindSelect(state, 'view-as-player', 'viewAs', updateViewAs, function(v) {
  return clampViewAs(parseInt(v, 10) || 0);
});
Gallery.bindSelect(state, 'cards-per-row', 'displayCardsPerRow', updateLayout, function(v) {
  return Math.max(1, Math.min(parseInt(v, 10) || DISPLAY_DEFAULT_COLS, DISPLAY_MAX_COLS));
});

Gallery.autoPauseOnHeaderFocus();
Gallery.initMobileOptionsToggle();
render();
