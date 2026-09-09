// The two full-screen overlays the race screen floats over the live 3D: the
// countdown banner and the results board. Both PAINT A MODEL ANSWER and decide
// nothing — the beat semantics are the race walk's, the board's dressing is
// uiModel.resultsView's — so what lives here is markup plus the tables that turn
// the model's KEYS into English.
//
// Split out of main.js so the gallery can drive the real thing: TestHarness used
// to carry a second implementation of both in template literals, which is how the
// lobby previews once drifted to a screen that no longer existed. A preview that
// renders through these functions cannot drift from live play by construction.
const el = (id) => document.getElementById(id);

// The countdown banner. n > 0: "3/2/1". n === 0: "GO!" (the race starts this
// beat, the banner fades over the next via .is-go). n < 0: banner gone. The
// beat's SOUND is the wasm's — it taps the same tick — so there is no cue call.
const CD_COPY = { go: 'GO!' };  // the GO beat's copy; numerals ride the effect
export function showCountdownBanner(e) {
  const cd = el('countdown');
  // `go` IS the beat semantics (the effect carries it); no third spelling of
  // "n === 0 means GO" here.
  cd.textContent = e.go ? CD_COPY.go : e.n > 0 ? String(e.n) : '';
  cd.classList.toggle('is-go', e.go);
  // slap each numeral in (re-add .slap around a reflow so the animation restarts
  // on the same element); GO! keeps its own is-go fade-out.
  cd.classList.remove('slap');
  if (e.slap) { void cd.offsetWidth; cd.classList.add('slap'); }
}

// ---- the results board ------------------------------------------------------
// Three dressings, and on a cup, TWO PHASES of one board. Phase 1 is the race
// that just ended: finishing order, lap time, what each place scored, and the
// cup total each row held COMING IN. Phase 2 accounts those scores into those
// totals ONE POINT AT A TIME, re-ranking as it goes, and settles on the new
// standings. Painting the end state alone states the delta and never shows the
// change, which is what this board used to do.
//
// NOTHING APPEARS, DISAPPEARS OR RESIZES ACROSS THE TWO. Both phases lay out
// the same filled cells at the same widths; the numbers change and the rows
// re-order, and that is the entire animation. Three earlier cuts each broke a
// piece of that, and the notes are kept because each is easy to reinvent:
//   - swapping the trailing cell (lap time OUT, "+N" IN) changed every row's
//     width and height at the exact moment the FLIP began translating it, so
//     the board jumped 48px sideways and grew 130px mid-slide;
//   - leaving the total blank until phase 2 gave the climb no visible starting
//     point — it appeared and began counting in the same frame;
//   - sliding the rows to their final order WHILE the totals were still
//     climbing showed, for the length of the slide, a ranking the board's own
//     figures did not yet support.
//
// WHICH dressing, which rows are in each phase, and what each row's trailing
// cell says are all uiModel.resultsView's — it answers in KEYS, and the tables
// below are where those keys become English. Everything from here down is
// markup and motion. `colors` is the livery palette (CAR_COLORS), indexed by
// row.colorIndex.
const TITLE_COPY = {
  // Podium boards celebrate: "<cup> CHAMPS!" on a red header sticker (.is-podium h2).
  cup_champs: (v) => `${v.cupName} CHAMPS!`,
  standings: () => 'Standings',
  results: () => 'Results'
};
const SUB_COPY = {
  cup_race: (v) => `${v.cupName} · Race ${v.race}`,          // endless: no "of N"
  cup_race_of: (v) => `${v.cupName} · Race ${v.race} of ${v.of}`
};
const NEWGAME_COPY = { next_race: 'Next race ▸', new_game: 'New Game' };

// Up to this many rows the board stays a single column; above it, two. A full
// grid plus late joiners is eleven rows, which does not fit a 720p TV in one
// column — the title and the button used to be pushed off the screen edges.
const ONE_COL_MAX = 5;

// The phase-2 beats, as fractions of the model's phase-1 hold. Proportional
// rather than fixed because racePhaseMs is itself scaled off the intermission
// budget, which E2E shrinks to milliseconds: fixed durations would leave the
// animation still running after the next race had started.
const TICK_OF_PHASE = 0.035;  // one point accounted for, per row, per tick
// The fallback for a board with nothing to count. Every other board's move is as
// long as its own tally (most * tickMs), so the list arrives with the numbers.
const FLIP_OF_PHASE = 0.055;

let phaseTimer = null;
let countTimer = null;
let settledCb = null;

