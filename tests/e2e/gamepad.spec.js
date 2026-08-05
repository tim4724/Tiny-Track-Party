// @ts-check
// Pads on the TV, end to end: a gamepad takes a real seat, cycles the room's
// pick, starts the race and drives it — with no phone in the party at all.
//
// The unit suite (tests/gamepads.test.js) pins the button MAP against a faked
// net. What only this can prove is that a LOCAL seat is a real seat: that the
// peer-message walk seats a string-keyed id, that the roster, the pick and the
// launch treat it exactly like a phone's, and that nothing on the per-seat send
// path tries to address it over the relay.
const { test, expect, openDisplay, joinController, waitForRacing } = require('./helpers');

// A fake Gamepad API, installed OVER the empty one every display page gets (see
// openDisplay — the suite must not depend on what is paired to the machine
// running it). Applied after the page is up rather than as an init script,
// because Gamepads.js reads navigator per frame and the pads only matter once
// this spec adds them. `window.__pads` is the handle the cases poke.
const riggedDisplay = async (page) => {
  const roomCode = await openDisplay(page);
  await page.evaluate(() => {
    const mk = (index) => ({
      index, connected: true, mapping: 'standard',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0]
    });
    const pads = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__pads = {
      add: (i) => { pads[i] = mk(i); },
      remove: (i) => { pads[i] = null; },
      axis: (i, a, v) => { pads[i].axes[a] = v; },
      // Held for a few frames so the poll sees the edge, then released: a press
      // has to be visible across two polls to read as one.
      tap: async (i, b) => {
        pads[i].buttons[b] = { pressed: true, value: 1 };
        await sleep(120);
        pads[i].buttons[b] = { pressed: false, value: 0 };
        await sleep(150);
      }
    };
    navigator.getGamepads = () => pads;
  });
  return roomCode;
};

const A = 0, B = 1, START = 9, DPAD_D = 13, DPAD_R = 15;

// One button press on one pad. The constants stay on this side, so a case reads
// as buttons rather than as indices.
const tap = (page, index, button) =>
  page.evaluate(([i, b]) => window.__pads.tap(i, b), [index, button]);

const roster = (page) => page.evaluate(() => window.__net.flow.list()
  .map((p) => ({ id: p.peerIndex, name: p.name, car: p.carIndex, ready: p.ready })));

