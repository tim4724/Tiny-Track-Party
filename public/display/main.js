// Display entry — lobby + authoritative race. Owns the Three.js scene, the car
// engine, the countdown→race→results flow, and per-player PLAYER_STATE.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { SceneRenderer } from './SceneRenderer.js';
import { buildTrack, TRACK_LIST } from './TrackBuilder.js';
import { CANDIDATE_TRACKS } from '../shared/candidateTracks.js';
import { DEV_TRACKS } from '../shared/devTracks.js';
import { themeByName, BIOME_NAMES } from '../shared/themes.js';
import { trackSchematic } from './trackSchematic.js';
import { RaceSession } from './RaceSession.js';
import { AiController, AI_PERSONALITIES } from './AiDriver.js';
import { LobbyDemo } from './LobbyDemo.js';
import { renderSeats, renderCupSlot } from './lobbySeats.js';
import { createWakeLock } from '../shared/wakeLock.js';
import { RaceAudio, RACE_MUSIC } from './Audio.js';
import { setSteerExpo, getSteerExpo, ITEM_IDS } from './engine/Game.js';
import { CupSeries, makeShuffleBag } from './GrandPrix.js';
import { CUPS } from '../shared/tracks.js';

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
function buildEntry(t) {
  const b = buildTrack(t);   // dispatches: t.waypoints → spline, else t.segments
  b.cup = t.cup;             // carry the cup id onto the geometry → SceneRenderer picks the biome theme
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
  // Boost pads + item boxes: same u→s resolve. Every trigger radius is the PROP's
  // own size — the engine tests it against the car's oriented body rectangle
  // (Game._carTouchesCircle), so the car's reach comes from the car, and tunneling
  // is covered by its half-length. Pads keep ~18% of road width: that's the painted
  // disc itself (edge-clipping the paint arms it). Read by the engine (detection)
  // + renderer (meshes).
  const u2s = (u) => (((u % 1) + 1) % 1) * b.length;
  b.pads = (t.pads || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * 0.18 }));
  // Every looping gets a full-width RECTANGULAR launch strip at its mouth, so a loop is
  // always entered on boost. The strip sits flat on the approach with its leading edge at
  // the loop entry (centre = entry − halfLen). Position-scaled like any pad (the engine
  // reads `shape: 'strip'` → a longitudinal band across the lane).
  const LOOP_PAD_LEN = 2.2; // world units along travel
  for (const ls of (b.loopStarts || [])) {
    b.pads.push({
      s: (((ls.s - LOOP_PAD_LEN / 2) % b.length) + b.length) % b.length,
      lat: 0, shape: 'strip', halfLen: LOOP_PAD_LEN / 2, halfWidth: ls.width / 2
    });
  }
  // Item boxes: ~6% of road width (0.3 on the standard 5-wide road) ≈ the floating
  // box mesh + a small forgiveness margin — "I touched it, I got it".
  b.boxes = (t.boxes || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * 0.06 }));
  // Support poles: same u→s resolve. SOLID obstacles (engine collision) — read by the
  // engine (car push-out), the AI (dodge it like an oil), and the renderer (the post mesh).
  // The builder's autoPoles ride along: collision proxies for pillars/loop shafts that
  // stand in a drivable corridor (ghost — already drawn as the support itself).
  b.poles = (t.poles || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : 0.45 }))
    .concat(b.autoPoles || []);
  // Authored bananas (dev tracks only — see shared/devTracks.js): same u→s resolve.
  // The engine seeds them live at race start and respawns them after each hit.
  b.bananas = (t.bananas || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0 }));
  return b;
}
const built = new Map(TRACK_LIST.map((t) => [t.id, buildEntry(t)]));
const trackCatalog = TRACK_LIST.map((t) => ({
  id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
  svg: trackSchematic(built.get(t.id))
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
// ?item=<id> — DEBUG: every item-box roll returns this item (e.g. ?item=monster on the
// gym track). Unknown ids are ignored. ?bots=<n> — DEBUG: cap the AI fill to n bots
// (?bots=0 = race alone) instead of topping up to FIELD_SIZE.
const _qForceItem = ITEM_IDS.includes(_trackParams.get('item')) ? _trackParams.get('item') : null;
const _qBots = _trackParams.has('bots') ? Math.max(0, parseInt(_trackParams.get('bots'), 10) || 0) : null;
// AUDITION CANDIDATES (gallery-tracks sections): an unknown ?track= id is looked up in
// the candidate catalogue and built like any track — but only the ONE requested id, and
// only in a ?scenario= test surface: a LIVE lobby preselecting a candidate would offer
// phones a track their picker catalog doesn't contain. Candidates live outside
// TRACKS/CUPS until one is promoted (scripts/gen-candidates.mjs).
// DEV_TRACKS (shared/devTracks.js) ride the same rule, additionally reachable in
// ?solo (they're keyboard test ranges — e.g. the 'gym' collision track).
if ((_isTestMode || _isDebugSolo) && _qTrack && !built.has(_qTrack)) {
  const _devDef = CANDIDATE_TRACKS[_qTrack] || DEV_TRACKS[_qTrack];
  if (_devDef) built.set(_qTrack, buildEntry({ id: _qTrack, ..._devDef }));
}
let selectedTrackId = (_qTrack && built.has(_qTrack)) ? _qTrack : null;
let track = built.get(selectedTrackId || TRACK_LIST[0].id);
track.totalLaps = TOTAL_LAPS;

// ---- scene ----
// Preload the UNION of every track's tiles up front, so the host can switch
// tracks in the lobby with no load hitch. The renderer orbits the selected track
// as a live lobby preview (scene.orbit).
const allGlbs = [...new Set([...built.values()].flatMap((b) => b.instances.map((i) => i.glb)))];
const scene = new SceneRenderer(el('scene'), CAR_COLORS);
// ?biome=<name> — inspector override: force a biome on every track regardless of its cup
// (compare any track in any biome). Off by default; an unknown name is ignored (cup decides).
const _qBiome = _trackParams.get('biome');
if (_qBiome) scene.biomeOverride = themeByName(_qBiome);
// ?dividers=0 — drop the chunky ink lines between split-screen cells (default
// ON; a debug-panel toggle so the look can be A/B'd at a party).
scene.showDividers = _trackParams.get('dividers') !== '0';
if (_isTestMode) window.__scene = scene; // test surfaces: let the inspector/automation drive the camera
scene.orbit = true;
scene.bboxOrbit = true; // lobby sweeps an ellipse around the track's bounding box (close, elongated like the track)
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
    // Swap the picked track with a crossfade — see fadeBackdrop. Track→track dissolves one
    // circuit straight into the next; the very first pick reveals the track over the diorama
    // (the default background). The build (geometry + demo cars) runs under cover either way.
    fadeBackdrop(() => {
      scene.setTrack(track, { debug: _showCenterline });
      refreshLobbyDemo();
    });
  } else {
    updateBackdrop();
  }
}

// Lobby backdrop: the sunny diorama is the persistent base layer; the 3D #scene sits over
// it and is shown/hidden by OPACITY (.is-dim), not display, so it can crossfade straight in
// over the diorama. No track picked (and not racing) → dim, so the diorama shows through.
function updateBackdrop() {
  const show3D = !!selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY);
  const sc = el('scene');
  sc.classList.remove('hidden');           // visibility is by opacity now, not display
  sc.classList.toggle('is-dim', !show3D);
}

