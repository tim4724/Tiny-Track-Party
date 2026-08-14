// Perf HUD — the display's frame-cost readout (bottom-right; "P" hides it).
//
// ON BY DEFAULT while the game is in development: the frame budget is something
// to keep under your eye, not something to remember to switch on. Turning the
// PANEL off for release is a one-line change here — gate the show() below on
// whatever release signal exists at that point. AirConsole is now that signal.
//
// SHOWING AND MEASURING ARE SEPARATE (instrument()). The hide path stops every
// canvas draw and DOM write, but a hidden HUD still keeps its ring and its timer
// query for a caller that reads sample() rather than looking at it — which the
// adaptive render scale (Stage) does on a shipped TV, where this panel is off.
// So gating show() no longer makes the class inert, and must not: the release
// build is exactly the case the scale controller has to keep working in.
//
// THE BAR IS 60 fps, FLAT. The budget is a CONSTANT 16.7 ms and the panel's
// refresh rate is deliberately not detected, because nothing here needs it: a
// percentage is cost ÷ budget, and a fixed denominator serves that (and the
// missed-budget count) exactly as well as a measured one. An earlier version
// did detect it — a snap table, a k>1 harmonic pass, a rank statistic over a
// 4 s ring to survive the junk interval Stage.start() feeds in — and all of it
// existed to print "/144" and to pick a denominator. It is gone. 60+ is good,
// below is bad, and a 144 Hz monitor no longer scores a perfectly good 16.7 ms
// frame as 240% of budget and turns the whole readout red.
//
// KNOWN AND ACCEPTED: a 50 Hz TV (or a 30 Hz HDMI mode) presents below 60 no
// matter how idle the machine is, so it sits amber permanently. The cost and
// drop numbers beside it still read healthy, so the picture stays legible —
// and that is cheaper than the detector was.
//
// THREE CLOCKS, and they do not measure the same thing:
//
//   • the rAF interval — the CADENCE the browser presented at. Under vsync it
//     is a plateau (16.7 ms and nothing between), so on its own it says nothing
//     about headroom: 60 fps is equally true at 10% and 95% GPU load. What it
//     does say is whether a budget was MISSED, which is the part a human feels.
//     Reported here as fps + a drop count, never as a mean ms (a mean at vsync
//     is just 1000/fps printed a second time).
//
//   • CPU — ttp_display_profile()'s total: the wasm building this frame's input
//     from the live Game and issuing its GL. Measured ~0.9 ms for a 4-cell race
//     at 1280×720, which is close enough to performance.now()'s 0.1 ms coarsening that
//     the per-section split below it is mostly quantization noise — hence the
//     total here, with the sections left to profile() for anyone chasing one.
//
//   • GPU — EXT_disjoint_timer_query_webgl2 wrapped around ttp_display_frame.
//     This is the number nothing else in the page can see: the same frame that
//     costs 0.8 ms of CPU costs 3.4 ms on the GPU.
//
// BOTH COSTS ARE SHOWN AS % OF BUDGET USED, low is good — the same sense as the
// scope bars, where height IS share of budget. They do NOT sum: the CPU builds
// frame N's commands while the GPU is still drawing N-1, so 30% + 30% is a
// comfortable frame, not a 60% one. Whichever is larger is the one to cut.
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

const CAP = 240;            // frames kept in the ring (4 s at 60 Hz)
const STRIP = 180;          // columns drawn in the scope (3 s at 60 Hz)
const STRIP_H = 34;         // scope height, CSS px
const STAT_FRAMES = 120;    // frames folded into the percentiles
const TEXT_MS = 250;        // text refresh cadence
const MAX_PENDING = 8;      // in-flight GPU queries before we assume a stall

// The bar, and the denominator of every percentage here.
export const GOOD_HZ = 60;
export const BUDGET_MS = 1000 / GOOD_HZ;
// fps wobbles by a frame or so at a hard 60 Hz vsync, so "on the bar" has to be
// a band rather than an equality, and it takes a few presents before a rate
// means anything at all.
const FPS_OK = GOOD_HZ - 3;
const FPS_MIN_STAMPS = 10;

// Budgets missed by a frame that took `interval`. Rounding is right rather than
// flooring: presents land on vsyncs, so a 25 ms interval is a frame that
// slipped one budget, not 1.5 of them.
export function budgetsMissed(interval, budget = BUDGET_MS) {
  if (!(budget > 0) || !(interval > 0)) return 0;
  return Math.max(0, Math.round(interval / budget) - 1);
}

