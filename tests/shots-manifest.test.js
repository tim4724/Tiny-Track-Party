// The screenshot gallery's COVERAGE, not its pixels.
//
// What this can honestly assert is that every screen the game has is
// photographed, that every manifest entry points at a file that exists and is
// the size it claims, and that no file is orphaned. What it deliberately does
// NOT do is compare images.
//
// A pixel gate here would be a flake factory and would say less than it looks
// like it says. The display rasterizes a full Filament scene, which under
// headless Chromium goes through SwiftShader; the E2E config already carries
// `retries: 1` explicitly to absorb multi-second render stalls, and the suite
// runs at dpr 0.25 with the shadow bake skipped under `navigator.webdriver`. And
// the tvOS column is a photograph of a physical TV whose panel, output mode and
// colour pipeline are not the browser's — the two columns are not supposed to be
// identical, they are supposed to be COMPARABLE. Judging that is what a human
// looking at /gallery-shots.html is for.
//
// The orphan half is modelled on `tests/display-abi.test.js`'s rule about the
// GLB directory: an image nothing references is either dead weight or an
// unfinished wiring job, and the check is what makes you decide which.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Both of these are ES modules — galleryScenarios.js loads in a browser too,
// and shots.mjs is a build script. Reached the way every other CommonJS test
// here reaches them: one dynamic import, resolved once.

const SHOTS = path.join(ROOT, 'public/assets/shots');

// LOADED PER TEST, not at module scope. Both sources are ES modules
// (galleryScenarios.js loads in a browser too), so they arrive through a dynamic
// import — which means `captured` cannot be a `skip:` condition, because skip is
// evaluated when the test is DEFINED. The capture-dependent tests bail early
// instead, which reads the same and needs no top-level await.
let _ctx;
const ctx = async () => (_ctx ??= await (async () => {
  const url = require('node:url');
  const g = await import(url.pathToFileURL(
    path.join(ROOT, 'public/shared/galleryScenarios.js')).href);
  const sh = await import(url.pathToFileURL(path.join(ROOT, 'scripts/lib/shots.mjs')).href);
  const manifest = sh.readManifest(ROOT);
  return {
    GALLERY_SCENARIOS: g.GALLERY_SCENARIOS,
    SHOT_PLATFORMS: g.SHOT_PLATFORMS,
    manifest,
    captured: manifest.shots.length > 0
  };
})());

test('the scenario table has unique ids and a live harness key for each', async () => {
  const { GALLERY_SCENARIOS } = await ctx();
  const ids = GALLERY_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate scenario id');
  for (const s of GALLERY_SCENARIOS) {
    assert.ok(s.key, `${s.id}: no harness key`);
    assert.ok(s.title, `${s.id}: no title`);
  }
});

test('the live display gallery reads the shared table rather than its own', () => {
  // There is deliberately no second list to diff against: `gallery-display.js`
  // used to hold a `DISPLAY_CARDS` literal saying the same thing, and the two
  // rotted in opposite directions — the live gallery grew a replay button on
  // four screens the shared table never heard about, and the coverage checks
  // above stayed green because they only knew their own copy. So what is pinned
  // is the IMPORT: a page that re-inlines the table brings the drift back.
  const source = readFileSync(path.join(ROOT, 'public/gallery-display.js'), 'utf8');
  assert.match(source, /import\s+\{[^}]*GALLERY_SCENARIOS[^}]*\}\s+from\s+'\.\/shared\/galleryScenarios\.js'/,
    'gallery-display.js no longer imports the shared scenario table');
  assert.doesNotMatch(source, /DISPLAY_CARDS/,
    'gallery-display.js has a second scenario list again');
});

test('every manifest entry names a real file of the size it claims', async () => {
  const { SHOT_PLATFORMS, manifest, captured } = await ctx();
  // Nothing has been captured yet — the coverage claims below would be vacuous.
  if (!captured) return;
  for (const shot of manifest.shots) {
    assert.ok(SHOT_PLATFORMS.includes(shot.platform), `unknown platform ${shot.platform}`);
    const file = path.join(SHOTS, shot.file);
    assert.ok(existsSync(file), `${shot.file}: missing`);
    // The recorded byte count is what the gallery shows; a stale one means a
    // re-capture wrote the file without updating the manifest.
    assert.equal(statSync(file).size, shot.bytes, `${shot.file}: size drifted from the manifest`);
    assert.ok(shot.w > 0 && shot.h > 0, `${shot.file}: no dimensions`);
  }
});

test('every scenario has a web reference shot', async () => {
  const { GALLERY_SCENARIOS, manifest, captured } = await ctx();
  // Nothing has been captured yet — the coverage claims below would be vacuous.
  if (!captured) return;
  // The web column is the reference the other two are read against, so a gap
  // there makes the whole card meaningless rather than half-full.
  const web = new Set(manifest.shots.filter((s) => s.platform === 'web').map((s) => s.scenario));
  const missing = GALLERY_SCENARIOS.filter((s) => !web.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `no web shot for: ${missing.join(', ')} — run npm run shots:web`);
});

test('no shot names a scenario that no longer exists', async () => {
  const { GALLERY_SCENARIOS, manifest, captured } = await ctx();
  // Nothing has been captured yet — the coverage claims below would be vacuous.
  if (!captured) return;
  const known = new Set(GALLERY_SCENARIOS.map((s) => s.id));
  const orphans = manifest.shots.filter((s) => !known.has(s.scenario)).map((s) => s.file);
  assert.deepEqual(orphans, [], `shots for retired scenarios: ${orphans.join(', ')}`);
});

test('no image file is unreferenced by the manifest', async () => {
  const { SHOT_PLATFORMS, manifest, captured } = await ctx();
  // Nothing has been captured yet — the coverage claims below would be vacuous.
  if (!captured) return;
  const referenced = new Set(manifest.shots.map((s) => s.file));
  const onDisk = [];
  for (const platform of SHOT_PLATFORMS) {
    const dir = path.join(SHOTS, platform);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) onDisk.push(`${platform}/${f}`);
  }
  const orphans = onDisk.filter((f) => !referenced.has(f));
  assert.deepEqual(orphans, [], `image files nothing references: ${orphans.join(', ')}`);
});
