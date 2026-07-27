// Generates tests/fixtures/ui-corpus.jsonl — the oracle for the display's UI
// MODEL (public/display/uiModel.js).
//
// WHY IT EXISTS NOW. docs/native-port/shared-cpp-plan.md P8 moves the UI model
// into C++ (P6 takes the per-frame HUD block ahead of it). The repo's conformance
// rests on JS-RECORDED fixtures because they are the only CROSS-IMPLEMENTATION
// evidence that a port matches the JS it replaced, and the ratchet is one-way:
// gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs can no longer RUN, because
// their JS twins were deleted. So this records the model's answers NOW, while the
// JS that produces them still exists.
//
// EVERY INPUT IS COMMITTED, AND THERE IS EXACTLY ONE. The generator reads
// public/display/uiModel.js and nothing else — no wasm, no traces, no track
// catalogue. That is deliberate: the model is catalogue-AGNOSTIC (it looks cups
// and tracks up in whatever list it is handed), so binding the oracle to
// shared/tracks.js would make every new track a corpus re-record and hand the
// fixture a way to rot. The scenarios below carry their own synthetic catalogue.
// Whether the SHIPPED catalogue still flows through the model correctly is
// tests/ui-model.test.js's job, and it is free to change with the data.
//
// SHAPE (following gen-roomflow-corpus.mjs, the established pattern here): each
// fixture line is one step of one scripted scenario — the op, its input, and the
// model's answer. Scenarios are stateful the way the shell is: the driver keeps
// the three pieces of state main.js owns (the current screen, the set of
// reconnect cards actually on screen, and what each phone was last told its item
// was) and feeds the model's answers back into them, so a scenario replays a real
// room+race arc rather than a table of isolated calls.
//
// Hand-authored scenarios cover the documented behaviours — lobby fill / leave /
// rename / car pick, ready transitions, the countdown and race states, the HUD
// across laps, a finish, a cup intermission, a podium, late joiners, a reconnect,
// a forfeit, auto-pause — plus seeded random sweeps (mulberry32) that also drive
// INVALID input (unknown cups, missing tracks, empty fields, ids nobody holds),
// because the recorded behaviour IS the contract, error paths included.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-ui-corpus.mjs [--check | --stdout]
//   --check  re-derive and require the committed corpus to match, writing nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalStringify, mulberry32 } from './oracle-lib.mjs';
import * as ui from '../public/display/uiModel.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/ui-corpus.jsonl');

// ---------------------------------------------------------------------------
// The synthetic world every scenario is written against. Two cups of four
// circuits plus one cupless track, which is enough to exercise every lookup the
// model does (cup → its races, track → its cup + difficulty, an id in no cup, an
// id in no catalogue at all).
// ---------------------------------------------------------------------------
const CUPS = [
  { id: 'cup-a', name: 'Sunrise', tracks: ['a1', 'a2', 'a3', 'a4'] },
  { id: 'cup-b', name: 'Thunder', tracks: ['b1', 'b2', 'b3', 'b4'] },
  { id: 'cup-empty', name: 'Hollow', tracks: [] }
];
const CATALOG = [
  { id: 'a1', name: 'Dune Loop', cup: 'cup-a', cupName: 'Sunrise', cupDifficulty: 1 },
  { id: 'a2', name: 'Palm Sprint', cup: 'cup-a', cupName: 'Sunrise', cupDifficulty: 1 },
  { id: 'a3', name: 'Reef Run', cup: 'cup-a', cupName: 'Sunrise', cupDifficulty: 1 },
  { id: 'a4', name: 'Sand Spiral', cup: 'cup-a', cupName: 'Sunrise', cupDifficulty: 1 },
  { id: 'b1', name: 'Storm Gate', cup: 'cup-b', cupName: 'Thunder', cupDifficulty: 4 },
  { id: 'b2', name: 'Bolt Bend', cup: 'cup-b', cupName: 'Thunder', cupDifficulty: 4 },
  { id: 'b3', name: 'Rift Rise', cup: 'cup-b', cupName: 'Thunder', cupDifficulty: 4 },
  { id: 'b4', name: 'Crash Coil', cup: 'cup-b', cupName: 'Thunder', cupDifficulty: 4 },
  { id: 'solo', name: 'Lone Oval', cup: null, cupName: null, cupDifficulty: null }
];
const MAX_PLAYERS = 4;
const CAR_COUNT = 6;
const INTERMISSION_MS = 10000;

// ---------------------------------------------------------------------------
// The driver. One `run` per scenario; the shell state it threads is exactly the
// state main.js owns beside the model.
// ---------------------------------------------------------------------------
const setOf = (a) => new Set(a || []);

// The shell state a scenario threads — exactly what main.js owns beside the
// model. Exported so tests/ui-corpus.test.js replays committed steps through the
// same driver they were recorded with.
export function newShellState(screen) {
  return {
    screen: screen === undefined ? null : screen,
    shown: [],            // reconnect cards actually on screen (main.js _rcShown)
    lastItem: new Map()   // what each phone was last told (main.js _lastItem)
  };
}

function runScenario(scn) {
  const st = newShellState(scn.screen);
  const steps = [];
  for (const op of scn.ops) {
    steps.push({ op: op.op, in: opInput(op), out: applyOp(st, op), state: shellState(st) });
  }
  return steps;
}

// The input as RECORDED: the op minus its name, so the corpus line carries
// everything a replay needs.
function opInput(op) {
  const { op: _name, ...rest } = op;
  return Object.keys(rest).length ? rest : null;
}

export function shellState(st) {
  return {
    screen: st.screen,
    shown: [...st.shown],
    lastItem: [...st.lastItem.entries()].map(([id, item]) => ({ id, item: item === undefined ? null : item }))
  };
}

