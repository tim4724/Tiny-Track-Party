// Gamepads — pads plugged into the TV as first-class players.
//
// This is a CONTROLLER, not a game layer. It is the display-side twin of
// public/controller/ (see that directory's CLAUDE.md for why a controller stays
// JS): it reads a device, maps buttons to the protocol's vocabulary, and hands
// the result to the SAME two seams a phone's input arrives on —
//
//   discrete presses -> net.localMessage(id, msg), which runs the identical
//                       peer-message walk (ttp_net.h) a relayed message runs, so
//                       every gate stays C++'s: set_ready_decision, the car-pick
//                       lock, the host + all-ready start gate, the seat rule.
//   steering frames   -> session.processInput(id, {s,b,u}), the bots' seam and
//                       ?solo's (DebugSolo.js).
//
// So nothing here decides anything about the game. What it decides is which
// BUTTON means which message, which is device policy and belongs beside the
// device — the same line the phone's TiltInput.js sits on.
//
// A pad's seat is a normal seat: it counts against MAX_PLAYERS, it can be host,
// it holds a livery and a car, and its liveness is stamped like a phone's (a pad
// that goes flat mid-race drops its seat and offers the usual rejoin QR, which a
// phone can claim; if the pad comes back first, noteSeen lifts the seat again).
//
// A SEAT IS TAKEN BY A PRESS, not by a pad appearing — being enumerated is not
// evidence that anybody is holding it (see the join below for what that cost).
// So "every pad gets a slot automatically" means "press a button and you are
// in, with nothing else to do", and the lobby says exactly that.
//
// THE MAP, by context (the contexts are what let one button carry two meanings):
//
//   lobby     stick / d-pad left-right   change car
//             stick / d-pad up-down      change what the room races (host only)
//             A, Start                   ready up — or, as host, start
//             B, Back                    give the seat back
//   racing    stick left-right, d-pad    steer
//             B, LB, LT                  brake (analog off a trigger)
//             A, X, RB, RT               use item
//             Start                      pause
//   paused    stick / d-pad              move the cursor over the overlay's
//                                        buttons
//             A                          take the highlighted one
//             Start, B, Back             back out (continue)
//   results   A, Start                   next race / new game
//                                        B, Back   new game

// The wire spellings and the room phases come from the manifest, never a second
// copy (shared/protocol.js is a classic script the page loads before any
// module). The guard is for the Node suite, which imports this file headlessly
// to exercise the pure mapping helpers below.
const { MSG = {}, ROOM_STATE = {} } = (typeof window !== 'undefined' ? window : {});

// The W3C "standard" gamepad layout. Every mainstream pad (Xbox, DualSense,
// Switch Pro, 8BitDo in X-input mode) reports mapping:'standard' and these
// indices over Bluetooth; a pad that doesn't still lands close enough that the
// face-button cluster works, and steering falls back to the stick axes.
const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  DPAD_U: 12, DPAD_D: 13, DPAD_L: 14, DPAD_R: 15
};

// ONE ACTION, SEVERAL BUTTONS — deliberately. Players arrive with different
// muscle memory (kart games put "go" on A, shooters on the right trigger), and
// the contexts these fire in are disjoint, so the overlaps below are not
// conflicts: A is ITEM only while a race is live and CONFIRM only while a menu
// is up; B is BRAKE while driving and CANCEL in a menu; START is the one button
// that means "the obvious thing here" everywhere.
const ITEM    = [BTN.A, BTN.X, BTN.RB, BTN.RT];
const BRAKE   = [BTN.B, BTN.LB, BTN.LT];
const CONFIRM = [BTN.A, BTN.START];
const CANCEL  = [BTN.B, BTN.BACK];
const MENU    = [BTN.START];
const NUDGE_L = [BTN.DPAD_L];
const NUDGE_R = [BTN.DPAD_R];
const NUDGE_U = [BTN.DPAD_U];
const NUDGE_D = [BTN.DPAD_D];

