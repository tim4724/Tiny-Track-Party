// Bake the info screen's legal data into Swift: the two couchpad.games links
// the QR cards encode, and the attribution list the Licenses board renders.
//
//   node shells/tvos/scripts/gen-legal.mjs      (called by stage-assets.sh)
//
// SINGLE-SOURCED, like gen-scenarios.mjs beside it. The credits are
// `public/shared/credits.js` + the live music catalogue — the same two modules
// the web's /licenses.html page renders — and the privacy/imprint URLs are read
// out of the display's own legal footer, which `tests/credits.test.js` already
// holds identical to the licenses page's. Nothing here is a second copy of a
// fact the web tree states.
//
// WHAT IS DECIDED HERE, and may not be anywhere else: the .ipa does not ship
// what the browser ships. Two web credits are for code this app does not
// contain, and two of its own packages have no web twin — that DELTA is the
// only thing this file adds to the shared data, and `tests/tvos-legal.test.js`
// fails if either half of it stops matching the tree.
//
// The output is BUILD OUTPUT (Generated/ is gitignored) and stage-assets.sh
// reruns it on every staging, so the Swift can never be staler than the last
// stage. The notice texts it names are staged next to it, into
// Generated/assets/licenses/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RACE_MUSIC } from '../../../public/display/audio/musicCatalogue.js';
import { creditsFor, licenseInfo } from '../../../public/shared/credits.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const OUT = path.join(HERE, '..', 'Generated', 'Legal.swift');

// Credits for code the browser runs and this app does not: the wasm toolchain
// (tvOS compiles the same C++ natively, through Xcode's clang) and the in-page
// QR encoder (Core Image draws the join code here — `Screens/QRCode.swift`).
// Matched on the title PREFIX, and a prefix that matches nothing is an error
// rather than a silent no-op, so renaming a credit cannot quietly re-add it.
export const WEB_ONLY = ['Emscripten', 'qrcode-generator'];

// The .ipa's own third-party code, which no web page credits because the
// browser provides both: WebRTC (tvOS ships none, and the fastlane needs one)
// and the SVG rasterizer for the shared item icons. `notice` names a file under
// TinyTrackParty/Resources/Licenses — see the SOURCES.md there for provenance.
export const TVOS_ONLY = [
  {
    section: 'Software',
    title: 'LiveKit WebRTC (the input fastlane)',
    author: 'The WebRTC project authors',
    license: 'BSD-3-Clause',
    url: 'https://github.com/livekit/webrtc-xcframework',
    notice: 'LiveKitWebRTC-LICENSE.txt',
  },
  {
    section: 'Software',
    title: 'SwiftDraw (draws the item icons)',
    author: 'Simon Whitty',
    license: 'zlib',
    url: 'https://github.com/swhitty/SwiftDraw',
    notice: 'SwiftDraw-LICENSE.txt',
  },
];

// Where each shared notice comes from in this tree, keyed by the file name the
// bundle will carry. credits.js states the notice as a SERVED URL (the web
// serves them out of public/), and a bundle has no origin to serve from, so the
// mapping from that name to a source path is here — one entry per notice the
// shared credits carry, and the test fails on a notice with no source.
export const SHARED_NOTICES = {
  'OFL-Fredoka.txt': 'public/assets/fonts/OFL-Fredoka.txt',
  'OFL-Nunito.txt': 'public/assets/fonts/OFL-Nunito.txt',
  'filament-LICENSE.txt': 'public/assets/licenses/filament-LICENSE.txt',
  'openlibm-LICENSE.md': 'public/assets/licenses/openlibm-LICENSE.md',
  'double-conversion-LICENSE.txt': 'public/assets/licenses/double-conversion-LICENSE.txt',
};

export const TVOS_NOTICES = Object.fromEntries(
  TVOS_ONLY.filter((e) => e.notice)
    .map((e) => [e.notice, `shells/tvos/TinyTrackParty/Resources/Licenses/${e.notice}`]));

/// Where each of those two texts was copied FROM, inside SwiftPM's checkout of
/// the pinned version (paths relative to a `SourcePackages` directory). Machine
/// readable so `tests/tvos-legal.test.js` can diff the committed copy against
/// the package that is actually resolved, and catch the one drift SOURCES.md can
/// only ask for in prose: a version bump whose license text moved.
///
/// SwiftPM checks packages out under DerivedData, so this check can only run on
/// a machine that has built the app — it skips where it cannot look, which is
/// why it is a safety net and not the obligation itself.
export const TVOS_NOTICE_UPSTREAM = {
  'SwiftDraw-LICENSE.txt': 'checkouts/SwiftDraw/LICENSE.txt',
  'LiveKitWebRTC-LICENSE.txt':
    'artifacts/webrtc-xcframework/LiveKitWebRTC/LiveKitWebRTC.xcframework/LICENSE',
};

/// The privacy and imprint pages, read out of the display's legal footer so the
/// TV cannot link somewhere the web does not. Both are couchpad.games pages
/// (legal is central for every game on the launcher), which is exactly why the
/// TV shows a QR: a phone can open them, a television cannot.
export function legalLinks() {
  const html = fs.readFileSync(path.join(ROOT, 'public/display/index.html'), 'utf8');
  const foot = /<footer class="site-foot[^"]*">([\s\S]*?)<\/footer>/.exec(html);
  if (!foot) throw new Error('public/display/index.html has no .site-foot footer to read');
  const href = (page) => {
    const m = new RegExp(`href="(https://couchpad\\.games/[^"]*${page})"`).exec(foot[1]);
    if (!m) throw new Error(`the display footer no longer links ${page}`);
    return m[1];
  };
  return { privacy: href('privacy'), imprint: href('imprint') };
}

