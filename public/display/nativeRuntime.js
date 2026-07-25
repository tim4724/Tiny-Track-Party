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

// Instantiate (or join the in-flight instantiation of) the runtime module.
export function loadNativeRuntime() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { default: createModule } = await import('./engine/native/ttp_runtime.mjs');
      return createModule();
    })();
  }
  return modulePromise;
}
