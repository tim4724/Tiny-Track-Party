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

// The results overlay in its three dressings: plain single-race board, cup
// intermission (points + "next up" footer), cup podium (top-three steps).
// Rows come from the same standingsPayload the phones get, so both screens
// always tell the same story (order, points, joining rows).
//
// WHICH dressing, which rows go on the steps vs in the list, and what each row's
// trailing cell says are uiModel.resultsView's — it answers in KEYS, and the
// tables below are where those keys become English. Everything from here down is
// markup. `colors` is the livery palette (CAR_COLORS), indexed by row.colorIndex.
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

export function renderResults(v, colors) {
  el('results-title').textContent = TITLE_COPY[v.titleKey](v);
  // Sub only during intermissions ("Cup · Race N of M") — the podium's CHAMPS
  // header says it all.
  const sub = el('results-sub');
  sub.classList.toggle('hidden', !v.intermission);
  if (v.sub) sub.textContent = SUB_COPY[v.sub.key](v.sub);

  renderPodium(el('results-podium'), v.podiumRows, colors);

  const list = el('results-list');
  list.innerHTML = '';
  for (const row of v.listRows) {
    const li = document.createElement('li');
    if (row.joining) li.className = 'is-joining';
    // The name is player-supplied — set as TEXT, never markup (same rule as
    // the controller's results list and renderJoinUrl). It carries the
    // player's livery colour itself — no swatch dot.
    const nm = document.createElement('span');
    nm.className = 'res-name';
    nm.style.setProperty('--c', colors[row.colorIndex] || 'inherit');
    nm.textContent = `${row.name}${row.ai ? ' (CPU)' : ''}`;
    li.append(nm, ' ');
    if (row.kind === 'joining') {
      const t = document.createElement('span');
      t.className = 'res-time';
      t.textContent = 'Next race';
      li.appendChild(t);
    } else if (row.kind === 'points') {
      // Cup boards tell the points story ("+9 · 15 pts"); the lap clock already
      // had its moment on the finish cards.
      const gain = document.createElement('span');
      gain.className = 'res-gain' + (row.gained ? '' : ' is-zero');
      gain.textContent = `+${row.gained || 0}`;
      const pts = document.createElement('span');
      pts.className = 'res-pts';
      pts.textContent = `${row.points || 0} pts`;
      li.append(gain, pts);
    } else {
      const t = document.createElement('span');
      t.className = 'res-time';
      t.textContent = row.finished ? `${row.time.toFixed(1)}s` : 'DNF';
      li.appendChild(t);
    }
    list.appendChild(li);
  }

  // Intermission footer: what's next + the auto-advance countdown (ticked by
  // renderIntermissionCountdown against seriesDeadline).
  const next = el('results-next');
  next.classList.toggle('hidden', !v.intermission);
  if (v.next) {
    next.textContent = 'Next up: ';
    const b = document.createElement('b');
    b.textContent = v.next.trackName;
    const secs = document.createElement('span');
    secs.id = 'results-next-secs';
    secs.textContent = String(v.next.secs);
    next.append(b, ' — starting in ', secs, '…');
  }

  el('results-newgame').textContent = NEWGAME_COPY[v.newGameKey];
  el('results').classList.toggle('is-podium', v.podium); // list ranks from 4th under the steps
  el('results').classList.remove('hidden');
}

// Top-three steps, arranged 2nd | 1st | 3rd; hidden outside podium boards (the
// model hands back null there). AI keep their (CPU) tag — beating them is the
// story of a short-handed cup. Each step is a livery-coloured sticker block
// carrying its rank numeral.
function renderPodium(wrap, top, colors) {
  wrap.innerHTML = '';
  top = top || [];
  wrap.classList.toggle('hidden', !top.length);
  for (const place of [2, 1, 3]) {
    const row = top[place - 1];
    if (!row) continue;
    const col = document.createElement('div');
    col.className = 'podium__col';
    col.dataset.place = String(place);
    col.style.setProperty('--c', colors[row.colorIndex] || '#888');
    const who = document.createElement('div');
    who.className = 'podium__who';
    const nm = document.createElement('span');
    nm.className = 'res-name';
    nm.style.setProperty('--c', colors[row.colorIndex] || 'inherit');
    nm.textContent = `${row.name}${row.ai ? ' (CPU)' : ''}`;
    who.append(nm);
    const pts = document.createElement('div');
    pts.className = 'podium__pts';
    pts.textContent = `${row.points || 0} pts`;
    const step = document.createElement('div');
    step.className = 'podium__step';
    step.textContent = String(place);
    col.append(who, pts, step);
    wrap.appendChild(col);
  }
}
