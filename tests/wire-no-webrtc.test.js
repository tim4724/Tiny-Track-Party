'use strict';

// The fastlane is an ENHANCEMENT (docs/native-port/architecture.md): with
// WebRTC absent — old phones, privacy browsers/policies that disable it — the
// party must still work relay-only. This ran into GameNet._initFastlane
// constructing PartyFastlane unconditionally, whose constructor throws
// "WebRTC not supported" INSIDE ControllerNet's `joined` handler, before the
// HELLO is sent: the phone died at the join instead of degrading.
//
// Own file rather than a case in wire-compat.test.js: the harness installs the
// fake RTCPeerConnection process-wide, and this suite is the one that must run
// WITHOUT it. node:test runs each file in its own process, so deleting the
// global here cannot leak into the other wire suites.

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('./wire-compat/harness.js');
const { Relay } = require('./wire-compat/relay.js');

test.after(() => H.teardownClients());

test('wire: with WebRTC absent, both ends come up fastlane-less and CONTROL rides the relay', async () => {
  // Load every module first (installBrowserGlobals runs once, and the OTHER
  // suites' comment in harness.js still holds for them) — then remove WebRTC
  // before anything constructs, which is when _initFastlane checks for it.
  const { DisplayNet, NativeRoomFlow, NativePartyConnection, NativePartyFastlane } =
      await H.displayModules();
  const { ControllerNet } = await H.controllerModules();
  delete globalThis.RTCPeerConnection;

  const relay = H.setRelay(new Relay());
  globalThis.sessionStorage.clear();
  const display = { controller: [] };
  const net = H.trackDisplay(new DisplayNet({
    RoomFlowImpl: NativeRoomFlow,
    PartyConnectionImpl: NativePartyConnection,
    FastlaneImpl: NativePartyFastlane,
    carChooser: [{ id: 'vehicle-racer-low', name: 'Dash' }],
    colorPalette: ['#e6492d'],
    trackChooser: [{ id: 'tidepool', name: 'Tidepool', cup: 'beach' }],
    defaultTrackId: 'tidepool',
    onControllerMessage: (i, d) => display.controller.push({ i, d }),
  }));
  await net.start();
  await H.flush();
  assert.equal(net.fastlane, null, 'the display came up without a fastlane');
  assert.ok(net.roomCode, 'and still created its room');

  const room = net.roomCode;
  globalThis.location.pathname = '/' + room;
  globalThis.location.search = '';
  globalThis.location.hash = '';
  globalThis.localStorage.setItem('clientId_' + room, 'phone-no-rtc');
  const phone = { joined: [], status: [] };
  const pnet = H.trackPhone(new ControllerNet({
    onJoined: (idx) => phone.joined.push(idx),
    onStatus: (s, info) => phone.status.push({ s, info }),
    onMessage: () => {},
    onRtt: () => {},
  }));
  pnet.connect('Ada');
  await H.flush();

  // The regression: _openFastlane threw out of the `joined` handler, so HELLO
  // never went out and onJoined never fired.
  assert.deepEqual(phone.joined, [1], 'the phone joined');
  assert.equal(pnet.fastlane, null, 'fastlane-less by design, not by luck');

  // CONTROL falls back to the relay — and being reliable/ordered, the handover
  // itself is the ack (gate confirmed without a fastlane in sight).
  assert.equal(pnet.sendControl({ s: 0.5, b: 0, u: 0 }, 1000), true);
  await H.flush();
  const control = display.controller.find(({ d }) => d && d.type === 'control');
  assert.ok(control, 'the display received CONTROL over the relay');
  assert.equal(control.i, 1);
  assert.equal(control.d.s, 0.5);
});