// ---- lobby backdrop crossfade ----
// Two transitions share this helper, picked by whether a track is already on screen:
//
//  • track → track (a track is showing): a TRUE crossfade between circuits. Freeze the
//    current track as a still over #scene (scene.snapshot), run `mid` to rebuild the live
//    canvas to the new track UNDERNEATH the still, then fade the still out so the new track
//    emerges through the old. It never dips through the diorama background.
//  • diorama → track (the very first pick — #scene still transparent): there's no outgoing
//    track to dissolve from, so reveal the just-built track over the diorama by fading
//    #scene's own opacity in.
//
// `mid` (swap track, rebuild demo cars, drop the frozen race field…) always runs under cover.
// FADE_MS mirrors the opacity transitions on #scene / #scene-snap in display.css.
const FADE_MS = 450;
let fadeTimer = null, snapTimer = null, fadeGen = 0;
function fadeBackdrop(mid) {
  const sc = el('scene');
  if (!sc) { mid(); return; }
  const dio = el('lobby-diorama'); if (dio) dio.classList.remove('hidden'); // base for the first reveal
  // Clear any in-flight crossfade so rapid track-cycling can't stack stills / fade timers.
  // fadeGen invalidates any deferred build still queued from a superseded pick (see below).
  clearTimeout(fadeTimer); clearTimeout(snapTimer);
  const gen = ++fadeGen;
  const oldSnap = el('scene-snap'); if (oldSnap) oldSnap.remove();

  const buildThenFadeIn = () => {
    // try/finally so a throw in mid() can never leave the backdrop stuck transparent.
    try { mid(); }
    finally {
      sc.classList.remove('hidden');
      sc.classList.add('is-dim');           // hold the just-built track transparent for one frame…
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const show3D = !!selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY);
        sc.classList.toggle('is-dim', !show3D); // …then fade it in over the diorama
      }));
    }
  };

  const visible = !sc.classList.contains('hidden') && !sc.classList.contains('is-dim');
  if (!visible) { buildThenFadeIn(); return; }   // first reveal → diorama → track

  // A track is on screen: dissolve it straight into the next one. The still is a frozen frame
  // of the OUTGOING track; the live #scene rebuilds to the new track behind it.
  const still = scene.snapshot();
  if (!still) {                                  // capture unavailable → fall back to the dip
    sc.classList.add('is-dim');
    fadeTimer = setTimeout(buildThenFadeIn, FADE_MS);
    return;
  }
  still.id = 'scene-snap';
  sc.appendChild(still);                         // sits over the live canvas, inside #scene's z-0 layer
  sc.classList.remove('is-dim');                 // the live track stays fully opaque beneath the still
  // Order matters: start the fade FIRST, rebuild the track a frame LATER. An opacity
  // transition runs on the compositor, so it keeps animating even while the main thread is
  // busy — whereas setTrack blocks the thread for tens of ms (and the orbit with it). By the
  // time the rebuild runs the compositor already owns the fade, so the hitch happens UNDER a
  // still that's visibly dissolving and the preview never appears to stop. (The very first
  // reveal masks the same block with the compositor-animated diorama; see buildThenFadeIn.)
  // Until the rebuild swaps it, the live layer is still the OUTGOING track — same as the
  // still on top, so the early fade shows no change. mid() reads the latest pick, and a fast
  // re-pick supersedes this whole chain via fadeGen.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== fadeGen) return;                 // superseded by a newer pick
    still.classList.add('is-fading');            // hand the dissolve to the compositor…
    snapTimer = setTimeout(() => { still.remove(); }, FADE_MS);
    requestAnimationFrame(() => {                // …then rebuild a frame later, hidden behind it
      if (gen !== fadeGen) return;               // a newer pick (or leaving the lobby) cancelled us
      if (!(sceneReady && net.roomState === ROOM_STATE.LOBBY)) { // race started under us → drop the still
        clearTimeout(snapTimer); still.remove(); return;
      }
      mid();
    });
  }));
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
  // ?bots=<n> caps the AI fill (debug); default tops the grid up to FIELD_SIZE.
  const fill = _qBots != null ? Math.min(FIELD_SIZE, humans.length + _qBots) : FIELD_SIZE;
  for (let n = 0; humans.length + seats.length < fill; n++) {
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
window.__audio = audio; // debug hook (alongside __engine/__track) — tune music/SFX by ear in ?solo

// Now-playing credit chip (bottom-left): the current track + artist, linking to
// its source — and the on-screen CC-BY attribution. Filled from the track
// descriptor; toggled with the music lifecycle (shown on GO, hidden at results /
// lobby). Values are static config, so textContent/href are safe to set raw.
function showMusicCredit(on) {
  const mc = el('music-credit');
  if (!mc) return;
  if (on) {
    mc.textContent = `${RACE_MUSIC.title} · ${RACE_MUSIC.artist}`;
    mc.href = RACE_MUSIC.source;
    mc.title = `${RACE_MUSIC.title} by ${RACE_MUSIC.artist} — ${RACE_MUSIC.license} (source ↗)`;
  }
  mc.classList.toggle('hidden', !on);
}

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
  let bestScrub = null; // loudest curb scrub this frame — fired ONCE after the loop (see below)
  for (const c of snap.cars) {
    scene.setCarMonster(c.id, !!c.monster); // morph to/from the monster truck (idempotent)
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, { steer: c.steer, spd: c.spd, scrub: c.onWall, steerInput: c.steerInput, spin: c.spin, boostMul: c.boostMul, brake: c.brake });
    // Curb scrub — loudness by distance to the nearest human (the player's own car
    // is at distance 0 → the ceiling). Unlike the one-shot cues this is a continuous
    // grind on a single shared throttle, so only in-scene scrubs (≥ the FLOOR)
    // compete and the loudest wins the window — a distant AI wall-grind can't claim it.
    if (c.onWall && c.spd > 0.35) {
      const g = audibility(c.pose && c.pose.pos);
      if (g >= AUD_FLOOR && (!bestScrub || g > bestScrub.g)) bestScrub = { spd: c.spd, g };
    }
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
      // Engine voice — pitch + level rise with speed (recorded loop, RPM=rate).
      // Divisor maps normal top speed (~1.0) to near-full and lets boost (~1.6)
      // peg the top of the range; starting value, tune by ear in ?solo=1. While a
      // monster truck, the same loop deepens into a heavy big-truck growl.
      audio.engineDrive(c.id, c.spd / 1.2, c.monster);
    }
  }
  if (bestScrub) audio.screech(bestScrub.spd, bestScrub.g); // the nearest scrub owns the shared throttle
  scene.syncProps(snap); // show/hide item boxes + reconcile dropped-banana meshes
  driveRocketAudio(snap); // sustained jet per in-flight rocket, level by distance to the nearest player
  if (!session.racing) return; // countdown: visible + steerable, but no HUD yet
  // throttle HUD + PLAYER_STATE to ~6 Hz
  const now = performance.now();
  if (now - lastPlayerState > 160) {
    lastPlayerState = now;
    for (const c of snap.cars) {
      scene.setCarHud(c.id, c); // the TV's own HUD still shows place/lap from the car directly
      if (aiBots.has(c.id)) continue; // no phone behind an AI car
      // The phone HUD shows no place/lap (standings live on the TV) and reads only the
      // held item — so PLAYER_STATE now carries just that. Still sent periodically (not
      // only on change) so a (re)joiner mid-race gets their ITEM button relit. A finished
      // car keeps an item internally (victory-lap box pops, see Game._enterBox) but can't
      // use it, so report an empty slot — the USE button stays dark on the results overlay.
      net.sendTo(c.id, { type: MSG.PLAYER_STATE, item: c.finished ? null : c.item });
    }
  }
};

