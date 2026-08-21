// Stage — the TV screen. Owns the canvas the native renderer draws into, the
// DOM HUD floating over it, and the frame loop that drives both.
//
// It does NOT own the 3D world. Cars, track, cameras, split-screen cells and
// every cosmetic that moves live in C++ (native/libttp-runtime/), which
// reads the sim directly. So there is no scene graph here, no per-car pose
// push, no camera math: a frame is `display.frame(dt)` plus the DOM writes that
// place this frame's labels.
//
// What the Stage tracks per car is only what the HUD needs — the cell it owns,
// its livery colour, its place/lap/item chips — plus the roster order the
// renderer baked its models and liveries in. Even WHERE a cell is comes from
// C++ (display.cellRects): this file used to score the split-screen grid a
// second time, and the two copies had already drifted once.
//
// The steer bar and the cell dividers used to be here too, and are not any
// more: both are cell-anchored and textless, so they need no part of the UI
// toolkit this file exists for, and the renderer draws them (voverlay.mat). The
// bar was also the ONLY per-frame element in the HUD — everything left here is
// written from a ~6 Hz poll, which is a far cleaner contract for three shells
// than each writing its own 60 Hz animation over a GL surface. What crosses for
// them now is two setters and no stream: cellCards and dividers, latched in
// _loop and pushed only when they change. No size and no unit — both elements
// size themselves off the cell, which is already a C++ answer.
import { ordinal } from '../shared/format.js';
import { cssHex, loadBiomes } from '../shared/biomes.js';
import { CAM, Display, assetCache } from './render/Display.js';
import { PerfHud } from './render/PerfHud.js';
import { ITEM_IDS } from './engine/contract.js';
import { loadItemIcons, CAR_BODY_COLORS } from '../shared/itemIcons.js';

// Labels are the vocabulary, shouted — derived, not re-typed.
const ITEM_LABELS = Object.fromEntries(ITEM_IDS.map((id) => [id, id.toUpperCase()]));
// The item chips' artwork — one shared SVG file per item id
// (/assets/items/<id>.svg, see shared/itemIcons.js), fetched once and INLINED
// so two CSS custom properties reach inside: the boost chevrons stroke
// --icon-accent (the biome's boost accent, set on the overlay in setTrack) and
// the monster cab fills --icon-car (the body tone of the car model this cell
// drives, set in addCar — the 2D echo of the in-race graft, which stands the
// player's own body on the kit chassis). Filled by setTrack, which every
// scene awaits before a race can hand an item out.
const ITEM_ICONS = {};
// The roulette reel cycles the ROLL-TABLE order — deliberately (ITEM_IDS is
// the one vocabulary, and the reel landing on the real item depends on every
// id having an icon; a missing entry would flash an empty chip).
const ITEM_KEYS = [...ITEM_IDS];

// A centred card (FINISHED banner or reconnect QR) owns this car's cell. ONE
// spelling: it feeds both the renderer's per-cell mask (steer bar hides, one
// layer down) and the DOM chrome around it — two consumers that must agree or
// the bar shows under a card.
const cardOwnsCell = (c) => !!(c.finished || c.reconnecting);

// The band the drawing buffer lives in, in lines, whatever the screen is.
//
// A frame's cost is close to linear in fragments (see native/renderer/CLAUDE.md:
// the road ribbon and the ambient cloud are fill, and split-screen draws the
// scene once per cell), and the devices this runs on are three orders of
// magnitude apart — an M1 Max draws a 4-cell race at 4K in 7.5 ms, and the TV
// browsers this game is FOR are the weakest GPUs it will ever see. No single
// number serves both: capped at the floor a good screen reads as pixelated,
// capped at the ceiling the weak TV has four times the fill it can afford.
//
// So the number is DECIDED, per device, from what its frames actually cost —
// _adaptScale below, over the rule in native/libttp-runtime/ttp/render_scale.h.
// This is only the CEILING it may move under, and it is 4K because past that
// nobody is sitting close enough. THE FLOOR IS NOT HERE: render_scale.h's rungs
// are line counts and its bottom rung is the softest picture this game will
// show, so that decision lives in one place for every shell instead of being a
// fraction that meant 360 lines on one surface and 720 on another.
//
// Lines, not pixel counts: height is the axis every display shares, so an
// ultrawide keeps its full width rather than being letterboxed into a budget.
// Layout is unaffected by any of it — the cell grid and the HUD are computed
// from the buffer and divided back out by _dpr (see _cellRects), so this changes
// how many pixels the picture has and nothing about where anything sits.
//
// An explicit ?dpr= (or setRenderScale) is a caller naming a buffer scale and
// BYPASSES the whole mechanism — that is how the trailer renders a true 4K
// master, and how a fixed resolution is pinned for an A/B.
const MAX_BUFFER_H = 2160;

// The most `?supersample=` may ask for. A ceiling on the debug ceiling: this is
// the one path allowed past MAX_BUFFER_H, and a fat-fingered 30 in a URL is a
// buffer allocation that takes the tab down rather than a slow frame.
const MAX_SUPERSAMPLE = 8;

// …and it ARMS this long after boot, rather than applying from the first frame.
//
// THE LOAD MUST ARRIVE AFTER THE PANEL PERIOD IS KNOWN, or the demo lands
// exactly on the one case the fallback cannot see. `presentBaseline` learns the
// device's own FASTEST present and only ever lowers it, so a page that is
// heavy from frame one has a p05 equal to its p95, reads as a perfectly steady
// cadence however slow it is, and never adapts — render_scale.h says so at the
// fallback, and names cheap screens (a welcome board, a lobby) as where an
// honest period gets learned. Measured here before this existed: 4200x2700 at
// 1.5 fps, floor learned as 642 ms, ratio 1.09, no step, forever.
//
// So the scene runs at the ordinary ceiling first — which is the real boot
// sequence, where a welcome board precedes a race — and the load lands on a
// rule that knows what this panel can do.
const SUPERSAMPLE_ARM_MS = 3000;

// NOTHING IS REMEMBERED ACROSS SESSIONS, on purpose. Persisting the learned
// scale looks like free value — a weak TV would skip the seconds it spends
// adapting in race one — but it combines badly with the half of the controller
// that can only step DOWN: a device with no GPU timer would descend on one bad
// window (a thermal blip, a cold shader cache, a heavy tab at boot) and have no
// path back on any later session. A ratchet on exactly the devices this is for
// is worse than re-learning, which costs a couple of seconds and self-corrects.

// The race loop's SLOW TICK: everything on that loop which is not the frame
// itself runs off this one guard — the HUD paint, the phones' ITEM push, and the
// finish check that triggers the fast-forward to results. Exported because the
// gallery harness (display/TestHarness.js) paints the same HUD and had its own
// copy of the number.
//
// 160 ms is quoted everywhere in this tree as "~6 Hz", and it is worth writing
// down why that is true and where it stops being true. The guard is tested
// inside rAF, so firing is quantised to frame boundaries: the first frame whose
// elapsed time EXCEEDS 160 ms. At 24/30/60/90/120/144 fps that lands on 166.7 ms
// — exactly 6.00 Hz at every one of them, because 160 sits just under a whole
// number of frames in each case. At 50 Hz (PAL) it does not: 160 is an exact
// multiple of 20 ms and the comparison is strict, so it slips to the 9th frame,
// 180 ms, 5.56 Hz. Nothing depends on the difference; it is here so the next
// person to read "6 Hz" in a header can tell it is a consequence, not a target.
//
// The value itself is inherited — it predates the native port entirely (it is in
// the game's first commit) and has never been re-derived for any of the three
// jobs above. It is defensible for all three: nothing in the HUD changes faster
// than a place does, the ITEM message is per-owner and sent only on change, and
// the finish check is a safety net behind the 'finish' event. But it was picked
// for none of them, so treat it as a budget to revisit, not a constant to
// preserve.
export const HUD_TICK_MS = 160;

