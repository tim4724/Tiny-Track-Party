// The lobby preview: a track under a MOVING camera with CARS DRIVING ON IT.
//
// Three separate things have to be true for that picture, and each of them is a
// single call that a shell can simply not make. None of the three fails loudly:
//
//   1. THE CAMERA RIG. `ttp_display_camera`'s default is `TTP_CAM_STILL` — the
//      fitted whole-track iso view, HELD MOTIONLESS. A shell that never pushes a
//      mode gets a perfectly correct render of the circuit that happens to be a
//      photograph. The web asks for `TTP_CAM_BBOX` at boot (`scene.orbit` +
//      `scene.bboxOrbit`, main.js); tvOS asked for nothing at all for the whole
//      of the port, and "the lobby preview does not rotate" was the symptom.
//
//   2. THE SCENE ROSTER. `buildFrame` walks `ttp_display_build`'s roster and
//      looks each slot's car up in the BOUND session — so a car the session has
//      and the roster does not is simulated, stepped, and drawn by nothing. Both
//      shells therefore have to put the attract field in the scene BEFORE they
//      bind: the web calls `scene.addCar` per entry then `bindSession`, tvOS
//      calls `onField` then `onSession`. tvOS only ever did the second half, so
//      the attract race ran invisibly through every lobby.
//
//   3. THE CUP CARD. `ttp_ui_cup_slot_json` answers the right rail. tvOS called
//      it from the screenshot harness and from nowhere else, so a host picking a
//      cup on their phone changed nothing on the television.
//
// THESE ARE SOURCE CHECKS because all three are a shell's to make — there is no
// ABI to ask "did anyone push a camera mode". What is pinned is that each shell
// makes the call, and where the ORDER matters (roster before bind) that it makes
// them in the right one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const codeOf = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');

// A MISSING SHELL FILE IS A FAILURE. Every path below is checked in, so the
// only way one is absent is a broken checkout — and this file used to `return`
// on that, which turned most of its cases into a green line reporting coverage
// the run never had. The three bugs in the header were all found by hand, in a
// tree where these greps were passing.
const shell = (rel) => {
  assert.ok(existsSync(path.join(ROOT, rel)), `${rel} is missing — broken checkout?`);
  return codeOf(rel);
};

// ---- 1. the camera rig ----------------------------------------------------

test('the web asks for the bbox sweep with no cells', () => {
  const src = codeOf('public/display/main.js');
  assert.match(src, /scene\.bboxOrbit\s*=\s*true/,
    'the lobby sweeps an ellipse round the track bbox; without it the preview is STILL');
  // Stage.js is what turns those flags into the ABI call.
  assert.match(codeOf('public/display/Stage.js'), /bboxOrbit\s*\?\s*CAM\.BBOX/);
});

test('the tvOS shell pushes a camera mode at boot', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  assert.match(src, /display\.camera\(TTP_CAM_BBOX\)/,
    'no camera mode pushed — the ABI default is TTP_CAM_STILL, so the lobby preview '
    + 'renders correctly and never moves, which reads as a still image rather than a bug');
});

test('…and LATCHES it, so a push that predated the surface is re-pushed', () => {
  // Pushing it is not enough. With no display the ABI is a documented safe
  // no-op, so a pre-attach push is dropped in C++ while the caller believes it
  // landed — the same trap `attach` already repairs for cells, the bind and the
  // card mask. The camera is the only ONE-SHOT among them: `boot()` pushes it
  // once and its async work races SwiftUI's first layout pass, so losing that
  // race left TTP_CAM_STILL for the life of the app. Intermittent by
  // construction, and it looks like a correct render of a motionless track.
  const src = shell('shells/tvos/TinyTrackParty/Render/DisplayHost.swift');
  const cam = src.indexOf('func camera(');
  assert.ok(cam > 0, 'DisplayHost.camera has moved');
  assert.match(src.slice(cam, src.indexOf('\n    }', cam)), /lastCamMode = mode/,
    'the camera mode is not latched — nothing can re-push it after an attach');

  const i = src.indexOf('func attach(');
  assert.ok(i > 0, 'DisplayHost.attach has moved');
  const body = src.slice(i, src.indexOf('\n    }', i));
  assert.match(body, /ttp_display_camera\(mode\)/,
    'attach re-pushes cells, the bind and the card mask but NOT the camera mode, '
    + 'so a mode pushed before the surface existed is lost permanently');
});

// ---- 2. the scene roster --------------------------------------------------

test('the web puts the attract field in the scene before binding it', () => {
  const src = codeOf('public/display/LobbyDemo.js');
  const add = src.indexOf('addCar');
  const bind = src.indexOf('bindSession');
  assert.ok(add > 0 && bind > add,
    'addCar must precede bindSession: a bound session whose cars own no roster '
    + 'slot is drawn by nothing at all');
});

