// THE HELD-ITEM ICONS ARE SHARED SVG FILES, drawn by every shell from the same
// bytes (`public/assets/items/<id>.svg`, ledger item 10). The web INLINES them
// into the DOM so CSS custom properties reach inside; a shell without CSS
// SUBSTITUTES the two tokens and rasterizes. What this suite holds together:
//
//   THE FILES        one SVG per item id, carrying the two recolour seams
//   ONE COPY         no shell re-draws the art in its own language
//   THE TWO SEAMS    --icon-accent (boost chevrons, ttp_theme_boost_icon) and
//                    --icon-car (monster cab, CAR_BODY_COLORS) — consumed on
//                    the web as CSS vars, substituted on tvOS before the
//                    rasterizer sees the file
//   THE BODY TONES   CAR_BODY_COLORS spelled per shell (JS + Swift + Kotlin)
//                    on purpose, and pinned here so the spellings cannot drift
//
// SOURCE CHECKS, because this is about what shells draw and there is no ABI in
// between to ask.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const ITEM_KEYS = ['boost', 'banana', 'rocket', 'monster'];

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Comment-stripped, so a mention in prose cannot satisfy a pin about code.
function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return read(rel).split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
}

// ---- the files ------------------------------------------------------------

test('one shared SVG per item id, and the two recolour seams are in the bytes', () => {
  for (const key of ITEM_KEYS) {
    assert.ok(existsSync(path.join(ROOT, `public/assets/items/${key}.svg`)),
      `no shared icon for ${key}`);
  }
  // The seams live in the FILES, where every shell inherits them — a colour
  // moved into shell code would recolour one platform and strand the others.
  assert.match(read('public/assets/items/boost.svg'), /var\(--icon-accent/,
    'the boost chevrons no longer stroke the biome accent seam');
  assert.match(read('public/assets/items/monster.svg'), /var\(--icon-car/,
    'the monster cab no longer fills the car-body seam');
});

test('the vocabulary here is the contract\'s', () => {
  // This suite spells the four keys locally (it runs in Node, where the wasm
  // vocabulary is a heavier reach than the pin deserves), so hold the spelling
  // against the one source rather than trusting it.
  const contract = read('public/display/engine/contract.js');
  const list = contract.slice(contract.indexOf('ITEM_IDS'));
  const ids = [...list.slice(0, list.indexOf(']')).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), [...ITEM_KEYS].sort(), 'ITEM_IDS moved');
});

// ---- one copy -------------------------------------------------------------

test('the vector art has exactly one copy, and it is the files', () => {
  // The art must not be re-drawn in any shell's own language: no inline <svg>,
  // no transcribed path data. (This pin once guarded a 300-line Swift path
  // parser out of existence; the baked-PNG era that followed is gone too.)
  for (const rel of ['public/display/Stage.js',
                     'shells/tvos/TinyTrackParty/Screens/ItemIcon.swift',
                     'shells/tvos/TinyTrackParty/Screens/RaceHUDView.swift']) {
    const src = shell(rel);
    if (src === null) continue;
    assert.doesNotMatch(src, /<svg/i, `${rel}: carries inline SVG markup`);
    assert.doesNotMatch(src, /"M[\d.]+[, ][\d.]+[A-Za-z\d .,-]{20,}"/,
      `${rel}: carries transcribed path data`);
  }
});

// ---- the web half ---------------------------------------------------------

test('the web fetches the shared files and inlines them', () => {
  const icons = read('public/shared/itemIcons.js');
  assert.match(icons, /\/assets\/items\/\$\{id\}\.svg/,
    'loadItemIcons no longer loads the shared files by item id');

  const stage = shell('public/display/Stage.js');
  assert.match(stage, /loadItemIcons/, 'Stage.js no longer uses the shared loader');
  // Inlining is what lets the two CSS custom properties reach inside.
  assert.match(stage, /--icon-accent/, 'the biome accent no longer reaches the chips');
  assert.match(stage, /--icon-car/, 'the car body tone no longer reaches the monster chip');
});

// ---- the tvOS half --------------------------------------------------------

test('tvOS stages the same files and substitutes the same two tokens', () => {
  const stage = shell('shells/tvos/scripts/stage-assets.sh');
  if (stage !== null) {
    assert.match(stage, /assets\/items/,
      'nothing stages the item SVGs, so every slot draws empty');
  }

  const src = shell('shells/tvos/TinyTrackParty/Screens/ItemIcon.swift');
  if (src === null) return;
  assert.match(src, /items\/\\\(key\)\.svg/,
    'the tvOS icon must load the shared file by item id — anything else is a '
    + 'platform copy of the artwork');
  // The ledger's rule for a shell that cannot evaluate CSS: substitute the
  // token, then rasterize.
  assert.match(src, /--icon-accent/, 'the boost accent seam is not substituted');
  assert.match(src, /--icon-car/, 'the car body seam is not substituted');
  assert.doesNotMatch(src, /renderingMode\(\.template\)/,
    'template tinting is the PNG era — the colour now rides the substituted '
    + 'token inside the SVG itself');
});

// ---- the body tones -------------------------------------------------------

test('CAR_BODY_COLORS is spelled the same in JS, Swift and Kotlin', () => {
  // A sanctioned per-shell spelling (like the cup tints): the values are
  // authored in shared/itemIcons.js, and each shell's table must match it entry
  // for entry, in CAR_MODELS order.
  const js = read('public/shared/itemIcons.js');
  const jsList = js.slice(js.indexOf('CAR_BODY_COLORS'));
  const jsColors = [...jsList.slice(0, jsList.indexOf(']')).matchAll(/'#([0-9a-fA-F]{6})'/g)]
    .map((m) => m[1].toLowerCase());
  assert.ok(jsColors.length > 0, 'CAR_BODY_COLORS has moved');

  const swift = shell('shells/tvos/TinyTrackParty/Screens/ItemIcon.swift');
  if (swift !== null) {
    // Slice from the literal's own `[` (the declaration's `[UInt32]` carries an
    // earlier `]` that would end the slice before the first entry).
    const decl = swift.slice(swift.indexOf('carBodyColors'));
    const open = decl.indexOf('= [');
    const swiftColors = [...decl.slice(open, decl.indexOf(']', open + 3)).matchAll(/0x([0-9a-fA-F]{6})/g)]
      .map((m) => m[1].toLowerCase());
    assert.deepEqual(swiftColors, jsColors,
      'the Swift body-tone table drifted from shared/itemIcons.js');
  }

  const kotlin = shell(
    'shells/androidtv/app/src/main/kotlin/com/couchgames/tinytrackparty/ItemIcon.kt');
  if (kotlin !== null) {
    const decl = kotlin.slice(kotlin.indexOf('CAR_BODY_COLORS'));
    const open = decl.indexOf('intArrayOf(');
    const kotlinColors = [...decl.slice(open, decl.indexOf(')', open)).matchAll(/0x([0-9a-fA-F]{6})/g)]
      .map((m) => m[1].toLowerCase());
    assert.deepEqual(kotlinColors, jsColors,
      'the Kotlin body-tone table drifted from shared/itemIcons.js');
  }
});

// ---- the slot -------------------------------------------------------------

test('the tvOS item slot draws the icon view, and its vocabulary is the ABI\'s', () => {
  const src = shell('shells/tvos/TinyTrackParty/Screens/RaceHUDView.swift');
  if (src === null) return;
  assert.match(src, /ItemIcon\(key:/,
    'the slot no longer draws the shared icon');
  assert.doesNotMatch(src, /Text\(Copy\.item\(/,
    'the slot is labelling items with words again');
  // Derived, not mirrored: a new item id must appear on the TV without a
  // Swift list to forget.
  assert.match(src, /ttp_item_id/,
    'the item vocabulary must be walked off the ABI');

  const web = shell('public/display/Stage.js');
  assert.match(web, /ITEM_IDS\.map\(/,
    'the web labels derive from the one vocabulary');
});
