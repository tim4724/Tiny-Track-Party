// THE FRAME MAP: where one frame's time goes on the Android TV box, step by
// step, at 1 and at 4 players.
//
//   node scripts/perf-frame.mjs --players 1,4 --track tidepool --pin 0.5
//
//   --players 1,4     one column per count; the cell count follows the seats
//   --track           pin it: a lap's own cost varies by ~4 ms between circuits
//   --pin             hold the render scale (see the saturation note below)
//   --hz 30           present every OTHER vsync; the readout follows the pin
//   --seconds         the frame map's own window, per player count
//   --armSeconds      seconds of race each ablation arm is folded over
//   --serial          an explicit adb device
//   --json out.json   the whole run, including what the table has no room for
//
// `perf-race.mjs` answers "where does this box settle" in one number per run.
// This answers the question under it — which STEP of a frame holds the
// milliseconds — and it exists because no single instrument on this platform can
// say. It folds three, and the table names which one every row came from,
// because they are not the same clock and they do not sum:
//
//   MAIN THREAD   the Choreographer callback, split by `PerfMonitor`'s per-phase
//                 window: the renderer's own zones (`ttp_display_profile`) plus
//                 the shell's three spans around them (`sim`, `slow`, `other`).
//                 Read off the `phase50` / `phase95` log lines.
//   BACKEND       Filament's `FEngine::loop`, sampled from /proc as CPU seconds
//                 and divided by the frames that were presented. It is the
//                 largest consumer in the process on this box and every
//                 in-process instrument is blind to it: culling and command
//                 GENERATION are the main thread's, command EXECUTION is here.
//   GPU           the backend's own timer (real on this driver), whole-frame,
//                 plus a per-group marginal from an ablation sweep.
//
// WHY EVERY ARM IS ITS OWN RACE, and not several short arms interleaved inside
// one. Interleaving was tried here first, on the reasoning that it holds the
// process, the driver state and the shader cache still. It does — and it is
// still the wrong instrument, because on a LIVE race none of those is the
// confound: WHERE ON THE LAP the sample lands is. A lap's own cost varies by
// about 4 ms on this box, so short arms taken seconds apart are priced at
// different corners, and the readings say so out loud — the unablated arm came
// back with a 7.4 ms spread across rounds and one ablated arm read HIGHER than
// the full picture. Only a fold over a large slice of circuit averages that out,
// which is what a whole-race arm is and what `perf-race.android.mjs` has always
// insisted on. `PerfDebug` dropping both windows on a mask change is kept
// regardless: it is what stops an arm inheriting the last one's history.
//
// The traps this is shaped around are `shells/androidtv/CLAUDE.md`'s, and none
// of them are optional:
//
//   • A PINNED SCALE. The adaptive rule resizes the buffer underneath a sweep
//     and hands back a 3x swing between arms that differ in nothing.
//   • A PINNED TRACK, and the grid thrown away. A lap's own cost varies by ~4 ms
//     and the opening seconds are a picture nobody plays.
//   • THE FIRST RUN AFTER AN INSTALL MEASURES THE INSTALL — dex/JIT and shader
//     warmup are worth a whole rung. Run this twice and keep the second.
//   • AN ARM THAT FITS THE BUDGET CANNOT BE PRICED. A frame that presents on
//     every vsync leaves the GPU idle, the box downclocks into the gap, and this
//     backend's timer reads the PACED span rather than the work — so every arm
//     comes back at the same number whatever it dropped. It is loud when it
//     happens (hiding the road read 2.9 ms SLOWER than drawing it, at 1 player
//     and 540 lines) and silent-looking in a table, so the sweep says which
//     columns it applies to. Pin a column that paces up until it saturates.
//   • THE BENCH RACE ENDS. It is a real race over a real number of laps, and it
//     is shorter than a sweep — an early version of this script read its last
//     arms off the RESULTS board and reported a 4-player split that cost what
//     one player does, with nothing in the numbers looking wrong. Every readout
//     carries its own `cells`, so only lines the race you meant logged are
//     folded, and a window that finds none stands a new race up.
//
// And the one that decides how to read the table: A GPU MEDIAN UNDER BUDGET IS
// NOT 60 fps. A present lands on a vsync or it does not, so both p50 and p95 are
// printed and the p95 is the one that sets the rate.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { GRID_MS } from './perf-race.mjs';
import { ADB, findTvDevice } from './lib/androidtv-device.mjs';
import {
  arg, sleep, pct, phases, PACKAGE, ACTIVITY, SCENARIO, EXTRA_SCENARIO,
  EXTRA_TRACK, EXTRA_PLAYERS, READY_TIMEOUT_MS, FEAT, GROUPS, EMPTY, hex,
} from './lib/androidtv-bench.mjs';

