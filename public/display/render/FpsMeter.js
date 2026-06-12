// Bottom-right FPS/frame-time debug readout for the display.
export class FpsMeter {
  // Bottom-right FPS/frame-time readout (debug aid). Shows smoothed FPS, the mean
  // frame time, and the WORST frame time in each ~250ms window (the worst is what
  // you feel — vsync bounces a single 17ms frame to 33ms). Reads the REAL rAF
  // cadence (the loop's raw delta, before the sim's dt clamp). Toggle with the "P"
  // key; shown by default (it's a debug build aid).
  constructor(container) {
    const el = document.createElement('div');
    el.className = 'fps-meter';
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;'
      + 'font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
      + 'color:#7CFC8A;background:rgba(0,0,0,0.55);padding:4px 8px;border-radius:7px;'
      + 'pointer-events:none;white-space:pre;text-align:right;letter-spacing:.3px;';
    el.textContent = '— fps';
    (container || document.body).appendChild(el);
    this._fpsEl = el;
    this._fpsFrames = 0;      // frames since last text update
    this._fpsAccumMs = 0;     // summed real frame time since last update
    this._fpsWorstMs = 0;     // worst frame in this window
    this._fpsLastUpdate = 0;  // timestamp of last text update
    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') el.style.display = (el.style.display === 'none') ? '' : 'none';
    });
  }

  // Fold one real frame (rawMs = unclamped rAF delta) into the meter and refresh
  // the text every ~250ms. Colour goes amber/red as the worst frame degrades.
  tick(t, rawMs) {
    this._fpsFrames++;
    this._fpsAccumMs += rawMs;
    if (rawMs > this._fpsWorstMs) this._fpsWorstMs = rawMs;
    if (t - this._fpsLastUpdate < 250) return;
    const mean = this._fpsAccumMs / this._fpsFrames;
    const fps = 1000 / mean;
    const worst = this._fpsWorstMs;
    const el = this._fpsEl;
    if (el) {
      el.textContent = `${fps.toFixed(0)} fps\n${mean.toFixed(1)} ms (⤒${worst.toFixed(0)})`;
      el.style.color = worst > 32 ? '#FF6B6B' : worst > 20 ? '#FFD166' : '#7CFC8A';
    }
    this._fpsFrames = 0; this._fpsAccumMs = 0; this._fpsWorstMs = 0; this._fpsLastUpdate = t;
  }
}
