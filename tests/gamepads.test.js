'use strict';
// Headless verification of the display's GAMEPAD mapping — the pad half of
// public/display/Gamepads.js, with the focus on the two things a mapping gets
// wrong: analog handling (a resting stick must not steer, a trigger must brake
// by how hard it is pressed) and EDGE detection (a button held across 60 frames
// is one press, not sixty items used).
//
// What is deliberately NOT asserted here: which message each press turns into is
// only half the story — whether it is ALLOWED is C++'s (set_ready_decision, the
// car-pick lock, the host + all-ready start gate), replayed by the frozen
// session corpus. So these cases pin that the pad SENDS the phone's vocabulary
// and let the gates be tested where they live.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MSG, ROOM_STATE, CAR_MODELS } = require('../public/shared/protocol.js');

// Gamepads.js reads the manifest off `window` (protocol.js is a classic script
// on the page) and destructures it at module scope, so the globals have to be up
// before the dynamic import below.
globalThis.window = { MSG, ROOM_STATE, CAR_MODELS };

let Gamepads, padSteer, padBrake;
test.before(async () => {
  ({ Gamepads, padSteer, padBrake } = await import('../public/display/Gamepads.js'));
});

// ---- a pad, as the Gamepad API reports one ---------------------------------
// `down` is a list of button indices (or [index, value] pairs for the analog
// triggers); axes default to centred.
function pad(index, down = [], axes = []) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: false, value: 0 });
  for (const d of down) {
    const [i, v] = Array.isArray(d) ? d : [d, 1];
    buttons[i] = { pressed: v > 0.5, value: v };
  }
  return { index, connected: true, mapping: 'standard', buttons, axes };
}

const BTN = { A: 0, B: 1, X: 2, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, DL: 14, DR: 15 };

// ---- steering ---------------------------------------------------------------

test('a resting stick does not steer', () => {
  assert.equal(padSteer(pad(0, [], [0.05, 0, -0.1, 0])), 0);
});

test('past the deadzone the stick rescales to a full lock', () => {
  // Deadzone 0.18: a stick at 1 must reach exactly 1, not 0.82 — a pad that
  // could never reach full lock understeers everywhere.
  assert.equal(padSteer(pad(0, [], [1, 0])), 1);
  assert.equal(padSteer(pad(0, [], [-1, 0])), -1);
  // ...and the first movement past the zone starts from 0, not from 0.18.
  assert.ok(padSteer(pad(0, [], [0.19, 0])) < 0.02);
});

test('the right stick steers too', () => {
  assert.ok(padSteer(pad(0, [], [0, 0, 1, 0])) === 1);
});

test('the d-pad is a full lock and beats a stick pushed the other way', () => {
  assert.equal(padSteer(pad(0, [BTN.DL])), -1);
  assert.equal(padSteer(pad(0, [BTN.DR])), 1);
  assert.equal(padSteer(pad(0, [BTN.DL], [1, 0])), -1);
});

// ---- braking ----------------------------------------------------------------

test('an analog trigger brakes by pressure, a button brakes fully', () => {
  assert.equal(padBrake(pad(0, [[BTN.LT, 0.4]])), 0.4);
  assert.equal(padBrake(pad(0, [BTN.B])), 1);
  assert.equal(padBrake(pad(0)), 0);
});

test('the hardest-pressed brake button wins', () => {
  assert.equal(padBrake(pad(0, [[BTN.LT, 0.3], [BTN.LB, 0.9]])), 0.9);
});

// ---- the seat + the button contexts -----------------------------------------

// A DisplayNet stand-in that records what the pad module asked of it. `seats` is
// the roster the room would answer with.
function fakeNet(state = ROOM_STATE.LOBBY) {
  const sent = [];
  const seats = [];
  return {
    sent, seats,
    roomState: state,
    pick: { mode: null, cupId: null },
    flow: {
      on() {},
      has: (id) => seats.some((s) => s.peerIndex === id),
      list: () => seats
    },
    localMessage: (id, msg) => sent.push({ id, ...msg }),
    noteSeen() {}
  };
}

// Drive one poll with a given pad list.
function withPads(list, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => list }, configurable: true, writable: true
  });
  try { return fn(); } finally {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete globalThis.navigator;
  }
}

test('a pad the browser reveals takes a seat on its first poll', () => {
  const net = fakeNet();
  const g = new Gamepads({ net });
  // The room seats whoever HELLOs, as the walk would.
  net.localMessage = (id, msg) => {
    net.sent.push({ id, ...msg });
    if (msg.type === MSG.HELLO) net.seats.push({ peerIndex: id, name: msg.name, carIndex: 0, ready: false });
  };
  withPads([pad(0)], () => g.poll(null));
  assert.deepEqual(net.sent, [{ id: 'pad-0', type: MSG.HELLO, name: 'Pad 1' }]);
  assert.equal(g.seated, 1);
});

