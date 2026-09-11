'use strict';

// Render the trailer's shots to clips, one frame at a time, OFFLINE.
//
//   node scripts/trailer/render.js                      # every shot in shots.js
//   node scripts/trailer/render.js --shot 02-canyon-4p  # one shot (repeatable)
//   node scripts/trailer/render.js --shot 02-canyon-4p --seed 12   # re-roll a take
//   node scripts/trailer/render.js --preview            # 960x540, fast, for pacing
//   node scripts/trailer/render.js --soundonly          # re-render the SOUND only
//
// WHY FRAME-BY-FRAME, and not a screen recording. The display can be driven by a
// FIXED timestep (Stage.setFixedStep) instead of the rAF clock, so the sim advances
// exactly 1/60 s per frame DRAWN no matter how long the frame takes to draw or how
// long this script then spends reading it back. That decouples the output frame rate
// from the render rate entirely: the master is a clean 60 fps, and being slow to
// produce costs only wall clock. A realtime capture would instead be at the mercy of
// whatever the machine was doing, and could not be re-rendered identically later.
//
// This must run HEADED. Headless Chromium falls back to SwiftShader (software GL);
// headed gets ANGLE-on-Metal and the real GPU, which is the difference between the
// scene rendering at 60 fps and at well under one. Nothing is displayed to a human —
// the window just has to exist. Measured on an M1 Max at 3840x2160: the scene itself
// runs at 60 fps, and a PNG readback is the whole per-frame cost.
//
// THE SOUND IS RENDERED THE SAME WAY. The display's mix is a Web Audio graph, and Web
// Audio can run one on an OfflineAudioContext that only advances when told to: `?offlineaudio`
// (RaceAudio) puts the game's graph on one, and after every frame stepped here the
// context is rendered up to the next frame boundary and halted. The commands that frame
// applied were scheduled at the context's own clock, so what comes out is the mix the
// game would have played over exactly these frames — engines, cornering, rockets at
// their distance, the countdown — without a speaker anywhere. The music is not in it:
// that is a streamed element outside the graph, and cut.js lays the bed itself.
//
// Output: frames under artwork/trailer/frames/<id>/, one clip per shot at
// artwork/trailer/clips/<id>.mp4 with its sound beside it as <id>.wav. cut.js stitches them.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { shot: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'preview' || key === 'keepframes' || key === 'soundonly') { out[key] = true; continue; }
    if (key === 'shot') { out.shot.push(argv[++i]); continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SHOTS = require('./shots.js');
const OUT = path.join(ROOT, 'artwork', 'trailer');

const FPS = parseInt(args.fps, 10) || 60;
// CSS layout size x deviceScaleFactor is the real output size. Composition is fixed by
// the LAYOUT size, so previewing at half scale frames every shot identically to the
// master — only the pixels are cheaper. deviceScaleFactor 2 is also the renderer's own
// pixel-ratio cap, so 1920x1080 @2 is the largest buffer it will allocate: a true 4K.
const WIDTH = parseInt(args.width, 10) || (args.preview ? 960 : 1920);
const HEIGHT = parseInt(args.height, 10) || (args.preview ? 540 : 1080);
const DSF = parseFloat(args.dsf) || (args.preview ? 1 : 2);
const CRF = args.crf || (args.preview ? '23' : '16');

// SCOUTING a take: --seed/--warmup/--seconds override the named shot's own fields for
// this run only. Sweep them until the action lands, then write the numbers into
// shots.js — the render is deterministic, so what you scouted is what you get back.
// `warmup` is the knob worth sweeping; see the seed note in shots.js for why the seed
// mostly is not. /trailer.html's timeline marks where a race's items land.
const OVERRIDE = {};
for (const k of ['seed', 'warmup', 'seconds']) if (args[k] != null) OVERRIDE[k] = parseFloat(args[k]);

const shots = args.shot.length
  ? args.shot.map((id) => {
      const s = SHOTS.find((x) => x.id === id);
      if (!s) throw new Error(`no shot '${id}' in shots.js (have: ${SHOTS.map((x) => x.id).join(', ')})`);
      return { ...s, ...OVERRIDE };
    })
  : SHOTS;

// ONE FIXED STEP, with its sound. Advance the scene by exactly one step and return once
// the frame has been drawn: start() re-arms the loop and pauseAfterFrame() tells it to
// halt after the next iteration, so the pair is a single-step primitive; __pump (the
// gate's — the display installs it itself from `?gate=1`, before it draws anything; see
// public/display/frameGate.js) then actually runs it, and onAfterFrame fires with the
// drawing buffer still holding the frame. The trailer EDITOR mirrors this stepping and
// deliberately does not share it: it runs same-realm against an <iframe>, with none of
// the cross-realm evaluate boundary this is built around.
//
// Then the sound: the frame just stepped applied its commands at the context's current
// time, so render up to the next boundary and halt there. Boundaries are absolute
// (i / fps), not accumulated: suspend() rounds to the 128-sample render quantum, and an
// absolute time keeps that rounding from adding up. The first frame starts the render;
// every later one resumes it.
const STEP_ONE = async ([i, fps]) => {
  await new Promise((done, fail) => {
    const s = window.__scene;
    const t = setTimeout(() => fail(new Error('frame never presented')), 30000);
    s.onAfterFrame = () => { s.onAfterFrame = null; clearTimeout(t); done(); };
    s.start();
    s.pauseAfterFrame();
    window.__pump(1000 / fps);
  });
  const ctx = window.__audio.ctx;
  const halt = ctx.suspend((i + 1) / fps);
  if (i === 0) window.__audioRendered = ctx.startRendering();
  else await ctx.resume();
  await halt;
};

// Run the context out and hand back the captured span — the `total` frames after the
// `warm` ones — one Float32Array per channel; Playwright carries typed arrays across.
const AUDIO_FINISH = async ([warm, total, fps]) => {
  const ctx = window.__audio.ctx;
  await ctx.resume();
  const buf = await window.__audioRendered;
  const from = Math.round(warm * ctx.sampleRate / fps);
  const n = Math.max(0, Math.min(Math.round(total * ctx.sampleRate / fps), buf.length - from));
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice(from, from + n));
  return { sampleRate: ctx.sampleRate, channels };
};

