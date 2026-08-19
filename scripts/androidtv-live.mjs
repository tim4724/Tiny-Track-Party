// What a REAL race actually settles at, with the adaptive scale left alone.
//
// A frozen-field bench draws one picture per arm; that is what makes two arms
// comparable and it is exactly what makes it a poor answer to "does this hold
// 60". A live race moves the camera through the whole circuit, rasterises and
// uploads rubber, regenerates the skid mips, and lets `ttp_display_scale_step`
// resize the buffer underneath all of it. So: drive, and read the readout back
// over the whole lap.
//
//   node scripts/androidtv-live.mjs --track tidepool --seconds 45
//   node scripts/androidtv-live.mjs --pin 0.667      # hold 720p and see what it costs
//   node scripts/androidtv-live.mjs --tracks tidepool,skysnake,powder
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ADB, findTvDevice } from './lib/androidtv-device.mjs';
import { Phone, loadProtocol } from './lib/phone.mjs';

const PACKAGE = 'com.couchgames.tinytrackparty';
const ACTIVITY = `${PACKAGE}/.MainActivity`;

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : argv[argv.indexOf(hit) + 1] ?? d;
};

const SERIAL = findTvDevice(opt('serial', null));
const TRACKS = opt('tracks', opt('track', 'tidepool')).split(',').map((s) => s.trim());
const SECONDS = parseInt(opt('seconds', '45'), 10);
const PIN = opt('pin', '0');          // 0 = leave the adaptive rule alone
// Camera follows the car that STARTED in place N (see PerfDebug.kt). 7 is the
// realistic arm: the harness phone cannot steer, so its own car (humans start
// last, place 8) grinds a wall over an emptying road. The last AI (place 7)
// actually drives, whole pack in frame — the load a real last-place player sees.
const SPECTATE = opt('spectate', '0');
const PLAYERS = parseInt(opt('players', '1'), 10);
// TTP_FEAT_* mask, so a live run can ablate too — a frozen bench cannot see
// anything that only happens while the field MOVES (the rubber raster, its
// uploads, the mip refresh), which is exactly where a frame-time TAIL lives.
const FEATURES = opt('features', '0x1FFC');

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = join(tmpdir(), 'ttp-android-live.log');

function startLog() {
  rmSync(LOG, { force: true });
  adb('logcat', '-c');
  const out = openSync(LOG, 'w');
  spawn(ADB, ['-s', SERIAL, 'logcat', '-v', 'brief', '-T', '1'],
    { stdio: ['ignore', out, 'ignore'], detached: true }).unref();
}
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');

const parse = (text) => {
  const rows = [...text.matchAll(/I\/TtpPerf\s*\(\s*\d+\):\s*(.*)$/gm)].map((m) => m[1].trim());
  const out = [];
  let cur = null;
  for (const line of rows) {
    const h = line.match(/^(\d+)x(\d+)\s+·\s+(\d+)c\s+·\s+([\d.]+)\s*fps\s+·\s+(\d+)\s+drops?/);
    if (h) { if (cur) out.push(cur); cur = { w: +h[1], h: +h[2], fps: +h[4], drops: +h[5] }; continue; }
    if (!cur) continue;
    const c = line.match(/gpu\s+([\d.]+|n\/a)ms/);
    if (c) {
      cur.gpu = c[1] === 'n/a' ? null : parseFloat(c[1]);
      cur.present = parseFloat(line.match(/present\s+([\d.]+)ms/)?.[1] ?? 'NaN');
      cur.skip = parseInt(line.match(/skip\s+(\d+)%/)?.[1] ?? '0', 10);
      continue;
    }
    // The renderer-CPU spike lines (PerfMonitor.logSpikes): `spike` is the
    // per-phase split of the window's worst frame, `phasemax` each phase's own
    // window max. `name:ms` with a COLON, never a space, so a `name value`
    // section parser cannot mistake a max for a median.
    if (line.startsWith('spike ') || line.startsWith('phasemax ')) {
      cur[line.startsWith('spike ') ? 'spike' : 'phasemax'] = Object.fromEntries(
        [...line.matchAll(/([A-Za-z]+):([\d.]+)/g)].map((m) => [m[1], +m[2]]));
    }
  }
  if (cur) out.push(cur);
  return out;
};

