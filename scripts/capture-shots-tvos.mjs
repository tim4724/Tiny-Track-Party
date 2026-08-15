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
const scenarios = GALLERY_SCENARIOS.filter((s) => !only || only.has(s.id));

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// The first available tvOS simulator, or the first paired Apple TV. Explicit
// --device wins.
function resolveDestination() {
  if (typeof args.device === 'string') {
    return SIM ? `platform=tvOS Simulator,id=${args.device}` : `platform=tvOS,id=${args.device}`;
  }
  if (SIM) {
    const devices = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices;
    for (const [runtime, list] of Object.entries(devices)) {
      if (!runtime.includes('tvOS')) continue;
      const pick = list.find((d) => d.name.includes('Apple TV 4K')) || list[0];
      if (pick) return `platform=tvOS Simulator,id=${pick.udid}`;
    }
    throw new Error('no tvOS simulator available');
  }
  const out = sh('xcrun', ['devicectl', 'list', 'devices']);
  // The State column moves between `available (paired)` and `connected`
  // depending on whether a tunnel is currently up, and both are usable. Matching
  // only one of them makes the script fail with "no paired Apple TV" while the
  // TV is sitting right there.
  const line = out.split('\n').find((l) => /Apple TV/.test(l) && /available|connected/.test(l));
  if (!line) throw new Error('no paired Apple TV — pair one in Xcode, or pass --device <udid>');
  // The 40-hex identifier xcodebuild wants is the last column of `xctrace list
  // devices`; devicectl prints its own UUID, which xcodebuild does NOT accept.
  const trace = sh('xcrun', ['xctrace', 'list', 'devices']);
  const m = trace.split('\n').find((l) => /Apple TV|Spielzimmer/.test(l) && /\([0-9a-f]{40}\)/.test(l));
  const udid = m && m.match(/\(([0-9a-f]{40})\)/)?.[1];
  if (!udid) throw new Error('could not read a device UDID from xctrace');
  return `platform=tvOS,id=${udid}`;
}

// A sleeping Apple TV composites a black screen and every shot comes back
// identical. Refuse instead of shipping a gallery of black rectangles.
function assertAwake(destination) {
  if (SIM) return;
  const udid = destination.split('id=')[1];
  const tmp = path.join(os.tmpdir(), `ttp-displays-${process.pid}.json`);
  let asleep = false;
  try {
    spawnSync('xcrun', ['devicectl', 'device', 'info', 'displays',
      '--device', udid, '--json-output', tmp], { encoding: 'utf8' });
    const info = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const text = JSON.stringify(info);
    asleep = /"backlightState"\s*:\s*"(?!activeOn)/.test(text);
  } catch {
    // Failing to READ the display state is not evidence of sleep, and not a
    // reason to refuse to capture; only a confirmed off backlight is.
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (asleep) {
    throw new Error('the Apple TV reports its backlight is off — wake it first, or every shot comes back black');
  }
}

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

// The Apple Developer team a DEVICE build signs with.
//
// Not in `project.yml`, deliberately: a team ID is a property of whoever is
// building, not of the project, and a checked-in one makes the repo unbuildable
// for anyone else while looking like it works. The simulator needs none of this
// (it runs unsigned), so this is only consulted for a device run.
//
// Derived from the installed signing certificate rather than asked for: the team
// is the OU field of any Apple Development cert in the keychain, so a machine
// that can sign at all can answer this itself. `TTP_DEVELOPMENT_TEAM` overrides,
// for the case of several teams in one keychain.
function developmentTeam() {
  if (process.env.TTP_DEVELOPMENT_TEAM) return process.env.TTP_DEVELOPMENT_TEAM;
  try {
    const identities = sh('security', ['find-identity', '-v', '-p', 'codesigning']);
    const name = identities.match(/"(Apple Development: [^"]+)"/)?.[1];
    if (!name) return null;
    const pem = sh('security', ['find-certificate', '-c', name, '-p']);
    const subject = execFileSync('openssl', ['x509', '-noout', '-subject'], { input: pem })
      .toString();
    return subject.match(/OU\s*=\s*([A-Z0-9]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // UNCONDITIONALLY, as `shells/tvos/scripts/build.sh` does. Regenerating only
  // when the .xcodeproj is absent means an edited project.yml — a new source
  // file, a changed bundle resource — is silently ignored, and the shots then
  // photograph a build made from a stale project with no error anywhere. It
  // costs about a second.
  sh('xcodegen', ['generate', '--spec', path.join(TVOS, 'project.yml'),
                  '--project', TVOS, '--quiet'], { cwd: TVOS });

  const destination = resolveDestination();
  assertAwake(destination);
  console.log(`==> ${PLATFORM}: ${destination}`);

  const bundle = path.join(os.tmpdir(), `ttp-shots-${PLATFORM}.xcresult`);
  fs.rmSync(bundle, { recursive: true, force: true });

  // ONE `xcodebuild test` for the whole table: the build, sign and install dominate
  // the wall clock (about 60 s cold), and the test phase itself was 7.4 s on
  // device. The scenario list is COMPILED IN — Generated/ShotScenarios.swift,
  // baked by shells/tvos/scripts/gen-scenarios.mjs, because a device run never
  // receives a TEST_RUNNER_ environment variable (see that generator's header) —
  // so the device shoots every scenario and `--only` filters on the HOST, at the
  // attachment lookup after export.
  const signing = [];
  if (SIM) {
    // The simulator runs unsigned, and asking it to sign only invents a reason
    // to fail on a machine with no certificate.
    signing.push('CODE_SIGNING_ALLOWED=NO');
  } else {
    const team = developmentTeam();
    if (!team) {
      throw new Error(
        'no Apple Development certificate found — a device run has to sign.\n' +
        '  Set TTP_DEVELOPMENT_TEAM=<team id>, or run with --sim.');
    }
    signing.push(`DEVELOPMENT_TEAM=${team}`, 'CODE_SIGNING_ALLOWED=YES');
  }

  sh('xcodebuild', [
    'test',
    '-project', path.join(TVOS, 'TinyTrackParty.xcodeproj'),
    '-scheme', 'TinyTrackParty',
    '-destination', destination,
    '-resultBundlePath', bundle,
    '-derivedDataPath', path.join(os.tmpdir(), `ttp-dd-${PLATFORM}`),
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