export class Stage {
  constructor(container, colors) {
    this.container = container;
    this.colors = colors || ['#e6492d'];
    this.cars = new Map();   // id -> { name, colorIndex, cell DOM, place/lap state }
    this._order = [];        // stable cell order
    this._running = false;
    this._last = 0;
    this._timeScale = 1;
    this._fixedDt = 0;       // >0: ignore the rAF clock entirely (see setFixedStep)
    this._track = null;
    this._biome = 'grass';   // resolved from the track's cup, or forced by biomeOverride
    this.display = null;     // set by boot()
    this.biomeOverride = null;
    this.orbit = false;      // lobby/gallery turntable
    this.bboxOrbit = false;  // lobby perimeter sweep (wins over orbit)
    // Judging aid: force the single whole-track overview camera even with a full
    // grid of cars racing, so a track's SHADOWS can be looked at without four
    // close-up chase cells in the way.
    this.soloCam = false;
    this._dividers = true;   // ?dividers=0; pushed to the renderer by _loop
    // Opt-in resolution cap (?dpr=0.5). A gallery preview iframe lays out at full
    // logical size, so at full DPR every card allocates a screen-sized drawing
    // buffer to show a ~500px thumbnail — and the gallery shows a grid of them.
    // The gallery passes dpr=0.5 and strips it from the card's "open" link, so a
    // real tab stays full-res. Guarded > 0: dpr=0 would allocate a 1×1 buffer.
    // Headless automation (E2E) gets its own, far harder cap for a different
    // reason: there the scene rasterizes through SwiftShader, where the CPU IS
    // the fill rate and cost is linear in pixels. 0.25 puts a 1280x720 display
    // on a 320x180 buffer (split cells 160x90), which is 1/16th the fragments.
    //
    // 0.25 is the measured KNEE, not a guess. cup-series, the heaviest spec
    // (4 chained tracks, split-screen), two runs each:
    //   dpr 1     78.0 s   (and 1.3 m before the shadow bake was skipped too)
    //   dpr 0.5   56.7 / 45.9 s
    //   dpr 0.25  41.7 / 41.9 s   <- here
    //   dpr 0.125 40.5 / 43.7 s   <- no further gain, so no reason to take on
    //                                degenerate-viewport risk for it
    // Below the knee the remaining time is not rasterization at all: it is the
    // wasm compile, the GLB fetches, scene build, the sim and Playwright's own
    // waits. Nothing is lost at 0.25 — the suite asserts DOM and engine state,
    // never pixels (it has no screenshot comparisons), and every render path
    // still executes at a sane resolution. An explicit ?dpr= still wins, so the
    // gallery's 0.5 and a manual override behave exactly as before.
    //
    // An explicit scale is a REQUEST, not a cap: it wins over devicePixelRatio
    // and over MAX_BUFFER_H alike (the gallery asks for half a card, the trailer
    // asks for two). Everything else lands on the automatic path in _sizeCanvas,
    // which is where the height cap is applied — it depends on the container's
    // size, so it cannot be resolved once here and has to be recomputed on every
    // resize.
    const automation = this._automation =
        typeof navigator !== 'undefined' && !!navigator.webdriver;
    const params = new URLSearchParams(location.search);
    const dprCap = parseFloat(params.get('dpr'));
    this._dprRequest = Number.isFinite(dprCap) && dprCap > 0 ? dprCap : null;
    this._autoCap = automation ? 0.25 : 2;
    // DEBUG: ?supersample=N raises the band's CEILING to N x the layout size,
    // above the panel's own resolution and past MAX_BUFFER_H.
    //
    // It exists because the mechanism is otherwise unwatchable on a good
    // machine: the rule only steps down when frames genuinely cost too much, and
    // four cells at a laptop's own resolution do not. Every other way of
    // provoking it lies to something — a fabricated GPU cost, a fake panel
    // period — and a rule whose whole contract is "hand over measurements, not
    // opinions" is not worth demonstrating on invented ones. This makes the
    // frames ACTUALLY expensive (at 3 it is nine times the fill), so everything
    // downstream is real: real cost, real percentiles, real cost model, real
    // resize. Where it settles is the honest answer to "what rung does this
    // machine hold four cells at".
    //
    // The three terms it overrides are each deliberate — the panel's own
    // resolution (this never supersamples), the 2x cap, and MAX_BUFFER_H — so
    // this is the one place allowed past them, and only ever from a URL nobody
    // reaches by accident.
    //
    // NOT UNDER AUTOMATION, whatever the URL says: the E2E cap exists to keep
    // the suite fast, and a stray parameter must not be able to hand it a
    // 20-megapixel buffer per cell.
    const ss = parseFloat(params.get('supersample'));
    this._superSample = !automation && Number.isFinite(ss) && ss > 0
        ? Math.min(ss, MAX_SUPERSAMPLE) : 0;
    this._superArmed = false;
    this._superReached = false;
    this._dpr = 1;           // real value comes from the _sizeCanvas below
    // THE OPERATING POINT THIS SIDE PERFORMS — the buffer scale it sized and the
    // cadence it paced. Not a second opinion about what to do: everything the
    // decision is MADE from (the window, the percentiles, the fastest present,
    // the cost model, the clocks) lives in ttp/render_scale_controller.h and
    // folds off the same monitor `perf` feeds. This is the record of the answer.
    //
    // Infinity rather than a number, so the band's ceiling is the only place
    // that knows what "as sharp as this screen allows" means (_sizeCanvas clamps
    // it before the first frame, and the rule adopts the same ceiling on its
    // first poll).
    this._autoScale = Infinity;
    // `_divisor` is "render every Nth rAF callback" and is the other half of the
    // point — 2 on a 120 Hz display holding the desired 1080@60, 1 once the
    // device proves it can drive 120.
    //
    // The SIM still ticks on every callback: only the picture is paced, so
    // steering keeps the display's full cadence and what doubles is picture
    // latency, not input latency. (The Android shell paces the same way, for the
    // same reason — see its vsyncInterval.)
    this._divisor = 1;
    this._vsyncCount = 0;
    this._pendingDt = 0;
    this._canvas = document.createElement('canvas');
    this._canvas.id = 'scene-canvas';
    this._canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    // FIRST child: the HUD overlays are later siblings and paint over it.
    container.insertBefore(this._canvas, container.firstChild);
    // Frame-cost readout, on by default while the game is in development ("P"
    // hides it). Hiding stops the DRAWING; whether it keeps MEASURING is the
    // next line's business. BEFORE the first _sizeCanvas, which is the one place
    // that tells it the scale the buffer was sized at — a resize is not
    // guaranteed to follow boot, so a HUD built after it would report that
    // scale as 1 for the whole session.
    this.perf = new PerfHud(this.container, this._canvas);
    // The scale is decided from the perf HUD's own measurements, so it has to
    // keep measuring with the panel hidden — which is the shipped state.
    if (this._dprRequest == null && !automation) this.perf.instrument(true);
    // The operating point the readout judges against, declared at boot and again
    // whenever either half moves (_adaptScale). Nothing is known about the panel
    // yet, which ttp_perf.h reads as "assume 60".
    this._pacedMs = 0;
    this._pacedDivisor = this._divisor;
    this.perf.pacing(this._pacedMs, this._pacedDivisor);
    this._sizeCanvas();
    this._initOverlay();
    this._assets = assetCache();
    this._free = null;       // free-cam state, once enableUserCamera() runs
    this._cellSig = null;    // last pushed cell list / camera mode (see _loop)
    this._hudSig = null;     // last-placed HUD layout (rects + cards) — see _loop
    this._camMode = null;
    this._cardMask = null;   // last pushed "a card owns this cell" bitmask
    this._divPushed = null;  // last pushed divider toggle
    window.addEventListener('resize', () => this._onResize());
  }

  // The chunky ink rules between split-screen cells (?dividers=0 turns them
  // off). A property rather than a method because main.js has always set it as
  // one, and it is read back by the debug panel; the push to the renderer is
  // latched in _loop, since this can be set before boot() has a display at all.
  get showDividers() { return this._dividers; }
  set showDividers(on) { this._dividers = on !== false; }

  // Boot the native renderer onto our canvas. Fatal on failure: there is no
  // second renderer to fall back to.
  async boot() {
    this.display = await Display.create(this._canvas);
    // RECONCILE THE SIZE THE RENDERER WAS BORN AT. ttp_display_create is handed
    // the buffer's dimensions and Display.create THEN fetches the .filamat
    // blobs, so `display` is null for a network round trip — and _onResize drops
    // its half of a resize for exactly as long. A window change landing in there
    // moves the canvas and leaves the viewport short, which draws the picture at
    // the BOTTOM of a taller buffer (GL's origin) under a bar of the black clear.
    // It does not heal: the only other caller of _onResize is _adaptScale, and a
    // machine sitting at the band's ceiling never steps. NEW GAME is the change
    // most likely to land here — its click carries the fullscreen unlock, and
    // the transition is slow enough to reach mid-boot. A no-op when they agree.
    this.display.resize(this._canvas.width, this._canvas.height);
    // The other half of the automation budget (see the DPR cap in the ctor):
    // drop the per-track shadow bake. Must be set before any setTrack, since
    // the map is baked into the scene at build time.
    if (this._automation) this.display.shadows(false);
    return this.display;
  }

