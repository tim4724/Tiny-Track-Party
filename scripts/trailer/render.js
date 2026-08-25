'use strict';

// Render the trailer's shots to clips, one frame at a time, OFFLINE.
//
//   node scripts/trailer/render.js                      # every shot in shots.js
//   node scripts/trailer/render.js --shot 02-canyon-4p  # one shot (repeatable)
//   node scripts/trailer/render.js --shot 02-canyon-4p --seed 12   # re-roll a take
//   node scripts/trailer/render.js --preview            # 960x540, fast, for pacing
//   node scripts/trailer/render.js --cuesonly           # re-derive the SOUND only
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
// Output: frames under artwork/trailer/frames/<id>/, one clip per shot at
// artwork/trailer/clips/<id>.mp4. cut.js stitches them.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { ROOT, STEP_ONE } = require('./harness.js');

function parseArgs(argv) {
  const out = { shot: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'preview' || key === 'keepframes' || key === 'cuesonly') { out[key] = true; continue; }
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
// mostly is not. scripts/trailer/scout.js finds a warmup without rendering anything.
const OVERRIDE = {};
for (const k of ['seed', 'warmup', 'seconds']) if (args[k] != null) OVERRIDE[k] = parseFloat(args[k]);

const shots = args.shot.length
  ? args.shot.map((id) => {
      const s = SHOTS.find((x) => x.id === id);
      if (!s) throw new Error(`no shot '${id}' in shots.js (have: ${SHOTS.map((x) => x.id).join(', ')})`);
      return { ...s, ...OVERRIDE };
    })
  : SHOTS;

// A frame's worth of "what is happening", read straight from the sim. Offline rendering
// produces NO audio — the display's sound is a Web Audio graph running in real time, and
// this steps at a few frames a second — so the soundtrack cannot be recorded, only
// RECONSTRUCTED. Determinism is what makes that exact: the sim time an event lands on
// here is the frame it lands on in the picture, so cut.js can place the cue on it rather
// than anyone lining sound up by ear.
//
// Only the captured frames are probed. Events during the warm-up happened before the clip
// starts and belong to nobody.
const PROBE = () => {
  const snap = window.__engine.getSnapshot();
  const cd = document.getElementById('countdown');
  return {
    rockets: (snap.rockets || []).map((r) => r.id),
    spinning: snap.cars.filter((c) => c.spin).map((c) => c.id),
    monsters: snap.cars.filter((c) => c.monster).map((c) => c.id),
    holding: snap.cars.filter((c) => c.item).map((c) => c.id),
    laps: snap.cars.reduce((n, c) => n + (c.totalLaps || 0), 0),
    banner: cd && getComputedStyle(cd).display !== 'none' ? (cd.textContent || '').trim() : '',
  };
};

// Turn the frame-by-frame probe into cue instances. Everything is a RISING EDGE: a state
// that was not there last frame and is now.
//
// These name WHAT HAPPENED, not what it sounds like. Which sample plays and how loud is
// cut.js's business (its CUE_MIX), so re-balancing the sound is a re-cut of seconds
// rather than a re-derive of the whole race.
function cuesFrom(samples, scenario, fps) {
  const cues = [];
  const at = (i) => +(i / fps).toFixed(3);
  const fresh = (now, before) => now.filter((id) => !before.includes(id));

  // The banner is the one thing worth catching mid-beat. A shot cut to open ON the launch
  // starts a hair after GO lit, so the rising edge falls outside the clip and the loudest
  // moment in the trailer would land silent. Nothing else gets this treatment: a rocket
  // already in flight when the clip opens was fired earlier and must not re-fire.
  if (samples.length && samples[0].banner) {
    cues.push({ t: 0, kind: samples[0].banner === 'GO!' ? 'countdown_go' : 'countdown_tick' });
  }
  for (let i = 1; i < samples.length; i++) {
    const now = samples[i];
    const before = samples[i - 1];
    for (const _ of fresh(now.rockets, before.rockets)) cues.push({ t: at(i), kind: 'rocket_fire' });
    for (const _ of fresh(now.monsters, before.monsters)) cues.push({ t: at(i), kind: 'monster_inflate' });
    for (const _ of fresh(now.holding, before.holding)) cues.push({ t: at(i), kind: 'pickup' });
    // A spin is a hit. In the rocket showcase that is a rocket landing; otherwise it is
    // a car being knocked about, which is a scrape rather than a bang.
    for (const _ of fresh(now.spinning, before.spinning)) {
      cues.push({ t: at(i), kind: scenario === 'rocket' ? 'rocket_hit' : 'screech' });
    }
    if (now.laps > before.laps) cues.push({ t: at(i), kind: 'lap' });
    if (now.banner !== before.banner && now.banner) {
      cues.push({ t: at(i), kind: now.banner === 'GO!' ? 'countdown_go' : 'countdown_tick' });
    }
  }
  return cues;
}

async function renderShot(page, shot, port) {
  // --cuesonly re-runs the same race and writes the cue sheet, skipping the screenshots
  // and the encode. The sound is derived from the sim, not from the pictures, so it can
  // be rebuilt in seconds without touching clips that are already correct — a readback is
  // two orders of magnitude dearer than a step.
  const cuesOnly = !!args.cuesonly;
  const frameDir = path.join(OUT, 'frames', shot.id);
  if (!cuesOnly) {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
  }

  const q = new URLSearchParams({
    test: '1',
    gate: '1',            // the display hands us the frame clock — see harness.js
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
    for (const sel of ['#corner-btns', '.dbg-fab', '#music-credit', '#sound-hint', '#toast', '.cam-hint']) {
      for (const node of document.querySelectorAll(sel)) node.style.display = 'none';
    }
  });

  await page.evaluate((fps) => window.__scene.setFixedStep(1 / fps), FPS);

  // Warmup: stepped, not shot. Cars leave the grid stacked, and a clip that opens on
  // three cars nose-to-tail is a starting line, not a race.
  const stepMs = 1000 / FPS;
  const warm = Math.round((shot.warmup || 0) * FPS);
  for (let i = 0; i < warm; i++) await page.evaluate(STEP_ONE, stepMs);

  const total = Math.round(shot.seconds * FPS);
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate(STEP_ONE, stepMs);
    samples.push(await page.evaluate(PROBE));
    if (!cuesOnly) await page.screenshot({ path: path.join(frameDir, String(i).padStart(5, '0') + '.png') });
    if (i && i % 60 === 0) {
      const rate = i / ((Date.now() - t0) / 1000);
      process.stdout.write(`    ${i}/${total} frames (${rate.toFixed(1)}/s)\r`);
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

  // The cue sheet rides beside the clip: cut.js reads it to build the sound.
  const cues = cuesFrom(samples, shot.scenario, FPS);
  const clip = path.join(OUT, 'clips', `${shot.id}.mp4`);
  fs.mkdirSync(path.dirname(clip), { recursive: true });
  fs.writeFileSync(clip.replace(/\.mp4$/, '.cues.json'), JSON.stringify(cues));

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (cuesOnly) {
    console.log(`  ${shot.id}: ${cues.length} cues in ${secs}s (picture untouched)`);
    return;
  }

  const ff = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(frameDir, '%05d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    clip,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (ff.status !== 0) throw new Error(`ffmpeg failed for ${shot.id}:\n${ff.stderr}`);
  if (!args.keepframes) fs.rmSync(frameDir, { recursive: true, force: true });

  console.log(`  ${shot.id}: ${total} frames @ ${surface.w}x${surface.h} in ${secs}s, ${cues.length} cues → ${path.relative(ROOT, clip)}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { serveApp, launchBrowser } = await import('../lib/capture.mjs');
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