// Thumbsticks rest noisy and off-centre, so this is far wider than the tilt
// deadzone (STEER.DEADZONE, 0.06) — that number is calibrated for a phone's
// accelerometer and reusing it here would leave a worn stick steering on its
// own. Past the zone the range is rescaled to a full [-1,1] so the wire value
// means the same thing a phone's does (the sim applies STEER.EXPO to both).
const STICK_DEADZONE = 0.18;
// How far a stick must be pushed to count as one menu step (car cycling). Well
// above the deadzone: a menu nudge should take intent, not a drift.
const STICK_STEP = 0.6;
// A pad the room refused (four seats already taken) retries no faster than this.
const JOIN_RETRY_MS = 1000;
// The seat ring's own length (display.css @keyframes seat-ping): re-firing it
// sooner would restart the draw instead of showing one.
const PING_MS = 600;
// Liveness stamps. The race-phase sweep drops a seat that has been silent for
// LIVENESS.TIMEOUT_MS; a pad held perfectly still sends nothing, so stamp on a
// slow cadence of its own rather than on every frame.
const SEEN_MS = 1000;

// Rescale past the deadzone, preserving sign; 0 inside it.
function applyDeadzone(v, dz) {
  const m = Math.abs(v);
  if (m <= dz) return 0;
  return Math.sign(v) * ((m - dz) / (1 - dz));
}

// Steer from one pad's raw state: either stick's X axis, or the d-pad as a
// full-lock digital press (which is how a d-pad has always steered — see
// button-steer-binary in the controller's input notes).
export function padSteer(gp) {
  const ax = gp.axes || [];
  const stick = applyDeadzone(ax[0] || 0, STICK_DEADZONE)
    || applyDeadzone(ax[2] || 0, STICK_DEADZONE);
  let dpad = 0;
  if (isDown(gp, BTN.DPAD_L)) dpad -= 1;
  if (isDown(gp, BTN.DPAD_R)) dpad += 1;
  // The d-pad wins when both are used at once: it is the more deliberate input.
  const s = dpad || stick;
  return Math.max(-1, Math.min(1, s));
}

// Brake pressure. Analog triggers report a 0..1 value; face/shoulder buttons
// report 1 when down — so the hardest-pressed brake button wins and the wire
// carries real pressure off a trigger.
export function padBrake(gp) {
  let b = 0;
  for (const i of BRAKE) b = Math.max(b, buttonValue(gp, i));
  return Math.min(1, b);
}

function buttonValue(gp, i) {
  const btn = gp.buttons && gp.buttons[i];
  if (!btn) return 0;
  return typeof btn === 'number' ? btn : (btn.value || (btn.pressed ? 1 : 0));
}
function isDown(gp, i) {
  const btn = gp.buttons && gp.buttons[i];
  if (!btn) return false;
  return typeof btn === 'number' ? btn > 0.5 : !!btn.pressed;
}
// One pad's bookkeeping between polls: what was held last frame (so presses are
// edges, not repeats), its own wrapping item counter, and its seat state.
class Pad {
  constructor(index) {
    this.index = index;
    // String ids can never collide with a relay peer index (phones are 0..N).
    // Room ids are already scalar-typed — the AI fillers are 'ai-N' — so a
    // seated pad is just another key.
    this.id = 'pad-' + index;
    // What the player is called, what their badge reads, and the key the seat
    // card is found by — one number, so the three can never disagree.
    this.ordinal = index + 1;
    this.name = 'Pad ' + this.ordinal;
    this.seated = false;
    this.held = new Set();   // button indices down at the last poll
    this.primed = false;     // has `held` been baselined? (see edges)
    this.stepX = 0;          // last stick direction per menu axis (the edge source
    this.stepY = 0;          // that makes a held stick one step, not a scroll)
    this.useSeq = 0;         // wrapping ITEM counter, one bump per press
    // Both throttles start at NEVER, not at 0. On a page whose clock is still
    // younger than the window, 0 reads as "just did that" and swallows the
    // first one of each — which are the two that matter most: the join itself,
    // and the ring that tells the player which seat they just took.
    this.joinAt = -Infinity;
    this.pingAt = -Infinity;
    this.seenAt = 0;         // last liveness stamp
  }

  // Refresh `held` from this frame's raw pad and answer the newly-pressed set.
  //
  // The FIRST look reports nothing: it only records the baseline. A button that
  // was already down when we first saw the pad is not a press — nobody pressed
  // it in front of us — and some pads rest with one reading down (a home key, a
  // sticky shoulder, a driver quirk). Counting those as presses seated an idle
  // pad the instant the page noticed it, which is the join bug one layer down
  // from the one the join itself guards.
  edges(gp) {
    const now = new Set();
    const fresh = new Set();
    const n = (gp.buttons && gp.buttons.length) || 0;
    for (let i = 0; i < n; i++) {
      if (!isDown(gp, i)) continue;
      now.add(i);
      if (this.primed && !this.held.has(i)) fresh.add(i);
    }
    this.held = now;
    this.primed = true;
    return fresh;
  }
}

