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
