// The phone's results board — ONE renderer shared by the live controller
// (main.js) and the gallery preview (TestHarness), so the two cannot drift. The
// harness used to hand-roll its own twin of this markup, and had already drifted:
// it wrote its own copy strings and its own row classes beside these.
//
// A preview renders through the live renderer, never a copy of it: the harness
// synthesizes a STANDINGS payload and calls the same function the race does.
//
// IT SHOWS ONE PLAYER, ONE RANKING: where YOU came in the race. The full field,
// the cup table and the points that moved it are the TV's story, told there at
// TV size with the totals counting across and the rows re-ranking as they go —
// and everyone in the room is looking at it. Eight rows of small type here
// competed with that screen and lost; the cup standing competed with it worse,
// because printing the new position on four phones the moment the board arrives
// gives away the reveal the TV is still building. What stays is the half the TV
// cannot personalise, plus the controls only this phone has.
import { renderWaitNote } from './ui.js';

const el = (id) => document.getElementById(id);

// Render your card + the footer. `data` is the STANDINGS payload as the display
// sends it: { over, series?, settled?, order: [{ playerId, name, colorIndex,
// joining?, ai?, finished?, time?, racePlace?, points?, gained? }] }.
//
// `settled` arrives only on a cup's LAST board, and only once the TV has
// finished revealing the cup (display main.js showResults). Before it this
// screen is about the race; after it, about the cup — and the title has to move
// with the card, or a phone reading "Beach Cup · Final" over a RACE place tells
// whoever won the last race that they won the cup.
export function renderResultsBoard(data, { meId, hostPeerIndex, amHost, liveryOf }) {
  const s = data.series;
  const cupDone = !!(s && s.final && data.settled);
  el('results-title').textContent = !s ? 'Results'
    : cupDone ? `${s.cupName} · Final`
      : s.endless ? `Race ${s.raceIndex + 1}`                  // endless random: no "of N"
        : `Race ${s.raceIndex + 1} of ${s.raceCount}`;
  renderMe(data, meId, cupDone);
  renderFoot(data, { hostPeerIndex, amHost, liveryOf });
}

// 1st/2nd/3rd/4th… — the teens are all "th", which is why this is not a lookup
// on the last digit alone. The field plus late joiners can reach the teens.
function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// WHERE YOU CAME IN THE RACE — one ranking, and deliberately not the cup one.
//
// The cup standing is the TV's to reveal: it counts the points across one at a
// time and re-ranks live, and a phone that printed the new position the moment
// the board arrived would spoil that for everyone holding one. The race place
// is the half the TV cannot personalise, it is true the instant you cross the
// line, and being the only number here it can never be read as the other one.
function renderMe(data, meId, cupDone) {
  const card = el('result-me');
  const order = data.order || [];
  const idx = order.findIndex((o) => o.playerId === meId);
  const me = idx < 0 ? null : order[idx];
  // A phone with no car this race (spectating, or the display's own host seat)
  // has no placement to report; the TV is showing the board either way.
  card.classList.toggle('hidden', !me);
  if (!me) return;

  const place = el('result-place');
  const time = el('result-time');
  if (me.joining) {
    card.classList.remove('result-me--won');
    place.textContent = '–';
    time.textContent = "You're in the next race";
    return;
  }
  // The cup is decided and the TV has said so: report THAT. The board arrives in
  // cup order, so the position in it is the cup finish.
  if (cupDone) {
    card.classList.toggle('result-me--won', idx === 0);
    place.textContent = ordinal(idx + 1);
    time.textContent = `${me.points || 0} pts`;
    return;
  }
  // `racePlace` survives the cup re-sort, so this stays the FINISHING place even
  // when the board it came on is sorted by the cup.
  card.classList.toggle('result-me--won', !!me.finished && me.racePlace === 1);
  place.textContent = me.finished ? ordinal(me.racePlace) : (data.over ? '–' : '…');
  time.textContent = me.finished ? `${me.time.toFixed(1)}s`
    : data.over ? 'DNF' : 'Still racing';
}

// Footer: while cars are still out, a waiting note for everyone. Once the race is
// over, the host gets ONE button — "Next race" during a cup intermission, "New
// game" otherwise; everyone else gets a note. There is deliberately no abandon
// button beside it: a run in progress is left through the pause overlay's "New
// game" in the next race, so the board can't be tapped out of a cup by mistake.
// That exit is any phone's, not just the host's. Intermissions auto-advance, so
// non-hosts see "starting soon" rather than a who-to-wait-on name.
function renderFoot(data, { hostPeerIndex, amHost, liveryOf }) {
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  const s = data.series;
  const intermission = !!(s && !s.final && data.over);
  if (!data.over) {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    wait.textContent = 'Waiting for the other racers to finish…';
  } else if (amHost) {
    btn.textContent = intermission ? 'Next race ▸' : 'New game';
    btn.classList.remove('hidden');
    wait.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    wait.classList.remove('hidden');
    if (intermission) {
      wait.textContent = `Next race starting soon: ${s.nextTrackName || '…'}`;
    } else {
      const host = (data.order || []).find((o) => o.playerId === hostPeerIndex);
      renderWaitNote(wait, { name: host && host.name, color: host && liveryOf(host.colorIndex) }, ' to start a new game…');
    }
  }
}
