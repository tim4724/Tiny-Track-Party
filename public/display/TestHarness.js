// Display Test Harness — drives a single display screen in isolation for the
// gallery (/gallery.html), with NO relay connection. main.js delegates here
// when the URL carries ?scenario=…, handing over the live scene +
// track so we can stand up the lobby, countdown, a self-driving race preview,
// or the results overlay from fake data.
//
// The race scenarios reuse the real Game engine; cars are steered by a small
// pure-pursuit autopilot (the engine has no AI of its own) so the split-screen
// chase cams, HUD, lean, and dust all show real motion in the preview.
import { Game } from './engine/Game.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { renderSeats, seatCountText } from './lobbySeats.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const FAKE_TIMES = [28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6];
// Held items per slot for the frozen previews (reconnect / finished) so the cell
// item indicator shows populated — a mix of boost/banana with some empty slots,
// rather than a field of empty squares. null = that slot is carrying nothing.
const PREVIEW_ITEMS = ['boost', 'banana', null, 'boost', 'banana', null, 'boost', null];
const giveItems = (engine) => { for (const c of engine.cars.values()) c.item = PREVIEW_ITEMS[c.id] || null; };

const el = (id) => document.getElementById(id);

// Standalone inspector camera. When a preview page is opened on its OWN (not in a
// gallery iframe), hand the overview camera to the viewer — drag to look, scroll to
// fly, WASD to glide, Q/E to drop/rise — so the scene can be inspected up close. In
// the gallery grid each card is an iframe → leave the scenario's own framing alone
// (you can't comfortably drag a thumbnail). A cross-origin frame throws on
// window.top, so treat that as framed. Call AFTER the scenario frames its shot (it
// reads scene._ovPos/_ovTarget). Returns true when it took over the camera.
function enableFreeCamIfStandalone(scene) {
  let inIframe = true;
  try { inIframe = window.self !== window.top; } catch (_) { inIframe = true; }
  if (inIframe) return false;
  scene.setFog(false); // flying around the scene: no haze clipping the far track
  // #race is a transparent z-2 overlay over the canvas; let pointer events fall
  // through to it so OrbitControls can listen (see .cam-free in display.css).
  document.documentElement.classList.add('cam-free');
  scene.enableUserCamera();
  showCamHint(); // surface the (otherwise invisible) drag + WASD/QE controls
  return true;
}

