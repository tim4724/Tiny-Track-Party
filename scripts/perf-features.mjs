// Per-feature GPU cost map for the display renderer.
//
// Drives one real display page and ablates one group of renderables at a time
// (ttp_display_debug_features / TTP_FEAT_*), reading the GPU timer the perf HUD
// already wraps around ttp_display_frame. What comes out is "what does the sky
// cost", per cell count and per resolution.
//
// WHY IT IS SHAPED LIKE THIS — every line is a trap already paid for once here
// (see public/display/CLAUDE.md, "Measuring frame cost"):
//
//   • HEADED. Headless Chromium is SwiftShader; the numbers would describe a
//     software rasterizer.
//   • ARMS INTERLEAVE ROUND-ROBIN inside ONE page load. The mask is a live
//     toggle, so every arm sees the same process, the same driver state and the
//     same warmed shader cache; medians across rounds then absorb the drift that
//     swamped the artifact-swap A/Bs this replaces.
//   • ?dpr= PINS the buffer. It is a request, not a cap, and it also switches
//     the adaptive render scale off — which would otherwise resize the buffer
//     mid-sweep and quietly compare two arms at two resolutions.
//   • ?gate=1 AND FRAMES IN BURSTS, rather than --disable-frame-rate-limit.
//     Uncapped, an ablated arm runs at 700 fps, which breaks the instrument in
//     two ways at once: the query pool cannot resolve results that fast, and the
//     HUD's 120-FRAME statistics window shrinks to a sixth of a second. A burst
//     of frames pumped back to back leaves the GPU no idle gap to downclock in
//     (the trap that inverted earlier readings) and fills exactly the window the
//     HUD folds, whatever an arm's frame rate would have been.
//   • A FROZEN scenario. A live race moves the camera, and framing swamps the
//     effect being measured.
//   • navigator.webdriver spoofed false, or Stage caps the buffer to the E2E
//     scale and skips the shadow bake — i.e. measures a different renderer.
//
// Usage: node scripts/perf-features.mjs [--port 4211] [--track skyline]
//        [--players 4] [--dpr 1] [--rounds 5] [--json out.json]
import { chromium } from 'playwright';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const PORT = arg('port', '4211');
const TRACK = arg('track', 'skyline');
const SCENARIO = arg('scenario', 'racing');
// Frames of real racing to run before the field is frozen and measured. The
// scenario matters more than it looks: the start grid (countdown) is a wall of
// close-up car with road behind it, which is not what most of a race looks like.
// Under the gate the step is fixed, so the same number always lands on the same
// corner of the same lap.
const FREEZE_AT = parseInt(arg('freeze', '900'), 10);
const PLAYERS = parseInt(arg('players', '4'), 10);
const DPR = parseFloat(arg('dpr', '1'));
const ROUNDS = parseInt(arg('rounds', '5'), 10);
const OUT = arg('json', null);
const SHOT = arg('shot', null);
// Restrict the sweep to named arms ("all", "-road", "only cars", …). What it is
// for is re-measuring ONE arm across rebuilt artifacts, where running the other
// seventeen is minutes per data point.
const ONLY = arg('arms', null);

// Bursts of frames back to back, with a pause between them for the timer
// results to come back. TAIL_FRAMES is not optional: the HUD folds a result into
// the frame it belongs to from inside the NEXT frame's query, so without a few
// frames after the last burst the last burst's results are still in flight when
// the sample is read — which reads as "this arm had no GPU cost at all".
const BURSTS = 4, BURST_FRAMES = 40, STEP_MS = 16.7, DRAIN_MS = 150, TAIL_FRAMES = 20;

// The bits, mirrored from Display.js's FEAT (itself TTP_FEAT_* in
// ttp_display.h) — read out of the page rather than re-typed here.
const ARM_NAMES = ['ROAD', 'TERRAIN', 'DRESSING', 'SKY', 'CARS', 'EFFECTS'];
// The road's fragment channels. These are not groups of renderables — the deck
// is drawn either way — so they only ever get a marginal reading.
const ROAD_CHANNELS = ['ROAD_DECALS', 'ROAD_RUBBER', 'ROAD_PAINT', 'ROAD_SHADOW'];

