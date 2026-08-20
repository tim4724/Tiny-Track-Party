// The APPLE TV backend of the frame-cost bench: stand a live race up on the box
// and hand back the readout lines it prints.
//
// `scripts/perf-race.mjs` owns the run — which track, how long, and the parsing,
// folding and printing that are the same on every platform, because the readout
// is one canonical JSON object (`native/runtime/ttp_perf.h`) on all three. This
// file owns only what is tvOS: `devicectl` / `simctl`, the launch arguments, and
// reading the app's own stdout back. It is registered there as
// `--platform tvos`.
//
//   node scripts/perf-race.mjs --platform tvos --players 4 --track tidepool
//   node scripts/perf-race.mjs --platform tvos --sim          # the simulator
//   node scripts/perf-race.mjs --platform tvos --device <udid>
//
// UNTIL NOW NO SCRIPT COULD READ A FRAME COST OFF AN APPLE TV AT ALL. The
// readout existed only as text on the panel — `PerfOverlay`'s `lines` were its
// one sink, and the whole Swift shell had three `print()` calls, none of them
// perf. This reads the same bytes the panel is drawn from.
//
// NO PHONES AND NO RELAY. The `bench` scenario seats its own players and the
// engine drives them (`ttp_race_autopilot_players`), so what is measured is a
// real launch: the field, the grid, the cells and the ids are the live game's,
// with the sim supplying the steering a phone would.
//
// WHAT A LIVE RACE MEASURES that a frozen bench cannot: the camera moves through
// the whole circuit, rubber accumulates, and the scene is the one the game
// builds. Pin the track — two runs on two circuits are two different questions.
//
// `--dpr` PINS THE BUFFER, exactly as the web's `?dpr=` does: it arrives as
// `-ttpRenderScale`, which holds the drawable at that fraction of the panel and
// switches `DisplayHost.adaptScale` off. `--dpr 0` asks the opposite question —
// let the rule steer, and report where it settled.
//
// PIN EVERY ARM OF A COMPARISON. Free-running, a run reports whichever rung the
// rule ended on, and on a box with no GPU timer the scale is a one-way ratchet:
// a run that stumbled early reports the softer rung for the whole of its length.
// Two runs that ended on different rungs are two different questions, so READ
// THE BUFFER SIZE OFF THE HEADER either way.
//
// IT MEASURES WHATEVER IS INSTALLED. Nothing here builds or installs
// (`npm run build:tvos [device|simulator]` does), so a stale install measures a
// stale engine and says nothing about it — the same trap the party check has.

import { execFileSync, spawn } from 'node:child_process';

import { GRID_MS, lineStream } from './perf-race.mjs';
import { resolveDevicectlId, assertAwake } from './lib/tvos-device.mjs';

const BUNDLE_ID = 'games.couchpad.tinytrack';

// `Scenarios.swift`'s launch arguments, and the scenario that is a race rather
// than a screen. tvOS reads them through `UserDefaults` (the NSArgumentDomain),
// which is why they are spelled `-key value` rather than as bare words.
const SCENARIO = 'bench';

/** The tag every shell prefixes its readout with, and what the shared half reads. */
const TAG = 'TtpPerf ';

/** Scene staging fetches and bakes a shadow map on the main thread. */
const READY_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** This backend's own flags, exactly as the web one reads its `--port`. */
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * A run, with its own state.
 *
 *   players / track / seconds  the shared runner's (`seconds` is COUNTED time:
 *                              the shared GRID_MS settle is on top of it).
 *                              Ask for more than a race lasts and the tail of
 *                              the run is a results board over a still picture.
 *   dpr                        the buffer as a fraction of the panel; 0 hands
 *                              the buffer back to the adaptive rule
 *
 * tvOS-only flags, read off argv:
 *   --sim            drive the booted tvOS simulator instead of the paired box
 *   --device <udid>  an explicit devicectl device
 *   --features 0x…   TTP_FEAT_* ablation mask (ttp_display.h); absent = the
 *                    shipped picture
 *   --aa 0|1         force the full-screen antialias pass off or on; absent
 *                    leaves the renderer's own default
 *
 * The two ablation flags are the Android backend's by the same names. They ride
 * the LAUNCH here rather than a live property, which is what that shell needs
 * and this one does not: every arm is its own cold launch already
 * (`--terminate-existing`), so an arm cannot inherit the one before it.
 */
