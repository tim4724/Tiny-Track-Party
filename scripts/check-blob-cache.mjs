// The derived-bytes cache, round-tripped through a real browser.
//
//   npm run check:blob-cache
//   node scripts/check-blob-cache.mjs --headed
//
// WHY THIS EXISTS AT ALL. Every suite in this tree is BLIND to the blob cache,
// and deliberately so: all three shells switch it off under automation, because
// a suite that asserts what a build produces must not be served what a previous
// run left behind (`Display.js`'s webdriver test, `GameCoordinator`'s
// `Scenarios.active` on Android and `Scenarios.requested` on tvOS). That rule is
// right and this does not change it — it spoofs `navigator.webdriver` the way
// the capture harnesses already do, so the cache is on for this one run.
//
// The cost of that blind spot was a shipped bug: an import that put the LAST
// offered blob's bytes into every silhouette layer, so the second visit to a
// page drew a monster-truck chassis under every car. A green suite, a review and
// a three-platform install all missed it, because the only thing that ever
// exercised the warm path was a person looking at a television.
//
// WHAT IT ASSERTS: an imported blob IS what was stored, byte for byte. The cold
// run bakes and stores; the warm run imports; then the store is emptied and the
// scene rebuilt, so the engine must EXPORT what it is HOLDING — which is the
// only way to see an imported blob from outside the wasm. No pixels are
// compared: a pixel diff of a live scene is noise (scripts/CLAUDE.md), and the
// bug was in the bytes anyway.
//
// AND IT PROVES THE WARM RUN ACTUALLY IMPORTED, because byte equality alone
// cannot: a blob the engine REFUSES is re-baked, and a deterministic field bakes
// the same bytes twice, so a walk that silently stopped importing would compare
// equal and pass. The engine says `shadow bake: REUSED` only when a resident
// bake answered — and on a page that has baked nothing yet, resident means
// imported.
//
// IT DRIVES ?solo RATHER THAN A `?scenario=` PAGE, and both halves of that
// matter. A scenario's `setTrack` rebuilds the PREVIEW scene — no cars, so no
// silhouettes to export, and this would compare one blob and pass. And its fake
// roster picks liveries per run, which the bake renders into the cell's RGB: two
// COLD runs of one scenario already disagree there, while the ALPHA vroad
// samples is identical. Solo seats a deterministic field, so whole blobs are
// comparable and no channel needs excusing.
//
// It is not an `npm test` entry: it drives a real Chromium through three scene
// builds, which is not what that suite is for.

import { serveApp, launchBrowser, displayURL, args as parseArgs } from './lib/capture.mjs';

const args = parseArgs();
// Generous, and it is the SCENE that needs it: a cold build compiles shaders and
// bakes a 2048² shadow map under software GL before the first frame.
const TIMEOUT_MS = 120_000;

const fail = (msg) => { console.error(`\n  FAIL  ${msg}`); process.exitCode = 1; };

/**
 * Wait for the page to be HOLDING STORES. Not `waitForScene`: nothing in the
 * tree sets the flag that one gates on, so it waits for fonts and no more.
 */
const waitForStores = (page) => page.waitForFunction(
  () => window.__scene?.display?.blobs?.stores?.length > 0, null, { timeout: TIMEOUT_MS });

/** Solo drops straight into a race, and the silhouettes bake as that scene builds. */
const waitForRoom = (page, state) => page.waitForFunction(
  (want) => window.__net?.roomState === window.ROOM_STATE[want], state, { timeout: TIMEOUT_MS });

/** A page in a solo race, with its console errors relayed. */
async function raceIn(ctx, port, onConsole) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [page error]', e.message));
  if (onConsole) page.on('console', (m) => onConsole(m.text()));
  await page.goto(displayURL(port, { solo: 1 }));
  await waitForStores(page);
  await waitForRoom(page, 'PLAYING');
  return page;
}

/**
 * Every blob the page is holding, as {store: {name: sha256}}.
 *
 * Digested IN THE PAGE rather than shipped over the bridge: the bake blob is
 * megabytes and the point is equality, not the bytes. Goes through the shell's
 * OWN BlobStore API (`entriesJson`/`read`), so this names no store and no blob
 * kind — the same rule the shells follow (`ttp_display.h`).
 */