export function applyOp(st, op) {
  switch (op.op) {
    // ---- screens ----------------------------------------------------------
    // show(name): a forward step pushes one history entry, a backward step pops
    // one. The driver records the STEP and the resulting nav action, not the
    // History API call itself (the plan's non-goal).
    case 'show': {
      const step = ui.screenStep(st.screen, op.to);
      st.screen = op.to;
      return { step, nav: step > 0 ? 'push' : step < 0 ? 'pop' : 'none' };
    }
    case 'back':
      return { effect: ui.backEffect(st.screen) };

    // ---- the lobby --------------------------------------------------------
    case 'roster': {
      const seats = ui.rosterSeats(op.roster, op.host === undefined ? null : op.host);
      return {
        seats,
        grid: ui.seatGrid(seats, MAX_PLAYERS, CAR_COUNT),
        ready: ui.allRacersReady(op.roster, op.host === undefined ? null : op.host),
        connected: ui.connectedPlayers(op.roster).map((p) => p.peerIndex)
      };
    }
    case 'pick':
      return {
        slot: ui.cupSlot({
          mode: op.mode === undefined ? null : op.mode,
          cupId: op.cupId === undefined ? null : op.cupId,
          trackId: op.trackId === undefined ? null : op.trackId,
          cups: CUPS, catalog: CATALOG
        })
      };

    // ---- dropped-seat reconnect cards -------------------------------------
    // `land` names the added seats whose card actually attached (a seat whose car
    // has no cell fails), which is why the shown set is the shell's and not the
    // model's. Absent = every card lands.
    case 'reconnect': {
      const diff = ui.reconnectDiff([...st.shown], op.seats);
      st.shown = st.shown.filter((id) => !diff.remove.includes(id));
      for (const s of diff.add) {
        if (op.land === undefined || op.land.includes(s.peerIndex)) st.shown.push(s.peerIndex);
      }
      return { remove: diff.remove, add: diff.add.map((s) => s.peerIndex) };
    }

    // ---- the racing HUD ---------------------------------------------------
    case 'hud': {
      const aiIds = setOf(op.aiIds);
      const rows = ui.hudRows(op.cars);
      const pushes = ui.itemPushes(op.cars, aiIds, st.lastItem);
      for (const p of pushes) st.lastItem.set(p.id, p.item);
      return { rows, pushes };
    }
    case 'clearItems':
      st.lastItem.clear();
      return { cleared: true };
    case 'welcomeItem': {
      const item = ui.welcomeItem(op.car === undefined ? null : op.car);
      return { item: item === undefined ? null : item };
    }

    // ---- race flow --------------------------------------------------------
    case 'flow': {
      const sets = {
        carIds: op.carIds,
        aiIds: setOf(op.aiIds),
        disconnectedIds: setOf(op.disconnectedIds),
        finishedIds: setOf(op.finishedIds)
      };
      return { allDone: ui.humansAllDone(sets), forfeit: ui.forfeitCandidates(sets) };
    }

    // ---- pause arbitration ------------------------------------------------
    case 'autopause': {
      const input = {
        hasSession: !!op.hasSession,
        raceEnded: !!op.raceEnded,
        roomState: op.roomState,
        carIds: op.carIds || [],
        aiIds: setOf(op.aiIds),
        seatedIds: setOf(op.seatedIds)
      };
      const asks = ui.autoPauseAsksParticipants(input);
      // The shell only READS the party layer when the model asks — the read
      // pushes the live car set into the room machine, so its timing matters.
      const decision = ui.autoPause({ ...input, allParticipantsDisconnected: asks && !!op.allDisconnected });
      return { asks, decision };
    }
    case 'freeze':
      return {
        move: ui.freezeTransition({ paused: op.paused, autoPaused: op.autoPaused, sessionPaused: op.sessionPaused }),
        canPause: ui.canPause({ hasSession: !!op.hasSession, paused: op.paused, roomState: op.roomState }),
        canResume: ui.canResume({ hasSession: !!op.hasSession, paused: op.paused })
      };

    // ---- the standings board ----------------------------------------------
    // One op for the whole chain the display runs: the cup chip feeds the board,
    // and the final board feeds the results overlay.
    case 'board': {
      const s = op.series || null;
      const cup = s ? {
        standings: s.standings,
        info: ui.seriesInfo({
          cupId: s.cupId, cupName: s.cupName, endless: !!s.endless,
          raceIndex: s.raceIndex, raceCount: s.raceCount,
          finished: !!s.finished, nextTrackId: s.nextTrackId === undefined ? null : s.nextTrackId,
          catalog: CATALOG, autoAdvanceMs: INTERMISSION_MS
        })
      } : null;
      const board = ui.standingsPayload({
        results: op.results,
        field: op.field || [],
        cup,
        lateJoiners: op.lateJoiners || [],
        hostPeerIndex: op.hostPeerIndex === undefined ? null : op.hostPeerIndex,
        over: !!op.over
      });
      return {
        board,
        // The exact bytes the phones receive: canonicalStringify sorts keys, so
        // this is the only place the board's INSERTION order is pinned.
        wire: JSON.stringify(board),
        view: op.over ? ui.resultsView(board, { intermissionMs: INTERMISSION_MS }) : null
      };
    }
    case 'intermission':
      return { secs: ui.intermissionSecs(op.deadlineMs, op.nowMs) };

    default:
      throw new Error(`unknown ui-corpus op '${op.op}'`);
  }
}

// ---------------------------------------------------------------------------
// Hand-authored scenarios.
// ---------------------------------------------------------------------------
const seat = (i, o = {}) => ({
  peerIndex: i,
  name: o.name === undefined ? `Player ${i + 1}` : o.name,
  colorIndex: o.colorIndex === undefined ? i : o.colorIndex,
  carIndex: o.carIndex === undefined ? i : o.carIndex,
  connected: o.connected === undefined ? true : o.connected,
  ready: !!o.ready
});

// A snapshot car, with only the fields the HUD reads.
const hudCar = (id, o = {}) => ({
  id,
  position: o.position === undefined ? 1 : o.position,
  lap: o.lap === undefined ? 1 : o.lap,
  totalLaps: o.totalLaps === undefined ? 3 : o.totalLaps,
  item: o.item === undefined ? null : o.item,
  finished: !!o.finished,
  finishTime: o.finishTime === undefined ? null : o.finishTime
});

