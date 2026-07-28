// Generates tests/fixtures/session-corpus.jsonl — the oracle for the display's
// SESSION MODEL (public/display/sessionModel.js).
//
// WHY IT EXISTS, AND WHY NOW. The session policy in public/display/Net.js is
// being moved into C++ (native/libttp-party/ttp/session.h). Almost none of it
// had an oracle: the room snapshot was covered only by wire-compat's live
// assertions, the SET_CAR / SET_READY / LEAVE guards had their ACCEPT paths
// covered and every REJECT path uncovered, and three units — the claim URL, the
// rejoinToken normalizer and the cross-device seat claim — had no coverage
// anywhere in the tree. Porting those on faith is exactly what
// tests/fixtures/traces/README.md's two-classes-of-fixture rule forbids: a
// C++-authored fixture proves C++ agrees with C++.
//
// So this records the JS answers FIRST, while the JS that produces them exists.
// The ratchet is one-way — gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs
// can no longer run at all — and once sessionModel.js goes, this oracle can
// never be re-derived.
//
// EVERY INPUT IS COMMITTED, AND THERE IS EXACTLY ONE. The generator reads
// public/display/sessionModel.js and nothing else: no wasm, no relay, no track
// catalogue, no DOM. The scenarios carry their own synthetic rooms, exactly as
// gen-ui-corpus.mjs carries a synthetic catalogue, so a new track or a new car
// is never a corpus re-record.
//
// SHAPE (following gen-ui-corpus.mjs, the established pattern):
//   line 1   header
//   then     {case:'scenario', name}                — starts a scenario
//            {case:'step', name, step, op, in, out, state}
// `in` is the FULLY RESOLVED input including anything the driver threads, so
// every step replays standalone; `state` is the threaded state after the step,
// so a port that answers right but threads wrong is still caught.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-session-corpus.mjs [--check | --stdout]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify, mulberry32 } from './oracle-lib.mjs';
import * as sm from '../public/display/sessionModel.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/session-corpus.jsonl');

// ---------------------------------------------------------------------------
// The synthetic world. Four room states, a small roster vocabulary, and a
// chooser payload that is deliberately NOT the shipped one — the model never
// looks inside it (it is opaque passthrough), so binding the oracle to
// shared/tracks.js would hand the fixture a way to rot.
// ---------------------------------------------------------------------------
const STATES = ['lobby', 'countdown', 'playing', 'results'];
const CHOOSER = {
  cars: [{ id: 'car-a', name: 'Ay', stats: { accel: 1, vmax: 1, turn: 1, mass: 1 } },
         { id: 'car-b', name: 'Bee', stats: { accel: 1.5, vmax: 0.5, turn: 2, mass: 0.25 } }],
  colors: ['#111111', '#222222', '#333333'],
  tracks: [{ id: 't1', name: 'One', cup: 'c1', cupName: 'Cup One', cupDifficulty: 2, svg: 'AAECAw==' },
           { id: 't2', name: 'Two', cup: null, cupName: null, cupDifficulty: null, svg: 'BAUGBw==' }]
};
const seat = (peerIndex, over) => ({
  peerIndex, name: 'P' + peerIndex, colorIndex: peerIndex - 1, carIndex: peerIndex - 1,
  connected: true, ready: false, ...over
});

// ---------------------------------------------------------------------------
// The driver. The one piece of state a scenario threads is the display's own
// heartbeat (in flight? sent when?) — exactly what Net.js keeps beside the
// model. Exported so tests/session-corpus.test.js replays committed steps
// through the same driver they were recorded with.
// ---------------------------------------------------------------------------
export function newShellState() {
  return { hbPending: false, hbSentAt: 0 };
}
export function shellState(st) {
  return { hbPending: st.hbPending, hbSentAt: st.hbSentAt };
}

// The RESOLVED input for a step: the op's own fields, plus whatever the driver
// threads into it. Recorded verbatim so a replay needs nothing but the line.
export function resolveInput(st, op) {
  const { op: _name, ...rest } = op;
  if (op.op === 'hb') return { inRoom: !!rest.inRoom, hbPending: st.hbPending, hbSentAt: st.hbSentAt, now: rest.now };
  return rest;
}

