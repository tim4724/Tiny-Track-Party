// Generate the AirConsole HTML entry points — public/display/screen.html and
// public/controller/controller.html — from the canonical index.html files.
// Both outputs are COMMITTED; tests/airconsole-html.test.js regenerates and
// compares, so an index.html edit that forgets to re-run this fails there.
//
// AirConsole loads screen.html / controller.html from the root of the
// uploaded zip inside www.airconsole.com iframes, with no server behind them:
// so paths turn relative (the dev server keeps them working by rewriting
// /screen.html → /display/screen.html while the browser URL stays at the
// root), the SDK loads from their CDN by pinned version, and the AC bootstrap
// (display-airconsole.js / controller-airconsole.js) slots in after the
// partyplug transport and before the module entry. Serve-time placeholders
// (__APP_V__ …) survive into the committed files — the dev server substitutes
// them as it does for index.html, and scripts/build-airconsole.sh bakes them
// for the zip.
//
// Usage: node scripts/gen-airconsole-html.mjs [--sdk-version 1.11.0]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const SDK_VERSION = '1.11.0';

export function generateAirconsoleHtml(sdkVersion = SDK_VERSION) {
  const sdkTag = `<script src="https://www.airconsole.com/api/airconsole-${sdkVersion}.js"></script>`;

  const transform = (html, bootstrap) => {
    html = html.replace('<body>', '<body class="airconsole">');

    // Strip what the AC iframe can never surface to the host browser: favicons
    // and home-screen icons belong to the top document, theme-color /
    // cp-accent-color are launcher-shell hints. Anchored on the TAG, not on
    // line isolation: the zip prunes assets/icon/ whole, so an icon reference
    // this regex missed after a head reflow would 404 only in the uploaded
    // build — the one surface nothing automated exercises.
    html = html.replace(/[ \t]*<link rel="(icon|apple-touch-icon)"[^>]*>\n?/g, '');
    html = html.replace(/[ \t]*<meta name="(theme-color|cp-accent-color)"[^>]*>\n?/g, '');

    // Absolute → relative in src/href, so the same file resolves from the zip
    // root and from the dev server's root-rewritten route.
    html = html.replace(/(src|href)="\/(?!\/)/g, '$1="');

    // The SDK, the kit's AC modules and the page bootstrap, straight after the
    // transport scripts (the bootstrap constructs `new AirConsole(...)` and
    // re-points the transport globals at load time, so it must follow both and
    // precede the deferred module entry — which any classic script does).
    const anchor = /(<script src="partyplug\/PartyFastlane\.js[^>]*><\/script>)/;
    if (!anchor.test(html)) throw new Error('gen-airconsole-html: PartyFastlane tag not found');
    html = html.replace(anchor, [
      '$1',
      `  ${sdkTag}`,
      '  <script src="partyplug/AirConsoleAdapter.js?v=__APP_V__"></script>',
      '  <script src="partyplug/AirConsoleStorage.js?v=__APP_V__"></script>',
      `  <script src="${bootstrap}?v=__APP_V__"></script>`
    ].join('\n'));

    return html;
  };

  return {
    screenHtml: transform(
      fs.readFileSync(path.join(PUBLIC, 'display', 'index.html'), 'utf8'),
      'display/display-airconsole.js'),
    controllerHtml: transform(
      fs.readFileSync(path.join(PUBLIC, 'controller', 'index.html'), 'utf8'),
      'controller/controller-airconsole.js')
  };
}

// Generate when run directly (imported by the freshness test otherwise).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argIdx = process.argv.indexOf('--sdk-version');
  const version = argIdx !== -1 ? process.argv[argIdx + 1] : SDK_VERSION;
  const { screenHtml, controllerHtml } = generateAirconsoleHtml(version);
  fs.writeFileSync(path.join(PUBLIC, 'display', 'screen.html'), screenHtml);
  fs.writeFileSync(path.join(PUBLIC, 'controller', 'controller.html'), controllerHtml);
  console.log(`Generated display/screen.html and controller/controller.html (SDK ${version})`);
}
