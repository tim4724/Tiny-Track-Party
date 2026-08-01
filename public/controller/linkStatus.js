// Relay-link feedback: the full-screen #conn overlay, and the copy for every link
// state. Screen-agnostic on purpose — a dropped link is the same event whether
// the player is in the lobby, driving, or reading the results.
//
// The copy DECISION is separated from showing it (`linkCopy` is pure and returns
// what to show) because the two answers differ by where the player is: the name
// screen has a status line under the form and needs no overlay, while in-room the
// status line is off-screen and the overlay is the only thing they can see.
const el = (id) => document.getElementById(id);

let _inShell = false;

// `leave` shows the "Exit to start" escape hatch — on for every terminal state,
// off while a reconnect is still in flight. In the shell the launcher owns
// leaving (its LEAVE bar), so ours is never shown: it would fight it (§1).
export function showConn({ title, msg, retry, leave }) {
  el('conn-title').textContent = title;
  el('conn-msg').textContent = msg || '';
  el('conn-retry').classList.toggle('hidden', !retry);
  el('conn-leave').classList.toggle('hidden', !leave || _inShell);
  el('conn').classList.remove('hidden');
}

export function hideConn() { el('conn').classList.add('hidden'); }

// Relay error strings (Party-Server) → copy a party guest can act on.
function friendlyRelayError(msg) {
  if (msg === 'Room not found') return 'That race has ended — scan a fresh QR code on the big screen.';
  if (msg === 'Room is full') return 'This race is full — wait for a free seat, then try again.';
  return 'Error: ' + msg;
}

// What a link state should say: `status` for the name screen's status line,
// `conn` for the in-room overlay (null = this state needs no overlay). Pure.
export function linkCopy(state, info) {
  switch (state) {
    case 'reconnecting': {
      const txt = `Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`;
      return { status: txt, conn: { title: 'Reconnecting…', msg: txt, retry: false, leave: false } };
    }
    case 'lost':
      return {
        status: 'Connection lost.',
        conn: { title: 'Connection lost', msg: 'Scan the QR on the big screen to take your seat back — or try again here.', retry: true, leave: true }
      };
    // The room is gone for good (host ended the party, or the big screen never
    // came back) — no retry button: reconnecting would only bounce off "Room not
    // found". Exiting to the start screen is the only move left.
    case 'room_closed':
      return {
        status: 'That race has ended — scan a fresh QR code on the big screen.',
        conn: { title: 'Race over', msg: 'The party on the big screen has ended. Scan a fresh QR code to join the next one!', retry: false, leave: true }
      };
    case 'display_gone':
      return {
        status: 'Waiting for the big screen…',
        conn: { title: 'Waiting for the big screen…', msg: 'The host’s screen dropped — hang tight, it’ll reconnect you.', retry: false, leave: true }
      };
    case 'replaced':
      return {
        status: 'Opened on another tab.',
        conn: { title: 'Opened on another tab', msg: 'This seat is now controlled from another tab or device.', retry: false, leave: true }
      };
    // A join that was refused never reaches the room, so the name screen's status
    // line is the whole story — no overlay.
    case 'error':
      return { status: friendlyRelayError(info), conn: null };
    default:
      return { status: null, conn: null };
  }
}

export function initLinkStatus({ inShell, onRetry, onLeave }) {
  _inShell = inShell;
  el('conn-retry').addEventListener('click', onRetry);
  el('conn-leave').addEventListener('click', onLeave);
}
