#!/usr/bin/env node
// check-music-loudness.mjs — the gate a re-encode can break in silence.
//
// WHAT IT GUARDS. Every song carries a `gain` in public/display/audio/
// musicCatalogue.js that trims it to a common perceived level, and that gain is
// derived from the file's integrated loudness — MEASURED ONCE, at wiring time,
// off the file as it was then. The gain is an AUTHORED LITERAL on both sides
// (musicCatalogue.js and native/libttp-runtime/ttp/audio.cc), frozen against
// tests/fixtures/audio-corpus.jsonl, which can never be re-recorded. So the
// numbers cannot follow the file. If a re-encode, a re-download or an
// accidental filter moves a song's loudness, NOTHING else in the tree notices:
// the corpus still passes (it only knows the literal), the E2E suite still
// passes, and the only symptom is one song playing at the wrong level.
//
// It also checks the baked `duration` and that no cover art crept back in.
//
//   node scripts/check-music-loudness.mjs
//   node scripts/check-music-loudness.mjs --tolerance 0.5
//
// WHY THIS IS A SCRIPT AND NOT A TEST. It shells out to ffmpeg, which is not a
// devDependency and is not on CI. Wiring it into `npm test` would make the
// suite's outcome depend on what happens to be installed. Run it after anything
// that touches the audio files — `npm run fetch:music` says so on the way out.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = path.join(ROOT, 'public/display/audio/musicCatalogue.js');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// A plain re-encode holds integrated loudness to ~0.1 LU. 0.3 leaves room for
// encoder-to-encoder drift while still catching anything that would actually be
// audible against a trim table that cannot move.
const TOLERANCE = Number(arg('--tolerance', '0.3'));
const DURATION_TOLERANCE = 1.0; // the catalogue bakes whole seconds

// A NaN tolerance makes every comparison below false, so the gate would report
// a clean run having checked nothing. Refuse rather than pass.
if (!Number.isFinite(TOLERANCE) || TOLERANCE < 0) {
  console.error(`--tolerance must be a non-negative number, got "${arg('--tolerance', '')}"`);
  process.exit(1);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// A song whose re-encode legitimately does not land on its catalogue figure.
// The allowance is the EXPECTED delta, still held to ±TOLERANCE either side, so
// it stays a gate: a file that drifts further, or that stops drifting, fails.
// Never add one to silence a genuine level change — see the note in each entry.
const ALLOWANCES = {
  'chipper_doodle_v2.mp3': {
    lu: -1.5,
    why: 'the master carries ~-24 dB RMS ABOVE 16 kHz (it is a chiptune, so its '
      + 'square-wave harmonics run to the top of the band). Every VBR setting '
      + 'below V0 lowpasses around 16 kHz and removes it, and BS.1770 '
      + 'K-weighting shelves the high end up, so the measurement drops 1.5 LU '
      + 'for content no listener can hear. V0 preserves it exactly (-12.2) at '
      + '5.8 MB against 2.9 MB — twice the bytes to satisfy a meter rather than '
      + 'an ear. The playback level is unchanged, so the frozen gain still '
      + 'holds. Verified: the loss tracks HF energy, not level (attenuating the '
      + 'input 3 dB first loses the same 1.5 LU) and no audio is missing '
      + '(identical duration and frame count).',
  },
};

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => reject(new Error(
      e.code === 'ENOENT' ? `${cmd} not found — install it to run this check` : e.message)));
    child.on('close', () => resolve(out));
  });
}

// ebur128 prints a summary block at the end; the last `I:` line is the
// integrated figure for the whole file.
async function measure(file) {
  const out = await capture('ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-af', 'ebur128', '-f', 'null', '-']);
  const all = [...out.matchAll(/^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gm)];
  if (!all.length) throw new Error(`could not read loudness of ${path.basename(file)}`);
  return Number(all[all.length - 1][1]);
}

async function probe(file) {
  const out = await capture('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
      '-of', 'json', file]);
  const json = JSON.parse(out);
  return {
    duration: Number(json.format?.duration ?? 0),
    hasVideo: (json.streams ?? []).some((s) => s.codec_type === 'video'),
  };
}

async function main() {
  const mod = await import(pathToFileURL(CATALOGUE).href);
  const songs = new Map();
  for (const pool of Object.values(mod.RACE_MUSIC ?? {})) {
    for (const s of pool) songs.set(s.file, s);
  }
  for (const s of mod.FALLBACK_MUSIC ?? []) songs.set(s.file, s);

  if (!songs.size) throw new Error(`no songs found in ${path.relative(ROOT, CATALOGUE)}`);
  console.log(`${songs.size} song(s), tolerance ${TOLERANCE} LU\n`);

  const problems = [];
  let bytes = 0;

  for (const song of [...songs.values()].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const file = path.join(ROOT, 'public', song.file.replace(/^\//, ''));
    const name = path.basename(file);

    let size;
    try { size = (await stat(file)).size; } catch {
      problems.push(`${name}: missing (run \`npm run fetch:music\`)`);
      continue;
    }
    bytes += size;

    const [lufs, info] = await Promise.all([measure(file), probe(file)]);
    const allowance = ALLOWANCES[name];
    const allowed = allowance?.lu ?? 0;
    const dLufs = lufs - song.lufs;
    const dDur = info.duration - song.duration;
    const bad = Math.abs(dLufs - allowed) > TOLERANCE;
    const badDur = Math.abs(dDur) > DURATION_TOLERANCE;

    console.log(`  ${bad || badDur || info.hasVideo ? 'FAIL' : 'ok  '} ${name.padEnd(28)}` +
      `${lufs.toFixed(1)} LUFS (catalogue ${song.lufs.toFixed(1)}, ${dLufs >= 0 ? '+' : ''}` +
      `${dLufs.toFixed(1)})${allowance ? ` [allowed ${allowed.toFixed(1)}]` : ''}` +
      `  ${mb(size)}`);

    if (bad) {
      problems.push(`${name}: ${lufs.toFixed(1)} LUFS but the catalogue trims it as ` +
        `${song.lufs.toFixed(1)} (${dLufs >= 0 ? '+' : ''}${dLufs.toFixed(1)} LU` +
        `${allowance ? `, allowed ${allowed.toFixed(1)}` : ''}). ` +
        'The gain is a frozen literal — re-encode the file rather than edit the number.' +
        (allowance ? `\n    This song has an allowance: ${allowance.why}` : ''));
    }
    if (badDur) {
      problems.push(`${name}: ${info.duration.toFixed(1)}s but the catalogue bakes ` +
        `${song.duration}s.`);
    }
    if (info.hasVideo) {
      problems.push(`${name}: carries embedded cover art. Re-encode with -vn.`);
    }
  }

  console.log(`\ntotal shipped: ${mb(bytes)}`);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('every song sits where the catalogue trims it.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
