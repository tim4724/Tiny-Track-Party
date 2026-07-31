// Generates tests/fixtures/raceflow-corpus.jsonl — the oracle for the display's
// RACE ORCHESTRATION (public/display/raceFlow.js).
//
// WHY IT EXISTS NOW. Race orchestration is the last layer of the display that a
// second shell has to re-derive from prose, and it is the one where getting it
// wrong is SILENT: the four ordering constraints in raceFlow.js's header
// (COUNTDOWN after the session exists, the deferred auto-pause re-check, points
// banked before the board, dispose before the LOBBY flip) each produce a
// plausible-looking room that is subtly wrong. So the order is recorded as data
// NOW, while the JS that produces it still exists — the same one-way ratchet
// that already froze gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs.
//
// EVERY INPUT IS COMMITTED, AND THERE IS EXACTLY ONE. The generator reads
// public/display/raceFlow.js and nothing else — no wasm, no traces, no track
// catalogue, no persona table. That is deliberate and it is the same rule
// gen-ui-corpus.mjs follows: the layer is catalogue-AGNOSTIC (personas, car
// stats and cups all arrive per call), so binding the oracle to
// shared/tracks.js or aiPersonas.js would make every new track — or a persona
// retune — a corpus re-record. The scenarios below carry their own synthetic
// world. Whether the SHIPPED tables still flow through correctly is
// tests/race-flow.test.js's job, and it is free to change with the data.
//
// SHAPE. Each fixture line is one step of one scripted scenario: the op, its
// FULLY RESOLVED input (so a step replays standalone) and the layer's answer,
// plus the shell STATE the driver threads afterwards. The state is what makes
// this an arc rather than a table of isolated calls — the driver walks each
// effect list and applies it, so the corpus also proves the effects are
// APPLIABLE in the order they come out, and a port that emits the right ops in
// the wrong order fails on `state` even when `out` matches.
//
// Deterministic: re-runs are byte-identical. No clock and no RNG reach the
// layer — seeds, draws and nowMs are scripted literals.
//
// Usage: node scripts/gen-raceflow-corpus.mjs [--check | --stdout]
//   --check  re-derive and require the committed corpus to match, writing nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringify, mulberry32 } from './oracle-lib.mjs';
import * as rf from '../public/display/raceFlow.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/raceflow-corpus.jsonl');

// ---------------------------------------------------------------------------
// The synthetic world. Two cups of four circuits plus a cupless track and an
// empty cup, which is enough to exercise every lookup the layer does (cup → its
// races, a cup whose id is in no list, an empty cup, a track in no cup).
// ---------------------------------------------------------------------------
const CUPS = [
  { id: 'cup-a', name: 'Sunrise', tracks: ['a1', 'a2', 'a3', 'a4'] },
  { id: 'cup-b', name: 'Thunder', tracks: ['b1', 'b2', 'b3', 'b4'] },
  { id: 'cup-empty', name: 'Hollow', tracks: [] }
];

// Four personas, deliberately NOT the shipped names/knobs — the layer only ever
// indexes this table, so a synthetic one proves that and keeps a persona retune
// from touching the fixture.
const PERSONAS = [
  { name: 'Alpha', caution: 1.10, laneBias: -0.5 },
  { name: 'Beta', caution: 1.00, laneBias: 0.5 },
  { name: 'Gamma', caution: 0.95, laneBias: -0.2 },
  { name: 'Delta', caution: 0.90, laneBias: 0.2 }
];

// Six stat rows, so carStatsAt's wrap is visible for indices past the end and a
// car count that does not divide the colour count.
const CAR_STATS = [
  { accel: 1.0, top: 1.0, turn: 1.0, weight: 1.0 },
  { accel: 1.1, top: 0.95, turn: 1.05, weight: 0.9 },
  { accel: 0.9, top: 1.1, turn: 0.95, weight: 1.1 },
  { accel: 1.05, top: 1.0, turn: 0.9, weight: 1.0 },
  { accel: 0.95, top: 1.05, turn: 1.1, weight: 0.95 },
  { accel: 1.0, top: 0.9, turn: 1.0, weight: 1.2 }
];

