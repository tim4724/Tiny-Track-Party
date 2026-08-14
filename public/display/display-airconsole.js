'use strict';

// =====================================================================
// AirConsole display bootstrap — loaded ONLY by display/screen.html, as a
// classic script AFTER the AirConsole SDK + partyplug (AirConsoleAdapter,
// AirConsoleStorage) and BEFORE the deferred module entry (main.js).
//
// The transport swap: window.__acParty overrides the native party impls in
// DisplayNet's opts (main.js spreads it after boot.js's party block), so the
// C++ room machine and every net walk run unchanged — only the socket half is
// AirConsole instead of the relay. Platform lifecycle (pause/ads/boot flow)
// is wired in main.js's AirConsole branch, which gates on window.airconsole.
// =====================================================================

// Top-level `var` in a classic script IS window.airconsole — the flag every
// AC-mode gate in the modules tests.
var airconsole = new AirConsole({
  orientation: AirConsole.ORIENTATION_LANDSCAPE,
  silence_inactive_players: false
});

// localStorage shim: the AC iframe's own storage partition is the platform's
// to clear, so the display's DURABLE record rides AirConsole persistent data
// instead. The progression blob is the one that matters — stars and the
// Playroom unlock — and dropping it is the difference between a couch that
// keeps its cups and one that starts over every launch.
//
// Every read here is SYNCHRONOUS at module init and hydration is not, so an
// allowlisted key reads null the first time BY CONSTRUCTION — it is worth
// allowlisting only if something re-applies it once it lands. So the list is
// exactly what main.js's AC branch re-applies through storage.onLoad, and the
// display's other two keys stay out on purpose: the volume slider ships only
// on the audition galleries (pruned from the zip, so the AC pages never write
// it), and the last-track preview is one frame of lobby attract that the
// catalogue's first track already fills. The mute switch is stored on no
// platform at all — see audio/bus.js.
var _acStorage = AirConsoleStorage.install(airconsole, {
  allowlist: ['tinytrack_progress']   // cup stars + the Playroom unlock (main.js)
});

// AirConsole watches the screen iframe's history and reads history.back() as
// "game ended, reset the master controller" (observed upstream in the
// simulator: the late-joining new host landed on about:blank). The display's
// back-stack traversal is shell-side History API by design, so neutralize all
// three — the C++ back-stack table is simply never walked in AC.
history.pushState = function () {};
history.replaceState = function () {};
history.back = function () {};

// The lobby is the boot screen in AC (display.css keeps #welcome dead), and
// the engine boot main.js awaits takes seconds — reveal the lobby's static
// markup (open seats, the loading ticket) as soon as the DOM exists, so the
// player never watches a blank page. main.js's AC branch re-runs show('lobby')
// once the engine is up, which is what adds the backdrop and the seat grid.
document.addEventListener('DOMContentLoaded', function () {
  var lobby = document.getElementById('lobby');
  if (lobby) lobby.classList.remove('hidden');
});

// The SDK fires onReady AT MOST ONCE per page load, but a fresh adapter is
// wired per _connect(). Cache the code and replay it into every adapter the
// factory below builds (multi-shot, unlike AirConsoleAdapter.captureEarlyReady).
var _acReadyCode;
function noteReady(code) {
  _acReadyCode = code;
  // getDeviceId()/getUID() are only valid from here — hydrate the pref shim.
  try { _acStorage.requestLoad(); } catch (_) {}
}
airconsole.onReady = noteReady;

// DisplayNet publishes the retained room snapshot as C++-composed relay frame
// TEXT ({"type":"set_state","data":{…}} — see NativePartyConnection.
// setStateFrame). AirConsole's retained-state primitive takes the data object
// itself, so unwrap the one envelope key here; the kit adapter stays generic.
class TTPAirConsoleAdapter extends AirConsoleAdapter {
  setStateFrame(frameText) {
    if (!frameText) return;
    try { this.setState(JSON.parse(frameText).data); } catch (_) { /* a frame C++ built always parses */ }
  }
}

// No WebRTC fastlane on AirConsole (upstream decision, kept): CONTROL falls
// back to party.sendTo in ControllerNet, and the display's close-fastlane
// effects land on these no-ops. isOpen=false keeps liveness/latency readings
// on the transport path; enqueue never answers 'p2p' so nothing waits on it.
class AirConsoleFastlaneStub {
  constructor() {}
  open() {}
  close() {}
  closeAll() {}
  isOpen() { return false; }
  enqueue() { return 'queued'; }
  handleSignal() { return false; }
}

// The platform surface main.js's AC branch reads (the transport half is
// __acParty below, which is spread straight into DisplayNet's opts).
window.__acDisplay = { storage: _acStorage };

window.__acParty = {
  // Constructed by DisplayNet._connect as `new Impl(url, {clientId})` — both
  // arguments are relay-isms the adapter ignores. A function returning an
  // object satisfies `new`.
  PartyConnectionImpl: function () {
    var adapter = new TTPAirConsoleAdapter(airconsole, { role: 'display' });
    // The adapter's _wireAirConsole took ac.onReady; re-wrap it so the cache
    // keeps filling for the NEXT adapter, then replay a ready the SDK fired
    // before this adapter existed (connect() turns it into created/peer_joined).
    var adapterOnReady = airconsole.onReady;
    airconsole.onReady = function (code) {
      noteReady(code);
      adapterOnReady.call(airconsole, code);
    };
    if (_acReadyCode !== undefined) airconsole.onReady(_acReadyCode);
    return adapter;
  },
  FastlaneImpl: AirConsoleFastlaneStub,
  // AirConsole designates the master controller (premium devices win); the
  // room machine consumes it through RoomFlow's masterProvider seam. Synced
  // before every walk, so onPremium's synthetic master_changed trigger is
  // enough even though the walk itself treats the type as unknown.
  masterProvider: function () {
    var id = airconsole.getMasterControllerDeviceId();
    return (id === undefined || id === null) ? null : id;
  },
  // AC owns connection tracking (onConnect/onDisconnect are authoritative and
  // prompt). Our lastSeen expiry must stay out of it: the platform freezes the
  // iframe on pause, and on resume every seat would read as silent-past-timeout
  // and be dropped mid-race. Drop records (peer_left) still drive the
  // abandoned-race grace — that path is not gated by this flag.
  livenessEnabledProvider: function () { return false; }
};
