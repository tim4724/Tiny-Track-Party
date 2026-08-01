#pragma once
// The engine data contract version — the vocabulary stamp on the plain-data
// structures that cross a boundary or get frozen on disk: `version` on a
// snapshot and on a built track, `contractVersion` on the party manifest and on
// every recorded trace header.
//
// It lives in libttp-json because that is the layer EVERY target already depends
// on and which depends on none of them (see native/CMakeLists.txt), and because
// this is exactly a property of the plain data that layer describes. It was four
// separate `= 2` declarations — runtime/ttp_runtime.cc, runtime/ttp_party.cc,
// replay/replay_cli.cc and libttp-track/ttp/trackbuilder.cc — and only two of
// them were reachable by any gate: schemas.test.js reads the snapshot and the
// built track back out of the live wasm, so the party manifest's copy and the
// replay CLI's could have drifted in silence. The replay CLI REFUSES a trace
// whose header disagrees, so that silence ends in a confusing replay failure
// rather than a clear one.
//
// public/display/engine/contract.js mirrors this for the browser and is pinned
// to it through the live wasm by tests/schemas.test.js.
//
// Bump it when one of those shapes changes (a field added, removed or retyped,
// or a unit changed) — knowing what that costs: the frozen corpora carry the old
// stamp and are never re-recorded, so a bump retires them. See
// tests/fixtures/traces/README.md.
namespace ttp {

// 2: 2026-07 pre-port slim — dropped cars[].v/of/boostActive/tCatch,
// snapshot+results elapsed, rockets[].owner, race_over + pad events.
inline constexpr int CONTRACT_VERSION = 2;

}  // namespace ttp