// ---- net ----
// Random-mode track draws: one bag for the room's lifetime, so "random" walks
// the whole catalogue before any repeat (page RNG, like track.seed).
const randomBag = makeShuffleBag(TRACK_LIST.map((t) => t.id), Math.random);
let currentJoinUrl = '';   // full join link (same string the QR encodes); set on room-ready
const net = new DisplayNet({
  trackCatalog,
  defaultTrackId: selectedTrackId,
  drawRandomTrack: () => randomBag.draw(),
  // selectTrack swaps the 3D preview; renderLobbyPick refreshes the cup slot
  // even when the resolved trackId didn't change (e.g. a mode switch landing
  // on the same circuit, where selectTrack early-returns).
  onTrackChange: (id) => { selectTrack(id); renderLobbyPick(); },
  onRoomReady: async ({ roomCode, joinUrl }) => {
    // The room code rides along in the join URL's path; the ticket shows one
    // URL line with the trailing code highlighted in the accent colour.
    currentJoinUrl = joinUrl;                   // the full link the join ticket copies
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
    // Host's "Next race" during a cup intermission (advanceSeriesRace re-checks room state).
    else if (data.type === MSG.SERIES_NEXT && from === net.flow.host) advanceSeriesRace();
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

// The TV tab going away IS the party ending: tear the room down so every phone
// bails to its "Race over" screen at once (their sockets close 4001) and stale
// join/rejoin links die with the room, instead of everyone waiting out the
// relay's ~2 min hostless grace. pagehide also fires on a RELOAD — accepted:
// a reloaded display simply opens a fresh room (reload isn't a real use case
// on a TV). If the send never flushes (bfcache freeze, crash — no pagehide at
// all), the room survives and the sessionStorage rejoin in DisplayNet turns
// the next load into a crash recovery that regathers the party instead.
window.addEventListener('pagehide', () => net.shutdown());

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
  if (series) series.rekey(oldId, newId); // banked cup points follow the player, car or no car
  if (!session || !session.rekeyCar(oldId, newId)) return;
  scene.rekeyCar(oldId, newId);
  audio.stopCarVoices(oldId); // the loop re-creates voices under newId next frame
  for (const p of currentField) { if (p.peerIndex === oldId) p.peerIndex = newId; }
}

// Every race runs a full FIELD_SIZE grid: seats no human took are filled by AI
// ("CPU") racers (see buildField), so a short-handed lobby still gets a real race.
const FIELD_SIZE = MAX_PLAYERS;
const AI_PREFIX = 'ai-';

// ---- Grand Prix series ----
// Picking a cup runs its 4 tracks back-to-back: each endRace banks points into
// `series` (GrandPrix.js), holds the room in RESULTS for an intermission, then
// chains straight into the next race (advanceSeriesRace) — the lobby only
// returns after the podium (or on any quit path, which cancels the series).
const INTERMISSION_MS = 10000;  // auto-advance budget; the host can advance early
let series = null;              // live CupSeries, or null (single race / no cup)
let seriesTimer = null;         // auto-advance timeout (armed per intermission)
let seriesDeadline = 0;         // when it fires — the countdown label reads this
let intermissionTicker = null;  // ½ s "starting in N…" refresh

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
  renderLobbyPick();   // the pre-pick cup slot names the host — track joins/renames
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Lobby right-rail cup slot, driven by the same state as the phones'
// track-pick UI (net.mode/cupId/trackId). Pre-pick the slot is empty;
// post-pick it shows the race card (cup / exact track / random). The scan
// hint under the ticket stays up for the whole lobby — joining is possible
// until the race starts.
function renderLobbyPick() {
  const slot = el('cup-slot');
  if (!slot) return;
  const svgOf = (id) => { const t = trackCatalog.find((e) => e.id === id); return t && t.svg; };
  let state;
  if (net.mode === 'cup') {
    const cup = CUPS.find((c) => c.id === net.cupId);
    const entry = trackCatalog.find((t) => t.cup === net.cupId);
    state = {
      name: cup ? cup.name : '?',
      races: `${cup ? cup.tracks.length : 4} races`,
      difficulty: entry ? entry.cupDifficulty : null,
      // the cup's circuits as numbered minis — the GP menu at a glance
      maps: cup ? cup.tracks.map((id, i) => ({ svg: svgOf(id), n: i + 1 })) : [],
      cupId: net.cupId   // biome-tints the mini fields, like the phone picker
    };
  } else if (net.mode === 'track') {
    const entry = trackCatalog.find((t) => t.id === net.trackId);
    state = {
      name: entry ? entry.name : '?',
      races: '1 race',
      difficulty: entry ? entry.cupDifficulty : null,
      maps: [{ svg: svgOf(net.trackId) }],
      cupId: entry ? entry.cup : null
    };
  } else if (net.mode === 'random') {
    // an endless surprise series — the sticker sells the mode; the map shows
    // this round's draw (it's also what the preview is orbiting)
    const entry = trackCatalog.find((t) => t.id === net.trackId);
    state = {
      name: 'Random', races: 'endless', difficulty: null,
      maps: [{ svg: svgOf(net.trackId) }],
      cupId: entry ? entry.cup : null
    };
  } else {
    state = null;   // no pick yet — the slot stays empty
  }
  renderCupSlot(slot, state);
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
  // Cup mode: this Start commits to the whole Grand Prix — the series engine
  // walks the cup from race 1 (the lobby preview already sits on it — the cup
  // pick resolved trackId to its first track). Random mode: an ENDLESS series
  // seeded with the previewed draw, each intermission pulling the next track
  // from the bag; only a lobby return ends it. Exact picks stay single races.
  series = net.mode === 'cup' ? new CupSeries(CUPS.find((c) => c.id === net.cupId))
    : net.mode === 'random' ? new CupSeries({ id: 'random', name: 'Random', tracks: [net.trackId] }, { drawNext: () => randomBag.draw() })
      : null;
  launchRace(players);
}

// The actual race launch, shared by the lobby start above and the series chain
// (advanceSeriesRace) — everything from here down assumes the go/no-go guards
// already passed and `track` is the circuit to race.
function launchRace(players) {
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
      const cd = el('countdown');
      cd.textContent = n > 0 ? n : n === 0 ? 'GO!' : '';
      cd.classList.toggle('is-go', n === 0);
      // slap each numeral in (re-add .slap around a reflow so the animation
      // restarts on the same element); GO! keeps its own is-go fade-out.
      cd.classList.remove('slap');
      if (n > 0) { void cd.offsetWidth; cd.classList.add('slap'); }
      audio.countdown(n);
      // The n<0 beat only clears the LOCAL banner — never broadcast it. The
      // phones' COUNTDOWN handler flips them onto the drive HUD, so a race that
      // ends within a second of GO (fast-forwarded finishes under test) would
      // otherwise have this trailing beat land AFTER the final standings and
      // yank their results board back to the wheel.
      if (n >= 0) net.broadcast({ type: MSG.COUNTDOWN, n });
    },
    onRaceStart() {
      // Fires on the "GO!" beat — physics are live and the GO! banner is still
      // up (it clears on the next tick). Fail-safe note: RaceSession enforces
      // MAX_RACE_MS internally so AFK/DNF cars can't hang the room forever. A
      // clean 3-lap is ~50-80 s.
      net.flow.transitionTo(ROOM_STATE.PLAYING);
      net.broadcast({ type: MSG.GAME_START });
      audio.startMusic();                      // background track for the whole race
      showMusicCredit(true);                   // now-playing credit chip (bottom-left)
    },
    onRaceEnd: endRace,
  });
  if (_qForceItem) session.engine.forceItem = _qForceItem; // ?item=<id>: every box rolls this
  window.__engine = session.engine;

  // Place cars at their grid poses immediately, and paint each cell's HUD
  // (place badge + LAP pill) right away so the chrome sits at its final size
  // through the countdown — no pop-in at GO (the racing loop takes over from
  // the first ~6 Hz tick).
  for (const c of session.getSnapshot().cars) {
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
    scene.setCarHud(c.id, c);
  }
  session.startCountdown(window.__countdownSeconds || COUNTDOWN_SECONDS); // __countdownSeconds: E2E hook to shorten the countdown
}