// raceFlow.js's own default; named here because the world in the header must
// be complete enough for a replayer to configure from it alone.
const AI_PREFIX = 'ai-';
const FIELD_SIZE = 4;
const CAR_COUNT = 6;
const COLOR_COUNT = 8;
const INTERMISSION_MS = 10000;
const RESULTS_FAILSAFE_MS = 60000;
const COUNTDOWN_SECONDS = 3;

const WORLD = {
  fieldSize: FIELD_SIZE, carCount: CAR_COUNT, colorCount: COLOR_COUNT,
  personas: PERSONAS, carStats: CAR_STATS
};

// ---------------------------------------------------------------------------
// The shell state the driver threads, and the applier that walks an effect
// list. This is the SHELL's half — deliberately minimal, and deliberately
// present: it is what turns "the right ops came out" into "the right ops came
// out in an order that leaves the room coherent".
// ---------------------------------------------------------------------------
function freshState() {
  return {
    roomState: 'lobby',
    screen: 'lobby',
    hasSession: false,
    sessionBound: false,
    paused: false,
    autoPaused: false,
    raceEnded: false,
    pauseOverlay: false,
    pauseButton: false,
    chrome: 'held',
    musicCredit: false,
    music: 'stopped',
    trackId: null,
    trackSeed: null,
    countdownShown: null,
    field: [],
    aiIds: [],
    bots: [],
    itemCache: true,       // "cleared" flag: true once a race cleared it
    sceneCars: [],
    demoRunning: true,
    seriesRaceIndex: null,
    resultsFailsafe: null,
    intermissionDeadline: null,
    lastBroadcast: null,
    log: []
  };
}

// Apply one effect. Unknown ops are a hard error: a port that invents an op
// must not silently record as "no state change".
function applyEffect(s, e) {
  s.log.push(e.op);
  switch (e.op) {
    case 'set-track-seed': s.trackSeed = e.seed; break;
    case 'stop-lobby-demo': s.demoRunning = false; break;
    case 'set-field': s.field = e.field; s.aiIds = e.aiIds; s.bots = e.bots; break;
    case 'clear-item-cache': s.itemCache = true; break;
    case 'show-screen': s.screen = e.screen; break;
    case 'hide-results': break;
    case 'set-race-flags':
      s.paused = e.paused; s.autoPaused = e.autoPaused; s.raceEnded = e.raceEnded; break;
    case 'set-pause-overlay': s.pauseOverlay = e.on; break;
    case 'set-pause-button': s.pauseButton = e.shown; break;
    case 'reveal-chrome': s.chrome = 'revealed'; break;
    case 'hold-chrome': s.chrome = 'held'; break;
    case 'reset-scene-cars': s.sceneCars = e.cars.map((c) => c.id); break;
    case 'create-session': s.hasSession = true; s.trackId = e.trackId; break;
    case 'transition': s.roomState = e.to; break;
    case 'bind-session': s.sessionBound = true; break;
    case 'paint-initial-hud': break;
    case 'start-countdown': s.countdownShown = e.seconds; break;
    case 'show-countdown': s.countdownShown = e.n; break;
    case 'broadcast-countdown': break;
    case 'refresh-auto-pause': break;
    case 'start-music': s.music = 'playing'; break;
    case 'stop-music': s.music = 'stopped'; break;
    case 'show-music-credit': s.musicCredit = e.on; break;
    case 'stop-voices': break;
    case 'item-pickup': case 'rocket-impact': case 'rocket-expire': break;
    case 'broadcast-standings': s.lastBroadcast = e.over ? 'final' : 'running'; break;
    case 'apply-race-points': break;
    case 'show-results': break;
    case 'arm-results-failsafe': s.resultsFailsafe = e.ms; break;
    case 'clear-results-failsafe': s.resultsFailsafe = null; break;
    case 'arm-intermission': s.intermissionDeadline = e.deadline; break;
    case 'clear-intermission': s.intermissionDeadline = null; break;
    case 'series-advance': s.seriesRaceIndex = (s.seriesRaceIndex || 0) + 1; break;
    case 'clear-series': s.seriesRaceIndex = null; break;
    case 'set-track-from-series': break;
    case 'place-track': break;
    case 'set-track': s.trackId = e.trackId; break;
    case 'dispose-session': s.hasSession = false; s.sessionBound = false; break;
    case 'clear-field': s.field = []; s.aiIds = []; s.bots = []; break;
    case 'fade-to-lobby': s.sceneCars = []; s.demoRunning = true; break;
    case 'remove-scene-car': s.sceneCars = s.sceneCars.filter((c) => c !== e.id); break;
    case 'stop-car-audio': break;
    case 'sync-state': break;
    case 'series-rekey': break;
    case 'rekey-scene-car':
      s.sceneCars = s.sceneCars.map((c) => (c === e.oldId ? e.newId : c)); break;
    case 'rekey-field':
      s.field = s.field.map((p) => (p.peerIndex === e.oldId ? { ...p, peerIndex: e.newId } : p)); break;
    case 'set-auto-paused': s.autoPaused = e.on; break;
    case 'sync-frozen': break;
    case 'return-to-lobby': break;
    default: throw new Error(`unknown effect op: ${e.op}`);
  }
}

