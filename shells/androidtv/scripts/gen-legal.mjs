// Stage the info board's legal data into the APK: the two couchpad.games links
// the QR cards encode, and the attribution list the Licenses board renders.
//
//   node shells/androidtv/scripts/gen-legal.mjs      (called by stage-assets.sh)
//
// SINGLE-SOURCED. The list is built by `scripts/shell-credits.mjs` out of
// `public/shared/credits.js` + the live music catalogue — the same two modules
// the web's /licenses.html page renders — and the privacy/imprint URLs are read
// out of the display's own legal footer. Nothing here is a second copy of a fact
// the web tree states.
//
// WHAT IS DECIDED HERE, and may not be anywhere else: the .apk does not ship
// what the browser ships. The shared module drops the two web-only credits; the
// packages that are this APK's ALONE are below, and that half of the DELTA is
// the only thing this file adds. `tests/androidtv-legal.test.js` fails if either
// stops matching the tree.
//
// DATA, NOT GENERATED KOTLIN, which is where this parts company with the tvOS
// twin. That one bakes a Swift file because a bundle's Swift is compiled from
// the same directory it stages into; here `assets/` is already how this shell
// reads everything it did not type (design-tokens.json, the cue manifest, the
// fonts), and a generated .kt would need a source set of its own in Gradle to
// buy nothing. `Legal.kt` reads what this writes.
//
// The output is BUILD OUTPUT (app/src/main/assets/ is gitignored) and
// stage-assets.sh reruns it on every staging, so the data can never be staler
// than the last stage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as shared from '../../../scripts/shell-credits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const OUT = path.join(HERE, '..', 'app', 'src', 'main', 'assets', 'legal');

// Re-exported so the gate reads one module: what a browser ships and this does
// not, and where a shared notice comes from, are both the shared module's.
export const { WEB_ONLY, SHARED_NOTICES, legalLinks } = shared;

// The APK's own third-party code, which no web page credits because the browser
// provides all of it: a socket, a QR encoder, a widget toolkit and a standard
// library. Every one of them is Apache-2.0 and every one is REDISTRIBUTED — it
// is inside the .apk a viewer installs, unlike the Android framework itself,
// which is the device's.
//
// `covers` is the Gradle coordinate PREFIX each credit accounts for, and it is
// what stops this list going stale: `tests/androidtv-legal.test.js` fails on a
// declared dependency that no credit covers. Kotlin's standard library is the
// one entry with no declaration to match — AGP puts it on the classpath itself —
// which is exactly why it is the one that would otherwise be forgotten.
//
// `notice` names a file under shells/androidtv/licenses — see the SOURCES.md
// there for provenance, and for why three texts cover four credits.
export const ANDROID_ONLY = [
  {
    section: 'Software',
    title: 'OkHttp and Okio (the relay socket)',
    author: 'Square, Inc.',
    license: 'Apache-2.0',
    url: 'https://square.github.io/okhttp/',
    covers: ['com.squareup.okhttp3:', 'com.squareup.okio:'],
    notice: 'apache-2.0-LICENSE.txt',
  },
  {
    section: 'Software',
    // The SAME LIBRARY tvOS credits as "LiveKit WebRTC", and deliberately worded
    // to say so: two shells link two builds of one upstream, and its notice is
    // the same 1511 bytes on both. What ships here is a prebuilt libwebrtc per
    // ABI — by far the largest thing in the APK — and the AAR carries no license
    // file of its own, so reproducing the notice is entirely ours to do.
    title: 'WebRTC (the input fastlane)',
    author: 'The WebRTC project authors',
    license: 'BSD-3-Clause',
    url: 'https://github.com/webrtc-sdk/android',
    covers: ['io.github.webrtc-sdk:'],
    notice: 'webrtc-LICENSE.txt',
  },
  {
    section: 'Software',
    title: 'ZXing (the join-code QR)',
    author: 'The ZXing authors',
    license: 'Apache-2.0',
    url: 'https://github.com/zxing/zxing',
    covers: ['com.google.zxing:'],
    notice: 'zxing-LICENSE.txt',
  },
  {
    section: 'Software',
    title: 'AndroidX and Jetpack Compose (the boards)',
    author: 'The Android Open Source Project',
    license: 'Apache-2.0',
    url: 'https://developer.android.com/jetpack/androidx',
    covers: ['androidx.'],
    notice: 'androidx-LICENSE.txt',
  },
  {
    section: 'Software',
    title: 'Kotlin standard library',
    author: 'JetBrains s.r.o. and contributors',
    license: 'Apache-2.0',
    url: 'https://github.com/JetBrains/kotlin',
    covers: ['org.jetbrains.kotlin:'],
    notice: 'apache-2.0-LICENSE.txt',
  },
];

export const ANDROID_NOTICES = Object.fromEntries(
  ANDROID_ONLY.filter((e) => e.notice)
    .map((e) => [e.notice, `shells/androidtv/licenses/${e.notice}`]));

/// The list the Licenses board renders.
export const entries = () => shared.entries(ANDROID_ONLY);

/// Every notice file that list names, as asset-name -> source path in the tree.
/// The stage below copies exactly this set into assets/legal/.
export const notices = () => shared.notices(entries(), ANDROID_NOTICES);

/// Every Gradle coordinate `app/build.gradle.kts` declares, as `group:artifact`.
///
/// THE DEPENDENCIES BLOCK IS THE REGISTRY, the way `project.yml`'s packages
/// block is on tvOS: a line added there ships in the APK, and shipping it
/// uncredited is what the gate catches. The BOM is skipped because it carries no
/// code — it is a version table — and a versionless `implementation("group:art")`
/// is one the BOM pins, which is still a real artifact in the APK.
export function gradleDependencies() {
  const kts = fs.readFileSync(path.join(HERE, '..', 'app', 'build.gradle.kts'), 'utf8');
  const block = /\ndependencies\s*\{\n([\s\S]*?)\n\}/.exec(kts);
  if (!block) throw new Error('app/build.gradle.kts has no dependencies { } block to read');
  return [...block[1].matchAll(/implementation\("([^":]+):([^":]+)(?::[^"]+)?"\)/g)]
    .map((m) => `${m[1]}:${m[2]}`);
}

/// The board's data, as the one JSON `Legal.kt` reads.
export function document() {
  const links = legalLinks();
  return {
    privacyUrl: links.privacy,
    imprintUrl: links.imprint,
    // `notice` is the license text this build SHIPS for an entry, as a file name
    // under assets/legal; entries without one are under a license that demands
    // no notice travel (CC0, CC-BY), and their row states its terms rather than
    // drilling into a text.
    entries: entries().map((e) => ({
      section: e.section,
      title: e.title,
      author: e.author,
      license: e.license,
      licenseUrl: e.licenseURL,
      url: e.url,
      notice: e.notice,
    })),
  };
}

// Importable (tests/androidtv-legal.test.js reads the same data) and runnable.
//
// It copies the notice texts itself rather than leaving a list for
// stage-assets.sh to repeat: the set is exactly what `notices()` derives from
// the entries, so a credit that gains or loses a notice cannot leave the APK
// carrying the wrong files. `pathToFileURL` rather than a `file://` template,
// for the reason the tvOS twin gives — a worktree path with a space in it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'credits.json'), `${JSON.stringify(document(), null, 2)}\n`);
  const staged = notices();
  for (const [name, src] of Object.entries(staged)) {
    fs.copyFileSync(path.join(ROOT, src), path.join(OUT, name));
  }
  console.log(`==> ${entries().length} credits, ${Object.keys(staged).length} notices`
    + ' -> assets/legal');
}