// Chain into the cup's next race, straight from the intermission (RESULTS →
// COUNTDOWN — no lobby in between; RoomFlow allows the transition). Reached
// three ways: the intermission's auto-advance timer, the host's "Next race"
// (SERIES_NEXT / the display's results button). startRace's LOBBY guard stays
// intact, so nothing else — a stale START_GAME, __startRace — can skip an
// intermission.
function advanceSeriesRace() {
  if (net.roomState !== ROOM_STATE.RESULTS || !series || series.finished || !sceneReady) return;
  clearTimeout(endTimer);          // endRace armed the 60s back-to-lobby failsafe — it must not yank race N+1
  clearSeriesTimers();
  // Who was waiting out the last race, BEFORE the field rebuild seats them.
  // Their phones sit on "you're in the next race!" and only a fresh WELCOME
  // (inRace now true) flips them to the wheel — GAME_END never comes mid-cup.
  const joiners = lateJoiners();
  const players = net.flow.list().filter((p) => p.connected);
  if (!players.length) { returnToLobby(); return; } // everyone left mid-intermission
  series.advance();
  net.setTrack(series.currentTrackId);   // publishes + selectTrack (track/totalLaps swap)
  // selectTrack outside the lobby skips the scene swap (no preview to fade);
  // a chained start has no lobby step, so place the new circuit explicitly —
  // the results overlay covers the pop.
  scene.setTrack(track, { debug: _showCenterline });
  launchRace(players);
  for (const p of joiners) net.resendWelcome(p.peerIndex);
}

