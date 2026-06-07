// Display entry — lobby + authoritative race. Owns the Three.js scene, the car
// engine, the countdown→race→results flow, and per-player PLAYER_STATE.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildTrack, TRACK_LIST } from './TrackBuilder.js';
import { trackSchematic } from './trackSchematic.js';
import { RaceSession } from './RaceSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { LobbyDemo } from './LobbyDemo.js';
import { carThumbNode } from '../shared/carThumbs.js';
// Sound is intentionally disabled for now (Audio.js kept for a later pass).

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS, CAR_MODELS, MAX_PLAYERS, carStats } = window;
const el = (id) => document.getElementById(id);
const screens = { lobby: el('lobby'), race: el('race') };
const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

// ---- tracks ----
// Build every track once (buildTrack is pure geometry — no GLBs needed), so we
// can ship a schematic catalog to the phones and switch the lobby preview with
// no rebuild. The catalog (id + name + top-down SVG path) is what the controllers'
// track picker renders; `built` keeps the geometry for the race + the 3D preview.
// Selection is host-driven (SELECT_TRACK) and echoed to all.
const built = new Map(TRACK_LIST.map((t) => {
  const b = buildTrack(t.segments);
  // Resolve the authored oil slicks once: fraction-of-lap (u) → arclength (s),
  // now that the built geometry knows the lap length. Read by the engine (spin-out
  // detection) and the renderer (drawing the puddle + cones), both off track.hazards.
  b.hazards = (t.oils || []).map((o) => ({
    s: (((o.u % 1) + 1) % 1) * b.length, lat: o.lat || 0,
    // diameter capped at 40% of the drivable track width (radius = 20%) unless the
    // slick names its own radius — keeps a puddle dodgeable on any track.
    radius: o.radius != null ? o.radius : b.roadWidth * 0.2,
    cones: o.cones
  }));
  // Boost pads + item boxes: same u→s resolve. Radius ~18% of road width (a touch
  // tighter than oil) — comfortably bigger than one frame of travel so a fast car
  // can't tunnel through. Read by the engine (detection) + renderer (meshes).
  const u2s = (u) => (((u % 1) + 1) % 1) * b.length;
  b.pads = (t.pads || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * 0.18 }));
  b.boxes = (t.boxes || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * 0.18 }));
  return [t.id, b];
}));
const trackCatalog = TRACK_LIST.map((t) => ({
  id: t.id, name: t.name, svg: trackSchematic(built.get(t.id))
}));

// No track is selected at first: the lobby shows the plain diorama and the host's
// "Start race" stays disabled until they pick one. ?track=<id> preselects (dev /
// gallery), and ?centerline=1 overlays the magenta racing-line ribbon (a track-
// gallery inspection aid). `track` always holds valid geometry (the pick, or the
// first track as a render default) so the scene + gallery always have something to draw.
const _trackParams = new URLSearchParams(location.search);
const _qTrack = _trackParams.get('track');
const _showCenterline = _trackParams.get('centerline') === '1';
// Gallery / test surfaces drive the scene themselves (their own onFrame + cars), so
// the live lobby attract demo must stay out of their way — guard every demo entry on it.
const _isTestMode = _trackParams.get('test') === '1' || !!_trackParams.get('scenario');
let selectedTrackId = (_qTrack && built.has(_qTrack)) ? _qTrack : null;
let track = built.get(selectedTrackId || TRACK_LIST[0].id);
track.totalLaps = TOTAL_LAPS;

// ---- scene ----
// Preload the UNION of every track's tiles up front, so the host can switch
// tracks in the lobby with no load hitch. The renderer orbits the selected track
// as a live lobby preview (scene.orbit).
const allGlbs = [...new Set([...built.values()].flatMap((b) => b.instances.map((i) => i.glb)))];
const scene = new SceneRenderer(el('scene'), CAR_COLORS);
scene.orbit = true;
let sceneReady = false;
// Lobby attract demo: AI driving the players' picked cars around the selected track,
// rendered under the orbiting overview camera. Runs only in the lobby (no session).
const lobbyDemo = new LobbyDemo(scene);
// Kept as a promise too so the gallery TestHarness can wait for the GLBs +
// track before placing its preview cars.
// item-cone rings each oil slick; item-box / item-banana are the pickup + dropped
// hazard meshes — none are track tiles, so they're added to the preload set here.
const scenePromise = scene.load([...allGlbs, 'item-cone', 'item-box', 'item-banana']).then(() => {
  scene.setTrack(track, { debug: _showCenterline });
  sceneReady = true;
  scene.start();
  refreshLobbyDemo(); // start the attract demo if a track is already picked (?track= / picked during load)
});

