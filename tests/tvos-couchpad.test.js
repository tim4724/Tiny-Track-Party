// The tvOS shell's half of the CouchPad launcher contract: the `cpp` platform
// declaration (§6) and the LAN room advertisement (§8).
//
// Both fail SILENTLY, which is why they are pinned rather than left to review.
//
//   §6  `ttp_net_join_url` and `ttp_net_controller_url_template` each take the
//       shell's platform as their LAST argument, and "" is a legal value meaning
//       "declare nothing". A shell that drops the argument therefore still
//       composes a perfectly good join URL — one that just never tells the
//       launcher which box the room is on. The two call sites must also pass the
//       SAME value: the contract requires the QR and the registered template to
//       agree, and nothing at runtime compares them.
//
//   §8  The advertisement is one Bonjour record whose whole payload is the room
//       code. A wrong service type or TXT key publishes happily and is simply
//       never discovered, and there is no error anywhere — the QR keeps working,
//       so the feature looks present and does nothing.
//
// SOURCE CHECKS, on the same terms as tvos-fastlane.test.js: no CI leg runs a
// tvOS app against a launcher, and the composition itself (query vs fragment) is
// already proven through the artifact in tests/party-abi.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
}

const NET = 'shells/tvos/TinyTrackParty/Net/PartyNet.swift';
const ADVERTISER = 'shells/tvos/TinyTrackParty/Net/RoomAdvertiser.swift';
const COORDINATOR = 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift';

// ---- §6: the platform declaration ----------------------------------------

test('the tvOS shell declares cpp=tvos, in ONE place', () => {
  const src = shell(NET);
  if (src === null) return; // a tree without the shell has nothing to check

  assert.match(src, /static let cpPlatform = "tvos"/,
    'the shell must declare its own CouchPad platform — "web" is the browser '
    + 'display\'s and no shell may invent a third spelling');

  // Both URL producers pass it. Dropping it from either is what the ABI's ""
  // default makes invisible.
  for (const fn of ['ttp_net_join_url', 'ttp_net_controller_url_template']) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `${fn} has moved`);
    const call = src.slice(i, src.indexOf('))', i) + 2);
    assert.match(call, /Self\.cpPlatform/,
      `${fn} does not pass the platform — the URL still works and declares NOTHING, `
      + 'so the launcher cannot tell a TV room from a browser one');
  }
});

// ---- §8: the LAN advertisement -------------------------------------------

test('the advertisement is the contract\'s service type and TXT key', () => {
  const src = shell(ADVERTISER);
  if (src === null) return;

  assert.match(src, /serviceType = "_couchpad\._tcp"/,
    'a different service type publishes fine and is discovered by nobody');
  assert.match(src, /codeKey = "c"/,
    'the room code is the WHOLE payload, under key `c`; a record without a '
    + 'usable `c` is ignored by the launcher');

  // `cpr` marks a record published by a CONTROLLER relaying a room it is in.
  // The contract says a display must NEVER set it: it tells the launcher the
  // instance name is not a room label, and ours is (the device name).
  assert.doesNotMatch(src, /"cpr"/,
    'cpr is launcher-only — a display that sets it disclaims its own label');
});

test('the record tracks the room: published when joinable, withdrawn otherwise', () => {
  const src = shell(COORDINATOR);
  if (src === null) return;

  const i = src.indexOf('func syncAdvertisement');
  assert.ok(i > 0, 'syncAdvertisement has moved');
  const body = src.slice(i, src.indexOf('\n    }', i));

  // The room code comes from the NET mirror. `state.roomCode` is a display
  // field the screenshot harness writes "TEST" into, so reading it here would
  // put a fixture room on the air during every gallery capture.
  assert.match(body, /net\.roomCode/,
    'the advertised code must be the relay\'s, not the display field the '
    + 'screenshot harness fabricates');
  assert.doesNotMatch(body, /state\.roomCode/,
    'state.roomCode is harness-writable — advertising it broadcasts fixtures');

  // A full room goes off the air: the launcher hides a full room on resolve,
  // but only re-resolves when a record APPEARS.
  assert.match(body, /proto\.maxPlayers/,
    'no occupancy gate — a full room keeps a stale card on the launcher\'s list');
  // And a backgrounded display stops offering a join it cannot honour.
  assert.match(body, /suspended/,
    'a suspended app must withdraw: the room may survive the wake, but a '
    + 'discovered join would land a player in front of a dead display');
});

test('every road that changes "is this room joinable" syncs the record', () => {
  // The three are the room warming, a roster movement, and the ticket coming
  // down. Miss one and the record is right until precisely the moment it
  // matters — a stale record costs a player a tap into a room that is gone.
  const sites = {
    'shells/tvos/TinyTrackParty/App/GameCoordinator+Net.swift': 'onRoomReady',
    'shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift': 'func refreshLobby',
    [COORDINATOR]: 'func clearJoinTicket'
  };
  for (const [rel, anchor] of Object.entries(sites)) {
    const src = shell(rel);
    if (src === null) continue;
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `${rel}: anchor not found: ${anchor}`);
    assert.match(src.slice(i, i + 900), /syncAdvertisement\(\)/,
      `${rel}: ${anchor} changes whether the room is joinable and does not sync `
      + 'the LAN record');
  }
});
