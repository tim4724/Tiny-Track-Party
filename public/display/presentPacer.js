// Which rAF callbacks DRAW when the render scale's divisor is above 1.
//
// The divisor is "present every Nth vsync" (native/libttp-runtime/ttp/render_scale.h),
// 2 on the host's Quality choice. The TV shells perform it on hardware ticks,
// which are vsyncs; rAF is the one tick that can arrive a vsync late under
// load, so the web counts vsyncs by TIME off the stamps rather than counting
// callbacks: a callback draws when the whole-vsync distance from the last
// present reaches the divisor, which is the earliest any callback can. Rounding
// to whole periods is what makes it immune to the ±1 ms the stamps jitter by.
// public/display/CLAUDE.md has what counting callbacks cost.
//
// Dependency-free so tests/present-pacer.test.js can drive it with a stamp train.
export class PresentPacer {
  constructor() { this._lastT = -Infinity; }

  // `t` is this callback's stamp, `periodMs` the panel period or 0 when none is
  // known (the first frame, the frame after a stall) — an unknown period draws,
  // which is what a stall wants anyway. Records a draw it answers yes to.
  due(t, periodMs, divisor) {
    const draw = !(divisor > 1) || !(periodMs > 0)
        || Math.round((t - this._lastT) / periodMs) >= divisor;
    if (draw) this._lastT = t;
    return draw;
  }
}
