// The phone's results board — ONE renderer shared by the live controller
// (main.js) and the gallery preview (TestHarness), so the two cannot drift. The
// harness used to hand-roll its own twin of this markup, and had already drifted:
// it wrote its own copy strings and its own row classes beside these.
//
// A preview renders through the live renderer, never a copy of it: the harness
// synthesizes a STANDINGS payload and calls the same function the race does.
import { renderWaitNote } from './ui.js';

const el = (id) => document.getElementById(id);

// Render the standings rows + the footer. `data` is the STANDINGS payload as the
// display sends it: { over, series?, order: [{ playerId, name, colorIndex,
// joining?, ai?, finished?, time?, points?, gained? }] }.
//
// Cup boards (data.series) trade the lap clock for points — "+9 · 15 pts" — and
// arrive from the display already in cup order; the title tracks the series
// ("Race 2 of 4", then "Beach Cup — Final" on the podium board).
export function renderResultsBoard(data, { meId, hostPeerIndex, amHost, liveryOf }) {
  const s = data.series;
  el('results-title').textContent = !s ? 'Results'
    : s.final ? `${s.cupName} — Final`
      : s.endless ? `Race ${s.raceIndex + 1}`                  // endless random: no "of N"
        : `Race ${s.raceIndex + 1} of ${s.raceCount}`;
  const cupBoard = !!(s && data.over);
  const list = el('result-list');
  list.innerHTML = '';
  // Two-column board (controller.css): the grid fills columns top-to-bottom,
  // so half the rows (rounded up) per column keeps 1-4 left of 5-8.
  list.style.setProperty('--result-rows', Math.max(1, Math.ceil((data.order || []).length / 2)));
  (data.order || []).forEach((o) => {
    const li = document.createElement('li');
    const isMe = o.playerId === meId;
    if (isMe) li.classList.add('is-me');
    if (o.joining) li.classList.add('is-joining');      // late joiner — no car this race
    else if (!o.finished) li.classList.add('is-racing');
    const dot = document.createElement('span');
    dot.className = 'res-dot';
    dot.style.background = liveryOf(o.colorIndex);
    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = o.name + (o.ai ? ' (CPU)' : isMe ? ' (You)' : '');
    li.append(dot, name);
    if (cupBoard && !o.joining) {
      const gain = document.createElement('span');
      gain.className = 'res-gain' + (o.gained ? '' : ' is-zero');
      gain.textContent = `+${o.gained || 0}`;
      const pts = document.createElement('span');
      pts.className = 'res-pts';
      pts.textContent = `${o.points || 0} pts`;
      li.append(gain, pts);
    } else {
      const time = document.createElement('span');
      time.className = 'res-time';
      time.textContent = o.joining ? 'Next race'
        : o.finished ? `${o.time.toFixed(1)}s` : (data.over ? 'DNF' : 'Racing…');
      li.appendChild(time);
    }
    list.appendChild(li);
  });
  renderFoot(data, { hostPeerIndex, amHost, liveryOf });
}

// Footer: while cars are still out, a waiting note for everyone. Once the race is
// over, the host gets the button — "Next race" during a cup intermission (plus the
// ghost "End cup early", the only way to abandon a cup from here) or "New game"
// otherwise; everyone else gets a note. Intermissions auto-advance, so non-hosts
// see "starting soon" rather than a who-to-wait-on name.
function renderFoot(data, { hostPeerIndex, amHost, liveryOf }) {
  const btn = el('newgame-btn');
  const wait = el('result-wait');
  const s = data.series;
  const intermission = !!(s && !s.final && data.over);
  const quit = el('quitcup-btn');
  quit.classList.toggle('hidden', !(intermission && amHost));
  if (intermission) quit.textContent = s.endless ? 'Back to lobby' : 'End cup early';
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
