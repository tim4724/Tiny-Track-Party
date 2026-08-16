// The tvOS input fastlane: a WebRTC TRANSPORT in Swift over the C++ NETCODE
// (`ttp::fastlane::Link`, the same Link the web display drives through
// `NativePartyFastlane.js`). What can drift here is exactly what these pins
// hold: the two spellings the wire depends on, the split that keeps the
// netcode out of Swift, and the platform obligations the transport carries.
//
// SOURCE CHECKS — the Swift half compiles on no CI leg that could run it
// against a phone, and the one historical fastlane blind spot ("nothing runs
// the C++ Link as a sender") taught that absence is what nobody greps for.

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

const FASTLANE = 'shells/tvos/TinyTrackParty/Net/Fastlane.swift';

test('the signal key is the kit\'s, spelled once per side', () => {
  const kit = read('partyplug/PartyFastlane.js');
  assert.match(kit, /var RTC_KEY = '__rtc'/, 'premise: the kit\'s envelope key moved');
  for (const rel of [FASTLANE, 'shells/tvos/TinyTrackParty/Net/PartyNet.swift']) {
    const src = shell(rel);
    if (src === null) continue;
    assert.match(src, /"__rtc"/, `${rel}: no signal-key spelling — envelopes leak into app dispatch`);
  }
});

test('the watchdog window is fastlane.h\'s', () => {
  // WATCHDOG_MS is an inline constexpr with no export to read, so the Swift
  // spelling is a sanctioned twin — held here, like the cup tints.
  const h = read('native/libttp-party/ttp/fastlane.h');
  const m = h.match(/WATCHDOG_MS = (\d+)/);
  assert.ok(m, 'fastlane.h\'s WATCHDOG_MS moved');
  const swift = shell(FASTLANE);
  if (swift === null) return;
  assert.match(swift, new RegExp(`watchdogMs: Double = ${m[1]}\\b`),
    'the Swift watchdog drifted from the netcode\'s window');
});

test('the netcode stays in C++ — Swift drives the Link and parses no packet', () => {
  const swift = shell(FASTLANE);
  if (swift === null) return;
  assert.match(swift, /ttp_link_create/, 'no Link per peer');
  assert.match(swift, /ttp_link_inbound/, 'inbound bytes must reach the Link');
  assert.match(swift, /ttp_link_dispose/, 'a torn-down peer must free its Link');
  // The REAL readyState is pushed before the op — the Link's belief about the
  // channel decides whether its ack write counts.
  const inbound = swift.indexOf('ttp_link_inbound');
  assert.ok(swift.lastIndexOf('syncOpen', inbound) > -1
            && swift.lastIndexOf('ttp_link_set_channel_open') > -1,
    'the channel state is not synced into the Link');
  // A Swift reading of `ps`/`pa`/`h` would be the second netcode the split
  // exists to prevent (and the NSNumber/Bool bridge trap that cost HexStacker
  // a lobby of renegotiation loops lives exactly there).
  assert.doesNotMatch(swift, /\["ps"\]|\["pa"\]|\["h"\]|lastApplied/,
    'the packet fields are being read in Swift — that is the Link\'s job');
});

test('the close-fastlane performer actually closes something', () => {
  const net = shell('shells/tvos/TinyTrackParty/Net/PartyNet.swift');
  if (net === null) return;
  const i = net.indexOf('case "close-fastlane"');
  assert.ok(i > 0, 'the performer is gone');
  assert.match(net.slice(i, i + 200), /fastlane\.close\(/,
    'close-fastlane is a no-op again — a left seat\'s link must die with it');
});

test('the transport carries its platform obligations', () => {
  const yml = read('shells/tvos/project.yml');
  assert.match(yml, /LiveKitWebRTC/, 'the tvOS WebRTC distribution is gone from the project');
  assert.match(yml, /NSLocalNetworkUsageDescription/,
    'ICE host-candidate checks trip the local-network prompt; without the '
    + 'string the dialog cannot even be shown');
  assert.match(yml, /NSCameraUsageDescription/,
    'the LiveKit binary references capture APIs — absent strings fail an '
    + 'App Store upload with ITMS-90683');
});

test('the STUN pair comes from the manifest, not a Swift literal', () => {
  const proto = shell('shells/tvos/TinyTrackParty/Net/Protocol.swift');
  if (proto === null) return;
  assert.match(proto, /STUN_URL/, 'the manifest key is not read');
  for (const rel of [FASTLANE, 'shells/tvos/TinyTrackParty/Net/Protocol.swift']) {
    const src = shell(rel);
    if (src === null) continue;
    assert.doesNotMatch(src, /"stun:/,
      `${rel}: a STUN literal — the manifest is the one source`);
  }
});
