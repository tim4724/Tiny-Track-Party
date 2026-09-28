// Trailer editor — build the cut against the LIVE game, and render only at the end.
//
// The monitor is an ordinary <iframe> of the display's own test harness, same-origin,
// so this page can reach straight into its `window.__scene` and drive it. That is the
// whole trick: a shot is not a video file to be produced and reviewed, it is the real
// game running under a clock this page owns.
//
// WHY IT MATCHES THE RENDER. scripts/trailer/render.js advances the scene by exactly
// one fixed step per frame and never lets it free-run (see its GATE note). This page
// steps the same way — Stage.stop() to take the loop off rAF, setFixedStep(1/60), then
// start()+pauseAfterFrame() per frame — so the sim time shown here is the sim time the
// renderer will reproduce. An in-point marked at 12.40s renders as warmup: 12.4.
//
// Speed multiplies STEPS PER ANIMATION FRAME, never the step size. A bigger dt would be
// a different simulation, and the in-point would land somewhere else in the render.
//
// The shot list lives in localStorage and is exported by copy/paste; the committed
// scripts/trailer/shots.js comes back in through a read-only JSON endpoint. Writing it
// to disk would need a mutating endpoint, and server/index.js serves static files and
// JSON reads only — see CLAUDE.md.

import { CUPS, TRACK_LIST } from '/shared/tracks.js';

// The harness's two item showcases ('rocket', 'monster') are deliberately not offered:
// they force the roulette and hand the item to whoever is armed — a monster truck in
// second place included — which is not a race the game would run. A real race's items
// land where the catch-up rules put them, and the timeline marks where (see survey).
const SCENARIOS = ['racing', 'chain'];
const SPLITS = [1, 2, 4];
const STORE = 'ttp-trailer-edit';
// Sim time is COUNTED IN STEPS and divided, never accumulated. Adding 1/60 repeatedly
// drifts: 300 of them come to 4.999999999999998, so a wind to 5.0 takes one step too
// many and the editor sits two frames past where the renderer will be. render.js turns
// seconds into steps with Math.round(seconds * FPS), and this has to agree exactly.
const FPS = 60;
const STEP = 1 / FPS;
// The monitor's buffer scale. The engine holds 60 fps at a full 3840x2160, and a monitor
// a thousand-odd CSS px wide at 2x is a fraction of that, so there is no reason to look
// at a soft picture; 2 is also the renderer's own pixel-ratio cap. A wind draws only its
// last frame (spend), so there is no cheaper scale left to drop to for it.
const VIEW_DPR = 2;

const NAME_OF = new Map(TRACK_LIST.map((t) => [t.id, t.name]));
const CUP_OF = new Map(TRACK_LIST.map((t) => [t.id, t.cupName]));

const $ = (sel) => document.querySelector(sel);
const el = {
  shots: $('#shots'), add: $('#add'), total: $('#total'), status: $('#status'),
  wrap: $('#frame-wrap'), clock: $('#clock'), marks: $('#marks'),
  play: $('#play'), toIn: $('#to-in'), setIn: $('#set-in'),
  playCut: $('#play-cut'), export: $('#export'), import: $('#import'),
  rec: $('#rec'), barIn: $('#bar-in'), barNow: $('#bar-now'), bar: $('#bar'), events: $('#bar-events'),
  followBox: $('#follow'), slowmo: $('#slowmo'),
};

// ---- the edit ---------------------------------------------------------------

const DEFAULT_SHOT = { track: 'ribbon', players: 4, scenario: 'racing', warmup: 20, seconds: 3 };

// The edit in progress, or nothing: a fresh editor starts from the COMMITTED cut
// (loadCommitted below), so there is no second starter list to drift from shots.js.
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (_) { /* corrupt or absent */ }
  return [];
}

let shots = load();
let liveIndex = -1;          // which shot the monitor holds
const save = () => localStorage.setItem(STORE, JSON.stringify(shots));

// ---- the monitor ------------------------------------------------------------
//
// Two iframes: the one on screen, and one warming up behind it. Booting a display is
// seconds of wasm + GLB load, so playing a cut would stutter at every join if each shot
// waited for its own boot.

let liveFrame = null;    // { iframe, scene, shot, time, ready }
let nextFrame = null;
let pump = null;         // rAF handle for the stepping loop
let playing = false;
// FOLLOW is the default, and it is what makes the monitor a preview of the trailer
// rather than a preview of a race: selecting a shot winds to its in-point, and reaching
// the out-point moves to the next shot. Turn it off to go hunting for a new in-point,
// which is the only time you want the race to keep running past the end of the shot.
let follow = true;
let outAt = Infinity;    // sim time this shot stops at, while following