// The observable slice of the state, recorded after every step. Deliberately
// the SHELL-VISIBLE surface only — a port may structure its internals freely.
function digest(s) {
  return {
    roomState: s.roomState, screen: s.screen, hasSession: s.hasSession,
    sessionBound: s.sessionBound, paused: s.paused, autoPaused: s.autoPaused,
    raceEnded: s.raceEnded, pauseOverlay: s.pauseOverlay, pauseButton: s.pauseButton,
    chrome: s.chrome, music: s.music, musicCredit: s.musicCredit,
    trackId: s.trackId, trackSeed: s.trackSeed, countdownShown: s.countdownShown,
    cars: s.sceneCars, aiIds: s.aiIds, demoRunning: s.demoRunning,
    seriesRaceIndex: s.seriesRaceIndex, resultsFailsafe: s.resultsFailsafe,
    intermissionDeadline: s.intermissionDeadline, lastBroadcast: s.lastBroadcast,
    ops: s.log.slice()
  };
}

// ---------------------------------------------------------------------------
// The op table. Each entry resolves its input against the driver's state, calls
// the layer, applies whatever effects came back, and returns {in, out}.
// ---------------------------------------------------------------------------
const OPS = {
  carStatsAt: (s, a) => ({ in: a, out: rf.carStatsAt(CAR_STATS, a.carIndex) }),
  lowestFreeSlot: (s, a) => ({ in: a, out: rf.lowestFreeSlot(new Set(a.used), a.count) }),
  cpuSeats: (s, a) => {
    const input = { ...WORLD, humans: a.humans, botCap: a.botCap ?? null };
    return { in: { humans: a.humans, botCap: a.botCap ?? null }, out: rf.cpuSeats(input) };
  },
  buildField: (s, a) => {
    const input = { ...WORLD, humans: a.humans, seed: a.seed, botCap: a.botCap ?? null };
    return { in: { humans: a.humans, seed: a.seed, botCap: a.botCap ?? null }, out: rf.buildField(input) };
  },
  buildDemoField: (s, a) => {
    const input = { ...WORLD, humans: a.humans, botCap: a.botCap ?? null };
    return { in: { humans: a.humans, botCap: a.botCap ?? null }, out: rf.buildDemoField(input) };
  },
  demoSig: (s, a) => ({ in: a, out: rf.demoSig(a.field, a.trackId) }),
  drawsNeeded: (s, a) => ({ in: a, out: rf.drawsNeeded(a) }),
  returnDrawsNeeded: (s, a) => ({ in: a, out: rf.returnDrawsNeeded(a) }),
  seriesForStart: (s, a) => {
    const input = { ...a, cups: CUPS };
    return { in: a, out: rf.seriesForStart(input) };
  },
  startRace: (s, a) => {
    const input = {
      roomState: s.roomState, sceneReady: a.sceneReady ?? true,
      selectedTrackId: a.selectedTrackId ?? s.trackId ?? 'a1',
      players: a.players, mode: a.mode, cupId: a.cupId ?? null,
      trackId: a.trackId ?? 'a1', randomRaces: a.randomRaces ?? 0,
      cups: CUPS, draws: a.draws ?? []
    };
    const out = rf.startRace(input);
    if (out.action === 'launch' && out.series) s.seriesRaceIndex = 0;
    return { in: { ...input, cups: undefined }, out };
  },
  launchRace: (s, a) => {
    const input = {
      ...WORLD, players: a.players, seed: a.seed, trackId: a.trackId,
      countdownSeconds: a.countdownSeconds ?? COUNTDOWN_SECONDS,
      forceItem: a.forceItem ?? null, botCap: a.botCap ?? null
    };
    const out = rf.launchRace(input);
    for (const e of out.effects) applyEffect(s, e);
    return { in: { players: a.players, seed: a.seed, trackId: a.trackId, countdownSeconds: input.countdownSeconds, forceItem: input.forceItem, botCap: input.botCap }, out };
  },
  countdownTick: (s, a) => {
    const out = rf.countdownTick(a.n);
    for (const e of out.effects) applyEffect(s, e);
    return { in: a, out };
  },
  raceStart: (s, a) => {
    const out = rf.raceStart({ biome: a.biome, audioReady: a.audioReady });
    for (const e of out.effects) applyEffect(s, e);
    return { in: a, out };
  },
  raceEvent: (s, a) => {
    const out = rf.raceEvent({ event: a.event, fastForwarding: !!a.fastForwarding, humansAllDone: !!a.humansAllDone });
    for (const e of out.effects) applyEffect(s, e);
    return { in: a, out };
  },
  endRace: (s, a) => {
    const input = {
      hasSeries: s.seriesRaceIndex != null, seriesFinished: !!a.seriesFinished,
      intermissionMs: a.intermissionMs ?? INTERMISSION_MS, nowMs: a.nowMs,
      resultsFailsafeMs: RESULTS_FAILSAFE_MS
    };
    const out = rf.endRace(input);
    for (const e of out.effects) applyEffect(s, e);
    return { in: input, out };
  },
  advanceSeriesRace: (s, a) => {
    const input = {
      roomState: s.roomState, hasSeries: s.seriesRaceIndex != null,
      seriesFinished: !!a.seriesFinished, sceneReady: a.sceneReady ?? true,
      players: a.players
    };
    const out = rf.advanceSeriesRace(input);
    for (const e of out.effects) applyEffect(s, e);
    return { in: input, out };
  },
  returnToLobby: (s, a) => {
    const input = {
      roomState: s.roomState, mode: a.mode, cupId: a.cupId ?? null,
      trackId: a.trackId ?? s.trackId, cups: CUPS, draws: a.draws ?? []
    };
    const out = rf.returnToLobby(input);
    for (const e of out.effects) applyEffect(s, e);
    return { in: { ...input, cups: undefined }, out };
  },
  forfeitCar: (s, a) => {
    const out = rf.forfeitCar({ removed: !!a.removed, peerIndex: a.peerIndex });
    for (const e of out.effects) applyEffect(s, e);
    return { in: a, out };
  },
  rekeyCarPlayer: (s, a) => {
    const input = { hasSeries: s.seriesRaceIndex != null, rekeyed: !!a.rekeyed, oldId: a.oldId, newId: a.newId };
    const out = rf.rekeyCarPlayer(input);
    for (const e of out.effects) applyEffect(s, e);
    return { in: input, out };
  },
  autoPauseEffects: (s, a) => {
    const out = rf.autoPauseEffects(a.decision);
    for (const e of out.effects) applyEffect(s, e);
    return { in: a, out };
  }
};

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------
const P = (peerIndex, name, colorIndex, carIndex) => ({ peerIndex, name, colorIndex, carIndex });

