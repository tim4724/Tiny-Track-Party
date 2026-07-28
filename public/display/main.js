// Display entry — lobby + authoritative race. Owns the Stage (canvas + DOM HUD),
// the race session, the countdown→race→results flow, and per-player
// PLAYER_STATE. The 3D itself is the engine's: see Stage.js / render/Display.js.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { Stage } from './Stage.js';
import { DEV_TRACKS } from '../shared/devTracks.js';
import { loadBiomes } from '../shared/biomes.js';
import { TRACK_SCHEMATICS } from '../shared/trackSchematics.js';
import { AI_PERSONALITIES } from './aiPersonas.js';
import { LobbyDemo } from './LobbyDemo.js';
import { renderSeats, renderCupSlot } from './lobbySeats.js';
import { createWakeLock } from '../shared/wakeLock.js';
import { RaceAudio } from './Audio.js';
// The UI MODEL is C++ too (ttp_ui.h over libttp-runtime/ttp/ui_model.cc). Every
// screen decision below — which seats, which race card, which rows, whether the
// field may freeze — is ITS answer; this file renders and decides nothing. The
// JS twin (uiModel.js) survives only as the oracle ui-corpus.jsonl was recorded
// from, exactly as decide.js does for the audio.
import * as ui from './NativeUiModel.js';
import { ITEM_IDS } from './engine/contract.js';
import { makeShuffleBag } from './shuffleBag.js';
import { CUPS, TRACK_LIST } from '../shared/tracks.js';

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
let suppressPopstate = false;   // the history.back() below is ours — its popstate must not act
let popstateNavigating = false; // this show() IS a popstate retreat — don't pop again (set/cleared by the handler)
function show(name) {
  const prev = currentScreen;
  currentScreen = name;
  for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
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
// catalogue row plus the two mutable per-race fields (the item-roll seed and the
// lap count) the session reads off it.
function trackEntry(t) {
  return { ...t, trackId: t.id, totalLaps: TOTAL_LAPS, seed: 1 };
}
const built = new Map(TRACK_LIST.map((t) => [t.id, trackEntry(t)]));
const trackCatalog = TRACK_LIST.map((t) => ({
  id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
  svg: TRACK_SCHEMATICS[t.id]
}));

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

// No track is selected at first: the lobby shows the plain diorama and the host's
// "Start race" stays disabled until they pick one. ?track=<id> preselects (dev /
// gallery). `track` always holds valid geometry (the pick, or the first track as
// a render default) so the scene + gallery always have something to draw.
const _trackParams = new URLSearchParams(location.search);
const _qTrack = _trackParams.get('track');

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
// ---- the native engine ------------------------------------------------------
// The C++ stack is the ONLY engine: the sim, the cup-series layer above it, and
// the party layer's decisions (room state, relay framing, fastlane netcode). The
// JS twins were retired once every layer was conformance-proven and the whole E2E
// suite ran green on them. Awaited at boot, and a failure is FATAL rather than a
// silent downgrade — there is nothing left to fall back to.
// Still JS by design: rendering, HUD, and the transport I/O (WebSocket /
// RTCPeerConnection), which wasm cannot own without proxying through JS anyway.
const _nativeSim = await import('./NativeRaceSession.js');
const _nativeSeries = await import('./NativeCupSeries.js');
// The audio DECISIONS are C++ too (ttp_audio.h). Only the device half — the
// AudioContext, the cue palette, the song element — is still JS, and it decides
// nothing.
const _nativeAudio = await import('./NativeAudio.js');
await Promise.all([_nativeSim.init(), _nativeSeries.init(), _nativeAudio.init(), ui.init()]);
// The world the UI model resolves ids against, handed over ONCE: the cups, the
// track catalogue and the two field sizes the seat grid needs. Authored data —
// it changes when the game ships, not while it runs — so it is set here rather
// than re-sent with every pick. Before ANY render below (the gallery harness
// grids seats off it too).
ui.configure({ cups: CUPS, catalog: trackCatalog, maxPlayers: MAX_PLAYERS, carCount: CAR_MODELS.length });
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
trackChooser = TRACK_LIST.map((t) => ({
  id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
  svg: _schem.pack(TRACK_SCHEMATICS[t.id].d)
}));
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
// over the diorama. No track picked (and not racing) → dim, so the diorama shows through.
// The welcome board ALWAYS sits on the diorama (its copy is unreadable over a live
// track), even if a pick exists — a phone picking while the TV is on the title
// board, or a dev ?track= preselect. NEW GAME re-runs updateBackdrop to reveal.
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
    const colorIndex = _room.NativeRoomFlow.lowestFreeSlot(used, CAR_COLORS.length);
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
  // Persona (caution + lane) by final grid index so they spread across the WHOLE field;
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
// Two halves, and the split is load-bearing (docs/native-port/shared-cpp-plan.md
// P7 ported one of them to C++ and left the other per-platform):
//   audioDecide  the DECISIONS — which cue, how loud, which voice at what level.
//                NATIVE (native/runtime/ttp_audio.h over libttp-runtime/ttp/
//                audio.cc), reached through NativeAudio.js, which hands back the
//                same command stream the JS layer used to. The JS twin survives
//                as the ORACLE audio-corpus.jsonl was recorded from, nothing
//                more (public/display/audio/decide.js).
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
let lastPlayerState = 0;
// Last held item pushed to each car's phone (peerIndex -> item|null), so ITEM is
// sent only when it changes. Cleared per race (launchRace); a reconnect forces a
// resend via onPlayerWelcomed.
const _lastItem = new Map();
// AI ("CPU") racers that filled empty seats this race: peerIndex -> controller.
// Empty when four humans race. `currentField` is the full roster (humans + AI),
// kept so the results screen can resolve AI names/liveries (they're not in the lobby).
// Which cars are CPU racers. Sourced from the FIELD, never from "do I hold a
// controller for it" — bots drive inside the wasm and hold no JS object at all, so
// a controller-derived test would answer "not an AI" for every bot (that bug broke
// the finish check, and with it cups reaching the podium, plus audio/item/cell
// targeting — see git history for aiBots). The AUDIO no longer asks: the
// decision layer reads the sim's own bot list, which is the same set by
// construction (buildField registers exactly these as ttp_add_bot personas).
let aiCarIds = new Set();
let nativeBotSpecs = []; // persona specs for the in-wasm bots (see buildField)
let currentField = [];
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
  // Every human across the line but CPU cars still circulating? Don't make the
  // humans watch them crawl home — fast-forward the deterministic sim to the
  // flag and show the final board now (the AI get their true finish times).
  // ONE crossing per frame for both answers: `allDone` is read every frame and
  // `forfeit` only on the frame it flips, so asking for them separately would
  // double the traffic to save nothing.
  const flow = session.racing ? raceFlow() : null;
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
    session.fastForwardToEnd(); // runs to raceOver, then fires endRace (sets raceEnded)
    fastForwarding = false;
    return;                               // session ended; the results overlay covers the scene
  }
  // NOTHING about the race is read out per frame any more. The renderer has
  // every car's pose, lean, monster state, item props AND its steer bar — it
  // reads the live Game itself — and so does the audio: this hands the decision
  // layer a clock and takes back a list of commands (the shared curb-scrub
  // throttle, the per-human state voices, a sustained jet per in-flight rocket,
  // plus whatever the race events fired inside the update above decided). The
  // HUD is the ~6 Hz poll below; the last per-frame getSnapshot went with this
  // call.
  sfx(audioDecide.frame(performance.now()));
  if (!session.racing) return; // countdown: visible + steerable, but no HUD yet
  // throttle HUD + PLAYER_STATE to ~6 Hz
  const now = performance.now();
  if (now - lastPlayerState > 160) {
    lastPlayerState = now;
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
    // The one readback still on this loop, and it is here rather than on the
    // HUD block on purpose: this value goes to a PHONE, and the block folds an
    // item it has no code for to "empty" (render/Display.js itemId) — fine for
    // a drawn slot, wrong for a USE button. ~6 Hz, never per frame.
    for (const { id, item } of ui.itemPushes(session.getSnapshot().cars, aiCarIds, _lastItem)) {
      _lastItem.set(id, item);
      net.sendTo(id, { type: MSG.ITEM, item });
    }
  }
};