function clearSeriesTimers() {
  clearTimeout(seriesTimer); seriesTimer = null;
  clearInterval(intermissionTicker); intermissionTicker = null;
}

// ---- spatial audio: world-cue loudness by 3D distance to the nearest human ----
// The split-screen cells ARE the listeners: each shows one human car, so a world
// sound is loud when it happens next to a human and fades with straight-line WORLD
// distance to the nearest one — never gating hard to silence inside the scene, so
// distant action stays present, just quiet. This is the whole sound model: one
// curve, shared by every world cue (curb scrub, grabs, banana, spin, rocket). It
// replaces the old binary "is this CPU car on a human's camera?" visibility gate
// and generalises what used to be the rocket's private distance falloff.
//
// Distance is true 3D proximity (Vector3.distanceTo): a car physically near a
// human is loud even when far apart in race position — an overpass, a crossing, a
// doubled-back straight — which reads on screen as "it's right there". Cheap: ≤4
// humans × a handful of sources per frame. Starting values — tune by ear in ?solo=1.
const AUD_PEAK = 0.7;  // loudness at point-blank (≤ AUD_NEAR) — the ceiling for EVERY world cue, so even
                       //   your own car's events don't slam full master (HUD cues bypass this and stay full)
const AUD_NEAR = 8;     // within this many world units of a human → AUD_PEAK (the pack around you)
const AUD_FAR = 34;     // by here it has faded to the distance FLOOR (the far edge of the chase view)
const AUD_FLOOR = 0.18; // quietest a still-in-scene source gets — distant but present, never silent here
const AUD_CUT = 64;     // past here: out of the scene → silent (FLOOR tapers to 0 across [FAR, CUT], no click)

// Min straight-line world distance from point `p` to any human car (Infinity with
// no humans / no live poses). Humans are the only listeners — CPU cars have no cell.
function nearestHumanDist(p) {
  if (!session) return Infinity;
  let best = Infinity;
  for (const [hid, h] of session.engine.cars) {
    if (aiBots.has(hid)) continue;
    const hp = h.pose && h.pose.pos;
    if (!hp) continue;
    const d = hp.distanceTo(p);
    if (d < best) best = d;
  }
  return best;
}
// Loudness in [0, AUD_PEAK] for a world cue at world position `p` (AUD_PEAK within
// AUD_NEAR of a human, FLOOR at AUD_FAR, 0 past AUD_CUT). A human's own car is at
// distance 0 → AUD_PEAK, so this needs no human/CPU branch: a player's own moments
// come out at the ceiling for free. A missing position (`!p`) plays at the ceiling
// rather than dropping the cue. (HUD cues — lap/roulette/countdown — never reach
// here; they bypass the distance model and play at full master.)
function audibility(p) {
  if (!p) return AUD_PEAK;
  const d = nearestHumanDist(p);
  if (d <= AUD_NEAR) return AUD_PEAK;
  if (d >= AUD_CUT) return 0;
  if (d <= AUD_FAR) return AUD_PEAK - (AUD_PEAK - AUD_FLOOR) * (d - AUD_NEAR) / (AUD_FAR - AUD_NEAR);
  return AUD_FLOOR * (1 - (d - AUD_FAR) / (AUD_CUT - AUD_FAR));
}
// Loudness for a race event = its car's world position through audibility;
// idless/global events (no positioned source) play at the world-cue ceiling.
function eventGain(e) {
  if (e == null || e.id == null) return AUD_PEAK;
  const c = session && session.engine.cars.get(e.id);
  return audibility(c && c.pose && c.pose.pos);
}

// A rocket lives in the engine's (arclength, lat) space — rebuild its world point
// the same way the engine poses cars (centreline sample + lateral offset) so the
// flight is measured in the SAME 3D metric as its target-car impact below.
function rocketWorldPos(r) {
  const f = session.engine.centerline.sampleAt(r.s); // r.s is wrapped to [0, length); sampleAt wraps anyway
  return f.pos.clone().addScaledVector(f.lateral, r.lat);
}
// Rocket flight: a sustained jet per in-flight rocket, held the whole air time, its
// level set by the SAME audibility curve as every other world cue (so the jet and
// its boom always agree, and a rocket near a human is loud while a far one is a
// quiet whoosh). Voices stop when a rocket leaves the snapshot (hit/expired).
let _rocketVoiceIds = new Set();
function driveRocketAudio(snap) {
  const seen = new Set();
  for (const r of (snap.rockets || [])) { seen.add(r.id); audio.rocketFlight(r.id, audibility(rocketWorldPos(r))); }
  for (const id of _rocketVoiceIds) if (!seen.has(id)) audio.rocketFlight(id, 0); // stop the ones that just landed/expired
  _rocketVoiceIds = seen;
}
// Loudness of a rocket IMPACT, kept CONSISTENT with the flight so you never get a
// jet that fades in with no boom: the detonation is at the target car, so reuse
// audibility on the target's world position (a human hit → always full), with a
// payoff floor so an audible jet always lands an audible boom. Returns 0 only when
// the impact is out of every human's earshot.
function rocketImpactLevel(targetId) {
  const t = session && session.engine.cars.get(targetId);
  if (!t) return 1;                    // target already gone (rare) — just play it
  if (!aiBots.has(targetId)) return 1; // a human got hit → full
  const a = audibility(t.pose && t.pose.pos);
  return a > 0 ? Math.max(0.45, a) : 0; // audible whenever the flight was, with a clear payoff floor
}

