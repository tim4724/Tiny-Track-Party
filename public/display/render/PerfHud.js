// Perf HUD — the display's frame-cost readout (bottom-right; "P" hides it).
//
// WHAT IS HERE AND WHAT IS NOT. Nothing on this page judges a frame any more:
// the ring, the warm-up filter, the percentiles, the two rates, the drop and
// skip counts and the health verdict are C++ (native/runtime/ttp_perf.h over
// libttp-runtime/ttp/perf_stats.{h,cc}, executed on every leg by the `perf`
// ctest), so "60 fps", "2 drops" and "amber" are the same statements in this
// browser, on an Apple TV and on an Android box. Read that header before
// adding a number to this file. What is left here is the half a shell owes:
// MEASURING (the GPU timer query, which is genuinely web-only) and DRAWING.
//
// OFF UNTIL ASKED FOR, on this shell and on both televisions: a player who
// launches the game gets no diagnostic block over the corner of the picture,
// and every capture rig stops having to remember to hide one. Three ways to ask
// for it here, all equivalent — `?perf=1` at boot (Stage), the "P" key, and
// window.__perf.show() from a console or a script.
//
// SHOWING AND MEASURING ARE SEPARATE (instrument()). The hide path stops every
// canvas draw and DOM write, but a hidden HUD still samples and still runs its
// timer query for a caller that reads sample() rather than looking at it —
// which the adaptive render scale (Stage) does on every shipped surface, where
// this panel is off. So the panel defaulting off does not make the class inert,
// and must not: that IS the case the scale controller has to keep working in.
//
// WHAT A HIDDEN PANEL STOPS PAYING FOR is everything only a reader wants: the
// CPU profile read (Stage gates it on `watching`), the scope's frame ring, the
// DOM writes and the readout fold. What it keeps paying is the per-frame sample
// and the timer query, because the scale rule reads both. `bench()` is the
// third state — nobody is looking, but something is READING the readout — and
// it is what the CPU term follows, not visibility.
//
// THE GPU TIMER RESOLVES LATE, and the monitor behind ttp_perf_sample takes a
// frame once and accepts no amendment afterwards. So a frame is HELD here until
// its timer result has landed (or the pool has moved past it) and only then
// pushed — see _flush. Holding is the whole reason this file still keeps frames
// of its own at all.
//
// TWO SOURCES THAT LOOK RIGHT AND ARE NOT, so nobody re-derives them:
//   • Filament's Renderer::getFrameInfoHistory().gpuFrameDuration. On emscripten
//     the GL backend compiles its timer-query path out (OpenGLContext.cpp guards
//     the EXT_disjoint_timer_query probe with #ifndef __EMSCRIPTEN__) and
//     OpenGLPlatform::canCreateFence() is false, so it lands on
//     TimerQueryFallbackFactory — which measures CPU time and says so in its own
//     comment. On the web that field is submit time wearing a GPU label.
//   • fenceSync + clientWaitSync(0) polling. Measured 9.6 ms p50 against a frame
//     whose real GPU cost was 3.4 ms: what it times is setTimeout clamping and
//     GPU-process round trips, not the GPU.
//
// There is no browser API for actual present/photon time. The honest end-to-end
// number is arrival → GPU complete → +1 vsync, and its ground truth is a 240 fps
// camera pointed at the TV.

import { loadNativeRuntime } from '../nativeRuntime.js';

const STRIP = 180;          // columns drawn in the scope (3 s at 60 Hz)
const STRIP_H = 34;         // scope height, CSS px
const TEXT_MS = 250;        // text refresh cadence
// How many GPU timer queries may be in flight. It is a SAMPLING pool, not a
// stall guard (see gpuBegin): results come back at the driver's rate rather than
// the frame's, so the pool being full is the signal to skip this frame's query,
// not to throw the backlog away. Sized for the UNCAPPED measurement run
// (--disable-frame-rate-limit), which is the only honest way to compare two
// builds — at 60 Hz the GPU is idle four fifths of every frame, downclocks, and
// identical builds then read across a wide band.
const MAX_PENDING = 64;
// How far the push may lag the frame. Normal running holds two or three; a
// script that pumps a burst of frames in one task (scripts/perf-features.mjs)
// holds the whole burst, because nothing can resolve until it yields — so the
// hold has to be at least as deep as the query pool or that script's readings
// lose most of their samples. Past this a result is not coming back at all (a
// lost context, a stopped loop), and the frames go over with their GPU cost
// ABSENT rather than stalling the readout behind them for good.
const HOLD_MAX = MAX_PENDING + 16;

