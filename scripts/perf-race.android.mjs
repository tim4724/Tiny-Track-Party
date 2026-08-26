// The ANDROID TV backend of the frame-cost bench: stand a live race up on the
// box and hand back the readout lines it logs.
//
// `scripts/perf-race.mjs` owns the run — which track, how long, and the parsing,
// folding and printing that are the same on every platform, because the readout
// is one canonical JSON object (`native/runtime/ttp_perf.h`) on all three. This
// file owns only what is Android: adb, the intent, the `debug.ttp.*` knobs and
// logcat. It is registered there as `--platform androidtv`.
//
//   node scripts/perf-race.mjs --platform androidtv --players 4 --track tidepool
//   node scripts/perf-race.mjs --platform androidtv --pin 0.667   # hold 720p
//   node scripts/perf-race.mjs --platform androidtv --features 0x1DFC
//
// NO PHONES AND NO RELAY. The `bench` scenario seats its own players and the
// engine drives them (`ttp_race_autopilot_players`), so this no longer joins
// headless phones through the PROD relay and steers them with a sine wave —
// which was never a lap anybody drives, and made every run depend on a service
// on the internet. What is measured is a real launch: the field, the grid, the
// cells and the ids are the live game's, with the sim supplying the steering a
// phone would.
//
// WHAT A LIVE RACE MEASURES that a frozen bench cannot: the camera moves through
// the whole circuit, rubber is rasterised and uploaded, the skid mips refresh,
// and `ttp_display_scale_poll` resizes the buffer underneath all of it. A lap's own
// cost varies by about 4 ms on this box, so pin the track — two runs on two
// circuits are two different questions.
//
// IT MEASURES WHATEVER IS INSTALLED. Nothing here builds or installs, and the
// first run after an install measures the install (dex/JIT and shader warmup are
// worth a whole rung of render scale) — so throw the first one away.

import { execFileSync, spawn } from 'node:child_process';

import { GRID_MS, lineStream } from './perf-race.mjs';
import { ADB, findTvDevice } from './lib/androidtv-device.mjs';
import {
  arg, sleep, pct, phases, ACTIVITY, SCENARIO, EXTRA_SCENARIO, EXTRA_TRACK,
  EXTRA_PLAYERS, READY_TIMEOUT_MS, FEAT, hex,
} from './lib/androidtv-bench.mjs';

/** The un-ablated arm. `tests/feature-bits.test.js` pins the one mirror behind it. */
const TTP_FEAT_ALL = hex(FEAT.ALL);

/** The tag every shell prefixes its readout with, and what the shared half reads. */
const TAG = 'TtpPerf';


/**
 * A run, with its own state.
 *
 *   players / track / seconds  the shared runner's (`seconds` is COUNTED time:
 *                              the shared GRID_MS settle is on top of it)
 *   dpr                        ignored — this surface is its own pixels, and
 *                              what pins the buffer here is `--pin`
 *
 * Android-only flags, read off argv:
 *   --pin 0.667      hold the render scale (0 leaves the adaptive rule alone)
 *   --features 0x…   TTP_FEAT_* ablation mask
 *   --aa 1           put the full-screen antialias pass back on
 *   --hz 30          pin every-other-vsync. The readout follows it — the app
 *                    declares the divisor through `ttp_perf_pacing`, so
 *                    `budgetMs` doubles and every share on the line is against
 *                    that, which is what makes a paced arm comparable to a free
 *                    one.
 *   --vk 1           the Vulkan backend — the SHIPPING default, but an
 *                    unflagged arm pins GL so readings stay comparable to
 *                    every GL-era ledger; see shells/androidtv/CLAUDE.md.
 *   --serial <id>    an explicit adb device
 */
