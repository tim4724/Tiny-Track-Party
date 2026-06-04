// Controller entry — name → lobby → drive. M2: tilt steering + swipe brake,
// streamed as CONTROL to the display; live lap/position HUD from PLAYER_STATE.
import { ControllerNet } from './Net.js';
import { TiltInput } from './TiltInput.js';

const { MSG, CAR_COLORS } = window;
const el = (id) => document.getElementById(id);

const screens = { name: el('name'), lobby: el('lobby'), game: el('game') };
function show(name) { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); }

let myColorIndex = null;
let amHost = false;

const NAME_KEY = 'toycar_name';
const storedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} };

const net = new ControllerNet({
  onJoined: () => setStatus(''),
  onStatus: (state, info) => {
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
      show('game'); el('drive-hud').classList.add('hidden');
      el('go').classList.remove('hidden');
      el('go').textContent = data.n > 0 ? data.n : 'GO!';
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
  tilt.start();
  const fill = el('steer-fill');
  const tip = el('motion-tip');
  tip.classList.toggle('hidden', tilt.motionState === 'granted');
  const brakeEl = el('brake-ind');
  const loop = () => {
    const st = tilt.state;
    fill.style.transform = `translateX(${st.steer * 50}%)`;
    brakeEl.classList.toggle('on', st.brake > 0.05);
    brakeEl.style.setProperty('--bfill', (st.brake * 100).toFixed(0) + '%');
    steerRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopDriving() {
  tilt.stop();
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

show('name');
window.__net = net; window.__tilt = tilt;
