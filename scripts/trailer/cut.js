'use strict';

// Stitch the rendered clips into the trailer: join the shots, lay the music bed under
// them, and put the game's own sounds back on top.
//
//   node scripts/trailer/cut.js                      # → artwork/trailer/trailer.mp4
//   node scripts/trailer/cut.js --music feelin_good
//   node scripts/trailer/cut.js --xfade 0            # hard cuts instead of dissolves
//   node scripts/trailer/cut.js --nosfx 1            # music only
//   node scripts/trailer/cut.js --out /tmp/cut.mp4
//
// Also: --sfxvol / --musicvol (levels), --fade (tail length), --crf (quality).
//
// Clip ORDER is shots.js's array order — the shot list is the edit, and re-cutting is a
// reorder there rather than an argument here.
//
// THE SOUND IS REBUILT, NOT RECORDED. An offline render produces no audio at all, so
// render.js writes a cue sheet beside each clip giving the sim time of every rocket, hit,
// pickup and countdown beat; those are placed here at the exact frame they happened on.
// Re-deriving them costs seconds (`render.js --cuesonly`) and never touches the picture.
//
// Music and the picture both fade at the tail, so the trailer ends rather than stopping.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = require('./shots.js');
const DIR = path.join(ROOT, 'artwork', 'trailer');
const CLIPS = path.join(DIR, 'clips');
const CUES = path.join(ROOT, 'public', 'assets', 'audio', 'cues');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(ROOT, args.out || path.join(DIR, 'trailer.mp4'));
const MUSIC = path.join(ROOT, 'public', 'assets', 'audio', 'music', `${args.music || 'hyperfun'}.mp3`);
const FADE = parseFloat(args.fade) || 1.5;   // seconds of audio+video fade at the tail
// Cross-dissolve between shots. Short on purpose: long enough to take the edge off a hard
// cut, short enough that it still reads as a cut rather than a dissolve. `--xfade 0`
// restores hard cuts. Every dissolve OVERLAPS its two shots, so the trailer ends up
// (shots - 1) x XFADE shorter than the sum of its parts.
const XFADE = args.xfade == null ? 0.25 : Math.max(0, parseFloat(args.xfade));
// Game sound sits ON TOP of the bed, so the bed steps back to make room for it. --nosfx
// drops the cues and returns the music to full.
const SFX_VOL = args.sfxvol == null ? 0.85 : parseFloat(args.sfxvol);

// WHICH SAMPLE, AND HOW LOUD, per kind of event. render.js only says what happened; the
// balance lives here so it can be changed with a re-cut instead of a re-derive.
//
// The rocket cues carry the game's own DISTANCE variants (-l002 quietest to -l100). The
// flight takes a far one at low gain on purpose: in the game it is a sustained voice
// scaled by how close the rocket is to a human, and every rocket in an eight-car field
// fires one. Giving each launch the full-level sample made a background event the loudest
// thing in the trailer. The IMPACT is the beat worth hearing, so it keeps the full sample.
const CUE_MIX = {
  rocket_fire:     { file: 'rocket_fire-l025', gain: 0.30 },
  rocket_hit:      { file: 'rocket_hit', gain: 1.0 },
  screech:         { file: 'screech', gain: 0.45 },
  pickup:          { file: 'pickup', gain: 0.5 },
  monster_inflate: { file: 'monster_inflate', gain: 0.7 },
  lap:             { file: 'lap', gain: 0.55 },
  countdown_go:    { file: 'countdown_go', gain: 0.9 },
  countdown_tick:  { file: 'countdown_tick', gain: 0.7 },
};
const MUSIC_DUCK = args.musicvol == null ? 0.55 : parseFloat(args.musicvol);
const MAX_CUES = args.nosfx != null ? 0 : 160;

function ff(cliArgs, label) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...cliArgs], { stdio: ['ignore', 'inherit', 'pipe'] });
  if (r.status !== 0) throw new Error(`${label} failed:\n${r.stderr}`);
}