  // The band the adaptive scale may move in, for THIS container at THIS moment.
  // A function of the box, so it is asked for rather than stored: the same tab
  // moved to a 4K screen, or a preview card that grows, moves both ends.
  //
  // THERE IS NO FLOOR HERE ANY MORE. render_scale.h's rungs are LINE COUNTS and
  // its bottom rung is the floor, so the softest picture this game will show is
  // one number in one place instead of a fraction that meant something different
  // on every window size. `min: 0` is "narrow me no further".
  //
  // The ceiling still collapses the band where it should: under the automation
  // cap or a preview card's half scale, min === max and nothing adapts, which is
  // exactly right — those are not budgets to be renegotiated.
  _scaleBand() {
    const ch = Math.max(1, this.container.clientHeight);
    if (this._superArmed) {
      // Held AT the debug ceiling until the point has been there once
      // (`_superReached`, latched in _adaptScale); released after, so the rescue
      // this exists to show is not fought by its own floor.
      return {
        min: this._superReached ? 0 : this._superSample,
        max: this._superSample,
        baseLines: ch
      };
    }
    const max = Math.min(window.devicePixelRatio || 1, this._autoCap, MAX_BUFFER_H / ch);
    return { min: 0, max, baseLines: ch };
  }

  // NO PANEL PERIOD TO DECLARE. There is no reliable web API for refresh rate,
  // so this shell passes 0 and the rule learns one off the tick series — see
  // RenderScaleController::panelMs, and `scalePanelMs()` for reading it back.
  // The two TV shells have a real answer and pass it.

  // Size the drawing buffer to the container, and pick the scale it is sized by.
  // The scale is resolved HERE rather than at construction because the band is a
  // function of the box, and _onResize already runs on every change to it.
  _sizeCanvas() {
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    if (this._dprRequest != null) {
      this._dpr = this._dprRequest;
    } else {
      const band = this._scaleBand();
      this._dpr = this._autoScale = Math.min(Math.max(this._autoScale, band.min), band.max);
    }
    const w = Math.max(1, Math.round(cw * this._dpr));
    const h = Math.max(1, Math.round(ch * this._dpr));
    this._canvas.width = w;
    this._canvas.height = h;
    // The readout reports the scale its PIXELS were rendered at, which is this
    // one and not devicePixelRatio — they differ under ?dpr= and under every
    // adaptive step. Written here because this is the only place it is decided.
    this.perf.dpr = this._dpr;
    return { w, h };
  }

  _onResize() {
    const { w, h } = this._sizeCanvas();
    if (this.display) this.display.resize(w, h);
    // DROP THE WINDOW, every time — this is the one place the buffer changes
    // size, and the readout is LABELLED with the size it was measured at. Held,
    // a line reads "960x540" over percentiles half of which were drawn at
    // 1280x720; worse, _adaptScale then fits its cost model from a point that
    // belongs to neither scale and banks it as prevCostMs.
    this.perf.reset();
    // The resize reallocated (and cleared) the drawing buffer. A running loop
    // repaints on the next rAF, but a preview idled by pauseAfterFrame would stay
    // blank forever (frozen cards have no play button) — repaint one frame, re-idle.
    if (!this._running) { this.start(); this.pauseAfterFrame(); }
  }

  _initOverlay() {
    const o = document.createElement('div');
    o.className = 'race-labels';
    o.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    this.container.appendChild(o);
    this.overlay = o;
  }

  // ---- track ----------------------------------------------------------------

  // Build (or rebuild) the scene for `track`. Async, unlike the three.js one it
  // replaces: the renderer needs its GLB bytes before it can bake a car into a
  // slot, so callers that hold a still over the swap (the lobby crossfade) await
  // this.
  async setTrack(track) {
    this._track = track;
    // Which biome this track wears. The RULES are C++ (a track resolves through
    // its cup, an unmapped cup falls back to grass); the only thing decided here
    // is that the ?biome= inspector override, which is a URL, beats them.
    const b = await loadBiomes();
    this._biome = this.biomeOverride || b.forTrack(track.id);
    // The boost chip wears the biome's own accent (green on Playroom, blue on
    // Snow) so the HUD reads as the same item the deck does. This is the ONE
    // colour of the palette that crosses back, because the chip is DOM: every
    // other boost surface is drawn by the renderer from the same one recipe.
    Object.assign(ITEM_ICONS, await loadItemIcons());
    this.overlay.style.setProperty('--icon-accent', cssHex(b.boostIcon(this._biome)));
    return this._rebuild();
  }

  // The biome this track is being drawn in — the race-music pool key.
  biome() { return this._biome; }

  // Draw every scene from here on as the ASSET GALLERY's showroom: this biome's
  // palette carrying every biome's vocabulary (ttp_display_showcase). The
  // gallery is the only caller; nothing in play sets it.
  //
  // Takes effect at the next build, so a caller flipping it on a live scene
  // asks for one — the same contract as biomeOverride. Held here and pushed in
  // _rebuild rather than pushed now, because the gallery sets it at module
  // scope, before boot() has a display to latch it on.
  showcase(on) { this._showcase = on !== false; }

  // DEV, the asset gallery's model bench (ttp_display_bench /
  // ttp_display_model_variant). Held here and pushed in _rebuild for the same
  // reason showcase() is — and they go in the rebuild SIGNATURE too, or picking
  // a new variant on a settled field would leave the roster identical and the
  // rebuild would be skipped, which is precisely the bug the biome pick had.
  bench(model) { this._bench = model || ''; }
  // DEV, the asset gallery's KIT FIELD: the models to stand beyond the track,
  // by GLB name. Same latch shape as bench() — held here and pushed in
  // _rebuild — and a SCENE input, since the field is meshed at build.
  kitField(models) { this._kitField = Array.isArray(models) ? models : []; }
  // Where the built field put them, in the order given. Empty until the build
  // that stands one has finished, so callers await their rebuild first.
  kitLayout() { return this.display ? this.display.kitLayout() : []; }
  modelVariant(model, variant) {
    this._variants = { ...(this._variants || {}), [model]: variant | 0 };
  }
  variants() { return { ...(this._variants || {}) }; }

  // The roster the renderer bakes models and liveries into, in SLOT order: cars
  // that own a cell first, in cell order, then the rest of the field. Every
  // frame then finds a car's slot by its id, so this order only has to be
  // stable within one build, not to mean anything to the sim.
  //
  // A slot is three fields, and the split between them is the whole contract:
  // id/carIndex/colour go to C++ verbatim (ttp_display_build parses them —
  // the livery arithmetic is ITS business, not this file's), while `model`
  // never crosses at all. It names the GLB to FETCH, which is the one part of
  // a scene build that is a platform job.
  _roster() {
    const seen = new Set(this._order.filter((id) => this.cars.has(id)));
    const all = [...seen, ...[...this.cars.keys()].filter((id) => !seen.has(id))];
    const models = window.CAR_MODELS || [];
    return all.map((id) => {
      const c = this.cars.get(id);
      const carIndex = c.carIndex ?? 0;
      return {
        id, carIndex,
        color: this.colors[(c.colorIndex ?? 0) % this.colors.length],
        model: models[carIndex % (models.length || 1)] || null
      };
    });
  }

