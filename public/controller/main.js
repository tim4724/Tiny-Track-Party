// Controller entry — name → lobby → drive. A dumb renderer: it holds no game
// content, driving every screen off the display's retained room snapshot
// (LOBBY_UPDATE / set_state). Tilt steering + brake stream as CONTROL to the
// display; ITEM lights the USE button (place/lap + the race HUD live on the big
// screen). Car images load by id from the web host.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { Haptics } from './Haptics.js';
import { buildCarPicker } from '../shared/carPicker.js';
import { buildModePicker } from '../shared/trackPicker.js';
import { unpackSchematic } from '../shared/schematicCodec.js';
import { applyLatencyChip, renderWaitNote, renderReadyFoot, motionHelpCopy } from './ui.js';
import { createWakeLock } from '../shared/wakeLock.js';
// Sanitize a display name to the wire limit (trim + ≤16 chars). The cap is
// shared with the display's own re-clamp of an incoming HELLO, so it lives in
// shared/names.js — one function, imported by both pages and driven directly by
// tests/wire-compat.test.js. Returns '' for blank input; callers that need a
// seatable name apply their own `|| 'Racer'` default (the shell keeps '' so a
// missing cgName falls back to the name screen).
import { cleanName } from '../shared/names.js';

const { MSG, ROOM_STATE } = window;
const el = (id) => document.getElementById(id);

// ---- Couch Games launcher shell (CONTRACT.md) ----
// The launcher (native Android app hosting this page in a WebView) appends
// ?cgv=<version>&cgName=<name> to the join URL. Its presence means "running
// inside the Couch Games shell"; ALL shell behaviour is gated on it, so the same
// deployed controller keeps working untouched in a plain browser. We accept any
// cgv value (forward-compat: an unknown higher version is still "shell present").
const _cgParams = new URLSearchParams(location.search);
const inShell = _cgParams.has('cgv');
// The launcher's name gate guarantees non-blank ≤16 chars; we still sanitize
// defensively (trim/truncate) exactly as the standalone name form does.
const shellName = inShell ? cleanName(_cgParams.get('cgName')) : '';
// Flag the shell on <html> so CSS can drop our own name labels: the launcher
// already shows the player's name in its native top-bar chip, so the in-game
// copies (lobby identity, in-race HUD, how-to-drive demo) are redundant there.
// Gated on cgv like every other shell behaviour, so the plain browser is unchanged.
document.documentElement.classList.toggle('cg-shell', inShell);

// Report a TERMINAL session end to the launcher (§3), feature-detected + fire-once.
// Terminal = the session cannot continue (room gone/closed, join rejected, seat
// taken over). The launcher tears down the WebView and returns home with a message,
// so we must NOT also navigate. Returns true once it has signalled (caller stops);
// false when there's no host to signal (plain browser / shell without the interface)
// so the caller falls back to its normal in-game handling.
let _sessionEnded = false;
function endSession(reason) {
  if (!(window.CouchGamesHost && window.CouchGamesHost.gameEnded)) return false;
  if (_sessionEnded) return true;  // fire-once on our side too; extra calls are ignored anyway
  _sessionEnded = true;
  window.CouchGamesHost.gameEnded(reason);
  return true;
}

const screens = { name: el('name'), lobby: el('lobby'), game: el('game'), results: el('results') };
// Screen "depth": name is the entry point (0); every in-room screen sits one
// level above it (1). lobby↔game↔results are same-level shuffles. Used to push a
// browser-history entry only on the forward step into the room, so the back
// button / phone back gesture pops cleanly back to name entry. See `show`.
const SCREEN_ORDER = { name: 0, lobby: 1, game: 1, results: 1 };
let currentScreen = null;
function show(name) {
  const prev = currentScreen;
  currentScreen = name;
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  // Push history only when stepping UP a level (name → lobby). Same-level and
  // back transitions don't push, so there's exactly one entry to pop: pressing
  // back from anywhere in the room returns to the name screen in one step.
  // In the shell the launcher owns the back gesture (it swallows it and shows its
  // own LEAVE bar), so we push nothing — our own back handling would fight it (§1).
  if (!inShell && (SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) history.pushState({ screen: name }, '');
}

// haptics — vibrate the phone (ignored where unsupported; iOS Safari has no
// navigator.vibrate at all, so every cue here is Android-only). The player's eyes
// are on the main display, not the phone, so a buzz is how the phone confirms
// something landed. ONE motor, so every cue routes through this instance: a
// transient fired while the brake rumble is running would otherwise silence it
// until the next renewal. See Haptics.js.
const haptics = new Haptics();
const buzz = (p) => haptics.tick(p);
const startBrakeRumble = () => haptics.startLoop();   // defaults ARE the brake rumble
const stopBrakeRumble = () => haptics.stopLoop();

let myColorIndex = null;
let myCarIndex = 0;
let myName = '';           // this player's name, shown at the top of the lobby
let amHost = false;
let roster = [];           // latest lobby roster (for the host name in the wait text)
let hostPeerIndex = null;
// Chooser content, driven entirely off the relay room snapshot (set_state) — the
// phone bundles none of it, so it can't diverge from a differently-versioned
// display. tracks ride the snapshot in the lobby only; cars + the livery palette
// always. Car images load by id from the web host (carThumbs.js).
let trackCatalog = [];     // [{id,name,svg,cup,cupName,cupDifficulty}] — snapshot.tracks (lobby only)
let carCatalog = [];       // [{id,name,stats}] — snapshot.cars
let colorPalette = (window.CAR_COLORS || []).slice(); // snapshot.colors (bundled palette = pre-snapshot fallback)
const liveryOf = (i) => colorPalette[i] || '#888';
let selectedMode = null;   // current pick {mode:'track'|'cup'|'random', trackId?, cupId?} (host-controlled, echoed to all)
let displayMode = null;    // pick the display last reported (WELCOME/LOBBY_UPDATE); null = it has none
let amReady = false;       // my lobby ready flag (optimistic; LOBBY_UPDATE confirms)
let inResults = false;     // showing the results overlay (my car finished / race over)
// Joined while a race was already running (WELCOME said inRace:false): we have
// no car out there, so we wait on the lobby screen — car picker live, no ready
// button — and ignore the current race's broadcasts. The display seats us
// automatically when the next race builds its field; GAME_END (back to the
// lobby) clears the flag.
let waitingForNextRace = false;
let lastStandings = null;  // latest STANDINGS payload — re-renders the results footer when the host changes

const NAME_KEY = 'tinytrack_name';
const MODE_KEY = 'tinytrack_mode';     // host's last pick, JSON {mode, trackId?, cupId?, randomRaces?}
const TRACK_KEY = 'tinytrack_track';   // legacy pre-mode key (bare track id) — read-only fallback
const CAR_KEY = 'tinytrack_car';       // last-picked car model index
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };
const storedMode = () => {
  try { const v = JSON.parse(localStorage.getItem(MODE_KEY) || 'null'); if (v && v.mode) return v; } catch (_) {}
  // Upgrade path: a phone that last picked before modes existed keeps its favourite track.
  try { const id = localStorage.getItem(TRACK_KEY); if (id) return { mode: 'track', trackId: id }; } catch (_) {}
  return null;
};
const saveMode = (m) => { try { localStorage.setItem(MODE_KEY, JSON.stringify(m)); } catch (_) {} };
const storedCarIndex = () => { try { const v = parseInt(localStorage.getItem(CAR_KEY), 10); return Number.isInteger(v) ? v : null; } catch (_) { return null; } };
const saveCarIndex = (i) => { try { localStorage.setItem(CAR_KEY, String(i)); } catch (_) {} };