const SCRIPTS = [];

// A single race, start to lobby: the whole happy arc, which is what pins the
// launch ORDER and the endRace order.
SCRIPTS.push({
  name: 'single-race-arc',
  steps: [
    ['startRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 3)], mode: 'exact', trackId: 'a1', selectedTrackId: 'a1' }],
    ['launchRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 3)], seed: 12345, trackId: 'a1' }],
    ['countdownTick', { n: 3 }],
    ['countdownTick', { n: 2 }],
    ['countdownTick', { n: 1 }],
    ['countdownTick', { n: 0 }],
    ['raceStart', { biome: 'meadow', audioReady: true }],
    ['countdownTick', { n: -1 }],
    ['raceEvent', { event: { type: 'pickup', id: 1, item: 'banana', finished: false } }],
    ['raceEvent', { event: { type: 'spin', id: 2, cause: 'rocket' } }],
    ['raceEvent', { event: { type: 'rocket_expire', s: 12.5, lat: -1.25 } }],
    ['raceEvent', { event: { type: 'finish', id: 1 }, humansAllDone: false }],
    ['raceEvent', { event: { type: 'finish', id: 2 }, humansAllDone: true }],
    ['endRace', { nowMs: 1000000 }],
    ['returnToLobby', { mode: 'exact', trackId: 'a1' }]
  ]
});

// The cup chain: start → race 1 → intermission → advance → race 2 → podium.
// This is the arc where the failsafe/intermission timers have to interleave
// correctly, and where points are banked before the board.
SCRIPTS.push({
  name: 'cup-chain',
  steps: [
    ['startRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 1), P(3, 'Cy', 2, 2)], mode: 'cup', cupId: 'cup-a', trackId: 'a1', selectedTrackId: 'a1' }],
    ['launchRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 1), P(3, 'Cy', 2, 2)], seed: 777, trackId: 'a1' }],
    ['raceStart', { biome: 'dunes', audioReady: true }],
    ['endRace', { nowMs: 2000000, seriesFinished: false }],
    ['advanceSeriesRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 1), P(3, 'Cy', 2, 2)] }],
    ['launchRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 1), P(3, 'Cy', 2, 2)], seed: 778, trackId: 'a2' }],
    ['raceStart', { biome: 'dunes', audioReady: false }],
    ['endRace', { nowMs: 2100000, seriesFinished: true }],   // podium: no intermission armed
    ['advanceSeriesRace', { players: [P(1, 'Ann', 0, 0)], seriesFinished: true }],
    ['returnToLobby', { mode: 'cup', cupId: 'cup-a', trackId: 'a2' }]
  ]
});

// Random mode in its three shapes, plus the lobby return that re-rolls the pick.
SCRIPTS.push({
  name: 'random-modes',
  steps: [
    ['drawsNeeded', { mode: 'random', randomRaces: 0 }],
    ['drawsNeeded', { mode: 'random', randomRaces: 1 }],
    ['drawsNeeded', { mode: 'random', randomRaces: 4 }],
    ['drawsNeeded', { mode: 'cup', randomRaces: 4 }],
    ['drawsNeeded', { mode: 'exact', randomRaces: 0 }],
    ['seriesForStart', { mode: 'random', trackId: 'a1', randomRaces: 0, draws: ['b1', 'b2', 'b3'] }],
    ['seriesForStart', { mode: 'random', trackId: 'a1', randomRaces: 1, draws: ['b1', 'b2', 'b3'] }],
    ['seriesForStart', { mode: 'random', trackId: 'a1', randomRaces: 4, draws: ['b1', 'b2', 'b3'] }],
    ['seriesForStart', { mode: 'random', trackId: 'a1', randomRaces: 6, draws: ['b1', 'b2'] }], // fewer draws than asked
    ['seriesForStart', { mode: 'cup', cupId: 'cup-a', trackId: 'a1' }],
    ['seriesForStart', { mode: 'cup', cupId: 'cup-empty', trackId: 'a1' }],
    ['seriesForStart', { mode: 'cup', cupId: 'no-such-cup', trackId: 'a1' }],
    ['seriesForStart', { mode: 'exact', trackId: 'solo1' }],
    ['startRace', { players: [P(1, 'Ann', 0, 0)], mode: 'random', trackId: 'a1', randomRaces: 3, draws: ['b1', 'b2'], selectedTrackId: 'a1' }],
    ['launchRace', { players: [P(1, 'Ann', 0, 0)], seed: 5, trackId: 'a1' }],
    ['endRace', { nowMs: 3000000, seriesFinished: false }],
    ['returnToLobby', { mode: 'random', trackId: 'a1', draws: ['b4'] }]
  ]
});

// Every start REJECTION. The recorded behaviour is the contract, error paths
// included — a port that starts a race from RESULTS is broken in a way no happy
// arc can see.
SCRIPTS.push({
  name: 'start-rejections',
  steps: [
    ['startRace', { players: [P(1, 'Ann', 0, 0)], mode: 'exact', selectedTrackId: null }],
    ['startRace', { players: [], mode: 'exact', selectedTrackId: 'a1' }],
    ['startRace', { players: [P(1, 'Ann', 0, 0)], mode: 'exact', selectedTrackId: 'a1', sceneReady: false }],
    ['launchRace', { players: [P(1, 'Ann', 0, 0)], seed: 9, trackId: 'a1' }],  // now PLAYING-ish
    ['startRace', { players: [P(1, 'Ann', 0, 0)], mode: 'exact', selectedTrackId: 'a1' }], // rejected: not lobby
    ['advanceSeriesRace', { players: [P(1, 'Ann', 0, 0)] }],   // rejected: not results, no series
    ['returnToLobby', { mode: 'exact', trackId: 'a1' }],
    ['returnToLobby', { mode: 'exact', trackId: 'a1' }]        // second call is a no-op
  ]
});

// The roster-driven repairs, mid-race.
SCRIPTS.push({
  name: 'roster-repairs',
  steps: [
    ['launchRace', { players: [P(1, 'Ann', 0, 0), P(2, 'Bo', 1, 1)], seed: 42, trackId: 'a1' }],
    ['raceStart', { biome: 'meadow', audioReady: true }],
    ['forfeitCar', { removed: true, peerIndex: 2 }],
    ['forfeitCar', { removed: false, peerIndex: 2 }],      // session no longer holds it
    ['rekeyCarPlayer', { rekeyed: true, oldId: 1, newId: 7 }],
    ['rekeyCarPlayer', { rekeyed: false, oldId: 99, newId: 100 }], // points follow, no car
    ['autoPauseEffects', { decision: { action: 'none' } }],
    ['autoPauseEffects', { decision: { action: 'set', autoPaused: true } }],
    ['autoPauseEffects', { decision: { action: 'set', autoPaused: false } }],
    ['autoPauseEffects', { decision: { action: 'return-to-lobby' } }],
    ['autoPauseEffects', { decision: null }]
  ]
});

// The CPU fill, across every shape that changes its answer: an empty lobby, a
// full lobby, colour collisions, the ?bots cap, and carIndex wrap/defaults.
SCRIPTS.push({
  name: 'cpu-fill',
  steps: [
    ['cpuSeats', { humans: [] }],
    ['cpuSeats', { humans: [P(1, 'Ann', 0, 0)] }],
    ['cpuSeats', { humans: [P(1, 'Ann', 3, 0), P(2, 'Bo', 1, 1)] }],   // non-contiguous liveries
    ['cpuSeats', { humans: [P(1, 'a', 0, 0), P(2, 'b', 1, 1), P(3, 'c', 2, 2), P(4, 'd', 3, 3)] }], // full
    ['cpuSeats', { humans: [P(1, 'Ann', 0, 0)], botCap: 0 }],
    ['cpuSeats', { humans: [P(1, 'Ann', 0, 0)], botCap: 1 }],
    ['cpuSeats', { humans: [P(1, 'Ann', 0, 0)], botCap: 99 }],
    ['buildField', { humans: [P(1, 'Ann', 0, 0)], seed: 1000 }],
    ['buildField', { humans: [P(1, 'Ann', 0, null), P(2, 'Bo', 1, 77)], seed: 0 }],  // null + past-the-end carIndex
    ['buildField', { humans: [], seed: 4294967295 }],                                 // seed wrap
    ['buildField', { humans: [P(1, 'Ann', 0, -3)], seed: 7, botCap: 2 }],              // negative carIndex
    ['buildDemoField', { humans: [P(1, 'Ann', 0, null), P(2, 'Bo', 5, 2)] }],
    ['buildDemoField', { humans: [] }],
    ['demoSig', { field: [{ id: 'demo-1', colorIndex: 0, carIndex: 0 }, { id: 'demo-cpu-0', colorIndex: 1, carIndex: 1 }], trackId: 'a1' }],
    ['carStatsAt', { carIndex: 0 }],
    ['carStatsAt', { carIndex: null }],
    ['carStatsAt', { carIndex: 5 }],
    ['carStatsAt', { carIndex: 6 }],
    ['carStatsAt', { carIndex: -1 }],
    ['carStatsAt', { carIndex: 1.0 }],
    ['lowestFreeSlot', { used: [], count: 8 }],
    ['lowestFreeSlot', { used: [0, 1, 2], count: 8 }],
    ['lowestFreeSlot', { used: [0, 1, 2, 3, 4, 5, 6, 7], count: 8 }],  // none free → 0
    ['lowestFreeSlot', { used: [1, 3], count: 8 }]
  ]
});

// Countdown + race-event edge cases, including the trailing n<0 beat that must
// never be broadcast and the fast-forward silence.
SCRIPTS.push({
  name: 'beats-and-events',
  steps: [
    ['countdownTick', { n: 5 }],
    ['countdownTick', { n: 0 }],
    ['countdownTick', { n: -1 }],
    ['countdownTick', { n: -5 }],
    ['raceEvent', { event: null }],
    ['raceEvent', { event: { type: 'pickup', id: 1, item: 'rocket', finished: true } }],   // victory-lap grab: no spin
    ['raceEvent', { event: { type: 'pickup', id: 1, item: 'rocket', finished: false }, fastForwarding: true }],
    ['raceEvent', { event: { type: 'spin', id: 1, cause: 'banana' } }],                    // not a rocket strike
    ['raceEvent', { event: { type: 'finish', id: 1 }, fastForwarding: true }],
    ['raceEvent', { event: { type: 'lap', id: 1, lap: 2 } }],
    ['raceEvent', { event: { type: 'finish', id: 1 }, humansAllDone: true }],
    ['raceEvent', { event: { type: 'finish', id: 1 }, humansAllDone: false }]
  ]
});

// The lobby-return draw rule, one step per mode. Appended as its own scenario
// (2026-07-31) rather than inside random-modes so every previously recorded
// step keeps its index — the file stays append-only across re-records.
SCRIPTS.push({
  name: 'return-draws',
  steps: [
    ['returnDrawsNeeded', { mode: 'random' }],
    ['returnDrawsNeeded', { mode: 'cup' }],
    ['returnDrawsNeeded', { mode: 'exact' }]
  ]
});

// Seeded random sweeps. They also drive INVALID input (unknown cups, empty
// fields, ids nobody holds) because the recorded behaviour is the contract.
function sweep(seed, n) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const steps = [];
  const humansOf = (k) => Array.from({ length: k }, (_, i) => P(i + 1, `P${i + 1}`, i % COLOR_COUNT, i % CAR_COUNT));
  for (let i = 0; i < n; i++) {
    const op = pick(['cpuSeats', 'buildField', 'buildDemoField', 'seriesForStart', 'drawsNeeded', 'countdownTick', 'raceEvent', 'forfeitCar', 'rekeyCarPlayer', 'carStatsAt', 'lowestFreeSlot']);
    const k = Math.floor(rnd() * 5);
    if (op === 'cpuSeats' || op === 'buildDemoField') {
      steps.push([op, { humans: humansOf(k), botCap: rnd() < 0.3 ? Math.floor(rnd() * 5) : null }]);
    } else if (op === 'buildField') {
      steps.push([op, { humans: humansOf(k), seed: Math.floor(rnd() * 0xffffffff), botCap: rnd() < 0.3 ? Math.floor(rnd() * 5) : null }]);
    } else if (op === 'drawsNeeded') {
      steps.push([op, { mode: pick(['cup', 'random', 'exact']), randomRaces: Math.floor(rnd() * 6) }]);
    } else if (op === 'seriesForStart') {
      steps.push([op, {
        mode: pick(['cup', 'random', 'exact', 'nonsense']),
        cupId: pick(['cup-a', 'cup-b', 'cup-empty', 'ghost']),
        trackId: pick(['a1', 'b1', 'solo1']),
        randomRaces: Math.floor(rnd() * 5),
        draws: ['b1', 'b2', 'b3', 'b4'].slice(0, Math.floor(rnd() * 5))
      }]);
    } else if (op === 'countdownTick') {
      steps.push([op, { n: Math.floor(rnd() * 9) - 4 }]);
    } else if (op === 'raceEvent') {
      steps.push([op, {
        event: { type: pick(['pickup', 'spin', 'finish', 'lap', 'rocket_expire']), id: Math.floor(rnd() * 4), item: pick(['banana', 'rocket', 'oil']), cause: pick(['rocket', 'banana', 'oil']), finished: rnd() < 0.5, s: 1.5, lat: -0.5 },
        fastForwarding: rnd() < 0.3,
        humansAllDone: rnd() < 0.3
      }]);
    } else if (op === 'forfeitCar') {
      steps.push([op, { removed: rnd() < 0.7, peerIndex: Math.floor(rnd() * 4) }]);
    } else if (op === 'rekeyCarPlayer') {
      steps.push([op, { rekeyed: rnd() < 0.7, oldId: Math.floor(rnd() * 4), newId: 90 + i }]);
    } else if (op === 'carStatsAt') {
      steps.push([op, { carIndex: rnd() < 0.2 ? null : Math.floor(rnd() * 20) - 8 }]);
    } else {
      const used = [];
      for (let j = 0; j < COLOR_COUNT; j++) if (rnd() < 0.5) used.push(j);
      steps.push([op, { used, count: COLOR_COUNT }]);
    }
  }
  return { name: `sweep-${seed}`, steps };
}
SCRIPTS.push(sweep(1, 60), sweep(2, 60), sweep(3, 60));

// ---------------------------------------------------------------------------
function buildCorpus() {
  const lines = [];
  let steps = 0;
  for (const script of SCRIPTS) {
    lines.push(canonicalStringify({ case: 'scenario', name: script.name }));
    const s = freshState();
    let i = 0;
    for (const [op, args] of script.steps) {
      const fn = OPS[op];
      if (!fn) throw new Error(`unknown op ${op} in ${script.name}`);
      s.log = [];
      const { in: input, out } = fn(s, args);
      lines.push(canonicalStringify({
        case: 'step', name: script.name, step: i++, op,
        in: input, out, state: digest(s)
      }));
      steps++;
    }
  }
  const header = canonicalStringify({
    kind: 'raceflow-corpus', version: 1,
    scenarios: SCRIPTS.length, steps,
    // The header CARRIES the world, it does not summarize it. Every scenario
    // below was recorded against these personas, stat rows, cups and sizes, so
    // a replayer that guessed them differently would replay into a world the
    // recorded answers were never produced in. Shipping it here means a port
    // CONFIGURES ITSELF FROM THE CORPUS — `raceflow_check.cc` builds the
    // layer's types from it and `abi_check.cc` hands it straight to
    // `ttp_race_configure` — instead of transcribing this file into C++ twice.
    // See tests/fixtures/traces/README.md, "A corpus carries its own world".
    world: {
      fieldSize: FIELD_SIZE, carCount: CAR_COUNT, colorCount: COLOR_COUNT,
      aiPrefix: AI_PREFIX, personas: PERSONAS, carStats: CAR_STATS, cups: CUPS
    },
    intermissionMs: INTERMISSION_MS, resultsFailsafeMs: RESULTS_FAILSAFE_MS,
    countdownSeconds: COUNTDOWN_SECONDS
  });
  return { text: [header, ...lines].join('\n') + '\n', scenarios: SCRIPTS.length, steps };
}

// The synthetic world, so tests/raceflow-corpus.test.js can replay a committed
// line through the same driver it was recorded with.
export { CUPS, PERSONAS, CAR_STATS, AI_PREFIX, FIELD_SIZE, CAR_COUNT, COLOR_COUNT, INTERMISSION_MS, RESULTS_FAILSAFE_MS };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { text, scenarios: nScn, steps } = buildCorpus();
  // --stdout goes to a PIPE, and `process.exit()` right after a write to one
  // TRUNCATES it: the write is asynchronous, exit does not flush, and the loss
  // is silent at exactly the 64 KiB pipe buffer. This corpus is 223 KB, so it
  // was the first one big enough to notice — the branch ends here instead and
  // the process exits on its own.
  if (process.argv.includes('--stdout')) {
    process.stdout.write(text);
  } else if (process.argv.includes('--check')) {
    const have = fs.readFileSync(OUT, 'utf8');
    if (have !== text) {
      console.error(`${OUT}: re-derived corpus differs from the committed one`);
      process.exit(1);
    }
    console.log(`${OUT}: reproduced byte-identically (${nScn} scenarios, ${steps} steps)`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    console.log(`${OUT}: ${steps} steps over ${nScn} scenarios`);
  }
}