  // One rebuild queue. Every trigger (a new track, the field changing) marks the
  // scene dirty and gets back a promise that settles when the renderer has caught
  // up. A burst of addCar calls collapses into one rebuild, and a trigger that
  // lands mid-build is picked up by the loop rather than dropped.
  _rebuild() {
    if (!this.display || !this._track) return Promise.resolve();
    this._dirty = true;
    if (!this._rebuilding) {
      this._rebuilding = (async () => {
        await Promise.resolve(); // let the rest of this task's triggers pile in
        while (this._dirty) {
          this._dirty = false;
          const roster = this._roster();
          // Every INPUT to the build, not just the roster: the look is one too.
          // Re-picking a biome on a settled field (the asset gallery's picker)
          // leaves the seats identical, and on a roster-only signature that
          // rebuild was silently skipped — the scene kept the old palette and
          // the caller's await resolved as if it had not.
          //
          // Two signatures, because the two halves have different cheap paths:
          // a SCENE input change (track, biome, showcase, bench, variants) is
          // always a full build, while a roster-only change on a live scene is
          // offered to ttp_display_reroster first — an in-place re-dress that
          // keeps the meshes, the baked shadows and the preview camera's orbit
          // phase. Whether it qualifies is C++'s call; a refusal (join/leave,
          // reorder) just falls through to the build below.
          const variants = this._variants || {};
          // The KIT FIELD is a SCENE input, not a roster one: it is meshed at
          // build, and its models are a fetch list this side owns.
          const kit = this._kitField || [];
          const sceneSig = JSON.stringify([this._track.id, this._biome,
                                           !!this._showcase, this._bench || '', variants, kit]);
          const rosterSig = JSON.stringify(roster);
          if (sceneSig === this._sceneSig && rosterSig === this._rosterSig) {
            continue; // nothing the renderer can see
          }
          try {
            if (sceneSig === this._sceneSig && this.display.built
                && await this.display.reroster(roster, this._assets)) {
              this._rosterSig = rosterSig;
              continue;
            }
            this.display.showcase(!!this._showcase); // latched; see showcase()
            this.display.bench(this._bench || '');   // …and see bench()
            this.display.kitField(kit);              // …and see kitField()
            for (const [m, v] of Object.entries(variants)) this.display.modelVariant(m, v);
            await this.display.setTrack(this._track.id, this._biome, roster, this._assets);
            this._sceneSig = sceneSig;
            this._rosterSig = rosterSig;
            // A FULL BUILD ONLY. The reroster path above is an in-place re-dress
            // of the same scene — same meshes, same cost — so it inherits its own
            // scale legitimately and must not re-arm the recovery hold.
            this.display.scaleScene(
                typeof performance !== 'undefined' ? performance.now() : 0);
            // …and the window describes the scene that just went away, exactly as
            // it does after a resize. Left in place, the first decision about the
            // NEW scene is made from the old one's frames.
            this.perf.reset();
          } catch (e) {
            this._sceneSig = this._rosterSig = null; // let the next change retry
            console.error('[stage] scene build failed', e);
          }
        }
        this._rebuilding = null;
        // The scene the caller was waiting for only exists NOW. A running loop
        // picks it up on the next rAF, but an idled preview (pauseAfterFrame)
        // would sit forever on the frame it painted BEFORE the build — which is
        // the old scene, or none at all. Same repaint-once rule as _onResize.
        if (!this._running) { this.start(); this.pauseAfterFrame(); }
      })();
    }
    return this._rebuilding;
  }

  // Has the scene the shell last asked for actually been meshed? The COUNTDOWN
  // GATE's half of the question (ttp_race.h): one bit, and the frame evidence
  // that goes with it is the rule's to read. `_rebuilding` covers a build still
  // in flight AND one the queue has not started yet, which is why this is not
  // `display.built` on its own — that flag describes the scene on screen, which
  // during a swap is the one being replaced.
  sceneBuilt() {
    return !this._rebuilding && !!(this.display && this.display.built);
  }

  // Mesh a track AHEAD of the race that will run on it, and promise the next
  // rebuild() that what comes out is already at its opening state — so the
  // launch does not immediately mesh it a second time. See prepareNextTrack()
  // in main.js for why a cup's chained start wants that.
  //
  // A ONE-SHOT TOKEN, not a "is the scene clean" flag, because that question
  // cannot be answered from this class: the finished race's session is still
  // bound all through the intermission, and the next one binds before the
  // prepared build has even landed. The promise is instead consumed by the very
  // next rebuild() and dropped the moment anything else takes the scene
  // (bindSession — a lobby demo, a harness scenario) so it can never be spent
  // on a scene that has since been driven on.
  prepare(track) {
    this._prepared = true;
    return this.setTrack(track);
  }

  // Force a FULL rebuild even when the roster comes out identical — a new race
  // on the same track with the same field still wants the scene back at its
  // opening state (cones upright, boxes uncollected, no skid patina). Nulling
  // the SCENE signature is what routes around the re-dress path: reroster
  // would happily say "nothing changed" and keep the raced-on scene.
  rebuild() {
    const prepared = this._prepared;
    this._prepared = false;
    if (!prepared) this._sceneSig = this._rosterSig = null;
    return this._rebuild();
  }

  // The session whose cars get drawn. 0 / null clears it (an empty track).
  // Someone else taking the scene (the lobby demo, a harness scenario) drops any
  // unspent prepare() promise — those cars lay rubber and kick cones on it.
  bindSession(handle) {
    if (handle) this._prepared = false;
    if (this.display) this.display.bind(handle || 0);
  }

  // Freeze the field where it is, at rest — see ttp_display_hold. Cleared by
  // hold(false) when the race resumes.
  hold(on) { if (this.display) this.display.hold(on); }

  // ---- cars -----------------------------------------------------------------

