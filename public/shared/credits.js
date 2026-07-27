// Machine-readable attribution data for the (future) in-game credits screen —
// DATA ONLY (no DOM, no renderer), so it loads in the display, the controller
// and Node tests alike. Everything third-party that SHIPS is recorded here or
// derives from game config; when the credits screen lands it should render
// `creditsFor(RACE_MUSIC)` and be done.
//
// Legal weight differs per section (each entry's `required` flag):
//  - Music is mostly CC-BY 4.0 → attribution is REQUIRED before public release
//    (CC0 songs ride along as courtesy credits). Songs are NOT listed statically
//    — they derive from display/Audio.js RACE_MUSIC via creditsFor(), so a
//    picks change can never desync the screen.
//  - CC0 entries (Kenney kit, OpenGameArt clips) need nothing; we credit anyway.
//  - OFL / Apache-2.0 keep their license files in-repo (assets/fonts/, the
//    Filament fork); the screen line is good practice, not the license mechanism.

export const ASSET_CREDITS = [
  {
    section: '3D models',
    title: 'Toy Car Kit 1.2',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://www.kenney.nl',
    required: false,
  },
  {
    section: '3D models',
    title: 'Nature Kit 2.3 (cacti, palms)',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://www.kenney.nl',
    required: false,
  },
  {
    section: '3D models',
    title: 'Holiday Kit 1.0 (snow trees)',
    author: 'Kenney',
    license: 'CC0 1.0',
    url: 'https://www.kenney.nl',
    required: false,
  },
  {
    section: 'Sound effects',
    title: 'Car Engine Loop (Car sound effects pack)',
    author: 'ggbotnet',
    license: 'CC0 1.0',
    url: 'https://opengameart.org/content/car-sound-effects-pack-low-quality',
    required: false,
  },
  {
    section: 'Sound effects',
    title: 'Explosions (explosion3)',
    author: 'EZduzziteh',
    license: 'CC0 1.0',
    url: 'https://opengameart.org/content/explosions-4',
    required: false,
  },
  {
    section: 'Fonts',
    title: 'Fredoka',
    author: 'Milena Brandão / Hafontia',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Fredoka',
    required: false,
  },
  {
    section: 'Fonts',
    title: 'Nunito',
    author: 'Vernon Adams et al.',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Nunito',
    required: false,
  },
  {
    section: 'Software',
    title: 'Filament (the 3D renderer)',
    author: 'Google LLC',
    license: 'Apache-2.0',
    url: 'https://github.com/google/filament',
    required: false,
  },
  {
    section: 'Software',
    title: 'node-qrcode (join-code QR, server-side)',
    author: 'Ryan Day',
    license: 'MIT',
    url: 'https://github.com/soldair/node-qrcode',
    required: false,
  },
];

// The credit line CC-BY 4.0 obliges us to show for the music (one line covers
// every CC-BY song since they share one author — see music/CREDITS.txt).
export const MUSIC_ATTRIBUTION_LINE =
  'Music by Kevin MacLeod (incompetech.com) — ' +
  'Licensed under Creative Commons: By Attribution 4.0 — ' +
  'https://creativecommons.org/licenses/by/4.0/';

// Flatten a RACE_MUSIC map (display/Audio.js) + the static entries into
// render-ready sections: [{ section, entries: [{title, author, license, url,
// required}] }]. Songs dedup by title (a song may sit in several biome pools)
// and sort alphabetically; `required` follows the license (CC-BY obliges the
// credit, CC0 songs are courtesy entries).
export function creditsFor(raceMusic) {
  const byTitle = new Map();
  for (const pool of Object.values(raceMusic)) {
    for (const s of pool) {
      byTitle.set(s.title, {
        section: 'Music', title: s.title, author: s.artist,
        license: s.license, url: s.source, required: /CC-BY/i.test(s.license),
      });
    }
  }
  const music = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));

  const sections = [];
  const bySection = new Map();
  for (const e of [...music, ...ASSET_CREDITS]) {
    if (!bySection.has(e.section)) {
      bySection.set(e.section, []);
      sections.push({ section: e.section, entries: bySection.get(e.section) });
    }
    bySection.get(e.section).push(e);
  }
  return sections;
}
