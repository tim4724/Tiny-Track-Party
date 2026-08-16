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
// two decision sites go through the twins.
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

const haveShell = existsSync(path.join(ROOT, SHELL_FILES[0]));

test('no shell file reaches for the order-sensitive room exports', { skip: !haveShell }, () => {
  for (const f of SHELL_FILES) {
    if (!existsSync(path.join(ROOT, f))) continue;
    for (const raw of RAW) {
      assert.doesNotMatch(codeOf(f), new RegExp(`\\b${raw}\\b`),
        `${f} calls ${raw} directly — the synced read lives inside the live twins now`);
    }
  }
});

test('the auto-pause arbitration goes through its live twin', { skip: !haveShell }, () => {
  // The specific site that was wrong: refreshAutoPause used to gather the
  // input and ask "is anyone at a wheel" itself.
  const src = codeOf('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  const i = src.indexOf('func refreshAutoPause');
  assert.ok(i > 0, 'refreshAutoPause has moved');
  assert.match(src.slice(i, i + 800), /ttp_race_auto_pause_live_json/,
    'the walk gathers the input, reads the participants through the synced seam '
    + 'AND answers the effects — one crossing, nothing re-derived');
});

test('the standings board goes through its live twin', { skip: !haveShell }, () => {
  const src = codeOf('shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift');
  assert.match(src, /ttp_ui_standings_live_json/,
    'the board\'s lateJoiners and host come off the room seam inside the twin');
});

test('the auto-pause is wired to the ROSTER, not only to the post-GO re-check',
  { skip: !haveShell }, () => {
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
