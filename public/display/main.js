// Display entry — lobby + authoritative race. Owns the Three.js scene, the car
// engine, the countdown→race→results flow, and per-player PLAYER_STATE.
import { DisplayNet, fetchQR, renderQR } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildTrack, OVAL } from './TrackBuilder.js';
import { Game } from './engine/Game.js';

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS } = window;
const el = (id) => document.getElementById(id);
const screens = { lobby: el('lobby'), race: el('race') };
const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

// ---- scene + track (built once) ----
const track = buildTrack(OVAL);
track.totalLaps = TOTAL_LAPS;
const scene = new SceneRenderer(el('scene'), CAR_COLORS);
let sceneReady = false;
scene.load().then(() => { scene.setTrack(track); sceneReady = true; scene.start(); });

// ---- race state ----
let engine = null;
let racing = false;
let lastPlayerState = 0;

scene.onFrame = (dt) => {
  if (!racing || !engine) return;
  engine.update(dt * 1000);
  const snap = engine.getSnapshot();
  for (const c of snap.cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.tangent, c.pose.up, -c.steer * 0.25);
  }
  // throttle HUD + PLAYER_STATE to ~6 Hz
  const now = performance.now();
  if (now - lastPlayerState > 160) {
    lastPlayerState = now;
    for (const c of snap.cars) {
      scene.setCarHud(c.id, c);
      net.sendTo(c.id, {
        type: MSG.PLAYER_STATE, lap: c.lap, totalLaps: c.totalLaps,
        position: c.position, of: c.of, finished: c.finished
      });
    }
  }
  if (engine.raceOver) endRace();
};

// ---- net ----
const net = new DisplayNet({
  onRoomReady: async ({ roomCode, joinUrl }) => {
    el('code').textContent = roomCode;
    try { const u = new URL(joinUrl); el('joinurl').textContent = u.host + u.pathname; }
    catch (_) { el('joinurl').textContent = joinUrl; }
    try { renderQR(el('qr'), await fetchQR(joinUrl)); } catch (e) { console.warn('QR failed', e); }
  },
  onRosterChange: renderRoster,
  onControllerMessage: (from, data) => {
    if (data.type === MSG.CONTROL && engine) engine.processInput(from, data);
    else if (data.type === MSG.START_GAME && from === net.flow.host && net.flow.connectedCount > 0) startRace();
  }
});

function renderRoster(roster, hostPeerIndex) {
  const list = el('players'); list.innerHTML = '';
  for (const p of roster) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.connected ? '' : ' chip--off');
    const dot = document.createElement('span');
    dot.className = 'chip__dot'; dot.style.background = CAR_COLORS[p.colorIndex] || '#888';
    chip.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = p.name + (p.peerIndex === hostPeerIndex ? '  ★' : '');
    chip.appendChild(name);
    list.appendChild(chip);
  }
  el('count').textContent = roster.length ? `${roster.length} racer${roster.length > 1 ? 's' : ''} ready` : 'Waiting for players…';
  el('hint').classList.toggle('hidden', roster.length === 0);
}

function rosterById() {
  const m = new Map();
  for (const p of net.flow.list()) m.set(p.peerIndex, p);
  return m;
}

// ---- race lifecycle ----
function startRace() {
  if (net.roomState !== ROOM_STATE.LOBBY || !sceneReady) return;
  const players = net.flow.list();
  if (!players.length) return;

  net.flow.transitionTo(ROOM_STATE.COUNTDOWN);
  net.setRoomState(ROOM_STATE.COUNTDOWN);
  show('race');
  el('results').classList.add('hidden');

  // (re)build engine + cars
  engine = new Game(players.map((p) => p.peerIndex), track, { onEvent: onRaceEvent });
  window.__engine = engine;
  for (const c of [...scene.cars.keys()]) scene.removeCar(c);
  for (const p of players) scene.addCar(p.peerIndex, p.colorIndex, p.name);
  // place cars at their grid poses immediately
  for (const c of engine.getSnapshot().cars) if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.tangent, c.pose.up);

  let n = COUNTDOWN_SECONDS;
  el('countdown').textContent = n;
  net.broadcast({ type: MSG.COUNTDOWN, n });
  const tick = setInterval(() => {
    n -= 1;
    if (n > 0) { el('countdown').textContent = n; net.broadcast({ type: MSG.COUNTDOWN, n }); }
    else if (n === 0) { el('countdown').textContent = 'GO!'; net.broadcast({ type: MSG.COUNTDOWN, n: 0 }); }
    else {
      clearInterval(tick);
      el('countdown').textContent = '';
      net.flow.transitionTo(ROOM_STATE.PLAYING);
      net.setRoomState(ROOM_STATE.PLAYING);
      net.broadcast({ type: MSG.GAME_START });
      racing = true;
    }
  }, 1000);
}

function onRaceEvent(e) {
  // hook for SFX / FX later (lap, finish, race_over)
}

let endTimer = null;
function endRace() {
  if (!racing) return;
  racing = false;
  const results = engine.getResults();
  net.flow.transitionTo(ROOM_STATE.RESULTS);
  net.setRoomState(ROOM_STATE.RESULTS);
  net.broadcast({ type: MSG.GAME_END, results: results.results });
  showResults(results);
  clearTimeout(endTimer);
  endTimer = setTimeout(returnToLobby, 7000);
}

function showResults(results) {
  const r = rosterById();
  el('results-list').innerHTML = results.results.map((res) => {
    const p = r.get(res.playerId) || {};
    const col = CAR_COLORS[p.colorIndex] || '#888';
    const time = res.finished ? `${res.time.toFixed(1)}s` : 'DNF';
    return `<li><span class="stand__dot" style="background:${col}"></span> ${p.name || res.playerId} <span class="res-time">${time}</span></li>`;
  }).join('');
  el('results').classList.remove('hidden');
}

function returnToLobby() {
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  net.setRoomState(ROOM_STATE.LOBBY);
  for (const c of scene.cars.keys()) scene.removeCar(c);
  engine = null;
  net.broadcast({ type: MSG.GAME_END, results: [] }); // controllers return to lobby
  show('lobby');
}

show('lobby');
net.start();
window.__net = net; window.__scene = scene; window.__startRace = startRace;
