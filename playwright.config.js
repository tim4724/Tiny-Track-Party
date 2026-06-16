// @ts-check
// E2E suite — real display + controller pages over the hermetic relay stub
// (tests/e2e/relay-server.js), so the full flow runs with no dependency on the
// production relay. Run with `npm run test:e2e`.
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.PW_PORT || 4200);
const RELAY_PORT = Number(process.env.PW_RELAY_PORT || 4201);

module.exports = defineConfig({
  testDir: './tests/e2e',
  // One worker: the display page renders the full Three.js scene under
  // SwiftShader in headless — parallel displays just starve each other.
  workers: 1,
  // One retry everywhere (not just CI): a retry runs in a FRESH worker process —
  // a brand-new browser with no accumulated SwiftShader GL memory pressure — which
  // is the cleanest antidote to the occasional multi-second render stall that
  // starves the race countdown (see waitForRacing in helpers.js). Cheap insurance
  // on a single-worker suite where a tail stall is a software-rendering artefact,
  // not a real failure.
  retries: 1,
  // The display renders the full 3D scene through software GL in headless; the
  // whole flow (scene load → countdown → race → results) needs more wall clock
  // than a DOM-only app, so give each test ample room before it's called hung.
  timeout: 120000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    // Generous per-action timeout: under the single-worker render load a controller
    // page can be janky enough that Playwright's actionability (visible/stable)
    // check on a button takes a few seconds to settle.
    actionTimeout: 15000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node server/index.js',
      // RELAY_URL points every served page at the local stub (injected via the
      // relay-url <meta>; see shared/protocol.js) and scopes the CSP to it.
      env: { ...process.env, PORT: String(PORT), RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}` },
      port: PORT,
      reuseExistingServer: false,
    },
    {
      command: 'node tests/e2e/relay-server.js',
      env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
      port: RELAY_PORT,
      reuseExistingServer: false,
    },
  ],
});
