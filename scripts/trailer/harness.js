'use strict';

// What render.js and scout.js both need beyond the capture seam: one fixed step
// of the scene. The server and the ordinary-tab browser come from
// ../lib/capture.mjs (serveApp/launchBrowser — allocated port, dead-child-fatal
// server, webdriver spoofed false so Stage runs the shipping render path); the
// seam is ESM, so the two CJS callers reach it with `await import()` inside
// their async mains.
//
// Both are plain Node CLI scripts pointing Playwright at the same page, so there
// is no reason for two copies of the stepping. (The trailer EDITOR mirrors it
// and deliberately does not share this: it runs same-realm inside the browser
// against an <iframe>, with none of the cross-realm evaluate boundary these two
// are built around.)
//
// The frame clock is a separate matter from the browser spoof and is NOT taken
// there: it comes from `?gate=1` in the page URL, which the display installs
// itself before it draws anything. See public/display/frameGate.js.

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Advance the scene by exactly one fixed step and return once the frame has been drawn.
// start() re-arms the loop and pauseAfterFrame() tells it to halt after the next
// iteration, so the pair is a single-step primitive; __pump (the gate's) then actually
// runs it, and onAfterFrame fires with the drawing buffer still holding the frame.
const STEP_ONE = (stepMs) => new Promise((done, fail) => {
  const s = window.__scene;
  const t = setTimeout(() => fail(new Error('frame never presented')), 30000);
  s.onAfterFrame = () => { s.onAfterFrame = null; clearTimeout(t); done(); };
  s.start();
  s.pauseAfterFrame();
  window.__pump(stepMs);
});

module.exports = { ROOT, STEP_ONE };
