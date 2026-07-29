#!/usr/bin/env node
// fetch-music.mjs — rebuild the shipped race music from its sources.
//
// The .mp3s under public/assets/audio/music/ are ARTIFACTS: incompetech
// downloads re-encoded to VBR. The masters are ~164 MB and are not in the tree.
// This script is what makes that safe — it downloads each master, checks it
// against the sha256 in SOURCES.json, and re-runs the recorded encode.
//
// It is the ACQUIRED-asset twin of scripts/bake-cues.mjs, which does the same
// job for the GENERATED ones (source = a script, not a URL).
//
//   node scripts/fetch-music.mjs              rebuild every shipped file
//   node scripts/fetch-music.mjs --verify     download + hash only, write nothing
//   node scripts/fetch-music.mjs --only happy_bee.mp3,bit_shift.mp3
//   node scripts/fetch-music.mjs --masters DIR  keep/reuse masters in DIR
//
// Masters are cached (default .cache/music-masters/, gitignored) so a second run
// re-encodes without re-downloading. --verify exits non-zero on the first hash
// mismatch: that means the upstream file MOVED under a URL we still trust, which
// is a licensing/provenance question, never something to paper over by updating
// the hash.
//
// WHY IT DOES NOT CHECK THE OUTPUT BYTES. Two LAME versions do not agree byte
// for byte, so a re-encode is reproducible in CONTENT but not as bytes. The
// gates that do hold are this script's master hash and, on the far side,
// `npm run check:music-loudness` — which is the one that matters, because the
// per-song gains are authored literals frozen against the audio corpus.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUSIC_DIR = path.join(ROOT, 'public/assets/audio/music');
const MANIFEST = path.join(MUSIC_DIR, 'SOURCES.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const VERIFY_ONLY = flag('--verify');
const MASTERS_DIR = path.resolve(ROOT, value('--masters', '.cache/music-masters'));
const ONLY = value('--only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

const sha256OfFile = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', (d) => hash.update(d))
    .on('end', () => resolve(hash.digest('hex')));
});

const exists = (p) => stat(p).then(() => true, () => false);

// Download to a .part and rename on success, so an interrupted run never leaves
// a truncated file that the next run's cache check would happily accept.
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const part = `${dest}.part`;
  await writeFile(part, Buffer.from(await res.arrayBuffer()));
  await rename(part, dest);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}\n${err.trim()}`)));
  });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

  if (ONLY) {
    const missing = ONLY.filter((f) => !manifest.songs.some((s) => s.file === f));
    if (missing.length) throw new Error(`not in SOURCES.json: ${missing.join(', ')}`);
  }
  const songs = ONLY ? manifest.songs.filter((s) => ONLY.includes(s.file)) : manifest.songs;

  await mkdir(MASTERS_DIR, { recursive: true });
  // `bytes` earns its place in the manifest here: a cold run pulls ~164 MB, and
  // saying so up front beats discovering it from the download.
  const toFetch = songs.reduce((n, s) => n + s.bytes, 0);
  console.log(`${songs.length} song(s), ${mb(toFetch)} of masters | ` +
    `cache: ${path.relative(ROOT, MASTERS_DIR)}${VERIFY_ONLY ? ' | verify only' : ''}`);

  const failures = [];
  let masterBytes = 0;
  let outBytes = 0;

  for (const song of songs) {
    const master = path.join(MASTERS_DIR, song.file);

    if (!await exists(master)) {
      process.stdout.write(`  ${song.file} … fetching`);
      await download(song.url, master);
    } else {
      process.stdout.write(`  ${song.file} … cached`);
    }

    const got = await sha256OfFile(master);
    if (got !== song.sha256) {
      // Not a self-healing condition. The URL is the same, so the upstream file
      // itself changed — which is a provenance question (is it still the track
      // CREDITS.txt attributes?), not a stale-hash bug.
      console.log(` MISMATCH\n      expected ${song.sha256}\n      got      ${got}`);
      failures.push(song.file);
      continue;
    }
    masterBytes += (await stat(master)).size;

    if (VERIFY_ONLY) { console.log(' ok'); continue; }

    const out = path.join(MUSIC_DIR, song.file);
    await run(manifest.encode.tool,
      ['-v', 'error', '-y', '-i', master, ...manifest.encode.args, out]);
    const size = (await stat(out)).size;
    outBytes += size;
    console.log(` ok -> ${mb(size)}`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} master(s) did not match SOURCES.json:` +
      `\n  ${failures.join('\n  ')}` +
      '\nThe upstream file changed. Confirm it is still the attributed track ' +
      'before touching the hash.');
    process.exitCode = 1;
    return;
  }

  console.log(VERIFY_ONLY
    ? `\nall ${songs.length} master(s) match (${mb(masterBytes)}).`
    : `\nrebuilt ${songs.length} file(s): ${mb(masterBytes)} of masters -> ` +
      `${mb(outBytes)} shipped.\nNow run: npm run check:music-loudness`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