// `onSettled` fires when the last point has landed and the board has stopped
// moving. The phones need it: they are handed the standings the instant the race
// ends, which is the instant this board STARTS its reveal, so anything they say
// about the cup before this would be said ahead of the TV.
export function renderResults(v, colors, onSettled) {
  cancelPhases();
  settledCb = onSettled || null;
  const root = el('results');
  // The champs header is phase 2's alone — phase 1 is still just "race 4 of 4".
  // Its BOX, though, goes on from the first frame: the sticker is bigger than a
  // plain title, so growing one at settle would shove the list and the button
  // down exactly as the rows are mid-FLIP. `is-champs` reserves that box now and
  // `is-podium` only paints it later. See display.css.
  root.classList.remove('is-podium');
  root.classList.toggle('is-champs', !!v.podium);
  paintPhase(v, colors, v.twoPhase ? v.raceRows : v.listRows, {
    titleKey: v.twoPhase ? v.raceTitleKey : v.titleKey,
    showSub: v.twoPhase ? !!v.sub : v.intermission,
    showNext: false
  });
  el('results-newgame').textContent = NEWGAME_COPY[v.newGameKey];
  root.classList.remove('hidden');
  if (v.twoPhase) phaseTimer = setTimeout(() => toStandings(v), v.racePhaseMs);
}

// Hiding the board has to stop the phase timers too, or a board dismissed
// during phase 1 repaints itself over whatever replaced it.
export function hideResults() {
  cancelPhases();
  el('results').classList.add('hidden');
}

function cancelPhases() {
  clearTimeout(phaseTimer); phaseTimer = null;
  clearInterval(countTimer); countTimer = null;
  settledCb = null;          // a board torn down mid-reveal never settled
}

// ---- phase 1 (and single-race boards) ---------------------------------------

function paintPhase(v, colors, rows, dressing) {
  el('results-title').textContent = TITLE_COPY[dressing.titleKey](v);
  const sub = el('results-sub');
  sub.classList.toggle('hidden', !dressing.showSub);
  sub.classList.remove('is-held');
  if (v.sub) sub.textContent = SUB_COPY[v.sub.key](v.sub);

  const list = el('results-list');
  list.innerHTML = '';
  // Column-major fill (1-4 left of 5-8), matching the phone's board, so the
  // two screens rank in the same reading order.
  list.style.setProperty('--result-rows', Math.ceil(Math.max(1, rows.length) / 2));
  list.classList.toggle('is-two-col', rows.length > ONE_COL_MAX);
  rows.forEach((row, i) => list.appendChild(buildRow(row, colors, i)));

  paintNext(v, dressing.showNext);
}

// The entrance stagger is set here rather than by :nth-child in the CSS — see
// the note beside the rule. Phase 2 re-orders these nodes, and a delay that
// changes under a moving row restarts its slap-in from opacity 0.
const SLAP_FIRST_MS = 100, SLAP_STEP_MS = 40, SLAP_LAST_MS = 260;

function buildRow(row, colors, i) {
  const li = document.createElement('li');
  li.dataset.pid = String(row.playerId);
  li.style.animationDelay = `${Math.min(SLAP_FIRST_MS + i * SLAP_STEP_MS, SLAP_LAST_MS)}ms`;
  if (row.joining) li.classList.add('is-joining');
  // The name is player-supplied — set as TEXT, never markup (same rule as the
  // controller's results list and renderJoinUrl). It carries the player's
  // livery colour itself — no swatch dot.
  const nm = document.createElement('span');
  nm.className = 'res-name';
  nm.style.setProperty('--c', colors[row.colorIndex] || 'inherit');
  nm.textContent = `${row.name}${row.ai ? ' (CPU)' : ''}`;
  const trail = document.createElement('span');
  trail.className = 'res-trail';
  li.append(nm, trail);
  fillTrail(trail, row);
  return li;
}

// The trailing cell, per the row's KIND. A cup's two phases build the SAME
// THREE FILLED CELLS and differ only in the total's VALUE — the model says
// which (time_gain vs points), and the CSS gives each cell a fixed width.
function fillTrail(trail, row) {
  trail.innerHTML = '';
  if (row.kind === 'joining') {
    const t = document.createElement('span');
    t.className = 'res-time';
    t.textContent = 'Next race';
    trail.appendChild(t);
    return;
  }
  const t = document.createElement('span');
  t.className = 'res-time';
  t.textContent = row.finished ? `${row.time.toFixed(1)}s` : 'DNF';
  trail.appendChild(t);
  if (row.kind === 'time') return;            // single race: the lap clock alone

  const gain = document.createElement('span');
  gain.className = 'res-gain' + (row.gained ? '' : ' is-zero');
  gain.textContent = `+${row.gained || 0}`;
  // The total is FILLED in both phases and differs only in value: the race phase
  // shows what this row had coming in, the standings phase counts up to what it
  // banked. A total that merely APPEARED in phase 2 had no readable before
  // state — it landed and started climbing in the same frame, so the change it
  // exists to show was the one thing nobody could see.
  const pts = document.createElement('span');
  pts.className = 'res-pts';
  // Only the race phase builds rows (phase 2 writes these two cells in place, in
  // tally()), so the total here is always the one the row came in with.
  pts.textContent = `${row.pointsBefore || 0} pts`;
  trail.append(gain, pts);
}

