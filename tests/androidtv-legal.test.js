'use strict';
// The Android TV info board's legal data.
//
// tests/credits.test.js holds the WEB's attribution honest, and it cannot see
// this: its coverage walk reads public/assets, native/vendor and the eslint
// ignore list, and an .apk's contents appear in none of them. The APK ships four
// packages the browser never loads (a socket, a QR encoder, a widget toolkit and
// a standard library) and leaves behind two the browser needs (Emscripten's
// output, the in-page QR encoder), so its list is the shared credits plus a
// delta — shells/androidtv/scripts/gen-legal.mjs. This is that delta's gate, and
// it is the twin of tests/tvos-legal.test.js.
//
// The staged JSON is build output (app/src/main/assets/ is gitignored), so what
// is checked here is the generator's own data, which is what the bake is made
// of.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KOTLIN = path.join(ROOT, 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack');

let WEB_ONLY, ANDROID_ONLY, SHARED_NOTICES;
let entries, texts, legalLinks, document, gradleDependencies, LICENSES;
test.before(async () => {
  ({ WEB_ONLY, ANDROID_ONLY, SHARED_NOTICES, entries, texts, legalLinks, document,
    gradleDependencies } = await import('../shells/androidtv/scripts/gen-legal.mjs'));
  ({ LICENSES } = await import('../public/shared/credits.js'));
});

test('every Gradle dependency the APK packages is credited', () => {
  // The dependencies block is the registry, the way project.yml's packages block
  // is on tvOS: a line added there ships in the APK, and shipping it uncredited
  // is the failure this catches.
  const declared = gradleDependencies();
  assert.ok(declared.length > 0, 'no coordinates parsed out of app/build.gradle.kts');

  for (const coord of declared) {
    const credit = ANDROID_ONLY.find((e) => e.covers.some((p) => coord.startsWith(p)));
    assert.ok(credit, `${coord} ships in the APK and no credit in gen-legal.mjs covers it`);
    assert.ok(credit.notice, `${credit.title} carries no license text for the build to ship`);
  }
});

test('every text the list names has a source file, and it is intact', () => {
  const staged = texts();
  assert.ok(Object.keys(staged).length > 0, 'no texts at all — the APK would ship none');

  for (const [name, rel] of Object.entries(staged)) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `'${name}' points at ${rel}, which is not in the tree`);
    const text = fs.readFileSync(file, 'utf8');
    // A license text is only a notice while it is whole. This is the same shape
    // of check credits.test.js makes on the served copies.
    assert.ok(text.length > 500, `${rel} is too short to be a whole license text`);
    assert.match(text, /copyright|permission|licen[cs]e/i,
      `${rel} no longer reads as a license text`);
  }
});

test('the Android-only credits ride a known license and are listed once', () => {
  const titles = entries().map((e) => e.title);
  for (const e of ANDROID_ONLY) {
    assert.ok(e.title && e.author && e.url, `${e.title}: a credit needs what, who and where`);
    assert.ok(e.covers?.length, `${e.title} covers no Gradle coordinate — the gate above is blind`);
    assert.equal(titles.filter((t) => t === e.title).length, 1,
      `${e.title} appears on the board other than exactly once`);
    // The APK invents no license of its own: everything on it is in the shared
    // table, which is where the web derives obligations from.
    assert.ok(LICENSES[e.license],
      `'${e.license}' is not in credits.js LICENSES — add it there, not here`);
  }
});

test('what the .apk does not ship is off its list, and still in the shared credits', () => {
  // entries() throws if a WEB_ONLY prefix matches nothing, which is the real
  // assertion; stating it here makes the failure name its cause.
  assert.doesNotThrow(() => entries(),
    'a WEB_ONLY prefix matches no shared credit any more — a rename would '
    + 'silently put browser-only code back on the TV list');
  const listed = entries().map((e) => e.title);
  for (const prefix of WEB_ONLY) {
    assert.ok(!listed.some((t) => t.startsWith(prefix)),
      `${prefix} does not ship in the .apk but is on its licenses board`);
  }
});

test('the QR cards link the same legal pages the web footer does', () => {
  const links = legalLinks();
  const html = fs.readFileSync(path.join(ROOT, 'public/licenses.html'), 'utf8');
  // The licenses page carries the same footer (credits.test.js pins the two
  // identical), so finding both there proves the TV, the display and the page
  // point at one pair of URLs.
  for (const url of [links.privacy, links.imprint]) {
    assert.ok(html.includes(url), `the licenses page does not link ${url}`);
  }
});

test('every shared notice source is one of ours to ship', () => {
  for (const rel of Object.values(SHARED_NOTICES)) {
    assert.ok(rel.startsWith('public/'),
      `${rel} is staged into the APK but is not part of the served tree`);
  }
});

// The staged JSON is the whole contract between the generator and Legal.kt, and
// it is a JSON document rather than generated Kotlin — so nothing in the
// compiler holds the two halves together. These two tests are what does.
test('the staged document carries the keys Legal.kt reads', () => {
  const doc = document();
  const kotlin = fs.readFileSync(path.join(KOTLIN, 'Legal.kt'), 'utf8');
  const read = [...kotlin.matchAll(/opt(?:String|Str|JSONArray)\((?:e, )?"([a-zA-Z]+)"\)/g)]
    .map((m) => m[1]);
  assert.ok(read.length > 0, 'no keys parsed out of Legal.kt — has it stopped reading JSON?');

  const present = new Set([...Object.keys(doc), ...Object.keys(doc.entries[0])]);
  for (const key of read) {
    assert.ok(present.has(key), `Legal.kt reads '${key}', which the staged document has no key for`);
  }
});

// A television cannot follow the link a browser gets on the licence chip, so a
// row with no text behind it is terms the room cannot read. Every row has one,
// and the generator throws rather than baking one that does not.
test('every row on the board opens a text, and nothing in the document is null', () => {
  const staged = texts();
  for (const e of document().entries) {
    assert.ok(e.text, `'${e.title}' has no text for its row to open`);
    assert.ok(staged[e.text], `'${e.title}' opens '${e.text}', which nothing stages`);
  }
  // NO NULLABLE KEY, and that is what lets Legal.kt read this file with plain
  // `optString`. This platform's org.json answers the four-character string
  // "null" for an EXPLICIT JSON null and the fallback only for an ABSENT key
  // (see TtpJson.optStr), so a key that starts coming back null has to change
  // the Kotlin at the same time. This fails first if one does.
  const nulls = document().entries.flatMap(
    (e) => Object.entries(e).filter(([, v]) => v == null).map(([k]) => `${e.title}.${k}`));
  assert.deepEqual(nulls, [],
    'a row carries a null — read it with TtpJson.optStr in Legal.kt, not optString');
});
