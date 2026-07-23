// The engine data contract version, for the native-port conformance harness.
// The JS engine is the reference implementation a future C++ port will be
// tested against; both sides stamp the plain-data structures they exchange
// (Game.getSnapshot() and TrackBuilder.buildTrack() output) with this number
// so a harness can refuse to compare mismatched vocabularies. Bump it on any
// change to those shapes (fields added/removed/retyped or units changed).
export const CONTRACT_VERSION = 2; // 2: 2026-07 pre-port slim — dropped cars[].v/of/boostActive/tCatch, snapshot+results elapsed, rockets[].owner, race_over + pad events
