// Photograph the Apple TV, one shot per gallery scenario, into
// public/assets/shots/tvos-device/ (or tvos-sim/).
//
//   npm run shots:tvos          # the paired device, "Spielzimmer"
//   npm run shots:tvos-sim      # the Apple TV 4K simulator
//   node scripts/capture-shots-tvos.mjs --device <udid> --only lobby,podium
//
// WHY XCUITEST AND NOT SOMETHING SIMPLER. There is no screenshot verb for a real
// Apple TV. `xcrun devicectl device` offers copy/info/install/notification/
// orientation/process/reboot/sysdiagnose/uninstall and nothing else — `strings
// devicectl | grep -i screenshot` is empty. The device advertises
// `com.apple.coredevice.feature.viewdevicescreen`, but that is Xcode's
// interactive mirroring window with no CLI entry point. `simctl io screenshot`
// covers the simulator only.
//
// THE DECISIVE FACT, checked on this exact hardware before any of it was built:
// XCUIScreen.main.screenshot() captures the CAMetalLayer's contents composited
// with the UIKit chrome over it. A magenta-clearing Metal view under a white
// label came back as a magenta PNG with the label on top, from the physical
// A10X box. Had that come back black, this whole approach would have been dead
// and the fallback was Filament readPixels (3D only, no HUD, needs a LAN) — which
// is the right tool for a future renderer-conformance diff and the wrong one for
// a gallery of SCREENS.
//
// THE TEST DRIVES NOTHING THROUGH THE REMOTE. Each scenario is a launch argument
// the app's own harness stands the screen up from, exactly as `?scenario=` does
// for the web. Walking the real lobby with XCUIRemote presses would be slow,
// flaky, and would photograph a different thing on a slow build.
//
// THE APPLE TV MUST BE AWAKE. `devicectl device info displays` reports
// backlightState; this asserts it rather than silently filling the gallery with
// identical black rectangles.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GALLERY_SCENARIOS } from '../public/shared/galleryScenarios.js';
import { readManifest, writeManifest, shotDir } from './lib/shots.mjs';
import { shotTestMethod } from '../shells/tvos/scripts/gen-scenarios.mjs';
import { sh, resolveDestination, resolveDevicectlId, signingArgs, assertAwake } from './lib/tvos-device.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TVOS = path.join(ROOT, 'shells/tvos');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : true]] : []
  )
);

const SIM = !!args.sim;
const PLATFORM = SIM ? 'tvos-sim' : 'tvos-device';
const OUT_W = parseInt(args.outWidth, 10) || 1280;

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
// A typo used to capture NOTHING and say so only by writing no files. Now it
// would reach xcodebuild as a selector for a test that does not exist, whose
// error names Xcode rather than the flag you got wrong — so it is caught here.
if (only) {
  const known = new Set(GALLERY_SCENARIOS.map((s) => s.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `--only names no such scenario: ${unknown.join(', ')}\n` +
      `  known: ${[...known].join(', ')}`);
  }
}
const scenarios = GALLERY_SCENARIOS.filter((s) => !only || only.has(s.id));




function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch { return 'unknown'; }
}

// Resize and encode one exported PNG to WebP.
//
// Two attempts in order, because none of the four candidates is reliably
// present and the two obvious ones are both wrong on a stock machine:
//   - `sips` ships with macOS and resizes fine, but CANNOT WRITE WebP
//     ("Can't write format: org.webmproject.webp") — it is not in `sips
//     --formats`' writable list at all.
//   - Homebrew's `ffmpeg` is commonly built without the libwebp encoder
//     ("Default encoder for format webp is probably disabled").
//   - `cwebp` is Google's own encoder and does both jobs in one call; Pillow is
//     the fallback for a machine that has Python imaging but not the webp
//     package.
// Falling back to PNG is deliberately NOT an option: it would put this gallery
// back at the tens of megabytes the format choice exists to avoid.
function toWebp(src, dest, width) {
  const attempts = [
    // -resize W 0 preserves the aspect ratio.
    () => sh('cwebp', ['-quiet', '-q', '80', '-resize', String(width), '0', src, '-o', dest]),
    () => sh('python3', ['-c',
      'import sys;from PIL import Image;' +
      'i=Image.open(sys.argv[1]);' +
      'w=int(sys.argv[3]);' +
      'i=i.resize((w,round(i.height*w/i.width)),Image.LANCZOS);' +
      'i.save(sys.argv[2],"WEBP",quality=80)',
      src, dest, String(width)])
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      attempt();
      return;
    } catch (e) {
      errors.push(e.message.split('\n')[0]);
    }
  }
  throw new Error(
    'no WebP encoder worked. Install one:  brew install webp\n  ' + errors.join('\n  '));
}

// The signing identity and the device lookup both live in `lib/tvos-device.mjs`
// now, shared with the lifecycle gate. A team ID is deliberately NOT in
// `project.yml`: it belongs to whoever is building, not to the project, and a
// checked-in one makes the repo unbuildable for everyone else while looking like
// it works.

