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
// and `ttp_display_step` resizes the buffer underneath all of it. A lap's own
// cost varies by about 4 ms on this box, so pin the track — two runs on two
// circuits are two different questions.
//
// IT MEASURES WHATEVER IS INSTALLED. Nothing here builds or installs, and the
// first run after an install measures the install (dex/JIT and shader warmup are
// worth a whole rung of render scale) — so throw the first one away.

import { execFileSync, spawn } from 'node:child_process';

import { GRID_MS } from './perf-race.mjs';
import { ADB, findTvDevice } from './lib/androidtv-device.mjs';

const PACKAGE = 'games.couchpad.tinytrack';
const ACTIVITY = `${PACKAGE}/.MainActivity`;

// Scenarios.kt's EXTRA_SCENARIO/EXTRA_TRACK/EXTRA_PLAYERS, and the scenario that
// is a race rather than a screen. There is no manifest to read them from.
const SCENARIO = 'bench';
const EXTRA_SCENARIO = 'ttpScenario';
const EXTRA_TRACK = 'ttpTrack';
const EXTRA_PLAYERS = 'ttpPlayers';

/** `ttp_display.h`'s TTP_FEAT_ALL — the un-ablated arm. `tests/feature-bits.test.js` pins it. */
const TTP_FEAT_ALL = '0x1FFC';

/** A cold launch builds a scene and bakes a shadow map before it says so. */
const READY_TIMEOUT_MS = 120_000;

/** The tag every shell prefixes its readout with, and what the shared half reads. */
const TAG = 'TtpPerf';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** This backend's own flags, exactly as the web one reads its `--port`. */
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

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
 *   --serial <id>    an explicit adb device
 */
export function makeAndroidBackend() {
  let serial = null;
  let logcat = null;
  let restored = false;
  let timer = null;
  /** Readout lines not yet consumed, the consumer waiting for one, and the end. */
  let pending = [];
  let wake = null;
  let ended = false;
  let counting = false;
  let ready = null;
  /** The Android-only per-phase spike lines, folded by [report]. */
  const spikes = [];
  const phasemax = [];

  const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8' });
  const setprop = (k, v) => adb('shell', 'setprop', k, String(v));
  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };

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
    pending.push(`${TAG} ${text}`);
    nudge();
  };

  // READINESS IS A LOG LINE, and it is the same one the screenshot runner waits
  // on: `Scenarios` emits it once the scene has landed AND the engine has
  // presented a few more frames. Never sleep instead — a cold shader compile is
  // seconds long here and reads as a healthy start.
  const waitForReady = () => new Promise((resolve) => {
    const t = setTimeout(() => { ready = null; resolve('timeout'); }, READY_TIMEOUT_MS);
    ready = (verdict) => { clearTimeout(t); ready = null; resolve(verdict); };
  });

  async function* readouts() {
    for (;;) {
      while (pending.length) yield pending.shift();
      if (ended) return;
      await new Promise((r) => { wake = r; });
    }
  }

  return {
    async launch({ players, track, seconds }) {
      serial = findTvDevice(arg('serial', null));

      // A property outlives a force-stop AND a reinstall, so an arm that does
      // not set one silently inherits the last arm's. Every one of them is
      // written here and cleared in `stop`, on every exit path.
      setprop('debug.ttp.scale', arg('pin', 0));
      setprop('debug.ttp.aa', arg('aa', 0));
      setprop('debug.ttp.hz', arg('hz', 0));

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
      timer = setTimeout(() => { ended = true; nudge(); }, seconds * 1000);
      return readouts();
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
      ended = true;
      nudge();
      restoreKnobs();
      report(spikes, phasemax);
    },
  };
}

/** `name:ms name:ms …` — a COLON, so a `name value` parser cannot read a max as a median. */
const phases = (line) => Object.fromEntries(
  [...line.matchAll(/([A-Za-z]+):([\d.]+)/g)].map((m) => [m[1], +m[2]]));

/**
 * The renderer-CPU spike attribution, which has no shared half because it has no
 * counterpart in the other two shells: `ttp_display_profile`'s per-section split
 * is this renderer's own, and on this box the frame costs tens of milliseconds
 * and WHICH section holds them is the question. Each `spike` is ONE frame (the
 * window's worst by total+build, the span the `ttp:render` atrace marker times),
 * so "top-of-worst" is the share of those frames a phase held; `phasemax` folds
 * each phase's own window maxima, which also catches the second culprit.
 *
 * NOTE WHAT NEITHER THIS NOR THE READOUT CAN SEE: the sim tick, the event drain,
 * the HUD poll and Compose all run on the same thread and are outside every
 * number here. `atrace` is the instrument for that half.
 */
function report(spikes, phasemax) {
  if (!spikes.length) return;
  const names = [...new Set(spikes.flatMap((o) => Object.keys(o)))].filter((n) => n !== 'total');
  const tops = spikes.map((o) => names.reduce((a, n) => ((o[n] ?? 0) > (o[a] ?? 0) ? n : a)));
  const worst = spikes.map((o) => (o.total ?? 0) + (o.build ?? 0));
  const rows = names.map((n) => {
    const xs = phasemax.map((o) => o[n]).filter((v) => v != null);
    return {
      n,
      max: xs.length ? Math.max(...xs) : 0,
      p50: pct(xs, 0.5) ?? 0,
      top: Math.round((100 * tops.filter((t) => t === n).length) / tops.length),
    };
  }).sort((a, b) => b.max - a.max);
  console.log(`\n# renderer-CPU worst-frame p50 ${pct(worst, 0.5)?.toFixed(1)}`
    + ` / max ${Math.max(...worst).toFixed(1)} ms — by phase:`);
  for (const r of rows) {
    if (r.max < 0.5 && r.top === 0) continue;
    console.log(`    ${r.n.padEnd(10)} worst ${r.max.toFixed(1).padStart(5)} ms`
      + `   p50-of-worst ${r.p50.toFixed(1).padStart(5)} ms`
      + `   top-of-worst ${String(r.top).padStart(3)}%`);
  }
}

const pct = (xs, q) => {
  const s = xs.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
};