const pct = (xs, q) => {
  const s = xs.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null;
};

async function race(track) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(2000);
  startLog();
  // NOT the feature mask, not yet — see below.
  adb('shell', 'setprop', 'debug.ttp.scale', PIN);
  adb('shell', 'setprop', 'debug.ttp.spectate', SPECTATE);
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'am', 'start', '-n', ACTIVITY);

  const deadline = Date.now() + 90000;
  let room = null;
  while (!room && Date.now() < deadline) {
    room = [...readLog().matchAll(/room ([A-Za-z0-9]+) — /g)].at(-1)?.[1] ?? null;
    if (!room) await sleep(500);
  }
  if (!room) throw new Error('no room code');

  // The readout is a TOGGLE that logs nothing while hidden, and a fresh process
  // starts hidden — so probe for lines logged AFTER a press rather than pressing
  // blind, which is a coin flip.
  for (let i = 0; ; i++) {
    const at = readLog().length;
    await sleep(2500);
    if (parse(readLog().slice(at)).length) break;
    if (i >= 2) throw new Error('the perf readout never logged');
    adb('shell', 'input', 'keyevent', '165');   // KEYCODE_INFO
    await sleep(1200);
  }

  const proto = await loadProtocol();
  const phones = [];
  for (let i = 0; i < PLAYERS; i++) {
    const p = new Phone(proto, { name: `P${i + 1}` });
    await p.join(room);
    p.hello();
    await p.waitFor(() => p.seat != null, `seat ${i + 1}`, 20000);
    phones.push(p);
  }
  const host = phones[0];
  await host.waitFor(() => host.snapshot != null, 'snapshot', 20000);
  const tr = (host.snapshot.tracks || []).find((t) => (t.id ?? t.trackId) === track);
  if (!tr) throw new Error(`unknown track ${track}`);
  host.selectMode({ mode: 'single', trackId: tr.id ?? tr.trackId });
  await sleep(1500);
  if (host.snapshot.trackId == null) {
    host.selectMode({ mode: 'cup', cupId: tr.cup });
    await host.waitFor(() => host.snapshot.trackId != null, 'a track', 15000);
  }
  for (const p of phones.slice(1)) p.setReady(true);
  await sleep(1200);
  host.startGame();
  await host.waitFor(() => host.snapshot.roomState !== 'lobby', 'the race', 30000);

  // THE MASK GOES ON NOW, WITH A SCENE UP, and that ordering is the whole of it:
  // `ttp_display_debug_features` early-returns when there is no scene to tag,
  // while PerfDebug has already recorded the value as applied — so a mask set
  // before launch lands only if a poll happens to fall after the first build,
  // and otherwise reads as a full-feature run wearing an ablated label. It
  // produced two different numbers for one arm before this moved.
  adb('shell', 'setprop', 'debug.ttp.features', FEATURES);
  await sleep(1500);

  // Let the countdown and the first corner go by before anything is counted:
  // the grid is a wall of close-up car and the scaler has not settled.
  await Promise.all(phones.map((p) => p.drive(6000, (t) => 0.5 * Math.sin(t / 850))));
  const mark = readLog().length;
  await Promise.all(phones.map((p, i) =>
    p.drive(SECONDS * 1000, (t) => 0.55 * Math.sin((t + i * 400) / 900))));
  for (const p of phones) { p.stopDriving(); p.close(); }
  return parse(readLog().slice(mark));
}

/**
 * BOTH KNOBS, ON EVERY EXIT PATH. This used to restore only `debug.ttp.scale`,
 * only on the success path, so a Ctrl-C or a throw left the box pinned and
 * masked — and a system property survives a force-stop AND a reinstall, so the
 * next thing to run there inherits it. That used to mean "the next arm of a
 * sweep"; since PerfDebug stopped being debug-only it means the SHIPPING build
 * too, which is how a leftover 0x1FFC from this script turned up in a release
 * screenshot with nothing to explain it.
 */
