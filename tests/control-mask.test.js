// THE CONTROL PRESENCE-MASK: what it means, and that every shell derives it.
//
// `ttp_process_input(h, id, mask, s, b, u)` takes a PRESENCE bitmask — 1 = `s`
// is present, 2 = `b`, 4 = `u` — and leaves an absent field UNTOUCHED on the
// car. That is what makes a partial CONTROL legal, and it is also what makes a
// wrong mask completely silent: pass 0 and every field is skipped, so the call
// succeeds, the packet is accounted for, nothing errors, and the car simply
// never answers the phone.
//
// THE MASK IS NEVER ON THE WIRE. `public/controller/Net.js` sends
// `{s, b, u, type}` and nothing else; the mask is DERIVED by the receiving
// shell from which fields the message actually carries. The first TV shell read
// a `mask` key off the message instead, got nil on every sample, and steered no
// car at all — with every packet arriving and nothing erroring.
//
// Two things are pinned here, because neither is visible from the other side:
//   * the SEMANTICS, against the shipped wasm — mask 0 really does discard.
//     Without this, "derive the mask" reads like a style preference.
//   * that each shell DERIVES it. Only a source-level check can see that, and
//     the C++ cannot help: from inside the ABI a 0 mask is a legitimate
//     "nothing to apply", indistinguishable from a shell that lost the fields.
//     The list of shells below grows as each one lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// A short bare race with one human, steering held hard over, read back through
// the snapshot. Bare (`countdownSeconds < 0`) so it is racing from frame 0 and
// three seconds of frames is enough to separate the two answers.
async function driveWithMask(mask) {
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href);
  const M = await mod.default();
  const c = (n, r, a) => M.cwrap(n, r, a);

  const h = c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string'])(
    'tidepool', 1, 3, null);
  assert.ok(h, 'ttp_session_begin failed');
  c('ttp_add_human', null, ['number', 'string', 'string'])(h, '1', null);
  c('ttp_session_start', null, ['number', 'number'])(h, -1);

  const input = c('ttp_process_input', null,
    ['number', 'string', 'number', 'number', 'number', 'number']);
  const update = c('ttp_update', null, ['number', 'number']);
  for (let i = 0; i < 180; i++) {
    input(h, '1', mask, 1.0, 0, i);      // hard over, every frame
    update(h, 1000 / 60);
  }
  const car = JSON.parse(c('ttp_snapshot_json', 'string', ['number'])(h)).cars[0];
  c('ttp_dispose', null, ['number'])(h);
  return car;
}

test('mask 0 DISCARDS the steer — the failure mode is silent, not loud', async () => {
  const car = await driveWithMask(0);
  // Not an error, not a clamp, not a zero-steer car that still reacts: the
  // field is simply never written. This is why the tvOS bug produced a race
  // that looked completely normal and answered nothing.
  assert.equal(car.steerInput, 0,
    'mask 0 applied a steer — then the bug this test exists for would have been loud');
});

test('mask 1 applies the steer', async () => {
  const car = await driveWithMask(1);
  assert.equal(car.steerInput, 1, 'bit 1 should carry `s`');
  assert.notEqual(car.steer, 0, 'the car should actually be turning');
});

