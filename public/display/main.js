// Display entry — lobby + authoritative race. Owns the Stage (canvas + DOM HUD),
// the race session, and the countdown→race→results flow. The 3D itself is the
// engine's: see Stage.js / render/Display.js.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { Stage, HUD_TICK_MS } from './Stage.js';
import { DEV_TRACKS } from '../shared/devTracks.js';
import { loadBiomes } from '../shared/biomes.js';
import { TRACK_SCHEMATICS } from '../shared/trackSchematics.js';
import { LobbyDemo } from './LobbyDemo.js';
import { renderSeats, renderCupSlot } from './lobbySeats.js';
import { createWakeLock } from '../shared/wakeLock.js';
import { RaceAudio } from './Audio.js';
// The UI MODEL is C++ too (ttp_ui.h over libttp-runtime/ttp/ui_model.cc). Every
// screen decision below — which seats, which race card, which rows, whether the
// field may freeze — is ITS answer; this file renders and decides nothing.
//
// THE CATALOGUE COMES OUT OF IT TOO. shared/tracks.js is not imported here: the
// cups, their display names, every track name and the cup-difficulty tendency
// are codegen'd into the wasm (generated/track_defs.h), so this page asks for
// them rather than bundling a copy — which is also what stops a second shell
// from having to carry one. What still comes from a JS module is DEV_TRACKS,
// below, because a dev range is a debug surface and never reaches a picker.
import * as ui from './NativeUiModel.js';
import { ITEM_IDS } from './engine/contract.js';

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS, CAR_MODELS, MAX_PLAYERS, carStats } = window;
const el = (id) => document.getElementById(id);
const screens = { welcome: el('welcome'), lobby: el('lobby'), race: el('race') };
// Back stack (live play only): each forward step pushes one history entry, each
// backward step pops one, so the browser back button walks race → lobby →
// welcome with exactly one entry per level (the controller's SCREEN_ORDER
// pattern; the screen ENUM and what back MEANS per screen are uiModel's
// SCREEN_ORDER / BACK_EFFECT — only the History API traversal is here, which is
// the plan's non-goal). Test/gallery/solo surfaces drive screens directly and
// get no history entries (gallery lives in iframes; solo has no welcome).
let currentScreen = null;
let updateSoundHint = () => {}; // rebound below once the audio pill is wired
let suppressPopstate = false;   // the history.back() below is ours — its popstate must not act
let popstateNavigating = false; // this show() IS a popstate retreat — don't pop again (set/cleared by the handler)
function show(name) {
  const prev = currentScreen;
  currentScreen = name;
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  updateSoundHint();
  if (_isTestMode || _isDebugSolo) return;
  const step = ui.screenStep(prev, name);
  if (step > 0) history.pushState({ screen: name }, '');
  else if (step < 0 && prev && !popstateNavigating) { suppressPopstate = true; history.back(); }
}

// ---- tracks ----
// A track is an ID here, and nothing more. The geometry is built inside the
// engine — by the sim when a race begins (ttp_session_begin) and by the renderer
// when the scene is built (ttp_display_build) — from the SAME C++ TrackBuilder,
// on the same descriptor codegen'd into the wasm. The browser used to carry a
// second builder purely to feed the renderer and to draw these mini-maps; the
// mini-maps are baked ahead of time now (shared/trackSchematics.js, regenerated
// by `npm run gen:schematics`) and nothing on this page integrates a track.
//
// `entry` is what the rest of the file passes around as "the track": the
// catalogue row plus the lap count the session reads off it.
function trackEntry(t) {
  return { ...t, trackId: t.id, totalLaps: TOTAL_LAPS };
}
// Filled from the wasm's own catalogue once it is up (see the boot block below).
// `let` rather than `const` for that reason alone — neither is written twice.
let CUPS, TRACK_LIST, built, trackCatalog;

// The controller is a dumb renderer driven entirely off the relay's retained room
// snapshot (set_state) — so all the chooser CONTENT it needs travels the wire, not
// a bundled copy that could diverge from a differently-versioned (native) display.
// These are the slim, display-authoritative payloads that ride the snapshot:
//   trackChooser — reduced schematics (~24 pts) so the whole catalog fits 16 KiB,
//   carChooser   — car id/name/handling stats (images load by id from the web host),
//   colorPalette — the livery hex palette (colorIndex → colour), so the phone's
//                  livery dots always match the car the display paints.
// Filled at boot, once the wasm is up: the codec is C++ (NativeSchematic.js over
// libttp-track/ttp/schematic.cc), so this cannot be a module-scope constant.
let trackChooser;
const carChooser = CAR_MODELS.map((id, i) => {
  const s = (window.CAR_STATS && window.CAR_STATS[i]) || {};
  return { id, name: (window.CAR_NAMES && window.CAR_NAMES[i]) || id, stats: { accel: s.accel, vmax: s.vmax, turn: s.turn, mass: s.mass } };
});
const colorPalette = CAR_COLORS.slice();

// No track is PICKED at first — the host's "Start race" stays gated until their
// phone sends one — but the live lobby still previews a circuit from the first
// frame (the last party's pick, remembered below). ?track=<id> preselects a real
// pick (dev / gallery). `track` always holds valid geometry (the pick, the
// preview, or the first track as a render default) so the scene + gallery
// always have something to draw.
const _trackParams = new URLSearchParams(location.search);
// The ASSET SHOWROOM has one stage and only one (shared/devTracks.js's
// `showroom`), so ?scenario=assets names it for you: the gallery passes it
// explicitly, and someone typing the URL by hand gets the scene rather than an
// arbitrary catalogue track with none of the exhibition frontage on it. An
// explicit ?track= still wins — flying the showcase vocabulary around a real
// circuit is a fair thing to want.
const _qTrack = _trackParams.get('track')
  || (_trackParams.get('scenario') === 'assets' ? 'showroom' : null);

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
// (?bots=0 = race alone) instead of topping the grid up to a full field.
const _qForceItem = ITEM_IDS.includes(_trackParams.get('item')) ? _trackParams.get('item') : null;
const _qBots = _trackParams.has('bots') ? Math.max(0, parseInt(_trackParams.get('bots'), 10) || 0) : null;
// ---- the native engine ------------------------------------------------------
// The C++ stack is the ONLY engine: the sim, the cup-series layer above it, and
// the party layer's decisions (room state, relay framing, fastlane netcode). The
// JS twins were retired once every layer was conformance-proven and the whole E2E
// suite ran green on them. Awaited at boot, and a failure is FATAL rather than a
// silent downgrade — there is nothing left to fall back to.
// Still JS by design: rendering, HUD, and the transport I/O (WebSocket /
// RTCPeerConnection), which wasm cannot own without proxying through JS anyway.
const _nativeSim = await import('./NativeRaceSession.js');
// The audio DECISIONS are C++ too (ttp_audio.h). Only the device half — the
// AudioContext, the cue palette, the song element — is still JS, and it decides
// nothing.
const _nativeAudio = await import('./NativeAudio.js');
// The RACE ORCHESTRATION is C++ too (ttp_race.h): the state machine that starts
// a race, launches one, walks the countdown, ends it, chains a cup and returns
// to the lobby. It answers in ORDERED EFFECT LISTS and `perform` below walks
// them — the order is the contract, so nothing here may reorder or skip.
const flow = await import('./NativeRaceFlow.js');
await Promise.all([_nativeSim.init(), _nativeAudio.init(), ui.init(), flow.init()]);
// The world the UI model resolves ids against, handed over ONCE: the cups, the
// track catalogue and the two field sizes the seat grid needs. Authored data —
// it changes when the game ships, not while it runs — so it is set here rather
// than re-sent with every pick. Before ANY render below (the gallery harness
// grids seats off it too).
// The two field sizes the seat grid needs. The WORLD is not passed: it is
// codegen'd into the wasm, so this is the point where the page stops having an
// opinion about which tracks exist. Before ANY render below (the gallery
// harness grids seats off it too).
ui.configure({ maxPlayers: MAX_PLAYERS, carCount: CAR_MODELS.length });
// ...and read straight back, because the SHELL still has to draw the picker and
// name the tracks in the phones' chooser payload. `catalog` is CUPS order
// flattened. cupName is derived here rather than carried: the model answers with
// a cup ID per track, and the cup NAMES are one lookup away in the same answer.
({ cups: CUPS, catalog: TRACK_LIST } = ui.catalogue());
{
  const nameOf = new Map(CUPS.map((c) => [c.id, c.name]));
  TRACK_LIST = TRACK_LIST.map((t) => ({ ...t, cupName: nameOf.get(t.cup) || null }));
}
built = new Map(TRACK_LIST.map((t) => [t.id, trackEntry(t)]));
trackCatalog = TRACK_LIST.map((t) => ({
  id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
  svg: TRACK_SCHEMATICS[t.id]
}));
// The same once-at-boot handover for the orchestration layer's world. Two things
// about it are worth knowing:
//   * the PERSONA table is read back out of the wasm (libttp-sim's own
//     ttp::AI_PERSONALITIES) and handed straight in, so the CPU roster has ONE
//     source. public/display/aiPersonas.js survives for the test surfaces that
//     need it synchronously, and tests/display-abi.test.js pins it to this.
//   * carStats rows cross OPAQUE — copied into a field entry and never read —
//     which is what keeps CAR_STATS out of the decision layer.
flow.configure({
  fieldSize: MAX_PLAYERS, carCount: CAR_MODELS.length, colorCount: CAR_COLORS.length,
  aiPrefix: 'ai-', personas: flow.personas(),
  carStats: CAR_MODELS.map((_, i) => carStats(i)), cups: CUPS
});
// The biome ABI off the same module: the ?biome= list, the music pool key and
// the HUD boost chip's accent. The palette itself never leaves C++.
const _biomes = await loadBiomes();

