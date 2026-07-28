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
// its name plate colour, its place/lap/item chips — plus the roster order the
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
// them now is three setters and no stream: uiScale once at boot, cellCards and
// dividers latched in _loop and pushed only when they change.
import { ordinal } from '../shared/format.js';
import { cssHex, loadBiomes } from '../shared/biomes.js';
import { rosterEntry } from '../shared/trackBin.js';
import { CAM, Display, assetCache } from './render/Display.js';
import { PerfHud } from './render/PerfHud.js';

const ITEM_LABELS = { boost: 'BOOST', banana: 'BANANA', rocket: 'ROCKET', monster: 'MONSTER' };
// The boost chip's twin chevrons, stroked in the biome's boost accent (regenerated
// by _applyBoostShades, default teal for the pre-theme look). Takes a '#rrggbb'
// stroke string. Two forward chevrons, apex-up (= travel), stacked and CENTRED on
// the 24×24 box: each chevron is 6 tall, apexes 7 apart, so the pair spans
// y5.5..18.5 (centre 12) with a 1u gap between the upper arms and the lower apex —
// even, not overlapping.
const boostIconSvg = (stroke) => `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,11.5 12,5.5 19,11.5"/><polyline points="5,18.5 12,12.5 19,18.5"/></svg>`;
const ITEM_ICONS = {
  boost: boostIconSvg('#12a99a'),
  banana: '<img src="/assets/toycar/thumbs/item-banana.png" alt="" draggable="false" decoding="async">',
  // Toy rocket: cream body (red outline), blue porthole, red fins, orange flame — the
  // 2D echo of the in-race procedural model (matched to the same toy palette). Inline
  // SVG like boost, so no baked asset / CSP change is needed.
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="#e6492d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.2c2.7 2.3 4 5.4 4 9.3 0 2-.5 3.8-1.3 5.2H9.3C8.5 15.3 8 13.5 8 11.5c0-3.9 1.3-7 4-9.3z" fill="#fff3e0"/><circle cx="12" cy="9.2" r="1.5" fill="#2d9cdb" stroke="none"/><path d="M8.2 14.2 5.5 16.6l.3 3 2.9-1.4M15.8 14.2l2.7 2.4-.3 3-2.9-1.4z" fill="#e6492d"/><path d="M10.3 19.6c.5 1.3 1.7 2.2 1.7 2.2s1.2-.9 1.7-2.2" stroke="#f2784b"/></svg>',
  // Monster truck: a chunky cab on a high frame over two fat tyres — the 2D echo of
  // the in-race transform (gunmetal frame, purple cab nod to the kit body, dark
  // tyres). Inline SVG like boost/rocket, so no baked asset / CSP change is needed.
  monster: '<svg viewBox="0 0 24 24" fill="none" stroke="#3a3f47" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11.5h14l-1.3-3.2a1.6 1.6 0 0 0-1.5-1H7.8a1.6 1.6 0 0 0-1.5 1L5 11.5z" fill="#7b4fc0"/><path d="M3.5 11.5h17v2.2a1.4 1.4 0 0 1-1.4 1.4H4.9a1.4 1.4 0 0 1-1.4-1.4z" fill="#565b63"/><circle cx="7.2" cy="17.4" r="3.1" fill="#2b2f36" stroke="#1c1f24"/><circle cx="16.8" cy="17.4" r="3.1" fill="#2b2f36" stroke="#1c1f24"/><circle cx="7.2" cy="17.4" r="1.1" fill="#aeb4bd" stroke="none"/><circle cx="16.8" cy="17.4" r="1.1" fill="#aeb4bd" stroke="none"/></svg>'
};
const ITEM_KEYS = Object.keys(ITEM_ICONS);

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
    const automation = this._automation =
        typeof navigator !== 'undefined' && !!navigator.webdriver;
    const dprCap = parseFloat(new URLSearchParams(location.search).get('dpr'));
    this._dpr = Math.min(window.devicePixelRatio || 1,
                         Number.isFinite(dprCap) && dprCap > 0 ? dprCap
                                                               : (automation ? 0.25 : 2));
    this._canvas = document.createElement('canvas');
    this._canvas.id = 'scene-canvas';
    this._canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    // FIRST child: the HUD overlays are later siblings and paint over it.
    container.insertBefore(this._canvas, container.firstChild);
    this._sizeCanvas();
    this._initOverlay();
    // Frame-cost readout, on by default while the game is in development ("P"
    // hides it). Inert while hidden: it instruments the frame only when someone
    // is looking at it.
    this.perf = new PerfHud(this.container, this._canvas);
    this._assets = assetCache();
    this._free = null;       // free-cam state, once enableUserCamera() runs
    this._cellSig = null;    // last pushed cell list / camera mode (see _loop)
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
    // The renderer draws two pieces of chrome now (the steer bar and the cell
    // dividers), and their sizes are authored in CSS pixels. This is the one
    // number that converts them — the same _dpr the canvas was sized by and
    // that _cellRects divides the answer back out with.
    this.display.uiScale(this._dpr);
    // The other half of the automation budget (see the DPR cap in the ctor):
    // drop the per-track shadow bake. Must be set before any setTrack, since
    // the map is baked into the scene at build time.
    if (this._automation) this.display.shadows(false);
    return this.display;
  }

  _sizeCanvas() {
    const w = Math.max(1, Math.round(this.container.clientWidth * this._dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * this._dpr));
    this._canvas.width = w;
    this._canvas.height = h;
    return { w, h };
  }

  _onResize() {
    const { w, h } = this._sizeCanvas();
    if (this.display) this.display.resize(w, h);
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
    ITEM_ICONS.boost = boostIconSvg(cssHex(b.boostIcon(this._biome)));
    return this._rebuild();
  }

  // The biome this track is being drawn in — the race-music pool key.
  biome() { return this._biome; }

  // The roster the renderer bakes models and liveries into, in SLOT order: cars
  // that own a cell first, in cell order, then the rest of the field. Every
  // frame then finds a car's slot by its id, so this order only has to be
  // stable within one build, not to mean anything to the sim.
  _roster() {
    const seen = new Set(this._order.filter((id) => this.cars.has(id)));
    const all = [...seen, ...[...this.cars.keys()].filter((id) => !seen.has(id))];
    return all.map((id) => {
      const c = this.cars.get(id);
      return rosterEntry(id, c.name || '', c.carIndex ?? 0,
          this.colors[(c.colorIndex ?? 0) % this.colors.length], window.CAR_MODELS);
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
          const sig = JSON.stringify(roster);
          if (sig === this._rosterSig) continue; // a seat edit the renderer can't see
          this._rosterSig = sig;
          try {
            await this.display.setTrack(this._track.id, this._biome, roster, this._assets);
          } catch (e) {
            this._rosterSig = null; // let the next change retry
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

  // Force a rebuild even when the roster comes out identical — a new race on the
  // same track with the same field still wants the scene back at its opening
  // state (cones upright, boxes uncollected, no skid patina).
  rebuild() { this._rosterSig = null; return this._rebuild(); }

  // The session whose cars get drawn. 0 / null clears it (an empty track).
  bindSession(handle) {
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
    }

    this.cars.set(id, c);
    if (cell && !this._order.includes(id)) this._order.push(id);
    // The renderer bakes a car's model and livery into its slot at scene build,
    // so any change to the field needs one: the lobby's attract race starts its
    // cars a tick AFTER the track lands, phones join and leave mid-lobby, and
    // the race grid then replaces the whole demo field.
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
  _cellRects(n) {
    const packed = this.display.cellRects(n);
    const k = 1 / this._dpr;
    const out = [];
    for (let i = 0; i + 3 < packed.length; i += 4) {
      out.push({ x: packed[i] * k, y: packed[i + 1] * k,
                 w: packed[i + 2] * k, h: packed[i + 3] * k });
    }
    return out;
  }

  // Push what the renderer's own cell overlay needs, on change only. Two latched
  // values, neither of them per-frame state: which cells have a centred card
  // over them (so the steer bar under it goes), and the divider toggle. The
  // third, uiScale, is a constant and goes across once in boot().
  //
  // The rules themselves are NOT computed here any more. They used to be built
  // from the CSS-pixel rects — one per distinct cell edge — and the renderer now
  // derives the same set from the same grid, so the seam is exactly where the
  // viewport edge is rather than a rounded-back copy of it.
  _syncOverlay(ids) {
    let mask = 0;
    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (c && (c.finished || c.reconnecting)) mask |= 1 << i;
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
  enableUserCamera() {
    if (this._free) return this._free;
    this.orbit = false;
    this.bboxOrbit = false;
    const dom = this.container;
    // Start on the same iso framing the still overview uses, looking at the
    // track centre. Yaw/pitch are then driven by the drag.
    const f = { eye: { x: 60, y: 45, z: 60 }, yaw: Math.PI * 1.25, pitch: -0.5,
                keys: new Set(), fly: 40 };
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
  // Render exactly one more frame with the state set so far, then halt. Gallery
  // previews hold a still this way instead of redrawing an unchanged scene at
  // 60fps; the held frame renders fully, so resuming picks up seamlessly.
  pauseAfterFrame() { if (this._running) this._idleAfterFrame = true; }

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
    const dt = Math.min(Math.max(rawMs, 0) / 1000, 0.05) * this._timeScale;
    this._last = t;
    if (rawMs > 0 && rawMs < 1000) this.perf.tick(t, rawMs); // skip absurd post-stall deltas
    if (this.onFrame) this.onFrame(dt);
    if (!this.display) { this._scheduleNext(); return; }

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

    if (ids.length === 0) {
      if (this._free) this._stepFreeCam(dt);
      this._renderFrame(dt, 0);
      this._hideCellHud();
      this._scheduleNext();
      return;
    }

    this._renderFrame(dt, ids.length);

    // Place this frame's HUD over the cells the renderer just drew — ASKING it
    // where they are (_cellRects) instead of scoring the same grid again here.
    const cells = this._cellRects(ids.length);
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
      // place/lap is hidden while a centred card owns the cell — when the player
      // has FINISHED or has dropped and is shown the reconnect QR. The steer bar
      // goes with it, one layer down: same predicate, pushed as _syncOverlay's
      // bitmask above.
      const cardInCell = c.finished || c.reconnecting;
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