// Keep the phone's screen on while seated in a room: tilt steering means whole
// races go by without a touch, so the screen would otherwise dim and lock
// mid-race. Held from join (lobby included — waiting on the host shouldn't dim
// either) until the player backs out; re-acquired on tab return (the browser
// drops the lock whenever the phone is pocketed / the tab hidden).
const wakeLock = createWakeLock();

const net = new ControllerNet({
  onJoined: () => { setStatus(''); hideConn(); wakeLock.enable(); },
  onStatus: (state, info) => {
    // Any status callback means the clean join→lobby path didn't carry us all the
    // way through, so re-enable the join form. It's a no-op once we've moved off
    // the name screen (the button is hidden), but it prevents a player getting
    // stuck on a disabled button — display gone, kicked, or reconnect exhausted.
    setJoining(false);
    // Shell: a TERMINAL link state ends the session — hand it to the launcher (§3)
    // and stop; it tears down the WebView. Recoverable states (reconnecting, a
    // display that may come back) are NOT terminal and stay in-game below as our
    // own overlay. If the host interface is somehow absent, endSession returns
    // false and we fall through to the normal in-game handling.
    if (inShell) {
      const reason = state === 'error'
        ? (info === 'Room not found' ? 'room_not_found'
          : info === 'Room is full' ? 'game_full' : 'game_ended')
        : state === 'replaced' ? 'replaced'
          : state === 'lost' ? 'game_ended'
            : state === 'room_closed' ? 'game_ended'
              : null;
      if (reason && endSession(reason)) return;
    }
    // In-room (lobby/game/results) the name-screen status line is off-screen, so a
    // dropped link needs the full-screen #conn overlay; on the name screen the
    // status text under the form is enough.
    const inRoom = currentScreen && currentScreen !== 'name';
    if (state === 'reconnecting') {
      const txt = `Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`;
      setStatus(txt);
      if (inRoom) showConn('Reconnecting…', txt, false, false);
    } else if (state === 'lost') {
      setStatus('Connection lost.');
      if (inRoom) showConn('Connection lost', 'Scan the QR on the big screen to take your seat back — or try again here.', true, true);
    } else if (state === 'room_closed') {
      // The room is gone for good (host ended the party, or the big screen never
      // came back) — no retry button: reconnecting would only bounce off
      // "Room not found". Exiting to the start screen is the only move left.
      setStatus('That race has ended — scan a fresh QR code on the big screen.');
      if (inRoom) showConn('Race over', 'The party on the big screen has ended. Scan a fresh QR code to join the next one!', false, true);
    } else if (state === 'error') {
      setStatus(friendlyRelayError(info));
    } else if (state === 'display_gone') {
      setStatus('Waiting for the big screen…');
      if (inRoom) showConn('Waiting for the big screen…', 'The host’s screen dropped — hang tight, it’ll reconnect you.', false, true);
    } else if (state === 'replaced') {
      setStatus('Opened on another tab.');
      if (inRoom) showConn('Opened on another tab', 'This seat is now controlled from another tab or device.', false, true);
    }
  },
  onMessage: handleMessage,
  onRtt: updateLatency
});

// ---- connection overlay (screen-agnostic relay-link feedback) ----
// `leave` shows the "Exit to start" escape hatch — on for every terminal state
// (lost / room_closed / display_gone / replaced), off while a reconnect is
// still in flight.
function showConn(title, msg, retry, leave) {
  el('conn-title').textContent = title;
  el('conn-msg').textContent = msg || '';
  el('conn-retry').classList.toggle('hidden', !retry);
  // In the shell the launcher owns leaving (its LEAVE bar) — never show our own
  // "Exit to start" escape hatch, which would fight it (§1).
  el('conn-leave').classList.toggle('hidden', !leave || inShell);
  el('conn').classList.remove('hidden');
}
function hideConn() { el('conn').classList.add('hidden'); }
el('conn-retry').addEventListener('click', () => {
  buzz(15);
  showConn('Reconnecting…', '', false, false);
  net.connect(myName);
});
// Pop the room's history entry — the popstate handler runs the real leave
// (leaveToName), exactly as the back gesture would, keeping the stack clean.
el('conn-leave').addEventListener('click', () => { buzz(15); history.back(); });

