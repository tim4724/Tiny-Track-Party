// Controller entry — name → lobby → drive. M2: tilt steering + swipe brake,
// streamed as CONTROL to the display; live lap/position HUD from PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { buildCarPicker } from '../shared/carPicker.js';
import { buildTrackPicker } from '../shared/trackPicker.js';
import { applyLatencyChip, renderWaitNote } from './ui.js';

const { MSG, CAR_COLORS } = window;
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
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  // Push history only when stepping UP a level (name → lobby). Same-level and
  // back transitions don't push, so there's exactly one entry to pop: pressing
  // back from anywhere in the room returns to the name screen in one step.
  if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) history.pushState({ screen: name }, '');
}

// haptics — vibrate the phone (ignored where unsupported). The player's eyes are
// on the main display, not the phone, so a buzz is how a tap confirms it landed.
const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) {} };

// Brake rumble: a *continuous*-feeling LIGHT buzz for as long as BRAKE is held —
// the player's eyes-free confirmation they're braking (they're watching the car
// on the main display). navigator.vibrate has no intensity control, so "light" is
// faked with duty cycle: a short on-pulse at a fast cycle = low average motor
// power (faint) AND pulses too quick to feel apart (they blend into one smooth
// hum, not taps). It also has no native loop, so we play a long pattern and renew
// it just before it ends — the motor never falls silent.
// Tune: raise the 8 (on-time) for a stronger rumble; raise the 22 (off-time) for
// fainter. Keep the cycle (8+22=30ms) short or the pulses stop blending.
const BRAKE_PULSE = [8, 22];                               // 30ms cycle, ~27% duty: a light hum
const BRAKE_PATTERN = Array(60).fill(BRAKE_PULSE).flat();  // ~1.8s of rumble
const BRAKE_RENEW_MS = 1500;                               // renew before it ends (1.8s > 1.5s, no gap)
let _brakeTimer = null;
function startBrakeRumble() {
  if (_brakeTimer) return;
  buzz(BRAKE_PATTERN);
  _brakeTimer = setInterval(() => buzz(BRAKE_PATTERN), BRAKE_RENEW_MS);
}
function stopBrakeRumble() {
  if (!_brakeTimer) return;
  clearInterval(_brakeTimer); _brakeTimer = null;
  buzz(0); // cancel any residual vibration immediately
}

let myColorIndex = null;
let myCarIndex = 0;
let myName = '';           // this player's name, shown at the top of the lobby
let amHost = false;
let roster = [];           // latest lobby roster (for the host name in the wait text)
let hostPeerIndex = null;
let trackCatalog = [];     // [{id,name,svg}] from the display (WELCOME)
let selectedTrackId = null; // current track pick (host-controlled, echoed to all)
let inResults = false;     // showing the results overlay (my car finished / race over)

const NAME_KEY = 'tinytrack_name';
const TRACK_KEY = 'tinytrack_track';   // host's last-picked track id
const CAR_KEY = 'tinytrack_car';       // last-picked car model index
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };
const storedTrackId = () => { try { return localStorage.getItem(TRACK_KEY); } catch (_) { return null; } };
const saveTrackId = (id) => { try { localStorage.setItem(TRACK_KEY, id); } catch (_) {} };
const storedCarIndex = () => { try { const v = parseInt(localStorage.getItem(CAR_KEY), 10); return Number.isInteger(v) ? v : null; } catch (_) { return null; } };
const saveCarIndex = (i) => { try { localStorage.setItem(CAR_KEY, String(i)); } catch (_) {} };

const net = new ControllerNet({
  onJoined: () => setStatus(''),
  onStatus: (state, info) => {
    // Any status callback means the clean join→lobby path didn't carry us all the
    // way through, so re-enable the join form. It's a no-op once we've moved off
    // the name screen (the button is hidden), but it prevents a player getting
    // stuck on a disabled button — display gone, kicked, or reconnect exhausted.
    setJoining(false);
    if (state === 'reconnecting') setStatus(`Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`);
    else if (state === 'error') setStatus('Error: ' + info);
    else if (state === 'display_gone') setStatus('Waiting for the big screen…');
    else if (state === 'replaced') setStatus('Opened on another tab.');
  },
  onMessage: handleMessage,
  onRtt: updateLatency
});

