// ?gate=1 — hand the frame clock to whoever is driving this page from outside.
//
// Normally the scene runs on requestAnimationFrame and its own wall-clock dt. An OFFLINE
// CAPTURE cannot use that: it wants one fixed step per frame drawn, and it wants the
// same URL to produce the same race every time. `Stage.setFixedStep` gives it the fixed
// step. This gives it the second half — no frame runs unless it is asked for.
//
// It matters from the FIRST frame, which is why this is a URL param and not something a
// caller turns on afterwards. Booting the display draws a frame or two before any
// external driver can reach in (the test harness holds its preview on a painted frame,
// which is one `Stage` iteration at a wall-clock dt), and the sim advances by a variable
// amount in them. Gate late and two runs of the same seed sit a few frames apart forever
// after; gate here and both start from nothing.
//
// The contract is small on purpose:
//   requestAnimationFrame  queues the callback and never fires it
//   window.__pump(stepMs)  runs everything queued, advancing a clock of our own
//
// Callers all reach it the same way, through `?gate=1`: scripts/trailer/render.js,
// scripts/trailer/scout.js and public/trailer/editor.js. The editor is why it has to live
// here rather than in the capture scripts — it drives an <iframe> and cannot inject
// anything ahead of the page's own scripts.
//
// Nothing in normal play imports the behaviour: without the param this module does
// nothing at all.

// CSS animations run on the browser's own clock, which under a gate is nothing like the
// scene's. An offline capture spends ~360 ms of wall time producing each 1/60 s frame, so
// a one-second CSS fade — the GO banner's, for one — finishes inside about three captured
// frames and reads as a pop instead of a fade.
//
// So put them on the same clock as everything else: pause each animation as it appears,
// note the step it started on, and drive its currentTime from the gated clock. An
// animation created inside a pump callback is picked up by the same pump, so it starts at
// zero rather than a frame late.
//
// This is also what makes slow motion honest in the trailer editor: at half speed the
// HUD slows with the race instead of running at wall speed over it.
function syncAnimations(clock, startedAt) {
  let running;
  try { running = document.getAnimations(); } catch (_) { return; }
  for (const anim of running) {
    try {
      if (!startedAt.has(anim)) { startedAt.set(anim, clock); anim.pause(); }
      anim.currentTime = clock - startedAt.get(anim);
    } catch (_) { /* an animation can be cancelled between the list and the write */ }
  }
}

export function installFrameGate() {
  if (new URLSearchParams(location.search).get('gate') !== '1') return false;
  const queue = [];
  const startedAt = new WeakMap();
  let clock = 0;
  window.requestAnimationFrame = (cb) => queue.push(cb);
  window.__pump = (stepMs) => {
    clock += stepMs || 0;
    // splice first: a callback that re-schedules itself must land in the NEXT pump,
    // not extend this one into an unbounded loop.
    for (const cb of queue.splice(0)) cb(clock);
    syncAnimations(clock, startedAt);
  };
  return true;
}