// Latency chip (bottom-right). Stays hidden until the first reading lands so it
// never flashes on the pre-join name screen. See applyLatencyChip in ui.js.
const latencyEl = el('latency');
function updateLatency(halfMs, viaFastlane) { applyLatencyChip(latencyEl, halfMs, viaFastlane); }

const tilt = new TiltInput({
  surface: el('game'),
  // sendControl (not send) — the 25 Hz stream is gated down to what the display
  // doesn't already hold. See InputGate.js.
  onControl: (c) => net.sendControl(c)
});

function setStatus(t) { el('name-status').textContent = t; }
// Relay error strings (Party-Server) → copy a party guest can act on.
function friendlyRelayError(msg) {
  if (msg === 'Room not found') return 'That race has ended — scan a fresh QR code on the big screen.';
  if (msg === 'Room is full') return 'This race is full — wait for a free seat, then try again.';
  return 'Error: ' + msg;
}
// Lock the join form while a connection is in flight so a double-tap can't fire
// two joins; unlocked again only if the attempt errors out (success navigates
// away to the lobby).
function setJoining(on) {
  el('join-btn').disabled = on;
  el('name-input').disabled = on;
}

// The display's pick as {mode, cupId, trackId} (WELCOME / LOBBY_UPDATE carry it
// flat). A display that predates modes sends a bare trackId — read it as an
// exact pick so a mid-deploy pairing still works.
function modeFrom(data) {
  if (data.mode) {
    return {
      mode: data.mode,
      cupId: data.cupId != null ? data.cupId : null,
      // How long a Random run is (0 = endless). The display owns it — it clamps
      // whatever we sent — so the picker's length tiles read it back from here.
      // null when the snapshot carries none, which lets the picker apply its own
      // default instead of reading the absence as endless.
      randomRaces: Number.isInteger(data.randomRaces) ? data.randomRaces : null,
      trackId: data.trackId != null ? data.trackId : null
    };
  }
  if (data.trackId != null) return { mode: 'track', cupId: null, randomRaces: null, trackId: data.trackId };
  return null;
}

function handleMessage(data) {
  switch (data.type) {
    // The retained room snapshot (set_state) is the single source of truth:
    // identity, roster, selection, chooser content, and which screen we belong
    // on. Replayed on every (re)join and pushed on every change, so a reconnecting
    // phone recovers its whole state here — no unicast WELCOME round-trip to miss.
    case MSG.LOBBY_UPDATE:
      syncRoom(data);
      break;
    // Transient haptic tick (3..2..1..GO). The snapshot owns the screen; this is
    // just the buzz plus a fresh-race USE reset.
    case MSG.COUNTDOWN:
      if (waitingForNextRace || inResults) break;
      if (data.n >= 0) buzz(data.n > 0 ? 20 : [0, 90]);
      setHeldItem(null);               // USE off at the line — ITEM relights it once boxes roll
      break;
    // Held item → lights the USE button. Per-owner, so it rides its own message
    // (on change + once on reconnect), never the shared room snapshot.
    case MSG.ITEM:
      if (inResults) break;
      setHeldItem(data.item);
      break;
  }
}

// Land this phone on the screen the snapshot describes, and adopt its identity /
// roster / chooser content. Idempotent by design: it runs on every replay and
// every push, so each branch must be a safe no-op when we're already there.
function syncRoom(data) {
  hideConn();   // the snapshot reached us ⇒ the relay link + the display are alive

  // Chooser content, display-authoritative. tracks ride the snapshot in the lobby
  // only, so keep the last set for the picker; cars + palette come on every push.
  if (data.cars) carCatalog = data.cars;
  if (data.colors) colorPalette = data.colors;
  // Each track's svg rides the snapshot as a packed base64 string (RDP + uint8);
  // decode it back to the { viewBox, d, start } the picker renders.
  if (data.tracks) trackCatalog = data.tracks.map((t) => ({ ...t, svg: unpackSchematic(t.svg) }));

  roster = data.players || [];
  hostPeerIndex = data.hostPeerIndex;
  amHost = net.isHost(hostPeerIndex);
  displayMode = modeFrom(data);
  if (displayMode) selectedMode = displayMode;

  const me = roster.find((p) => p.peerIndex === net.peerIndex);
  // The first replay after `joined` can arrive before our HELLO is seated — wait
  // for the push that includes us instead of routing off a roster we're not in.
  if (!me) return;
  myColorIndex = me.colorIndex;
  if (me.carIndex != null) myCarIndex = me.carIndex;
  if (me.name) myName = me.name;
  amReady = !!me.ready;
  applyLivery();
  if (!amReady) maybeRestoreCar(); // ready = car locked; don't fight the display's record

  const rs = data.roomState;
  const midRace = rs === ROOM_STATE.COUNTDOWN || rs === ROOM_STATE.PLAYING;
  waitingForNextRace = midRace && me.inRace === false;
  const board = data.standings;
  if (board) lastStandings = board;
  // My car is home (finished, or the race is over) → the results board owns my
  // screen even while others are still out.
  const mineDone = board && (board.over || (board.order || []).some((o) => o.playerId === net.peerIndex && o.finished));

  if (rs === ROOM_STATE.RESULTS || (midRace && !waitingForNextRace && mineDone)) {
    if (board) { renderResults(board); showResultsScreen(); }
  } else if (midRace && !waitingForNextRace) {
    // Drop into the live race (or the countdown — tilt streams so the display reacts).
    inResults = false;
    show('game');
    el('drive-hud').classList.remove('hidden');
    el('pause-btn').classList.remove('hidden');
    el('help-btn-game').classList.remove('hidden');
    setPauseOverlay(!!data.paused);  // re-raise a pause missed while away
    if (data.paused) stopBrakeRumble();
    startDriving();                  // resume/continue streaming tilt to our car
  } else if (waitingForNextRace && board && board.over) {
    // Late joiner and the FINAL board is up — it lists us as "Next race", so join
    // everyone on the results screen.
    renderResults(board); showResultsScreen();
  } else {
    // Lobby proper, or waiting on the next race. May be reached FROM the game
    // screen (display reloaded mid-race), so shut the drive surface down.
    if (rs === ROOM_STATE.LOBBY) { waitingForNextRace = false; inResults = false; lastStandings = null; }
    const entering = currentScreen !== 'lobby';
    stopDriving();
    setPauseOverlay(false);
    el('pause-btn').classList.add('hidden');
    el('help-btn-game').classList.add('hidden');
    renderLobby();
    show('lobby');
    if (entering) onEnterLobby(); // teach controls / surface blocked motion once, on entry
  }
}

