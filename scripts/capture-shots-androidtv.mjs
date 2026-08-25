// Photograph the Android TV app, one shot per gallery scenario, into
// public/assets/shots/androidtv-device/ (or androidtv-emu/).
//
//   npm run shots:androidtv                 # the paired TV box
//   npm run shots:androidtv-emu             # the Television_4K_Android_TV AVD
//   node scripts/capture-shots-androidtv.mjs --serial emulator-5554 --only lobby-track
//
// How the app side works — the intent extras, the TtpShot readiness protocol,
// and why `am start -S` is safe here and nowhere else — is
// shells/androidtv/CLAUDE.md §The screenshot harness.
//
// WEBP AT 1280 WIDE, matching the other three columns exactly (see
// scripts/lib/shots.mjs's toWebp for why not PNG). The 4K AVD screencaps at
// 3840x2160 and a TV box at its own panel size; both land on the same stored
// geometry, so side-by-side and difference mode line up with no rescale in the page.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CAPTURED_SCENARIOS } from '../public/shared/galleryScenarios.js';
// The launch vocabulary (Scenarios.kt's spellings; no manifest to read them
// from) has one script-side home: lib/androidtv-bench.mjs. A rename touches
// Scenarios.kt and that module, nothing here.
import { ACTIVITY, EXTRA_PLAYERS, EXTRA_SCENARIO, EXTRA_TRACK, PACKAGE } from './lib/androidtv-bench.mjs';
import { gitSha, mergeShots, shotDir, toWebp } from './lib/shots.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []
  )
);

const EMU = !!args.emu;
const PLATFORM = EMU ? 'androidtv-emu' : 'androidtv-device';
const OUT_W = parseInt(args.outWidth, 10) || 1280;
// Generous, and it is the SCENE that needs it: a cold launch compiles shaders and
// bakes a 2048x2048 shadow map before the first frame, and the chained-start card
// races most of a lap before it signals.
const READY_TIMEOUT_MS = parseInt(args.timeout, 10) || 90_000;

const ADB = process.env.ADB
  || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
