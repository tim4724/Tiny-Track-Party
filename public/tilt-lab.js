// Tilt Lab — dev instrument, never shipped (root-level pages stay out of the
// AirConsole zip). Two TiltInput instances on one physical motion:
//   truth : driven by DeviceOrientation, the OS's fused signal — what the
//           normal controller page feels like.
//   filter: driven ONLY by raw devicemotion (accelerationIncludingGravity +
//           rotationRate), the exact payload AirConsole's device_motion relay
//           delivers — what the AC controller feels like.
// If the complementary filter is right, orange tracks green with no visible
// lag, agrees in sign, and stays quiet under translation-only shakes.
import { TiltInput } from './controller/TiltInput.js';

const el = (id) => document.getElementById(id);
const truth = new TiltInput({});
const filter = new TiltInput({});

let nOrient = 0, nMotion = 0, nRates = 0;

function onOrient(e) { nOrient++; truth._onOrient(e); }
const RAW_N = 1080; // ~18 s of raw motion samples for offline unit/axis checks
const raw = [];
function onMotion(e) {
  const a = e.accelerationIncludingGravity, r = e.rotationRate;
  if (!a || a.x == null) return;
  nMotion++;
  if (r && (Math.abs(r.alpha || 0) + Math.abs(r.beta || 0) + Math.abs(r.gamma || 0)) > 0.5) nRates++;
  raw.push({ t: Date.now(), iv: e.interval, ax: a.x, ay: a.y, az: a.z,
    ra: r && r.alpha || 0, rb: r && r.beta || 0, rg: r && r.gamma || 0 });
  if (raw.length > RAW_N) raw.shift();
  filter.setGravity(a.x, a.y, a.z, r && r.alpha || 0, r && r.beta || 0, r && r.gamma || 0);
}

// Guided calibration run: timed phases shown full-screen, every raw sample
// tagged with the phase it belongs to — so offline analysis segments
// deterministically instead of guessing from energy. window.__guided fills
// when the run completes.
// Single-axis phases on purpose: body rates equal the matching Euler-angle
// derivative ONLY for near-single-axis motion — a free 3D wiggle through
// gimbal poses decorrelates them completely (measured: |r| < 0.3).
const PHASES = [
  ['GET READY', 3],
  ['ROLL: smooth right/left leans, phone upright facing you', 6], ['REST', 2],
  ['PITCH: smooth top-edge away/toward you', 6], ['REST', 2],
  ['YAW: flat on palm, smooth compass twists', 6],
  ['DONE — hold still', 2],
];
let guidedPhase = null;
// Latest fused orientation, merged into every recorded motion sample — the
// definitive reference for rate-channel units/sign (deg by spec, OS-fused).
const lastOrient = { oa: null, ob: null, og: null };
window.addEventListener('deviceorientation', (e) => {
  lastOrient.oa = e.alpha; lastOrient.ob = e.beta; lastOrient.og = e.gamma;
});
window.__startGuided = () => {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;inset:0;background:#000d;color:#fff;display:flex;' +
    'align-items:center;justify-content:center;font-size:28px;text-align:center;padding:24px;z-index:9';
  document.body.appendChild(banner);
  window.__guided = null;
  const rec = [];
  const onRec = (e) => {
    const a = e.accelerationIncludingGravity, r = e.rotationRate;
    if (!a || a.x == null || !guidedPhase) return;
    rec.push({ t: Date.now(), phase: guidedPhase, ax: a.x, ay: a.y, az: a.z,
      ra: r && r.alpha || 0, rb: r && r.beta || 0, rg: r && r.gamma || 0,
      oa: lastOrient.oa, ob: lastOrient.ob, og: lastOrient.og });
  };
  window.addEventListener('devicemotion', onRec);
  let i = 0;
  const step = () => {
    if (i >= PHASES.length) {
      window.removeEventListener('devicemotion', onRec);
      guidedPhase = null; banner.remove();
      window.__guided = rec;
      return;
    }
    banner.textContent = PHASES[i][0];
    guidedPhase = PHASES[i][0].split(':')[0];
    setTimeout(step, PHASES[i][1] * 1000);
    i++;
  };
  step();
  return 'guided run started';
};

el('start').addEventListener('click', async () => {
  const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
  try { if (DOE && typeof DOE.requestPermission === 'function') await DOE.requestPermission(); } catch (_) {}
  try { if (DME && typeof DME.requestPermission === 'function') await DME.requestPermission(); } catch (_) {}
  window.addEventListener('deviceorientation', onOrient);
  window.addEventListener('devicemotion', onMotion);
  el('start').style.display = 'none';
  el('ui').style.display = '';
  requestAnimationFrame(tick);
});