// Latency chip (bottom-right). Stays hidden until the first reading lands so it
// never flashes on the pre-join name screen. See applyLatencyChip in ui.js.
const latencyEl = el('latency');
function updateLatency(halfMs, viaFastlane) { applyLatencyChip(latencyEl, halfMs, viaFastlane); }

const tilt = new TiltInput({
  surface: el('game'),
  onControl: (c) => net.send(MSG.CONTROL, c)
});

function setStatus(t) { el('name-status').textContent = t; }
// Lock the join form while a connection is in flight so a double-tap can't fire
// two joins; unlocked again only if the attempt errors out (success navigates
// away to the lobby).
function setJoining(on) {
  el('join-btn').disabled = on;
  el('name-input').disabled = on;
}

function handleMessage(data) {
  switch (data.type) {
    case MSG.WELCOME: {
      myColorIndex = data.colorIndex;
      if (data.carIndex != null) myCarIndex = data.carIndex;
      maybeRestoreCar();   // override the slot default with this phone's saved pick
      applyLivery();
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      if (data.tracks) trackCatalog = data.tracks;       // catalog ships once, on join
      if (data.trackId != null) selectedTrackId = data.trackId;
      const me = roster.find((p) => p.peerIndex === net.peerIndex);
      if (me && me.name) myName = me.name;
      renderLobby();
      if (data.roomState === 'lobby') show('lobby');
      break;
    }
    case MSG.LOBBY_UPDATE: {
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      if (data.trackId != null) selectedTrackId = data.trackId; // host's pick, echoed to all
      // The display is authoritative — adopt the colour + car it has on record
      // for us (colour is auto-assigned; car confirms our pick).
      const me = (data.players || []).find((p) => p.peerIndex === net.peerIndex);
      if (me) {
        myColorIndex = me.colorIndex;
        if (me.carIndex != null) myCarIndex = me.carIndex;
        if (me.name) myName = me.name;
        applyLivery();
      }
      renderLobby();
      break;
    }
    case MSG.COUNTDOWN:
      inResults = false;               // a fresh race clears any leftover results overlay
      show('game');
      el('drive-hud').classList.remove('hidden'); // full HUD up front — the countdown lives on the display
      if (data.n >= 0) buzz(data.n > 0 ? 20 : [0, 90]); // haptic tick on counts, stronger on GO
      setPauseOverlay(false);          // a fresh countdown clears any stale pause UI
      el('pause-btn').classList.remove('hidden');
      setHeldItem(null);               // USE off at the line (no PLAYER_STATE yet during countdown)
      startDriving();                  // stream tilt during the countdown (display reacts)
      break;
    case MSG.GAME_START:
      // Fires on the "GO!" beat. The HUD is already up from COUNTDOWN; this just
      // covers a player who joined too late to get the countdown messages.
      show('game');
      el('drive-hud').classList.remove('hidden');
      el('pause-btn').classList.remove('hidden');
      setHeldItem(null);
      startDriving();
      break;
    case MSG.PLAYER_STATE:
      if (inResults) break;            // finished → results overlay owns the screen now
      el('lap').textContent = `Lap ${data.lap}/${data.totalLaps}`;
      el('pos').textContent = `P${data.position}`;
      el('pos').classList.toggle('leader', data.position === 1);
      if (data.finished) el('pos').textContent = `Finished P${data.position}`;
      setHeldItem(data.item);          // lights the USE button (identity shows on the display)
      break;
    case MSG.STANDINGS: {
      // Live finish board. Refresh who's host (may have shifted if someone left)
      // and render; flip to the overlay once the race is over (everyone, incl.
      // DNF) or as soon as MY car crosses the line — I'm on autopilot now.
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      renderResults(data);
      const mine = (data.order || []).find((o) => o.playerId === net.peerIndex);
      if (data.over || (mine && mine.finished)) showResultsScreen();
      break;
    }
    case MSG.GAME_PAUSED:
      if (inResults) break;            // finished racers watch results, not the pause overlay
      stopBrakeRumble();               // the overlay covers BRAKE — don't hum through the pause
      setPauseOverlay(true);
      break;
    case MSG.GAME_RESUMED:
      if (inResults) break;
      setPauseOverlay(false);
      break;
    case MSG.GAME_END:
      inResults = false;
      stopDriving();
      setPauseOverlay(false);
      el('pause-btn').classList.add('hidden');
      show('lobby');
      break;
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
  show('results');
}

// Render the standings rows + the footer (host's "New game" vs a waiting note).
function renderResults(data) {
  const list = el('result-list');
  list.innerHTML = '';
  (data.order || []).forEach((o) => {
    const li = document.createElement('li');
    const isMe = o.playerId === net.peerIndex;
    if (isMe) li.classList.add('is-me');
    if (!o.finished) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = CAR_COLORS[o.colorIndex] || '#888';
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : isMe ? ' (You)' : '');
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (data.over ? 'DNF' : 'Racing…');
    li.append(dot, name, time);
    list.appendChild(li);
  });
  renderResultFoot(data);
}

