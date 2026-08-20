// The display gallery's scenario table — the ONE list of screens this game has.
//
// It was a `var` inside `public/gallery-display.js` until the screenshot gallery
// needed the same list from Node. Two hand-maintained copies of "what screens
// exist" is exactly the shape of thing that rots in one of them: the capture
// script would quietly stop shooting a screen the live gallery had grown, and
// the coverage check built on top would still be green. Both surfaces read this
// module — the live gallery mounts an iframe per entry, the capture script
// photographs one — so there is no second list to pin.
//
// DEPENDENCY-FREE ES MODULE, on the same terms as shared/tracks.js and
// shared/protocol.js — Node imports it directly (scripts/capture-shots.mjs,
// tests/shots-manifest.test.js) and so does the browser, so it may not reach for
// a DOM or a package.
//
// `id` is the screenshot's filename stem and must be unique across the table;
// `key` is the TestHarness scenario the display page actually runs, and several
// cards deliberately share one (the lobby, four ways).

export const GALLERY_SCENARIOS = [
  { id: 'welcome', key: 'welcome', title: 'Welcome', replayable: true },
  { id: 'lobby-loading', key: 'lobby-loading', title: 'Lobby (loading)' },
  { id: 'lobby-empty', key: 'lobby-empty', title: 'Lobby (waiting)', animated: true },
  {
    id: 'lobby-track', key: 'lobby', title: 'Lobby (track picked)',
    hostVariant: true, animated: true, params: { picked: 'track', track: 'driftwood' }
  },
  {
    id: 'lobby-tour', key: 'lobby', title: 'Lobby (tour picked)',
    hostVariant: true, animated: true, params: { picked: 'tour' }
  },
  {
    id: 'lobby-random', key: 'lobby', title: 'Lobby (random picked)',
    hostVariant: true, animated: true, params: { picked: 'random', track: 'powder' }
  },
  // TWO KINDS OF MOTION, and an entry declares whichever it has:
  //   animated    the SIM is the animation — a live scene that would otherwise
  //               render forever. The live gallery's preview becomes a
  //               play/pause surface over window.__preview and idles on one held
  //               frame until asked; the capture script lets it run on past the
  //               start grid before shooting.
  //   replayable  the DOM is the animation — an entrance slap-in, or the results
  //               board's race->standings turn. It plays once on arrival and is
  //               then over, so the live card gets a play button that runs it
  //               again through window.__TEST__.replay.
  // An entry with neither is a still. A capture ignores `replayable` entirely,
  // but it belongs here rather than in the page, so the two surfaces describe
  // one thing.
  { id: 'countdown', key: 'countdown', title: 'Countdown', replayable: true },
  { id: 'racing', key: 'racing', title: 'Race', animated: true },
  // Deck-decal check: hairpins force scrub skids and the pads sit on the racing
  // line, so one card shows every road-shader decal (contact shadows, boost
  // aura, rubber) accumulating under driving cars on a bendy road.
  {
    id: 'racing-sidewinder', key: 'racing', title: 'Deck decals',
    animated: true, params: { track: 'sidewinder' }
  },
  // THE ADAPTIVE SCALE, WATCHABLE — an instrument rather than a screen.
  //
  // Every other card on this page renders at `dpr` 0.5 (gallery-common.js caps
  // the preview so a grid of live scenes does not melt the machine), and a pinned
  // dpr switches the rule OFF. So the gallery already shows you the ladder's
  // bottom rung on every card, and none of them shows the rule doing anything.
  //
  // This one drops the pin: four cells, no `dpr`, so the band's ceiling is the
  // panel's own resolution and the operating point is decided from what the
  // frames actually cost (ttp/render_scale.h). A machine with the headroom to
  // hold four cells at its own resolution stays at native, and that is the
  // honest answer; anything else steps down and settles, with the readout in the
  // corner carrying the numbers it was judged on. Short of a weak television in
  // the room it is the only way to watch the mechanism work.
  //
  // FOUR CELLS WHATEVER THE PLAYER SELECTOR SAYS: the split IS the load — the
  // scene is drawn once per cell — and a one-cell version of this card
  // demonstrates nothing.
  //
  // LIVE ONLY, and not a gap in the capture. A shot is a still; this is a thing
  // that HAPPENS over several seconds, and a photograph of it is indistinguishable
  // from the Race card above at whatever rung the shutter happened to catch.
  {
    id: 'racing-adaptive', key: 'racing', title: 'Race (adaptive scale)',
    animated: true, liveOnly: true, params: { players: 4, dpr: null }
  },
  // …AND THE SAME THING PROVOKED, because the card above only demonstrates the
  // mechanism on a machine that cannot hold four cells at its own resolution,
  // and a developer's laptop can. `supersample=3` raises the band's CEILING to
  // three times the layout size — NINE TIMES the fill, past the panel's own
  // resolution and past MAX_BUFFER_H — so the opening frames genuinely cost more
  // than any machine can afford and the rule genuinely rescues them.
  //
  // NOTHING IS FAKED, and that is the whole reason it is built this way. The
  // obvious alternatives — a fabricated GPU cost, a declared panel period the
  // box cannot feed — both demonstrate the rule on invented numbers, and its
  // entire contract is that a shell hands over measurements and does not invent
  // them. Here the pixels are real, so the cost, the percentiles, the cost model
  // and the resize all are too.
  //
  // WHERE IT SETTLES IS THE ANSWER TO A REAL QUESTION: the rung this machine
  // holds four cells at. Watch it in the console — `[stage] scale …` is printed
  // on every move — or in the readout's buffer size.
  {
    id: 'racing-downscale', key: 'racing', title: 'Race (forced downscale)',
    animated: true, liveOnly: true,
    params: { players: 4, dpr: null, supersample: 3 }
  },
  { id: 'rocket', key: 'rocket', title: 'Rocket strike', animated: true },
  { id: 'monster', key: 'monster', title: 'Monster truck', animated: true },
  { id: 'paused', key: 'paused', title: 'Paused' },
  { id: 'reconnect', key: 'reconnect', title: 'Reconnect' },
  { id: 'finished', key: 'finished', title: 'Player finished' },
  // `settleMs` — WHICH MOMENT of a replayable card is the card. A capture waits
  // this long after the screen stands up before it shoots, and the three board
  // cards need it for the same reason: a cup board is TWO PHASES, and its second
  // one (the re-sort, the points counting up, the champion crowned) is the thing
  // the card is named after. Shot on arrival they photograph phase 1 — a "Cup
  // podium" card that has not yet crowned anybody. The countdown is replayable too
  // and wants the opposite, which is why this is per-entry rather than a rule about
  // `replayable`.
  { id: 'results', key: 'results', title: 'Results', replayable: true, settleMs: 1200 },
  {
    id: 'intermission', key: 'intermission', title: 'Cup intermission',
    replayable: true, settleMs: 4500
  },
  { id: 'chain', key: 'chain', title: 'Cup: race → next race', animated: true },
  { id: 'podium', key: 'podium', title: 'Cup podium', replayable: true, settleMs: 4500 }
];