export class Gamepads {
  constructor(opts) {
    this.net = opts.net;
    // The manual pause latch and the frozen-results flag: the same two the phone
    // learns from the room snapshot, read here from the shell that owns them.
    this.isPaused = opts.isPaused || (() => false);
    this.canDrive = opts.canDrive || (() => true);
    // Which button the results board is showing — 'advance' during a cup
    // intermission, else a new game. The MODEL's answer (ui.resultsAction), the
    // same one the on-screen button reads.
    this.resultsAction = opts.resultsAction || (() => 'new-game');
    // The pick list the host pad cycles with up/down, as SELECT_MODE payloads.
    // Composed by the shell from the room's own chooser, so the pad offers what
    // the phone's picker offers rather than a second catalogue.
    this.picks = opts.picks || [];
    // Fired when the seated-pad count changes, so the lobby can drop its
    // "press a button" hint once someone has.
    this.onSeatChange = opts.onSeatChange || (() => {});
    // The pause overlay as a walkable menu: `items` are the MESSAGES its buttons
    // send, in the order they sit on screen, and `onFocus(i)` paints the cursor
    // (-1 clears it). Unconfigured, a pad can still leave the overlay — it just
    // has nothing to point at.
    this.pauseMenu = opts.pauseMenu || { items: [], onFocus: () => {} };
    this.cursor = 0;         // the shared pause-menu cursor (one overlay, one TV)
    this._menuUp = false;    // is that cursor currently on screen?
    // "That seat is you": the shell pings the pad's own seat card. Fired on the
    // join and on any press afterwards, so a player who has lost track of which
    // card is theirs can always ask by pressing something.
    this.onPadSignal = opts.onPadSignal || (() => {});

    this.pads = new Map(); // gamepad index -> Pad

    // A seat lost for any reason (a LEAVE, an expired grace window, the lobby
    // sweep) clears our flag, so the pad re-joins on its next press instead of
    // driving a car the room no longer knows about.
    if (this.net && this.net.flow) {
      this.net.flow.on('playerleave', ({ peerIndex }) => {
        for (const pad of this.pads.values()) {
          if (pad.id === peerIndex && pad.seated) { pad.seated = false; this.onSeatChange(this.seated); }
        }
      });
    }
  }

  get seated() {
    let n = 0;
    for (const pad of this.pads.values()) if (pad.seated) n++;
    return n;
  }

  // Which pad holds this seat, as its badge number — null for a phone. The
  // lobby asks this per roster row when it draws the seat dock.
  //
  // Deliberately NOT gated on `seated`: a row keyed 'pad-0' IS pad 0's, and the
  // roster is the truth about that — `seated` is only this module's own record
  // of it. The two disagree for exactly one render, because the seating walk
  // redraws the dock from inside localMessage() before _join can set the flag,
  // and a badge that missed its own join would be a poor first impression.
  ordinalOf(peerIndex) {
    for (const pad of this.pads.values()) if (pad.id === peerIndex) return pad.ordinal;
    return null;
  }

