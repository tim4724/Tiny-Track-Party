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
// `--dpr` DOES NOTHING HERE, and the reason has to travel with every number this
// produces: tvOS links `ttp_display_step` and calls it nowhere, so an Apple TV
// renders its panel's whole buffer (3840x2160 on a 4K box) with no adaptive
// render scale and no way to pin one, where the web and Android both steer
// theirs. A tvOS reading is therefore not yet comparable with the other two
// columns — it is a different operating point, not a slower box. See
// docs/native-port/shells.md, item 14.
//
// IT MEASURES WHATEVER IS INSTALLED. Nothing here builds or installs
// (`npm run build:tvos [device|simulator]` does), so a stale install measures a
// stale engine and says nothing about it — the same trap the party check has.

import { execFileSync, spawn } from 'node:child_process';

import { GRID_MS } from './perf-race.mjs';
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
 *   dpr                        ignored — see the header; there is nothing on
 *                              this platform to pin a buffer with
 *
 * tvOS-only flags, read off argv:
 *   --sim            drive the booted tvOS simulator instead of the paired box
 *   --device <udid>  an explicit devicectl device
 */
export function makeTvosBackend() {
  const sim = flag('sim');
  let child = null;
  let timer = null;
  /** Readout lines not yet consumed, the consumer waiting for one, and the end. */
  let pending = [];
  let wake = null;
  let ended = false;
  let counting = false;
  let ready = null;
  /** The app's own `[ttp] …` complaints, so a timeout can say what it saw. */
  const complaints = [];

  const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };

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
    pending.push(text);
    nudge();
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
    async launch({ players, track, seconds }) {
      const args = ['-ttpScenario', SCENARIO,
        ...(track ? ['-ttpTrack', String(track)] : []),
        ...(players ? ['-ttpPlayers', String(players)] : [])];

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
        argv = ['devicectl', 'device', 'process', 'launch', '--device', device,
          '--console', '--terminate-existing', BUNDLE_ID, ...args];
      }
      console.log(`# xcrun ${argv.join(' ')}`);

      child = spawn('xcrun', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      stream(child.stdout);
      stream(child.stderr);   // devicectl puts some of its own progress here

      await waitForWarmRace();
      await sleep(GRID_MS);
      counting = true;
      timer = setTimeout(() => { ended = true; nudge(); }, seconds * 1000);

      return {
        async* [Symbol.asyncIterator]() {
          for (;;) {
            while (pending.length) yield pending.shift();
            if (ended) return;
            await new Promise((r) => { wake = r; });
          }
        }
      };
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
      ended = true;
      if (child) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill('SIGKILL');
        child = null;
      }
      nudge();
    }
  };
}
