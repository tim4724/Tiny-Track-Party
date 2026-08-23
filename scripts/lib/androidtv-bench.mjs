// What the two Android bench harnesses both need: the app's launch vocabulary,
// the ablation bits, and four helpers that were verbatim copies in each.
//
// Extracted for the reason `androidtv-device.mjs` beside it was — there are two
// callers now (`perf-race.android.mjs` and `perf-frame.mjs`) — and for one more
// that matters more than tidiness: TTP_FEAT_* was mirrored by hand in BOTH of
// them, and `tests/feature-bits.test.js` only ever gated one. A second copy of a
// shared number is the failure root `CLAUDE.md` rule 1 exists for, and the mask
// is the one where going stale is SILENT: every "full picture" arm quietly draws
// one channel short, wearing a full-feature label.
//
// WHAT IS DELIBERATELY NOT HERE: the logcat pump, the knob restore and the
// launch walk, which look alike and are not. One backend hands its lines to a
// shared fold and counts only after a settle; the other keeps a timestamped
// buffer, relaunches per arm and samples /proc across a window. Merging those
// would be one function with two modes, which is the thing this tree's rules
// say not to build.

/** One flag off argv. Each harness reads its own; there is no shared parser. */
export const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A percentile over whatever is finite, or null for a series nothing filled. */
export const pct = (xs, q) => {
  const s = xs.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
};

/** `name:ms name:ms …` — a COLON, so a `name value` parser cannot read a max as a median. */
export const phases = (line) => Object.fromEntries(
  [...line.matchAll(/([A-Za-z]+):([\d.]+)/g)].map((m) => [m[1], +m[2]]));

export const PACKAGE = 'games.couchpad.tinytrack';
export const ACTIVITY = `${PACKAGE}/.MainActivity`;

// Scenarios.kt's EXTRA_SCENARIO/EXTRA_TRACK/EXTRA_PLAYERS, and the scenario that
// is a race rather than a screen. There is no manifest to read them from.
export const SCENARIO = 'bench';
export const EXTRA_SCENARIO = 'ttpScenario';
export const EXTRA_TRACK = 'ttpTrack';
export const EXTRA_PLAYERS = 'ttpPlayers';

/** A cold launch builds a scene and bakes a shadow map before it says so. */
export const READY_TIMEOUT_MS = 120_000;

/**
 * `native/runtime/ttp_display.h`'s TTP_FEAT_*, and the ONLY copy of them on the
 * Android harness side. `tests/feature-bits.test.js` holds it to the header.
 */
export const FEAT = {
  ROAD: 0x04, TERRAIN: 0x08, DRESSING: 0x10, SKY: 0x20, CARS: 0x40, EFFECTS: 0x80,
  ALL: 0xDFFC,
};

/** The content groups, in the order a sweep prints them. */
export const GROUPS = ['ROAD', 'TERRAIN', 'DRESSING', 'SKY', 'CARS', 'EFFECTS'];

/**
 * Every content group off; the road's fragment channels and the fog stay, and
 * draw nothing without a deck to draw on. What is left is the FLOOR: the cells,
 * the passes and the present, with no content in them.
 *
 * DERIVED, never typed. Hand-computed, it silently stops dropping the next
 * content bit somebody adds and the floor arm reads high forever.
 */
export const EMPTY = GROUPS.reduce((m, g) => m & ~FEAT[g], FEAT.ALL);

export const hex = (n) => `0x${n.toString(16).toUpperCase()}`;
