// Perf HUD — the display's frame-cost readout (bottom-right; "P" toggles it,
// ?perf=1 arms it at boot). Hidden by default: a party TV should not wear a
// debug panel, and while hidden this file does no work at all (no GL queries,
// no wasm profile reads, no canvas draws).
//
// THREE CLOCKS, and they do not measure the same thing:
//
//   • the rAF interval — the CADENCE the browser presented at. Under vsync it
//     is a plateau (16.7 ms and nothing between), so on its own it says nothing
//     about headroom: 60 fps is equally true at 10% and 95% GPU load. What it
//     does say is whether a vsync was MISSED, which is the part a human feels.
//     Reported here as presented/target + a drop count, never as a mean ms
//     (a mean at vsync is just 1000/fps printed a second time).
//
//   • CPU — ttp_display_profile()'s total: the wasm building this frame's input
//     from the live Game and issuing its GL. Measured ~0.8 ms for a one-cell
//     race, which is close enough to performance.now()'s 0.1 ms coarsening that
//     the per-section split below it is mostly quantization noise — hence the
//     total here, with the sections left to profile() for anyone chasing one.
//
//   • GPU — EXT_disjoint_timer_query_webgl2 wrapped around ttp_display_frame.
//     This is the number nothing else in the page can see: the same frame that
//     costs 0.8 ms of CPU costs 3.4 ms on the GPU. Shown in ms AND as a % of
//     the vsync budget, because "GPU fps" is not a thing under vsync — it would
//     just be the same plateau. Headroom is the gradient worth watching.
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

const CAP = 240;            // frames kept (4 s at 60 Hz) — also the period window
const STRIP = 180;          // columns drawn in the scope (3 s at 60 Hz)
const STRIP_H = 34;         // scope height, CSS px
const STAT_FRAMES = 120;    // frames folded into the percentiles
const TEXT_MS = 250;        // text refresh cadence
const MAX_PENDING = 8;      // in-flight GPU queries before we assume a stall

// Refresh rates we snap the measured vsync period to. A displayed target of
// "60" beats "59.4", and the snap is what lets a solidly GPU-bound run still
// name the right target: locked at 33.3 ms nothing here matches, so the k=2
// pass finds 16.65 → 60 Hz and reports one dropped vsync per frame, which is
// the truth. (A display genuinely running at 30 Hz reads as 60 Hz with constant
// drops. That is a fair description of what it feels like.)
const REFRESH_HZ = [240, 165, 144, 120, 100, 90, 75, 72, 60, 50, 48];

// Exported for tests: this is the one piece of judgement in the file, and the
// k>1 pass is exactly the case that is hard to get right by staring at it.
export function snapPeriod(minMs) {
  if (!(minMs > 0) || !Number.isFinite(minMs)) return 1000 / 60;
  // k ascending, and k=1 wins outright when it matches: 16.7 ms must resolve to
  // 60 Hz, never to "half of 120".
  for (let k = 1; k <= 3; k++) {
    const p = minMs / k;
    for (const hz of REFRESH_HZ) {
      const c = 1000 / hz;
      if (Math.abs(c - p) <= 0.06 * c) return c;
    }
  }
  return minMs; // an unrecognised (or unthrottled, e.g. headless) cadence
}

