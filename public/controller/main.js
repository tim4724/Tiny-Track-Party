// Controller entry — name → lobby → drive. A dumb renderer: it holds no game
// content, driving every screen off the display's retained room snapshot
// (LOBBY_UPDATE / set_state). Tilt steering + brake stream as CONTROL to the
// display; ITEM lights the USE button (place/lap + the race HUD live on the big
// screen). Car images load by id from the web host.
//
// What is LEFT here is the session: this phone's view of the room (identity,
// roster, pick, which screen we belong on) and the routing that keeps it in step
// with the snapshot. The self-contained parts moved out to their own files —
// the launcher contract, the two popups, the results board, the drive surface,
// the link overlay, the stored preferences — because they were nineteen
// unrelated concerns sharing one module scope, not because the file was long.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { Haptics } from './Haptics.js';
import { buildCarPicker } from '../shared/carPicker.js';
import { buildModePicker } from '../shared/trackPicker.js';
import { unpackSchematic } from '../shared/schematicCodec.js';
import { applyLatencyChip, renderReadyFoot, NEXT_RACE_NOTE } from './ui.js';
import { createWakeLock } from '../shared/wakeLock.js';
// Sanitize a display name to the wire limit (trim + ≤16 chars). The cap is
// shared with the display's own re-clamp of an incoming HELLO, so it lives in
// shared/names.js — one function, imported by both pages and driven directly by
// tests/wire-compat.test.js. Returns '' for blank input; callers that need a
// seatable name apply their own `|| 'Racer'` default (the shell keeps '' so a
// missing cpName falls back to the name screen).
import { cleanName } from '../shared/names.js';
import { inShell, shellName, endSession, terminalReason, setAccentColor, installRenameHook, armSystemBack, installBackHook } from './launcher.js';
import { storedName, saveName, storedMode, saveMode, storedCarIndex, saveCarIndex, storedInputMode, saveInputMode } from './prefs.js';
import { showConn, hideConn, linkCopy, initLinkStatus } from './linkStatus.js';
import { initModals, onEnterLobby, closeAnyModal, anyModalOpen, closeTopModal, refreshHelpName, refreshSettingsState } from './modals.js';
import { renderResultsBoard } from './resultsBoard.js';
import { initDriveSurface, startDriving, stopDriving, setInputMode, setHeldItem, resetHeldItem } from './driveSurface.js';
import { initOrientation } from './orientation.js';
import { initPressPaint } from './press.js';

const { MSG, ROOM_STATE } = window;
const el = (id) => document.getElementById(id);

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
  // A held Start belongs to the lobby: landing anywhere else IS the answer to it.
  if (name !== 'lobby') clearStartPending();
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  // Push history only when stepping UP a level (name → lobby). Same-level and
  // back transitions don't push, so there's exactly one entry to pop: pressing
  // back from anywhere in the room returns to the name screen in one step.
  // In the shell the launcher owns the back gesture (it swallows it and shows its
  // own LEAVE bar), so we push nothing — our own back handling would fight it (§1).
  if (!inShell && (SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) history.pushState({ screen: name }, '');
  syncShellBack();
}

// Shell §9: arm the system back gesture wherever an edge swipe isn't gameplay —
// the lobby and results screens (back = leave, the launcher's own exit), a
// paused race, and any open popup (back = close it, see the back hook at the
// bottom). Disarmed only while actually DRIVING, where the screen edges must
// stay steering input. Re-derived on every screen change, popup toggle and
// pause flip; armSystemBack dedupes the transitions.
function syncShellBack() {
  if (!inShell) return;
  const paused = !el('pause-overlay').classList.contains('hidden');
  armSystemBack(currentScreen !== 'game' || paused || anyModalOpen());
}

// haptics — vibrate the phone (ignored where unsupported; iOS Safari has no
// navigator.vibrate at all, so every cue here is Android-only). The player's eyes
// are on the main display, not the phone, so a buzz is how the phone confirms
// something landed. ONE motor, so every cue routes through this instance: a
// transient fired while the brake rumble is running would otherwise silence it
// until the next renewal. See Haptics.js.
const haptics = new Haptics();
const buzz = (p) => haptics.tick(p);