// gate=1 is what makes this monitor show the same race the renderer will produce. The
// display then draws NO frame until pumped, from boot onward — including the frame the
// harness paints to hold a framed preview, which otherwise advances the sim by a
// wall-clock dt nobody can reproduce and leaves the editor a few frames off the render
// forever after. See public/display/frameGate.js.
const urlFor = (shot) => `/?test=1&gate=1&scenario=${shot.scenario}&players=${shot.players}` +
  `&track=${shot.track}&dpr=${VIEW_DPR}`;

// Everything on the display that is page chrome rather than the GAME. The monitor has
// to show what the render will show, and the corner buttons in particular land square
// on the top-right cell's place chip in a 2x2 grid. scripts/trailer/render.js hides the
// same set for the same reason — change one, change the other.
function hideChrome(w) {
  try {
    for (const sel of ['#corner-btns', '.dbg-fab', '#sound-hint', '#toast', '.cam-hint']) {
      for (const node of w.document.querySelectorAll(sel)) node.style.display = 'none';
    }
  } catch (_) { /* frame torn down mid-boot */ }
}

// Mount a frame and resolve once its scene is stepping under OUR clock.
function mount(shot) {
  const iframe = document.createElement('iframe');
  iframe.src = urlFor(shot);
  el.wrap.appendChild(iframe);
  const frame = {
    iframe, shot, scene: null, steps: 0, ready: false,
    events: [],                   // the race's moments, from the survey
    // What this race was actually dealt with. The shot object it came from is mutable —
    // changing its track edits it in place — so a frame has to remember its own terms
    // rather than be asked to re-read them.
    mounted: { track: shot.track, players: shot.players, scenario: shot.scenario },
    get time() { return this.steps / FPS; },
  };

  frame.boot = new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const w = iframe.contentWindow;
      const scene = w && w.__scene;
      // __engine too: the harness builds the field after the GLBs land, and a scene
      // without cars steps a race that has not been dealt yet. __preview is the
      // harness's restart and event log (TestHarness.js previewControl).
      if (scene && w.__engine && w.__pump && w.__preview && scene.cars && scene.cars.size) {
        clearInterval(poll);
        scene.stop();                 // the gate means nothing has drawn yet anyway
        scene.setFixedStep(STEP);
        frame.pump = w.__pump;
        hideChrome(w);
        frame.scene = scene;
        frame.ready = true;
        resolve(frame);
      } else if (Date.now() - started > 60000) {
        clearInterval(poll);
        resolve(frame);               // ready stays false; the caller reports it
      }
    }, 120);
  }).then(async (f) => { if (f.ready) await survey(f); return f; });
  return frame;
}

// THE WHOLE RACE, SURVEYED UP FRONT. A freshly booted frame runs its race to the end
// without drawing and deals it again — so the timeline is the whole race at one fixed
// scale, every rocket, transform and hit already on it, before the first frame is looked
// at. The moments are the harness's own event log (window.__preview.events): the sim's
// word on when a rocket went, a truck grew or a camera car was struck, frame-exact, with
// no snapshot to diff. A survey is the sim alone at a fraction of a millisecond a step,
// so a three-lap race is a couple of seconds; it takes the slices a wind takes, so a shot
// already playing keeps its frame rate. The end is the harness dealing the NEXT race —
// its endless preview re-deals at the flag, and the chain preview launches the next leg
// after its board — so the surveyed race is exactly what the monitor can show.
const SURVEY_CAP = 300 * FPS;   // a race that never ends still gets a bar
async function survey(frame) {
  const w = frame.iframe.contentWindow;
  const deal = w.__preview.deal();
  const same = () => w.__preview.deal() === deal && frame.steps < SURVEY_CAP;
  while (same()) {
    const until = performance.now() + (playing ? PREWIND_MS : WIND_MS);
    while (same() && performance.now() < until) step(frame, false);
    if (frame === liveFrame) setStatus(`surveying the race — ${frame.time.toFixed(0)}s`);
    // A macrotask, not an animation frame: the browser stops animation frames for a
    // window another window covers — the video player just opened over this one, say —
    // and a survey paced by them then crawls at one slice a second.
    await new Promise((r) => setTimeout(r, 0));
  }
  frame.raceLen = frame.time;
  // A hit is a rocket landing on a CAMERA car: that is the shot; one passing by is not.
  const cells = new Set(frame.scene._order);
  frame.events = w.__preview.events().filter((e) => e.deal === deal).flatMap((e) => {
    if (e.type === 'item_use' && (e.item === 'rocket' || e.item === 'monster')) return [{ t: e.t, kind: e.item }];
    if (e.type === 'spin' && e.cause === 'rocket' && cells.has(e.id)) return [{ t: e.t, kind: 'hit' }];
    return [];
  });
  restart(frame);
  if (frame === liveFrame) paintEvents(frame);
}