const res = (playerId, rank, o = {}) => ({
  playerId, rank,
  finished: o.finished === undefined ? true : o.finished,
  time: o.time === undefined ? 60 + rank : o.time
});

const fieldRow = (peerIndex, o = {}) => ({
  peerIndex,
  name: o.name === undefined ? `Player ${peerIndex + 1}` : o.name,
  colorIndex: o.colorIndex === undefined ? 0 : o.colorIndex,
  ai: !!o.ai
});

const AI_FIELD = [
  fieldRow(0, { name: 'Ada', colorIndex: 0 }),
  fieldRow(1, { name: 'Bo', colorIndex: 1 }),
  fieldRow('ai-0', { name: 'Bolt', colorIndex: 2, ai: true }),
  fieldRow('ai-1', { name: 'Dash', colorIndex: 3, ai: true })
];

const scenarios = [];

// -- the screen stack and what back means on each board ----------------------
scenarios.push({
  name: 'screens-and-back-effects',
  ops: [
    { op: 'back' },                       // no screen yet — the root's answer
    { op: 'show', to: 'welcome' },
    { op: 'back' },
    { op: 'show', to: 'lobby' },          // forward: push
    { op: 'back' },
    { op: 'show', to: 'race' },
    { op: 'back' },
    { op: 'show', to: 'race' },           // same level: no nav
    { op: 'show', to: 'lobby' },          // backward: pop
    { op: 'show', to: 'welcome' },
    { op: 'show', to: 'race' },           // two levels at once, still one push
    { op: 'show', to: 'welcome' },        // ... and one pop back down
    { op: 'show', to: 'nowhere' },        // an unknown board counts as the root
    { op: 'back' }
  ]
});

// -- the lobby filling, renaming, picking cars, readying up ------------------
scenarios.push({
  name: 'lobby-fill-rename-carpick-ready',
  screen: 'lobby',
  ops: [
    { op: 'roster', roster: [], host: null },                         // four open seats
    { op: 'roster', roster: [seat(0)], host: 0 },                     // first joiner is host
    { op: 'roster', roster: [seat(0), seat(1)], host: 0 },
    { op: 'roster', roster: [seat(0), seat(1), seat(2)], host: 0 },
    { op: 'roster', roster: [seat(0), seat(1), seat(2), seat(3)], host: 0 },
    // a rename, then a car pick (carIndex diverges from the livery slot)
    { op: 'roster', roster: [seat(0, { name: 'Ada' }), seat(1), seat(2), seat(3)], host: 0 },
    { op: 'roster', roster: [seat(0, { name: 'Ada', carIndex: 5 }), seat(1), seat(2), seat(3)], host: 0 },
    // a seat that never picked a car falls back to its livery slot
    { op: 'roster', roster: [seat(0, { carIndex: null }), seat(1, { carIndex: undefined })], host: 0 },
    // readiness: the host never readies, so the gate is about everyone else
    { op: 'roster', roster: [seat(0), seat(1), seat(2)], host: 0 },
    { op: 'roster', roster: [seat(0), seat(1, { ready: true }), seat(2)], host: 0 },
    { op: 'roster', roster: [seat(0), seat(1, { ready: true }), seat(2, { ready: true })], host: 0 },
    { op: 'roster', roster: [seat(0, { ready: true }), seat(1, { ready: true }), seat(2, { ready: true })], host: 0 },
    // the host themselves readying changes nothing; a NON-host host id does
    { op: 'roster', roster: [seat(0), seat(1, { ready: true })], host: 9 },
    // a solo lobby: the host alone is enough to start
    { op: 'roster', roster: [seat(0)], host: 0 },
    // ... but a solo lobby with no host is not, and neither is an empty one
    { op: 'roster', roster: [seat(0)], host: null },
    { op: 'roster', roster: [], host: 0 },
    // a dropped seat is held (dimmed) and does not count toward readiness
    { op: 'roster', roster: [seat(0), seat(1, { connected: false }), seat(2, { ready: true })], host: 0 },
    { op: 'roster', roster: [seat(0), seat(1, { connected: false, ready: true }), seat(2, { ready: true })], host: 0 },
    // a leave: the grid re-pads back to four
    { op: 'roster', roster: [seat(0), seat(2)], host: 0 },
    // more players than seats — the grid grows rather than truncating
    { op: 'roster', roster: [seat(0), seat(1), seat(2), seat(3), seat(4), seat(5)], host: 3 },
    // a car pick past the model roster wraps for the thumbnail
    { op: 'roster', roster: [seat(0, { carIndex: 11 }), seat(1, { carIndex: 6 })], host: 0 }
  ]
});

// -- the right-rail race card, in all four pick states -----------------------
scenarios.push({
  name: 'lobby-pick-card',
  screen: 'lobby',
  ops: [
    { op: 'pick' },                                             // pre-pick: empty slot
    { op: 'pick', mode: null, trackId: 'a1' },                  // a track with no mode is still no pick
    { op: 'pick', mode: 'cup', cupId: 'cup-a', trackId: 'a1' },
    { op: 'pick', mode: 'cup', cupId: 'cup-b', trackId: 'b1' },
    { op: 'pick', mode: 'cup', cupId: 'cup-empty', trackId: null },  // a cup with no circuits
    { op: 'pick', mode: 'cup', cupId: 'no-such-cup', trackId: 'a1' }, // unknown cup: the fallbacks
    { op: 'pick', mode: 'track', trackId: 'b3' },
    { op: 'pick', mode: 'track', trackId: 'solo' },             // a cupless track: no tint
    { op: 'pick', mode: 'track', trackId: 'no-such-track' },
    { op: 'pick', mode: 'track', trackId: null },
    { op: 'pick', mode: 'random', trackId: 'a3' },
    { op: 'pick', mode: 'random', trackId: 'solo' },
    { op: 'pick', mode: 'random', trackId: null },
    { op: 'pick', mode: 'no-such-mode', trackId: 'a1' }
  ]
});

