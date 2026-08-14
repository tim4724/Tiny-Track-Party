'use strict';
// Drift guard for the licenses page's data (/licenses.html): every shipped song
// must carry complete attribution fields, and creditsFor() must surface them all
// as required — CC-BY 4.0 makes missing music attribution a license violation,
// not a cosmetic bug. The rest of the file guards the two things the page can
// only get wrong silently: a notice link that 404s, and a legal footer that
// says one thing on the welcome board and another here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

let RACE_MUSIC, MUSIC_FALLBACK, MUSIC_TARGET_LUFS;
let ASSET_CREDITS;
let creditsFor, LICENSES, OBLIGATION_IDS, SECTION_ORDER;
test.before(async () => {
  ({ RACE_MUSIC, MUSIC_FALLBACK, MUSIC_TARGET_LUFS } = await import('../public/display/audio/musicCatalogue.js'));
  ({
    ASSET_CREDITS,
    creditsFor, LICENSES, OBLIGATION_IDS, SECTION_ORDER,
  } = await import('../public/shared/credits.js'));
});

test('every RACE_MUSIC song carries full attribution fields', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    assert.ok(pool.length > 0, `biome '${biome}' has an empty pool — delete the key instead`);
    for (const s of pool) {
      for (const field of ['file', 'title', 'artist', 'license', 'source']) {
        assert.ok(s[field], `${biome}: '${s.title || s.file}' is missing '${field}'`);
      }
    }
  }
  assert.ok(MUSIC_FALLBACK.length > 0, 'MUSIC_FALLBACK must never be empty (it is the no-silence guarantee)');
});

test('every song carries a loudness measurement and an attenuating gain', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    for (const s of pool) {
      assert.ok(Number.isFinite(s.lufs) && s.lufs < 0,
        `${biome}: '${s.title}' needs a measured integrated LUFS (see the ffmpeg recipe in Audio.js)`);
      assert.ok(s.gain > 0 && s.gain <= 1,
        `${biome}: '${s.title}' gain ${s.gain} outside (0, 1] — a pick quieter than ` +
        'MUSIC_TARGET_LUFS means the target (and MUSIC_LEVEL) need rebalancing');
    }
  }
});

// musicCatalogue.js bakes each `gain` as a LITERAL instead of evaluating
// `10 ** ((MUSIC_TARGET_LUFS - lufs) / 20)` at load, because `**` is V8's pow —
// implementation-approximated, disagreeing with the fdlibm the C++ port links on 2
// of the 23 shipped trims — and this number is recorded into audio-corpus.jsonl,
// which a port has to match bit-for-bit (docs/native-port/fp-profile.md §2).
// Literals are portable; the derivation is not. This re-runs it anyway so the
// literals stay honest: a typo or a new song carrying a stale trim fails here,
// while the recorded byte path keeps resting on a decimal both languages parse
// identically. The tolerance absorbs exactly the last-bit spread between two
// conforming pow implementations and nothing more — 1e-12 relative is ~4500 ULP,
// far under the 1e-3 a genuinely wrong trim would be off by.
test('each song gain is the LUFS trim it claims to be, without the byte path using pow', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    for (const s of pool) {
      const derived = 10 ** ((MUSIC_TARGET_LUFS - s.lufs) / 20);
      assert.ok(Math.abs(s.gain - derived) <= 1e-12 * derived,
        `${biome}: '${s.title}' gain ${s.gain} does not match its ${s.lufs} LUFS trim ` +
        `(expected ~${derived}). Re-derive with: node -e "console.log(10 ** ((${MUSIC_TARGET_LUFS} - ${s.lufs}) / 20))"`);
    }
  }
});