// Redraw the frame that is on screen WITHOUT advancing anything. The display's WebGL
// context does not preserve its drawing buffer, so a canvas that stops being drawn
// composites black — pausing used to blank the monitor, and so did the hold at a join.
// Display.repaint() is frame(0): the same picture, presented again. Stage hits the same
// trap when a preview is idled by pauseAfterFrame (see its _onResize note).
function repaint(frame) {
  try { frame.scene.display.repaint(); } catch (_) { /* not built yet, or torn down */ }
}

// One fixed step: arm, halt-after-next, then actually run it. Mirrors render.js.
//
// The pump is the display's own, installed by ?gate=1 before it drew anything.
// WITHOUT IT THE CLOCK LIES: start()+pauseAfterFrame() only SCHEDULES a frame, so a
// synchronous loop calling it N times produces ONE frame while counting N — measured at
// exactly 2x, which put every in-point at twice the race it claimed. Pumping makes one
// call mean one frame, and lets a wind run many frames per animation frame instead of
// being capped at the monitor's refresh rate.
//
// UNDRAWN (`draw` false) is the same step through the same loop with the GPU left out
// (Stage.setUndrawn): the sim lands bit-identical, the renderer's own state — chase
// rigs, props, the skid stamps — moves on with it, and it costs a fiftieth of a drawn
// step, because the cost of a step is the GPU. A wind draws only the frame it arrives
// on; the renderer catches its rubber layer up on that frame.
function step(frame, draw = true) {
  const s = frame.scene;
  if (!s || !frame.pump) return;
  s.setUndrawn(!draw);
  s.start();
  s.pauseAfterFrame();
  frame.pump(STEP * 1000);
  frame.steps++;
}

// Deal the frame's race again, in place. The harness exposes exactly the re-deal it
// runs when a preview race laps, so this is the same race from zero without a page boot.
// The timeline stays: it is the survey's, and the same race puts the same events back.
function restart(frame) {
  frame.iframe.contentWindow.__preview.restart();
  frame.steps = 0;
}

function stopPump() {
  if (pump) cancelAnimationFrame(pump);
  pump = null;
}

// PLAYBACK FOLLOWS THE WALL CLOCK, not the animation-frame count. Stepping once per
// animation frame silently turns any dropped frame into slow motion — the sim advances
// 1/60 s whether the frame took 16 ms or 40 — and the background pre-wind drops exactly
// enough frames to make the first second of a shot visibly slow. Owing steps against
// real elapsed time instead means a busy tick costs a DRAWN frame, not sim time.
//
// The backlog is dropped rather than carried when it exceeds the cap: a machine that
// cannot keep up should run slow, not accumulate a debt it then sprints through.
// How many steps one animation frame may run to make up for a slow one. Enough to
// absorb a hiccup, low enough that a long stall is dropped rather than sprinted through.
const CATCHUP_CAP = 4;
// Watching speed, and ONLY watching speed. 0.5 runs half as many steps per second of
// wall clock; every one of them is still a 1/60 s step, so the race is identical and an
// in-point marked in slow motion is the same frame the renderer produces. Scaling dt
// instead would be a different simulation.
let rate = 1;
let lastTick = 0;
let owed = 0;

function runPump() {
  stopPump();
  lastTick = performance.now();
  owed = 0;
  const tick = (now) => {
    pump = requestAnimationFrame(tick);
    if (!liveFrame || !liveFrame.ready) { lastTick = now; return; }
    if (!playing) { lastTick = now; repaint(liveFrame); prewindTick(); paintClock(); return; }

    owed += ((Math.min(now - lastTick, 250)) / (STEP * 1000)) * rate;
    lastTick = now;
    let n = Math.min(Math.floor(owed), CATCHUP_CAP);
    owed = Math.floor(owed) > CATCHUP_CAP ? 0 : owed - n;
    while (n-- > 0 && liveFrame.time < outAt) step(liveFrame);

    // Only feed the waiting shot once the visible one is on time. Starving the picture
    // to get ahead on a shot nobody is looking at yet is the wrong trade.
    if (owed < 1) prewindTick();
    paintClock();
    if (follow && liveFrame.time >= outAt) toNextShot();
  };
  pump = requestAnimationFrame(tick);
}