// ---- sampling + metrics ----
const HZ = 60, WINDOW_S = 10;
const N = HZ * WINDOW_S;
const sT = new Float32Array(N), sF = new Float32Array(N);
let head = 0, filled = 0, t0 = 0, frames = 0;

const ctx = el('trace').getContext('2d');

function metrics() {
  const n = Math.min(filled, N);
  if (n < HZ * 2) return null;
  // Sign agreement + lag via cross-correlation over ±20 samples (~±330 ms),
  // computed on the last window. Wobble = RMS of the filter while the truth
  // is quiet (|truth| < 0.05) — translation shakes land here.
  let best = 0, bestLag = 0;
  for (let lag = -20; lag <= 20; lag++) {
    let c = 0;
    for (let i = 40; i < n - 40; i++) {
      const a = sT[(head - i + 5 * N) % N];
      const b = sF[(head - i - lag + 5 * N) % N];
      c += a * b;
    }
    if (Math.abs(c) > Math.abs(best)) { best = c; bestLag = lag; }
  }
  let quiet = 0, quietN = 0, active = 0;
  for (let i = 0; i < n; i++) {
    const a = sT[(head - i + 5 * N) % N], b = sF[(head - i + 5 * N) % N];
    if (Math.abs(a) < 0.05) { quiet += b * b; quietN++; } else active++;
  }
  return {
    sign: best === 0 ? 0 : Math.sign(best),
    lagMs: bestLag * (1000 / HZ),
    corr: best,
    wobbleRms: quietN ? Math.sqrt(quiet / quietN) : 0,
    activeFrac: active / n,
  };
}

function tick(t) {
  if (!t0) t0 = t;
  // resample both steers at ~60 Hz regardless of event cadence
  sT[head] = truth._sensorSteer();
  sF[head] = filter._sensorSteer();
  head = (head + 1) % N; filled++;

  el('b-truth').style.left = (50 + sT[(head - 1 + N) % N] * 50) + '%';
  el('b-filter').style.left = (50 + sF[(head - 1 + N) % N] * 50) + '%';

  if (++frames % 6 === 0) {
    const W = ctx.canvas.width, H = ctx.canvas.height, n = Math.min(filled, N);
    ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    for (const [buf, color] of [[sT, '#58d68d'], [sF, '#ff7f50']]) {
      ctx.strokeStyle = color; ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = buf[(head - n + i + 5 * N) % N];
        const x = (i / N) * W, y = H / 2 - v * (H / 2 - 4);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    const m = metrics();
    const v = el('verdict');
    if (!m || m.activeFrac < 0.1) {
      v.innerHTML = '<div class="warn">Lean the phone left and right a few times…</div>';
    } else {
      v.innerHTML = [
        m.sign > 0 ? '<div class="ok">SIGN: agrees</div>'
                   : '<div class="bad">SIGN: INVERTED — the filter steers the wrong way</div>',
        Math.abs(m.lagMs) <= 50 ? `<div class="ok">LAG: ${m.lagMs.toFixed(0)} ms</div>`
                                : `<div class="warn">LAG: ${m.lagMs.toFixed(0)} ms</div>`,
        m.wobbleRms < 0.03 ? `<div class="ok">REST WOBBLE: ${m.wobbleRms.toFixed(3)}</div>`
                           : `<div class="bad">REST WOBBLE: ${m.wobbleRms.toFixed(3)} (rings at centre)</div>`,
      ].join('');
    }
    const scale = filter.gyroScale();
    el('stats').textContent =
      `orientation ${nOrient} ev · motion ${nMotion} ev · live gyro samples ${nRates}\n` +
      `gyro scale: ${scale == null ? 'calibrating…' : scale.toFixed(4)}   ` +
      `truth ${sT[(head - 1 + N) % N].toFixed(2)}   filter ${sF[(head - 1 + N) % N].toFixed(2)}`;
    // machine-readable for remote (adb/DevTools) collection — trace is the
    // last WINDOW_S seconds of both steers, oldest → newest, for offline
    // analysis (the on-page metrics alias on periodic motion).
    const tn = Math.min(filled, N), truthArr = new Array(tn), filtArr = new Array(tn);
    for (let i = 0; i < tn; i++) {
      truthArr[i] = sT[(head - tn + i + 5 * N) % N];
      filtArr[i] = sF[(head - tn + i + 5 * N) % N];
    }
    window.__tiltLab = { metrics: m, nOrient, nMotion, nRates, gyroScale: scale,
      hz: HZ, truth: truthArr, filter: filtArr, raw };
  }
  requestAnimationFrame(tick);
}