let myColorIndex = null;
let myCarIndex = 0;
let myName = '';           // this player's name, shown at the top of the lobby
let amHost = false;
let roster = [];           // latest lobby roster (for the host name in the wait text)
let hostPeerIndex = null;
let displaySoundOn = true; // the DISPLAY's mute state (snapshot soundOn) — the host's Sound setting renders it
// Chooser content, driven entirely off the relay room snapshot (set_state) — the
// phone bundles none of it, so it can't diverge from a differently-versioned
// display. tracks ride the snapshot in the lobby only; cars + the livery palette
// always. Car images load by id from the web host (carThumbs.js).
let trackCatalog = [];     // [{id,name,svg,cup,cupName,cupDifficulty}] — snapshot.tracks (lobby only)
let trackCatalogRaw = '';  // the packed snapshot.tracks it was decoded from (skip re-decoding per push)
let carCatalog = [];       // [{id,name,stats}] — snapshot.cars
let colorPalette = (window.CAR_COLORS || []).slice(); // snapshot.colors (bundled palette = pre-snapshot fallback)
const liveryOf = (i) => colorPalette[i] || '#888';
let selectedMode = null;   // current pick {mode:'track'|'cup'|'random'|'tour', trackId?, cupId?} (host-controlled, echoed to all)
let displayMode = null;    // pick the display last reported (LOBBY_UPDATE snapshot); null = it has none
let progressData = null;   // snapshot.progress — the couch's stars/locks (lobby only; cached like tracks)
let lobbyTab = 'car';      // the host's lobby page: 'car' | 'race' (non-hosts only ever see 'car')
let raceCursor = null;     // which race-list row the detail panel describes; null follows the pick
let amReady = false;       // my lobby ready flag (optimistic; LOBBY_UPDATE confirms)
// The host's Start press, held until the display answers it. Unlike every other
// optimistic flag here it needs a way OUT on its own: the display validates
// START_GAME and a refusal (no track, no scene) publishes nothing at all, so
// there is no snapshot coming to clear this one. See armStartGiveUp.
let startPending = false;
let startGiveUpTimer = null;
let inResults = false;     // showing the results overlay (my car finished / race over)
// Joined while a race was already running (the snapshot says our inRace is
// false): we have
// no car out there, so we wait on the lobby screen — car picker live, no ready
// button — and ignore the current race's broadcasts. The display seats us
// automatically when the next race builds its field; GAME_END (back to the
// lobby) clears the flag.
let waitingForNextRace = false;
let lastStandings = null;  // latest STANDINGS payload — re-renders the results footer when the host changes

// Keep the phone's screen on while seated in a room: tilt steering means whole
// races go by without a touch, so the screen would otherwise dim and lock
// mid-race. Held from join (lobby included — waiting on the host shouldn't dim
// either) until the player backs out; re-acquired on tab return (the browser
// drops the lock whenever the phone is pocketed / the tab hidden).
const wakeLock = createWakeLock();

// Latency chip (bottom-right). Stays hidden until the first reading lands so it
// never flashes on the pre-join name screen. See applyLatencyChip in ui.js.
const latencyEl = el('latency');

const net = new ControllerNet({
  onJoined: () => { setStatus(''); hideConn(); wakeLock.enable(); },
  onStatus: (state, info) => {
    // Any status callback means the clean join→lobby path didn't carry us all the
    // way through, so re-enable the join form. It's a no-op once we've moved off
    // the name screen (the button is hidden), but it prevents a player getting
    // stuck on a disabled button — display gone, kicked, or reconnect exhausted.
    setJoining(false);
    // Shell: a TERMINAL link state ends the session — hand it to the launcher (§3)
    // and stop; it tears down the WebView. If the host interface is somehow
    // absent, endSession returns false and we fall through to the normal in-game
    // handling below.
    if (inShell) {
      const reason = terminalReason(state, info);
      if (reason && endSession(reason)) return;
    }
    // In-room (lobby/game/results) the name-screen status line is off-screen, so a
    // dropped link needs the full-screen #conn overlay; on the name screen the
    // status text under the form is enough.
    const inRoom = currentScreen && currentScreen !== 'name';
    const { status, conn } = linkCopy(state, info);
    if (status != null) setStatus(status);
    if (inRoom && conn) showConn(conn);
  },
  onMessage: handleMessage,
  onRtt: (halfMs, viaFastlane) => applyLatencyChip(latencyEl, halfMs, viaFastlane)
});

