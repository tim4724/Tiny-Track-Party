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
import { renderSeats, renderCupSlot } from './lobbySeats.js';
import { trackSchematic } from './trackSchematic.js';
import { POINTS_BY_RANK } from './GrandPrix.js';
import { CUPS, TRACKS } from '../shared/tracks.js';
import { TRACK_LIST, buildTrack } from './TrackBuilder.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const FAKE_TIMES = [28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6];
// Banked cup points per row for the intermission/podium previews: leader swap
// drama (row 2 leads the cup despite row 1 winning this race).
const FAKE_POINTS = [10, 15, 6, 3, 2, 1, 0, 0];
// Held items per slot for the frozen previews (reconnect / finished) so the cell
// item indicator shows populated — a mix of boost/banana with some empty slots,
// rather than a field of empty squares. null = that slot is carrying nothing.
const PREVIEW_ITEMS = ['boost', 'banana', null, 'boost', 'banana', null, 'boost', null];
const giveItems = (engine) => { for (const c of engine.cars.values()) c.item = PREVIEW_ITEMS[c.id] || null; };

const el = (id) => document.getElementById(id);

// ---- track-preview minimap ----
// A small schematic overlay (bottom-left) with LIVE car dots, so the orbiting
// whole-layout shot always carries a readable map of the line. The path is the exact
// SVG the phones' track picker renders; trackSchematic's `proj` maps world x/z onto it.
function buildMinimap(parent, track, colors) {
  const schem = trackSchematic(track);
  if (!schem.d || !schem.proj) return null;
  const old = parent.querySelector('#track-minimap');
  if (old) old.remove();
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.id = 'track-minimap';
  wrap.style.cssText = 'position:absolute;left:16px;bottom:16px;width:170px;height:170px;'
    + 'background:rgba(22,26,36,.55);border-radius:14px;padding:6px;pointer-events:none;z-index:30;';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', schem.viewBox);
  svg.style.cssText = 'width:100%;height:100%;display:block;';
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', schem.d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'rgba(255,255,255,.92)');
  path.setAttribute('stroke-width', '4');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  const start = document.createElementNS(NS, 'circle');
  start.setAttribute('cx', schem.start.x);
  start.setAttribute('cy', schem.start.y);
  start.setAttribute('r', '2.6');
  start.setAttribute('fill', '#fff');
  start.setAttribute('stroke', '#20242c');
  start.setAttribute('stroke-width', '1');
  svg.appendChild(start);
  wrap.appendChild(svg);
  parent.appendChild(wrap);
  const proj = schem.proj, dots = new Map();
  return {
    update(cars) {
      for (const c of cars) {
        if (!c.pose) continue;
        let dot = dots.get(c.id);
        if (!dot) {
          dot = document.createElementNS(NS, 'circle');
          dot.setAttribute('r', '3.4');
          dot.setAttribute('fill', colors[c.id % colors.length]);
          dot.setAttribute('stroke', '#171a21');
          dot.setAttribute('stroke-width', '1.2');
          svg.appendChild(dot);
          dots.set(c.id, dot);
        }
        dot.setAttribute('cx', (proj.offX + (c.pose.pos.x - proj.minX) * proj.scale).toFixed(1));
        dot.setAttribute('cy', (proj.offZ + (c.pose.pos.z - proj.minZ) * proj.scale).toFixed(1));
      }
    }
  };
}

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
  const scenario = opts.scenario || 'racing';
  // != null (not ||) so an explicit players=0 clamps to 1 rather than 4.
  const players = Math.max(1, Math.min(opts.players != null ? opts.players : 4, COLORS.length));
  const host = (opts.host == null || isNaN(opts.host)) ? null : Math.max(0, Math.min(opts.host, 7));

  const screens = { welcome: el('welcome'), lobby: el('lobby'), race: el('race') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  window.__TEST__ = window.__TEST__ || {};

  // ---- gallery power saver ----
  // The gallery mounts ~11 live WebGL scenes at once; left alone each runs a full
  // render loop forever — even the frozen previews, which redraw an unchanging frame
  // 60×/sec. Hold every preview on a single painted frame (pauseAfterFrame) and then
  // leave it idle. Animated previews additionally expose window.__preview so the
  // gallery CARD can drive play/pause from the parent document — the preview iframe is
  // pointer-events:none (page-scroll pass-through, gallery.css), so it can't take the
  // click itself. A standalone tab (own window) ignores all this and runs freely: you
  // opened it to watch or to fly the free-cam. Call holdFrame AFTER the scene's first
  // state is set, so the held frame shows that state.
  // In a gallery iframe, or our own tab? (Reused by setupRace's audio gate below.)
  // A cross-origin top throws → treat as framed.
  let inIframe = true;
  try { inIframe = window.self !== window.top; } catch (_) { inIframe = true; }
  function holdFrame(live) {
    if (!inIframe) return;                // own tab → keep running (watch / inspect)
    ctx.scene.pauseAfterFrame();          // paint the state just set, then idle
    if (live) window.__preview = {        // parent gallery card drives play/pause
      play: () => ctx.scene.start(),
      pause: () => ctx.scene.pauseAfterFrame(),
      running: () => ctx.scene.isRunning()
    };
  }
  // DOM-only previews (welcome / lobbies / device-choice) drive no 3D — the WebGL
  // backdrop sits dimmed behind them — so let it paint once, then idle for good.
  const DOM_ONLY = ['welcome', 'lobby', 'lobby-empty', 'device-choice'];
  if (DOM_ONLY.includes(scenario) && ctx.scenePromise) {
    ctx.scenePromise.then(() => holdFrame(false)).catch(() => {});
  }

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
  }

  function fakeJoin(code) {
    renderJoinUrl(el('joinurl'), (location.host || 'tinytrack.party') + '/' + code, code);
    fetchQR((location.origin || 'https://tinytrack.party') + '/' + code)
      .then((m) => renderQR(el('qr'), m))
      .catch(() => { /* gallery still works without the QR */ });
  }

  if (scenario === 'welcome') {
    // The title board at boot: just the section over the diorama (the room
    // warms invisibly behind it in live play — nothing to fake here).
    show('welcome');
    return;
  }

  if (scenario === 'lobby-empty') {
    // The lobby the instant NEW GAME reveals it, before anyone joins: open
    // seats, empty cup slot, the room's join URL + QR.
    show('lobby');
    renderRoster([], null);
    el('joinurl').textContent = (location.host || 'tinytrack.party');
    renderCupSlot(el('cup-slot'), null);   // no pick yet → empty slot
    fetchQR((location.origin || 'https://tinytrack.party')).then((m) => renderQR(el('qr'), m)).catch(() => {});
    return;
  }

  if (scenario === 'device-choice') {
    // The wrong-device fork (display URL opened on a phone). Live it's
    // media-query driven and main.js pre-dismisses it for every gallery iframe,
    // so force it on with an inline display — viewport-independent here.
    // Behind it: the welcome board, exactly what boot shows while room
    // creation is deferred on the chooser.
    show('welcome');
    el('device-choice').style.display = 'flex';
    return;
  }

  if (scenario === 'lobby') {
    const slots = buildSlots(players);
    const hostIdx = hostSlot(slots);
    show('lobby');
    renderRoster(slots, hostIdx);
    fakeJoin('TEST');
    if (opts.picked) {
      // Post-pick lobby: race card in the slot, hint gone, chrome floating
      // over the live 3D preview (mirrors renderLobbyPick + the .is-dim
      // reveal). `picked` picks the MODE: 'cup' (legacy '1'), 'track' or
      // 'random'. Pair the card with a matching ?track=<id> so the orbiting
      // preview shows the circuit the card names. The live lobby reads its
      // schematics from main.js's prebuilt catalog; the harness builds them
      // itself (pure geometry).
      const mode = opts.picked === '1' ? 'cup' : String(opts.picked);
      const qTrack = new URLSearchParams(location.search).get('track');
      const mapOf = (id) => ({ svg: trackSchematic(buildTrack({ id, ...TRACKS[id] })) });
      const entryOf = (id) => TRACK_LIST.find((t) => t.id === id);
      const cupOf = (id) => CUPS.find((c) => c.tracks.includes(id));
      let state;
      if (mode === 'track') {
        const id = (qTrack && TRACKS[qTrack]) ? qTrack : CUPS[0].tracks[2];
        const entry = entryOf(id), cup = cupOf(id);
        state = {
          name: entry ? entry.name : id, races: '1 race',
          difficulty: entry ? entry.cupDifficulty : null,
          maps: [mapOf(id)], cupId: cup && cup.id
        };
      } else if (mode === 'random') {
        const id = (qTrack && TRACKS[qTrack]) ? qTrack : CUPS[1].tracks[0];
        const cup = cupOf(id);
        state = { name: 'Random', races: 'endless', difficulty: null, maps: [mapOf(id)], cupId: cup && cup.id };
      } else {
        const cup = (qTrack && cupOf(qTrack)) || CUPS[0];
        const first = TRACK_LIST.find((t) => t.cup === cup.id);
        state = {
          name: cup.name,
          races: `${cup.tracks.length} races`,
          difficulty: first ? first.cupDifficulty : null,
          maps: cup.tracks.map((id, i) => ({ ...mapOf(id), n: i + 1 })),
          cupId: cup.id
        };
      }
      renderCupSlot(el('cup-slot'), state);
      el('scene').classList.remove('hidden', 'is-dim');
    } else {
      renderCupSlot(el('cup-slot'), null);   // no pick yet → empty slot
    }
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

      const minimap = buildMinimap(el('race'), track, COLORS);

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
        const snap = engine.getSnapshot();
        for (const c of snap.cars) {
          if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, spd: c.spd, scrub: c.onWall, steerInput: c.steerInput, brake: c.brake });
        }
        scene.syncProps(snap); // reconcile item boxes/bananas + draw the ?bbox car collision outlines
        if (minimap) minimap.update(snap.cars);
        // Endless preview: once everyone finishes, reset and lap again.
        if (engine.raceOver) {
          engine = new Game(ids, track, { onEvent() {} });
          window.__engine = engine;
          placeGrid();
        }
      };
      holdFrame(true); // gallery: hold the turntable on a still frame; the card's ▶ orbits it
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
      scene.bboxOrbit = false; // clear the lobby attract-orbit flag main.js set at boot — else the
                               // overview loop sweeps the WHOLE track and ignores our cluster framing
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
      engine.rockets.push({ id: 1, s: at(4.2), lat: 0.7, owner: 'none' }); // a homing rocket mid-flight in the lineup
      engine._recomputePoses();

      const snap = engine.getSnapshot();
      const c0 = snap.cars[0];
      scene.setCarPose(0, c0.pose.pos, c0.pose.forward, c0.pose.up, { spd: 1, boostMul: c0.boostMul }); // boostMul → aura
      scene.syncProps(snap); // box + dropped-banana + in-flight rocket meshes

      // Frame the cluster from an elevated 3/4 angle, off to one side looking ACROSS it, so
      // every piece reads at once and the straight's vanishing line falls off to the side
      // (rather than shrinking the whole lineup down a long-straight perspective).
      const ctr = cl.sampleAt(at(4));
      const cf = ctr.tangent.clone().normalize(), clat = ctr.lateral.clone().normalize(), cup = ctr.up.clone().normalize();
      const pos = ctr.pos.clone().addScaledVector(cf, -4.6).addScaledVector(clat, 6.0).addScaledVector(cup, 5.0);
      scene._ovTarget = ctr.pos.clone().addScaledVector(cf, -0.5).addScaledVector(cup, 0.2);
      scene._ovPos = pos.clone();
      scene.overview.position.copy(pos);
      scene.overview.lookAt(scene._ovTarget);

      // Car stays put, but re-pose it + re-sync props each frame so the boost aura keeps
      // pulsating and the rocket keeps spinning with its flickering flame (boxes/cones
      // idle-animate via the render loop regardless).
      scene.onFrame = () => {
        scene.setCarPose(0, c0.pose.pos, c0.pose.forward, c0.pose.up, { spd: 1, boostMul: c0.boostMul });
        scene.syncProps(snap);
      };

      // Standalone (own tab): let the viewer fly around the feature cluster. In the
      // gallery iframe this is a no-op, so the frozen 3/4 framing above is kept.
      enableFreeCamIfStandalone(scene);
      holdFrame(false); // gallery: a labelled showcase — one painted frame says it all
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

    // The 'rocket' scenario routes the engine's hit event to the impact burst (live
    // main.js does this in onRaceEvent; the gallery has no relay, so we wire it here).
    // Sound only plays STANDALONE (own tab, not a gallery-grid iframe) — a wall of
    // thumbnails all firing rockets would be cacophony. Audio stays locked until the
    // viewer's first click (main.js wires the gesture-resume); window.__audio is the
    // shared RaceAudio the host built. Same not-in-iframe gate as the free camera
    // (inIframe is computed once at the top of runDisplayScenario).
    const sfx = (!inIframe && window.__audio) ? window.__audio : null;
    // The rocket FLIGHT (jet) is a sustained voice driven per-frame below (driveGalleryRocketAudio),
    // held for the whole air time — not a one-shot. Only the impact is event-driven here.
    const events = kind === 'rocket'
      ? { onEvent: (ev) => {
          if (ev.type === 'spin' && ev.cause === 'rocket') { scene.rocketImpact(ev.id); if (sfx) sfx.rocketHit(); }
          else if (ev.type === 'rocket_expire') { scene.rocketExpire(ev.s, ev.lat); if (sfx) sfx.rocketHit(); } // whiff self-destruct
        } }
      : kind === 'monster'
      ? { onEvent: (ev) => {
          if (!sfx) return;
          // the morph itself is snapshot-driven in onFrame (setCarMonster); here we voice the
          // transform: inflate on use, deflate on lapse, and the comedy slip on a body-check.
          if (ev.type === 'item_use' && ev.item === 'monster') sfx.monsterInflate();
          else if (ev.type === 'monster_end') sfx.monsterDeflate();
          else if (ev.type === 'spin') sfx.spin();
        } }
      : { onEvent() {} };
    let galleryRocketIds = new Set();
    function driveGalleryRocketAudio() {
      if (!sfx) return;
      const seen = new Set();
      for (const r of engine.rockets) { seen.add(r.id); sfx.rocketFlight(r.id, 1); } // demo: full level (no human-distance to scale by)
      for (const id of galleryRocketIds) if (!seen.has(id)) sfx.rocketFlight(id, 0);
      galleryRocketIds = seen;
    }

    let engine = new Game(field, track, events);
    window.__engine = engine;

    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i], { carIndex: i }));

    const placeGrid = () => {
      for (const c of engine.getSnapshot().cars) {
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
      }
    };
    placeGrid();

    const live = kind === 'racing' || kind === 'rocket' || kind === 'monster';

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

    // 'rocket' demo: every ~1.3s hand the LAST-place car a homing rocket and fire it at the
    // car directly ahead, so the split-screen preview continuously shows the rocket flying +
    // its impact burst. One in flight per car at a time, so it doesn't turn into a barrage.
    let rocketCd = 0.8; // first strike shortly after the start
    function fireRocketFromBack(dt) {
      rocketCd -= dt;
      if (rocketCd > 0) return;
      rocketCd = 1.3;
      const liveCars = [...engine.cars.values()].filter((c) => !c.finished);
      if (liveCars.length < 2) return;
      liveCars.sort((a, b) => a.totalS - b.totalS);
      const firer = liveCars[0];
      if (engine.rockets.some((r) => r.owner === firer.id)) return; // one already in flight from this car
      firer.item = 'rocket';
      engine._useItem(firer); // locks the car ahead + spawns the rocket (+events → impact burst)
    }

    // 'monster' demo: transform a car into a monster truck, then a short gap after it lapses
    // before the next one — so the preview loops the burst + grow-in AND the monster ploughing
    // through the field (the cars it touches crash out). To guarantee a body-check to show off
    // (in real play you fire it yourself; here we stage the encounter), pick the car with the
    // SMALLEST gap to the car directly ahead so the heavier, faster monster runs it down fast.
    let monsterCd = 0.8; // first transform shortly after the start
    function transformFromBack(dt) {
      if ([...engine.cars.values()].some((c) => c.monsterT > 0)) return; // one transform at a time
      monsterCd -= dt;
      if (monsterCd > 0) return;
      monsterCd = 1.6; // gap before the next transform once this one lapses
      const liveCars = [...engine.cars.values()].filter((c) => !c.finished);
      if (liveCars.length < 2) return;
      let firer = null, best = Infinity;
      for (const c of liveCars) {
        let gapAhead = Infinity;
        for (const o of liveCars) { if (o === c) continue; const g = o.totalS - c.totalS; if (g > 0 && g < gapAhead) gapAhead = g; }
        if (gapAhead < best) { best = gapAhead; firer = c; }
      }
      if (!firer) firer = liveCars.sort((a, b) => a.totalS - b.totalS)[0];
      firer.item = 'monster';
      firer.tCatch = 1;       // the full-length transform, for a good showcase
      engine._useItem(firer); // flips monsterT on → snapshot.monster → setCarMonster morphs it
    }

    let lastHud = 0;
    scene.onFrame = (dt) => {
      if (live) {
        if (kind === 'rocket') fireRocketFromBack(dt);
        if (kind === 'monster') transformFromBack(dt);
        autosteer();
        engine.update(dt * 1000);
      }
      const snap = engine.getSnapshot();
      for (const c of snap.cars) {
        scene.setCarMonster(c.id, !!c.monster); // morph to/from the monster truck (burst + grow-in)
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, spd: c.spd, scrub: c.onWall, steerInput: c.steerInput, spin: c.spin, boostMul: c.boostMul, brake: c.brake });
      }
      scene.syncProps(snap); // consume/respawn item boxes + render dropped bananas
      if (kind === 'rocket') driveGalleryRocketAudio(); // sustained jet per in-flight rocket
      // Monster demo (standalone tab only): voice the transformed car's deep big-truck
      // engine growl, silent otherwise — so the gallery hears the sound change too.
      if (kind === 'monster' && sfx) for (const c of snap.cars) sfx.engineDrive(c.id, c.monster ? c.spd / 1.2 : 0, true);
      if (live) {
        const now = performance.now();
        if (now - lastHud > 160) {
          lastHud = now;
          for (const c of snap.cars) scene.setCarHud(c.id, c);
        }
        // Endless preview: once everyone crosses the line, reset and lap again.
        if (engine.raceOver) {
          engine = new Game(field, track, events);
          window.__engine = engine;
          rocketCd = 0.8; monsterCd = 0.8;
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
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, steerInput: c.steerInput });
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
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, steerInput: c.steerInput });
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
        if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, steerInput: c.steerInput });
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
          `<span class="res-name" style="--c:${col}">${FAKE_NAMES[s]}</span>` +
          `<span class="res-time">${FAKE_TIMES[i].toFixed(1)}s</span>`;
        listEl.appendChild(li);
      });
      // Late joiner riding along under the field — mirrors showResults'
      // "Next race" row (no rank, no time; they race the next one).
      const j = slots.length % FAKE_NAMES.length;
      const joinLi = document.createElement('li');
      joinLi.className = 'is-joining';
      joinLi.innerHTML =
        `<span class="res-name" style="--c:${COLORS[j % COLORS.length] || '#888'}">${FAKE_NAMES[j]}</span>` +
        `<span class="res-time">Next race</span>`;
      listEl.appendChild(joinLi);
      el('results').classList.remove('hidden');
    } else if (kind === 'intermission' || kind === 'podium') {
      // Cup dressings of the results overlay (mirrors showResults' series
      // branches): frozen grid behind either the mid-cup intermission (points
      // board + "next up" footer) or the final podium. Real cup/track names,
      // fake points — with a leader swap so the board shows cup order beating
      // this race's finish order.
      const cup = CUPS[0];
      const final = kind === 'podium';
      const raceIdx = final ? cup.tracks.length - 1 : 1;
      const rows = buildSlots(players).map((s, i) => ({
        slot: s, name: FAKE_NAMES[s],
        gained: POINTS_BY_RANK[i] || 0,
        points: (FAKE_POINTS[i] || 0) + (POINTS_BY_RANK[i] || 0)
      })).sort((a, b) => b.points - a.points);
      el('results-title').textContent = final ? `${cup.name} CHAMPS!` : 'Standings';
      const sub = el('results-sub');
      sub.classList.toggle('hidden', final);   // podium: the CHAMPS header says it all
      if (!final) sub.textContent = `${cup.name} · Race ${raceIdx + 1} of ${cup.tracks.length}`;
      const cupRow = (r) =>
        `<span class="res-name" style="--c:${COLORS[r.slot % COLORS.length] || '#888'}">${r.name}</span>` +
        `<span class="res-gain${r.gained ? '' : ' is-zero'}">+${r.gained}</span><span class="res-pts">${r.points} pts</span>`;
      const podiumEl = el('results-podium');
      podiumEl.innerHTML = '';
      podiumEl.classList.toggle('hidden', !final);
      if (final) {
        for (const place of [2, 1, 3]) {
          const r = rows[place - 1];
          if (!r) continue;
          const col = document.createElement('div');
          col.className = 'podium__col';
          col.dataset.place = String(place);
          col.style.setProperty('--c', COLORS[r.slot % COLORS.length] || '#888');
          col.innerHTML =
            `<div class="podium__who"><span class="res-name" style="--c:${COLORS[r.slot % COLORS.length] || '#888'}">${r.name}</span></div>` +
            `<div class="podium__pts">${r.points} pts</div><div class="podium__step">${place}</div>`;
          podiumEl.appendChild(col);
        }
      }
      const listEl = el('results-list'); listEl.innerHTML = '';
      for (const r of final ? rows.slice(3) : rows) {
        const li = document.createElement('li');
        li.innerHTML = cupRow(r);
        listEl.appendChild(li);
      }
      const next = el('results-next');
      next.classList.toggle('hidden', final);
      if (!final) next.innerHTML = `Next up: <b>${TRACKS[cup.tracks[raceIdx + 1]].name}</b> — starting in 8…`;
      el('results-newgame').textContent = final ? 'New Game' : 'Next race ▸';
      el('results').classList.toggle('is-podium', final); // list ranks from 4th under the steps
      el('results').classList.remove('hidden');
    }
    // gallery: animated previews (racing/rocket/monster) hold a still grid and run via
    // the card's ▶; frozen previews (countdown/paused/reconnect/finished/results) paint
    // once and stay idle. Standalone tabs ignore this and run freely.
    holdFrame(live);
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
        cd.classList.remove('slap');                    // slap each numeral in, like the live race
        if (seq[i] !== 'GO!') { void cd.offsetWidth; cd.classList.add('slap'); }
        i++;
        if (i < seq.length) timers.push(setTimeout(tick, 800));
        else timers.push(setTimeout(() => { cd.classList.remove('is-go'); cd.textContent = '3'; }, 1200)); // rest at "3"
      })();
    }
    cd.textContent = '3'; // frozen initial frame; ▶ replays the sequence
    window.__TEST__.replay = run;
  }
}
