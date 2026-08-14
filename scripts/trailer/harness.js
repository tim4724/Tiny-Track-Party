'use strict';

// What render.js and scout.js both need to drive the display from Node: a static server,
// a browser that presents as an ordinary tab, and one fixed step of the scene.
//
// Both are plain Node CLI scripts pointing Playwright at the same page, so there is no
// reason for two copies. (The trailer EDITOR mirrors the same stepping and deliberately
// does not share this: it runs same-realm inside the browser against an <iframe>, with
// none of the cross-realm evaluate boundary these two are built around.)

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// Stage clamps itself under automation — dpr 0.25 and no shadow bake, budgets for the
// E2E suite, which asserts state and never looks at a pixel. Neither of these callers is
// the suite: both want the shipping render path, so present as an ordinary tab.
//
// The frame clock is a separate matter and is NOT taken here: it comes from `?gate=1` in
// the page URL, which the display installs itself before it draws anything. See
// public/display/frameGate.js.
const UNMASK = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
};

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

function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => (Date.now() > deadline
        ? reject(new Error(`server never came up on :${port}`))
        : setTimeout(ping, 150)));
    })();
  });
}

// Own static server on its own port, so a running dev server is never disturbed.
// Returns the kill, already registered to run at exit.
async function serveStatic(port) {
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), APP_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const kill = () => { try { server.kill('SIGTERM'); } catch (_) { /* already gone */ } };
  process.on('exit', kill);
  await waitForServer(port);
  return kill;
}

module.exports = { ROOT, UNMASK, STEP_ONE, waitForServer, serveStatic };
