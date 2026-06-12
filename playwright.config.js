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
  retries: process.env.CI ? 1 : 0,
  timeout: 60000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 7000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node server/index.js',
      env: { ...process.env, PORT: String(PORT) },
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
