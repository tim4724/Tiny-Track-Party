// LobbyDemo — attract-mode race that plays under the orbiting lobby preview once a
// track is picked. It runs the real sim (NativeRaceSession → the C++ engine in WASM) in
// BARE mode — racing from frame 0, no countdown, no session lifecycle — with every car
// driven by an in-wasm AI bot, showing the liveries/models the players have CURRENTLY
// picked topped up to a full grid with CPU racers. Cars are added cell:false so the
// renderer keeps its single orbiting overview camera (no split-screen) and frames the
// whole track; the loop re-grids and laps forever.
//
// This is lobby eye-candy only — no net, no HUD, no results. The real race takes over
// the scene the instant the host starts it. The field + per-frame stepping mirror
// display/main.js's race loop so the cars drive, dodge hazards, and contest items
// exactly as they will in the race.
import { init as initNativeSim, NativeRaceSession } from './NativeRaceSession.js';

const DEMO_SEED = 0x5eed; // base for the bots' wander streams — lobby determinism doesn't
                          // matter, this just keeps each bot's weave distinct.

// The native sim is initialised once at boot by main.js (top-level await), so this is
// already resolved by the time a lobby demo can start. We hold our own handle on it so a
// surface that pulls LobbyDemo in on its own still gets a working demo, and so a failed
// init is reported rather than silently rendering an empty track.
let simReady = null;
const ensureSim = () => (simReady = simReady || initNativeSim());

export class LobbyDemo {
  constructor(scene) {
    this.scene = scene;
    this.track = null;
    this.field = [];        // [{ id, colorIndex, carIndex, name, stats, persona }]
    this.engine = null;
    this._ids = [];         // scene car ids we own, so stop() removes exactly ours
    this.sig = null;        // caller-supplied field/track signature (skip no-op rebuilds)
    this.active = false;
    this._epoch = 0;        // bumped by every start/stop, so a pending build can tell it's stale
  }

  // (Re)build the demo for `track` with `field`. Tears down any previous run first,
  // so it's safe to call on every track switch / roster change. `sig` is stored so
  // the caller can compare against it next time and skip a redundant rebuild.
  start(track, field, sig) {
    this.stop();
    this.track = track;
    this.field = field;
    this.sig = sig;
    this._ids = field.map((p) => p.id);
    const epoch = ++this._epoch;
    // Deferred by a microtask (the sim promise is already resolved) so the demo can't
    // race the module load. stop()/start() bump the epoch, cancelling a stale build.
    ensureSim().then(() => {
      if (epoch !== this._epoch) return;
      this.engine = this._buildEngine();
      for (const p of field) this.scene.addCar(p.id, p.colorIndex, p.name, { cell: false, carIndex: p.carIndex });
      this.scene.bindSession(this.engine.h); // the renderer draws this session's cars
      this.active = true;
    }).catch((e) => console.warn('[LobbyDemo] native sim unavailable — no attract race', e));
  }

  // Every car drives on an AI persona (caution/laneBias) even when it's a human's
  // livery — there are no phones steering in the lobby. The bots live inside the wasm,
  // so the personas go in at construction; distinct seeds → distinct weave.
  _buildEngine() {
    const players = this.field.map((p) => ({ peerIndex: p.id, stats: p.stats }));
    const bots = this.field.map((p, i) => {
      const persona = p.persona || {};
      return {
        peerIndex: p.id,
        caution: persona.caution != null ? persona.caution : 1,
        laneBias: persona.laneBias != null ? persona.laneBias : 0,
        seed: (DEMO_SEED + i * 2 + 1) >>> 0
      };
    });
    const engine = new NativeRaceSession(players, this.track, { bots });
    engine.startBare(); // attract mode: already racing, no countdown to sit through
    return engine;
  }

  // Swap one car's model/livery WITHOUT restarting the demo race: the sim keeps
  // driving, and the re-registration below lands in Stage._rebuild as a
  // roster-only change — an in-place re-dress (ttp_display_reroster) that swaps
  // the model in its slot while the scene, the skids and the preview camera's
  // orbit phase all stay put. Used when a player changes their lobby car pick.
  // The new handling stats only land on the next full rebuild (join/leave/track
  // switch): the native ABI has no re-stat hook, and re-seating the car in a fresh
  // session would pop the whole field back to the grid, which is the visible cost the
  // attract loop is avoiding. Handling differences are invisible in eye-candy anyway.
  swapCar(id, { colorIndex, carIndex, name, stats }) {
    if (!this.engine || !this.engine.hasCar(id)) return;
    const rec = this.field.find((p) => p.id === id); // keep our field record current for that later rebuild
    if (rec) { rec.colorIndex = colorIndex; rec.carIndex = carIndex; rec.name = name; rec.stats = stats; }
    // In place, NOT removeCar + addCar: re-adding would move the car to the end
    // of the roster, and a reordered roster is a full build (slot identity).
    this.scene.updateCar(id, { colorIndex, carIndex, name });
  }

  // One frame-loop tick (driven by Stage.onFrame; dt in seconds). A no-op until
  // start() has run, so the display can call it unconditionally each frame.
  step(dt) {
    if (!this.active || !this.engine) return;
    this.engine.update(dt * 1000); // the bots are stepped inside ttp_update, in the live loop's order
    // Endless: once every car is home, re-grid and lap again. Bare mode has no
    // session layer to fire a raceEnd, so this is the engine's own `raceOver`
    // rule (finishedOrder >= cars). Polled every half second rather than every
    // frame — the renderer no longer needs a snapshot, and a lap takes a minute,
    // so reading the whole field 60 times a second to ask "done yet?" is the
    // only thing that would still be marshalling state for the attract loop.
    if ((this._tick = (this._tick || 0) + 1) % 30) return;
    // Per-car scalar reads, not a ~4 KB snapshot parse for one boolean.
    const ids = this.engine.carIds();
    if (ids.length > 0 && ids.every((id) => this.engine.carFinished(id))) {
      this.engine.dispose();
      this.engine = this._buildEngine();
      this.scene.bindSession(this.engine.h);
    }
  }

  // Unbinds only OUR session. stop() doubles as the "make sure the demo isn't
  // running" call — refreshLobbyDemo fires it on every roster change, including
  // ones that land mid-race — so a blind bindSession(0) here cut the RACE's
  // session out of the renderer: no cars drawn at all, and with every cell's car
  // missing the chase cameras fell back to the whole-track overview for the rest
  // of the race. The seat edit that triggers it is ordinary (a phone joining
  // during the countdown; in ?solo the roster settles a beat after launchRace).
  stop() {
    this.active = false;
    this._epoch++; // cancels a start still waiting on the sim module
    // engine and binding are set together (and only together), so this is
    // exactly "the renderer is drawing the demo".
    if (this.engine) {
      this.scene.bindSession(0);
      this.engine.dispose();
      this.engine = null;
    }
    for (const id of this._ids) this.scene.removeCar(id);
    this._ids = [];
  }
}