  // Called once per frame from the render loop, BEFORE its pause/frozen guards
  // — a pad has to be able to unpause the race it paused.
  poll(session) {
    const list = (navigator.getGamepads && navigator.getGamepads()) || [];
    const now = this._now();
    // BEFORE the pads are stepped, so no press can ever land on a stale cursor.
    // The highlight exists only while the overlay is up AND a pad is here to
    // move it — a mouse-only TV must not grow one it cannot use, and the overlay
    // is raised from the on-screen button as often as from a pad. Every open
    // starts on the first item, which is the safe one (Continue).
    const menuUp = this.pads.size > 0 && this.isPaused();
    if (menuUp !== this._menuUp) {
      this._menuUp = menuUp;
      this.cursor = 0;
      this.pauseMenu.onFocus(menuUp ? 0 : -1);
    }
    const seen = new Set();
    // The room phase crosses the ABI, so it is read on the first pad rather than
    // on every frame: a party with no pad in it (every party today) pays for the
    // getGamepads() call and nothing else.
    let state = null;
    for (const gp of list) {
      if (!gp || gp.connected === false) continue;
      seen.add(gp.index);
      let pad = this.pads.get(gp.index);
      if (!pad) { pad = new Pad(gp.index); this.pads.set(gp.index, pad); }
      if (state === null) state = this.net.roomState;
      this._step(pad, gp, session, state, now);
    }
    if (!this.pads.size) return;
    // A pad that vanished from the list is unplugged/out of battery. Hand its
    // seat back the same way a phone backing out does — the LEAVE walk decides
    // what that means (freed in the lobby, a soft drop with a rejoin QR
    // mid-race, so an accidental knock cannot forfeit a car).
    for (const [index, pad] of [...this.pads]) {
      if (seen.has(index)) continue;
      if (pad.seated) this.net.localMessage(pad.id, { type: MSG.LEAVE });
      this.pads.delete(index);
      if (pad.seated) this.onSeatChange(this.seated);
    }
  }

  _step(pad, gp, session, state, now) {
    const fresh = pad.edges(gp);

    if (!pad.seated) {
      // A PRESS TAKES THE SEAT, never the pad merely appearing.
      //
      // The tempting version of this reads "the browser only reveals a pad once
      // it has been used, so being here means someone pressed something". That
      // is what the spec implies and it is NOT what happens: a pad paired to the
      // machine and sitting untouched on the table is enumerated anyway. Joining
      // on sight let one silently take a seat in every party on that machine —
      // and take the HOST slot, which disables the real host's start. It cost
      // the E2E suite a day of "flake" before a failure screenshot showed two
      // phantom players in the lobby.
      //
      // Buttons only, deliberately: a worn stick rests off-centre and drifts,
      // which is the same false input in a different shape.
      if (!fresh.size || now - pad.joinAt < JOIN_RETRY_MS) return;
      pad.joinAt = now;   // a refusal (the room was full) retries no faster
      this._join(pad, gp);
      return;
    }

    // Proof of life, on a slow cadence — the same walk the fastlane's input path
    // stamps with, so a pad sitting still is not swept by the liveness tick.
    if (now - pad.seenAt > SEEN_MS) { pad.seenAt = now; this.net.noteSeen(pad.id); }

    if (state === ROOM_STATE.LOBBY) {
      this._lobby(pad, gp, fresh);
      // Anything the player does in the LOBBY re-answers "which card is mine",
      // that being the screen where they are picking a car and looking for
      // themselves. Not during a race: their own car is the answer there.
      //
      // AFTER the press is handled, never before: a car pick or a ready toggle
      // republishes the roster, and the redraw that follows would wipe a ring
      // fired ahead of it. (The join's own ring is fine — _join fires it once
      // the seating walk, redraw and all, has returned.)
      if (fresh.size || this._menuStepHeld(gp)) this._ping(pad);
    } else if (state === ROOM_STATE.RESULTS) this._results(pad, fresh);
    else this._race(pad, gp, fresh, session);
  }

  _join(pad, gp) {
    // A plain HELLO, exactly as a phone's first frame — the walk claims a seat
    // (lowest free livery, default car, MAX_PLAYERS cap) and names it. A room
    // with no seat left simply doesn't seat us; `has` is the answer.
    this.net.localMessage(pad.id, { type: MSG.HELLO, name: pad.name });
    const seated = this.net.flow.has(pad.id);
    if (seated === pad.seated) return;
    pad.seated = seated;
    // The seating walk stamped liveness itself; start this pad's own cadence
    // from there rather than firing a redundant stamp on its next frame.
    pad.seenAt = this._now();
    this.onSeatChange(this.seated);
    // BIND THE PAD TO THE CARD, at the one moment it is guaranteed to matter:
    // the buzz is in their hands and the ring is on their seat, at the same
    // instant. No amount of on-screen text does that job. The roster's
    // re-render has already run inside the walk above, so the card is there to
    // be pinged. Rumble is Chrome/Edge only today and degrades to the ring
    // alone, which is why the ring is not the optional half.
    this._ping(pad);
    this._rumble(gp, 260, 0.7);
  }

