'use strict';
// Portable-purity gate: the whole sim path (public/display/engine/*, Centerline,
// AiDriver, TrackBuilder, RaceSession) and the kit's RoomFlow are CLOCK-FREE,
// THREE-FREE and host-agnostic — no wall clock, no global RNG, no DOM, no
// timers, no vendored renderer math. They must load and behave identically in
// the browser, the Node tests, and (eventually) alongside the native C++ port,
// and stay deterministic (seeded PRNG streams; all timing injected as dt/nowMs
// by the host). Nothing else fails fast on a stray Date.now() in these files —
// a race would just quietly stop being reproducible — so this scan is the
// enforcement the modules' comments promise. A second scan below guards the
// boundary from the OUTSIDE: display code may not reach into engine internals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DISPLAY_DIR = path.join(ROOT, 'public/display');
const ENGINE_DIR = path.join(DISPLAY_DIR, 'engine');
const FILES = [
  ...fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(ENGINE_DIR, f)),
  // The rest of the sim path — the C++ port's conformance boundary. All four are
  // three-free and clock-free with NO exceptions: TrackBuilder swapped its last
  // THREE.Vector3 for engine/Vec3.js, and RaceSession is dt-driven (no timers).
  path.join(DISPLAY_DIR, 'Centerline.js'),
  path.join(DISPLAY_DIR, 'AiDriver.js'),
  path.join(DISPLAY_DIR, 'TrackBuilder.js'),
  path.join(DISPLAY_DIR, 'RaceSession.js'),
  path.join(ROOT, 'partyplug/RoomFlow.js'),
  path.join(DISPLAY_DIR, 'GrandPrix.js'), // cup scoring: outside engine/, same purity promise
  // Transitive DATA imports of the sim path: TrackBuilder pulls the track
  // catalogue, so a stray Math.random()/Date.now() in a track helper would
  // silently break golden-trace reproducibility. Same scan, same bans.
  path.join(ROOT, 'public/shared/tracks.js'),
  path.join(ROOT, 'public/shared/genTracks.js')
];