initLinkStatus({
  inShell,
  onRetry: () => {
    buzz(15);
    showConn({ title: 'Reconnecting…', msg: '', retry: false, leave: false });
    net.connect(myName);
  },
  // Pop the room's history entry — the popstate handler runs the real leave
  // (leaveToName), exactly as the back gesture would, keeping the stack clean.
  onLeave: () => { buzz(15); history.back(); }
});

const tilt = new TiltInput({
  surface: el('game'),
  // sendControl (not send) — the sensor-rate stream is gated down to what the display
  // doesn't already hold. See InputGate.js.
  onControl: (c) => net.sendControl(c)
});

// Steering input mode — 'tilt' (default) or 'buttons', remembered per device.
// setInputMode applies it everywhere (TiltInput signal path + the #game mode
// class); the Settings popup's seg drives changes through here. A page that
// can't get tilt can never steer by it, so it's forced onto buttons and the
// settings card shows Tilt disabled (refreshSettingsCard).
//
// Where tilt is unsupported the mode is FORCED, not chosen, so it isn't saved:
// the stored pref only means anything where tilt exists, and the same browser
// on a page that does get the sensors must not inherit a fallback as a
// preference. Every caller goes through here, so the rule holds in one place —
// the startup seed below, the Settings seg, and the join fallback alike.
let inputMode = tilt.motionState === 'unsupported' ? 'buttons' : storedInputMode();
function applyInputMode(mode) {
  inputMode = mode;
  if (tilt.motionState !== 'unsupported') saveInputMode(mode);
  setInputMode(mode);
}

initModals({
  screens, tilt, buzz,
  playerName: () => myName || 'Racer',
  getInputMode: () => inputMode,
  setInputMode: applyInputMode,
  // The host-only Sound switch — the DISPLAY's mute, not this phone's.
  // Optimistic like every lobby control: the next LOBBY_UPDATE's soundOn
  // (echoed by the display's republish) is the truth.
  isHost: () => amHost,
  getSoundOn: () => displaySoundOn,
  setSoundOn: (on) => { displaySoundOn = on; net.send(MSG.SET_SOUND, { on }); },
  onModalToggle: syncShellBack
});
initDriveSurface({ tilt, buzz, haptics });
setInputMode(inputMode);
initOrientation({ inShell });
initPressPaint();

function setStatus(t) { el('name-status').textContent = t; }
// Lock the join form while a connection is in flight so a double-tap can't fire
// two joins; unlocked again only if the attempt errors out (success navigates
// away to the lobby).
function setJoining(on) {
  el('join-btn').disabled = on;
  el('name-input').disabled = on;
}