// Map engine events onto cues. World moments (a car's grab, banana drop, spin,
// curb scrub) are scaled by distance to the nearest human (eventGain): close =
// loud, far = quiet but present — so the player's own moments come out full (gap
// 0) and a CPU's fade with distance instead of popping on/off as they enter or
// leave a camera. HUD-narration cues stay human-only and full: the roulette
// describes the player's item slot, and lap / finish narrate their cell's HUD.
function audioForRaceEvent(e) {
  const isHuman = e.id == null || !aiBots.has(e.id);
  const g = eventGain(e); // 1 for the player's own car / idless cues, distance-scaled for CPUs
  switch (e.type) {
    case 'pickup':
      // A finished car has no HUD item slot to narrate, so its victory-lap grabs play
      // just the world pop (like a CPU grab) — never the player roulette chain.
      if (isHuman && !e.finished) audio.pickup(); // pop + roulette tick-down (player's own slot)
      else if (g > 0) audio.pickupPop(g);         // any other grab: world pop, by distance
      break;
    // (boost item-use and pad crossings make no one-shot sound — the boost
    // WIND in onFrame tracks the resulting speed state instead.)
    case 'item_use':
      if (g > 0 && e.item === 'banana') audio.bananaDrop(g);
      else if (g > 0 && e.item === 'monster') audio.monsterInflate(g); // pump-up as the car transforms
      // the rocket's launch+flight is a SUSTAINED voice driven per-frame in onFrame
      // (driveRocketAudio), not a one-shot here; boost item-use stays silent.
      break;
    // The monster transform lapsing back to a car: the deflate sputter (pairs with the
    // on-screen shrink). World cue, scaled by distance to the nearest human like the rest.
    case 'monster_end':
      if (g > 0) audio.monsterDeflate(g);
      break;
    case 'spin':
      // rocket → boom (its own distance metric, kept in step with the flight so the
      // jet and explosion are always heard together); oil/banana → comedy slip,
      // scaled by distance to the nearest human like every other world cue.
      if (e.cause === 'rocket') { const lvl = rocketImpactLevel(e.id); if (lvl > 0) audio.rocketHit(lvl); }
      else if (g > 0) audio.spin(g);
      break;
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
  // A live car's grab always re-spins its cell roulette (incl. a box swap that re-rolls
  // the same item) — a finished car's victory-lap grab has no usable slot, so no spin.
  if (!fastForwarding && e.type === 'pickup' && !e.finished) scene.itemPickup(e.id, e.item);
  // Rocket strike: pop a one-shot impact burst on the target (frustum culling drops it
  // off-screen). Skipped during the silent fast-forward, like the audio above.
  if (!fastForwarding && e.type === 'spin' && e.cause === 'rocket') scene.rocketImpact(e.id);
  // A rocket self-destructing at the end of its flight (a whiff): detonate at its track point.
  if (!fastForwarding && e.type === 'rocket_expire') {
    scene.rocketExpire(e.s, e.lat);
    const lvl = audibility(rocketWorldPos({ s: e.s, lat: e.lat })); // boom scaled by distance to the nearest human
    if (lvl > 0) audio.rocketHit(lvl);
  }
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
  // Cup: stamp every racer's banked points, and re-sort the FINAL board into
  // cup-standings order (points → latest-race placement — the intermission and
  // podium story). Live boards (over=false) stay in race order: mid-race the
  // drama is who crosses the line, not the tally.
  if (series) {
    const cup = new Map(series.standings().map((r, i) => [r.playerId, { row: r, seq: i }]));
    for (const o of order) {
      const s = cup.get(o.playerId);
      o.points = s ? s.row.points : 0;
      if (over) o.gained = s ? s.row.gained : 0;
    }
    if (over) order.sort((a, b) => (cup.has(a.playerId) ? cup.get(a.playerId).seq : Infinity)
      - (cup.has(b.playerId) ? cup.get(b.playerId).seq : Infinity));
  }
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
    ...(series ? { series: seriesInfo() } : {}),
    total: order.length,   // racers + joining rows — always matches order
    order
  };
}

// The cup's progress chip on every STANDINGS board: which race of how many
// (raceCount is null for endless random play — there is no "of N"), what's
// next (null after a cup's last race), and whether this board is the podium
// (`final`; never for endless). autoAdvanceMs lets the phones caption the
// auto-start.
function seriesInfo() {
  const next = series.finished ? null : TRACK_LIST.find((t) => t.id === series.nextTrackId);
  return {
    cupId: series.cup.id, cupName: series.cup.name,
    endless: series.endless,
    raceIndex: series.raceIndex, raceCount: series.endless ? null : series.raceCount,
    nextTrackId: next ? next.id : null, nextTrackName: next ? next.name : null,
    final: series.finished,
    autoAdvanceMs: window.__intermissionMs || INTERMISSION_MS
  };
}

// Connected players without a car in the current race — they joined after the
// field was locked and ride the next one (see the `joining` rows above).
// Both callers (standingsPayload + showResults) run synchronously inside the
// same endRace flow, so the two boards always agree on who's joining.
function lateJoiners() {
  const byId = new Map(currentField.map((p) => [p.peerIndex, p]));
  return net.flow.list().filter((p) => !!p.connected && !byId.has(p.peerIndex));
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
  // Bank the cup points FIRST — the final board broadcast below must already
  // carry this race's gains, and the intermission/podium reads them too.
  if (series) series.applyRace(results.results, currentField);
  raceEnded = true;                            // hold the finish frame behind the translucent results overlay
  audio.stopVoices();                          // the frozen frame must not hold wind/squeal voices open
  audio.stopMusic();                           // race over → results screen is quiet
  showMusicCredit(false);
  paused = false;                              // results aren't pausable
  autoPaused = false;
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  stopPauseAutoHide();
  broadcastStandings(true);                    // final board → phones show the full results overlay
  showResults(results);
  clearTimeout(endTimer);
  endTimer = setTimeout(returnToLobby, RESULTS_FAILSAFE_MS);
  // Mid-cup: this results screen is an INTERMISSION — arm the auto-advance into
  // the next race (the host can jump it early via SERIES_NEXT / the on-screen
  // button; advanceSeriesRace disarms the failsafe above). __intermissionMs is
  // the E2E hook, like __countdownSeconds.
  if (series && !series.finished) {
    const wait = window.__intermissionMs || INTERMISSION_MS;
    seriesDeadline = Date.now() + wait;
    seriesTimer = setTimeout(advanceSeriesRace, wait);
    intermissionTicker = setInterval(renderIntermissionCountdown, 500);
  }
}