test('creditsFor() lists every unique song exactly once, as required credits', () => {
  const sections = creditsFor(RACE_MUSIC);
  const music = sections.find((s) => s.section === 'Music');
  assert.ok(music, 'a Music section exists');

  const uniqueTitles = new Set(Object.values(RACE_MUSIC).flat().map((s) => s.title));
  assert.equal(music.entries.length, uniqueTitles.size, 'one credit per unique song');
  for (const e of music.entries) {
    assert.equal(e.required, /CC-BY/i.test(e.license),
      `music credit '${e.title}' required-flag must follow its license (CC-BY = required)`);
    assert.ok(e.author && e.license && e.url, `music credit '${e.title}' is complete`);
  }
  assert.ok(music.entries.some((e) => e.required), 'the CC-BY songs keep their required credits');
});

test('static asset credits are complete', () => {
  for (const e of ASSET_CREDITS) {
    for (const field of ['section', 'title', 'author', 'license', 'url']) {
      assert.ok(e[field], `'${e.title || '?'}' is missing '${field}'`);
    }
  }
});

// Every entry's obligation comes from its license id, so this is really a check
// that no shipped work is under a license the table has never heard of —
// creditsFor() throws on one, and a new dependency is exactly when that
// happens. The obligation no longer shows on the page, but it is what the
// served-notice gate below keys on, so it still has to be right.
test('every credit rides a known license, and its obligation is that license’s', () => {
  const all = creditsFor(RACE_MUSIC).flatMap((s) => s.entries);
  const known = new Set(OBLIGATION_IDS);
  for (const e of all) {
    const info = LICENSES[e.license];
    assert.ok(info, `'${e.title}' is under '${e.license}', which is not in LICENSES`);
    assert.ok(known.has(info.obligation), `license '${e.license}' claims '${info.obligation}'`);
    assert.equal(e.obligation, info.obligation, `'${e.title}' obligation follows its license`);
    assert.equal(e.required, info.obligation === 'attribution');
  }
  for (const [id, info] of Object.entries(LICENSES)) {
    assert.match(info.url, /^https:\/\//, `license '${id}' needs a link to its own text`);
  }
});

// The page IS creditsFor(): every section it returns becomes a card, in order.
// A section missing from SECTION_ORDER would drop its works off the page
// silently, which for a credit is the one failure that matters.
test('creditsFor groups every credit into a listed section, in SECTION_ORDER', () => {
  const sections = creditsFor(RACE_MUSIC);

  const placed = sections.flatMap((s) => s.entries.map((e) => e.title)).sort();
  const expected = [
    ...new Set(Object.values(RACE_MUSIC).flat().map((s) => s.title)),
    ...ASSET_CREDITS.map((e) => e.title),
  ].sort();
  assert.deepEqual(placed, expected, 'every credit lands in exactly one section');

  assert.deepEqual(
    sections.map((s) => s.section),
    SECTION_ORDER.filter((name) => sections.some((s) => s.section === name)),
    'sections follow SECTION_ORDER, and empty ones are dropped');

  for (const s of sections) {
    assert.ok(s.entries.length > 0, `empty section '${s.section}' should have been dropped`);
    for (const e of s.entries) assert.equal(e.section, s.section);
  }
});

// A `notice` is the thing that discharges a permissive license, so a dead one is
// worse than none: the page claims the text ships when it does not.
// `notice` is an assetUrl() result, so under Node it is a file:// URL pointing
// straight at the file the browser would fetch — which makes this check exact
// rather than a re-derivation of where the path is supposed to land.
test('every license notice resolves to a file the server actually serves', () => {
  for (const e of ASSET_CREDITS) {
    if (!e.notice) continue;
    assert.match(e.notice, /^file:\/\//,
      `'${e.title}' notice must go through assetUrl(), got '${e.notice}'`);
    const file = url.fileURLToPath(e.notice);
    assert.ok(file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file),
      `'${e.title}' notice '${e.notice}' is not a file under public/`);
  }
  // The whole point of the 'notice' tier: shipping under one of those licenses
  // means shipping its text. No exceptions — a new dependency without a served
  // copy fails here rather than going live with a link where a notice belongs.
  const noNotice = ASSET_CREDITS.filter((e) => LICENSES[e.license].obligation === 'notice' && !e.notice);
  assert.deepEqual(noNotice.map((e) => e.title), [],
    'these need their license text served — add it under public/assets/licenses/ ' +
    'and record where it came from in that directory\'s SOURCES.md');

  // And the other way round, which is what keeps the license chip meaning one
  // thing. A notice on an entry that owes none used to appear or not purely on
  // whether a file happened to exist, so two CC0 works sat under the same
  // license showing different links.
  const owesNone = ASSET_CREDITS.filter((e) => LICENSES[e.license].obligation !== 'notice' && e.notice);
  assert.deepEqual(owesNone.map((e) => e.title), [],
    'these licenses demand no notice, so the chip should link the canonical text');
});

