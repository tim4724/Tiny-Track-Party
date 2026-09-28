// The host's lobby pick: five rules, ONE copy, in C++.
//
// `selectModeWalk` (native/runtime/ttp_net.cc, behind
// `ttp_net_on_peer_message_json` / `ttp_net_select_mode_draw_json`) owns the
// host/lobby gate, the run-length clamp, the same-pick guard, the kept draw and
// the atomic store. Both shells PERFORM its effect list and re-derive nothing —
// the rules were written twice for a while (display/Net.js `_applyMode`, then a
// Swift copy in the first tvOS port), and every clause that went missing in a
// copy was visible on the board:
//
//   THE RUN LENGTH        no clamp, and a default of 1 rather than the
//                         manifest's 4 — so a fresh lobby advertised
//                         "Random, 1 race", which the phone's picker cannot
//                         produce and the host cannot get back to.
//   THE SAME-PICK GUARD   re-tapping a cup rebuilt the scene: a track mesh and
//                         a 2048² shadow bake, on the main thread, for a pick
//                         that had not moved.
//   THE DRAWN TRACK       `trackId` stayed null in random mode, so the race
//                         card's mini-map had no circuit to draw. (The card no
//                         longer SHOWS the draw — the random family is veiled —
//                         but the preview scene still drives on it.)
//   THE ATOMIC APPLY      a rejected pick must change nothing; the walk stores
//                         a whole pick or none (storePickAndPush after every
//                         gate), so a state neither end can describe (new mode,
//                         stale cup) cannot be written.
//
// What these tests pin now: the C++ spelling of each rule, and that no shell
// has grown a copy back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return read(rel).split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
}

// ---- the run length is the MANIFEST's ---------------------------------------

