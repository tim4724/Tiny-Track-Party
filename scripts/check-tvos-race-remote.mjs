// The remote on a LIVE race, on the paired Apple TV, in one command.
//
//   npm run check:tvos-race-remote
//
// Menu and Play/Pause on a live race must pause and resume it. `RaceRemoteTests`
// presses them, but it cannot start the race: a scenario race is relay-less and
// its room never leaves the lobby, so the pause walk would refuse it. So this
// launches the app, joins two phones over the real relay, starts a real race,
// and only then hands the running app to `xcodebuild test`. The phones then
// say whether the pause reached the room and the party survived the resume: a
// Menu that reached tvOS backgrounds the app, and `suspend()` closes the room
// under them.
//
// Assumes the app is BUILT and INSTALLED — `npm run build:tvos device` builds
// it, then `xcrun devicectl device install app …` — exactly like
// check:tvos-lifecycle. This does not build, for the reason that one gives.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { Phone, loadProtocol } from './lib/phone.mjs';
import { resolveDestination, resolveDevicectlId, signingArgs, assertAwake } from './lib/tvos-device.mjs';
import { sleep, launchApp, waitForRoom, backgroundApp } from './lib/tvos-app.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TVOS = path.join(ROOT, 'shells/tvos');

async function main() {
  const destination = resolveDestination();
  assertAwake(resolveDevicectlId());
  const proto = await loadProtocol();

  backgroundApp();   // so the launch is a cold boot into a fresh room
  await sleep(2500);
  const logPath = path.join(tmpdir(), 'ttp-race-remote.log');
  launchApp(logPath);
  const { room } = await waitForRoom(logPath);
  console.log(`==> room ${room}`);

  const alice = new Phone(proto, { name: 'Alice' });
  await alice.join(room);
  alice.hello();
  await alice.waitFor(() => alice.seat != null, 'our seat');
  const bob = new Phone(proto, { name: 'Bob' });
  await bob.join(room);
  bob.hello();
  await bob.waitFor(() => bob.seat != null, "Bob's seat");
  const track = (alice.snapshot.tracks || [])[0];
  if (!track) throw new Error('the snapshot carries no tracks to race');
  alice.selectMode({ mode: 'cup', cupId: track.cup });
  await alice.waitFor(() => alice.snapshot.cupId === track.cup, 'the cup pick');
  bob.setReady(true);
  await bob.waitFor(() => bob.seat?.ready === true, 'the ready flag');
  alice.startGame();
  await alice.waitFor(() => alice.snapshot.roomState === 'playing', 'GO', 60000);
  console.log('==> racing; pressing the remote');

  // NOT spawnSync. A blocked event loop is a dead phone: it cannot answer the
  // relay's keepalive pings (the relay drops it after `idleTimeoutMs`,
  // tests/wire-compat/relay-contract.json) or read
  // a frame, so anything asserted from it afterwards is the state from BEFORE
  // the presses. Sampled while the test runs, the phones also prove the pause
  // reached the room, not just the overlay.
  let sawPaused = false;
  const sampler = setInterval(() => { if (alice.snapshot.paused) sawPaused = true; }, 100);
  const test = spawn('xcrun', ['xcodebuild', 'test',
    '-project', path.join(TVOS, 'TinyTrackParty.xcodeproj'),
    '-scheme', 'TinyTrackParty',
    '-destination', destination,
    // Per-worktree, for the reason check-tvos-lifecycle gives.
    '-derivedDataPath', path.join(process.env.TMPDIR || '/tmp',
      `ttp-dd-tvos-device-${createHash('sha256').update(TVOS).digest('hex').slice(0, 12)}`),
    '-only-testing:TinyTrackPartyShots/RaceRemoteTests',
    '-allowProvisioningUpdates',
    ...signingArgs()
  ], { cwd: TVOS });
  let log = '';
  test.stdout.on('data', (d) => { log += d; });
  test.stderr.on('data', (d) => { log += d; });
  const status = await new Promise((res) => {
    test.on('error', (e) => { console.error(`xcodebuild did not start: ${e.message}`); res(-1); });
    test.on('close', res);
  });
  await sleep(2000);   // let the last resume reach the phones
  clearInterval(sampler);
  for (const line of log.split('\n')) {
    if (/Test Case .*(passed|failed)|error:/.test(line)) console.log(line.trim());
  }

  // The phones' half: the presses paused the room, and it is racing again.
  const s = alice.snapshot;
  const survived = alice.closed == null && s.roomState === 'playing' && s.paused === false;
  console.log(`==> phones: saw paused=${sawPaused}; now closed=${JSON.stringify(alice.closed)}, ` +
              `roomState=${s.roomState}, paused=${s.paused}`);
  alice.close();
  bob.close();
  if (status !== 0 || !sawPaused || !survived) {
    console.error('==> FAILED');
    process.exit(1);
  }
  console.log('==> ok — Menu and Play/Pause pause and resume a live race');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
