// The Android input fastlane: a WebRTC TRANSPORT in Kotlin over the C++ NETCODE
// (`ttp::fastlane::Link`, the same Link the web display drives through
// `NativePartyFastlane.js` and the tvOS shell through `Net/Fastlane.swift`).
// The twin of tests/tvos-fastlane.test.js, and it exists for the same reason:
// what can drift is exactly what these pins hold — the two spellings the wire
// depends on, the split that keeps the netcode out of Kotlin, and the platform
// obligations the transport carries.
//
// SOURCE CHECKS. The Kotlin half compiles on no CI leg that could run it
// against a phone, and the one historical fastlane blind spot ("nothing runs
// the C++ Link as a sender") taught that absence is what nobody greps for.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KOTLIN = 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Comments carry every spelling this file greps for, so they are stripped first
// — otherwise a prose mention of `ttp_link_inbound` passes a check the code
// fails. `*` catches KDoc continuation lines.
function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

const FASTLANE = `${KOTLIN}/Fastlane.kt`;
const NET = `${KOTLIN}/PartyNet.kt`;

test('the signal key is the kit\'s, spelled once', () => {
  const kit = read('partyplug/PartyFastlane.js');
  assert.match(kit, /var RTC_KEY = '__rtc'/, 'premise: the kit\'s envelope key moved');
  const src = shell(FASTLANE);
  if (src === null) return;
  assert.match(src, /const val RTC_KEY = "__rtc"/,
    'no signal-key spelling — envelopes leak into app dispatch');
  // And PartyNet reads it from there rather than re-typing it: a second literal
  // is how one side stops recognising the other's envelope.
  const net = shell(NET);
  if (net === null) return;
  assert.doesNotMatch(net, /"__rtc"/,
    'PartyNet re-types the envelope key — Fastlane.RTC_KEY is the one spelling');
  assert.match(net, /Fastlane\.RTC_KEY/, 'PartyNet does not read the key at all');
});

test('the watchdog window is fastlane.h\'s', () => {
  // WATCHDOG_MS is an inline constexpr with no export to read, so the Kotlin
  // spelling is a sanctioned twin — held here, like the cup tints.
  const h = read('native/libttp-party/ttp/fastlane.h');
  const m = h.match(/WATCHDOG_MS = (\d+)/);
  assert.ok(m, 'fastlane.h\'s WATCHDOG_MS moved');
  const src = shell(FASTLANE);
  if (src === null) return;
  assert.match(src, new RegExp(`WATCHDOG_MS = ${m[1]}L\\b`),
    'the Kotlin watchdog drifted from the netcode\'s window');
});

test('the netcode stays in C++ — Kotlin drives the Link and parses no packet', () => {
  const src = shell(FASTLANE);
  if (src === null) return;
  assert.match(src, /ttp_link_create/, 'no Link per peer');
  assert.match(src, /ttp_link_inbound/, 'inbound bytes must reach the Link');
  assert.match(src, /ttp_link_dispose/, 'a torn-down peer must free its Link');
  // The REAL readyState is pushed before the op — the Link's belief about the
  // channel decides whether its ack write counts.
  const inbound = src.indexOf('ttp_link_inbound');
  assert.ok(src.lastIndexOf('syncOpen', inbound) > -1
            && src.indexOf('ttp_link_set_channel_open') > -1,
    'the channel state is not synced into the Link');
  // A Kotlin reading of `ps`/`pa`/`h` would be the second netcode the split
  // exists to prevent (and the boxing trap that cost HexStacker a lobby of
  // renegotiation loops lives exactly there).
  assert.doesNotMatch(src, /"ps"|"pa"|"h"|lastApplied/,
    'the packet fields are being read in Kotlin — that is the Link\'s job');
});

test('the close-fastlane performer actually closes something', () => {
  const net = shell(NET);
  if (net === null) return;
  // The ARM, not the PERFORMABLE row that names the same op two hundred lines
  // above it.
  const i = net.indexOf('"close-fastlane" ->');
  assert.ok(i > 0, 'the performer is gone');
  assert.match(net.slice(i, i + 300), /fastlane\.close\(/,
    'close-fastlane is a no-op again — a left seat\'s link must die with it');
});

test('the STUN pair comes from the manifest, not a Kotlin literal', () => {
  const proto = shell(`${KOTLIN}/GameProtocol.kt`);
  if (proto === null) return;
  assert.match(proto, /STUN_URL/, 'the manifest key is not read');
  assert.match(proto, /STUN_FALLBACK_URL/, 'the fallback is not read — a stun.* outage is then fatal');
  for (const rel of [FASTLANE, NET, `${KOTLIN}/GameProtocol.kt`]) {
    const src = shell(rel);
    if (src === null) continue;
    assert.doesNotMatch(src, /"stun:/, `${rel}: a STUN literal — the manifest is the one source`);
  }
});

test('the transport carries its platform obligations', () => {
  const gradle = read('shells/androidtv/app/build.gradle.kts');
  assert.match(gradle, /io\.github\.webrtc-sdk:android/,
    'the WebRTC distribution is gone from the build');
  // armeabi-v7a is the PRIMARY abi on the box this shell targets, so an
  // arm64-only slice would not run at all.
  assert.match(gradle, /abiFilters \+= listOf\("armeabi-v7a", "arm64-v8a"\)/,
    'the ABI pair moved — check the WebRTC AAR still carries both');

  // The AAR ships NO consumer proguard rules and libjingle FindClass()es both
  // packages from its own JNI_OnLoad, so R8 strips them and the native load
  // aborts. Release-only, i.e. the one build nobody runs before shipping.
  const rules = read('shells/androidtv/app/proguard-rules.pro');
  for (const pkg of ['org.webrtc', 'org.jni_zero']) {
    assert.ok(rules.includes(`-keep class ${pkg}.** { *; }`),
      `no R8 keep for ${pkg} — the release APK will abort at library load`);
  }
});

test('every ttp_link_ call is on the shell\'s one thread', () => {
  // The shell's rule 1 (shells/androidtv/CLAUDE.md): every `ttp_*` call happens
  // on main. libwebrtc's observers fire on ITS signalling thread, so anything
  // that reaches a Link must have hopped first — and the hop is what a port
  // from HexStacker's serial-executor twin would quietly drop.
  const src = shell(FASTLANE);
  if (src === null) return;
  for (const m of src.matchAll(/\boverride fun on[A-Za-z]+\([^)]*\)[^\n]*\{/g)) {
    const body = src.slice(m.index, src.indexOf('\n        }', m.index));
    if (!/\bttp_link_/.test(body)) continue;
    assert.fail(`a WebRTC observer calls a Link directly: ${m[0].trim()}`);
  }
  assert.match(src, /Looper\.getMainLooper\(\)/, 'no main-thread handler at all');
});
