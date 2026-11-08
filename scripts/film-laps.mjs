// MATCHED LAP FILMS: cell 0's car's second lap of a live race, rendered one
// frame at a time, so two trees' films of one track are the same race to the
// frame and differ only in what the trees draw. It is how an idea or a
// prototype is judged against today's track: side by side, in motion, from
// the seat, over a whole lap rather than hand-picked stills.
//
// The capture is the trailer's (scripts/trailer/render.js): `?gate=1` hands
// the frame clock over, Stage.setFixedStep cuts the sim loose from the wall,
// and start + pauseAfterFrame + __pump is one step. Headless and silent, on
// the chase camera with no HUD (`?hud=0`), at a named `?dpr=` so the buffer
// never adapts mid-lap. Two differences, both for the match:
//
//   THE SIM STEPS AT 60 HZ WHATEVER THE FILM'S RATE. Game::update integrates
//   the dt it is handed, so a race stepped at 1/30 s is another race. The
//   film keeps every (60 / fps)-th step and steps the rest UNDRAWN
//   (Stage.setUndrawn), so its race is the game's own, and the same lap
//   score:verge and see:landmarks measure.
//
//   LAP 1 IS WOUND, NOT DRAWN. The film opens on the first step that car's
//   totalS reaches one lap and ends before the one that reaches two; the
//   grid and lap 1 run undrawn, and the next drawn frame is what drawing
//   every frame would have shown.
//
// --tree films another worktree's build: its own server, page and wasm (its
// scripts/lib/capture.mjs, which serves the tree it lives in). The tag
// defaults to the tree's directory name, with `-lite` on a --detail lite film.
//
// --detail lite|full films that detail tier (ttp/detail.h; default full, the
// web's own), so a board can show what the Android TV's lite tier gives up:
// the same race, frame for frame, since the tier changes no sim.
//
// Output, in --out (default scratch/eval/films): <track>-<tag>-<1p|4p>.mp4
// (1280x720 1P, or the TV's 540p four-cell picture at 960x540), a poster .jpg
// at 1 s and a .json with cell 0's car per frame as [t, s, lat], s from the
// line. A 4P film is another race (four player seats change the field).
//
// Usage: npm run film:laps -- --track id [--tree path] [--players 1|4] [--detail lite|full]
//        [--tag name] [--out dir] [--fps 30]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { args, ROOT } from './lib/capture.mjs';

const SIM_HZ = 60;
const a = args();
const TREE = path.resolve(typeof a.tree === 'string' ? a.tree : ROOT);
const DETAIL = a.detail === undefined ? 'full' : String(a.detail);
if (DETAIL !== 'full' && DETAIL !== 'lite') throw new Error('--detail: lite or full');
const TAG = typeof a.tag === 'string' ? a.tag : path.basename(TREE) + (DETAIL === 'lite' ? '-lite' : '');
const OUT = path.resolve(typeof a.out === 'string' ? a.out : path.join(ROOT, 'scratch', 'eval', 'films'));
const PLAYERS = Number(a.players) === 4 ? 4 : 1;
const FPS = Number(a.fps) || 30;
if (SIM_HZ % FPS) throw new Error(`--fps must divide ${SIM_HZ}`);
const EVERY = SIM_HZ / FPS;
const VIEW = PLAYERS === 4 ? { width: 960, height: 540 } : { width: 1280, height: 720 };

const { serveApp, launchBrowser, displayURL, hideChrome } = await import(pathToFileURL(path.join(TREE, 'scripts/lib/capture.mjs')));
const { TRACK_LIST } = await import(pathToFileURL(path.join(TREE, 'public/shared/tracks.js')));
const track = String(a.track || '');
if (!TRACK_LIST.some((t) => t.id === track)) throw new Error(`--track: one of ${TRACK_LIST.map((t) => t.id).join(', ')}`);
const base = path.join(OUT, `${track}-${TAG}-${PLAYERS}p`);
fs.mkdirSync(OUT, { recursive: true });