// ── The census ────────────────────────────────────────────────────────────
// Everything above checks that the credits are well-FORMED. This checks they
// are still TRUE, which is the way this page actually rots: nobody edits it, so
// it decays when the build changes underneath it. Both directions matter, and
// the tree has told us so — the QR encoder moved into the browser and the page
// went on serving the old package's notice for code that had left the build.
//
// Discovery is narrow ON PURPOSE, and each rule keys off something the tree
// maintains for its own reasons rather than a second list that could rot too:
//   - a third-party asset arrives WITH its license file, so those files mark it
//   - vendored C lives in native/vendor/<name>
//   - vendored browser JS is exactly what lint refuses to touch (it is upstream
//     style, not ours), so eslint's ignore list is the registry
//   - an npm runtime dependency ships with the server
// It does NOT discover: anything baked in from a pinned upstream (Filament,
// Emscripten) — those have no path here, and SOURCES.md carries them instead.
async function thirdPartySurfaces() {
  const found = new Set();

  const assets = path.join(PUBLIC_DIR, 'assets');
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      // public/assets/licenses/ is OUR served copies, not an arriving asset.
      if (d.isDirectory()) { if (full !== path.join(assets, 'licenses')) walk(full); }
      else if (/licen[cs]e|^OFL|COPYING/i.test(d.name)) found.add(path.relative(ROOT, full));
    }
  };
  walk(assets);

  for (const d of fs.readdirSync(path.join(ROOT, 'native/vendor'), { withFileTypes: true })) {
    if (d.isDirectory()) found.add(`native/vendor/${d.name}`);
  }

  const eslint = (await import('../eslint.config.mjs')).default;
  for (const block of eslint) {
    for (const ig of block.ignores || []) {
      if (ig.startsWith('public/') && ig.endsWith('.js') && !ig.includes('*')) found.add(ig);
    }
  }
  return found;
}

test('every third-party surface in the tree is credited, and every credit still has one', async () => {
  // Direction 1: a credit may not describe something that has left the build.
  for (const e of ASSET_CREDITS) {
    for (const rel of e.covers || []) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)),
        `'${e.title}' claims to cover '${rel}', which is not in the tree — either the ` +
        'credit is stale (drop it, and its served notice) or the path moved');
    }
  }

  // Direction 2: nothing third-party may ship uncredited.
  const covered = new Set(ASSET_CREDITS.flatMap((e) => e.covers || []));
  const uncovered = [...await thirdPartySurfaces()].filter((s) => !covered.has(s)).sort();
  assert.deepEqual(uncovered, [],
    'these are third-party and no credit in shared/credits.js names them in `covers`');

  // An npm runtime dependency is shipped code too. (There are none today: the
  // server has no runtime deps at all. This is the gate for the first one.)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    assert.ok(ASSET_CREDITS.some((e) => e.title.includes(name) || e.url.includes(name)),
      `runtime dependency '${name}' ships with the server and is credited nowhere`);
  }
});