// ---- net ----
// Random-mode track draws: one bag for the room's lifetime, so "random" walks
// the whole catalogue before any repeat (page RNG, like track.seed).
const randomBag = makeShuffleBag(TRACK_LIST.map((t) => t.id), Math.random);
let currentJoinUrl = '';   // full join link (same string the QR encodes); set on room-ready
const net = new DisplayNet({
  // The room state machine, relay framing and fastlane netcode all run on the
  // C++ party layer; DisplayNet has no JS fallback to choose from.
  ...(_nativeParty || {}),
  trackCatalog,
  // Slim, display-authoritative chooser content for the retained room snapshot.
  carChooser, trackChooser, colorPalette,
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
  inRace: (peerIndex) => !!(session && session.hasCar(peerIndex)),
  // The live race itself, as a native handle: the party layer works out its own
  // participant order (cars + dropped seats) from it in C++ rather than being
  // fed a set from here. 0 between races.
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
  // their next pickup. No-op for a seat with no live car (lobby / late joiner).
  onPlayerWelcomed: (peerIndex) => {
    if (!session || !session.hasCar(peerIndex)) return;
    const c = session.getSnapshot().cars.find((x) => x.id === peerIndex);
    const item = ui.welcomeItem(c);
    _lastItem.set(peerIndex, item);
    net.sendTo(peerIndex, { type: MSG.ITEM, item });
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
  sfx(audioDecide.stopCar(peerIndex)); // its id leaves the loop — no zero-level update will come
  net.syncState(); // inRace(peerIndex) just flipped false with no roster event — republish
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
// what an empty field means); what stays here is reading the live session and
// the room. "Is anyone AT those wheels?" comes from RoomFlow, over the very
// participant set the abandoned-race grace waits on (Net.js _syncActiveOrder) —
// read, never re-derived, which is what keeps the silent freeze and that policy
// from ever disagreeing.
function refreshAutoPause() {
  const carIds = session ? session.carIds() : [];
  const input = {
    hasSession: !!session,
    raceEnded,
    roomState: net.roomState,
    carIds,
    aiIds: aiCarIds,
    // a human at the wheel, or a held seat with its QR up
    seatedIds: new Set(carIds.filter((id) => net.flow.has(id)))
  };
  // allParticipantsDisconnected() pushes the live car set into RoomFlow before
  // answering, so it is read exactly on the ticks the decision consults it.
  const d = ui.autoPause({
    ...input,
    allParticipantsDisconnected: ui.autoPauseAsksParticipants(input) && net.allParticipantsDisconnected()
  });
  if (d.action === 'none') return;
  if (d.action === 'return-to-lobby') { returnToLobby(); return; } // no human cars left at all
  autoPaused = d.autoPaused;
  syncSessionFrozen();
}
net.flow.on('rosterchange', refreshAutoPause);

// A dropped player reconnected on a different device (new peerIndex): move their
// still-racing car — engine, render entry and results identity — onto the new
// slot so that phone drives it and the camera keeps following the same car.
function rekeyCarPlayer(oldId, newId) {
  if (series) series.rekey(oldId, newId); // banked cup points follow the player, car or no car
  if (!session || !session.rekeyCar(oldId, newId)) return;
  scene.rekeyCar(oldId, newId);
  sfx(audioDecide.stopCar(oldId)); // the loop re-creates voices under newId next frame
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
function renderRoster(roster, hostPeerIndex) {
  // A bigger roster means someone joined (renames/car picks keep the count) —
  // greet them with the join plink. Lobby only; mid-race arrivals are reconnects.
  sfx(audioDecide.roster(roster.length, net.roomState === ROOM_STATE.LOBBY));
  renderSeats(el('players'), ui.rosterSeats(roster, hostPeerIndex));
  renderLobbyPick();   // the pre-pick cup slot names the host — track joins/renames
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Lobby right-rail cup slot, driven by the same state as the phones'
// track-pick UI (net.mode/cupId/trackId). Pre-pick the slot is empty;
// post-pick it shows the race card (cup / exact track / random). The scan
// hint under the ticket stays up for the whole lobby — joining is possible
// until the race starts.
// The slot's CONTENT is uiModel.cupSlot's — which name, how many races, the
// difficulty pips, which circuits to draw as minis and how they're numbered. It
// hands back keys plus data (never composed copy), so the two English strings
// and the schematic lookup are all that stay here.
const RACES_COPY = { one: () => '1 race', endless: () => 'endless', count: (n) => `${n} races` };
function renderLobbyPick() {
  const slot = el('cup-slot');
  if (!slot) return;
  const svgOf = (id) => { const t = trackCatalog.find((e) => e.id === id); return t && t.svg; };
  const m = ui.cupSlot({ mode: net.mode, cupId: net.cupId, trackId: net.trackId,
                         randomRaces: net.randomRaces });
  renderCupSlot(slot, m && {
    name: m.nameKey === 'random' ? 'Random' : (m.name || '?'),
    races: RACES_COPY[m.racesKey](m.raceCount),
    difficulty: m.difficulty,
    maps: m.maps.map((x) => ({ svg: svgOf(x.trackId), n: x.n })),
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
  aiCarIds = new Set();
  nativeBotSpecs = [];
  for (const s of cpuSeats(field)) {
    const peerIndex = AI_PREFIX + s.n;
    field.push({ peerIndex, name: s.persona.name, colorIndex: s.colorIndex, carIndex: s.carIndex, stats: s.stats, ai: true });
    // Seed each bot's wander from the race seed + its NUMERIC index (s.n, not the
    // 'ai-N' id string — number+string coerces to NaN>>>0 = 0, which had been
    // handing every bot the same stream): distinct per bot, fresh per race.
    const seed = ((track.seed || 1) + s.n) >>> 0;
    // Bots live INSIDE the wasm (stepped by ttp_update in this loop's exact
    // order), so we record the persona spec rather than build a controller.
    nativeBotSpecs.push({ peerIndex, caution: s.persona.caution, laneBias: s.persona.laneBias, seed });
    aiCarIds.add(peerIndex);
  }
  return field;
}

// Feed each AI car its pure-pursuit input for this frame, exactly as a phone's
// CONTROL would. Runs every frame (a no-op during the countdown, when update() is).

// ---- race lifecycle ----
// START_GAME gate: the host's "Start race" button is only enabled once every
// other player is ready (controller-side renderReadyFoot); re-checked here so
// a stale or forged START_GAME can't jump the lobby. The host themselves never
// readies — their start IS the commitment.
function allRacersReady() {
  return ui.allRacersReady(net.flow.list(), net.flow.host);
}

// The series behind a Random start, per the host's length pick (net.randomRaces).
// Endless (0) is the original behaviour: one track on the card and a draw offered
// at every intermission, so it never finishes. A fixed count instead draws the
// WHOLE card up front — race 1 is the track the lobby already previewed — and
// hands it over with no drawNext, which makes it a cup in every way that matters:
// "Race 2 of 4", a last race, points and a podium. A count of 1 is just a single
// race (no series), which the phone can't pick but the wire allows.
function randomSeries(SeriesImpl) {
  const cup = (tracks) => ({ id: 'random', name: 'Random', tracks });
  if (!net.randomRaces) return new SeriesImpl(cup([net.trackId]), { drawNext: () => randomBag.draw() });
  if (net.randomRaces === 1) return null;
  const rest = Array.from({ length: net.randomRaces - 1 }, () => randomBag.draw());
  return new SeriesImpl(cup([net.trackId, ...rest]));
}

function startRace() {
  if (net.roomState !== ROOM_STATE.LOBBY || !sceneReady) return;
  if (!selectedTrackId) return;              // a track must be chosen first
  // Only seat connected players — a dropped racer's seat lingers (dimmed, with a
  // reconnect QR) but doesn't get a car until they're back.
  const players = ui.connectedPlayers(net.flow.list());
  if (!players.length) return;
  // Cup mode: this Start commits to the whole Grand Prix — the series engine
  // walks the cup from race 1 (the lobby preview already sits on it — the cup
  // pick resolved trackId to its first track). Random mode: a series of drawn
  // tracks, either ENDLESS (each intermission pulls the next from the bag; only
  // a lobby return ends it) or a fixed card, per the host's length pick. Exact
  // picks stay single races.
  // The series layer runs on C++ too (the shuffle bag stays JS — it is page RNG,
  // not sim state, so the draw is OFFERED to the port, which takes it only when
  // the rules call for one).
  const SeriesImpl = _nativeSeries.NativeCupSeries;
  series = net.mode === 'cup' ? new SeriesImpl(CUPS.find((c) => c.id === net.cupId))
    : net.mode === 'random' ? randomSeries(SeriesImpl)
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
  _lastItem.clear(); // fresh race — first frame resends every phone's (empty) ITEM

  show('race');
  el('results').classList.add('hidden');
  paused = false;
  autoPaused = false;
  raceEnded = false;             // un-freeze the scene for the new race
  setPauseOverlay(false);
  el('pause-btn').classList.remove('hidden'); // pausable from the countdown on
  revealRaceChrome();                         // buttons + cursor up, then auto-fade until activity

  // (re)build scene cars. AI cars get no split-screen cell (cell:false) — they're
  // opponents in the shared world, not players watching the screen.
  for (const c of [...scene.cars.keys()]) scene.removeCar(c);
  for (const p of field) scene.addCar(p.peerIndex, p.colorIndex, p.name, { cell: !p.ai, carIndex: p.carIndex });
  // A new race rebuilds the scene from scratch, which is also what puts the
  // warning cones back upright, clears last race's rubber patina and restores
  // every collected item box.
  scene.rebuild();

  // Same construction shape the JS engine had, native implementation. Fails
  // loudly if the wasm module hasn't finished loading (boot races only).
  session = new _nativeSim.NativeRaceSession(field, track, {
    onRaceEvent,
    forceItem: _qForceItem || null, // ?item=<id>: every box rolls this (debug hook)
    bots: nativeBotSpecs,
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
      // The beat's own sound is the wasm's (it taps the same tick), so there is
      // no cue call here — it rides out on the next frame's drain, in order.
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
      net.flow.transitionTo(ROOM_STATE.PLAYING); // roomState=playing in the snapshot lands phones on the drive screen
      // The auto-pause only freezes while PLAYING (see refreshAutoPause), so a
      // field that emptied during the countdown has to be re-checked now that we
      // are. DEFERRED off this stack on purpose: we are inside session.update(),
      // and the no-seats-left branch tears the session down.
      setTimeout(refreshAutoPause, 0);
      // Background song for the whole race, picked from the biome's pool. The
      // ?biome inspector override steers the music too, so an override race
      // sounds like it looks.
      if (audio.ready) sfx(audioDecide.startMusic(scene.biome())); // the pick only happens if the device can play it
      showMusicCredit(true);                   // now-playing credit chip (bottom-left)
    },
    onRaceEnd: endRace,
  });
  // Debug escape hatch (free-cam inspection recipe, manual console poking). The
  // ONE sanctioned session.engine reach outside the sim path — everything else
  // goes through the session query API (tests/portable-purity.test.js allowlists
  // exactly this line).
  window.__engine = session.engine;

  // Flip to COUNTDOWN only now that the session exists: the statechange
  // republishes the snapshot, and each player's inRace is read from
  // session.hasCar(). Transitioning BEFORE the session was built published a
  // snapshot with the OLD (or null) session — every racer's inRace came out
  // false, so phones briefly showed "you're in the next race" until the GO beat
  // (PLAYING) republished with the live session. No frame/await runs between
  // here and now, so this is the first snapshot any phone sees for the race.
  net.flow.transitionTo(ROOM_STATE.COUNTDOWN);

  // Hand the renderer this race's session: from here it reads the grid poses
  // (and then every frame) straight off the engine. Paint each cell's HUD right
  // away too, so the chrome sits at its final size through the countdown — no
  // pop-in at GO (the racing loop takes over from the first ~6 Hz tick).
  scene.bindSession(session.h);
  // ... and the audio, for the same reason: this is the race the room can hear,
  // so its events and countdown beats make a sound while the lobby's attract
  // race (never bound) stays silent. Before startCountdown, so the opening beat
  // is not the one that gets away.
  audioDecide.bind(session.h);
  for (const c of session.getSnapshot().cars) scene.setCarHud(c.id, c);
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
  // Phones that sat out the last race on "you're in the next race!" flip to the
  // wheel off the snapshot: launchRace's COUNTDOWN transition republishes it with
  // their inRace now true (GAME_END never comes mid-cup, so this is their signal).
  const players = ui.connectedPlayers(net.flow.list());
  if (!players.length) { returnToLobby(); return; } // everyone left mid-intermission
  series.advance();
  net.setTrack(series.currentTrackId);   // publishes + selectTrack (track/totalLaps swap)
  // selectTrack outside the lobby skips the scene swap (no preview to fade);
  // a chained start has no lobby step, so place the new circuit explicitly —
  // the results overlay covers the pop.
  scene.setTrack(track);
  launchRace(players); // COUNTDOWN statechange republishes the snapshot (joiners now inRace) — no re-welcome
}

function clearSeriesTimers() {
  clearTimeout(seriesTimer); seriesTimer = null;
  clearInterval(intermissionTicker); intermissionTicker = null;
}

// ---- race events ----
// NO AUDIO HERE ANY MORE, and the deletion is the point. A pickup, a banana, a
// spin, a lap chime and a countdown beat are decided into sound INSIDE the wasm
// as the sim fires them (ttp_audio_bind names the session the room can hear), so
// the shell no longer reads each event's world point, gathers every human's
// position as the listener set, and hands all of it back over the boundary — a
// pair of ABI calls per human per event, gone. The fast-forward burst stays
// silent for the same reason it always did, decided in the same place: it is
// skipping, not racing (ttp_fast_forward runs muted).
function onRaceEvent(e) {
  // As each car crosses the line, push the running standings so a finished
  // player's phone flips to the results overlay and it fills in for everyone
  // else as more cars finish.
  if (!e) return;
  // A live car's grab always re-spins its cell roulette (incl. a box swap that re-rolls
  // the same item) — a finished car's victory-lap grab has no usable slot, so no spin.
  if (!fastForwarding && e.type === 'pickup' && !e.finished) scene.itemPickup(e.id, e.item);
  // Rocket strike: pop a one-shot impact burst on the target (frustum culling drops it
  // off-screen). Skipped during the silent fast-forward, like the audio above.
  if (!fastForwarding && e.type === 'spin' && e.cause === 'rocket') scene.rocketImpact(e.id);
  // A rocket self-destructing at the end of its flight (a whiff): detonate at its
  // track point (the boom is audioForRaceEvent's, scaled like every world cue).
  if (!fastForwarding && e.type === 'rocket_expire') scene.rocketExpire(e.s, e.lat);
  if (e.type !== 'finish') return;
  if (fastForwarding) return; // endRace sends the final board once; don't spam one per AI car
  // If that finish was the last human's, we're about to fast-forward to the flag
  // (only CPU cars remain) and endRace will send the final board — skip this
  // intermediate push so the last human jumps straight to results, no flash of
  // the "FINISHED" hero for a race that's effectively already decided.
  if (humansAllDone()) return;
  broadcastStandings(false);
}

// The live race's car list split into the roles the UI model reasons over —
// which car is a CPU racer, whose phone has dropped, who is already home. Read
// off the session + the room here (the part that names this shell's objects) so
// the RULES over them stay plain-data pure (uiModel.humansAllDone /
// forfeitCandidates).
function raceRoleSets() {
  const carIds = session ? session.carIds() : [];
  const disconnectedIds = new Set();
  const finishedIds = new Set();
  for (const id of carIds) {
    if (net.flow.isDisconnected(id)) disconnectedIds.add(id);
    if (session.carFinished(id)) finishedIds.add(id);
  }
  return { carIds, aiIds: aiCarIds, disconnectedIds, finishedIds };
}

// The finish-moment pair, off one call: `allDone` is true once every CONNECTED
// human car has crossed the line (CPU cars may still be out — the cue to skip
// to results), and `forfeit` names the dropped-racer ghosts to pull out at that
// moment. Both rules are the native UI model's.
function raceFlow() {
  if (!session) return { allDone: false, forfeit: [] };
  return ui.raceFlow(raceRoleSets());
}
function humansAllDone() { return raceFlow().allDone; }

// Live standings for the controllers' results overlay. Pushed as each car
// finishes (over=false) and once more at race end (over=true, so DNF/AFK cars
// resolve and everyone — not just finishers — sees the final board). The BOARD
// is uiModel.standingsPayload's; what stays here is naming the objects it reads
// — currentField (the AI racers aren't in the lobby roster the phones know, so
// the display is the only side that can name/colour them), the live cup, and
// RoomFlow's late-joiner set.
function standingsPayload(results, over) {
  return ui.standingsPayload({
    results: results.results,
    field: currentField,
    cup: series ? { standings: series.standings(), info: seriesInfo() } : null,
    lateJoiners: net.lateJoiners(),
    hostPeerIndex: net.flow.host,
    over
  });
}

// The cup's progress chip on every STANDINGS board (uiModel.seriesInfo).
function seriesInfo() {
  const cup = series.cup;
  return ui.seriesInfo({
    cupId: cup.id, cupName: cup.name,
    endless: series.endless,
    raceIndex: series.raceIndex, raceCount: series.raceCount,
    finished: series.finished, nextTrackId: series.nextTrackId,
    catalog: TRACK_LIST,
    autoAdvanceMs: intermissionMs()
  });
}

// The intermission budget, with the E2E override (__intermissionMs) applied.
function intermissionMs() { return window.__intermissionMs || INTERMISSION_MS; }

function broadcastStandings(over) {
  if (!session) return;
  const board = standingsPayload(session.getResults(), over);
  net.setStandings(board);    // standings live in the room snapshot — pushed live + replayed on (re)join
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
  sfx(audioDecide.stopVoices());               // the frozen frame must not hold wind/squeal voices open
  sfx(audioDecide.stopMusic());                // race over → results screen is quiet
  showMusicCredit(false);
  paused = false;                              // results aren't pausable
  autoPaused = false;
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  holdRaceChrome();
  broadcastStandings(true);                    // final board → phones show the full results overlay
  showResults(results);
  clearTimeout(endTimer);
  endTimer = setTimeout(returnToLobby, RESULTS_FAILSAFE_MS);
  // Mid-cup: this results screen is an INTERMISSION — arm the auto-advance into
  // the next race (the host can jump it early via SERIES_NEXT / the on-screen
  // button; advanceSeriesRace disarms the failsafe above). __intermissionMs is
  // the E2E hook, like __countdownSeconds.
  if (series && !series.finished) {
    const wait = intermissionMs();
    seriesDeadline = Date.now() + wait;
    seriesTimer = setTimeout(advanceSeriesRace, wait);
    intermissionTicker = setInterval(renderIntermissionCountdown, 500);
  }
}

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
  if (net.roomState === ROOM_STATE.LOBBY) return;
  clearTimeout(endTimer);
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
  // Tear the session down BEFORE the flow flips to LOBBY: that transition sweeps
  // held disconnected seats (Net._freeDisconnectedSeats → playerleave), and with
  // the session already gone forfeitCar no-ops instead of racing an endRace on
  // the way out.
  if (session) { scene.bindSession(0); audioDecide.bind(0); session.dispose(); session = null; }
  net.flow.transitionTo(ROOM_STATE.LOBBY);
  // Reachable straight from a live race (controller RETURN_TO_LOBBY, solo's R
  // key) — kill any state voices or a boost wind would drone on in the lobby.
  sfx(audioDecide.stopVoices());
  sfx(audioDecide.stopMusic());
  showMusicCredit(false);
  paused = false;
  autoPaused = false;
  raceEnded = false;
  setPauseOverlay(false);
  el('pause-btn').classList.add('hidden');
  holdRaceChrome();
  aiCarIds = new Set(); currentField = [];
  // controllers return to the lobby off the snapshot (roomState=lobby)
  show('lobby');
  // Crossfade from the frozen finish frame back to the attract demo (through the diorama):
  // drop the race cars + restart the demo under cover so the reset doesn't pop on screen.
  fadeBackdrop(() => {
    for (const c of scene.cars.keys()) scene.removeCar(c);
    if (trackSwapped) scene.setTrack(track); // the re-aimed pick (random re-roll / cup rewind)
    refreshLobbyDemo();           // AI back to driving the picked cars
  });
}

// End the party and return to the title board (back from the lobby, or a
// future in-UI "End party" action). closeRoom() bails every phone terminally
// (their party-over overlay) while the display's own 4001 self-heals into a
// FRESH room (Net.js onClose {roomClosed}, which also clears the roster) — so
// the next NEW GAME reveals a lobby already sitting on the new room's QR.
function endParty() {
  returnToLobby(); // no-op from the lobby; full race teardown from anywhere else
  net.closeRoom();
  // A fresh party starts clean: drop the ended party's pick so the welcome
  // board and the next lobby sit on the paper diorama again, with an empty
  // cup slot and no attract demo, exactly like a cold boot.
  net.clearPick();
  selectedTrackId = null;
  renderLobbyPick();
  refreshLobbyDemo();  // no pick → stops the attract demo
  show('welcome');
  updateBackdrop();    // fade the 3D preview back out to the diorama
}

// ---- pause ----
// Any player's controller (or the on-screen pause button) can freeze the race;
// the display is authoritative, so it owns `paused` and tells the controllers.
// "New game" routes through returnToLobby (a full reset), so it isn't handled here.
function pauseRace() {
  if (!ui.canPause({ hasSession: !!session, paused, roomState: net.roomState })) return;
  paused = true;
  syncSessionFrozen();
  net.syncState();  // paused is snapshot state — the republish is what tells the phones
  setPauseOverlay(true);
  holdRaceChrome(); // the overlay is a mouse target — cursor + buttons stay put while it's up
}

function resumeRace() {
  if (!ui.canResume({ hasSession: !!session, paused })) return;
  paused = false;
  syncSessionFrozen();
  net.syncState();  // paused cleared — the republish is what tells the phones
  setPauseOverlay(false);
  revealRaceChrome(); // racing again — re-arm the fade (this click already hid the overlay)
}

// The sim is frozen while EITHER pause is set (manual overlay pause OR the
// silent auto-pause), so the two compose: a manual resume while every racer is
// still disconnected keeps the field frozen, and a reconnect during a manual
// pause keeps the overlay's authority. Sync the session's timers to the
// combined state instead of letting each path drive pause()/resume() directly.
function syncSessionFrozen() {
  if (!session) return;
  const move = ui.freezeTransition({ paused, autoPaused, sessionPaused: session.paused });
  if (move === 'freeze') {
    session.pause();
    sfx(audioDecide.stopVoices());       // frozen cars must not keep their wind/squeal going
    sfx(audioDecide.pauseMusic());       // ... and the music holds where it was
    freezeCars();                        // hold the field at rest behind the overlay
  } else if (move === 'thaw') {
    session.resume();
    freezeCars(false);                   // back to reading the live engine
    sfx(audioDecide.resumeMusic());
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
  window.addEventListener(ev, () => audio.resume(), { passive: true });
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
  setInterval(() => el('sound-hint').classList.toggle('hidden', audio.ready || currentScreen === 'welcome'), 500);
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
  // Gallery/test. DOM-only previews (welcome / lobbies / device-choice) keep the
  // default diorama backdrop (no track picked, matching the real boards); race
  // previews reveal the 3D scene the harness renders the track + cars into.
  const _scn = _scenario;
  if (!['welcome', 'lobby', 'lobby-empty', 'device-choice'].includes(_scn)) {
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
window.__series = () => series; // live CupSeries (null outside a cup)
window.__session = () => session; window.__lobbyDemo = lobbyDemo; window.__wakeLock = wakeLock;
window.__sceneReady = scenePromise; // awaited by E2E before starting a race (startRace gates on sceneReady)
// Perf HUD (render/PerfHud.js). show()/hide() arm it without a reload, and
// sample() hands back the same numbers it prints — which is how a scripted GPU
// budget sweep across the catalogue reads a track: show(), race it, sample().
window.__perf = scene.perf;

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
    options: ['welcome', 'device-choice', 'lobby-empty', 'lobby', 'track', 'countdown', 'racing', 'results', 'intermission', 'podium']
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
