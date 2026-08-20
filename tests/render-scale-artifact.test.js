'use strict';
// The adaptive render scale, driven end to end on the SHIPPED wasm.
//
// WHY HERE AND NOT ONLY IN ctest. The `render_scale` ctest proves the rule and
// the controller on every leg, and this file deliberately does not restate
// them. What it adds is the ARTIFACT and the SEAM: ctest recompiles the sources,
// so whether these exports survived into the module the browser loads is a
// linker outcome no ctest can see — and `cwrap` does not throw on a missing
// name, it defers until the call, so absence surfaces as a mystery at bench
// time. Same reasoning as tests/perf-abi.test.js, which is the sibling of this
// file for the readout half.
//
// It also pins the thing the split MOVED: the scale rule and the readout share
// one window. Nothing here calls a scale function to feed it. Frames go in
// through `ttp_perf_sample` — the readout's own entry point, the one a shell
// was already calling — and operating points come back out of
// `ttp_display_scale_poll`. If those two ever stop being the same ring, every
// test below goes quiet in the same direction: the rule stops seeing anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');

// The artifacts are CHECKED IN and the game is native-only, so a missing module
// is a broken checkout, not an unbuilt optional extra.
if (!fs.existsSync(MJS)) {
  throw new Error('ttp_runtime.mjs missing — run native/scripts/build-runtime-web.sh');
}

const HZ60 = 1000 / 60;

