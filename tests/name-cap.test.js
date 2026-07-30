// The display-name cap, in its two spellings.
//
// `public/shared/names.js` is the AUTHORED source and stays so: both browser
// pages import it, the phone half is permanent JS on all three TV platforms, and
// `tests/wire-compat.test.js` drives that exact function through a real wire.
// `ttp::session::clean_name_json` is the MIRROR a native shell reads instead of
// retyping `.trim().slice(0, 16)`. Until this export existed there was nothing
// behind names.js for C++ to call, so the first TV shell duly restated the rule
// — under a comment predicting that a third shell would type it a third time.
//
// This is the only place that can see both, so it is the whole gate — the same
// job `tests/config-drift.test.js` does for the protocol manifest. Without it
// the mirror is just a fourth copy with a nicer address.
//
// WHY THE CAP IS WORTH SHARING AT ALL, given it looks like one line: the two
// halves of it are not one line. `trim()` removes a Unicode set most languages'
// `strip()` does not match, and the cut is by UTF-16 CODE UNIT, which is JS's
// default and nobody else's. A shell that trims ASCII-only and cuts by byte or
// by code point disagrees with the phone about what the player is called, and
// the disagreement only shows up on names nobody tests with.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// names.js is an ES module and stays one — it loads in both browsers and Node,
// which is the property that lets the wire suite drive the REAL producer. So it
// arrives here the way every other CommonJS test in this tree reaches shared/:
// a dynamic import, resolved once.
let names;
let clean;
async function load() {
  names ??= await import(pathToFileURL(path.join(ROOT, 'public/shared/names.js')).href);
  return names;
}
async function abi() {
  if (clean) return clean;
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href);
  const M = await mod.default();
  const fn = M.cwrap('ttp_net_clean_name', 'string', ['string']);
  // The ABI takes the RAW JSON value, because a HELLO's `name` is untrusted and
  // JS stringifies rather than rejecting. Passing the JSON is what keeps a
  // number, a bool and an array distinguishable from their spellings.
  clean = (v) => fn(JSON.stringify(v) ?? 'null');
  return clean;
}

// Inputs chosen for the ways the two languages disagree by default, not for
// coverage of the happy path.
const CASES = [
  ['a plain name', 'Ada'],
  ['empty', ''],
  ['exactly the cap', 'abcdefghijklmnop'],
  ['one over the cap', 'abcdefghijklmnopq'],
  ['far over the cap', 'abcdefghijklmnopqrstuvwxyz'],
  ['leading and trailing ASCII space', '  Ada  '],
  ['tabs and newlines', '\t\nAda\r\n'],
  ['a NO-BREAK SPACE at each end', ' Ada '],
  ['a BOM at each end', '﻿Ada﻿'],
  // THE WHOLE ECMA-262 WhiteSpace + LineTerminator SET, one case each.
  //
  // This list held only NBSP and the BOM, and that gap hid a real divergence:
  // the C++ mirror reused a trim written for NUMBER parsing, which knows those
  // two and nothing else — correct there (an unrecognised space and a stray
  // letter both make NaN) and wrong here, where an unknown space simply STAYS in
  // the name and the two halves disagree about what the player is called. A
  // table with two entries could not see it.
  ["OGHAM SPACE MARK", " Ada "],
  ["EN QUAD (start of the U+2000 run)", " Ada "],
  ["EM SPACE (middle of it)", " Ada "],
  ["HAIR SPACE (end of the run)", " Ada "],
  ["LINE SEPARATOR", " Ada "],
  ["PARAGRAPH SEPARATOR", " Ada "],
  ["NARROW NO-BREAK SPACE", " Ada "],
  ["MEDIUM MATHEMATICAL SPACE", " Ada "],
  ["IDEOGRAPHIC SPACE", "　Ada　"],
  ["a mixed run of them", "　   Ada ﻿"],
  // NOT whitespace, and must survive: U+200B ZERO WIDTH SPACE is not stripped
  // by JS trim(). A mirror reaching for 'anything space-ish' would eat it.
  ["ZERO WIDTH SPACE is NOT trimmed", "​Ada​"],
  ['whitespace only', '   \t  '],
  ['trim happens BEFORE the cut', '   abcdefghijklmnop   '],
  ['a well-formed emoji inside the cap', 'Ada \u{1F3CE}'],
  ['accents (2-byte UTF-8, 1 UTF-16 unit)', 'Ådàm Ünderscøre Ñi'],
  ['CJK (3-byte UTF-8, 1 UTF-16 unit)', '走行走行走行走行走行走行走行走行走行'],
  ['null', null],
  ['a number', 42],
  ['a float', 1.5],
  ['true', true],
  ['an array', [1, 2]],
  ['an empty array', []],
  ['an object', { a: 1 }]
];

test('NAME_MAX is 16 in both spellings', async () => {
  // The C++ constant is not exported, so it is checked BEHAVIOURALLY: a 17-unit
  // name must come back 16 long.
  const { NAME_MAX } = await load();
  assert.equal(NAME_MAX, 16);
  const c = await abi();
  assert.equal([...(await c('abcdefghijklmnopq'))].length, 16);
});

for (const [label, input] of CASES) {
  test(`the C++ mirror agrees with names.js: ${label}`, async () => {
    const { cleanName } = await load();
    const c = await abi();
    assert.equal(c(input), cleanName(input),
      `names.js said ${JSON.stringify(cleanName(input))}, ` +
      `ttp_net_clean_name said ${JSON.stringify(c(input))}`);
  });
}

test('a cut that halves an emoji lands where the WIRE already lands', async () => {
  // THE ONE DOCUMENTED DIVERGENCE, and it is not a bug in the mirror.
  //
  // names.js cuts by UTF-16 unit, so this leaves a lone high surrogate. In JS
  // that survives in memory; on the WIRE it does not — JSON.stringify emits
  // \ud83c, json_parse writes 3-byte WTF-8, and the decoder replaces it. So the
  // C++ answer here is what a phone's own sliced name ALREADY becomes by the
  // time a display sees it (`tests/wire-compat.test.js` pins that path end to
  // end). Asserting raw equality instead would be asserting that C++ can hold a
  // lone surrogate, which is not a property anything wants.
  const { cleanName } = await load();
  const c = await abi();
  const js = cleanName('abcdefghijklmno\u{1F3CE}');
  assert.equal(js.charCodeAt(15), 0xd83c, 'the JS cut really does orphan a surrogate');
  assert.equal(c('abcdefghijklmno\u{1F3CE}'), 'abcdefghijklmno�');
  assert.notEqual(c('abcdefghijklmno\u{1F3CE}'), js);
});