const [_room, _conn, _lane, _sess, _schem] = await Promise.all([
  import('./NativeRoomFlow.js'),
  import('./NativePartyConnection.js'),
  import('./NativePartyFastlane.js'),
  // The SESSION POLICY: the room snapshot, the seat rules, the message guards,
  // the self-heartbeat, the seat claim. DisplayNet performs its answers.
  import('./NativeSessionModel.js'),
  // ...and the track-map codec the snapshot's chooser payload is packed with.
  import('./NativeSchematic.js')
]);
// One shared wasm module backs all of these (nativeRuntime.js memoizes it).
await Promise.all([_room.init(), _conn.init(), _lane.init(), _sess.init(), _schem.init()]);
// The reduced maps the phones' picker renders: the baked full-res schematic,
// RDP-simplified and uint8-packed by the native codec so the whole catalogue
// fits the relay's 16 KiB set_state cap.
// A track with no baked schematic loses its mini-map and nothing else. The two
// lists cannot disagree in a shipped build — TRACK_LIST comes from the wasm's
// codegen'd catalogue and the bake comes from the same shared/tracks.js, and
// tests/ui-model.test.js plus native-artifact gate the pair — but they are two
// artifacts now rather than one module, so a dev mid-rebuild can hold a wasm
// the bake has not caught up with. That should cost a picture, not the page.
trackChooser = TRACK_LIST.flatMap((t) => {
  const baked = TRACK_SCHEMATICS[t.id];
  if (!baked) {
    console.error(`[display] no baked schematic for "${t.id}" — run npm run gen:schematics`);
    return [];
  }
  return [{
    id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
    svg: _schem.pack(baked.d)
  }];
});
const _nativeParty = {
  RoomFlowImpl: _room.NativeRoomFlow,
  PartyConnectionImpl: _conn.NativePartyConnection,
  // The fastlane subclasses the kit's class (which keeps the WebRTC handshake and
  // is a classic-script global), so the subclass is built here, not at module scope.
  FastlaneImpl: _lane.makeNativePartyFastlane(window.PartyFastlane)
};
// DEV_TRACKS (shared/devTracks.js): an unknown ?track= id is looked up in the dev
// catalogue and built like any track — but only the ONE requested id, and only in a
// ?scenario= test surface or ?solo (they're keyboard test ranges — e.g. the 'gym'
// collision track): a LIVE lobby preselecting one would offer phones a track their
// picker catalog doesn't contain.
if ((_isTestMode || _isDebugSolo) && _qTrack && !built.has(_qTrack)) {
  // Dev ranges are in the wasm's track table too (gen-track-defs-header.mjs
  // carries DEV_TRACKS past the catalogue), so this only has to name one.
  const _devDef = DEV_TRACKS[_qTrack];
  if (_devDef) built.set(_qTrack, trackEntry({ id: _qTrack, ..._devDef }));
}
let selectedTrackId = (_qTrack && built.has(_qTrack)) ? _qTrack : null;
// Only an EXPLICIT ?track= preselects a room PICK (DisplayNet's defaultTrackId
// rule) — captured before the attract preview below widens selectedTrackId.
const _defaultPickId = selectedTrackId;
// The live lobby attracts from its first frame: preview the last party's
// circuit (saved on every confirmed pick, below in onTrackChange), falling back
// to the catalogue's first track — the easy cup's race 1. A PREVIEW, not a
// pick: the room pick stays null, so Start stays gated until the host's phone
// picks. Test surfaces and solo own their scenes and pick their own tracks.
const LAST_TRACK_KEY = 'tinytrack_last_track';
if (!selectedTrackId && !_isTestMode && !_isDebugSolo) {
  let last = null;
  try { last = localStorage.getItem(LAST_TRACK_KEY); } catch (_) {}
  selectedTrackId = (last && built.has(last)) ? last : TRACK_LIST[0].id;
}
let track = built.get(selectedTrackId || TRACK_LIST[0].id);

// ---- scene ----
// The Stage owns the canvas the native renderer draws into and the DOM HUD over
// it.
//
// NOT a top-level await, deliberately: that would hold the whole module body —
// net.start() at the tail included — behind standing up a Filament engine, a
// WebGL2 context and ten .filamat fetches. The room is supposed to warm EAGERLY
// behind the welcome board, and a display that hasn't opened its room yet is a
// display phones cannot join. (The engine wasm above is a different story: the
// party layer is in it, so the room genuinely cannot start without it.)
//
// Still FATAL on failure — there is no second renderer — it just fails through
// scenePromise instead of by aborting module evaluation.
const scene = new Stage(el('scene'), CAR_COLORS);
const sceneBooted = scene.boot().catch((e) => {
  console.error('[display] renderer boot failed — nothing will draw', e);
  throw e;
});
// ?biome=<name> — inspector override: force a biome on every track regardless of its cup
// (compare any track in any biome). Off by default; an unknown name is ignored (cup decides).
const _qBiome = _trackParams.get('biome');
if (_biomes.has(_qBiome)) scene.biomeOverride = _qBiome;

// ?scenario=assets — the asset gallery's SHOWROOM look: the biome above (or the
// track's own) carrying every biome's vocabulary, so one scene holds the whole
// kit. Set here, before the first scene build, because it changes what that
// build resolves AND which scenery bytes the shell fetches for it.
if (_trackParams.get('scenario') === 'assets') scene.showcase(true);

// ?dividers=0 — drop the chunky ink lines between split-screen cells (default
// ON; a debug-panel toggle so the look can be A/B'd at a party).
scene.showDividers = _trackParams.get('dividers') !== '0';
scene.orbit = true;
scene.bboxOrbit = true; // lobby sweeps an ellipse around the track's bounding box (close, elongated like the track)
let sceneReady = false;
// Lobby attract demo: AI driving the players' picked cars around the selected track,
// rendered under the orbiting overview camera. Runs only in the lobby (no session).
const lobbyDemo = new LobbyDemo(scene);
// Kept as a promise so the gallery TestHarness (and E2E) can wait for the first
// scene build before placing preview cars or starting a race.
const scenePromise = sceneBooted.then(() => scene.setTrack(track)).then(() => {
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
      // setTrack is ASYNC (asset provisioning + buildScene), so hand the
      // crossfade something to wait on — otherwise the still dissolves off a
      // canvas that still holds the old circuit and the new one pops in a beat
      // later. refreshLobbyDemo re-grids the attract field onto the new track.
      const built = scene.setTrack(track);
      refreshLobbyDemo();
      return built;
    });
  } else {
    updateBackdrop();
  }
}