// The in-point is the whole point of the editor and it used to be a line of small grey
// text, which is why it read as doing nothing. Three readouts now agree: the clock, a
// scrub bar with the kept span marked on it, and a badge over the picture that is only
// lit while the frames being drawn are frames that will end up in the trailer.
function paintClock() {
  if (!liveFrame) return;
  const t = liveFrame.time;
  const s = liveFrame.shot;
  const inAt = +s.warmup;
  const outAt = inAt + +s.seconds;
  const live = t >= inAt && t <= outAt;

  el.clock.textContent = `${t.toFixed(2)}s`;
  el.clock.classList.toggle('is-live', live);
  el.rec.classList.toggle('is-on', live);
  el.marks.textContent = live
    ? `IN SHOT — ${(t - inAt).toFixed(1)}s of ${(+s.seconds).toFixed(1)}s`
    : t < inAt
      ? `before the in-point — ${(inAt - t).toFixed(1)}s to go`
      : `past the out-point by ${(t - outAt).toFixed(1)}s`;

  const span = barSpan();
  el.barIn.style.left = `${(inAt / span) * 100}%`;
  el.barIn.style.width = `${((outAt2(s) - inAt) / span) * 100}%`;
  el.barNow.style.left = `${Math.min((t / span) * 100, 100)}%`;
}

// The race's moments over the scrub bar, from the survey, on the bar's own fixed scale.
// Built when a frame takes the monitor and when its survey answers; a marker clicked
// seeks to its frame.
const EVENT_GLYPH = { rocket: '🚀', monster: '🛻', hit: '💥' };
function paintEvents(frame) {
  const span = barSpan();
  el.events.replaceChildren(...frame.events.map((ev) => {
    const m = document.createElement('button');
    m.className = 'bar-events__ev';
    m.style.left = `${Math.min((ev.t / span) * 100, 100)}%`;
    m.textContent = EVENT_GLYPH[ev.kind];
    m.title = `${ev.kind} at ${ev.t.toFixed(2)}s — click to seek`;
    m.onclick = () => seekTo(ev.t);
    return m;
  }));
}

const outAt2 = (s) => +s.warmup + +s.seconds;

// THE BAR IS THE WHOLE RACE, at one scale: the length the survey found, from the grid
// to the harness's next deal. It does not grow with the playhead or move with the
// in-point, so a marker stays where it was and a click means the same second it did
// a moment ago. Before the survey has answered there is nothing to scale to yet.
function barSpan() {
  return (liveFrame && liveFrame.raceLen) || 60;
}

function setStatus(text) {
  el.status.textContent = text;
  el.status.classList.toggle('is-hidden', !text);
}

// Arm the stop point for the shot in the monitor. Only meaningful while following —
// scouting deliberately runs past the end of the shot, which is how a later in-point
// gets found in the first place.
function armOut() {
  const s = shots[liveIndex];
  outAt = follow && s ? +s.warmup + +s.seconds : Infinity;
}

// Load a shot into the monitor, reusing the preloaded frame when it is the right one.
// While following, this lands ON the in-point: the monitor is showing the trailer.
// TWO WAYS A SHOT ARRIVES, and they want opposite things.
//
// PICKED (`swapFirst`) — you clicked it, so the monitor changes NOW, before any race is
// wound. Waiting for the in-point first is what made the rack feel like it hung: the
// click did nothing visible for seconds while the OLD shot stayed up. Any preparing then
// happens on the shot you asked for, where it reads as that shot getting ready.
//
// REACHED (during playback) — the cut ran into it, and the join has to be seamless, so
// the outgoing shot holds its last frame until the incoming one is at its in-point and
// the swap is invisible.
async function show(index, { preloadNext = true, wind = follow, swapFirst = false } = {}) {
  const shot = shots[index];
  if (!shot) return;
  liveIndex = index;

  // SCOUTING STARTS AT ZERO. With follow off you are looking for a moment, so the race
  // has to begin at the beginning — landing wherever the cached race happened to be left
  // is useless for that. A simulation only runs forward, so "back to 0" means dealing it
  // again; the cached frame stays and deals it in place.
  const cached = frames.get(keyOf(shot));
  if (!wind && cached && cached.ready && cached.steps > 0) restart(cached);
  if (liveFrame && liveFrame.ready && sameShot(liveFrame.mounted, shot)) {
    // Already showing this exact race, and not resetting: keep it, move the playhead.
    // Frames are cached by track|players|scenario, so this can be a DIFFERENT shot
    // than the one the frame was mounted for — repoint it, or the clock, the kept
    // span on the bar and "Wind to in" keep reading the old shot's in/out.
    liveFrame.shot = shot;
    paintShots();
    if (preloadNext && shots[index + 1]) preload(shots[index + 1]);
    if (wind) await windTo(+shot.warmup);
    armOut();
    return;
  }

  const incoming = acquire(shot);
  incoming.shot = shot;          // a cached frame may have been mounted for another shot
  if (incoming === nextFrame) nextFrame = null;
  const goal = Math.round((+shot.warmup || 0) * FPS);

  if (swapFirst) {
    // Put it up immediately, ready or not: a cached frame appears at once, a fresh one
    // shows its own loading rather than freezing the previous shot.
    swapTo(incoming, index);
    setStatus(incoming.ready ? '' : `loading ${NAME_OF.get(shot.track) || shot.track}…`);
  }

  await incoming.boot;
  if (liveIndex !== index) return;                    // moved on; the frame stays cached
  if (!incoming.ready) {
    frames.delete(keyOf(shot));
    destroy(incoming);
    setStatus(`could not load ${shot.track}`);
    return;
  }

  if (!swapFirst && wind && incoming.steps < goal) {
    await windHidden(incoming, goal);
    if (liveIndex !== index) return;
  }

  if (!swapFirst) swapTo(incoming, index);

  for (const b of [el.play, el.toIn, el.setIn]) b.disabled = false;
  setStatus('');
  outAt = Infinity;              // never stop mid-wind
  runPump();

  if (preloadNext && shots[index + 1]) preload(shots[index + 1]);
  if (wind) await windTo(+shot.warmup);
  if (liveIndex !== index) return;
  armOut();
}