test('a full room refuses the seat, and the pad retries on a later press', () => {
  const net = fakeNet();              // flow.has stays false: nobody was seated
  const g = new Gamepads({ net });
  const list = [pad(0)];
  withPads(list, () => g.poll(null));
  assert.equal(g.seated, 0);
  // Same frame state again inside the retry window: no second HELLO.
  withPads(list, () => g.poll(null));
  assert.equal(net.sent.length, 1);
});

test('ITEM is one bump per press, not one per frame', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  const inputs = [];
  const session = { hasCar: () => true, processInput: (id, m) => inputs.push(m.u) };
  withPads([pad(0)], () => g.poll(session));        // seats it (no drive this frame)
  withPads([pad(0, [BTN.A])], () => g.poll(session)); // press
  withPads([pad(0, [BTN.A])], () => g.poll(session)); // still held
  withPads([pad(0)], () => g.poll(session));          // released
  withPads([pad(0, [BTN.RT])], () => g.poll(session)); // a DIFFERENT item button
  assert.deepEqual(inputs, [1, 1, 1, 2]);
});

test('driving input carries steer, brake and the item counter', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  let last = null;
  const session = { hasCar: () => true, processInput: (id, m) => { last = { id, ...m }; } };
  withPads([pad(0)], () => g.poll(session));
  withPads([pad(0, [[BTN.LT, 0.5]], [1, 0])], () => g.poll(session));
  assert.deepEqual(last, { id: 'pad-0', s: 1, b: 0.5, u: 0 });
});

test('a frozen field still routes buttons but moves no car', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net, canDrive: () => false });
  let drove = false;
  const session = { hasCar: () => true, processInput: () => { drove = true; } };
  withPads([pad(0)], () => g.poll(session));
  withPads([pad(0, [BTN.START])], () => g.poll(session));
  assert.equal(drove, false);
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.PAUSE_GAME });
});

test('lobby: confirm sends both the ready toggle and the start, gates decide', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [BTN.A])], () => g.poll(null));
  assert.deepEqual(net.sent.slice(-2), [
    { id: 'pad-0', type: MSG.SET_READY, ready: true },
    { id: 'pad-0', type: MSG.START_GAME }
  ]);
});

test('lobby: the ready toggle reads the seat, so a second press un-readies', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: true });
  const g = new Gamepads({ net });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [BTN.START])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-2), { id: 'pad-0', type: MSG.SET_READY, ready: false });
});

test('lobby: the d-pad cycles the car, wrapping both ways', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [BTN.DL])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.SET_CAR, carIndex: CAR_MODELS.length - 1 });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [BTN.DR])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.SET_CAR, carIndex: 1 });
});

test('lobby: a held stick is one car step, not a scroll', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  withPads([pad(0)], () => g.poll(null));
  const held = [pad(0, [], [1, 0])];
  withPads(held, () => g.poll(null));
  withPads(held, () => g.poll(null));
  withPads(held, () => g.poll(null));
  assert.equal(net.sent.filter((m) => m.type === MSG.SET_CAR).length, 1);
});

// The pick is what gates the host's start, and it is otherwise phone-only UI —
// so these three are what stands between a pads-only party and a lobby it can
// never leave.
const PICKS = [{ mode: 'cup', cupId: 'beach' }, { mode: 'cup', cupId: 'snow' }, { mode: 'tour' }];

test('lobby: up/down cycles the pick, and starts from the top when there is none', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  net.pick = { mode: null, cupId: null };
  const g = new Gamepads({ net, picks: PICKS });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [13])], () => g.poll(null));  // d-pad down
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.SELECT_MODE, mode: 'cup', cupId: 'beach' });
});

test('lobby: the cycle resumes from the ROOM\'s pick and wraps', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  net.pick = { mode: 'tour' };                  // the last entry
  const g = new Gamepads({ net, picks: PICKS });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [13])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.SELECT_MODE, mode: 'cup', cupId: 'beach' });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [12])], () => g.poll(null)); // d-pad up, back off the tour
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.SELECT_MODE, mode: 'cup', cupId: 'snow' });
});

test('lobby: the two axes keep their own memory — a car step is not a pick step', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  net.pick = { mode: 'tour' };
  const g = new Gamepads({ net, picks: PICKS });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [], [1, 0])], () => g.poll(null));   // stick right, held
  withPads([pad(0, [], [1, 1])], () => g.poll(null));   // ...now also pushed down
  const types = net.sent.map((m) => m.type);
  assert.equal(types.filter((t) => t === MSG.SET_CAR).length, 1);
  assert.equal(types.filter((t) => t === MSG.SELECT_MODE).length, 1);
});

// ---- the pause menu ----------------------------------------------------------