// Footer: while cars are still out, a waiting note for everyone. Once the race is
// over, the host gets the "New game" button; everyone else is told who to wait on.
function renderResultFoot(data) {
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  if (!data.over) {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other racers to finish…';
  } else if (amHost) {
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    const host = (data.order || []).find((o) => o.playerId === hostPeerIndex);
    renderWaitNote(wait, { name: host && host.name, color: host && CAR_COLORS[host.colorIndex] }, ' to start a new game…');
  }
}

function applyLivery() {
  const c = CAR_COLORS[myColorIndex] || '#888';
  document.documentElement.style.setProperty('--car', c);
}

// Car picker — the controller's lobby is just "pick your car" (the shared display
// owns the player roster). A big HERO shows the selected car (spinning pre-baked
// render — a plain <img>, no WebGL on the phone — its name, and handling stat
// bars) above a compact strip of every model as a small still. Tapping a strip
// tile picks it; the hero (preview + stats) updates to match. Car and colour are
// independent and duplicates are fine, so there's no locking; the livery shows as
// the selection ring. A tap is optimistic — the next LOBBY_UPDATE echoes back the
// display's record. Layout lives in shared/carPicker.js (shared with the gallery).
function renderLobby() {
  maybeAutoSelectTrack();   // host: leave the display's plain diorama for the 3D preview right away
  el('me-name').textContent = myName || 'Racer'; // who you are, up top (livery dot is var(--car))
  buildCarPicker({ heroEl: el('car-hero'), stripEl: el('carpick'), selected: myCarIndex, onPick: chooseCar });
  renderTrackPicker();
  el('start-btn').classList.toggle('hidden', !amHost);
  el('start-btn').disabled = !selectedTrackId;   // greyed out until a track is picked
  const waitEl = el('wait-host');
  waitEl.classList.toggle('hidden', amHost);
  if (!amHost) renderWaitHost(waitEl);
}

