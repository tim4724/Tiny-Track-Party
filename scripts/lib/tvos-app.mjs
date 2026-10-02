// The app under test, on the Apple TV or the tvOS simulator: launch it, read the
// room it warms, and send it away and back the way a viewer does. Shared by
// `tvos-party-check.mjs` and `check-tvos-race-remote.mjs`.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';

import { resolveDevicectlId } from './tvos-device.mjs';

export const BUNDLE_ID = 'games.couchpad.tinytrack';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' });

/// Launch, and stream stdout to a file. The ROOM CODE is read back out of that
/// stream: a TV has no address bar, and reading the code off the screen with a
/// camera is not a thing a script can do.
export function launchApp(logPath, { sim = false } = {}) {
  rmSync(logPath, { force: true });
  const out = openSync(logPath, 'w');
  const argv = sim
    ? ['simctl', 'launch', '--console-pty', 'booted', BUNDLE_ID]
    : ['devicectl', 'device', 'process', 'launch', '--device', resolveDevicectlId(),
       '--console', '--terminate-existing', BUNDLE_ID];
  const child = spawn('xcrun', argv, { stdio: ['ignore', out, out] });
  child.unref();
  return child;
}

/// The LAST room code the app logged, optionally waiting for one that is not
/// `notThis`. The app prints every room it warms, so a resume appends a second
/// line to the same stream — matching the last rather than the first is what
/// lets one log serve the whole run.
export async function waitForRoom(logPath, timeout = 60000, notThis = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const all = [...readFileSync(logPath, 'utf8').matchAll(/\[ttp\] room ([A-Za-z0-9]+) — (\S+)/g)];
      const last = all[all.length - 1];
      if (last && (!notThis || last[1] !== notThis)) return { room: last[1], url: last[2] };
    }
    await sleep(500);
  }
  throw new Error(notThis ? 'the app never warmed a room other than ' + notThis
                          : 'the app never logged a room code');
}

/// Send the app to the background, the way a viewer pressing Home does.
///
/// BY LAUNCHING ANOTHER APP, because neither `devicectl` nor `simctl` can press
/// Home on a TV. Backgrounding is the case that matters and a force-kill is NOT
/// a substitute for it: SIGKILL runs no code at all, so it exercises the CRASH
/// path (where the room is supposed to survive and the next launch regathers it)
/// and would report the graceful teardown as broken no matter how well it works.
/// It is also how a check starts COLD: `launchApp`'s `--terminate-existing` is a
/// SIGKILL, so without this first the launch rejoins the previous party's room.
export function backgroundApp({ sim = false } = {}) {
  if (sim) { sh('xcrun', ['simctl', 'launch', 'booted', 'com.apple.TVSettings']); return; }
  sh('xcrun', ['devicectl', 'device', 'process', 'launch',
               '--device', resolveDevicectlId(), '--terminate-existing', 'com.apple.TVSettings']);
}

/// Bring the game back to the front WITHOUT `--terminate-existing`, so this is a
/// genuine resume of the suspended process rather than a cold launch. The
/// distinction is the whole point: a cold launch would exercise
/// `restoreRoom()`, and what needs proving is that coming back from a
/// backgrounded party warms a fresh room.
export function foregroundApp({ sim = false } = {}) {
  if (sim) { sh('xcrun', ['simctl', 'launch', 'booted', BUNDLE_ID]); return; }
  sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', resolveDevicectlId(), BUNDLE_ID]);
}