test('a pad-only party joins, picks, starts and drives', async ({ page }) => {
  await riggedDisplay(page);

  // Two pads appear and are IGNORED until someone presses something. A pad
  // paired to the machine and lying on the table is enumerated like any other,
  // and seating one would hand a seat (and possibly the host slot, which gates
  // everyone's start) to nobody at all.
  await page.evaluate(() => { window.__pads.add(0); window.__pads.add(1); });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__net.flow.size)).toBe(0);
  await expect(page.locator('#tagline')).not.toHaveClass(/has-pad/);

  await Promise.all([tap(page, 0, A), tap(page, 1, A)]);
  await page.waitForFunction(() => window.__net.flow.size === 2, null, { timeout: 5000 });
  expect((await roster(page)).map(({ id, name, ready }) => ({ id, name, ready }))).toEqual([
    { id: 'pad-0', name: 'Pad 1', ready: false },
    { id: 'pad-1', name: 'Pad 2', ready: false }
  ]);
  // Two seats, two liveries — the seat rule ran, it wasn't bypassed.
  expect(await page.evaluate(() => window.__net.flow.list().map((p) => p.colorIndex))).toEqual([0, 1]);
  // First in owns the host slot, exactly as a phone would.
  expect(await page.evaluate(() => window.__net.flow.host)).toBe('pad-0');
  // The lobby stops advertising pads once one has taken a seat.
  await expect(page.locator('#tagline')).toHaveClass(/has-pad/);

  // WHICH card is mine. The badge is the shell's own decoration (the room has
  // no notion of a local seat), zipped onto the model's rows by position — so
  // this is the case that catches the badges landing on the wrong cards.
  const seats = page.locator('#players .seat');
  await expect(seats.nth(0).locator('.seat__pad')).toHaveText('1');
  await expect(seats.nth(1).locator('.seat__pad')).toHaveText('2');
  await expect(seats.nth(0)).toHaveAttribute('data-pad', '1');
  // ...and the badge is on the card whose NAME is that pad's.
  await expect(seats.nth(1).locator('.seat__label')).toHaveText('Pad 2');

  // Pad 2 changes car (off whatever its seat default was) and readies up.
  const carWas = (await roster(page))[1].car;
  await tap(page, 1, DPAD_R);
  await tap(page, 1, A);
  const pad2 = (await roster(page))[1];
  expect(pad2.ready).toBe(true);
  expect(pad2.car).not.toBe(carWas);

  // The pick: phone-only UI otherwise, and the host's start is gated on it — so
  // a pad-only party would be stuck in the lobby without this step.
  await tap(page, 0, DPAD_D);
  await page.waitForFunction(() => window.__net.trackId != null, null, { timeout: 5000 });

  // Host confirms: the readiness half is refused (a host is never "ready"), the
  // start half is honoured.
  await page.evaluate(() => window.__sceneReady);
  await tap(page, 0, A);
  await waitForRacing(page);
  expect((await roster(page))[0].ready).toBe(false);
  // Both pads hold a car in the launched field.
  expect(await page.evaluate(() => window.__session().carIds().filter((id) => String(id).startsWith('pad-'))))
    .toEqual(['pad-0', 'pad-1']);

  // Drive: pad 0's stick held full right must land on pad 0's car as steer, and
  // on nothing else — the per-seat routing all the way into the sim.
  const steerOf = (id) => page.evaluate((carId) => {
    const c = window.__session().getSnapshot().cars.find((x) => x.id === carId);
    return c ? c.steerInput : null;
  }, id);
  await page.evaluate(() => window.__pads.axis(0, 0, 1));
  await page.waitForFunction(() => {
    const c = window.__session().getSnapshot().cars.find((x) => x.id === 'pad-0');
    return c && c.steerInput > 0.9;
  }, null, { timeout: 5000 });
  expect(await steerOf('pad-1')).toBe(0);
  await page.evaluate(() => window.__pads.axis(0, 0, 0));

  // Start pauses, and the pad can then walk the overlay — it has to be able to
  // reach the menu it raised (the poll runs ahead of the frame loop's frozen
  // guards for exactly this). The cursor opens on Continue.
  await tap(page, 0, START);
  await expect(page.locator('#pause-overlay')).toBeVisible();
  await expect(page.locator('#pause-continue')).toHaveClass(/is-cursor/);
  await tap(page, 0, DPAD_R);
  await expect(page.locator('#pause-newgame')).toHaveClass(/is-cursor/);
  await expect(page.locator('#pause-continue')).not.toHaveClass(/is-cursor/);
  // Back out rather than taking the highlighted (destructive) item, and the
  // cursor goes with the overlay.
  await tap(page, 0, B);
  await expect(page.locator('#pause-overlay')).toBeHidden();
  await expect(page.locator('#pause-newgame')).not.toHaveClass(/is-cursor/);

  // ...and the highlighted item is what a confirm actually takes: pause again,
  // walk to "New game", press A, land back in the lobby.
  await tap(page, 0, START);
  await tap(page, 0, DPAD_R);
  await tap(page, 0, A);
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
});

test('a pad and a phone share the same four seats', async ({ page, browser }) => {
  const roomCode = await riggedDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  await page.evaluate(() => window.__pads.add(0));
  await tap(page, 0, A);
  await page.waitForFunction(() => window.__net.flow.size === 2, null, { timeout: 5000 });

  // The pad sits beside the phone: distinct ids, distinct liveries, one roster.
  expect(await page.evaluate(() => window.__net.flow.list().map((p) => [p.peerIndex, p.colorIndex])))
    .toEqual([[1, 0], ['pad-0', 1]]);
  // Only the pad's seat is badged — the phone player is holding their own answer.
  await expect(page.locator('#players .seat').nth(0).locator('.seat__pad')).toHaveCount(0);
  await expect(page.locator('#players .seat').nth(1).locator('.seat__pad')).toHaveText('1');
  expect(await page.evaluate(() => window.__net.flow.host)).toBe(1); // the phone got there first

  // A guest pad cannot move the room's pick — the same host gate a guest phone hits.
  const pickBefore = await page.evaluate(() => window.__net.pick);
  await tap(page, 0, DPAD_D);
  expect(await page.evaluate(() => window.__net.pick)).toEqual(pickBefore);

  // Unplugging it hands the seat back, and the phone is untouched.
  await page.evaluate(() => window.__pads.remove(0));
  await page.waitForFunction(() => window.__net.flow.size === 1, null, { timeout: 5000 });
  expect(await page.evaluate(() => window.__net.flow.list().map((p) => p.peerIndex))).toEqual([1]);
  await alice.close();
});
