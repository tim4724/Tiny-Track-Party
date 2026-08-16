// Four things the tvOS lobby drew differently from the web, none of which was a
// port that had not happened yet — each was a decision taken in a comment,
// alone, that the web had already taken the other way.
//
// They are grouped because they share a shape and the shape is the lesson: a
// shell reasoning from first principles about a screen the web already ships is
// re-deciding, not porting, and the second decision is made without the thing
// that produced the first one (somebody looking at it on a television).
//
//   THE START BUTTON     invented, because "a TV shell needs an affordance"
//   THE CAR PICTURE      a hand-drawn silhouette, because the real ones are "3.5 MB"
//   THE GHOST BUTTON     an ink-filled primary, because the kit had no white variant
//   THE PERF READOUT     built, wired, and switched off
//
// SOURCE CHECKS, because all four are about what a shell draws and there is no
// ABI in between to ask.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
}

// ---- the start button -----------------------------------------------------

test('the web lobby has no start control, and neither does the TV', () => {
  // On the web the host starts from their PHONE (MSG.START_GAME) and the
  // display obeys. The TV button was not a missing affordance, it was a
  // duplicate authority that skipped the "who" — whoever holds the remote — and
  // it was a second road into startRace() with no web twin and therefore no
  // shared test. It shipped broken four separate ways.
  const html = readFileSync(path.join(ROOT, 'public/display/index.html'), 'utf8');
  const lobby = html.slice(html.indexOf('id="lobby"'), html.indexOf('id="race"'));
  assert.doesNotMatch(lobby, /id="start/i, 'premise: the web lobby has no start button');

  const src = shell('shells/tvos/TinyTrackParty/Screens/LobbyView.swift');
  if (src === null) return;
  assert.doesNotMatch(src, /StickerButton\(/,
    'the lobby has a button again — the host starts from their phone on every '
    + 'platform, and a lobby with nothing focusable is correct here');
  assert.doesNotMatch(src, /onStart/,
    'and no start callback should be threaded into it');
});

// ---- the car picture ------------------------------------------------------

test('the seat shows the baked render of the picked car', () => {
  const src = shell('shells/tvos/TinyTrackParty/Screens/CarThumbnail.swift');
  if (src === null) return;
  assert.match(src, /toycar\/thumbs\/\\\(.*\)\.png|toycar\/thumbs/,
    'the thumbnail must load the same pre-baked still the web and the phone '
    + 'picker draw — four hand-authored silhouettes made the TV disagree with '
    + 'the picker in the player\'s own hand');
  assert.doesNotMatch(src, /struct CarSilhouette|struct CarProfile/,
    'the hand-drawn profiles are dead once the stills ship');
});

test('the stills are staged and the model list is the manifest\'s', () => {
  const stage = shell('shells/tvos/scripts/stage-assets.sh');
  if (stage === null) return;
  assert.match(stage, /thumbs/, 'nothing stages the thumbs, so every seat draws its placeholder');

  const src = shell('shells/tvos/TinyTrackParty/Screens/CarThumbnail.swift');
  assert.match(src, /ttp_protocol_manifest_json/,
    'the still\'s filename IS the model id, so the list must come from the '
    + 'manifest — a hand-typed array here is a fifth copy of CAR_MODELS');
});

test('every shipped car model has a still to draw', () => {
  // The failure this catches is quiet: an unstaged model draws the livery
  // placeholder, which looks like a deliberate empty seat.
  const thumbs = path.join(ROOT, 'public/assets/toycar/thumbs');
  const have = new Set(readdirSync(thumbs)
    .filter((f) => f.endsWith('.png') && !f.endsWith('.strip.png'))
    .map((f) => f.replace(/\.png$/, '')));
  const proto = readFileSync(path.join(ROOT, 'public/shared/protocol.js'), 'utf8');
  const list = proto.slice(proto.indexOf('CAR_MODELS'));
  const models = [...list.slice(0, list.indexOf(']')).matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(models.length > 0, 'CAR_MODELS has moved');
  for (const m of models) assert.ok(have.has(m), `no baked still for ${m}`);
});

// ---- the ghost button -----------------------------------------------------

test('the pause card\'s second button is a GHOST, not an ink slab', () => {
  const css = readFileSync(path.join(ROOT, 'public/shared/theme.css'), 'utf8');
  const i = css.indexOf('.btn--ghost');
  assert.ok(i > 0, '.btn--ghost has moved');
  assert.match(css.slice(i, i + 200), /--btn-bg:\s*var\(--surface\)/,
    'premise: the web\'s quiet button is WHITE');

  const kit = shell('shells/tvos/TinyTrackParty/Theme/Sticker.swift');
  if (kit === null) return;
  assert.match(kit, /ghost:\s*Bool/, 'the kit has no ghost variant');

  const pause = shell('shells/tvos/TinyTrackParty/Screens/CountdownView.swift');
  const j = pause.indexOf('struct PauseOverlay');
  assert.match(pause.slice(j, pause.indexOf('\n}', j)), /ghost:\s*true/,
    'New game is drawn as a primary again — the darkest value in the palette '
    + 'beside the green Continue reads as the LOUDER of the two');
});

// ---- the perf readout -----------------------------------------------------

test('the frame-cost overlay is on during development, as the web\'s is', () => {
  const web = readFileSync(path.join(ROOT, 'public/display/render/PerfHud.js'), 'utf8');
  assert.match(web, /this\.show\(\)/, 'premise: the web HUD shows itself at construction');

  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  if (src === null) return;
  assert.match(src, /display\.perf\.show\(\)/,
    'the overlay is built, wired and inert — a debug surface that cannot be seen '
    + 'on the device it was written for is not a debug surface');
});

// ---- the QR ---------------------------------------------------------------

test('both QR panels FILTER, because both downscale under a rotation', () => {
  // `.interpolation(.none)` keeps a QR crisp when it is ENLARGED. Neither of
  // these is: the bitmap is ~800 px, the panels are 308 and 160 points, and the
  // cards they sit on carry the sticker kit's rotation. Point-sampling a
  // rotated downscale drops most of the source and staircases every module
  // edge — which is worse for a decoder, not better.
  for (const rel of ['shells/tvos/TinyTrackParty/Screens/LobbyView.swift',
                     'shells/tvos/TinyTrackParty/Screens/RaceHUDView.swift']) {
    const src = shell(rel);
    if (src === null) continue;
    assert.doesNotMatch(src, /\.interpolation\(\.none\)/, `${rel}: point-samples a QR`);
  }
});

// ---- the die-cut edge -------------------------------------------------------

test('a die-cut edge is HALF the CSS stroke, because a stroke is centred', () => {
  // SwiftUI has no text stroke, so both die-cut faces (the countdown numerals
  // and the wordmark) are white copies of the glyph stamped round a ring — a
  // DILATION by the offset. `-webkit-text-stroke` is centred on the outline, so
  // only half of it shows. Reading the CSS number straight across doubles the
  // cut, which at the countdown's 281-point face was a 24-point white halo and
  // is what "the countdown font is weird" was.
  const css = readFileSync(path.join(ROOT, 'public/display/display.css'), 'utf8');
  assert.match(css, /-webkit-text-stroke:\s*12px/, 'premise: the countdown stroke is 12px');

  for (const [rel, sym] of [
    ['shells/tvos/TinyTrackParty/Screens/CountdownView.swift', 'DieCutText'],
    ['shells/tvos/TinyTrackParty/Theme/Sticker.swift', 'Wordmark']
  ]) {
    const src = shell(rel);
    if (src === null) continue;
    const i = src.indexOf('var edge: CGFloat');
    assert.ok(i > 0, `${rel}: ${sym} has no edge`);
    assert.match(src.slice(i, i + 120), /\/ 2/,
      `${rel}: ${sym}'s edge is the full stroke width — a stamped ring reaches `
      + 'the whole offset outward, where the CSS reaches half of it');
  }
});

test('the countdown scenario actually photographs a countdown', () => {
  // It never had. The launch runs with no countdown, so the flow raises GO and
  // clears the banner about a second later — landing on the same beat as the
  // harness's own write, which then usually lost. Three captures in a row came
  // back with no banner and it read as the view failing to render.
  const src = shell('shells/tvos/TinyTrackParty/Harness/Scenarios.swift');
  if (src === null) return;
  const i = src.indexOf('static func settle');
  assert.ok(i > 0, 'the post-settle hook is gone; the banner will race the GO clear again');
  assert.match(src.slice(i, i + 400), /Task\.sleep/,
    'the write has to wait past the flow\'s own countdown clear');

  const root = shell('shells/tvos/TinyTrackParty/Screens/RootView.swift');
  assert.match(root, /await Scenarios\.settle\(id, to: game\)/,
    'and the runner has to await it before signalling ready');
});