// A paused race with one seated pad, plus a record of where the cursor was drawn.
function pausedRig() {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const focus = [];
  const g = new Gamepads({
    net,
    isPaused: () => true,
    pauseMenu: { items: [MSG.RESUME_GAME, MSG.RETURN_TO_LOBBY], onFocus: (i) => focus.push(i) }
  });
  withPads([pad(0)], () => g.poll(null));   // seats it
  withPads([pad(0)], () => g.poll(null));   // ...and the overlay's cursor appears
  return { net, g, focus };
}

test('pause menu: the cursor appears on the safe item and confirm takes it', () => {
  const { net, g, focus } = pausedRig();
  assert.deepEqual(focus, [0]);
  assert.equal(g.cursor, 0);
  withPads([pad(0, [BTN.A])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.RESUME_GAME });
});

test('pause menu: the cursor moves on either axis, and wraps', () => {
  const { net, g, focus } = pausedRig();
  withPads([pad(0, [BTN.DR])], () => g.poll(null));     // right
  assert.equal(g.cursor, 1);
  withPads([pad(0, [BTN.A])], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.RETURN_TO_LOBBY });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0, [13])], () => g.poll(null));         // d-pad down works too
  assert.equal(g.cursor, 0);                            // ...wrapping back round
  assert.deepEqual(focus, [0, 1, 0]);
});

test('pause menu: a held stick is one move, not a run down the row', () => {
  const { g } = pausedRig();
  const held = [pad(0, [], [1, 0])];
  withPads(held, () => g.poll(null));
  withPads(held, () => g.poll(null));
  withPads(held, () => g.poll(null));
  assert.equal(g.cursor, 1);
});

test('pause menu: cancel backs OUT, it never takes the destructive item', () => {
  // B is brake while driving, so it must not double as "quit the race" the
  // moment the overlay is up — the cursor is how you choose that, deliberately.
  for (const btn of [BTN.B, BTN.BACK, BTN.START]) {
    const { net, g } = pausedRig();
    withPads([pad(0, [btn])], () => g.poll(null));
    assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.RESUME_GAME });
    assert.equal(g.cursor, 0);
  }
});

test('pause menu: the cursor is cleared when the overlay goes away', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const focus = [];
  let paused = true;
  const g = new Gamepads({
    net,
    isPaused: () => paused,
    pauseMenu: { items: [MSG.RESUME_GAME, MSG.RETURN_TO_LOBBY], onFocus: (i) => focus.push(i) }
  });
  withPads([pad(0)], () => g.poll(null));
  withPads([pad(0)], () => g.poll(null));
  paused = false;
  withPads([pad(0)], () => g.poll({ hasCar: () => false })) ;
  assert.deepEqual(focus, [0, -1]);
});

test('pause menu: a TV with no pad on it grows no cursor', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  const focus = [];
  const g = new Gamepads({
    net,
    isPaused: () => true,
    pauseMenu: { items: [MSG.RESUME_GAME], onFocus: (i) => focus.push(i) }
  });
  withPads([], () => g.poll(null));
  withPads([], () => g.poll(null));
  assert.deepEqual(focus, []);
});

test('results: confirm advances a cup and starts a new game otherwise', () => {
  for (const [action, type] of [['advance', MSG.SERIES_NEXT], ['new-game', MSG.RETURN_TO_LOBBY]]) {
    const net = fakeNet(ROOM_STATE.RESULTS);
    net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
    const g = new Gamepads({ net, resultsAction: () => action });
    withPads([pad(0)], () => g.poll(null));
    withPads([pad(0, [BTN.START])], () => g.poll(null));
    assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type });
  }
});

test('an unplugged pad hands its seat back', () => {
  const net = fakeNet();
  net.seats.push({ peerIndex: 'pad-0', carIndex: 0, ready: false });
  const g = new Gamepads({ net });
  withPads([pad(0)], () => g.poll(null));
  assert.equal(g.seated, 1);
  withPads([], () => g.poll(null));
  assert.deepEqual(net.sent.at(-1), { id: 'pad-0', type: MSG.LEAVE });
  assert.equal(g.seated, 0);
});

test('two pads are two seats with their own ids and counters', () => {
  const net = fakeNet(ROOM_STATE.PLAYING);
  net.seats.push({ peerIndex: 'pad-0' }, { peerIndex: 'pad-1' });
  const g = new Gamepads({ net });
  const seen = [];
  const session = { hasCar: () => true, processInput: (id, m) => seen.push([id, m.u]) };
  withPads([pad(0), pad(1)], () => g.poll(session));
  withPads([pad(0, [BTN.A]), pad(1)], () => g.poll(session));
  assert.deepEqual(seen.slice(-2), [['pad-0', 1], ['pad-1', 0]]);
});