// Tick the intermission's "starting in N…" against the auto-advance deadline
// (a fresh ceil each beat instead of a decrementing counter, so it can't drift).
function renderIntermissionCountdown() {
  const secs = el('results-next-secs');
  if (secs) secs.textContent = String(Math.max(0, Math.ceil((seriesDeadline - Date.now()) / 1000)));
}

// The results overlay in its three dressings: plain single-race board, cup
// intermission (points + "next up" footer), cup podium (top-three steps).
// Rows come from the same standingsPayload the phones get, so both screens
// always tell the same story (order, points, joining rows).
function showResults(results) {
  const board = standingsPayload(results, true);
  const s = board.series || null;
  const podium = !!(s && s.final);
  const intermission = !!(s && !s.final);

  // Podium boards celebrate: "<cup> CHAMPS!" on a red header sticker (.is-podium h2).
  el('results-title').textContent = podium ? `${s.cupName} CHAMPS!` : s ? 'Standings' : 'Results';
  // Sub only during intermissions ("Cup · Race N of M") — the podium's CHAMPS
  // header says it all.
  const sub = el('results-sub');
  sub.classList.toggle('hidden', !intermission);
  if (intermission) {
    sub.textContent = s.endless ? `${s.cupName} · Race ${s.raceIndex + 1}`  // endless: no "of N"
      : `${s.cupName} · Race ${s.raceIndex + 1} of ${s.raceCount}`;
  }

  renderPodium(el('results-podium'), podium ? board.order : null);

  const list = el('results-list');
  list.innerHTML = '';
  for (const row of podium ? board.order.slice(3) : board.order) { // the podium holds the top three
    const li = document.createElement('li');
    if (row.joining) li.className = 'is-joining';
    // The name is player-supplied — set as TEXT, never markup (same rule as
    // the controller's results list and renderJoinUrl). It carries the
    // player's livery colour itself — no swatch dot.
    const nm = document.createElement('span');
    nm.className = 'res-name';
    nm.style.setProperty('--c', CAR_COLORS[row.colorIndex] || 'inherit');
    nm.textContent = `${row.name}${row.ai ? ' (CPU)' : ''}`;
    li.append(nm, ' ');
    if (row.joining) {
      const t = document.createElement('span');
      t.className = 'res-time';
      t.textContent = 'Next race';
      li.appendChild(t);
    } else if (s) {
      // Cup boards tell the points story ("+9 · 15 pts"); the lap clock already
      // had its moment on the finish cards.
      const gain = document.createElement('span');
      gain.className = 'res-gain' + (row.gained ? '' : ' is-zero');
      gain.textContent = `+${row.gained || 0}`;
      const pts = document.createElement('span');
      pts.className = 'res-pts';
      pts.textContent = `${row.points || 0} pts`;
      li.append(gain, pts);
    } else {
      const t = document.createElement('span');
      t.className = 'res-time';
      t.textContent = row.finished ? `${row.time.toFixed(1)}s` : 'DNF';
      li.appendChild(t);
    }
    list.appendChild(li);
  }

  // Intermission footer: what's next + the auto-advance countdown (ticked by
  // renderIntermissionCountdown against seriesDeadline).
  const next = el('results-next');
  next.classList.toggle('hidden', !intermission);
  if (intermission) {
    next.textContent = 'Next up: ';
    const b = document.createElement('b');
    b.textContent = s.nextTrackName || '';
    const secs = document.createElement('span');
    secs.id = 'results-next-secs';
    secs.textContent = String(Math.ceil((window.__intermissionMs || INTERMISSION_MS) / 1000));
    next.append(b, ' — starting in ', secs, '…');
  }

  el('results-newgame').textContent = intermission ? 'Next race ▸' : 'New Game';
  el('results').classList.toggle('is-podium', podium); // list ranks from 4th under the steps
  el('results').classList.remove('hidden');
}

// Top-three steps, arranged 2nd | 1st | 3rd; hidden outside podium boards. AI
// keep their (CPU) tag — beating them is the story of a short-handed cup.
// Each step is a livery-coloured sticker block carrying its rank numeral.
function renderPodium(wrap, order) {
  wrap.innerHTML = '';
  const top = order ? order.filter((r) => !r.joining).slice(0, 3) : [];
  wrap.classList.toggle('hidden', !top.length);
  for (const place of [2, 1, 3]) {
    const row = top[place - 1];
    if (!row) continue;
    const col = document.createElement('div');
    col.className = 'podium__col';
    col.dataset.place = String(place);
    col.style.setProperty('--c', CAR_COLORS[row.colorIndex] || '#888');
    const who = document.createElement('div');
    who.className = 'podium__who';
    const nm = document.createElement('span');
    nm.className = 'res-name';
    nm.style.setProperty('--c', CAR_COLORS[row.colorIndex] || 'inherit');
    nm.textContent = `${row.name}${row.ai ? ' (CPU)' : ''}`;
    who.append(nm);
    const pts = document.createElement('div');
    pts.className = 'podium__pts';
    pts.textContent = `${row.points || 0} pts`;
    const step = document.createElement('div');
    step.className = 'podium__step';
    step.textContent = String(place);
    col.append(who, pts, step);
    wrap.appendChild(col);
  }
}