let wavLib;   // scripts/lib/wav.mjs, loaded in main (ESM, from this CJS script)

// The colour the clips are encoded in, written into the H.264 stream's VUI — cut.js
// stamps the same on the master. Through x264's own parameters: ffmpeg's codec-level
// colour flags reach the matrix and range but not the primaries and transfer, which
// then read as unknown. See the encode below for why none of it is left implicit.
const COLOR_TAGS = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv'];

async function renderShot(page, shot, port) {
  // --soundonly re-runs the same race and writes the wav, skipping the screenshots and
  // the encode. The sound comes from the sim, not from the pictures, so it can be
  // rebuilt in seconds without touching clips that are already correct — a readback is
  // two orders of magnitude dearer than a step.
  const soundOnly = !!args.soundonly;
  const frameDir = path.join(OUT, 'frames', shot.id);
  if (!soundOnly) {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
  }

  const warm = Math.round((shot.warmup || 0) * FPS);
  const total = Math.round(shot.seconds * FPS);

  const q = new URLSearchParams({
    test: '1',
    gate: '1',            // the display hands us the frame clock — see STEP_ONE
    // …and the sound's clock too: a context long enough for the warmup, the shot and
    // the boundary after the last frame (suspend() cannot land on the very end).
    offlineaudio: String((warm + total + 1) / FPS),
    scenario: shot.scenario,
    players: String(shot.players),
    track: shot.track,
    // The master's resolution, NAMED rather than inherited, because on the
    // automatic path the shell decides the buffer size from what frames cost and
    // may resize mid-capture (Stage._adaptScale) — a master whose resolution
    // changes at shot 4 because the machine warmed up. An explicit scale latches
    // that off, so DSF is what actually reaches the canvas: --dsf 2 renders true
    // 4K, --preview stays cheap.
    dpr: String(DSF),
  });
  if (shot.seed != null) q.set('seed', String(shot.seed));
  if (shot.dividers === false) q.set('dividers', '0');

  await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'networkidle' });

  // The harness builds the engine and the scene cars once the GLBs load. Wait for the
  // full field rather than a timeout: a lost GL context shows up here as cars that
  // never arrive, instead of as a clip of an empty track.
  await page.waitForFunction((n) => {
    const s = window.__scene, e = window.__engine;
    return !!(s && e && s.cars.size >= n);
  }, shot.players, { timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  // Everything on the page that is not the GAME: the corner buttons in particular
  // sit on top of the top-right cell's place chip.
  await page.evaluate(() => {
    for (const sel of ['#corner-btns', '.dbg-fab', '#sound-hint', '#toast', '.cam-hint']) {
      for (const node of document.querySelectorAll(sel)) node.style.display = 'none';
    }
  });

  await page.evaluate((fps) => window.__scene.setFixedStep(1 / fps), FPS);

  // Open the sound: the context, and the recorded cues decoded into it. Live, a gesture
  // does this and the decode lands during the lobby; here the first frame is next.
  await page.evaluate(() => { window.__audio.resume(); return window.__audio.samplesReady; });

  // Warmup: stepped and sounded, not shot. Cars leave the grid stacked, and a clip that
  // opens on three cars nose-to-tail is a starting line, not a race. The sound runs
  // through it so every voice is where the game would have it when the clip opens.
  let t0 = Date.now();
  for (let i = 0; i < warm + total; i++) {
    await page.evaluate(STEP_ONE, [i, FPS]);
    if (i < warm) continue;
    const k = i - warm;
    if (k === 0) t0 = Date.now();
    if (!soundOnly) await page.screenshot({ path: path.join(frameDir, String(k).padStart(5, '0') + '.png') });
    if (k && k % 60 === 0) {
      const rate = k / ((Date.now() - t0) / 1000);
      process.stdout.write(`    ${k}/${total} frames (${rate.toFixed(1)}/s)\r`);
    }
  }

  // A clamped render surface is silent — it still writes perfectly valid PNGs, just
  // soft ones — so assert the buffer rather than trusting it.
  const surface = await page.evaluate(() => {
    const c = document.getElementById('scene-canvas');
    return c && { w: c.width, h: c.height };
  });
  const want = Math.round(WIDTH * Math.min(DSF, 2));
  if (!surface) throw new Error('no #scene-canvas — the display never booted its renderer');
  if (surface.w < want) {
    throw new Error(`render surface is ${surface.w}x${surface.h}, wanted ${want} wide — the display clamped its resolution`);
  }

  // The sound rides beside the clip: cut.js lays it under the bed.
  const clip = path.join(OUT, 'clips', `${shot.id}.mp4`);
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  const sound = await page.evaluate(AUDIO_FINISH, [warm, total, FPS]);
  const { pcm } = wavLib.quantize(wavLib.interleave(sound.channels));
  fs.writeFileSync(clip.replace(/\.mp4$/, '.wav'), wavLib.wav(pcm, sound.channels.length, sound.sampleRate).file);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (soundOnly) {
    console.log(`  ${shot.id}: ${shot.seconds}s of sound in ${secs}s (picture untouched)`);
    return;
  }

  // BT.709, SAID SO. The frames are sRGB PNGs and the clip is HD video, and the two
  // meet in the RGB→YUV conversion: left to itself ffmpeg converts with the BT.601
  // matrix and tags nothing, while every HD player assumes BT.709 — and QuickTime, given
  // no tags, adds a gamma assumption of its own on top, which read as a bright, washed
  // picture. So the conversion uses the 709 matrix and the stream carries the full set
  // of tags (primaries, transfer, matrix, limited range) it was made with (COLOR_TAGS).
  const ff = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(frameDir, '%05d.png'),
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...COLOR_TAGS,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF),
    '-movflags', '+faststart',
    clip,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (ff.status !== 0) throw new Error(`ffmpeg failed for ${shot.id}:\n${ff.stderr}`);
  if (!args.keepframes) fs.rmSync(frameDir, { recursive: true, force: true });

  console.log(`  ${shot.id}: ${total} frames @ ${surface.w}x${surface.h} in ${secs}s, with sound → ${path.relative(ROOT, clip)}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { serveApp, launchBrowser } = await import('../lib/capture.mjs');
  wavLib = await import('../lib/wav.mjs');
  const app = await serveApp({ port: args.port ? parseInt(args.port, 10) : undefined });

  let b;
  try {
    // HEADED for the real GPU — see the note at the top of this file.
    b = await launchBrowser({ headed: true });
    const page = await b.page({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: DSF,
    });
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

    console.log(`Rendering ${shots.length} shot(s) at ${WIDTH * DSF}x${HEIGHT * DSF} @ ${FPS}fps`);
    for (const shot of shots) await renderShot(page, shot, app.port);
    console.log(`\nClips in ${path.relative(ROOT, path.join(OUT, 'clips'))}/ — run scripts/trailer/cut.js to stitch.`);
  } finally {
    if (b) await b.close();
    app.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