// Swap the lobby preview + race track to the host's pick. Lobby only — Net
// validates host + room state before calling this; `track` is read by startRace.
function selectTrack(id) {
  if (!built.has(id) || id === selectedTrackId) return;
  selectedTrackId = id;
  track = built.get(id);
  track.totalLaps = TOTAL_LAPS;
  window.__track = track;
  if (sceneReady && net.roomState === ROOM_STATE.LOBBY) {
    // Crossfade the backdrop: the track swap (and demo rebuild) happens under a
    // sky-coloured veil so it reads as a smooth transition, not a hard cut — and
    // the same dip reveals the very first preview over the diorama.
    fadeBackdrop(() => {
      updateBackdrop();
      scene.setTrack(track, { debug: _showCenterline });
      refreshLobbyDemo();
    });
  } else {
    updateBackdrop();
  }
}

// Lobby backdrop: the plain sunny diorama until a track is picked, then the live
// 3D preview (which covers it). During a race the 3D scene is always the backdrop.
function updateBackdrop() {
  const show3D = !!selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY);
  el('scene').classList.toggle('hidden', !show3D);
  const dio = el('lobby-diorama');
  if (dio) dio.classList.toggle('hidden', show3D);
}

// ---- lobby backdrop crossfade ----
// Dip a sky-coloured veil to opaque, run `mid` under the cover (swap track, rebuild
// the demo cars, drop the frozen race field…), then fade back. The veil sits below
// the lobby UI + race overlay, so only the 3D preview dips, not the cards. FADE_MS
// mirrors the CSS transition on #scene-fade.
const FADE_MS = 380;
let fadeTimer = null;
function fadeBackdrop(mid) {
  const fade = el('scene-fade');
  if (!fade) { mid(); return; }            // veil missing (older markup) → instant
  fade.classList.add('is-on');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    // try/finally so a throw in mid() can never leave the veil stuck opaque.
    try { mid(); }
    finally { fadeTimer = setTimeout(() => fade.classList.remove('is-on'), 60); } // fade back in
  }, FADE_MS);
}

// ---- lobby attract demo ----
// (Re)build the demo to match the current track + roster, or tear it down when it
// shouldn't be running (no track yet, mid-race, or a test surface owns the scene).
// Cheap to call repeatedly: it skips a rebuild when nothing relevant changed, so
// re-picking the same car doesn't re-grid the field.
function refreshLobbyDemo() {
  if (_isTestMode || !sceneReady || session || !selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY)) {
    lobbyDemo.stop();
    return;
  }
  const field = buildDemoField(net.flow.list());
  const sig = demoSig(field, selectedTrackId);
  if (lobbyDemo.active && lobbyDemo.sig === sig) return; // no relevant change

  // Same track + same set of cars, only the picks changed (a player switched their
  // car) → swap those models in place so the demo race keeps running, no re-grid.
  // Anything else (join/leave, track switch, first start) is a full rebuild.
  if (lobbyDemo.active && lobbyDemo.track === track && sameCarSet(field, lobbyDemo.field)) {
    const prevById = new Map(lobbyDemo.field.map((p) => [p.id, p]));
    for (const p of field) {
      const prev = prevById.get(p.id);
      if (prev && (prev.carIndex !== p.carIndex || prev.colorIndex !== p.colorIndex || prev.name !== p.name)) {
        lobbyDemo.swapCar(p.id, p);
      }
    }
    lobbyDemo.sig = sig; // record the new signature so the next diff is accurate
    return;
  }
  lobbyDemo.start(track, field, sig);
}

// True when two demo fields cover the exact same set of car ids (so only liveries/
// models could have changed) — the cue to swap in place rather than rebuild.
function sameCarSet(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(b.map((p) => p.id));
  return a.every((p) => ids.has(p.id));
}

// Roster changes (join/leave/car-pick) arrive in bursts as players fiddle; debounce
// the rebuild so rapid car-cycling coalesces into one re-grid instead of many.
let demoRefreshTimer = null;
function scheduleLobbyDemo() {
  clearTimeout(demoRefreshTimer);
  demoRefreshTimer = setTimeout(refreshLobbyDemo, 500);
}