// --- results overlay ---
// Switch the phone to the results board. Stops driving (the car is on autopilot
// now) and clears the pause UI so a still-racing player's pause can't surface
// over the board.
function showResultsScreen() {
  if (!inResults) { inResults = true; stopDriving(); }
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  el('help-btn-game').classList.add('hidden');
  show('results');
}

// Render the standings rows + the footer (host's "New game" vs a waiting note).
// Cup boards (data.series) trade the lap clock for points — "+9 · 15 pts" — and
// arrive from the display already in cup order; the title tracks the series
// ("Race 2 of 4", then "Beach Cup — Final" on the podium board).
function renderResults(data) {
  const s = data.series;
  el('results-title').textContent = !s ? 'Results'
    : s.final ? `${s.cupName} — Final`
      : s.endless ? `Race ${s.raceIndex + 1}`                  // endless random: no "of N"
        : `Race ${s.raceIndex + 1} of ${s.raceCount}`;
  const cupBoard = !!(s && data.over);
  const list = el('result-list');
  list.innerHTML = '';
  (data.order || []).forEach((o) => {
    const li = document.createElement('li');
    const isMe = o.playerId === net.peerIndex;
    if (isMe) li.classList.add('is-me');
    if (o.joining) li.classList.add('is-joining');      // late joiner — no car this race
    else if (!o.finished) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = liveryOf(o.colorIndex);
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : isMe ? ' (You)' : '');
    li.append(dot, name);
    if (cupBoard && !o.joining) {
      const gain = document.createElement('span');
      gain.className = 'res-gain' + (o.gained ? '' : ' is-zero');
      gain.textContent = `+${o.gained || 0}`;
      const pts = document.createElement('span');
      pts.className = 'res-pts';
      pts.textContent = `${o.points || 0} pts`;
      li.append(gain, pts);
    } else {
      const time = document.createElement('span');
      time.className = 'res-time';
      time.textContent = o.joining ? 'Next race'
        : o.finished ? `${o.time.toFixed(1)}s` : (data.over ? 'DNF' : 'Racing…');
      li.appendChild(time);
    }
    list.appendChild(li);
  });
  renderResultFoot(data);
}

// Footer: while cars are still out, a waiting note for everyone. Once the race is
// over, the host gets the button — "Next race" during a cup intermission (plus the
// ghost "End cup early", the only way to abandon a cup from here) or "New game"
// otherwise; everyone else gets a note. Intermissions auto-advance, so non-hosts
// see "starting soon" rather than a who-to-wait-on name.
function renderResultFoot(data) {
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  const s = data.series;
  const intermission = !!(s && !s.final && data.over);
  const quit = el('quitcup-btn');
  quit.classList.toggle('hidden', !(intermission && amHost));
  if (intermission) quit.textContent = s.endless ? 'Back to lobby' : 'End cup early';
  if (!data.over) {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other racers to finish…';
  } else if (amHost) {
    btn.textContent = intermission ? 'Next race ▸' : 'New game';
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    if (intermission) {
      wait.textContent = `Next race starting soon: ${s.nextTrackName || '…'}`;
    } else {
      const host = (data.order || []).find((o) => o.playerId === hostPeerIndex);
      renderWaitNote(wait, { name: host && host.name, color: host && liveryOf(host.colorIndex) }, ' to start a new game…');
    }
  }
}

function applyLivery() {
  const c = liveryOf(myColorIndex);
  document.documentElement.style.setProperty('--car', c);
  // Retint the launcher's accent chrome (name chip, spinner, rename sheet) to
  // match this player's livery — a live §4 hint. Mutating the meta's content is
  // what the launcher's observer watches; a plain browser ignores it. Guarded on
  // a real colour so we don't advertise the grey placeholder before livery lands.
  if (myColorIndex != null) {
    const meta = document.querySelector('meta[name="cg-accent-color"]');
    if (meta) meta.setAttribute('content', c);
  }
}