export function makeAndroidBackend() {
  let serial = null;
  let logcat = null;
  let restored = false;
  let timer = null;
  /** Readout lines not yet consumed, and the consumer waiting for one. */
  const lines = lineStream();
  let counting = false;
  let ready = null;
  /** The Android-only per-phase spike lines, folded by [report]. */
  const spikes = [];
  const phasemax = [];
  const phase50 = [];

  const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8' });
  const setprop = (k, v) => adb('shell', 'setprop', k, String(v));

  /**
   * Every knob back, and it is not optional tidying: `debug.ttp.*` survives a
   * force-stop and a reinstall, and PerfDebug is deliberately live in RELEASE —
   * so a leftover mask from a bench turns up in a shipping build's picture with
   * nothing to explain it. It used to restore only the scale, only on the
   * success path, and never `debug.ttp.hz` at all.
   */
  const restoreKnobs = () => {
    if (restored || !serial) return;
    restored = true;
    try {
      setprop('debug.ttp.scale', 0);
      setprop('debug.ttp.features', 0);   // 0 = "not set", i.e. draw everything
      setprop('debug.ttp.aa', 0);
      setprop('debug.ttp.hz', 0);
      setprop('debug.ttp.perf', 0);
      setprop('debug.ttp.vk', 0);         // a leftover 1 flips the ENGINE's backend
    } catch { /* the box went away; nothing to restore it on */ }
  };

  // A knob that outlives the process can only be cleaned up by the process that
  // set it, so this does not wait to be asked politely. The runner's own exit is
  // hard (a live logcat child would otherwise hold the event loop open, which
  // hung three measurement chains in one day), and a hard exit runs neither a
  // `finally` nor a promise.
  process.once('SIGINT', () => { restoreKnobs(); process.exit(130); });
  process.once('SIGTERM', () => { restoreKnobs(); process.exit(143); });
  process.once('exit', restoreKnobs);

  /**
   * Tail the WHOLE log and match in Node rather than passing `-s TtpPerf:I`.
   * Several filterspecs after `-s` make adb print nothing at all rather than
   * complaining, which reads exactly like a healthy run that logged nothing — it
   * cost a whole capture once — and this needs two tags.
   */
  const startLogcat = () => {
    logcat = spawn(ADB, ['-s', serial, 'logcat', '-v', 'brief', '-T', '1'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let tail = '';
    logcat.stdout.setEncoding('utf8');
    logcat.stdout.on('data', (chunk) => {
      const parts = (tail + chunk).split('\n');
      tail = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    });
  };

  const onLine = (line) => {
    const shot = line.match(/I\/TtpShot\s*\(\s*\d+\):\s*(ready|failed|unsupported) (\S+)/);
    if (shot && shot[2] === SCENARIO) { ready?.(shot[1]); return; }
    const perf = line.match(/I\/TtpPerf\s*\(\s*\d+\):\s*(.*)$/);
    if (!perf || !counting) return;
    const text = perf[1].trim();
    // The readout is the JSON object. The other two lines under this tag are the
    // renderer-CPU spike table, which is Android's alone — they go to [report]
    // rather than downstream, where the shared fold would have to know about a
    // shape only one platform has.
    if (text.startsWith('spike ')) { spikes.push(phases(text)); return; }
    if (text.startsWith('phasemax ')) { phasemax.push(phases(text)); return; }
    if (text.startsWith('phase50 ')) { phase50.push(phases(text)); return; }
    // `phase95` is logged too and is deliberately not folded here: this table is
    // about the TAIL, and the p95 of a window whose worst frame is already on the
    // line above says nothing a reader of this script came for. Named rather than
    // left to fall through — `readoutOf` would discard it as prose either way,
    // but a reader of this switch should not have to know that to be sure.
    if (text.startsWith('phase95 ')) return;
    lines.push(`${TAG} ${text}`);
  };

  // READINESS IS A LOG LINE, and it is the same one the screenshot runner waits
  // on: `Scenarios` emits it once the scene has landed AND the engine has
  // presented a few more frames. Never sleep instead — a cold shader compile is
  // seconds long here and reads as a healthy start.
  const waitForReady = () => new Promise((resolve) => {
    const t = setTimeout(() => { ready = null; resolve('timeout'); }, READY_TIMEOUT_MS);
    ready = (verdict) => { clearTimeout(t); ready = null; resolve(verdict); };
  });



  return {
    async launch({ players, track, seconds }) {
      serial = findTvDevice(arg('serial', null));

      // A property outlives a force-stop AND a reinstall, so an arm that does
      // not set one silently inherits the last arm's. Every one of them is
      // written here and cleared in `stop`, on every exit path.
      setprop('debug.ttp.scale', arg('pin', 0));
      setprop('debug.ttp.aa', arg('aa', 0));
      setprop('debug.ttp.hz', arg('hz', 0));
      // The READOUT stays down whatever a previous session left behind. The
      // scenario benches it (`PerfMonitor.bench`), which logs the line this
      // parser reads without drawing anything — and drawing it is four Compose
      // re-measures a second on the very thread being priced.
      setprop('debug.ttp.perf', 0);
      // The backend (`debug.ttp.vk`: 1 Vulkan, -1 GL, unset = VulkanPolicy,
      // which defaults to VULKAN). Explicit per arm — an unflagged arm PINS GL
      // so readings stay comparable to the GL-era ledgers — and set BEFORE the
      // launch below because a backend cannot be switched on a running engine.
      setprop('debug.ttp.vk', arg('vk', -1));

      adb('logcat', '-c');
      startLogcat();

      // A SLEEPING BOX NEVER CREATES A SURFACE: the app boots, logs its version
      // and sits there, which reads exactly like a hung room and photographs as
      // black.
      adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
      // `-S` (force-stop first) is REQUIRED, not tidy: the activity is
      // `singleTask`, so without it a second launch reaches onNewIntent,
      // onCreate never re-runs and the extras below are never read — the second
      // arm of a sweep would silently measure the first arm's track. Safe here:
      // a scenario opens no relay, so there is no room to strand.
      adb('shell', 'am', 'start', '-S', '-n', ACTIVITY,
        '--es', EXTRA_SCENARIO, SCENARIO,
        ...(track ? ['--es', EXTRA_TRACK, String(track)] : []),
        ...(players ? ['--ei', EXTRA_PLAYERS, String(players)] : []));

      const verdict = await waitForReady();
      if (verdict !== 'ready') {
        throw new Error(`the bench race never stood up (${verdict})`
          + ' — is the app installed and built from this tree?');
      }

      // THE MASK GOES ON WITH A SCENE UP, and that ordering is the whole of it:
      // `ttp_display_debug_features` early-returns when there is no scene to
      // tag, while PerfDebug has already recorded the value as applied — so a
      // mask set before launch lands only if a poll happens to fall after the
      // first build, and otherwise reads as a full-feature run wearing an
      // ablated label. It produced two different numbers for one arm before
      // this moved.
      setprop('debug.ttp.features', arg('features', TTP_FEAT_ALL));

      await sleep(GRID_MS);
      counting = true;
      timer = setTimeout(() => lines.end(), seconds * 1000);
      return lines;
    },

    /**
     * End the run: restore every knob and let go of logcat. The APP IS LEFT
     * RUNNING — the next launch force-stops it anyway, and killing it here would
     * leave the television on its home screen mid-sweep.
     */
    async stop() {
      clearTimeout(timer);
      if (logcat) {
        logcat.stdout?.destroy();
        logcat.kill('SIGKILL');
        logcat = null;
      }
      lines.end();
      restoreKnobs();
      report(spikes, phasemax, phase50);
    },
  };
}

/**
 * The frame-thread spike attribution, which has no shared half because it has no
 * counterpart in the other two shells: `ttp_display_profile`'s per-section split
 * is this renderer's own, and on this box the frame costs tens of milliseconds
 * and WHICH section holds them is the question. Each `spike` is ONE frame (the
 * window's worst by total+build, the span the `ttp:render` atrace marker times),
 * so "top-of-worst" is the share of those frames a phase held; `phasemax` folds
 * each phase's own window maxima, which also catches the second culprit.
 *
 * The frame thread's own spans ride the same lines now — `sim`, `slow` and
 * `other`, and `callback` over all of it (`PerfOverlay.kt`) — so the sim tick and
 * the HUD poll are no longer outside every number here. COMPOSE still is: it runs
 * after the callback returns, and `atrace` remains the only instrument for it.
 * `scripts/perf-frame.mjs` is what maps these properly; this table is the tail.
 */
function report(spikes, phasemax, phase50) {
  if (!spikes.length) return;
  // THE AGGREGATES ARE NOT PHASES, and leaving them in makes this table say
  // nothing. `callback` is by construction >= every column inside it, so the
  // argmax below picks it on essentially every frame: `top-of-worst` reads 100%
  // callback and 0% everywhere else, and the sort puts the total at the top of a
  // table whose whole point is which PART held the frame. `total` was excluded
  // for this reason already; `callback` arrived beside it and was not.
  const AGGREGATE = new Set(['total', 'callback']);
  const names = [...new Set(spikes.flatMap((o) => Object.keys(o)))]
    .filter((n) => !AGGREGATE.has(n));
  const tops = spikes.map((o) => names.reduce((a, n) => ((o[n] ?? 0) > (o[a] ?? 0) ? n : a)));
  const worst = spikes.map((o) => (o.total ?? 0) + (o.build ?? 0));
  const rows = names.map((n) => {
    const xs = phasemax.map((o) => o[n]).filter((v) => v != null);
    // WHAT A TYPICAL FRAME SPENT HERE, beside what the worst one did. Without it
    // the table cannot tell a phase that is always expensive from one that spikes
    // — and those two findings ask for opposite work.
    const mid = phase50.map((o) => o[n]).filter((v) => v != null);
    return {
      n,
      max: xs.length ? Math.max(...xs) : 0,
      p50: pct(xs, 0.5) ?? 0,
      typical: pct(mid, 0.5) ?? 0,
      top: Math.round((100 * tops.filter((t) => t === n).length) / tops.length),
    };
  }).sort((a, b) => b.max - a.max);
  console.log(`\n# frame-thread worst-frame p50 ${pct(worst, 0.5)?.toFixed(1)}`
    + ` / max ${Math.max(...worst).toFixed(1)} ms — by phase:`);
  for (const r of rows) {
    if (r.max < 0.5 && r.top === 0 && r.typical < 0.5) continue;
    console.log(`    ${r.n.padEnd(10)} typical ${r.typical.toFixed(1).padStart(5)} ms`
      + `   worst ${r.max.toFixed(1).padStart(5)} ms`
      + `   p50-of-worst ${r.p50.toFixed(1).padStart(5)} ms`
      + `   top-of-worst ${String(r.top).padStart(3)}%`);
  }
  console.log('    (`sim`, `slow` and `other` are the frame thread OUTSIDE the renderer.'
    + ' `total` and `callback` are the two AGGREGATES and are left out of the'
    + ' attribution above;\n     scripts/perf-frame.mjs is what maps a whole frame.)');
}