// -- the HUD across a race: laps, an item, a finish --------------------------
scenarios.push({
  name: 'race-hud-across-laps',
  screen: 'race',
  ops: [
    { op: 'clearItems' },
    // the grid: every phone is told its (empty) slot on the first tick
    { op: 'hud', aiIds: ['ai-0'], cars: [hudCar(0), hudCar(1), hudCar('ai-0')] },
    // ... and told nothing on the next, because nothing changed
    { op: 'hud', aiIds: ['ai-0'], cars: [hudCar(0), hudCar(1), hudCar('ai-0')] },
    // lap 2, places shuffle, one pickup
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 2 }), hudCar(1, { position: 1, lap: 2, item: 'boost' }), hudCar('ai-0', { position: 3, lap: 2 })] },
    // a swap of held items, both ways in one tick
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 2, item: 'banana' }), hudCar(1, { position: 1, lap: 2 }), hudCar('ai-0', { position: 3, lap: 2 })] },
    // an AI holding an item is never pushed anywhere
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 2, item: 'banana' }), hudCar(1, { position: 1, lap: 3 }), hudCar('ai-0', { position: 3, lap: 3, item: 'rocket' })] },
    // the leader finishes holding an item: a finished car reports an EMPTY slot
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 3, item: 'banana' }),
      hudCar(1, { position: 1, lap: 3, item: 'rocket', finished: true, finishTime: 61.25 }),
      hudCar('ai-0', { position: 3, lap: 3 })] },
    // ... and keeps reporting empty while it victory-laps into more boxes
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 3, item: 'banana' }),
      hudCar(1, { position: 1, lap: 3, item: 'boost', finished: true, finishTime: 61.25 }),
      hudCar('ai-0', { position: 3, lap: 3 })] },
    // the last human home
    { op: 'hud', aiIds: ['ai-0'], cars: [
      hudCar(0, { position: 2, lap: 3, finished: true, finishTime: 64.5 }),
      hudCar(1, { position: 1, lap: 3, finished: true, finishTime: 61.25 }),
      hudCar('ai-0', { position: 3, lap: 3 })] },
    // a car that leaves the field stops being pushed at all
    { op: 'hud', aiIds: ['ai-0'], cars: [hudCar(1, { position: 1, finished: true, finishTime: 61.25 }), hudCar('ai-0')] },
    // an empty-string item is the same as none; a missing item field too
    { op: 'hud', aiIds: [], cars: [{ id: 7, position: 1, lap: 1, totalLaps: 3, item: '', finished: false, finishTime: null }] },
    { op: 'hud', aiIds: [], cars: [{ id: 7, position: 1, lap: 1, totalLaps: 3, finished: false, finishTime: null }] },
    // a fresh race resends every phone's empty slot
    { op: 'clearItems' },
    { op: 'hud', aiIds: ['ai-0'], cars: [hudCar(0), hudCar(1), hudCar('ai-0')] },
    // the one-shot relight a (re)joining phone gets
    { op: 'welcomeItem', car: hudCar(0, { item: 'boost' }) },
    { op: 'welcomeItem', car: hudCar(0, { item: 'boost', finished: true }) },
    { op: 'welcomeItem', car: hudCar(0) },
    { op: 'welcomeItem', car: null }
  ]
});

// -- the finish: who holds the flag down, and whose ghost gets forfeited ------
scenarios.push({
  name: 'finish-and-forfeit',
  screen: 'race',
  ops: [
    // nobody home yet
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [], finishedIds: [] },
    // one human home, one still out
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [], finishedIds: [1] },
    // both humans home while the bot circulates → fast-forward
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [], finishedIds: [0, 1] },
    // a dropped racer's ghost does NOT hold the flag down, and is forfeited
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [0], finishedIds: [1] },
    // ... even when it happens to have finished already
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [0], finishedIds: [0, 1] },
    // every human gone: false, because there is nobody to skip ahead FOR
    { op: 'flow', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: [0, 1], finishedIds: [] },
    // an all-AI field is the same answer for the same reason
    { op: 'flow', carIds: ['ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], disconnectedIds: [], finishedIds: ['ai-0'] },
    // an empty grid
    { op: 'flow', carIds: [], aiIds: [], disconnectedIds: [], finishedIds: [] },
    // a disconnected AI is not a forfeit candidate (bots hold no seat)
    { op: 'flow', carIds: [0, 'ai-0'], aiIds: ['ai-0'], disconnectedIds: ['ai-0'], finishedIds: [0] },
    // a solo human, out and then home
    { op: 'flow', carIds: [0], aiIds: [], disconnectedIds: [], finishedIds: [] },
    { op: 'flow', carIds: [0], aiIds: [], disconnectedIds: [], finishedIds: [0] }
  ]
});

// -- reconnect cards appearing, failing to attach, and coming down -----------
scenarios.push({
  name: 'reconnect-cards',
  screen: 'race',
  ops: [
    { op: 'reconnect', seats: [] },
    { op: 'reconnect', seats: [{ peerIndex: 1, name: 'Bo' }] },
    { op: 'reconnect', seats: [{ peerIndex: 1, name: 'Bo' }] },                       // unchanged → no churn
    { op: 'reconnect', seats: [{ peerIndex: 1, name: 'Bo' }, { peerIndex: 2, name: 'Cy' }] },
    // a card that cannot attach (its car has no cell) must be offered again next time
    { op: 'reconnect', seats: [{ peerIndex: 1 }, { peerIndex: 2 }, { peerIndex: 3 }], land: [] },
    { op: 'reconnect', seats: [{ peerIndex: 1 }, { peerIndex: 2 }, { peerIndex: 3 }] },
    // one comes back
    { op: 'reconnect', seats: [{ peerIndex: 2 }, { peerIndex: 3 }] },
    // a full reshuffle: one stays, one goes, one arrives
    { op: 'reconnect', seats: [{ peerIndex: 3 }, { peerIndex: 5 }] },
    // everyone back
    { op: 'reconnect', seats: [] },
    { op: 'reconnect', seats: [] }
  ]
});

