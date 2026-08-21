// Runs against the REAL controller page now that the relayout has shipped into
// controller.css. "Bigger text if space allows" needs a limit that is checked
// rather than eyeballed: this walks every element in the lobby at both landscape
// viewports and reports anything wider than its own box, plus the tightest gap
// between a cup name and its tile edge.
import { chromium } from 'playwright';
const b = await chromium.launch();
let bad = 0;
for (const [label, w, h] of [['iphone14', 844, 390], ['se', 667, 375]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  for (const s of ['lobby-host', 'lobby-race', 'lobby-waiting', 'lobby-race-locked']) {
    await p.goto(`http://localhost:8477/controller/index.html?scenario=${s}&color=0`, { waitUntil: 'networkidle' });
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
      // tightest text-to-edge margin among the cup tiles, so "nearly clipped" shows up too
      const tight = [...document.querySelectorAll('.mode-opt__name')].map((e) => {
        const par = e.closest('.mode-opt');
        return Math.round(par.getBoundingClientRect().right - e.getBoundingClientRect().right);
      });
      const gap = (() => {
        const btns = [...document.querySelectorAll('.lobby-go .btn')].filter((b) => !b.classList.contains('hidden'));
        if (!btns.length) return null;
        const right = Math.max(...btns.map((b) => b.getBoundingClientRect().right));
        return Math.round(chip.getBoundingClientRect().left - right);
      })();
      return { out, tight: Math.min(...tight), gap };
    });
    for (const f of found.out) { bad++; console.log(label.padEnd(9), s.padEnd(18), f.join(' | ')); }
    console.log(label.padEnd(9), s.padEnd(18),
      'cup-name slack:', String(found.tight + 'px').padEnd(9),
      'corner-to-chip:', found.gap == null ? 'n/a' : found.gap + 'px');
  }
  await p.close();
}
await b.close();
console.log(bad ? `\n${bad} problem(s)` : '\nclean');
