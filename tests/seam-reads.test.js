// Cross-layer reads that must go THROUGH the seam, not around it.
//
// CLAUDE.md states the rule: "if you are about to pull state out of one wasm
// layer only to hand it to another, add a seam accessor instead". What it cannot
// state is that a shell reached past one — that is invisible to every corpus,
// because the shell is the part a corpus does not replay.
//
// It has happened once already. The tvOS coordinator called
// `ttp_room_all_participants_disconnected` directly, which answers off whatever
// participant set the last `ttp_room_sync_active_order` left behind. Nothing
// failed; the answer was simply computed from a stale world — and the silent
// auto-pause and the ABANDONED-RACE grace are supposed to be ONE definition of
// "is anyone driving".
//
// The seam has since moved INTO C++: the live twins
// (`ttp_ui_auto_pause_live_json`, `ttp_ui_standings_live_json`) do the synced
// read internally through `ttp_room.h`'s `*_synced` accessors, and the liveness
// walk pushes the sync on its own ticks. That is the strongest form of the
// rule — a caller that could drop the sync no longer exists — so what is left
// to pin is exactly that: NO shell file touches the raw exports at all, and the
// standings board's late-joiner read goes through the synced one. (The
// auto-pause site, the one that was actually wrong, is pinned harder in
// `abi-vocabulary.test.js`, which requires the twin's answer to reach the effect
// walker rather than merely be called.)
//
// THE BOARD'S ANCHOR MOVED, AND WAS NOT DROPPED. It used to be "the tvOS
// coordinator calls `ttp_ui_standings_live_json`", which worked while a shell
// composed the board. The board is composed and RETAINED in C++ now, so no
// shell calls anything — and a rule whose subject has left the file it searches
// is a green line over a search that never runs, which is the failure this
// file's own history is about. So the subject is the COMPOSER: there is exactly
// one composition, both of its writers go through it, and it is the thing that
// does the synced read.
//
// This is a source check because it has to be. The C++ cannot help: from inside
// the ABI a direct call is a legal call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Comments quote the wrong spelling on purpose — that is how a note stops
// someone reintroducing it — so only code is searched.
const codeOf = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');

// The order-sensitive raw exports. Their one legitimate caller is C++ (the
// walks and the live twins); a Swift call site is a read off a maybe-stale set.
const RAW = [
  'ttp_room_all_participants_disconnected',
  'ttp_room_late_joiners_json',
  'ttp_room_sync_active_order'
];

const SHELL_FILES = [
  'shells/tvos/TinyTrackParty/Net/PartyNet.swift',
  'shells/tvos/TinyTrackParty/App/GameCoordinator.swift',
  'shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift',
  'shells/tvos/TinyTrackParty/App/GameCoordinator+Net.swift',
  'shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift',
  'shells/tvos/TinyTrackParty/App/RaceFlowPerformer.swift'
];

test('no shell file reaches for the order-sensitive room exports', () => {
  for (const f of SHELL_FILES) {
    // A MISSING FILE IS A FAILURE. The shell is checked in, so absence is a
    // broken checkout — and a skip here is a green line over a search that
    // never ran, on a rule whose whole point is that nothing failed last time.
    assert.ok(existsSync(path.join(ROOT, f)), `${f} is missing — broken checkout?`);
    for (const raw of RAW) {
      assert.doesNotMatch(codeOf(f), new RegExp(`\\b${raw}\\b`),
        `${f} calls ${raw} directly — the synced read lives inside the live twins now`);
    }
  }
});

// Where the board is composed, now that it is nobody's shell state.
const COMPOSER = 'native/runtime/ttp_ui.cc';

test('the standings board is composed ONCE, and that composition reads the SYNCED seam', () => {
  const src = codeOf(COMPOSER);
  const at = src.indexOf('static Value composeBoard(');
  assert.ok(at > 0,
    `${COMPOSER}: composeBoard has moved — it is the board's one composition, `
    + 'and this rule has no subject without it');
  const body = src.slice(at, src.indexOf('\n}\n', at));

  assert.match(body, /ttp_room_late_joiners_synced\(/,
    'the board\'s lateJoiners must come off the SYNCED accessor: the raw one answers '
    + 'off whatever participant set the last sync left behind');
  assert.doesNotMatch(src, /\bttp_room_late_joiners_json\b/,
    `${COMPOSER} reaches for the raw late-joiner export — the synced read is the rule`);

  // Both writers of the retained board go through it. A second composition is
  // how the synced read gets dropped without anyone touching the line above.
  for (const [fn, what] of [
    ['const char* ttp_ui_standings_live_json(', 'the JSON export (the conformance surface)'],
    ['bool ttp_live_store_standings(', 'the retaining seam the race walk calls'],
  ]) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `${COMPOSER}: ${fn} has moved`);
    assert.match(src.slice(i, src.indexOf('\n}\n', i)), /composeBoard\(/,
      `${what} composes a board of its own instead of calling composeBoard`);
  }
});

test('no shell composes a standings board', () => {
  // The three files that used to. A shell that starts composing again has
  // reintroduced the mirror, and with it its own copy of the never-raise-a-first
  // -board gate and the no-session refusal.
  for (const f of [
    'public/display/main.js',
    'shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift',
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt',
  ]) {
    assert.ok(existsSync(path.join(ROOT, f)), `${f} is missing — broken checkout?`);
    assert.doesNotMatch(codeOf(f), /\bttp_ui_standings_live_json\b|\bstandingsPayload\b/,
      `${f} composes a standings board — the board is retained behind the room handle, `
      + 'and what a shell does about one is republish');
  }
});

test('the auto-pause is wired to the ROSTER, not only to the post-GO re-check', () => {
  // The other half of the same bug, and the one with teeth: the freeze only
  // ever ran from the deferred re-check after GO, so a party that walked away
  // MID-RACE left the cars driving themselves. The web wires it to every
  // roster movement (`flow.on('rosterchange', refreshAutoPause)`).
  const lobby = codeOf('shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift');
  const i = lobby.indexOf('func refreshLobby');
  assert.ok(i > 0, 'refreshLobby has moved');
  const body = lobby.slice(i, lobby.indexOf('\n    }', i));
  assert.match(body, /refreshAutoPause\(\)/,
    'refreshLobby is the one place that knows the roster moved — the freeze rides it');
});
