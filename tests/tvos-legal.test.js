'use strict';
// The tvOS info board's legal data.
//
// tests/credits.test.js holds the WEB's attribution honest, and it cannot see
// this: its coverage walk reads public/assets, native/vendor and the eslint
// ignore list, and an .ipa's contents appear in none of them. The tvOS bundle
// ships two packages the browser never loads (LiveKit's WebRTC binary and
// SwiftDraw) and leaves behind two the browser needs (Emscripten's output, the
// in-page QR encoder), so its list is the shared credits plus a delta —
// shells/tvos/scripts/gen-legal.mjs. This is that delta's gate.
//
// The generated Swift is build output (Generated/ is gitignored), so what is
// checked here is the generator's own data, which is what the bake is made of.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROJECT = path.join(ROOT, 'shells/tvos/project.yml');
const DERIVED = path.join(process.env.HOME || '', 'Library/Developer/Xcode/DerivedData');

let WEB_ONLY, TVOS_ONLY, SHARED_NOTICES, TVOS_NOTICE_UPSTREAM;
let entries, notices, legalLinks, LICENSES;
test.before(async () => {
  ({ WEB_ONLY, TVOS_ONLY, SHARED_NOTICES, TVOS_NOTICE_UPSTREAM, entries, notices, legalLinks } =
    await import('../shells/tvos/scripts/gen-legal.mjs'));
  ({ LICENSES } = await import('../public/shared/credits.js'));
});

test('every SPM package the app links is credited', () => {
  // The packages block is the registry: a dependency added there ships in the
  // .ipa, and shipping it uncredited is the failure this catches.
  const yml = fs.readFileSync(PROJECT, 'utf8');
  const block = /\npackages:\n([\s\S]*?)\n[a-z]/.exec(yml);
  assert.ok(block, 'project.yml has no packages: block to read');
  const urls = [...block[1].matchAll(/url:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0, 'no package urls parsed out of project.yml');

  for (const url of urls) {
    const credit = TVOS_ONLY.find((e) => e.url === url);
    assert.ok(credit, `${url} ships in the .ipa and no credit in gen-legal.mjs names it`);
    assert.ok(credit.notice, `${credit.title} carries no license text for the build to ship`);
  }
});

test('every notice the list names has a source file, and it is intact', () => {
  const staged = notices();
  assert.ok(Object.keys(staged).length > 0, 'no notices at all — the bundle would ship none');

  for (const [name, rel] of Object.entries(staged)) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `notice '${name}' points at ${rel}, which is not in the tree`);
    const text = fs.readFileSync(file, 'utf8');
    // A license text is only a notice while it is whole. This is the same shape
    // of check credits.test.js makes on the served copies.
    assert.ok(text.length > 500, `${rel} is too short to be a whole license text`);
    assert.match(text, /copyright|permission|licen[cs]e/i,
      `${rel} no longer reads as a license text`);
  }
});

test('the tvOS-only credits ride a known license and are listed once', () => {
  const titles = entries().map((e) => e.title);
  for (const e of TVOS_ONLY) {
    assert.ok(e.title && e.author && e.url, `${e.title}: a credit needs what, who and where`);
    assert.equal(titles.filter((t) => t === e.title).length, 1,
      `${e.title} appears on the board other than exactly once`);
    // zlib is the one license only this bundle uses; everything else has to be
    // in the shared table, which is where the web derives obligations from.
    assert.ok(e.license === 'zlib' || LICENSES[e.license],
      `'${e.license}' is not in credits.js LICENSES — add it there, not here`);
  }
});

test('what the .ipa does not ship is off its list, and still in the shared credits', () => {
  // entries() throws if a WEB_ONLY prefix matches nothing, which is the real
  // assertion; stating it here makes the failure name its cause.
  assert.doesNotThrow(() => entries(),
    'a WEB_ONLY prefix matches no shared credit any more — a rename would '
    + 'silently put browser-only code back on the TV list');
  const listed = entries().map((e) => e.title);
  for (const prefix of WEB_ONLY) {
    assert.ok(!listed.some((t) => t.startsWith(prefix)),
      `${prefix} does not ship in the .ipa but is on its licenses board`);
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

// A bumped dependency has to bring its license along, and for these two the
// original is not in the tree: SwiftPM owns it, under DerivedData. Where that
// checkout exists this diffs the committed copy against the version actually
// resolved — the same duty credits.test.js discharges for the vendored C by
// comparing bytes, run opportunistically because the source is not in git.
//
// A SKIP here is not a pass: on a machine that has never built the tvOS app
// (CI's web jobs), the only thing holding these texts current is the version
// bump going through Resources/Licenses/SOURCES.md.
test('the bundled SPM notices match the package version actually resolved', (t) => {
  const homes = fs.existsSync(DERIVED) ? fs.readdirSync(DERIVED) : [];
  const roots = homes
    .filter((d) => d.startsWith('TinyTrackParty-'))
    .map((d) => path.join(DERIVED, d, 'SourcePackages'))
    .filter((p) => fs.existsSync(p));
  if (!roots.length) {
    t.skip('no SwiftPM checkout on this machine — build the tvOS app to run this');
    return;
  }

  let compared = 0;
  for (const [name, rel] of Object.entries(TVOS_NOTICE_UPSTREAM)) {
    const upstream = roots.map((r) => path.join(r, rel)).find((p) => fs.existsSync(p));
    if (!upstream) continue;
    compared += 1;
    const ours = path.join(ROOT, 'shells/tvos/TinyTrackParty/Resources/Licenses', name);
    assert.ok(fs.readFileSync(ours).equals(fs.readFileSync(upstream)),
      `${name} has drifted from the resolved package — re-copy it from ${rel} `
      + '(and check whether the license itself changed)');
  }
  if (!compared) t.skip('the resolved packages carry no license at the recorded paths');
});

test('every shared notice source is one of ours to ship', () => {
  for (const rel of Object.values(SHARED_NOTICES)) {
    assert.ok(rel.startsWith('public/'),
      `${rel} is staged into the bundle but is not part of the served tree`);
  }
});
