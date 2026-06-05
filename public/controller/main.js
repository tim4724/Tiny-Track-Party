// Controller entry — name → lobby → drive. M2: tilt steering + swipe brake,
// streamed as CONTROL to the display; live lap/position HUD from PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';
import { carThumbNode } from '../shared/carThumbs.js';

const { MSG, CAR_COLORS, CAR_MODELS, CAR_NAMES } = window;
const el = (id) => document.getElementById(id);

const screens = { name: el('name'), lobby: el('lobby'), game: el('game') };
function show(name) { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); }

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

// Latency chip (bottom-right). halfMs is one-way (RTT/2); halfMs < 0 means the
// PONG is overdue (no signal). viaFastlane lights the bolt when the reading came
// off the P2P DataChannel rather than the WS relay. Stays hidden until the first
// reading lands so it never flashes on the pre-join name screen.
const latencyEl = el('latency');
function updateLatency(halfMs, viaFastlane) {
  if (!latencyEl) return;
  latencyEl.classList.remove('hidden', 'latency--good', 'latency--ok', 'latency--bad');
  latencyEl.classList.toggle('latency--fastlane', !!viaFastlane);
  const textEl = latencyEl.querySelector('.latency__text');
  if (halfMs < 0) {
    textEl.textContent = 'no signal';
    latencyEl.classList.add('latency--bad');
  } else {
    textEl.textContent = halfMs + ' ms';
    latencyEl.classList.add(halfMs < 50 ? 'latency--good' : halfMs < 100 ? 'latency--ok' : 'latency--bad');
  }
}

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
      show('game');
      el('drive-hud').classList.remove('hidden'); // show controls so players can pre-steer
      el('go').classList.remove('hidden');
      el('go').textContent = data.n > 0 ? data.n : 'GO!';
      startDriving();                  // stream tilt during the countdown (display reacts)
      buzz(data.n > 0 ? 20 : [0, 90]); // tick on counts, stronger on GO
      break;
    case MSG.GAME_START:
      show('game');
      el('go').classList.add('hidden');
      el('drive-hud').classList.remove('hidden');
      startDriving();
      break;
    case MSG.PLAYER_STATE:
      el('lap').textContent = `Lap ${data.lap}/${data.totalLaps}`;
      el('pos').textContent = `P${data.position}`;
      el('pos').classList.toggle('leader', data.position === 1);
      if (data.finished) el('pos').textContent = `Finished P${data.position}`;
      data.scrub ? startScrub() : stopScrub(); // continuous soft curb rumble
      break;
    case MSG.GAME_END:
      stopDriving();
      show('lobby');
      break;
  }
}

function applyLivery() {
  const c = CAR_COLORS[myColorIndex] || '#888';
  document.documentElement.style.setProperty('--car', c);
}

// Car picker — the controller's lobby is just "pick your car" (the shared
// display owns the player roster). Every car model is shown as a real pre-baked
// render (a plain <img>, so the phone needs no WebGL/Three.js — see carThumbs).
// Car and colour are independent and duplicates are fine, so there's no
// locking; the player's livery shows as the selection ring, not a body tint. A
// tap is optimistic — the next LOBBY_UPDATE echoes back the display's record.
// In spin mode the current pick rotates (one turntable APNG at a time); the
// rest stay stills.
const CAR_COUNT = (CAR_MODELS || []).length;
const carLabel = (i) => (CAR_NAMES && CAR_NAMES[i]) || ('Car ' + (i + 1));
function renderLobby() {
  const pick = el('carpick'); pick.innerHTML = '';
  for (let i = 0; i < CAR_COUNT; i++) {
    const mine = i === myCarIndex;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'car-opt' + (mine ? ' car-opt--mine' : '');
    if (mine) btn.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'car-opt__name';
    name.textContent = carLabel(i);
    btn.appendChild(carThumbNode(CAR_MODELS[i], { spin: mine })); // mine spins (others still)
    btn.appendChild(name);
    btn.addEventListener('click', () => chooseCar(i));
    pick.appendChild(btn);
  }
  el('start-btn').classList.toggle('hidden', !amHost);
  const waitEl = el('wait-host');
  waitEl.classList.toggle('hidden', amHost);
  if (!amHost) renderWaitHost(waitEl);
}

// "Waiting for NAME to start…" — NAME is the host, tinted in their livery
// colour (matching the in-race name plate). Built from DOM nodes so a
// player-supplied name is always inserted as text, never markup. Falls back to
// "the host" until the roster naming the host has arrived.
function renderWaitHost(waitEl) {
  const host = roster.find((p) => p.peerIndex === hostPeerIndex);
  const nameEl = document.createElement('span');
  nameEl.className = 'host-name';
  nameEl.textContent = (host && host.name) || 'the host';
  if (host) nameEl.style.color = CAR_COLORS[host.colorIndex] || '';
  waitEl.textContent = 'Waiting for ';
  waitEl.append(nameEl, ' to start…');
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
    color: _int(_params.get('color'), 0),
    players: _int(_params.get('players'), 4)
  }));
}

window.__net = net; window.__tilt = tilt;
