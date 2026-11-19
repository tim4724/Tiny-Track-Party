'use strict';

// The phone's fastlane REOPEN policy (public/controller/Net.js): when the channel
// dies with the relay still up, retry at 2 s doubling to 30 s, and reset only once
// a channel has stayed up long enough to prove it. Real ControllerNet and real kit
// PartyFastlane; only the clock, the RTCPeerConnection and the relay socket are
// fabricated (the wire-compat harness's fakes).
//
// Failures are driven through the kit's own paths, not by calling Net's callbacks:
// ICE failing is the pc's connectionstatechange to 'failed', and a channel that
// opens and then goes quiet is the kit's watchdog.

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('./wire-compat/harness.js');
const { FakeDataChannel, connectPair } = require('./wire-compat/rtc.js');

test.after(() => H.teardownClients());

// A joined phone, minus the relay: _openFastlane is what `joined` runs. Every
// open() after the first is recorded and builds a fresh peer, as a real one does.
async function joinedPhone() {
  const { ControllerNet } = await H.controllerModules();
  const net = H.trackPhone(new ControllerNet());
  net.peerIndex = 1;
  net.party = { sendTo() {}, close() {}, connected: true };
  return net;
}

function spyOpens(net, clock) {
  const opens = [];
  const fl = net.fastlane;
  fl.open = (peerIdx) => { opens.push(clock.now); fl._ensurePeer(peerIdx); };
  return opens;
}

function iceFails(net) {
  const pc = net.fastlane.peers.get(0).pc;
  pc.connectionState = 'failed';
  pc.onconnectionstatechange();
}

test('fastlane: ICE that keeps failing backs off 2 s, doubling, capped at 30 s', async () => {
  const net = await joinedPhone();
  H.withFakeClock((clock) => {
    net._openFastlane();
    const opens = spyOpens(net, clock);
    const gaps = [];
    for (let i = 0; i < 7; i++) {
      const failedAt = clock.now;
      iceFails(net);
      clock.advance(60000);
      gaps.push(opens[i] - failedAt);
    }
    assert.deepEqual(gaps, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

test('fastlane: a channel the watchdog kills right after it opens does not reset the backoff', async () => {
  // Resetting on open (onPeerReady) would restart every cycle at 2 s, so a link
  // that opens and then never acks would renegotiate at the floor forever.
  const net = await joinedPhone();
  H.withFakeClock((clock) => {
    net._openFastlane();
    const opens = spyOpens(net, clock);
    const gaps = [];
    let diedAt = clock.now;
    iceFails(net);
    for (let i = 0; i < 4; i++) {
      clock.advanceTo(diedAt + 60000);   // well past any pending retry
      gaps.push(opens[i] - diedAt);
      // The retry's channel opens, then nothing comes back: the kit's watchdog.
      const ch = new FakeDataChannel();
      net.fastlane._wireChannel(net.fastlane.peers.get(0), 0, ch);
      ch.open();
      const before = net.fastlane.peers.get(0);
      while (net.fastlane.peers.get(0) === before) clock.advance(100);
      diedAt = clock.now;
    }
    assert.deepEqual(gaps, [2000, 4000, 8000, 16000]);
  });
});

test('fastlane: a channel that stays up resets the backoff to 2 s', async () => {
  const { PartyFastlane } = H.kit();
  const net = await joinedPhone();
  H.withFakeClock((clock) => {
    net._openFastlane();
    const opens = spyOpens(net, clock);
    // Climb the ladder: two failures put the next retry at 8 s.
    iceFails(net); clock.advance(60000);
    iceFails(net); clock.advance(60000);
    assert.equal(opens.length, 2);
    // This time it connects to a live display, whose acks to the phone's idle
    // heartbeats keep the watchdog fed well past the stability window.
    const display = new PartyFastlane({ selfIndex: 0, sendSignal() {}, onInput() {} });
    connectPair(net.fastlane, 0, display, 1);
    clock.advance(12000);
    assert.ok(net.fastlane.isOpen(0), 'heartbeats + acks kept the channel up');
    // Now it dies: the ladder starts over.
    const diedAt = clock.now;
    iceFails(net);
    clock.advance(60000);
    assert.equal(opens[2] - diedAt, 2000);
    display.closeAll();
  });
});

test('fastlane: a fresh join cancels the retry the old fastlane armed', async () => {
  const net = await joinedPhone();
  H.withFakeClock((clock) => {
    net._openFastlane();
    iceFails(net);   // retry armed at 2 s, on THIS fastlane
    // A relay rejoin rebuilds the fastlane and opens it at once; the stale retry
    // must not fire into the new one, and the new one starts the ladder fresh.
    net._openFastlane();
    const opens = spyOpens(net, clock);
    clock.advance(60000);
    assert.deepEqual(opens, [], 'no retry outlives the fastlane it was armed for');
    iceFails(net);
    clock.advance(60000);
    assert.equal(opens[0], 60000 + 2000);
  });
});