export function applyOp(st, input, opName) {
  switch (opName) {
    // ---- the retained room snapshot ---------------------------------------
    case 'roster':
      return { rows: sm.rosterRows(input.roster, input.inRace) };
    case 'snapshot':
      return { snapshot: sm.lobbySnapshot(input) };

    // ---- URLs --------------------------------------------------------------
    case 'joinUrl':
      return { url: sm.joinUrl(input.base, input.room, input.instance) };
    case 'claimUrl':
      return { url: sm.claimUrl(input.url, input.peerIndex) };
    case 'template':
      return { template: sm.controllerUrlTemplate(input.base) };
    case 'normIndex':
      return { index: sm.normIndex(input.absent ? undefined : input.value) };

    // ---- seats -------------------------------------------------------------
    case 'seat':
      return { defaults: sm.seatDefaults(input.colorIndex) };
    case 'addPeer':
      return { plan: sm.addPeerPlan(input) };
    case 'presence':
      return { action: sm.presenceAction(input.roomState) };
    case 'leave':
      return { action: sm.leaveAction(input.roomState) };
    case 'card':
      return { card: sm.reconnectCard(input.seat, input.url) };

    // ---- controller messages ----------------------------------------------
    case 'route':
      return { route: sm.inboundRoute(input.from, input.type) };
    case 'action':
      return { action: sm.messageAction(input.type) };
    case 'setCar':
      return { accept: sm.setCarDecision(input) };
    case 'setReady':
      return { accept: sm.setReadyDecision(input) };

    // ---- room-state transitions -------------------------------------------
    case 'stateChange':
      return { plan: sm.stateChangePlan(input.to) };
    case 'hostChange':
      return { plan: sm.hostChangePlan() };

    // ---- liveness ----------------------------------------------------------
    case 'hb': {
      const out = sm.heartbeatTick(input);
      st.hbPending = out.hbPending;
      st.hbSentAt = out.hbSentAt;
      return { tick: out };
    }

    // ---- claims + reconciliation ------------------------------------------
    case 'claim':
      return { plan: sm.claimPlan({ ...input, rejoinToken: input.absent ? undefined : input.rejoinToken }) };
    case 'resync':
      return { plan: sm.resyncPlan(input.rosterIds, input.relayPeers) };

    default:
      throw new Error('unknown op ' + opName);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const scenarios = [];
const scenario = (name, ops) => scenarios.push({ name, ops });

// --- the snapshot, through a whole party arc -------------------------------
// The room's single outbound message, walked through every phase. The tracks
// payload is LOBBY-ONLY (it is the bulk, and the picker is only shown there),
// which is the rule most likely to be lost in a port because nothing about the
// other eleven keys hints at it.
scenario('snapshot-arc', [
  { op: 'snapshot', roomState: 'lobby', hostPeerIndex: 1, paused: false, roster: [], inRace: [], mode: null, cupId: null, trackId: null, standings: null, chooser: CHOOSER },
  { op: 'snapshot', roomState: 'lobby', hostPeerIndex: 1, paused: false, roster: [seat(1)], inRace: [false], mode: 'track', cupId: null, trackId: 't1', standings: null, chooser: CHOOSER },
  { op: 'snapshot', roomState: 'lobby', hostPeerIndex: 1, paused: false, roster: [seat(1, { ready: true }), seat(2)], inRace: [false, false], mode: 'cup', cupId: 'c1', trackId: 't1', standings: null, chooser: CHOOSER },
  { op: 'snapshot', roomState: 'countdown', hostPeerIndex: 1, paused: false, roster: [seat(1), seat(2)], inRace: [true, true], mode: 'cup', cupId: 'c1', trackId: 't1', standings: null, chooser: CHOOSER },
  { op: 'snapshot', roomState: 'playing', hostPeerIndex: 1, paused: true, roster: [seat(1), seat(2, { connected: false })], inRace: [true, true], mode: 'cup', cupId: 'c1', trackId: 't1', standings: { over: false, order: [] }, chooser: CHOOSER },
  { op: 'snapshot', roomState: 'results', hostPeerIndex: 2, paused: false, roster: [seat(1), seat(2)], inRace: [true, true], mode: 'cup', cupId: 'c1', trackId: 't2', standings: { over: true, order: [{ playerId: 1 }] }, chooser: CHOOSER },
  // Back to the lobby: the chooser's tracks return, the board is gone.
  { op: 'snapshot', roomState: 'lobby', hostPeerIndex: 2, paused: false, roster: [seat(1), seat(2)], inRace: [false, false], mode: 'random', cupId: null, trackId: 't2', standings: null, chooser: CHOOSER },
  // A room state no side names — the tracks gate is an equality test, not a
  // "not playing" test, so an unknown phase ships no tracks.
  { op: 'snapshot', roomState: 'intermission', hostPeerIndex: 2, paused: false, roster: [seat(1)], inRace: [true], mode: 'random', cupId: null, trackId: 't2', standings: null, chooser: CHOOSER },
  // No chooser configured at all: the three keys must still be PRESENT (the
  // phone reads them by name) and undefined-as-JSON, not absent-with-meaning.
  { op: 'snapshot', roomState: 'lobby', hostPeerIndex: null, paused: false, roster: [seat(1)], inRace: [false], mode: null, cupId: null, trackId: null, standings: null, chooser: null }
]);

// --- the players projection -------------------------------------------------
scenario('roster-rows', [
  { op: 'roster', roster: [], inRace: [] },
  { op: 'roster', roster: [seat(1)], inRace: [true] },
  { op: 'roster', roster: [seat(1), seat(2, { connected: false, ready: true })], inRace: [true, false] },
  // A car-less seat mid-race is a late joiner; a held, dropped seat still
  // holds its car. Both shapes ride the same row.
  { op: 'roster', roster: [seat(3, { connected: false }), seat(4)], inRace: [true, false] },
  // carIndex null (never picked) must survive as null, not as 0.
  { op: 'roster', roster: [seat(1, { carIndex: null })], inRace: [false] },
  // `ready` is coerced (the kit stores whatever the shell wrote) and `inRace`
  // is coerced from the game layer's answer.
  { op: 'roster', roster: [seat(1, { ready: 1 }), seat(2, { ready: undefined })], inRace: [1, 0] },
  // A short inRace array: a seat the game layer answered nothing for is false.
  { op: 'roster', roster: [seat(1), seat(2)], inRace: [true] },
  { op: 'roster', roster: [seat(1), seat(2)], inRace: null }
]);

// --- URLs -------------------------------------------------------------------
// The claim URL's fragment-preserving splice is the reason this scenario
// exists: get the order wrong and the reconnect QR lands on a relay shard that
// has never heard of the room.
scenario('urls', [
  { op: 'joinUrl', base: 'https://tinytrack.party', room: 'BZK4', instance: null },
  { op: 'joinUrl', base: 'https://tinytrack.party', room: 'BZK4', instance: 'eu-1' },
  { op: 'joinUrl', base: 'http://localhost:3000', room: 'BZK4', instance: 'a b/c?d#e' },
  { op: 'joinUrl', base: 'https://x.test', room: 'BZK4', instance: '' },
  { op: 'claimUrl', url: 'https://tinytrack.party/BZK4', peerIndex: 2 },
  { op: 'claimUrl', url: 'https://tinytrack.party/BZK4#eu-1', peerIndex: 2 },
  { op: 'claimUrl', url: 'https://tinytrack.party/BZK4?x=1#eu-1', peerIndex: 3 },
  { op: 'claimUrl', url: 'https://tinytrack.party/BZK4#a?b', peerIndex: 1 },
  { op: 'claimUrl', url: 'https://tinytrack.party/BZK4', peerIndex: 0 },
  { op: 'template', base: 'https://tinytrack.party' },
  { op: 'template', base: 'https://tinytrack.party/' },
  { op: 'template', base: 'https://tinytrack.party///' },
  { op: 'template', base: 'http://localhost:3000' },
  { op: 'template', base: 'https://tinytrack.party/sub' },
  { op: 'template', base: 'HTTPS://tinytrack.party' },
  { op: 'template', base: '' }
]);

// --- normIndex, the frozen quirk -------------------------------------------
// `Number(value)` is the rule, so null becomes seat 0 and every ordinary HELLO
// is a claim on the display's own slot. Recorded across every JSON type the
// wire can carry, because a port that reproduces this loosely changes who can
// take over a seat.
const NORM_VALUES = [
  null, true, false, 0, 1, 2, -1, 0.5, 3.0, 1e21,
  '', ' ', '  ', '3', '3.0', ' 42 ', '-1', '+5', '.5', '5.', '1e2', '1e-2',
  '0x10', '0b11', '0o17', 'Infinity', '-Infinity', 'abc', '1_0', '\n7\t',
  [], [7], [1, 2], [null], [[]], [{}], {}, { a: 1 }
];
scenario('norm-index', [
  { op: 'normIndex', absent: true, value: null },
  ...NORM_VALUES.map((value) => ({ op: 'normIndex', absent: false, value }))
]);

// --- seats ------------------------------------------------------------------
scenario('seats', [
  { op: 'seat', colorIndex: 0 },
  { op: 'seat', colorIndex: 3 },
  { op: 'seat', colorIndex: -1 },      // lowestFreeSlot's "no slot" answer, faithfully
  { op: 'addPeer', has: false, size: 0, maxPlayers: 4, colorIndex: 0 },
  { op: 'addPeer', has: false, size: 3, maxPlayers: 4, colorIndex: 2 },
  { op: 'addPeer', has: false, size: 4, maxPlayers: 4, colorIndex: 0 },   // full room: no seat, NO stamp
  { op: 'addPeer', has: false, size: 9, maxPlayers: 4, colorIndex: 0 },
  { op: 'addPeer', has: true, size: 2, maxPlayers: 4, colorIndex: 1 },    // same-device reconnect: stamp only
  { op: 'addPeer', has: true, size: 4, maxPlayers: 4, colorIndex: 1 },    // ...even in a full room
  ...STATES.map((roomState) => ({ op: 'presence', roomState })),
  { op: 'presence', roomState: 'intermission' },
  ...STATES.map((roomState) => ({ op: 'leave', roomState })),
  { op: 'leave', roomState: 'intermission' },
  { op: 'card', seat: seat(2), url: 'https://tinytrack.party/BZK4?claim=2#eu-1' },
  { op: 'card', seat: seat(1, { name: 'Zoë 🏁' }), url: 'https://x.test/AB12?claim=1' }
]);

// --- controller message routing --------------------------------------------
scenario('routing', [
  { op: 'route', from: 0, type: '_heartbeat' },
  { op: 'route', from: 0, type: 'hello' },
  { op: 'route', from: 0, type: 'control' },
  { op: 'route', from: 1, type: '_heartbeat' },   // a PEER forging the type is still a peer
  { op: 'route', from: 1, type: 'hello' },
  { op: 'route', from: 2, type: 'ping' },
  ...['hello', 'leave', 'set_car', 'set_ready', 'select_mode', 'ping', 'start_game',
      'return_to_lobby', 'pause_game', 'resume_game', 'series_next', 'control',
      'lobby_update', 'pong', '', 'nonsense'].map((type) => ({ op: 'action', type }))
]);

// --- the guards nothing covered --------------------------------------------
// Every REJECT branch of SET_CAR and SET_READY. wire-compat covers the accepted
// paths only, so before this fixture existed a port could have dropped any of
// these guards and stayed green.
const CAR_CASES = [];
for (const ready of [false, true]) {
  for (const roomState of STATES) {
    for (const inRace of [false, true]) {
      CAR_CASES.push({ op: 'setCar', ready, roomState, inRace, carIndex: 1, carCount: 4 });
    }
  }
}
scenario('set-car', [
  ...CAR_CASES,
  // index validation, on untrusted input
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 0, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 3, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 4, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: -1, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 1.5, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: '1', carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: null, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: true, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 1e21, carCount: 4 },
  { op: 'setCar', ready: false, roomState: 'lobby', inRace: false, carIndex: 0, carCount: 0 }
]);

const READY_CASES = [];
for (const isHost of [false, true]) {
  for (const roomState of STATES) {
    for (const ready of [false, true]) {
      for (const current of [false, true]) {
        READY_CASES.push({ op: 'setReady', isHost, roomState, ready, current });
      }
    }
  }
}
scenario('set-ready', [
  ...READY_CASES,
  // the coercion on both sides of the change-only guard
  { op: 'setReady', isHost: false, roomState: 'lobby', ready: 1, current: false },
  { op: 'setReady', isHost: false, roomState: 'lobby', ready: 1, current: true },
  { op: 'setReady', isHost: false, roomState: 'lobby', ready: null, current: true },
  { op: 'setReady', isHost: false, roomState: 'lobby', ready: 'yes', current: false }
]);

// --- phase transitions ------------------------------------------------------
scenario('transitions', [
  ...STATES.map((to) => ({ op: 'stateChange', to })),
  { op: 'stateChange', to: 'intermission' },
  { op: 'hostChange' }
]);

// --- the liveness tick ------------------------------------------------------
// The heartbeat is an IN-FLIGHT FLAG, not an echo age, so a tab that was
// throttled for ten minutes sends one and waits rather than force-reconnecting
// a healthy socket. Every arm, in sequence, threading the state.
scenario('heartbeat', [
  { op: 'hb', inRoom: false, now: 1000 },        // not in a room: nothing at all
  { op: 'hb', inRoom: true, now: 1000 },         // send
  { op: 'hb', inRoom: true, now: 2000 },         // in flight, inside the window
  { op: 'hb', inRoom: true, now: 7000 },         // exactly at the window: NOT overdue
  { op: 'hb', inRoom: true, now: 7001 },         // one ms past: reconnect, and STOP
  { op: 'hb', inRoom: true, now: 7002 },         // the flag cleared, so we send again
  { op: 'hb', inRoom: true, now: 7003 },
  { op: 'hb', inRoom: false, now: 999999 },      // a dead room does not clear the flag
  { op: 'hb', inRoom: true, now: 999999 }        // ...and the throttled tab is overdue
]);
scenario('heartbeat-throttled', [
  { op: 'hb', inRoom: true, now: 0 },
  { op: 'hb', inRoom: true, now: 600000 },       // ten minutes later: overdue, reconnect
  { op: 'hb', inRoom: true, now: 600001 },       // send
  { op: 'hb', inRoom: true, now: 600001 }        // same instant twice: still in flight
]);

// --- claims + reconciliation -----------------------------------------------
scenario('claims', [
  // The ordinary HELLO. Its token is ABSENT (undefined), so no claim.
  { op: 'claim', fromId: 3, absent: true, rejoinToken: null, hasOld: false, oldDisconnected: false },
  // An explicit null claims seat 0 — the quirk — and misses because the
  // display's own slot is never on the roster.
  { op: 'claim', fromId: 3, absent: false, rejoinToken: null, hasOld: false, oldDisconnected: false },
  // ...and if something ever DID seat 0, this is what would happen. Recorded so
  // the consequence is written down rather than reasoned about.
  { op: 'claim', fromId: 3, absent: false, rejoinToken: null, hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 1, hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 1, hasOld: true, oldDisconnected: false },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 1, hasOld: false, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 3, hasOld: true, oldDisconnected: true },   // same device
  { op: 'claim', fromId: 3, absent: false, rejoinToken: '2', hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: -1, hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 2.5, hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 3, absent: false, rejoinToken: 'abc', hasOld: true, oldDisconnected: true },
  { op: 'claim', fromId: 0, absent: false, rejoinToken: null, hasOld: true, oldDisconnected: true }
]);
scenario('resync', [
  { op: 'resync', rosterIds: [], relayPeers: [] },
  { op: 'resync', rosterIds: [], relayPeers: [0] },
  { op: 'resync', rosterIds: [], relayPeers: [0, 1, 2] },
  { op: 'resync', rosterIds: [1, 2], relayPeers: [0, 1, 2] },
  { op: 'resync', rosterIds: [1, 2, 3], relayPeers: [0, 2] },
  { op: 'resync', rosterIds: [1, 2], relayPeers: [0, 3, 4] },
  { op: 'resync', rosterIds: [5], relayPeers: [0, 1, 1, 5, 5] },   // the relay repeating itself
  { op: 'resync', rosterIds: [1, 2], relayPeers: [] }
]);