// Put a frame on the monitor. The one coming off is shelved, not destroyed — its race is
// worth keeping for the next time that shot is picked.
function swapTo(frame, index) {
  const outgoing = liveFrame;
  liveFrame = frame;
  liveIndex = index;
  frame.iframe.classList.add('is-live');
  if (outgoing && outgoing !== frame) shelve(outgoing);
  paintShots();
  paintClock();
  paintEvents(frame);
}

// Run a HIDDEN frame up to its in-point, off screen, while whatever is on the monitor
// stays there. No status overlay: from the viewer's side the previous shot is simply
// holding its last frame, which reads as a hold rather than as a stall.
async function windHidden(frame, goal) {
  // Nothing on the monitor is moving — it holds the outgoing shot's last frame — so stop
  // the pump rather than let it keep stepping a frozen frame and a second wind alongside
  // this one. That contention was most of the frame-rate collapse at a join.
  stopPump();
  const from = frame.steps;
  const t0 = Date.now();
  while (frame.steps < goal) {
    spend(frame, goal, WIND_MS);
    if (liveFrame) repaint(liveFrame);   // the held shot must not blank while we wind
    // Silent for a brief wind — it reads as a deliberate hold. A long one has to say
    // something, or a six-second wait looks like a hang.
    if (Date.now() - t0 > 400) {
      const pct = Math.round(((frame.steps - from) / Math.max(goal - from, 1)) * 100);
      setStatus(`preparing next shot — ${pct}%`);
    }
    await new Promise((r) => requestAnimationFrame(r));
    if (Date.now() - t0 > 120000) break;
  }
  setStatus('');
  runPump();
}

// End of a shot while following: roll into the next one, or stop at the end of the cut.
// Guarded because the pump keeps ticking while this awaits, and every one of those ticks
// still sees the outgoing frame parked on its out-point — without the flag each would
// start another advance.
let advancing = false;

async function toNextShot() {
  if (advancing) return;
  const next = liveIndex + 1;
  if (next >= shots.length) {
    playing = false;
    paintPlay();
    setStatus('end of cut');
    return;
  }
  advancing = true;
  try { await show(next); } finally { advancing = false; }
}

const sameShot = (a, b) => a && b && a.track === b.track && a.players === b.players && a.scenario === b.scenario;

// KEEP THE RACES WE HAVE ALREADY RUN. A shot costs seconds of simulation to reach its
// in-point, and throwing that away the moment the monitor moves on means paying it again
// on the way back — which is what made clicking around the rack feel like it was always
// preparing. Frames are cached by what they were dealt with, so a shot is set up once and
// re-selecting it is instant.
//
// Capped and evicted least-recently-used, because each frame is a live WebGL context and
// browsers hand out a limited number: past roughly a dozen, the oldest gets killed and a
// dead context is far worse than a re-wind. Four covers moving between neighbouring shots
// while editing.
//
// Editing a shot's track, split or scenario changes its key, so the stale frame simply
// stops being asked for and ages out. Editing only the in-point keeps the frame and
// re-winds it, which is the cheap case.
const MAX_FRAMES = 4;
const frames = new Map();      // key -> frame, in least-recently-used order

const keyOf = (shot) => `${shot.track}|${shot.players}|${shot.scenario}`;

function acquire(shot) {
  const key = keyOf(shot);
  const held = frames.get(key);
  if (held) { frames.delete(key); frames.set(key, held); return held; }   // touch: now newest
  const frame = mount(shot);
  frames.set(key, frame);
  for (const [k, f] of frames) {
    if (frames.size <= MAX_FRAMES) break;
    if (f === liveFrame || f === frame) continue;
    frames.delete(k);
    destroy(f);
  }
  return frame;
}

