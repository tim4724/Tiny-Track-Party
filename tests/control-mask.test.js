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

test('the two masks produce genuinely different cars', async () => {
  // The discriminator that a device test CANNOT provide: a car auto-throttles
  // either way, so both cars move and only the STEERING differs. Anything that
  // watched a car "make progress" would pass with input entirely dead.
  const [off, on] = [await driveWithMask(0), await driveWithMask(1)];
  assert.notEqual(off.lat.toFixed(3), on.lat.toFixed(3),
    'the steered car should sit somewhere else across the road');
});

test('every shell DERIVES the mask from the fields, and reads no `mask` key', () => {
  // The web derives it in NativeRaceSession; tvOS derives it in the CONTROL
  // branch. Neither may read a `mask` off the message — there is none to read.
  // The web shell today; each TV shell adds its own file here as it lands.
  const sources = {
    'public/display/NativeRaceSession.js': readFileSync(
      path.join(ROOT, 'public/display/NativeRaceSession.js'), 'utf8')
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

    // Reading it off the message is the bug, in either language's spelling.
    assert.doesNotMatch(src, /msg\[["']mask["']\]|\bm\.mask\b|message\.mask\b/,
      `${name}: reads a \`mask\` off the CONTROL message — the wire carries none, ` +
      'so it is 0 on every sample and every field is silently discarded');

    // All three bits, each set from its own field being present.
    for (const bit of ['1', '2', '4']) {
      assert.match(src, new RegExp(`mask\\s*\\|=\\s*${bit}\\b`),
        `${name}: never sets presence bit ${bit} — that field can never reach a car`);
    }
  }
});
