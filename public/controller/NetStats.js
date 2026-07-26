// NetStats — measurement overlay for the CONTROL send gate (InputGate).
//
// The whole point of the gate is a number nobody can guess from a desk: how much
// of a REAL player's 25 Hz stream is redundant. Sensor jitter, how twitchy a
// given person is, and how much of a lap is spent holding a line all move it, so
// it has to be read off an actual party rather than a simulated input walk.
//
// Shown only behind ?netstats=1. The controller deliberately ships NO debug UI to
// players (see the note at the foot of main.js — the display's query-param wrench
// is display-only for exactly this reason), and players join by scanning a QR
// that carries no query string, so this can never surface for them. Whoever is
// running the measurement opens their own phone with the flag.
//
//   ?netstats=1              show the overlay
//   ?steerThresh=0.05        run the LIVE gate at this threshold (default 0.03)
//
// The table's shadow rows replay the same real input through every candidate
// threshold at once, so a single party yields the whole suppression curve instead
// of one point — no reloading between races to try another value.

const FMT1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

export function initNetStats(gate, { intervalMs = 500 } = {}) {
  const box = document.createElement('div');
  box.id = 'netstats';
  // pointer-events:none is load-bearing — this sits over the drive surface and
  // must never eat a steer/brake touch, which would corrupt the very measurement
  // it exists to take.
  box.style.cssText = [
    'position:fixed', 'left:8px', 'top:8px', 'z-index:9999',
    'pointer-events:none', 'font:11px/1.35 ui-monospace,Menlo,monospace',
    'background:rgba(42,39,53,.88)', 'color:#FFF6EB',
    'padding:7px 9px', 'border-radius:8px', 'white-space:pre',
    'max-width:60vw', 'letter-spacing:.02em',
  ].join(';');
  document.body.appendChild(box);

  let lastProduced = 0, lastSent = 0, rateProduced = 0, rateSent = 0;

  const render = () => {
    const s = gate.stats();
    // Instantaneous rates over the refresh window, so the readout tracks what the
    // player is doing NOW (a lap spent cornering vs a long straight) rather than
    // being dragged toward the session mean.
    const dp = s.produced - lastProduced, ds = s.sent - lastSent;
    const secs = intervalMs / 1000;
    if (dp > 0) { rateProduced = dp / secs; rateSent = ds / secs; }
    lastProduced = s.produced; lastSent = s.sent;

    const rows = s.shadows.map((sh) => {
      const live = sh.threshold === s.threshold ? '<' : ' ';
      return `  ${sh.threshold.toFixed(2)}  ${FMT1(sh.suppressedPct).padStart(5)}%${live}`;
    }).join('\n');

    box.textContent =
      `NETSTATS  thr ${s.threshold}\n` +
      `now   ${FMT1(rateSent)}/s of ${FMT1(rateProduced)}/s\n` +
      `total ${s.sent} of ${s.produced}  (-${FMT1(s.suppressedPct)}%)\n` +
      `thresh  suppressed\n${rows}`;
  };

  render();
  const timer = setInterval(render, intervalMs);
  return () => { clearInterval(timer); box.remove(); };
}
