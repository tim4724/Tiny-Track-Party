// Freeze one screenshot per gallery scenario, from the WEB display, into
// public/assets/shots/web/ — the reference column /gallery-shots.html reads the
// tvOS ones against.
//
//   npm run shots:web
//   node scripts/capture-shots.mjs --only lobby,podium --headed
//
// WHY A FROZEN SHOT AT ALL, when /gallery.html already renders every one of these
// live in an iframe: because the second column cannot be live. A tvOS screen only
// exists as a photograph of an Apple TV, so the comparison has to be
// still-against-still or it is not a comparison. The live gallery keeps its job;
// this is a different surface with a different question ("has the TV drifted from
// the web?") and the same scenario table underneath, imported rather than copied
// (public/shared/galleryScenarios.js).
//
// THE READINESS WAIT IS THE WHOLE GAME. `capture-artwork.js` learned this: it
// waits on __scene/__engine and the car count and then document.fonts.ready,
// never on a bare timeout. A cold Filament shader compile behind a plain
// setTimeout produces a gallery of half-loaded scenes, and nobody notices for a
// week because every card still has a picture in it.
//
// WEBP, NOT PNG. The whole table across three platforms at 1080p PNG is tens of
// megabytes, which would undo the deliberate 170 -> 87 MB asset work; at 1280x720
// WebP q80 it is a few. Byte-exactness buys nothing here, because
// nothing diffs these programmatically: this is a human-judgement surface, and
// the automated half is coverage and freshness (tests/shots-manifest.test.js).

import path from 'node:path';
import fs from 'node:fs';

import { CAPTURED_SCENARIOS, scenarioQuery } from '../public/shared/galleryScenarios.js';
import { gitSha, mergeShots, shotDir } from './lib/shots.mjs';
import {
  ROOT, args as parseArgs, serveApp, launchBrowser, waitForScene, encode
} from './lib/capture.mjs';

const args = parseArgs();

// The capture viewport. 1920x1080 matches what the Apple TV's render server
// actually composites (devicectl reports TVOut 1920x1080 on the 4K box), so the
// two columns line up without a rescale in the page.
const WIDTH = parseInt(args.width, 10) || 1920;
const HEIGHT = parseInt(args.height, 10) || 1080;
// Stored at half that. Big enough to judge type and colour on a laptop, small
// enough that the whole gallery is a few MB.
const OUT_W = parseInt(args.outWidth, 10) || 1280;
const OUT_H = Math.round((OUT_W * HEIGHT) / WIDTH);
const PLAYERS = parseInt(args.players, 10) || 4;
// Animated scenarios need the race to develop past the start grid; still ones
// need only their first painted frame.
const SETTLE_MS = parseInt(args.settle, 10) || 2500;

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const scenarios = CAPTURED_SCENARIOS.filter((s) => !only || only.has(s.id));

async function main() {
  const dir = shotDir(ROOT, 'web');
  fs.mkdirSync(dir, { recursive: true });

  const server = await serveApp();
  let chrome;
  const entries = [];
  try {
    chrome = await launchBrowser({ headed: !!args.headed });
    const page = await chrome.page({ viewport: { width: WIDTH, height: HEIGHT } });

    const sha = gitSha(ROOT);
    for (const scenario of scenarios) {
      // dpr=1 IS LOAD-BEARING. Without it Stage.js sees `navigator.webdriver` and
      // renders the scene at a QUARTER of the layout size; capture.mjs's browser
      // also presents the page as an ordinary tab, which is what brings the sun's
      // shadow bake back. This gallery compares a browser against photographs of
      // real televisions, so a quarter-scale shadowless web column was not a
      // slightly worse picture — it was the wrong picture to judge the TVs by.
      const q = scenarioQuery(scenario, { players: PLAYERS });
      await page.goto(`http://127.0.0.1:${server.port}/?test=1&dpr=1&${q}`, { waitUntil: 'networkidle' });
      // Waits for the harness's scene signal and the self-hosted Fredoka face:
      // without the latter a shot can catch a system fallback and every label is
      // subtly the wrong shape.
      await waitForScene(page, { timeout: 20000 });
      // A scenario's own `settleMs` wins: it names WHICH MOMENT of that screen the
      // card is about, which for the two cup boards is after the re-sort has run.
      await page.waitForTimeout(scenario.settleMs ?? (scenario.animated ? SETTLE_MS : 400));

      const png = await page.screenshot();
      const webp = await encode(page, png, { width: OUT_W, height: OUT_H, type: 'image/webp', quality: 0.8 });
      const file = `${scenario.id}.webp`;
      fs.writeFileSync(path.join(dir, file), webp);
      entries.push({
        scenario: scenario.id,
        platform: 'web',
        file: `web/${file}`,
        w: OUT_W,
        h: OUT_H,
        bytes: webp.length,
        capturedAt: new Date().toISOString(),
        gitSha: sha
      });
      console.log(`  ${scenario.id.padEnd(14)} ${String(webp.length).padStart(7)} B`);
    }
  } finally {
    if (chrome) await chrome.close();
    server.close();
  }

  // Merge rather than replace: --only must not wipe the platforms and scenarios
  // this run did not touch.
  mergeShots(ROOT, 'web', entries);
  console.log(`==> ${entries.length} web shots -> public/assets/shots/web/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