async function main() {
  // UNCONDITIONALLY, as `shells/tvos/scripts/build.sh` does. Regenerating only
  // when the .xcodeproj is absent means an edited project.yml — a new source
  // file, a changed bundle resource — is silently ignored, and the shots then
  // photograph a build made from a stale project with no error anywhere. It
  // costs about a second.
  sh('xcodegen', ['generate', '--spec', path.join(TVOS, 'project.yml'),
                  '--project', TVOS, '--quiet'], { cwd: TVOS });

  const destination = resolveDestination({ sim: SIM, device: args.device });
  if (!SIM) assertAwake(resolveDevicectlId());
  console.log(`==> ${PLATFORM}: ${destination}`);

  const bundle = path.join(os.tmpdir(), `ttp-shots-${PLATFORM}.xcresult`);
  fs.rmSync(bundle, { recursive: true, force: true });

  // ONE `xcodebuild test`: the build, sign and install dominate the wall clock,
  // so there is nothing to gain by splitting the run.
  //
  // `--only` REACHES THE DEVICE, via one `-only-testing:` per scenario. The
  // scenario table is compiled in (Generated/ShotScenarios.swift, baked by
  // shells/tvos/scripts/gen-scenarios.mjs) because a device run never receives a
  // TEST_RUNNER_ environment variable — see that generator's header — but it
  // bakes a METHOD PER SCENARIO, and a method is what `-only-testing:` selects.
  // Before that the device shot all eighteen boards however few you asked for
  // and this script threw the extras away after export, so looking at one
  // changed screen cost a full-table capture.
  //
  // `-only-testing` IS NOT AN OPTIMISATION, it is the difference between this
  // script doing its job and running two unrelated harnesses every time. The
  // shots target also holds `RealRaceShotTests`, which sleeps 15 s twenty times
  // over (five minutes, deliberately — it photographs a real race for the rubber
  // layer), and `SkidShotTests`, which sleeps another 90 s. Without this flag
  // `xcodebuild test` runs the WHOLE TARGET, so every gallery capture paid both:
  // ~10 minutes wall for a job that is a couple of minutes. SkidShotTests' own
  // header already claims it is "reached only by an explicit -only-testing" —
  // this is the line that finally makes that true.
  const signing = signingArgs({ sim: SIM });

  sh('xcodebuild', [
    'test',
    '-project', path.join(TVOS, 'TinyTrackParty.xcodeproj'),
    '-scheme', 'TinyTrackParty',
    '-destination', destination,
    '-resultBundlePath', bundle,
    '-derivedDataPath', path.join(os.tmpdir(), `ttp-dd-${PLATFORM}`),
    ...(only
      ? scenarios.map((s) => `-only-testing:TinyTrackPartyShots/ShotTests/${shotTestMethod(s.id)}`)
      : ['-only-testing:TinyTrackPartyShots/ShotTests']),
    '-allowProvisioningUpdates',
    ...signing
  ], { stdio: ['ignore', args.verbose ? 'inherit' : 'ignore', 'inherit'], cwd: TVOS });

  // Attachments come out named by the XCTAttachment's own `name`, prefixed onto
  // suggestedHumanReadableName — which is why the test names each one after its
  // scenario and the rename below is a lookup rather than a guess.
  const exported = path.join(os.tmpdir(), `ttp-att-${PLATFORM}`);
  fs.rmSync(exported, { recursive: true, force: true });
  sh('xcrun', ['xcresulttool', 'export', 'attachments',
    '--path', bundle, '--output-path', exported]);

  const manifestJson = JSON.parse(fs.readFileSync(path.join(exported, 'manifest.json'), 'utf8'));
  const attachments = manifestJson.flatMap((t) => t.attachments || []);

  const dir = shotDir(ROOT, PLATFORM);
  fs.mkdirSync(dir, { recursive: true });
  const sha = gitSha();
  const entries = [];

  for (const scenario of scenarios) {
    const att = attachments.find((a) =>
      (a.suggestedHumanReadableName || '').startsWith(`ttp-${scenario.id}_`));
    // No attachment is also the UNSUPPORTED path (the runner skips a screen
    // this platform does not have — the welcome board), so this is a note,
    // not a failure; a scenario the app genuinely failed to reach shows up as
    // an XCTFail in the test output above.
    if (!att) { console.warn(`  ${scenario.id}: no attachment (unsupported here, or see test failures above)`); continue; }
    const src = path.join(exported, att.exportedFileName);
    const file = `${scenario.id}.webp`;
    const dest = path.join(dir, file);
    toWebp(src, dest, OUT_W);
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
      deviceName: att.deviceName,
      deviceId: att.deviceId
    });
    console.log(`  ${scenario.id.padEnd(14)} ${String(size).padStart(7)} B  ${att.deviceName || ''}`);
  }

  const manifest = readManifest(ROOT);
  const keep = manifest.shots.filter(
    (s) => !(s.platform === PLATFORM && entries.some((e) => e.scenario === s.scenario))
  );
  writeManifest(ROOT, { ...manifest, shots: [...keep, ...entries] });
  console.log(`==> ${entries.length} ${PLATFORM} shots -> public/assets/shots/${PLATFORM}/`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
