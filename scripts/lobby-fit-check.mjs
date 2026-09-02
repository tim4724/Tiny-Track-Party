// Runs against the REAL controller page now that the relayout has shipped into
// controller.css. "Bigger text if space allows" needs a limit that is checked
// rather than eyeballed: this walks every element in the lobby at every landscape
// viewport below and reports anything outside its own box, plus how close the
// cup names are to being clipped and whether the two halves are still in order.
//
// The cup-name reading is VERTICAL. The names wrap to two lines and then
// ellipsise (controller.css .mode-opt__name), so a name can no longer outgrow
// its width — the horizontal slack this used to print would pass whatever it
// was handed. What can still go wrong is a third line, so what is measured is
// the lines left before the clamp bites.
//
// It stands up its OWN server on an allocated port (capture.mjs, whose header
// explains the port trap this tree keeps stepping in). It used to hardcode one
// and leave you to start the server by hand: two worktrees running it at once
// measured each other's pages, and running it with nothing on that port died in
// an unhandled rejection rather than saying what was missing.
//
// THE VIEWPORTS ARE THE COVERAGE. The short pair is not decoration: the tall
// pair alone is what let a car strip whose rows demanded ~340px of a ~250px
// column ship, since the spill check below would have named it on the first run
// at a real height. A phone's landscape height is its SHORT side minus browser
// chrome — under 300px with the bar up, where a dev window leaves 390+.
import { serveApp, launchBrowser } from './lib/capture.mjs';

const VIEWPORTS = [
  ['iphone14', 844, 390],   // the shell, or a browser with its bar retracted
  ['se', 667, 375],
  ['iphone14-bar', 844, 300], // …and the same two with the browser bar up
  ['se-bar', 667, 280],
  // The floor of the whole set: a Z Fold cover screen (280x653) turned
  // landscape with the browser bar up. It is offered in the phone gallery and
  // was in no sweep, which is how the track-tile cap's dvh term got to go
  // NEGATIVE there — four 10px slivers with their schematics spilling 100px off
  // the page. Nothing above 232px could see it.
  ['zfold-bar', 653, 232]
];

const app = await serveApp();
// realUser: false — this measures the DOM, not pixels, so the automation path
// (scripts/CLAUDE.md) is the right one and is what the page will be under in
// E2E anyway. What the seam is really here for is `page`'s pageerror relay: a
// script throwing on the controller left this reporting a tidy "clean" over a
// lobby that had not finished rendering.
const b = await launchBrowser({ realUser: false });
let bad = 0;
for (const [label, w, h] of VIEWPORTS) {
  const p = await b.page({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  for (const s of ['lobby-host', 'lobby-race', 'lobby-race-waiting', 'lobby-waiting', 'lobby-race-locked']) {
    await p.goto(`http://127.0.0.1:${app.port}/controller/index.html?scenario=${s}&color=0`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(900);
    const found = await p.evaluate(() => {
      const out = [];
      const vw = innerWidth, vh = innerHeight;
      for (const e of document.querySelectorAll('#lobby *')) {
        const r = e.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const cls = e.className && e.className.baseVal === undefined ? e.className : '';
        // any element wider than its own box: ellipsised labels AND plain
        // overflow (a stat label that has outgrown its grid column shows up
        // here, and has no ellipsis to make it obvious on screen)
        if (e.scrollWidth > e.clientWidth + 1) {
          out.push(['OVERFLOW', cls, (e.textContent || '').trim().slice(0, 28), e.scrollWidth + '>' + e.clientWidth]);
        }
        if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
          out.push(['SPILL', cls, (e.textContent || '').trim().slice(0, 28),
            `l${Math.round(r.left)} t${Math.round(r.top)} r${Math.round(r.right)} b${Math.round(r.bottom)}`]);
        }
      }
      // The action corner is centred rather than inset, so nothing in the layout
      // keeps it off the latency chip's bottom-right home — this does. The chip
      // only appears once a reading lands, so force it visible to measure.
      const chip = document.getElementById('latency');
      chip.classList.remove('hidden');
      for (const btn of document.querySelectorAll('.lobby-go .btn')) {
        if (btn.classList.contains('hidden')) continue;
        const a = chip.getBoundingClientRect(), b = btn.getBoundingClientRect();
        const clear = Math.round(a.left - b.right);
        if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) {
          out.push(['CORNER/CHIP', btn.id, btn.textContent.trim().slice(0, 20), `overlap ${-clear}px`]);
        }
      }
      // The choices track must never be the WIDER half: the card is what the
      // page is about, and a picker that outgrows it inverts the page. One
      // declaration feeds both lobby pages, so this reads on all four scenarios.
      const cols = getComputedStyle(document.getElementById('lobby'))
        .gridTemplateColumns.split(' ').map((x) => parseFloat(x));
      if (cols.length === 2 && cols[1] < cols[0]) {
        out.push(['SIDES', 'lobby', 'choices wider than the card',
          `${Math.round(cols[0])} > ${Math.round(cols[1])}`]);
      }
      // Cup names clamp at two lines. What is worth printing is how many lines
      // the longest name actually takes — 2 means the clamp is the only thing
      // left between it and a clip, which is the state to notice before a cup
      // named later crosses it. A real clip is reported outright.
      const tight = [...document.querySelectorAll('.mode-opt__name')].map((e) => {
        if (e.scrollHeight > e.clientHeight + 1) {
          out.push(['CLIPPED', 'mode-opt__name', (e.textContent || '').trim().slice(0, 28),
            `${e.scrollHeight}>${e.clientHeight}`]);
        }
        return Math.round(e.scrollHeight / parseFloat(getComputedStyle(e).lineHeight));
      });
      const gap = (() => {
        const btns = [...document.querySelectorAll('.lobby-go .btn')].filter((b) => !b.classList.contains('hidden'));
        if (!btns.length) return null;
        const right = Math.max(...btns.map((b) => b.getBoundingClientRect().right));
        return Math.round(chip.getBoundingClientRect().left - right);
      })();
      return { out, tight: tight.length ? Math.max(...tight) : null, gap };
    });
    for (const f of found.out) { bad++; console.log(label.padEnd(9), s.padEnd(18), f.join(' | ')); }
    console.log(label.padEnd(9), s.padEnd(18),
      'longest cup name:', (found.tight == null ? 'n/a' : found.tight + ' line(s)').padEnd(9),
      'corner-to-chip:', found.gap == null ? 'n/a' : found.gap + 'px');
  }
  await p.close();
}
await b.close();
app.close();
console.log(bad ? `\n${bad} problem(s)` : '\nclean');
process.exit(bad ? 1 : 0);
