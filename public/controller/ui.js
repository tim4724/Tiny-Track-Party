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
// (matching their in-race HUD chip). Built from DOM nodes so a player-supplied
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
// has no case: a device with no sensor is forced onto button steering at startup
// (main.js) and the settings card's Tilt row reads "Not available" — nothing to
// recover, so it never reaches this popup. 'unknown' (the gallery / pre-prompt
// edge) is the one state where a fresh request CAN still prompt.
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
    default: // 'unknown' — before the Join tap resolved permission (e.g. the gallery)
      return {
        show: true, allow: true, action: 'request', allowText: 'Allow motion',
        title: 'Turn on motion access',
        status: 'Steering uses your phone’s tilt, so the game needs motion access. Tap below to turn it on.',
        fix: null
      };
  }
}

export function renderReadyFoot(btnEl, noteEl, { amHost, amReady, tab, canStart, host, others, backEl }) {
  // A new node for a new face (see the note above). Same id, same classes, so
  // the next el('ready-btn') finds it and nothing else has to know.
  const face = amHost ? tab : 'ready';
  if (btnEl.dataset.face && btnEl.dataset.face !== face) {
    const fresh = btnEl.cloneNode(false);
    btnEl.replaceWith(fresh);
    btnEl = fresh;
  }
  btnEl.dataset.face = face;

  btnEl.classList.remove('hidden');
  // The back chip is the other half of the stepper, and only the host has a
  // page to go back FROM — so it lives and dies with the forward button rather
  // than in its own renderer, which is what let the old tab strip drift out of
  // step with the bar below it.
  if (backEl) backEl.classList.toggle('hidden', !(amHost && tab === 'race'));
  // The note is a floating chip OUT OF FLOW above the button (controller.css),
  // hidden by :empty — so it's cleared, never display:none'd, and toggling
  // ready never moves the button.
  const allReady = others.every((p) => p.ready);
  if (amHost) {
    // The host's button is a STEPPER between the two lobby pages: on CAR it
    // advances ("Select race", always enabled — picking needs no permission),
    // on RACE it launches. Blue for the step, brand green stays "go". There is
    // no tab strip above it: this button and the chip beside it ARE the
    // navigation, so the label has to name the destination, not the action.
    const onCar = tab === 'car';
    btnEl.textContent = onCar ? 'Select race' : 'Start race';
    btnEl.classList.toggle('btn--step', onCar);
    btnEl.disabled = onCar ? false : (!canStart || !allReady);
    btnEl.classList.remove('is-pressed');
    noteEl.textContent = (!onCar && !allReady) ? 'Waiting for all players to get ready…' : '';
  } else {
    btnEl.disabled = false;
    btnEl.textContent = amReady ? 'Ready ✓' : 'I’m ready';
    btnEl.classList.toggle('is-pressed', amReady); // stays visually held down while ready
    if (!amReady) noteEl.textContent = '';
    else if (allReady) renderWaitNote(noteEl, host || {}, ' to start…');
    else noteEl.textContent = 'Waiting for all players to get ready…';
  }
}
