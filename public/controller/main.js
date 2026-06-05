// Controller entry — name → lobby → drive. M2: tilt steering + swipe brake,
// streamed as CONTROL to the display; live lap/position HUD from PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { buildCarPicker } from '../shared/carPicker.js';
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

// haptics — vibrate the phone (ignored where unsupported)
const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) {} };

// Curb rumble: a *continuous*-feeling faint buzz while the car scrubs the wall.
// navigator.vibrate has no intensity control and no native loop, so we fake a
// steady light rumble with a fine pattern, renewed just before it ends — the
// motor never falls silent between updates, so it reads as one smooth hum, not
// taps. Softness has only one lever (duty cycle), so we keep the on-pulse very
// short (6ms) at a fast cycle (30ms ≈ 33Hz): low average power = faint, high
// frequency = the pulses blend together instead of feeling like a buzz.
// Tune: raise the 6 for a stronger rumble; raise the 24 (off-time) for fainter.
const SCRUB_UNIT = [6, 24];                               // 30ms cycle, ~20% duty: faint hum
const SCRUB_PATTERN = Array(40).fill(SCRUB_UNIT).flat();  // ~1.2s of soft rumble
const SCRUB_RENEW_MS = 1000;                              // renew before it ends (1.2s > 1.0s, no gap)
let _scrubOn = false, _scrubTimer = null;
function startScrub() {
  if (_scrubOn) return;
  _scrubOn = true;
  buzz(SCRUB_PATTERN);
  _scrubTimer = setInterval(() => buzz(SCRUB_PATTERN), SCRUB_RENEW_MS);
}
function stopScrub() {
  if (!_scrubOn) return;
  _scrubOn = false;
  clearInterval(_scrubTimer); _scrubTimer = null;
  buzz(0); // cancel any residual vibration immediately
}

let myColorIndex = null;
let myCarIndex = 0;
let amHost = false;
let roster = [];           // latest lobby roster (for the host name in the wait text)
let hostPeerIndex = null;
let inResults = false;     // showing the results overlay (my car finished / race over)

const NAME_KEY = 'tinytrack_name';
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };

const net = new ControllerNet({
  onJoined: () => setStatus(''),
  onStatus: (state, info) => {
    if (state !== 'reconnecting') stopScrub(); // never leave the curb rumble stuck on
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
    case MSG.WELCOME:
      myColorIndex = data.colorIndex;
      if (data.carIndex != null) myCarIndex = data.carIndex;
      applyLivery();
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      renderLobby();
      if (data.roomState === 'lobby') show('lobby');
      break;
    case MSG.LOBBY_UPDATE: {
      roster = data.players || [];
      hostPeerIndex = data.hostPeerIndex;
      amHost = net.isHost(data.hostPeerIndex);
      // The display is authoritative — adopt the colour + car it has on record
      // for us (colour is auto-assigned; car confirms our pick).
      const me = (data.players || []).find((p) => p.peerIndex === net.peerIndex);
      if (me) {
        myColorIndex = me.colorIndex;
        if (me.carIndex != null) myCarIndex = me.carIndex;
        applyLivery();
      }
      renderLobby();
      break;
    }
    case MSG.COUNTDOWN:
      inResults = false;               // a fresh race clears any leftover results overlay
      show('game');
      el('drive-hud').classList.remove('hidden'); // show controls so players can pre-steer
      if (data.n >= 0) {
        el('go').classList.remove('hidden');
        el('go').textContent = data.n > 0 ? data.n : 'GO!';
        el('go').classList.toggle('is-go', data.n === 0); // fade out on GO!
        buzz(data.n > 0 ? 20 : [0, 90]); // tick on counts, stronger on GO
      } else {
        el('go').classList.add('hidden'); // GO! banner gone the beat after the start
        el('go').classList.remove('is-go');
      }
      setPauseOverlay(false);          // a fresh countdown clears any stale pause UI
      el('pause-btn').classList.remove('hidden');
      startDriving();                  // stream tilt during the countdown (display reacts)
      break;
    case MSG.GAME_START:
      // Fires on the "GO!" beat; leave the GO! banner up (the n<0 COUNTDOWN
      // tick hides it) so it doesn't flash away the instant the race starts.
      show('game');
      el('drive-hud').classList.remove('hidden');
      el('pause-btn').classList.remove('hidden');
      startDriving();
      break;
    case MSG.PLAYER_STATE:
      if (inResults) break;            // finished → results overlay owns the screen now
      el('lap').textContent = `Lap ${data.lap}/${data.totalLaps}`;
      el('pos').textContent = `P${data.position}`;
      el('pos').classList.toggle('leader', data.position === 1);
      if (data.finished) el('pos').textContent = `Finished P${data.position}`;
      data.scrub ? startScrub() : stopScrub(); // continuous soft curb rumble
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
      stopScrub();                     // never leave the curb rumble buzzing while frozen
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
  buildCarPicker({ heroEl: el('car-hero'), stripEl: el('carpick'), selected: myCarIndex, onPick: chooseCar });
  el('start-btn').classList.toggle('hidden', !amHost);
  const waitEl = el('wait-host');
  waitEl.classList.toggle('hidden', amHost);
  if (!amHost) renderWaitHost(waitEl);
}

function renderWaitHost(waitEl) {
  const host = roster.find((p) => p.peerIndex === hostPeerIndex);
  renderWaitNote(waitEl, { name: host && host.name, color: host && CAR_COLORS[host.colorIndex] }, ' to start…');
}

function chooseCar(i) {
  if (i === myCarIndex) return;
  myCarIndex = i;       // optimistic; LOBBY_UPDATE is the source of truth
  renderLobby();        // move the highlight now
  net.send(MSG.SET_CAR, { carIndex: i });
  buzz(15);
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
  stopScrub(); // kill any curb rumble when the race ends / we leave the track
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
  saveName(n);
  // Request motion permission within this user gesture (iOS requirement).
  tilt.enableMotion();
  setStatus('');           // the disabled button signals the in-flight join
  setJoining(true);
  net.connect(n);
});

el('start-btn').addEventListener('click', () => { if (amHost) net.send(MSG.START_GAME); });

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

// BRAKE button — held = brake at the fixed rate, released = release
const brakeBtn = el('brake-btn');
const pressBrake = (on) => { tilt.pressBrake(on); brakeBtn.classList.toggle('held', on); };
brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressBrake(true); });
brakeBtn.addEventListener('pointerup', () => pressBrake(false));
brakeBtn.addEventListener('pointercancel', () => pressBrake(false));
brakeBtn.addEventListener('pointerleave', () => pressBrake(false));

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
