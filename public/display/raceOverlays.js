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
const TICK_OF_PHASE = 0.035;  // one beat of the tally
const FADE_OF_PHASE = 0.055;  // the cut: the race table dips out before the cup's slaps in

// HOW MANY BEATS THE TALLY TAKES, whatever the ladder pays. It used to take one
// per point the WINNER owed, which tied the length of the board to the top of
// POINTS_BY_RANK: widening that from 9 to 15 stretched the tally from 819 ms to
// 1365 ms without anyone touching this file. A row still moves WHOLE POINTS —
// integers are what make a total followable — it just moves as many as the clock
// has reached, so a bigger ladder means bigger steps rather than a longer wait.
const TALLY_BEATS = 8;

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
  if (v.twoPhase) phaseTimer = setTimeout(() => toStandings(v, colors), v.racePhaseMs);
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

// The trailing cells. A CUP ROW ALWAYS BUILDS ALL THREE, whichever beat it is
// for, and a beat that has nothing to say in a cell leaves it EMPTY rather than
// leaving it out: each has a min-width in the CSS, so an empty one still holds
// its box and the row is the same width in every beat. That is what lets the
// board cut from the race table to the cup's without the list changing size
// under a title that is supposed to be the only thing that changed.
//
// Which cell each beat speaks in is the row KIND's, and the kinds are the
// model's (ui_model.h):
//   time_gain  the race: the lap clock. Cup cells reserved, empty.
//   points     the cup:  the score and the total. Lap clock reserved, empty.
//   time       a single race, no cup anywhere: the lap clock, with the same two
//              cells reserved beside it. There is no second beat for THIS board
//              to line up with — it lines up with the OTHER boards, so a race
//              result, a cup table and a podium are all one width.
function fillTrail(trail, row) {
  trail.innerHTML = '';
  const cell = (cls, text) => {
    const n = document.createElement('span');
    n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  if (row.kind === 'joining') {
    trail.appendChild(cell('res-time', 'Next race'));
    return;
  }
  const lap = row.finished ? `${row.time.toFixed(1)}s` : 'DNF';
  const cup = row.kind === 'points';
  const time = cell('res-time', cup ? '' : lap);
  const gain = cell('res-gain' + (cup && !row.gained ? ' is-zero' : ''),
                    cup ? `+${row.gained || 0}` : '');
  // The total is on screen from the standings phase's FIRST frame, holding the
  // value the row came in with, because a number that appears in the same beat
  // that changes it has no before state to read. tally() writes this cell and
  // the gain in place from there.
  const pts = cell('res-pts', cup ? `${row.pointsBefore || 0} pts` : '');
  // THE ROW'S LAST NUMBER SITS AT THE RIGHT EDGE in both beats. The standings
  // end on the total, so the race ends on the lap time and keeps its two
  // reserved cells to the LEFT of it — a row whose one figure floated in the
  // middle read as a column that had lost its heading. Only the order differs;
  // the three cells and their widths do not, so the row is the same size either
  // way, and a cut is not a move, so there is no translate for the reordering to
  // show up in.
  trail.append(...(cup ? [time, gain, pts] : [gain, pts, time]));
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

// ---- phase 2: the cup answers, in three beats -------------------------------
// A CUP BOARD CARRIES THREE ORDERS, and every attempt to show it in fewer than
// three beats has failed on one of them:
//   A  the race that just ended      (phase 1: finishing order, lap times)
//   B  the cup BEFORE these points   (what the totals on screen already say)
//   C  the cup AFTER them            (the model's listRows)
//
// Two cuts are on record as rejected, and they are the two halves of the same
// mistake — animating a move the figures on screen do not account for:
//   - SORTING LIVE FROM A ONWARD re-sorts on the totals being shown, and at t=0
//     those are the pre-race ones: the board slides into B, which is
//     uncorrelated with the race just watched, before a single point has moved.
//   - GLIDING A STRAIGHT TO C shows, for the whole length of the slide, a
//     ranking the board's own numbers do not yet support.
//
// So A -> B is a CUT, not a move. The race table dips out, the title turns over
// to "Standings", and the cup's own table slaps back in — the same entrance the
// board arrived with. Nothing travels, so nothing has to be justified: the
// heading says why the list is different. Only B -> C is animated, and there
// every row moves BECAUSE A POINT LANDED, which is the one motivation this
// board can actually show.
//
// (Race 1 of a cup is the degenerate case and it is free: everyone comes in on
// zero and the ladder is monotonic in finishing rank, so A = B = C. The cut
// re-enters the same order and the tally moves nothing.)
//
// The medals and the CHAMPS title still wait for the LAST point — the cut turns
// the heading to "Standings", never to a champion. Crowning one while rows can
// still overtake marks the wrong row.
// BEAT 2 — the cut. The race table dips out and the CUP's table, as it stood
// BEFORE this race, slaps back in under a new heading. paintPhase rebuilds the
// list, and rebuilding is what replays the entrance animation: the same slap the
// board arrived on, so the turn reads as the board answering a second question
// rather than as rows scurrying.
//
// B'S ORDER IS DERIVED HERE, and that is the one thing on this path that ought
// to be the model's (CLAUDE.md rule 2) — `pointsBefore` is on every row, but
// what breaks a TIE in the pre-race table is a policy question this side cannot
// answer. Ties fall back to the model's own C order until it emits a B.
function toStandings(v, colors) {
  phaseTimer = null;
  const list = el('results-list');
  const fadeMs = v.racePhaseMs * FADE_OF_PHASE;
  list.style.transition = `opacity ${fadeMs}ms ease-in`;
  list.style.opacity = '0';
  phaseTimer = setTimeout(() => {
    list.style.transition = '';
    list.style.opacity = '';
    // 'standings', not v.titleKey: a podium's key is cup_champs and the champion
    // is not known until the last point. settle() is where that lands.
    paintPhase(v, colors, standingsBefore(v), {
      titleKey: 'standings', showSub: !!v.sub, showNext: false
    });
    // LET THE TABLE FINISH ARRIVING. The entrance is staggered, so the last row
    // lands about half a second after the first; starting the tally on the fade's
    // own clock had the top of the board already counting while the bottom of it
    // was still slapping in. Read off the last row rather than retyping the CSS:
    // the stagger is inline (buildRow) and the duration is a rule in display.css,
    // and a reduced-motion viewer has no entrance to wait for at all.
    phaseTimer = setTimeout(() => tally(v), entranceMs(el('results-list').lastElementChild));
  }, fadeMs);
}

// When a freshly painted row has finished its entrance, in ms.
function entranceMs(li) {
  if (!li) return 0;
  const cs = getComputedStyle(li);
  const dur = parseFloat(cs.animationDuration) || 0;
  if (!dur) return 0;                       // prefers-reduced-motion: nothing to wait for
  return (dur + (parseFloat(cs.animationDelay) || 0)) * 1000;
}

// The cup as it stood COMING IN: the model's rows on the totals they already
// show. Joining rows raced nothing and stay under the field, exactly as they do
// in every other order on this board.
function standingsBefore(v) {
  return v.listRows.map((row, seat) => ({ row, seat }))
    .sort((a, b) => {
      const aj = a.row.kind === 'joining', bj = b.row.kind === 'joining';
      if (aj !== bj) return aj ? 1 : -1;
      const ap = a.row.pointsBefore || 0, bp = b.row.pointsBefore || 0;
      return aj ? a.seat - b.seat : (bp - ap) || (a.seat - b.seat);
    })
    .map((x) => x.row);
}

// BEAT 3 — the points land, and the rows move because of it.
function tally(v) {
  phaseTimer = null;
  const nodes = new Map();
  for (const li of el('results-list').children) nodes.set(li.dataset.pid, li);

  // `seat` is the row's index in the model's FINAL order, and it is the
  // tie-break — which is what guarantees the last point lands the board exactly
  // on what the model said rather than near it.
  const live = v.listRows.map((row, seat) => ({
    row, seat, li: nodes.get(String(row.playerId)),
    owed0: row.kind === 'points' ? Math.max(0, Math.round(row.points - row.pointsBefore)) : 0,
    owed: 0, total: row.kind === 'points' ? row.pointsBefore : 0
  })).filter((r) => r.li);
  for (const r of live) r.owed = r.owed0;

  const tickMs = Math.max(16, v.racePhaseMs * TICK_OF_PHASE);
  const most = live.reduce((m, r) => Math.max(m, r.owed0), 0);
  if (!most) return settle(v, live, tickMs);   // nothing owed: B is already C

  // A SLIDE FITS INSIDE ITS OWN BEAT. The old board gave the flip its own
  // fraction of the phase and got 143 ms against a 91 ms tick, so every slide
  // was cut off at two thirds and restarted from mid-flight, stacking ease-out
  // on ease-out. Tying the two together makes that impossible by construction.
  const flipMs = tickMs;

  // Driven by ELAPSED TIME, not by counting ticks. Each row still steps whole
  // points, but how many have been accounted for is a function of the clock. A
  // starved page (the E2E suite runs several of these at once) then skips ahead
  // and still finishes inside its budget, where a fixed step per firing would
  // stretch the tally for as long as the contention lasted.
  const runMs = TALLY_BEATS * tickMs;
  const t0 = performance.now();
  countTimer = setInterval(() => {
    // QUANTISED TO THE BEAT, not read off the raw clock. Rows owe different
    // amounts, so on a continuous clock their points cross a whole number at
    // different instants — and a row that gains one 14 ms before the row under
    // it gains one overtakes and is overtaken back inside a single frame. Every
    // total moves on the same beat instead, so an order the board holds for less
    // than a beat cannot exist. It also makes the counting even: the poll is
    // faster than the beat, so what used to be a 40-116 ms stutter is now one
    // step per tickMs.
    const elapsed = performance.now() - t0;
    const beat = Math.min(TALLY_BEATS, Math.floor(elapsed / tickMs));
    const k = beat / TALLY_BEATS;
    for (const r of live) {
      if (!r.owed0) continue;
      const done = Math.round(k * r.owed0);
      if (r.owed0 - done === r.owed) continue;       // no whole point moved yet
      r.owed = r.owed0 - done;
      r.total = r.row.pointsBefore + done;
      r.li.querySelector('.res-gain').textContent = `+${r.owed}`;
      r.li.querySelector('.res-pts').textContent = `${r.total} pts`;
    }
    reflow(live, flipMs);
    if (elapsed >= runMs) { clearInterval(countTimer); countTimer = null; settle(v, live, flipMs); }
  }, Math.min(tickMs / 4, 16));
}

// Rank on the totals CURRENTLY SHOWN, and FLIP anything that moved. This is the
// board's only movement and every bit of it is caused by a point that has just
// landed — which is only true because the list already sat in B when the tally
// started. Joining rows raced nothing and stay under the field; everything else
// is total-desc with the model's own order breaking ties, so the last tick
// cannot land anywhere but on what the model said.
function reflow(live, flipMs, final) {
  const list = el('results-list');
  // WHERE EACH ROW IS RIGHT NOW, which is the tie-break for every tick but the
  // last. Breaking a tie by `seat` — the FINAL order — makes a level score
  // display the finish early: two rows whose totals leapfrog each other tie on
  // one beat, the lower one jumps ahead because it is going to end up there,
  // and the next beat takes it back. That twitch is not a thing that happened.
  // A row moves when it is genuinely AHEAD; a tie moves nobody.
  const at = new Map([...list.children].map((li, i) => [li.dataset.pid, i]));
  const here = (r) => at.get(String(r.row.playerId)) ?? r.seat;
  const want = [...live].sort((a, b) => {
    const aj = a.row.kind === 'joining', bj = b.row.kind === 'joining';
    if (aj !== bj) return aj ? 1 : -1;
    if (!aj && a.total !== b.total) return b.total - a.total;
    // ...except at settle, where the totals are final and the board has to land
    // exactly on the order the model composed, ties and all.
    return final ? a.seat - b.seat : here(a) - here(b);
  });
  if (want.every((r, i) => list.children[i] === r.li)) return;   // nothing moved

  // Measured mid-flight on purpose: a rect taken while a previous slide is still
  // running is where the row VISUALLY is, which is exactly what the next
  // inversion has to start from. Without that an overtake landing on top of one
  // still settling would jump.
  const before = new Map();
  for (const li of list.children) before.set(li.dataset.pid, li.getBoundingClientRect());
  for (const r of want) {
    // Re-inserting a node RESTARTS its CSS animations, and the row's entrance
    // slap begins at opacity 0 — so every row that moved went invisible for the
    // length of its own slide. The slap belongs to the cut, which is over by now.
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
    // Two rows swapping occupy the same strip of screen halfway through. The row
    // CLIMBING passes in front, so an overtake reads as one thing going past
    // another rather than as two things dissolving through each other.
    li.style.position = 'relative';
    li.style.zIndex = dy > 0 ? '2' : '1';
    moving.push(li);
  }
  void list.offsetWidth;        // commit the inverted positions before easing them out
  for (const li of moving) {
    li.style.transition = `transform ${flipMs}ms cubic-bezier(0.2, 0.9, 0.25, 1)`;
    li.style.transform = '';
  }
}

// The last point has landed: the order is final, so the board can now say what
// it is. The spent "+0" empties rather than resting on a figure that reads as
// "scored nothing" for the rest of the intermission.
function settle(v, live, flipMs) {
  reflow(live, flipMs, true);
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
    // The gain retires: it would otherwise rest on "+0", which reads as "scored
    // nothing" on a board that stays up for the rest of the intermission. Only
    // the gain — the lap time went at the CUT, when the board stopped being
    // about the race, and its cell has been standing empty ever since.
    const gain = r.li.querySelector('.res-gain');
    if (gain) gain.classList.add('is-spent');
  }
  // The cup is now told. Anything waiting on it — the phones — can say so too.
  const done = settledCb; settledCb = null;
  if (done) done();
}