const median = (a) => {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const main = async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Boot itself needs frames — the scene promise is not settled by fetches
    // alone — and under the gate nothing runs unless something pumps. So pump
    // from the moment the gate exists, and stop once the sweep takes over.
    // It stops the instant the race scenario exists, IN THE PAGE — not when the
    // driver gets round to saying so. A frame that runs after the scenario has
    // installed its hook is a frame of racing this script did not count, and a
    // round trip's worth of them is enough to freeze on a different corner
    // every run: measured as a 40% swing in the reference arm.
    const t = setInterval(() => {
      if (window.__stopWarmPump || window.__engine) { clearInterval(t); return; }
      if (window.__pump) window.__pump(16.7);
    }, 8);
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text()); });

  const url = `http://localhost:${PORT}/?scenario=${SCENARIO}&players=${PLAYERS}`
      + `&track=${TRACK}&seed=1&dpr=${DPR}&gate=1`;
  console.log(`# ${url}  rounds=${ROUNDS}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__sceneReady, null, { timeout: 60000 });
  await page.evaluate(() => window.__sceneReady);
  // STOP THE WARM PUMP BEFORE waiting for the race, not after. The scenario
  // installs its frame hook off promises, not frames, so nothing is lost — but
  // every frame that runs between the hook landing and the pump stopping is a
  // frame of racing this script did not count, and the freeze then lands on a
  // different corner every run. That was a 40% swing in a reading whose whole
  // premise is that every arm draws the same picture.
  await page.evaluate(() => { window.__stopWarmPump = true; });
  await page.waitForFunction(() => window.__engine, null, { timeout: 60000 });

  // Under the gate nothing draws until it is asked to, so the whole warm-up —
  // shader compilation, the first uploads — has to be pumped before anything is
  // measured, or the first arm of the first round wears it.
  await page.evaluate(async (frames) => {
    // Race into the middle of a lap, then FREEZE: onFrame off stops the sim
    // advancing, hold() stops the renderer's own cosmetics. Every arm then draws
    // the same picture, which is the only way the arms are comparable at all.
    for (let i = 0; i < frames; i++) {
      window.__pump(16.7);
      if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0)); // let the tab breathe
    }
    window.__scene.onFrame = null;
    window.__scene.hold(true);
    for (let i = 0; i < 60; i++) window.__pump(16.7);
    await new Promise((r) => setTimeout(r, 500));
  }, SCENARIO === 'racing' ? FREEZE_AT : 120);
  // The GPU timer has to actually be there — on a backend without the extension
  // every sample is null and the whole sweep reads as zero cost.
  const probe = await page.evaluate(() => window.__perf.sample());
  if (probe.gpuTimer !== 'ext') throw new Error(`no GPU timer (${probe.gpuTimer})`);
  console.log(`# buffer ${probe.pixels[0]}x${probe.pixels[1]}  cells ${probe.cells}`);
  if (SHOT) {
    // The frozen frame, so two runs can be compared as pixels rather than
    // trusted to have landed on the same corner. The HUD goes first — its scope
    // is a picture of the last three seconds and never repeats, so leaving it up
    // makes every capture differ for a reason that has nothing to do with the
    // scene.
    await page.evaluate(async () => {
      window.__perf.hide();
      for (let i = 0; i < 3; i++) { window.__pump(16.7); await new Promise((r) => setTimeout(r, 20)); }
    });
    await page.screenshot({ path: SHOT });
    await page.evaluate(() => window.__perf.show());
    console.log(`# wrote ${SHOT}`);
  }

  const FEAT = await page.evaluate(async () => {
    const m = await import('/display/render/Display.js');
    return m.FEAT;
  });
  const CHAN = ROAD_CHANNELS.reduce((m, n) => m | FEAT[n], 0);
  // ALL first (the reference), then one group dropped at a time, then the bare
  // canvas — which is the present pass plus whatever a frame costs with nothing
  // in it, i.e. the floor every other reading sits on.
  // Two readings per group, because neither alone is the answer. DROPPING one
  // group gives its MARGINAL cost — what the frame saves if it goes, which is
  // what an optimisation would actually buy, and it is smaller than the group's
  // own work because whatever was behind it now has to be drawn. Running one
  // group ALONE gives its STANDALONE cost — its own draw calls and fill with
  // nothing occluding it, which is the upper bound and the one that ranks the
  // groups against each other.
  const arms = [
    { name: 'all', mask: FEAT.ALL },
    ...ARM_NAMES.map((n) => ({ name: `-${n.toLowerCase()}`, mask: FEAT.ALL & ~FEAT[n] })),
    // A solo arm keeps the road's fragment channels ON: they are not one of the
    // groups, and dropping them silently would make "only road" a reading of a
    // deck with nothing painted on it.
    ...ARM_NAMES.map((n) => ({ name: `only ${n.toLowerCase()}`, mask: FEAT[n] | CHAN })),
    ...ROAD_CHANNELS.map((n) => ({ name: `-${n.toLowerCase()}`, mask: FEAT.ALL & ~FEAT[n] })),
    // The deck with every channel off is the road's own floor: its geometry,
    // its Lambert term and the grade, and nothing it was asked to paint.
    { name: '-road channels', mask: FEAT.ALL & ~CHAN },
    { name: 'none', mask: CHAN },
  ];

  // EVERY ARM IS MEASURED AGAINST A REFERENCE TAKEN BESIDE IT. The absolute
  // numbers drift over a run — the machine warms, the GPU's clocks move — by
  // more than the small groups cost, so an arm measured in round 1 and another
  // in round 5 cannot be subtracted. Taking `all` again immediately before each
  // arm makes every delta a paired reading, and the drift cancels. It doubles
  // the sweep's length and it is the difference between "sky costs 0.02 ms" and
  // a column of numbers with random signs in it.
  if (ONLY) {
    const keep = new Set(ONLY.split(',').map((s) => s.trim()));
    keep.add('all');    // the reference and the floor are what every number is against
    keep.add('none');
    for (let i = arms.length - 1; i >= 0; i--) if (!keep.has(arms[i].name)) arms.splice(i, 1);
  }
  const samples = new Map(arms.map((a) => [a.name, []]));
  const deltas = new Map(arms.map((a) => [a.name, []]));
  const measure = (mask, condition) => page.evaluate(async ([m, cond, cfg]) => {
    // CONDITION THE GPU FIRST, with the full scene, always. Every measurement
    // then arrives with the same recent history behind it. Without this the
    // reading depends on what ran before it: a cheap arm lets the machine cool,
    // and the next heavy reading comes back ~20% faster than the same arm taken
    // after another heavy one. That is a bigger effect than most of the groups
    // being measured, and it does not average out — the running order decides
    // which arms get it.
    window.__scene.display.debugFeatures(cond);
    for (let i = 0; i < cfg.frames; i++) window.__pump(cfg.step);
    await new Promise((res) => setTimeout(res, cfg.drain));
    window.__scene.display.debugFeatures(m);
    window.__perf.reset();   // the previous arm's frames are not this one's
    for (let b = 0; b < cfg.bursts; b++) {
      for (let i = 0; i < cfg.frames; i++) window.__pump(cfg.step);
      await new Promise((res) => setTimeout(res, cfg.drain));
    }
    for (let i = 0; i < cfg.tail; i++) {
      window.__pump(cfg.step);                       // drains the last burst's results
      await new Promise((res) => setTimeout(res, 8));
    }
    return window.__perf.sample();
  }, [mask, condition, { bursts: BURSTS, frames: BURST_FRAMES, step: STEP_MS,
                         drain: DRAIN_MS, tail: TAIL_FRAMES }]);

  const record = (name, s) =>
      samples.get(name).push({ gpu: s.gpu.p50, cpu: s.cpu.p50, n: s.gpu.n });
  const ALL = arms[0];
  for (let r = 0; r < ROUNDS; r++) {
    // ROTATE the order every round, so no arm always follows the same one.
    const rest = arms.slice(1);
    const order = rest.slice(r % rest.length).concat(rest.slice(0, r % rest.length));
    for (const a of order) {
      const ref = await measure(ALL.mask, ALL.mask);
      const s = await measure(a.mask, ALL.mask);
      record(ALL.name, ref);
      record(a.name, s);
      if (ref.gpu.p50 != null && s.gpu.p50 != null) {
        deltas.get(a.name).push(ref.gpu.p50 - s.gpu.p50);
      }
    }
    process.stdout.write(`# round ${r + 1}/${ROUNDS}\n`);
  }
  await page.evaluate(async () => {
    const m = await import('/display/render/Display.js');
    window.__scene.display.debugFeatures(m.FEAT.ALL);
  });

  const rows = arms.map((a) => {
    const xs = samples.get(a.name);
    return {
      arm: a.name,
      gpuMs: median(xs.map((x) => x.gpu)),
      cpuMs: median(xs.map((x) => x.cpu)),
      // The paired saving against the reference beside it — this, not the
      // difference of two medians, is what the tables below quote.
      saved: median(deltas.get(a.name)),
      n: median(xs.map((x) => x.n)),
    };
  });
  // The tables quote the MEDIAN ABSOLUTE of each arm, differenced against the
  // reference's. `saved` — the median of the paired readings taken beside each
  // arm — is printed alongside as a cross-check, and the two agreeing is how you
  // know the machine was quiet: under load the pairs scatter and their median
  // stops meaning anything, while the per-arm medians stay put.
  const by = (name) => rows.find((r) => r.arm === name);
  const base = by('all').gpuMs;
  const floor = by('none').gpuMs ?? 0;
  const drawn = base - floor;
  const ms = (v) => (v == null ? '   —  ' : v.toFixed(3));
  console.log(`\nfull frame ${ms(base)} ms   empty-scene floor ${ms(floor)} ms`
      + `   → ${drawn.toFixed(3)} ms of drawing`);
  console.log('\ngroup       marginal (drop)      standalone (alone)');
  let sum = 0;
  for (const n of ARM_NAMES) {
    if (!by(`-${n.toLowerCase()}`) || !by(`only ${n.toLowerCase()}`)) continue;
    const marg = base - by(`-${n.toLowerCase()}`).gpuMs;
    const alone = by(`only ${n.toLowerCase()}`).gpuMs - floor;
    if (marg != null) sum += marg;
    console.log(`${n.toLowerCase().padEnd(10)} `
        + `${marg == null ? '   —  ' : marg.toFixed(3)} ms `
        + `${marg == null ? '      ' : (100 * marg / drawn).toFixed(1).padStart(5) + '%'}`
        + `      ${alone == null ? '   —  ' : alone.toFixed(3)} ms `
        + `${alone == null ? '      ' : (100 * alone / drawn).toFixed(1).padStart(5) + '%'}`);
  }
  console.log('\nroad shader channel   marginal (drop)');
  for (const n of [...ROAD_CHANNELS, 'road channels']) {
    if (!by(`-${n.toLowerCase()}`)) continue;
    const marg = base - by(`-${n.toLowerCase()}`).gpuMs;
    console.log(`  ${n.toLowerCase().replace('road_', '').padEnd(20)}`
        + `${marg == null ? '   —  ' : marg.toFixed(3)} ms `
        + `${marg == null ? '' : (100 * marg / drawn).toFixed(1).padStart(5) + '%'}`);
  }
  console.log(`\n# marginal deltas sum to ${sum.toFixed(3)} ms `
      + `(${(100 * sum / drawn).toFixed(0)}% of what is drawn) — the shortfall is`
      + ` the fill each group was hiding, which the group behind it takes over.`);
  console.log('\nraw arms (absolute median, and the paired saving vs `all`):');
  for (const row of rows) {
    console.log(`  ${row.arm.padEnd(14)} ${ms(row.gpuMs)} ms   saved ${ms(row.saved)} ms`
        + `   cpu ${ms(row.cpuMs)} ms   n=${row.n}`);
  }

  if (OUT) {
    const fs = await import('node:fs');
    fs.writeFileSync(OUT, JSON.stringify({ url, dpr: DPR, pixels: probe.pixels,
        cells: probe.cells, rounds: ROUNDS, rows }, null, 2));
    console.log(`# wrote ${OUT}`);
  }
  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