// Car picker — the controller's lobby is just "pick your car" (the shared display
// owns the player roster). A big HERO shows the selected car (spinning pre-baked
// render — a plain <img>, no WebGL on the phone — its name, and handling stat
// bars) above a compact strip of every model as a small still. Tapping a strip
// tile picks it; the hero (preview + stats) updates to match. Car and colour are
// independent and duplicates are fine, so no tile is ever claimed; the livery
// shows as the selection ring. A tap is optimistic — the next LOBBY_UPDATE echoes back the
// display's record. While READY the picker is locked (ready survives race →
// lobby, so the pick behind a standing ready flag must not shift) — toggling
// "I'm ready" off unlocks it. Layout lives in shared/carPicker.js (shared with
// the gallery).
function renderLobby() {
  maybeAutoSelectMode();    // host: leave the display's plain diorama for the 3D preview right away
  el('me-name').textContent = myName || 'Racer'; // who you are, up top (livery dot is var(--car))
  buildCarPicker({ heroEl: el('car-hero'), stripEl: el('carpick'), selected: myCarIndex, onPick: chooseCar, canPick: !amReady, cars: carCatalog });
  renderModePicker();
  const hostP = roster.find((p) => p.peerIndex === hostPeerIndex);
  if (waitingForNextRace) {
    // Late joiner: a race is running without us. No ready button (readiness
    // gates a lobby we're not in) — pick a car and hold for the next race.
    // If host promotion lands on us mid-race (original host gone), this branch
    // still hides the start controls — acceptable: the abandoned-race timer on
    // the display returns everyone to the lobby, where we get them normally.
    el('ready-btn').classList.add('hidden');
    const note = el('ready-note');
    note.classList.remove('hidden');
    note.textContent = 'You’re in the next race!'; // copy duplicated in TestHarness.js 'lobby-joining'
    return;
  }
  renderReadyFoot(el('ready-btn'), el('ready-note'), {
    amHost, amReady,
    canStart: !!selectedMode,     // host can't start without a pick (auto-picked, so ~always true)
    host: hostP && { name: hostP.name, color: liveryOf(hostP.colorIndex) },
    others: roster   // every non-host racer but me (for the host that's everyone else)
      .filter((p) => p.peerIndex !== net.peerIndex && p.peerIndex !== hostPeerIndex && p.connected !== false)
      .map((p) => ({ name: p.name, color: liveryOf(p.colorIndex), ready: !!p.ready }))
  });
}

