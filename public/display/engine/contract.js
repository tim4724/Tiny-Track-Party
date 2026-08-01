// The engine data contract version: the vocabulary stamp on the plain-data
// structures that cross the wasm boundary — `version` on a snapshot and on a
// built track, `contractVersion` on the party manifest — and on every frozen
// trace header, which replay_cli REFUSES when it disagrees. C++ declares it once
// in native/libttp-json/ttp/contract.h — the layer every target depends on — and
// this is the browser-side mirror, pinned to it through the live wasm by
// tests/schemas.test.js, which also pins the JSON schemas so the three cannot
// quietly disagree.
//
// Bump it when one of those shapes changes (a field added, removed or retyped,
// or a unit changed) — knowing what that costs: the frozen corpora carry the old
// stamp and are never re-recorded, so a bump retires them. See
// tests/fixtures/traces/README.md.
export const CONTRACT_VERSION = 2; // 2: 2026-07 pre-port slim — dropped cars[].v/of/boostActive/tCatch, snapshot+results elapsed, rockets[].owner, race_over + pad events

// The item vocabulary — a mirror of the sim's roll table (ttp::ITEM_IDS in
// native/libttp-sim/ttp/game.h). C++ is the source and the ORDER is the
// contract, not a detail: a held item reaches the shell as this index rather
// than as a string. tests/display-abi.test.js pins this copy to the table the
// engine reads back out.
export const ITEM_IDS = ['boost', 'banana', 'rocket', 'monster'];