// --- seeded random sweeps ---------------------------------------------------
// The hand-written scenarios above cover the documented behaviours; these cover
// the combinations nobody thought to write, including invalid input, because
// the recorded behaviour IS the contract, error paths included.
{
  const rnd = mulberry32(20260728);
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
  const ops = [];
  for (let i = 0; i < 140; i++) {
    switch (i % 7) {
      case 0: {
        const n = Math.floor(rnd() * 5);
        const roster = [];
        const inRace = [];
        for (let k = 0; k < n; k++) {
          roster.push(seat(k + 1, {
            connected: rnd() > 0.3,
            ready: rnd() > 0.6,
            carIndex: rnd() > 0.2 ? Math.floor(rnd() * 4) : null
          }));
          inRace.push(rnd() > 0.5);
        }
        ops.push({
          op: 'snapshot', roomState: pick(STATES.concat(['intermission'])),
          hostPeerIndex: n ? Math.floor(rnd() * n) + 1 : null,
          paused: rnd() > 0.7, roster, inRace,
          mode: pick([null, 'track', 'cup', 'random']),
          cupId: pick([null, 'c1', 'c2']), trackId: pick([null, 't1', 't2']),
          standings: rnd() > 0.6 ? { over: rnd() > 0.5, order: [] } : null,
          chooser: rnd() > 0.2 ? CHOOSER : null
        });
        break;
      }
      case 1:
        ops.push({ op: 'setCar', ready: rnd() > 0.5, roomState: pick(STATES), inRace: rnd() > 0.5,
          carIndex: pick([0, 1, 2, 3, 4, -1, 1.5, null, '2', true]), carCount: pick([0, 1, 4, 8]) });
        break;
      case 2:
        ops.push({ op: 'setReady', isHost: rnd() > 0.5, roomState: pick(STATES),
          ready: pick([true, false, 1, 0, null, 'x']), current: pick([true, false, undefined]) });
        break;
      case 3:
        ops.push({ op: 'hb', inRoom: rnd() > 0.25, now: Math.floor(rnd() * 20000) });
        break;
      case 4: {
        const rosterIds = [];
        for (let k = 1; k <= 6; k++) if (rnd() > 0.5) rosterIds.push(k);
        const relayPeers = [];
        for (let k = 0; k <= 6; k++) if (rnd() > 0.5) relayPeers.push(k);
        ops.push({ op: 'resync', rosterIds, relayPeers });
        break;
      }
      case 5:
        ops.push({ op: 'claim', fromId: Math.floor(rnd() * 5),
          absent: rnd() > 0.8, rejoinToken: pick(NORM_VALUES),
          hasOld: rnd() > 0.4, oldDisconnected: rnd() > 0.4 });
        break;
      default:
        ops.push({ op: 'claimUrl',
          url: pick(['https://a.test/R1', 'https://a.test/R1#f', 'https://a.test/R1?q=1',
                     'https://a.test/R1?q=1#f', 'https://a.test/R1#?', 'R1']),
          peerIndex: Math.floor(rnd() * 6) });
    }
  }
  scenario('sweep', ops);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
export function buildCorpus() {
  const lines = [];
  let steps = 0;
  const body = [];
  for (const scn of scenarios) {
    body.push(canonicalStringify({ case: 'scenario', name: scn.name }));
    const st = newShellState();
    let n = 0;
    for (const op of scn.ops) {
      const input = resolveInput(st, op);
      const out = applyOp(st, input, op.op);
      body.push(canonicalStringify({
        case: 'step', name: scn.name, step: n++, op: op.op,
        in: input, out, state: shellState(st)
      }));
      steps++;
    }
  }
  lines.push(canonicalStringify({ kind: 'session', scenarios: scenarios.length, steps }));
  lines.push(...body);
  return { text: lines.join('\n') + '\n', steps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text, steps } = buildCorpus();
  // No process.exit after a pipe write: it is asynchronous, and exiting before
  // it drains truncates the output — which reads as a stale corpus rather than
  // as the bug it is.
  if (process.argv.includes('--stdout')) {
    process.stdout.write(text);
  } else if (process.argv.includes('--check')) {
    if (fs.readFileSync(OUT, 'utf8') !== text) {
      console.error('session-corpus.jsonl is stale');
      process.exitCode = 1;
    } else {
      console.log('session-corpus.jsonl is current');
    }
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${OUT}: ${scenarios.length} scenarios, ${steps} steps`);
  }
}