// `n` steps of 1/60 s, the last drawn unless `draw` is false; answers cell 0's
// car. One step is start() + pauseAfterFrame() + __pump, run synchronously
// inside the pump.
const STEPS = ([n, draw, hz]) => {
  const s = window.__scene;
  for (let i = 0; i < n; i++) {
    s.setUndrawn(!draw || i < n - 1);
    s.start();
    s.pauseAfterFrame();
    window.__pump(1000 / hz);
  }
  const id = s._order.find((x) => s.cars.has(x));   // cell 0's car, as Stage draws it
  const c = window.__engine.getSnapshot().cars.find((x) => x.id === id);
  return { totalS: c.totalS, lat: c.lat, finished: c.finished };
};

const app = await serveApp();
const browser = await launchBrowser();
try {
  const page = await browser.page({ viewport: VIEW, deviceScaleFactor: 1 });
  await page.goto(displayURL(app.port, { scenario: 'racing', track, players: PLAYERS, dpr: 1, gate: 1, hud: 0, detail: DETAIL }));
  // The field's build must have LANDED, not just begun: while it is in
  // flight a frame skips the renderer (Display.setTrack has released the
  // field) but still steps the sim, so the scene clock every set piece's
  // motion runs on would trail the race by however many frames the fetches
  // took. Interval polling: under the gate the page's rAF never fires.
  await page.waitForFunction((n) => window.__scene && window.__engine && window.__scene.cars.size >= n
                             && window.__scene.sceneBuilt(), PLAYERS, { timeout: 180000, polling: 250 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // A tree that predates the tier ignores ?detail= and would film full under a lite name.
  const tier = await page.evaluate(() => window.__scene.detail);
  if (DETAIL === 'lite' && tier !== 'lite') throw new Error(`${TREE} has no lite tier (it drew ${tier ?? 'no tier'})`);
  await hideChrome(page);
  await page.evaluate((hz) => window.__scene.setFixedStep(1 / hz), SIM_HZ);
  // The lap the sim counts: the tree's own builder's length, which any tree
  // can answer (a tree without the landmark ABI has no setLayout).
  const nativeTrack = await import(pathToFileURL(path.join(TREE, 'scripts/native-track.mjs')));
  await nativeTrack.init();
  const len = nativeTrack.buildTrack(track).length;

  // Lap 1 and the grid, undrawn: a second at a time, then a step at a time
  // as the line nears, the step that crosses it drawn (a 60 Hz step covers
  // well under a unit).
  let c = { totalS: -Infinity };
  while (c.totalS < len && !c.finished) {
    const left = len - c.totalS;
    c = await page.evaluate(STEPS, left > 40 ? [SIM_HZ, false, SIM_HZ] : [1, left < 1, SIM_HZ]);
  }
  if (c.finished) throw new Error(`cell 0's car finished before lap 2 of ${track}`);

  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', `${base}.mp4`
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('exit', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));
  const frames = [];
  for (let k = 0; c.totalS < 2 * len && !c.finished; k++) {
    const png = await page.screenshot();
    if (k === FPS) await page.screenshot({ path: `${base}.jpg`, type: 'jpeg', quality: 88 });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    frames.push([+(k / FPS).toFixed(4), +(c.totalS - len).toFixed(3), +c.lat.toFixed(3)]);
    if (k % (FPS * 5) === 0) process.stdout.write(`  ${track} ${TAG} ${PLAYERS}P  ${(k / FPS).toFixed(0)} s  s ${(c.totalS - len).toFixed(0)}/${len.toFixed(0)}\r`);
    c = await page.evaluate(STEPS, [EVERY, true, SIM_HZ]);
  }
  ff.stdin.end();
  await done;

  const lapSeconds = +(frames.length / FPS).toFixed(3);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ track, tag: TAG, tree: TREE, players: PLAYERS, detail: DETAIL, fps: FPS, len, lapSeconds, frames }));
  console.log(`${path.basename(base)}: ${frames.length} frames, lap ${lapSeconds} s -> ${base}.mp4`);
} finally {
  await browser.close();
  app.close();
}
