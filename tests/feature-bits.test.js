// One source per shared number: the TTP_FEAT_* ablation bits are declared in
// `native/runtime/ttp_display.h` and nowhere else, and every mirror is a
// hand-typed copy — Display.js's FEAT map, PerfDebug.kt's TTP_FEAT_ALL, and
// androidtv-live.mjs's default mask.
//
// THE FAILURE DIRECTION IS SILENT. A new TTP_FEAT bit lands in the header, the
// renderer gates a channel on it, and every stale ALL mirror masks that channel
// OFF: the web's "all" sweep arm ablates it on every run, and the Android
// knob's cleared-property restore (`debug.ttp.features 0`) puts back a picture
// with the channel missing. Nothing errors — the frame just draws one channel
// short, wearing a full-feature label. That is exactly how the web's FEAT table
// shipped without FOG: its ALL sat at 0xFFC against the header's 0x1FFC.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** `#define TTP_FEAT_<NAME> 0x<bits>` out of the one source. */
function headerBits() {
  const out = new Map();
  for (const m of read('native/runtime/ttp_display.h')
      .matchAll(/#define TTP_FEAT_([A-Z_]+)\s+0x([0-9A-Fa-f]+)/g)) {
    out.set(m[1], parseInt(m[2], 16));
  }
  assert.ok(out.has('ALL'), 'ttp_display.h no longer defines TTP_FEAT_ALL');
  assert.ok(out.size >= 12, `only ${out.size} TTP_FEAT_* defines — has the header moved?`);
  return out;
}

test('the header itself is closed: TTP_FEAT_ALL is the OR of every bit', () => {
  // The drift usually starts HERE — a new bit added without bumping ALL is the
  // stale mirror one commit early, in the file everything else copies.
  const bits = headerBits();
  let or = 0;
  for (const [name, v] of bits) if (name !== 'ALL') or |= v;
  assert.equal(bits.get('ALL'), or,
    `TTP_FEAT_ALL 0x${bits.get('ALL').toString(16)} is not the OR of the declared bits`
    + ` (0x${or.toString(16)}) — a bit it misses is masked off by every restore`);
});

test('Display.js FEAT mirrors the header, name for name and bit for bit', () => {
  const block = read('public/display/render/Display.js')
    .match(/export const FEAT = \{([\s\S]*?)\};/);
  assert.ok(block, 'Display.js FEAT has moved');
  const feat = {};
  for (const m of block[1].matchAll(/([A-Z_]+):\s*0x([0-9A-Fa-f]+)/g)) {
    feat[m[1]] = parseInt(m[2], 16);
  }
  assert.deepEqual(feat, Object.fromEntries(headerBits()),
    'Display.js FEAT disagrees with ttp_display.h — the header is the source');
});

test("PerfDebug.kt's TTP_FEAT_ALL matches the header", () => {
  // The value the knob restores when `debug.ttp.features` is cleared: stale, it
  // un-ablates a box into a picture that is still missing the new channel.
  const m = read('shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PerfDebug.kt')
    .match(/TTP_FEAT_ALL\s*=\s*0x([0-9A-Fa-f]+)/);
  assert.ok(m, 'PerfDebug.kt no longer declares TTP_FEAT_ALL');
  assert.equal(parseInt(m[1], 16), headerBits().get('ALL'),
    `PerfDebug.kt's TTP_FEAT_ALL 0x${m[1]} disagrees with ttp_display.h`);
});

test("androidtv-live.mjs defaults its mask to the header's ALL", () => {
  // The live harness's un-ablated arm: a stale default here measures every
  // "full picture" run one channel short.
  const m = read('scripts/androidtv-live.mjs')
    .match(/opt\('features',\s*'0x([0-9A-Fa-f]+)'\)/);
  assert.ok(m, "androidtv-live.mjs's --features default has moved");
  assert.equal(parseInt(m[1], 16), headerBits().get('ALL'),
    `androidtv-live.mjs defaults --features to 0x${m[1]}, which disagrees with ttp_display.h`);
});