// The display's pick as {mode, cupId, trackId} (the LOBBY_UPDATE snapshot
// carries it flat). A display that predates modes sends a bare trackId — read it as an
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
  // decode it back to the { viewBox, d, start } the picker renders. The same
  // catalogue rides EVERY lobby push, so only re-decode when it actually changed.
  if (data.tracks) {
    const raw = JSON.stringify(data.tracks);
    if (raw !== trackCatalogRaw) {
      trackCatalogRaw = raw;
      trackCatalog = data.tracks.map((t) => ({ ...t, svg: unpackSchematic(t.svg) }));
    }
  }
  if (data.progress) progressData = data.progress;

  roster = data.players || [];
  hostPeerIndex = data.hostPeerIndex;
  amHost = net.isHost(hostPeerIndex);
  // The display's mute state — absent (an older display) means sound ON. Keep
  // the open settings card in step: a host handover or the TV's own mute
  // button can move it while the card is up.
  displaySoundOn = data.soundOn !== false;
  refreshSettingsState();
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
  // The FIRST snapshot can seat us under the engine's placeholder ("Player N")
  // with our HELLO name still in flight — and the auto-shown settings popup
  // reads the name at open. Keep the open card's demo phone tracking the
  // snapshot (no-op while it's closed).
  refreshHelpName(myName || 'Racer');
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
    el('drive-hud').classList.remove('hidden');  // pause + settings ride inside it
    setPauseOverlay(!!data.paused);  // re-raise a pause missed while away
    if (data.paused) haptics.stopLoop();
    startDriving(myName || 'Racer'); // resume/continue streaming tilt to our car
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
    renderLobby();
    show('lobby');
    if (entering) onEnterLobby(); // teach controls / surface blocked motion once, on entry
  }
}

// --- results ---
// Switch the phone to the results board. Stops driving (the car is on autopilot
// now) and clears the pause UI so a still-racing player's pause can't surface
// over the board.
function showResultsScreen() {
  if (!inResults) { inResults = true; stopDriving(); }
  setPauseOverlay(false);
  show('results');
}

function renderResults(data) {
  renderResultsBoard(data, { meId: net.peerIndex, hostPeerIndex, amHost, liveryOf });
}

function applyLivery() {
  const c = liveryOf(myColorIndex);
  document.documentElement.style.setProperty('--car', c);
  // Guarded on a real colour so we don't advertise the grey placeholder before
  // livery lands. See launcher.js for what the launcher does with it.
  if (myColorIndex != null) setAccentColor(c);
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
  renderLobbyPage();
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
    el('ready-note').textContent = NEXT_RACE_NOTE;
    return;
  }
  renderReadyFoot(el('ready-btn'), el('ready-note'), {
    amHost, amReady,
    backEl: el('lobby-back'),     // the corner's other half: shown on the race page only
    tab: lobbyTab,                // the stepper: CAR says "Select race", RACE "Start race"
    canStart: !!selectedMode,     // host can't start without a pick (auto-picked, so ~always true)
    starting: startPending,       // the press owns the button until the display answers
    host: hostP && { name: hostP.name, color: liveryOf(hostP.colorIndex) },
    others: roster   // every non-host racer but me (for the host that's everyone else)
      .filter((p) => p.peerIndex !== net.peerIndex && p.peerIndex !== hostPeerIndex && p.connected !== false)
      .map((p) => ({ name: p.name, color: liveryOf(p.colorIndex), ready: !!p.ready }))
  });
}

// Which lobby page we're on. There is no tab strip: the action corner's two
// buttons ARE the stepper (forward is renderReadyFoot's, back is the chip
// below). Both steps come through here, so the buzz and the transition live
// here too rather than at the call sites — the forward step used to buzz and
// the back chip didn't, which is exactly the drift a shared path prevents.
function setLobbyPage(tab) {
  if (tab === lobbyTab) return;
  lobbyTab = tab;
  renderLobby();
  // Without a page change to explain it, the corner's label simply mutates
  // under the thumb that pressed it. The content fades; the button itself
  // deliberately does NOT move, animate or fade — it is the fixed point the
  // finger is already on. (Its node is swapped for a fresh one on a face
  // change; see renderReadyFoot.)
  const lobby = el('lobby');
  lobby.classList.remove('lobby--step');
  void lobby.offsetWidth;             // restart it when stepping twice quickly
  lobby.classList.add('lobby--step');
  buzz(15);
}
// A race page exists only for a host with a catalogue to pick from. Anyone
// else's lobby IS the car page, so we pin them there rather than leaving a
// stale 'race' behind a vanished picker (host handover mid-lobby does exactly
// that).
function renderLobbyPage() {
  const canPickRace = amHost && trackCatalog.length > 0 && !waitingForNextRace;
  if (!canPickRace) lobbyTab = 'car';
  el('lobby').classList.toggle('lobby--race', lobbyTab === 'race');
}
el('lobby-back').addEventListener('click', () => setLobbyPage('car'));

