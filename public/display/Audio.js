// RaceAudio — all sound for the big screen, synthesized with Web Audio (no asset
// files). A single engine drone whose pitch/volume track the pack's speed, plus
// discrete SFX (countdown, lap, finish, curb screech). Browsers require a user
// gesture to start audio, so call resume() from a click/key on the display.
export class RaceAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.engine = null;
    this.noiseBuf = null;
    this._lastScreech = 0;
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    // one second of white noise for screech
    const n = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, n, n);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  resume() { this._ensure(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  get ready() { return this.ctx && this.ctx.state === 'running'; }

  // ---- engine drone (level 0..1) ----
  startEngine() {
    this._ensure();
    if (!this.ctx || this.engine) return;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 60;
    const osc2 = ctx.createOscillator(); osc2.type = 'square'; osc2.frequency.value = 90;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 600;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc1.connect(filt); osc2.connect(filt); filt.connect(gain); gain.connect(this.master);
    osc1.start(); osc2.start();
    this.engine = { osc1, osc2, filt, gain };
  }
  setEngine(level) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime, l = Math.max(0, Math.min(1, level));
    const f = 55 + l * 150;
    this.engine.osc1.frequency.setTargetAtTime(f, t, 0.06);
    this.engine.osc2.frequency.setTargetAtTime(f * 1.5, t, 0.06);
    this.engine.filt.frequency.setTargetAtTime(450 + l * 1600, t, 0.06);
    this.engine.gain.gain.setTargetAtTime(0.05 + l * 0.11, t, 0.06);
  }
  stopEngine() {
    if (!this.engine || !this.ctx) return;
    const e = this.engine, t = this.ctx.currentTime;
    try { e.gain.gain.setTargetAtTime(0, t, 0.1); e.osc1.stop(t + 0.4); e.osc2.stop(t + 0.4); } catch (_) {}
    this.engine = null;
  }

  // ---- one-shot SFX ----
  _tone(freq, dur, vol, type = 'square', delay = 0) {
    this._ensure();
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    o.connect(g); g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.03);
  }

  countdown(n) { if (n > 0) this._tone(440, 0.18, 0.3, 'square'); else this._tone(880, 0.5, 0.4, 'sawtooth'); }
  lap() { this._tone(660, 0.12, 0.3); this._tone(990, 0.2, 0.3, 'square', 0.1); }
  finish() { [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.3, 0.35, 'triangle', i * 0.12)); }

  // tyre screech: short band-passed noise burst, throttled so it doesn't machine-gun
  screech(intensity = 1) {
    this._ensure();
    if (!this.ctx || !this.noiseBuf) return;
    const now = performance.now();
    if (now - this._lastScreech < 140) return;
    this._lastScreech = now;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 1.2;
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g); g.connect(this.master);
    const v = 0.12 * Math.max(0.3, Math.min(1, intensity));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.start(t); src.stop(t + 0.25);
  }
}