async function digests(page) {
  return page.evaluate(async () => {
    const blobs = window.__scene?.display?.blobs;
    if (!blobs) throw new Error('no blob stores on this page — is navigator.webdriver still true?');
    const out = {};
    for (const { name, store } of blobs.stores) {
      out[name] = {};
      for (const e of JSON.parse(await store.entriesJson())) {
        const bytes = await store.read(e.name);
        if (!bytes) continue;
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        out[name][e.name] = [...new Uint8Array(hash)]
          .map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    }
    return out;
  });
}

const count = (d) => Object.values(d).reduce((n, s) => n + Object.keys(s).length, 0);

/**
 * Poll until EVERY store has answered and the total has stopped moving.
 *
 * Not "until there are N": the write half is a frame beat and the two stores do
 * not land on the same one, so a fixed number snapshots whichever arrived first
 * and silently drops the rest of the comparison. How many blobs there are is the
 * engine's business — a field of four models is four silhouettes, eight would be
 * more — so the only thing to wait for is "every store non-empty, twice running".
 */
async function settled(page, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = -1;
  let seen = {};
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    seen = await digests(page);
    const stores = Object.values(seen);
    const full = stores.length > 0 && stores.every((s) => Object.keys(s).length > 0);
    const n = count(seen);
    if (full && n === last) return seen;
    last = full ? n : -1;
  }
  throw new Error(`${what}: the stores never settled (held ${count(seen)} blob(s))`);
}

async function main() {
  const server = await serveApp();
  const chrome = await launchBrowser({ headed: !!args.headed });
  // ONE CONTEXT, TWO PAGE LOADS. IndexedDB is per context, so a second context
  // would be a second cold run and this would pass on a cache that never filled.
  // `realUser` (the default) is what turns the cache on at all.
  const ctx = await chrome.context();
  try {
    console.log('==> cold: a solo race, baking');
    const page1 = await raceIn(ctx, server.port);
    const cold = await settled(page1, 'cold');
    for (const [store, blobs] of Object.entries(cold)) {
      console.log(`    ${store}: ${Object.keys(blobs).length} stored`);
    }
    await page1.close();

    console.log('==> warm: the same race, served from the store');
    let reused = false;
    const page2 = await raceIn(ctx, server.port, (line) => { reused ||= /REUSED/.test(line); });
    if (!reused) {
      fail('the warm run never logged a REUSED bake — nothing was imported, so the'
        + ' comparison below would only be comparing one bake against another');
    }

    // EMPTY THE STORE, THEN REBUILD. The engine exports only what the store
    // lacks, so this is what makes it hand back the blobs it imported a moment
    // ago rather than the ones the run before baked.
    await page2.evaluate(async () => {
      for (const { store } of window.__scene.display.blobs.stores) {
        for (const e of JSON.parse(await store.entriesJson())) await store.delete(e.name);
      }
    });
    // Back to the lobby and out again IS a race-scene rebuild, cars and all;
    // `setTrack` alone rebuilds the preview, which has none. DebugSolo defers the
    // start until its own crossfade has settled, so there is nothing to sleep for.
    await page2.keyboard.press('KeyR');
    await waitForRoom(page2, 'LOBBY');
    await page2.keyboard.press('Enter');
    await waitForRoom(page2, 'PLAYING');
    const warm = await settled(page2, 'warm re-export');

    console.log('==> comparing');
    for (const [store, blobs] of Object.entries(cold)) {
      for (const [name, sha] of Object.entries(blobs)) {
        const got = warm[store]?.[name];
        if (!got) fail(`${store}/${name} was not written back — the engine is not holding it`);
        else if (got !== sha) {
          fail(`${store}/${name} came back DIFFERENT after a round trip\n`
            + `        stored   ${sha}\n        exported ${got}\n`
            + '        an imported blob must be the bytes that were stored — see importMaskBlob');
        }
      }
    }
    if (!process.exitCode) console.log(`\n  OK  ${count(cold)} blob(s) survived a full round trip\n`);
  } finally {
    await chrome.close();
    await server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
