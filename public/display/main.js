// Display entry — lobby + authoritative race. Owns the Stage (canvas + DOM HUD),
// the race session, and the countdown→race→results flow. The 3D itself is the
// engine's: see Stage.js / render/Display.js.
//
// What stays HERE is the race core and the wiring that joins the layers: the
// session, the pause/auto-pause latches, the effect walk that performs the
// orchestration layer's answers, and the net callbacks. Everything with its own
// state and no stake in a race was split out beside it — see the imports below.
import { DisplayNet, fetchQR, renderQR, renderJoinUrl, buildReconnectCard } from './Net.js';
import { Stage, HUD_TICK_MS } from './Stage.js';
import { DEV_TRACKS } from '../shared/devTracks.js';
import { LobbyDemo } from './LobbyDemo.js';
import { renderSeats, renderLobbyPick, renderCupShelf } from './lobbySeats.js';
import { createWakeLock } from '../shared/wakeLock.js';
import { RaceAudio } from './Audio.js';
// The native stack, stood up once in a fixed order (configure before read, world
// before any render) — see boot.js.
import { bootEngine, trackEntry, progressChooser } from './boot.js';
// The two race-screen overlays, painting model answers; the gallery previews
// drive these same functions so a preview cannot drift from live play.
import { showCountdownBanner, renderResults } from './raceOverlays.js';
// The lobby's 3D backdrop: reveal + the track→track crossfade state machine.
import { setBackdrop3D, crossfadeBackdrop } from './backdrop.js';
// TV-surface furniture with no stake in the race: the auto-hiding chrome, the
// fullscreen toggle, the copy toast. Importing this module installs them.
import { revealRaceChrome, holdRaceChrome, enterFullscreen, showToast, copyText } from './chrome.js';
import { dismissDeviceChoice, startWhenDeviceChosen } from './deviceChoice.js';
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

const { MSG, ROOM_STATE, COUNTDOWN_SECONDS, TOTAL_LAPS, CAR_COLORS, CAR_MODELS, MAX_PLAYERS, FIELD_SIZE, carStats } = window;
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

// NEW GAME answers from the first paint. The engine boot below top-level-awaits
// the wasm, so a click landing mid-boot would find a button with no listener —
// this listener attaches ahead of every await. Pre-boot the click claims the
// gesture-bound unlock (fullscreen) and reveals the lobby IMMEDIATELY: its
// markup is complete without the engine (index.html seeds the open seats; the
// ticket shows a blank square until the room opens and the QR fades in). The
// bootstrap tail re-runs the reveal through show() — the history entry, the
// sound hint, the backdrop — once the engine is up. (No audio carry needed: if
// this gesture predates the AudioContext, the sound-hint pill catches the next
// one.)
let newGameClicked = false;
let newGameClick = () => {
  newGameClicked = true;
  screens.welcome.classList.add('hidden');
  screens.lobby.classList.remove('hidden');
  enterFullscreen();
};
el('newgame-btn').addEventListener('click', () => newGameClick());

