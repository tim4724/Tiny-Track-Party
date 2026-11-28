// Which rumble a held drive button plays: the DRIFT's (slower, heavier) or the
// BRAKE's. The display's sim decides what the car really does (game.cc's slide
// rule); the phone cannot wait a round trip to feel it, so it runs the same rule
// on its own steer and button. It leaves out the one input it cannot see, the
// sim's speed gate: a car too slow to slide brakes on the TV while the phone
// still rumbles drift.
//
// The rule, as the sim has it: the button held with |steer| at or past
// DRIFT_START slides; |steer| under DRIFT_END ends the slide, and the button
// still held then brakes until it comes up.
//
// DRIFT_START / DRIFT_END are MANIFEST values (protocol.js STEER), re-declared
// here as TiltInput's are because protocol.js is a classic script and this file
// is imported headlessly by the Node suites; tests/config-drift.test.js pins them.
export const DRIFT_START = 0.5;
export const DRIFT_END = 0.2;

export class DriftFeel {
  constructor() {
    this.drifting = false;
    this._spent = false;   // this press's slide ended on a straightened steer
  }

  // One beat: whether the button is held, and the steer as sent. Answers
  // 'drift', 'brake', or null with nothing held.
  step(held, steer) {
    const s = Math.abs(steer);
    if (!held) {
      this.drifting = false;
      this._spent = false;
      return null;
    }
    if (this.drifting && s < DRIFT_END) {
      this.drifting = false;
      this._spent = true;
    } else if (!this.drifting && !this._spent && s >= DRIFT_START) {
      this.drifting = true;
    }
    return this.drifting ? 'drift' : 'brake';
  }
}
