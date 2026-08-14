'use strict';

// =====================================================================
// AirConsole controller bootstrap — loaded ONLY by controller/controller.html,
// as a classic script AFTER the AirConsole SDK + partyplug (AirConsoleAdapter,
// AirConsoleStorage) and BEFORE the deferred module entry (main.js).
//
// The transport swap: window.PartyConnection is re-pointed at a factory
// returning AirConsoleAdapter before Net.js captures it at import, and
// window.PartyFastlane at a no-op stub before GameNet reads it at join —
// CONTROL then always takes ControllerNet's relay-fallback path, which on
// this page IS the AirConsole message channel. Identity, join flow and
// haptics are wired in main.js's AirConsole branch via window.__acController.
// =====================================================================

// Top-level `var` in a classic script IS window.airconsole — the flag the
// modules' AC-mode gates test.
var airconsole = new AirConsole({
  // The TTP controller is landscape-only (the plain web page enforces it with
  // fullscreen+lock and a rotate overlay); AC pins the device for us.
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false,
  // The game is a cross-origin iframe (airconsole.com in a browser, or the AC
  // app's webview) and neither embedder delegates motion sensors to the
  // frame, so DeviceOrientation NEVER fires in here — the SDK's relay is the
  // only tilt source on this platform (local postMessage, no message-budget
  // cost). 16 ms ≈ the 60 Hz cadence TiltInput's complementary filter
  // integrates the gyro rates at. Wired in main.js's AC branch.
  //
  // This is PERMANENT, not a stopgap waiting on the platform to add
  // allow="accelerometer; gyroscope" to the game frame: that attribute would
  // fix Chrome only. WebKit refuses motion in a cross-origin frame outright
  // and never consults `allow` (measured on iOS 18.7 / Safari 26.2:
  // requestPermission answers 'denied' with no prompt, delegated or not),
  // so every iPhone here needs the relay whatever AirConsole ships. Do not
  // unplug it to "test delegation" again — that test is done.
  device_motion: 16
});

// Replace window.localStorage BEFORE main.js reads the stored prefs. The
// allowlist is prefs.js's device-preference keys; the player NAME is excluded
// (AC owns identity — the profile nickname arrives via getNickname) and
// clientId_* stays out for the same reason. Reads race hydration (prefs load
// synchronously at module init), so main.js's AC branch re-applies the input
// mode from storage.onLoad.
var _acStorage = AirConsoleStorage.install(airconsole, {
  allowlist: [
    'tinytrack_car',
    'tinytrack_input',
    'tinytrack_mode',
    'tinytrack_seen_help'
  ]
});

// No history entries in the AC iframe: main.js pushes name→lobby (we're not
// in the CouchPad shell, so its !inShell guard doesn't cover us), and that
// entry is exactly what a spurious popstate (SDK location check, bfcache,
// phone back gesture) would pop into leaveToName. The popstate handler is
// also gated on window.airconsole as belt-and-braces.
history.pushState = function () {};

// No WebRTC fastlane on AirConsole — same stub as the display bootstrap.
// GameNet._initFastlane reads window.PartyFastlane lazily at join, so this
// assignment is all it takes; enqueue never answers 'p2p', so every CONTROL
// falls through to party.sendTo (the AC message channel), still gated to the
// platform's 25 msg/s budget by InputGate (STEER.SEND_MIN_INTERVAL_MS).
window.PartyFastlane = class AirConsoleFastlaneStub {
  constructor() {}
  open() {}
  close() {}
  closeAll() {}
  isOpen() { return false; }
  enqueue() { return 'queued'; }
  handleSignal() { return false; }
};

// The SDK fires onReady AT MOST ONCE per page load, but the conn overlay's
// "Try again" re-runs net.connect(), which builds a fresh adapter. Cache the
// code and replay it into every adapter the factory below builds.
var _acReadyCode;
var _resolveAcReady;
function noteReady(code) {
  _acReadyCode = code;
  // getDeviceId()/getUID() are only valid from here — hydrate the pref shim.
  try { _acStorage.requestLoad(); } catch (_) {}
  if (_resolveAcReady) { _resolveAcReady(); _resolveAcReady = null; }
}
airconsole.onReady = noteReady;

window.PartyConnection = function () {
  var adapter = new AirConsoleAdapter(airconsole, { role: 'controller' });
  // The adapter's _wireAirConsole took ac.onReady; re-wrap so the cache keeps
  // filling for the NEXT adapter, then replay a ready the SDK fired before
  // this adapter existed (connect() turns it into `joined` + state replay).
  var adapterOnReady = airconsole.onReady;
  airconsole.onReady = function (code) {
    noteReady(code);
    adapterOnReady.call(airconsole, code);
  };
  if (_acReadyCode !== undefined) airconsole.onReady(_acReadyCode);
  return adapter;
};

// main.js's AirConsole branch drives the join off this: await ready, join as
// the AC profile nickname, route haptics through the SDK where the iframe's
// permissions policy blocks navigator.vibrate.
window.__acController = {
  airconsole: airconsole,
  ready: new Promise(function (resolve) { _resolveAcReady = resolve; }),
  storage: _acStorage,
  nickname: function () {
    try { return airconsole.getNickname(airconsole.getDeviceId()) || ''; }
    catch (_) { return ''; }
  },
  // navigator.vibrate first — it preserves the pattern's rhythm (the brake
  // rumble is a duty-cycle trick) and returns false where the iframe policy
  // blocks it. The SDK fallback takes a single duration, so patterns collapse
  // to their summed on-time (even indices): energy preserved, rhythm lost.
  vibrate: function (p) {
    try { if (navigator.vibrate && navigator.vibrate(p)) return; } catch (_) {}
    var total = p;
    if (Array.isArray(p)) {
      total = 0;
      for (var i = 0; i < p.length; i += 2) total += p[i];
    }
    if (total > 0) { try { airconsole.vibrate(total); } catch (_) {} }
  }
};
