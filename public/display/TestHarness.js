// Display Test Harness — drives a single display screen in isolation for the
// gallery (/gallery.html), with NO relay connection. main.js delegates here
// when the URL carries ?scenario=…, handing over the live scene +
// track so we can stand up the lobby, countdown, a self-driving race preview,
// or the results overlay from fake data.
//
// The race scenarios run the real NATIVE sim (NativeRaceSession → the C++ engine in
// WASM) in bare mode — racing from frame 0, no countdown, no session lifecycle — with
// every car driven by an in-wasm AI bot, so the split-screen chase cams, HUD, lean,
// and dust all show real motion in the preview.
import { init as initNativeSim, NativeRaceSession } from './NativeRaceSession.js';
import { AI_PERSONALITIES } from './aiPersonas.js';
import { fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { renderSeats, renderCupSlot } from './lobbySeats.js';
import { CUPS, TRACKS, TRACK_LIST } from '../shared/tracks.js';
import { TRACK_SCHEMATICS } from '../shared/trackSchematics.js';

// Cup points per finishing rank, for the intermission/podium previews. Mirrors the
// series layer's ladder (native/libttp-sim/ttp/grand_prix.cc POINTS_BY_RANK).
const POINTS_BY_RANK = [9, 6, 3, 1];

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const FAKE_TIMES = [28.4, 30.7, 33.1, 35.8, 38.2, 41.0, 44.3, 47.6];
// Banked cup points per row for the intermission/podium previews: leader swap
// drama (row 2 leads the cup despite row 1 winning this race).
const FAKE_POINTS = [10, 15, 6, 3, 2, 1, 0, 0];
// Held items per slot for the frozen previews (reconnect / finished) so the cell
// item indicator shows populated — a mix of boost/banana with some empty slots,
// rather than a field of empty squares. null = that slot is carrying nothing.
const PREVIEW_ITEMS = ['boost', 'banana', null, 'boost', 'banana', null, 'boost', null];
// Frozen previews only. The native sim has no giveItem staging hook, and a frozen sim
// would never spend the item anyway — so we dress the snapshot cars on their way to
// setCarHud (a fresh, caller-owned object per getSnapshot) instead of the sim.
const dressItems = (cars) => { for (const c of cars) c.item = PREVIEW_ITEMS[c.id] || null; };

// Every preview car is driven by the sim's own AI — there are no phones here. One
// persona per grid slot (AI_PERSONALITIES is the table main.js hands the wasm for real
// races), each on its own seed so the bots weave distinctly.
const botSpecs = (ids) => ids.map((id, n) => {
  const p = AI_PERSONALITIES[n % AI_PERSONALITIES.length];
  return { peerIndex: id, caution: p.caution, laneBias: p.laneBias, seed: id + 1 };
});

// Bare mode has no session layer to fire a raceEnd, so the endless previews read the
// engine's own `raceOver` rule (finishedOrder >= cars) straight off the snapshot.
const raceOver = (snap) => snap.cars.length > 0 && snap.cars.every((c) => c.finished);

// A native session in BARE mode: racing from frame 0, no countdown and no lobby
// lifecycle, which is what every preview wants. Throws with a readable message when
// the wasm can't build the track — dev-only tracks (?track=gym) aren't in the native
// track registry, so a preview pointed at one has no sim to run.
function bareSession(field, track, opts) {
  let s;
  try {
    s = new NativeRaceSession(field, track, opts);
  } catch (e) {
    throw new Error(`native sim can't race track '${track.trackId}'`, { cause: e });
  }
  s.startBare();
  return s;
}

const el = (id) => document.getElementById(id);

// ---- track-preview minimap ----
// A small schematic overlay (bottom-left) with LIVE car dots, so the orbiting
// whole-layout shot always carries a readable map of the line. The path is the exact
// SVG the phones' track picker renders, and its baked `proj` maps world x/z onto it.
function buildMinimap(parent, trackId, colors) {
  const schem = TRACK_SCHEMATICS[trackId];
  if (!schem || !schem.d || !schem.proj) return null;
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
          dot.setAttribute('r', '8.7');       // schematic viewBox is 0 0 256 256 (see trackSchematic VIEW)
          dot.setAttribute('fill', colors[c.id % colors.length]);
          dot.setAttribute('stroke', '#171a21');
          dot.setAttribute('stroke-width', '3');
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
// window.top, so treat that as framed. Returns true when it took over the camera.
function enableFreeCamIfStandalone(scene) {
  let inIframe = true;
  try { inIframe = window.self !== window.top; } catch (_) { inIframe = true; }
  if (inIframe) return false;
  scene.setFog(false); // flying around the scene: no haze clipping the far track
  // #race is a transparent z-2 overlay over the canvas; let pointer events fall
  // through to it so the drag handler can listen (see .cam-free in display.css).
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

  // What a sim-backed preview waits on: the GLBs + track (main.js's scenePromise) AND
  // the native sim module. main.js already awaited init() at boot, so this resolves on
  // the same tick as the scene in practice; awaiting it anyway keeps the harness honest
  // if it's ever loaded on its own, and surfaces an init failure instead of a blank scene.
  const ready = () => Promise.all([ctx.scenePromise, initNativeSim()]);

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
      // preview shows the circuit the card names. Same prebaked schematics the
      // live lobby uses — nothing in the browser integrates a track any more.
      const mode = opts.picked === '1' ? 'cup' : String(opts.picked);
      const qTrack = new URLSearchParams(location.search).get('track');
      const mapOf = (id) => ({ svg: TRACK_SCHEMATICS[id] });
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
        // the default card, not the endless run — the gallery previews what a
        // 🎲 tap actually lands on (only race 1 is drawn yet, hence one mini)
        state = { name: 'Random', races: '4 races', difficulty: null, maps: [mapOf(id)], cupId: cup && cup.id };
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
    ready().then(() => setupTrackPreview()).catch((e) => console.warn('[TestHarness] track preview failed to start', e));

    function setupTrackPreview() {
      const { scene, track } = ctx;
      scene.setFog(false);   // track preview (grid thumbnail OR free-cam inspector): show the WHOLE circuit, no haze
      // Standalone ("open ↗" / own tab) → free-cam inspector; gallery iframe →
      // keep the calm auto-orbit turntable (you can't comfortably drag a thumbnail).
      if (!enableFreeCamIfStandalone(scene)) scene.orbit = true;

      const ids = [];
      for (let i = 0; i < players; i++) ids.push(i);
      const newSession = () => bareSession(ids.map((i) => ({ peerIndex: i })), track, { bots: botSpecs(ids) });
      let engine = newSession();
      window.__engine = engine;

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false → opponents in the shared world with no split-screen viewport,
      // so _order stays empty and the overview camera frames the whole track.
      ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i], { cell: false }));

      const minimap = buildMinimap(el('race'), track.id, COLORS);
      scene.bindSession(engine.h); // the renderer draws this session's cars

      scene.onFrame = (dt) => {
        // The bots live inside the wasm — ttp_update drives them (dodging hazards/poles,
        // skipping finished cars) in the live loop's own order, so there's nothing to
        // step out here, and the renderer reads their poses from the same engine.
        engine.update(dt * 1000);
        // The minimap is the one thing here that still needs car positions in JS.
        const snap = engine.getSnapshot();
        if (minimap) minimap.update(snap.cars);
        // Endless preview: once everyone finishes, reset and lap again. dispose() frees
        // the wasm session — a JS Game was just garbage, a native handle is not.
        if (raceOver(snap)) {
          engine.dispose();
          engine = newSession();
          window.__engine = engine;
          scene.bindSession(engine.h);
        }
      };
      holdFrame(true); // gallery: hold the turntable on a still frame; the card's ▶ orbits it
    }
    return;
  }

  // ---- race scenarios (countdown / racing / results) ----
  // Switch to the race screen synchronously so the lobby (QR/roster/join URL)
  // doesn't flash while the GLBs load. Build the engine + scene cars once the
  // GLBs are ready, place them at the grid, then install our own frame hook.
  show('race');
  el('results').classList.add('hidden');
  ready().then(() => setupRace(scenario)).catch((e) => console.warn('[TestHarness] race preview failed to start', e));

  function setupRace(kind) {
    const { scene, track } = ctx;
    // (race screen already shown synchronously above, before the GLB load)

    const ids = [];
    for (let i = 0; i < players; i++) ids.push(i);
    // Give each preview car the model + stats for its slot so the gallery shows
    // the real spread of handling and the new car-car bumping, not a uniform field.
    const statsFor = window.carStats || (() => undefined);
    const field = ids.map((i) => ({ peerIndex: i, stats: statsFor(i) }));

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
    const onRaceEvent = kind === 'rocket'
      ? (ev) => {
          if (ev.type === 'spin' && ev.cause === 'rocket') { scene.rocketImpact(ev.id); if (sfx) sfx.rocketHit(); }
          else if (ev.type === 'rocket_expire') { scene.rocketExpire(ev.s, ev.lat); if (sfx) sfx.rocketHit(); } // whiff self-destruct
        }
      : kind === 'monster'
      ? (ev) => {
          if (!sfx) return;
          // the morph itself is snapshot-driven in onFrame (setCarMonster); here we voice the
          // transform: inflate on use, deflate on lapse, and the comedy slip on a body-check.
          if (ev.type === 'item_use' && ev.item === 'monster') sfx.monsterInflate();
          else if (ev.type === 'monster_end') sfx.monsterDeflate();
          else if (ev.type === 'spin') sfx.spin();
        }
      : () => {};
    let galleryRocketIds = new Set();
    function driveGalleryRocketAudio(snap) {
      if (!sfx) return;
      const seen = new Set();
      for (const r of (snap.rockets || [])) { seen.add(r.id); sfx.rocketFlight(r.id, 1); } // demo: full level (no human-distance to scale by)
      for (const id of galleryRocketIds) if (!seen.has(id)) sfx.rocketFlight(id, 0);
      galleryRocketIds = seen;
    }

    // Self-driving preview: every car is one of the sim's own AI racers (same personas
    // main.js hands the wasm for the live CPU fill), so the gallery shows real bot
    // behaviour — fanned lanes, a spread of speeds — not a bespoke demo loop.
    //
    // 'rocket'/'monster' demos: the native ABI carries no giveItem hook, so the demo
    // item is guaranteed by FORCING THE ROULETTE instead — every box on the track rolls
    // this one item (the same knob as the debug ?item=). Cars still have to collect it,
    // so the first showcase shot lands a box-run into the race rather than at 0.8s.
    const forceItem = (kind === 'rocket' || kind === 'monster') ? kind : null;
    const newSession = () => bareSession(field, track, { bots: botSpecs(ids), onRaceEvent, forceItem });
    let engine = newSession();
    window.__engine = engine;

    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    ids.forEach((i) => scene.addCar(i, i, FAKE_NAMES[i], { carIndex: i }));
    scene.bindSession(engine.h); // the renderer draws this session's cars

    const live = kind === 'racing' || kind === 'rocket' || kind === 'monster';

    // The forced item (above) is then SPENT from out here rather than on the bot's own
    // 1.5–4s hold, so the preview loops its showcase (rocket flight + impact burst; the
    // monster's grow-in and the field it ploughs through) instead of showing one event a
    // lap. The car furthest BACK fires — the most dramatic user, and the one the catch-up
    // items are for — on a cooldown so it doesn't become a barrage. processInput's use
    // flag is sticky (a changed `u` arms the car there and then), which is what lets the
    // host spend a wasm-side bot's item at all.
    let useSeq = 0, fireCd = 0.8; // first showcase shot as soon as someone is armed
    function spendHeldItem(snap, dt) {
      fireCd -= dt;
      if (fireCd > 0) return;
      if (kind === 'monster' && snap.cars.some((c) => c.monster)) return; // one transform at a time
      const armed = snap.cars.filter((c) => c.item && !c.finished);
      if (!armed.length) return;
      armed.sort((a, b) => a.totalS - b.totalS);
      engine.processInput(armed[0].id, { u: ++useSeq });
      fireCd = kind === 'monster' ? 1.6 : 1.3; // gap before the next one (monsters last, so give them room)
    }

    let lastHud = 0;
    scene.onFrame = (dt) => {
      if (!live) return; // frozen preview: the renderer holds the field (see below)
      // The bots, item pickups and the roulette all run inside the wasm sim, and
      // the renderer reads the result from the same engine — so a frame is one
      // update plus the shell's own business below.
      engine.update(dt * 1000);
      const snap = engine.getSnapshot();
      if (forceItem) spendHeldItem(snap, dt); // arms the next frame's use (post-snapshot)
      if (kind === 'rocket') driveGalleryRocketAudio(snap); // sustained jet per in-flight rocket
      // Monster demo (standalone tab only): voice the transformed car's deep big-truck
      // engine growl, silent otherwise — so the gallery hears the sound change too.
      if (kind === 'monster' && sfx) for (const c of snap.cars) sfx.engineDrive(c.id, c.monster ? c.spd / 1.2 : 0, true);
      const now = performance.now();
      if (now - lastHud > 160) {
        lastHud = now;
        for (const c of snap.cars) { scene.setCarHud(c.id, c); scene.setCarSteer(c.id, c.steerInput); }
      }
      // Endless preview: once everyone crosses the line, reset and lap again.
      // dispose() frees the wasm session — a JS Game was just garbage, a handle isn't.
      if (raceOver(snap)) {
        engine.dispose();
        engine = newSession();
        window.__engine = engine;
        scene.bindSession(engine.h);
      }
    };

    if (kind === 'countdown') {
      // HUD shows lap 1 while the lights count down.
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      runCountdown();
    } else if (kind === 'paused') {
      // Spin the field forward a few seconds so it reads mid-race, freeze it
      // (speed 0 → no wheel dust), then show the pause button + overlay over it.
      for (let t = 0; t < 90; t++) engine.update(33);
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      scene.hold(true); // the renderer holds the field at rest — no wheel spin, no dust
      el('pause-btn').classList.remove('hidden');
      el('pause-overlay').classList.remove('hidden');
    } else if (kind === 'reconnect') {
      // Spin the field forward so it reads mid-race, then freeze it and float a
      // reconnect QR over it for a "dropped" player. The dropped racer's car keeps
      // its split-screen cell — exactly as it does live while someone reconnects
      // (the car isn't forfeited until the grace window elapses).
      for (let t = 0; t < 90; t++) engine.update(33);
      const rcCars = engine.getSnapshot().cars;
      dressItems(rcCars); // populate the cell item slots so the preview isn't all empty
      for (const c of rcCars) scene.setCarHud(c.id, c);
      scene.hold(true);
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
      for (let t = 0; t < 160; t++) engine.update(33);
      const leadId = engine.getSnapshot().cars.reduce((a, b) => (a.position <= b.position ? a : b)).id;
      engine.forceFinish(leadId, FAKE_TIMES[0]); // promote the finisher to P1; the rest keep racing for position
      const fnCars = engine.getSnapshot().cars;
      dressItems(fnCars); // the still-racing cells carry items (setCarHud clears the finisher's own slot)
      for (const c of fnCars) scene.setCarHud(c.id, c);
      scene.hold(true);
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