// BOOT IS NOT A FRAME RATE. Measured here, the first four presents of a run
// cost 75.5, 17, 50 and 58 ms — shader compilation, pipeline warm-up, the first
// texture uploads — and every frame after them is a clean 8.3. Those four miss
// ~9 budgets between them, and since fps and the drop count are BOTH windowed
// over the trailing second, they hold the readout amber for a full second after
// the game is already running perfectly. Nobody can act on that, and a HUD that
// cries wolf at every boot is one you stop reading.
//
// So a run is WARMING until it delivers WARMUP_RUN frames in a row that miss no
// budget, and warming frames are discarded rather than recorded. It has to be a
// RUN, not one frame: boot is bursty rather than monotonic — that 17 ms second
// frame is already inside budget, and taking it as the all-clear would let the
// 50 and 58 ms frames behind it straight into the window, which is the whole
// problem again.
//
// The condition scales itself. It ends on frame 7 here, later on a slower
// machine, and after exactly WARMUP_RUN frames on a 50 Hz TV (a 20 ms present
// misses no 16.7 ms budget). WARMUP_MAX is the backstop — a machine that cannot
// string three good frames together in 30 is not warming up, it is slow, and it
// must be shown as slow.
const WARMUP_RUN = 3;
const WARMUP_MAX = 30;

