// Small controller-UI helpers shared by the live phone (main.js) and the gallery
// preview (TestHarness.js) so the two can't drift. No globals, no relay — pure DOM.

// Latency chip (bottom-right). halfMs is one-way (RTT/2); halfMs < 0 means the
// PONG is overdue (no signal). viaFastlane lights the bolt when the reading came
// off the P2P DataChannel rather than the WS relay. Quality thresholds: <50 good,
// <100 ok, else bad.
export function applyLatencyChip(chipEl, halfMs, viaFastlane) {
  if (!chipEl) return;
  chipEl.classList.remove('hidden', 'latency--good', 'latency--ok', 'latency--bad');
  chipEl.classList.toggle('latency--fastlane', !!viaFastlane);
  const textEl = chipEl.querySelector('.latency__text');
  if (halfMs < 0) {
    textEl.textContent = 'no signal';
    chipEl.classList.add('latency--bad');
  } else {
    textEl.textContent = halfMs + ' ms';
    chipEl.classList.add(halfMs < 50 ? 'latency--good' : halfMs < 100 ? 'latency--ok' : 'latency--bad');
  }
}

// "Waiting for NAME<suffix>" — NAME is the host, tinted in their livery colour
// (matching the in-race name plate). Built from DOM nodes so a player-supplied
// name is always inserted as text, never markup. Falls back to "the host" until
// the roster naming the host has arrived. `color` is a CSS colour string (or
// falsy to leave the default).
export function renderWaitNote(waitEl, { name, color } = {}, suffix) {
  const nameEl = document.createElement('span');
  nameEl.className = 'host-name';
  nameEl.textContent = name || 'the host';
  if (color) nameEl.style.color = color;
  waitEl.textContent = 'Waiting for ';
  waitEl.append(nameEl, suffix);
}

// Lobby footer — shared by the live phone (main.js) and the gallery preview
// (TestHarness) so the button logic can't drift. Non-hosts toggle their own
// readiness; the host gets a single "Start race" button, disabled until every
// other connected player is ready (the display re-validates START_GAME, so
// this gate is purely UX). `others` is every other NON-host connected player
// as {name, color, ready}; `host` is {name, color} for the non-host waiting
// note; `canStart` additionally gates the host until a track is picked.
export function renderReadyFoot(btnEl, noteEl, { amHost, amReady, canStart, host, others }) {
  btnEl.classList.remove('hidden');
  const allReady = others.every((p) => p.ready);
  if (amHost) {
    btnEl.textContent = 'Start race';
    btnEl.disabled = !canStart || !allReady;
    btnEl.classList.remove('is-pressed');
    noteEl.classList.toggle('hidden', allReady);
    if (!allReady) noteEl.textContent = 'Waiting for all players to get ready…';
  } else {
    btnEl.disabled = false;
    btnEl.textContent = amReady ? 'Ready ✓' : 'I’m ready';
    btnEl.classList.toggle('is-pressed', amReady); // stays visually held down while ready
    noteEl.classList.toggle('hidden', !amReady);
    if (amReady) {
      if (allReady) renderWaitNote(noteEl, host || {}, ' to start…');
      else noteEl.textContent = 'Waiting for all players to get ready…';
    }
  }
}