// Mode picker — host only: one tile per cup then 🎲 Random (a cup pick runs its
// 4-race Grand Prix and its open panel offers exact single-track picks; Random's
// panel offers the run's length instead). Sent as SELECT_MODE. Everyone else gets no picker at all — the big screen
// shows the host's pick. Also hidden until the catalog arrives (older display /
// pre-WELCOME). Layout in shared/trackPicker.js.
function renderModePicker() {
  const wrap = el('trackpick');
  if (!amHost || !trackCatalog.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  buildModePicker({
    stripEl: el('track-strip'),
    catalog: trackCatalog, selection: selectedMode, canPick: true, onPickMode: chooseMode
  });
}

// A stored pick is only worth re-asserting if this catalog still backs it
// (tracks/cups can churn between visits; 'random' always resolves).
function modeInCatalog(m) {
  if (!m) return false;
  if (m.mode === 'random') return true;
  if (m.mode === 'cup') return trackCatalog.some((t) => t.cup === m.cupId);
  if (m.mode === 'track') return trackCatalog.some((t) => t.id === m.trackId);
  return false;
}

// Host auto-picks the moment they reach the lobby, so the display leaves its
// plain diorama for the live 3D preview without waiting for a tap. The pick is
// this phone's last-used mode (saved on tap; a pre-mode phone's bare track id
// upgrades to an exact pick), falling back to the FIRST CUP — a fresh party's
// Start launches the easy Grand Prix. Sent as SELECT_MODE exactly like a manual
// choice — the display echoes it back to everyone via LOBBY_UPDATE. No-op for
// non-hosts or before the catalog arrives.
function maybeAutoSelectMode() {
  if (!amHost || !trackCatalog.length) return;
  if (!selectedMode) {
    const stored = storedMode();
    const firstCup = trackCatalog.find((t) => t.cup);
    selectedMode = modeInCatalog(stored) ? stored
      : firstCup ? { mode: 'cup', cupId: firstCup.cup }
        : { mode: 'track', trackId: trackCatalog[0].id }; // cup-less catalog (older display)
    net.send(MSG.SELECT_MODE, selectedMode); // optimistic; LOBBY_UPDATE is the source of truth
    return;
  }
  // Repair a desync: we hold a pick but the display reports none (it reloaded /
  // reconnected and lost its selection while our phone kept ours). Without this
  // the "Start race" button is enabled here (canStart = !!selectedMode) yet the
  // display's startRace() bails on its own null track, so the tap silently no-ops —
  // and re-picking only helps if you choose something DIFFERENT. Re-asserting our
  // pick restores both the display's 3D preview and the start gate. (For 'random'
  // the reloaded display re-rolls — its old draw died with it.)
  if (displayMode == null) net.send(MSG.SELECT_MODE, selectedMode);
}

function chooseMode(pick) {
  const cur = selectedMode || {};
  const same = cur.mode === pick.mode
    && (pick.mode === 'cup' ? cur.cupId === pick.cupId
      : pick.mode === 'track' ? cur.trackId === pick.trackId
        // Random is never filtered: a tap that changes the length changes the
        // pick, and one that doesn't re-rolls the draw. Both need the display.
        : false);
  if (same) return;
  selectedMode = { ...pick };  // optimistic; LOBBY_UPDATE is the source of truth
  saveMode(pick);              // remember it so the next lobby auto-picks this mode
  renderModePicker();          // move the ring (and open the cup's panel) now
  net.send(MSG.SELECT_MODE, pick);
  buzz(15);
}

function chooseCar(i) {
  if (amReady || i === myCarIndex) return; // ready = car locked (tiles are disabled; belt-and-braces)
  myCarIndex = i;       // optimistic; LOBBY_UPDATE is the source of truth
  saveCarIndex(i);      // remember it so the next join restores this car
  renderLobby();        // move the highlight now
  net.send(MSG.SET_CAR, { carIndex: i });
  buzz(15);
}

// Restore the car model this phone last used, overriding the display's slot-based
// default assigned on join. Sent as SET_CAR exactly like a tap; the display
// validates + echoes it back in LOBBY_UPDATE. No-op when nothing's saved, the
// saved index is out of range, or it already matches what the display gave us.
function maybeRestoreCar() {
  const stored = storedCarIndex();
  const count = carCatalog.length; // display-authoritative roster (from the snapshot)
  if (!count || stored == null || stored < 0 || stored >= count || stored === myCarIndex) return;
  myCarIndex = stored;
  net.send(MSG.SET_CAR, { carIndex: stored });
}

// --- driving ---
let steerRaf = null;
function startDriving() {
  el('hud-name').textContent = myName || 'Racer'; // who you are, top-left (mirrors the display cell)
  if (steerRaf) return; // already driving (may have begun during the countdown)
  tilt.start();
  const fill = el('steer-fill');
  const tip = el('motion-tip');
  tip.classList.toggle('hidden', tilt.motionState === 'granted');
  const loop = () => {
    fill.style.transform = `translateX(${tilt.state.steer * 50}%)`;
    steerRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopDriving() {
  tilt.stop();
  stopBrakeRumble(); // never leave the motor humming if BRAKE was held at race end
  if (steerRaf) cancelAnimationFrame(steerRaf);
  steerRaf = null;
}

// --- name screen ---
el('name-input').value = storedName();

// Back out of the room (back button / phone back gesture) → name entry. Drops
// the relay connection so the display removes us from the roster, resets the
// transient in-room UI, and re-fills the name input so the player can edit it
// and re-join. The history entry pushed by `show` on name → lobby is what the
// pop lands on; here we just react to it.
function leaveToName() {
  net.disconnect();
  stopDriving();
  wakeLock.disable();  // off the room — let the phone sleep normally again
  _heldItem = undefined; setHeldItem(null); // reset USE state for the next race
  inResults = false;
  waitingForNextRace = false;
  lastStandings = null;
  amHost = false;
  amReady = false;
  roster = [];
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  el('help-btn-game').classList.add('hidden');
  if (helpOpen()) closeHelp();         // don't strand either popup over the name screen
  if (motionOpen()) closeMotionPopup();
  setJoining(false);
  setStatus('');
  hideConn();
  el('name-input').value = storedName();
  show('name');
  el('name-input').focus();
}
window.addEventListener('popstate', () => {
  if (inShell) return;   // shell owns leaving (§1) — we never pushed, and don't self-leave
  if (currentScreen && currentScreen !== 'name') leaveToName();
});

// Join the room under `name`. `persist` saves it as this device's default for the
// standalone name form; the shell passes false — the launcher owns identity and its
// injected name must never leak into the game's own storage (§1).
async function joinRace(name, { persist } = {}) {
  const n = cleanName(name) || 'Racer';
  myName = n;
  if (persist) saveName(n);
  setStatus('');           // the disabled button signals the in-flight join
  setJoining(true);
  // Request motion permission within this user gesture (iOS requirement). AWAIT it
  // so motionState is resolved before the lobby's auto-shown help reads it — the
  // request itself is fired synchronously inside this gesture (enableMotion calls
  // requestPermission before its first await), so awaiting the result is safe and
  // doesn't break the gesture rule. On iOS this waits out the system prompt; on
  // Android/desktop it resolves on the next microtask (no prompt, negligible delay).
  await tilt.enableMotion();
  net.connect(n);
}
el('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRace(el('name-input').value, { persist: true });
});

// Lobby footer button — for the host it's "Start race" (enabled only once
// everyone else is ready — see renderReadyFoot); for everyone else it's the
// ready toggle. The display validates both messages.
el('ready-btn').addEventListener('click', () => {
  if (amHost) {
    net.send(MSG.START_GAME);
  } else {
    amReady = !amReady;   // optimistic; LOBBY_UPDATE is the source of truth
    renderLobby();        // flip the button (and note) now
    net.send(MSG.SET_READY, { ready: amReady });
  }
  buzz(15);
});

// --- pause ---
// The display is authoritative over the paused state; the controller just
// requests a change and reacts to the GAME_PAUSED / GAME_RESUMED broadcast.
// While paused the overlay covers the screen, so the pause button is disabled.
function setPauseOverlay(on) {
  // Pause is authoritative and must win the screen: if a popup is open when a pause
  // lands (both sit above the pause overlay), close it so the pause shows.
  if (on) { if (helpOpen()) closeHelp(); if (motionOpen()) closeMotionPopup(); }
  el('pause-overlay').classList.toggle('hidden', !on);
  el('pause-btn').disabled = on;
}
el('pause-btn').addEventListener('click', () => { buzz(15); net.send(MSG.PAUSE_GAME); });
el('pause-continue').addEventListener('click', () => { buzz(15); net.send(MSG.RESUME_GAME); });
el('pause-newgame').addEventListener('click', () => { buzz(15); net.send(MSG.RETURN_TO_LOBBY); });

// Host's results button: mid-series it advances to the next race, otherwise it
// sends everyone to the lobby. The ghost quit button is the intermission's
// escape hatch ("End cup early" / endless: "Back to lobby").
el('newgame-btn').addEventListener('click', () => {
  if (!amHost) return;
  buzz(15);
  const s = lastStandings && lastStandings.series;
  net.send(s && !s.final ? MSG.SERIES_NEXT : MSG.RETURN_TO_LOBBY);
});
el('quitcup-btn').addEventListener('click', () => { if (amHost) { buzz(15); net.send(MSG.RETURN_TO_LOBBY); } });

// --- How-to-Drive popup ---
// Purely INSTRUCTIONAL: teaches the controls (tilt/brake/item) + the keep-upright
// note. Auto-shows ONCE per device on first lobby entry; the "?" buttons (lobby +
// game) reopen it. The motion-permission recovery is a SEPARATE popup (below).
const HELP_SEEN_KEY = 'tinytrack_seen_help';
const helpSeen = () => { try { return localStorage.getItem(HELP_SEEN_KEY) === '1'; } catch (_) { return false; } };
const markHelpSeen = () => { try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch (_) {} };

// True in gallery/scenario mode — auto-popups stay shut there (the harness opens the
// one it's previewing; a real WELCOME never fires anyway).
const inScenario = () => !!new URLSearchParams(location.search).get('scenario');

// Auto-show the help popup once per device on the first lobby entry, then never
// again (the flag is sticky). See onEnterLobby for how it yields to the motion popup.
function maybeAutoShowHelp() {
  if (inScenario() || helpSeen() || helpOpen()) return;
  openHelp();        // show first, THEN stamp — a throw before it shows can't burn the once
  markHelpSeen();
}

// On reaching the lobby: if tilt is blocked, the actionable motion popup wins the
// beat (so the two never stack); otherwise teach the controls once. A blocked player
// still gets the controls intro later — once motion is sorted, this runs again with
// the help flag still unseen.
function onEnterLobby() {
  if (inScenario()) return;
  if (motionBlocked()) maybeShowMotionAlert();
  else maybeAutoShowHelp();
}

// --- shared modal plumbing (help + motion popups) ---
// While a modal is up, mark the screens behind it inert so a screen reader's virtual
// cursor (and any stray Tab) can't reach the lobby/HUD underneath — aria-modal + the
// keyboard trap only cover sighted keyboard users. inert is ignored where unsupported,
// so this degrades to the trap alone.
function setBackgroundInert(on) {
  for (const k of Object.keys(screens)) screens[k].toggleAttribute('inert', on);
}
// Minimal focus trap: keep Tab/Shift+Tab cycling within the open card's VISIBLE
// focusables (a hidden button is in the DOM but offsetParent null — exclude it, or
// Tab lands on something invisible).
function trapTab(overlay, e) {
  if (e.key !== 'Tab') return;
  const f = [...overlay.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
const restoreFocus = (node) => { if (node && node.focus) node.focus(); };

// How-to-Drive popup open/close. _helpReturnFocus is the element focused before
// opening, so closing returns focus to it (the "?" that opened it).
let _helpReturnFocus = null;
function openHelp() {
  _helpReturnFocus = document.activeElement;
  el('phone-name').textContent = myName || 'Racer';   // demo phone reads as "your phone" (livery via --car)
  el('help-overlay').classList.remove('hidden');
  setBackgroundInert(true);
  el('help-done').focus();   // keyboard-operable + announced; the trap keeps Tab inside
}
function closeHelp() {
  el('help-overlay').classList.add('hidden');
  if (!motionOpen()) setBackgroundInert(false);   // un-inert BEFORE restoring focus
  restoreFocus(_helpReturnFocus); _helpReturnFocus = null;
}
const helpOpen = () => !el('help-overlay').classList.contains('hidden');

el('help-btn').addEventListener('click', () => { buzz(15); openHelp(); });
el('help-btn-game').addEventListener('click', () => { buzz(15); openHelp(); });
el('help-done').addEventListener('click', () => { buzz(15); closeHelp(); });
el('help-overlay').addEventListener('keydown', (e) => trapTab(el('help-overlay'), e));

// --- Motion-blocked popup ---
// A SEPARATE alert from the instructions: surfaces when the tilt sensor is blocked
// (iOS denied) or absent (unsupported), with the live recovery path. Auto-shows once
// per page load on lobby entry while blocked (no nagging on every lobby return). The
// recovery action depends on the state: iOS won't re-prompt once denied, so the button
// RELOADS (the next Join re-raises the prompt) rather than uselessly re-requesting.
// Copy + action live in ui.js (motionHelpCopy) so they can't drift from the gallery.
const motionBlocked = () => { const s = tilt.motionState; return s === 'denied' || s === 'unsupported'; };
let _motionAlertShown = false;
let _motionReturnFocus = null;

function maybeShowMotionAlert() {
  if (inScenario() || _motionAlertShown || motionOpen() || !motionBlocked()) return;
  _motionAlertShown = true;
  openMotionPopup();
}

// Populate the popup's title/status/Allow/fix from the resolved state.
function refreshMotionPopup() {
  const copy = motionHelpCopy(tilt.motionState);
  if (!copy.show) return;          // granted — popup shouldn't be up; guard anyway
  el('motion-title').textContent = copy.title;
  el('motion-status').textContent = copy.status;
  const allow = el('motion-allow');
  allow.classList.toggle('hidden', !copy.allow);
  allow.disabled = false; allow.textContent = copy.allowText;
  const fix = el('motion-fix');
  if (copy.fix) { fix.classList.remove('hidden'); fix.innerHTML = copy.fix; }
  else fix.classList.add('hidden');
}

function openMotionPopup() {
  _motionReturnFocus = document.activeElement;
  refreshMotionPopup();
  el('motion-overlay').classList.remove('hidden');
  setBackgroundInert(true);
  el('motion-done').focus();
}
function closeMotionPopup() {
  el('motion-overlay').classList.add('hidden');
  if (!helpOpen()) setBackgroundInert(false);
  restoreFocus(_motionReturnFocus); _motionReturnFocus = null;
}
const motionOpen = () => !el('motion-overlay').classList.contains('hidden');

el('motion-done').addEventListener('click', () => { buzz(15); closeMotionPopup(); });
el('motion-overlay').addEventListener('keydown', (e) => trapTab(el('motion-overlay'), e));
// The in-race "tilt is off" chip reopens the recovery popup (its only fix path,
// since players have no keyboard fallback).
el('motion-tip').addEventListener('click', () => { buzz(15); openMotionPopup(); });

// Primary recovery button — what it DOES depends on the resolved state (see
// motionHelpCopy's `action`). Once iOS has denied, re-calling requestPermission()
// resolves 'denied' silently (no prompt), so 'denied' RELOADS instead: the next Join
// re-raises the prompt (name is restored from localStorage). 'unknown' (gallery /
// pre-prompt) is the only state where a fresh request can still prompt — there we
// (re-)call enableMotion() within this gesture and confirm a grant in place.
el('motion-allow').addEventListener('click', async () => {
  buzz(15);
  if (motionHelpCopy(tilt.motionState).action === 'reload') { location.reload(); return; }
  const btn = el('motion-allow');
  btn.disabled = true; btn.textContent = 'Asking…';
  await tilt.enableMotion();
  if (tilt.motionState === 'granted') {
    el('motion-title').textContent = 'Motion access on';
    el('motion-status').textContent = 'Tilt to steer is ready.';
    btn.classList.add('hidden');
    el('motion-fix').classList.add('hidden');
  } else {
    refreshMotionPopup();   // now 'denied' → button flips to "Reload & ask again"
  }
});

// Escape closes whichever modal is up (motion sits above help — close it first).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (motionOpen()) { e.preventDefault(); e.stopPropagation(); closeMotionPopup(); }
  else if (helpOpen()) { e.preventDefault(); e.stopPropagation(); closeHelp(); }
});

// BRAKE button — held = brake at the fixed rate, released = release. A continuous
// rumble runs while it's held: the player's eyes-free confirmation they're braking
// (they're watching the car on the main display, not the phone).
const brakeBtn = el('brake-btn');
const pressBrake = (on) => { on ? startBrakeRumble() : stopBrakeRumble(); tilt.pressBrake(on); brakeBtn.classList.toggle('held', on); };
brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressBrake(true); });
brakeBtn.addEventListener('pointerup', () => pressBrake(false));
brakeBtn.addEventListener('pointercancel', () => pressBrake(false));
brakeBtn.addEventListener('pointerleave', () => pressBrake(false));