// Exported for tests: the updated count of consecutive frames that were fine.
export function warmupRun(interval, run) {
  return budgetsMissed(interval) === 0 ? run + 1 : 0;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
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
    this._canvas = canvas;
    this._visible = false;
    // MEASURING is not the same as SHOWING, and the difference is the whole of
    // what the adaptive render scale (Stage) needs: it decides from the GPU
    // timer on a shipped TV, where this panel is off. Measuring costs a ring
    // write and one timer query per frame; DRAWING (the DOM text and the scope)
    // is what stays gated on _visible, so a release build with the panel off
    // still pays nothing to look at.
    this._instrumenting = false;
    this._measuring = false;
    this._frames = [];        // ring of { interval, cpu, gpu, drops }, slot = n % CAP
    this._n = 0;              // absolute frame counter (never wraps)
    this._stamps = [];        // rAF timestamps in the trailing second
    this._warming = true;     // discarding this run's warm-up frames
    this._warmRun = 0;        // consecutive good frames seen
    this._warmSeen = 0;
    this._cells = 0;
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

    // AirConsole is the tree's only RELEASE surface — the uploaded zip is played
    // by strangers, where a green developer readout pinned to the TV is just a
    // bug they can't dismiss. Every other surface is a dev one and keeps the
    // budget under your eye, and "P" still toggles it on, which is what the AC
    // simulator needs.
    //
    // Hiding stops the DRAWING, not the measuring (see instrument() below), so
    // this gate costs the adaptive render scale nothing — which matters, because
    // the release build is exactly where it has to keep working.
    if (!window.airconsole) this.show();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') this.toggle();
    });
  }

  // ---- visibility and measurement (drawing is what hiding stops) --------------

  show() { this._setVisible(true); }
  hide() { this._setVisible(false); }
  toggle() { this._setVisible(!this._visible); }
  get visible() { return this._visible; }

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
    if (!on) this._dropQueries();
    else this.reset();   // stale history is worse than none
  }

  // Throw the window away and start measuring again from cold. For a caller
  // that has CHANGED what a frame costs — the scale controller resizing the
  // buffer — where keeping the old frames would judge the new resolution partly
  // on the old one's timings. warmUp() alone is not enough: it stops the next
  // few frames being recorded, it does not forget the ones already in the ring.
  reset() { this._frames = []; this._n = 0; this._stamps = []; this.warmUp(); }

  // Re-arm the warm-up discard. Called when the rAF loop starts from cold: a
  // stopped-then-restarted loop pays the same first-frame costs a boot does.
  // Costs WARMUP_RUN frames when the renderer is already warm, which is the
  // price of not having to know whether it is.
  warmUp() { this._warming = true; this._warmRun = 0; this._warmSeen = 0; }

  // ---- per-frame hooks --------------------------------------------------------

  // One real frame's cadence (rawMs = the unclamped rAF delta).
  tick(t, rawMs) {
    if (!this._measuring) return;
    // Discard the run's warm-up entirely — recording it would describe the
    // shader compiler, not the game (see warmupRun). The frame that completes
    // the run is itself a good one, so it is the first one kept.
    if (this._warming) {
      this._warmRun = warmupRun(rawMs, this._warmRun);
      if (this._warmRun < WARMUP_RUN && ++this._warmSeen < WARMUP_MAX) return;
      this._warming = false;
    }
    const drops = budgetsMissed(rawMs);
    this._frames[this._n % CAP] = { interval: rawMs, cpu: null, gpu: null, drops };
    this._n++;
    this._stamps.push(t);
    while (this._stamps.length && t - this._stamps[0] > 1000) this._stamps.shift();
    if (this._visible && t - this._lastText >= TEXT_MS) { this._lastText = t; this._render(); }
  }

  // Bracket the renderer's GL work. gpuBegin/gpuEnd must wrap ONLY the
  // display.frame() call: a query spanning anything else (a canvas readback, the
  // HUD's own DOM writes) stops being a measure of the renderer.
  gpuBegin() {
    if (!this._measuring || this._n === 0) return; // nothing to attach a result to yet
    const gl = this._acquire();
    if (!gl || this._open) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
    // tick() ALREADY recorded this frame and advanced the counter, so the frame
    // being rendered is _n - 1. Getting this wrong shifts every GPU bar one
    // column away from the interval and drop tick it belongs to.
    this._open = { query, n: this._n - 1 };
  }

  gpuEnd() {
    if (!this._open) return;
    const gl = this._gl;
    gl.endQuery(this._ext.TIME_ELAPSED_EXT);
    this._pending.push(this._open);
    this._open = null;
    this._drain();
    // A backlog means results stopped arriving (context loss, a driver that
    // never signals). Let them go rather than growing the pool forever.
    while (this._pending.length > MAX_PENDING) {
      const old = this._pending.shift();
      gl.deleteQuery(old.query);
    }
  }

  // This frame's CPU cost, from Display.profile(). Called after the frame so the
  // numbers are the ones the renderer just posted.
  cpu(ms) {
    if (!this._measuring || ms == null || this._n === 0) return;
    const f = this._frames[(this._n - 1) % CAP]; // the frame tick() just recorded
    if (f) f.cpu = ms;
  }

  // Cell count. NOT in the readout — a human looking at the TV can already see
  // how many cells are on it. It stays in sample() because a SCRIPTED sweep
  // cannot: GPU cost scales with cells (and with pixels), so a logged number
  // without both is not comparable to any other logged number.
  setCells(n) { this._cells = n | 0; }

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

  // Results land one or two frames late, so they are written BACK into the frame
  // they belong to — which is why the scope redraws from the ring instead of
  // scrolling a blitted strip.
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
      // >= : the oldest slot still holding a valid frame is _n - CAP. tick() has
      // already written _n - 1 this frame, and _n % CAP is not overwritten until
      // the NEXT one.
      if (!disjoint && p.n >= this._n - CAP) {
        const f = this._frames[p.n % CAP];
        if (f) f.gpu = ms;
      }
    }
  }

  _dropQueries() {
    const gl = this._gl;
    if (!gl) { this._pending = []; this._open = null; return; }
    if (this._open) { gl.endQuery(this._ext.TIME_ELAPSED_EXT); this._pending.push(this._open); this._open = null; }
    for (const p of this._pending) gl.deleteQuery(p.query);
    this._pending = [];
  }

  // ---- stats + drawing --------------------------------------------------------

  // The window of frames the readout describes, oldest first.
  _window(count) {
    const out = [];
    const first = Math.max(0, this._n - count);
    for (let i = first; i < this._n; i++) {
      const f = this._frames[i % CAP];
      if (f) out.push(f);
    }
    return out;
  }

  // Everything the HUD shows, as data. Also the scripted-sweep surface
  // (window.__perf.sample()) — a GPU budget probe across the catalogue is just
  // this, once per track. The ms percentiles stay in here even though the
  // readout prints only percentages: a sweep wants the resolution, a glance
  // does not.
  sample() {
    const w = this._window(STAT_FRAMES);
    const stat = (key) => {
      const a = w.map((f) => f[key]).filter((v) => v != null).sort((x, y) => x - y);
      // p05 is here for ONE reader: the adaptive scale's fallback signal wants
      // the device's own FASTEST present (its vsync period, whatever that panel's
      // rate is) and the raw minimum is not it — a pair of rAFs inside one vsync,
      // or one bad timestamp, and the minimum is half the period forever.
      return a.length ? { p05: pct(a, 0.05), p50: pct(a, 0.5), p95: pct(a, 0.95),
                          max: a[a.length - 1], n: a.length }
                      : { p05: null, p50: null, p95: null, max: null, n: 0 };
    };
    const all = this._window(CAP);
    const gpu = stat('gpu'), cpu = stat('cpu');
    const share = (ms) => (ms == null ? null : ms / BUDGET_MS);
    // A RATE over the span actually sampled, not a count of what is in the
    // trailing second: during the first second the window is short, and a bare
    // count reads as a collapsed frame rate for exactly as long as it takes a
    // human to look at it.
    const span = this._stamps.length > 1
        ? this._stamps[this._stamps.length - 1] - this._stamps[0] : 0;
    return {
      fps: span > 0 ? Math.round((this._stamps.length - 1) * 1000 / span) : 0,
      // Whether fps is meaningful yet. Judging the bar off two presents would
      // paint the HUD red for the first tenth of a second of every run.
      fpsReady: this._stamps.length >= FPS_MIN_STAMPS && span > 0,
      good: GOOD_HZ,
      budgetMs: BUDGET_MS,
      // The last second's worth of frames. _stamps IS that set (it is pruned to
      // the trailing second every tick), so its length is the exact count.
      // slice clamps on its own.
      drops: all.slice(-Math.max(1, this._stamps.length))
                .reduce((s, f) => s + f.drops, 0),
      gpu, cpu, frame: stat('interval'),
      // Share of the 16.7 ms budget CONSUMED, 0..1+ — low is good. Not additive:
      // the CPU runs a frame ahead of the GPU.
      gpuUsed: share(gpu.p50), gpuUsedP95: share(gpu.p95), cpuUsed: share(cpu.p50),
      gpuTimer: this._gpuState,
      disjoints: this._disjoints,
      pixels: [this._canvas.width, this._canvas.height],
      dpr: window.devicePixelRatio || 1,
      cells: this._cells
    };
  }

  _render() {
    const s = this.sample();
    const p = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
    const gpuPart = s.gpuTimer === 'ext' ? `gpu ${p(s.gpuUsed)}`
        : `gpu ${s.gpuTimer === 'unavailable' ? 'no timer ext' : s.gpuTimer}`;
    this._text.textContent = [
      `${s.pixels[0]}×${s.pixels[1]} · ${s.fps} fps · ${s.drops} drop${s.drops === 1 ? '' : 's'}`,
      `${gpuPart} · cpu ${p(s.cpuUsed)}`
    ].join('\n');
    // Health: the rate against the bar, dropped budgets, and the GPU's p95 —
    // the p95 is what you feel, the p50 printed above is what you tune against.
    // With no GPU timer the fallback is the rAF interval's overshoot past one
    // budget, which lands on the same scale: 1.0 means the slow frames take two.
    const over = s.gpuUsedP95 != null ? s.gpuUsedP95 : (s.frame.p95 / BUDGET_MS) - 1;
    const rate = s.fpsReady ? s.fps : GOOD_HZ;  // an unknown rate is not a bad one
    this._el.style.color = (s.drops > 2 || over > 1 || rate < GOOD_HZ * 0.8) ? '#FF6B6B'
        : (s.drops > 0 || over > 0.7 || rate < FPS_OK) ? '#FFD166' : '#7CFC8A';
    this._drawScope();
  }

  // The scope: one column per frame, newest at the right. GPU as a filled bar,
  // CPU as a dot trace over it, and a tick on the baseline for every missed
  // budget period.
  //
  // FULL HEIGHT IS ONE FRAME BUDGET, so a bar's height IS the percentage on the
  // line above and the top edge is the cliff. (Scaling to 2× budget instead
  // draws a typical 40% frame as 4 px of 34 — measured, and unreadable. The
  // gradient is the thing being watched; the strip should spend its pixels on
  // it.) An over-budget frame clamps at the top and turns red, which is where
  // the drop ticks under it start appearing anyway.
  _drawScope() {
    const ctx = this._ctx;
    const H = STRIP_H;
    ctx.clearRect(0, 0, STRIP, H);
    const w = this._window(STRIP);
    const x0 = STRIP - w.length;
    const y = (ms) => H - Math.min(H, (ms / BUDGET_MS) * H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';   // half-budget reference
    ctx.fillRect(0, y(BUDGET_MS / 2), STRIP, 0.5);
    for (let i = 0; i < w.length; i++) {
      const f = w[i], x = x0 + i;
      if (f.gpu != null) {
        ctx.fillStyle = f.gpu > BUDGET_MS ? 'rgba(255,107,107,0.9)' : 'rgba(79,163,247,0.85)';
        ctx.fillRect(x, y(f.gpu), 1, H - y(f.gpu));
      }
      if (f.cpu != null) {
        ctx.fillStyle = 'rgba(176,140,232,0.95)';
        ctx.fillRect(x, y(f.cpu) - 0.5, 1, 1);
      }
      if (f.drops > 0) {
        ctx.fillStyle = '#FF6B6B';
        ctx.fillRect(x, H - 2, 1, 2);
      }
    }
  }
}
