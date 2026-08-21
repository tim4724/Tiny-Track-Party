// The Android TV shell's half of the CouchPad launcher contract: the `cpp`
// platform declaration (§6) and the LAN room advertisement (§8). The twin of
// tests/tvos-couchpad.test.js.
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
//   §8  The advertisement is one DNS-SD record whose whole payload is the room
//       code. A wrong service type or TXT key publishes happily and is simply
//       never discovered, and there is no error anywhere — the QR keeps working,
//       so the feature looks present and does nothing.
//
// SOURCE CHECKS, on the same terms as androidtv-fastlane.test.js: no CI leg runs
// this app against a launcher, and the composition itself (query vs fragment) is
// already proven through the artifact in tests/party-abi.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KOTLIN = 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack';

function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

const NET = `${KOTLIN}/PartyNet.kt`;
const ADVERTISER = `${KOTLIN}/RoomAdvertiser.kt`;
const COORDINATOR = `${KOTLIN}/GameCoordinator.kt`;

// ---- §6: the platform declaration ----------------------------------------

test('the Android shell declares cpp=androidtv, in ONE place', () => {
  const src = shell(NET);
  if (src === null) return; // a tree without the shell has nothing to check

  assert.match(src, /const val CP_PLATFORM = "androidtv"/,
    'the shell must declare its own CouchPad platform — "web" is the browser '
    + 'display\'s and no shell may invent a third spelling');

  // Both URL producers pass it. Dropping it from either is what the ABI's ""
  // default makes invisible.
  for (const fn of ['ttp_net_join_url', 'ttp_net_controller_url_template']) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `${fn} has moved`);
    const call = src.slice(i, src.indexOf('))', i) + 2);
    assert.match(call, /CP_PLATFORM/,
      `${fn} does not pass the platform — the URL still works and declares NOTHING, `
      + 'so the launcher cannot tell a TV room from a browser one');
  }
});

// ---- §8: the LAN advertisement -------------------------------------------

test('the advertisement is the contract\'s service type and TXT key', () => {
  const src = shell(ADVERTISER);
  if (src === null) return;

  // NsdManager's convention carries the trailing dot and Bonjour's omits it;
  // the same record goes on the wire either way.
  assert.match(src, /SERVICE_TYPE = "_couchpad\._tcp\.?"/,
    'a different service type publishes fine and is discovered by nobody');
  assert.match(src, /CODE_KEY = "c"/,
    'the room code is the WHOLE payload, under key `c`; a record without a '
    + 'usable `c` is ignored by the launcher');

  // `cpr` marks a record published by a CONTROLLER relaying a room it is in.
  // The contract says a display must NEVER set it: it tells the launcher the
  // instance name is not a room label, and ours is (the device name).
  assert.doesNotMatch(src, /"cpr"/,
    'cpr is launcher-only — a display that sets it disclaims its own label');

  // NsdManager needs a port to register and the launcher never dials it, so the
  // record must not advertise something that is actually served.
  assert.match(src, /ServerSocket\(0\)/,
    'the SRV port must be a throwaway — nothing here serves the LAN');
});

test('the record tracks the room: published when joinable, withdrawn otherwise', () => {
  const src = shell(COORDINATOR);
  if (src === null) return;

  const i = src.indexOf('fun syncAdvertisement');
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
  // And a backgrounded app stops offering a join it cannot honour.
  assert.match(body, /suspended/,
    'a suspended app must withdraw: the room may survive the wake, but a '
    + 'discovered join would land a player in front of a dead display');
});

test('every road that changes "is this room joinable" syncs the record', () => {
  // The three are the room warming, a roster movement, and the ticket coming
  // down. Miss one and the record is right until precisely the moment it
  // matters — a stale record costs a player a tap into a room that is gone.
  const src = shell(COORDINATOR);
  if (src === null) return;
  for (const anchor of ['net.onRoomReady', 'fun refreshLobby', 'private fun clearJoinTicket']) {
    const i = src.indexOf(anchor);
    assert.ok(i > 0, `anchor not found: ${anchor}`);
    assert.match(src.slice(i, i + 900), /syncAdvertisement\(\)/,
      `${anchor} changes whether the room is joinable and does not sync the LAN record`);
  }
});

test('the LAN record is taken down on the way out', () => {
  // Two exits, and only one of them is onDestroy: Android may kill a stopped
  // process without ever calling it, so the record must come down at suspend
  // too — which is what the `suspended` gate above does, provided suspend
  // actually re-syncs.
  const src = shell(COORDINATOR);
  if (src === null) return;
  const i = src.indexOf('fun suspend()');
  assert.ok(i > 0, 'suspend() has moved');
  assert.match(src.slice(i, i + 600), /syncAdvertisement\(\)/,
    'a backgrounded display keeps advertising a room it just closed');
  const j = src.indexOf('fun release()');
  assert.ok(j > 0, 'release() has moved');
  assert.match(src.slice(j, j + 300), /advertiser\.withdraw\(\)/,
    'onDestroy leaves the record and its socket alive');
});
