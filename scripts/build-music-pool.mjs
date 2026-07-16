#!/usr/bin/env node
// HISTORICAL round-1 assembler — do NOT re-run against the live pool. It
// downloaded the original candidate set (Kenney Music Loops + Kevin MacLeod)
// and wrote _music-pool/manifest.json from scratch. The pool has since been
// hand-curated past what this script knows: the Kenney loops were CUT (too
// short for race music), round-2 candidates were added directly from
// incompetech's pieces.json, and manifest entries grew a `biome` field —
// re-running would resurrect the loops and clobber all of that. The committed
// manifest is the source of truth now; kept for provenance and as a template
// for a future sourcing round.
//
//   node scripts/build-music-pool.mjs
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Track length in whole seconds, so the gallery can show duration before play
// (the <audio> elements preload='none', so they'd otherwise read 0:00 until hit).
const probeDuration = (path) => {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim();
    const s = parseFloat(out);
    return Number.isFinite(s) ? Math.round(s) : 0;
  } catch (_) { return 0; }
};

const DIR = 'public/assets/audio/_music-pool';

const KENNEY_LOOPS = 'https://gamesounds.xyz/Kenney%27s%20Sound%20Pack/Music%20Loops/Loops/';
const KENNEY_RETRO = 'https://gamesounds.xyz/Kenney%27s%20Sound%20Pack/Music%20Loops/Retro/';
const KENNEY_SRC = 'https://kenney.nl/assets/music-loops';
const KM_MP3 = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
const KM_SRC = 'https://incompetech.com/music/royalty-free/music.html';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const enc = (s) => encodeURIComponent(s);

// Kenney Music Loops — CC0. `name` is the exact remote filename (sans .ogg);
// `dir` picks the Loops/ vs Retro/ subfolder. Curated to the bright/playful ones
// (the sad/spooky cuts in the pack are skipped — they don't fit a toy racer).
const kenney = (name, dir = KENNEY_LOOPS) => ({
  remote: dir + enc(name) + '.ogg',
  file: slug(name) + '.ogg',
  title: name,
  composer: 'Kenney',
  license: 'CC0',
  source: KENNEY_SRC,
});
// Kevin MacLeod — CC-BY 4.0. `name` is the exact Incompetech track title.
const km = (name) => ({
  remote: KM_MP3 + enc(name) + '.mp3',
  file: slug(name) + '.mp3',
  title: name,
  composer: 'Kevin MacLeod',
  license: 'CC-BY 4.0',
  source: KM_SRC,
});

const TRACKS = [
  // --- Kenney Music Loops (CC0) ---
  kenney('Alpha Dance'), kenney('Cheerful Annoyance'), kenney('Drumming Sticks'),
  kenney('Farm Frolics'), kenney('Flowing Rocks'), kenney('German Virtue'),
  kenney('Italian Mom'), kenney('Mishief Stroll'), kenney('Mission Plausible'),
  kenney('Night at the Beach'), kenney('Polka Train'), kenney('Space Cadet'),
  kenney('Swinging Pants'), kenney('Time Driving'), kenney('Wacky Waiting'),
  kenney('Game Over'),
  kenney('Retro Beat', KENNEY_RETRO), kenney('Retro Comedy', KENNEY_RETRO),
  kenney('Retro Polka', KENNEY_RETRO), kenney('Retro Reggae', KENNEY_RETRO),
  // --- Kevin MacLeod / Incompetech (CC-BY 4.0) ---
  km('Pixelland'), km('Carefree'), km('Monkeys Spinning Monkeys'), km('Wallpaper'),
  km('Fluffing a Duck'), km('Sneaky Snitch'), km('Spazzmatica Polka'),
  km('Beachfront Celebration'), km('Happy Bee'), km('Itty Bitty 8 Bit'),
  km('Hyperfun'), km('Run Amok'), km('Quirky Dog'), km('Cheery Monday'),
  km('Disco con Tutti'), km('Fast Talkin'), km('The Builder'),
  km('Jaunty Gumption'), km('Bumbly March'),
];

mkdirSync(DIR, { recursive: true });

let ok = 0, skipped = 0, failed = 0;
for (const t of TRACKS) {
  const dest = join(DIR, t.file);
  if (existsSync(dest) && statSync(dest).size > 1024) { skipped++; continue; }
  try {
    const res = await fetch(t.remote);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`too small (${buf.length}B)`);
    writeFileSync(dest, buf);
    ok++;
    console.log(`  ↓ ${t.file}  (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e) {
    failed++;
    console.warn(`  ✗ ${t.file}  ${e.message}  <= ${t.remote}`);
  }
}

const manifest = TRACKS.map(({ file, title, composer, license, source }) => ({
  file, title, composer, fastFile: '',
  duration: probeDuration(join(DIR, file)),
  license, source,
}));
manifest.sort((a, b) => a.title.localeCompare(b.title));
writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Plain-text credit block for the CC-BY tracks — what we'd paste into an
// in-game credits screen if a Kevin MacLeod track is chosen. CC0 (Kenney)
// needs nothing.
const credits =
  'Music candidates — credits & licenses\n' +
  '=====================================\n\n' +
  'Kenney Music Loops — CC0 1.0 (public domain, no attribution required)\n' +
  `  ${KENNEY_SRC}\n\n` +
  'Kevin MacLeod (incompetech.com) — Creative Commons Attribution 4.0 (CC-BY 4.0)\n' +
  '  Required credit line if shipped, e.g.:\n' +
  '  "<Track> by Kevin MacLeod | incompetech.com | Licensed under CC BY 4.0"\n' +
  `  ${KM_SRC}\n\n` +
  'Tracks:\n' +
  TRACKS.map((t) => `  [${t.license}] ${t.title} — ${t.composer}`).join('\n') + '\n';
writeFileSync(join(DIR, 'CREDITS.txt'), credits);

console.log(`\nWrote ${manifest.length} entries to ${DIR}/manifest.json`);
console.log(`Downloaded ${ok}, skipped ${skipped} (already present), failed ${failed}.`);