// Boot the next shot's display AND run its race up to its in-point, both while the
// current shot is still playing, so a join has nothing left to do.
function preload(shot) {
  const frame = acquire(shot);
  nextFrame = frame;
  frame.windGoal = Math.round((+shot.warmup || 0) * FPS);
}

// Give the waiting frame a slice of this animation frame. Budget rather than a fixed
// count: what matters is arriving before the cut does, and a shot with a 47 s in-point
// needs far more per tick than one with 5 s. Capped so a distant in-point cannot starve
// the picture that is actually on screen.
// BUDGETED IN MILLISECONDS, not steps, because a step's cost is not something this file
// can predict: an undrawn one is a tenth of a millisecond, a drawn one is a few, and
// which a wind is doing changes as it nears its goal. A fixed count of them is a fixed
// gamble on the machine — sixteen drawn steps came to 38 ms of a 16 ms frame, which is
// what dropped the editor to 25 fps.
//
// A time slice self-limits instead: whatever a step costs, the tick stays inside its
// budget and the page stays at 60.
const PREWIND_MS = 2;    // per animation frame, while something is playing
const WIND_MS = 30;      // while the picture is held and only the wind is happening

// What a step actually costs here, learned rather than assumed — it varies with the
// track, the split, the machine and the drawn/undrawn mix, and the decision below is
// only as good as this.
let msPerStep = 3;

// Undrawn but for the last step, the one that is looked at (see step).
function spend(frame, goal, ms) {
  const t0 = performance.now();
  const from = frame.steps;
  const until = t0 + ms;
  while (frame.steps < goal && performance.now() < until) step(frame, frame.steps + 1 === goal);
  const n = frame.steps - from;
  if (n > 0) msPerStep = msPerStep * 0.8 + ((performance.now() - t0) / n) * 0.2;
}

// Pre-winding only pays if it FINISHES. Winding part of the way there does not shorten
// the hold at the join by anything anyone notices; it just spends the shot's own frames
// doing it, which measured as 60 fps falling to 29 back when every step was drawn.
//
// So: work out whether the remaining shot can cover it at the budget we are willing to
// spend, and if it cannot, do nothing and let the join take an honest hold. Paused is the
// exception — with no picture to protect, wind as fast as the slice allows.
function prewindTick() {
  const f = nextFrame;
  if (!f || !f.ready || !f.pump || f.steps >= f.windGoal) return;
  if (playing && liveFrame) {
    const ticksLeft = (Math.max(0, outAt - liveFrame.time) * FPS) / rate;
    const affordable = ticksLeft * (PREWIND_MS / Math.max(msPerStep, 0.1));
    if (f.windGoal - f.steps > affordable) return;
  }
  spend(f, f.windGoal, playing ? PREWIND_MS : WIND_MS);
}

// Take a frame off the monitor. It STAYS in the cache — that is the whole point — so
// this only hides it.
function shelve(frame) {
  if (!frame || frame === liveFrame) return;
  frame.iframe.classList.remove('is-live');
}

// Actually destroy one, releasing its WebGL context. Only eviction and a failed boot do
// this; everything else shelves.
function destroy(frame) {
  if (!frame) return;
  try { frame.scene && frame.scene.stop(); } catch (_) { /* already torn down */ }
  frame.iframe.remove();
}

// SEEKING A SIMULATION. There is no seek — a race has no frame to jump to, only a state
// reached by stepping. So forward is a wind, and backward is the same race dealt again
// in place (restart) and wound forward from zero. A wind is undrawn but for the frame
// it arrives on (step), so either direction is a fraction of a second.
//
// Nothing in the ABI serialises a session, and nothing needs to: a re-simulation is
// cheaper than a restore would be to prove bit-exact.
let winding = false;

async function windTo(target) {
  if (!liveFrame || !liveFrame.ready || winding) return;
  winding = true;
  // The playback pump steps too. Leave it running and it races the wind loop, and the
  // wind overshoots by however many frames the pump got in — which landed each shot a
  // few frames past its own in-point.
  stopPump();
  try {
    // Backward: deal the race again and re-run it.
    if (liveFrame.steps > Math.round(target * FPS)) restart(liveFrame);
    // Steps, not seconds — the same conversion render.js makes, so both land on the
    // identical frame rather than within a step of each other.
    const goal = Math.round(target * FPS);
    if (liveFrame.steps === goal) return;   // a preloaded shot arrives already wound
    const from = liveFrame.steps;
    const t0 = Date.now();
    while (liveFrame.steps < goal) {
      spend(liveFrame, goal, WIND_MS);
      prewindTick();      // the pump is stopped in here, so keep the next shot moving too
      const pct = Math.round(((liveFrame.steps - from) / Math.max(goal - from, 1)) * 100);
      setStatus(`winding to ${target.toFixed(1)}s — ${liveFrame.time.toFixed(1)}s (${pct}%)`);
      paintClock();
      await new Promise((r) => requestAnimationFrame(r));
      if (Date.now() - t0 > 120000) break;
    }
    setStatus('');
    paintClock();
  } finally {
    winding = false;
    runPump();
  }
}

