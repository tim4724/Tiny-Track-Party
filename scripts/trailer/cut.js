'use strict';

// Stitch the rendered clips into the trailer: join the shots, lay the music bed under
// them, and put the game's own sounds back on top.
//
//   node scripts/trailer/cut.js                      # → artwork/trailer/trailer.mp4
//   node scripts/trailer/cut.js --music hyperfun
//   node scripts/trailer/cut.js --xfade 0            # hard cuts instead of dissolves
//   node scripts/trailer/cut.js --nosfx 1            # music only
//   node scripts/trailer/cut.js --out /tmp/cut.mp4
//
// Also: --sfxvol / --musicvol (levels), --fade (tail length), --crf (quality).
//
// Clip ORDER is shots.js's array order — the shot list is the edit, and re-cutting is a
// reorder there rather than an argument here.
//
// THE SOUND IS THE GAME'S OWN MIX, rendered offline in lockstep with the frames (see
// render.js) and written beside each clip as <id>.wav — everything but the music, which
// is laid here as a bed. Re-rendering it costs seconds (`render.js --soundonly`) and
// never touches the picture.
//
// Music and the picture both fade at the tail, so the trailer ends rather than stopping.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = require('./shots.js');
const DIR = path.join(ROOT, 'artwork', 'trailer');
const CLIPS = path.join(DIR, 'clips');

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
const MUSIC = path.join(ROOT, 'public', 'assets', 'audio', 'music', `${args.music || 'vivacity'}.mp3`);
const FADE = parseFloat(args.fade) || 1.5;   // seconds of audio+video fade at the tail
// Cross-dissolve between shots. Short on purpose: long enough to take the edge off a hard
// cut, short enough that it still reads as a cut rather than a dissolve. `--xfade 0`
// restores hard cuts. Every dissolve OVERLAPS its two shots, so the trailer ends up
// (shots - 1) x XFADE shorter than the sum of its parts.
const XFADE = args.xfade == null ? 0.25 : Math.max(0, parseFloat(args.xfade));
// Game sound sits ON TOP of the bed, so the bed steps back to make room for it. --nosfx
// drops it and returns the music to full. The game's mix already went through its own
// master level and limiter, so this is a trim over that, not a balance of its parts.
const SFX_VOL = args.sfxvol == null ? 0.85 : parseFloat(args.sfxvol);
const MUSIC_DUCK = args.musicvol == null ? 0.55 : parseFloat(args.musicvol);
const SFX = args.nosfx == null;

function ff(cliArgs, label) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...cliArgs], { stdio: ['ignore', 'inherit', 'pipe'] });
  if (r.status !== 0) throw new Error(`${label} failed:\n${r.stderr}`);
}

function main() {
  const missing = SHOTS.filter((s) => !fs.existsSync(path.join(CLIPS, `${s.id}.mp4`))
                                   || !fs.existsSync(path.join(CLIPS, `${s.id}.wav`)));
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
  const starts = [];      // where each clip's picture begins in the output
  let running = 0;
  SHOTS.forEach((s, i) => {
    inputs.push('-i', path.join(CLIPS, `${s.id}.mp4`));
    starts.push(i === 0 ? 0 : running - XFADE);
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

  // GAME SOUND. Each clip's wav is the display's own mix over exactly that clip's frames
  // (render.js), so it goes where its picture goes: delayed to the clip's start, and
  // faded across the dissolve at each join so two engines never sit on top of each other
  // where the pictures overlap.
  const musicIdx = SHOTS.length;
  const sounds = SFX ? SHOTS.map((s, i) => {
    const f = [];
    if (XFADE && i > 0) f.push(`afade=t=in:d=${XFADE}`);
    if (XFADE && i < SHOTS.length - 1) f.push(`afade=t=out:st=${(s.seconds - XFADE).toFixed(3)}:d=${XFADE}`);
    f.push(`adelay=${Math.round(starts[i] * 1000)}:all=1`, `volume=${SFX_VOL.toFixed(3)}`);
    return { file: path.join(CLIPS, `${s.id}.wav`), filter: `[${musicIdx + 1 + i}:a]${f.join(',')}[c${i}]` };
  }) : [];
  const soundFilters = sounds.map((c) => c.filter);
  const bed = `[${musicIdx}:a]afade=t=out:st=${(total - FADE).toFixed(2)}:d=${FADE},volume=${sounds.length ? MUSIC_DUCK : 1}[bed]`;
  const mix = sounds.length
    ? `${bed};${soundFilters.join(';')};[bed]${sounds.map((_, k) => `[c${k}]`).join('')}amix=inputs=${sounds.length + 1}:normalize=0:dropout_transition=0,atrim=0:${total.toFixed(2)}[a]`
    : `${bed};[bed]atrim=0:${total.toFixed(2)}[a]`;

  ff([
    ...inputs,
    '-i', MUSIC,
    ...sounds.flatMap((c) => ['-i', c.file]),
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
    '-pix_fmt', 'yuv420p',
    // The clips' own colour (render.js COLOR_TAGS), stamped on the master too: the
    // re-encode keeps their YUV as it is, and a master without the tags would hand
    // QuickTime the same guesswork the clips were tagged to avoid.
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', OUT,
  ], 'mux');

  const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
  console.log(`${SHOTS.length} shots, ${total.toFixed(1)}s, ${mb} MB → ${path.relative(ROOT, OUT)}`);

  // The music bed is one of the shipped race songs, and every one of those is CC-BY —
  // see public/assets/audio/music/CREDITS.txt, which says attribution is required before
  // public release. A trailer is a public release, and it carries no licenses page the
  // way the game does, so print the credit here rather than let it be forgotten.
  const song = path.basename(MUSIC, '.mp3').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  console.log('\nATTRIBUTION REQUIRED wherever this is published (CC-BY 4.0):');
  console.log(`  "${song}" by Kevin MacLeod (incompetech.com)`);
  console.log('  Licensed under Creative Commons: By Attribution 4.0');
  console.log('  https://creativecommons.org/licenses/by/4.0/');
}

main();
