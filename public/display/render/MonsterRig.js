// Monster-truck VARIANT of any toy car: keep the kit monster truck's WHEELS and
// grey CHASSIS (suspension arms, drivetrain block, axle rods) and graft the
// player's car body in place of the monster cab. The result reads as a real
// monster truck — body high on a visible suspension over big wheels — rather than
// just a car on bigger tyres.
//
// The kit's vehicle-monster-truck.glb ships a single `body` mesh; it's split
// offline (scripts/split-monster-body.js) into `chassis` (the kept frame), `cab`
// (dropped — the car body takes its place), and `chassis-trim` (the round shock
// pods over the wheels + the rear spoiler bar, also dropped). The car and the
// monster share a wheelbase (wheels at z ±0.25), so the body seats naturally.
//
// Pure scene-graph composition: no renderer state, no game logic. The asset gallery
// uses it to preview the look; the in-game "monster" item transform will reuse the
// same rules so preview and game match.
import * as THREE from 'three';

const WHEEL_NAMES = ['wheel-fl', 'wheel-fr', 'wheel-bl', 'wheel-br'];

// The kit GLB that supplies the monster chassis + wheels (see split-monster-cab.js).
export const MONSTER_BASE_ASSET = 'vehicle-monster-truck';

// The kit chassis is part-grey, part-PURPLE (the shock towers sit in a purple band
// of the colormap) — left as-is it clashes with every car colour and reads like a
// leftover cab. Recolour the whole frame to one neutral gunmetal so it reads as a
// proper monster suspension under any body.
const MONSTER_CHASSIS_COLOR = 0x565b63;

export const MONSTER_DEFAULTS = {
  bodyScale: 1.0,  // scale applied to the grafted car body
  mountLift: 0.0,  // extra Y nudge on top of bottom-aligning the body into the cab slot
  baseScale: 1.0,  // overall rig scale — the in-game "bigger" multiplier rides on top
};

function findWheels(root) {
  return WHEEL_NAMES.map((n) => root.getObjectByName(n)).filter(Boolean);
}

// True world-space bbox of a mesh's *indexed* triangles. The cab shares its vertex
// buffer with the chassis (the split is index-only), so Box3.setFromObject — which
// bounds the whole position attribute — would span the entire body. We walk only
// the indices this mesh actually draws.
function indexedWorldBox(mesh, target) {
  const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
  mesh.updateWorldMatrix(true, false);
  target.makeEmpty();
  if (!idx) return target.setFromObject(mesh);
  const v = new THREE.Vector3();
  for (let i = 0; i < idx.count; i++) {
    target.expandByPoint(v.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(mesh.matrixWorld));
  }
  return target;
}

// The shared base for every monster build: a clone of the (cab-split) monster
// truck with the cab dropped and the chassis recoloured to gunmetal. Returns the
// posed base (wheels touch y≈0) plus the measured cab `slot` (where a body seats).
function buildMonsterBase(monsterScene) {
  const base = monsterScene.clone(true);
  base.updateMatrixWorld(true);
  const cab = base.getObjectByName('cab');
  const slot = new THREE.Box3();
  let hasCab = false;
  if (cab) { indexedWorldBox(cab, slot); cab.parent && cab.parent.remove(cab); hasCab = true; }
  // Drop the round wheel pods + rear spoiler bar (the kit's `chassis-trim`) so only
  // the bare frame remains.
  const trim = base.getObjectByName('chassis-trim');
  if (trim) trim.parent && trim.parent.remove(trim);
  // Recolour the chassis to neutral gunmetal (clone the material first so the
  // wheels, which share it, keep their dark tyre colour).
  const chassisMesh = base.getObjectByName('chassis');
  if (chassisMesh && chassisMesh.isMesh) {
    chassisMesh.material = chassisMesh.material.clone();
    chassisMesh.material.map = null;
    chassisMesh.material.color = new THREE.Color(MONSTER_CHASSIS_COLOR);
  }
  return { base, slot, hasCab };
}

// The bare monster chassis + wheels (cab removed, recoloured) on its own — the
// building block the variants graft a car body onto. Returns a THREE.Group resting
// on the ground.
export function buildMonsterChassis(monsterScene) {
  const { base } = buildMonsterBase(monsterScene);
  base.name = 'monster-chassis';
  return base;
}

// Build a monster-truck rig from a loaded car GLB scene + the loaded (cab-split)
// vehicle-monster-truck scene. Returns a THREE.Group resting on the ground (wheels
// touch y≈0), authored facing preserved (the caller rotates it for travel like any
// other car). Inputs are cloned, so the source scenes are untouched.
export function buildMonsterRig(carScene, monsterScene, opts = {}) {
  const o = { ...MONSTER_DEFAULTS, ...opts };
  const rig = new THREE.Group();
  rig.name = 'monster-rig';

  // Monster base = wheels + chassis, cab removed; `slot` is where the cab was.
  const { base, slot, hasCab } = buildMonsterBase(monsterScene);
  rig.add(base);

  // Car body = the car GLB with its wheels (and the exposed axle rod, if any)
  // stripped, so only the body shell remains. Named so the in-race transform can
  // grab it as the lean/pitch handle (SceneRenderer.setCarMonster).
  const body = carScene.clone(true);
  body.name = 'monster-body';
  for (const w of findWheels(body)) w.parent && w.parent.remove(w);
  const axle = body.getObjectByName('axle');
  if (axle) axle.parent && axle.parent.remove(axle);
  body.scale.setScalar(o.bodyScale);
  body.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(body);

  // Seat the body into the cab slot: centre it on the slot in X/Z and bottom-align
  // it to the slot floor (so the body perches on the chassis exactly where the cab
  // did, and the suspension arms tuck up into its underside as the kit intends).
  if (hasCab) {
    const slotCtr = slot.getCenter(new THREE.Vector3());
    const bbCtr = bb.getCenter(new THREE.Vector3());
    body.position.set(
      slotCtr.x - bbCtr.x,
      (slot.min.y - bb.min.y) + o.mountLift,
      slotCtr.z - bbCtr.z
    );
  }
  rig.add(body);

  rig.scale.setScalar(o.baseScale);
  return rig;
}