function restoreKnobs() {
  try {
    adb('shell', 'setprop', 'debug.ttp.scale', '0');
    adb('shell', 'setprop', 'debug.ttp.features', '0');   // 0 = "not set", i.e. draw everything
    adb('shell', 'setprop', 'debug.ttp.aa', '0');
    adb('shell', 'setprop', 'debug.ttp.spectate', '0');         // nothing else ever clears it
  } catch { /* the box went away; nothing to restore it on */ }
}

async function main() {
  console.log(`== live race · ${PLAYERS} player(s) · scale ${PIN === '0' ? 'ADAPTIVE' : PIN}`
  + ` · features ${FEATURES} ==\n`);
  for (const track of TRACKS) {
    const s = await race(track);
    if (!s.length) { console.log(`  ${track}: no samples`); continue; }
    const fps = s.map((x) => x.fps), gpu = s.map((x) => x.gpu);
    const sizes = [...new Set(s.map((x) => `${x.w}x${x.h}`))];
    const last = s.at(-1);
    console.log(`  ${track.padEnd(12)} settled ${last.w}x${last.h}`
      + `   fps p05 ${pct(fps, 0.05)} / median ${pct(fps, 0.5)} / p95 ${pct(fps, 0.95)}`
      + `   gpu p50 ${pct(gpu, 0.5)} p95 ${pct(gpu, 0.95)} ms`
      + `   drops/s ${(s.reduce((a, x) => a + x.drops, 0) / s.length).toFixed(1)}`);
    console.log(`  ${''.padEnd(12)} buffers seen: ${sizes.join(', ')}   samples ${s.length}`);
    // Renderer-CPU spike attribution: each sample's `spike` is ONE frame (the
    // window's worst, by total+build — the ttp:render span), so "top-of-worst"
    // is the share of those frames each phase held. `worst` and `p50` fold the
    // per-window phase maxima instead, which also catches the second culprit.
    const spikes = s.map((x) => x.spike).filter(Boolean);
    const pmax = s.map((x) => x.phasemax).filter(Boolean);
    if (spikes.length) {
      const phases = [...new Set(spikes.flatMap((o) => Object.keys(o)))]
        .filter((n) => n !== 'total');
      const tops = spikes.map((o) =>
        phases.reduce((a, n) => ((o[n] ?? 0) > (o[a] ?? 0) ? n : a)));
      const rows = phases.map((n) => {
        const xs = pmax.map((o) => o[n]).filter((v) => v != null);
        return {
          n,
          max: xs.length ? Math.max(...xs) : 0,
          p50: pct(xs, 0.5) ?? 0,
          top: Math.round((100 * tops.filter((t) => t === n).length) / tops.length),
        };
      }).sort((a, b) => b.max - a.max);
      const worstTotals = spikes.map((o) => (o.total ?? 0) + (o.build ?? 0));
      console.log(`  ${''.padEnd(12)} renderer-CPU worst-frame `
        + `p50 ${pct(worstTotals, 0.5)?.toFixed(1)} / max ${Math.max(...worstTotals).toFixed(1)} ms — by phase:`);
      for (const r of rows) {
        if (r.max < 0.5 && r.top === 0) continue;
        console.log(`  ${''.padEnd(12)}   ${r.n.padEnd(10)}`
          + ` worst ${r.max.toFixed(1).padStart(5)} ms`
          + `   p50-of-worst ${r.p50.toFixed(1).padStart(5)} ms`
          + `   top-of-worst ${String(r.top).padStart(3)}%`);
      }
    }
  }
}

process.on('SIGINT', () => { restoreKnobs(); process.exit(130); });
main()
  .catch((e) => { console.error(String(e.message ?? e)); process.exitCode = 1; })
  // EXIT HARD. The logcat child and the phones' relay sockets keep the event
  // loop alive, so a failure path that merely sets exitCode HANGS the process
  // — it cost three stuck measurement chains in one day (each looked like a
  // wedged box until `ps` showed a 40-minute androidtv-live). Everything this
  // run owes the world is done once restoreKnobs has run.
  .finally(() => { restoreKnobs(); process.exit(process.exitCode ?? 0); });