test('the call ANSWERS what it consumed, so the silence is at least askable', async () => {
  // The semantics above are the trap; this is the one lever a shell has against
  // it. `ttp_process_input` is void-shaped in spirit — the hot path has no error
  // handling and is not about to grow any — but it now returns the presence mask
  // it actually used, so a shell bringing its input path up can assert once
  // instead of learning the answer from a television.
  //
  // It does not PREVENT the bug (nothing forces a caller to look). The source
  // gate below is still what does that. What this buys is that the question has
  // an answer at all, which is what the first port lacked for its whole life.
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href);
  const M = await mod.default();
  const c = (n, r, a) => M.cwrap(n, r, a);
  const h = c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string'])(
    'tidepool', 1, 3, null);
  c('ttp_add_human', null, ['number', 'string', 'string'])(h, '1', null);
  c('ttp_session_start', null, ['number', 'number'])(h, -1);
  const input = c('ttp_process_input', 'number',
    ['number', 'string', 'number', 'number', 'number', 'number']);

  assert.equal(input(h, '1', 7, 1, 0, 1), 7, 'a full sample should report all three fields');
  assert.equal(input(h, '1', 1, 1, 0, 1), 1, 'a steer-only sample should report bit 1');
  // THE WHOLE POINT: the shipped bug's call is the one that answers 0.
  assert.equal(input(h, '1', 0, 1, 0, 1), 0,
    'mask 0 must answer 0 — that is the difference between silent and askable');
  // Stray high bits are masked off, so the answer is what was USED, never an echo.
  assert.equal(input(h, '1', 0xff, 1, 0, 1), 7, 'unknown bits should not come back');
  // The other silent way to steer nothing, and it cost the same kind of hour: a
  // mistyped identity used to be indistinguishable from a delivered packet.
  assert.equal(input(h, '999', 7, 1, 0, 1), -1, 'no such car should answer -1');
  assert.equal(input(h, '"1"', 7, 1, 0, 1), -1,
    'the STRING "1" is a different player from the number 1 — and says so');
  c('ttp_dispose', null, ['number'])(h);
});

test('the two masks produce genuinely different cars', async () => {
  // The discriminator that a device test CANNOT provide: a car auto-throttles
  // either way, so both cars move and only the STEERING differs. Anything that
  // watched a car "make progress" would pass with input entirely dead.
  const [off, on] = [await driveWithMask(0), await driveWithMask(1)];
  assert.notEqual(off.lat.toFixed(3), on.lat.toFixed(3),
    'the steered car should sit somewhere else across the road');
});

test('every shell DERIVES the mask from the fields, and reads no `mask` key', () => {
  // The web derives it in NativeRaceSession; tvOS and Android derive it in
  // their CONTROL branches. None may read a `mask` off the message — there is
  // none to read. The tvOS entry is why the source half of this test exists at
  // all: that shell read a `mask` key off the CONTROL message, got nil on
  // every sample, and steered no car for the life of the port — with every
  // packet arriving and nothing erroring.
  const sources = {
    'public/display/NativeRaceSession.js': readFileSync(
      path.join(ROOT, 'public/display/NativeRaceSession.js'), 'utf8'),
    'shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift': readFileSync(
      path.join(ROOT, 'shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift'), 'utf8'),
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt':
      readFileSync(path.join(ROOT,
        'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt'), 'utf8')
  };

  // Whole-file scope on purpose: `mask` appears in exactly one place in each of
  // these, so narrowing to a window around the call site only adds an anchor
  // that can drift (the first attempt at this landed on the cwrap TABLE and
  // reported the web as broken).
  for (const [name, raw] of Object.entries(sources)) {
    // CODE ONLY. Both files now carry a comment naming the bug — quoting the
    // wrong spelling is how you stop someone reintroducing it — and a check
    // that cannot tell a warning from the thing it warns about is worse than
    // no check.
    const src = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // Reading it off the message is the bug, in any language's spelling
    // (JS/Swift subscripts and members, Kotlin's org.json getters).
    assert.doesNotMatch(src,
      /msg\[["']mask["']\]|\bm\.mask\b|message\.mask\b|\b(?:opt|optInt|getInt)\(\s*"mask"\)/,
      `${name}: reads a \`mask\` off the CONTROL message — the wire carries none, ` +
      'so it is 0 on every sample and every field is silently discarded');

    // All three bits, each set from its own field being present
    // (`mask |= N` in JS/Swift, `mask = mask or N` in Kotlin).
    for (const bit of ['1', '2', '4']) {
      assert.match(src, new RegExp(`mask\\s*(?:\\|=\\s*${bit}|=\\s*mask\\s+or\\s+${bit})\\b`),
        `${name}: never sets presence bit ${bit} — that field can never reach a car`);
    }
  }
});