// Build the attract field: each connected human's PICKED car (livery + model), plus
// CPU racers topping the grid up to a full field — every car driven by the AI. The
// ids are namespaced so they never collide with the integer phone slots a later real
// race uses (the race rebuilds its own field on "GO").
function buildDemoField(humans) {
  const field = [];
  const usedColors = new Set();
  for (const p of humans) {
    const carIndex = (p.carIndex == null ? p.colorIndex : p.carIndex);
    field.push({ id: 'demo-' + p.peerIndex, name: p.name, colorIndex: p.colorIndex, carIndex, stats: carStats(carIndex) });
    usedColors.add(p.colorIndex);
  }
  const humanCount = field.length;
  const lowestFreeColor = () => { let i = 0; while (usedColors.has(i)) i++; return i; };
  while (field.length < FIELD_SIZE) {
    const colorIndex = lowestFreeColor(); usedColors.add(colorIndex);
    const carIndex = colorIndex % CAR_MODELS.length;
    field.push({ id: 'demo-cpu-' + (field.length - humanCount), colorIndex, carIndex, stats: carStats(carIndex) });
  }
  // Persona (skill + lane) by final grid index so they spread across the WHOLE field;
  // each CPU also takes THAT persona's name, so its plate matches how it drives.
  // Humans keep their own name but still drive on a persona — no phones steer here.
  field.forEach((p, i) => {
    p.persona = AI_PERSONALITIES[i % AI_PERSONALITIES.length];
    if (i >= humanCount) p.name = p.persona.name;
  });
  return field;
}

// Cheap signature of what the demo renders, so refreshLobbyDemo can skip a no-op
// rebuild. Track + each car's id/livery/model; a rename alone won't re-grid.
function demoSig(field, trackId) {
  return trackId + '|' + field.map((p) => p.id + ':' + p.colorIndex + ':' + p.carIndex).join(',');
}

// ---- race state ----
let session = null;
let paused = false;        // race frozen via the pause overlay (display or a controller)
let lastPlayerState = 0;
// AI ("CPU") racers that filled empty seats this race: peerIndex -> controller.
// Empty when four humans race. `currentField` is the full roster (humans + AI),
// kept so the results screen can resolve AI names/liveries (they're not in the lobby).
let aiBots = new Map();
let currentField = [];
let fastForwarding = false; // true only inside the AI-only fast-forward burst
let raceEnded = false;      // race over → freeze the scene behind the (translucent) results overlay until the next race

scene.onFrame = (dt) => {
  if (!session) { lobbyDemo.step(dt); return; } // no race → run the lobby attract demo
  if (paused || raceEnded) return; // paused/ended: cars hold their last (frozen) pose
  // During countdown the session exists but isn't racing yet: we still draw
  // the cars and let them react to steering so players can feel their tilt —
  // they just don't move until GO. session.update() is a no-op until racing.
  driveBots();
  session.update(dt * 1000);
  // Every human across the line but CPU cars still circulating? Don't make the
  // humans watch them crawl home — fast-forward the deterministic sim to the
  // flag and show the final board now (the AI get their true finish times).
  if (session.racing && humansAllDone()) {
    // Freeze the field at the finish moment BEFORE the burst. fastForwardToEnd
    // advances the deterministic sim with NO rendering, and the just-finished
    // human keeps driving a victory lap — so without this the chase camera is
    // seen whipping across the track to that far-away pose through the
    // translucent results glass. raceEnded then holds this frame until the next
    // race (see the onFrame guard above).
    freezeCars(session.getSnapshot());
    fastForwarding = true;
    session.fastForwardToEnd(driveBots); // runs to raceOver, then fires endRace (sets raceEnded)
    fastForwarding = false;
    return;                               // session ended; the results overlay covers the scene
  }
  const snap = session.getSnapshot();
  for (const c of snap.cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, c.spd, c.onWall, c.steerInput, c.spin, c.boostMul);
  }
  scene.syncProps(snap); // show/hide item boxes + reconcile dropped-banana meshes
  if (!session.racing) return; // countdown: visible + steerable, but no HUD yet
  // throttle HUD + PLAYER_STATE to ~6 Hz
  const now = performance.now();
  if (now - lastPlayerState > 160) {
    lastPlayerState = now;
    for (const c of snap.cars) {
      scene.setCarHud(c.id, c);
      if (aiBots.has(c.id)) continue; // no phone behind an AI car
      net.sendTo(c.id, {
        type: MSG.PLAYER_STATE, lap: c.lap, totalLaps: c.totalLaps,
        position: c.position, of: c.of, finished: c.finished,
        item: c.item, boost: c.boostActive // phone shows the held item + a boost flash
      });
    }
  }
};

