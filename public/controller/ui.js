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
// "Motion sensor is blocked" popup copy — one source of truth for the live phone
// (main.js refreshMotionPopup) and the gallery preview (TestHarness's
// 'motion-blocked' case), keyed off tilt.motionState so the two can't drift. Returns
// what to render: { show, title, status, allow, action, allowText, fix } (fix is an
// HTML string or null — set via innerHTML for the <em> emphasis; the only markup is
// our own literal). `action` says what the primary button DOES:
//   'request' — (re-)call requestPermission(); only useful before a choice was made.
//   'reload'  — reload the page (the only way to re-raise the iOS prompt once denied).
// The distinction matters because iOS already prompts on the Join tap, then caches the
// answer for the life of the page load: a second requestPermission() after a deny
// resolves 'denied' SILENTLY (no prompt). So 'denied' offers RELOAD, not re-request —
// reloading lets the next Join prompt again (name is restored from localStorage, so
// it's a one-tap rejoin). If the global Safari toggle is off, even reload won't
// prompt, hence the Settings fix line. 'granted' (incl. Android/desktop, which resolve
// granted on the Join tap) needs no recovery, so the popup stays shut. 'unsupported'
// drops the button entirely (no prompt to raise on that platform). 'unknown' (the
// gallery / pre-prompt edge) is the one state where a fresh request CAN still prompt.
export function motionHelpCopy(state) {
  switch (state) {
    case 'granted':
      return { show: false };
    case 'denied':
      return {
        show: true, allow: true, action: 'reload', allowText: 'Reload & ask again',
        title: 'Motion sensor is blocked',
        status: 'Steering uses your phone’s tilt, which is switched off.',
        fix: 'Still off after reloading? Turn on <em>Settings → Apps → Safari → Motion &amp; Orientation Access</em>, then rejoin.'
      };
    case 'unsupported':
      return {
        show: true, allow: false, action: null, allowText: 'Allow motion',
        title: 'Tilt steering isn’t available',
        status: 'This device doesn’t report motion, so tilt steering won’t work here. Try joining from a phone.',
        fix: null
      };
    default: // 'unknown' — before the Join tap resolved permission (e.g. the gallery)
      return {
        show: true, allow: true, action: 'request', allowText: 'Allow motion',
        title: 'Turn on motion access',
        status: 'Steering uses your phone’s tilt, so the game needs motion access. Tap below to turn it on.',
        fix: null
      };
  }
}

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