export function makeTvosBackend() {
  const sim = flag('sim');
  const features = arg('features', null);
  const aa = arg('aa', null);
  let child = null;
  let timer = null;
  /** Readout lines not yet consumed, and the consumer waiting for one. */
  const lines = lineStream();
  let counting = false;
  let ready = null;
  /** The app's own `[ttp] …` complaints, so a timeout can say what it saw. */
  const complaints = [];


  const onLine = (line) => {
    // NOT ANCHORED: `devicectl --console` decorates the process's output with
    // its own prefix, and the same reader has to work for `simctl`'s pty, which
    // does not. What is stable is the tag and the object after it — and the
    // line is handed on FROM the tag, so the shared half sees exactly what the
    // shell logged and nothing this file added.
    const at = line.indexOf(TAG);
    if (at < 0) {
      const why = line.match(/\[ttp\] (.*)$/);
      if (why) complaints.push(why[1].trim());
      return;
    }
    const text = line.slice(at).trimEnd();
    if (ready) {
      // READINESS IS THE READOUT ITSELF. Nothing else on this platform
      // announces a scenario: the screenshot runner waits on an accessibility
      // identifier, which needs an XCUITest, and there is none here. A
      // `TtpPerf` line can only exist once `Scenarios` has stood the bench up
      // (nothing else calls `PerfMonitor.bench`), and `warming:false` means the
      // shared fold has a window of frames that missed nothing — i.e. the scene
      // is built and the box is presenting. perf_stats.h says why boot frames
      // are not one.
      let warming = true;
      try { warming = JSON.parse(text.slice(TAG.length)).warming !== false; } catch { /* wait */ }
      if (warming) return;
      const r = ready; ready = null; r();
      return;
    }
    if (!counting) return;
    lines.push(text);
  };

  const stream = (pipe) => {
    if (!pipe) return;
    let tail = '';
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk) => {
      const parts = (tail + chunk).split('\n');
      tail = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    });
  };

  const waitForWarmRace = async () => {
    let t = null;
    const ok = await new Promise((resolve) => {
      ready = () => resolve(true);
      t = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    clearTimeout(t);
    ready = null;
    if (!ok) {
      throw new Error(
        'the bench race never reached a steady frame rate — is the build on the '
        + `${sim ? 'simulator' : 'Apple TV'} current, and does it know the \`bench\` scenario?`
        + (complaints.length ? `\n  the app said: ${complaints.slice(-3).join(' | ')}` : ''));
    }
  };

  return {
    async launch({ players, track, seconds, dpr }) {
      const args = ['-ttpScenario', SCENARIO,
        ...(track ? ['-ttpTrack', String(track)] : []),
        ...(players ? ['-ttpPlayers', String(players)] : []),
        // The shell reads this with `double(forKey:)`, which COERCES: the
        // argument domain holds it as a string, and `object(forKey:) as? Double`
        // would read nil through it and leave the drawable full size.
        ...(dpr > 0 ? ['-ttpRenderScale', String(dpr)] : []),
        ...(features ? ['-ttpFeatures', String(parseInt(features, 0))] : []),
        ...(aa != null ? ['-ttpAntialias', String(parseInt(aa, 10))] : [])];

      let argv;
      if (sim) {
        // TERMINATE FIRST, because `simctl launch` on a running app only
        // foregrounds it: the process never re-reads its arguments, so the
        // second arm of a sweep silently measures the first arm's track.
        try {
          execFileSync('xcrun', ['simctl', 'terminate', 'booted', BUNDLE_ID], { stdio: 'ignore' });
        } catch { /* not running, which is the state we wanted */ }
        argv = ['simctl', 'launch', '--console-pty', 'booted', BUNDLE_ID, ...args];
      } else {
        const device = arg('device', null) ?? resolveDevicectlId();
        // A DARK PANEL IS NOT A CHEAP FRAME. A sleeping Apple TV still runs the
        // app, and every number it produces is of a compositor with nothing to
        // show — the same reason the gallery capture refuses to shoot one.
        assertAwake(device);
        // `--console` is what makes the app's stdout arrive here at all;
        // `--terminate-existing` makes the launch cold, for the same reason as
        // the simulator's terminate above.
        //
        // `--` IS LOAD-BEARING, and its absence does not look like an argument
        // bug. devicectl keeps parsing its OWN flags past the bundle id, so
        // `-ttpScenario bench` is read as its `-t <seconds>` timeout and the
        // launch dies with "The value 'bench' is invalid for '-t <seconds>'" —
        // a message about a flag this script never passed. simctl has no such
        // problem, so the simulator arm worked while the device arm had never
        // run at all.
        argv = ['devicectl', 'device', 'process', 'launch', '--device', device,
          '--console', '--terminate-existing', BUNDLE_ID, '--', ...args];
      }
      console.log(`# xcrun ${argv.join(' ')}`);

      child = spawn('xcrun', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      stream(child.stdout);
      stream(child.stderr);   // devicectl puts some of its own progress here

      await waitForWarmRace();
      await sleep(GRID_MS);
      counting = true;
      timer = setTimeout(() => lines.end(), seconds * 1000);

      return lines;
    },

    /**
     * End the run: let go of the stream.
     *
     * THE APP IS LEFT RUNNING, exactly as the Android backend leaves its box.
     * Killing the console does not stop a process on the television, and the
     * honest ways to stop one (launching another app over it) belong to the
     * party check rather than to a measurement. The next `launch` is cold
     * anyway: `--terminate-existing` and `simctl terminate` both see to that.
     */
    async stop() {
      clearTimeout(timer);

      if (child) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill('SIGKILL');
        child = null;
      }
      lines.end();
    }
  };
}