// ---- net ----
let currentJoinUrl = '';   // full join link (same string the QR encodes); set on room-ready
const net = new DisplayNet({
  trackCatalog,
  defaultTrackId: selectedTrackId,
  onTrackChange: selectTrack,
  onRoomReady: async ({ roomCode, joinUrl }) => {
    // The room code rides along in the join URL's path; we highlight that
    // trailing segment rather than showing the code separately.
    currentJoinUrl = joinUrl;                   // the full link the join box copies
    try { const u = new URL(joinUrl); renderJoinUrl(el('joinurl'), u.host + u.pathname, roomCode); }
    catch (_) { el('joinurl').textContent = joinUrl; }
    try { renderQR(el('qr'), await fetchQR(joinUrl)); } catch (e) { console.warn('QR failed', e); }
  },
  onRosterChange: renderRoster,
  onControllerMessage: (from, data) => {
    if (data.type === MSG.CONTROL && session) session.processInput(from, data);
    else if (data.type === MSG.START_GAME && from === net.flow.host && net.flow.connectedCount > 0) startRace();
    // Pause / resume / new game can come from any player's controller.
    else if (data.type === MSG.PAUSE_GAME) pauseRace();
    else if (data.type === MSG.RESUME_GAME) resumeRace();
    else if (data.type === MSG.RETURN_TO_LOBBY) returnToLobby();
  }
});

// A player who leaves during a countdown/race forfeits: drop their car so it
// doesn't drive on as a ghost and doesn't block the race from ever ending.
net.flow.on('playerleave', ({ peerIndex }) => {
  if (!session || !session.forceRemoveCar(peerIndex)) return;
  scene.removeCar(peerIndex);
});

// Always lay out at least this many seats; empty ones show as placeholders so
// the lobby card keeps a fixed size as players trickle in. Locked to the race
// field size so the lobby grid and the grid that actually races never diverge.
const MIN_SEATS = MAX_PLAYERS;

