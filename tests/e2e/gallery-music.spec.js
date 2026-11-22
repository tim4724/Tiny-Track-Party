// @ts-check
// The music gallery (/gallery-music.html): every catalogue track listed by cup,
// a picked track's race running in the frame beside its songs (the one the
// game plays there, the draft's pick and options) with the race's own sound under
// the song, a candidate whose file is not on
// the server said to be missing, and a pick posted for that track. The draft,
// the candidate files and the picks endpoint are mocked: the real draft and
// candidates are local, and the real endpoint writes the checkout.
const { test, expect } = require('./helpers');

const DRAFT = {
  note: 'Test draft.',
  tracks: [{ track: 'cove', cup: 'beach', song: 'candidates/gone.mp3', why: 'A test pick.', options: ['bit_shift.mp3'] }],
  candidates: [{ file: 'candidates/gone.mp3', title: 'Gone Song', artist: 'Kevin MacLeod', license: 'CC BY 4.0',
                 url: '', page: '', dur: 150, lufs: -14, gain: 0.55, feel: 'bouncy', for: ['cove'] }]
};

test('music gallery: the tracks, a track\'s race and songs, and a pick', async ({ page }) => {
  await page.route('**/gallery-music-draft.json', (route) => route.fulfill({ json: DRAFT }));
  await page.route('**/assets/audio/music/candidates/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }));
  let posted = null;
  await page.route('**/api/review-music', async (route) => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: {} }); return; }
    posted = route.request().postDataJSON();
    await route.fulfill({ json: { pick: { song: posted.song, at: '2026-11-21T00:00:00.000Z' }, file: 'scratch/review/music-picks.json' } });
  });
  await page.goto('/gallery-music.html');

  // Every catalogue track, five cups of four.
  await expect(page.locator('.mu-track')).toHaveCount(20);
  await expect(page.locator('.mu-cup')).toHaveCount(5);

  // A picked track's race runs in the frame: that track, its field driving.
  await page.locator('.mu-track[data-track="cove"]').click();
  await expect(page.locator('.mu-track[data-track="cove"]')).toHaveClass(/is-on/);
  const race = page.frameLocator('#mu-frame');
  await expect(race.locator('#scene')).toBeVisible();
  const frame = page.frame({ url: /scenario=racing&track=cove/ });
  expect(frame).not.toBeNull();
  await frame.waitForFunction(() => window.__track?.id === 'cove' && window.__preview?.running(), null, { timeout: 60000 });
  const driven = () => frame.evaluate(() => window.__engine.getSnapshot().cars.find((c) => typeof c.id === 'number').totalS);
  const from = await driven();
  await expect.poll(driven, { timeout: 30000 }).toBeGreaterThan(from + 1);

  // Its songs: the one the game plays on this track, the draft's pick (its
  // file not on the server) and the option.
  await expect(page.locator('#mu-title')).toContainText('Cove');
  await expect(page.locator('#mu-today')).toContainText('In the game: Arroz Con Pollo');
  await expect(page.locator('.mu-track[data-track="cove"] span')).toHaveText('Arroz Con Pollo');
  const gone = page.locator('.mu-song[data-song="candidates/gone.mp3"]');
  await expect(gone.first()).toHaveClass(/is-missing/);
  await expect(gone.first().locator('.tag--missing')).toHaveText('missing');
  await expect(page.locator('.mu-song[data-song="bit_shift.mp3"] .tag--draft').first()).toHaveText('option');
  await expect(page.locator('.mu-song .tag--shipped')).not.toHaveCount(0);

  // Game sound (on by default): the race's own voices through its own bus,
  // started by a gesture on this page, held by Pause and cut by the switch.
  expect(frame.url()).toContain('sfx=1');
  await page.locator('.mu-song[data-song="bit_shift.mp3"] .play').first().click();
  const sound = () => frame.evaluate(() => {
    const a = window.__audio;
    return { state: a.ctx && a.ctx.state, gain: a.master ? a.master.gain.value : -1, voices: a._voices.size, music: !!a._music };
  });
  await expect.poll(async () => { const s = await sound(); return s.state === 'running' && s.gain > 0 && s.voices > 0; },
                    { timeout: 30000 }).toBe(true);
  await page.locator('#mu-pause').click();
  await expect.poll(async () => (await sound()).state).toBe('suspended');
  await page.locator('#mu-pause').click();
  await expect.poll(async () => (await sound()).state).toBe('running');
  await page.locator('#mu-sfx').click();
  await expect(page.locator('#mu-sfx')).toHaveText('Game sound: off');
  expect(await sound()).toMatchObject({ gain: 0, music: false });   // nor did the game start its own song
  // The same button stops the song; the race runs on.
  await page.locator('.mu-song[data-song="bit_shift.mp3"] .play').first().click();
  await expect(page.locator('#mu-now')).toHaveClass(/is-idle/);

  // A pick is posted for this track, with the note typed beside it.
  await page.locator('#mu-note').fill('warm and easy');
  await page.locator('.mu-song[data-song="bit_shift.mp3"] .use').first().click();
  await expect.poll(() => posted).toEqual({ track: 'cove', song: 'bit_shift.mp3', note: 'warm and easy' });
  await expect(page.locator('.mu-track[data-track="cove"] span')).toHaveText('✓ Bit Shift');
  await expect(page.locator('.mu-song[data-song="bit_shift.mp3"] .use').first()).toHaveText('Picked ✓');
  await expect(page.locator('#mu-pick')).toContainText('not in the game yet');
});
