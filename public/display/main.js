// Display entry — lobby + authoritative race. Owns the Three.js scene, the car
// engine, the countdown→race→results flow, and per-player PLAYER_STATE.
import { DisplayNet, fetchQR, renderQR } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildTrack, OVAL } from './TrackBuilder.js';
import { Game } from './engine/Game.js';
// Sound is intentionally disabled for now (Audio.js kept for a later pass).

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS } = window;
const el = (id) => document.getElementById(id);
const screens = { lobby: el('lobby'), race: el('race') };
const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

// ---- scene + track (built once) ----
const track = buildTrack(OVAL);
track.totalLaps = TOTAL_LAPS;
const scene = new SceneRenderer(el('scene'), CAR_COLORS);
let sceneReady = false;
// Kept as a promise too so the gallery TestHarness can wait for the GLBs +
// track before placing its preview cars.
const scenePromise = scene.load().then(() => { scene.setTrack(track); sceneReady = true; scene.start(); });

// ---- race state ----
let engine = null;
let racing = false;
let lastPlayerState = 0;

scene.onFrame = (dt) => {
  if (!engine) return;
  // During the countdown the engine exists but isn't `racing` yet: we still draw
  // the cars and let them react to steering (wheels/lean/indicator) so players
  // can get a feel for their tilt — they just don't move until GO.
  if (racing) engine.update(dt * 1000);
  const snap = engine.getSnapshot();
  for (const c of snap.cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.pose.tangent, c.pose.lookAhead, c.steer, c.spd, c.onWall, c.steerInput);
  }
  if (!racing) return; // countdown: visible + steerable, but no race progress / HUD yet
  // throttle HUD + PLAYER_STATE to ~6 Hz
  const now = performance.now();
  if (now - lastPlayerState > 160) {
    lastPlayerState = now;
    for (const c of snap.cars) {
      scene.setCarHud(c.id, c);
      net.sendTo(c.id, {
        type: MSG.PLAYER_STATE, lap: c.lap, totalLaps: c.totalLaps,
        position: c.position, of: c.of, finished: c.finished, scrub: c.onWall
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

// A player who leaves during a countdown/race forfeits: drop their car so it
// doesn't drive on as a ghost and doesn't block the race from ever ending.
net.flow.on('playerleave', ({ peerIndex }) => {
  if (!engine || !engine.removeCar(peerIndex)) return;
  scene.removeCar(peerIndex);
  if (racing && engine.raceOver) endRace();
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
  show('race');
  el('results').classList.add('hidden');

  // (re)build engine + cars
  engine = new Game(players.map((p) => p.peerIndex), track, { onEvent: onRaceEvent });
  window.__engine = engine;
  for (const c of [...scene.cars.keys()]) scene.removeCar(c);
  for (const p of players) scene.addCar(p.peerIndex, p.colorIndex, p.name);
  // place cars at their grid poses immediately
  for (const c of engine.getSnapshot().cars) if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.pose.tangent, c.pose.lookAhead);

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
      net.broadcast({ type: MSG.GAME_START });
      racing = true;
      // Fail-safe: a car that can never finish (player AFK, holding full brake,
      // or gone mid-race) would otherwise hang the room forever, since the race
      // only ends once every car crosses the line. Cap the race so stragglers
      // are DNF'd and everyone returns to the lobby. A clean 3-lap is ~50-80s;
      // this is a generous ceiling, not a target.
      clearTimeout(raceTimer);
      raceTimer = setTimeout(() => { if (racing) endRace(); }, MAX_RACE_MS);
    }
  }, 1000);
}

function onRaceEvent(e) {
  // hook for SFX / FX (lap, finish, race_over) — sound disabled for now
}

const MAX_RACE_MS = 180000; // hard race ceiling (see fail-safe note in startRace)
let endTimer = null;
let raceTimer = null;
function endRace() {
  if (!racing) return;
  racing = false;
  clearTimeout(raceTimer);
  const results = engine.getResults();
  net.flow.transitionTo(ROOM_STATE.RESULTS);
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
  for (const c of scene.cars.keys()) scene.removeCar(c);
  engine = null;
  net.broadcast({ type: MSG.GAME_END, results: [] }); // controllers return to lobby
  show('lobby');
}

// Gallery / test mode: ?test=1 (or any ?scenario=…) skips the relay and lets
// the TestHarness drive a single screen from fake data. Normal play connects.
const _params = new URLSearchParams(location.search);
const _scenario = _params.get('scenario');
if (_params.get('test') === '1' || _scenario) {
  const _int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
  import('./TestHarness.js').then(({ runDisplayScenario }) => runDisplayScenario(
    {
      scenario: _scenario || 'racing',
      players: _int(_params.get('players'), 4),
      host: _params.get('host') === null ? null : _int(_params.get('host'), 0)
    },
    { scene, track, scenePromise }
  ));
} else {
  show('lobby');
  net.start();
}
window.__net = net; window.__scene = scene; window.__startRace = startRace;
