// nativeRuntime — the one memoized loader for the native wasm runtime
// (engine/native/ttp_runtime.mjs: the sim ABI ttp_runtime.h + the party ABI
// ttp_party.h in a single module).
//
// Both adapters (?sim=native's NativeRaceSession, ?party=native's NativeRoomFlow)
// go through here so a page that enables both instantiates ONE module — one wasm
// heap, one copy of double-conversion — instead of two. Nothing loads unless a
// native flag is set: the default path never imports this file.

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