  // A short buzz. Absent on Safari (no vibrationActuator) and on pads that
  // report no actuator, so every failure path is a silent no-op — this confirms
  // an action the player already took, it never carries information of its own.
  _rumble(gp, duration, magnitude) {
    const act = gp && gp.vibrationActuator;
    if (!act || !act.playEffect) return;
    try {
      const r = act.playEffect('dual-rumble', {
        duration, strongMagnitude: magnitude, weakMagnitude: magnitude
      });
      if (r && r.catch) r.catch(() => {});
    } catch (_) { /* an actuator that refuses its own effect type */ }
  }

  // Ping this pad's seat card, at most once per animation length: holding a
  // stick would otherwise re-fire it every frame and the ring would never
  // finish drawing.
  _ping(pad) {
    const now = this._now();
    if (now - pad.pingAt < PING_MS) return;
    pad.pingAt = now;
    this.onPadSignal(pad.ordinal);
  }

  // ---- the three contexts ----------------------------------------------------

  // Lobby: pick a car, choose what to race, ready up, start, or give the seat back.
  _lobby(pad, gp, fresh) {
    const across = this._menuStep(pad, gp, fresh, 'stepX', [0, 2], NUDGE_L, NUDGE_R);
    if (across) this._cycleCar(pad, across);
    const down = this._menuStep(pad, gp, fresh, 'stepY', [1, 3], NUDGE_U, NUDGE_D);
    if (down) this._cyclePick(pad, down);
    if (hasAny(fresh, CANCEL)) { this.net.localMessage(pad.id, { type: MSG.LEAVE }); return; }
    if (!hasAny(fresh, CONFIRM)) return;
    // BOTH messages, every time, and let their C++ gates sort it out: the host's
    // readiness toggle is refused by set_ready_decision, and START_GAME is
    // refused for everyone but a host whose room is all-ready. So the same
    // button reads as "I'm ready" to a guest and "go" to the host without this
    // module re-deriving which of the two it is talking to.
    const seat = this._seat(pad.id);
    this.net.localMessage(pad.id, { type: MSG.SET_READY, ready: !(seat && seat.ready) });
    this.net.localMessage(pad.id, { type: MSG.START_GAME });
  }

  // The pause overlay, walked like a menu: a cursor over its buttons, moved on
  // either axis (a d-pad and a stick both land somewhere sensible for a row),
  // A to take the highlighted one.
  //
  // The cursor is SHARED — one overlay on one TV, so four pads point at the same
  // thing rather than fighting over four highlights. Its lifetime is poll()'s,
  // which owns the open/close latch.
  //
  // What a button DOES is not decided here: each entry is the message its
  // on-screen twin sends, so a pad's choice and a click land on the same verdict.
  _pauseMenu(pad, gp, fresh) {
    const items = this.pauseMenu.items;
    if (hasAny(fresh, MENU)) { this.net.localMessage(pad.id, { type: MSG.RESUME_GAME }); return; }
    // B backs OUT of the menu (it resumes) rather than taking the second item —
    // "cancel" must never be the destructive one when there is a cursor to make
    // the destructive choice deliberately.
    if (hasAny(fresh, CANCEL)) { this.net.localMessage(pad.id, { type: MSG.RESUME_GAME }); return; }
    // Both axes are read every frame even though only one can win, so a stick
    // let go of diagonally leaves neither axis remembering a direction it never
    // reported.
    const across = this._menuStep(pad, gp, fresh, 'stepX', [0, 2], NUDGE_L, NUDGE_R);
    const down = this._menuStep(pad, gp, fresh, 'stepY', [1, 3], NUDGE_U, NUDGE_D);
    if (!items.length) return;
    const step = across || down;
    if (step) this._moveCursor(step);
    if (hasAny(fresh, CONFIRM)) this.net.localMessage(pad.id, { type: items[this.cursor] });
  }

  _moveCursor(step) {
    const n = this.pauseMenu.items.length;
    this.cursor = ((this.cursor + step) % n + n) % n;
    this.pauseMenu.onFocus(this.cursor);
  }

  // Results board: the same two actions its on-screen button offers.
  _results(pad, fresh) {
    if (hasAny(fresh, CANCEL)) {
      this.net.localMessage(pad.id, { type: MSG.RETURN_TO_LOBBY });
    } else if (hasAny(fresh, CONFIRM)) {
      this.net.localMessage(pad.id, this.resultsAction() === 'advance'
        ? { type: MSG.SERIES_NEXT }        // host-gated in C++, like the phone's
        : { type: MSG.RETURN_TO_LOBBY });
    }
  }