// Mode picker — host only: one tile per cup then 🎲 Random (a cup pick runs its
// 4-race Grand Prix and its open panel offers exact single-track picks; Random's
// panel offers the run's length instead). Sent as SELECT_MODE. Everyone else gets no picker at all — the big screen
// shows the host's pick. Also hidden until the catalog arrives (older display /
// no snapshot yet). Layout in shared/trackPicker.js.
function renderModePicker() {
  const wrap = el('trackpick');
  if (!amHost || !trackCatalog.length || lobbyTab !== 'race') { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  buildModePicker({
    stripEl: el('track-strip'),
    catalog: trackCatalog, progress: progressData,
    selection: selectedMode, highlight: raceCursor,
    canPick: true, onPickMode: chooseMode,
    // A tapped row moves the detail cursor; a LOCKED row moves only it — the
    // panel becomes the unlock pitch without touching the pick.
    onHighlight: (rowId) => { raceCursor = rowId; renderModePicker(); }
  });
}

// Cup ids the snapshot's progression marks LOCKED. UX only — the display's
// walks refuse a locked pick regardless — but re-asserting one would silently
// no-op, and auto-picking one would strand the Start gate.
function lockedCupIds() {
  return new Set(((progressData && progressData.cups) || [])
    .filter((c) => c.locked).map((c) => c.id));
}

// A stored pick is only worth re-asserting if this catalog still backs it
// (tracks/cups can churn between visits; 'random' always resolves) AND the
// couch hasn't got it locked (a progress reset can re-lock a cup this phone
// once raced).
function modeInCatalog(m) {
  if (!m) return false;
  const locked = lockedCupIds();
  if (m.mode === 'random') return true;
  if (m.mode === 'tour') return trackCatalog.some((t) => t.cup); // needs cups to tour
  if (m.mode === 'cup') return !locked.has(m.cupId) && trackCatalog.some((t) => t.cup === m.cupId);
  if (m.mode === 'track') {
    const t = trackCatalog.find((x) => x.id === m.trackId);
    return !!t && !locked.has(t.cup);
  }
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
    // The first UNLOCKED cup — auto-picking a locked one would send a pick the
    // display silently refuses, stranding the Start gate.
    const locked = lockedCupIds();
    const firstCup = trackCatalog.find((t) => t.cup && !locked.has(t.cup));
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
        // The random family is never filtered: a tap that changes the run
        // changes the pick, and EVERY tap — same pick included — deals fresh
        // track(s). Both need the display.
        : false);
  if (same) return;
  selectedMode = { ...pick };  // optimistic; LOBBY_UPDATE is the source of truth
  raceCursor = null;           // the detail panel follows the pick again
  saveMode(pick);              // remember it so the next lobby auto-picks this mode
  renderModePicker();          // move the mark (and swap the detail panel) now
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

// A tap on the LOCKED strip — while ready the tiles are disabled with
// pointer-events off (controller.css), so the tap lands here on the container.
// A dead tap on a visible control reads as broken, so answer it: say how to
// unlock in the note line and wiggle the ready button. The note re-renders from
// the roster on the next renderLobby; the timer restores it sooner so the
// waiting text isn't gone for long. (Enabled tiles' taps bubble here too —
// the amReady guard drops those.)
let lockedHintTimer = 0;
el('carpick').addEventListener('click', () => {
  if (!amReady) return;
  el('ready-note').textContent = 'Tap “Ready ✓” to change your car';
  const btn = el('ready-btn');
  btn.classList.remove('btn--nudge');
  void btn.offsetWidth; // restart the wiggle when it's already run
  btn.classList.add('btn--nudge');
  clearTimeout(lockedHintTimer);
  lockedHintTimer = setTimeout(() => {
    btn.classList.remove('btn--nudge');
    if (!el('lobby').classList.contains('hidden')) renderLobby();
  }, 2500);
});

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
  resetHeldItem();     // USE goes dark again for the next race
  inResults = false;
  waitingForNextRace = false;
  lastStandings = null;
  amHost = false;
  amReady = false;
  roster = [];
  setPauseOverlay(false);
  closeAnyModal();     // don't strand either popup over the name screen
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

// ---- app lifecycle: hand the seat back while backgrounded (§7) ----
// The launcher dispatches a SYNTHETIC persisted `pagehide` when the player leaves
// the app (home, app switch, lock); a plain browser fires the real one on
// navigation or a bfcache freeze. Either way the page stops running while the
// relay socket would not, which is what leaves a zombie player on the big screen
// (see ControllerNet.suspend). There is no synthetic counterpart on return — the
// standard visibilitychange → visible is the signal, and net.resume() redials
// onto the same slot. Both are ordinary web events, so this is NOT gated on
// inShell: the handling is equally right in a plain browser, and net.suspend()
// no-ops when we never joined (the name screen has no link to drop).
window.addEventListener('pagehide', () => net.suspend());
document.addEventListener('visibilitychange', () => { if (!document.hidden) net.resume(); });
// pageshow is the second half of a belt-and-braces pair, and it earns its place
// because the pagehide above closes the socket in a PLAIN BROWSER too: a bfcache
// restore that didn't also flip visibility would strand a live-looking lobby on a
// link we deliberately dropped. It is the guaranteed counterpart of the event the
// teardown hangs on, and resume() no-ops unless suspend() actually ran.
window.addEventListener('pageshow', () => net.resume());

// Join the room under `name`. `persist` saves it as this device's default for the
// standalone name form; the shell passes false — the launcher owns identity and its
// injected name must never leak into the game's own storage (§1).
async function joinRace(name, { persist } = {}) {
  const n = cleanName(name) || 'Racer';
  myName = n;
  if (persist) saveName(n);
  setStatus('');           // the disabled button signals the in-flight join
  setJoining(true);
  // Request motion permission within this user gesture (iOS requirement) — but
  // only when TILT is the steering mode; a buttons phone never needs the sensor
  // (switching to Tilt later re-requests inside that tap, see modals.js). AWAIT it
  // so motionState is resolved before the lobby's auto-shown settings reads it —
  // the request itself is fired synchronously inside this gesture (enableMotion
  // calls requestPermission before its first await), so awaiting the result is
  // safe and doesn't break the gesture rule. On iOS this waits out the system
  // prompt; on Android/desktop it resolves on the next microtask.
  // enableMotion resolves the state completely (permission AND delivery), so a
  // phone whose sensor turns out to be absent or withheld is put on buttons
  // here rather than steering with a dead wheel. applyInputMode declines to
  // save it, since the state it just resolved is 'unsupported'.
  if (inputMode === 'tilt' && (await tilt.enableMotion()) === 'unsupported') {
    applyInputMode('buttons');
  }
  net.connect(n);
}
el('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRace(el('name-input').value, { persist: true });
});

