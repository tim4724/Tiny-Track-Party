// The suspend/resume gate, on the paired Apple TV, in one command.
//
//   npm run check:tvos-lifecycle
//
// It exists because the gate cannot be run the ordinary way. `LifecycleTests`
// refuses to run against an app the TEST launched — a test-launched process
// provably does not reproduce the bug it guards (tried twice, both clean), while
// the same Menu press on a `devicectl`-launched one froze every time. So the app
// has to be started first, given time to reach the lobby, and only then handed
// to `xcodebuild test`. That is three commands and a device UDID to look up, and
// nobody was going to do it twice.
//
// Assumes the app is BUILT and INSTALLED — `shells/tvos/scripts/build.sh device`
// then `xcrun devicectl device install app …`, or just leave the last capture's
// install in place. This does not build, deliberately: the thing under test is a
// lifecycle, and rebuilding here would make a green run mean "the build I just
// made is fine" rather than "what is on the television is fine".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { sh, resolveDestination, resolveDevicectlId, signingArgs, assertAwake } from './lib/tvos-device.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TVOS = path.join(ROOT, 'shells/tvos');
const BUNDLE_ID = 'com.couchgames.tinytrackparty';

/// Long enough for a cold boot to reach the attract scene on an A10X. The test
/// only needs the app to be RUNNING, but starting the cycle mid-boot would be
/// measuring the wrong thing.
const BOOT_SETTLE_MS = 30_000;

function running(deviceId) {
  const r = spawnSync('xcrun',
    ['devicectl', 'device', 'info', 'processes', '--device', deviceId],
    { encoding: 'utf8' });
  return /TinyTrackParty\.app\/TinyTrackParty/.test(r.stdout || '');
}

async function main() {
  const deviceId = resolveDevicectlId();
  const destination = resolveDestination();
  assertAwake(deviceId);
  console.log(`==> device ${deviceId}`);
  // A screensaver survives `assertAwake` — the backlight is on behind it — but
  // the launch and activate below dismiss it, and every frame this gate compares
  // is taken after that. Said out loud because one earlier run of a DIFFERENT
  // harness, which walked the Home screen instead of activating, photographed
  // ten frames of an aerial screensaver and reported them as the app.

  // A FRESH PROCESS, so the run does not inherit whatever state an earlier one
  // was left in — including, pointedly, an already-frozen surface.
  const procs = spawnSync('xcrun',
    ['devicectl', 'device', 'info', 'processes', '--device', deviceId], { encoding: 'utf8' });
  const pid = (procs.stdout || '').split('\n')
    .find((l) => l.includes('TinyTrackParty.app/TinyTrackParty'))?.trim().split(/\s+/)[0];
  if (pid) {
    console.log(`==> terminating pid ${pid}`);
    spawnSync('xcrun', ['devicectl', 'device', 'process', 'terminate',
                        '--device', deviceId, '--pid', pid], { encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log('==> launching');
  sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', deviceId, BUNDLE_ID]);
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  if (!running(deviceId)) {
    throw new Error('the app is not running after launch — nothing to test');
  }
  console.log('==> running the gate (Menu out, Select back, frame diff)');

  const r = spawnSync('xcrun', ['xcodebuild', 'test',
    '-project', path.join(TVOS, 'TinyTrackParty.xcodeproj'),
    '-scheme', 'TinyTrackParty',
    '-destination', destination,
    '-derivedDataPath', path.join(process.env.TMPDIR || '/tmp', 'ttp-dd-tvos-device'),
    '-only-testing:TinyTrackPartyShots/LifecycleTests',
    '-allowProvisioningUpdates',
    ...signingArgs()
  ], { encoding: 'utf8', cwd: TVOS });

  const out = `${r.stdout || ''}${r.stderr || ''}`;
  for (const line of out.split('\n')) {
    if (/Test Case .*(passed|failed)|error:/.test(line)) console.log(line.trim());
  }
  if (r.status !== 0) {
    console.error('\n==> FAILED. The surface stopped drawing across a Menu cycle, ' +
                  'or the app was not running. See the lines above.');
    process.exit(1);
  }
  console.log('==> ok — the surface survived a Menu cycle');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