// ACTION (use item) — one tap = one use. Bumps the wrapping use-counter the next
// CONTROL frame carries; disabled (and ignored) while the slot is empty.
const actionBtn = el('action-btn');
actionBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (actionBtn.disabled) return;
  tilt.pressAction(); buzz(20); actionBtn.classList.add('held');
});
const releaseAction = () => actionBtn.classList.remove('held');
actionBtn.addEventListener('pointerup', releaseAction);
actionBtn.addEventListener('pointercancel', releaseAction);
actionBtn.addEventListener('pointerleave', releaseAction);

// Held-item badge: dims + disables ACTION when empty, lights up with the item name
// otherwise. Names map to .is-<id> livery classes in controller.css.
// The item's IDENTITY is shown on the main display (flashy roulette there); the
// phone stays a clean driving surface. The only controller-side cue is the USE
// button lighting up when you're holding something + a light buzz on pickup.
const ITEM_LABEL = { boost: 'BOOST', banana: 'BANANA', rocket: 'ROCKET', monster: 'MONSTER' };
let _heldItem = undefined;
function setHeldItem(item) {
  if (item === _heldItem) return;            // only react on a change
  _heldItem = item;
  actionBtn.disabled = !item;
  tilt.setActionEnabled(!!item);             // gate BOTH the button and the keyboard ACTION
  actionBtn.setAttribute('aria-label', item ? `Use ${ITEM_LABEL[item] || item}` : 'Use item');
  if (item) buzz(20);                        // eyes-free "you picked something up" (look at the TV for what)
}

