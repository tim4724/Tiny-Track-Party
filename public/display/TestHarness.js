// Display Test Harness — drives a single display screen in isolation for the
// gallery (/gallery.html), with NO relay connection. main.js delegates here
// when the URL carries ?scenario=…, handing over the live scene +
// track so we can stand up the lobby, countdown, a self-driving race preview,
// or the results overlay from fake data. ?scenario=bench is the one that is not
// a picture: a live race left running under the perf readout (startBenchReadout).
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
import { dissolveInto } from './backdrop.js';
import { resultsView, intermissionSecs, previewBoard, previewProgress, progressLoad, catalogue } from './NativeUiModel.js';
import { benchField, previewCupRace, intermissionMs, flourishMs } from './NativeRaceFlow.js';
import { LobbyDemo } from './LobbyDemo.js';
import { CUPS, TRACKS, TRACK_LIST } from '../shared/tracks.js';
import { trackSchematic } from './NativeSchematic.js';
import { glbTriangles } from './glbTriangles.js';
import { assetUrl } from '../shared/assetUrl.js';

// One countdown beat as the banner takes it — race_flow.cc's countdownTick,
// which is the only thing about a beat that is a decision: numerals slap in, GO
// does not (it fades out on .is-go instead). A preview supplies the BEAT NUMBER
// and nothing else, and this is the one place the chained start below turns one
// into a banner. It is not the walk itself: reaching that needs a live room
// handle, which no scenario has.
const countdownBeat = (n) => ({ n, slap: n > 0, go: n === 0 });
// The banner AFTER its entrance: the numeral in place, no slap left to play.
// That is the Countdown card, and it is also the frame the Apple TV top shelf is
// cut from (scripts/bake-shelf.mjs), so which numeral this holds is shipped art.
// The chain scenario below counts for real off a live session instead.
const COUNTDOWN_STILL = { n: 3, slap: false, go: false };

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
// A per-car preview fact, keyed by CAR ID. A car id is a SCALAR that may be a
// number or a string — the CPU fill's are 'ai-0'… (race_flow's aiPrefix) — so
// nothing on this page may index an array with one or do arithmetic on one.
// What a preview wants per car sits on that car's launch FIELD entry, and this
// is how it is reached. The minimap paid for the rule: `colors[c.id % n]` is
// colors[NaN] for every bot, which writes the fill as the literal "undefined"
// and paints the CPU dots black.
const byCar = (field, pick) => new Map(field.map((f, i) => [f.peerIndex, pick(f, i)]));

// Bare mode has no session layer to fire a raceEnd, so the endless previews read the
// engine's own `raceOver` rule (finishedOrder >= cars) straight off the snapshot.
const raceOver = (snap) => snap.cars.length > 0 && snap.cars.every((c) => c.finished);

// What a live preview keeps about its race for the trailer editor (window.__preview):
// which deal of the race this is, the frame clock at the deal and now, and the race's
// events stamped with the race's own time — the sim's word on when a rocket went, a
// truck grew or a car was struck, with no snapshot to diff. Kept for the current deal
// and the one before, since the editor reads a race's log the step after the harness
// has dealt the next one.
function raceLog() { return { deal: 0, dealAtMs: 0, frameMs: 0, events: [] }; }
function logDeal(log) {
  log.deal++;
  log.dealAtMs = log.frameMs;
  log.events = log.events.filter((e) => e.deal >= log.deal - 1);
}

// The per-event effects a live race PERFORMS, mirrored from the decision race_flow.cc
// makes in raceEvent(): a live car's pickup spins its cell roulette and its reveal
// gate lands it, a rocket strike bursts on the victim, a whiff bursts where the rocket
// died. The walk that decides them takes a room, and these previews have none — so
// this is the one place the harness performs a race_flow rule by hand, and it performs
// it for EVERY live preview:
// the trailer films them as the game, and a race that spun its cars without a fireball
// or left its item slots empty was not the game. Renderer calls only — nothing here is
// audio; the decision layer hears the same events itself. Every event also lands in
// the preview's log (raceLog).
function raceEventPerformer(scene, log) {
  return (ev) => {
    if (ev.type === 'pickup' && !ev.finished) scene.itemPickup(ev.id, ev.item);
    else if (ev.type === 'item_ready') scene.itemReady(ev.id);
    else if (ev.type === 'spin' && ev.cause === 'rocket') scene.rocketImpact(ev.id);
    else if (ev.type === 'rocket_expire') scene.rocketExpire(ev.s, ev.lat);
    log.events.push({ deal: log.deal, t: (log.frameMs - log.dealAtMs) / 1000,
                      type: ev.type, id: ev.id, item: ev.item, cause: ev.cause });
  };
}

// The editor's half of window.__preview: deal the race again from the top, and read
// the deal count and the log (see holdFrame).
const previewControl = (restart, log) => ({ restart, deal: () => log.deal, events: () => log.events });

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