// -- auto-pause arbitration, across every room state -------------------------
scenarios.push({
  name: 'auto-pause-arbitration',
  screen: 'race',
  ops: [
    // no race at all
    { op: 'autopause', hasSession: false, roomState: 'lobby', carIds: [], aiIds: [], seatedIds: [] },
    // a finished race is not arbitrated
    { op: 'autopause', hasSession: true, raceEnded: true, roomState: 'playing', carIds: [0], aiIds: [], seatedIds: [0] },
    // results / lobby are not race states
    { op: 'autopause', hasSession: true, roomState: 'results', carIds: [0], aiIds: [], seatedIds: [0], allDisconnected: true },
    { op: 'autopause', hasSession: true, roomState: 'lobby', carIds: [0], aiIds: [], seatedIds: [0], allDisconnected: true },
    // the countdown: never frozen, however empty the field looks
    { op: 'autopause', hasSession: true, roomState: 'countdown', carIds: [0, 'ai-0'], aiIds: ['ai-0'], seatedIds: [0], allDisconnected: true },
    { op: 'autopause', hasSession: true, roomState: 'countdown', carIds: [0, 'ai-0'], aiIds: ['ai-0'], seatedIds: [0], allDisconnected: false },
    // playing, everyone present
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], seatedIds: [0, 1], allDisconnected: false },
    // playing, every racer blipped but their seats held → the silent freeze
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], seatedIds: [0, 1], allDisconnected: true },
    // one comes back → the freeze lifts
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], seatedIds: [0, 1], allDisconnected: false },
    // every human seat gone from the room → nothing to wait for
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0'], aiIds: ['ai-0'], seatedIds: [], allDisconnected: true },
    { op: 'autopause', hasSession: true, roomState: 'countdown', carIds: [0, 'ai-0'], aiIds: ['ai-0'], seatedIds: [], allDisconnected: false },
    // an all-AI grid is the same: no human car, so no race to hold
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: ['ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: ['ai-0'], allDisconnected: false },
    // a car whose owner left the room does not count for anybody
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1], aiIds: [], seatedIds: [1], allDisconnected: false },
    // an unknown room state
    { op: 'autopause', hasSession: true, roomState: 'paused-forever', carIds: [0], aiIds: [], seatedIds: [0] },
    // the two freezes composing, and the sim moves they imply
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: false, autoPaused: false, sessionPaused: false },
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: true, autoPaused: false, sessionPaused: false },
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: true, autoPaused: false, sessionPaused: true },
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: true, autoPaused: true, sessionPaused: true },
    // a manual resume while every racer is still gone keeps the field frozen
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: false, autoPaused: true, sessionPaused: true },
    // ... and only both clearing thaws it
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: false, autoPaused: false, sessionPaused: true },
    // the gates: no session, wrong state, already in the target state
    { op: 'freeze', hasSession: false, roomState: 'playing', paused: false, autoPaused: false, sessionPaused: false },
    { op: 'freeze', hasSession: false, roomState: 'playing', paused: true, autoPaused: false, sessionPaused: true },
    { op: 'freeze', hasSession: true, roomState: 'countdown', paused: false, autoPaused: false, sessionPaused: false },
    { op: 'freeze', hasSession: true, roomState: 'results', paused: false, autoPaused: false, sessionPaused: false },
    { op: 'freeze', hasSession: true, roomState: 'lobby', paused: false, autoPaused: false, sessionPaused: false }
  ]
});

// -- a single race board, live and final -------------------------------------
scenarios.push({
  name: 'single-race-board',
  screen: 'race',
  ops: [
    // the first car home: a live board, in race order
    { op: 'board', hostPeerIndex: 0, over: false, field: AI_FIELD,
      results: [res(1, 1, { time: 61.2 }), res(0, 2, { finished: false, time: null }),
        res('ai-0', 3, { finished: false, time: null }), res('ai-1', 4, { finished: false, time: null })] },
    // the flag: everyone resolves, DNFs included
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      results: [res(1, 1, { time: 61.2 }), res('ai-0', 2, { time: 63.05 }), res(0, 3, { time: 64.7 }),
        res('ai-1', 4, { finished: false, time: null })] },
    // a racer nobody in the field can name falls back to its id
    { op: 'board', hostPeerIndex: 0, over: true, field: [fieldRow(0, { name: 'Ada' })],
      results: [res(0, 1, { time: 60 }), res(9, 2, { time: 70 }), res('ai-3', 3, { finished: false, time: null })] },
    // a field entry with no colour lands on livery 0
    { op: 'board', hostPeerIndex: null, over: true,
      field: [{ peerIndex: 0, name: 'Ada' }, { peerIndex: 1, name: '', colorIndex: 3 }],
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 })] },
    // an empty race
    { op: 'board', hostPeerIndex: 0, over: true, field: [], results: [] }
  ]
});

// -- late joiners: the `joining` rows, live and final ------------------------
scenarios.push({
  name: 'late-joiners',
  screen: 'race',
  ops: [
    { op: 'board', hostPeerIndex: 0, over: false, field: AI_FIELD,
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 }), res('ai-0', 3, { time: 62 }), res('ai-1', 4, { time: 63 })],
      lateJoiners: [{ peerIndex: 2, name: 'Cy', colorIndex: 2 }] },
    // two of them, in join order, always UNDER the racers
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 }), res('ai-0', 3, { time: 62 }), res('ai-1', 4, { time: 63 })],
      lateJoiners: [{ peerIndex: 2, name: 'Cy', colorIndex: 2 }, { peerIndex: 3, name: 'Di', colorIndex: 3 }] },
    // a whole race of nothing but people waiting for the next one
    { op: 'board', hostPeerIndex: 2, over: true, field: [], results: [],
      lateJoiners: [{ peerIndex: 2, name: 'Cy', colorIndex: 2 }, { peerIndex: 3, name: 'Di', colorIndex: 3 }] },
    // late joiners on a CUP board: they carry no points and take no cup seat
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      series: { cupId: 'cup-a', cupName: 'Sunrise', raceIndex: 1, raceCount: 4, nextTrackId: 'a3',
        standings: [
          { playerId: 1, points: 15, gained: 9 }, { playerId: 0, points: 12, gained: 6 },
          { playerId: 'ai-0', points: 6, gained: 3 }, { playerId: 'ai-1', points: 2, gained: 1 }] },
      results: [res(1, 1, { time: 60 }), res(0, 2, { time: 61 }), res('ai-0', 3, { time: 62 }), res('ai-1', 4, { time: 63 })],
      lateJoiners: [{ peerIndex: 2, name: 'Cy', colorIndex: 2 }] }
  ]
});