test('the tvOS attract demo hands its field to the scene, then binds', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/LobbyDemo.swift');
  const field = src.indexOf('onField?(');
  const session = src.indexOf('onSession?(handle)');
  assert.ok(field > 0,
    'LobbyDemo never hands its field to the scene — the roster stays whatever the '
    + 'last race left, which in a fresh lobby is EMPTY and draws no cars');
  assert.ok(session > field,
    'the roster has to be in place before the session is bound');
});

test('and the coordinator actually wires that callback', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Net.swift');
  assert.match(src, /lobbyDemo\.onField\s*=/,
    'an unwired callback is the same bug with an extra step');
});

test('the demo cars take NO split-screen cell', () => {
  // Every attract car owning a cell would put the lobby under four chase
  // cameras instead of one overview — the web says `cell: false` per addCar.
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift');
  // The literal lives in the shared field→SceneCar mapper (both the full
  // rebuild and the in-place re-dress route through it).
  const i = src.indexOf('func demoSceneCars');
  assert.ok(i > 0, 'demoSceneCars has moved');
  assert.match(src.slice(i, i + 700), /cell:\s*false/);
});

// ---- 3. the cup card ------------------------------------------------------

test('the web refreshes the cup slot on every roster render', () => {
  const src = codeOf('public/display/main.js');
  const i = src.indexOf('function renderRoster');
  assert.ok(i > 0, 'renderRoster has moved');
  assert.match(src.slice(i, src.indexOf('\n}', i)), /renderPick\(\)/,
    'the pre-pick slot names the host, so a join or a rename changes it');
});

test('the tvOS lobby refresh asks for the cup slot', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift');
  const i = src.indexOf('func refreshLobby');
  assert.ok(i > 0, 'refreshLobby has moved');
  assert.match(src.slice(i, src.indexOf('\n    }', i)), /refreshCupSlot\(\)/,
    'nothing else calls it on the live path, so the right rail stays empty forever');
  assert.match(src, /ttp_ui_cup_slot_json/,
    'the card is the MODEL\'s answer — a shell composing one would be a second rule');
});

// ---- the harness must not photograph a screen the game cannot produce -----

test('a picked lobby scenario stages the TRACK, not just the card', () => {
  // The third time this harness has misrepresented the lobby: it showed a cup
  // card over paper, because it set `state.cupSlot` by hand and never picked a
  // track. So the gallery could not have caught either of the two bugs above,
  // in principle — the surface that exists to verify the look was verifying a
  // composition the live board never produces.
  const src = shell('shells/tvos/TinyTrackParty/Harness/Scenarios.swift');
  const i = src.indexOf('case "lobby-tour"');
  assert.ok(i > 0, 'the picked-lobby scenarios have moved');
  const body = src.slice(i, src.indexOf('case "countdown"', i));
  // The pick WALK is the live path: its track-change effect stages the scene
  // and refreshes the card (wireNet's onTrackChange), so the scenario drives
  // one call and fabricates only its inputs.
  assert.match(body, /net\.applyPick\(/, 'no pick made — the backdrop stays PAPER');
  assert.doesNotMatch(body, /state\.cupSlot\s*=/,
    'assigning the card directly is how this scenario went stale in the first place');
});

test('every tvOS scenario case names a real gallery id', async () => {
  // THE DRIFT THIS FILE ALREADY CARRIED. The harness dispatches on the gallery
  // table's `id`, but four of its labels had been written against the web
  // harness's `key` instead — `lobby` and `lobby-cup`, neither of which is an id
  // — so `lobby-tour`, `racing-sidewinder` and `chain` fell through to
  // `default` and the capture reported three screens as ones this platform does
  // not have. A case nothing dispatches to is silent by construction; only the
  // table can say.
  const { GALLERY_SCENARIOS } = await import(
    require('node:url').pathToFileURL(
      path.join(ROOT, 'public/shared/galleryScenarios.js')).href);
  const ids = new Set(GALLERY_SCENARIOS.map((s) => s.id));
  // `bench` is deliberately not a card: it photographs nothing, it is the live
  // race the frame-cost readout is logged from.
  ids.add('bench');
  const src = shell('shells/tvos/TinyTrackParty/Harness/Scenarios.swift');
  const body = src.slice(src.indexOf('switch id {'), src.indexOf('\n        default:'));
  // The LABELS only — a case body is full of quoted engine keys ("mode",
  // "track") that are nothing to do with this list. A label runs from `case` to
  // the colon that ends its line, and may wrap.
  const labels = [...body.matchAll(/^\s*case\s+([\s\S]*?):\s*$/gm)].map((m) => m[1]);
  const cased = labels.flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(cased.length > 10, 'the scenario switch has moved');
  assert.deepEqual(cased.filter((s) => !ids.has(s)), [],
    'case labels that are not gallery ids');
});
