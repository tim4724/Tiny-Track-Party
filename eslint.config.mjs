// Flat ESLint config for Tiny Track Party.
//
// The codebase spans several module regimes, so linting is scoped per area:
//   - Browser ES modules (public/**, partyplug kit): `import`/`export`, plus a
//     few files using the universal `typeof window` / `module.exports` dual
//     export shim (public/shared/protocol.js, partyplug/PartyConnection.js, …).
//   - Node CommonJS (server, unit tests): `require`, `process`, `__dirname`.
//   - Node CommonJS that drives a browser (asset-capture scripts, Playwright
//     E2E): the same, plus browser globals for the page.evaluate() closures.
//   - Node ESM scripts (scripts/*.mjs): `import` + Node globals.
//   - This config: ESM, Node globals.
//
// Rules lead with the correctness signal a type system would give for free
// (no-undef as an error catches typos/missing globals). Style-ish rules
// (unused vars, redundant assignment, == null, empty catch) are warnings so the
// build gates on real bugs, not housekeeping. Formatting is not linted — there
// is no Prettier.

import js from '@eslint/js';
import globals from 'globals';

// Browser globals + the dual browser-script/CommonJS export shim a few shared
// files use (public/shared/protocol.js, partyplug/PartyConnection.js).
const browserGlobals = {
  ...globals.browser,
  module: 'readonly',
  require: 'readonly',
  exports: 'writable',
};

export default [
  // ── What never gets linted ────────────────────────────────────────────────
  // worktrees/ and .claude/ hold gitignored sibling checkouts other agents work
  // in; the rest are run/build artefacts and vendored upstream code.
  {
    ignores: [
      'node_modules/**',
      'worktrees/**',
      '.claude/**',
      '.playwright-mcp/**',
      'test-results/**',
      'native/**',                        // C++ tree; build dirs emit emscripten glue JS
      'public/display/engine/native/**',  // generated wasm artifacts (ttp_runtime.mjs — emscripten glue)
      'public/shared/qrcode-generator.js', // vendored verbatim; upstream style, not ours
      'artwork/**',
    ],
  },

  // ── Base correctness ruleset for everything below ─────────────────────────
  js.configs.recommended,

  // ── Browser ES modules: shipped display + controller + partyplug kit ──────
  {
    files: ['public/**/*.js', 'partyplug/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserGlobals,
    },
  },

  // ── Node CommonJS: server + unit tests ────────────────────────────────────
  {
    files: [
      'server/**/*.js',
      'tests/*.test.js',
      'partyplug/tests/**/*.js',
      'playwright.config.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // ── Node CommonJS helpers for the wire-compat suite ───────────────────────
  // tests/wire-compat/*.js are require()d by tests/wire-*.test.js (the relay
  // model, the DataChannel fakes, the wasm/kit harness). Node CommonJS, plus the
  // browser globals they INSTALL for the unchanged controller + kit modules.
  {
    files: ['tests/wire-compat/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ── Node CommonJS that drives a browser: capture scripts + E2E specs ──────
  // These run page.evaluate() closures, so the file is Node but references
  // browser globals (window, document, OffscreenCanvas, …) inside those closures.
  {
    files: ['scripts/**/*.js', 'tests/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ── Node ES module scripts (scripts/*.mjs) ────────────────────────────────
  {
    files: ['scripts/**/*.mjs', 'shells/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ── Node ESM that drives a browser: the cue baker, the perf sweep ─────────
  // Same reasoning as the CommonJS capture-script block above — the file is
  // Node, but its page.evaluate() closures run in Chromium and reference window.
  // (scripts/lib/bake-harness.js is browser-only and is covered by the
  // scripts/**/*.js block, which already carries browser globals.)
  // ── ESM that drives a browser ──────────────────────────────────────────────
  // Same situation as the CommonJS capture scripts above: the FILE is Node, but
  // it ships page.evaluate() closures that run in the page and reference browser
  // globals. Split out rather than widening the Node block, so a stray `window`
  // in an ordinary script is still an error.
  {
    files: ['scripts/capture-shots.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    files: ['scripts/bake-cues.mjs', 'scripts/perf-features.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ── This config file: ESM, Node globals ───────────────────────────────────
  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ── Project rule tuning (overrides recommended severities everywhere) ─────
  {
    rules: {
      // The headline win: catch undeclared names / typos a type system would.
      'no-undef': 'error',
      // High-signal but housekeeping — warn, and honour the `_`-prefix
      // convention for deliberately-unused bindings.
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      // Mostly fires on defensive `let x = null;` inits that are immediately
      // reassigned — legitimate, so advisory rather than build-breaking.
      'no-useless-assignment': 'warn',
      // `== null` is used intentionally for nullish checks (protocol.js etc.).
      eqeqeq: ['warn', 'smart'],
      // Empty catch blocks are an intentional swallow pattern in audio/net code.
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