// Intermission footer: what's next + the auto-advance countdown (ticked by
// main.js's renderIntermissionCountdown against seriesDeadline). Built even
// while hidden, so the ticker always has its span to write into.
function paintNext(v, show) {
  const next = el('results-next');
  // A board that will NEVER have a footer takes no space for one. A board that
  // is merely not showing it yet HOLDS the space: `display:none` here would let
  // the footer's arrival in phase 2 shove the title, the list and the button up
  // by its own height — and those three are not what the FLIP animates, so they
  // would jump while the rows slid.
  next.classList.toggle('hidden', !v.intermission);
  next.classList.toggle('is-held', v.intermission && !show);
  if (!v.next) return;
  next.textContent = 'Next up: ';
  const b = document.createElement('b');
  b.textContent = v.next.trackName;
  const secs = document.createElement('span');
  secs.id = 'results-next-secs';
  secs.textContent = String(v.next.secs);
  next.append(b, ' · starting in ', secs, '…');
}

// ---- phase 2: the race order becomes the cup order --------------------------
// TWO THINGS RUN TOGETHER AND NEITHER DRIVES THE OTHER. The totals climb, one
// whole point at a time, from what each row held coming in to what it banked;
// and the list glides, ONCE, from the race's finishing order straight into the
// cup's. The intermediate totals do not position anything.
//
// THERE ARE THREE ORDERS ON A CUP BOARD, and that is the whole reason this is
// choreography rather than a live sort:
//   A  the race that just ended      (phase 1's order)
//   B  the cup BEFORE these points   (what the totals on screen say at t=0)
//   C  the cup AFTER them            (the model's listRows — where we land)
// Sorting on the totals being shown means passing through B, and B is
// uncorrelated with the race the viewer has just watched: the board would snap
// sideways into the pre-race table before a single point had moved, which is a
// jump with no cause on screen. Worse, B is where it spends the FIRST TICK —
// 32 ms in, before any of the climbing that is supposed to explain it.
//
// The totals still step WHOLE POINTS, because the display only ever shows
// integers and a total that ticks is one the eye can follow. That also sets the
// length of the whole phase, movement included: the tally runs as many ticks as
// the WINNER owes points, however big the field is — widening the ladder
// lengthens it, so the gallery's settle budgets are what feel a change to
// POINTS_BY_RANK first.
//
// So the order is the model's from the first frame of this phase and no shell
// sorts anything. What is animated is the row's journey to the seat it already
// has. (Race 1 of a cup is the degenerate case and it is free: everyone comes in
// on zero, the ladder is monotonic in finishing rank, so A = B = C and nothing
// moves at all.)
//
// The title, the medals and the next-up footer all wait for the last point.
// Crowning a champion, or moving the CHAMPS sticker in, while rows can still be
// travelling would mark the wrong row.
function toStandings(v) {
  phaseTimer = null;
  const nodes = new Map();
  for (const li of el('results-list').children) nodes.set(li.dataset.pid, li);

  // Live state per row, IN THE MODEL'S FINAL ORDER. `seat` is the row's index in
  // it, and it is the whole ranking: nothing here re-derives a position from the
  // numbers, so the board cannot land anywhere but on what the model said.
  const live = v.listRows.map((row, seat) => ({
    row, seat, li: nodes.get(String(row.playerId)),
    owed0: row.kind === 'points' ? Math.max(0, Math.round(row.points - row.pointsBefore)) : 0,
    owed: 0, total: row.kind === 'points' ? row.pointsBefore : 0
  })).filter((r) => r.li);
  for (const r of live) r.owed = r.owed0;

  const tickMs = Math.max(16, v.racePhaseMs * TICK_OF_PHASE);
  const flipMs = v.racePhaseMs * FLIP_OF_PHASE;
  const most = live.reduce((m, r) => Math.max(m, r.owed0), 0);
  // A board with nothing to count still has to become the cup's: the move gets
  // the bare flip duration, since there is no tally for it to keep pace with.
  if (!most) { glide(live, flipMs); return settle(v, live); }

  // Driven by ELAPSED TIME, not by counting ticks. Each row still steps whole
  // points — the display only ever shows integers, which is what makes an
  // overtake attributable — but how many have been accounted for is a function
  // of the clock. A starved page (the E2E suite runs several of these at once)
  // then skips ahead and still finishes inside its budget, where a fixed point
  // per firing would stretch the tally for as long as the contention lasted.
  const runMs = most * tickMs;
  // The journey takes exactly as long as the counting, so the board arrives all
  // at once: the last point lands on a list that has just stopped moving.
  glide(live, runMs);
  const t0 = performance.now();
  countTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / runMs);
    for (const r of live) {
      if (!r.owed0) continue;
      const done = Math.round(k * r.owed0);
      if (r.owed0 - done === r.owed) continue;       // no whole point moved yet
      r.owed = r.owed0 - done;
      r.total = r.row.pointsBefore + done;
      r.li.querySelector('.res-gain').textContent = `+${r.owed}`;
      r.li.querySelector('.res-pts').textContent = `${r.total} pts`;
    }
    if (k >= 1) { clearInterval(countTimer); countTimer = null; settle(v, live); }
  }, Math.min(tickMs, 32));
}