// Lobby backdrop: the sunny diorama is the persistent base layer; the 3D #scene sits over
// it and is shown/hidden by OPACITY (.is-dim), not display, so it can crossfade straight in
// over the diorama. The live lobby always has a preview track (the boot fallback above), so
// in practice the diorama shows through only on test surfaces that boot without one.
// The welcome board ALWAYS sits on the diorama (its copy is unreadable over a live
// track), even though a preview or pick exists behind it — NEW GAME re-runs
// updateBackdrop to reveal the 3D attract race already running underneath.
function backdropShow3D() {
  if (currentScreen === 'welcome') return false;
  return !!selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY);
}
function updateBackdrop() {
  const sc = el('scene');
  sc.classList.remove('hidden');           // visibility is by opacity now, not display
  sc.classList.toggle('is-dim', !backdropShow3D());
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
        sc.classList.toggle('is-dim', !backdropShow3D()); // …then fade it in over the diorama
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
  const dissolve = () => {
    if (gen !== fadeGen) return;
    still.classList.add('is-fading');            // hand the dissolve to the compositor
    snapTimer = setTimeout(() => { still.remove(); }, FADE_MS);
  };
  // The swap finishes LATER than the frame that starts it (asset provisioning +
  // buildScene), so the still stays opaque until mid()'s promise resolves —
  // dissolving on schedule would just uncover the OLD circuit and let the new
  // one pop in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== fadeGen) return;                 // superseded by a newer pick
    requestAnimationFrame(() => {                // rebuild a frame later, hidden behind the still
      if (gen !== fadeGen) return;               // a newer pick (or leaving the lobby) cancelled us
      if (!(sceneReady && net.roomState === ROOM_STATE.LOBBY)) { // race started under us → drop the still
        clearTimeout(snapTimer); still.remove(); return;
      }
      Promise.resolve(mid()).then(dissolve, dissolve);
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
  // The grid and its signature in one crossing, off the live room.
  const { field, sig } = flow.demoLive(net.flow.handle, selectedTrackId, _qBots);
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

// The attract field and its signature are the ORCHESTRATION layer's
// (ttp_race.h): each seated human's PICKED car (livery + model), plus CPU
// racers topping the grid up to a full field, every car driven by the AI, read
// straight off the room handle (flow.demoLive above). The ?bots=<n> debug cap
// rides each call rather than the configured world: it is a URL hook, not part
// of the game's shape.
// ---- audio ----
// Two halves, and the split is load-bearing (docs/native-port/shared-cpp-plan.md
// P7 ported one of them to C++ and left the other per-platform):
//   audioDecide  the DECISIONS — which cue, how loud, which voice at what level.
//                NATIVE (native/runtime/ttp_audio.h over libttp-runtime/ttp/
//                audio.cc), reached through NativeAudio.js, which hands back the
//                same command stream the JS layer used to. The JS twin
//                (audio/decide.js) was the ORACLE audio-corpus.jsonl was
//                recorded from, and is now retired — git history has it.
//   audio        the DEVICE — the AudioContext, the cue palette, the song
//                element. It performs the command stream and decides nothing.
// Race events and countdown beats are decided inside the wasm as the sim fires
// them, so there is no event() call anywhere below: whatever they decided rides
// out on the next drain, ahead of that frame's own commands.
// Browsers gate audio behind a user gesture, so resume() rides the window
// gesture listeners below; until someone touches the display every cue no-ops
// silently (the decisions still run — they are what the corpus pins).
const audio = new RaceAudio();
const audioDecide = new _nativeAudio.NativeAudioDecider();
// Perform a decision stream. Every audio call in this file goes through here.
const sfx = (cmds) => audio.apply(cmds);

// Now-playing credit chip (bottom-left): the current song + artist, linking to
// its source — and the on-screen CC-BY attribution. Filled from whichever song
// startMusic picked for this race (audio.nowPlaying); toggled with the music
// lifecycle (shown on GO, hidden at results / lobby). Values are static config,
// so textContent/href are safe to set raw.
function showMusicCredit(on) {
  const mc = el('music-credit');
  if (!mc) return;
  const np = audio.nowPlaying;
  if (on && np) {
    mc.textContent = `${np.title} · ${np.artist}`;
    mc.href = np.source;
    mc.title = `${np.title} by ${np.artist} — ${np.license} (source ↗)`;
  }
  mc.classList.toggle('hidden', !(on && np));
}

// ---- race state ----
let session = null;
let paused = false;        // race frozen via the pause overlay (display or a controller)
let autoPaused = false;    // race frozen because no connected human holds a car (silent; see refreshAutoPause)
let lastHudTick = 0;
// Last held item pushed to each car's phone (peerIndex -> item|null), so ITEM is
// sent only when it changes. Cleared per race (launchRace); a reconnect forces a
// resend via onPlayerWelcomed.
const _lastItem = new Map();
// AI ("CPU") racers that filled empty seats this race: peerIndex -> controller.
// Empty when four humans race. The full field (humans + AI) is retained
// kept so the results screen can resolve AI names/liveries (they're not in the lobby).
// Which cars are CPU racers. Sourced from the FIELD, never from "do I hold a
// controller for it" — bots drive inside the wasm and hold no JS object at all, so
// a controller-derived test would answer "not an AI" for every bot (that bug broke
// the finish check, and with it cups reaching the podium, plus audio/item/cell
// targeting — see git history for aiBots). The AUDIO no longer asks: the
// decision layer reads the sim's own bot list, which is the same set by
// construction (the layer's buildField registers exactly these as bot personas).

// Reconcile every phone's held-item light against the engine's HUD block.
// The DECISION (who gets an ITEM message, only on change, AIs filtered) is
// C++'s ui.itemPushes; this only chooses WHEN to ask. Called from the slow
// HUD tick as the steady-state net, and from the 'item-pickup' effect so the
// light + pickup haptic land at the event instead of up to a HUD tick later.
const pushHeldItems = () => {
  if (!session) return;
  for (const { id, item } of ui.itemPushes(session.h, _lastItem)) {
    _lastItem.set(id, item);
    net.sendTo(id, { type: MSG.ITEM, item });
  }
};
let fastForwarding = false; // true only inside the AI-only fast-forward burst
let raceEnded = false;      // race over → freeze the scene behind the (translucent) results overlay until the next race
let debugSolo = null;       // DEBUG ?solo=1 keyboard player (null in normal play); see DebugSolo.js

scene.onFrame = (dt) => {
  if (!session) { lobbyDemo.step(dt); return; } // no race → run the lobby attract demo
  if (paused || autoPaused || raceEnded) return; // frozen: cars hold their last pose
  // During countdown the session exists but isn't racing yet: we still draw
  // the cars and let them react to steering so players can feel their tilt —
  // they just don't move until GO. session.update() advances the countdown
  // beats (this loop is the session's only clock); physics start at GO.
  if (debugSolo) debugSolo.drive(session); // DEBUG ?solo=1: feed the local keyboard car, same seam as the bots
  session.update(dt * 1000);
  // Everything the update's events mean — countdown beats, GO, pickups,
  // finishes, the race's end — is routed and decided in ONE crossing
  // (ttp_race_events_live_json): the lifecycle routing table is not this
  // shell's anymore. `results` rides the answer because no effect can carry
  // endRace's callback argument.
  drainRaceEvents();
  // One SLOW TICK drives everything below that isn't the frame itself: the
  // finish check here, and the HUD + ITEM push further down. Hoisted so the
  // ordering is unchanged (this check still runs before the audio drain) while
  // the cost is paid on HUD_TICK_MS rather than on every frame.
  const now = performance.now();
  const slowTick = now - lastHudTick > HUD_TICK_MS;
  // Every human across the line but CPU cars still circulating? Don't make the
  // humans watch them crawl home — fast-forward the deterministic sim to the
  // flag and show the final board now (the AI get their true finish times).
  // ONE crossing for both answers: `forfeit` is only read on the tick `allDone`
  // flips, so asking for them separately would double the traffic to save
  // nothing.
  //
  // NOT PER FRAME, and it never needed to be. This question is a pure function of
  // who holds a car, who is connected and who has finished — three sets that only
  // move on discrete events — and asking it costs ~11 us against a ~15 us sim
  // tick: a car-ids readback, then two string-marshalled ABI calls PER CAR, then
  // a four-array JSON round trip. The moment it can actually flip is already
  // covered by the event drain's own finish handling (humans-all-done is read
  // in C++ exactly when a finish asks), so what is left here is the SAFETY NET for the paths that carry no
  // finish event (a drop, a forfeit, a rekey). A net does not need 60 Hz; the
  // worst case is ~160 ms before a fast-forward that then resolves the whole
  // remaining race instantly.
  const flow = (slowTick && session.racing) ? raceFlow() : null;
  if (flow && flow.allDone) {
    // A dropped racer's ghost can never cross the line — forfeit any such car now
    // that every connected human is home, so the burst (and the race) ends
    // promptly instead of running to the guard cap on a car that can't finish.
    // fresh array — safe while forfeitCar removes cars
    for (const id of flow.forfeit) forfeitCar(id);
    if (!session.racing) return; // forfeiting the last unfinished car already ended the race
    // Freeze the field at the finish moment BEFORE the burst. fastForwardToEnd
    // advances the deterministic sim with NO rendering, and the just-finished
    // human keeps driving a victory lap — so without this the chase camera is
    // seen whipping across the track to that far-away pose through the
    // translucent results glass. raceEnded then holds this frame until the next
    // race (see the onFrame guard above).
    freezeCars();
    fastForwarding = true;
    session.fastForwardToEnd(); // runs to raceOver, queueing the end events
    drainRaceEvents();          // ...decided muted: the burst is skipping, not racing
    fastForwarding = false;
    return;                               // session ended; the results overlay covers the scene
  }
  // NOTHING about the race is read out per frame any more. The renderer has
  // every car's pose, lean, monster state, item props AND its steer bar — it
  // reads the live Game itself — and so does the audio: this hands the decision
  // layer a clock and takes back a list of commands (the shared curb-scrub
  // throttle, the per-human state voices, a sustained jet per in-flight rocket,
  // plus whatever the race events fired inside the update above decided). The
  // HUD is the slow-tick poll below; the last per-frame getSnapshot went with
  // this call.
  sfx(audioDecide.frame(now));
  if (!session.racing) return; // countdown: visible + steerable, but no HUD yet
  // The other half of the slow tick hoisted above. `lastHudTick` is stamped
  // HERE rather than at the top, so a countdown frame (which returns above) does
  // not consume the tick the first racing frame wants.
  if (slowTick) {
    lastHudTick = now;
    // The HUD values (ordinal, lap counter, held item, finish card) are the
    // ENGINE's, read back packed (ttp_hud.h) rather than picked out of a
    // serialized race state; painting them is still the Stage's. uiModel.hudRows
    // is off this path — it survives as the oracle the C++ port is pinned to.
    for (const row of scene.hudRows()) scene.setCarHud(row.id, row);
    // Held item lights the phone's USE button (all other race state — place/lap,
    // standings — lives on the TV or the room snapshot). It's per-owner, so it
    // rides its own ITEM message sent ONLY ON CHANGE (a reconnect relight comes
    // from onPlayerWelcomed).
    //
    // OFF THE SAME BLOCK the HUD was just painted from, which is the last thing
    // on this loop that used to serialize a race. It read ttp_snapshot_json — a
    // canonical (key-sorted) stringify of every car's pose, forward and up
    // vectors, plus every box, banana and rocket, ~4 KB parsed back in JS — to
    // keep three fields per car. Measured, that snapshot was ~59 us against a
    // ~15 us sim tick, and the rule it fed costs ~3 us; the plan's P7 line
    // ("the shipping game simply stops calling ttp_snapshot_json") is this.
    //
    // The block carries what the rule reads: the id (its roster slot), the
    // finished flag, and the held item as a CODE. A code this build cannot name
    // resolves to null and the phone's button stays dark — the same degradation
    // the drawn slot takes, and reachable only if ITEM_IDS has drifted from the
    // sim's roll table, which tests/display-abi.test.js exists to prevent.
    pushHeldItems();
  }
};

// ---- net ----
let currentJoinUrl = '';   // full join link (same string the QR encodes); set on room-ready
const net = new DisplayNet({
  // The room state machine, relay framing and fastlane netcode all run on the
  // C++ party layer; DisplayNet has no JS fallback to choose from.
  ...(_nativeParty || {}),
  trackCatalog,
  // Slim, display-authoritative chooser content for the retained room snapshot.
  carChooser, trackChooser, colorPalette,
  defaultTrackId: _defaultPickId,
  // The random-track shuffle bag lives BEHIND THE ROOM now; what the shell
  // supplies is one page-entropy seed (DisplayNet hands it to init_pick).
  hasBag: true,
  // selectTrack swaps the 3D preview; renderLobbyPick refreshes the cup slot
  // even when the resolved trackId didn't change (e.g. a mode switch landing
  // on the same circuit, where selectTrack early-returns).
  onTrackChange: (id) => {
    // Remember every confirmed pick's resolved circuit: it is what the NEXT
    // party's lobby attracts on before anyone joins.
    if (id && built.has(id)) { try { localStorage.setItem(LAST_TRACK_KEY, id); } catch (_) {} }
    selectTrack(id); renderLobbyPick();
  },
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
  onPlayerRenamed: renamePlayer,        // live rename: move the copies a race froze
  // The live race itself, as a native handle: the party layer works out its own
  // participant order (cars + dropped seats), each seat's inRace flag AND the
  // welcome-item routing from it in C++ rather than being fed answers from
  // here. 0 between races.
  sessionHandle: () => (session ? session.h : 0),
  // Manual pause only: the silent auto-pause lifts on the reconnect itself
  // (refreshAutoPause fires on the roster change), before the WELCOME goes out.
  isPaused: () => paused,
  // RoomFlow's abandoned-race deadline expired: no racer left and someone is
  // waiting for the next one. Same exit as any other quit path.
  onRaceAbandoned: returnToLobby,
  // A (re)joining phone recovers all room/results state from the snapshot replay,
  // but its held item is per-owner and rides ITEM (sent only on change) — so
  // relight it here, once, or a reconnecting driver's USE button stays dark until
  // their next pickup. Fired by the welcome-item effect, which C++ emits only
  // when the live race holds this seat's car — the lobby / late-joiner filter
  // this callback used to apply itself lives behind the session handle now.
  onPlayerWelcomed: (peerIndex) => {
    if (!session) return; // the handle the effect was decided on is being torn down
    // The seat's held item, off the live race in C++ — one crossing.
    const item = ui.welcomeItem(session.h, peerIndex);
    _lastItem.set(peerIndex, item);
    net.sendTo(peerIndex, { type: MSG.ITEM, item });
  },
  onControllerMessage: (from, data) => {
    // CONTROL stays on its own short-circuit: it is the relay-fallback INPUT
    // path (sensor-rate when the fastlane is down), and adding a crossing
    // there was measured and refuted. Every button-press message routes
    // through the verdict, gates (host, all-ready, live race) included.
    if (data.type === MSG.CONTROL) { if (session) session.processInput(from, data); return; }
    switch (net.controllerAction(from, data.type)) {
      case 'start-race': startRace(); break;
      // Host's "Next race" during a cup intermission (advanceSeriesRace
      // re-checks room state).
      case 'series-next': advanceSeriesRace(); break;
      case 'pause': pauseRace(); break;
      case 'resume': resumeRace(); break;
      case 'return-to-lobby': returnToLobby(); break;
    }
  }
});

// Pull a player's car out of the live race. Fires on playerleave — a clean
// back-out (LEAVE) or a dropped seat whose reconnect grace window elapsed. A
// brief mid-race disconnect does NOT come through here: the car is kept running
// (camera stays on it) so a quick reconnect resumes driving.
function forfeitCar(peerIndex) {
  // The removal happens inside the walk, against the live session; a removal
  // that ends the race queues its end events, which the next frame's drain
  // decides.
  perform(flow.forfeitCar(session ? session.h : 0, peerIndex).effects);
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
//
// The escape hatch ON TOP of this — every racer gone while late joiners wait, so
// give the dropped party a short window and then return to the lobby — is NOT
// here: it is RoomFlow.graceTick, polled by DisplayNet's liveness tick and
// surfaced as onRaceAbandoned below. It used to be a second copy of this
// bookkeeping in JS.
// The RULE is uiModel.autoPause's (which seats count, when the freeze may apply,
// what an empty field means), and the whole gather is C++'s too: "is anyone AT
// those wheels?" comes from RoomFlow over the very participant set the
// abandoned-race grace waits on, synced and read behind the twin
// (ttp_room.h's synced seam) — never re-derived, which is what keeps the
// silent freeze and that policy from ever disagreeing.
function refreshAutoPause() {
  // The input (roomState, carIds, aiIds, seatedIds), the consult rule, the
  // synced participants read AND the effects are all one walk now — one
  // crossing where the shell used to make four over two ABIs. raceEnded is the
  // one input that stays: it is this shell's results-overlay latch.
  perform(flow.autoPause(session ? session.h : 0, net.flow.handle, raceEnded).effects);
}
net.flow.on('rosterchange', refreshAutoPause);

// A dropped player reconnected on a different device (new peerIndex): move their
// still-racing car — engine, render entry and results identity — onto the new
// slot so that phone drives it and the camera keeps following the same car.
function rekeyCarPlayer(oldId, newId) {
  // The session rekey happens inside the walk (before the series-rekey effect
  // it emits — safe: the two are independent wasm handles with no cross-reads,
  // and the corpus pins the order of the EFFECTS, never the query).
  perform(flow.rekeyCarPlayer(session ? session.h : 0, net.flow.handle,
                              oldId, newId).effects);
}

// A seated player renamed themselves. The lobby needs nothing — its seat grid is
// re-read off the room handle on the same _announce that delivered this — but a
// RACE freezes copies of the name at its start, and each has to be moved by hand:
// the cell chip Stage wrote when the car was added (the room-retained field
// row every standings board reads was already repaired inside the walk). A
// no-op for a seat with no car, since a late joiner is in neither.
function renamePlayer(peerIndex, name) {
  // The room-retained field row was repaired inside the rename walk; what is
  // left here is the scene chip and the board re-push.
  scene.setCarName(peerIndex, name);
  // currentField only reaches the phones on the board's NEXT push — mid-race the
  // next car to cross, on the podium never. So re-push the board already out, at
  // the same `over` it went out with; never a first one (see net.hasStandings).
  if (net.hasStandings()) broadcastStandings(raceEnded);
}

// Every race runs a full grid: seats no human took are filled by AI ("CPU")
// racers, so a short-handed lobby still gets a real race. The field size, the
// livery/model wrap and the 'ai-' id namespace are all the orchestration
// layer's world now (flow.configure at boot) — they used to be three consts
// here and a fourth copy of the persona table in aiPersonas.js.

// ---- Grand Prix series ----
// Picking a cup runs its 4 tracks back-to-back: each endRace banks points into
// the room's stored series, holds the room in RESULTS for an intermission, then
// chains straight into the next race (advanceSeriesRace) — the lobby only
// returns after the podium (or on any quit path, which cancels the series).
let seriesTimer = null;         // auto-advance timeout (armed per intermission)
let seriesDeadline = 0;         // when it fires — the countdown label reads this
let intermissionTicker = null;  // ½ s "starting in N…" refresh

// Seat grid + headline live in lobbySeats.js (shared with the gallery preview).
//
// A COUNT, not a roster. The seat rows are read off the room handle in C++
// (ui.rosterSeatsFromRoom), so the only thing this callback still needs in JS is
// how many seats there are — which is the one fact the join plink turns on. The
// roster used to arrive here as an array that was immediately serialized back
// into the wasm to be turned into seats.
function renderRoster(rosterSize, hostPeerIndex) {
  // A bigger roster means someone joined (renames/car picks keep the count) —
  // greet them with the join plink. Lobby only; mid-race arrivals are reconnects.
  sfx(audioDecide.roster(rosterSize, net.roomState === ROOM_STATE.LOBBY));
  renderSeats(el('players'), ui.rosterSeatsFromRoom(net.flow.handle, hostPeerIndex));
  renderLobbyPick();   // the pre-pick cup slot names the host — track joins/renames
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Lobby right-rail cup slot, driven by the same state as the phones'
// track-pick UI (net.mode/cupId/trackId). Pre-pick the slot is empty;
// post-pick it shows the race card (cup / exact track / random). The scan
// hint under the ticket stays up for the whole lobby — joining is possible
// until the race starts.
// The slot's CONTENT is uiModel.cupSlot's — which name, how many races, the
// difficulty pips, which circuits to draw as minis and how they're numbered
// (an undrawn race is a trackId-less chip). It hands back keys plus data
// (never composed copy), so the few English strings and the schematic lookup
// are all that stay here.
const RACES_COPY = { one: () => '1 race', endless: () => 'endless', count: (n) => `${n} races` };
const NAME_COPY = { random: 'Random', tour: 'World Tour' };
function renderLobbyPick() {
  const slot = el('cup-slot');
  if (!slot) return;
  const svgOf = (id) => { const t = trackCatalog.find((e) => e.id === id); return t && t.svg; };
  const m = ui.cupSlot(net.pick);
  renderCupSlot(slot, m && {
    name: NAME_COPY[m.nameKey] || m.name || '?',
    races: RACES_COPY[m.racesKey](m.raceCount),
    // raceCount sizes the maps grid (renderCupSlot pads a counted card's
    // not-yet-drawn races with "?" boxes); endless is a single ∞ box. RANDOM
    // only — a cup's racesKey is 'count' too, and a cup card must never pad
    // (a chip with a missing schematic just costs its picture, not a "?").
    raceCount: m.nameKey === 'random' && m.racesKey === 'count' ? m.raceCount : null,
    difficulty: m.difficulty,
    // Random spoils nothing: a counted card is raceCount grey "?" boxes (an
    // empty list here — renderCupSlot's raceCount padding builds them all)
    // and endless is one grey box carrying ∞; even the drawn race 1 isn't the
    // card's to sell. A veil here rather than in the model — the frozen ui
    // corpus pins cupSlot's random answers to the drawn chip.
    maps: m.nameKey === 'random' ? (m.racesKey === 'endless' ? [{ q: true, glyph: '∞' }] : [])
      : m.maps.map((x) => ({ svg: x.trackId ? svgOf(x.trackId) : null, q: !x.trackId, n: x.n, cup: x.cup })),
    cupId: m.cupId   // biome-tints the mini fields, like the phone picker
  });
}

// Dropped-seat reconnect cards: a QR centred in each disconnected player's
// split-screen cell (same placement as the FINISHED card) so they can scan — their
// own phone OR a new one — and drop back into their exact seat. The card rides on
// their still-racing car via the renderer; Stage._loop keeps it centred.
// Driven by DisplayNet.onReconnectChange; we diff against what's shown so a roster
// reshuffle only adds/removes the cards that changed.
const _rcShown = new Set(); // car ids currently showing a reconnect card
function renderReconnect(seats) {
  const { remove, add } = ui.reconnectDiff([..._rcShown], seats);
  for (const id of remove) { scene.setCarReconnect(id, null); _rcShown.delete(id); }
  // Putting a card up can fail (a seat whose car has no cell), so the shown set
  // records what actually landed — which is why the model only proposes.
  for (const s of add) {
    if (scene.setCarReconnect(s.peerIndex, buildReconnectCard(s))) _rcShown.add(s.peerIndex);
  }
}

// ---- performing the orchestration layer's effects ----
// Every entry point below asks ttp_race.h what happens and then walks the answer
// through here IN INDEX ORDER. That walk is the contract: four of the constraints
// it encodes are silent when broken (COUNTDOWN only after the session exists, the
// DEFERRED auto-pause re-check, points banked before the board, dispose before
// the LOBBY flip), which is exactly why the order is data now instead of the
// shape of this file. Nothing here may reorder, batch or skip.
//
// `ctx` carries the few things an effect names but the layer cannot hold: the
// race results in flight (endRace's callback argument) and the launch's field,
// which `create-session` needs and `set-field` has already delivered.
//
// `ctx.results` IS LOAD-BEARING AND UNTYPED. Three ops read it — 'apply-race-points',
// 'show-results' and the final 'broadcast-standings' — and all three are emitted
// only by the layer's endRace(), which only main.js's endRace() performs, and it
// always passes {results}. Nothing enforces that pairing. If one of those ops
// ever starts being emitted from another entry point, give it its own carrier
// rather than hoping the context happens to be populated.
function perform(effects, ctx = {}) {
  for (const e of effects) applyEffect(e, ctx);
}

// The race walks' performers, one per op of ttp_race_effect_ops_json — a TABLE
// rather than a switch so the coverage is checkable data: the boot assert below
// holds it to the wasm's own vocabulary, turning a missing arm into a load
// failure instead of a half-built race.
const RACE_PERFORMERS = {
  'stop-lobby-demo': () => lobbyDemo.stop(),
  'clear-item-cache': () => _lastItem.clear(),
  'show-screen': (e) => show(e.screen),
  'hide-results': () => el('results').classList.add('hidden'),
  'set-race-flags': (e) => {
    paused = e.paused; autoPaused = e.autoPaused; raceEnded = e.raceEnded;
  },
  'set-pause-overlay': (e) => setPauseOverlay(e.on),
  'set-pause-button': (e) => el('pause-btn').classList.toggle('hidden', !e.shown),
  'reveal-chrome': () => revealRaceChrome(),
  'hold-chrome': () => holdRaceChrome(),
  'reset-scene-cars': (e) => {
    for (const c of [...scene.cars.keys()]) scene.removeCar(c);
    for (const c of e.cars) scene.addCar(c.id, c.colorIndex, c.name, { cell: c.cell, carIndex: c.carIndex });
    scene.rebuild();
  },
  'create-session': (e) => createSession(e),
  'transition': (e) => net.flow.transitionTo(ROOM_STATE[e.to.toUpperCase()]),
  // The renderer reads the grid poses (and then every frame) straight off the
  // engine; the audio hears only the BOUND session, which is why the lobby's
  // attract race is silent for free.
  'bind-session': () => {
    scene.bindSession(session.h);
    audioDecide.bind(session.h);
  },
  // Off the packed HUD rows — the last snapshot parse on this path went with
  // the welcome relight's.
  'paint-initial-hud': () => {
    for (const row of scene.hudRows()) scene.setCarHud(row.id, row);
  },
  'start-countdown': (e) => session.startCountdown(e.seconds),
  'show-countdown': (e) => showCountdownBanner(e),
  'broadcast-countdown': (e) => net.broadcast({ type: MSG.COUNTDOWN, n: e.n }),
  // DEFERRED off the calling stack on purpose — we are inside session.update()
  // and the no-seats-left branch tears the session down. Performing this
  // synchronously is the bug the flag exists to prevent.
  'refresh-auto-pause': (e) => {
    if (e.deferred) setTimeout(refreshAutoPause, 0); else refreshAutoPause();
  },
  'start-music': (e) => sfx(audioDecide.startMusic(e.biome)),
  'stop-music': () => sfx(audioDecide.stopMusic()),
  'show-music-credit': (e) => showMusicCredit(e.on),
  'stop-voices': () => sfx(audioDecide.stopVoices()),
  'item-pickup': (e) => { scene.itemPickup(e.id, e.item); pushHeldItems(); },
  'rocket-impact': (e) => scene.rocketImpact(e.id),
  'rocket-expire': (e) => scene.rocketExpire(e.s, e.lat),
  'broadcast-standings': (e, ctx) => broadcastStandings(e.over, ctx.results),
  'show-results': (e, ctx) => showResults(ctx.results),
  'arm-results-failsafe': (e) => {
    clearTimeout(endTimer);
    endTimer = setTimeout(returnToLobby, e.ms);
  },
  'clear-results-failsafe': () => clearTimeout(endTimer),
  'arm-intermission': (e) => {
    seriesDeadline = e.deadline;
    seriesTimer = setTimeout(advanceSeriesRace, e.ms);
    intermissionTicker = setInterval(renderIntermissionCountdown, 500);
  },
  'clear-intermission': () => clearSeriesTimers(),
  // A chained start has no lobby step, so the new circuit is placed explicitly
  // (selectTrack outside the lobby skips the scene swap) — the results overlay
  // covers the pop.
  'place-track': () => scene.setTrack(track),
  // endParty's teardown — closeRoom bails every phone terminally while the
  // display's own 4001 self-heals into a FRESH room (Net.js onClose
  // {roomClosed}, which also clears the roster), so the next NEW GAME
  // reveals a lobby already sitting on the new room's QR.
  'close-room': () => net.closeRoom(),
  // A fresh party starts clean: drop the ended party's pick so the cup slot
  // empties and Start re-gates on a fresh SELECT_MODE. The PREVIEW deliberately
  // survives — selectedTrackId stays aimed at the dead party's last circuit, so
  // the next lobby keeps its 3D attract race instead of dipping back to the
  // paper diorama (the welcome board still sits on the diorama regardless;
  // backdropShow3D gates on the screen).
  'clear-pick': () => net.clearPick(),
  'render-lobby-pick': () => renderLobbyPick(),
  'refresh-lobby-demo': () => refreshLobbyDemo(),
  'update-backdrop': () => updateBackdrop(),
  'dispose-session': () => {
    if (session) { scene.bindSession(0); audioDecide.bind(0); session.dispose(); session = null; }
  },
  'fade-to-lobby': (e) => {
    fadeBackdrop(() => {
      for (const c of scene.cars.keys()) scene.removeCar(c);
      if (e.placeTrack) scene.setTrack(track);   // the re-aimed pick (random re-roll / cup rewind)
      refreshLobbyDemo();                        // AI back to driving the picked cars
    });
  },
  'remove-scene-car': (e) => scene.removeCar(e.id),
  'stop-car-audio': (e) => sfx(audioDecide.stopCar(e.id)),
  'sync-state': () => net.syncState(),
  'rekey-scene-car': (e) => scene.rekeyCar(e.oldId, e.newId),
  'set-auto-paused': (e) => { autoPaused = e.on; },
  'sync-frozen': () => syncSessionFrozen(),
  'return-to-lobby': () => returnToLobby()
};

// The boot proof: every op this build's race walks can emit has a performer.
// Runs before any race can start, so a port that grew a new op fails its first
// launch instead of dropping a step mid-race.
{
  const missing = flow.effectOps().filter((op) => !RACE_PERFORMERS[op]);
  if (missing.length) throw new Error(`race effect ops with no performer: ${missing.join(', ')}`);
}

function applyEffect(e, ctx) {
  const perform = RACE_PERFORMERS[e.op];
  if (perform) return perform(e, ctx);
  // A race answer may carry NET-vocabulary ops in place: the executor merges
  // the set-track walk's tail (track-change, publish, …) into it. Those are
  // the net performer's; anything neither table knows throws there.
  net.performEffect(e);
}

// The countdown banner. n > 0: "3/2/1". n === 0: "GO!" (the race starts this
// beat, the banner fades over the next via .is-go). n < 0: banner gone. The
// beat's SOUND is the wasm's — it taps the same tick — so there is no cue call.
const CD_COPY = { go: 'GO!' };  // the GO beat's copy; numerals ride the effect
function showCountdownBanner(e) {
  const cd = el('countdown');
  // `go` IS the beat semantics (the effect carries it); no third spelling of
  // "n === 0 means GO" here.
  cd.textContent = e.go ? CD_COPY.go : e.n > 0 ? String(e.n) : '';
  cd.classList.toggle('is-go', e.go);
  // slap each numeral in (re-add .slap around a reflow so the animation restarts
  // on the same element); GO! keeps its own is-go fade-out.
  cd.classList.remove('slap');
  if (e.slap) { void cd.offsetWidth; cd.classList.add('slap'); }
}

// Feed each AI car its pure-pursuit input for this frame, exactly as a phone's
// CONTROL would. Runs every frame (a no-op during the countdown, when update() is).

// ---- race lifecycle ----
// START_GAME gate: the host's "Start race" button is only enabled once every
// other player is ready (controller-side renderReadyFoot); re-checked here so
// a stale or forged START_GAME can't jump the lobby. The host themselves never
// readies — their start IS the commitment.



// The launch knobs the walks cannot know: a fresh seed per race (page RNG —
// the display is the sole authority, so minting it here keeps the engine
// deterministic from the seed while the rolls vary game-to-game), the E2E
// countdown override, and the two URL debug hooks.
function launchArgs() {
  return {
    seed: (Math.random() * 0xffffffff) >>> 0,
    countdownSeconds: window.__countdownSeconds || COUNTDOWN_SECONDS,
    forceItem: _qForceItem || null,   // ?item=<id>: every box rolls this (debug hook)
    botCap: _qBots
  };
}

function startRace() {
  // ONE walk: the go/no-go (room phase, scene, pick, connected players — all
  // read off the room handle in C++), the bag draws a random pick needs, the
  // cup series stood up behind the room, and the launch effects.
  const d = flow.startRace(net.flow.handle, sceneReady, launchArgs());
  if (d.action === 'launch') perform(d.effects);
}

// The 'create-session' effect, performed. The session is the one thing an effect
// can name but not carry: it needs this shell's callbacks, and those callbacks
// are themselves entry points back into the layer.
//
// Fails loudly if the wasm module hasn't finished loading (boot races only).
function createSession(e) {
  // events:'external' — the race walk (drainRaceEvents) owns the queue and the
  // lifecycle routing; the adapter must not touch it. Fail-safe note:
  // RaceSession enforces MAX_RACE_MS internally so AFK/DNF cars can't hang the
  // room forever. A clean 3-lap is ~50-80 s.
  session = new _nativeSim.NativeRaceSession(e.field, track, {
    events: 'external',
    seed: e.seed,
    forceItem: e.forceItem,
    bots: e.bots
  });
  // Debug escape hatch (free-cam inspection recipe, manual console poking). The
  // ONE sanctioned session.engine reach outside the sim path — everything else
  // goes through the session query API (tests/portable-purity.test.js allowlists
  // exactly this line).
  window.__engine = session.engine;
}

// Chain into the cup's next race, straight from the intermission (RESULTS →
// COUNTDOWN — no lobby in between; RoomFlow allows the transition). Reached
// three ways: the intermission's auto-advance timer, the host's "Next race"
// (SERIES_NEXT / the display's results button). startRace's LOBBY guard stays
// intact, so nothing else — a stale START_GAME, __startRace — can skip an
// intermission.
function advanceSeriesRace() {
  // ONE walk: verdict, the series advanced, the pick re-aimed at the cup's
  // next circuit AND the launch — RESULTS → COUNTDOWN with nothing sequenced
  // here. Phones that sat out flip to the wheel off the COUNTDOWN republish.
  const d = flow.advanceSeriesRace(net.flow.handle, sceneReady, launchArgs());
  if (d.action === 'return-to-lobby') { returnToLobby(); return; } // everyone left mid-intermission
  if (d.action === 'advance') perform(d.effects);
}

function clearSeriesTimers() {
  clearTimeout(seriesTimer); seriesTimer = null;
  clearInterval(intermissionTicker); intermissionTicker = null;
}

// ---- race events ----
// The frame's one drain. WHICH events do what — the victory-lap grab that
// spins no roulette, the rocket-strike burst, the countdown routing, the
// intermediate board that is skipped when the last human is home, the whole
// end-of-race order — is the orchestration layer's, decided inside the wasm
// off the queued events and the three live handles. NO AUDIO HERE: the sounds
// were decided as the sim fired the events (ttp_audio_bind).
function drainRaceEvents() {
  if (!session) return;
  const d = flow.drainEvents(session.h, net.flow.handle, {
    biome: scene.biome(), audioReady: audio.ready, fastForwarding,
    intermissionMs: intermissionMs(), nowMs: Date.now(),
    resultsFailsafeMs: flow.resultsFailsafeMs()
  });
  if (d.effects.length) perform(d.effects, { results: d.results });
}

// The finish-moment pair, off one call: `allDone` is true once every CONNECTED
// human car has crossed the line (CPU cars may still be out — the cue to skip
// to results), and `forfeit` names the dropped-racer ghosts to pull out at that
// moment. Both rules are the native UI model's, and the role sets they read
// (car/AI/dropped/finished ids) are gathered off the two handles in C++ —
// the shell no longer crosses the boundary per car to build them.
function raceFlow() {
  return ui.raceFlow(session ? session.h : 0, net.flow.handle);
}

// Live standings for the controllers' results overlay. Pushed as each car
// finishes (over=false) and once more at race end (over=true, so DNF/AFK cars
// resolve and everyone — not just finishers — sees the final board). The BOARD
// is the ui model's, and the results, cup half (standings + chip), late
// joiners and host are all gathered off the live handles in C++. What stays
// here is nothing at all — the AI racers aren't in the lobby roster the
// phones know, so the display is the only side that can name/colour them —
// and the results object endRace's callback carries (no effect can).
function standingsPayload(results, over) {
  return ui.standingsPayload({
    sessionHandle: session ? session.h : 0,
    roomHandle: net.flow.handle,
    over,
    results: results || null,
    autoAdvanceMs: intermissionMs()
  });
}

// The intermission budget — the layer's number (race_flow.h), with the E2E
// override (__intermissionMs) applied shell-side.
function intermissionMs() { return window.__intermissionMs || flow.intermissionMs(); }

function broadcastStandings(over, results) {
  if (!session) return;
  // The final board rides endRace's OWN results object (via the perform
  // context); with none in flight the twin re-reads the live session in C++,
  // which is the same thing mid-race.
  const board = standingsPayload(results || null, over);
  net.setStandings(board);    // standings live in the room snapshot — pushed live + replayed on (re)join
}

// The host ends the results screen with "New game" (RETURN_TO_LOBBY); the
// failsafe (the layer's number) is only a net so a room whose players all
// left mid-podium still recovers. The end-of-race walk itself rides the event
// drain above — banking the points BEFORE the board goes out, and arming the
// intermission only mid-cup, are the layer's order.
let endTimer = null;

// Tick the intermission's "starting in N…" against the auto-advance deadline
// (a fresh ceil each beat instead of a decrementing counter, so it can't drift).
function renderIntermissionCountdown() {
  const secs = el('results-next-secs');
  if (secs) secs.textContent = String(ui.intermissionSecs(seriesDeadline, Date.now()));
}

// The results overlay in its three dressings: plain single-race board, cup
// intermission (points + "next up" footer), cup podium (top-three steps).
// Rows come from the same standingsPayload the phones get, so both screens
// always tell the same story (order, points, joining rows).
//
// WHICH dressing, which rows go on the steps vs in the list, and what each row's
// trailing cell says are uiModel.resultsView's — it answers in KEYS, and the
// table below is where those keys become English. Everything from here down is
// markup.
const TITLE_COPY = {
  // Podium boards celebrate: "<cup> CHAMPS!" on a red header sticker (.is-podium h2).
  cup_champs: (v) => `${v.cupName} CHAMPS!`,
  standings: () => 'Standings',
  results: () => 'Results'
};
const SUB_COPY = {
  cup_race: (v) => `${v.cupName} · Race ${v.race}`,          // endless: no "of N"
  cup_race_of: (v) => `${v.cupName} · Race ${v.race} of ${v.of}`
};
const NEWGAME_COPY = { next_race: 'Next race ▸', new_game: 'New Game' };
function showResults(results) {
  const board = standingsPayload(results, true);
  const v = ui.resultsView(board, { intermissionMs: intermissionMs() });

  el('results-title').textContent = TITLE_COPY[v.titleKey](v);
  // Sub only during intermissions ("Cup · Race N of M") — the podium's CHAMPS
  // header says it all.
  const sub = el('results-sub');
  sub.classList.toggle('hidden', !v.intermission);
  if (v.sub) sub.textContent = SUB_COPY[v.sub.key](v.sub);

  renderPodium(el('results-podium'), v.podiumRows);

  const list = el('results-list');
  list.innerHTML = '';
  for (const row of v.listRows) {
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
    if (row.kind === 'joining') {
      const t = document.createElement('span');
      t.className = 'res-time';
      t.textContent = 'Next race';
      li.appendChild(t);
    } else if (row.kind === 'points') {
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
  next.classList.toggle('hidden', !v.intermission);
  if (v.next) {
    next.textContent = 'Next up: ';
    const b = document.createElement('b');
    b.textContent = v.next.trackName;
    const secs = document.createElement('span');
    secs.id = 'results-next-secs';
    secs.textContent = String(v.next.secs);
    next.append(b, ' — starting in ', secs, '…');
  }

  el('results-newgame').textContent = NEWGAME_COPY[v.newGameKey];
  el('results').classList.toggle('is-podium', v.podium); // list ranks from 4th under the steps
  el('results').classList.remove('hidden');
}

// Top-three steps, arranged 2nd | 1st | 3rd; hidden outside podium boards (the
// model hands back null there). AI keep their (CPU) tag — beating them is the
// story of a short-handed cup. Each step is a livery-coloured sticker block
// carrying its rank numeral.
function renderPodium(wrap, top) {
  wrap.innerHTML = '';
  top = top || [];
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
  const d = flow.returnToLobby(net.flow.handle);
  if (d.action === 'return') perform(d.effects);
}

// End the party and return to the title board (back from the lobby, or a
// future in-UI "End party" action). closeRoom() bails every phone terminally
// (their party-over overlay) while the display's own 4001 self-heals into a
// FRESH room (Net.js onClose {roomClosed}, which also clears the roster) — so
// the next NEW GAME reveals a lobby already sitting on the new room's QR.
function endParty() {
  returnToLobby(); // no-op from the lobby; full race teardown from anywhere else
  // The teardown ORDER is the layer's (flow.endParty), corpus-pinned like
  // every other lifecycle path — this was the one that ran outside perform().
  perform(flow.endParty().effects);
}

// ---- pause ----
// Any player's controller (or the on-screen pause button) can freeze the race;
// the display is authoritative, so it owns `paused` and tells the controllers.
// "New game" routes through returnToLobby (a full reset), so it isn't handled
// here. The verdict AND the five-step order are the walk's
// (ttp_race_pause_json / resume_json); these two only hand in the shell's
// latches and perform.
function pauseRace() {
  perform(flow.pauseRace(session ? session.h : 0, net.flow.handle,
                         { paused, autoPaused, raceEnded }).effects);
}

function resumeRace() {
  perform(flow.resumeRace(session ? session.h : 0, net.flow.handle,
                          { paused, autoPaused, raceEnded }).effects);
}

// The sim is frozen while EITHER pause is set (manual overlay pause OR the
// silent auto-pause), so the two compose: a manual resume while every racer is
// still disconnected keeps the field frozen, and a reconnect during a manual
// pause keeps the overlay's authority. Sync the session's timers to the
// combined state instead of letting each path drive pause()/resume() directly.
function syncSessionFrozen() {
  if (!session) return;
  // What freeze/thaw MEAN — which member ops, in which order, thaw not being
  // freeze reversed — is the plan's (ttp_ui_freeze_plan_json). This walk only
  // performs; an op it cannot perform is a missing capability, same contract
  // as the race-flow walk.
  for (const op of ui.freezePlan(paused, autoPaused, session.paused).ops) {
    switch (op) {
      case 'pause-session': session.pause(); break;
      case 'resume-session': session.resume(); break;
      case 'stop-voices': sfx(audioDecide.stopVoices()); break;
      case 'pause-music': sfx(audioDecide.pauseMusic()); break;
      case 'resume-music': sfx(audioDecide.resumeMusic()); break;
      case 'hold-cars': freezeCars(); break;
      case 'release-cars': freezeCars(false); break;
      default: throw new Error(`freeze op this build cannot perform: ${op}`);
    }
  }
}

// Hold every car where it is, at rest, so nothing keeps spinning its wheels or
// laying rubber while the field is frozen behind an overlay. Two callers: the
// pause overlay, and the finish moment before the AI-only fast-forward runs the
// sim on to the flag (which would otherwise whip the just-finished player's
// chase camera across the track behind the results glass).
function freezeCars(held = true) {
  scene.hold(held);
}

function setPauseOverlay(on) {
  el('pause-overlay').classList.toggle('hidden', !on);
}

// ---- race chrome auto-hide ----
// A running race hides its own furniture after a spell of pointer inactivity:
// the corner buttons (which share the top-right with each cell's place/lap
// readout) fade, and the mouse pointer goes with them — this is a TV surface,
// so a parked arrow is litter on the track. One class on <html> drives both
// (display.css), and any mouse move / tap / key press brings them back.
//
// Armed ONLY while a race is actually running, since a vanished cursor is a
// trap wherever there's something to click: the welcome board, the lobby and
// the results screen never arm it (the pause button is .hidden there — the
// same signal), and pauseRace/resumeRace disarm and re-arm it around the pause
// overlay, whose buttons are the one thing a mouse user MUST be able to hit.
const CHROME_IDLE_MS = 2500;    // starting value — long enough to aim + click after moving
let chromeIdleTimer = 0;
function revealRaceChrome() {
  // Gated on what's actually ON SCREEN, not on `paused`: the pause button is
  // .hidden off-race, and a visible overlay means a modal wants the mouse —
  // true for a real pause AND for the test harness's `paused` preview, which
  // dresses the overlay without touching the pause state.
  if (el('pause-btn').classList.contains('hidden')) return;
  if (!el('pause-overlay').classList.contains('hidden')) return;
  document.documentElement.classList.remove('chrome-idle');
  clearTimeout(chromeIdleTimer);
  chromeIdleTimer = setTimeout(() => document.documentElement.classList.add('chrome-idle'), CHROME_IDLE_MS);
}
function holdRaceChrome() { clearTimeout(chromeIdleTimer); document.documentElement.classList.remove('chrome-idle'); }
for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  window.addEventListener(ev, revealRaceChrome, { passive: true });
}
// Unlock audio on the first real gesture (pointermove is not a user activation,
// so it can't resume a suspended AudioContext — only clicks/keys count).
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { audio.resume(); updateSoundHint(); }, { passive: true });
}
// Until that gesture happens the page is silently muted — surface it, or a solo
// auto-race / an untouched TV reads as "the game has no sound". The pill shows
// while audio is locked and disappears the moment it unlocks; clicking it is a
// gesture, so the window pointerdown listener above does the actual resume.
// Hidden on gallery/test surfaces (their iframes never get gestures) and where
// Web Audio doesn't exist (nothing to unlock).
// The welcome board needs no hint: leaving it takes a click (NEW GAME), which
// IS the unlocking gesture — the pill would nag about a problem already solved.
const _audioSupported = !!(window.AudioContext || window.webkitAudioContext);
if (!_isTestMode && _audioSupported) {
  // Both inputs are events, so no poll: screens change in show() (which calls
  // this) and readiness flips on the context's own statechange, hooked after
  // each unlock gesture (idempotent — resume() reuses the one context).
  updateSoundHint = () => {
    el('sound-hint').classList.toggle('hidden', audio.ready || currentScreen === 'welcome');
    if (audio.ctx) audio.ctx.onstatechange = () => updateSoundHint();
  };
  updateSoundHint();
}

// ---- fullscreen ----
// The big screen wants the whole screen: NEW GAME claims it on the session's
// first click (see the bootstrap tail), and this toggle is the way back out —
// and, more usefully, back IN, since entering needs a user gesture and Esc / a
// tab switch can drop it mid-party with no other way to recover. The button
// mirrors the DOCUMENT's state rather than its own clicks: the browser also
// changes it behind our back (Esc, and a denied request never happens at all).
// Hidden where it can't work: fullscreenEnabled is false both with no API at all
// and inside an iframe that wasn't granted the permission (the gallery's preview
// cards), so it covers both without a test-surface special case.
const _fullscreenSupported = !!document.fullscreenEnabled;
el('fullscreen-btn').classList.toggle('hidden', !_fullscreenSupported);
function enterFullscreen() {
  if (!_fullscreenSupported || document.fullscreenElement) return;
  document.documentElement.requestFullscreen().catch(() => { /* denied/unsupported — play windowed */ });
}
function syncFullscreenBtn() {
  const on = !!document.fullscreenElement;
  el('fullscreen-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
  el('fullscreen-btn').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
}
el('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else enterFullscreen();
});
document.addEventListener('fullscreenchange', syncFullscreenBtn);
syncFullscreenBtn(); // a crash-recovery reload can boot already fullscreen

el('pause-btn').addEventListener('click', () => { paused ? resumeRace() : pauseRace(); });
el('pause-continue').addEventListener('click', resumeRace);
el('pause-newgame').addEventListener('click', returnToLobby); // mid-race quit — cancels a cup too
// On the results board the same button is "Next race ▸" during a cup
// intermission and "New Game" otherwise (label swapped by showResults). The
// ACTION behind the click is the model's too — label and branch can no longer
// disagree.
el('results-newgame').addEventListener('click', () => {
  if (ui.resultsAction(net.flow.handle) === 'advance') advanceSeriesRace();
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
  // Which backdrop each scenario gets (diorama vs the 3D scene) is the
  // harness's call, in ONE place next to the scenarios — see runDisplayScenario.
  const _scn = _scenario;
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
      startRace, returnToLobby,
      defaultTrackId: selectedTrackId || TRACK_LIST[0].id,
      carIndex: _soloCar,
    });
    window.__debugSolo = debugSolo;
    debugSolo.start();
  });
} else {
  show('welcome');
  renderRoster([], null); // paint the open-seat placeholders now, so the lobby reveal is complete
  updateBackdrop();       // diorama until the host picks a track (then the 3D preview)
  startWhenDeviceChosen(); // net.start() warms the room BEHIND the welcome board, gated on the device chooser where it shows

  // NEW GAME — reveal the (already-connecting) lobby. The session's first real
  // click, so it carries the browser unlocks that need a user gesture: fullscreen
  // here, and the AudioContext via the window pointerdown listener above (this
  // same click trips it; the explicit resume() just makes the intent readable).
  el('newgame-btn').addEventListener('click', () => {
    enterFullscreen();
    audio.resume();
    show('lobby');
    updateBackdrop(); // a pick made while on the title board reveals its preview now
  });

  // Browser back: one level up the SCREEN_ORDER stack. WHAT that means per
  // screen is uiModel.BACK_EFFECT (race → the same reset as the pause overlay's
  // "New game"; lobby → end the party, with a fresh room warming behind the
  // title board; welcome is the root and swallows it). Only the History API
  // traversal is here — the plan's non-goal, and the reason this handler owns
  // the two show()-coordination flags: while it runs, show()'s backward steps
  // must not history.back() again (the browser already popped), and our own
  // compensating back() must be swallowed.
  const BACK_ACTION = { 'return-to-lobby': returnToLobby, 'end-party': endParty };
  window.addEventListener('popstate', (e) => {
    if (suppressPopstate) { suppressPopstate = false; return; }
    const act = BACK_ACTION[ui.backEffect(currentScreen)];
    if (!act) {
      // Forward-nav (or a stale reloaded entry) landed ahead of the UI — the
      // welcome board is the root, so swallow the entry instead of acting.
      if (e.state && e.state.screen) { suppressPopstate = true; history.back(); }
      return;
    }
    popstateNavigating = true;
    act();
    popstateNavigating = false;
  });
}
// ---- The window.__* automation surface (E2E + console debugging) ----
// The ONE sanctioned reach into this module's internals: the E2E suite drives the
// real display flow through these globals, and ?solo/console poking reads them (e.g.
// tune music by ear via __audio). Everything is assigned HERE, in one block, so the
// surface is auditable at a glance — with four exceptions that track runtime state
// where it changes: __engine (per-race, in startRace), __track (re-pointed in
// selectTrack), __debugSolo (lazy ?solo loader), __deviceChoicePending (boot flow).
// E2E may also SET timing overrides read elsewhere: __countdownSeconds,
// __intermissionMs, __abandonGraceMs.
window.__net = net; window.__scene = scene; window.__startRace = startRace; window.__track = track; window.__audio = audio; window.__audioDecide = audioDecide;
window.__series = () => flow.seriesState(net.flow.handle); // the room's series state (null outside a cup)
window.__session = () => session; window.__lobbyDemo = lobbyDemo; window.__wakeLock = wakeLock;
window.__sceneReady = scenePromise; // awaited by E2E before starting a race (startRace gates on sceneReady)
// Perf HUD (render/PerfHud.js). show()/hide() arm it without a reload, and
// sample() hands back the same numbers it prints — which is how a scripted GPU
// budget sweep across the catalogue reads a track: show(), race it, sample().
window.__perf = scene.perf;
// The bound biome ABI (shared/biomes.js). Here for the ASSET GALLERY, which
// hosts this page in a frame and draws its own biome picker and legend from it:
// reaching into the frame costs nothing, where importing the module in the
// parent would stand up a second wasm instance to read two lists.
window.__biomes = _biomes;

// Debug settings (faint wrench, bottom-left): interactive editor for this
// page's query params — edits reload the page so each param takes effect
// through its normal boot path above. Lazy import: dev aid, not boot-critical.
import('../shared/debugPanel.js').then(({ initDebugPanel }) => {
  // Capture the engine default ONCE, before any URL ?steerExpo= value is applied
  // (the panel's range field calls live() at init). Used for both the slider's
  // default and the "· default" readout marker — reading it live inside format()
  // would wrongly equal the dragged value.
  const steerDefault = _nativeSim.getNativeSteerExpo();
  return initDebugPanel([
  { section: 'Test harness' },
  { key: 'scenario', label: 'Scenario', hint: 'no relay, fake players', type: 'select',
    options: ['welcome', 'device-choice', 'lobby-empty', 'lobby', 'track', 'assets', 'countdown', 'racing', 'results', 'intermission', 'podium']
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
    min: 0.6, max: 3, step: 0.05, value: steerDefault,
    live: (x) => _nativeSim.setNativeSteerExpo(x),
    format: (n) => n.toFixed(2) + (Math.abs(n - 1) < 1e-9 ? ' · linear' : Math.abs(n - steerDefault) < 1e-9 ? ' · default' : '') },
  // Live: scales the whole scene's per-frame dt (sim, props, FX, camera) for slow-mo inspection — no
  // reload. 1 = normal; drag down to watch fast action (e.g. a rocket strike) play out frame by frame.
  { key: 'timescale', label: 'Time scale', hint: 'slow-mo · live', type: 'range',
    min: 0.1, max: 1, step: 0.05, value: 1, live: (n) => scene.setTimeScale(n),
    format: (n) => n.toFixed(2) + '×' + (Math.abs(n - 1) < 1e-9 ? ' · normal' : '') },
  { section: 'Track' },
  { key: 'track', label: 'Preselect', type: 'select',
    options: TRACK_LIST.map((t) => ({ value: t.id, label: t.name })) },
  { section: 'Rendering' },
  { key: 'biome', label: 'Biome', hint: 'override the cup look (blank = cup decides)', type: 'select',
    options: _biomes.names.map((b) => ({ value: b, label: b })) },
  { key: 'dividers', label: 'Cell dividers', hint: 'ink lines between cells · default on', type: 'select',
    options: [{ value: '0', label: 'off' }] },
  ], { title: 'Display' });
});
