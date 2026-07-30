// nativeRuntime — the one memoized loader for the native wasm runtime
// (engine/native/ttp_runtime.mjs: the sim ABI ttp_runtime.h + the party ABI
// ttp_party.h in a single module).
//
// Every adapter (NativeRaceSession, NativeCupSeries, NativeRoomFlow,
// NativePartyConnection, NativePartyFastlane) goes through here, so the display
// instantiates ONE module — one wasm heap, one copy of double-conversion — rather
// than one per layer. main.js awaits this at boot and a failure is FATAL: the
// game has no JS engine to fall back to.

let modulePromise = null;
let lastError = null;

// Instantiate (or join the in-flight instantiation of) the runtime module.
export function loadNativeRuntime() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { default: createModule } = await import('./engine/native/ttp_runtime.mjs');
      const M = await createModule();
      lastError = M.cwrap('ttp_last_error', 'string', []);
      return M;
    })();
  }
  return modulePromise;
}

// WHY THE LAST CALL REFUSED, straight from ttp_error.h.
//
// Every adapter used to compose its own message at its throw site, and every one
// of them was a GUESS: "ttp_session_begin failed for track 'x'" names the symptom
// and cannot say whether the track is unknown, the lap count was refused, or
// nothing was configured — because the ABI returned a bare 0. This reads the
// reason the C++ recorded, so all three shells surface one explanation instead of
// inventing three.
//
// `what` is what the shell was DOING; the reason is what the engine says about
// it. Read immediately after a failing call (ttp_error.h states that contract);
// stale text is not possible here because nothing else runs in between.
export function nativeError(what) {
  const why = lastError ? lastError() : '';
  return new Error(why ? `${what}: ${why}` : `${what} (the engine gave no reason)`);
}