// Live rename from the launcher (§2). The game implements, the launcher calls it
// when the player edits their name in the in-game bar (and re-asserts it on every
// load, belt-and-suspenders with the cgName param). Only meaningful in the shell —
// a plain browser renames via the name screen. Applies locally (the labels that
// carry the name) AND broadcasts to the display via a re-HELLO, exactly like a
// join. We do NOT persist it (§1): the injected identity must not leak into the
// game's own name storage.
window.CouchGames = {
  setName(name) {
    if (!inShell) return;
    const n = cleanName(name) || 'Racer';
    myName = n;
    el('me-name').textContent = n;                     // lobby identity
    el('hud-name').textContent = n;                    // in-race HUD
    if (helpOpen()) el('phone-name').textContent = n;  // how-to-drive demo phone
    net.rename(n);                                     // → display roster + LOBBY_UPDATE echo
  }
};

// Boot. In the shell the launcher owns identity: skip the name screen entirely
// and join straight away with the injected name (never persisted). Otherwise land
// on the name screen and wait for the player to pick a name. (Scenario/gallery
// mode below never connects and always carries no cgv, so it's unaffected.)
if (inShell && shellName) {
  // Never flash the name screen (it's the default-visible section): hide it up
  // front and go straight to joining. The launcher's own joining spinner floats
  // over the blank sky until WELCOME lands and show('lobby') takes over.
  screens.name.classList.add('hidden');
  joinRace(shellName, { persist: false });
} else {
  show('name');
}
window.__net = net; window.__wakeLock = wakeLock; // debug/test handles (parity with the display)

// Gallery / test mode: ?scenario=… lays out a single screen from fake data
// without connecting to the relay (the controller never auto-connects, so
// there's nothing to suppress — we just drive the screens directly).
const _params = new URLSearchParams(location.search);
const _scenario = _params.get('scenario');
if (_scenario) {
  const _int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
  import('./TestHarness.js').then(({ runControllerScenario }) => runControllerScenario({
    scenario: _scenario,
    color: _int(_params.get('color'), 0)
  }));
}

// Measurement overlay for the CONTROL send gate: ?netstats=1 (optionally with
// ?steerThresh=…). Same escape-hatch shape as ?scenario= above — opt-in via URL,
// so it can't reach a player who joined by scanning the QR. See NetStats.js.
if (_params.get('netstats')) {
  const _thresh = parseFloat(_params.get('steerThresh'));
  if (isFinite(_thresh) && _thresh >= 0) net.gate.steerThreshold = _thresh;
  import('./NetStats.js').then(({ initNetStats }) => initNetStats(net.gate));
}

// No debug-settings wrench on the controller — it's the player-facing phone, so the
// query-param editor would ship to real players. Scenarios are still reachable
// directly via ?scenario=…&color=… (handled above); the gallery drives them that way.