// Every race runs a full FIELD_SIZE grid: seats no human took are filled by AI
// ("CPU") racers (see buildField), so a short-handed lobby still gets a real race.
const FIELD_SIZE = MAX_PLAYERS;
const AI_PREFIX = 'ai-';
function renderRoster(roster, hostPeerIndex) {
  const list = el('players'); list.innerHTML = '';
  const seats = Math.max(MIN_SEATS, roster.length);
  for (let i = 0; i < seats; i++) {
    const p = roster[i];
    const seat = document.createElement('div');
    if (p) {
      // Show the car this player picked (a real render), ringed + dotted in
      // their livery. carIndex falls back to colorIndex before they pick.
      seat.className = 'seat' + (p.connected ? '' : ' seat--off');
      seat.style.setProperty('--c', CAR_COLORS[p.colorIndex] || '#888');
      const carIdx = (p.carIndex == null ? p.colorIndex : p.carIndex);
      const model = CAR_MODELS[carIdx % CAR_MODELS.length];
      const row = document.createElement('div');
      row.className = 'seat__name';
      const dot = document.createElement('span'); dot.className = 'seat__dot';
      const nm = document.createElement('span'); nm.className = 'seat__label';
      nm.textContent = p.name + (p.peerIndex === hostPeerIndex ? '  ★' : '');
      row.appendChild(dot); row.appendChild(nm);
      // each joined car rotates in spin mode, in lockstep via the shared clock
      seat.appendChild(carThumbNode(model, { spin: true }));
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
  el('count').textContent = roster.length ? `${roster.length} racer${roster.length > 1 ? 's' : ''} ready` : 'Scan the QR code to join';
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Build the race field: the connected humans plus AI racers topping the grid up
// to FIELD_SIZE. AI get string ids ('ai-0'…) that never collide with the integer
// phone slots, the lowest free liveries, and a personality from AI_PERSONALITIES.
function buildField(humans) {
  // carIndex is the player's lobby car pick; each player carries the handling
  // stats resolved from it (carStats wraps + defaults), so the engine can give
  // every car its own accel/top speed/turn/weight + collision footprint.
  const field = humans.map((p) => ({
    peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex,
    carIndex: p.carIndex, stats: carStats(p.carIndex), ai: false
  }));
  aiBots = new Map();
  const usedColors = new Set(field.map((p) => p.colorIndex));
  const lowestFreeColor = () => { let i = 0; while (usedColors.has(i)) i++; return i; };
  for (let n = 0; field.length < FIELD_SIZE; n++) {
    const persona = AI_PERSONALITIES[n % AI_PERSONALITIES.length];
    const colorIndex = lowestFreeColor();
    usedColors.add(colorIndex);
    const peerIndex = AI_PREFIX + n;
    // AI race the model their livery slot maps to (what the renderer already drew
    // when carIndex was omitted) — set it explicitly so stats match that model.
    const carIndex = colorIndex % CAR_MODELS.length;
    field.push({ peerIndex, name: persona.name, colorIndex, carIndex, stats: carStats(carIndex), ai: true });
    aiBots.set(peerIndex, new AiController({ ...persona, seed: ((track.seed || 1) + peerIndex) >>> 0 }));
  }
  return field;
}

// Feed each AI car its pure-pursuit input for this frame, exactly as a phone's
// CONTROL would. Runs every frame (a no-op during the countdown, when update() is).
function driveBots() {
  if (!aiBots.size) return;
  for (const [id, bot] of aiBots) {
    const car = session.engine.cars.get(id);
    if (!car || car.finished) continue;
    session.processInput(id, bot.drive(car, track.centerline, session.engine));
  }
}

// ---- race lifecycle ----
function startRace() {
  if (net.roomState !== ROOM_STATE.LOBBY || !sceneReady) return;
  if (!selectedTrackId) return;              // a track must be chosen first
  const players = net.flow.list();
  if (!players.length) return;

  // Fresh seed per race so item rolls (and AI lane wander) vary game-to-game. The
  // display is the sole authority, so picking it here (with the page RNG) keeps the
  // engine deterministic from the seed while the rolls aren't identical every game.
  // Set BEFORE buildField so the bots seed their wander from the same race seed.
  track.seed = (Math.random() * 0xffffffff) >>> 0;

  lobbyDemo.stop(); // the race owns the scene now — drop the attract cars

  // Top the grid up to a full field with AI; keep the roster for the results screen.
  const field = buildField(players);
  currentField = field;

  net.flow.transitionTo(ROOM_STATE.COUNTDOWN);
  show('race');
  el('results').classList.add('hidden');
  paused = false;
  raceEnded = false;             // un-freeze the scene for the new race
  setPauseOverlay(false);
  el('pause-btn').classList.remove('hidden'); // pausable from the countdown on
  revealPauseBtn();                           // show it, then auto-fade until activity

  // (re)build scene cars. AI cars get no split-screen cell (cell:false) — they're
  // opponents in the shared world, not players watching the screen.
  for (const c of [...scene.cars.keys()]) scene.removeCar(c);
  for (const p of field) scene.addCar(p.peerIndex, p.colorIndex, p.name, { cell: !p.ai, carIndex: p.carIndex });
  scene.resetCones(); // a new race starts with the warning rings intact, not where they were knocked

  session = new RaceSession(field, track, {
    onRaceEvent,
    onCountdownTick(n) {
      // n > 0: "3/2/1". n === 0: "GO!" (race starts this beat, banner fades out
      // over the next beat via .is-go). n < 0: banner gone.
      el('countdown').textContent = n > 0 ? n : n === 0 ? 'GO!' : '';
      el('countdown').classList.toggle('is-go', n === 0);
      net.broadcast({ type: MSG.COUNTDOWN, n });
    },
    onRaceStart() {
      // Fires on the "GO!" beat — physics are live and the GO! banner is still
      // up (it clears on the next tick). Fail-safe note: RaceSession enforces
      // MAX_RACE_MS internally so AFK/DNF cars can't hang the room forever. A
      // clean 3-lap is ~50-80 s.
      net.flow.transitionTo(ROOM_STATE.PLAYING);
      net.broadcast({ type: MSG.GAME_START });
    },
    onRaceEnd: endRace,
  });
  window.__engine = session.engine;

  // Place cars at their grid poses immediately.
  for (const c of session.getSnapshot().cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
  }
  session.startCountdown(COUNTDOWN_SECONDS);
}

function onRaceEvent(e) {
  // As each car crosses the line, push the running standings so a finished
  // player's phone flips to the results overlay and it fills in for everyone
  // else as more cars finish. (Other events are SFX/FX hooks — sound disabled.)
  if (!e || e.type !== 'finish') return;
  if (fastForwarding) return; // endRace sends the final board once; don't spam one per AI car
  // If that finish was the last human's, we're about to fast-forward to the flag
  // (only CPU cars remain) and endRace will send the final board — skip this
  // intermediate push so the last human jumps straight to results, no flash of
  // the "FINISHED" hero for a race that's effectively already decided.
  if (humansAllDone()) return;
  broadcastStandings(false);
}

// True once every HUMAN car has crossed the line (CPU cars may still be out).
// Drives the "only CPU left → skip to results" fast-forward. False when there
// are no humans at all (a fully-AI field has no one to be courteous to, and the
// natural race_over already covers it).
function humansAllDone() {
  if (!session) return false;
  let humans = 0;
  for (const [id, c] of session.engine.cars) {
    if (aiBots.has(id)) continue;  // a CPU racer
    humans++;
    if (!c.finished) return false; // a human still on track
  }
  return humans > 0;
}

// Live standings for the controllers' results overlay. Pushed as each car
// finishes (over=false) and once more at race end (over=true, so DNF/AFK cars
// resolve and everyone — not just finishers — sees the final board). Enriched
// from currentField because the AI racers aren't in the lobby roster the phones
// know, so the display is the only side that can name/colour them.
function standingsPayload(results, over) {
  const byId = new Map(currentField.map((p) => [p.peerIndex, p]));
  return {
    type: MSG.STANDINGS,
    over: !!over,
    hostPeerIndex: net.flow.host,
    total: results.results.length,
    order: results.results.map((res) => {
      const p = byId.get(res.playerId) || {};
      return {
        playerId: res.playerId,
        name: p.name || String(res.playerId),
        colorIndex: p.colorIndex == null ? 0 : p.colorIndex,
        ai: !!p.ai,
        finished: !!res.finished,
        time: res.time
      };
    })
  };
}
function broadcastStandings(over) {
  if (session) net.broadcast(standingsPayload(session.getResults(), over));
}

// The host ends the results screen with "New game" (RETURN_TO_LOBBY); this is
// only a safety net so a room whose players all left mid-podium still recovers.
const RESULTS_FAILSAFE_MS = 60000;
let endTimer = null;
function endRace(results) {
  net.flow.transitionTo(ROOM_STATE.RESULTS);
  raceEnded = true;                            // hold the finish frame behind the translucent results overlay
  paused = false;                              // results aren't pausable
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  stopPauseAutoHide();
  broadcastStandings(true);                    // final board → phones show the full results overlay
  showResults(results);
  clearTimeout(endTimer);
  endTimer = setTimeout(returnToLobby, RESULTS_FAILSAFE_MS);
}

function showResults(results) {
  const byId = new Map(currentField.map((p) => [p.peerIndex, p]));
  el('results-list').innerHTML = results.results.map((res) => {
    const p = byId.get(res.playerId) || {};
    const col = CAR_COLORS[p.colorIndex] || '#888';
    const time = res.finished ? `${res.time.toFixed(1)}s` : 'DNF';
    const label = (p.name || res.playerId) + (p.ai ? ' (CPU)' : '');
    return `<li><span class="stand__dot" style="background:${col}"></span> ${label} <span class="res-time">${time}</span></li>`;
  }).join('');
  el('results').classList.remove('hidden');
}

function returnToLobby() {
  if (net.roomState === ROOM_STATE.LOBBY) return;
  clearTimeout(endTimer);
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  paused = false;
  raceEnded = false;
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  stopPauseAutoHide();
  if (session) { session.dispose(); session = null; }
  aiBots = new Map(); currentField = [];
  net.broadcast({ type: MSG.GAME_END, results: [] }); // controllers return to lobby
  show('lobby');
  // Crossfade from the frozen finish frame back to the attract demo: drop the race
  // cars + restart the demo under the veil so the reset doesn't pop on screen.
  fadeBackdrop(() => {
    for (const c of scene.cars.keys()) scene.removeCar(c);
    updateBackdrop();             // resume the selected track's 3D preview (or diorama)
    refreshLobbyDemo();           // AI back to driving the picked cars
  });
}

// ---- pause ----
// Any player's controller (or the on-screen pause button) can freeze the race;
// the display is authoritative, so it owns `paused` and tells the controllers.
// "New game" routes through returnToLobby (a full reset), so it isn't handled here.
function pauseRace() {
  if (paused || !session) return;
  if (net.roomState !== ROOM_STATE.COUNTDOWN && net.roomState !== ROOM_STATE.PLAYING) return;
  paused = true;
  session.pause();
  freezeCars();                          // zero each car's speed so dust stops kicking up
  net.broadcast({ type: MSG.GAME_PAUSED });
  setPauseOverlay(true);
}

function resumeRace() {
  if (!paused || !session) return;
  paused = false;
  session.resume();
  net.broadcast({ type: MSG.GAME_RESUMED });
  setPauseOverlay(false);
}

// Re-pose every car at rest (spd 0, no scrub) so the renderer stops emitting
// wheel dust while the field is frozen behind the overlay. Takes an optional
// snapshot so the caller can freeze on a SPECIFIC frame (e.g. the finish moment
// captured before the AI-only fast-forward burst teleports the cars); defaults
// to the live snapshot for the pause path.
function freezeCars(snap) {
  if (!session) return;
  for (const c of (snap || session.getSnapshot()).cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, 0, 0, false, 0);
  }
}

function setPauseOverlay(on) {
  el('pause-overlay').classList.toggle('hidden', !on);
}

// ---- pause button auto-hide ----
// The on-screen pause button lives in the top-right corner, sharing it with each
// cell's place/lap readout. Fade it out after a spell of pointer inactivity so it
// stops covering that text; any mouse move / tap / key press reveals it again.
const PAUSE_IDLE_MS = 2500;     // starting value — long enough to aim + click after moving
let pauseIdleTimer = 0;
function revealPauseBtn() {
  const btn = el('pause-btn');
  if (btn.classList.contains('hidden')) return; // not in a race — nothing to reveal
  btn.classList.remove('is-idle');
  clearTimeout(pauseIdleTimer);
  pauseIdleTimer = setTimeout(() => btn.classList.add('is-idle'), PAUSE_IDLE_MS);
}
function stopPauseAutoHide() { clearTimeout(pauseIdleTimer); el('pause-btn').classList.remove('is-idle'); }
for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  window.addEventListener(ev, revealPauseBtn, { passive: true });
}

el('pause-btn').addEventListener('click', () => { paused ? resumeRace() : pauseRace(); });
el('pause-continue').addEventListener('click', resumeRace);
el('pause-newgame').addEventListener('click', returnToLobby);
el('results-newgame').addEventListener('click', returnToLobby);

// ---- join link → clipboard ----
// Brief confirmation toast; auto-hides. Re-trigger restarts the timer.
let toastTimer = null;
function showToast(msg) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 1600);
}
// Copy with a graceful fallback for non-secure contexts where the async
// Clipboard API isn't available (older setups / plain http).
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
el('joinbox').addEventListener('click', async () => {
  if (!currentJoinUrl) return;
  showToast(await copyText(currentJoinUrl) ? 'Copied' : 'Copy failed');
});

