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
// cards deliberately share one (the lobby, four ways). A card without one is
// either a `page` (a standalone web URL rather than a display-page scenario) or
// `tvOnly` (a screen the web deliberately does not have — the TV harnesses
// decide their own gaps by refusing an id, and this flag is the web's refusal).

export const GALLERY_SCENARIOS = [
  { id: 'welcome', key: 'welcome', title: 'Welcome' },
  { id: 'lobby-loading', key: 'lobby-loading', title: 'Lobby (loading)' },
  // EVERY card that shows a circuit names it (`track`), or each TV shows whatever
  // its previous launch left as the saved pick — a different biome per platform.
  { id: 'lobby-empty', key: 'lobby-empty', title: 'Lobby (waiting)', animated: true,
    params: { track: 'tidepool' } },
  {
    id: 'lobby-track', key: 'lobby', title: 'Lobby (track picked)',
    hostVariant: true, animated: true, params: { picked: 'track', track: 'driftwood' }
  },
  {
    id: 'lobby-tour', key: 'lobby', title: 'Lobby (tour picked)',
    hostVariant: true, animated: true, params: { picked: 'tour', track: 'tidepool' }
  },
  {
    id: 'lobby-random', key: 'lobby', title: 'Lobby (random picked)',
    hostVariant: true, animated: true, params: { picked: 'random', track: 'powder' }
  },
  // MOTION IS THE SIM, and `animated` is the entry that declares it: a live
  // scene that would otherwise render forever, so the live gallery's preview
  // becomes a play/pause surface over window.__preview and idles on one held
  // frame until asked, and the capture script lets it run on past the start grid
  // before shooting.
  //
  // AN ENTRY WITHOUT IT IS A STILL, including every screen whose motion is DOM
  // (the welcome slap-in, the countdown banner, the results board's
  // race->standings turn). Those play once on arrival and are then over, and the
  // frame they settle into IS the card — which is also what the reference shots
  // hold and what a reduced-motion visitor sees on the first paint. There is no
  // replay surface: a card that offered one was a button whose only job was to
  // show an entrance a second time.
  // Held at race time 0: the grid, frozen, on every platform. A TV launch races
  // from GO, and its own GO clear one race-second later used to erase the banner
  // on a slow machine; a race that never steps never clears it.
  { id: 'countdown', key: 'countdown', title: 'Countdown', store: 7,
    params: { track: 'powder', seed: 1 }, hold: { simMs: 0 } },
  { id: 'racing', key: 'racing', title: 'Race', animated: true,
    params: { track: 'tidepool', seed: 1 }, hold: { simMs: 5000 } },
  // Deck-decal check: hairpins force scrub skids and the pads sit on the racing
  // line, so one card shows every road-shader decal (contact shadows, boost
  // aura, rubber) accumulating under driving cars on a bendy road.
  {
    id: 'racing-sidewinder', key: 'racing', title: 'Deck decals',
    animated: true, params: { track: 'sidewinder', seed: 1 }, hold: { simMs: 5000 }
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
  // THE STORE LISTING. `store: n` puts a card at position n of the App Store and
  // Play screenshot set: its shots are captured as STORE_SHOT (JPEG, the size
  // both stores take) instead of the gallery's WebP, and the screens gallery
  // zips them per platform. So the listing IS these gallery cards, and there is
  // no second set of store pictures to fall out of step with them.
  //
  // One race per cup, because five cups are five looks and a listing that shows
  // one of them sells a smaller game; the seat counts vary for the same reason.
  //
  // `hold` — WHICH RACE MOMENT the card is, frozen by the engine itself
  // (native/libttp-runtime/ttp/shot_hold.h, armed through ttp_shot_hold). A wall-
  // clock settle landed each platform at a different race time, and the chase
  // camera's distance depends on speed, so the same card came back with a
  // different camera per platform. Every capture passes the hold through
  // unchanged and shoots once the engine reports it held.
  //
  // `seed` pins the race's item/wander seed on every platform (the TV launches
  // are otherwise random), and a held race steps in fixed increments, so a card
  // is the SAME race everywhere, not merely the same moment of one.
  { id: 'race-beach', key: 'racing', title: 'Beach Cup race', animated: true, store: 1,
    params: { track: 'tidepool', players: 4, seed: 1 }, hold: { simMs: 5000 } },
  { id: 'race-snow', key: 'racing', title: 'Snow Cup race', animated: true, store: 2,
    params: { track: 'glacier', players: 2, seed: 1 }, hold: { simMs: 5000 } },
  { id: 'race-backyard', key: 'racing', title: 'Backyard Cup race', animated: true, store: 3,
    params: { track: 'pretzel', players: 4, seed: 1 }, hold: { simMs: 5000 } },
  { id: 'race-canyon', key: 'racing', title: 'Canyon Cup race', animated: true, store: 4,
    params: { track: 'crag', players: 1, seed: 1 }, hold: { simMs: 5000 } },
  { id: 'race-playroom', key: 'racing', title: 'Playroom Cup race', animated: true, store: 5,
    params: { track: 'skyline', players: 4, seed: 1 }, hold: { simMs: 5000 } },
  // The item cards hold on the EVENT: a rocket crosses the road in a few frames,
  // so the card is the hit car spun out (sim state, which the freeze keeps — the
  // burst ring is the renderer's and fades on its own clock), and the monster
  // card is a player's own car grown into the truck. The cap stops a run whose
  // item never lands instead of hanging the capture.
  // Each names its circuit too, or every platform races its own default track.
  { id: 'rocket', key: 'rocket', title: 'Rocket strike', animated: true, store: 6,
    params: { track: 'powder', seed: 1 }, hold: { simMs: 1500, on: 'rocket', afterMs: 400, capMs: 30000 } },
  { id: 'monster', key: 'monster', title: 'Monster truck', animated: true, store: 8,
    params: { track: 'driftwood', seed: 1 }, hold: { simMs: 1500, on: 'monster', afterMs: 600, capMs: 30000 } },
  // The scripted-beat cards (pause, a dropped seat, a finisher) hold too, and the
  // beat runs AFTER the hold: a wall-clock delay put a slow TV's beat at the start
  // line with GO still up. The moments sit just under the web preview's own spin
  // (90 or 160 steps of 33 ms), so its fixed steps reach them.
  { id: 'paused', key: 'paused', title: 'Paused', params: { track: 'tidepool', seed: 1 },
    hold: { simMs: 2900 } },
  // THE DISPLAY'S OWN LINK, over the empty lobby: the two states of the
  // connection overlay (the `set-link` effect). `reconnecting` is the kit's
  // counter mid-backoff; `disconnected` is the spent budget with the one
  // focusable control on the glass, which is the card that shows each
  // platform's focus ring.
  { id: 'reconnecting', key: 'reconnecting', title: 'Reconnecting', params: { track: 'tidepool' } },
  { id: 'disconnected', key: 'disconnected', title: 'Disconnected', params: { track: 'tidepool' } },
  // The reconnect QR is sized off the CELL (display.css .cell-reconnect): half
  // the screen's height for one player, most of the cell in a split. Two cards,
  // because a capture shoots every card at four players unless the table pins
  // a count — the solo case is the other arm of the rule, and a column that
  // photographs only the split arm never shows it.
  { id: 'reconnect', key: 'reconnect', title: 'Reconnect', params: { track: 'tidepool', seed: 1 },
    hold: { simMs: 2900 } },
  { id: 'reconnect-solo', key: 'reconnect', title: 'Reconnect (one player)',
    params: { players: 1, track: 'tidepool', seed: 1 }, hold: { simMs: 2900 } },
  { id: 'finished', key: 'finished', title: 'Player finished', params: { track: 'tidepool', seed: 1 },
    hold: { simMs: 5200 } },
  // `settleMs` — WHICH MOMENT of a still card is the card. A capture waits this
  // long after the screen stands up before it shoots, and the three board cards
  // are the only ones that want a later one: a cup board is TWO PHASES, and its
  // second (the re-sort, the points counting up, the champion crowned) is the
  // thing the card is named after. Shot on arrival they photograph phase 1 — a
  // "Cup podium" card that has not yet crowned anybody. Per entry, not a rule
  // about stills, because the countdown wants the opposite: its banner settles
  // on the first frame and never turns.
  //
  // The two cup budgets are phase 1 (RACE_PHASE_MS) plus the tally, which runs
  // one tick per point the WINNER owes — so WIDENING POINTS_BY_RANK LENGTHENS
  // THEM, and the slack left over is what absorbs a capture machine under load.
  { id: 'results', key: 'results', title: 'Results', settleMs: 1200, params: { track: 'tidepool', seed: 1 } },
  { id: 'intermission', key: 'intermission', title: 'Cup intermission', settleMs: 5200,
    params: { track: 'tidepool', seed: 1 } },
  // LIVE ONLY: a SEQUENCE (finish, the board, the next launch), and any one frame
  // of it is a picture of whichever beat the shutter caught.
  { id: 'chain', key: 'chain', title: 'Cup: finish → results → next race', animated: true, liveOnly: true },
  { id: 'podium', key: 'podium', title: 'Cup podium', settleMs: 5200, params: { track: 'tidepool', seed: 1 } },
  // THE INFO BRANCH: the two boards behind the lobby's ⓘ on both TVs. Neither
  // is a screen the WEB DISPLAY has. Its legal links sit in the welcome board's
  // footer, which the `welcome` card already carries, so `info` is `tvOnly`:
  // no web shot, and the web pane shows the gap — the same honest record the
  // TV panes give `welcome`. Its licenses are a PAGE of their own rather than
  // a board, so `licenses` names the URL the web camera opens instead of a
  // harness key. Neither runs the sim, and neither is a card on the LIVE
  // gallery, which mounts the display page and nothing else.
  { id: 'info', title: 'Info board', tvOnly: true },
  { id: 'licenses', title: 'Licenses', page: '/licenses.html' }
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
// ONE COLUMN PER TV, whichever machine took the shot. A scenario keeps its most
// recent capture, from the physical box or the simulator/emulator alike, and each
// manifest row names the device and its `deviceKind` so the gallery can say which.
// Two columns per TV used to mean two photographs of every screen to keep fresh,
// and in practice one of them was always older than the other.
export const SHOT_PLATFORMS = ['web', 'tvos', 'androidtv'];

// What a `store` card is captured as: the one size and format both the App Store
// (tvOS) and Play (Android TV) accept, neither of which takes WebP.
export const STORE_SHOT = { w: 1920, h: 1080, ext: 'jpg' };

// The listing, in store order.
export const STORE_SCENARIOS = CAPTURED_SCENARIOS
  .filter((s) => s.store)
  .sort((a, b) => a.store - b.store);

// The display page's query string for a scenario — the CAPTURE script's URL
// builder. The live gallery builds its iframe URLs itself (cardURL in
// gallery-common.js, which layers preview-only dpr/host handling on top), so
// this is kept param-compatible with its `qs` rather than shared by it.
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
