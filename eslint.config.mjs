// Flat ESLint config for Tiny Track Party.
//
// The codebase spans several module regimes, so linting is scoped per area:
//   - Browser ES modules (public/**, partyplug kit): `import`/`export`, plus a
//     few files using the universal `typeof window` / `module.exports` dual
//     export shim (public/shared/protocol.js, partyplug/PartyConnection.js, …).
//   - Browser classic scripts (the gallery preview surface): loaded via plain
//     <script src> tags that share a global `Gallery`, so they're `script`, not
//     `module` — under `module` the shared global reads as undefined.
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
// files use. The gallery preview surface's shared `Gallery` global is added
// only to its consumers — gallery-common.js *defines* it (a real `var`), so
// predeclaring it there would trip no-redeclare.
const browserGlobals = {
  ...globals.browser,
  module: 'readonly',
  require: 'readonly',
  exports: 'writable',
};

export default [
  // ── What never gets linted ────────────────────────────────────────────────
  // worktrees/ and .claude/ hold gitignored sibling checkouts other agents work
  // in; the rest are run/build artefacts.
  {
    ignores: [
      'node_modules/**',
      'worktrees/**',
      '.claude/**',
      '.playwright-mcp/**',
      'test-results/**',
      'native/**',                        // C++ tree; build dirs emit emscripten glue JS
      'public/display/engine/native/**',  // generated wasm artifacts (ttp_runtime.mjs — emscripten glue)
      'artwork/**',
    ],
  },

  // ── Base correctness ruleset for everything below ─────────────────────────
  js.configs.recommended,

  // ── Browser ES modules: shipped display + controller + partyplug kit ──────
  // Gallery: 'readonly' covers gallery-tracks.js / gallery-sounds.js, which load
  // as type=module yet read the global from the classic gallery-common.js script.
  {
    files: ['public/**/*.js', 'partyplug/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...browserGlobals, Gallery: 'readonly' },
    },
  },

  // ── Gallery preview surface: classic <script src> files (no import/export) ─
  // gallery-common.js DEFINES the shared `Gallery` global; the others read it.
  // `script` source type keeps a top-level `var` in the shared global scope.
  {
    files: ['public/gallery-common.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // 'off' neutralises the Gallery:'readonly' the broad public/** block above
      // merges in — this file *is* the definition, so its `var Gallery` must not
      // collide with a predeclared global (flat config merges globals additively).
      globals: { ...browserGlobals, Gallery: 'off' },
    },
  },
  {
    files: ['public/gallery-display.js', 'public/gallery-controller.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...browserGlobals, Gallery: 'readonly' },
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
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
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