// Gallery / test mode: ?test=1 (or any ?scenario=…) skips the relay and lets
// the TestHarness drive a single screen from fake data. Normal play connects.
const _params = new URLSearchParams(location.search);
const _scenario = _params.get('scenario');
if (_params.get('test') === '1' || _scenario) {
  // Gallery/test. Lobby previews ('welcome'/'lobby') keep the default diorama
  // backdrop (no track picked, matching the real lobby); race previews reveal the
  // 3D scene the harness renders the track + cars into.
  const _scn = _scenario || 'racing';
  if (_scn !== 'welcome' && _scn !== 'lobby') {
    el('scene').classList.remove('hidden');
    const _dio = el('lobby-diorama'); if (_dio) _dio.classList.add('hidden');
  }
  const _int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
  import('./TestHarness.js').then(({ runDisplayScenario }) => runDisplayScenario(
    {
      scenario: _scn,
      players: _int(_params.get('players'), 4),
      host: _params.get('host') === null ? null : _int(_params.get('host'), 0)
    },
    { scene, track, scenePromise }
  ));
} else {
  show('lobby');
  renderRoster([], null); // paint the open-seat placeholders immediately, before anyone joins
  updateBackdrop();       // diorama until the host picks a track (then the 3D preview)
  net.start();
}
window.__net = net; window.__scene = scene; window.__startRace = startRace; window.__track = track;
window.__session = () => session; window.__lobbyDemo = lobbyDemo;