test('RANDOM_RACES is in the manifest, not in a shell', () => {
  const proto = read('public/shared/protocol.js');
  assert.match(proto, /var RANDOM_RACES = \{/,
    'the run length lived as two private copies (trackPicker.js and display/Net.js) '
    + 'with nothing between them, which is what the manifest rule exists to stop');
  assert.match(proto, /DEFAULT: 4/);
  assert.match(proto, /MAX: 8/);

  // The mirror, which `protocol_check` holds to the corpus on all four legs.
  const h = read('native/libttp-party/ttp/protocol.h');
  assert.match(h, /RANDOM_RACES_DEFAULT = 4/);
  assert.match(h, /RANDOM_RACES_MAX = 8/);
  // …and the corpus generator has to NAME it, or config-drift's deep-equal is
  // the only thing left and the C++ side is never checked.
  assert.match(read('scripts/gen-protocol-corpus.mjs'), /RANDOM_RACES: P\.RANDOM_RACES/);
});

test('no shell re-declares the number', () => {
  // The shells' copies are GONE entirely: the run-length rule moved behind the
  // walk (ttp_net.cc normRandomRaces over protocol.h). Only the phone's picker
  // UI still reads the manifest block, for its chips.
  for (const rel of ['public/display/Net.js', 'public/shared/trackPicker.js']) {
    const src = shell(rel);
    assert.doesNotMatch(src, /RANDOM_(DEFAULT|MAX)_RACES\s*=\s*\d/,
      `${rel}: a literal run length again — read RANDOM_RACES from the manifest`);
  }
  assert.match(shell('public/shared/trackPicker.js'), /RANDOM_RACES/,
    'the picker must read the manifest block');
  const tv = shell('shells/tvos/TinyTrackParty/Net/Protocol.swift');
  if (tv === null) return;
  assert.doesNotMatch(tv, /RANDOM_RACES|randomRaces/,
    'the tvOS shell reads the number again — its only consumer is the walk, in C++');
});

test('0 is a LEGAL length, so MAX is a ceiling and not half a range', () => {
  // The trap: a falsy check turns ENDLESS into four races. The one normaliser
  // has to test the integer and the bounds, never truthiness.
  const cc = read('native/runtime/ttp_net.cc');
  const norm = cc.slice(cc.indexOf('double normRandomRaces'), cc.indexOf('\n}', cc.indexOf('double normRandomRaces')));
  assert.match(norm, /num >= 0/, 'zero has to be admitted explicitly');
  assert.match(norm, /RANDOM_RACES_MAX/);
});

// ---- the four rules of the pick itself ---------------------------------------

test('a pick is refused unless the room is in the LOBBY and the sender is host', () => {
  const cc = read('native/runtime/ttp_net.cc');
  const i = cc.indexOf('bool selectModeWalk');
  assert.ok(i > 0, 'selectModeWalk has moved');
  assert.match(cc.slice(i, i + 400),
    /!\(from == flow->host\(\)\) \|\| flow->state\(\) != RoomFlow::State::LOBBY/);
});

test('the same pick twice is a no-op — except random, which re-rolls', () => {
  const cc = read('native/runtime/ttp_net.cc');
  const i = cc.indexOf('bool selectModeWalk');
  const body = cc.slice(i, cc.indexOf('\n}', i));
  assert.match(body, /curMode == "track" && strictEquals/);
  assert.match(body, /curMode == "cup" && strictEquals/);
  assert.doesNotMatch(body.slice(body.indexOf('mode == "random"')), /curMode == "random" && strictEquals/,
    'a same-pick guard on random would break the re-roll, which is the whole gesture');
});

test('EVERY random-family tap deals a fresh draw — the keep rule is retired', () => {
  // The keep-the-draw-on-length-change rule existed for a card that showed its
  // tracks; the World Tour pass veiled the random family, so a re-tap dealing
  // fresh circuits is now the whole gesture and the walk draws every time.
  const cc = read('native/runtime/ttp_net.cc');
  assert.doesNotMatch(cc, /keepDraw/,
    'the keep-the-draw rule is back — it was retired with the card that showed '
    + 'its tracks (the random family is veiled now)');
});

test('random resolves a concrete trackId, so the card has a map to draw', () => {
  // `cupSlot`'s random branch pushes ONE map chip and it is the pick's own
  // trackId. Leave it null and the card renders an empty frame.
  const model = read('native/libttp-runtime/ttp/ui_model.cc');
  const i = model.indexOf('if (mode == PickMode::RANDOM)');
  assert.match(model.slice(i, model.indexOf('return true;', i)), /out\.maps\.push_back\(MapChip\{trackId,/);
});

// ---- no shell grows a copy back ----------------------------------------------

test('the tvOS shell performs the pick and re-derives none of it', () => {
  const lobby = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift');
  if (lobby === null) return;
  // The Swift copy of `_applyMode` carried all five rules and drifted on four
  // of them; deleting it is only safe while the walks are actually driven.
  assert.doesNotMatch(lobby, /func applyMode|normRandomRaces|keepDraw/,
    'the pick rules are back in Swift — they live in selectModeWalk, once');
  const net = shell('shells/tvos/TinyTrackParty/Net/PartyNet.swift');
  assert.match(net, /ttp_net_on_peer_message_json/,
    'a SELECT_MODE must reach the walk that owns the rules');
  // The draws protocol is GONE: the bag lives behind the room (seeded once at
  // init_pick), so a random pick draws inside the one walk — a shell that
  // grows the needDraw round trip back is re-deriving the bag.
  assert.doesNotMatch(net, /needDraw|select_mode_draw/,
    'the shuffle-bag draw happens inside the walk now, not in a second half');
  // The stored pick has ONE writer set (the walks): the shell reads it back
  // and never assigns it.
  const coord = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  assert.match(coord, /ttp_net_pick_json/, 'the pick is read where the walks store it');
  assert.doesNotMatch(coord, /\bpick\s*=\s/,
    'a pick mirror again — the stored pick behind the room handle is the one copy');
});

// ---- what a fresh lobby shows ------------------------------------------------

test('the tvOS lobby PREVIEWS at boot and never seeds a pick', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  if (src === null) return;
  // The web's boot-time attract: preview the remembered circuit, keep the room
  // pick null so Start stays gated and the phone picker opens on its own
  // default. The old seeded random pick is the thing this replaces — a seed
  // here would put "Random" on the card of a lobby nobody has touched.
  assert.match(src, /func previewLastCircuit/,
    'with no preview there is no track, with no track no scene, and with no '
    + 'scene the attract race has nothing to drive on — a TV lobby is the IDLE screen');
  assert.doesNotMatch(src, /applyPick\(/,
    'boot must not make a PICK — the preview is the whole design, and a seeded '
    + 'pick un-gates Start for a race nobody chose');
  assert.match(src, /"tinytrack_last_track"/,
    'the remembered circuit must use the web\'s own LAST_TRACK_KEY spelling');
  const show = src.indexOf('show(.lobby)');
  const preview = src.indexOf('previewLastCircuit()', src.indexOf('func boot'));
  assert.ok(show > 0 && preview > show,
    'the demo only runs while the lobby is the current screen, so previewing '
    + 'before show() lifts the backdrop with nothing built behind it');
});

test('a track swap does not build the scene twice', () => {
  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift');
  if (src === null) return;
  const i = src.indexOf('func setTrack');
  const body = src.slice(i, src.indexOf('\n    }', i));
  assert.match(body, /guard id != trackId else \{ return \}/,
    'two cups can share a race-1 circuit, and a re-tap costs a full rebuild');
  assert.match(body, /lobbyDemo\.willRebuild\(for: id\)/,
    'the attract demo rebuilds with its own roster a moment later; building here '
    + 'first pays for two track meshes and two shadow bakes back to back');
});
