// Display entry — lobby + authoritative race. Owns the Three.js scene, the car
// engine, the countdown→race→results flow, and per-player PLAYER_STATE.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildTrack, TRACK_LIST } from './TrackBuilder.js';
import { trackSchematic } from './trackSchematic.js';
import { RaceSession } from './RaceSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { LobbyDemo } from './LobbyDemo.js';
import { renderSeats, seatCountText } from './lobbySeats.js';
import { createWakeLock } from '../shared/wakeLock.js';
import { RaceAudio } from './Audio.js';
import { wrapDelta } from './engine/util.js';

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS, CAR_MODELS, MAX_PLAYERS, carStats, RoomFlow } = window;
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
const _isTestMode = !!_trackParams.get('scenario');
// ?solo[=<n>] — DEBUG single-player keyboard mode (no relay, no phones); the
// value picks the car model (bare ?solo = car 0). See DebugSolo.js; wired at
// the bootstrap tail below.
const _isDebugSolo = _trackParams.has('solo');
const _soloCar = (((parseInt(_trackParams.get('solo'), 10) || 0) % CAR_MODELS.length) + CAR_MODELS.length) % CAR_MODELS.length;
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

// CPU seats that top a human roster up to FIELD_SIZE — shared by the race grid
// (buildField) and the lobby attract demo (buildDemoField). Each gets the lowest
// free livery, the model that livery slot maps to (what the renderer already
// drew when carIndex was omitted) + its stats, and a persona cycled by CPU
// index. Callers shape the entry (id key, ai flag) and wire any controller.
function cpuSeats(humans) {
  const used = new Set(humans.map((p) => p.colorIndex));
  const seats = [];
  for (let n = 0; humans.length + seats.length < FIELD_SIZE; n++) {
    const colorIndex = RoomFlow.lowestFreeSlot(used, CAR_COLORS.length);
    used.add(colorIndex);
    const carIndex = colorIndex % CAR_MODELS.length;
    seats.push({ n, persona: AI_PERSONALITIES[n % AI_PERSONALITIES.length], colorIndex, carIndex, stats: carStats(carIndex) });
  }
  return seats;
}

