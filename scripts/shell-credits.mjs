// The attribution list a TV SHELL owes, out of the web's own credit data.
//
// A packaged app does not ship what a browser ships, and every shell has the
// same two-sided delta: some web credits are for code it does not contain, and
// it carries packages no web page ever loads. Everything except that delta is
// identical across shells, so it is implemented once here and the per-platform
// generators supply only their own half:
//
//   shells/tvos/scripts/gen-legal.mjs        -> Generated/Legal.swift
//   shells/androidtv/scripts/gen-legal.mjs   -> assets/legal/credits.json
//
// NOTHING HERE IS TYPED. The credits are `public/shared/credits.js` plus the
// live music catalogue — the same two modules /licenses.html renders — and the
// privacy/imprint URLs are read out of the display's own legal footer. A song
// added to a biome pool appears on every shell's board with nothing edited.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RACE_MUSIC } from '../public/display/audio/musicCatalogue.js';
import { creditsFor, licenseInfo } from '../public/shared/credits.js';

/// The repo root. Exported because the generators copy files out of the tree
/// and would otherwise each re-derive it from their own depth — one path,
/// spelled once.
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Credits for code the BROWSER runs and no packaged app does: the wasm
// toolchain (a shell compiles the same C++ natively) and the in-page QR encoder
// (every shell has a platform encoder). Matched on the title PREFIX, and a
// prefix that matches nothing is an error rather than a silent no-op, so
// renaming a credit cannot quietly re-add it to a TV.
export const WEB_ONLY = ['Emscripten', 'qrcode-generator'];

// The canonical text of a licence that obliges NO notice, one copy per licence
// id, so that every row on a TV board can be opened and read.
//
// **A TELEVISION CANNOT FOLLOW A LINK, and that is the whole reason these
// exist.** On /licenses.html each licence chip IS a link — to the entry's served
// notice where one is shipped, else to the canonical URL (`public/licenses.js`)
// — so a browser can always reach the terms. A TV has no browser, so a CC-BY or
// CC0 row named its licence and gave the room no way to read it. These are what
// that link becomes on a television.
//
// They are NOT notices in the sense credits.js means. A notice DISCHARGES a
// permissive licence and belongs to the WORK; these belong to the LICENCE and
// are shown as a courtesy. Nothing here dilutes that: the notice-tier gates in
// tests/credits.test.js and tests/androidtv-legal.test.js still key on `notice`.
const LICENSE_TEXTS = {
  'CC-BY 4.0': 'shells/licenses/CC-BY-4.0.txt',
  'CC0 1.0': 'shells/licenses/CC0-1.0.txt',
};

// Where each shared notice comes from in this tree, keyed by the file name a
// bundle will carry. credits.js states the notice as a SERVED URL (the web
// serves them out of public/), and a bundle has no origin to serve from, so the
// mapping from that name to a source path is here — one entry per notice the
// shared credits carry, and a notice with no source is an error.
export const SHARED_NOTICES = {
  'OFL-Fredoka.txt': 'public/assets/fonts/OFL-Fredoka.txt',
  'OFL-Nunito.txt': 'public/assets/fonts/OFL-Nunito.txt',
  'filament-LICENSE.txt': 'public/assets/licenses/filament-LICENSE.txt',
  'openlibm-LICENSE.md': 'public/assets/licenses/openlibm-LICENSE.md',
  'double-conversion-LICENSE.txt': 'public/assets/licenses/double-conversion-LICENSE.txt',
};

/// The privacy and imprint pages, read out of the display's legal footer so a TV
/// cannot link somewhere the web does not. Both are couchpad.games pages (legal
/// is central for every game on the launcher), which is exactly why a TV shows
/// them as QR codes: a phone can open them, a television cannot.
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

/// The list one shell's board renders: the shared credits minus what only the
/// browser ships, plus [platformOnly] — this package's own third-party code —
/// grouped as the web page groups them. Each entry keeps its section's position
/// in the shared order, and within a section the shared data's own order.
export function entries(platformOnly) {
  const groups = creditsFor(RACE_MUSIC);
  for (const prefix of WEB_ONLY) {
    if (!groups.some((g) => g.entries.some((e) => e.title.startsWith(prefix)))) {
      throw new Error(`WEB_ONLY names '${prefix}', which no shared credit matches any more`);
    }
  }
  const out = [];
  for (const group of groups) {
    const kept = group.entries.filter((e) => !WEB_ONLY.some((p) => e.title.startsWith(p)));
    const mine = platformOnly.filter((e) => e.section === group.section);
    for (const e of [...kept, ...mine]) {
      out.push({
        section: group.section,
        title: e.title,
        author: e.author,
        license: e.license,
        licenseURL: licenseURL(e.license, platformOnly),
        url: e.url,
        // WHAT THE ROW OPENS, as a file name in the bundle, and every row has
        // one. The notice where this build ships one — credits.js spells a
        // shared notice as a served URL, and a bundle carries the file itself
        // under its own name — else the licence's own text.
        text: textFor(e),
      });
    }
  }
  return out;
}

/// The file one credit's row opens: its notice where this build ships one, else
/// the text of the licence itself.
///
/// A credit that reaches the board with NEITHER is a row that cannot be opened,
/// which on these boards is a row that looks broken — so it throws here, at bake
/// time, rather than reaching a television.
function textFor(e) {
  if (e.notice) return path.basename(new URL(e.notice, 'https://x/').pathname);
  const own = LICENSE_TEXTS[e.license];
  if (own) return path.basename(own);
  throw new Error(`'${e.title}' is ${e.license}, which ships no notice and has no `
    + 'text in LICENSE_TEXTS — a row on the board with nothing behind it');
}

/// Every file a list's rows open, as bundle-name -> source path in the tree.
/// The staging step copies exactly this set: a shell's own notices are its
/// [platformNotices], the shared ones resolve out of [SHARED_NOTICES], and the
/// licence texts out of [LICENSE_TEXTS].
export function texts(list, platformNotices) {
  const wanted = new Set(list.map((e) => e.text));
  const byName = Object.fromEntries(
    Object.values(LICENSE_TEXTS).map((rel) => [path.basename(rel), rel]));
  const map = { ...SHARED_NOTICES, ...byName, ...platformNotices };
  const out = {};
  for (const name of wanted) {
    if (!map[name]) throw new Error(`no source for '${name}' — add it to SHARED_NOTICES`);
    out[name] = map[name];
  }
  return out;
}

/// The canonical text of a license, by id.
///
/// A license id the shared table does not know is one a shell invented, and an
/// invented license has no obligation attached to it — so the only ids that
/// resolve outside `credits.js` LICENSES are the ones a platform entry declares
/// itself, with `licenseURL` on the entry that uses it.
function licenseURL(id, platformOnly = []) {
  const own = platformOnly.find((e) => e.license === id && e.licenseURL);
  if (own) return own.licenseURL;
  return licenseInfo(id).url;
}