// Vsyncs missed by a frame that took `interval` on a display refreshing every
// `period`. Rounding is right rather than flooring: presents land ON vsyncs, so
// a 25 ms interval at 60 Hz is a frame that slipped one, not 1.5 of them.
export function vsyncDrops(interval, period) {
  if (!(period > 0) || !(interval > 0)) return 0;
  return Math.max(0, Math.round(interval / period) - 1);
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
    this._frames = [];        // ring of { interval, cpu, gpu, drops }, slot = n % CAP
    this._n = 0;              // absolute frame counter (never wraps)
    this._stamps = [];        // rAF timestamps in the trailing second
    this._periodMs = 1000 / 60;
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
    text.textContent = 'perf: waiting for a frame';
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

    const q = new URLSearchParams(location.search).get('perf');
    if (q !== null && q !== '0') this.show();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') this.toggle();
    });
  }

  // ---- visibility (everything below is inert while hidden) --------------------

  show() { this._setVisible(true); }
  hide() { this._setVisible(false); }
  toggle() { this._setVisible(!this._visible); }
  get visible() { return this._visible; }

  _setVisible(on) {
    if (on === this._visible) return;
    this._visible = on;
    this._el.style.display = on ? '' : 'none';
    if (!on) this._dropQueries();
    else { this._frames = []; this._n = 0; this._stamps = []; } // stale history is worse than none
  }

  // ---- per-frame hooks --------------------------------------------------------

  // One real frame's cadence (rawMs = the unclamped rAF delta). The drop count
  // is measured against the period estimate as it stood at the last text update
  // (sample() refreshes it), so it can lag a refresh-rate change by up to
  // TEXT_MS. That is invisible next to the window the percentiles cover.
  tick(t, rawMs) {
    if (!this._visible) return;
    const drops = vsyncDrops(rawMs, this._periodMs);
    this._frames[this._n % CAP] = { interval: rawMs, cpu: null, gpu: null, drops };
    this._n++;
    this._stamps.push(t);
    while (this._stamps.length && t - this._stamps[0] > 1000) this._stamps.shift();
    if (t - this._lastText >= TEXT_MS) { this._lastText = t; this._render(); }
  }

  // Bracket the renderer's GL work. gpuBegin/gpuEnd must wrap ONLY the
  // display.frame() call: a query spanning anything else (a canvas readback, the
  // HUD's own DOM writes) stops being a measure of the renderer.
  gpuBegin() {
    if (!this._visible || this._n === 0) return; // nothing to attach a result to yet
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
    if (!this._visible || ms == null || this._n === 0) return;
    const f = this._frames[(this._n - 1) % CAP]; // the frame tick() just recorded
    if (f) f.cpu = ms;
  }

  // Cell count for the header — GPU cost scales with it (and with pixels), so a
  // number without them is not comparable to any other number.
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
  // this, once per track. NOT a pure read: it re-estimates the vsync period,
  // which is what every other number here is measured against.
  sample() {
    const w = this._window(STAT_FRAMES);
    const stat = (key) => {
      const a = w.map((f) => f[key]).filter((v) => v != null).sort((x, y) => x - y);
      return a.length ? { p50: pct(a, 0.5), p95: pct(a, 0.95), max: a[a.length - 1], n: a.length }
                      : { p50: null, p95: null, max: null, n: 0 };
    };
    // The period estimate looks at the whole ring: a longer window is likelier to
    // contain one frame that actually hit vsync.
    const all = this._window(CAP);
    let min = Infinity;
    for (const f of all) if (f.interval > 0 && f.interval < min) min = f.interval;
    this._periodMs = snapPeriod(min);
    const gpu = stat('gpu');
    return {
      fps: this._stamps.length,
      target: Math.round(1000 / this._periodMs),
      periodMs: this._periodMs,
      drops: all.slice(-Math.min(all.length, Math.round(1000 / this._periodMs)))
                .reduce((s, f) => s + f.drops, 0),
      gpu, cpu: stat('cpu'), frame: stat('interval'),
      budget: gpu.p50 == null ? null : gpu.p50 / this._periodMs,
      gpuTimer: this._gpuState,
      disjoints: this._disjoints,
      pixels: [this._canvas.width, this._canvas.height],
      dpr: window.devicePixelRatio || 1,
      cells: this._cells
    };
  }

  _render() {
    const s = this.sample();
    const n1 = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
    const gpuLine = s.gpuTimer === 'ext'
        ? `gpu ${n1(s.gpu.p50)} (p95 ${n1(s.gpu.p95)}) · ${s.budget == null ? '—' : Math.round(s.budget * 100) + '%'}`
        : `gpu n/a · ${s.gpuTimer === 'unavailable' ? 'no timer ext' : s.gpuTimer}`;
    this._text.textContent = [
      `${s.fps}/${s.target} fps · ${s.drops} drop${s.drops === 1 ? '' : 's'}`,
      gpuLine,
      `cpu ${n1(s.cpu.p50)} · frame p95 ${n1(s.frame.p95)}`,
      `${s.pixels[0]}×${s.pixels[1]} · ${this._cells || 'no'} cell${this._cells === 1 ? '' : 's'}`
    ].join('\n');
    // Health is the GPU's p95 against the budget, plus dropped vsyncs. Both are
    // "what you feel"; the p50 is what you tune against.
    const over = s.gpu.p95 != null ? s.gpu.p95 / s.periodMs : (s.frame.p95 / s.periodMs) - 1;
    this._el.style.color = (s.drops > 2 || over > 1) ? '#FF6B6B'
        : (s.drops > 0 || over > 0.7) ? '#FFD166' : '#7CFC8A';
    this._drawScope(s.periodMs);
  }

  // The scope: one column per frame, newest at the right. GPU as a filled bar,
  // CPU as a dot trace over it, and a tick on the baseline for every dropped
  // vsync.
  //
  // FULL HEIGHT IS ONE VSYNC PERIOD, so a bar's height IS its share of the
  // budget and the top edge is the cliff. (Scaling to 2× budget instead draws a
  // typical 40% frame as 4 px of 34 — measured, and unreadable. Headroom is the
  // thing being watched; the strip should spend its pixels on it.) An
  // over-budget frame clamps at the top and turns red, which is where the drop
  // ticks under it start appearing anyway.
  _drawScope(period) {
    const ctx = this._ctx;
    const H = STRIP_H;
    ctx.clearRect(0, 0, STRIP, H);
    const w = this._window(STRIP);
    const x0 = STRIP - w.length;
    const y = (ms) => H - Math.min(H, (ms / period) * H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';   // half-budget reference
    ctx.fillRect(0, y(period / 2), STRIP, 0.5);
    for (let i = 0; i < w.length; i++) {
      const f = w[i], x = x0 + i;
      if (f.gpu != null) {
        ctx.fillStyle = f.gpu > period ? 'rgba(255,107,107,0.9)' : 'rgba(79,163,247,0.85)';
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
