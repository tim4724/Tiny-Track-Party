// Machine-readable attribution data for the licenses page (/licenses.html) —
// DATA ONLY (no DOM, no renderer), so it loads in the display, that page and
// Node tests alike. Everything third-party that SHIPS is recorded here or
// derives from game config.
//
// The page groups by TYPE: `section` is what the thing is (Music, 3D models,
// Fonts, …), in SECTION_ORDER.
//
// Each license also carries an OBLIGATION (see LICENSES), DERIVED from the
// license id and never typed per entry, so a new entry cannot claim a lighter
// duty than its license imposes. The page no longer groups by it, but it is
// what tests/credits.test.js holds us to: an entry whose license demands a
// notice must ship one.
//
// Songs are NOT listed here — they derive from musicCatalogue.js RACE_MUSIC via
// creditsFor(), so a change to the picks can never desync the page.
import { assetUrl } from './assetUrl.js';

// Every license anything shipped is under, hardest duty first.
//   attribution — the credit IS the license condition (CC-BY). Dropping it
//                 makes shipping a violation, not a cosmetic bug.
//   notice      — permissive, but the license text and its copyright line must
//                 travel with the build. An entry's `notice` is the served copy
//                 that discharges this; a bare upstream link does not.
//   courtesy    — CC0 asks for nothing; we credit anyway.
// `url` is the canonical text of the license itself (not the project).
export const LICENSES = {
  'CC-BY 4.0':    { obligation: 'attribution', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'SIL OFL 1.1':  { obligation: 'notice',      url: 'https://openfontlicense.org/open-font-license-official-text/' },
  'Apache-2.0':   { obligation: 'notice',      url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  'MIT':          { obligation: 'notice',      url: 'https://opensource.org/license/mit' },
  'BSD-3-Clause': { obligation: 'notice',      url: 'https://opensource.org/license/bsd-3-clause' },
  'CC0 1.0':      { obligation: 'courtesy',    url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
};

// Every obligation a license in LICENSES may carry.
export const OBLIGATION_IDS = ['attribution', 'notice', 'courtesy'];

// The order the page shows the types in: what the player heard and saw first,
// then what the game is built out of. A section with no entries is skipped, and
// an entry in no listed section is a test failure rather than a silent drop.
export const SECTION_ORDER = ['Music', '3D models', 'Sound effects', 'Fonts', 'Software'];

export function licenseInfo(id) {
  const info = LICENSES[id];
  if (!info) throw new Error(`unknown license '${id}' — add it to LICENSES in shared/credits.js`);
  return info;
}

// Everything third-party that ships and is NOT a song.
//
// `covers` is what this credit ACCOUNTS FOR in the tree, and is what stops the
// page going stale in either direction: tests/credits.test.js fails if a listed
// path is gone (the credit now describes something the build no longer
// contains) and if a third-party surface in the tree is named by no credit at
// all (something ships uncredited). Omit it only where there is nothing local
// to point at — Filament and Emscripten are pinned upstream and bake into the
// wasm, so they have no path of their own.
//
// `url` points at the work. `notice` is the served copy of the license text,
// and belongs on exactly the entries whose license DEMANDS one travel with the
// build — the page makes it the license chip's link there, so a `notice` on a
// CC0 entry would only send a reader to a file nothing obliged us to ship.
// tests/credits.test.js holds both halves: every notice-tier entry has one, and
// each resolves to a real file. They go through assetUrl() because they are OUR
// files: root-absolute would 404 anywhere the tree is hosted under a prefix,
// and this is the one link on the page that has to work.
export const ASSET_CREDITS = [
  {
    section: '3D models',
    title: 'Toy Car Kit 1.2',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://kenney.nl/assets/toy-car-kit',
    covers: ['public/assets/toycar/KENNEY-License.txt'],
  },
  {
    section: '3D models',
    title: 'Nature Kit 2.3 (desert and camp scenery)',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://kenney.nl/assets/nature-kit',
    covers: ['public/assets/toycar/KENNEY-License.txt'],
  },
  {
    section: '3D models',
    title: 'Holiday Kit 1.0 (the winter set dressing)',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://kenney.nl/assets/holiday-kit',
    covers: ['public/assets/toycar/KENNEY-License.txt'],
  },
  {
    section: 'Sound effects',
    title: 'Car Engine Loop (Car sound effects pack)',
    author: 'ggbotnet',
    license: 'CC0 1.0',
    url: 'https://opengameart.org/content/car-sound-effects-pack-low-quality',
    covers: [
      'public/assets/audio/engine_loop.LICENSE.txt',
      'public/assets/audio/engine_loop.ogg',
    ],
  },
  {
    section: 'Sound effects',
    title: 'Explosions (explosion3)',
    author: 'EZduzziteh',
    license: 'CC0 1.0',
    url: 'https://opengameart.org/content/explosions-4',
    covers: ['public/assets/audio/sfx/SFX.LICENSE.txt'],
  },
  {
    section: 'Fonts',
    title: 'Fredoka',
    author: 'Milena Brandão / Hafontia',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Fredoka',
    notice: assetUrl('/assets/fonts/OFL-Fredoka.txt'),
    covers: [
      'public/assets/fonts/OFL-Fredoka.txt',
      'public/assets/fonts/fredoka-variable.woff2',
    ],
  },
  {
    section: 'Fonts',
    title: 'Nunito',
    author: 'Vernon Adams et al.',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Nunito',
    notice: assetUrl('/assets/fonts/OFL-Nunito.txt'),
    covers: [
      'public/assets/fonts/OFL-Nunito.txt',
      'public/assets/fonts/nunito-variable.woff2',
    ],
  },
  {
    section: 'Software',
    title: 'Filament (the 3D renderer)',
    author: 'Google LLC',
    license: 'Apache-2.0',
    url: 'https://github.com/google/filament',
    notice: assetUrl('/assets/licenses/filament-LICENSE.txt'),
  },
  {
    section: 'Software',
    title: 'Emscripten (compiles the engine to wasm)',
    author: 'The Emscripten authors',
    license: 'MIT',
    url: 'https://emscripten.org',
    notice: assetUrl('/assets/licenses/emscripten-LICENSE.txt'),
  },
  {
    section: 'Software',
    title: 'openlibm (the sim’s deterministic math)',
    author: 'The Julia Project, from Sun’s fdlibm',
    license: 'MIT',
    url: 'https://github.com/JuliaLang/openlibm',
    notice: assetUrl('/assets/licenses/openlibm-LICENSE.md'),
    covers: ['native/vendor/fdlibm'],
  },
  {
    section: 'Software',
    title: 'double-conversion (number formatting)',
    author: 'Google LLC',
    license: 'BSD-3-Clause',
    url: 'https://github.com/google/double-conversion',
    notice: assetUrl('/assets/licenses/double-conversion-LICENSE.txt'),
    covers: ['native/vendor/double-conversion'],
  },
  {
    section: 'Software',
    title: 'qrcode-generator (join-code QR, in-browser)',
    author: 'Kazuhiko Arase',
    license: 'MIT',
    url: 'https://github.com/kazuhikoarase/qrcode-generator',
    notice: assetUrl('/assets/licenses/qrcode-generator-LICENSE.txt'),
    covers: ['public/shared/qrcode-generator.js'],
  },
];

// CC-BY 4.0 §3(a)(1) is discharged by the ROWS themselves: each names its
// creator, links its source and links the license. Nothing else is owed. In
// particular the shipped mp3s are the downloads re-encoded at a lower bitrate
// (assets/audio/music/SOURCES.json records each master), and that does NOT
// trigger §3(a)(1)(B)'s "indicate if You modified" duty — §2(a)(4) allows
// technical format changes and says they never produce Adapted Material. The
// long-form credit still lives in the static music/CREDITS.txt, which is what
// the no-JS fallback points at.

// Flatten a RACE_MUSIC map (audio/musicCatalogue.js) + the static entries into
// the page's shape: [{ section, entries: [{title, author, license, url,
// notice?, obligation, required}] }], sections in SECTION_ORDER. Songs dedup by
// title (a song may sit in several biome pools) and sort alphabetically.
// `obligation` and `required` are stamped from the license here, so no entry
// carries its own claim.
export function creditsFor(raceMusic) {
  const byTitle = new Map();
  for (const pool of Object.values(raceMusic)) {
    for (const s of pool) {
      byTitle.set(s.title, {
        section: 'Music', title: s.title, author: s.artist,
        license: s.license, url: s.source,
      });
    }
  }
  const music = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));

  const bySection = new Map();
  for (const e of [...music, ...ASSET_CREDITS]) {
    const { obligation } = licenseInfo(e.license);
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section).push({ ...e, obligation, required: obligation === 'attribution' });
  }
  return SECTION_ORDER
    .filter((section) => bySection.has(section))
    .map((section) => ({ section, entries: bySection.get(section) }));
}
