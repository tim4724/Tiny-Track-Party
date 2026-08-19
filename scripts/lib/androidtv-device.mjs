// Finding the Android TV box to drive.
//
// Extracted because there are now two callers — the bench's Android backend
// (`perf-race.android.mjs`) and the party check (`androidtv-party-check.mjs`).
// Matched on the PROPERTY rather than on a model name: a phone plugged in
// beside the box is the ordinary case on a developer's desk, and installing a
// leanback-only APK on it fails in a way that reads as an app bug. An AVD
// deliberately does NOT match — its `ro.build.characteristics` says
// `emulator`, not `tv` — which is why `capture-shots-androidtv.mjs` keeps its
// own resolver with a separate `--emu` rule.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const ADB = process.env.ADB
  || join(process.env.HOME ?? '', 'Library/Android/sdk/platform-tools/adb');

/**
 * The attached adb device whose `ro.build.characteristics` says `tv`. An
 * explicit serial (a `--serial` flag, or `TTP_SERIAL`) wins unchecked; zero or
 * several TV candidates is an error rather than a guess.
 */
export function findTvDevice(override = null) {
  const serial = override || process.env.TTP_SERIAL;
  if (serial) return serial;
  const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' })
    .split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[1] === 'device')
    .map((c) => c[0]);
  const tvs = attached.filter((id) =>
    /\btv\b/.test(execFileSync(ADB, ['-s', id, 'shell', 'getprop', 'ro.build.characteristics'],
      { encoding: 'utf8' })));
  if (!tvs.length) {
    throw new Error('no Android TV device attached — `adb devices`, and pass --serial'
      + ' (or TTP_SERIAL) if it is not a TV build');
  }
  if (tvs.length > 1) {
    throw new Error(`several Android TV devices attached (${tvs.join(', ')})`
      + ' — pass --serial (or TTP_SERIAL)');
  }
  return tvs[0];
}
