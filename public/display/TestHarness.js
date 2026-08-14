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
// The HUD cadence, from the file that owns the HUD — this preview paints the
// same chrome through the same setCarHud, and used to carry its own copy of the
// number.
import { HUD_TICK_MS } from './Stage.js';
import { AI_PERSONALITIES } from './aiPersonas.js';
import { renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { buildQRMatrix } from '../shared/qr.js';
import { renderSeats, renderLobbyPick, renderCupShelf } from './lobbySeats.js';
// The live results overlay and countdown banner. Driving the REAL renderers off
// the REAL ui model (a synthesized board in, the same markup out) is what keeps
// these previews from drifting — this file used to carry a second implementation
// of both in template literals, and the lobby's twin had already drifted to a
// screen that no longer existed by the time anyone noticed.
import { renderResults, hideResults, showCountdownBanner } from './raceOverlays.js';
import { resultsView } from './NativeUiModel.js';
import { intermissionMs } from './NativeRaceFlow.js';
import { LobbyDemo } from './LobbyDemo.js';
import { CUPS, TRACKS, TRACK_LIST } from '../shared/tracks.js';
import { TRACK_SCHEMATICS } from '../shared/trackSchematics.js';
// The monster demo's engine timbre. It used to be imported from decide.js, the
// retired audio oracle; the race path never read it that way — a transformed
// car's growl arrives as numbers on a voice command from the C++ decision layer
// (ttp/audio.cc's MONSTER_ENGINE_MOD, which this mirrors). It lives here because
// the gallery is the only caller: it drives engineDrive itself, outside any
// session, so no command stream reaches it.
const MONSTER_ENGINE_MOD = { rateMul: 0.6, gainMul: 1.45, lpMul: 0.82 };

// Cup points per finishing rank, for the intermission/podium previews. Mirrors the
// series layer's ladder (native/libttp-sim/ttp/grand_prix.cc POINTS_BY_RANK).
const POINTS_BY_RANK = [9, 6, 3, 1];

// One countdown beat as the banner takes it — race_flow.cc's countdownTick,
// which is the only thing about a beat that is a decision: numerals slap in, GO
// does not (it fades out on .is-go instead). A preview supplies the BEAT NUMBER
// and nothing else, and this is the one place either card turns one into a
// banner. It is not the walk itself: reaching that needs a live room handle,
// which no scenario has.
const countdownBeat = (n) => ({ n, slap: n > 0, go: n === 0 });
const CD_BEAT_MS = 800;   // the COUNTDOWN CARD's replay cadence only — it has no session
                          // to tick it (a frozen card paints once and idles, so no frames
                          // run). The chained start below uses the real 1 Hz session clock.

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

// Handling stats for a preview car (undefined when the stats table isn't on the
// page — the sim falls back to defaults). Resolved per call: this module loads
// dynamically, but a lazy read costs nothing and can't race the classic scripts.
const statsFor = (i) => (window.carStats ? window.carStats(i) : undefined);

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

// In a gallery iframe, or our own tab? A cross-origin top throws on access, so a
// throw IS the framed answer. Both readers below want that same reading.
function isFramed() {
  try { return window.self !== window.top; } catch (_) { return true; }
}

// Standalone inspector camera. When a preview page is opened on its OWN (not in a
// gallery iframe), hand the overview camera to the viewer — drag to look, scroll to
// fly, WASD to glide, Q/E to drop/rise — so the scene can be inspected up close. In
// the gallery grid each card is an iframe → leave the scenario's own framing alone
// (you can't comfortably drag a thumbnail). Returns true when it took over the camera.
function enableFreeCamIfStandalone(scene) {
  if (isFramed()) return false;
  enableFreeCam(scene);
  return true;
}

// One key for all tracks, deliberately: reload-same-URL is the use case, and a
// pose carried onto a different track is one drag away from useful anyway.
const FREECAM_KEY = 'ttp-freecam';

function restoreFreeCamPose() {
  try { return JSON.parse(sessionStorage.getItem(FREECAM_KEY)) || undefined; }
  catch (_) { return undefined; } // corrupt entry: fall back to the iso framing
}

// The same camera, unconditionally, from `start` (see Stage.enableUserCamera).
// The asset gallery takes this branch: there the preview IS the page — one
// full-bleed frame you are meant to fly, not a thumbnail in a grid — so the
// iframe test above says nothing useful about whether a viewer can drag it.
// Hands back the camera's own state, which is what a caller that wants to move
// it later (the gallery's "back to the cars") holds on to.
function enableFreeCam(scene, start) {
  scene.setFog(false); // flying around the scene: no haze clipping the far track
  // #race is a transparent z-2 overlay over the canvas; let pointer events fall
  // through to it so the drag handler can listen (see .cam-free in display.css).
  document.documentElement.classList.add('cam-free');
  // Reload keeps the pose: the pose you flew to is saved per-tab on pagehide and
  // handed back as the start override, so an F5 reopens the exact same view. An
  // explicit `start` wins — a caller that says where to look means it.
  const cam = scene.enableUserCamera(start || restoreFreeCamPose());
  window.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(FREECAM_KEY,
        JSON.stringify({ eye: cam.eye, yaw: cam.yaw, pitch: cam.pitch }));
    } catch (_) { /* storage denied: the next load just opens on the default framing */ }
  });
  showCamHint(); // surface the (otherwise invisible) drag + WASD/QE controls
  return cam;
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
  // `players` is the HUMAN count — the roster seats and the split-screen cells —
  // capped at the live phone cap. Race previews then top the field up to the
  // live FIELD_SIZE with cell-less CPU racers (raceGrid below), so a gallery
  // race reads like a real one: 8 cars, at most 4 cells.
  const players = Math.max(1, Math.min(opts.players != null ? opts.players : 4, window.MAX_PLAYERS || 4));
  const host = (opts.host == null || isNaN(opts.host)) ? null : Math.max(0, Math.min(opts.host, 7));

  // What a sim-backed preview waits on: the GLBs + track (main.js's scenePromise) AND
  // the native sim module. main.js already awaited init() at boot, so this resolves on
  // the same tick as the scene in practice; awaiting it anyway keeps the harness honest
  // if it's ever loaded on its own, and surfaces an init failure instead of a blank scene.
  const ready = () => Promise.all([ctx.scenePromise, initNativeSim()]);

  const screens = { welcome: el('welcome'), lobby: el('lobby'), race: el('race') };
  const show = (name) => {
    for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
    el('mute-btn').classList.toggle('hidden', name === 'welcome');  // same rule as main.js show()
  };

  // ---- the gallery card's ▶ ----------------------------------------------------
  // A screen whose animation is DOM (an entrance slap-in, the results board's
  // race→standings turn) plays once on arrival and is then over, so a preview of
  // it is a still of whatever it settled into. `replayable` paints the screen and
  // registers the card's ▶ to paint it again.
  //
  // Restarting a CSS animation means the element must go display:none and back —
  // and BOTH halves have to be seen by a style recalc, or the browser folds the
  // pair away and nothing re-runs. Hence the forced reflow between them; a plain
  // hide(); paint(); is a no-op for every element the repaint does not recreate.
  //
  // Scene cards do NOT come through here: their animation is the sim, driven by
  // the preview overlay's play/pause (window.__preview) instead.
  function replayable(hide, paint) {
    window.__TEST__.replay = () => { hide(); void document.body.offsetWidth; paint(); };
    paint();
  }

  // Paint the results overlay from a SYNTHESIZED board — the same shape
  // standingsPayload hands live play — through the real ui model and the real
  // renderer. The preview's whole job is choosing what board to show; every
  // decision after that (dressing, row kinds, podium split, footer) is the
  // model's, exactly as in a real race.
  const showBoard = (board) => renderResults(resultsView(board, { intermissionMs: intermissionMs() }), COLORS);
  // …and the board is the card's animation on a cup: ▶ replays the race phase
  // turning into the standings, which otherwise happens once and never again.
  const playBoard = (board) => replayable(hideResults, () => showBoard(board));

  // A board for the first cup, as it stands after its race `raceIdx`: real cup
  // and track names, fake points, with a leader swap so the table shows cup
  // order beating this race's finish order. `final` is the only thing the two
  // dressings (mid-cup intermission, closing podium) differ by — the model
  // decides the rest. Shared by the frozen previews and the chained-start loop.
  function cupBoard(raceIdx, final) {
    const cup = CUPS[0];
    const nextId = cup.tracks[raceIdx + 1] || null;
    // Built in FINISHING order (times and gains ride the index), then sorted into
    // cup order — the same two orders standingsPayload produces, and `racePlace`
    // is what carries the first one through the sort. Without it the board's
    // race phase would replay the cup table and the preview would show a leader
    // swap that never happened.
    const order = humansFirst(raceGrid(buildSlots(players))).map((g, i) => ({
      playerId: g.slot, name: g.name, colorIndex: g.slot, finished: true, time: FAKE_TIMES[i],
      racePlace: i + 1,
      gained: POINTS_BY_RANK[i] || 0,
      points: (FAKE_POINTS[i] || 0) + (POINTS_BY_RANK[i] || 0)
    })).sort((a, b) => b.points - a.points);
    return {
      over: true, hostPeerIndex: order[0].playerId, order,
      series: {
        cupId: cup.id, cupName: cup.name, endless: false,
        raceIndex: raceIdx, raceCount: cup.tracks.length,
        nextTrackId: nextId, nextTrackName: nextId ? TRACKS[nextId].name : null,
        final, autoAdvanceMs: intermissionMs()
      }
    };
  }

  // The lobby's cup slot, off the same renderLobbyPick the live lobby calls: a
  // PICK goes in, the model decides the whole card. null empties the slot.
  // The synthesized progression dresses the card's stars and the shelf below —
  // mid-game numbers (three cups starred, the Playroom still locked), so
  // gallery-lobby.spec can pin dressings only the right payload produces.
  const PREVIEW_SHELF = CUPS.map((c, i) => ({
    id: c.id, name: c.name,
    stars: [3, 2, 1, 0, 0][i] || 0,
    locked: c.id === 'rooftop',
    ...(c.id === 'rooftop' ? { unlockDone: 3, unlockNeed: 4 } : {})
  }));
  const PREVIEW_PROGRESS = { cups: PREVIEW_SHELF };
  const previewCatalog = TRACK_LIST.map((t) => ({ id: t.id, svg: TRACK_SCHEMATICS[t.id] }));
  const showPick = (pick) => renderLobbyPick(el('cup-slot'), pick || {}, previewCatalog, PREVIEW_PROGRESS);

  // ?picked=<mode> → the pick the preview shows. A matching ?track=<id> aims the
  // card at that circuit (and its cup) so the card names what the 3D preview is
  // orbiting; without one each mode falls back to something representative.
  function previewPick(picked) {
    const mode = picked === '1' ? 'cup' : String(picked);   // legacy '1' = cup
    const qTrack = new URLSearchParams(location.search).get('track');
    const cupOf = (id) => CUPS.find((c) => c.tracks.includes(id));
    if (mode === 'track') {
      return { mode, trackId: (qTrack && TRACKS[qTrack]) ? qTrack : CUPS[0].tracks[2] };
    }
    if (mode === 'random') return { mode, randomRaces: window.RANDOM_RACES.DEFAULT };
    if (mode === 'tour') return { mode };
    return { mode: 'cup', cupId: ((qTrack && cupOf(qTrack)) || CUPS[0]).id };
  }

  // ---- backdrop ----
  // Mirrors live play's rule (main.js backdropShow3D): only the welcome board
  // (and the device chooser sitting on it) keeps the 2D paper diorama — every
  // other screen floats over the live 3D scene, the lobby included, which has
  // attracted in 3D from its first frame since the boot-time preview shipped.
  // The exception is lobby-loading: it previews the mid-boot lobby, before the
  // scene has drawn a frame (backdropShow3D's sceneReady gate), so it sits on
  // the diorama on purpose. Default-3D otherwise: a scenario added later
  // previews the production look unless it explicitly opts back on here.
  const DIORAMA_ONLY = ['welcome', 'device-choice', 'lobby-loading'];
  if (!DIORAMA_ONLY.includes(scenario)) {
    // #scene ships .is-dim (opacity 0) — drop BOTH .hidden and .is-dim, else the
    // canvas renders into a fully transparent container (looks like a blank page).
    el('scene').classList.remove('hidden', 'is-dim');
    const dio = el('lobby-diorama'); if (dio) dio.classList.add('hidden');
  }

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
  // Read once here (reused by setupRace's audio gate below).
  const inIframe = isFramed();
  function holdFrame(live) {
    if (!inIframe) return;                // own tab → keep running (watch / inspect)
    ctx.scene.pauseAfterFrame();          // paint the state just set, then idle
    if (live) window.__preview = {        // parent gallery card drives play/pause
      play: () => ctx.scene.start(),
      pause: () => ctx.scene.pauseAfterFrame(),
      running: () => ctx.scene.isRunning()
    };
  }
  // Diorama previews (welcome / device-choice / lobby-loading) drive no 3D — the
  // WebGL backdrop sits dimmed behind them — so let the scene paint once, then
  // idle for good. The other lobby previews are NOT in this set: they run the
  // attract demo and hold their frame once it's up (startAttractDemo below).
  if (DIORAMA_ONLY.includes(scenario) && ctx.scenePromise) {
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

  // The CPU fill for the given human slots, by the wasm's own seat rule
  // (cpuSeats): lowest free livery, carIndex wraps the model list, name =
  // the persona that drives it. `personaBase` is where the persona deal
  // starts: 0 for a launch (buildField names bots by bot ordinal — Bolt is
  // always the first bot), slots.length for the lobby demo (buildDemoField
  // names by final grid index so personas spread across the whole field).
  const modelCount = () => (window.CAR_MODELS || []).length || 4;
  function cpuFill(slots, personaBase) {
    const fieldSize = Math.max(slots.length, Math.min(window.FIELD_SIZE || 8, COLORS.length));
    const fill = [];
    const used = slots.slice();
    for (let i = 0; used.length < fieldSize; i++) {
      if (used.includes(i)) continue;
      used.push(i);
      const p = AI_PERSONALITIES[(personaBase + fill.length) % AI_PERSONALITIES.length];
      fill.push({ slot: i, human: false, name: p.name, persona: p, carIndex: i % modelCount() });
    }
    return fill;
  }
  function humanEntries(slots) {
    return slots.map((s) => ({ slot: s, human: true, name: FAKE_NAMES[s], carIndex: s % modelCount() }));
  }
  // A race field in LAUNCH shape — the order the live walks hand begin_field,
  // which seats it verbatim (race_flow's orderGrid, humansAtBack): the CPU
  // field out front, the humans gridded at the back. botSpecs deals personas
  // by the same positions, so name and driving stay matched.
  function raceGrid(slots) {
    return cpuFill(slots, 0).concat(humanEntries(slots));
  }
  // The lobby demo's shape (buildDemoField): the roster first, the fill behind
  // it, and EVERY entry driven by the persona at its final grid index — the
  // fill carries that persona's name — exactly what flow.demoLive answers off
  // a live room. cpuFill(slots.length) lines its names up with the same index
  // by construction.
  function demoGrid(slots) {
    return humanEntries(slots).concat(cpuFill(slots, slots.length)).map((g, n) => ({
      ...g, persona: AI_PERSONALITIES[n % AI_PERSONALITIES.length]
    }));
  }
  // Board previews list the humans on top — the fake-points drama is authored
  // on the roster names — with the CPU fill trailing.
  const humansFirst = (grid) => grid.filter((g) => g.human).concat(grid.filter((g) => !g.human));

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
    renderQR(el('qr'), buildQRMatrix((location.origin || 'https://tinytrack.party') + '/' + code));
  }

  // ---- lobby attract demo ----
  // The live lobby attracts from its first frame, so the lobby previews run the
  // SAME LobbyDemo main.js does — real sim, AI-driven field, orbiting overview
  // camera — on ctx.track (?track= or the catalogue's first, which is also the
  // fresh-display boot fallback). The field mirrors the previewed roster (each
  // seat's car in its seat colour), topped up with CPU racers to a full grid —
  // the shape flow.demoLive answers off a live room.
  function startAttractDemo(slots) {
    const field = demoGrid(slots).map((g) => ({
      id: g.slot, colorIndex: g.slot, carIndex: g.carIndex, name: g.name, stats: statsFor(g.carIndex),
      persona: g.persona
    }));
    const demo = new LobbyDemo(ctx.scene);
    // The SAME automation hook live play publishes (main.js), so one E2E
    // predicate covers both: gallery-lobby.spec asserts the attract race runs.
    window.__lobbyDemo = demo;
    ready().then(() => {
      demo.start(ctx.track, field, 'gallery');
      ctx.scene.onFrame = (dt) => demo.step(dt);
      holdFrame(true); // gallery card: hold the attract race on a still; ▶ resumes it
    }).catch((e) => console.warn('[TestHarness] lobby attract demo failed to start', e));
  }

  if (scenario === 'welcome') {
    // The title board at boot: just the section over the diorama (the room
    // warms invisibly behind it in live play — nothing to fake here). The
    // wordmark/tagline/button slap in on arrival, so ▶ replays that.
    replayable(() => el('welcome').classList.add('hidden'), () => show('welcome'));
    return;
  }

  if (scenario === 'lobby-loading') {
    // The mid-boot lobby (a NEW GAME click the engine boot caught): the ticket
    // shows its blank white square + "Loading…", the scan hint is held back —
    // nothing room-dependent has rendered, so nothing here fakes a join.
    show('lobby');
    renderRoster([], null);
    showPick(null);
    return;
  }

  if (scenario === 'lobby-empty') {
    // The lobby the instant NEW GAME reveals it, before anyone joins: open
    // seats, empty cup slot, the room's join URL + QR — over the boot-time
    // attract race (all-CPU field: no one has joined).
    show('lobby');
    renderRoster([], null);
    renderJoinUrl(el('joinurl'), (location.host || 'tinytrack.party'), null); // stamps the fade-in class
    showPick(null);   // no pick yet → empty slot
    renderQR(el('qr'), buildQRMatrix(location.origin || 'https://tinytrack.party'));
    startAttractDemo([]);
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
    startAttractDemo(slots);
    // Post-pick lobby: race card in the slot, hint gone. `picked` names the MODE
    // ('cup' — legacy '1' — 'track', 'random' or 'tour'); everything the card
    // then says is the model's, off the same renderLobbyPick the live lobby
    // calls. Pair the card with a matching ?track=<id> so the orbiting preview
    // shows the circuit the card names.
    showPick(opts.picked ? previewPick(opts.picked) : null);
    // The bottom-right star shelf, off the same renderer as live play.
    renderCupShelf(el('cup-shelf'), PREVIEW_SHELF);
    return;
  }

  // ---- track preview (used by the track gallery, /gallery-tracks.html) ----
  // Shows the WHOLE layout under a slowly orbiting overview camera, with a small
  // AI field driving it so you can read the line + scale. The cars are added
  // cell:false so the renderer keeps its single overview camera (no split-screen),
  // which is what makes the orbiting whole-track shot possible.
  if (scenario === 'track') {
    show('race');
    hideResults();
    ready().then(() => setupTrackPreview()).catch((e) => console.warn('[TestHarness] track preview failed to start', e));

    function setupTrackPreview() {
      const { scene, track } = ctx;
      scene.setFog(false);   // track preview (grid thumbnail OR free-cam inspector): show the WHOLE circuit, no haze
      // Standalone ("open ↗" / own tab) → free-cam inspector; gallery iframe →
      // keep the calm auto-orbit turntable (you can't comfortably drag a thumbnail).
      if (!enableFreeCamIfStandalone(scene)) scene.orbit = true;

      const grid = raceGrid(buildSlots(players));
      const ids = grid.map((g) => g.slot);
      const newSession = () => bareSession(
        grid.map((g) => ({ peerIndex: g.slot, stats: statsFor(g.carIndex) })), track, { bots: botSpecs(ids) });
      let engine = newSession();
      window.__engine = engine;

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false on EVERY car — opponents in the shared world with no split-screen
      // viewport, so _order stays empty and the overview camera frames the whole track.
      grid.forEach((g) => scene.addCar(g.slot, g.slot, g.name, { cell: false, carIndex: g.carIndex }));

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

  // ---- asset showroom (used by the asset gallery, /gallery-assets.html) ----
  // Everything the game draws, in one scene, under a camera you fly yourself.
  //
  // Three pieces do the work and none of them is new machinery: the SHOWROOM
  // track (shared/devTracks.js) is a stadium oval whose exhibition straight the
  // renderer lines its hero landmarks along; the SHOWCASE theme (set in main.js
  // for this scenario) unions every biome's scenery, clutter and fliers into
  // whichever biome is being shown; and the field is a bare session left UNRUN,
  // so the cars sit parked on the grid — one per model, in the liveries — which
  // is the shot the gallery opens on.
  //
  // The only thing here the other previews do not do is stay INTERACTIVE: the
  // camera is the viewer's, and window.__showroom lets the gallery's own chrome
  // drive the biome, the field and the item roulette without reloading the page
  // (a reload would re-fetch the wasm and every GLB to change a dropdown).
  if (scenario === 'assets') {
    show('race');
    hideResults();
    ready().then(() => setupShowroom()).catch((e) => console.warn('[TestHarness] showroom failed to start', e));

    function setupShowroom() {
      const { scene, track } = ctx;
      const MODELS = window.CAR_MODELS || [];
      const MODEL_NAMES = window.CAR_NAMES || [];
      // Three-quarters behind the grid, at car height: the opening frame is the
      // parked lineup wearing its liveries, with the gantry
      // and then the whole exhibition straight receding past it — the cars, and
      // where to fly next, in one shot. Fitted to the showroom's own geometry
      // (the line is at world origin, the road runs +x, the grid sits behind
      // it), which is why it is authored rather than solved: this scenario
      // builds exactly one track.
      const START_CAM = { eye: { x: -12, y: 2, z: -7.5 }, yaw: 0.75, pitch: -0.12 };
      const cam = enableFreeCam(scene, START_CAM);

      // One seat per LIVERY, cycling the models — eight cars covers every model
      // twice over, and no model is represented by only one paint job.
      //
      // TWO PER MODEL, CYCLING IN SLOT ORDER is load-bearing beyond the paint:
      // the parked showroom puts the monster rig on the BACK HALF of the grid
      // (showcase_monster_from, native/libttp-runtime/ttp/showcase.h), and a rig
      // is the kit chassis seating that slot's own body — so a lineup of this
      // shape is what makes those four rigs one of each of the four trucks
      // rather than the same one four times.
      const ids = [];
      for (let i = 0; i < COLORS.length; i++) ids.push(i);
      const modelOf = (i) => (MODELS.length ? i % MODELS.length : 0);
      const field = ids.map((i) => ({ peerIndex: i, stats: statsFor(modelOf(i)) }));

      let forceItem = null;   // the roulette override the gallery's picker sets
      let engine = null;
      let driving = false;
      const newSession = () => {
        if (engine) engine.dispose();
        engine = bareSession(field, track, { bots: botSpecs(ids), forceItem });
        window.__engine = engine;
        scene.bindSession(engine.h);
        scene.hold(!driving);
      };
      newSession();

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false — no split-screen: one camera over the whole showroom, which
      // is the one this page hands to the viewer.
      ids.forEach((i) => scene.addCar(i, i, MODEL_NAMES[modelOf(i)] || `Car ${i + 1}`,
                                      { cell: false, carIndex: modelOf(i) }));

      // Spending the held item from out here rather than on the bot's own hold,
      // so a forced roulette actually SHOWS the thing on a loop (the rocket's
      // flight and burst, the monster truck's grow-in) instead of once a lap.
      // The car furthest back fires, which is both the most dramatic and what
      // the catch-up items are for. Lifted from the race previews above.
      let useSeq = 0, fireCd = 1.2;
      function spendHeldItem(snap, dt) {
        fireCd -= dt;
        if (fireCd > 0) return;
        if (forceItem === 'monster' && snap.cars.some((c) => c.monster)) return;
        const armed = snap.cars.filter((c) => c.item && !c.finished);
        if (!armed.length) return;
        armed.sort((a, b) => a.totalS - b.totalS);
        engine.processInput(armed[0].id, { u: ++useSeq });
        fireCd = forceItem === 'monster' ? 1.6 : 1.3;
      }

      scene.onFrame = (dt) => {
        if (!driving) return;   // parked: the renderer holds the grid at rest
        engine.update(dt * 1000);
        const snap = engine.getSnapshot();
        if (forceItem) spendHeldItem(snap, dt);
        if (raceOver(snap)) newSession();   // endless: back to the grid, lap again
      };

      // The gallery chrome's control surface. Same-origin, so the page reaches
      // it through the iframe's contentWindow rather than through postMessage.
      window.__showroom = {
        // Park the field back on the grid, or let the AI drive it out — the only
        // way to see the moving half of the kit (skids, dust, items in flight).
        drive(on) {
          driving = on !== false;
          if (driving) scene.hold(false);
          else newSession();   // parked means back ON the grid, not stopped mid-corner
          return driving;
        },
        driving: () => driving,
        // Every box rolls this item, so the demo above can spend it on a loop.
        // null hands the roulette back.
        item(id) { forceItem = id || null; newSession(); return forceItem; },
        heldItem: () => forceItem,
        // Repaint the world. A biome is a scene REBUILD (the palette is baked
        // into the meshes), so this awaits the new scene and rebinds the field.
        async biome(name) {
          scene.biomeOverride = name || null;
          await scene.setTrack(track);
          scene.bindSession(engine.h);
          return scene.biome();
        },
        // The MODEL BENCH: every variant of one procedural prop in a row on the
        // verge, instead of the usual landmark set. Same rebuild shape as the
        // biome pick above — the geometry is baked into the scene's meshes, so
        // there is nothing to toggle on a live one.
        //
        // It FLIES YOU THERE too. The row starts 26 units up the exhibition
        // straight on the far verge, facing the road: findable, but only if you
        // already know it is there, and a bench you have to search for is a
        // bench that gets used once. The viewpoint is authored from the
        // showroom's own geometry for the same reason START_CAM is — this
        // scenario builds exactly one track.
        async bench(model, view) {
          scene.bench(model || '');
          await scene.setTrack(track);
          scene.bindSession(engine.h);
          if (model && view) {
            // Scripted close-ups: a caller that knows where it wants to stand
            // (screenshot sweeps) skips the authored row viewpoint.
            if (view.eye) cam.eye = { ...view.eye };
            cam.yaw = view.yaw ?? 0;
            cam.pitch = view.pitch ?? -0.05;
          } else if (model) {
            // Offset up-track and pulled back so the whole row clears the
            // legend panel, which is the right quarter of the frame whenever
            // the gallery is showing one. The ROCKET row is one entry longer
            // than the other two and is staged at 9x, so it needs both a wider
            // shot and more height.
            const wide = model === 'rocket';
            // The starfish row lies flat on the sand, so the shared eye reads
            // it nearly edge-on — it gets a higher, steeper viewpoint.
            const flat = model === 'starfish';
            cam.eye = { x: wide ? 37.0 : flat ? 35.2 : 31.5,
                        y: wide ? 5.4 : flat ? 5.8 : 2.6,
                        z: wide ? -19.0 : flat ? -9.2 : -10.5 };
            cam.yaw = 0;
            cam.pitch = flat ? -0.5 : -0.05;
          } else {
            this.home();
          }
          return model || '';
        },
        // The KIT FIELD: every model the gallery hands over, standing on clear
        // ground beyond the track (ttp_display_kit_field). This is the browser
        // itself — not a picker beside the scene but the scene — so it answers
        // with the LAYOUT, which is what the chrome flies its camera by and
        // names models from. A scene rebuild, like the biome and the bench.
        async kits(models) {
          scene.kitField(models || []);
          await scene.setTrack(track);
          scene.bindSession(engine.h);
          return scene.kitLayout();
        },
        // Stand in front of one model of the field, at ITS OWN size: a coin
        // needs a step closer than a loop piece, and a row read from one fixed
        // range is a row you cannot judge. Off the LAYOUT, so the camera cannot
        // end up somewhere the model is not.
        lookAtKit(spot) {
          if (!spot) return;
          // Height counts as much as footprint here: the tall thin models
          // (gantries, palms) are exactly the ones a footprint under-reads.
          const reach = Math.max(spot.w, spot.d, spot.h, 1.0);
          cam.eye = { x: spot.x, y: spot.y + reach * 0.45, z: spot.z - reach * 2.4 };
          cam.yaw = 0;              // +z, straight down the row's near side
          cam.pitch = -0.1;
        },
        // Which variant of a prop the SCENE is built with, which is the answer
        // the bench exists to reach: pick one here and it is what the showroom
        // (and every race, until the page reloads) draws.
        async variant(model, v) {
          scene.modelVariant(model, v | 0);
          await scene.setTrack(track);
          scene.bindSession(engine.h);
          return scene.variants();
        },
        // Where the camera is, and how to put it back on the cars. `cam` is the
        // free cam's own state (enableFreeCam hands it back), so this moves the
        // camera the same way a drag does.
        camera: () => ({ ...cam.eye }),
        home() {
          cam.eye = { ...START_CAM.eye };
          cam.yaw = START_CAM.yaw;
          cam.pitch = START_CAM.pitch;
        }
      };
    }
    return;
  }

  // ---- the cup's chained start (scenario=chain) ----
  // The one transition in the game with no lobby step to hide behind: a cup race
  // ends, the intermission board goes up, and the next circuit has to already be
  // on screen when the board comes down. Live play meshes it UNDER the board
  // (main.js prepareNextTrack → Stage.prepare) so the chained start has nothing
  // left to build; done at the start instead, the countdown ticks over the
  // OUTGOING circuit and then hitches. This preview loops that transition around
  // a cup's four tracks so the whole thing can be watched, which no still can
  // show and no assertion reads as well as an eye does.
  //
  // NOTHING HERE KEEPS ITS OWN COPY OF THE SEQUENCE. showBoard is the real
  // results renderer, showCountdownBanner the real banner, the scene work is
  // Stage.prepare / setTrack / rebuild IN THE ORDER THE WALKS EMIT IT
  // (place-track, hide-results, reset-scene-cars, create-session, bind-session,
  // start-countdown), the board sits up for the layer's own intermissionMs, and
  // the countdown is a REAL countdown-mode session: it ticks at the sim's 1 Hz
  // and flips `racing` inside the n=0 beat, so the field leaves on GO because
  // the game says so and not because this file agreed to. A hand-rolled beat
  // clock here had the cars pulling away a beat LATE, which is the whole reason
  // the rule is "drive the live code, don't re-time it".
  //
  // The one authored number left is how long a leg races: a real race is three
  // laps and a preview cannot wait for that.
  //
  // Clocks run off the frame's dt, so the gallery card's pause freezes the demo
  // mid-transition instead of letting it march on behind a still.
  // ---- warp: the deck-under-the-car bench (?scenario=warp) -------------------
  //
  // WHY THIS EXISTS. "It goes wrong on bendy tracks" is not one question, it is
  // three, and a shipped circuit asks all of them at once: the road bends in
  // PLAN, the deck TWISTS, and the deck rises and falls. Those are different
  // conditions with different causes, and on `powder` or `sidewinder` you
  // cannot tell which one you are looking at.
  //
  // So this drives ONE car, slowly, at a held lateral offset, along a track
  // whose legs are one warp each (devTracks.js `warp`), and puts the number
  // that separates them on screen: GAP, the deck's departure from the plane the
  // car is seated on, measured at its four wheel corners. It reads 0 down every
  // flat leg AND through the plain corner, and only the rungs move it — so a
  // defect that tracks GAP is the deck's, and one that does not is not.
  //
  // It is what found the ground conform's real bug: the body was posed from the
  // centreline while standing on a surface, and the height correction switched
  // ITSELF off past ~29 degrees of roll.
  //
  // Everything here is a dev instrument: no gallery card, no fixture, nothing
  // else imports it. Keep it that way — it is allowed to be blunt.
  if (scenario === 'warp') {
    show('race');
    hideResults();
    ready().then(() => runWarpBench()).catch((e) =>
      console.warn('[TestHarness] warp bench failed to start', e));
    return;
  }

  function runWarpBench() {
    const { scene, track } = ctx;
    const CAR = 0;
    const engine = bareSession([{ peerIndex: CAR, stats: statsFor(CAR) }], track, { bots: [] });
    window.__engine = engine;
    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    scene.addCar(CAR, CAR, 'BENCH', { carIndex: CAR });
    scene.bindSession(engine.h);
    // No cell owns a car, so the bench drives the camera itself (Stage only runs
    // the user camera when the cell list is empty) and no split-screen HUD lands
    // on top of the thing being looked at.
    scene.soloCam = true;
    const cam = scene.enableUserCamera({ eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: -0.7 });
    document.querySelectorAll('.cam-hint').forEach((n) => n.remove());

    // The bench's state. `step` is what makes a per-frame pop findable: freeze,
    // then advance ONE sim frame at a time and watch the outline between two
    // stills rather than trying to catch it at 60 Hz.
    const st = {
      lat: 0,            // held lateral offset — the line the car is pinned to
      speed: 3.5,        // world u/s; slow enough to read, fast enough to move
      paused: false,
      step: 0,           // frames owed while paused
      cam: 'orbit',      // orbit | deck | chase | free
      dist: 3.2,         // orbit/deck framing distance
      elev: 0.95,        // orbit elevation off the deck plane, radians
      // Lap length, SELF-CALIBRATED from the stamp's own arclength. The display
      // holds no track geometry — that is the point of the native builder — so
      // there is nothing on this page to read it off; the high-water mark of a
      // wrapping value is, and one lap of the bench settles it.
      lapL: 0,
      lock: false,     // camera frozen in world space (see place())
      // ISOLATION: hide the bodies and wipe the laid rubber, so the deck
      // stamp is the only dark thing on the road. Without this a contact
      // shadow, a tyre trail and the car's own underside are three dark
      // patches in the same place and no screenshot can separate them.
      solo: false,
      forceLayer: -1   // -1 auto · 9 the generic superellipse · 8 the monster rig
    };
    const DT = 1 / 60;   // fixed: a bench that varies its own timestep is useless

    const hud = document.createElement('div');
    hud.id = 'warp-hud';
    hud.style.cssText = 'position:absolute;left:16px;top:16px;z-index:40;padding:10px 12px;'
      + 'background:rgba(18,20,26,.82);color:#e9edf5;border-radius:10px;pointer-events:none;'
      + 'font:12px/1.55 ui-monospace,Menlo,monospace;white-space:pre;min-width:290px';
    el('race').appendChild(hud);

    // Which rung the car is on, named. Derived from the descriptor's own leg
    // structure rather than hand-typed arclengths, so it cannot rot when a rung
    // is retuned — the four legs are equal by construction (see devTracks.js).
    const legName = (u) => (u < 0.25 ? 'N · FLAT CONTROL / plain corner'
      : u < 0.5 ? 'E · TWIST rungs → banked corner'
        : u < 0.75 ? 'S · CREST / DIP rungs'
          : 'W · flat run-back');

    // Hold the line: steer proportionally back to the target lat, brake above
    // the target speed. Deliberately a governor and not a driver — the bench
    // wants the SAME pass over a rung every time, not a racing line.
    //
    // BOTH TERMS ARE DELIBERATELY LAZY, and it matters. A bang-bang brake and a
    // twitchy steer both SCRUB, and scrub lays rubber — which is a dark band in
    // track space, right under the car, in the one place you are trying to read
    // a dark blob in world space. The first pass of this bench printed tyre
    // trails through the very stamp it exists to show. So: hysteresis on the
    // brake, and damping on the steer, to keep the deck clean under the car.
    let braking = false;
    function drive(car) {
      const err = st.lat - car.lat;
      const s = Math.max(-1, Math.min(1, err * 1.1 - car.steer * 0.45));
      if (braking && car.spd < st.speed * 0.92) braking = false;
      else if (!braking && car.spd > st.speed * 1.08) braking = true;
      engine.processInput(CAR, { s, b: braking ? 1 : 0, u: 0 });
    }

    function place(car) {
      const p = car.pose.pos, f = car.pose.forward, up = car.pose.up;
      if (st.cam === 'free') return;                 // hands off: the drag owns it
      // LOCK: stop tracking and leave the camera where it is, so stepping the
      // car forward changes ONLY the car and what is painted under it. Without
      // this the camera moves with the car and every pixel in the frame changes
      // every step, which buries a shape pop in global motion — the trap that
      // made a whole burst of chase-camera captures unreadable.
      if (st.lock) return;
      let eye, dir;
      if (st.cam === 'deck') {
        // FACE-ON DOWN THE DECK NORMAL. The stamp is a prism along this axis, so
        // seen from here its painted footprint is the baked silhouette EXACTLY —
        // any departure is real and cannot be blamed on perspective. The car
        // hides most of it, which is the point of the orbit view below; use this
        // one to check the deck itself and the stamp's reach past the body.
        eye = { x: p.x + up.x * st.dist, y: p.y + up.y * st.dist, z: p.z + up.z * st.dist };
        dir = { x: -up.x, y: -up.y, z: -up.z };
      } else if (st.cam === 'chase') {
        eye = { x: p.x - f.x * 3.4 + up.x * 1.1, y: p.y - f.y * 3.4 + up.y * 1.1,
                z: p.z - f.z * 3.4 + up.z * 1.1 };
        dir = { x: f.x, y: f.y, z: f.z };
      } else {
        // ORBIT: high and off to one side, so the stamp spills clear of the body
        // on the far side. This is the view that shows the SHAPE.
        const r = { x: f.z * -1, y: 0, z: f.x };     // the car's right, in plan
        const c = Math.cos(st.elev), sE = Math.sin(st.elev);
        eye = { x: p.x + (r.x * 0.75 - f.x * 0.66) * st.dist * c + up.x * st.dist * sE,
                y: p.y + (r.y * 0.75 - f.y * 0.66) * st.dist * c + up.y * st.dist * sE,
                z: p.z + (r.z * 0.75 - f.z * 0.66) * st.dist * c + up.z * st.dist * sE };
        dir = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
      }
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      cam.eye = eye;
      cam.yaw = Math.atan2(dir.x, dir.z);
      // Short of vertical: the look basis degenerates exactly at ±π/2, which is
      // why Stage clamps its own drag to 1.55 (the deck view sits right on it).
      cam.pitch = Math.max(-1.54, Math.min(1.54, Math.asin(dir.y / len)));
    }

    function paint(car) {
      const d = scene.display.debugDecals().filter((x) => x.masked > 0.5)[0];
      if (d) st.lapL = Math.max(st.lapL, d.s);
      const u = (d && st.lapL > 1) ? d.s / st.lapL : 0;
      hud.textContent = [
        `${st.lapL > 1 ? legName(u) : 'calibrating lap…'}`,
        `s ${(d ? d.s : car.totalS).toFixed(2).padStart(8)}`
          + `   lat ${car.lat.toFixed(2).padStart(6)}   spd ${car.spd.toFixed(2)}`,
        // GAP is the deck's departure from the plane the car is seated on,
        // measured at the four wheel corners — 0 on a flat leg AND on a plain
        // corner, so it separates "the road bends" from "the deck warps".
        d
          ? `GAP  ${d.wheelGap.toFixed(4).padStart(7)}   `
            + `${'█'.repeat(Math.min(24, Math.round(d.wheelGap * 120))) || '·'}`
          : 'GAP     —      (no car stamp this frame)',
        d ? `jitter ${d.jitter.toFixed(5)} seated · ${d.rawJitter.toFixed(5)} contract`
          + `   lean ${d.upJitter.toFixed(5)}` : '',
        '',
        `cam ${st.cam}${st.lock ? ' LOCKED' : ''}${st.solo ? ' · CARS HIDDEN' : ''}`
          + `   ${st.paused ? 'PAUSED' : 'running'}`
          + (st.forceLayer >= 0 ? `   MASK ${st.forceLayer}` : '')
          + `   lat target ${st.lat.toFixed(1)}`,
        'space pause · , . step · [ ] speed · k l lat · c cam · f lock'
          + ' · h hide cars · w wipe rubber · m mask · - = zoom'
      ].join('\n');
    }

    scene.onFrame = () => {
      let advance = !st.paused;
      if (st.paused && st.step > 0) { st.step--; advance = true; }
      const pre = engine.getSnapshot().cars[0];
      if (pre) drive(pre);
      if (advance) engine.update(DT * 1000);
      const car = engine.getSnapshot().cars[0];
      if (!car) return;
      scene.setCarHud(car.id, car);
      place(car);
      paint(car);
    };

    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === ' ') { st.paused = !st.paused; e.preventDefault(); }
      else if (k === '.') { st.step++; st.paused = true; }
      else if (k === ',') { st.step += 10; st.paused = true; }   // a beat, not a frame
      else if (k === '[') st.speed = Math.max(0.5, st.speed - 0.5);
      else if (k === ']') st.speed = Math.min(20, st.speed + 0.5);
      else if (k === 'k') st.lat = Math.max(-2.0, st.lat - 0.4);
      else if (k === 'l') st.lat = Math.min(2.0, st.lat + 0.4);
      else if (k === '-') st.dist = Math.min(14, st.dist + 0.4);
      else if (k === '=') st.dist = Math.max(1.2, st.dist - 0.4);
      else if (k === 'f') st.lock = !st.lock;
      else if (k === 'h') { st.solo = !st.solo; scene.display.debugHideCars(st.solo); }
      else if (k === 'w') scene.display.debugWipeSkids();
      else if (k === 'm') {
        // auto -> generic -> monster -> auto. The generic layer is a shape
        // correct by construction, so it separates a bad BAKE from a bad
        // everything-downstream-of-the-bake.
        st.forceLayer = st.forceLayer === -1 ? 9 : st.forceLayer === 9 ? 8 : -1;
        scene.display.debugForceMaskLayer(st.forceLayer);
      }
      else if (k === 'c') {
        const order = ['orbit', 'deck', 'chase', 'free'];
        st.cam = order[(order.indexOf(st.cam) + 1) % order.length];
      }
    });
    // WASD belong to Stage's free cam; the bench must not fight it in 'free'.
    holdFrame(false);
  }

  const CHAIN_RACE_MS = 8000;    // long enough to leave the grid and read as a race
  if (scenario === 'chain') {
    show('race');
    hideResults();
    ready().then(() => setupChain()).catch((e) => console.warn('[TestHarness] chain preview failed to start', e));

    function setupChain() {
      const { scene, built } = ctx;
      const cup = CUPS[0];
      const grid = raceGrid(buildSlots(players));
      const ids = grid.map((g) => g.slot);
      const field = grid.map((g) => ({ peerIndex: g.slot, stats: statsFor(g.carIndex) }));
      const entry = (id) => built.get(id);

      let leg = 0;          // which of the cup's tracks is racing
      let engine = null;
      let onBoard = false;  // the intermission is up; the sim is done
      let boardMs = 0, raceMs = 0, lastHud = 0;

      // The launch, performed in the walks' own order. The two rebuild triggers
      // (setTrack, rebuild) come out as no-ops when the board above already
      // prepared this circuit — which is the whole point of the preview.
      function launch() {
        const t = entry(cup.tracks[leg]);
        scene.setTrack(t);                                    // place-track
        hideResults();                // hide-results
        for (const id of [...scene.cars.keys()]) scene.removeCar(id);
        grid.forEach((g) => scene.addCar(g.slot, g.slot, g.name, { carIndex: g.carIndex, cell: g.human }));
        scene.rebuild();                                      // reset-scene-cars
        if (engine) engine.dispose();                         // dispose-session
        // A COUNTDOWN-MODE session, not a bare one: the beats, their cadence and
        // the moment the field is allowed to move are all its own, drained to
        // the banner through the callback the live shell uses.
        engine = new NativeRaceSession(field, t, {            // create-session
          bots: botSpecs(ids),
          onCountdownTick: (n) => showCountdownBanner(countdownBeat(n))
        });
        window.__engine = engine;
        scene.bindSession(engine.h);                          // bind-session
        // The manifest's own count, and the same E2E override the live launch
        // reads — not a 3 retyped here.
        engine.startCountdown(window.__countdownSeconds || window.COUNTDOWN_SECONDS);
        for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
        onBoard = false; raceMs = 0;
      }

      // End of a leg: the board goes up and the NEXT circuit is meshed behind it.
      function intermission() {
        showBoard(cupBoard(leg, false));
        leg = (leg + 1) % cup.tracks.length;
        scene.prepare(entry(cup.tracks[leg]));
        onBoard = true; boardMs = 0;
      }

      launch();
      scene.onFrame = (dt) => {
        const ms = dt * 1000;
        if (onBoard) {
          // The board sits for the layer's OWN budget, which is also the number
          // it is at that moment printing in its "starting in N…" footer.
          boardMs += ms;
          if (boardMs >= intermissionMs()) launch();
          return;
        }
        // Countdown and race are ONE path here exactly as they are in main.js:
        // the session is updated from the first countdown frame on (cars drawn
        // and steerable, physics held), and IT decides when they are racing.
        engine.update(ms);
        const now = performance.now();
        if (now - lastHud > HUD_TICK_MS) {
          lastHud = now;
          for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
        }
        if (!engine.racing) return;   // still counting down
        raceMs += ms;
        if (raceMs >= CHAIN_RACE_MS || raceOver(engine.getSnapshot())) intermission();
      };
      holdFrame(true);   // gallery: the card's ▶ runs the loop; a standalone tab just runs
    }
    return;
  }

  // ---- race scenarios (countdown / racing / results) ----
  // Switch to the race screen synchronously so the lobby (QR/roster/join URL)
  // doesn't flash while the GLBs load. Build the engine + scene cars once the
  // GLBs are ready, place them at the grid, then install our own frame hook.
  show('race');
  hideResults();
  ready().then(() => setupRace(scenario)).catch((e) => console.warn('[TestHarness] race preview failed to start', e));

  function setupRace(kind) {
    const { scene, track } = ctx;
    // (race screen already shown synchronously above, before the GLB load)

    // Give each preview car the model + stats for its slot so the gallery shows
    // the real spread of handling and the new car-car bumping, not a uniform field.
    const grid = raceGrid(buildSlots(players));
    const ids = grid.map((g) => g.slot);
    const field = grid.map((g) => ({ peerIndex: g.slot, stats: statsFor(g.carIndex) }));

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
    // Humans get their split-screen cell, the CPU fill drives cell-less — the
    // C++ rule live launches apply (race_flow's cell = !ai).
    grid.forEach((g) => scene.addCar(g.slot, g.slot, g.name, { carIndex: g.carIndex, cell: g.human }));
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
      if (kind === 'monster' && sfx) for (const c of snap.cars) sfx.engineDrive(c.id, c.monster ? c.spd / 1.2 : 0, MONSTER_ENGINE_MOD);
      const now = performance.now();
      if (now - lastHud > HUD_TICK_MS) {
        lastHud = now;
        for (const c of snap.cars) scene.setCarHud(c.id, c);
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
      // needed — the matrix is built in-browser).
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
      // The finisher must be a HUMAN — the FINISHED card lives in a split-screen
      // cell, and the CPU fill has none.
      const humanIds = new Set(grid.filter((g) => g.human).map((g) => g.slot));
      const leadId = engine.getSnapshot().cars.filter((c) => humanIds.has(c.id))
        .reduce((a, b) => (a.position <= b.position ? a : b)).id;
      engine.forceFinish(leadId, FAKE_TIMES[0]); // promote the finisher to P1; the rest keep racing for position
      const fnCars = engine.getSnapshot().cars;
      dressItems(fnCars); // the still-racing cells carry items (setCarHud clears the finisher's own slot)
      for (const c of fnCars) scene.setCarHud(c.id, c);
      scene.hold(true);
    } else if (kind === 'results') {
      // Freeze the grid behind the blurred results overlay. Every row is a plain
      // finish; the late joiner riding along under the field gets the model's
      // `joining` shape (no rank, no time — they race the next one).
      const roster = humansFirst(grid);
      const order = roster.map((g, i) => ({
        playerId: g.slot, name: g.name, colorIndex: g.slot, finished: true, time: FAKE_TIMES[i],
        racePlace: i + 1
      }));
      // The late joiner riding along under the field. Its seat colour can repeat
      // a CPU livery — exactly as live, where a mid-race join takes a free SEAT,
      // not a free livery in the running race.
      const j = players % FAKE_NAMES.length;
      order.push({ playerId: j, name: FAKE_NAMES[j], colorIndex: j, joining: true });
      playBoard({ over: true, hostPeerIndex: roster[0].slot, order });
    } else if (kind === 'intermission' || kind === 'podium') {
      // Cup dressings of the same overlay: frozen grid behind either the mid-cup
      // intermission (points board + "next up" footer) or the final podium.
      // WHICH dressing is the model's call off `final` — the two previews differ
      // only in the board handed to it.
      const final = kind === 'podium';
      playBoard(cupBoard(final ? CUPS[0].tracks.length - 1 : 1, final));
    }
    // gallery: animated previews (racing/rocket/monster) hold a still grid and run via
    // the card's ▶; frozen previews (countdown/paused/reconnect/finished/results) paint
    // once and stay idle. Standalone tabs ignore this and run freely.
    holdFrame(live);
  }

  function runCountdown() {
    let timers = [];
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const seq = [3, 2, 1, 0].map(countdownBeat);
    const rest = { n: 3, slap: false, go: false };  // the frozen frame between replays
    function run() {
      clear();
      let i = 0;
      (function tick() {
        showCountdownBanner(seq[i]);
        i++;
        if (i < seq.length) timers.push(setTimeout(tick, CD_BEAT_MS));
        else timers.push(setTimeout(() => showCountdownBanner(rest), 1200));
      })();
    }
    showCountdownBanner(rest); // frozen initial frame; ▶ replays the sequence
    window.__TEST__.replay = run;
  }
}