// THE ONE MOVE: put the rows in the model's order and slide each from wherever
// it is to where it now belongs. A FLIP — re-order first, invert the difference,
// then ease the inversion out — so the browser lays the list out once and every
// row travels on the compositor.
//
// Called ONCE per board, not per tick, which is what makes the slides readable:
// a glide re-issued every 91 ms was cut off at two-thirds of its own travel and
// restarted from mid-flight, stacking ease-out on ease-out. It is also why the
// order is a straight `seat` sort with no numbers in it — the model ranked this
// board, and re-deriving that rank here from figures that are still climbing is
// how the pre-race table (B, above) got on screen.
function glide(live, ms) {
  const list = el('results-list');
  const want = [...live].sort((a, b) => a.seat - b.seat);
  if (want.every((r, i) => list.children[i] === r.li)) return;   // nothing to move

  const before = new Map();
  for (const li of list.children) before.set(li.dataset.pid, li.getBoundingClientRect());
  for (const r of want) {
    // Re-inserting a node RESTARTS its CSS animations, and the row's entrance
    // slap begins at opacity 0 — so every row that moved went invisible for the
    // length of its own slide. The slap belongs to the board's reveal, which is
    // over by now.
    r.li.style.animation = 'none';
    list.appendChild(r.li);                 // appendChild MOVES an existing child
  }
  const moving = [];
  for (const li of list.children) {
    const from = before.get(li.dataset.pid);
    if (!from) continue;
    const to = li.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (!dx && !dy) continue;
    li.style.transition = 'none';
    li.style.transform = `translate(${dx}px, ${dy}px)`;
    // Two rows swapping occupy the same strip of screen halfway through, and
    // over a whole tally that overlap is on show rather than gone in a frame.
    // The row climbing passes IN FRONT — an overtake reads as one thing going
    // past another, not as two things dissolving through each other.
    li.style.position = 'relative';
    li.style.zIndex = dy > 0 ? '2' : '1';
    moving.push(li);
  }
  void list.offsetWidth;        // commit the inverted positions before easing them out
  for (const li of moving) {
    // Eased at BOTH ends, unlike the old snap: this move now lasts as long as
    // the counting beside it, so it should set off and arrive with the numbers
    // rather than lunging away from the start.
    li.style.transition = `transform ${ms}ms cubic-bezier(0.45, 0.05, 0.25, 1)`;
    li.style.transform = '';
  }
}

// The last point has landed: the order is final, so the board can now say what
// it is. The spent "+0" empties rather than resting on a figure that reads as
// "scored nothing" for the rest of the intermission.
function settle(v, live) {
  el('results').classList.toggle('is-podium', v.podium);
  el('results-title').textContent = TITLE_COPY[v.titleKey](v);
  // HELD, not hidden — same reason as the footer. A podium drops the "Race 4 of
  // 4" line once it is crowned, and this board is a centred column: removing
  // that line's box shrinks the column and re-centres EVERYTHING, so the list
  // and the button slide up under a sticker that is supposed to be the only
  // thing arriving. (The sticker itself moves nothing: its box is reserved from
  // frame one by .is-champs, and its rotate is a transform.)
  el('results-sub').classList.toggle('is-held', !v.intermission);
  paintNext(v, true);
  for (const r of live) {
    r.li.classList.remove('is-medal-1', 'is-medal-2', 'is-medal-3');
    if (r.row.medal) r.li.classList.add(`is-medal-${r.row.medal}`);
    if (r.row.kind === 'joining') continue;   // "Next race" is still true here
    // BOTH race columns retire together, because the settled board is the CUP's:
    // its rank is a cup rank and its total a cup total, and a lap time left
    // sitting between them is the one number still talking about the race. The
    // race phase is where it belonged, and it had 2.6 s there.
    for (const sel of ['.res-gain', '.res-time']) {
      const cell = r.li.querySelector(sel);
      if (cell) cell.classList.add('is-spent');
    }
  }
  // The cup is now told. Anything waiting on it — the phones — can say so too.
  const done = settledCb; settledCb = null;
  if (done) done();
}