// API-shaped patterns (call sites / property reads, not bare words). Scanned on
// comment-stripped source, so neither prose in comments nor these belt-and-braces
// shapes can false-positive on documentation.
const BANNED = [
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date', /\bnew\s+Date\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['performance.*', /\bperformance\s*\./],
  ['window.*', /\bwindow\s*\./],
  ['document.*', /\bdocument\s*\./],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['setInterval', /\bsetInterval\s*\(/],
  ['requestAnimationFrame', /\brequestAnimationFrame\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['fetch(', /\bfetch\s*\(/],
  // The sim path must not lean on the vendored renderer math either — its vector
  // type is engine/Vec3.js, so the same sources compile against the native port.
  // The vendor-relative specifier is banned too: importing vendor/three directly
  // would load fine in browser AND Node, so nothing else would catch it.
  ["import from 'three'", /from\s*['"]three['"]|import\s*\(\s*['"]three['"]\s*\)/],
  ['vendor/three import', /vendor\/three/],
  ['THREE', /\bTHREE\b/],
  // Cheap extra host-API bans (none are load-bearing today; fail fast if one appears).
  ['navigator', /\bnavigator\b/],
  ['location.*', /\blocation\s*\./],
  ['alert(', /\balert\s*\(/],
  ['WebSocket', /\bWebSocket\b/]
];

// Blank out comments but keep every newline, so violation line numbers stay true.
// Tiny scanner instead of a regex: string literals may contain `//` (URLs) and
// comment markers may sit inside template strings.
function stripComments(src) {
  let out = '';
  let mode = null; // null | '"' | "'" | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = '//'; out += '  '; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; out += '  '; i++; continue; }
      if (c === '"' || c === "'" || c === '`') mode = c;
      out += c;
    } else if (mode === '//') {
      if (c === '\n') { mode = null; out += c; } else out += ' ';
    } else if (mode === '/*') {
      if (c === '*' && n === '/') { mode = null; out += '  '; i++; }
      else out += c === '\n' ? c : ' ';
    } else { // inside a string
      if (c === '\\') { out += c + (n || ''); i++; continue; }
      if (c === mode) mode = null;
      out += c;
    }
  }
  return out;
}

test('sim-path modules and RoomFlow stay clock-free, three-free and host-agnostic', () => {
  assert.ok(FILES.length >= 11, `expected sim-path files + RoomFlow + GrandPrix + shared track data, found ${FILES.length} (moved?)`);
  const violations = [];
  for (const file of FILES) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of BANNED) {
        if (re.test(line)) violations.push(`${path.relative(ROOT, file)}:${i + 1} uses ${name}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'purity violations (inject time/RNG from the host instead):\n  ' + violations.join('\n  '));
});

// The scan is only airtight if FILES covers the sim path's whole module graph:
// a new `import './helper.js'` in a scanned file would otherwise open an
// unscanned side door (exactly how shared/tracks.js slipped out before).
// Every static relative import of a scanned file must itself be scanned.
test('the sim path\'s import closure stays inside the scanned file set', () => {
  const scanned = new Set(FILES.map((f) => fs.realpathSync(f)));
  const escapes = [];
  for (const file of FILES) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = fs.realpathSync(path.resolve(path.dirname(file), m[1]));
      if (!scanned.has(target)) {
        escapes.push(`${path.relative(ROOT, file)} imports ${path.relative(ROOT, target)} (unscanned)`);
      }
    }
  }
  assert.deepEqual(escapes, [], 'sim-path imports outside the purity scan (add them to FILES):\n  ' + escapes.join('\n  '));
});

// ---- sim-boundary seam scan ----
// The other half of portability: nothing on the display side reaches THROUGH the
// boundary into engine internals. main.js holds only a RaceSession and reads it
// via the query API (carIds/hasCar/carFinished/carWorldPos/trackPoint/driveBot/
// forceFinish — all plain data); LobbyDemo/TestHarness own demo Game instances
// but may only call the Game contract surface on them. Anything else (.cars,
// .centerline, ._useItem, .rockets, ...) is a leak the native port would break on.

// The sim path itself legitimately owns engine internals — skipped by the scan
// (RaceSession IS the boundary; the engine/ dir is the engine).
const SIM_PATH_NAMES = new Set(['engine', 'Centerline.js', 'AiDriver.js', 'TrackBuilder.js', 'RaceSession.js']);

// Members reachable through a held engine reference (`<expr>.engine.<member>`
// or a bare local bound to `new Game(...)`): the Game contract surface,
// exactly as documented in Game.js's header.
const ENGINE_CONTRACT = new Set([
  'update', 'processInput', 'getSnapshot', 'getResults', 'raceOver',
  'setCarStats', 'removeCar', 'rekeyCar',
  'carIds', 'hasCar', 'carFinished', 'carWorldPos', 'trackPoint', 'driveBot',
  'giveItem', 'useItem', 'forceFinish', 'stageCar', 'stageBanana', 'stageRocket'
]);

// The ONE sanctioned raw-engine REACH: main.js's debug escape hatch (free-cam
// inspection / console poking). TestHarness's `window.__engine = engine`
// console hatches are plain assignments with no member reach, so they pass
// the member scans below without an allowlist. Known limits, accepted as
// cheap grep-based enforcement: an ALIAS (`const g = this.engine`) or a reach
// via `window.__engine.<member>` would evade the scan; no such code exists today.
const DEBUG_HATCH = /^\s*window\.__engine = session\.engine;/;

function displayFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SIM_PATH_NAMES.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...displayFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('display code consumes the engine only through the session/Game contract surface', () => {
  const files = displayFiles(DISPLAY_DIR);
  assert.ok(files.length >= 10, `expected display sources, found ${files.length} (moved?)`);
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    // Bare locals holding a Game instance (`const engine = new Game(...)`, and
    // reassignments): their member reaches are held to the same contract as
    // `.engine.<member>` chains, since demo surfaces hold engines as plain locals.
    const engineNames = new Set();
    for (const m of src.matchAll(/\b([$\w]+)\s*=\s*new\s+Game\s*\(/g)) engineNames.add(m[1]);
    const bareRe = engineNames.size
      ? new RegExp(`(?<![.\\w$])(${[...engineNames].join('|')})\\.([$\\w]+)`, 'g')
      : null;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (DEBUG_HATCH.test(line)) return;
      if (/\bsession\.engine\b/.test(line)) {
        violations.push(`${rel}:${i + 1} reaches session.engine (use the RaceSession query API)`);
        return;
      }
      for (const m of line.matchAll(/\.engine\.([$\w]+)/g)) {
        if (!ENGINE_CONTRACT.has(m[1])) violations.push(`${rel}:${i + 1} reaches .engine.${m[1]} (off the Game contract surface)`);
      }
      if (bareRe) {
        for (const m of line.matchAll(bareRe)) {
          if (!ENGINE_CONTRACT.has(m[2])) violations.push(`${rel}:${i + 1} reaches ${m[1]}.${m[2]} (off the Game contract surface)`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], 'engine-boundary leaks (add a query API instead of reaching in):\n  ' + violations.join('\n  '));
});