// Build the attract field: each connected human's PICKED car (livery + model), plus
// CPU racers topping the grid up to a full field — every car driven by the AI. The
// ids are namespaced so they never collide with the integer phone slots a later real
// race uses (the race rebuilds its own field on "GO").
function buildDemoField(humans) {
  const field = humans.map((p) => {
    const carIndex = (p.carIndex == null ? p.colorIndex : p.carIndex);
    return { id: 'demo-' + p.peerIndex, name: p.name, colorIndex: p.colorIndex, carIndex, stats: carStats(carIndex) };
  });
  const humanCount = field.length;
  for (const s of cpuSeats(field)) {
    field.push({ id: 'demo-cpu-' + s.n, colorIndex: s.colorIndex, carIndex: s.carIndex, stats: s.stats });
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

// ---- audio ----
// All race/lobby sound — the "toy foley" cue palette (see Audio.js for how the
// sound gallery's picks resolve). Browsers gate audio behind a user gesture, so
// resume() rides the window gesture listeners below; until someone touches the
// display every cue no-ops silently.
const audio = new RaceAudio();

// ---- race state ----
let session = null;
let paused = false;        // race frozen via the pause overlay (display or a controller)
let autoPaused = false;    // race frozen because no connected human holds a car (silent; see refreshAutoPause)
let lastPlayerState = 0;
// AI ("CPU") racers that filled empty seats this race: peerIndex -> controller.
// Empty when four humans race. `currentField` is the full roster (humans + AI),
// kept so the results screen can resolve AI names/liveries (they're not in the lobby).
let aiBots = new Map();
let currentField = [];
let fastForwarding = false; // true only inside the AI-only fast-forward burst
let raceEnded = false;      // race over → freeze the scene behind the (translucent) results overlay until the next race
let debugSolo = null;       // DEBUG ?solo=1 keyboard player (null in normal play); see DebugSolo.js

scene.onFrame = (dt) => {
  if (!session) { lobbyDemo.step(dt); return; } // no race → run the lobby attract demo
  if (paused || autoPaused || raceEnded) return; // frozen: cars hold their last pose
  // During countdown the session exists but isn't racing yet: we still draw
  // the cars and let them react to steering so players can feel their tilt —
  // they just don't move until GO. session.update() is a no-op until racing.
  driveBots();
  if (debugSolo) debugSolo.drive(session); // DEBUG ?solo=1: feed the local keyboard car, same seam as the bots
  session.update(dt * 1000);
  // Every human across the line but CPU cars still circulating? Don't make the
  // humans watch them crawl home — fast-forward the deterministic sim to the
  // flag and show the final board now (the AI get their true finish times).
  if (session.racing && humansAllDone()) {
    // A dropped racer's ghost can never cross the line — forfeit any such car now
    // that every connected human is home, so the burst (and the race) ends
    // promptly instead of running to the guard cap on a car that can't finish.
    for (const id of [...session.engine.cars.keys()]) {
      if (!aiBots.has(id) && net.flow.isDisconnected(id)) forfeitCar(id);
    }
    if (!session.racing) return; // forfeiting the last unfinished car already ended the race
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
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, c.spd, c.onWall, c.steerInput, c.spin, c.boostMul, c.brake);
    // Curb scrub — humans always (their cell shows it), CPU cars only while on
    // some human's camera; RaceAudio spaces the bursts.
    if (c.onWall && c.spd > 0.35 && (!aiBots.has(c.id) || cpuCarOnScreen(c.id))) audio.screech(c.spd);
    // State-driven voices per HUMAN car — each level follows the physics this
    // frame: boost wind from the boost multiplier, tire squeal from hard
    // steering at speed (squared so gentle corrections stay silent; a spinning
    // car's wheels aren't gripping, so no squeal), brake skid from brake
    // pressure while the car still moves. CPU cars stay silent here — they
    // corner and brake constantly, and a 7-car chorus would be noise.
    // Gate thresholds are starting values — tune by ear in ?solo=1.
    if (!aiBots.has(c.id)) {
      audio.boostWind(c.id, c.boostMul);
      const fastGate = Math.max(0, Math.min(1, (c.spd - 0.45) / 0.3));
      audio.cornerSqueal(c.id, c.spin ? 0 : c.steer * c.steer * fastGate);
      audio.brakeSkid(c.id, c.brake * Math.max(0, Math.min(1, (c.spd - 0.2) / 0.4)));
    }
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
  onReconnectChange: renderReconnect,   // dropped seats awaiting a rejoin → QR cards
  onPlayerRekey: rekeyCarPlayer,        // cross-device rejoin: move their car to the new slot
  // Mid-race WELCOME routing: a seat with a car still on track is a rejoin (the
  // phone drops back into the race); one without is a late joiner (the phone
  // waits in its lobby — they get a car when the next race builds its field).
  inRace: (peerIndex) => !!(session && session.engine.cars.has(peerIndex)),
  // Manual pause only: the silent auto-pause lifts on the reconnect itself
  // (refreshAutoPause fires on the roster change), before the WELCOME goes out.
  isPaused: () => paused,
  // Standings are broadcast-only, so a (re)joiner missed every board pushed
  // while they were away. Catch them up: mid-race the live order (a rejoiner
  // whose car already finished flips straight to the results overlay), during
  // results the final board (instead of stranding them on the lobby screen).
  onPlayerWelcomed: (peerIndex) => {
    if (!session) return;
    if (net.roomState === ROOM_STATE.PLAYING) net.sendTo(peerIndex, standingsPayload(session.getResults(), false));
    else if (net.roomState === ROOM_STATE.RESULTS) net.sendTo(peerIndex, standingsPayload(session.getResults(), true));
  },
  onControllerMessage: (from, data) => {
    if (data.type === MSG.CONTROL && session) session.processInput(from, data);
    else if (data.type === MSG.START_GAME && from === net.flow.host && allRacersReady()) startRace();
    // Pause / resume / new game can come from any player's controller.
    else if (data.type === MSG.PAUSE_GAME) pauseRace();
    else if (data.type === MSG.RESUME_GAME) resumeRace();
    else if (data.type === MSG.RETURN_TO_LOBBY) returnToLobby();
  }
});

// Pull a player's car out of the live race. Fires on playerleave — a clean
// back-out (LEAVE) or a dropped seat whose reconnect grace window elapsed. A
// brief mid-race disconnect does NOT come through here: the car is kept running
// (camera stays on it) so a quick reconnect resumes driving.
function forfeitCar(peerIndex) {
  if (!session || !session.forceRemoveCar(peerIndex)) return;
  scene.removeCar(peerIndex);
  audio.stopCarVoices(peerIndex); // its id leaves the loop — no zero-level update will come
}
net.flow.on('playerleave', ({ peerIndex }) => forfeitCar(peerIndex));

// ---- auto-pause ----
// A race with no connected human driving is a race nobody is playing: freeze it
// instead of letting the bots run it to the flag. SILENT on purpose — no pause
// overlay, no GAME_PAUSED broadcast — because the frosted overlay would cover
// the per-seat reconnect QR cards frozen on screen, and those are exactly what
// a dropped party needs to scan back in. The freeze lifts the moment a racer
// reconnects (same device or via their QR). When no human seat is left at all
// (everyone backed out / every grace window expired) there is nothing to wait
// for, so the room returns to the lobby — any late joiners waiting there get
// seated in the next race immediately. Re-checked on every roster change
// (disconnect, reconnect, rekey, leave, seat expiry).
function refreshAutoPause() {
  if (!session || raceEnded) return;
  if (net.roomState !== ROOM_STATE.COUNTDOWN && net.roomState !== ROOM_STATE.PLAYING) return;
  let connected = 0, inGrace = 0;
  for (const id of session.engine.cars.keys()) {
    if (aiBots.has(id)) continue;                 // CPU racer
    if (net.flow.isDisconnected(id)) inGrace++;   // seat held, QR showing
    else if (net.flow.has(id)) connected++;       // human at the wheel
  }
  if (!connected && !inGrace) { returnToLobby(); return; } // no human cars left at all
  autoPaused = connected === 0;
  syncSessionFrozen();
  refreshAbandonTimer();
}
net.flow.on('rosterchange', refreshAutoPause);

// Escape hatch on top of the auto-pause: every racer is gone (only QR seats
// left) while late joiners sit waiting in their lobby. Don't hold the newcomers
// hostage for the full RECONNECT_GRACE_MS — give the dropped party a short
// window to scan back in, then return to the lobby so the next race seats the
// people who are actually here. The timer is disarmed the moment any racer
// reconnects or the last waiting late joiner leaves (both fire rosterchange).
const ABANDONED_RACE_GRACE_MS = window.__abandonGraceMs || 15000; // __abandonGraceMs: E2E hook to shorten the wait
let abandonTimer = null;
function refreshAbandonTimer() {
  const abandoned = autoPaused && lateJoiners().length > 0;
  if (!abandoned) {
    clearTimeout(abandonTimer);
    abandonTimer = null;
  } else if (!abandonTimer) {
    abandonTimer = setTimeout(() => {
      abandonTimer = null;
      if (autoPaused) returnToLobby(); // re-check: state may have shifted since arming
    }, ABANDONED_RACE_GRACE_MS);
  }
}

// A dropped player reconnected on a different device (new peerIndex): move their
// still-racing car — engine, render entry and results identity — onto the new
// slot so that phone drives it and the camera keeps following the same car.
function rekeyCarPlayer(oldId, newId) {
  if (!session || !session.rekeyCar(oldId, newId)) return;
  scene.rekeyCar(oldId, newId);
  audio.stopCarVoices(oldId); // the loop re-creates voices under newId next frame
  for (const p of currentField) { if (p.peerIndex === oldId) p.peerIndex = newId; }
}

// Every race runs a full FIELD_SIZE grid: seats no human took are filled by AI
// ("CPU") racers (see buildField), so a short-handed lobby still gets a real race.
const FIELD_SIZE = MAX_PLAYERS;
const AI_PREFIX = 'ai-';

// Seat grid + headline live in lobbySeats.js (shared with the gallery preview).
let lastRosterCount = 0;
function renderRoster(roster, hostPeerIndex) {
  // A bigger roster means someone joined (renames/car picks keep the count) —
  // greet them with the join plink. Lobby only; mid-race arrivals are reconnects.
  if (roster.length > lastRosterCount && net.roomState === ROOM_STATE.LOBBY) audio.join();
  lastRosterCount = roster.length;
  renderSeats(el('players'), roster.map((p) => ({
    name: p.name, colorIndex: p.colorIndex, carIndex: p.carIndex,
    connected: p.connected, host: p.peerIndex === hostPeerIndex, ready: p.ready
  })));
  el('count').textContent = seatCountText(roster.length);
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Dropped-seat reconnect cards: a QR centred in each disconnected player's
// split-screen cell (same placement as the FINISHED card) so they can scan — their
// own phone OR a new one — and drop back into their exact seat. The card rides on
// their still-racing car via the renderer; SceneRenderer._loop keeps it centred.
// Driven by DisplayNet.onReconnectChange; we diff against what's shown so a roster
// reshuffle only adds/removes the cards that changed.
const _rcShown = new Set(); // car ids currently showing a reconnect card
function renderReconnect(seats) {
  const want = new Set(seats.map((s) => s.peerIndex));
  for (const id of [..._rcShown]) {
    if (!want.has(id)) { scene.setCarReconnect(id, null); _rcShown.delete(id); }
  }
  for (const s of seats) {
    if (_rcShown.has(s.peerIndex)) continue;             // already showing this seat's card
    if (scene.setCarReconnect(s.peerIndex, buildReconnectCard(s))) _rcShown.add(s.peerIndex);
  }
}

// Build the race field: the connected humans plus AI racers topping the grid up
// to FIELD_SIZE (cpuSeats). AI get string ids ('ai-0'…) that never collide with
// the integer phone slots.
function buildField(humans) {
  // carIndex is the player's lobby car pick; each player carries the handling
  // stats resolved from it (carStats wraps + defaults), so the engine can give
  // every car its own accel/top speed/turn/weight + collision footprint.
  const field = humans.map((p) => ({
    peerIndex: p.peerIndex, name: p.name, colorIndex: p.colorIndex,
    carIndex: p.carIndex, stats: carStats(p.carIndex), ai: false
  }));
  aiBots = new Map();
  for (const s of cpuSeats(field)) {
    const peerIndex = AI_PREFIX + s.n;
    field.push({ peerIndex, name: s.persona.name, colorIndex: s.colorIndex, carIndex: s.carIndex, stats: s.stats, ai: true });
    // Seed each bot's wander from the race seed + its NUMERIC index (s.n, not the
    // 'ai-N' id string — number+string coerces to NaN>>>0 = 0, which had been
    // handing every bot the same stream): distinct per bot, fresh per race.
    aiBots.set(peerIndex, new AiController({ ...s.persona, seed: ((track.seed || 1) + s.n) >>> 0 }));
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
// START_GAME gate: the host's "Start race" button is only enabled once every
// other player is ready (controller-side renderReadyFoot); re-checked here so
// a stale or forged START_GAME can't jump the lobby. The host themselves never
// readies — their start IS the commitment.
function allRacersReady() {
  const players = net.flow.list().filter((p) => p.connected);
  return players.length > 0 && players.every((p) => p.ready || p.peerIndex === net.flow.host);
}

function startRace() {
  if (net.roomState !== ROOM_STATE.LOBBY || !sceneReady) return;
  if (!selectedTrackId) return;              // a track must be chosen first
  // Only seat connected players — a dropped racer's seat lingers (dimmed, with a
  // reconnect QR) but doesn't get a car until they're back.
  const players = net.flow.list().filter((p) => p.connected);
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
  autoPaused = false;
  raceEnded = false;             // un-freeze the scene for the new race
  setPauseOverlay(false);
  el('pause-btn').classList.remove('hidden'); // pausable from the countdown on
  revealPauseBtn();                           // show it, then auto-fade until activity

  // (re)build scene cars. AI cars get no split-screen cell (cell:false) — they're
  // opponents in the shared world, not players watching the screen.
  for (const c of [...scene.cars.keys()]) scene.removeCar(c);
  for (const p of field) scene.addCar(p.peerIndex, p.colorIndex, p.name, { cell: !p.ai, carIndex: p.carIndex });
  scene.resetCones(); // a new race starts with the warning rings intact, not where they were knocked
  scene.clearSkids(); // ... and a clean track — last race's rubber patina belongs to last race

  session = new RaceSession(field, track, {
    onRaceEvent,
    onCountdownTick(n) {
      // n > 0: "3/2/1". n === 0: "GO!" (race starts this beat, banner fades out
      // over the next beat via .is-go). n < 0: banner gone.
      el('countdown').textContent = n > 0 ? n : n === 0 ? 'GO!' : '';
      el('countdown').classList.toggle('is-go', n === 0);
      audio.countdown(n);
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

// A CPU car is "on screen" when it sits in some human's chase view: the camera
// hangs ~2 units behind its car looking ahead, so the visible stretch is from
// just behind a human to a run of track in front. Starting values (tune by ear
// in ?solo=1): beyond ~20 units a car is a speck, behind the camera it's gone.
const VIS_BEHIND = 2, VIS_AHEAD = 20;
function cpuCarOnScreen(id) {
  if (!session) return false;
  const cpu = session.engine.cars.get(id);
  if (!cpu) return false;
  for (const [hid, h] of session.engine.cars) {
    if (aiBots.has(hid)) continue;
    const ds = wrapDelta(cpu.totalS - h.totalS, session.engine.length);
    if (ds >= -VIS_BEHIND && ds <= VIS_AHEAD) return true;
  }
  return false;
}

// Map engine events onto cues — sound only for what's VISIBLE (same principle
// as the controller haptics: feedback must map to something the player can
// see). A human's moments are always on screen (their split-screen cell); a
// CPU car's world moments (boost, banana, spin) sound only while it's in a
// human's view. HUD-narration cues stay human-only regardless: the roulette
// describes the player's item slot, and lap / finish narrate their cell's HUD.
function audioForRaceEvent(e) {
  const isHuman = e.id == null || !aiBots.has(e.id);
  const visible = isHuman || cpuCarOnScreen(e.id);
  switch (e.type) {
    case 'pickup':
      if (isHuman) audio.pickup();          // pop + roulette tick-down
      else if (visible) audio.pickupPop();  // a CPU grab on camera: just the world pop
      break;
    // (boost item-use and pad crossings make no one-shot sound — the boost
    // WIND in onFrame tracks the resulting speed state instead.)
    case 'item_use': if (visible && e.item === 'banana') audio.bananaDrop(); break;
    case 'spin': if (visible) audio.spin(); break;
    // The chequered-flag crossing chimes like any other lap (a 'finish' fanfare
    // was auditioned and cut) — the results overlay carries the celebration.
    case 'lap': case 'finish': if (isHuman) audio.lap(); break;
  }
}

function onRaceEvent(e) {
  // As each car crosses the line, push the running standings so a finished
  // player's phone flips to the results overlay and it fills in for everyone
  // else as more cars finish.
  if (!e) return;
  if (!fastForwarding) audioForRaceEvent(e); // the fast-forward burst is silent — it's skipping, not racing
  if (e.type !== 'finish') return;
  if (fastForwarding) return; // endRace sends the final board once; don't spam one per AI car
  // If that finish was the last human's, we're about to fast-forward to the flag
  // (only CPU cars remain) and endRace will send the final board — skip this
  // intermediate push so the last human jumps straight to results, no flash of
  // the "FINISHED" hero for a race that's effectively already decided.
  if (humansAllDone()) return;
  broadcastStandings(false);
}

// True once every CONNECTED human car has crossed the line (CPU cars may still be
// out). Drives the "only CPU left → skip to results" fast-forward. A dropped
// racer's ghost is skipped: it can never finish (no input), so it must not hold
// the flag down and make everyone else wait out the reconnect grace window —
// the courtesy path forfeits it. False when no connected humans are left (a
// fully-AI / fully-dropped field; the race-timeout failsafe covers that).
function humansAllDone() {
  if (!session) return false;
  let humans = 0;
  for (const [id, c] of session.engine.cars) {
    if (aiBots.has(id)) continue;               // a CPU racer
    if (net.flow.isDisconnected(id)) continue;  // a dropped racer's ghost — doesn't hold up the flag
    humans++;
    if (!c.finished) return false;              // a connected human still on track
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
  const order = results.results.map((res) => {
    const p = byId.get(res.playerId) || {};
    return {
      playerId: res.playerId,
      name: p.name || String(res.playerId),
      colorIndex: p.colorIndex == null ? 0 : p.colorIndex,
      ai: !!p.ai,
      finished: !!res.finished,
      time: res.time
    };
  });
  // Anyone who joined mid-race has no car this round (the field is locked at
  // the start) — list them under the racers, flagged `joining`, so every board
  // shows who's waiting on the next race instead of silently omitting them.
  for (const p of lateJoiners()) {
    order.push({ playerId: p.peerIndex, name: p.name, colorIndex: p.colorIndex, joining: true });
  }
  return {
    type: MSG.STANDINGS,
    over: !!over,
    hostPeerIndex: net.flow.host,
    total: results.results.length,
    order
  };
}

// Connected players without a car in the current race — they joined after the
// field was locked and ride the next one (see the `joining` rows above).
// Both callers (standingsPayload + showResults) run synchronously inside the
// same endRace flow, so the two boards always agree on who's joining.
function lateJoiners() {
  const byId = new Map(currentField.map((p) => [p.peerIndex, p]));
  return net.flow.list().filter((p) => p.connected !== false && !byId.has(p.peerIndex));
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
  audio.stopVoices();                          // the frozen frame must not hold wind/squeal voices open
  paused = false;                              // results aren't pausable
  autoPaused = false;
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
  const list = el('results-list');
  list.innerHTML = '';
  for (const res of results.results) {
    const p = byId.get(res.playerId) || {};
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'stand__dot';
    dot.style.background = CAR_COLORS[p.colorIndex] || '#888';
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = res.finished ? `${res.time.toFixed(1)}s` : 'DNF';
    // The name is player-supplied — appended as TEXT, never markup (same rule as
    // the controller's results list and renderJoinUrl).
    li.append(dot, ` ${(p.name || res.playerId)}${p.ai ? ' (CPU)' : ''} `, time);
    list.appendChild(li);
  }
  // Late joiners under the field: no rank or time — they're in the next race.
  for (const p of lateJoiners()) {
    const li = document.createElement('li');
    li.className = 'is-joining';
    const dot = document.createElement('span');
    dot.className = 'stand__dot';
    dot.style.background = CAR_COLORS[p.colorIndex] || '#888';
    const time = document.createElement('span');
    time.className = 'res-time';
    time.textContent = 'Next race';
    li.append(dot, ` ${p.name} `, time);
    list.appendChild(li);
  }
  el('results').classList.remove('hidden');
}

function returnToLobby() {
  if (net.roomState === ROOM_STATE.LOBBY) return;
  clearTimeout(endTimer);
  clearTimeout(abandonTimer); abandonTimer = null;
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  // Reachable straight from a live race (controller RETURN_TO_LOBBY, solo's R
  // key) — kill any state voices or a boost wind would drone on in the lobby.
  audio.stopVoices();
  paused = false;
  autoPaused = false;
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
  syncSessionFrozen();
  net.broadcast({ type: MSG.GAME_PAUSED });
  setPauseOverlay(true);
}

function resumeRace() {
  if (!paused || !session) return;
  paused = false;
  syncSessionFrozen();
  net.broadcast({ type: MSG.GAME_RESUMED });
  setPauseOverlay(false);
}

// The sim is frozen while EITHER pause is set (manual overlay pause OR the
// silent auto-pause), so the two compose: a manual resume while every racer is
// still disconnected keeps the field frozen, and a reconnect during a manual
// pause keeps the overlay's authority. Sync the session's timers to the
// combined state instead of letting each path drive pause()/resume() directly.
function syncSessionFrozen() {
  if (!session) return;
  const frozen = paused || autoPaused;
  if (frozen && !session.paused) {
    session.pause();
    audio.stopVoices();                  // frozen cars must not keep their wind/squeal going
    freezeCars();                        // zero each car's speed so dust stops kicking up
  } else if (!frozen && session.paused) {
    session.resume();
  }
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
// Unlock audio on the first real gesture (pointermove is not a user activation,
// so it can't resume a suspended AudioContext — only clicks/keys count).
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => audio.resume(), { passive: true });
}
// Until that gesture happens the page is silently muted — surface it, or a solo
// auto-race / an untouched TV reads as "the game has no sound". The pill shows
// while audio is locked and disappears the moment it unlocks; clicking it is a
// gesture, so the window pointerdown listener above does the actual resume.
// Hidden on gallery/test surfaces (their iframes never get gestures) and where
// Web Audio doesn't exist (nothing to unlock).
const _audioSupported = !!(window.AudioContext || window.webkitAudioContext);
if (!_isTestMode && _audioSupported) {
  setInterval(() => el('sound-hint').classList.toggle('hidden', audio.ready), 500);
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

// Keep the display awake for the whole session — the lobby IS the join screen
// (QR + attract demo), so the screen sleeping there is as bad as mid-race.
// Re-acquired on tab return; no-op where unsupported. Gallery/test surfaces are
// dev previews and skip it.
const wakeLock = createWakeLock();
if (!_isTestMode) wakeLock.enable();

// ---- device chooser ----
// The display URL opened on a phone-sized screen (see #device-choice in
// index.html + display.css): most likely someone followed the wrong link while
// trying to JOIN a game, so don't open a room until they commit to running the
// big screen here. On big screens (and test/solo surfaces, which dismiss
// up front) we mark it dismissed immediately, so resizing the window
// mid-session can never surface the chooser over a live lobby or race.
function dismissDeviceChoice() { document.documentElement.classList.add('device-choice-dismissed'); }
function startWhenDeviceChosen() {
  const choice = el('device-choice');
  if (!choice || getComputedStyle(choice).display === 'none') {
    dismissDeviceChoice();
    net.start();
    return;
  }
  window.__deviceChoicePending = true; // E2E hook: the boot took the deferred path
  let chosen = false;
  const proceed = () => {
    if (chosen) return;
    chosen = true;
    window.__deviceChoicePending = false;
    window.removeEventListener('resize', onResize);
    dismissDeviceChoice();
    net.start();
  };
  // The chooser's visibility is pure CSS (the display.css media query): if the
  // window grows past the trigger — a small desktop window getting maximised —
  // the overlay vanishes on its own, so treat that as choosing the big screen
  // or the room would never open. Reading the computed style on resize keeps
  // the breakpoint defined in exactly one place (the CSS).
  const onResize = () => { if (getComputedStyle(choice).display === 'none') proceed(); };
  el('device-continue').addEventListener('click', proceed);
  window.addEventListener('resize', onResize);
}

// Gallery / test mode: any ?scenario=… skips the relay and lets the
// TestHarness drive a single screen from fake data. Normal play connects.
const _params = new URLSearchParams(location.search);
const _scenario = _params.get('scenario');
if (_scenario) {
  dismissDeviceChoice(); // gallery iframes are small — keep the chooser away
  // Gallery/test. Lobby previews ('welcome'/'lobby') keep the default diorama
  // backdrop (no track picked, matching the real lobby); race previews reveal the
  // 3D scene the harness renders the track + cars into.
  const _scn = _scenario;
  if (_scn !== 'welcome' && _scn !== 'lobby' && _scn !== 'device-choice') {
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
} else if (_isDebugSolo) {
  // DEBUG ?solo=1: one local keyboard player on the main display, no relay. The
  // module seats a synthetic human in net.flow and feeds the keyboard through the
  // normal engine input path, so the whole race lifecycle runs unchanged. Booting
  // through the lobby (not the test harness) keeps that path identical to live play.
  dismissDeviceChoice(); // dev surface — never block it on the chooser
  show('lobby');
  renderRoster([], null);
  updateBackdrop();
  import('./DebugSolo.js').then(({ DebugSolo }) => {
    debugSolo = new DebugSolo({
      net, scenePromise,
      startRace, returnToLobby, selectTrack,
      defaultTrackId: selectedTrackId || TRACK_LIST[0].id,
      carIndex: _soloCar,
    });
    window.__debugSolo = debugSolo;
    debugSolo.start();
  });
} else {
  show('lobby');
  renderRoster([], null); // paint the open-seat placeholders immediately, before anyone joins
  updateBackdrop();       // diorama until the host picks a track (then the 3D preview)
  startWhenDeviceChosen(); // net.start(), gated on the device chooser where it shows
}
window.__net = net; window.__scene = scene; window.__startRace = startRace; window.__track = track; window.__audio = audio;
window.__session = () => session; window.__lobbyDemo = lobbyDemo; window.__wakeLock = wakeLock;
window.__sceneReady = scenePromise; // awaited by E2E before starting a race (startRace gates on sceneReady)

// Debug settings (faint wrench, bottom-left): interactive editor for this
// page's query params — edits reload the page so each param takes effect
// through its normal boot path above. Lazy import: dev aid, not boot-critical.
import('../shared/debugPanel.js').then(({ initDebugPanel }) => initDebugPanel([
  { section: 'Test harness' },
  { key: 'scenario', label: 'Scenario', hint: 'no relay, fake players', type: 'select',
    options: ['welcome', 'device-choice', 'lobby', 'track', 'features', 'countdown', 'racing', 'results']
      .map((s) => ({ value: s, label: s })) },
  { key: 'players', label: 'Players', hint: 'fake roster size', type: 'int', min: 1, max: MAX_PLAYERS },
  { key: 'host', label: 'Host seat', hint: 'blank = no host', type: 'int', min: 0, max: MAX_PLAYERS - 1 },
  { section: 'Solo drive' },
  { key: 'solo', label: 'Solo keyboard', hint: 'pick a car; no phones needed', type: 'select', bare: '0',
    options: CAR_MODELS.map((_, i) => ({ value: String(i), label: window.CAR_NAMES[i] })) },
  { section: 'Track' },
  { key: 'track', label: 'Preselect', type: 'select',
    options: TRACK_LIST.map((t) => ({ value: t.id, label: t.name })) },
  { key: 'centerline', label: 'Racing line', hint: 'magenta ribbon overlay', type: 'flag' },
  { section: 'Rendering' },
  { key: 'msaa', label: 'MSAA', hint: 'default off (perf)', type: 'select',
    options: [{ value: '0', label: 'off' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }] },
  { key: 'bbox', label: 'Collision boxes', type: 'flag' },
  { key: 'carview', label: 'Car thumbs', type: 'select',
    options: [{ value: 'spin', label: 'spin' }, { value: 'still', label: 'still' }] },
], { title: 'Display' }));