// The PERF BENCH's whole shell half (?scenario=bench): a live race that runs
// until the tab closes, printing the shared frame-cost readout once a second.
//
// THE LINE IS THE CONTRACT and it is the same on all three shells — one
// `TtpPerf <json>` per line on the platform's own log stream, carrying exactly
// the bytes ttp_perf_readout_json answered — so ONE parser reads a browser, an
// Apple TV and an Android box (scripts/perf-race.mjs). Nothing is folded,
// renamed or added here: a shell that reshapes the line is a shell whose
// numbers cannot be compared with the other two's.
//
// A DEV SURFACE, deliberately not a gallery card (shared/galleryScenarios.js):
// it never settles on a frame to photograph, and it is the one scenario meant
// to be left running.
function startBenchReadout(scene, track) {
  scene.perf.track = track.trackId;   // GPU cost is per track as well as per pixel
  // MEASURE WITHOUT DRAWING: the panel is off by default and stays off here, but
  // the window has to keep the CPU term the line below prints — which follows a
  // READER, not visibility (PerfHud.bench). It also drops the frames spent
  // standing the scene up, which are not the bench's.
  scene.perf.bench();
  setInterval(() => {
    const line = scene.perf.readout();
    if (line) console.log('TtpPerf ' + line);
  }, 1000);
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
function buildMinimap(parent, trackId, field, colors) {
  const schem = trackSchematic(trackId);
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
  // The livery each dot wears, off the launch field rather than off the id.
  const paint = byCar(field, (f) => colors[f.colorIndex % colors.length]);
  return {
    update(cars) {
      for (const c of cars) {
        if (!c.pose) continue;
        let dot = dots.get(c.id);
        if (!dot) {
          dot = document.createElementNS(NS, 'circle');
          dot.setAttribute('r', '8.7');       // schematic viewBox is 0 0 256 256 (see trackSchematic VIEW)
          dot.setAttribute('fill', paint.get(c.id) || colors[0]);
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
  // live FIELD_SIZE with cell-less CPU racers (raceField below), so a gallery
  // race reads like a real one: 8 cars, at most 4 cells.
  const players = Math.max(1, Math.min(opts.players != null ? opts.players : 4, window.MAX_PLAYERS || 4));
  // ?seed= (see main.js): null leaves NativeRaceSession's own default, which is what
  // every gallery card wants — one pinned take, so a preview never shifts under a
  // reviewer. Spread into the session opts rather than defaulted here so the number
  // still has exactly one home.
  const seedOpt = opts.seed != null ? { seed: opts.seed } : {};
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

  // Paint the results overlay from a SYNTHESIZED board — the same shape
  // ttp_ui_standings_live_json hands live play — through the real ui model and
  // the real renderer. The preview's whole job is choosing what board to show; every
  // decision after that (dressing, row kinds, podium split, footer) is the
  // model's, exactly as in a real race.
  //
  // PAINTED ON ARRIVAL, NEVER SETTLED DIRECTLY, and that is what makes the board
  // cards honest: the model turns phase 1 (the race that just ended, with its lap
  // times and +N gains) into phase 2 (the cup table) on its own clock, and only
  // phase 1 carries that dressing. `settleMs` in shared/galleryScenarios.js is
  // how a capture waits for the phase it wants.
  const showBoard = (board) => renderResults(resultsView(board, { intermissionMs: intermissionMs() }), COLORS);

  // The lobby's cup slot, off the same renderLobbyPick the live lobby calls: a
  // PICK goes in, the model decides the whole card. null empties the slot.
  // The fabricated couch dresses the shelf below, so gallery-lobby.spec can pin
  // dressings only the right payload produces. The couch is
  // ttp_ui_preview_progress_json's, loaded like a saved record so the shelf and
  // the tour card derive their stars and lock exactly as live play does.
  progressLoad(previewProgress(), false);
  const PREVIEW_PROGRESS = catalogue();
  const previewCatalog = TRACK_LIST.map((t) => ({ id: t.id, svg: trackSchematic(t.id) }));
  const showPick = (pick) => renderLobbyPick(el('cup-slot'), pick || {}, previewCatalog);

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

  // ---- gallery power saver ----
  // The gallery mounts ~11 live WebGL scenes at once; left alone each runs a full
  // render loop forever — even the frozen previews, which redraw an unchanging frame
  // 60×/sec. Hold every preview on a single painted frame (pauseAfterFrame) and then
  // leave it idle. Animated previews additionally expose window.__preview so the
  // gallery CARD can drive play/pause from the parent document — the preview iframe is
  // pointer-events:none (page-scroll pass-through, gallery.css), so it can't take the
  // click itself — and so the trailer editor can restart the race and read its log
  // (previewControl). A standalone tab (own window) ignores all this and runs freely:
  // you opened it to watch or to fly the free-cam. Call holdFrame AFTER the scene's
  // first state is set, so the held frame shows that state.
  // Read once here (reused by setupRace's audio gate below).
  const inIframe = isFramed();
  function holdFrame(live, control) {
    if (!inIframe) return;                // own tab → keep running (watch / inspect)
    ctx.scene.pauseAfterFrame();          // paint the state just set, then idle
    if (live) window.__preview = {        // parent gallery card drives play/pause
      play: () => ctx.scene.start(),
      pause: () => ctx.scene.pauseAfterFrame(),
      running: () => ctx.scene.isRunning(),
      ...control,
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

  // THE RACE FIELD IS THE LAUNCH'S OWN (ttp_race.h's bench field): `players`
  // seats at the back of the game's grid, the CPU fill in front, every seat
  // autopiloted so a preview with nobody holding a phone is still an authentic
  // race. What comes back is exactly what ttp_session_begin_field takes.
  //
  // It replaces a hand copy of cpuSeats/buildField/orderGrid that lived here,
  // and the copy had already drifted: its bot seeds were `id + 1` where the
  // engine deals toUint32(seed + n), so every gallery race was watching bots no
  // real race has. The seed is the SESSION's, so the field and the race it
  // drives are one draw.
  const raceField = () => benchField(ctx.track.trackId, players, seedOpt.seed ?? 1);

  // The lobby demo's shape (buildDemoField): the roster and the CPU fill in
  // livery order, EVERY entry driven by the persona at its grid slot — the fill
  // carries that persona's name — exactly what flow.demoLive answers off a live
  // room. There is no walk to call for it: demoLive needs a room handle, and no
  // scenario here has one.
  const modelCount = () => (window.CAR_MODELS || []).length || 4;
  function demoGrid(slots) {
    const grid = slots.map((s) => ({ slot: s, human: true, name: FAKE_NAMES[s],
                                     carIndex: s % modelCount() }));
    const fieldSize = Math.max(slots.length, Math.min(window.FIELD_SIZE || 8, COLORS.length));
    const used = slots.slice();
    for (let i = 0; grid.length < fieldSize; i++) {
      if (used.includes(i)) continue;   // lowest free livery, cpuSeats' own rule
      used.push(i);
      grid.push({ slot: i, human: false, carIndex: i % modelCount() });
    }
    return grid.sort((a, b) => a.slot - b.slot).map((g, n) => {
      const persona = AI_PERSONALITIES[n % AI_PERSONALITIES.length];
      return { ...g, persona, name: g.human ? g.name : persona.name };
    });
  }
  // Board previews list the players on top — the fake-points drama is authored
  // on their names — with the CPU fill trailing.
  const humansFirst = (field) => field.filter((f) => !f.ai).concat(field.filter((f) => f.ai));

  // Seat grid via the SAME renderer as the live lobby (lobbySeats.js), so the
  // preview can't drift from the real markup. The preview varies the car per
  // slot (carIndex = slot) so the lobby shows a mix of models.
  function renderRoster(slots, hostPeerIndex) {
    renderSeats(el('players'), slots.map((s) => ({
      name: FAKE_NAMES[s], colorIndex: s, carIndex: s, host: s === hostPeerIndex,
      // `connected: true`, and it is LOAD-BEARING. The seat grid TAKES a roster
      // row and DERIVES the dimming from it, so an absent `connected` reads as
      // falsy and every previewed seat comes back `off` — the whole dock at 50%
      // opacity, in the gallery that exists to check the look. It was, in every
      // populated lobby shot, until a TV column beside it made the difference
      // obvious. (GameState.kt on Android carries the same warning; that shell
      // hit this from the other direction.)
      connected: true,
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
      persona: g.persona, player: g.human
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
    // wordmark/tagline/button slap in on arrival and the card is the still they
    // land on.
    show('welcome');
    return;
  }

  if (scenario === 'lobby-loading') {
    // The mid-boot lobby (a NEW GAME click the engine boot caught): the ticket
    // shows its blank white square + "Loading…", the scan hint is held back —
    // nothing room-dependent has rendered, so nothing here fakes a join.
    show('lobby');
    renderRoster([], null);
    showPick(null);
    // The shelf is on the board from BOOT in live play (main.js calls
    // refreshCupShelf at module scope, off the catalogue the engine already
    // holds) — it is the couch's record, not something a pick reveals. Left out
    // here, the two lobby cards that show no pick were the only ones in the
    // gallery missing a card the live lobby always has, and every TV column
    // compared against them looked like it had grown one.
    renderCupShelf(el('cup-shelf'), PREVIEW_PROGRESS.cups, PREVIEW_PROGRESS.stars);
    return;
  }

  if (scenario === 'lobby-empty' || scenario === 'reconnecting' || scenario === 'disconnected') {
    // The lobby the instant NEW GAME reveals it, before anyone joins: open
    // seats, empty cup slot, the room's join URL + QR — over the boot-time
    // attract race (all-CPU field: no one has joined).
    show('lobby');
    renderRoster([], null);
    renderJoinUrl(el('joinurl'), (location.host || 'tinytrack.party'), null); // stamps the fade-in class
    showPick(null);   // no pick yet → empty slot
    renderQR(el('qr'), buildQRMatrix(location.origin || 'https://tinytrack.party'));
    renderCupShelf(el('cup-shelf'), PREVIEW_PROGRESS.cups, PREVIEW_PROGRESS.stars);
    startAttractDemo([]);
    if (scenario !== 'lobby-empty') {
      // The display's OWN link over that board: the overlay main.js fills off
      // the set-link effect, filled here off a fabricated view. Mid-backoff
      // shows the kit's counter; the spent budget shows the button, focused,
      // as it is live — nothing else on the glass takes focus then.
      const gaveUp = scenario === 'disconnected';
      el('link-overlay').classList.remove('hidden');
      el('link-heading').textContent = gaveUp ? 'Disconnected' : 'Reconnecting…';
      el('link-status').textContent = gaveUp ? '' : 'Attempt 3 of 5';
      el('link-reconnect').classList.toggle('hidden', !gaveUp);
      if (gaveUp) el('link-reconnect').focus();
    }
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
    // Post-pick lobby: the race card fills the rail's slot. `picked` names the
    // MODE ('cup' — legacy '1' — 'track', 'random' or 'tour'); everything the
    // card then says is the model's, off the same renderLobbyPick the live
    // lobby calls. Pair the card with a matching ?track=<id> so the orbiting
    // preview shows the circuit the card names.
    showPick(opts.picked ? previewPick(opts.picked) : null);
    // The star shelf under it, off the same renderer as live play.
    renderCupShelf(el('cup-shelf'), PREVIEW_PROGRESS.cups, PREVIEW_PROGRESS.stars);
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

      const { field, bots } = raceField();
      const newSession = () => bareSession(field, track, { bots });
      let engine = newSession();
      window.__engine = engine;

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false on EVERY car — opponents in the shared world with no split-screen
      // viewport, so _order stays empty and the overview camera frames the whole track.
      field.forEach((f) => scene.addCar(f.peerIndex, f.colorIndex, f.name,
                                       { cell: false, carIndex: f.carIndex }));

      const minimap = buildMinimap(el('race'), track.id, field, COLORS);
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
      //
      // The seats are the BENCH ROSTER's (ttp_race.h's bench field, one per
      // livery here rather than a race's four): livery = seat, model = seat
      // wrapped into the model list, every seat carrying a controller. That is
      // the lineup above, dealt by the launch rule instead of by this page.
      const { field, bots } = benchField(track.trackId, COLORS.length, 1);

      let forceItem = null;   // the roulette override the gallery's picker sets
      let engine = null;
      let driving = false;
      const newSession = () => {
        if (engine) engine.dispose();
        engine = bareSession(field, track, { bots, forceItem });
        // Every box rolls the forced item, and the engine gives and fires it on a
        // loop (the rocket's flight and burst, the monster truck's grow-in)
        // instead of once a lap: the showcase rule, ttp_item_showcase.
        engine.itemShowcase(forceItem);
        window.__engine = engine;
        scene.bindSession(engine.h);
        scene.hold(!driving);
      };
      newSession();

      for (const id of [...scene.cars.keys()]) scene.removeCar(id);
      // cell:false — no split-screen: one camera over the whole showroom, which
      // is the one this page hands to the viewer.
      // Labelled by MODEL rather than by driver: this page is a catalogue of
      // the kit, and the roster's names say nothing about which car is which.
      field.forEach((f, i) => scene.addCar(f.peerIndex, f.colorIndex,
                                           MODEL_NAMES[f.carIndex] || `Car ${i + 1}`,
                                           { cell: false, carIndex: f.carIndex }));

      scene.onFrame = (dt) => {
        if (!driving) return;   // parked: the renderer holds the grid at rest
        engine.update(dt * 1000);
        if (raceOver(engine.getSnapshot())) newSession();   // endless: back to the grid, lap again
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
        lookAtKit(spot, car) {
          if (!spot) return;
          if (car) {
            // A car: the race's own chase rig behind it, trailing as it does
            // flat out, where most of a race is driven, with the lens at that
            // speed — so it is judged from where a player sees it. The field
            // stands every model as its file does, and a car's nose is -z.
            const rig = scene.display.chaseRig(spot.x, spot.y, spot.z, 0, -1, 1);
            const dir = { x: rig.target[0] - rig.eye[0], y: rig.target[1] - rig.eye[1],
                          z: rig.target[2] - rig.eye[2] };
            cam.eye = { x: rig.eye[0], y: rig.eye[1], z: rig.eye[2] };
            cam.yaw = Math.atan2(dir.x, dir.z);
            cam.pitch = Math.asin(dir.y / Math.hypot(dir.x, dir.y, dir.z));
            scene.display.lookFov(rig.fov);
            return;
          }
          // Height counts as much as footprint here: the tall thin models
          // (gantries, palms) are exactly the ones a footprint under-reads.
          const reach = Math.max(spot.w, spot.d, spot.h, 1.0);
          cam.eye = { x: spot.x, y: spot.y + reach * 0.45, z: spot.z - reach * 2.4 };
          cam.yaw = 0;              // +z, straight down the row's near side
          cam.pitch = -0.1;
          scene.display.lookFov(0);
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
          scene.display.lookFov(0);
        }
      };
    }
    return;
  }

  // ---- landmark gallery (/gallery-landmarks.html) ----
  // A catalogue track's SET PIECES, seen through the live renderer from where a
  // player meets them. Shaped like the showroom above: the camera is this
  // scenario's own (never holdFrame), the field is a bare session left UNRUN so
  // the cars stay on the grid unless a view parks them, and window.__landmarks
  // is the surface the gallery chrome drives without a reload.
  //
  // Every pose comes from the engine: where a piece stands is the renderer's set
  // layout (ttp_display_set_layout), the road is the track's own frames, and the
  // driver's eye is the race's chase rig behind the cell's own car, parked on
  // the approach (ttp_display_car_pose) and judged against the renderer's own
  // ground (ttp_display_ground_y). Nothing here re-reads tracks.js' placement.
  // The split is the race's too: each seat owns a cell exactly as in a race,
  // and a cell look (ttp_display_cell_look) swaps its camera and nothing else,
  // so a 4P view of a landmark is what a 4P race draws around it.
  if (scenario === 'landmarks') {
    show('race');
    hideResults();
    // The display's own corner buttons sit under the gallery's landmark list and
    // do nothing for a scene nobody joins.
    document.getElementById('corner-btns')?.style.setProperty('display', 'none');
    ready().then(() => setupLandmarks()).catch((e) => console.warn('[TestHarness] landmark gallery failed to start', e));

    function setupLandmarks() {
      const { scene } = ctx;
      const display = scene.display;
      const VIEWS = ['driver', 'glance', 'high', 'orbit', 'top', 'race', 'free'];
      // The framed views' lens. Wider than the chase rig's, so a piece and the
      // road beside it fit together without standing the camera far off.
      const WIDE_FOV = 50;
      const HIGH_PITCH = 0.6;     // ~34 degrees down onto a piece
      const HIGH_MARGIN = 4;      // how far past the road's far edge High's eye stands
      const ORBIT_PITCH = 0.42;
      const ORBIT_RATE = 0.22;    // rad/s: a slow walk round, not a spin
      // Glance's and High's tightest lens, so a small piece far off the road fills the shot
      // without the view turning into a telescope.
      const GLANCE_MIN_FOV = 12;
      // The approach search (approaches()): a lane is a quarter of the road's
      // width either side of the centreline, and a piece counts as in a cell's
      // lens inside this share of its half-angle, across and up; inside
      // CENTRED of it across, with its top inside TOP_MARGIN of the vertical
      // half-angle, it is in the middle of the picture rather than at an edge
      // (which is where the nearest spot that merely has it in the lens puts
      // it) and a tall piece is not cut off by the top of the frame.
      const LANE = 0.25;
      const LENS_MARGIN = 0.7;
      const CENTRED = 0.4;
      const TOP_MARGIN = 0.9;
      // A car parks only on road near level and upright: the rig's prediction
      // (chaseRig) is for level ground, and a car parked on a loop or a steep
      // ramp shows nothing but deck.
      const UPRIGHT = 0.9;        // the least up.y
      const LEVEL = 0.25;         // the most |tangent.y|
      // A sight line is walked in this many steps, and is hidden where the
      // ground comes within SIGHT_MARGIN of it, or where it runs into the road
      // anywhere on the lap: within KERB_CLEAR over its edge (the kerbs, 0.2
      // tall, the theme's, and a hair; the edge band is KERB_IN inside the
      // deck and KERB_OUT past it) or within DECK_SKIM over the deck between,
      // so a low line along a flat straight sees down it and one over a crest
      // does not. The road is a slab DECK_DEPTH thick under its surface, so a
      // line that passes UNDER a bridge still sees what is beyond it. The
      // chase eye is under a unit over the deck, so these margins are what
      // decides most of what a racer sees.
      const SIGHT_SAMPLES = 40;
      const SIGHT_MARGIN = 0.2;
      const KERB_CLEAR = 0.25;
      const KERB_IN = 0.2;
      const KERB_OUT = 0.5;
      const DECK_SKIM = 0.05;
      const DECK_DEPTH = 0.6;
      // How much of the parked car Glance keeps in the bottom of its shot: its
      // body from this far above the deck up.
      const CAR_SHOW = 0.25;
      // How far off a turned cell's forward its car may sit, in half-lenses.
      const CAR_KEEP = 0.8;
      // The other drivers' approaches to one piece, as [scale, add, other
      // lane] on the base approach's distance back: further back across the
      // road, closer, furthest back.
      const VARIANTS = [[1.6, 8, true], [0.6, 0, false], [2.2, 16, false]];
      // How far apart (along the road) two parked cars in one lane must stand,
      // so neither is parked inside the other or fills the other's view.
      const CAR_GAP = 6;
      // How far (along the road) from the base a variant may park where it
      // cannot see the piece's middle: further back is another stretch of
      // the lap, and another piece's view.
      const VARIANT_REACH = 30;
      // A spot is CLEAN when the piece is no speck (its body, sizeOf, at least
      // this share of the half-lens across) and the sight line to its middle
      // runs under no raised road: an overpass between the eye and the piece
      // hides nothing by the sight test, yet the view is deck and piers.
      const SIZE_MIN = 0.15;
      // A piece whose footprint is larger than this radius (a power line across
      // the map) is framed by the stretch round its anchor, LONG_HALF either
      // way, not by its whole box, which would make it a thread in every view.
      const LONG_R = 30;
      const LONG_HALF = 12;
      // Where no spot with the piece in the rig's own lens is clean (a small
      // piece is a speck from every spot far enough back to have it ahead),
      // a spot where it is no speck may turn its camera onto it instead
      // (fitLook), if the piece's far edge sits within TURN_FIT half-lenses
      // of the rig's forward: the car stays in the shot.
      const TURN_FIT = 1.6;
      // The race cameras' far plane is CAM_FAR (camera.h, 600): the top view
      // stays under it and widens its lens instead of climbing past it.
      const TOP_MAX_H = 480;

      let track = ctx.track;
      let seats = players;
      let mode = 'driver';
      let focusAt = 0;
      let spreadOn = false;
      let layout = display.setLayout();
      // The scenery trees and boulders as [x, z, r, top]: a sight line through
      // a tree's crown is as screened as one through a set piece.
      let scatter = display.scatterLayout();
      let marks = listMarks(layout);
      let engine = null;
      let field = null, bots = null;
      let free = null;            // the free cam's state, once free mode first opens
      let orbitT = 0;
      let lastHud = -Infinity;
      let poses = [];             // what aim() last pushed, per cell (window.__landmarks.poses)
      // Race mode performs its events like every live preview (raceEventPerformer).
      const log = raceLog();
      // Rebuilds are async; chained so a burst of clicks lands in order.
      let queue = Promise.resolve();
      const serial = (fn) => (queue = queue.then(fn, fn));

      // A piece's label off its GLB name: "set-beach-huts" -> "Beach huts".
      function labelOf(model) {
        const s = model.replace(/^set-/, '').replace(/-/g, ' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
      // One entry per MODEL, at its first placement, biggest first so the hero
      // leads; the sort is stable, so equal sizes keep the authored order.
      function listMarks(lay) {
        const by = new Map();
        lay.pieces.forEach((p, i) => {
          const m = by.get(p.model);
          if (m) { m.count++; return; }
          by.set(p.model, { model: p.model, label: labelOf(p.model), count: 1, index: i,
                            size: 4 * p.hx * p.hz * Math.max(p.top - p.y, 0) });
        });
        return [...by.values()].sort((a, b) => b.size - a.size);
      }

      // The parked field: `seats` autopiloted player seats in their own cells,
      // the CPU fill cell-less, on a fresh session nobody steps (race mode does).
      function newSession() {
        engine = bareSession(field, track,
                             mode === 'race' ? { bots, onRaceEvent: raceEventPerformer(scene, log) } : { bots });
        window.__engine = engine;
        scene.bindSession(engine.h);
        scene.hold(mode !== 'race');
        // The cells' place/lap readout off the grid, rather than empty pills.
        for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      }
      async function seat() {
        // Unbound across the rebuild: the old session is freed before the new
        // scene lands, and a frame must not draw a handle that is gone.
        scene.bindSession(0);
        if (engine) { engine.dispose(); engine = null; }
        ({ field, bots } = benchField(track.trackId, seats, 1));
        for (const id of [...scene.cars.keys()]) scene.removeCar(id);
        field.forEach((f) => scene.addCar(f.peerIndex, f.colorIndex, f.name,
                                          { carIndex: f.carIndex, cell: !f.ai }));
        await scene.setTrack(track);
        newSession();
        layout = display.setLayout();
        await loadShapes(layout);
        scatter = display.scatterLayout();
        marks = listMarks(layout);
        focusAt = Math.min(focusAt, Math.max(marks.length - 1, 0));
      }

      const v3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
      const frameAt = (s) => display.trackFrames(track.trackId, [s])[0];
      // The layout index cell k frames: the focused piece, or with SPREAD the
      // k-th after it.
      function indexFor(k) {
        if (!marks.length) return -1;
        return marks[(focusAt + (spreadOn ? k : 0)) % marks.length].index;
      }
      // What cell k frames: the piece, or for a LONG one the stretch of it
      // round its anchor (`of` is the piece itself, for the sight lines).
      let viewed = new Map(), viewedFor = null;
      function pieceFor(k) {
        const p = layout.pieces[indexFor(k)];
        return p ? viewOf(p) : null;
      }
      function viewOf(p) {
        if (Math.hypot(p.hx, p.hz) <= LONG_R) return p;
        if (viewedFor !== layout) { viewed = new Map(); viewedFor = layout; }
        if (!viewed.has(p)) {
          viewed.set(p, { ...p, of: p, cx: p.x, cz: p.z,
                          hx: Math.min(p.hx, LONG_HALF), hz: Math.min(p.hz, LONG_HALF) });
        }
        return viewed.get(p);
      }
      const heightOf = (p) => Math.max(p.top - p.y, 0.5);
      const centreOf = (p, at) => ({ x: p.cx, y: p.y + heightOf(p) * at, z: p.cz });
      const radiusOf = (p) => Math.max(Math.hypot(p.hx, p.hz), heightOf(p) / 2, 1);
      // How big the piece reads: its largest mesh, not its footprint, which
      // takes in the snowman and lamp beside an igloo; at least half the
      // footprint, for a piece of many small parts (a flower bed).
      const sizeOf = (p) => Math.max(radiusOf(p) / 2,
                                     ...(p.parts || []).map(([, , hx, hz, top]) => Math.max(Math.hypot(hx, hz), (top - p.y) / 2)));
      // How far back a framed view stands: a bounding radius inside the lens'
      // half-angle, with a margin.
      const reachOf = (r) => r / Math.sin((WIDE_FOV / 2) * Math.PI / 180) * 1.15;

      // The road, sampled every couple of units, once per track: what a sight
      // line can graze, run into, or pass under. Each sample stands for the
      // stretch `reach` either side of it along its tangent (in plan, t), out
      // to `half` (the deck's own half-width `w` and the kerbs past it) along
      // its lateral (l, whose rise is the deck's bank).
      let road = null, roadFor = null;
      function roadPoints() {
        if (roadFor !== layout) {
          const n = Math.max(32, Math.ceil(layout.length / 2));
          const reach = layout.length / n / 2 + 0.05;
          road = display.trackFrames(track.trackId,
                                     Array.from({ length: n }, (_, i) => (layout.length * i) / n))
            .map((f) => {
              const t = Math.hypot(f.tangent.x, f.tangent.z) || 1;
              const l = Math.hypot(f.lateral.x, f.lateral.z) || 1;
              const w = (f.width || 0) / 2;
              return { x: f.pos.x, y: f.pos.y, z: f.pos.z, w, half: w + KERB_OUT, reach,
                       tx: f.tangent.x / t, tz: f.tangent.z / t,
                       lx: f.lateral.x / l, lz: f.lateral.z / l, ly: f.lateral.y / l };
            });
          roadFor = layout;
        }
        return road;
      }
      // Whether the point (x, y, z) is in road sample f's stretch of road:
      // under its surface (to DECK_DEPTH) or just over it (DECK_SKIM over the
      // deck, KERB_CLEAR over its edge).
      function inRoad(f, x, y, z) {
        const dx = x - f.x, dz = z - f.z;
        if (Math.abs(dx * f.tx + dz * f.tz) > f.reach) return false;
        const l = dx * f.lx + dz * f.lz;
        const side = Math.abs(l);
        if (side >= f.half) return false;
        const deck = f.y + f.ly * l;
        return y >= deck - DECK_DEPTH && y <= deck + (side < f.w - KERB_IN ? DECK_SKIM : KERB_CLEAR);
      }
      // Where the plan of the line from `eye` to `c` crosses piece q's
      // footprint, as [t0, t1] along it (t0 > t1 when it misses).
      function crossing(q, eye, c) {
        const loc = (x, z) => [(x - q.cx) * q.ax + (z - q.cz) * q.az,
                               (z - q.cz) * q.ax - (x - q.cx) * q.az];
        const [u0, v0] = loc(eye.x, eye.z);
        const [u1, v1] = loc(c.x, c.z);
        let t0 = 0, t1 = 1;
        for (const [o, d, h] of [[u0, u1 - u0, q.hx], [v0, v1 - v0, q.hz]]) {
          if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) t0 = 2; continue; }
          const ta = (-h - o) / d, tb = (h - o) / d;
          t0 = Math.max(t0, Math.min(ta, tb));
          t1 = Math.min(t1, Math.max(ta, tb));
        }
        return [t0, t1];
      }
      // What a sight line runs into on a set piece: each model's shape as a
      // height map on its own axes, SHAPE_CELL square, holding the lowest and
      // highest point of its surface over each cell (off the GLB's own
      // triangles). A line is in the piece where it passes a cell between the
      // two: through a mound or a wall, never under a roof or a wire, nor
      // across the open ground inside a footprint. Per model, for the page's
      // life.
      const SHAPE_CELL = 0.5;
      const shapes = new Map();
      async function loadShapes(lay) {
        const want = [...new Set(lay.pieces.map((p) => p.model))].filter((m) => !shapes.has(m));
        await Promise.all(want.map(async (m) => {
          const res = await fetch(assetUrl(`/assets/toycar/${m}.glb`));
          if (!res.ok) throw new Error(`no ${m}.glb (${res.status})`);
          shapes.set(m, shapeOf(glbTriangles(new Uint8Array(await res.arrayBuffer()))));
        }));
      }
      function shapeOf(tris) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const t of tris) for (const [x, , z] of t) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
        const nx = Math.max(1, Math.ceil((x1 - x0) / SHAPE_CELL)), nz = Math.max(1, Math.ceil((z1 - z0) / SHAPE_CELL));
        const lo = new Float32Array(nx * nz).fill(Infinity), hi = new Float32Array(nx * nz).fill(-Infinity);
        // Each triangle sampled at half a cell, so every cell it covers is hit.
        for (const [a, b, c] of tris) {
          const edge = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
                                Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
                                Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]));
          const m = Math.max(1, Math.ceil(edge / (SHAPE_CELL / 2)));
          for (let i = 0; i <= m; i++) {
            for (let j = 0; i + j <= m; j++) {
              const u = i / m, v = j / m, w = 1 - u - v;
              const x = a[0] * w + b[0] * u + c[0] * v, y = a[1] * w + b[1] * u + c[1] * v;
              const z = a[2] * w + b[2] * u + c[2] * v;
              const k = Math.min(nz - 1, Math.floor((z - z0) / SHAPE_CELL)) * nx + Math.min(nx - 1, Math.floor((x - x0) / SHAPE_CELL));
              lo[k] = Math.min(lo[k], y);
              hi[k] = Math.max(hi[k], y);
            }
          }
        }
        return { x0, z0, nx, nz, w: x1 - x0, d: z1 - z0, lo, hi };
      }
      // Whether world point (x, y, z) is inside piece q's shape: the point on
      // the piece's own axes (ax, az from its anchor, y from its foot), at the
      // scale its footprint says it was placed at.
      function inShape(q, x, y, z) {
        const sh = shapes.get(q.model);
        if (!sh) return false;
        const sc = sh.w >= sh.d ? (2 * q.hx) / sh.w : (2 * q.hz) / sh.d;
        const dx = x - q.x, dz = z - q.z;
        const i = Math.floor(((dx * q.ax + dz * q.az) / sc - sh.x0) / SHAPE_CELL);
        const k = Math.floor(((dz * q.ax - dx * q.az) / sc - sh.z0) / SHAPE_CELL);
        if (i < 0 || k < 0 || i >= sh.nx || k >= sh.nz) return false;
        const ly = (y - q.y) / sc;
        return ly >= sh.lo[k * sh.nx + i] && ly <= sh.hi[k * sh.nx + i];
      }
      // How much of the sight line from `eye` to the point `c` on piece p is
      // hidden: the count of its samples that are under the GROUND (the
      // renderer's own height, hills and slopes included; the margin stops at
      // p's own footprint, or a low piece's middle reads as buried in the lawn
      // it stands on), in the road (inRoad), in a tree or boulder (a column
      // its plan radius wide up to its top) or in another piece (inShape).
      // 0 is a clear view. Round p the ground is level and bare, as the
      // renderer leaves it under every piece it stands (buildSetPieces: the
      // relief flattened out to FLAT_PAD past the footprint's corners, the
      // scatter kept FLAT_PAD off it), which holds for a row the placement
      // search moved without a build as well.
      const FLAT_PAD = 1;
      // Where the pieces stand for the sight lines: the layout, or while the
      // placement search runs, its moves too.
      let standing = null;
      function hidden(eye, c, p) {
        let n = 0;
        const x0 = Math.min(eye.x, c.x), x1 = Math.max(eye.x, c.x);
        const z0 = Math.min(eye.z, c.z), z1 = Math.max(eye.z, c.z);
        const near = roadPoints().filter((f) => f.x > x0 - f.half && f.x < x1 + f.half
                                              && f.z > z0 - f.half && f.z < z1 + f.half);
        const inFoot = (x, z) => {
          const dx = x - p.cx, dz = z - p.cz;
          return Math.abs(dx * p.ax + dz * p.az) < p.hx + FLAT_PAD && Math.abs(dz * p.ax - dx * p.az) < p.hz + FLAT_PAD;
        };
        const trees = scatter.filter(([x, z, r]) => x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r && !inFoot(x, z));
        const flatR = Math.hypot(p.hx, p.hz) + FLAT_PAD;
        const ground = (x, z) => ((x - p.cx) ** 2 + (z - p.cz) ** 2 < flatR * flatR
          ? Math.min(display.groundY(x, z), p.y) : display.groundY(x, z));
        const [into] = crossing(p, eye, c);
        // The other pieces whose footprint the line crosses, and where.
        const across = [];
        for (const q of standing || layout.pieces) {
          if (q === p || q === p.of) continue;
          const [t0, t1] = crossing(q, eye, c);
          if (t0 <= t1) across.push({ q, t0, t1 });
        }
        for (let i = 1; i < SIGHT_SAMPLES; i++) {
          const t = i / SIGHT_SAMPLES;
          const x = eye.x + (c.x - eye.x) * t, y = eye.y + (c.y - eye.y) * t;
          const z = eye.z + (c.z - eye.z) * t;
          if (ground(x, z) + (t < into ? SIGHT_MARGIN : 0) > y) { n++; continue; }
          if (near.some((f) => inRoad(f, x, y, z))) { n++; continue; }
          if (trees.some(([tx, tz, r, top]) => y < top && (x - tx) ** 2 + (z - tz) ** 2 < r * r)) { n++; continue; }
          if (across.some((a) => t >= a.t0 && t <= a.t1 && inShape(a.q, x, y, z))) n++;
        }
        return n;
      }
      // Whether the sight line from `eye` to `c` passes under raised road
      // anywhere: below the slab of a stretch of the lap above it.
      function underDeck(eye, c) {
        const x0 = Math.min(eye.x, c.x), x1 = Math.max(eye.x, c.x);
        const z0 = Math.min(eye.z, c.z), z1 = Math.max(eye.z, c.z);
        const near = roadPoints().filter((f) => f.x > x0 - f.half && f.x < x1 + f.half
                                              && f.z > z0 - f.half && f.z < z1 + f.half);
        for (let i = 0; i < SIGHT_SAMPLES; i++) {
          const t = i / SIGHT_SAMPLES;
          const x = eye.x + (c.x - eye.x) * t, y = eye.y + (c.y - eye.y) * t;
          const z = eye.z + (c.z - eye.z) * t;
          for (const f of near) {
            if (y < f.y - DECK_DEPTH && (x - f.x) ** 2 + (z - f.z) ** 2 < f.half * f.half) return true;
          }
        }
        return false;
      }

      // Where on piece p a sight line is aimed: its middle first (the one that
      // must be clear), then its foot, its top, and both ends of its long side,
      // so a piece screened all but its tip scores below one in full view.
      function sightPoints(p) {
        const h = heightOf(p);
        const long = p.hx >= p.hz ? { x: p.ax * p.hx, z: p.az * p.hx } : { x: -p.az * p.hz, z: p.ax * p.hz };
        const end = (k) => ({ x: p.cx + long.x * k, y: p.y + h * 0.4, z: p.cz + long.z * k });
        return [centreOf(p, 0.5), centreOf(p, 0.15), centreOf(p, 0.9), end(0.7), end(-0.7)];
      }

      // How a chase rig (chaseRig's answer) in a cell of this aspect sees the
      // point `centre`: its eye, the half-lens across and up, how far off the
      // rig's forward the point is across (`off`) and up (`rise`, for any
      // point), its distance in plan (`far`, at least 1), and whether it is in
      // the lens with margin (LENS_MARGIN) both ways.
      function lensOf(rig, aspect, centre) {
        const eye = v3(rig.eye);
        const half = Math.atan(Math.tan((rig.fov / 2) * Math.PI / 180) * aspect);
        const vhalf = (rig.fov / 2) * Math.PI / 180;
        const fwd = Math.atan2(rig.target[0] - eye.x, rig.target[2] - eye.z);
        const to = Math.atan2(centre.x - eye.x, centre.z - eye.z);
        const off = Math.atan2(Math.sin(to - fwd), Math.cos(to - fwd));
        const flat = (x, z) => Math.hypot(x - eye.x, z - eye.z);
        const pitch = Math.atan2(rig.target[1] - eye.y, flat(rig.target[0], rig.target[2]));
        const rise = (c) => Math.atan2(c.y - eye.y, flat(c.x, c.z)) - pitch;
        const lens = Math.abs(off) < half * LENS_MARGIN && Math.abs(rise(centre)) < vhalf * LENS_MARGIN;
        return { eye, half, vhalf, off, rise, far: Math.max(flat(centre.x, centre.z), 1), lens };
      }

      // Every place a car could park on the road short of piece p, `b` units
      // back in either lane on level, upright road, with where its chase rig
      // will stand (the race's rig, parked: what the posed car's own cell
      // shows) and how well that rig sees the piece. `at` is the car's spot on
      // the deck; `lens` says the piece's middle is inside the cell's lens
      // with margin, across and up; `fit` is how far off the rig's forward
      // its far edge sits, as a share of the half-lens across or up (the
      // car is near the forward, so a camera turned from a low fit keeps both
      // in shot); `size` is the piece's body (sizeOf) as a share of the half-lens.
      // In the lens, or close enough to turn onto it (`turn`), `hidden` is how
      // hidden the piece's middle is (0 clear), `vis` how many of its sight
      // points are clear and `roof` whether the line to its middle runs under
      // raised road. Cached per piece and cell aspect: the ground walk is the
      // costly part and a view switch re-aims.
      let spots = new Map(), spotsFor = null;
      function approaches(p, aspect) {
        if (spotsFor !== layout) { spots = new Map(); spotsFor = layout; }
        const key = `${layout.pieces.indexOf(p.of || p)}:${aspect.toFixed(3)}`;
        if (spots.has(key)) return spots.get(key);
        const backs = [];
        for (let b = 6; b <= layout.length * 0.45; b += 2) backs.push(b);
        const frames = display.trackFrames(track.trackId, backs.map((b) => p.s - b));
        const aims = sightPoints(p);
        const centre = aims[0];
        const radius = radiusOf(p);
        const body = sizeOf(p);
        const out = [];
        frames.forEach((f, i) => {
          if (f.up.y < UPRIGHT || Math.abs(f.tangent.y) > LEVEL) return;
          const lane = (f.width || 0) * LANE;
          for (const lat of [-lane, lane]) {
            const at = { x: f.pos.x + f.lateral.x * lat, y: f.pos.y + f.lateral.y * lat,
                         z: f.pos.z + f.lateral.z * lat };
            const rig = display.chaseRig(at.x, at.y, at.z, f.tangent.x, f.tangent.z, 0);
            const { eye, half, vhalf, off, rise, far, lens } = lensOf(rig, aspect, centre);
            const r = Math.atan(1.2 * radius / far);
            const spot = { b: backs[i], s: p.s - backs[i], lat, at, rig, eye, lens,
                           fit: Math.max((Math.abs(off) + r) / half, (Math.abs(rise(centre)) + r) / vhalf),
                           centred: lens && Math.abs(off) < half * CENTRED && rise(aims[2]) < vhalf * TOP_MARGIN,
                           size: Math.atan(body / far) / half,
                           hidden: Infinity, vis: 0, roof: false };
            if (!lens && spot.fit <= TURN_FIT && spot.size >= SIZE_MIN) spot.turn = true;
            if (lens || spot.turn) {
              const each = aims.map((c) => hidden(eye, c, p));
              spot.hidden = each[0];
              spot.vis = each.filter((n) => n === 0).length;
              spot.roof = underDeck(eye, centre);
            }
            out.push(spot);
          }
        });
        spots.set(key, out);
        return out;
      }
      // Spot a for a cell that has to turn its camera onto the piece (fitLook):
      // a spot whose rig does not have it in the lens, with how well its eye
      // sees the piece, which approaches() only works out inside the lens.
      function turned(a, p) {
        if (a.lens) return a;
        const aims = sightPoints(p);
        const each = aims.map((c) => hidden(a.eye, c, p));
        return { ...a, turn: true, hidden: each[0], vis: each.filter((n) => n === 0).length,
                 roof: underDeck(a.eye, aims[0]) };
      }
      // The approach a cell parks its car at. Variant 0 is the base: among
      // the spots that see the piece's middle (CLEAN ones first, then those
      // with it mid-picture, CENTRED), the NEAREST of the ones that see the
      // most of it; where none in the lens is clean, a clean spot that turns
      // onto it (TURN_FIT), then one where it is no speck under a deck, then
      // any that sees it, turned or not; if every spot is screened, the least
      // hidden in the lens. With several cells on one piece the others are
      // other drivers' views of it: 1 further back in the other lane, 2
      // closer, 3 furthest back (behind 1 where it can), each at the spot
      // nearest its distance among those that see the middle and nearly as
      // much as the base, else the middle (clean, then turned and clean, then
      // any); failing that, the least hidden in the lens within VARIANT_REACH
      // of the base. Never
      // onto or right behind a car another variant parked: a full car gap,
      // else half.
      // A bend can swing a piece out of every stretch short of it: then the
      // spots that come nearest are used with `turn` set (the cell turns its
      // camera onto the piece and the car), each at a distance of its own and
      // within VARIANT_REACH of the first where they can.
      // Null when there is no room left to park.
      function approachFor(p, aspect, variant) {
        const all = approaches(p, aspect);
        const taken = [];
        const parked = (a, gap) => taken.some((t) => Math.sign(t.lat) === Math.sign(a.lat)
                                                   && Math.abs(t.b - a.b) < gap);
        const first = (list) => list.find((a) => !parked(a, CAR_GAP))
                             || list.find((a) => !parked(a, CAR_GAP / 2)) || null;
        const nearest = [...all].sort((a, b) => a.fit - b.fit);
        const apart = (a) => !taken.some((t) => Math.abs(t.b - a.b) < CAR_GAP);
        const turnTo = () => nearest.find((a) => apart(a) && (!taken.length || Math.abs(a.b - taken[0].b) <= VARIANT_REACH))
                          || nearest.find(apart) || first(nearest);
        const inLens = all.filter((a) => a.lens);
        const clean = (a) => !a.roof && a.size >= SIZE_MIN;
        const turnClean = all.filter((a) => a.turn && a.hidden === 0 && clean(a));
        if (!inLens.length && !turnClean.length) {
          let pick = null;
          for (let k = 0; k <= variant; k++) {
            pick = turnTo();
            if (!pick) return null;
            taken.push(pick);
          }
          return turned(pick, p);
        }
        const score = (a) => a.hidden - a.vis;
        const seen = inLens.filter((a) => a.hidden === 0);
        const seenClean = seen.filter(clean);
        const seenBig = seen.filter((a) => a.size >= SIZE_MIN);
        const turnSeen = all.filter((a) => a.turn && a.hidden === 0);
        const pool = [seenClean, turnClean, seenBig, seen, turnSeen].find((l) => l.length) || seen;
        const centred = pool.filter((a) => a.centred);
        const tier = centred.length ? centred : pool;
        const most = Math.max(0, ...tier.map((a) => a.vis));
        const base = tier.find((a) => a.vis === most)
          || inLens.reduce((m, x) => (score(x) < score(m) ? x : m));
        if (!variant) return base;
        taken.push(base);
        const good = pool.filter((a) => a.vis >= base.vis - 1);
        const near = inLens.filter((a) => Math.abs(a.b - base.b) <= VARIANT_REACH);
        let pick = null;
        for (let k = 1; k <= variant; k++) {
          const [scale, add, otherLane] = VARIANTS[(k - 1) % VARIANTS.length];
          const want = base.b * scale + add;
          const side = Math.sign(base.lat) * (otherLane ? -1 : 1);
          const byWant = (list) => [...list].sort((a, b) => Math.abs(a.b - want) - Math.abs(b.b - want));
          const behind = k === 3 ? (a) => a.b > taken[1].b : () => true;
          pick = null;
          const lists = [good.filter((a) => Math.sign(a.lat) === side), good, pool, turnClean, seen, turnSeen];
          for (const list of lists) {
            pick = first(byWant(list.filter(behind))) || first(byWant(list));
            if (pick) break;
          }
          pick = pick || first(byWant(near).sort((a, b) => score(a) - score(b))) || turnTo();
          if (!pick) return null;
          taken.push(pick);
        }
        return turned(pick, p);
      }
      // LAP VISIBILITY (window.__landmarks.score): how long a racer sees each
      // piece, which is what a piece's place on the lap is for. One
      // autopiloted player drives a fresh session nobody draws; over its
      // second lap (the first starts from the grid), every LAP_SAMPLE seconds
      // its chase rig (chaseRig, at the car's pose and speed) looks for every
      // piece. A piece reads CLEAN when its middle (or, for one too tall for
      // that, its foot) is in the lens, the sight line to it is clear
      // (hidden) and runs under no raised road, the driver view's own tests,
      // and its body is at least LAP_SIZE of the half-lens: half the parked
      // bar (SIZE_MIN), which frames a piece as the subject where a racer
      // only needs it in the picture. It scores the seconds it reads clean in
      // runs of at least LAP_RUN (a glimpse is not a look) and its longest
      // run; for the seconds it was in the lens but not clean, the first thing
      // wrong (too small, hidden, under a deck), so a poor score says why; how
      // big it read at best in clear sight (`peak`, a share of the half-lens);
      // and the racer's best moment (`at`: the car's s and lane in the middle
      // of the longest run, else where it read biggest in clear sight, else
      // null) to photograph.
      const LAP_SAMPLE = 0.1;
      const LAP_SIZE = SIZE_MIN / 2;
      const LAP_RUN = 1;
      const LAP_STEP_MS = 1000 / 60;
      const LAP_MAX_S = 600;       // a car that never finishes two laps is a stuck sim
      // How far ahead along the lap the racer reads the road (the placement
      // search keeps it in sight), and how far over the deck that is read.
      const AHEAD = [12, 20];
      const ROAD_SIGHT = 0.3;
      // The lap a racer drives, recorded once per scene: per sample the car's
      // spot on the road and its chase rig. Set pieces stand off the road, so
      // where one stands never changes the lap.
      let lapRec = null, lapFor = null;
      function lapPath() {
        if (lapFor === layout) return lapRec;
        const { field: f, bots: b } = benchField(track.trackId, 1, 1);
        const run = bareSession(f, track, { bots: b });
        const me = f.find((x) => !x.ai).peerIndex;
        const len = layout.length;
        const path = [];
        const every = Math.round((LAP_SAMPLE * 1000) / LAP_STEP_MS);
        try {
          for (let k = 1; ; k++) {
            run.update(LAP_STEP_MS);
            if (k % every) continue;
            if (k * LAP_STEP_MS > LAP_MAX_S * 1000) throw new Error(`no two laps of '${track.id}' in ${LAP_MAX_S}s`);
            const c = run.getSnapshot().cars.find((x) => x.id === me);
            if (c.totalS < len) continue;
            if (c.totalS >= 2 * len || c.finished) break;
            const { pos, forward } = c.pose;
            path.push({ s: c.totalS - len, lat: c.lat, rig: display.chaseRig(pos.x, pos.y, pos.z, forward.x, forward.z, c.spd) });
          }
        } finally {
          run.dispose();
        }
        // The road the racer is steering for, AHEAD along the lap from each
        // sample: the deck a little over its surface.
        const ahead = display.trackFrames(track.trackId, path.flatMap((q) => AHEAD.map((d) => q.s + d)));
        path.forEach((q, k) => {
          q.ahead = AHEAD.map((_, j) => {
            const f = ahead[k * AHEAD.length + j];
            return { x: f.pos.x, y: f.pos.y + ROAD_SIGHT, z: f.pos.z };
          });
        });
        lapRec = path;
        lapFor = layout;
        return path;
      }
      const secs = (k) => Math.round(k * LAP_SAMPLE * 10) / 10;
      // How piece row v reads over the recorded lap: lapScore's row for it.
      // A long piece is read whole, not the stretch round its anchor a parked
      // view frames: what is in the picture is the mountain, not where it
      // meets the road.
      function readOver(path, v, aspect) {
        const aims = [centreOf(v, 0.5), centreOf(v, 0.15)];
        const body = sizeOf(v);
        const clean = [];
        let lens = 0, peak = 0, peakAt = -1;
        const bad = { small: 0, hidden: 0, roof: 0 };
        path.forEach(({ rig }, k) => {
          const seen = aims.map((c) => ({ c, ...lensOf(rig, aspect, c) })).find((a) => a.lens);
          if (!seen) { clean.push(false); return; }
          const { c: centre, eye, half, far } = seen;
          lens++;
          let why = null;
          const size = Math.atan(body / far) / half;
          if (hidden(eye, centre, v)) why = 'hidden';
          else if (underDeck(eye, centre)) why = 'roof';
          else if (size > peak) { peak = size; peakAt = k; }
          if (!why && size < LAP_SIZE) why = 'small';
          if (why) bad[why]++;
          clean.push(!why);
        });
        // The clean runs round the lap, from a sample that is not clean so a
        // run across the line counts once.
        const n = path.length;
        const from = clean.indexOf(false);
        let total = 0, longest = 0, mid = peakAt;
        if (from < 0) { total = longest = n; } else {
          for (let k = 0, run = 0; k <= n; k++) {
            const j = (from + k) % n;
            if (k < n && clean[j]) { run++; continue; }
            if (run * LAP_SAMPLE >= LAP_RUN) total += run;
            if (run > longest) { longest = run; mid = (j - Math.ceil(run / 2) + n) % n; }
            run = 0;
          }
        }
        const at = mid >= 0 ? { s: Math.round(path[mid].s * 10) / 10, lat: Math.round(path[mid].lat * 100) / 100 } : null;
        return { seen: secs(total), longest: secs(longest), at, eye: mid >= 0 ? path[mid].rig.eye : null, lens: secs(lens), small: secs(bad.small),
                 hidden: secs(bad.hidden), roof: secs(bad.roof), peak: Math.round(peak * 100) / 100 };
      }
      // The yaw (tracks.js degrees) that turns row p's front (+X) straight at
      // the eye: a piece with a face (penguins) authored facing +X looks at
      // the racer where the lap reads it best.
      function faceYaw(p, eye) {
        const f = frameAt(p.s);
        const at = Math.atan2(-(eye[2] - p.cz), eye[0] - p.cx);      // +X's sense: (cos h, -sin h)
        const road = Math.atan2(f.tangent.x, f.tangent.z);
        return Math.round((((at - road) * 180 / Math.PI) % 360 + 360) % 360);
      }
      function lapScore(aspect) {
        const path = lapPath();
        return {
          track: track.id, aspect, lap: secs(path.length), length: layout.length,
          pieces: layout.pieces.map((p, i) => {
            const { eye, ...read } = readOver(path, p, aspect);
            return { index: i, model: p.model, label: labelOf(p.model), s: p.s, lat: p.lat, yaw: p.yaw,
                     face: eye && faceYaw(p, eye), spot: clashOf(p, i), ...read };
          })
        };
      }

      // PLACEMENT SEARCH (window.__landmarks.better): for every piece a racer
      // reads for under PLACE_GOOD seconds, a spot on its own side of the road
      // where it reads better, scored over the recorded lap like lapScore. A
      // candidate is the piece's own row moved rigidly (its authored yaw to
      // the road, its lift and scale kept) to a point every PLACE_DU of the lap
      // within its reach (HERO_REACH for the track's biggest model, the hero,
      // which the lap is shaped round; the whole lap for the rest), at each of
      // PLACE_GAPS past the kerb, where it stands now, or PLACE_KEEP of that,
      // never nearer than PLACE_KEEP of it: a piece set back on the tide line
      // or up a slope keeps most of its distance. It is kept only where the
      // renderer lets every cell of its shape stand (spotIssue), where it
      // never comes between the racer and the road AHEAD (blocksRoad), clear
      // of the spots already chosen, and PLACE_SPREAD of the lap from every
      // other placement of the same model, so companions stay spread round
      // the lap.
      // A piece moves only for PLACE_GAIN more clean seconds, and never to a
      // spot that costs another piece over PLACE_HARM of its own (it stands in
      // that one's sight line); among spots within PLACE_TIE of the best, the
      // biggest read wins, then the nearest. PLACE_TRIES spots are tried (every one for a piece
      // that must move, below). A piece that stands in
      // the sea or on the shore now (a ship, a jetty) is placed by its
      // coastline and never moves. One that CLASHES where it stands (the
      // road, a deck, another piece or a berm where its shape stands) moves however well it
      // reads, to the best legal spot, CLASH_GAPS further out included and
      // across the road too (its yaw mirrored, so the side it showed the road
      // still faces it). Worst read first. The scene is not
      // rebuilt: terrain flattens under a piece and scatter clears round it
      // only once one is, so a chosen spot is checked by building it.
      const PLACE_GOOD = 2;
      const PLACE_DU = 0.01;
      const HERO_REACH = 0.05;
      const PLACE_GAPS = [1.5, 3, 5, 8, 12];
      const CLASH_GAPS = [16, 20, 25, 30];          // further out for a piece that must move
      const PLACE_KEEP = 0.5;
      const PLACE_SPREAD = 0.08;
      const PLACE_GAIN = 1;
      const PLACE_TIE = 0.3;
      const PLACE_HARM = 0.5;
      const PLACE_TRIES = 6;
      // Row p stood at arclength s, `lat` off the centreline, turned `yaw`
      // degrees to the road.
      function movedRow(p, s, lat, yaw = p.yaw) {
        const f = frameAt(s);
        const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
        const h = Math.atan2(f.tangent.x, f.tangent.z) + (yaw * Math.PI) / 180;
        const ax = Math.cos(h), az = -Math.sin(h);
        // The footprint's centre off the anchor, on the piece's own axes.
        const dx = p.cx - p.x, dz = p.cz - p.z;
        const u = dx * p.ax + dz * p.az, v = -dx * p.az + dz * p.ax;
        return { ...p, of: p, s, u: s / layout.length, lat, yaw, x, z, heading: h, ax, az,
                 cx: x + u * ax - v * az, cz: z + u * az + v * ax };
      }
      // What keeps row q (layout row `skip`) from standing where it is: the
      // first issue spotIssue finds under a cell of its shape, or ''.
      function spotOf(q, skip) {
        const sh = shapes.get(q.model);
        if (!sh) return 'no shape';
        const sc = sh.w >= sh.d ? (2 * q.hx) / sh.w : (2 * q.hz) / sh.d;
        for (let k = 0; k < sh.nz; k++) {
          for (let i = 0; i < sh.nx; i++) {
            const c = k * sh.nx + i;
            if (!(sh.hi[c] > -Infinity)) continue;
            const lx = (sh.x0 + (i + 0.5) * SHAPE_CELL) * sc, lz = (sh.z0 + (k + 0.5) * SHAPE_CELL) * sc;
            const issue = display.spotIssue(q.x + lx * q.ax - lz * q.az, q.z + lx * q.az + lz * q.ax,
                                            q.y + sh.lo[c] * sc, q.y + sh.hi[c] * sc, skip);
            if (issue) return issue;
          }
        }
        return '';
      }
      // Whether a road deck passes over row q: a cell of its shape inside a
      // road sample's stretch, the deck over the piece's foot. spotIssue lets
      // a piece stand under a deck raised high enough, and one parked under
      // its own overpass reads as hidden to a reviewer.
      function bridged(q) {
        const sh = shapes.get(q.model);
        if (!sh) return false;
        const r = Math.hypot(q.hx, q.hz);
        const near = roadPoints().filter((f) => f.y > q.y + 1
          && Math.hypot(f.x - q.cx, f.z - q.cz) < r + f.half + f.reach);
        if (!near.length) return false;
        const sc = sh.w >= sh.d ? (2 * q.hx) / sh.w : (2 * q.hz) / sh.d;
        for (let k = 0; k < sh.nz; k++) {
          for (let i = 0; i < sh.nx; i++) {
            if (!(sh.hi[k * sh.nx + i] > -Infinity)) continue;
            const lx = (sh.x0 + (i + 0.5) * SHAPE_CELL) * sc, lz = (sh.z0 + (k + 0.5) * SHAPE_CELL) * sc;
            const x = q.x + lx * q.ax - lz * q.az, z = q.z + lx * q.az + lz * q.ax;
            for (const f of near) {
              const dx = x - f.x, dz = z - f.z;
              if (Math.abs(dx * f.tx + dz * f.tz) <= f.reach && Math.abs(dx * f.lx + dz * f.lz) < f.half) return true;
            }
          }
        }
        return false;
      }
      // What is wrong with row q (layout row `skip`) standing where it is:
      // spotOf's issue, 'deck' when a road passes over it, or ''.
      const clashOf = (q, skip) => spotOf(q, skip) || (bridged(q) ? 'deck' : '');
      // Whether row q stands between the racer and the road AHEAD anywhere
      // on the recorded lap: a sight line from a chase eye to a point ahead
      // runs into its shape.
      function blocksRoad(path, q) {
        const r = Math.hypot(q.hx, q.hz);
        for (const { rig, ahead } of path) {
          for (const a of ahead) {
            const e = rig.eye;
            // Most lines pass nowhere near: their box misses the piece's circle.
            if (Math.max(e[0], a.x) < q.cx - r || Math.min(e[0], a.x) > q.cx + r
                || Math.max(e[2], a.z) < q.cz - r || Math.min(e[2], a.z) > q.cz + r) continue;
            for (let i = 1; i < SIGHT_SAMPLES; i++) {
              const t = i / SIGHT_SAMPLES;
              if (inShape(q, e[0] + (a.x - e[0]) * t, e[1] + (a.y - e[1]) * t, e[2] + (a.z - e[2]) * t)) return true;
            }
          }
        }
        return false;
      }
      // Whether two rows' footprints overlap (separating axes of two boxes).
      function overlap(a, b) {
        const axes = [[a.ax, a.az], [-a.az, a.ax], [b.ax, b.az], [-b.az, b.ax]];
        const reach = (q, [x, z]) => q.hx * Math.abs(q.ax * x + q.az * z) + q.hz * Math.abs(-q.az * x + q.ax * z);
        return axes.every(([x, z]) => Math.abs((a.cx - b.cx) * x + (a.cz - b.cz) * z) < reach(a, [x, z]) + reach(b, [x, z]) + 0.5);
      }
      function better(aspect) {
        const path = lapPath();
        const len = layout.length;
        const hero = marks.length ? marks[0].model : null;
        const where = layout.pieces.slice();             // where each stands once chosen
        let reads = where.map((p) => readOver(path, p, aspect));
        const now = reads.slice();
        const clash = where.map((p, i) => clashOf(p, i));
        const fixed = new Set(clash.map((c, i) => (c === 'sea' ? i : -1)));
        const must = clash.map((c) => c !== '' && c !== 'sea');
        const chosen = [];
        const gap = (a, b) => { const d = Math.abs(a - b) % len; return Math.min(d, len - d); };
        const out = [];
        const order = where.map((_, i) => i).sort((a, b) => now[a].seen - now[b].seen || now[a].peak - now[b].peak);
        standing = where;
        try {
          for (const i of order) {
            const p = layout.pieces[i], read = now[i];
            if ((read.seen >= PLACE_GOOD && !must[i]) || fixed.has(i)) continue;
            const side = Math.sign(p.lat) || 1;
            const reach = p.model === hero ? HERO_REACH * len : len / 2;
            const kin = where.filter((q, k) => k !== i && q.model === p.model);
            const tried = [];
            for (let du = -reach; du <= reach; du += PLACE_DU * len) {
              const s = (((p.s + du) % len) + len) % len;
              if (kin.some((q) => gap(q.s, s) < PLACE_SPREAD * len)) continue;
              const w = (frameAt(s).width || 0) / 2;
              const keep = PLACE_KEEP * Math.abs(p.lat);
              const gaps = [...[...PLACE_GAPS, ...(must[i] ? CLASH_GAPS : [])].map((x) => w + x), Math.abs(p.lat), keep].filter((g) => g >= keep);
              for (const [g, sd] of gaps.flatMap((g) => (must[i] ? [[g, side], [g, -side]] : [[g, side]]))) {
                const q = sd === side ? movedRow(p, s, sd * g) : movedRow(p, s, sd * g, 180 - p.yaw);
                if (chosen.some((c) => overlap(c, q)) || spotOf(q, i) || bridged(q) || blocksRoad(path, q)) continue;
                tried.push({ q, read: readOver(path, q, aspect) });
              }
            }
            const dist = (t) => Math.hypot(t.q.cx - p.cx, t.q.cz - p.cz);
            const ranked = tried.filter((t) => must[i] || t.read.seen >= reads[i].seen + PLACE_GAIN)
              .sort((a, b) => Math.round(b.read.seen / PLACE_TIE) - Math.round(a.read.seen / PLACE_TIE)
                || b.read.peak - a.read.peak || dist(a) - dist(b));
            let best = null;
            for (const t of must[i] ? ranked : ranked.slice(0, PLACE_TRIES)) {
              where[i] = t.q;
              const after = where.map((q, k) => (k === i ? t.read : readOver(path, q, aspect)));
              if (after.every((r, k) => k === i || r.seen >= reads[k].seen - PLACE_HARM)) { best = t; reads = after; break; }
              where[i] = p;
            }
            if (best) chosen.push(best.q);
            out.push({ index: i, model: p.model, label: labelOf(p.model), hero: p.model === hero, clash: clash[i],
                       from: { s: p.s, u: p.u, lat: p.lat, ...read },
                       to: best ? { s: best.q.s, u: best.q.u, lat: best.q.lat, yaw: best.q.yaw, ...best.read } : null,
                       candidates: tried.length });
          }
        } finally {
          standing = null;
        }
        return { track: track.id, aspect, proposals: out.sort((a, b) => a.index - b.index) };
      }

      // The parked car's chase eye turned onto the piece, aimed to keep the
      // piece and the top of the car in shot together; where both do not fit
      // across, the piece gives way at its edge and the car stays inside
      // CAR_KEEP of the half-lens (a cell is that player's view, car and
      // all), and up and down the piece wins. Glance (`zoom`) also narrows
      // the lens to fit them, so a small piece far off the road is a subject
      // and the car still shows at the bottom of the shot, never wider than
      // the rig's own; a driver keeps the rig's lens.
      function fitLook(a, p, aspect, zoom) {
        const ang = (q) => {
          const dx = q.x - a.eye.x, dz = q.z - a.eye.z, flat = Math.hypot(dx, dz);
          return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(q.y - a.eye.y, flat),
                   d: Math.hypot(flat, q.y - a.eye.y) };
        };
        const c = centreOf(p, 0.5);
        const pc = ang(c);
        const car = ang({ x: a.at.x, y: a.at.y + CAR_SHOW, z: a.at.z });
        const r = Math.atan(1.2 * radiusOf(p) / Math.max(pc.d, 1));
        const carYaw = Math.atan2(Math.sin(car.yaw - pc.yaw), Math.cos(car.yaw - pc.yaw));
        const yaw0 = Math.min(-r, carYaw), yaw1 = Math.max(r, carYaw);
        const pit0 = Math.min(pc.pitch - r, car.pitch), pit1 = Math.max(pc.pitch + r, car.pitch);
        const tanA = (x) => Math.tan(x) / aspect;
        const need = 2 * Math.max((pit1 - pit0) / 2, Math.atan(tanA((yaw1 - yaw0) / 2))) * 1.15;
        const fov = zoom ? Math.min(a.rig.fov, Math.max(GLANCE_MIN_FOV, need * 180 / Math.PI)) : a.rig.fov;
        const vhalf = (fov / 2) * Math.PI / 180;
        const hhalf = Math.atan(Math.tan(vhalf) * aspect);
        const keep = (mid, at, room) => Math.min(Math.max(mid, at - room), at + room);
        const yaw = pc.yaw + keep(keep((yaw0 + yaw1) / 2, 0, Math.max(hhalf * 0.95 - r, 0)), carYaw, hhalf * CAR_KEEP);
        const pitch = keep((pit0 + pit1) / 2, pc.pitch, Math.max(vhalf * 0.95 - r, 0));
        const l = pc.d;
        return { eye: a.eye, fov,
                 target: { x: a.eye.x + Math.sin(yaw) * Math.cos(pitch) * l, y: a.eye.y + Math.sin(pitch) * l,
                           z: a.eye.z + Math.cos(yaw) * Math.cos(pitch) * l } };
      }
      // From across the road from the piece; a piece on the centreline (an
      // arch) is seen from behind.
      function highDir(p) {
        const f = frameAt(p.s);
        const side = Math.abs(p.lat) < 1 ? 0 : -Math.sign(p.lat);
        const x = side ? side * f.lateral.x : -f.tangent.x;
        const z = side ? side * f.lateral.z : -f.tangent.z;
        const l = Math.hypot(x, z) || 1;
        return { x: x / l, z: z / l };
      }
      // Look at c from `d` away along `dir`, `pitch` above the horizon.
      function framedAt(c, d, dir, pitch, fov) {
        return { eye: { x: c.x + dir.x * d * Math.cos(pitch), y: c.y + d * Math.sin(pitch),
                        z: c.z + dir.z * d * Math.cos(pitch) },
                 target: c, fov };
      }
      const framedPose = (p, dir, pitch) =>
        framedAt(centreOf(p, 0.4), reachOf(radiusOf(p)), dir, pitch, WIDE_FOV);
      // High stands across the road from the piece, back far enough that the
      // road's far edge lies between the eye and the piece, and fits its lens
      // to the piece the way glance does: the piece fills the shot however far
      // off the road it was placed, with the road in front of it.
      function highPose(p) {
        const dir = highDir(p);
        if (Math.abs(p.lat) < 1) return framedPose(p, dir, HIGH_PITCH);
        const f = frameAt(p.s);
        const half = (f.width || 0) / 2;
        const c = centreOf(p, 0.4);
        const r = radiusOf(p);
        const gap = Math.hypot(f.pos.x + dir.x * half - c.x, f.pos.z + dir.z * half - c.z);
        const d = Math.max(reachOf(r), (gap + HIGH_MARGIN) / Math.cos(HIGH_PITCH));
        const fit = 2 * Math.atan(1.5 * r / d) * 180 / Math.PI;
        return framedAt(c, d, dir, HIGH_PITCH, Math.min(WIDE_FOV, Math.max(GLANCE_MIN_FOV, fit)));
      }
      // Orbit walks round the piece at one reach and pitch, chosen per piece:
      // the first (the framed pose's, then higher, then closer in) from which
      // the piece's middle is in clear sight all the way round, else the one
      // that sees it from the most of the way, so the walk never passes
      // behind a deck or into a hill where another would not.
      const ORBIT_STEPS = 12;
      let orbitFit = new Map(), orbitFor = null;
      function orbitPose(p) {
        if (orbitFor !== layout) { orbitFit = new Map(); orbitFor = layout; }
        const c = centreOf(p, 0.4);
        const reach = reachOf(radiusOf(p));
        const d = highDir(p);
        const a0 = Math.atan2(d.z, d.x);
        const dirAt = (a) => ({ x: Math.cos(a), z: Math.sin(a) });
        let fit = orbitFit.get(p);
        if (!fit) {
          let best = null;
          for (const k of [1, 0.8, 0.6]) {
            for (const pitch of [ORBIT_PITCH, ORBIT_PITCH + 0.3, ORBIT_PITCH + 0.6]) {
              let blocked = 0;
              for (let i = 0; i < ORBIT_STEPS; i++) {
                const e = framedAt(c, reach * k, dirAt(a0 + (2 * Math.PI * i) / ORBIT_STEPS), pitch, WIDE_FOV).eye;
                if (hidden(e, c, p)) blocked++;
              }
              if (!best || blocked < best.blocked) best = { blocked, pitch, k };
              if (!blocked) break;
            }
            if (!best.blocked) break;
          }
          fit = best;
          orbitFit.set(p, fit);
        }
        return framedAt(c, reach * fit.k, dirAt(a0 + orbitT * ORBIT_RATE), fit.pitch, WIDE_FOV);
      }
      // Straight down over the whole lap and every piece on it, fitted to the
      // cell's aspect. The target leans a hair off vertical: a look straight
      // along world up has no basis.
      function topPose(aspect) {
        const n = 96;
        const fr = display.trackFrames(track.trackId,
                                       Array.from({ length: n }, (_, i) => (layout.length * i) / n));
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const grow = (x, z, r) => {
          x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
          z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r);
        };
        for (const f of fr) grow(f.pos.x, f.pos.z, (f.width || 0) / 2 + 4);
        for (const p of layout.pieces) grow(p.cx, p.cz, Math.hypot(p.hx, p.hz));
        const half = Math.max((z1 - z0) / 2, (x1 - x0) / 2 / (aspect || 1)) * 1.08;
        let fov = WIDE_FOV;
        let h = half / Math.tan((fov / 2) * Math.PI / 180);
        if (h > TOP_MAX_H) { h = TOP_MAX_H; fov = 2 * Math.atan(half / h) * 180 / Math.PI; }
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, y = layout.groundY;
        return { eye: { x: cx, y: y + h, z: cz + h * 0.02 }, target: { x: cx, y, z: cz }, fov };
      }
      // The framed views' look for cell k; driver and glance go through aim().
      function poseFor(k, aspect) {
        if (mode === 'top') return topPose(aspect);
        const p = pieceFor(k);
        if (!p) return null;
        if (mode === 'high') return highPose(p);
        if (mode === 'orbit') return orbitPose(p);
        return null;
      }

      // Point every cell for the current mode. Driver and glance park each
      // cell's car on the approach (ttp_display_car_pose) so the cell is the
      // race's own chase camera with the player's car in it: driver keeps that
      // camera (a look only where a bend leaves the piece out of every
      // approach), glance turns it onto the piece. Several cells on ONE piece
      // (spread off, or more cells than pieces) are different approaches to it. The
      // framed views put every car back on the grid and stand a look; race
      // clears both and lets the chase rigs drive; free hands one full view
      // to the viewer. cellBoxes() pushes the cells before any look or pose
      // lands, and the engine only takes one for a cell it has.
      function aim() {
        display.cellLookClear();
        display.carPoseClear();
        poses = [];
        if (mode === 'race' || mode === 'free') return;
        const framed = [];
        scene.cellBoxes().forEach((b, k) => {
          const aspect = b.w / Math.max(b.h, 1);
          const piece = mode === 'top' ? -1 : indexFor(k);
          framed.push(piece);
          if (mode === 'driver' || mode === 'glance') {
            // The how-many-th cell on this piece: every cell is, without
            // spread; with it, only where the cells outnumber the pieces.
            const variant = framed.filter((i) => i === piece).length - 1;
            const p = pieceFor(k);
            const a = p && approachFor(p, aspect, variant);
            if (!a) return;
            display.carPose(k, a.s, a.lat);
            const look = mode === 'glance' || a.turn ? fitLook(a, p, aspect, mode === 'glance') : null;
            if (look) display.cellLook(k, look.eye, look.target, look.fov);
            const rig = { eye: a.eye, target: v3(a.rig.target), fov: a.rig.fov };
            poses[k] = { ...(look || rig), aspect, piece, look: !!look,
                         car: { s: a.s, lat: a.lat }, hidden: a.hidden, vis: a.vis,
                         roof: a.roof, size: a.size };
            return;
          }
          const pose = poseFor(k, aspect);
          if (!pose) return;
          display.cellLook(k, pose.eye, pose.target, pose.fov);
          poses[k] = { ...pose, aspect, piece, look: true };
        });
      }
      // Free starts where High's wide framing would stand (not High's fitted
      // lens: a step back in a 12-degree view loses the piece), at the free
      // camera's own lens.
      function openFree() {
        const p = pieceFor(0);
        const pose = p ? framedPose(p, highDir(p), HIGH_PITCH) : topPose(16 / 9);
        const d = { x: pose.target.x - pose.eye.x, y: pose.target.y - pose.eye.y,
                    z: pose.target.z - pose.eye.z };
        const start = { eye: pose.eye, yaw: Math.atan2(d.x, d.z),
                        pitch: Math.asin(d.y / Math.hypot(d.x, d.y, d.z)) };
        document.documentElement.classList.add('cam-free');  // drags reach the canvas
        if (!free) free = scene.enableUserCamera(start);
        else Object.assign(free, { eye: { ...start.eye }, yaw: start.yaw, pitch: start.pitch });
        display.lookFov(0);
      }

      function closeFree() {
        scene.disableUserCamera();
        document.documentElement.classList.remove('cam-free');
        display.lookFov(0);
        free = null;
      }

      // Switch the camera. Race is a live race from the grid; leaving it puts
      // the field back on the grid, parked. Free has no cells (a free camera and
      // a split cannot coexist), so it shows one full view until another mode
      // brings the seats back and drops the free camera's drag and keys. The
      // race fog band stays on only where a player's eye is (driver, glance,
      // race): the framed views stand off further than a racer ever looks, and
      // the band would haze the very piece they frame.
      function setView(m) {
        if (!VIEWS.includes(m)) throw new Error(`unknown landmark view '${m}'`);
        const wasRace = mode === 'race';
        mode = m;
        orbitT = 0;
        if (free && m !== 'free') closeFree();
        scene.soloCam = m === 'free';
        scene.setFog(m === 'driver' || m === 'glance' || m === 'race');
        // The race HUD only in a race: elsewhere its pills and empty map box
        // sit over the very piece a view frames.
        scene.showHud = m === 'race';
        if (engine && (m === 'race' || wasRace)) { engine.dispose(); newSession(); }
        if (m === 'free') openFree();
        aim();
        return mode;
      }

      scene.onFrame = (dt, nowMs) => {
        if (mode === 'orbit') { orbitT += dt; aim(); return; }
        if (mode !== 'race' || !engine) return;
        engine.update(dt * 1000);
        const snap = engine.getSnapshot();
        if (nowMs - lastHud > HUD_TICK_MS) {
          lastHud = nowMs;
          for (const c of snap.cars) scene.setCarHud(c.id, c);
        }
        if (raceOver(snap)) { engine.dispose(); newSession(); }
      };

      // The poses are fitted to each cell's aspect: a resize re-fits them.
      // Registered after the stage's own listener, so the cells have moved.
      window.addEventListener('resize', () => aim());

      const built = serial(async () => { await seat(); setView(mode); });

      // The gallery chrome's control surface, same-origin like __showroom. The
      // rebuilding calls (track, players) resolve once the new scene is up.
      window.__landmarks = {
        ready: () => built,
        tracks: () => TRACK_LIST.map((t) => ({ id: t.id, name: t.name, cupName: t.cupName })),
        trackId: () => track.id,
        track: (id) => serial(async () => {
          const next = ctx.built.get(id);
          if (!next) throw new Error(`no catalogue track '${id}'`);
          track = next;
          focusAt = 0;
          await seat();
          setView(mode);
          return layout;
        }),
        layout: () => layout,
        landmarks: () => marks.slice(),
        // Per cell, what aim() last stood there: {eye, target, fov, aspect,
        // piece (its layout index, -1 for the top view), look (a cell look was
        // pushed; false is the parked car's own chase rig, as predicted)}, and
        // in driver and glance also car {s, lat}, how hidden the piece's middle
        // is from that eye (0 clear), how many of its five sight points are
        // clear (vis), whether that line runs under raised road (roof) and the
        // piece's radius as a share of the half-lens (size). Empty in race and free.
        poses: () => poses.slice(),
        // The parking rules a pose must keep, for the suite to hold them to.
        rules: () => ({ carGap: CAR_GAP, upright: UPRIGHT, level: LEVEL }),
        // The drawing buffer's height: what the render scale is drawing at.
        lines: () => scene.bufferLines,
        players: (n) => serial(async () => {
          seats = Math.max(1, Math.min(n | 0, window.MAX_PLAYERS || 4));
          await seat();
          setView(mode);
          return seats;
        }),
        seats: () => seats,
        view: (m) => setView(m),
        mode: () => mode,
        focus(i) {
          const n = marks.length || 1;
          focusAt = (((i | 0) % n) + n) % n;
          if (mode === 'free') openFree();
          aim();
          return focusAt;
        },
        focused: () => focusAt,
        // Park cell 0's car at (s, lat) under its own chase rig, the driver
        // view's camera: a moment of the lap (a score's `at`) to look at.
        park(s, lat) {
          setView('driver');
          display.cellLookClear();
          display.carPoseClear();
          display.carPose(0, s, lat);
          poses = [];
        },
        // The lap visibility of every piece on the track (lapScore), for a
        // cell of this aspect (16:9, every split's shape, by default).
        score: (aspect) => serial(async () => lapScore(aspect || 16 / 9)),
        // Better spots for the pieces a racer barely reads (the placement
        // search), for a cell of this aspect: per piece searched, where it
        // stands and reads now and where it would read better (`to`, null
        // where nothing beats it by enough or nothing may stand).
        better: (aspect) => serial(async () => better(aspect || 16 / 9)),
        spread(on) { spreadOn = on !== false; aim(); return spreadOn; },
        home() { focusAt = 0; return setView('driver'); }
      };
    }
    return;
  }

  // ---- the cup's chained start (scenario=chain) ----
  // THE WHOLE END-OF-RACE BEAT, on a loop: the flag, the frozen finish frame
  // wearing its place cards, the board fading up over it a flourish later, and
  // then the next circuit's countdown with no lobby step in between. Every one
  // of those is a MOMENT rather than a picture — no still shows a board arriving
  // late, and no assertion reads the join between them as well as an eye does.
  //
  // The board stands over the race that was just run, still driving its victory
  // laps (ttp_coast), and the chained start swaps the circuit under a blurred
  // still of it (main.js prepareNextTrack → backdrop dissolveInto), dissolving
  // into the next grid once the build lands. This loops the lot around a cup's
  // four tracks.
  //
  // NOTHING HERE KEEPS ITS OWN COPY OF THE SEQUENCE. showBoard is the real
  // results renderer, showCountdownBanner the real banner, the scene work is
  // Stage.prepare / rebuild IN THE ORDER THE WALKS EMIT IT
  // (hide-results, reset-scene-cars, create-session, bind-session,
  // start-countdown), the flag freezes and paints in endRace's order, the two
  // waits are the layer's own flourishMs and intermissionMs, and
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
      solo: false
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
        // FACE-ON DOWN THE DECK NORMAL. Seen from here the painted footprint is
        // the stamp's shape as rasterized — any departure is real and cannot be
        // blamed on perspective. The car
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
      const d = scene.display.debugDecals().filter((x) => x.car > 0.5)[0];
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
          + `   lat target ${st.lat.toFixed(1)}`,
        'space pause · , . step · [ ] speed · k l lat · c cam · f lock'
          + ' · h hide cars · w wipe rubber · - = zoom'
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
      // START WHERE ?track= ASKED. This is the only scenario that runs a real countdown,
      // so it is also the only way to preview a launch on a chosen circuit — filming the
      // start of a race is a fair thing to want on a track other than the first cup's
      // first one. The chain then carries on through THAT track's cup, so the preview
      // still shows what it is for: one cup, raced in order.
      const cup = CUPS.find((c) => c.tracks.includes(ctx.track.trackId)) || CUPS[0];
      const { field, bots } = raceField();
      const entry = (id) => built.get(id);

      const firstLeg = Math.max(0, cup.tracks.indexOf(ctx.track.trackId));
      let leg = firstLeg;          // which of the cup's tracks is racing
      let engine = null;
      // race → flourish (the frozen finish frame) → board → race. `phaseMs` is
      // the clock of whichever of the last two is up; the race keeps its own.
      let phase = 'race';
      let phaseMs = 0, raceMs = 0, lastHud = -Infinity;   // -Infinity: the first frame paints
      // The seats the sim treats as PEOPLE — the ones whose crossing is the flag,
      // and the only ones with a split-screen cell to carry a place card.
      const humanIds = new Set(field.filter((f) => !f.ai).map((f) => f.peerIndex));

      // SOUND, and this is the one preview that carries MUSIC. Standalone only,
      // the same rule the race previews follow: a grid of gallery iframes all
      // playing at once is cacophony, and a card whose frames holdFrame idles
      // would queue beats forever. It earns the song because it is the only card
      // that plays the beat the song has to survive — the flag, the flourish,
      // and the board landing on top of it.
      //
      // Decided by the production layer off the bound session, exactly as
      // main.js does it: nothing here picks a cue or a track.
      const audible = !inIframe && !!window.__audio && !!window.__audioDecide;
      const sfx = (cmds) => { if (audible) window.__audio.apply(cmds); };

      // The launch, performed in the walks' own order. Both rebuild triggers
      // come out as no-ops when the board above already prepared this circuit,
      // which is the whole point of the preview.
      function launch() {
        const t = entry(cup.tracks[leg]);
        hideResults();                // hide-results
        for (const id of [...scene.cars.keys()]) scene.removeCar(id);
        field.forEach((f) => scene.addCar(f.peerIndex, f.colorIndex, f.name,
                                         { carIndex: f.carIndex, cell: !f.ai }));
        scene.rebuild();                                      // reset-scene-cars
        if (engine) engine.dispose();                         // dispose-session
        // A COUNTDOWN-MODE session, not a bare one: the beats, their cadence and
        // the moment the field is allowed to move are all its own, drained to
        // the banner through the callback the live shell uses.
        logDeal(log);
        engine = new NativeRaceSession(field, t, {            // create-session
          bots,
          onCountdownTick: (n) => showCountdownBanner(countdownBeat(n), scene.cellBoxes()),
          onRaceEvent: raceEventPerformer(scene, log),
        });
        window.__engine = engine;
        scene.bindSession(engine.h);                          // bind-session
        if (audible) window.__audioDecide.bind(engine.h);
        // The manifest's own count, and the same E2E override the live launch
        // reads — not a 3 retyped here.
        engine.startCountdown(window.__countdownSeconds || window.COUNTDOWN_SECONDS);
        for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
        phase = 'race'; raceMs = 0;
      }

      // THE FLAG, in main.js's order: freeze the picture BEFORE running the sim
      // on, or the just-finished car's chase camera whips off after a pose the
      // screen no longer shows. Then one HUD paint — the same one endRace emits
      // — and that paint is the whole point of this leg: it is what puts the
      // "nth place" card in every human's cell.
      //
      // Live the flag IS every human home; a preview leg is cut on the clock
      // instead, so bring them in in the order they are running and let the
      // fast-forward resolve the CPU fill exactly as the live one does.
      //
      // NO BOARD HERE. That is the beat this preview exists to show.
      function flag() {
        // Live the flag IS every human home; a preview leg is cut on the clock
        // instead, so bring them in in the order they are running.
        const home = engine.getSnapshot().cars
          .filter((c) => humanIds.has(c.id) && !c.finished)
          .sort((a, b) => a.position - b.position);
        home.forEach((c, i) => engine.forceFinish(c.id, raceMs / 1000 + i * 0.4));
        // AND NOTHING STOPS. Hold the sim's own end open so the race runs on
        // through the flourish — the cars that are home drive themselves, the
        // ones that are not race on, the song keeps playing and the voices keep
        // sounding. Without the hold the session would end on the very next
        // update, because these humans were the last cars still running.
        engine.holdEnd(true);
        for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);   // paint-hud
        phase = 'flourish'; phaseMs = 0;                      // arm-results
      }

      // The flourish's far end, in main.js's order: drop the hold, freeze the
      // picture, THEN resolve whatever is still running — the burst draws no
      // frames, so every remaining car teleports to the line and the freeze is
      // what keeps that off screen. Then the board, and the field coasts on.
      function endFlourish() {
        engine.holdEnd(false);
        scene.hold(true);
        engine.fastForwardToEnd();
        for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);   // paint-hud
        sfx(window.__audioDecide.stopVoices());   // the curtain call is muted
        scene.hold(false);
        board();
      }

      // The board arrives a flourish later, fading up over the race, which
      // keeps driving behind it.
      function board() {
        sfx(window.__audioDecide.stopMusic());                // …with the board
        showBoard(previewBoard('intermission', ctx.track.trackId, players, seedOpt.seed ?? 1, leg));   // show-results
        leg = (leg + 1) % cup.tracks.length;
        phase = 'board'; phaseMs = 0;                         // arm-intermission
      }

      // The chained start: the next circuit meshed under a still of this one
      // (main.js advanceSeriesRace → prepareNextTrack), then the launch.
      function advance() {
        dissolveInto(scene, () => scene.prepare(entry(cup.tracks[leg])));
        launch();
      }

      // The board's "starting in N…", ticked exactly as the live shell ticks it
      // (main.js renderIntermissionCountdown): a fresh ceil off the ui model
      // every beat rather than a counter this side decrements, so it cannot
      // drift and it cannot disagree with the live footer.
      //
      // Off the FRAME clock, not main.js's setInterval, for the reason every
      // other clock in this preview is: a gallery card's pause has to freeze the
      // footer along with the picture, and an interval would march on behind a
      // still. The span only exists once the board turns to its cup phase — the
      // race phase has no footer — so a null here is "not up yet", not a fault.
      function tickNextSecs(remainMs) {
        const secs = el('results-next-secs');
        if (secs) secs.textContent = String(intermissionSecs(remainMs, 0));
      }

      const log = raceLog();
      // FROM THE TOP, in place: the same launch on the same first leg, for the trailer
      // editor's backward seek. A simulation only runs forward, so a rewind is this
      // plus a wind — and this is what makes it a wind rather than a page boot. The
      // setTrack is the one scene step no walk emits: the first leg has no board
      // before it to prepare its circuit.
      const restart = () => { leg = firstLeg; scene.setTrack(entry(cup.tracks[leg])); launch(); };
      restart();
      // The mix is decided on Stage's frame clock, like the footer above and for the
      // same reason: the decision layer spaces its screeches and lap chimes by it, and
      // under a capture gate a wall-clock read spans hundreds of ms per frame.
      scene.onFrame = (dt, nowMs) => {
        const ms = dt * 1000;
        log.frameMs = nowMs;
        if (phase === 'board') {
          // The board sits for the layer's own budget, which is also the number
          // it is at that moment printing in its "starting in N…" footer.
          phaseMs += ms;
          const remain = intermissionMs() - phaseMs;
          tickNextSecs(remain);
          if (remain <= 0) { advance(); return; }
          engine.coast(ms);                                   // the curtain call
          return;
        }
        if (phase === 'flourish') {
          // STILL RACING. The only difference from the beat above is that the
          // clock is now counting the flourish out; everything else — the sim,
          // the HUD, the mix — carries on exactly as it did a moment ago.
          phaseMs += ms;
          if (phaseMs >= flourishMs()) { endFlourish(); return; }
        }
        // Countdown and race are ONE path here exactly as they are in main.js:
        // the session is updated from the first countdown frame on (cars drawn
        // and steerable, physics held), and IT decides when they are racing.
        engine.update(ms);
        const now = nowMs;
        sfx(window.__audioDecide.frame(now));   // one frame of the mix
        if (now - lastHud > HUD_TICK_MS) {
          lastHud = now;
          for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
        }
        if (!engine.racing) return;   // still counting down (never true past the flag)
        if (phase === 'flourish') return;   // the race clock stopped at the flag
        // THE SONG STARTS ON GO, not at the launch. That is where the live walk
        // puts it (race_flow's raceStart, not launchRace), so the countdown beats
        // play over silence and the music arrives with the field.
        if (!raceMs && audible) sfx(window.__audioDecide.startMusic(scene.biome()));
        raceMs += ms;
        if (raceMs >= CHAIN_RACE_MS || raceOver(engine.getSnapshot())) flag();
      };
      holdFrame(true, previewControl(restart, log));   // gallery: the card's ▶ runs the loop; a standalone tab just runs
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

    // Each car carries the model + handling stats its seat resolves to, so the
    // gallery shows the real spread of handling and the car-car bumping, not a
    // uniform field. All of that is the launch's (raceField).
    const { field, bots } = raceField();

    // Pickups, strikes and whiffs land on the picture as they do live (raceEventPerformer).
    const log = raceLog();
    const onRaceEvent = raceEventPerformer(scene, log);

    // SOUND, THROUGH THE PRODUCTION DECISION LAYER. The preview is a real native
    // sim on the bench field, whose player seats are autopiloted PARTICIPANTS —
    // so the C++ layer has its four listeners and its four voiced cars and can
    // decide the whole mix (engines, squeal, brake, boost wind, the rocket's jet,
    // the transformed car's growl) exactly as it does in a live race. There is no
    // gallery-only cue path any more.
    //
    // Only when the sound is being RENDERED (RaceAudio.offline, the trailer's
    // ?offlineaudio seam): there the graph plays to nobody. A gallery card stays
    // silent — a wall of thumbnails all racing would be cacophony, and a bound
    // session whose frames never run (holdFrame idles every card) would queue
    // beats forever — and ?scenario=bench too, since audio work would perturb the
    // reading it exists to take.
    const audible = !inIframe && !!window.__audio && window.__audio.offline;

    // Self-driving preview: every car is one of the sim's own AI racers (same personas
    // main.js hands the wasm for the live CPU fill), so the gallery shows real bot
    // behaviour — fanned lanes, a spread of speeds — not a bespoke demo loop.
    //
    // The live race scenarios take the debug ?item= the live launch does, roulette
    // only: every box rolls that item, and the field still has to collect and fire it,
    // as in a real race.
    const forceItem = (kind === 'racing' || kind === 'bench') ? opts.forceItem : null;
    // `?hold=` — a screenshot card's race moment (galleryScenarios.js `hold`),
    // re-armed on every deal so a redealt race stops at the same moment.
    const holdParam = new URLSearchParams(location.search).get('hold');
    const hold = holdParam ? JSON.parse(holdParam) : null;
    // `?showcase=` — a live card's item loop (ttp_item_showcase), for an item no
    // race shows on its own. A capture names its moment with a hold instead, and
    // the loop would change the race on the way there, so a hold switches it off.
    const showcase = hold ? null : new URLSearchParams(location.search).get('showcase');
    const newSession = () => {
      const s = bareSession(field, track, { bots, onRaceEvent, forceItem, ...seedOpt });
      if (hold && !s.shotHold(hold)) console.error(`[harness] the engine refused hold ${holdParam}`);
      if (showcase) s.itemShowcase(showcase);
      return s;
    };
    let engine = newSession();
    window.__engine = engine;

    for (const id of [...scene.cars.keys()]) scene.removeCar(id);
    // Humans get their split-screen cell, the CPU fill drives cell-less — the
    // C++ rule live launches apply (race_flow's cell = !ai).
    field.forEach((f) => scene.addCar(f.peerIndex, f.colorIndex, f.name,
                                     { carIndex: f.carIndex, cell: !f.ai }));
    scene.bindSession(engine.h); // the renderer draws this session's cars
    if (audible) window.__audioDecide.bind(engine.h); // …and the audio hears it

    const live = kind === 'racing' || kind === 'bench';

    // The seats the decision layer treats as PEOPLE: not in the sim's aiIds, so
    // they are its listeners and the only cars it voices. The bench field's
    // autopiloted player seats are exactly these, and they are also the ones
    // carrying a split-screen cell.
    const humanIds = new Set(field.filter((f) => !f.ai).map((f) => f.peerIndex));

    let lastHud = -Infinity;   // the first frame paints

    // Deal the race again from the grid. The end of a preview race does this to lap
    // forever; the trailer editor does it to seek BACKWARD, a simulation having no way
    // back but a fresh race wound forward. Same seed, same bots, same showcase clock,
    // so it is the same race — which is what puts the editor's in-points where
    // render.js will put them. dispose() frees the wasm session — a JS Game was just
    // garbage, a handle isn't.
    function redeal() {
      // Every voice belongs to the session about to be freed, and nothing will
      // feed it a zero level once the loop restarts on a fresh one — so kill
      // them here, exactly as the end-of-race walk does in a live race.
      if (audible) window.__audio.apply(window.__audioDecide.stopVoices());
      engine.dispose();
      engine = newSession();
      window.__engine = engine;
      scene.bindSession(engine.h);
      if (audible) window.__audioDecide.bind(engine.h);
      logDeal(log);
    }

    // The mix is decided on Stage's frame clock, for the reason the chain preview gives.
    scene.onFrame = (dt, nowMs) => {
      if (!live) return; // frozen preview: the renderer holds the field (see below)
      log.frameMs = nowMs;
      // The bots, item pickups and the roulette all run inside the wasm sim, and
      // the renderer reads the result from the same engine — so a frame is one
      // update plus the shell's own business below.
      engine.update(dt * 1000);
      const snap = engine.getSnapshot();
      const now = nowMs;
      // One frame of the mix, decided off the bound session — the same call
      // main.js makes, and the flush point for whatever the events that fired
      // inside the update above decided.
      if (audible) window.__audio.apply(window.__audioDecide.frame(now));
      if (now - lastHud > HUD_TICK_MS) {
        lastHud = now;
        for (const c of snap.cars) scene.setCarHud(c.id, c);
      }
      // Endless preview: once everyone crosses the line, reset and lap again.
      if (raceOver(snap)) redeal();
    };

    if (kind === 'countdown') {
      // HUD shows lap 1 while the lights count down.
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      // The cup line a live cup puts up on this track: its place in its cup.
      const cupRace = previewCupRace(track.trackId);
      showCountdownBanner(cupRace ? { ...COUNTDOWN_STILL, cupRace } : COUNTDOWN_STILL,
                          scene.cellBoxes());
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
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      scene.hold(true);
      // Fake a dropped racer: the last filled slot is reconnecting. Its car keeps
      // its cell; the reconnect QR is centred in that cell (the renderer positions
      // it). The QR encodes the join URL with the seat's ?claim= token (no relay
      // needed — the matrix is built in-browser).
      const dropped = humansFirst(field)[players - 1];
      scene.setCarReconnect(dropped.peerIndex, buildReconnectCard({
        colorIndex: dropped.colorIndex,
        url: (location.origin || 'https://tinytrack.party') + '/TEST?claim=' + dropped.peerIndex
      }));
    } else if (kind === 'finished') {
      // One racer has crossed the line while the rest of the field races on: spin
      // the field forward so it's spread out, mark the current leader FINISHED,
      // then freeze. Their split-screen cell shows the centred FINISHED card
      // (place + time); every other cell keeps its live lap/place HUD.
      for (let t = 0; t < 160; t++) engine.update(33);
      // The finisher must be a HUMAN — the FINISHED card lives in a split-screen
      // cell, and the CPU fill has none.
      const leadId = engine.getSnapshot().cars.filter((c) => humanIds.has(c.id))
        .reduce((a, b) => (a.position <= b.position ? a : b)).id;
      // Promote the finisher to P1 at the winning time the boards show; the rest keep racing.
      engine.forceFinish(leadId, previewBoard('results', track.trackId, players, seedOpt.seed ?? 1).order[0].time);
      for (const c of engine.getSnapshot().cars) scene.setCarHud(c.id, c);
      scene.hold(true);
    } else if (kind === 'results' || kind === 'intermission' || kind === 'podium') {
      // Freeze the grid behind the board. Both kinds of board — a single race
      // with a late joiner, and the cup's mid-way break or its podium — are
      // ttp_ui_preview_board_json's, over the bench race launched here.
      showBoard(previewBoard(kind, track.trackId, players, seedOpt.seed ?? 1));
    }
    // The bench races the same loop everything else does — that is the point of
    // measuring it — and then runs on under the readout instead of holding a
    // frame for a card.
    if (kind === 'bench') { startBenchReadout(scene, track); return; }
    // gallery: animated previews (racing) hold a still grid and run via
    // the card's ▶; frozen previews (countdown/paused/reconnect/finished/results) paint
    // once and stay idle. Standalone tabs ignore this and run freely.
    holdFrame(live, live ? previewControl(redeal, log) : null);
  }
}