// The scenarios a CAMERA sees, which is every screen minus the instruments.
//
// Derived rather than hand-listed, and read by all three capture scripts, the
// screens gallery and the coverage gate — so `liveOnly` is one flag in one place
// instead of an exclusion each of them remembers separately. The live gallery
// (`gallery-display.js`) deliberately reads the FULL table: an instrument is
// still a card you can look at.
export const CAPTURED_SCENARIOS = GALLERY_SCENARIOS.filter((s) => !s.liveOnly);

// The platforms a shot can come from. `web` is the reference the others are read
// against, which is why it is first and why the manifest test requires it — every
// other column is allowed to be partial, because a screen a platform deliberately
// does not have (the welcome board on a TV) is a gap the gallery should SHOW.
//
// Each TV platform carries both of its legs, and the pair is not redundant: the
// simulator/emulator is what a laptop can capture on demand, and the physical box
// is the only thing that answers for the panel, the output mode and the GPU. A
// column that silently mixed the two would make "has the TV drifted?" unanswerable.
export const SHOT_PLATFORMS = [
  'web',
  'tvos-device', 'tvos-sim',
  'androidtv-device', 'androidtv-emu'
];

// The display page's query string for a scenario, shared by the live gallery's
// iframes and the capture script's page loads so a card and its screenshot can
// never be showing different things.
export function scenarioQuery(scenario, { players = 4, host = 0, viewAs = 0 } = {}) {
  const q = new URLSearchParams({ scenario: scenario.key, players: String(players) });
  if (scenario.hostVariant) q.set('host', String(host));
  if (viewAs) q.set('viewAs', String(viewAs));
  // SKIPPED WHEN ABSENT, exactly as gallery-common.js's `qs` does it. A param of
  // null means "leave it off" — the live cards use `dpr: null` for that — and
  // `String(null)` would put a literal `?dpr=null` on a capture URL instead.
  // Harmless only by accident today (both such cards are liveOnly, so they never
  // reach here, and `parseFloat('null')` happens to be NaN), which is the kind of
  // correctness that stops holding the moment a card loses its flag.
  for (const [k, v] of Object.entries(scenario.params || {})) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  return q.toString();
}