// Served notices whose original is IN this tree are copies of it, and a bumped
// dependency has to bring its license along. (The Filament and Emscripten texts
// are fetched from their pinned upstream and have no local original to compare
// against — public/assets/licenses/SOURCES.md carries that obligation instead.)
test('the served notices are byte-identical to the sources they were copied from', () => {
  const copies = [
    ['native/vendor/fdlibm/LICENSE.md', 'public/assets/licenses/openlibm-LICENSE.md'],
    ['native/vendor/double-conversion/LICENSE', 'public/assets/licenses/double-conversion-LICENSE.txt'],
  ];
  for (const [src, served] of copies) {
    assert.ok(fs.readFileSync(path.join(ROOT, src)).equals(fs.readFileSync(path.join(ROOT, served))),
      `${served} has drifted from ${src} — re-copy it`);
  }
});

// The QR encoder is VENDORED as source, so its license has no standalone
// original in the tree to diff against — the notice is a comment inside the
// file. Tie the two by their copyright line instead: re-vendoring a different
// encoder (this was node-qrcode by Ryan Day until the encoding moved into the
// browser) leaves the served text crediting the wrong author, and shipping
// someone else's MIT notice discharges nothing.
test('the served QR license is the license of the QR encoder we actually vendor', () => {
  const served = fs.readFileSync(
    path.join(PUBLIC_DIR, 'assets/licenses/qrcode-generator-LICENSE.txt'), 'utf8');
  const vendored = fs.readFileSync(path.join(PUBLIC_DIR, 'shared/qrcode-generator.js'), 'utf8');
  const copyright = served.match(/^Copyright \(c\).*$/m);
  assert.ok(copyright, 'the served text must carry a copyright line');
  assert.ok(vendored.includes(copyright[0]),
    `the vendored encoder does not carry "${copyright[0]}" — re-fetch the LICENSE of ` +
    'whatever is actually vendored (see public/assets/licenses/SOURCES.md)');
});

// A license text is only a notice while it is intact. Nothing may reformat,
// truncate or annotate one, so check each still reads as the license it claims.
test('every served license text is intact', () => {
  const marks = {
    'openlibm-LICENSE.md': /Permission is hereby granted, free of charge/,
    'double-conversion-LICENSE.txt': /Redistributions of source code must retain/,
    'qrcode-generator-LICENSE.txt': /The above copyright notice and this permission notice/,
    'filament-LICENSE.txt': /Apache License[\s\S]*Version 2\.0, January 2004/,
    'emscripten-LICENSE.txt': /University of Illinois\/NCSA Open Source License/,
  };
  const dir = path.join(PUBLIC_DIR, 'assets', 'licenses');
  for (const [file, mark] of Object.entries(marks)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(text, mark, `${file} no longer reads as the license it stands in for`);
    assert.ok(text.length > 500, `${file} is too short to be a whole license text`);
  }
  // Nothing but the texts and their provenance note lives in that directory —
  // a stray file there would be served as if it were a notice.
  assert.deepEqual(fs.readdirSync(dir).sort(), [...Object.keys(marks), 'SOURCES.md'].sort());
});

// The legal footer is copied rather than built: on the welcome board, in the
// lobby (the AirConsole boot screen, which has no welcome board) and on the
// licenses page, all three as plain markup on purpose — a footer that needs JS
// to name its imprint is a footer that can fail to. This is what keeps the
// copies one footer. EVERY .site-foot is checked, so a fourth copy is pinned
// the moment it appears.
test('every legal footer carries the same four links', () => {
  const footersOf = (rel) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
    const found = [...html.matchAll(/<footer class="site-foot[^"]*">([\s\S]*?)<\/footer>/g)]
      .map((m) => m[1]);
    assert.ok(found.length, `${rel} has no .site-foot footer`);
    return found;
  };
  const want = [
    'https://github.com/tim4724/Tiny-Track-Party',
    '/licenses.html',
    'https://couchpad.games/en/privacy',
    'https://couchpad.games/en/imprint',
  ];

  for (const rel of ['display/index.html', 'licenses.html']) {
    for (const foot of footersOf(rel)) {
      assert.match(foot, /Developed by Tim/, `${rel} names the developer`);
      assert.deepEqual([...foot.matchAll(/href="([^"]+)"/g)].map((h) => h[1]), want,
        `${rel} links the repo, licenses, privacy and imprint, in that order`);
    }
  }
});
