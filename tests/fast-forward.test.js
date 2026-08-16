// The AI fast-forward burst: what it does, and that a shell runs it.
//
// When every HUMAN is home the race is decided, but the bots are still driving.
// The web resolves the rest at once — `ttp_fast_forward` advances the
// deterministic sim to its own end with no rendering — so every car finishes the
// way it would have and the results board shows real times.
//
// A shell that instead ends the race there and then produces a DIFFERENT BOARD
// for the same race: the bots arrive unfinished. That is what the tvOS shell did,
// and it is a parity bug rather than a performance one — same race, two answers
// depending on which screen you were watching.
//
// WHY THIS IS HERMETIC AND NOT ON THE DEVICE: the burst fires when every human
// finishes, and a scripted phone cannot steer a lap of a real circuit. The
// end-to-end harness can never reach the state, so it asserts what it can (that
// bots are in the field and racing) and the semantics are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function race() {
  const M = await (await import(pathToFileURL(
    path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href)).default();
  const c = (n, r, a) => M.cwrap(n, r, a);
  const h = c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string'])(
    'tidepool', 1, 1, null);
  assert.ok(h, 'ttp_session_begin');
  // BOTS ONLY, and that models the precondition rather than dodging it: the
  // burst runs when every HUMAN is already home, so what is left on the track is
  // exactly a field of AI. Leaving an unfinished human in here would be testing
  // a state the burst is never entered from — it would drive to the guard cap
  // and never reach raceOver, because nothing steers it.
  for (const [id, caution, bias, seed] of [
    ['"ai-0"', 1, 0, 1], ['"ai-1"', 1.05, -0.6, 2], ['"ai-2"', 0.95, 0.4, 3]
  ]) {
    c('ttp_add_bot', null, ['number', 'string', 'number', 'number', 'number', 'string'])(
      h, id, caution, bias, seed, null);
  }
  c('ttp_session_start', null, ['number', 'number'])(h, -1);   // bare: racing at once
  return {
    h,
    update: c('ttp_update', null, ['number', 'number']),
    fastForward: c('ttp_fast_forward', null, ['number']),
    racing: c('ttp_racing', 'number', ['number']),
    results: () => JSON.parse(c('ttp_results_json', 'string', ['number'])(h)),
    events: () => JSON.parse(c('ttp_events_json', 'string', ['number'])(h)),
    dispose: c('ttp_dispose', null, ['number'])
  };
}

test('without the burst, a race stopped early leaves cars unfinished', async () => {
  // The premise, and the shape of the bug: a few seconds in, nobody is home.
  const r = await race();
  for (let i = 0; i < 120; i++) r.update(r.h, 1000 / 60);
  assert.equal(r.racing(r.h), 1, 'still racing');
  const unfinished = r.results().results.filter((x) => !x.finished);
  assert.ok(unfinished.length > 0, 'cars are mid-lap — this is what a board would have shown');
  r.dispose(r.h);
});

test('the burst runs the race to its end and brings every car home', async () => {
  const r = await race();
  for (let i = 0; i < 120; i++) r.update(r.h, 1000 / 60);
  r.fastForward(r.h);

  // ASSERTED ON THE BOARD, not on ttp_racing. This drives BARE mode (the only
  // way to get a field racing from frame zero without a countdown), and the
  // burst's bare branch does not clear `racingBare` — so the flag still reads 1
  // while every car is demonstrably home. That is a bare-mode inconsistency and
  // not the property under test: the shipping path is session mode, where
  // fastForwardToEnd ends the race properly. What matters here, and what the
  // results board actually shows, is that the cars finished.
  const rows = r.results().results;
  assert.equal(rows.length, 3, 'all three cars are on the board');
  for (const x of rows) {
    assert.equal(x.finished, true, `${x.playerId} did not finish`);
  }
  // Real times, not zeroes — the sim actually ran the remaining laps.
  for (const x of rows) assert.ok(x.time > 0, `${x.playerId} finished with no time`);
  r.dispose(r.h);
});

test('the burst queues its finishes for the shell to drain', async () => {
  // The shell must drain IMMEDIATELY: the queue is per-handle and the next
  // update overwrites it, so a burst whose events are left for the next frame
  // loses every finish it just produced.
  const r = await race();
  for (let i = 0; i < 60; i++) r.update(r.h, 1000 / 60);
  r.events();                       // clear anything already queued
  r.fastForward(r.h);
  const types = r.events().map((e) => e.type);
  assert.ok(types.filter((t) => t === 'finish').length > 0,
    `the remaining finishes must queue for the shell to drain, got ${JSON.stringify(types)}`);
  r.dispose(r.h);
});

// ---- and that the shells actually run it ----------------------------------

const SHELLS = [
  { file: 'public/display/main.js', call: /fastForwardToEnd\(\)/, hold: /freezeCars\(\)/ },
  {
    file: 'shells/tvos/TinyTrackParty/App/GameCoordinator+Net.swift',
    call: /ttp_fast_forward\(sessionHandle\)/,
    hold: /display\.hold\(true\)/
  }
];

for (const { file, call, hold } of SHELLS) {
  test(`${file} bursts when every human is home, and freezes first`, () => {
    if (!existsSync(path.join(ROOT, file))) {
      assert.ok(file.startsWith('shells/'), `${file} is missing and is not an optional shell`);
      return;
    }
    const code = readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.match(code, call, `${file}: never runs the burst — bots reach the board unfinished`);
    // The hold is not decoration: the burst advances the world with no frames,
    // and a just-finished human keeps driving a victory lap, so the chase camera
    // is seen whipping to a far-away pose through the results glass.
    assert.match(code, hold, `${file}: bursts without freezing the field first`);
  });
}