function main() {
  const missing = SHOTS.filter((s) => !fs.existsSync(path.join(CLIPS, `${s.id}.mp4`)));
  if (missing.length) {
    throw new Error(`no clip for: ${missing.map((s) => s.id).join(', ')}\n` +
      `run: node scripts/trailer/render.js${missing.map((s) => ` --shot ${s.id}`).join('')}`);
  }
  if (!fs.existsSync(MUSIC)) throw new Error(`no music at ${path.relative(ROOT, MUSIC)}`);

  // Join the shots. With cross-dissolves each pair OVERLAPS, so this is one xfade chain
  // over N inputs rather than a concat: xfade's `offset` is where the dissolve starts in
  // the running output, which is the output so far minus the overlap being spent.
  const inputs = [];
  const steps = [];
  let running = 0;
  SHOTS.forEach((s, i) => {
    inputs.push('-i', path.join(CLIPS, `${s.id}.mp4`));
    if (i === 0) { running = s.seconds; return; }
    const from = i === 1 ? '[0:v]' : `[x${i - 1}]`;
    const label = i === SHOTS.length - 1 ? '[joined]' : `[x${i}]`;
    steps.push(`${from}[${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${(running - XFADE).toFixed(3)}${label}`);
    running += s.seconds - XFADE;
  });
  const total = running;

  // One clip is a degenerate chain — there is nothing to dissolve into.
  const joined = SHOTS.length > 1 ? '[joined]' : '[0:v]';
  const chain = steps.join(';');

  // GAME SOUND, RECONSTRUCTED. render.js writes a cue sheet beside each clip — the sim
  // time of every rocket, hit, pickup and countdown beat, taken from the same
  // deterministic pass that drew the frames. There is no audio to record from an offline
  // render, so the cues are placed here instead, each delayed to its own moment. Because
  // the timestamps come from the picture's own clock they land on the exact frame.
  //
  // One ffmpeg input per cue INSTANCE. Duplicated file inputs are cheap and it avoids
  // splitting one decoded stream a dozen ways.
  const cues = [];
  let clipStart = 0;
  SHOTS.forEach((s, i) => {
    const sheet = path.join(CLIPS, `${s.id}.cues.json`);
    if (fs.existsSync(sheet)) {
      for (const c of JSON.parse(fs.readFileSync(sheet, 'utf8'))) {
        const mix = CUE_MIX[c.kind];
        if (!mix) continue;                       // an event nobody has chosen a sound for
        const file = path.join(CUES, `${mix.file}.wav`);
        if (fs.existsSync(file)) cues.push({ file, gain: mix.gain, at: clipStart + c.t });
      }
    }
    clipStart += s.seconds - (i < SHOTS.length - 1 ? XFADE : 0);
  });
  // Keep the command sane, and a wall of overlapping cues is mud anyway.
  if (cues.length > MAX_CUES) {
    console.log(`  (${cues.length} cues, keeping the first ${MAX_CUES})`);
    cues.length = MAX_CUES;
  }

  const musicIdx = SHOTS.length;
  const cueFilters = cues.map((c, k) => `[${musicIdx + 1 + k}:a]adelay=${Math.round(c.at * 1000)}:all=1,volume=${(SFX_VOL * c.gain).toFixed(3)}[c${k}]`);
  const bed = `[${musicIdx}:a]afade=t=out:st=${(total - FADE).toFixed(2)}:d=${FADE},volume=${cues.length ? MUSIC_DUCK : 1}[bed]`;
  const mix = cues.length
    ? `${bed};${cueFilters.join(';')};[bed]${cues.map((_, k) => `[c${k}]`).join('')}amix=inputs=${cues.length + 1}:normalize=0:dropout_transition=0,atrim=0:${total.toFixed(2)}[a]`
    : `${bed};[bed]atrim=0:${total.toFixed(2)}[a]`;

  ff([
    ...inputs,
    '-i', MUSIC,
    ...cues.flatMap((c) => ['-i', c.file]),
    '-filter_complex',
    (chain ? `${chain};` : '') +
    `${joined}fade=t=out:st=${(total - FADE).toFixed(2)}:d=${FADE}[v];` +
    mix,
    '-map', '[v]', '-map', '[a]',
    // A notch finer than the per-shot clips (crf 16). The tail fade means the picture
    // has to be re-encoded, so this is a second generation over an already-lossy source;
    // giving it more bits keeps that step from compounding. Flat-shaded art compresses
    // well, so the extra size is small.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', args.crf || '14',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', OUT,
  ], 'mux');

  const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
  console.log(`${SHOTS.length} shots, ${total.toFixed(1)}s, ${mb} MB → ${path.relative(ROOT, OUT)}`);

  // The music bed is one of the shipped race songs, and every one of those is CC-BY —
  // see public/assets/audio/music/CREDITS.txt, which says attribution is required before
  // public release. A trailer is a public release, and it has no now-playing chip to
  // carry the credit the game shows, so print it here rather than let it be forgotten.
  const song = path.basename(MUSIC, '.mp3').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  console.log('\nATTRIBUTION REQUIRED wherever this is published (CC-BY 4.0):');
  console.log(`  "${song}" by Kevin MacLeod (incompetech.com)`);
  console.log('  Licensed under Creative Commons: By Attribution 4.0');
  console.log('  https://creativecommons.org/licenses/by/4.0/');
}

main();
