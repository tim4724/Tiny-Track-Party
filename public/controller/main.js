// Controller entry — name → lobby → drive. M2: tilt steering + swipe brake,
// streamed as CONTROL to the display; live lap/position HUD from PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';

const { MSG, CAR_COLORS } = window;
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
let amHost = false;

const NAME_KEY = 'tinytrack_name';
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };

const net = new ControllerNet({
  onJoined: () => setStatus(''),
  onStatus: (state, info) => {
    if (state !== 'reconnecting') stopScrub(); // never leave the curb rumble stuck on
    if (state === 'reconnecting') setStatus(`Reconnecting… (${Math.min(info.attempt, info.max)}/${info.max})`);
    else if (state === 'error') setStatus('Error: ' + info);
    else if (state === 'display_gone') setStatus('Waiting for the big screen…');
    else if (state === 'replaced') setStatus('Opened on another tab.');
  },
  onMessage: handleMessage
});

const tilt = new TiltInput({
  surface: el('game'),
  onControl: (c) => net.send(MSG.CONTROL, c)
});

function setStatus(t) { el('name-status').textContent = t; }

function handleMessage(data) {
  switch (data.type) {
    case MSG.WELCOME:
      myColorIndex = data.colorIndex; applyLivery();
      amHost = net.isHost(data.hostPeerIndex);
      renderLobby(data.players, data.hostPeerIndex);
      if (data.roomState === 'lobby') show('lobby');
      break;
    case MSG.LOBBY_UPDATE:
      amHost = net.isHost(data.hostPeerIndex);
      renderLobby(data.players, data.hostPeerIndex);
      break;
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
  el('mycar').style.background = c;
}

function renderLobby(players, hostPeerIndex) {
  const list = el('roster'); list.innerHTML = '';
  for (const p of (players || [])) {
    const li = document.createElement('div');
    li.className = 'row' + (p.peerIndex === net.peerIndex ? ' row--me' : '');
    const dot = document.createElement('span');
    dot.className = 'row__dot'; dot.style.background = CAR_COLORS[p.colorIndex] || '#888';
    li.appendChild(dot);
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.peerIndex === hostPeerIndex ? ' ★' : '');
    li.appendChild(nm);
    list.appendChild(li);
  }
  el('start-btn').classList.toggle('hidden', !amHost);
  el('wait-host').classList.toggle('hidden', amHost);
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
  setStatus('Connecting…');
  net.connect(n);
});

el('start-btn').addEventListener('click', () => { if (amHost) net.send(MSG.START_GAME); });
el('recenter-btn').addEventListener('click', () => tilt.recenter());

// BRAKE button — held = brake at the fixed rate, released = release
const brakeBtn = el('brake-btn');
const pressBrake = (on) => { tilt.pressBrake(on); brakeBtn.classList.toggle('held', on); };
brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressBrake(true); });
brakeBtn.addEventListener('pointerup', () => pressBrake(false));
brakeBtn.addEventListener('pointercancel', () => pressBrake(false));
brakeBtn.addEventListener('pointerleave', () => pressBrake(false));

show('name');
window.__net = net; window.__tilt = tilt;
