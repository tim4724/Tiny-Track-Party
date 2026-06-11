// LobbyDemo — attract-mode race that plays under the orbiting lobby preview once a
// track is picked. It reuses the real Game engine and the pure-pursuit AI (AiDriver)
// to drive every car on autopilot, showing the liveries/models the players have
// CURRENTLY picked topped up to a full grid with CPU racers. Cars are added
// cell:false so the renderer keeps its single orbiting overview camera (no
// split-screen) and frames the whole track; the loop re-grids and laps forever.
//
// This is lobby eye-candy only — no net, no HUD, no results. The real race
// (RaceSession) takes over the scene the instant the host starts it. The field +
// per-frame stepping mirror display/main.js's driveBots so the cars drive, dodge
// hazards, and contest items exactly as they will in the race.
import { Game } from './engine/Game.js';
import { AiController } from './AiDriver.js';

const DEMO_SEED = 0x5eed; // base for the bots' wander streams — lobby determinism doesn't
                          // matter, this just keeps each bot's weave distinct.

export class LobbyDemo {
  constructor(scene) {
    this.scene = scene;
    this.track = null;
    this.field = [];        // [{ id, colorIndex, carIndex, name, stats, persona }]
    this.engine = null;
    this.bots = new Map();  // car id -> AiController
    this._ids = [];         // scene car ids we own, so stop() removes exactly ours
    this.sig = null;        // caller-supplied field/track signature (skip no-op rebuilds)
    this.active = false;
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
    this._buildEngine();
    field.forEach((p, i) => {
      this.scene.addCar(p.id, p.colorIndex, p.name, { cell: false, carIndex: p.carIndex });
      // Each car drives on an AI persona (skill/laneBias) even when it's a human's
      // livery — there are no phones steering in the lobby. Distinct seeds → distinct weave.
      this.bots.set(p.id, new AiController({ ...(p.persona || {}), seed: (DEMO_SEED + i * 2 + 1) >>> 0 }));
    });
    this._placeGrid();
    this.active = true;
  }

  _buildEngine() {
    this.engine = new Game(this.field.map((p) => ({ id: p.id, stats: p.stats })), this.track, { onEvent() {} });
  }

  // Swap one car's model/livery WITHOUT restarting the demo race: re-resolve its
  // engine handling in place, then rebuild just its scene mesh (addCar bakes the
  // model at creation) and re-pose it at its current spot so it keeps driving from
  // where it was — no re-grid. Used when a player changes their lobby car pick.
  swapCar(id, { colorIndex, carIndex, name, stats }) {
    if (!this.engine || !this.engine.cars.has(id)) return;
    this.engine.setCarStats(id, stats);
    const rec = this.field.find((p) => p.id === id); // keep our field record current for a later full rebuild
    if (rec) { rec.colorIndex = colorIndex; rec.carIndex = carIndex; rec.name = name; rec.stats = stats; }
    this.scene.removeCar(id);
    this.scene.addCar(id, colorIndex, name, { cell: false, carIndex });
    const car = this.engine.cars.get(id);
    if (car && car.pose) this.scene.setCarPose(id, car.pose.pos, car.pose.forward, car.pose.up); // place at its current pose so it doesn't pop to the grid for a frame
  }

  _placeGrid() {
    for (const c of this.engine.getSnapshot().cars) {
      if (c.pose) this.scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up);
    }
  }

  // One render-loop tick (driven by SceneRenderer.onFrame; dt in seconds). A no-op
  // until start() has run, so the display can call it unconditionally each frame.
  step(dt) {
    if (!this.active || !this.engine) return;
    const cl = this.track.centerline;
    for (const c of this.engine.cars.values()) {
      if (!c.finished && c.pose) this.engine.processInput(c.id, this.bots.get(c.id).drive(c, cl, this.engine));
    }
    this.engine.update(dt * 1000);
    const snap = this.engine.getSnapshot();
    for (const c of snap.cars) {
      if (c.pose) this.scene.setCarPose(c.id, c.pose.pos, c.pose.forward, c.pose.up, c.steer, c.spd, c.onWall, c.steerInput, c.spin, c.boostMul, c.brake);
    }
    this.scene.syncProps(snap); // item boxes pop + dropped bananas, same as a live race
    if (this.engine.raceOver) { this._buildEngine(); this._placeGrid(); } // endless: re-grid + lap again
  }

  stop() {
    this.active = false;
    for (const id of this._ids) this.scene.removeCar(id);
    this._ids = [];
    this.bots.clear();
    this.engine = null;
  }
}