  // Register a car with the HUD and the renderer's roster. `opts.cell` false is
  // an AI/CPU car: it races in the shared world — so it shows up in every human's
  // chase view — but gets no split-screen cell of its own, so a solo human sees
  // one viewport rather than their own cell plus three bot cameras.
  addCar(id, colorIndex, name, opts = {}) {
    const carIndex = (opts.carIndex == null ? colorIndex : opts.carIndex);
    const cell = opts.cell !== false;
    const colHex = this.colors[colorIndex % this.colors.length] || '#fff';
    // The *El fields are the leaves setCarHud writes, resolved ONCE here rather
    // than re-queried per paint — they are created a few lines below, so a
    // selector match every tick was only ever finding what we already had. The
    // _*Text fields are the last string written to each, so an unchanged value
    // costs a comparison instead of a DOM write (see setCarHud).
    const c = { name, colorIndex, carIndex, finished: false, reconnecting: false,
                label: null, placeEl: null, placeTextEl: null, lapTextEl: null,
                itemEl: null, finPlaceEl: null, finTimeEl: null,
                _placeText: null, _lapText: null, _finPlaceText: null, _finTimeText: null,
                finishEl: null, reconnectEl: null, _chipItem: null, _chipTimer: null };

    if (cell) {
      const label = document.createElement('div');
      label.className = 'cell-label';
      label.innerHTML = `<div class="cell-label__row"><span class="cell-label__name"></span><div class="cell-label__item is-empty"></div></div>`;
      label.querySelector('.cell-label__name').textContent = name || ('P' + id);
      label.style.setProperty('--c', colHex);
      // The monster chip's cab wears the CAR's own body tone, not the player's
      // livery — the in-race transform grafts the player's body onto the
      // chassis, and the body keeps its model paint.
      label.style.setProperty('--icon-car', CAR_BODY_COLORS[carIndex % CAR_BODY_COLORS.length]);
      this.overlay.appendChild(label);
      c.label = label;
      c.itemEl = label.querySelector('.cell-label__item');

      // place + lap readout — pinned to this player's cell top-right, no card,
      // white text over the scene (positioned by _loop, filled by setCarHud).
      const placeEl = document.createElement('div');
      placeEl.className = 'cell-rank';
      placeEl.innerHTML = `<div class="cell-rank__place"></div><div class="cell-rank__lap"></div>`;
      this.overlay.appendChild(placeEl);
      c.placeEl = placeEl;
      c.placeTextEl = placeEl.querySelector('.cell-rank__place');
      c.lapTextEl = placeEl.querySelector('.cell-rank__lap');

      // The on-screen steer indicator is NOT here: the renderer draws it, from
      // the same cell rects this HUD is placed on and the same roster livery
      // its car model wears (voverlay.mat).

      // "FINISHED / place / time" — centred in this player's cell the instant
      // they cross the line while the rest of the field is still racing.
      // Replaces the steer bar (they're on a victory lap now, not steering) —
      // which is what the cellCards bitmask in _loop tells the renderer.
      const finishEl = document.createElement('div');
      finishEl.className = 'cell-finish';
      finishEl.style.setProperty('--c', colHex);
      finishEl.innerHTML =
        `<div class="cell-finish__badge">FINISHED</div>` +
        `<div class="cell-finish__place"></div>` +
        `<div class="cell-finish__time"></div>`;
      this.overlay.appendChild(finishEl);
      c.finishEl = finishEl;
      c.finPlaceEl = finishEl.querySelector('.cell-finish__place');
      c.finTimeEl = finishEl.querySelector('.cell-finish__time');

      // Every element above is CSS display:none until _loop's placement pass
      // shows it, so the "already placed" latch is stale the moment they exist.
      // Without this, reset-scene-cars rebuilding the SAME layout (same ids,
      // rects and flags — a chained cup race whose finish flags never got a
      // placement pass) skips the pass and the whole cell HUD stays hidden.
      this._hudSig = null;
    }

    this.cars.set(id, c);
    if (cell && !this._order.includes(id)) this._order.push(id);
    // The renderer bakes a car's model and livery into its slot, so any change
    // to the field goes through _rebuild — which routes it to an in-place
    // re-dress when only the dressing changed (a car pick on the same seats)
    // and to a full scene build when the field changed shape (the lobby's
    // attract race starting a tick after the track lands, phones joining and
    // leaving mid-lobby, the race grid replacing the whole demo field).
    this._rebuild();
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; }
    for (const el of [c.label, c.finishEl, c.placeEl, c.reconnectEl]) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
    this._rebuild();
  }

  // Re-key a car from one id to another (a dropped player reconnects on a
  // different device). Keeps the same HUD cell and the same renderer slot — only
  // the id it's filed under changes, so the camera keeps following it. The
  // reconnect card is dropped: a re-key means the seat is back.
  rekeyCar(oldId, newId) {
    if (oldId === newId) return false;
    const c = this.cars.get(oldId);
    if (!c || this.cars.has(newId)) return false;
    this.setCarReconnect(oldId, null);
    this.cars.delete(oldId);
    this.cars.set(newId, c);
    for (let i = 0; i < this._order.length; i++) {
      if (this._order[i] === oldId) this._order[i] = newId;
    }
    this.rebuild(); // the renderer keys its slots by id too
    return true;
  }

  // Change a registered car's model/livery/name IN PLACE — same slot, same
  // insertion order. The order is the point: removing and re-adding the car
  // would push its slot to the end of the roster, and a REORDERED roster is a
  // full scene build by design (planReroster refuses it), where this lands as
  // a re-dress that leaves the scene and the preview camera alone.
  updateCar(id, { colorIndex, carIndex, name } = {}) {
    const c = this.cars.get(id);
    if (!c) return false;
    if (colorIndex != null) c.colorIndex = colorIndex;
    if (carIndex != null) {
      c.carIndex = carIndex;
      // the monster chip's cab follows the MODEL, so a re-pick retints it
      if (c.label) c.label.style.setProperty('--icon-car', CAR_BODY_COLORS[carIndex % CAR_BODY_COLORS.length]);
    }
    if (name != null) {
      c.name = name;
      if (c.label) c.label.querySelector('.cell-label__name').textContent = name || ('P' + id);
    }
    this._rebuild();
    return true;
  }

  // A seated player changed their name (DisplayNet's onPlayerRenamed). A name
  // is HUD-only — the cell chip is DOM, and nothing in the 3D scene wears it —
  // so this never touches the renderer: the roster the scene builds from
  // carries no name, and _rebuild sees an unchanged signature.
  setCarName(id, name) { return this.updateCar(id, { name }); }

  // Show (el) or clear (null) a dropped player's reconnect card, centred in
  // their split-screen cell by _loop — same placement as the FINISHED card.
  // No-op for a car with no cell, so reconnect cards only show in-race.
  setCarReconnect(id, el) {
    const c = this.cars.get(id);
    if (!c || !c.label) return false;
    if (c.reconnectEl && c.reconnectEl !== el && c.reconnectEl.parentNode) {
      c.reconnectEl.parentNode.removeChild(c.reconnectEl);
    }
    if (!el) { c.reconnectEl = null; c.reconnecting = false; return true; }
    c.reconnectEl = el;
    c.reconnecting = true;
    if (el.parentNode !== this.overlay) this.overlay.appendChild(el);
    return true;
  }

  // ---- HUD ------------------------------------------------------------------

  // What each cell's chrome should say right now, straight off the engine as a
  // packed block (Display.hud → ttp_hud.h): one row per car that holds a
  // renderer slot, in the shape setCarHud takes. No race state is serialized for
  // it, and the values are the sim's own — Game::displayLap and Car::rank — not
  // a second derivation of them.
  //
  // Polled, not pushed: the caller reads this at its own ~6 Hz and paints. The
  // one HUD element that needed 60 Hz, the steer bar, is the renderer's now.
  hudRows() { return this.display ? this.display.hud() : []; }

  // WRITES ONLY WHAT CHANGED. The poll runs at ~6 Hz but the values behind it
  // move about 0.9 times a second across a whole 8-car field (measured over a
  // 90 s race: 61 place changes, 16 item, 4 lap), so ~85% of these calls have
  // nothing to say. Re-writing textContent with an identical string is not free:
  // it is a selector match, a string build and a DOM property set per field per
  // car, and the FINISHED card used to repaint its place and toFixed'd time
  // every tick for the whole rest of the race.
  //
  // The DIFF is here rather than upstream because the readback is not what
  // costs — ttp_display_hud is a packed struct, no JSON — and because `position`
  // has no event to be driven by: it is a side effect of physics that the sim
  // recomputes every tick. Turning that into a push would mean the sim diffing
  // ranks and emitting, for a saving the diff already gets.
  setCarHud(id, info) {
    const c = this.cars.get(id);
    if (!c || !c.label) return; // cell-less AI cars have no HUD label
    // place + lap, top-right (no card): a big ordinal over a smaller "Lap n/N".
    // Hidden while finished — the centred FINISHED overlay shows place + time.
    if (c.placeEl) {
      const place = ordinal(info.position);
      const lap = `Lap ${info.lap}/${info.totalLaps}`;
      if (place !== c._placeText) { c._placeText = place; c.placeTextEl.textContent = place; }
      if (lap !== c._lapText) { c._lapText = lap; c.lapTextEl.textContent = lap; }
    }
    // Held-item slot — a fixed reserved square. On a fresh pickup it SLOT-MACHINES
    // the item icons and lands on what they got; on use it returns to the empty
    // square (the square is always present, so there is no reflow).
    const next = (!info.finished && info.item) ? info.item : null;
    if (next !== c._chipItem) {
      c._chipItem = next;
      if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; }
      if (next) this._rouletteChip(c, next);
      else if (c.itemEl) this._paintSlot(c.itemEl, null, false);
    }
    c.finished = !!info.finished;
    if (c.finished && c.finishEl) {
      // Both fields are fixed the moment the car crosses, so this card is
      // written ONCE and then left alone for the rest of the race.
      const place = ordinal(info.position);
      const time = info.finishTime != null ? `${info.finishTime.toFixed(1)}s` : '';
      if (place !== c._finPlaceText) { c._finPlaceText = place; c.finPlaceEl.textContent = place; }
      if (time !== c._finTimeText) { c._finTimeText = time; c.finTimeEl.textContent = time; }
    }
  }

  _paintSlot(el, item, rolling) {
    if (item) {
      el.innerHTML = ITEM_ICONS[item] || '';
      el.className = 'cell-label__item is-' + item + (rolling ? ' rolling' : '');
      el.title = ITEM_LABELS[item] || '';
    } else {
      el.innerHTML = '';
      el.className = 'cell-label__item is-empty';
      el.title = '';
    }
  }

  // A fresh grab (fired once per pickup by onRaceEvent): ALWAYS re-spin the
  // cell's roulette, even when a box swap re-rolls the SAME item id — so every
  // pickup reads. setCarHud's polling won't double-spin, because this sets
  // _chipItem before the next poll.
  itemPickup(id, item) {
    const c = this.cars.get(id);
    if (!c || !c.label || !item) return; // cell-less AI car → no HUD chip
    c._chipItem = item;
    if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; }
    this._rouletteChip(c, item);
  }

  // Slot-machine the cell's item slot: flick through the item ICONS,
  // decelerating, then land on `item` with a pop. Self-driven so it animates
  // faster than the ~6 Hz HUD poll; cancelled on change/teardown.
  _rouletteChip(c, item) {
    const el = c.itemEl;
    if (!el) return;
    let i = 0, n = 0; const TOTAL = 9;
    const spin = () => {
      this._paintSlot(el, ITEM_KEYS[i % ITEM_KEYS.length], true); i++; n++;
      if (n >= TOTAL) { // land on the real item
        c._chipTimer = null;
        this._paintSlot(el, item, false);
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
        return;
      }
      c._chipTimer = setTimeout(spin, 35 + n * 16); // decelerate ~35ms → ~165ms
    };
    spin();
  }

  // Where this frame's split-screen cells are, as [{ x, y, w, h }, …] in CSS
  // pixels and in cell order — the renderer's OWN split, not a second opinion.
  // Empty until a car owns a cell.
  //
  // THE ONE CONVERSION. C++ answers in drawing-buffer pixels, which is the only
  // surface it is ever told about (ttp_display_create/resize take physical
  // pixels; CSS pixels are a web idea that tvOS and Android do not share). The
  // canvas was sized by multiplying the CSS box by _dpr in _sizeCanvas, so the
  // DOM's coordinates are the reciprocal of that, applied here — the single
  // place in the shell holding both numbers. Scale in the wrong place, or not at
  // all, and every label, steer bar and FINISHED card lands at 1/dpr of its cell
  // on a HiDPI screen (and 4x outside it under the E2E suite's 0.25 cap).
  //
  // The rects are truncated to whole DEVICE pixels C++-side, so a cell edge can
  // land on a half CSS pixel at dpr 2. That is deliberate: the label follows the
  // edge the player actually sees, which is where the renderer put its viewport.
  // The cell grid in CSS pixels, for placing the DOM chrome over it.
  //
  // The ABI answers FRACTIONS of the surface, so what they are multiplied by is
  // the container — never the buffer, and therefore never anything the adaptive
  // render scale can move. `_dpr` used to be the divisor here and its only job
  // was to undo a scaling the ABI had no reason to apply.
  _cellRects(n) {
    const packed = this.display.cellRects(n);
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    const out = [];
    for (let i = 0; i + 3 < packed.length; i += 4) {
      out.push({ x: packed[i] * cw, y: packed[i + 1] * ch,
                 w: packed[i + 2] * cw, h: packed[i + 3] * ch });
    }
    return out;
  }

  // Push what the renderer's own cell overlay needs, on change only. Two latched
  // values, neither of them per-frame state: which cells have a centred card
  // over them (so the steer bar under it goes), and the divider toggle. That is
  // the whole of it — no size and no unit, since both elements measure
  // themselves against the cell rects C++ already owns.
  //
  // The rules themselves are NOT computed here any more. They used to be built
  // from the CSS-pixel rects — one per distinct cell edge — and the renderer now
  // derives the same set from the same grid, so the seam is exactly where the
  // viewport edge is rather than a rounded-back copy of it.
  _syncOverlay(ids) {
    let mask = 0;
    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (c && cardOwnsCell(c)) mask |= 1 << i;
    });
    if (mask !== this._cardMask) { this._cardMask = mask; this.display.cellCards(mask); }
    if (this._dividers !== this._divPushed) {
      this._divPushed = this._dividers;
      this.display.dividers(this._dividers);
    }
  }

  // The no-cell branch runs for the whole lobby, so this latches: hiding the
  // same elements 60 times a second is a style write per car per frame for a
  // HUD that is already hidden.
  _hideCellHud() {
    if (this._hudHidden) return;
    this._hudHidden = true;
    this._hudSig = null; // the labels are display:none now — re-place on return
    for (const c of this.cars.values()) {
      for (const el of [c.label, c.finishEl, c.placeEl, c.reconnectEl]) {
        if (el) el.style.display = 'none';
      }
    }
  }

  // ---- effects the renderer can't infer ---------------------------------------

  // A rocket that HIT a car detonates ON that car and rides it out; a whiff
  // self-destructs at a track point. Only the event knows which.
  rocketImpact(id) { if (this.display) this.display.burstOn(id); }
  rocketExpire(s, lat) { if (this.display) this.display.burstAt(s, lat); }

  // Force the distance fog fully OFF (the gallery grid and the free-cam
  // inspector want the whole circuit with zero haze). Left enabled, the renderer
  // picks the profile by camera mode each frame — tight race fog for the chase
  // cams, pushed-out overview fog for the turntable.
  setFog(enabled) {
    if (this.display) this.display.fog(enabled);
  }

  // Grab the CURRENT frame as a frozen still (a detached 2D canvas). The lobby
  // uses this to crossfade one track STRAIGHT into the next: snapshot track A,
  // rebuild to track B underneath, then fade the still out so B emerges through
  // A — no dip through an empty diorama. The frame has to be re-presented in
  // THIS task, because a WebGL drawing buffer is cleared the moment the browser
  // composites and a readback of an idle canvas comes back black.
  snapshot() {
    if (!this.display || !this.display.repaint()) return null;
    const src = this._canvas;
    if (!src.width || !src.height) return null;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // ---- free-cam inspector -----------------------------------------------------

  // Hand the overview camera to the viewer: drag to LOOK AROUND in place, scroll
  // to fly forward, WASD to glide and Q/E to drop/rise. Used by the standalone
  // track preview so a track can be inspected up close; it replaces the
  // turntable. Call AFTER setTrack, so the framing is solved.
  //
  // This is ~60 lines of pointer and key handling rather than a controls library
  // because all it produces is an eye and a look target, which is exactly what
  // ttp_display_look takes.
  //
  // `start` overrides where it opens ({ eye: {x,y,z}, yaw, pitch }, any subset).
  // A surface that knows what it wants looked at says so — the asset gallery
  // opens on the parked cars rather than on the iso overview, which on its long
  // showroom oval would be a distant view of nothing in particular. It is the
  // SHELL's to decide because the free cam is the shell's: TTP_CAM_FREE is the
  // one mode where C++ draws whatever pose it is handed.
  enableUserCamera(start) {
    if (this._free) return this._free;
    this.orbit = false;
    this.bboxOrbit = false;
    const dom = this.container;
    // Start on the same iso framing the still overview uses, looking at the
    // track centre. Yaw/pitch are then driven by the drag.
    const f = { eye: { x: 60, y: 45, z: 60 }, yaw: Math.PI * 1.25, pitch: -0.5,
                keys: new Set(), fly: 40 };
    if (start) {
      if (start.eye) f.eye = { ...f.eye, ...start.eye };
      if (Number.isFinite(start.yaw)) f.yaw = start.yaw;
      if (Number.isFinite(start.pitch)) f.pitch = start.pitch;
    }
    this._free = f;
    if (this.display) this.display.camera(CAM.FREE);

    const editable = (t) => !!t && (t.isContentEditable ||
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    let dragging = false, lx = 0, ly = 0;
    dom.style.cursor = 'grab';
    dom.style.pointerEvents = 'auto';
    dom.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      dom.style.cursor = 'grabbing';
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', (e) => {
      dragging = false;
      dom.style.cursor = 'grab';
      try { dom.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      f.yaw -= (e.clientX - lx) * 0.005;
      // Free the pitch so you can look right down at the track or up to the sky,
      // with an epsilon short of vertical (where the look basis degenerates).
      f.pitch = Math.max(-1.55, Math.min(1.55, f.pitch - (e.clientY - ly) * 0.005));
      lx = e.clientX; ly = e.clientY;
    });
    // The wheel flies forward/back along the look direction, scaled by the
    // framing distance so a notch feels the same near or far.
    dom.addEventListener('wheel', (e) => {
      if (editable(e.target)) return;
      e.preventDefault();
      const d = this._freeDir();
      const step = Math.max(8, f.fly) * 0.0009 * -e.deltaY;
      f.eye.x += d.x * step; f.eye.y += d.y * step; f.eye.z += d.z * step;
    }, { passive: false });

    const HANDLED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
    window.addEventListener('keydown', (e) => {
      if (!HANDLED.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editable(e.target)) return; // don't hijack keys typed into the debug panel
      f.keys.add(e.code);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => f.keys.delete(e.code));
    window.addEventListener('blur', () => f.keys.clear()); // no keyup arrives if focus leaves mid-press
    return f;
  }

  _freeDir() {
    const f = this._free;
    const cp = Math.cos(f.pitch);
    return { x: Math.sin(f.yaw) * cp, y: Math.sin(f.pitch), z: Math.cos(f.yaw) * cp };
  }

  // WASD ride the camera's GROUND-plane forward/right so you skim level over the
  // track; Q drops and E rises on world up. Both are fractions of a framing-
  // anchored reference speed so it feels the same everywhere: WASD at 50%,
  // rise/dip at a gentler 25% for fine height tweaks.
  _stepFreeCam(dt) {
    const f = this._free;
    const d = this._freeDir();
    if (f.keys.size) {
      let fx = d.x, fz = d.z;
      const fl = Math.hypot(fx, fz);
      if (fl < 1e-6) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
      const rx = -fz, rz = fx;
      let hx = 0, hz = 0, vy = 0;
      if (f.keys.has('KeyW')) { hx += fx; hz += fz; }
      if (f.keys.has('KeyS')) { hx -= fx; hz -= fz; }
      if (f.keys.has('KeyD')) { hx += rx; hz += rz; }
      if (f.keys.has('KeyA')) { hx -= rx; hz -= rz; }
      if (f.keys.has('KeyE')) vy += 1;
      if (f.keys.has('KeyQ')) vy -= 1;
      const ref = Math.max(8, f.fly) * 0.9 * dt;
      const hl = Math.hypot(hx, hz);
      if (hl > 0) { f.eye.x += (hx / hl) * ref * 0.5; f.eye.z += (hz / hl) * ref * 0.5; }
      f.eye.y += vy * ref * 0.25;
    }
    this.display.look(f.eye, { x: f.eye.x + d.x, y: f.eye.y + d.y, z: f.eye.z + d.z });
  }

  // ---- loop -------------------------------------------------------------------

  start() {
    this._idleAfterFrame = false; // re-entering cancels a pending idle
    if (!this._running) {
      this._running = true;
      this._last = performance.now();
      requestAnimationFrame((t) => this._loop(t));
    }
  }
  stop() { this._running = false; }
  // Is the loop live right now? (false once pauseAfterFrame has idled it.) The
  // gallery play overlay derives its ▶/❚❚ state from this instead of guessing.
  isRunning() { return !!this._running; }
  // DEBUG slow-mo: scale the per-frame dt the whole scene runs on (1 = normal,
  // 0.1 = tenth speed). Driven live by the debug panel's "Time scale" slider.
  setTimeScale(n) {
    const v = parseFloat(n);
    this._timeScale = Number.isFinite(v) ? Math.max(0.05, Math.min(4, v)) : 1;
    return this._timeScale;
  }
  // OFFLINE CAPTURE: cut the scene loose from the wall clock. With a fixed step the
  // per-frame dt is whatever is named here rather than the rAF delta, so the sim
  // advances by exactly one step per frame DRAWN, no matter how long the frame took
  // to draw or how long the caller then sat on it.
  //
  // This is what makes a rendered video possible at all. The usual loop derives dt
  // from real time and clamps it at 50 ms (see _loop), which is a frame-rate/sim-rate
  // coupling: a capture that screenshots each frame runs the tab at ~3 fps, so a
  // wall-clock dt yields either a slideshow of 50 ms lurches or, once the clamp bites,
  // a race that barely advances — the trap scripts/capture-artwork.js documents at
  // length and works around by racing at a cheap resolution. Stepping instead means
  // the OUTPUT is a clean 60 fps and only the render TIME is slow, which nobody sees.
  //
  // Pairs with start() + pauseAfterFrame() to advance exactly one frame per call.
  // 0 (the default) restores the real clock. _timeScale still applies, so a shot can
  // be stepped in slow motion without changing the step.
  setFixedStep(sec) {
    const v = parseFloat(sec);
    this._fixedDt = Number.isFinite(v) && v > 0 ? Math.min(v, 0.05) : 0;
    return this._fixedDt;
  }
  // Render exactly one more frame with the state set so far, then halt. Gallery
  // previews hold a still this way instead of redrawing an unchanged scene at
  // 60fps; the held frame renders fully, so resuming picks up seamlessly.
  pauseAfterFrame() { if (this._running) this._idleAfterFrame = true; }

  // ADAPTIVE resolution: ask, and perform the answer.
  //
  // NOTHING IS DECIDED HERE and nothing is even measured here any more. The
  // window is the readout's (PerfHud feeds ttp_perf_sample every callback), the
  // percentiles, the fastest present, the cost model and the clocks are all
  // ttp/render_scale_controller.h's, and the rule is ttp/render_scale.h's. What
  // is left on this side is the two things only a browser knows — the band, and
  // that a hidden tab is not a device — plus the resize.
  //
  // WHAT "low hardware" MEANS here: not a device probe. There is no honest one
  // in a browser — a UA string lies and WEBGL_debug_renderer_info is being taken
  // away — and a probe would have to guess at the load anyway. What is measured
  // instead is THIS device drawing THIS game's frames, so a weak GPU, a hot
  // laptop, a heavy tab next door and four cells instead of one all arrive as
  // the same fact: the frames cost too much, render fewer pixels.
  //
  // It therefore adapts in the LOBBY as well as in a race, and the two are not
  // the same load — the lobby is one camera, a race is four. That is not a
  // problem to be special-cased: a lobby that has climbed then meets a race that
  // has not, notices inside a second and gives the pixels back, because the
  // holds are asymmetric.
  // DEBUG (?supersample=): arm the raised ceiling, and get there THROUGH THE
  // BAND rather than by writing the scale.
  //
  // THE SHELL MAY NOT MOVE THE OPERATING POINT. It tried, in the first draft of
  // this, and the bug is the exact one the whole layer exists to prevent: the
  // shell set `_autoScale` to the new ceiling, the rule went on deciding from
  // the point IT still held, and the "rescue" that followed was arithmetic on a
  // scale nobody was drawing at. It happened to land on the floor, which is
  // what made it look like it had worked.
  //
  // So the band does it. `min` means "narrow me no further" — a shell saying
  // the floor is 3x is using a documented input for its documented meaning, and
  // the rule moves the point itself and stays the only thing that ever has. The
  // floor is released the moment the point reaches it (`_superReached` latches,
  // so a rescue afterwards is not forced back up), and from there the rule steps
  // down the ladder normally.
  //
  // WHY NOT JUST RAISE THE CEILING AND LET IT CLIMB: a climb needs the cost
  // model, which needs a GPU timer, so on WebKit it would never arrive at all.
  _armSuperSample(t) {
    if (!this._superSample || this._superArmed || t < SUPERSAMPLE_ARM_MS) return;
    this._superArmed = true;
    console.info(`[stage] supersample armed: ceiling -> ${this._superSample}x`
        + ` (${Math.round(this._superSample * this.container.clientHeight)} lines)`);
  }

  _adaptScale(t) {
    if (this._dprRequest != null || this._automation) return;   // a named scale is not ours to move
    // A THROTTLED TAB IS NOT THIS DEVICE. A hidden tab presents at whatever rate
    // the browser feels like, so the window fills with frames that describe
    // nothing — drop it rather than decide on it, which is the readout's own
    // rule (stale history is worse than none) applied to the same monitor.
    if (typeof document !== 'undefined' && document.hidden) { this.perf.reset(); return; }
    this._armSuperSample(t);
    // …and release its floor once the point has actually reached it. Latched
    // here rather than inside _scaleBand, which _sizeCanvas also calls and which
    // has no business having a side effect.
    if (this._superArmed && this._autoScale >= this._superSample - 1e-9) {
      this._superReached = true;
    }
    const band = this._scaleBand();
    // 0 for the panel period: no web API answers it, so the rule learns one.
    const was = this._autoScale;
    const step = this.display.scalePoll(t, band.min, band.max, band.baseLines, 0);
    if (step) [this._autoScale, this._divisor] = step;
    // THE READOUT IS JUDGED AGAINST THE POINT THE RULE IS STEERING, so it hears
    // both halves whenever either moves — and the panel period is one of them
    // here, because this shell has none to declare and the rule LEARNS it (it
    // only ever falls, as the box turns out to be capable of a faster present
    // than anything seen yet). Declared on change rather than every frame: a
    // budget still quoting the first estimate paints an honest box red, and a
    // per-frame setter is a boundary crossing for a value that moves a handful
    // of times a session.
    const panelMs = this.display.scalePanelMs();
    if (panelMs !== this._pacedMs || this._divisor !== this._pacedDivisor) {
      this._pacedMs = panelMs;
      this._pacedDivisor = this._divisor;
      this.perf.pacing(panelMs, this._divisor);
    }
    if (!step) return;
    // WHAT THE RULE ANSWERED, on the console, because a move is an EVENT and the
    // readout only ever shows the current size. Both TV shells print this and
    // the browser did not, so the one platform you can actually sit in front of
    // was the one where a step left no trace — you had to catch the corner
    // changing. Only on a MOVE (the poll is silent), so a settled session says
    // nothing at all.
    console.info(`[stage] scale ${was.toFixed(3)} -> ${this._autoScale.toFixed(3)}`
        + ` (${Math.round(this._autoScale * band.baseLines)} lines)`
        + ` | ${Math.round(1000 / (panelMs || 1000 / 60))}Hz / divisor ${this._divisor}`);
    // …and _onResize drops the window a second time, once the buffer has
    // actually changed size. The rule dropped it at the decision; this catches
    // the reallocation's own stall, which would otherwise be the first thing the
    // next decision sees.
    this._onResize();
  }

  // DEBUG resolution scale: re-point the drawing buffer at n x the layout size,
  // live. ?dpr= picks the value at boot and is the normal way to set it; this is
  // for the one caller that needs to CHANGE it mid-session — scripts/capture-artwork.js,
  // which races at a cheap scale (the artwork rig raster is software GL: full-res
  // 4K measures 0.58 fps, and since _loop clamps dt to 50 ms per frame a slow
  // frame rate stops the sim advancing, so a hero shot at full scale throughout
  // is 20 s of wall clock for 0.6 s of race) and then lifts it for the shot alone.
  //
  // Clamped to the renderer's pixel-ratio cap of 2, but NOT to devicePixelRatio
  // or to the adaptive band the way the automatic path is: a caller naming a
  // scale is asking for a buffer size, and on a DPR-1 screen 2 means supersample,
  // which is exactly what the capture wants. It also LATCHES the request, so the
  // adaptive controller stops touching the buffer from here on.
  //
  // _onResize is the whole of it. The renderer's two chrome pieces used to need
  // the new scale pushed after it (uiScale), and no longer do — they size
  // themselves off the cell rects, which are C++'s own answer and move with the
  // surface. So nothing here has to stay in step with a second copy of the size.
  setRenderScale(n) {
    const v = parseFloat(n);
    this._dprRequest = Number.isFinite(v) && v > 0 ? Math.min(v, 2) : 1;
    // Nothing reads the frame cost from here on, so stop paying for it — a timer
    // query per frame with no reader, on exactly the capture paths that are
    // slowest already. The panel keeps whatever visibility it had.
    if (!this.perf.visible) this.perf.instrument(false);
    this._onResize();        // resolves _dpr from the request, in _sizeCanvas
    return this._dpr;
  }

  _loop(t) {
    if (!this._running) return;
    const rawMs = t - this._last; // true rAF cadence (pre-clamp) for the FPS meter
    // One global dt drives EVERYTHING downstream (sim, cosmetics, camera
    // damping), so the DEBUG slow-mo scale here slows the whole scene uniformly.
    // rawMs stays real → the FPS meter is honest. Clamped at BOTH ends: start()
    // stamps _last from performance.now(), but the rAF callback that follows
    // carries the frame's vsync timestamp, which can sit a fraction of a
    // millisecond EARLIER — and a negative dt runs the camera damping backwards,
    // walking the chase camera away from the car until the scene is off-screen.
    // A fixed step (offline capture) replaces the clock outright — clamp included,
    // since setFixedStep already caps at the same 50 ms.
    const dt = (this._fixedDt || Math.min(Math.max(rawMs, 0) / 1000, 0.05)) * this._timeScale;
    this._last = t;
    if (rawMs > 0 && rawMs < 1000) this.perf.tick(t, rawMs); // skip absurd post-stall deltas
    if (this.onFrame) this.onFrame(dt);
    if (!this.display) { this._scheduleNext(); return; }
    this._adaptScale(t);

    const ids = this.soloCam ? [] : this._order.filter((id) => this.cars.has(id));
    if (ids.length) this._hudHidden = false; // cells are back; the HUD gets placed below
    // Which cars own cells, and which camera rig is running, change on a seat
    // edit — not per frame. Push them only when they actually move, so the
    // steady-state frame really is one call with a dt.
    const cellSig = ids.join(',');
    if (cellSig !== this._cellSig) { this._cellSig = cellSig; this.display.cells(ids); }
    // …and the same for the cell overlay's two flags, BEFORE the frame draws
    // with them: a mask pushed afterwards would leave the bar under a fresh
    // FINISHED card for one frame.
    if (ids.length) this._syncOverlay(ids);
    const mode = ids.length ? null
        : this._free ? CAM.FREE
        : this.bboxOrbit ? CAM.BBOX
        : this.orbit ? CAM.ORBIT : CAM.STILL;
    if (mode !== null && mode !== this._camMode) { this._camMode = mode; this.display.camera(mode); }

    // THE PACING GATE. Everything above is the sim and the scene's bookkeeping
    // and runs every callback; everything below draws. dt is ACCUMULATED across
    // the skipped callbacks rather than dropped, because the renderer's own
    // clock (box bob, cloud drift, skid decay, camera damping) is cosmetic and
    // would otherwise run at a fraction speed whenever the divisor is above 1.
    this._vsyncCount++;
    this._pendingDt += dt;
    if (this._divisor > 1 && this._vsyncCount % this._divisor !== 0) {
      this._scheduleNext();
      return;
    }
    const frameDt = this._pendingDt;
    this._pendingDt = 0;

    if (ids.length === 0) {
      if (this._free) this._stepFreeCam(dt);
      this._renderFrame(frameDt, 0);
      this._hideCellHud();
      this._scheduleNext();
      return;
    }

    this._renderFrame(frameDt, ids.length);

    // Place this frame's HUD over the cells the renderer just drew — ASKING it
    // where they are (_cellRects) instead of scoring the same grid again here.
    // The placement only moves on a seat edit, a resize or a card flip, so the
    // ~40 style writes below latch on a signature of exactly those inputs and
    // the steady-state frame writes no DOM (this file's own rule).
    const cells = this._cellRects(ids.length);
    const hudSig = cellSig + '|'
        + cells.map((r) => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join(';') + '|'
        + ids.map((id) => {
          const c = this.cars.get(id);
          return (c.finished ? 'f' : '') + (c.reconnecting ? 'r' : '');
        }).join(',');
    if (hudSig === this._hudSig) { this._scheduleNext(); return; }
    this._hudSig = hudSig;
    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      const r = cells[i];
      if (!r) return; // more cells than rects: only if the two lists disagree
      // The corner label is hidden while the reconnect card owns the cell — that
      // card already shows the name, so the label would just duplicate it. (The
      // FINISHED card has no name, so it keeps the label.)
      if (c.label) {
        c.label.style.display = c.reconnecting ? 'none' : 'block';
        c.label.style.left = r.x + 'px';
        c.label.style.top = r.y + 'px';
      }
      // place/lap is hidden while a centred card owns the cell; the steer bar
      // goes with it, one layer down — cardOwnsCell is the one predicate both
      // consumers read (pushed as _syncOverlay's bitmask above).
      const cardInCell = cardOwnsCell(c);
      if (c.placeEl) {
        c.placeEl.style.display = cardInCell ? 'none' : 'block';
        c.placeEl.style.left = (r.x + r.w - 12) + 'px';
        c.placeEl.style.top = (r.y + 11) + 'px';
      }
      if (c.finishEl) {
        c.finishEl.style.display = c.finished ? 'flex' : 'none';
        if (c.finished) {
          c.finishEl.style.left = (r.x + r.w / 2) + 'px';
          c.finishEl.style.top = (r.y + r.h / 2) + 'px';
        }
      }
      // Reconnect QR: centred exactly like FINISHED, while their car keeps its
      // place on track. FINISHED wins the cell if both.
      if (c.reconnectEl) {
        const showRc = c.reconnecting && !c.finished;
        c.reconnectEl.style.display = showRc ? 'flex' : 'none';
        if (showRc) {
          c.reconnectEl.style.left = (r.x + r.w / 2) + 'px';
          c.reconnectEl.style.top = (r.y + r.h / 2) + 'px';
        }
      }
    });
    this._scheduleNext();
  }

  // The frame itself, and the only place the perf HUD instruments. The GPU timer
  // brackets THIS call and nothing else: the HUD's own DOM writes and the cell
  // placement below happen outside it, so the number stays a measure of the
  // renderer. (snapshot()/repaint() deliberately go straight to the display —
  // they re-present a frame that was already paid for.)
  _renderFrame(dt, cells) {
    this.perf.setCells(cells);
    this.perf.gpuBegin();
    this.display.frame(dt);
    this.perf.gpuEnd();
    if (this.perf.visible) this.perf.cpu(this.display.profileTotal());
  }

  // Tail of every iteration: idle if asked, else queue the next frame.
  _scheduleNext() {
    // Post-present hook — the drawing buffer still holds this frame's pixels, so
    // a same-task canvas readback here works.
    if (this.onAfterFrame) this.onAfterFrame();
    if (this._idleAfterFrame) { this._idleAfterFrame = false; this._running = false; return; }
    requestAnimationFrame((tt) => this._loop(tt));
  }
}