// -- a four-race cup: intermissions, then the podium -------------------------
{
  const cupField = AI_FIELD;
  const raceResults = [
    [res(0, 1, { time: 60.1 }), res(1, 2, { time: 61.4 }), res('ai-0', 3, { time: 62.9 }), res('ai-1', 4, { time: 64.2 })],
    [res(1, 1, { time: 59.8 }), res('ai-0', 2, { time: 60.2 }), res(0, 3, { time: 61.0 }), res('ai-1', 4, { finished: false, time: null })],
    [res('ai-1', 1, { time: 58.7 }), res(0, 2, { time: 59.1 }), res(1, 3, { time: 59.9 }), res('ai-0', 4, { time: 60.6 })],
    [res(1, 1, { time: 57.2 }), res(0, 2, { time: 57.6 }), res('ai-1', 3, { time: 58.4 }), res('ai-0', 4, { time: 59.9 })]
  ];
  // The cup table after each race, in the series layer's own order (points, then
  // latest-race placement) — the order the FINAL board is re-sorted into.
  const tables = [
    [{ playerId: 0, points: 9, gained: 9 }, { playerId: 1, points: 6, gained: 6 },
      { playerId: 'ai-0', points: 3, gained: 3 }, { playerId: 'ai-1', points: 1, gained: 1 }],
    [{ playerId: 1, points: 15, gained: 9 }, { playerId: 0, points: 12, gained: 3 },
      { playerId: 'ai-0', points: 9, gained: 6 }, { playerId: 'ai-1', points: 1, gained: 0 }],
    [{ playerId: 1, points: 18, gained: 3 }, { playerId: 0, points: 18, gained: 6 },
      { playerId: 'ai-1', points: 10, gained: 9 }, { playerId: 'ai-0', points: 10, gained: 1 }],
    [{ playerId: 1, points: 27, gained: 9 }, { playerId: 0, points: 24, gained: 6 },
      { playerId: 'ai-1', points: 13, gained: 3 }, { playerId: 'ai-0', points: 11, gained: 1 }]
  ];
  const ops = [];
  for (let i = 0; i < 4; i++) {
    const finished = i === 3;
    const seriesState = {
      cupId: 'cup-a', cupName: 'Sunrise', raceIndex: i, raceCount: 4, finished,
      nextTrackId: finished ? null : CUPS[0].tracks[i + 1], standings: tables[i]
    };
    // mid-race board first (race order, points stamped but no gains, no re-sort)
    ops.push({ op: 'board', hostPeerIndex: 0, over: false, field: cupField, series: seriesState, results: raceResults[i] });
    // then the final board: cup order, gains, and the intermission or the podium
    ops.push({ op: 'board', hostPeerIndex: 0, over: true, field: cupField, series: seriesState, results: raceResults[i] });
    if (!finished) {
      ops.push({ op: 'intermission', deadlineMs: 10000, nowMs: 0 });
      ops.push({ op: 'intermission', deadlineMs: 10000, nowMs: 4500 });
      ops.push({ op: 'intermission', deadlineMs: 10000, nowMs: 9999 });
      ops.push({ op: 'intermission', deadlineMs: 10000, nowMs: 10000 });
      ops.push({ op: 'intermission', deadlineMs: 10000, nowMs: 12000 });   // past the deadline: clamped
    }
  }
  scenarios.push({ name: 'cup-four-races-to-podium', screen: 'race', ops });
}

// -- the endless (random) series, which never reaches a podium ---------------
scenarios.push({
  name: 'endless-series',
  screen: 'race',
  ops: [
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      series: { cupId: 'random', cupName: 'Random', endless: true, raceIndex: 0, raceCount: 1, nextTrackId: 'b2',
        standings: [{ playerId: 0, points: 9, gained: 9 }, { playerId: 1, points: 6, gained: 6 },
          { playerId: 'ai-0', points: 3, gained: 3 }, { playerId: 'ai-1', points: 1, gained: 1 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 }), res('ai-0', 3, { time: 62 }), res('ai-1', 4, { time: 63 })] },
    // deep into an endless run: still an intermission, still no "of N"
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      series: { cupId: 'random', cupName: 'Random', endless: true, raceIndex: 11, raceCount: 12, nextTrackId: 'solo',
        standings: [{ playerId: 1, points: 74, gained: 9 }, { playerId: 0, points: 71, gained: 6 },
          { playerId: 'ai-0', points: 30, gained: 1 }, { playerId: 'ai-1', points: 28, gained: 3 }] },
      results: [res(1, 1, { time: 60 }), res(0, 2, { time: 61 }), res('ai-1', 3, { time: 62 }), res('ai-0', 4, { time: 63 })] },
    // an endless series that somehow reports finished: `final` wins, and the
    // "next up" goes away with it
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      series: { cupId: 'random', cupName: 'Random', endless: true, raceIndex: 2, raceCount: 3, finished: true, nextTrackId: 'a1',
        standings: [{ playerId: 0, points: 20, gained: 9 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 })] },
    // a next track that is in no catalogue: the chip names nothing
    { op: 'board', hostPeerIndex: 0, over: true, field: AI_FIELD,
      series: { cupId: 'random', cupName: 'Random', endless: true, raceIndex: 3, raceCount: 4, nextTrackId: 'ghost-track',
        standings: [{ playerId: 0, points: 24, gained: 6 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 })] }
  ]
});

