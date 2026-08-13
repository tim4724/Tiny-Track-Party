// @ts-check
// Shared helpers for the E2E suite. The app server is started with RELAY_URL
// pointing at the local stub (playwright.config.js), so every served page is
// already wired to it — no per-URL plumbing here. Each controller gets its
// OWN browser context so per-room clientIds (localStorage) don't collide —
// two pages in one context would evict each other's relay slot.
//
// Import `test`/`expect` from HERE, not @playwright/test: the extended test
// closes every context a spec opened, so leaked phone pages (rAF loops, 25 Hz
// CONTROL streams) can't starve the single worker across tests.

const base = require('@playwright/test');

const test = base.test.extend({
  // Auto fixture: after each test, reap every context the spec opened
  // (closing the built-in page's context twice is a safe no-op).
  _reapContexts: [async ({ browser }, use) => {
    await use(undefined);
    for (const ctx of browser.contexts()) await ctx.close();
  }, { auto: true }],
});

// Open the display, wait for its room + the 3D scene (startRace gates on
// sceneReady, so tests must not press Start before the GLBs are in).
async function openDisplay(page) {
  // Collapse the 3 s race countdown to a single beat under automation (mirrors
  // __abandonGraceMs). The countdown→GO→racing path still runs end to end, it
  // just resolves in ~1 s instead of ~3 s. Per-test time is dominated by the 3D
  // scene boot, not the countdown, so this is about surface, not wall clock.
  // The beats ride the render loop's dt (session.update), so a software-GL
  // render stall delays a beat but can never drop it: the whole-beats loop
  // catches up on the next frame. 1 is the floor: 0 never flips racing (see
  // RaceSession._stepCountdown: racing flips on the n=0 beat, which only fires
  // from update(dtMs), not on startCountdown's opening tick).
  await page.addInitScript(() => { window.__countdownSeconds = 1; });
  // Optional display query flags for the whole suite, e.g.
  //   TTP_DISPLAY_FLAGS=party=native npm run test:e2e
  // runs every spec with the room state machine on the C++ party layer (add
  // sim=native to also race on the native engine). Unset — the default, and what
  // CI runs — this is plain '/' and the JS kit. The few specs that navigate
  // themselves (device-chooser, couchpad-shell, welcome) are shell tests and
  // stay on the default path.
  const flags = process.env.TTP_DISPLAY_FLAGS || '';
  await page.goto(flags ? `/?${flags}` : '/');
  // Click through the welcome board (its NEW GAME carries the fullscreen/audio
  // unlocks — both harmless headless). Wait for the module first (__net is set
  // at its tail): the button is in the static HTML, so an instant click could
  // land before the listener attaches. The room warms behind the welcome, so
  // the roomCode wait below is unchanged.
  // The native stack is the only engine now, so this is an UNCONDITIONAL guard:
  // if a JS twin ever creeps back in (or the wasm silently fails to load), every
  // spec would still pass while testing something we no longer ship. Fail loud.
  //
  // Wait for BOTH halves to exist before sampling. `window.__net` and `__net.flow`
  // are there as soon as main.js publishes them, but `__net.party` is built inside
  // DisplayNet._connect(), which start() only reaches AFTER awaiting
  // _fetchBaseUrl() — a real network round-trip — and start() is not awaited. So
  // "__net exists" was never the condition this guard needed: it sampled mid-flight
  // and read conn === undefined, which JSON.stringify then dropped, producing the
  // baffling `got {"flow":"NativeRoomFlow"}`. That was the single biggest source of
  // e2e flake (3 of 4 flaky specs in one clean run).
  const nativeParty = () => {
    const n = window.__net;
    return !!(n && n.flow && n.party);
  };
  const snapshot = () => page.evaluate(() => ({
    flow: window.__net?.flow?.constructor?.name ?? null,
    conn: window.__net?.party?.constructor?.name ?? null
  }));
  try {
    await page.waitForFunction(nativeParty, null, { timeout: 15000 });
  } catch {
    throw new Error(`the native party layer never came up, got ${JSON.stringify(await snapshot())}`);
  }
  // Still asserted rather than merely awaited: a JS twin WOULD satisfy the wait
  // above, and must fail here instead of quietly being tested.
  const impls = await snapshot();
  if (impls.flow !== 'NativeRoomFlow' || impls.conn !== 'NativePartyConnection') {
    throw new Error(`expected the native party layer, got ${JSON.stringify(impls)}`);
  }
  await page.click('#newgame-btn');
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });
  await page.evaluate(() => window.__sceneReady); // evaluate awaits the returned Promise (GLB load)
  return page.evaluate(() => window.__net.roomCode);
}

// New phone: fresh context (own localStorage) + join through the name form.
// Returns the controller page. Does NOT assert which screen it lands on —
// a mid-race joiner lands on the waiting lobby, others on the normal lobby.
async function joinController(browser, roomCode, name) {
  // LANDSCAPE — the controller is landscape-only; a portrait viewport gets the
  // full-screen rotate overlay, which would sit over every button these specs click.
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  // Pre-seed the Settings popup's seen-flag so its first-run auto-show
  // doesn't cover the lobby and block ready/start clicks. These specs drive the
  // game flow (a returning player who's already dismissed it); the popup's own
  // coverage is the gallery 'settings' scenario. Key mirrors HELP_SEEN_KEY in prefs.js.
  await context.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
  });
  const page = await context.newPage();
  await page.goto(`/${roomCode}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#name.hidden', { state: 'attached', timeout: 15000 });
  return page;
}

// Ready up every non-host phone, then the host presses "Start race" (the
// button enables itself once everyone else is ready — Playwright's click
// auto-waits on that). Ready SURVIVES race → lobby and the button is a
// toggle, so only tap phones that aren't already ready — a blind click on a
// still-ready returning racer would un-ready them and deadlock the start.
// The host's bar is a STEPPER: on the CAR page it says "Select race" and only
// advances to the RACE page, so a host still there needs the extra tap. A spec
// that already switched tabs (to reach the picker) is on "Start race" already.
async function startRace(host, others) {
  for (const p of others) {
    const btn = p.locator('#ready-btn');
    if (!(await btn.evaluate((b) => b.classList.contains('is-pressed')))) await btn.click();
  }
  const hostBtn = host.locator('#ready-btn');
  if ((await hostBtn.textContent()) === 'Select race') await hostBtn.click();
  await hostBtn.click();
}

const visible = (sel) => `${sel}:not(.hidden)`;

// Wait for the display to flip into the live race (session.racing). The race
// starts on the "GO!" beat of a wall-clock countdown — but that countdown runs
// on the display's main thread, which in headless CI renders the full
// scene through SwiftShader (software GL). The first race frame there can stall
// for several seconds (lazy shader compile / first split-screen setup), and on a
// busy box the steady frames are slow too, blocking the 1 Hz countdown setInterval
// so the race starts many seconds late. The countdown is ~3 s on real hardware;
// this generous budget absorbs the software-render stall without masking a
// genuinely stuck start. (Skipping the sun's shadow bake under automation is
// what keeps that stall to seconds rather than tens: Stage.js turns it off on
// navigator.webdriver, through Display.shadows → ttp_display_shadows. The JS
// renderer did the same in environment.js, which the Filament port deleted
// along with the rest of that file — this replaces it.)
async function waitForRacing(displayPage, timeout = 45000) {
  await displayPage.waitForFunction(
    () => window.__session() && window.__session().racing, null, { timeout });
}

module.exports = { test, expect: base.expect, openDisplay, joinController, startRace, waitForRacing, visible };
