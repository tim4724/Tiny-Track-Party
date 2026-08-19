// Finding the Apple TV, and the identity to sign for it.
//
// Extracted because there are now two callers — the gallery capture
// (`capture-shots-tvos.mjs`) and the lifecycle gate
// (`check-tvos-lifecycle.mjs`) — and both halves are the kind of thing that is
// only ever debugged once. The device lookup in particular carries two findings
// that a second copy would rediscover the hard way: `devicectl` reports a
// different UUID than `xcodebuild` accepts, and the State column moves between
// "available (paired)" and "connected" depending on whether a tunnel is up.

import { spawnSync, execFileSync } from 'node:child_process';

export function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/// The first available tvOS simulator, or the first paired Apple TV. An explicit
/// `device` (a UDID) wins.
export function resolveDestination({ sim = false, device } = {}) {
  if (typeof device === 'string') {
    return sim ? `platform=tvOS Simulator,id=${device}` : `platform=tvOS,id=${device}`;
  }
  if (sim) {
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
  // only one of them makes this fail with "no paired Apple TV" while the TV is
  // sitting right there.
  const line = out.split('\n').find((l) => /Apple TV/.test(l) && /available|connected/.test(l));
  if (!line) throw new Error('no paired Apple TV — pair one in Xcode, or pass --device <udid>');

  // MATCH BY NAME, because the two tools do not agree on anything else.
  // `devicectl` names the MODEL ("Apple TV 4K (AppleTV6,2)") in its own column;
  // `xctrace` lists a physical device by the name its owner gave it and never
  // prints "Apple TV" for it at all. This used to be an `/Apple TV|Spielzimmer/`
  // alternation, which worked on exactly one person's television.
  const name = line.trim().split(/\s{2,}/)[0];

  // The 40-hex identifier xcodebuild wants is the last column of `xctrace list
  // devices`; devicectl prints its own UUID, which xcodebuild does NOT accept.
  // The hex length also excludes the simulators, whose ids are dashed UUIDs.
  const trace = sh('xcrun', ['xctrace', 'list', 'devices']);
  const m = trace.split('\n').find((l) => l.includes(name) && /\([0-9a-f]{40}\)/.test(l));
  const udid = m && m.match(/\(([0-9a-f]{40})\)/)?.[1];
  if (!udid) {
    throw new Error(`could not find "${name}" with a device UDID in \`xctrace list devices\``);
  }
  return `platform=tvOS,id=${udid}`;
}

/// Refuse to drive a television that is asleep.
///
/// WHAT THIS CATCHES AND WHAT IT DOES NOT. A dark panel composites black, so
/// every screenshot comes back identical and a gallery fills with black
/// rectangles. That is caught. A SCREENSAVER is not: the backlight is "on and
/// active" behind it, and the aerial ones are video, so frames keep changing and
/// a frame-diff check would pass on footage of Los Angeles. Bringing an app to
/// the foreground dismisses it, which is why the lifecycle gate activates before
/// it photographs anything — but a caller that walks the Home screen instead has
/// no such protection, and one run of that did photograph the screensaver.
export function assertAwake(deviceId) {
  let asleep = false;
  try {
    const out = sh('xcrun',
      ['devicectl', 'device', 'info', 'displays', '--device', deviceId]);
    asleep = /backlight is off|backlightState"\s*:\s*"(?!activeOn)/.test(out);
  } catch {
    // Failing to READ the display state is not evidence of sleep, and not a
    // reason to refuse; only a confirmed off backlight is.
  }
  if (asleep) {
    // NOT ACTIONABLE OVER devicectl, and saying so is the whole point of this
    // message. Launching an app does not turn a television on: the process
    // starts, the backlight stays off, and the run photographs black or
    // measures a compositor with nothing to composite. There is no wake verb
    // for a paired Apple TV, so the only fix is at the panel — which is a
    // sentence, not a discovery someone should have to make twice.
    throw new Error(
      'the Apple TV reports its backlight is off, and nothing here can wake it '
      + '(launching the app does not turn the television on). Switch the set on '
      + '— and its input to the Apple TV — then re-run. Use --sim to measure '
      + 'without a television at all.');
  }
}

/// `devicectl`'s own UUID for the paired Apple TV — the one its `device …`
/// verbs take, which is NOT the identifier `xcodebuild -destination` wants.
export function resolveDevicectlId() {
  const out = sh('xcrun', ['devicectl', 'list', 'devices']);
  const line = out.split('\n').find((l) => /Apple TV/.test(l) && /available|connected/.test(l));
  const id = line && line.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/)?.[1];
  if (!id) throw new Error('no paired Apple TV — pair one in Xcode');
  return id;
}

/// The team id is the OU field of the keychain's Apple Development certificate,
/// so any machine that can sign at all can answer it. `TTP_DEVELOPMENT_TEAM`
/// overrides, for a keychain holding several.
export function developmentTeam() {
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

/// The signing arguments an `xcodebuild` invocation needs. The simulator runs
/// unsigned, and asking it to sign only invents a reason to fail on a machine
/// with no certificate.
export function signingArgs({ sim = false } = {}) {
  if (sim) return ['CODE_SIGNING_ALLOWED=NO'];
  const team = developmentTeam();
  if (!team) {
    throw new Error(
      'no Apple Development certificate found — a device run has to sign.\n' +
      '  Set TTP_DEVELOPMENT_TEAM=<team id>, or run with --sim.');
  }
  return [`DEVELOPMENT_TEAM=${team}`, 'CODE_SIGNING_ALLOWED=YES'];
}