const toIn = () => (liveFrame ? windTo(+liveFrame.shot.warmup) : Promise.resolve());

// ---- playing the whole cut ---------------------------------------------------

function paintPlay() {
  el.play.textContent = playing ? 'Pause' : 'Play';
  el.playCut.textContent = playing && follow ? 'Stop' : 'Play from top';
  paintShots();
}

// Run the cut from the first shot. Following is what makes it a cut rather than a race,
// so this turns it back on if it was off for scouting.
async function playFromTop() {
  if (!shots.length) return;
  follow = true;
  el.followBox.checked = true;
  playing = true;
  paintPlay();
  await show(0);
}

// ---- rendering the rack ------------------------------------------------------

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label; o.selected = String(selected) === String(value);
  return o;
}

function trackSelect(shot, onChange) {
  const sel = document.createElement('select');
  for (const cup of CUPS) {
    const g = document.createElement('optgroup');
    g.label = cup.name;
    for (const id of cup.tracks) g.appendChild(option(id, NAME_OF.get(id) || id, shot.track));
    sel.appendChild(g);
  }
  sel.onchange = () => onChange('track', sel.value);
  return sel;
}

function pick(values, key, shot, onChange, fmt = (v) => v) {
  const sel = document.createElement('select');
  for (const v of values) sel.appendChild(option(v, fmt(v), shot[key]));
  sel.onchange = () => onChange(key, sel.value);
  return sel;
}

function num(key, shot, onChange, step) {
  const wrapLabel = document.createElement('label');
  wrapLabel.textContent = key === 'warmup' ? 'in' : 'len';
  const input = document.createElement('input');
  input.type = 'number'; input.step = step; input.min = '0'; input.value = shot[key];
  input.onchange = () => onChange(key, parseFloat(input.value) || 0);
  input.onclick = (e) => e.stopPropagation();
  wrapLabel.appendChild(input);
  return wrapLabel;
}

function paintShots() {
  el.shots.replaceChildren();
  shots.forEach((shot, i) => {
    const li = document.createElement('li');
    li.className = 'shot';
    li.draggable = true;
    li.dataset.i = String(i);
    if (i === liveIndex) li.classList.add(playing && follow ? 'is-playing' : 'is-live');

    const grip = document.createElement('div');
    grip.className = 'shot__grip'; grip.textContent = '⠿';

    const head = document.createElement('div');
    head.className = 'shot__head';
    const n = document.createElement('span');
    n.className = 'shot__n'; n.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'shot__name';
    name.textContent = `${NAME_OF.get(shot.track) || shot.track} · ${CUP_OF.get(shot.track) || ''}`;
    head.append(n, name);

    const kill = document.createElement('button');
    kill.className = 'shot__kill'; kill.title = 'Remove'; kill.textContent = '✕';
    kill.onclick = (e) => {
      e.stopPropagation();
      shots.splice(i, 1);
      if (i < liveIndex) liveIndex--;    // the live shot moved up a row
      if (liveIndex >= shots.length) liveIndex = shots.length - 1;
      save(); paintShots(); paintTotal();
    };

    const change = (key, value) => {
      shot[key] = key === 'players' ? parseInt(value, 10) : value;
      save(); paintShots(); paintTotal();
      // A changed track/split/scenario is a different race, so the monitor is stale.
      if (i === liveIndex && (key === 'track' || key === 'players' || key === 'scenario')) {
        show(i, { swapFirst: true });
      }
    };

    const body = document.createElement('div');
    body.className = 'shot__body';
    body.append(
      trackSelect(shot, change),
      pick(SPLITS, 'players', shot, change, (v) => `${v}P`),
      pick(SCENARIOS, 'scenario', shot, change),
      num('warmup', shot, change, '0.1'),
      num('seconds', shot, change, '0.5'),
    );
    for (const control of body.querySelectorAll('select')) control.onclick = (e) => e.stopPropagation();

    li.append(grip, head, kill, body);
    // Selecting a shot while following lands on its in-point and keeps rolling, so
    // clicking down the rack plays the trailer from there.
    li.onclick = () => show(i, { swapFirst: true });

    li.addEventListener('dragstart', (e) => {
      li.classList.add('is-drag');
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => li.classList.remove('is-drag'));
    li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (Number.isNaN(from) || from === i) return;
      const [moved] = shots.splice(from, 1);
      shots.splice(i, 0, moved);
      liveIndex = -1;
      save(); paintShots(); paintTotal();
    });

    el.shots.appendChild(li);
  });
}

