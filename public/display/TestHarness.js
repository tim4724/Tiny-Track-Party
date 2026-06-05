// Display Test Harness — drives a single display screen in isolation for the
// gallery (/gallery.html), with NO relay connection. main.js delegates here
// when the URL carries ?test=1 / ?scenario=…, handing over the live scene +
// track so we can stand up the lobby, countdown, a self-driving race preview,
// or the results overlay from fake data.
//
// The race scenarios reuse the real Game engine; cars are steered by a small
// pure-pursuit autopilot (the engine has no AI of its own) so the split-screen
// chase cams, HUD, lean, and dust all show real motion in the preview.
import { Game } from './engine/Game.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { fetchQR, renderQR, renderJoinUrl } from './Net.js';
import { carThumbNode } from '../shared/carThumbs.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const FAKE_TIMES = [28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6];

const el = (id) => document.getElementById(id);

// runDisplayScenario(opts, ctx)
//   opts: { scenario, players, host }
//   ctx:  { scene, track, scenePromise }  (live instances built by main.js)
export function runDisplayScenario(opts, ctx) {
  const COLORS = window.CAR_COLORS || ['#e6492d'];
  const TOTAL_LAPS = window.TOTAL_LAPS || 3;
  const scenario = opts.scenario || 'racing';
  // != null (not ||) so an explicit players=0 clamps to 1 rather than 4.
  const players = Math.max(1, Math.min(opts.players != null ? opts.players : 4, COLORS.length));
  const host = (opts.host == null || isNaN(opts.host)) ? null : Math.max(0, Math.min(opts.host, 7));

  const screens = { lobby: el('lobby'), race: el('race') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  window.__TEST__ = window.__TEST__ || {};

  // ---- lobby roster ----
  // Slots usually fill 0..players-1; if the chosen host lives outside that
  // range, swap in the host slot so the previewed roster actually contains it.
  function buildSlots(n) {
    const slots = [];
    let fill = n;
    const needHost = host != null && host >= n && host < COLORS.length;
    if (needHost) fill = n - 1;
    for (let i = 0; i < fill; i++) slots.push(i);
    if (needHost) slots.push(host);
    return slots;
  }

  function hostSlot(slots) {
    if (host != null && slots.includes(host)) return host;
    return slots.length ? slots[0] : null;
  }

  // Mirror display/main.js: always lay out >= 4 seats; empties are placeholders.
  // Each filled seat shows the car that player picked (a real render); for the
  // preview we vary the car per slot so the lobby shows a mix of models.
  const MIN_SEATS = 4;
  const MODELS = window.CAR_MODELS || [];
  function renderRoster(slots, hostPeerIndex) {
    const list = el('players'); list.innerHTML = '';
    const seats = Math.max(MIN_SEATS, slots.length);
    for (let i = 0; i < seats; i++) {
      const s = slots[i];
      const seat = document.createElement('div');
      if (s != null) {
        seat.className = 'seat';
        seat.style.setProperty('--c', COLORS[s % COLORS.length] || '#888');
        const row = document.createElement('div');
        row.className = 'seat__name';
        const dot = document.createElement('span'); dot.className = 'seat__dot';
        const nm = document.createElement('span'); nm.className = 'seat__label';
        nm.textContent = FAKE_NAMES[s] + (s === hostPeerIndex ? '  ★' : '');
        row.appendChild(dot); row.appendChild(nm);
        seat.appendChild(carThumbNode(MODELS[s % MODELS.length], { spin: true }));
        seat.appendChild(row);
      } else {
        seat.className = 'seat seat--open';
        const ph = document.createElement('div'); ph.className = 'seat__open';
        const lab = document.createElement('div'); lab.className = 'seat__name';
        const nm = document.createElement('span'); nm.className = 'seat__label'; nm.textContent = 'Open';
        lab.appendChild(nm);
        seat.appendChild(ph); seat.appendChild(lab);
      }
      list.appendChild(seat);
    }
    el('count').textContent = slots.length
      ? `${slots.length} racer${slots.length > 1 ? 's' : ''} ready`
      : 'Waiting for players…';
  }

  function fakeJoin(code) {
    renderJoinUrl(el('joinurl'), (location.host || 'tinytrack.party') + '/' + code, code);
    fetchQR((location.origin || 'https://tinytrack.party') + '/' + code)
      .then((m) => renderQR(el('qr'), m))
      .catch(() => { /* gallery still works without the QR */ });
  }

  if (scenario === 'welcome') {
    show('lobby');
    renderRoster([], null);
    el('joinurl').textContent = (location.host || 'tinytrack.party');
    fetchQR((location.origin || 'https://tinytrack.party')).then((m) => renderQR(el('qr'), m)).catch(() => {});
    return;
  }

  if (scenario === 'lobby') {
    const slots = buildSlots(players);
    show('lobby');
    renderRoster(slots, hostSlot(slots));
    fakeJoin('TEST');
    return;
  }

  // ---- race scenarios (countdown / racing / results) ----
  // Switch to the race screen synchronously so the lobby (QR/roster/join URL)
  // doesn't flash while the GLBs load. Build the engine + scene cars once the
  // GLBs are ready, place them at the grid, then install our own frame hook.
  show('race');
  el('results').classList.add('hidden');
  ctx.scenePromise.then(() => setupRace(scenario)).catch((e) => console.warn('[TestHarness] scene load failed', e));

  function setupRace(kind) {
    const { scene, track } = ctx;
    // (race screen already shown synchronously above, before the GLB load)

    const ids = [];
    for (let i = 0; i < players; i++) ids.push(i);

    let engine = new Game(ids, track, { onEvent() {} });
    window.__engine = engine;

    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i]));

    const placeGrid = () => {
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.pose.tangent, c.pose.lookAhead);
      }
    };
    placeGrid();

    const live = kind === 'racing';

    // Self-driving preview: every car is an AI racer using the SAME pure-pursuit
    // autopilot as the live CPU fill (AiDriver), so the gallery shows the real bot
    // behaviour — fanned lanes, a spread of speeds — not a bespoke demo loop.
    const bots = new Map(ids.map((i) => [i, new AiController(AI_PERSONALITIES[i % AI_PERSONALITIES.length])]));
    function autosteer() {
      for (const c of engine.cars.values()) {
        if (c.finished || !c.pose) continue;
        engine.processInput(c.id, bots.get(c.id).drive(c, track.centerline));
      }
    }

    let lastHud = 0;
    scene.onFrame = (dt) => {
      if (live) {
        autosteer();
        engine.update(dt * 1000);
      }
      const snap = engine.getSnapshot();
      for (const c of snap.cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.pose.tangent, c.pose.lookAhead, c.steer, c.spd, c.onWall, c.steerInput);
      }
      if (live) {
        const now = performance.now();
        if (now - lastHud > 160) {
          lastHud = now;
          for (const c of snap.cars) scene.setCarHud(c.id, c);
        }
        // Endless preview: once everyone crosses the line, reset and lap again.
        if (engine.raceOver) {
          engine = new Game(ids, track, { onEvent() {} });
          window.__engine = engine;
          placeGrid();
        }
      }
    };

    if (kind === 'countdown') {
      // HUD shows lap 1 while the lights count down.
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      runCountdown();
    } else if (kind === 'paused') {
      // Spin the field forward a few seconds so it reads mid-race, freeze it
      // (speed 0 → no wheel dust), then show the pause button + overlay over it.
      for (let t = 0; t < 90; t++) { autosteer(); engine.update(33); }
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.pose.tangent, c.pose.lookAhead, c.steer, 0, false, c.steerInput);
        scene.setCarHud(c.id, c);
      }
      scene.onFrame = null; // frozen: no per-frame re-pose
      el('pause-btn').classList.remove('hidden');
      el('pause-overlay').classList.remove('hidden');
    } else if (kind === 'results') {
      // Freeze the grid behind the blurred results overlay.
      const slots = buildSlots(players);
      const listEl = el('results-list'); listEl.innerHTML = '';
      slots.forEach((s, i) => {
        const col = COLORS[s % COLORS.length] || '#888';
        const li = document.createElement('li');
        li.innerHTML =
          `<span class="stand__dot" style="background:${col}"></span> ${FAKE_NAMES[s]}` +
          `<span class="res-time">${FAKE_TIMES[i].toFixed(1)}s</span>`;
        listEl.appendChild(li);
      });
      el('results').classList.remove('hidden');
    }
  }

  function runCountdown() {
    const cd = el('countdown');
    let timers = [];
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const seq = ['3', '2', '1', 'GO!'];
    function run() {
      clear();
      let i = 0;
      (function tick() {
        cd.textContent = seq[i];
        i++;
        if (i < seq.length) timers.push(setTimeout(tick, 800));
        else timers.push(setTimeout(() => { cd.textContent = '3'; }, 1200)); // rest at "3"
      })();
    }
    cd.textContent = '3'; // frozen initial frame; ▶ replays the sequence
    window.__TEST__.replay = run;
  }
}
