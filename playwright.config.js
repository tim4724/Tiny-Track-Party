// @ts-check
// E2E suite — real display + controller pages over the hermetic relay stub
// (tests/e2e/relay-server.js), so the full flow runs with no dependency on the
// production relay. Run with `npm run test:e2e`.
const { defineConfig } = require('@playwright/test');

// Default ports are derived per-worktree from this config's own path, so
// concurrent runs in sibling worktrees (or parallel agents) don't collide on a
// shared hardcoded pair — the webServers use reuseExistingServer:false, so a
// collision means one run's server tears down the port the other is mid-request
// on (ERR_CONNECTION_REFUSED). PW_PORT/PW_RELAY_PORT still override explicitly.
// 200 slots across 4200–4599: app = base, relay = base+1 (stepped by 2).
let slot = 0;
for (const ch of __dirname) slot = (slot * 31 + ch.charCodeAt(0)) >>> 0;
slot %= 200;
const PORT = Number(process.env.PW_PORT || 4200 + slot * 2);
const RELAY_PORT = Number(process.env.PW_RELAY_PORT || PORT + 1);

module.exports = defineConfig({
  testDir: './tests/e2e',
  // ONE worker on CI, three locally, and the split is measured rather than
  // reasoned about. The display page rasterizes the full Filament scene through
  // SwiftShader in headless, so a worker is a CPU-hungry software rasterizer:
  // on a 2-core CI runner parallel displays genuinely starve each other, and CI
  // scales by SHARDING across runners instead (.github/workflows/test.yml).
  //
  // A dev box is not that machine. The serial suite used 2.4 of 10 cores here,
  // and the whole 25-test run measures:
  //     workers 1 -> 213 s      workers 3 -> 79 s      workers 5 -> 103 s
  // All three passed; 5 is past the knee (same ~475 s of user CPU as 3, so 3
  // already saturates) and its contention stretched one test to 46 s against
  // the 120 s timeout — margin worth keeping. Hence 3, not "half the cores":
  // this scales with the rasterizer's appetite, not with the core count.
  workers: process.env.CI ? 1 : 3,
  // Shard granularity as well as in-machine parallelism. On CI (workers: 1) it
  // is ONLY the former — every test still runs one at a time there, and what
  // this changes is how --shard splits the suite. Left off, Playwright shards
  // whole FILES, so
  // cup-series.spec.js (5 tests, ~3m49s on CI) is one atomic lump and the
  // shards came out 2:19/3:54/6:01/2:50 against a 3:46 perfect split — the
  // slowest shard set the whole workflow's wall clock. Per-test sharding lets
  // that file spread. Safe because no spec has beforeAll/describe.serial or any
  // other file-level shared state; every test opens its own display and phones,
  // and the _reapContexts fixture in helpers.js closes them per test.
  fullyParallel: true,
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
    //
    // 15s was tuned against the Three.js renderer. The native one rasterizes a
    // heavier scene through the same SwiftShader, and the FIRST test in a CI
    // shard additionally pays a cold fetch + compile of the 2.76 MB engine wasm
    // — contexts don't share a cache, so every shard has one such test. That
    // combination starved the actionability check on a phone's join button.
    // The 120s test timeout is what still catches a genuinely stuck action.
    actionTimeout: 30000,
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