function paintTotal() {
  const total = shots.reduce((n, s) => n + (+s.seconds || 0), 0);
  el.total.textContent = `${shots.length} shots · ${total.toFixed(1)}s`;
}

// ---- export ------------------------------------------------------------------

function shotsJs() {
  const body = shots.map((s, i) => {
    const id = `${String(i + 1).padStart(2, '0')}-${s.track}-${s.players}p`;
    return `  { id: '${id}', scenario: '${s.scenario}', players: ${s.players}, ` +
      `track: '${s.track}', warmup: ${+s.warmup}, seconds: ${+s.seconds} },`;
  }).join('\n');
  // Only the ARRAY is worth pasting: shots.js carries a long field-by-field header that
  // this export cannot reproduce, and replacing the whole file with this would throw it
  // away. The banner says so, for whoever pastes it.
  return `// Built in /trailer.html — paste over the module.exports ARRAY in\n`
    + `// scripts/trailer/shots.js, keeping that file's header. Then: npm run trailer\n\n`
    + `module.exports = [\n${body}\n];\n`;
}

// ---- wiring ------------------------------------------------------------------

el.add.onclick = () => {
  shots.push({ ...DEFAULT_SHOT });
  save(); paintShots(); paintTotal();
};

el.play.onclick = () => {
  playing = !playing;
  // Pressing play at the end of a shot while following would otherwise sit on the
  // out-point doing nothing; roll into the next shot instead.
  if (playing && follow && liveFrame && liveFrame.time >= outAt) toNextShot();
  paintPlay();
};

el.toIn.onclick = () => toIn();

el.setIn.onclick = () => {
  if (!liveFrame) return;
  // Land on a whole step: render.js converts back with Math.round(warmup * FPS), so a
  // value that is already a step boundary survives the round trip exactly.
  shots[liveIndex].warmup = +(liveFrame.steps / FPS).toFixed(3);
  save(); armOut(); paintShots(); paintClock();
};

el.playCut.onclick = () => {
  if (playing && follow) { playing = false; paintPlay(); return; }
  playFromTop();
};

el.slowmo.onclick = () => {
  rate = rate === 1 ? 0.5 : 1;
  el.slowmo.classList.toggle('is-on', rate !== 1);
};

el.followBox.onchange = () => {
  follow = el.followBox.checked;
  armOut();
  paintPlay();
  // Reload the shot under the new rule: following puts it on its in-point, scouting
  // restarts it from 0.
  if (liveIndex >= 0) show(liveIndex, { swapFirst: true });
};

// Seek to a moment. Forward is a wind; backward re-deals the race and winds again (see
// windTo). A manual seek is scouting, by definition, so following comes off.
async function seekTo(target) {
  if (!liveFrame || !liveFrame.ready) return;
  const wasFollowing = follow;
  follow = false;
  el.followBox.checked = false;
  outAt = Infinity;
  await windTo(target);
  if (wasFollowing) paintPlay();
}

// Click the scrub bar to seek.
el.bar.onclick = (e) => {
  const r = el.bar.getBoundingClientRect();
  seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * barSpan());
};

// The other direction: replace the edit with the committed cut. The monitor keeps
// whatever it holds; the list under it is simply new, so the live row is cleared.
async function loadCommitted() {
  const res = await fetch('/api/trailer-shots');
  const { shots: loaded, error } = await res.json();
  if (!res.ok) throw new Error(error);
  shots = loaded.map(({ track, players, scenario, warmup, seconds }) =>
    ({ track, players, scenario, warmup, seconds }));
  liveIndex = -1;
  save(); paintShots(); paintTotal();
}

el.import.onclick = async () => {
  try {
    await loadCommitted();
    el.import.textContent = `Loaded ${shots.length}`;
  } catch (err) {
    console.error(err);
    el.import.textContent = 'Failed';
  }
  setTimeout(() => { el.import.textContent = 'Load shots.js'; }, 1400);
};

el.export.onclick = async () => {
  const text = shotsJs();
  try {
    await navigator.clipboard.writeText(text);
    el.export.textContent = 'Copied';
  } catch (_) {
    // Clipboard needs a secure context; over plain http on a LAN address it is absent.
    console.log(text);
    el.export.textContent = 'In console';
  }
  setTimeout(() => { el.export.textContent = 'Copy shots.js'; }, 1400);
};

paintShots();
paintTotal();
if (!shots.length) loadCommitted().catch((err) => { console.error(err); setStatus('could not load shots.js'); });
paintPlay();
// Open on the first shot's in-point, paused: the monitor shows frame one of the trailer
// rather than a race that has not started.
if (shots.length) show(0);

// Handy from the console when poking at a shot by hand.
window.__trailerEdit = { get shots() { return shots; }, shotsJs, show };
