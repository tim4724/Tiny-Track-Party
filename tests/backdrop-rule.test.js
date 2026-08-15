// Paper, or the live 3D behind it.
//
// The rule has THREE clauses and each one earns its place:
//
//   never over the welcome board   — its copy is unreadable over a live track
//   in the LOBBY, only once picked — there is no scene built before that
//   anywhere else, always          — a race is the 3D, by definition
//
// A shell that keeps only the first shows a 3D surface with nothing built on it
// for the whole of a fresh lobby. That is a BLACK SCREEN where the web shows the
// warm paper diorama, and it is the first thing a viewer sees — before anyone
// has picked anything, which is exactly the state a party starts in.
//
// It shipped on tvOS as `screen != .welcome`, and it hid behind the screenshot
// harness twice over: the lobby scenarios never pick a track, so every lobby
// photograph was black and looked like a deliberate dark theme rather than a
// missing backdrop.
//
// THIS IS A SOURCE CHECK because the rule is a shell's — the web spells it in
// `backdropShow3D()` and tvOS in `refreshBackdrop()`, and there is no ABI in
// between to ask. What is pinned is that both spell all three clauses, and that
// each re-evaluates on a PICK rather than only on a screen change: the track can
// arrive from a phone long after the board is up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const codeOf = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');

test('the web states all three clauses', () => {
  const src = codeOf('public/display/main.js');
  const i = src.indexOf('function backdropShow3D');
  assert.ok(i > 0, 'backdropShow3D has moved');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.match(body, /welcome/, 'never over the welcome board');
  assert.match(body, /selectedTrackId/, 'a pick lifts the paper');
  assert.match(body, /roomState/, 'and a race shows the 3D whatever the lobby had');
});

test('the tvOS shell states all three, not just the screen', () => {
  const file = 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift';
  if (!existsSync(path.join(ROOT, file))) return;
  const src = codeOf(file);
  const i = src.indexOf('func refreshBackdrop');
  assert.ok(i > 0, `${file}: no refreshBackdrop — the rule is a line inside show() again?`);
  const body = src.slice(i, src.indexOf('\n    }', i));

  assert.match(body, /welcome/, 'never over the welcome board');
  assert.match(body, /trackId/,
    'a fresh lobby with no pick must show PAPER — otherwise it is a black screen');
  assert.match(body, /roomState/, 'and a race shows the 3D whatever the lobby had');
});

test('a PICK re-asks, not only a screen change', () => {
  // The subtlety that makes this a function rather than a line in show(): the
  // host picks from their phone, minutes after the lobby is already up. A rule
  // evaluated only on navigation would leave the paper down over a built track.
  const file = 'shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift';
  if (!existsSync(path.join(ROOT, file))) return;
  const src = codeOf(file);
  const i = src.indexOf('func setTrack');
  assert.ok(i > 0, 'setTrack has moved');
  assert.match(src.slice(i, i + 500), /refreshBackdrop\(\)/,
    'setTrack must re-ask — the pick is what lifts the paper');
});

test('and so does the room-state flip', () => {
  const file = 'shells/tvos/TinyTrackParty/App/RaceFlowPerformer.swift';
  if (!existsSync(path.join(ROOT, file))) return;
  const src = codeOf(file);
  const i = src.indexOf('case "transition"');
  assert.ok(i > 0, 'the transition op has moved');
  assert.match(src.slice(i, i + 300), /refreshBackdrop\(\)/,
    'a race starting or ending changes which backdrop is right');
});