// ---- tracks ----
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
// The WARP BENCH likewise has one surface: the ladder is the scenario (see
// devTracks.js), so ?scenario=warp needs no second parameter to be useful.
const _qTrack = _trackParams.get('track')
  || (_trackParams.get('scenario') === 'assets' ? 'showroom' : null)
  || (_trackParams.get('scenario') === 'warp' ? 'warp' : null);

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
// ?bootdelay=<ms> — DEBUG: hold the engine boot this long, so the pre-boot NEW
// GAME path (the caught click held pressed, then the lobby reveal and the
// ticket's QR/URL fade) can be watched by hand instead of racing a fast machine.
const _qBootDelay = parseInt(_trackParams.get('bootdelay'), 10) || 0;
if (_qBootDelay) await new Promise((r) => setTimeout(r, _qBootDelay));
// ---- the native engine ------------------------------------------------------
// Stood up in boot.js, which owns the ordering; a failure is FATAL rather than a
// silent downgrade, so nothing here catches. `flow` is the RACE ORCHESTRATION
// (ttp_race.h): it answers in ORDERED EFFECT LISTS and `perform` below walks
// them — the order is the contract, so nothing here may reorder or skip.
const {
  sim: _nativeSim, audio: _nativeAudio, flow, biomes: _biomes,
  trackList: TRACK_LIST, built, trackCatalog, trackChooser, carChooser, party: _nativeParty
} = await bootEngine({
  maxPlayers: MAX_PLAYERS, fieldSize: FIELD_SIZE, carModels: CAR_MODELS, carColors: CAR_COLORS,
  carNames: window.CAR_NAMES || [], carStatsRows: CAR_MODELS.map((_, i) => carStats(i)),
  totalLaps: TOTAL_LAPS
});
// The livery hex palette (colorIndex → colour) rides the retained room snapshot
// beside the two chooser payloads, so a phone's livery dots always match the car
// the display paints.
const colorPalette = CAR_COLORS.slice();
// DEV_TRACKS (shared/devTracks.js): an unknown ?track= id is looked up in the dev
// catalogue and built like any track — but only the ONE requested id, and only in a
// ?scenario= test surface or ?solo (they're keyboard test ranges — e.g. the 'gym'
// collision track): a LIVE lobby preselecting one would offer phones a track their
// picker catalog doesn't contain.
if ((_isTestMode || _isDebugSolo) && _qTrack && !built.has(_qTrack)) {
  // Dev ranges are in the wasm's track table too (gen-track-defs-header.mjs
  // carries DEV_TRACKS past the catalogue), so this only has to name one.
  const _devDef = DEV_TRACKS[_qTrack];
  if (_devDef) built.set(_qTrack, trackEntry({ id: _qTrack, ..._devDef }, TOTAL_LAPS));
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

// The couch's star record: the shell only ferries the blob between storage and
// the engine — every derivation (stars, the Playroom lock) is the wasm's. Test
// surfaces skip the load so gallery/E2E scenarios start from the fresh couch
// they synthesize; ?unlockAll=1 is the dev override, and it still loads the
// record so banking keeps working under it.
const PROGRESS_KEY = 'tinytrack_progress';
if (!_isTestMode) {
  let saved = null;
  try { saved = localStorage.getItem(PROGRESS_KEY); } catch (_) {}
  ui.progressLoad(saved, _trackParams.has('unlockAll'));
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
  // The backdrop may already WANT the 3D (a mid-boot NEW GAME landed in the
  // lobby before the scene was up): reveal it only now, two frames into the
  // loop, so the fade starts from a drawn track rather than a black canvas.
  requestAnimationFrame(() => requestAnimationFrame(updateBackdrop));
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

// Whether the 3D backdrop should be showing at all. The live lobby always has a
// preview track (the boot fallback above), so in practice the diorama shows
// through only on test surfaces that boot without one. The welcome board ALWAYS
// sits on the diorama (its copy is unreadable over a live track), even though a
// preview or pick exists behind it — NEW GAME re-runs updateBackdrop to reveal
// the 3D attract race already running underneath.
function backdropShow3D() {
  // Never reveal a canvas that hasn't drawn a frame yet — the fade would come
  // up from black instead of from the diorama. scenePromise re-runs
  // updateBackdrop once the first track frames exist.
  if (!sceneReady) return false;
  if (currentScreen === 'welcome') return false;
  return !!selectedTrackId || (net && net.roomState !== ROOM_STATE.LOBBY);
}

// The reveal itself is backdrop.js's; what stays here is WHEN, and the test-mode
// veto. Test surfaces own the backdrop (see runDisplayScenario's DIORAMA_ONLY):
// the harness un-dims #scene for its 3D scenarios before the scene has booted,
// and scenePromise's deferred call here would re-dim it back to a blank page.
function updateBackdrop() {
  if (_isTestMode) return;
  setBackdrop3D(backdropShow3D());
}

// The lobby's track→track crossfade, with the two predicates it re-asks after a
// frame: whether to reveal at all, and whether the lobby is still the thing on
// screen (a race starting under a crossfade drops the still instead).
function fadeBackdrop(mid) {
  crossfadeBackdrop(scene, mid, {
    show3D: backdropShow3D,
    stillValid: () => sceneReady && net.roomState === ROOM_STATE.LOBBY
  });
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
  // Named for what it is, not `flow` — that is the orchestration MODULE in this
  // scope, and a local of the same name shadowed it for the whole branch below.
  const finish = (slowTick && session.racing) ? raceFlow() : null;
  if (finish && finish.allDone) {
    // A dropped racer's ghost can never cross the line — forfeit any such car now
    // that every connected human is home, so the burst (and the race) ends
    // promptly instead of running to the guard cap on a car that can't finish.
    // fresh array — safe while forfeitCar removes cars
    for (const id of finish.forfeit) forfeitCar(id);
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
  // The couch's stars/lock for the phones' picker — composed AFTER the
  // progression load above, so a returning couch's first snapshot already
  // carries its record.
  progressChooser: progressChooser(),
  defaultTrackId: _defaultPickId,
  // The random-track shuffle bag lives BEHIND THE ROOM now; what the shell
  // supplies is one page-entropy seed (DisplayNet hands it to init_pick).
  hasBag: true,
  // selectTrack swaps the 3D preview; renderPick refreshes the cup slot even
  // when the resolved trackId didn't change (e.g. a mode switch landing on the
  // same circuit, where selectTrack early-returns).
  onTrackChange: (id) => {
    // Remember every confirmed pick's resolved circuit: it is what the NEXT
    // party's lobby attracts on before anyone joins.
    if (id && built.has(id)) { try { localStorage.setItem(LAST_TRACK_KEY, id); } catch (_) {} }
    selectTrack(id); renderPick();
  },
  onRoomReady: async ({ roomCode, joinUrl }) => {
    // The room code rides along in the join URL's path; the ticket shows one
    // URL line with the trailing code highlighted in the accent colour.
    currentJoinUrl = joinUrl;                   // the full link the join ticket copies
    try { const u = new URL(joinUrl); renderJoinUrl(el('joinurl'), u.host + u.pathname, roomCode); }
    catch (_) { renderJoinUrl(el('joinurl'), joinUrl, roomCode); }
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
  renderPick();   // the pre-pick cup slot names the host — track joins/renames
  scheduleLobbyDemo(); // reflect joins/leaves/car-picks in the attract demo (debounced)
}

// Lobby right-rail cup slot, driven by the same state as the phones' track-pick
// UI (the room's stored pick). Pre-pick the slot is empty; post-pick it shows
// the race card. The markup and the copy live in lobbySeats.js, shared with the
// gallery preview so the two cannot drift. The scan hint under the ticket stays
// up for the whole lobby — joining is possible until the race starts.
function renderPick() {
  renderLobbyPick(el('cup-slot'), net.pick, trackCatalog, progressChooser());
}

// The left rail's "Your cups" shelf, from the wasm-stamped catalogue. Refreshed
// only when the record can have moved: boot (below) and the persist performer.
function refreshCupShelf() {
  if (!_isTestMode) renderCupShelf(el('cup-shelf'), ui.catalogue().cups);
}
refreshCupShelf();

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
    prepareNextTrack();
  },
  'clear-intermission': () => clearSeriesTimers(),
  // A chained start has no lobby step, so the new circuit is placed explicitly
  // (selectTrack outside the lobby skips the scene swap) — the results overlay
  // covers the pop. Usually already meshed by prepareNextTrack, in which case
  // this and the reset below both come out as no-ops.
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
  'render-lobby-pick': () => renderPick(),
  'refresh-lobby-demo': () => refreshLobbyDemo(),
  'update-backdrop': () => updateBackdrop(),
  'dispose-session': () => {
    if (session) { scene.bindSession(0); audioDecide.bind(0); session.dispose(); session = null; }
  },
  // ALWAYS place the track, not only on the effect's `placeTrack`. That flag
  // answers "did the PICK move" (a random re-roll, a cup rewind), which was the
  // only way the scene could be showing the wrong circuit — until prepareNextTrack
  // gave the shell its own reason to have moved it. Quitting a cup FROM the
  // intermission rewinds to race 1, which is usually the circuit already
  // selected, so the pick has not moved and the layer says there is nothing to
  // place — while the scene is sitting on the speculatively-meshed race 2. The
  // lobby then attracts on a circuit its own card does not name. Placing
  // unconditionally costs nothing when the scene is already right (Stage skips
  // an unchanged signature), and the promise goes back to the crossfade so the
  // still holds until the swap lands instead of uncovering the old one.
  'fade-to-lobby': () => {
    fadeBackdrop(() => {
      for (const c of scene.cars.keys()) scene.removeCar(c);
      const placed = scene.setTrack(track);
      refreshLobbyDemo();                        // AI back to driving the picked cars
      return placed;
    });
  },
  'remove-scene-car': (e) => scene.removeCar(e.id),
  'stop-car-audio': (e) => sfx(audioDecide.stopCar(e.id)),
  'sync-state': () => net.syncState(),
  'rekey-scene-car': (e) => scene.rekeyCar(e.oldId, e.newId),
  'set-auto-paused': (e) => { autoPaused = e.on; },
  'sync-frozen': () => syncSessionFrozen(),
  'return-to-lobby': () => returnToLobby(),
  // The walk banked a finished cup's stars; the shell writes the blob it was
  // handed (same try/catch as every localStorage touch — Safari private mode
  // throws on access) and recomposes the snapshot's progress chooser, so the
  // phones' pickers carry the new stars when the party is back in the lobby.
  'persist-progression': (e) => {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(e.progress)); } catch (_) {}
    net.setChooser({ progress: progressChooser() });
    refreshCupShelf();
  }
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
  // RaceSession enforces its DNF timeout ladder internally (grace after the
  // first flag, a shorter one for a lone straggler, a hard cap when nobody
  // finishes) so AFK/DNF cars can't hang the room. A clean 3-lap is ~50-80 s.
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

// Mesh the cup's next circuit NOW, under the intermission board, instead of
// under the countdown that follows it. A scene build blocks the main thread for
// a few hundred ms and the results overlay is near-opaque paper, so the swap is
// both invisible and free here; performed at the chained start it is neither —
// the countdown is already ticking over the OLD circuit while the thread is
// busy, which is the stutter and the stale track this exists to remove.
//
// The field is the same one the launch will build (the AI fill is a function of
// the connected humans, not of the race seed), so the launch's reset-scene-cars
// re-adds the same roster onto the prepared scene and both of its rebuild
// triggers fall out as no-ops. If a player joins or leaves in the meantime the
// roster moves, the launch rebuilds, and we are back to the old behaviour
// rather than a wrong scene.
//
// WHICH circuit is next is the series', never guessed here. Fire-and-forget:
// nothing waits on it, and a prepare still in flight when the host taps "Next
// race" early is picked up by Stage's own rebuild queue.
function prepareNextTrack() {
  const series = flow.seriesState(net.flow.handle);
  const next = series && series.nextTrack;
  if (next && built.has(next)) scene.prepare(built.get(next));
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

// The results overlay, painted by raceOverlays.js. WHICH dressing (single race,
// cup intermission, podium) and every row's content are uiModel.resultsView's;
// what happens here is only the two crossings that need this shell's state — the
// live board, and the intermission budget.
function showResults(results) {
  const board = standingsPayload(results, true);
  renderResults(ui.resultsView(board, { intermissionMs: intermissionMs() }), CAR_COLORS);
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

// ---- audio unlock + the sound hint ----
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

// ---- the buttons the race screen owns ----
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
    // `built` is the track catalogue as entries — the chained-start preview is
    // the one scenario that shows a SECOND circuit, so it needs to name one.
    { scene, track, scenePromise, built }
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
  // NEW GAME — reveal the (already-connecting) lobby. The listener and the
  // pre-boot half of the handshake live at the top of the file; here the click
  // becomes the real reveal, adding what only the booted engine can do: the
  // history entry, the sound hint, the backdrop. The audio unlock rides the
  // window pointerdown listener above (this same click trips it; the explicit
  // resume() just makes the intent readable).
  newGameClick = () => {
    enterFullscreen();
    audio.resume();
    show('lobby');
    updateBackdrop(); // a pick made while on the title board reveals its preview now
  };
  show('welcome');
  // The caught-click replay runs IMMEDIATELY after show('welcome'), before
  // anything that forces a style recalc (startWhenDeviceChosen reads computed
  // style): if the lobby's display:none from show('welcome') were committed
  // between the two, re-showing it would restart every entrance animation in
  // it — the already-visible chrome re-slapping is what a mid-boot click must
  // NOT cause.
  if (newGameClicked) newGameClick();
  renderRoster([], null); // paint the open-seat placeholders now, so the lobby reveal is complete
  updateBackdrop();       // diorama until the host picks a track (then the 3D preview)
  startWhenDeviceChosen(() => net.start()); // warms the room BEHIND the welcome board, gated on the device chooser where it shows

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
// The field list is debugFields.js.
Promise.all([import('../shared/debugPanel.js'), import('./debugFields.js')])
  .then(([{ initDebugPanel }, { displayDebugFields }]) => initDebugPanel(
    displayDebugFields({
      maxPlayers: MAX_PLAYERS, carNames: window.CAR_NAMES || [], trackList: TRACK_LIST,
      biomeNames: _biomes.names, scene, sim: _nativeSim
    }),
    { title: 'Display' }
  ));