// Let go of a held Start that nothing answered, and say so rather than silently
// re-enabling: the display logs its refusal to a console this phone cannot see,
// so "nothing happened" is the whole of what the host would otherwise get.
//
// The wait is generous ON PURPOSE. What it has to outlast is the display's launch
// build — a track mesh plus a shadow bake, which on the Android TV shell runs on
// the main thread BEFORE the launch publishes anything — and giving up early
// would flip the button back to "Start race" while the race it started is still
// assembling. Only a genuine refusal ever reaches the end of it.
const START_GIVE_UP_MS = 8000;

function armStartGiveUp() {
  clearTimeout(startGiveUpTimer);
  startGiveUpTimer = setTimeout(() => {
    if (!startPending) return;
    clearStartPending();
    // renderLobby FIRST: it owns the note and would overwrite this line.
    renderLobby();
    el('ready-note').textContent = 'The TV didn’t start the race. Try again.';
  }, START_GIVE_UP_MS);
}

function clearStartPending() {
  clearTimeout(startGiveUpTimer);
  startGiveUpTimer = null;
  startPending = false;
}

// Lobby footer button — for the host it's "Start race" (enabled only once
// everyone else is ready — see renderReadyFoot); for everyone else it's the
// ready toggle. The display validates both messages.
// DELEGATED from the corner rather than bound to the button: renderReadyFoot
// swaps the primary button's NODE whenever its face changes, and a listener
// bound to the old node would go with it. (#lobby-back needs none of this — it
// is static markup, only ever shown and hidden.)
el('ready-btn').closest('.lobby-go').addEventListener('click', (e) => {
  if (!e.target.closest('#ready-btn')) return;
  if (amHost) {
    // The stepper: on the CAR page the button ADVANCES to the race page; on
    // the RACE page it starts. Two taps from a fresh lobby, matching the two
    // decisions a host actually makes.
    if (lobbyTab !== 'race') { setLobbyPage('race'); return; }   // setLobbyPage buzzes
    startPending = true;  // optimistic; the snapshot that moves us off the lobby confirms it
    renderLobby();
    armStartGiveUp();
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
  // Pause is authoritative and must win the screen: if a popup is open when a
  // pause lands (both sit above the pause overlay), close it so the pause shows.
  if (on) closeAnyModal();
  el('pause-overlay').classList.toggle('hidden', !on);
  el('pause-btn').disabled = on;
  syncShellBack();   // a paused race welcomes back (= continue); a live one doesn't
}
el('pause-btn').addEventListener('click', () => { buzz(15); net.send(MSG.PAUSE_GAME); });
el('pause-continue').addEventListener('click', () => { buzz(15); net.send(MSG.RESUME_GAME); });
el('pause-newgame').addEventListener('click', () => { buzz(15); net.send(MSG.RETURN_TO_LOBBY); });

// Host's results button: mid-series it advances to the next race, otherwise it
// sends everyone to the lobby. It is the board's ONLY button — abandoning a
// running cup is the pause overlay's job (see resultsBoard's renderFoot).
el('newgame-btn').addEventListener('click', () => {
  if (!amHost) return;
  buzz(15);
  const s = lastStandings && lastStandings.series;
  net.send(s && !s.final ? MSG.SERIES_NEXT : MSG.RETURN_TO_LOBBY);
});

// Applies the launcher's rename locally (the labels that carry the name) AND
// broadcasts it to the display via a re-HELLO, exactly like a join.
installRenameHook((n) => {
  myName = n;
  el('me-name').textContent = n;    // lobby identity
  el('hud-name').textContent = n;   // in-race HUD
  refreshHelpName(n);               // settings demo phone
  net.rename(n);                    // → display roster + LOBBY_UPDATE echo
});

// Shell §9: what an armed back gesture DOES. A popup closes (motion above
// settings); a paused race continues; anywhere else — the lobby, the results —
// returning false hands the exit to the launcher, same as its LEAVE bar.
installBackHook(() => {
  if (closeTopModal()) return true;
  if (!el('pause-overlay').classList.contains('hidden')) { net.send(MSG.RESUME_GAME); return true; }
  return false;
});

// Boot. In the shell the launcher owns identity: skip the name screen entirely
// and join straight away with the injected name (never persisted). Otherwise land
// on the name screen and wait for the player to pick a name. (Scenario/gallery
// mode below never connects and always carries no cpName, so it's unaffected.)
if (inShell && shellName) {
  // Never flash the name screen (it's the default-visible section): hide it up
  // front and go straight to joining. The launcher's own joining spinner floats
  // over the blank sky until the replayed room snapshot lands and show('lobby')
  // takes over.
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

// No debug-settings wrench on the controller — it's the player-facing phone, so the
// query-param editor would ship to real players. Scenarios are still reachable
// directly via ?scenario=…&color=… (handled above); the gallery drives them that way.
