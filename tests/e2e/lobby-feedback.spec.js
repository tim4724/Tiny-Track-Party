// @ts-check
// How the lobby answers a touch. Three things here have each broken at least
// once and none of them are visible to a unit test.
//
// The lobby corner's two steps are ONE element re-labelled, which makes it the
// place where "nothing moved" has to be proven rather than assumed. Two ways it
// has broken:
//
//   1. The press landed on "Select race" handed its release animation to
//      "Start race" on the page that press had just opened — a button springing
//      on arrival, never having been touched. Structurally impossible now: a
//      face change replaces the button's node, so there is nothing to inherit.
//      Still pinned, because that is one refactor away from coming back.
//   2. The back chip appearing on the race page re-centred the pair, so the
//      primary button jumped 46px sideways between the steps: you press one
//      thing and the next thing is not where your thumb is.
//
// Neither is reachable from the gallery — a scenario does not wire the host
// stepper — so this is the only place either can be caught.
const { test, expect, openDisplay, joinController } = require('./helpers');

// joinController's context has no touch, and TOUCH is what these need: a mouse
// fires click in the same task as mouseup, so :active is already released and a
// whole class of defect is invisible. On a finger the order is touchend,
// :active released, recalc, THEN click — and the corner's worst bug lived in
// exactly that gap.
async function joinByTouch(browser, roomCode, name) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {}
    setInterval(() => window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 0 })), 50);
  });
  const page = await ctx.newPage();
  await page.goto(`/${roomCode}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#name.hidden', { state: 'attached', timeout: 15000 });
  return page;
}
const tap = async (page, sel) => {
  const box = await page.locator(sel).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};

test('the corner does not move or animate when it steps to the race page', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinByTouch(browser, roomCode, 'Alice');

  const btn = alice.locator('#ready-btn');
  await expect(btn).toHaveText('Select race');

  await alice.evaluate(() => {
    window.__anim = [];
    const b = document.getElementById('ready-btn');
    for (const n of ['transitionstart', 'transitionend', 'transitioncancel']) {
      b.addEventListener(n, (e) => window.__anim.push(`${n}:${e.propertyName}@${b.textContent.trim()}`));
    }
    const r = b.getBoundingClientRect();
    window.__mid = Math.round(r.left + r.width / 2);
  });

  await tap(alice, '#ready-btn');
  await expect(btn).toHaveText('Start race');

  // Sampled at once, while the step is still on the lobby.
  const stepped = await alice.evaluate(() => {
    const of = (s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { name: cs.animationName, transform: cs.transform };
    };
    return {
      cls: document.getElementById('lobby').className,
      list: of('.racelist'), detail: of('.racedetail'),
      // The button is a NEW node per face, so it cannot inherit a press — no
      // muting, no snapping, nothing to time.
      faceIsFresh: document.getElementById('ready-btn').dataset.face
    };
  });
  expect(stepped.cls, 'the lobby should be mid-step').toContain('lobby--step');
  expect(stepped.list.name, 'the pick list fades in').toBe('lobby-step-in');
  expect(stepped.detail.name, 'the detail card fades in').toBe('lobby-step-in');
  // A FADE, not a slide: the step used to carry the content sideways.
  expect(stepped.list.transform, 'the content must not move as it fades').toBe('none');
  expect(stepped.detail.transform, 'the content must not move as it fades').toBe('none');
  expect(stepped.faceIsFresh, 'the corner wears the new page\'s face').toBe('race');

  // Now let the release the finger left behind have every chance to play, and
  // confirm the corner sat through all of it.
  await alice.waitForTimeout(400);
  const seen = await alice.evaluate(() => {
    const b = document.getElementById('ready-btn');
    const r = b.getBoundingClientRect();
    return {
      // NOTHING may animate under the new face. Narrowing this to transform
      // once let box-shadow and filter through, and a mouse-driven tap hid all
      // three: the release only escapes on a touch tap.
      anim: window.__anim.filter((s) => s.endsWith('@Start race')).join(' | '),
      transform: getComputedStyle(b).transform,
      shifted: Math.round(r.left + r.width / 2) - window.__mid,
      backShown: !document.getElementById('lobby-back').classList.contains('hidden'),
      settled: getComputedStyle(b).transitionProperty
    };
  });

  expect(seen.backShown, 'the race page should offer the way back').toBe(true);
  expect(seen.anim, 'nothing may animate under the new label').toBe('');
  expect(seen.transform, 'the button must arrive at rest, not mid-release').toBe('none');
  expect(seen.shifted, 'the primary button must not move between the two steps').toBe(0);
  expect(seen.settled, 'the new button transitions normally from here on').not.toBe('none');
});

test('the way back buzzes like every other tap', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');   // mouse is fine: this is about the buzz
  // Count vibrations rather than trust the call site: the back chip shipped
  // without one because the forward step buzzed at ITS call site instead of in
  // the shared path.
  await alice.evaluate(() => {
    window.__buzz = 0;
    navigator.vibrate = () => { window.__buzz++; return true; };
  });
  await alice.locator('#ready-btn').click();
  await expect(alice.locator('#ready-btn')).toHaveText('Start race');
  const afterForward = await alice.evaluate(() => window.__buzz);

  await alice.locator('#lobby-back').click();
  await expect(alice.locator('#ready-btn')).toHaveText('Select race');
  const afterBack = await alice.evaluate(() => window.__buzz);
  expect(afterBack, 'the back chip must confirm the tap too').toBeGreaterThan(afterForward);
  expect(await alice.evaluate(() => document.getElementById('lobby').className))
    .toContain('lobby--step');
});

// The live panel: during a swap the outgoing one is still in the card for a
// beat, laid over its replacement (trackPicker.js retireLayer), so anything
// asking about "the panel" has to say which.
const LIVE = '.modepick__tracks:not(.modepick__tracks--out)';

test('a pick tile plays its press through, and a cup swap cross-fades', async ({ page }) => {
  // No room needed: a scenario plus CSS. Both halves are gated because both
  // have failed. The press read as missing for two rounds — not because of its
  // duration but because buildModePicker destroyed the tile mid-animation, so
  // what matters is that the transition REACHES ITS END rather than being
  // cancelled and dropped. And the detail panel was rebuilt on every render
  // with its CONTENTS fading in from nothing, so every pick blanked the card to
  // its bare wash for a beat — a white flash on the pale cups.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/controller/index.html?scenario=lobby-race&color=0');
  const tile = page.locator('.mode-opt', { hasText: 'Canyon' });
  await tile.waitFor();

  await page.evaluate(() => {
    window.__ev = [];
    const t = [...document.querySelectorAll('.mode-opt')].find((n) => n.textContent.includes('Canyon'));
    for (const n of ['transitionstart', 'transitionend', 'transitioncancel']) {
      t.addEventListener(n, (e) => { if (e.propertyName === 'transform') window.__ev.push(n); });
    }
    // the fading element is the OUTGOING panel, which is a new node each swap,
    // so the listener has to be on the doc
    window.__fades = [];
    document.addEventListener('animationstart', (e) => {
      if (e.target.closest('.racedetail')) window.__fades.push(e.animationName);
    }, true);
  });

  const box = await tile.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(50);          // a real tap, not a held press
  await page.mouse.up();

  // The tile must come to REST, not vanish mid-press: a transition that starts
  // and is cancelled without ever restarting is the tile being rebuilt under
  // the finger, which is exactly how this broke.
  await expect.poll(() => page.evaluate(() => getComputedStyle(
    [...document.querySelectorAll('.mode-opt')].find((n) => n.textContent.includes('Canyon'))).transform),
  { message: 'the press must settle back to rest' }).toBe('none');
  const ev = await page.evaluate(() => window.__ev.join(' > '));
  expect(ev, `the press must play through, not be dropped: ${ev}`).toMatch(/transitionend$/);

  await page.locator('.mode-opt', { hasText: 'Snow Cup' }).click();
  await expect(page.locator(`${LIVE} .raceinfo__name`)).toHaveText('Snow Cup');
  expect(await page.evaluate(() => window.__fades.join(',')),
    'a cup swap should cross-fade rather than cut').toContain('swap-out');
  // The ARRIVING panel does not animate at all: it is opaque from its first
  // frame with the outgoing one fading off the top of it. Anything that fades
  // the incoming side in is the blank card coming back — and fading the panel
  // itself thins its tint toward the paper, which is the white flash that
  // started all this.
  expect(await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    return [p, ...p.children].map((n) => getComputedStyle(n).animationName).filter((n) => n !== 'none');
  }, LIVE), 'nothing on the arriving panel may fade in').toEqual([]);

  // A pick that only re-MARKS the panel must not swap it at all. Picking a
  // track changes one word of the meta line and one tile's fill; it used to
  // rebuild the whole panel, taking the tile out from under the thumb that
  // pressed it.
  await page.evaluate(() => {
    window.__swaps = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__swaps++;
    }).observe(document.querySelector('.racedetail'), { childList: true });
  });
  await page.locator(`${LIVE} .track-opt`).first().click();
  await expect(page.locator(`${LIVE} .raceinfo__meta`)).toContainText('Single race');
  expect(await page.evaluate(() => window.__swaps),
    'picking a track must re-dress the panel, never replace it').toBe(0);
});

test('one cup tap swaps the panel once, not once per render', async ({ page, browser }) => {
  // A tap renders the picker three times — the cursor moving, the pick landing,
  // and the display echoing that pick back — and each swap restarted the fade
  // mid-flight, so one tap blinked the panel three times. Only reachable here:
  // the gallery has no relay to echo, so it renders once and looks perfect.
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await alice.locator('#ready-btn').click();
  await expect(alice.locator('#ready-btn')).toHaveText('Start race');
  await alice.waitForTimeout(400);

  await alice.evaluate(() => {
    window.__swaps = 0;
    window.__cards = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (!n.classList) continue;
        if (n.classList.contains('modepick__tracks')) window.__swaps++;
        if (n.classList.contains('racedetail')) window.__cards++;
      }
    }).observe(document.getElementById('track-strip'), { childList: true, subtree: true });
  });
  await alice.locator('.mode-opt', { hasText: 'Snow Cup' }).click();
  await expect(alice.locator(`${LIVE} .raceinfo__name`)).toHaveText('Snow Cup');
  await alice.waitForTimeout(600);        // long enough for the display's echo
  expect(await alice.evaluate(() => window.__swaps),
    'the panel may be swapped once per tap, or its fade restarts mid-flight').toBe(1);
  expect(await alice.evaluate(() => window.__cards),
    'the card holding it is permanent — only the tinted panel is ever swapped').toBe(0);
});

test('picking a car re-dresses its card and cross-fades the render', async ({ page }) => {
  // The car page's half of the same rule. The card used to be rebuilt whenever
  // the selection moved, so the name, the stat bars and the render all cut at
  // once — and the fresh thumbnail re-ran its own still→spin handoff, flashing a
  // static hero before settling. Everything here is the card NOT being rebuilt:
  // the bars can only slide from one car's values to the next if they are the
  // same four elements throughout.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/controller/index.html?scenario=lobby-host&color=0');
  await page.waitForSelector('#car-hero .carthumb');

  const before = await page.evaluate(() => {
    const hero = document.getElementById('car-hero');
    window.__adds = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__adds++;
    }).observe(hero, { childList: true });
    window.__fades = [];
    document.addEventListener('animationstart', (e) => {
      if (e.target.closest('#car-hero')) window.__fades.push(e.animationName);
    }, true);
    // held by reference: the bars have to be the SAME nodes afterwards
    window.__bars = [...hero.querySelectorAll('.stat__bar > i')];
    return { name: hero.querySelector('.raceinfo__name').textContent,
      widths: window.__bars.map((i) => i.style.width) };
  });

  await page.locator('.car-opt').nth(3).click();
  await expect(page.locator('#car-hero .raceinfo__name')).not.toHaveText(before.name);
  // Two renders for a beat — the one you had, over the one you picked.
  await expect(page.locator('#car-hero .carthumb')).toHaveCount(2);
  await expect(page.locator('#car-hero .carthumb--out')).toHaveCount(1);

  const after = await page.evaluate(() => {
    const hero = document.getElementById('car-hero');
    return {
      adds: window.__adds,
      fades: window.__fades.join(','),
      sameBars: window.__bars.every((i, k) => i === hero.querySelectorAll('.stat__bar > i')[k]),
      widths: window.__bars.map((i) => i.style.width),
      // the bars carry a transition, which is what turns a new width into a slide
      moves: getComputedStyle(window.__bars[0]).transitionProperty
    };
  });
  expect(after.adds, 'the card is dressed, never rebuilt').toBe(0);
  expect(after.fades, 'the outgoing car fades off the incoming one').toContain('swap-out');
  expect(after.sameBars, 'the stat bars must survive the pick, or they cannot slide').toBe(true);
  expect(after.widths, 'the new car\'s stats are dressed onto them').not.toEqual(before.widths);
  expect(after.moves, 'a new width has to move rather than cut').toContain('width');

  // The retired render leaves on its own, and re-picking the SAME car swaps
  // nothing at all.
  await expect(page.locator('#car-hero .carthumb')).toHaveCount(1);
  await page.locator('.car-opt').nth(3).click();
  await page.waitForTimeout(200);
  await expect(page.locator('#car-hero .carthumb')).toHaveCount(1);
  expect(await page.evaluate(() => window.__adds), 'a repick must not touch the card').toBe(0);
});