// A typo used to capture NOTHING and say so only by writing no files. Caught here,
// where the message can name the flag rather than leaving adb to launch a scenario
// the app will call unsupported.
if (only) {
  const known = new Set(CAPTURED_SCENARIOS.map((s) => s.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `--only names no such scenario: ${unknown.join(', ')}\n  known: ${[...known].join(', ')}`);
  }
}
const scenarios = CAPTURED_SCENARIOS.filter((s) => !only || only.has(s.id));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(serial, adbArgs, opts = {}) {
  return execFileSync(ADB, ['-s', serial, ...adbArgs],
    { encoding: opts.buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * Which box to photograph.
 *
 * The device half matches `ro.build.characteristics` the way
 * `scripts/lib/androidtv-device.mjs` does — and the emulator half is separate for
 * the reason that module documents: an AVD answers `emulator`, not `tv`, so
 * loosening that match to include it would hand a phone on the desk a
 * leanback-only APK. Two flags, one rule each.
 */
function resolveSerial() {
  if (typeof args.serial === 'string') return args.serial;
  const lines = execFileSync(ADB, ['devices'], { encoding: 'utf8' })
    .split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
  if (!lines.length) throw new Error('no adb device — is the TV on the network, or the AVD booted?');

  const matches = lines.filter((serial) => {
    if (EMU) return serial.startsWith('emulator-');
    const chars = adb(serial, ['shell', 'getprop', 'ro.build.characteristics']).trim();
    return /\btv\b/.test(chars);
  });
  if (!matches.length) {
    throw new Error(
      `no ${EMU ? 'emulator' : 'Android TV device'} among: ${lines.join(', ')}\n` +
      '  pass --serial <id> to name one explicitly');
  }
  if (matches.length > 1) {
    throw new Error(`several candidates (${matches.join(', ')}) — pass --serial <id>`);
  }
  return matches[0];
}

/**
 * IS THE BOX RUNNING THE TREE THIS IS STAMPING THE SHOTS WITH? This script never
 * builds or installs, and a stale install photographs perfectly.
 * app/build.gradle.kts puts the short sha in versionName for exactly this check.
 * Only the sha is compared — the device stamps `-dirty` and gitSha() does not,
 * so a dirty tree can be verified no further than "built from this commit".
 */
function assertBuildMatchesTree(serial) {
  const dump = adb(serial, ['shell', 'dumpsys', 'package', PACKAGE]);
  const onBox = dump.match(/versionName=(\S+)/)?.[1];
  if (!onBox) throw new Error(`${PACKAGE} is not installed on ${serial} — npm run build:androidtv -- release install`);
  const tree = gitSha(ROOT);
  if (onBox.includes(tree) || tree === 'unknown') return;
  throw new Error(
    `the box is running ${onBox} but this tree is ${tree}, and the shots would be\n` +
    '  stamped with the tree — install first:\n' +
    '    npm run build:androidtv -- release install');
}

/** What the gallery prints under the shot, so two boxes are told apart on sight. */
function deviceName(serial) {
  const prop = (k) => adb(serial, ['shell', 'getprop', k]).trim();
  if (EMU) return prop('ro.kernel.qemu.avd_name') || prop('ro.boot.qemu.avd_name') || serial;
  return [prop('ro.product.brand'), prop('ro.product.model')].filter(Boolean).join(' ') || serial;
}

/**
 * Launch one scenario and wait for the app to say it is standing.
 *
 * Polls `logcat -d -s TtpShot:I` rather than tailing a spawned process: the whole
 * conversation is two lines, and a detached tail is one more thing to leak when a
 * capture is interrupted. Both logcat formats are matched — `-v brief` prints
 * `I/TtpShot( 123): …` and the default threadtime prints `… I TtpShot : …` — because
 * a one-format parser reads a healthy run as a timeout.
 */
async function stand(serial, scenario) {
  adb(serial, ['logcat', '-c']);
  const extras = ['--es', EXTRA_SCENARIO, scenario.id];
  // The circuit each card names is the SHARED TABLE's, not this script's — and so
  // is the seat count, which `scenarioQuery` puts on the web's URL from the same
  // key. `--ei`, an INT extra: `--es` hands getIntExtra a String and it answers
  // the default without a word.
  if (scenario.params?.track) extras.push('--es', EXTRA_TRACK, String(scenario.params.track));
  if (scenario.params?.players) {
    extras.push('--ei', EXTRA_PLAYERS, String(scenario.params.players));
  }
  adb(serial, ['shell', 'am', 'start', '-S', '-n', ACTIVITY, ...extras]);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  // `TtpShot:V` — ONE filterspec, and the level is the lowest rather than `I`,
  // because both of those cost a whole capture the first time round. Passing
  // several specs after `-s` (`-s TtpShot:I TtpShot:W TtpShot:E`) makes adb print
  // NOTHING AT ALL rather than complaining, so every scenario timed out at 90 s
  // while the device log plainly held its `ready` line: eighteen boards, none
  // written, no error anywhere. `V` then admits the warn/error lines that the
  // three-spec version was reaching for.
  const verdict = new RegExp(`TtpShot\\s*[(:][^)]*[):]?\\s*(ready|unsupported|failed) ${scenario.id}\\b`);
  while (Date.now() < deadline) {
    await sleep(400);
    const hit = adb(serial, ['logcat', '-d', '-s', 'TtpShot:V']).match(verdict);
    if (hit) return hit[1];
  }
  return 'timeout';
}

async function main() {
  const serial = resolveSerial();
  const name = deviceName(serial);
  console.log(`==> ${PLATFORM}: ${serial} (${name})`);
  assertBuildMatchesTree(serial);

  // A SLEEPING BOX NEVER CREATES A SURFACE: the app boots, logs its version and
  // sits there, which reads exactly like a hung room and photographs as black.
  adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);

  // THE EMULATOR'S DRIVERS ARE NOT WORTH PHOTOGRAPHING, on two counts. Its
  // Vulkan (no host passthrough → guest-side software Lavapipe) hands back
  // vkMapMemory'd host-visible memory with PROT_NONE holes in it, so the first
  // readPixels of a scene build (bakeSilhouette) SIGSEGVs in code upstream
  // Filament would run identically — left alone, VulkanPolicy's boot canary
  // still lands every fresh AVD on GL, but only after two dead launches that
  // read as capture flakes. And its GLES advertises OVR_multiview2 but renders
  // the 4-cell multiview array BLACK (chrome and the 2D cell overlay draw;
  // every 3D cell is empty), so the four-player scenarios photograph as HUD on
  // void. The AVD lane exists to exercise the arm64 SLICE (the JNI bridge,
  // Bionic, the engine), not those drivers — so pin GL and the classic
  // per-cell path up front. The BOX lane must never do this: photographing the
  // shipping configuration is the point there.
  if (EMU) {
    adb(serial, ['shell', 'setprop', 'debug.ttp.vk', '-1']);
    adb(serial, ['shell', 'setprop', 'debug.ttp.mv', '-1']);
  }

  const dir = shotDir(ROOT, PLATFORM);
  fs.mkdirSync(dir, { recursive: true });
  const sha = gitSha(ROOT);
  const tmp = path.join(os.tmpdir(), `ttp-shot-${PLATFORM}.png`);
  const entries = [];

  for (const scenario of scenarios) {
    const verdict = await stand(serial, scenario);
    if (verdict !== 'ready') {
      // Not a throw. `unsupported` is a screen this platform deliberately does not
      // have; a timeout or a failure is worth shouting about but must not cost the
      // fifteen boards that would have worked.
      console.warn(`  ${scenario.id.padEnd(18)} ${verdict}`);
      continue;
    }
    fs.writeFileSync(tmp, adb(serial, ['exec-out', 'screencap', '-p'], { buffer: true }));
    const file = `${scenario.id}.webp`;
    const dest = path.join(dir, file);
    toWebp(tmp, dest, OUT_W);
    const { size } = fs.statSync(dest);
    entries.push({
      scenario: scenario.id,
      platform: PLATFORM,
      file: `${PLATFORM}/${file}`,
      w: OUT_W,
      h: Math.round((OUT_W * 1080) / 1920),
      bytes: size,
      capturedAt: new Date().toISOString(),
      gitSha: sha,
      deviceName: name,
      deviceId: serial
    });
    console.log(`  ${scenario.id.padEnd(18)} ${String(size).padStart(7)} B`);
  }

  fs.rmSync(tmp, { force: true });
  mergeShots(ROOT, PLATFORM, entries);
  console.log(`==> ${entries.length} ${PLATFORM} shots -> public/assets/shots/${PLATFORM}/`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