// Track picker — schematic maps from the display's catalog. Host taps to change
// the track (SELECT_TRACK); everyone else sees the strip read-only with the
// current pick ringed, plus a "host picks" note. Hidden entirely until the
// catalog arrives (older display / pre-WELCOME). Layout in shared/trackPicker.js.
function renderTrackPicker() {
  const wrap = el('trackpick');
  if (!trackCatalog.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  buildTrackPicker({
    stripEl: el('track-strip'),
    catalog: trackCatalog, selected: selectedTrackId, canPick: amHost, onPick: chooseTrack
  });
  // Note line: only the non-host needs telling the host owns the pick. The host
  // always has a track selected (auto-picked on entry), so no prompt is shown.
  const note = el('track-note');
  if (!amHost) { note.textContent = 'The host picks the track'; note.classList.remove('hidden'); }
  else note.classList.add('hidden');
}

// Host auto-picks a track the moment they reach the lobby, so the display leaves
// its plain diorama for the live 3D preview without waiting for a tap. The pick
// is this phone's last-used track (saved on tap), falling back to the first in
// the catalog. Sent as SELECT_TRACK exactly like a manual choice — the display
// echoes it back to everyone via LOBBY_UPDATE. No-op for non-hosts, before the
// catalog arrives, or once a track is already chosen (incl. the display's own).
function maybeAutoSelectTrack() {
  if (!amHost || selectedTrackId || !trackCatalog.length) return;
  const stored = storedTrackId();
  const id = trackCatalog.some((t) => t.id === stored) ? stored : trackCatalog[0].id;
  selectedTrackId = id;   // optimistic; LOBBY_UPDATE is the source of truth
  net.send(MSG.SELECT_TRACK, { trackId: id });
}

function chooseTrack(id) {
  if (id === selectedTrackId) return;
  selectedTrackId = id;   // optimistic; LOBBY_UPDATE is the source of truth
  saveTrackId(id);        // remember it so the next lobby auto-picks this track
  renderTrackPicker();    // move the ring + name now
  net.send(MSG.SELECT_TRACK, { trackId: id });
  buzz(15);
}

function renderWaitHost(waitEl) {
  const host = roster.find((p) => p.peerIndex === hostPeerIndex);
  renderWaitNote(waitEl, { name: host && host.name, color: host && CAR_COLORS[host.colorIndex] }, ' to start…');
}

function chooseCar(i) {
  if (i === myCarIndex) return;
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
  const count = (window.CAR_MODELS || []).length;
  if (stored == null || stored < 0 || stored >= count || stored === myCarIndex) return;
  myCarIndex = stored;
  net.send(MSG.SET_CAR, { carIndex: stored });
}

// --- driving ---
let steerRaf = null;
function startDriving() {
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
  _heldItem = undefined; setHeldItem(null); // reset USE state for the next race
  inResults = false;
  amHost = false;
  roster = [];
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  setJoining(false);
  setStatus('');
  el('name-input').value = storedName();
  show('name');
  el('name-input').focus();
}
window.addEventListener('popstate', () => {
  if (currentScreen && currentScreen !== 'name') leaveToName();
});

el('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = el('name-input').value.trim().slice(0, 16) || 'Racer';
  myName = n;
  saveName(n);
  // Request motion permission within this user gesture (iOS requirement).
  tilt.enableMotion();
  setStatus('');           // the disabled button signals the in-flight join
  setJoining(true);
  net.connect(n);
});

el('start-btn').addEventListener('click', () => { if (amHost && selectedTrackId) net.send(MSG.START_GAME); });

// --- pause ---
// The display is authoritative over the paused state; the controller just
// requests a change and reacts to the GAME_PAUSED / GAME_RESUMED broadcast.
// While paused the overlay covers the screen, so the pause button is disabled.
function setPauseOverlay(on) {
  el('pause-overlay').classList.toggle('hidden', !on);
  el('pause-btn').disabled = on;
}
el('pause-btn').addEventListener('click', () => { buzz(15); net.send(MSG.PAUSE_GAME); });
el('pause-continue').addEventListener('click', () => { buzz(15); net.send(MSG.RESUME_GAME); });
el('pause-newgame').addEventListener('click', () => { buzz(15); net.send(MSG.RETURN_TO_LOBBY); });

// Results overlay: only the host gets the button; it sends everyone to the lobby.
el('newgame-btn').addEventListener('click', () => { if (amHost) { buzz(15); net.send(MSG.RETURN_TO_LOBBY); } });

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
const ITEM_LABEL = { boost: 'BOOST', banana: 'BANANA' };
let _heldItem = undefined;
function setHeldItem(item) {
  if (item === _heldItem) return;            // only react on a change
  _heldItem = item;
  actionBtn.disabled = !item;
  tilt.setActionEnabled(!!item);             // gate BOTH the button and the keyboard ACTION
  actionBtn.setAttribute('aria-label', item ? `Use ${ITEM_LABEL[item] || item}` : 'Use item');
  if (item) buzz(20);                        // eyes-free "you picked something up" (look at the TV for what)
}

show('name');

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