// -- the podium's split between the steps and the list -----------------------
scenarios.push({
  name: 'podium-edges',
  screen: 'race',
  ops: [
    // a three-car cup: the steps take everyone and the list is empty
    { op: 'board', hostPeerIndex: 0, over: true,
      field: [fieldRow(0, { name: 'Ada' }), fieldRow(1, { name: 'Bo' }), fieldRow('ai-0', { name: 'Bolt', ai: true })],
      series: { cupId: 'cup-b', cupName: 'Thunder', raceIndex: 3, raceCount: 4, finished: true,
        standings: [{ playerId: 0, points: 27, gained: 9 }, { playerId: 1, points: 18, gained: 6 }, { playerId: 'ai-0', points: 9, gained: 3 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 }), res('ai-0', 3, { time: 62 })] },
    // a two-car podium
    { op: 'board', hostPeerIndex: 0, over: true, field: [fieldRow(0, { name: 'Ada' }), fieldRow(1, { name: 'Bo' })],
      series: { cupId: 'cup-b', cupName: 'Thunder', raceIndex: 3, raceCount: 4, finished: true,
        standings: [{ playerId: 0, points: 27, gained: 9 }, { playerId: 1, points: 18, gained: 6 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 })] },
    // a podium with NOBODY on it
    { op: 'board', hostPeerIndex: 0, over: true, field: [],
      series: { cupId: 'cup-b', cupName: 'Thunder', raceIndex: 3, raceCount: 4, finished: true, standings: [] },
      results: [] },
    // the frozen quirk: a joining row inside the first three shortens the STEPS
    // without shifting where the list starts. Recorded on purpose — a shell that
    // "fixes" it drops a racer off both.
    { op: 'board', hostPeerIndex: 0, over: true, field: [fieldRow(0, { name: 'Ada' }), fieldRow(1, { name: 'Bo' })],
      series: { cupId: 'cup-b', cupName: 'Thunder', raceIndex: 3, raceCount: 4, finished: true,
        standings: [{ playerId: 0, points: 27, gained: 9 }, { playerId: 1, points: 18, gained: 6 }] },
      results: [res(0, 1, { time: 60 }), res(1, 2, { time: 61 })],
      lateJoiners: [{ peerIndex: 5, name: 'Ed', colorIndex: 1 }] },
    // a big field: six racers, three on the steps, three in the list
    { op: 'board', hostPeerIndex: 0, over: true,
      field: [0, 1, 2, 3, 4, 5].map((i) => fieldRow(i, { name: `P${i}`, colorIndex: i, ai: i > 3 })),
      series: { cupId: 'cup-a', cupName: 'Sunrise', raceIndex: 3, raceCount: 4, finished: true,
        standings: [0, 1, 2, 3, 4, 5].map((i) => ({ playerId: i, points: 30 - i * 4, gained: 9 - i })) },
      results: [0, 1, 2, 3, 4, 5].map((i) => res(i, i + 1, { time: 60 + i })) }
  ]
});

// -- a race that empties out: forfeit, auto-pause, then the lobby ------------
scenarios.push({
  name: 'race-abandoned-arc',
  screen: 'race',
  ops: [
    { op: 'show', to: 'lobby' },
    { op: 'roster', roster: [seat(0), seat(1, { ready: true })], host: 0 },
    { op: 'show', to: 'race' },
    { op: 'autopause', hasSession: true, roomState: 'countdown', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: [0, 1] },
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: [0, 1] },
    // one phone blips: its seat is held, its card goes up
    { op: 'reconnect', seats: [{ peerIndex: 1, name: 'Bo', colorIndex: 1 }] },
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: [0, 1], allDisconnected: false },
    // the other goes too → the silent freeze
    { op: 'reconnect', seats: [{ peerIndex: 0, name: 'Ada', colorIndex: 0 }, { peerIndex: 1, name: 'Bo', colorIndex: 1 }] },
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: [0, 1], allDisconnected: true },
    { op: 'freeze', hasSession: true, roomState: 'playing', paused: false, autoPaused: true, sessionPaused: false },
    // the last human car finishes as a ghost, so it is forfeited
    { op: 'flow', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], disconnectedIds: [0, 1], finishedIds: [] },
    // ... and with both seats expired there is nothing left to wait for
    { op: 'autopause', hasSession: true, roomState: 'playing', carIds: [0, 1, 'ai-0', 'ai-1'], aiIds: ['ai-0', 'ai-1'], seatedIds: [], allDisconnected: true },
    { op: 'reconnect', seats: [] },
    { op: 'show', to: 'lobby' },
    { op: 'roster', roster: [], host: null },
    { op: 'back' }
  ]
});

// ---------------------------------------------------------------------------
// Seeded random sweeps. They exist to reach the shapes nobody thought to author:
// ids that collide across kinds, fields that name nobody in the results, cup
// tables missing half the grid, negative and fractional car indices.
// ---------------------------------------------------------------------------
const OPS = ['roster', 'pick', 'hud', 'flow', 'autopause', 'freeze', 'board',
  'reconnect', 'intermission', 'show', 'back', 'clearItems', 'welcomeItem'];
const ROOM_STATES = ['lobby', 'countdown', 'playing', 'results'];
const ITEMS = [null, 'boost', 'banana', 'rocket', 'monster', ''];
const IDS = [0, 1, 2, 3, 'ai-0', 'ai-1'];