// The diagnostic tint, keyed by the verdict the C++ decided. Amber and the rest
// are deliberate here: the chrome palette's veto does not reach a debug overlay,
// and the three shells agreeing is worth more than matching the theme.
const TINT = { good: '#7CFC8A', warn: '#FFD166', bad: '#FF6B6B' };

// A series the window holds nothing for. The ABI answers null for that (absent
// is not zero — a platform with no GPU timer has no signal, not a free frame),
// while every reader of sample() wants the keys; the null is spread back out
// once, at the boundary, rather than at each read.
const NO_STAT = { p05: null, p50: null, p95: null, max: null, n: 0 };

// ttp_perf.h, bound once: there is ONE monitor per process because there is one
// display, so this is module state and takes no handle. Bound off the memoized
// runtime loader, which boot.js has already resolved by the time a Stage exists.
let perf = null;
// The last pacing declared, REPLAYED once the module binds. The loader resolves
// on a microtask, so the boot declaration is made before there is anything to
// declare it to — and a dropped one leaves the monitor judging a paced loop
// against an unpaced budget, which is the permanent red this exists to prevent.
let paced = null;
function bindPerf() {
  if (perf) return;
  loadNativeRuntime().then((M) => {
    perf = {
      reset: M.cwrap('ttp_perf_reset', null, []),
      pacing: M.cwrap('ttp_perf_pacing', null, ['number', 'number']),
      sample: M.cwrap('ttp_perf_sample', null,
                      ['number', 'number', 'number', 'number', 'number']),
      readout: M.cwrap('ttp_perf_readout_json', 'string',
                       ['number', 'number', 'number', 'number', 'string'])
    };
    if (paced) perf.pacing(paced[0], paced[1]);
  }).catch(() => { /* a failed load is fatal in boot.js; this side just stays dark */ });
}