// One-time control legend for the free camera — the drag/WASD controls are
// otherwise invisible. Fades out on its own after a few seconds (the controls keep
// working regardless); styled by .cam-hint in display.css.
function showCamHint() {
  if (document.querySelector('.cam-hint')) return;
  const hint = document.createElement('div');
  hint.className = 'cam-hint';
  hint.textContent = 'Drag to look · scroll to zoom · WASD to move · Q/E to drop & rise';
  document.body.appendChild(hint);
  setTimeout(() => hint.classList.add('is-faded'), 6000);
}

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

  // Seat grid via the SAME renderer as the live lobby (lobbySeats.js), so the
  // preview can't drift from the real markup. The preview varies the car per
  // slot (carIndex = slot) so the lobby shows a mix of models.
  function renderRoster(slots, hostPeerIndex) {
    renderSeats(el('players'), slots.map((s) => ({
      name: FAKE_NAMES[s], colorIndex: s, carIndex: s, host: s === hostPeerIndex,
      // preview the readiness pill: everyone but the host has readied up
      ready: hostPeerIndex != null && s !== hostPeerIndex
    })));
    el('count').textContent = seatCountText(slots.length);
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

  if (scenario === 'device-choice') {
    // The wrong-device fork (display URL opened on a phone). Live it's
    // media-query driven and main.js pre-dismisses it for every gallery iframe,
    // so force it on with an inline display — viewport-independent here.
    // Behind it: the welcome lobby, exactly what boot shows while room
    // creation is deferred on the chooser (no room yet, so no QR).
    show('lobby');
    renderRoster([], null);
    el('joinurl').textContent = (location.host || 'tinytrack.party');
    el('device-choice').style.display = 'flex';
    return;
  }

  if (scenario === 'lobby') {
    const slots = buildSlots(players);
    show('lobby');
    renderRoster(slots, hostSlot(slots));
    fakeJoin('TEST');
    return;
  }

  // ---- track preview (used by the track gallery, /gallery-tracks.html) ----
  // Shows the WHOLE layout under a slowly orbiting overview camera, with a small
  // AI field driving it so you can read the line + scale. The cars are added
  // cell:false so the renderer keeps its single overview camera (no split-screen),
  // which is what makes the orbiting whole-track shot possible.
  if (scenario === 'track') {
    show('race');
    el('results').classList.add('hidden');
    ctx.scenePromise.then(() => setupTrackPreview()).catch((e) => console.warn('[TestHarness] scene load failed', e));

    function setupTrackPreview() {
      const { scene, track } = ctx;
      scene.setFog(false);   // track preview (grid thumbnail OR free-cam inspector): show the WHOLE circuit, no haze
      // Standalone ("open ↗" / own tab) → free-cam inspector; gallery iframe →
      // keep the calm auto-orbit turntable (you can't comfortably drag a thumbnail).
      if (!enableFreeCamIfStandalone(scene)) scene.orbit = true;

      const ids = [];
      for (let i = 0; i < players; i++) ids.push(i);
      let engine = new Game(ids, track, { onEvent() {} });
      window.__engine = engine;

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false → opponents in the shared world with no split-screen viewport,
      // so _order stays empty and the overview camera frames the whole track.
      ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i], { cell: false }));

      const placeGrid = () => {
        for (const c of engine.getSnapshot().cars) {
          if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
        }
      };
      placeGrid();

      const bots = new Map(ids.map((i) => [i, new AiController(AI_PERSONALITIES[i % AI_PERSONALITIES.length])]));
      scene.onFrame = (dt) => {
        for (const c of engine.cars.values()) {
          if (!c.finished && c.pose) engine.processInput(c.id, bots.get(c.id).drive(c, track.centerline, engine)); // pass the game so preview bots dodge hazards/poles too
        }
        engine.update(dt * 1000);
        for (const c of engine.getSnapshot().cars) {
          if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, c.spd, c.onWall, c.steerInput);
        }
        // Endless preview: once everyone finishes, reset and lap again.
        if (engine.raceOver) {
          engine = new Game(ids, track, { onEvent() {} });
          window.__engine = engine;
          placeGrid();
        }
      };
    }
    return;
  }

  // ---- mechanics showcase (gallery 'features') ----
  // A frozen, well-framed shot that reliably shows ALL the catch-up/hazard pieces
  // at once: a boost PAD, an item BOX, a dropped BANANA, an OIL slick (+cones), and
  // a car with an ACTIVE BOOST (gold aura). They're clustered down the longest
  // straight (overriding the track's authored positions just for this preview) so a
  // single 3/4 camera frames them; the engine is frozen (no update) so nothing drifts.
  if (scenario === 'features') {
    show('race');
    el('results').classList.add('hidden');
    ctx.scenePromise.then(() => setupFeatures()).catch((e) => console.warn('[TestHarness] scene load failed', e));

    // Start arclength of the longest horizontal straight (curvature ≈ 0).
    function longestStraight(cl, L) {
      const head = (s) => { const f = cl.sampleAt(((s % L) + L) % L); return Math.atan2(f.tangent.x, f.tangent.z); };
      const N = 240, ds = 1.0, TH = 0.045, flat = [];
      for (let i = 0; i < N; i++) {
        const s = (i / N) * L; let dh = head(s + ds) - head(s - ds);
        while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
        flat.push(Math.abs(dh) / (2 * ds) < TH);
      }
      let st = 0; while (st < N && flat[st]) st++;             // rotate to a corner so runs don't split at the seam
      const rot = Array.from({ length: N }, (_, k) => flat[(st + k) % N]);
      let best = { len: 0, start: 0 }, j = 0;
      while (j < N) { if (rot[j]) { let e = j; while (e + 1 < N && rot[e + 1]) e++; if (e - j + 1 > best.len) best = { len: e - j + 1, start: (st + j) % N }; j = e + 1; } else j++; }
      return (best.start / N) * L;
    }

    function setupFeatures() {
      const { scene, track } = ctx;
      scene.orbit = false;
      const cl = track.centerline, L = track.length;
      const s0 = longestStraight(cl, L) + 3; // a few units in for runway
      const at = (d) => ((s0 + d) % L + L) % L;

      // Override the authored layout: cluster one of each down the straight.
      const featureTrack = Object.assign({}, track, {
        pads: [{ s: at(3), lat: 0.0, radius: 0.65 }],
        boxes: [{ s: at(6), lat: 0.7, radius: 0.65 }],
        hazards: [{ s: at(11), lat: 0.35, radius: 0.7 }], // oil slick (+cones)
      });
      scene.setTrack(featureTrack);

      const engine = new Game([0], featureTrack, { onEvent() {} });
      window.__engine = engine;
      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      scene.addCar(0, 0, 'Boost!', { cell: false }); // cell:false → the overview camera frames the cluster

      const car = engine.cars.get(0);
      Object.assign(car, { totalS: s0, lat: 0, v: 9, boostMul: 1.6, boostT: 9 }); // active boost (won't tick — frozen)
      engine.bananas.push({ id: 1, s: at(8), lat: -0.5, owner: 'none' });
      engine._recomputePoses();

      const snap = engine.getSnapshot();
      const c0 = snap.cars[0];
      scene.setCarPose(0, c0.pose.pos, c0.pose.forward, c0.pose.up, 0, 1, false, 0, 0, c0.boostMul); // boostMul → aura
      scene.syncProps(snap); // box mesh + dropped-banana mesh

      // Frame it: behind + above the boosting car, looking down the straight at the cluster.
      const fcar = cl.sampleAt(s0), tan = fcar.tangent.clone().normalize();
      const pos = fcar.pos.clone().addScaledVector(tan, -4.5).addScaledVector(fcar.lateral, 1.2);
      pos.y += 3.2;
      scene.overview.position.copy(pos);
      scene._ovPos = pos.clone();
      scene._ovTarget = cl.sampleAt(at(6)).pos.clone();
      scene.overview.lookAt(scene._ovTarget);

      // Car stays put, but re-pose it each frame so the boost aura keeps pulsating
      // (boxes/cones idle-animate via the render loop regardless).
      scene.onFrame = () => scene.setCarPose(0, c0.pose.pos, c0.pose.forward, c0.pose.up, 0, 1, false, 0, 0, c0.boostMul);

      // Standalone (own tab): let the viewer fly around the feature cluster. In the
      // gallery iframe this is a no-op, so the frozen 3/4 framing above is kept.
      enableFreeCamIfStandalone(scene);
    }
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
    // Give each preview car the model + stats for its slot so the gallery shows
    // the real spread of handling and the new car-car bumping, not a uniform field.
    const statsFor = window.carStats || (() => undefined);
    const field = ids.map((i) => ({ id: i, stats: statsFor(i) }));

    let engine = new Game(field, track, { onEvent() {} });
    window.__engine = engine;

    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i], { carIndex: i }));

    const placeGrid = () => {
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
      }
    };
    placeGrid();

    const live = kind === 'racing';

    // Self-driving preview: every car is an AI racer using the SAME pure-pursuit
    // autopilot as the live CPU fill (AiDriver), so the gallery shows the real bot
    // behaviour — fanned lanes, a spread of speeds — not a bespoke demo loop.
    const bots = new Map(ids.map((i) => [i, new AiController({ ...AI_PERSONALITIES[i % AI_PERSONALITIES.length], seed: i + 1 })]));
    function autosteer() {
      for (const c of engine.cars.values()) {
        if (c.finished || !c.pose) continue;
        engine.processInput(c.id, bots.get(c.id).drive(c, track.centerline, engine));
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
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, c.spd, c.onWall, c.steerInput, c.spin, c.boostMul);
      }
      scene.syncProps(snap); // consume/respawn item boxes + render dropped bananas
      if (live) {
        const now = performance.now();
        if (now - lastHud > 160) {
          lastHud = now;
          for (const c of snap.cars) scene.setCarHud(c.id, c);
        }
        // Endless preview: once everyone crosses the line, reset and lap again.
        if (engine.raceOver) {
          engine = new Game(field, track, { onEvent() {} });
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
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, 0, false, c.steerInput);
        scene.setCarHud(c.id, c);
      }
      scene.onFrame = null; // frozen: no per-frame re-pose
      el('pause-btn').classList.remove('hidden');
      el('pause-overlay').classList.remove('hidden');
    } else if (kind === 'reconnect') {
      // Spin the field forward so it reads mid-race, then freeze it and float a
      // reconnect QR over it for a "dropped" player. The dropped racer's car keeps
      // its split-screen cell — exactly as it does live while someone reconnects
      // (the car isn't forfeited until the grace window elapses).
      for (let t = 0; t < 90; t++) { autosteer(); engine.update(33); }
      giveItems(engine); // populate the cell item slots so the preview isn't all empty
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, 0, false, c.steerInput);
        scene.setCarHud(c.id, c);
      }
      scene.onFrame = null; // frozen: no per-frame re-pose
      // Fake a dropped racer: the last filled slot is reconnecting. Its car keeps
      // its cell; the reconnect QR is centred in that cell (the renderer positions
      // it). The QR encodes the join URL with the seat's ?claim= token (no relay
      // needed — /api/qr serves it).
      const dropped = buildSlots(players).slice(-1)[0];
      scene.setCarReconnect(dropped, buildReconnectCard({
        name: FAKE_NAMES[dropped], colorIndex: dropped,
        url: (location.origin || 'https://tinytrack.party') + '/TEST?claim=' + dropped
      }));
    } else if (kind === 'finished') {
      // One racer has crossed the line while the rest of the field races on: spin
      // the field forward so it's spread out, mark the current leader FINISHED,
      // then freeze. Their split-screen cell shows the centred FINISHED card
      // (place + time); every other cell keeps its live lap/place HUD.
      for (let t = 0; t < 160; t++) { autosteer(); engine.update(33); }
      const leadId = engine.getSnapshot().cars.reduce((a, b) => (a.position <= b.position ? a : b)).id;
      const lead = engine.cars.get(leadId);
      if (lead) {
        lead.finished = true;
        lead.finishTime = FAKE_TIMES[0];
        if (!engine.finishedOrder.includes(leadId)) engine.finishedOrder.push(leadId);
        engine._rank(); // promote the finisher to P1; the rest keep racing for position
      }
      giveItems(engine); // the still-racing cells carry items (setCarHud clears the finisher's own slot)
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, 0, false, c.steerInput);
        scene.setCarHud(c.id, c);
      }
      scene.onFrame = null; // frozen
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
      // Late joiner riding along under the field — mirrors showResults'
      // "Next race" row (no rank, no time; they race the next one).
      const j = slots.length % FAKE_NAMES.length;
      const joinLi = document.createElement('li');
      joinLi.className = 'is-joining';
      joinLi.innerHTML =
        `<span class="stand__dot" style="background:${COLORS[j % COLORS.length] || '#888'}"></span> ${FAKE_NAMES[j]}` +
        `<span class="res-time">Next race</span>`;
      listEl.appendChild(joinLi);
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
        cd.classList.toggle('is-go', seq[i] === 'GO!'); // GO! fades out like the real race
        i++;
        if (i < seq.length) timers.push(setTimeout(tick, 800));
        else timers.push(setTimeout(() => { cd.classList.remove('is-go'); cd.textContent = '3'; }, 1200)); // rest at "3"
      })();
    }
    cd.textContent = '3'; // frozen initial frame; ▶ replays the sequence
    window.__TEST__.replay = run;
  }
}