  // Countdown / racing / paused. Driving input is fed straight into the sim; the
  // pause overlay turns the pad back into a menu.
  _race(pad, gp, fresh, session) {
    if (this.isPaused()) { this._pauseMenu(pad, gp, fresh); return; }
    if (hasAny(fresh, MENU)) { this.net.localMessage(pad.id, { type: MSG.PAUSE_GAME }); return; }
    if (hasAny(fresh, ITEM)) pad.useSeq = (pad.useSeq + 1) & 255;
    // The frozen frames (results overlay up, silent auto-pause) still route the
    // buttons above; they just must not move a car.
    if (!session || !this.canDrive() || !session.hasCar(pad.id)) return;
    session.processInput(pad.id, { s: padSteer(gp), b: padBrake(gp), u: pad.useSeq });
  }

  // ---- helpers ---------------------------------------------------------------

  _now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  // Is a stick pushed far enough to be a menu move? Read for the seat ping
  // alone — a stick carries no press EDGE, so without this a player who only
  // ever thumbs the car strip would never light their own card.
  _menuStepHeld(gp) {
    const ax = gp.axes || [];
    for (const i of [0, 1, 2, 3]) if (Math.abs(ax[i] || 0) >= STICK_STEP) return true;
    return false;
  }

  // One discrete menu step along an axis: a d-pad press, or a stick pushed past
  // STICK_STEP (edge-detected against the last direction, so holding it over is
  // one step and not a scroll). `key` names the pad's memory for this axis, so
  // across and down keep their own.
  _menuStep(pad, gp, fresh, key, axes, back, fwd) {
    if (hasAny(fresh, back)) return -1;
    if (hasAny(fresh, fwd)) return 1;
    const ax = gp.axes || [];
    const a = ax[axes[0]] || 0, b = ax[axes[1]] || 0;
    const v = Math.abs(a) > Math.abs(b) ? a : b;
    const dir = v <= -STICK_STEP ? -1 : (v >= STICK_STEP ? 1 : 0);
    const step = dir && dir !== pad[key] ? dir : 0;
    pad[key] = dir;
    return step;
  }

  // Cycle what the room is racing. WITHOUT THIS A PAD-ONLY PARTY CANNOT START:
  // the pick is what gates the host's start, and picking is otherwise phone-only
  // UI. Refused for everyone but the host, in the lobby, by selectModeWalk — so
  // a guest pad thumbing the stick changes nothing, like a guest phone tapping a
  // tile. The lobby's cup slot and 3D preview are the feedback, off the
  // track-change effect the walk already emits.
  _cyclePick(pad, step) {
    const picks = this.picks;
    if (!picks.length) return;
    const cur = this.net.pick || {};
    // Where the room's stored pick sits in the list. A cup is identified by its
    // id, the other modes by mode alone; an unrecognised pick (or none yet)
    // starts the cycle at the top.
    const at = picks.findIndex((p) => p.mode === cur.mode && (p.mode !== 'cup' || p.cupId === cur.cupId));
    const next = at < 0
      ? (step > 0 ? 0 : picks.length - 1)
      : ((at + step) % picks.length + picks.length) % picks.length;
    this.net.localMessage(pad.id, { type: MSG.SELECT_MODE, ...picks[next] });
  }

  _cycleCar(pad, step) {
    const models = window.CAR_MODELS || [];
    if (!models.length) return;
    const seat = this._seat(pad.id);
    const cur = seat && typeof seat.carIndex === 'number' ? seat.carIndex : 0;
    const next = ((cur + step) % models.length + models.length) % models.length;
    // Refused while the seat is ready or its car is in the live race — that lock
    // is set_car_decision's, and this asks rather than shadowing it.
    this.net.localMessage(pad.id, { type: MSG.SET_CAR, carIndex: next });
  }

  // This pad's seat record, read at button-press frequency only.
  _seat(id) {
    return this.net.flow.list().find((p) => p.peerIndex === id) || null;
  }
}

function hasAny(set, list) {
  for (const i of list) if (set.has(i)) return true;
  return false;
}
