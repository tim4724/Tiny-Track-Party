// Preflight for `npm run test:e2e` — the one suite in this repo that needs
// node_modules at all.
//
// `npm test` is node:test over dependency-free sources and runs in a bare
// checkout, so a fresh worktree looks fine right up until the E2E run, which
// then fails in two ways that both hide the real cause:
//
//   * `playwright test` -> "sh: playwright: command not found" (the bin lives in
//     node_modules/.bin, which npm only puts on PATH when it exists), and
//   * `npx playwright test` -> "No tests found", exit 1: npx fetches the
//     `playwright` package, but playwright.config.js is a @playwright/test
//     config, so the runner it fetched sees no suite. That reads like a broken
//     glob rather than a missing install.
//
// So: check first, say what to run, and never let either message be the thing a
// newcomer has to decode. Dependency-free on purpose — it has to run in exactly
// the checkout it is diagnosing.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NEEDED = [
  ['@playwright/test', 'the E2E runner (playwright.config.js is its config)'],
  ['ws', 'the hermetic relay stub (tests/e2e/relay-server.js)'],
];

const missing = NEEDED.filter(([m]) => !fs.existsSync(path.join(ROOT, 'node_modules', m)));
if (missing.length) {
  const what = missing.map(([m, why]) => `  ${m} — ${why}`).join('\n');
  process.stderr.write(
    `E2E dependencies are not installed:\n${what}\n\n` +
    `Fix: npm ci   (~1 s here — npm's cache is shared across worktrees and APFS\n` +
    `clones the files, so a fresh worktree is not worth sharing a node_modules for.\n` +
    `The browser binaries are already shared, in ~/Library/Caches/ms-playwright;\n` +
    `if this is a new machine: npx playwright install chromium)\n\n` +
    `Note that \`npm test\` needs none of this — it is node:test over ` +
    `dependency-free sources — so a bare checkout passes the unit suite and only ` +
    `trips here.\n`
  );
  process.exit(1);
}