/** A fresh binding set over its own module instance — the controller is a process singleton. */
async function box() {
  const M = await import(pathToFileURL(MJS).href).then((m) => m.default());
  const out = M._malloc(16);   // 2 doubles
  const fn = {
    reset: M.cwrap('ttp_perf_reset', null, []),
    sample: M.cwrap('ttp_perf_sample', null,
      ['number', 'number', 'number', 'number', 'number']),
    readout: M.cwrap('ttp_perf_readout_json', 'string',
      ['number', 'number', 'number', 'number', 'string']),
    scene: M.cwrap('ttp_display_scale_scene', null, ['number']),
    poll: M.cwrap('ttp_display_scale_poll', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number']),
    panelMs: M.cwrap('ttp_display_scale_panel_ms', 'number', []),
  };

  const b = {
    t: 0,           // ms on the shell's own clock
    everyNth: 1,    // present every Nth tick — a SKIP where it is not the divisor
    gpuMs: -1,      // <= 0: no timer, which is the tvOS and the WebKit case
    tick: 0,
    scale: 1,       // what the "shell" performs, exactly as Stage._autoScale does
    divisor: 1,
    /** `n` ticks of a loop running at the panel's rate. */
    ticks(n, panel = HZ60) {
      for (let i = 0; i < n; i++) {
        b.t += panel;
        const drew = (++b.tick % b.everyNth) === 0;
        // The readout's own contract: a TICK interval, drawn or not, and an
        // ABSENT (<= 0) cost where there is no number rather than a zero.
        fn.sample(b.t, panel, drew ? 1 : 0, -1, drew ? b.gpuMs : -1);
      }
      return b;
    },
    /** Poll, and PERFORM the answer the way every shell does. Returns whether it moved. */
    poll(band) {
      if (!fn.poll(b.t, band.min, band.max, band.baseLines, band.panelMs, out)) return false;
      const i = out >> 3;
      b.scale = M.HEAPF64[i];
      b.divisor = M.HEAPF64[i + 1] | 0;
      // A move drops the window in C++; a shell drops it again once the buffer
      // has actually changed size (Stage._onResize, DisplayHost.applyResize).
      fn.reset();
      return true;
    },
    lines(band) { return b.scale * band.baseLines; },
    fn,
  };
  return b;
}

const BAND_4K = { min: 0, max: 1, baseLines: 2160, panelMs: HZ60 };

test('the shipped module exports the render-scale ABI a shell binds to', async () => {
  const M = await import(pathToFileURL(MJS).href).then((m) => m.default());
  // DERIVED FROM THE HEADER, never listed here — a hand-written list is a list
  // that misses the next export.
  const src = fs.readFileSync(path.join(ROOT, 'native/runtime/ttp_display.h'), 'utf8');
  const names = [...src.matchAll(/TTP_ABI\s+[\w* ]+?\b(ttp_display_scale_\w+)\s*\(/g)].map((m) => m[1]);
  assert.ok(names.length >= 3, 'ttp_display.h declares no scale exports any more');
  for (const n of names) {
    assert.equal(typeof M[`_${n}`], 'function',
      `_${n} is not exported — every shell would fail at the cwrap call`);
  }
});

test('frames fed to the READOUT are what the scale rule decides from', async () => {
  const b = await box();
  // A loop ticking a clean 60 that only presents every third tick: a box running
  // 20 fps behind a link that fires at 60. Nothing here tells the scale rule
  // that; it reads the same window the overlay draws.
  b.everyNth = 3;
  b.ticks(360);   // 6 s, past the rule's scene grace

  const r = JSON.parse(b.fn.readout(4, 1280, 720, 1, null));
  assert.equal(r.frame.p95, HZ60, 'the tick series is a flat vsync period through a skip storm');
  assert.ok(r.present.p95 > 2.5 * HZ60, 'and the present series is the only one that can see it');

  assert.ok(b.poll(BAND_4K), 'a box presenting one tick in three is rescued');
  assert.ok(b.scale < 1, `…downward: ${b.scale}`);
});

test('the panel period is learned where a shell has none to declare', async () => {
  // What the browser passes, because no web API answers it. The rule learns one
  // off the TICK series, which runs at the panel's rate whether or not a frame
  // drew — Stage reads it back for perf.pacing so the readout's budget and the
  // rule's are one number.
  const b = await box();
  b.everyNth = 3;
  b.ticks(180);
  b.poll({ min: 0, max: 1, baseLines: 2160, panelMs: 0 });
  assert.ok(Math.abs(b.fn.panelMs() - HZ60) < 1e-6, `learned ${b.fn.panelMs()}`);
});

test('the ceiling is the BAND\'s, adopted without moving the shell\'s buffer', async () => {
  // The regression this test was written for. A browser on a HiDPI screen sizes
  // its buffer from the ceiling before a frame exists, so a controller starting
  // at a baked-in 1.0 prices frames drawn at 2.0 as though they cost that at
  // 1.0 — and halves a canvas nobody asked it to touch on its first move.
  const retina = { min: 0, max: 2, baseLines: 1080, panelMs: HZ60 };
  const b = await box();
  b.gpuMs = 1;
  b.ticks(180);
  assert.equal(b.poll(retina), false, 'adopting the ceiling is not a move');
  // The shell never called poll's answer, so its own copy is still what
  // _sizeCanvas clamped it to — and the rule now agrees with it.
  b.ticks(180);
  b.poll(retina);
  assert.ok(b.scale === 1 || b.scale === 2,
    `the first move must not land below the surface's own resolution: ${b.scale}`);
});

test('a scene build restarts the tenure the climb is paced by', async () => {
  const b = await box();
  b.gpuMs = 30;                                    // hopeless against 16.7 ms
  for (let i = 0; i < 6; i++) { b.ticks(180); b.poll(BAND_4K); }
  const floored = b.lines(BAND_4K);
  assert.ok(floored < 2160, 'an expensive scene falls off native');

  b.gpuMs = 1;                                     // …and the load lifts
  for (let i = 0; i < 6; i++) { b.ticks(180); b.poll(BAND_4K); }
  assert.equal(b.lines(BAND_4K), floored,
    'past the recovery window a climb waits out the lap-sized hold');

  // What a shell owes on a build: this call, and ttp_perf_reset beside it.
  b.fn.scene(b.t);
  b.fn.reset();
  for (let i = 0; i < 5; i++) { b.ticks(180); b.poll(BAND_4K); }
  assert.ok(b.lines(BAND_4K) > floored,
    'a new scene climbs back at one evidence window a step');
});

test('a poll that decides nothing leaves the window alone', async () => {
  const b = await box();
  b.everyNth = 3;
  b.ticks(360);
  assert.ok(b.poll(BAND_4K), 'the first poll decides');

  // NOT "the second poll inside the cadence is refused" — that answers no-move
  // either way and would pass for the wrong reason. The cadence is a cost guard
  // and decides nothing; render_scale_check gates the honest property (polled
  // every frame, the controller lands where polling at the cadence lands).
  //
  // A poll that decides NOTHING must leave the window alone: clearing it every
  // second caps the sample count at the frame rate, and the rule ignores a
  // window under kMinSignalFrames — so a box at 20 fps would be told it had no
  // signal and never step down, deaf in exactly the case this exists for.
  b.everyNth = 1;
  b.ticks(180);
  const before = JSON.parse(b.fn.readout(1, 960, 540, 1, null)).frame.n;
  b.poll(BAND_4K);
  b.ticks(1);
  const after = JSON.parse(b.fn.readout(1, 960, 540, 1, null)).frame.n;
  assert.ok(after > before - 5, `a hold must not drop the window: ${before} -> ${after}`);
});