const PLAYERS = arg('players', '1,4').split(',').map((n) => parseInt(n, 10));
const TRACK = arg('track', 'tidepool');
const PIN = arg('pin', '0.5');
const HZ = arg('hz', '0');
const SECONDS = parseFloat(arg('seconds', '15'));

const OUT = arg('json', null);

/**
 * Seconds of race each arm is folded over, on top of the grid this throws away.
 * The bench's own default, and the one this platform's readings are documented
 * to repeat at (~0.6 ms of GPU median). It is the circuit being averaged, not the
 * statistics settling: see the note at the top of this file.
 */
const ARM_SECONDS = parseFloat(arg('armSeconds', '45'));

const median = (xs) => pct(xs, 0.5);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** A millisecond column, or a dash for a series this run has none of. */
const fmt = (v, w = 6) => (v == null ? '-'.padStart(w) : v.toFixed(1).padStart(w));

// ---------------------------------------------------------------------------
// The box.
// ---------------------------------------------------------------------------

function box(serial) {
  const adb = (...a) => execFileSync(ADB, ['-s', serial, ...a], { encoding: 'utf8' });
  const setprop = (k, v) => adb('shell', 'setprop', k, String(v));

  /**
   * Per-thread CPU, in milliseconds, off /proc. utime and stime are fields 14
   * and 15 of `stat`; everything before them is parsed from the LAST `)` rather
   * than by splitting, because a thread name can hold spaces and parentheses and
   * two of this process's do.
   */
  const clkTck = parseInt(adb('shell', 'getconf', 'CLK_TCK').trim(), 10) || 100;
  const threads = (pid) => {
    const out = adb('shell', `cat /proc/${pid}/task/*/stat 2>/dev/null`);
    const by = new Map();
    for (const line of out.split('\n')) {
      const close = line.lastIndexOf(')');
      const open = line.indexOf('(');
      if (close < 0 || open < 0) continue;
      const name = line.slice(open + 1, close);
      const f = line.slice(close + 2).trim().split(/\s+/);
      const ms = ((+f[11] || 0) + (+f[12] || 0)) * (1000 / clkTck);
      by.set(name, (by.get(name) ?? 0) + ms);
    }
    return by;
  };

  return { adb, setprop, threads,
    pid: () => parseInt(adb('shell', 'pidof', PACKAGE).trim().split(/\s+/)[0], 10) };
}

// ---------------------------------------------------------------------------
// One player count: launch, map the frame, sweep the arms.
// ---------------------------------------------------------------------------