function returnToLobby() {
  if (net.roomState === ROOM_STATE.LOBBY) return;
  clearTimeout(endTimer);
  clearTimeout(abandonTimer); abandonTimer = null;
  series = null;        // every exit route cancels a running cup (quit, abandon, failsafe)
  clearSeriesTimers();
  // Re-aim the pick for the next lobby: random re-rolls every visit; a cup
  // rewinds to its race 1 (a quit/finished cup left trackId mid-cup, and the
  // next Start races a fresh series from the top). Done while still in
  // RESULTS/PLAYING so selectTrack skips its lobby crossfade — the scene swap
  // rides this function's own fade below.
  let trackSwapped = false;
  if (net.mode === 'random') {
    net.setTrack(randomBag.draw());
    trackSwapped = true;
  } else if (net.mode === 'cup') {
    const cup = CUPS.find((c) => c.id === net.cupId);
    if (cup && net.trackId !== cup.tracks[0]) { net.setTrack(cup.tracks[0]); trackSwapped = true; }
  }
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  // Reachable straight from a live race (controller RETURN_TO_LOBBY, solo's R
  // key) — kill any state voices or a boost wind would drone on in the lobby.
  audio.stopVoices();
  audio.stopMusic();
  showMusicCredit(false);
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
  // Crossfade from the frozen finish frame back to the attract demo (through the diorama):
  // drop the race cars + restart the demo under cover so the reset doesn't pop on screen.
  fadeBackdrop(() => {
    for (const c of scene.cars.keys()) scene.removeCar(c);
    if (trackSwapped) scene.setTrack(track, { debug: _showCenterline }); // the re-aimed pick (random re-roll / cup rewind)
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
    audio.pauseMusic();                  // ... and the music holds where it was
    freezeCars();                        // zero each car's speed so dust stops kicking up
  } else if (!frozen && session.paused) {
    session.resume();
    audio.resumeMusic();
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
    if (c.pose) scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up); // static repose — all anim inputs default
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
el('pause-newgame').addEventListener('click', returnToLobby); // mid-race quit — cancels a cup too
// On the results board the same button is "Next race ▸" during a cup
// intermission and "New Game" otherwise (label swapped by showResults).
el('results-newgame').addEventListener('click', () => {
  if (series && !series.finished) advanceSeriesRace();
  else returnToLobby();
});

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
    // Reveal the 3D scene: #scene ships .is-dim (opacity 0) so the lobby starts on the
    // diorama, but a track/race preview owns the screen — drop BOTH .hidden and .is-dim,
    // else the canvas renders into a fully transparent container (looks like a blank page).
    el('scene').classList.remove('hidden', 'is-dim');
    const _dio = el('lobby-diorama'); if (_dio) _dio.classList.add('hidden');
  }
  const _int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
  import('./TestHarness.js').then(({ runDisplayScenario }) => runDisplayScenario(
    {
      scenario: _scn,
      players: _int(_params.get('players'), 4),
      host: _params.get('host') === null ? null : _int(_params.get('host'), 0),
      picked: _params.get('picked') || false   // lobby scenario: post-pick chrome ('cup'|'track'|'random'; legacy '1' = cup)
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
window.__series = () => series; // live CupSeries (null outside a cup) — E2E + console poking
window.__session = () => session; window.__lobbyDemo = lobbyDemo; window.__wakeLock = wakeLock;
window.__sceneReady = scenePromise; // awaited by E2E before starting a race (startRace gates on sceneReady)

// Debug settings (faint wrench, bottom-left): interactive editor for this
// page's query params — edits reload the page so each param takes effect
// through its normal boot path above. Lazy import: dev aid, not boot-critical.
import('../shared/debugPanel.js').then(({ initDebugPanel }) => {
  // Capture the engine default ONCE, before any URL ?steerExpo= value is applied
  // (the panel's range field calls live() at init). Used for both the slider's
  // default and the "· default" readout marker — reading it live inside format()
  // would wrongly equal the dragged value.
  const steerDefault = getSteerExpo();
  return initDebugPanel([
  { section: 'Test harness' },
  { key: 'scenario', label: 'Scenario', hint: 'no relay, fake players', type: 'select',
    options: ['welcome', 'device-choice', 'lobby', 'track', 'features', 'countdown', 'racing', 'results', 'intermission', 'podium']
      .map((s) => ({ value: s, label: s })) },
  { key: 'players', label: 'Players', hint: 'fake roster size', type: 'int', min: 1, max: MAX_PLAYERS },
  { key: 'host', label: 'Host seat', hint: 'blank = no host', type: 'int', min: 0, max: MAX_PLAYERS - 1 },
  { key: 'picked', label: 'Picked mode', hint: 'lobby: post-pick chrome over the preview', type: 'select',
    options: [{ value: 'cup', label: 'cup' }, { value: 'track', label: 'exact track' }, { value: 'random', label: 'random' }] },
  { section: 'Solo drive' },
  { key: 'solo', label: 'Solo keyboard', hint: 'pick a car; no phones needed', type: 'select', bare: '0',
    options: CAR_MODELS.map((_, i) => ({ value: String(i), label: window.CAR_NAMES[i] })) },
  { section: 'Driving feel' },
  // Live: re-shapes the tilt→steer curve mid-race (no reload). 1 = linear scaling;
  // higher = gentler near centre, sharper toward full lock. The engine reads it
  // fresh each step, so it affects every car in the running race instantly.
  { key: 'steerExpo', label: 'Steering curve', hint: 'tilt→steer exponent · live', type: 'range',
    min: 0.6, max: 3, step: 0.05, value: steerDefault, live: setSteerExpo,
    format: (n) => n.toFixed(2) + (Math.abs(n - 1) < 1e-9 ? ' · linear' : Math.abs(n - steerDefault) < 1e-9 ? ' · default' : '') },
  // Live: scales the whole scene's per-frame dt (sim, props, FX, camera) for slow-mo inspection — no
  // reload. 1 = normal; drag down to watch fast action (e.g. a rocket strike) play out frame by frame.
  { key: 'timescale', label: 'Time scale', hint: 'slow-mo · live', type: 'range',
    min: 0.1, max: 1, step: 0.05, value: 1, live: (n) => scene.setTimeScale(n),
    format: (n) => n.toFixed(2) + '×' + (Math.abs(n - 1) < 1e-9 ? ' · normal' : '') },
  { section: 'Track' },
  { key: 'track', label: 'Preselect', type: 'select',
    options: TRACK_LIST.map((t) => ({ value: t.id, label: t.name })) },
  { key: 'centerline', label: 'Racing line', hint: 'magenta ribbon overlay', type: 'flag' },
  { section: 'Rendering' },
  { key: 'biome', label: 'Biome', hint: 'override the cup look (blank = cup decides)', type: 'select',
    options: BIOME_NAMES.map((b) => ({ value: b, label: b })) },
  { key: 'msaa', label: 'MSAA', hint: 'default off (perf)', type: 'select',
    options: [{ value: '0', label: 'off' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }] },
  { key: 'dividers', label: 'Cell dividers', hint: 'ink lines between cells · default on', type: 'select',
    options: [{ value: '0', label: 'off' }] },
  { key: 'bbox', label: 'Collision boxes', type: 'flag' },
  ], { title: 'Display' });
});