function randomScenario(seedN) {
  const rand = mulberry32(0x0F17CAFE ^ (seedN * 2654435761));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const some = (arr) => arr.filter(() => rand() < 0.5);
  const ops = [];
  const n = 40 + Math.floor(rand() * 30);
  for (let i = 0; i < n; i++) {
    const op = pick(OPS);
    switch (op) {
      case 'roster': {
        const roster = [];
        for (let k = 0; k < Math.floor(rand() * 6); k++) {
          roster.push(seat(k, {
            name: rand() < 0.15 ? '' : `P${k}`,
            colorIndex: Math.floor(rand() * 8),
            carIndex: rand() < 0.2 ? null : Math.floor(rand() * 9) - 1,
            connected: rand() > 0.25,
            ready: rand() < 0.5
          }));
        }
        ops.push({ op, roster, host: rand() < 0.2 ? null : Math.floor(rand() * 6) });
        break;
      }
      case 'pick':
        ops.push({ op,
          mode: pick(['cup', 'track', 'random', null, 'bogus']),
          cupId: pick(['cup-a', 'cup-b', 'cup-empty', 'nope', null]),
          trackId: pick(['a1', 'b4', 'solo', 'ghost', null]) });
        break;
      case 'hud': {
        const cars = some(IDS).map((id) => hudCar(id, {
          position: 1 + Math.floor(rand() * 8),
          lap: 1 + Math.floor(rand() * 3),
          item: pick(ITEMS),
          finished: rand() < 0.3,
          finishTime: rand() < 0.5 ? null : Math.round(rand() * 900) / 10
        }));
        ops.push({ op, cars, aiIds: some(IDS) });
        break;
      }
      case 'flow':
        ops.push({ op, carIds: some(IDS), aiIds: some(IDS), disconnectedIds: some(IDS), finishedIds: some(IDS) });
        break;
      case 'autopause':
        ops.push({ op, hasSession: rand() < 0.85, raceEnded: rand() < 0.2, roomState: pick(ROOM_STATES),
          carIds: some(IDS), aiIds: some(IDS), seatedIds: some(IDS), allDisconnected: rand() < 0.5 });
        break;
      case 'freeze':
        ops.push({ op, hasSession: rand() < 0.85, roomState: pick(ROOM_STATES),
          paused: rand() < 0.5, autoPaused: rand() < 0.5, sessionPaused: rand() < 0.5 });
        break;
      case 'board': {
        const ids = some(IDS);
        const results = ids.map((id, k) => res(id, k + 1, {
          finished: rand() < 0.8, time: rand() < 0.2 ? null : Math.round(rand() * 900) / 10
        }));
        const withCup = rand() < 0.6;
        ops.push({ op,
          hostPeerIndex: rand() < 0.2 ? null : Math.floor(rand() * 4),
          over: rand() < 0.5,
          field: some(IDS).map((id) => fieldRow(id, { name: `N${id}`, colorIndex: Math.floor(rand() * 8), ai: rand() < 0.4 })),
          results,
          series: withCup ? {
            cupId: pick(['cup-a', 'cup-b', 'random']),
            cupName: pick(['Sunrise', 'Thunder', 'Random']),
            endless: rand() < 0.3,
            raceIndex: Math.floor(rand() * 4),
            raceCount: 4,
            finished: rand() < 0.35,
            nextTrackId: pick(['a2', 'b3', 'ghost', null]),
            // deliberately partial: not every racer is in the cup table
            standings: some(IDS).map((id) => ({ playerId: id, points: Math.floor(rand() * 30), gained: Math.floor(rand() * 10) }))
          } : null,
          lateJoiners: some([4, 5, 6]).map((p) => ({ peerIndex: p, name: `L${p}`, colorIndex: p })) });
        break;
      }
      case 'reconnect':
        ops.push({ op, seats: some(IDS.slice(0, 4)).map((p) => ({ peerIndex: p, name: `R${p}`, colorIndex: 1 })),
          land: rand() < 0.3 ? [] : undefined });
        break;
      case 'intermission':
        ops.push({ op, deadlineMs: Math.floor(rand() * 20000), nowMs: Math.floor(rand() * 20000) });
        break;
      case 'show':
        ops.push({ op, to: pick(['welcome', 'lobby', 'race', 'ghost']) });
        break;
      case 'welcomeItem':
        ops.push({ op, car: rand() < 0.2 ? null : hudCar(pick(IDS), { item: pick(ITEMS), finished: rand() < 0.5 }) });
        break;
      default:
        ops.push({ op });
        break;
    }
  }
  return { name: `random-${seedN}`, screen: pick(['welcome', 'lobby', 'race', null]), ops };
}

// ---------------------------------------------------------------------------
export function buildCorpus() {
  const scripts = [...scenarios];
  for (let i = 1; i <= 24; i++) scripts.push(randomScenario(i));

  const lines = [];
  let steps = 0;
  for (const scn of scripts) {
    lines.push(canonicalStringify({ case: 'scenario', name: scn.name, screen: scn.screen === undefined ? null : scn.screen, steps: scn.ops.length }));
    for (const [index, step] of runScenario(scn).entries()) {
      lines.push(canonicalStringify({ case: 'step', name: scn.name, step: index, op: step.op, in: step.in, out: step.out, state: step.state }));
      steps++;
    }
  }

  const header = canonicalStringify({
    kind: 'ui',
    version: 1,
    scenarios: scripts.length,
    steps,
    maxPlayers: MAX_PLAYERS,
    carCount: CAR_COUNT,
    intermissionMs: INTERMISSION_MS,
    cups: CUPS.length,
    catalog: CATALOG.length
  });
  return { text: [header, ...lines].join('\n') + '\n', scenarios: scripts.length, steps };
}

// The scenario table, so tests/ui-corpus.test.js can replay a committed line
// through the same driver it was recorded with.
export { CUPS, CATALOG, MAX_PLAYERS, CAR_COUNT, INTERMISSION_MS };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { text, scenarios: nScn, steps } = buildCorpus();
  if (process.argv.includes('--stdout')) { process.stdout.write(text); process.exit(0); }
  if (process.argv.includes('--check')) {
    const have = fs.readFileSync(OUT, 'utf8');
    if (have !== text) {
      console.error(`${OUT}: re-derived corpus differs from the committed one`);
      process.exit(1);
    }
    console.log(`${OUT}: reproduced byte-identically (${nScn} scenarios, ${steps} steps)`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${steps} steps over ${nScn} scenarios`);
}