async function measure(dev, players) {
  const { adb, setprop, threads, pid } = dev;
  // The log, timestamped ON ARRIVAL: every window below is a time range over
  // this one buffer rather than a second subscription.
  const log = [];
  let ready = null;

  const onLine = (line) => {
    const shot = line.match(/I\/TtpShot\s*\(\s*\d+\):\s*(ready|failed|unsupported) (\S+)/);
    if (shot && shot[2] === SCENARIO) { ready?.(shot[1]); return; }
    const perf = line.match(/I\/TtpPerf\s*\(\s*\d+\):\s*(.*)$/);
    if (perf) {
      const text = perf[1].trim();
      const t = Date.now();
      if (text.startsWith('{')) { try { log.push({ t, readout: JSON.parse(text) }); } catch { /* torn line */ } }
      else if (text.startsWith('phase50 ')) log.push({ t, p50: phases(text) });
      else if (text.startsWith('phase95 ')) log.push({ t, p95: phases(text) });
      return;
    }
  };

  adb('logcat', '-c');
  const logcat = spawn(ADB, ['-s', dev.serial, 'logcat', '-v', 'brief', '-T', '1'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let tail = '';
  logcat.stdout.setEncoding('utf8');
  logcat.stdout.on('data', (chunk) => {
    const parts = (tail + chunk).split('\n');
    tail = parts.pop() ?? '';
    for (const l of parts) onLine(l);
  });

  /**
   * Stand a fresh bench race up and let its grid go by. Called again mid-sweep
   * when the race this one is measuring has finished.
   *
   * A SLEEPING BOX NEVER CREATES A SURFACE, and it reads exactly like a hung
   * room. `-S` is required: the activity is `singleTask`, so without it
   * onCreate never re-runs and the extras are never read.
   */
  const launchBench = async (mask = FEAT.ALL) => {
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    setprop('debug.ttp.features', hex(mask));
    setprop('debug.ttp.scale', PIN);
    setprop('debug.ttp.aa', 0);
    setprop('debug.ttp.hz', HZ);
    adb('shell', 'am', 'start', '-S', '-n', ACTIVITY,
      '--es', EXTRA_SCENARIO, SCENARIO, '--es', EXTRA_TRACK, TRACK,
      '--ei', EXTRA_PLAYERS, String(players));

    const verdict = await new Promise((resolve) => {
      const timer = setTimeout(() => { ready = null; resolve('timeout'); }, READY_TIMEOUT_MS);
      ready = (v) => { clearTimeout(timer); ready = null; resolve(v); };
    });
    if (verdict !== 'ready') {
      throw new Error(`the bench race never stood up (${verdict})`
        + ' — is the app installed and built from this tree?');
    }
    // THE MASK GOES ON WITH A SCENE UP: `ttp_display_debug_features` early-returns
    // with nothing to tag, and the poll has already recorded it as applied. It is
    // written before the launch as well, so a run that dies here leaves the box
    // in the state the restore path knows about.
    setprop('debug.ttp.features', hex(mask));
    console.log(`[${players}P] settling ${(GRID_MS / 1000).toFixed(0)}s of grid…`);
    await sleep(GRID_MS);
  };

  /**
   * A readout this race logged, and not one the results board did. `cells` is
   * the seated player count for the whole of a bench race and something else the
   * moment the race is over, which is the only in-band way to tell from here.
   */
  const racing = (r) => r && !r.warming && r.cells === players;

  try {
    console.log(`\n[${players}P] launching…`);
    await launchBench();

    // ---- PASS A: the frame map, full picture ----
    console.log(`[${players}P] mapping the frame over ${SECONDS}s…`);
    const p = pid();
    const t0 = Date.now();
    const before = threads(p);
    await sleep(SECONDS * 1000);
    const after = threads(p);
    const elapsedSec = (Date.now() - t0) / 1000;
    const windowLog = log.filter((e) => e.t >= t0);
    const readouts = windowLog.filter((e) => racing(e.readout)).map((e) => e.readout);
    if (!readouts.length) {
      throw new Error(`no ${players}-cell readouts in the map window`
        + ' — did the race end before it, or is the seat count not the cell count?');
    }

    // Frames per second of the WINDOW, which is what turns a thread's CPU
    // seconds into CPU per frame. `fps` is presents; `hz` is callbacks, and the
    // gap between them is exactly what this box's problem is.
    const fps = mean(readouts.map((r) => r.fps).filter((v) => v > 0)) ?? 0;
    const perFrame = new Map();
    for (const [name, ms] of after) {
      const d = ms - (before.get(name) ?? 0);
      if (d <= 0) continue;
      perFrame.set(name, { msPerSec: d / elapsedSec, msPerFrame: fps > 0 ? d / (fps * elapsedSec) : null });
    }

    const foldPhase = (key) => {
      const rows = windowLog.filter((e) => e[key]).map((e) => e[key]);
      const names = [...new Set(rows.flatMap(Object.keys))];
      return Object.fromEntries(names.map((n) => [n, median(rows.map((r) => r[n]))]));
    };
    const map = {
      players,
      readout: {
        width: readouts.at(-1).width, height: readouts.at(-1).height,
        cells: readouts.at(-1).cells, budgetMs: readouts.at(-1).budgetMs,
        fps, hz: mean(readouts.map((r) => r.hz)),
        skips: mean(readouts.map((r) => r.skips)), drops: mean(readouts.map((r) => r.drops)),
        gpuP50: median(readouts.map((r) => r.gpu?.p50)), gpuP95: median(readouts.map((r) => r.gpu?.p95)),
        cpuP50: median(readouts.map((r) => r.cpu?.p50)), cpuP95: median(readouts.map((r) => r.cpu?.p95)),
        frameP50: median(readouts.map((r) => r.frame?.p50)), frameP95: median(readouts.map((r) => r.frame?.p95)),
      },
      phase50: foldPhase('p50'),
      phase95: foldPhase('p95'),
      threads: Object.fromEntries(perFrame),
    };

    // ---- PASS B: the ablation sweep, one whole race per arm ----
    //
    // `all` is run TWICE, first and last, and the gap between the two is this
    // sweep's own resolution: the same picture measured either side of every
    // other arm, so whatever moved underneath the run in between is in it.
    const arms = [{ name: 'all', mask: FEAT.ALL }, { name: 'floor', mask: EMPTY },
      ...GROUPS.map((g) => ({ name: `-${g.toLowerCase()}`, mask: FEAT.ALL & ~FEAT[g] })),
      { name: 'all2', mask: FEAT.ALL }];
    map.arms = {};
    for (const a of arms) {
      // A RACE PER ARM. The mask goes on with a scene up (see [launchBench]) and
      // the grid goes in the bin; what is folded is a real lap being driven.
      await launchBench(a.mask);
      const from = Date.now();
      await sleep(ARM_SECONDS * 1000);
      const rs = log.filter((e) => e.t >= from && racing(e.readout)).map((e) => e.readout);
      map.arms[a.name] = {
        gpuP50: median(rs.map((r) => r.gpu?.p50)),
        gpuP95: median(rs.map((r) => r.gpu?.p95)),
        fps: mean(rs.map((r) => r.fps)),
        n: rs.length,
      };
      console.log(`[${players}P] ${a.name.padEnd(10)} `
        + `gpu ${fmt(map.arms[a.name].gpuP50)} p50 / ${fmt(map.arms[a.name].gpuP95)} p95`
        + `  fps ${(map.arms[a.name].fps ?? 0).toFixed(1)}  (${rs.length} readouts)`);
    }
    return map;
  } finally {
    logcat.stdout?.destroy();
    logcat.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

/**
 * The frame's steps in the order a callback runs them, with what each one is.
 * `nested` rows are a SUB-SPAN of the row above and are INDENTED — already
 * counted in it, so leave them out when adding the column up.
 */
const STEPS = [
  ['sim', 'ttp_update: the sim tick, the event drain and the audio decisions'],
  ['build', 'buildFrame: the frame input the renderer is handed'],
  ['cars', 'car poses, wheels, streaks, contact-shadow stamps'],
  ['world', 'deck, terrain, dressing, sky, item and effect pools'],
  ['decalUp', 'the deck decal upload, inside `world`', true],
  ['skids', 'the rubber layer: raster, dirty-rect uploads, mips'],
  ['ambient', 'the per-camera particle box'],
  ['beginFrame', 'merged-draw transform mirroring, then Renderer::beginFrame'],
  ['cellSetup', 'per cell: camera, fog, billboards, the monster swap'],
  ['cellRender', 'per cell: Renderer::render — cull and command GENERATION'],
  ['present', 'the antialias pass (off here) and the cell overlay'],
  ['endFrame', 'Renderer::endFrame — the commit'],
  ['slow', 'the ~6 Hz HUD poll, the knob poll and the pacing declaration'],
  ['other', 'the callback remainder: the resize latch and the loop itself'],
];

function table(maps) {
  const cols = maps.map((m) => `${m.players}P`);
  const W = 13 + 14 * cols.length;
  const head = (label) => `${label.padEnd(13)}${cols.map((c) => c.padStart(7) + c.padStart(7)).join('')}`;
  const sub = () => `${''.padEnd(13)}${cols.map(() => '    p50    p95').join('')}`;

  console.log(`\n${'='.repeat(W)}`);
  console.log('THE FRAME, STEP BY STEP — milliseconds');
  for (const m of maps) {
    console.log(`  ${m.players}P: ${m.readout.width}x${m.readout.height} · ${m.readout.cells} cells`
      + ` · ${m.readout.fps.toFixed(1)} fps of ${m.readout.hz.toFixed(0)} hz`
      + ` · budget ${m.readout.budgetMs.toFixed(1)} ms`
      + ` · ${m.readout.skips.toFixed(1)} skips/s`);
  }
  console.log('='.repeat(W));

  console.log(`\nMAIN THREAD — the Choreographer callback, split (PerfMonitor)`);
  console.log(head('step'));
  console.log(sub());
  for (const [key, what, nested] of STEPS) {
    const row = maps.map((m) => fmt(m.phase50[key]) + fmt(m.phase95[key])).join('');
    console.log(`${(nested ? `  ${key}` : key).padEnd(13)}${row}   ${what}`);
  }
  console.log('-'.repeat(W));
  console.log(`${'renderer'.padEnd(13)}`
    + maps.map((m) => fmt(m.phase50.total) + fmt(m.phase95.total)).join('')
    + '   ttp_display_frame, i.e. `cars` through `endFrame`');
  console.log(`${'callback'.padEnd(13)}`
    + maps.map((m) => fmt(m.phase50.callback) + fmt(m.phase95.callback)).join('')
    + '   the whole callback; Compose runs AFTER it and is outside every row');

  console.log(`\nOTHER THREADS — CPU ms per presented frame (/proc, whole window)`);
  const names = [...new Set(maps.flatMap((m) => Object.keys(m.threads)))]
    .filter((n) => maps.some((m) => (m.threads[n]?.msPerFrame ?? 0) >= 0.2))
    .sort((a, b) => (maps[0].threads[b]?.msPerFrame ?? 0) - (maps[0].threads[a]?.msPerFrame ?? 0));
  console.log(`${'thread'.padEnd(20)}${cols.map((c) => c.padStart(9)).join('')}`);
  for (const n of names) {
    console.log(`${n.slice(0, 19).padEnd(20)}`
      + maps.map((m) => fmt(m.threads[n]?.msPerFrame, 9)).join(''));
  }
  console.log('  FEngine::loop is Filament\'s backend: GL command EXECUTION, and the one');
  console.log('  consumer no in-process instrument can see. It runs CONCURRENTLY with the');
  console.log('  main thread, so it does not add to the rows above — it bounds them.');

  // AN ARM THAT NEVER MISSES A VSYNC IS NOT A MEASUREMENT (see the header). The
  // unablated arm's own frame rate is what says so, and it is stated per column
  // rather than left for a reader to notice.
  const paced = (m) => (m.arms?.all?.fps ?? 0) >= 0.92 * (m.readout.hz || 60);
  console.log(`\nGPU — the backend's own timer, and what each group costs (ablation)`);
  for (const m of maps.filter(paced)) {
    console.log(`  !! ${m.players}P PRESENTED EVERY VSYNC at this pin`
      + ` (${m.arms.all.fps.toFixed(1)} fps) — its column below is a PACED SPAN,`
      + ` not a cost.\n     Re-run this player count at a pin that saturates.`);
  }
  console.log(head('arm'));
  console.log(sub());
  const armRow = (label, pick) => console.log(`${label.padEnd(13)}`
    + maps.map((m) => fmt(pick(m, 'gpuP50')) + fmt(pick(m, 'gpuP95'))).join(''));
  // The unablated arm, run first and last, is the baseline every marginal is
  // taken against — averaged, so a drift across the sweep is halved into every
  // row rather than landing entirely on the arms measured late.
  const base = (m, k) => mean([m.arms.all?.[k], m.arms.all2?.[k]].filter((v) => v != null));
  armRow('whole frame', base);
  armRow('floor', (m, k) => m.arms.floor?.[k]);
  // THE RESOLUTION OF THIS SWEEP, measured rather than assumed: the same picture
  // measured either side of every other arm. Nothing narrower than this gap is a
  // result, whatever the row says.
  const spread = (m, k) => (m.arms.all?.[k] != null && m.arms.all2?.[k] != null
    ? Math.abs(m.arms.all[k] - m.arms.all2[k]) : null);
  console.log(`${'  (repeat)'.padEnd(13)}`
    + maps.map((m) => fmt(spread(m, 'gpuP50')) + fmt(spread(m, 'gpuP95'))).join('')
    + '   the SAME arm either side of the sweep — the resolution, not a cost');
  for (const g of GROUPS) {
    const key = `-${g.toLowerCase()}`;
    console.log(`${g.toLowerCase().padEnd(13)}`
      + maps.map((m) => {
        const off = m.arms[key];
        return fmt(off?.gpuP50 != null ? base(m, 'gpuP50') - off.gpuP50 : null)
          + fmt(off?.gpuP95 != null ? base(m, 'gpuP95') - off.gpuP95 : null);
      }).join('') + `   marginal: what the frame loses when this group is dropped`);
  }
  console.log('  A marginal can be NEGATIVE and that is a real reading, not noise: cars');
  console.log('  occlude deck fragments, so hiding them makes the frame slower.');
  console.log('  Anything narrower than the (repeat) row is not a result.');
}

// ---------------------------------------------------------------------------

const main = async () => {
  const serial = findTvDevice(arg('serial', null));
  const dev = { ...box(serial), serial };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    // A knob outlives a force-stop AND a reinstall, and `PerfDebug` is live in
    // RELEASE — a leftover mask turns up in a shipping build's picture with
    // nothing to explain it.
    try {
      for (const k of ['features', 'scale', 'aa', 'hz']) dev.setprop(`debug.ttp.${k}`, 0);
    } catch { /* the box went away; nothing to restore it on */ }
  };
  process.once('SIGINT', () => { restore(); process.exit(130); });
  process.once('SIGTERM', () => { restore(); process.exit(143); });
  process.once('exit', restore);

  const maps = [];
  for (const players of PLAYERS) maps.push(await measure(dev, players));
  restore();
  table(maps);
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ track: TRACK, pin: PIN, hz: HZ, maps }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
};

main().catch((e) => { console.error(e.message); process.exit(1); });