/// The list the Licenses board renders: the shared credits minus what only the
/// browser ships, plus what only the .ipa does, grouped as the web page groups
/// them. Each entry keeps its section's position in the shared order.
export function entries() {
  const groups = creditsFor(RACE_MUSIC);
  for (const prefix of WEB_ONLY) {
    if (!groups.some((g) => g.entries.some((e) => e.title.startsWith(prefix)))) {
      throw new Error(`WEB_ONLY names '${prefix}', which no shared credit matches any more`);
    }
  }
  const out = [];
  for (const group of groups) {
    const kept = group.entries.filter((e) => !WEB_ONLY.some((p) => e.title.startsWith(p)));
    const mine = TVOS_ONLY.filter((e) => e.section === group.section);
    for (const e of [...kept, ...mine]) {
      out.push({
        section: group.section,
        title: e.title,
        author: e.author,
        license: e.license,
        url: e.url,
        // credits.js spells a shared notice as a served URL; the bundle carries
        // the file itself, under its own name.
        notice: e.notice ? path.basename(new URL(e.notice, 'https://x/').pathname) : null,
      });
    }
  }
  return out;
}

/// Every notice file the list names, as bundle-name -> source path in the tree.
/// stage-assets.sh copies exactly this set into Generated/assets/licenses.
export function notices() {
  const wanted = new Set(entries().map((e) => e.notice).filter(Boolean));
  const map = { ...SHARED_NOTICES, ...TVOS_NOTICES };
  const out = {};
  for (const name of wanted) {
    if (!map[name]) throw new Error(`no source for notice '${name}' — add it to SHARED_NOTICES`);
    out[name] = map[name];
  }
  return out;
}

/// A license id the shared table does not know is one this file invented, and
/// an invented license has no obligation attached to it. zlib is the tvOS-only
/// one; anything else has to be added to credits.js LICENSES where the web can
/// see it too.
const LICENSE_URLS = { zlib: 'https://zlib.net/zlib_license.html' };
function licenseURL(id) {
  if (LICENSE_URLS[id]) return LICENSE_URLS[id];
  return licenseInfo(id).url;
}

const swiftString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function source() {
  const links = legalLinks();
  const rows = entries().map((e) => '        .init(section: ' + swiftString(e.section)
    + ', title: ' + swiftString(e.title)
    + ', author: ' + swiftString(e.author)
    + ', license: ' + swiftString(e.license)
    + ', licenseURL: ' + swiftString(licenseURL(e.license))
    + ', url: ' + swiftString(e.url)
    + ', notice: ' + (e.notice ? swiftString(e.notice) : 'nil') + ')').join(',\n');

  return `// GENERATED by shells/tvos/scripts/gen-legal.mjs — do not edit.
//
// The info screen's legal data: the couchpad.games pages the QR cards encode
// (read from the web display's own legal footer) and the attribution list, from
// public/shared/credits.js + the live music catalogue, adjusted for what this
// bundle actually contains. See the generator's header for that delta.

enum Legal {

    /// The two central legal pages. They are couchpad.games's, not this game's,
    /// and a TV cannot open either — which is why the info board shows them as
    /// QR codes for the phone the player is already holding.
    static let privacyURL = ${swiftString(links.privacy)}
    static let imprintURL = ${swiftString(links.imprint)}

    /// One credited work. \`notice\` is the license text this build SHIPS for it,
    /// as a file name under \`assets/licenses\` in the bundle; entries without one
    /// are under a license that demands no notice travel (CC0, CC-BY), and their
    /// row states its terms rather than drilling into a text.
    struct Entry: Identifiable, Hashable {
        let section: String
        let title: String
        let author: String
        let license: String
        let licenseURL: String
        let url: String
        let notice: String?

        var id: String { section + "/" + title }
    }

    static let entries: [Entry] = [
${rows}
    ]
}
`;
}

// Importable (tests/tvos-legal.test.js reads the same data) and runnable.
//
// It copies the notice texts itself rather than leaving a list for
// stage-assets.sh to repeat: the set is exactly what `notices()` derives from
// the entries, so a credit that gains or loses a notice cannot leave the bundle
// carrying the wrong files.
// `pathToFileURL` rather than a `file://` template: a URL percent-encodes, so a
// checkout under a path with a space (or any non-ASCII) never matches the
// hand-built string — and the failure is that this writes NOTHING, leaving the
// last stage's Legal.swift in place. This tree is worked in many worktrees at
// once, so their names are not something to bet on.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, source());

  const dest = path.join(HERE, '..', 'Generated', 'assets', 'licenses');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const staged = notices();
  for (const [name, src] of Object.entries(staged)) {
    fs.copyFileSync(path.join(ROOT, src), path.join(dest, name));
  }
  console.log(`==> ${entries().length} credits, ${Object.keys(staged).length} notices`
    + ' -> Generated/Legal.swift + assets/licenses');
}