export class PerfHud {
  // `canvas` is the renderer's canvas. NOTE the ordering hazard: this class must
  // NOT touch getContext() here. Filament creates the WebGL2 context with its own
  // attributes in Display.create(), and getContext on an already-initialised
  // canvas returns the existing context whatever attributes you pass — so
  // grabbing it first would hand Filament a context IT did not configure. The
  // context is acquired lazily on the first instrumented frame, which by
  // construction is after boot().
  constructor(container, canvas) {
    bindPerf();
    this._canvas = canvas;
    this._visible = false;
    // Something is READING the readout without looking at the panel — the bench
    // scenario (TestHarness), which logs the same bytes the panel draws. It is
    // what the CPU term follows: with nobody watching there is no reader for it
    // at all, and the scale rule does not use one.
    this._benching = false;
    // MEASURING is not the same as SHOWING, and the difference is the whole of
    // what the adaptive render scale (Stage) needs: it decides from the GPU
    // timer on a shipped TV, where this panel is off. Measuring costs a sample
    // call and one timer query per frame; DRAWING (the DOM text and the scope)
    // is what stays gated on _visible, so a release build with the panel off
    // still pays nothing to look at.
    this._instrumenting = false;
    this._measuring = false;
    this._hold = [];          // frames measured but not yet pushed (see _flush)
    this._ring = [];          // the last STRIP pushed frames, for the scope only
    this._n = 0;              // absolute frame counter (never wraps)
    // What is being driven, for a bench that spans a catalogue — it rides the
    // readout beside the buffer size and the cell count, and a logged number
    // carrying none of them is not comparable to any other logged number.
    this.track = null;
    this._cells = 0;
    // The scale the drawing buffer was SIZED at — Stage's own _dpr, which is
    // NOT window.devicePixelRatio: `?dpr=1` on a Retina Mac renders a 1280×720
    // buffer, and a header line saying "@ dpr 2" beside it misstates the very
    // operating point the numbers describe. Stage writes it wherever it sizes
    // the canvas; 1 until then, which is what an unsized buffer would be.
    this.dpr = 1;
    this._lastText = 0;
    this._disjoints = 0;
    // GPU timer state, all null until the first instrumented frame.
    this._gl = null;
    this._ext = null;
    this._gpuState = 'idle';  // idle | ext | unavailable | lost
    this._pending = [];       // { query, n }
    this._open = null;

    const el = document.createElement('div');
    el.className = 'perf-hud';
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;display:none;'
      + 'font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
      + 'color:#7CFC8A;background:rgba(0,0,0,0.58);padding:5px 7px 4px;border-radius:7px;'
      + 'pointer-events:none;white-space:pre;text-align:left;letter-spacing:.2px;';
    const text = document.createElement('div');
    text.textContent = 'perf: warming up';
    const scope = document.createElement('canvas');
    scope.width = STRIP * 2;          // 2× backing store: the scope is 1 CSS px
    scope.height = STRIP_H * 2;       // per frame, and a hairline needs the pixels
    scope.style.cssText = `display:block;width:${STRIP}px;height:${STRIP_H}px;margin-top:4px;`
      + 'border-radius:3px;background:rgba(255,255,255,0.05)';
    el.appendChild(text);
    el.appendChild(scope);
    (container || document.body).appendChild(el);
    this._el = el;
    this._text = text;
    this._ctx = scope.getContext('2d');
    this._ctx.scale(2, 2);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') this.toggle();
    });
  }

  // ---- visibility and measurement (drawing is what hiding stops) --------------

  show() { this._setVisible(true); }
  hide() { this._setVisible(false); }
  toggle() { this._setVisible(!this._visible); }
  get visible() { return this._visible; }

  // Is anyone reading the readout — by looking at it, or by logging it? The CPU
  // sample is fed for exactly this, and for nothing else (Stage). The GPU one is
  // NOT: the scale rule reads that whether or not a reader exists.
  get watching() { return this._visible || this._benching; }

  // A BENCHED run: keep the window fed and keep the CPU term in it, with the
  // panel down. The panel is four DOM writes and a canvas at 4 Hz on the same
  // thread the bench is pricing, so a run that drew it would be measuring the
  // instrument (Android's PerfMonitor.bench makes the same trade).
  bench() {
    this._benching = true;
    this.instrument(true);
    this.reset();
  }

  // Is the window actually being fed? A caller that READS the readout has to be
  // able to tell "no frames yet" from "no frames coming" — the countdown gate
  // does exactly that (ttp_race.h), and this is off under automation and under a
  // pinned ?dpr=, where instrumenting would perturb what the run is measuring.
  get measuring() { return this._measuring; }

  // Keep measuring with the panel hidden, for a caller that reads sample()
  // rather than looking at it. Independent of show/hide in both directions: "P"
  // during a race hides the panel without blinding the scale controller behind
  // it, and the controller switching off does not close a panel someone opened.
  instrument(on) {
    const want = on !== false;
    if (want === this._instrumenting) return;
    this._instrumenting = want;
    this._syncMeasuring();
  }

  _setVisible(on) {
    if (on === this._visible) return;
    this._visible = on;
    this._el.style.display = on ? '' : 'none';
    this._syncMeasuring();
  }

  _syncMeasuring() {
    const on = this._visible || this._instrumenting;
    if (on === this._measuring) return;
    this._measuring = on;
    if (!on) this._dropInflight();
    else this.reset();   // stale history is worse than none
  }

  // Throw the window away and start measuring again from cold. For a caller
  // that has CHANGED what a frame costs — the scale controller resizing the
  // buffer — where keeping the old frames would judge the new resolution partly
  // on the old one's timings. It re-arms the warm-up discard too: that is the
  // monitor's, and ttp_perf_reset is how it is re-armed.
  reset() {
    this._dropInflight();
    if (perf) perf.reset();
  }

  // What this shell is AIMING AT: the panel's own present period (one vsync)
  // and the render-scale rule's divisor, "present every Nth vsync". Both are
  // facts only Stage has and both are CHOICES rather than faults — a divisor of
  // 2 on a 120 Hz screen is holding 60 deliberately, and a readout that cannot
  // tell that from a missed frame scores every skipped tick as damage. See
  // ttp_perf.h; the budget follows the divisor and never goes tighter than 60.
  pacing(panelMs, divisor) {
    paced = [panelMs, divisor];
    if (perf) perf.pacing(panelMs, divisor);
  }

  // ---- per-frame hooks --------------------------------------------------------

  // One tick of the frame loop, drawn or not (rawMs = the unclamped rAF delta).
  tick(t, rawMs) {
    if (!this._measuring) return;
    this._hold.push({ n: this._n++, t, interval: rawMs, presented: false,
                      cpu: -1, gpu: -1, waiting: false });
    this._flush();
    if (this._visible && t - this._lastText >= TEXT_MS) { this._lastText = t; this._render(); }
  }

  // Bracket the renderer's GL work. gpuBegin/gpuEnd must wrap ONLY the
  // display.frame() call: a query spanning anything else (a canvas readback, the
  // HUD's own DOM writes) stops being a measure of the renderer.
  gpuBegin() {
    if (!this._measuring || !this._hold.length) return;
    // Stage calls this from exactly the frames that DRAW — a callback the
    // present pacing skipped returns before it — so it is also this tick's
    // PRESENTED flag, which is the one thing ttp_perf_sample wants to know
    // about the pacing. Marked before the pool check below: a frame that draws
    // presented a picture whether or not it also got a timer query.
    const f = this._hold[this._hold.length - 1];
    f.presented = true;
    // SAMPLE WHAT THE POOL CAN CARRY, rather than issuing a query per frame and
    // throwing the overflow away. Results come back at the driver's own rate,
    // not the frame's, and past a few hundred fps the frames win: measured
    // uncapped on an empty scene the pool sat pinned at MAX_PENDING and NOT ONE
    // result ever landed, so the readout was blank exactly where the frame was
    // cheapest. Skipping instead makes the query rate self-pacing — every query
    // issued is one that resolves — and the window simply samples fewer frames.
    const gl = this._acquire();   // before the pool check, so context loss is still seen
    if (!gl || this._open || this._pending.length >= MAX_PENDING) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
    this._open = { query, n: f.n };
    f.waiting = true;             // held until this comes back (see _flush)
  }

  gpuEnd() {
    const gl = this._gl;
    if (!gl) return;
    if (this._open) {
      gl.endQuery(this._ext.TIME_ELAPSED_EXT);
      this._pending.push(this._open);
      this._open = null;
    }
    // DRAINING IS NOT CONDITIONAL ON HAVING OPENED ONE. A frame that skipped its
    // query (the pool was full) is exactly the frame whose job it is to collect
    // what came back, and gating this on _open deadlocks: the pool stays full,
    // so every later frame skips too, so nothing ever drains it.
    this._drain();
    this._flush();
  }

  // This frame's CPU cost, from Display.profile(). Called after the frame so the
  // numbers are the ones the renderer just posted.
  cpu(ms) {
    if (!this._measuring || ms == null || !this._hold.length) return;
    this._hold[this._hold.length - 1].cpu = ms;   // the frame tick() just opened
  }

  // Cell count. NOT in the panel — a human looking at the TV can already see how
  // many cells are on it. It rides the readout because a SCRIPTED sweep cannot:
  // GPU cost scales with cells and pixels together.
  setCells(n) { this._cells = n | 0; }

  // Hand the measured frames over, oldest first, and never out of order — the
  // monitor folds a trailing second off the timestamps it is given.
  //
  // The NEWEST frame is never pushed: gpuBegin, gpuEnd and cpu() all land inside
  // its own rAF callback, after tick() opened it, so it is only finished with
  // once the next tick exists. Behind that, a frame waits for its timer result,
  // and everything behind IT waits too rather than jumping the queue.
  _flush() {
    while (this._hold.length > 1) {
      const f = this._hold[0];
      if (f.waiting && this._hold.length <= HOLD_MAX) break;
      this._hold.shift();
      if (perf) perf.sample(f.t, f.interval, f.presented ? 1 : 0, f.cpu, f.gpu);
      // The ring is the SCOPE's, and nothing else reads it: kept only while
      // there is a scope being drawn. (The sample above is unconditional and
      // must stay so — it is the rule's window, not the panel's.)
      if (!this._visible) continue;
      this._ring.push(f);
      if (this._ring.length > STRIP) this._ring.shift();
    }
  }

  // ---- GPU timer --------------------------------------------------------------

  _acquire() {
    if (this._gpuState === 'unavailable' || this._gpuState === 'lost') return null;
    if (this._gl) {
      if (this._gl.isContextLost()) { this._gpuState = 'lost'; this._gl = null; return null; }
      return this._gl;
    }
    // Same context object Filament is drawing with (see the ctor's note).
    const gl = this._canvas.getContext('webgl2');
    const ext = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!gl || !ext) { this._gpuState = 'unavailable'; return null; }
    this._gl = gl; this._ext = ext; this._gpuState = 'ext';
    return gl;
  }

  // Results land one or two frames late, so they are written back into the frame
  // they belong to — which is the frame still being HELD for them.
  _drain() {
    const gl = this._gl;
    // Read GPU_DISJOINT ONCE per drain, before consuming any result: reading it
    // CLEARS it, so a per-result read would let the first result eat the flag
    // and the rest of the batch keep their garbage. A disjoint means the GPU was
    // interrupted (clock change, context switch) and every timing in flight over
    // that window is meaningless.
    const disjoint = gl.getParameter(this._ext.GPU_DISJOINT_EXT);
    if (disjoint) this._disjoints++;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const p = this._pending[i];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ms = gl.getQueryParameter(p.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(p.query);
      this._pending.splice(i, 1);
      // The frame may have gone over already (HOLD_MAX), in which case the
      // result has nowhere to land. A disjoint one has nowhere to land either:
      // the cost stays ABSENT, which is not the same as zero.
      const f = this._hold.find((x) => x.n === p.n);
      if (!f) continue;
      f.waiting = false;
      if (!disjoint) f.gpu = ms;
    }
  }

  // Every query in flight, and the frames waiting on them, are thrown away
  // together: the results would land in a window that no longer describes the
  // same thing, and the frames would otherwise wait for results nobody is going
  // to collect.
  _dropInflight() {
    const gl = this._gl;
    if (gl) {
      if (this._open) { gl.endQuery(this._ext.TIME_ELAPSED_EXT); this._pending.push(this._open); }
      for (const p of this._pending) gl.deleteQuery(p.query);
    }
    this._open = null;
    this._pending = [];
    this._hold = [];
    this._ring = [];
  }

  // ---- the readout ------------------------------------------------------------

  // The canonical readout line — ttp_perf_readout_json's own bytes, which is
  // what a bench logs (`TtpPerf <json>`, the same shape on all three shells) and
  // what the panel below draws from. Null before the runtime module has bound.
  readout() {
    if (!perf) return null;
    return perf.readout(this._cells, this._canvas.width, this._canvas.height,
                        this.dpr, this.track);
  }

  // The same readout as data, plus the two facts only this side has. Also the
  // scripted-sweep surface (window.__perf.sample()): a GPU budget probe across
  // the catalogue is just this, once per track.
  sample() {
    const line = this.readout();
    const r = line ? JSON.parse(line) : {};
    return {
      ...r,
      // ADAPTED AT THE BOUNDARY: the ABI spells an empty series as null and the
      // buffer as width/height, while this file, Stage._adaptScale and
      // scripts/perf-features.mjs all read stat keys and one `pixels` pair.
      cpu: r.cpu || NO_STAT, gpu: r.gpu || NO_STAT, frame: r.frame || NO_STAT,
      pixels: [this._canvas.width, this._canvas.height],
      // Web-only, and none of the ABI's business: whether this backend has a GPU
      // timer at all, and how many readings a disjoint threw away.
      gpuTimer: this._gpuState,
      disjoints: this._disjoints
    };
  }

  _render() {
    const s = this.sample();
    if (!s.budgetMs) return;              // the runtime module has not bound yet
    if (s.warming) {
      // The monitor discards a run's warm-up frames (perf_stats.h says why), so
      // the scope drops the columns it drew from them: a 75 ms boot spike
      // sitting red in the strip for three seconds is the same false alarm the
      // filter exists to stop. At most one poll's worth survives the switch.
      this._ring = [];
      this._text.textContent = 'perf: warming up';
      return;
    }
    // BOTH COSTS ARE SHOWN AS % OF BUDGET USED, low is good — the same sense as
    // the scope bars, where height IS share of budget. They do NOT sum: the CPU
    // builds frame N's commands while the GPU is still drawing N-1, so 30% + 30%
    // is a comfortable frame, not a 60% one. Whichever is larger is the one to
    // cut.
    const p = (ms) => (ms == null ? '—' : Math.round(100 * ms / s.budgetMs) + '%');
    const gpuPart = s.gpuTimer === 'ext' ? `gpu ${p(s.gpu.p50)}`
        : `gpu ${s.gpuTimer === 'unavailable' ? 'no timer ext' : s.gpuTimer}`;
    // TWO RATES, ALWAYS BOTH, as the two TV shells print them: `hz` is how often
    // the loop ticked, `fps` counts only the ticks that DREW, and the gap is how
    // many pictures the panel never got. They fold over the same numerator base,
    // so a healthy machine shows them EQUAL — do not suppress one for looking
    // redundant, the PAIR is the diagnosis and only C++ may decide the numbers.
    const rate = `${s.fps}/${s.hz} fps`;
    const skips = s.skips ? ` · ${s.skips} skip${s.skips === 1 ? '' : 's'}` : '';
    this._text.textContent = [
      `${s.width}×${s.height} · ${rate} · ${s.drops} drop${s.drops === 1 ? '' : 's'}${skips}`,
      `${gpuPart} · cpu ${p(s.cpu.p50)}`
    ].join('\n');
    this._el.style.color = TINT[s.verdict] || TINT.good;
    this._drawScope(s.budgetMs);
  }

  // The scope: one column per frame, newest at the right. GPU as a filled bar,
  // CPU as a dot trace over it, and a tick on the baseline for a tick that put
  // no new picture up.
  //
  // FULL HEIGHT IS ONE FRAME BUDGET, so a bar's height IS the percentage on the
  // line above and the top edge is the cliff. (Scaling to 2× budget instead
  // draws a typical 40% frame as 4 px of 34 — measured, and unreadable. The
  // gradient is the thing being watched; the strip should spend its pixels on
  // it.) An over-budget frame clamps at the top and turns red.
  //
  // The MISSED-BUDGET count is on the line above and is not drawn per column:
  // it rounds (a 25 ms present is one slipped frame, 16.9 ms is none), and that
  // rounding is one of the rules that moved into the wasm. Re-deriving it here
  // to place a tick is exactly the drift the move was for.
  _drawScope(budgetMs) {
    const ctx = this._ctx;
    const H = STRIP_H;
    ctx.clearRect(0, 0, STRIP, H);
    const w = this._ring;
    const x0 = STRIP - w.length;
    const y = (ms) => H - Math.min(H, (ms / budgetMs) * H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';   // half-budget reference
    ctx.fillRect(0, y(budgetMs / 2), STRIP, 0.5);
    for (let i = 0; i < w.length; i++) {
      const f = w[i], x = x0 + i;
      if (f.gpu > 0) {
        ctx.fillStyle = f.gpu > budgetMs ? 'rgba(255,107,107,0.9)' : 'rgba(79,163,247,0.85)';
        ctx.fillRect(x, y(f.gpu), 1, H - y(f.gpu));
      }
      if (f.cpu > 0) {
        ctx.fillStyle = 'rgba(176,140,232,0.95)';
        ctx.fillRect(x, y(f.cpu) - 0.5, 1, 1);
      }
      if (!f.presented) {
        ctx.fillStyle = '#FF6B6B';
        ctx.fillRect(x, H - 2, 1, 2);
      }
    }
  }
}
