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
    CAPTURED_SCENARIOS: g.CAPTURED_SCENARIOS,
    SHOT_PLATFORMS: g.SHOT_PLATFORMS,
    STORE_SCENARIOS: g.STORE_SCENARIOS,
    STORE_SHOT: g.STORE_SHOT,
    manifest,
    captured: manifest.shots.length > 0
  };
})());

test('the scenario table has unique ids and says how the web reaches each', async () => {
  const { GALLERY_SCENARIOS } = await ctx();
  const ids = GALLERY_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate scenario id');
  for (const s of GALLERY_SCENARIOS) {
    // A harness key, a standalone page, or a declared gap — exactly one. An
    // entry with none is a card the web camera cannot open; one with two is a
    // card whose web picture is ambiguous.
    const ways = [s.key, s.page, s.tvOnly].filter(Boolean).length;
    assert.equal(ways, 1, `${s.id}: needs exactly one of key / page / tvOnly`);
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

test('every CAPTURED scenario has a web reference shot', async () => {
  const { CAPTURED_SCENARIOS, manifest, captured } = await ctx();
  // Nothing has been captured yet — the coverage claims below would be vacuous.
  if (!captured) return;
  // The web column is the reference the other two are read against, so a gap
  // there makes the whole card meaningless rather than half-full — except where
  // the table itself says the web has no such screen, which is a TV-only card
  // read TV against TV.
  const web = new Set(manifest.shots.filter((s) => s.platform === 'web').map((s) => s.scenario));
  const missing = CAPTURED_SCENARIOS.filter((s) => !s.tvOnly && !web.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `no web shot for: ${missing.join(', ')} — run npm run shots:web`);
});

test('a liveOnly scenario is on the live page and out of every camera', async () => {
  // THE FLAG HAS TO KEEP WORKING, and the way it stops is silent: a capture
  // script re-imports the full table, starts shooting an instrument, and the
  // coverage gate above then DEMANDS the shot it just took. So what is pinned is
  // both halves — the derivation, and that every consumer with a camera reads the
  // derived list rather than the table.
  const { GALLERY_SCENARIOS, CAPTURED_SCENARIOS } = await ctx();
  const live = GALLERY_SCENARIOS.filter((s) => s.liveOnly).map((s) => s.id);
  assert.ok(live.length, 'no liveOnly scenario — delete this gate rather than leaving it vacuous');
  assert.deepEqual(
    CAPTURED_SCENARIOS.filter((s) => s.liveOnly).map((s) => s.id), [],
    'CAPTURED_SCENARIOS is no longer filtering liveOnly out');
  assert.equal(CAPTURED_SCENARIOS.length, GALLERY_SCENARIOS.length - live.length);

  for (const f of ['scripts/capture-shots.mjs', 'scripts/capture-shots-tvos.mjs',
                   'scripts/capture-shots-androidtv.mjs', 'public/gallery-shots.js']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bGALLERY_SCENARIOS\b/,
      `${f} reads the full table — it would photograph the instruments, and the web`
      + '-reference gate would then require a shot for each. Import CAPTURED_SCENARIOS.');
    assert.match(src, /\bCAPTURED_SCENARIOS\b/, `${f} reads neither list any more`);
  }

  // …and the live gallery reads the FULL table, which is the other half of the
  // flag meaning anything: an instrument is still a card you can look at.
  const live_src = readFileSync(path.join(ROOT, 'public/gallery-display.js'), 'utf8');
  assert.match(live_src, /\bGALLERY_SCENARIOS\b/,
    'gallery-display.js stopped reading the full table — the liveOnly cards would vanish');
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
  for (const entry of readdirSync(SHOTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // A directory for a platform id that no longer exists (the old per-leg
    // `tvos-sim/`) is dead weight the per-platform walk would never look in.
    assert.ok(SHOT_PLATFORMS.includes(entry.name), `${entry.name}/ is not a shot platform`);
    for (const f of readdirSync(path.join(SHOTS, entry.name))) onDisk.push(`${entry.name}/${f}`);
  }
  const orphans = onDisk.filter((f) => !referenced.has(f));
  assert.deepEqual(orphans, [], `image files nothing references: ${orphans.join(', ')}`);
});

test('the store listing is a gapless order the stores accept', async () => {
  const { STORE_SCENARIOS, GALLERY_SCENARIOS } = await ctx();
  // 1..n with no gap or repeat, so the zip's filenames are the listing order.
  assert.deepEqual(STORE_SCENARIOS.map((s) => s.store), STORE_SCENARIOS.map((_, i) => i + 1),
    'store positions must run 1..n');
  // Play takes at most eight screenshots per device type (the App Store ten).
  assert.ok(STORE_SCENARIOS.length >= 1 && STORE_SCENARIOS.length <= 8,
    `${STORE_SCENARIOS.length} store cards — Play accepts 1 to 8`);
  // A liveOnly card is never photographed, so it could never be in the listing.
  const lost = GALLERY_SCENARIOS.filter((s) => s.store && s.liveOnly).map((s) => s.id);
  assert.deepEqual(lost, [], `store cards no camera sees: ${lost.join(', ')}`);
});

// Pixel dimensions from the JPEG's first SOF marker (tests/artwork-manifest.test.js
// has the same walk, and says why it is not an image dependency).
function jpegSize(buf) {
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8, 'not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}

test('a store card is shot as STORE_SHOT and every other card as WebP', async () => {
  const { GALLERY_SCENARIOS, STORE_SHOT, manifest, captured } = await ctx();
  if (!captured) return;
  const byId = new Map(GALLERY_SCENARIOS.map((s) => [s.id, s]));
  for (const shot of manifest.shots) {
    const scenario = byId.get(shot.scenario);
    if (!scenario) continue;   // the retired-scenario gate above names it
    if (!scenario.store) {
      assert.match(shot.file, /\.webp$/, `${shot.file}: a gallery card is WebP`);
      continue;
    }
    // The stores check the pixels, so the header is read rather than the row.
    assert.match(shot.file, new RegExp(`\\.${STORE_SHOT.ext}$`), `${shot.file}: a store card is ${STORE_SHOT.ext}`);
    const got = jpegSize(readFileSync(path.join(SHOTS, shot.file)));
    assert.deepEqual(got, { w: STORE_SHOT.w, h: STORE_SHOT.h }, `${shot.file}: ${got.w}x${got.h}`);
    assert.deepEqual({ w: shot.w, h: shot.h }, got, `${shot.file}: the manifest's size is not the file's`);
  }
});

test('a TV shot says which device took it', async () => {
  const { manifest, captured } = await ctx();
  if (!captured) return;
  // One column per TV holds device and simulator shots side by side, so this
  // is the only record of which one a picture came from.
  for (const shot of manifest.shots.filter((s) => s.platform !== 'web')) {
    assert.ok(shot.deviceName, `${shot.file}: no deviceName`);
    assert.ok(['device', 'simulator', 'emulator'].includes(shot.deviceKind),
      `${shot.file}: deviceKind ${shot.deviceKind}`);
  }
});
