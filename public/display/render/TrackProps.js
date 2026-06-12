// Track props with per-frame behaviour: oil slicks + their kickable warning
// cones, boost pads, item boxes (idle/collect animation), dropped bananas, and
// the ?bbox collision-outline debug overlay. Owns the hazard scene group; the
// engine stays authoritative — everything here is render-side juice.
import * as THREE from 'three';
import { makePadTexture } from './textures.js';

// Oil-slick warning cones. They're cosmetic (the sim drives straight through), so
// a car that gets close PUNTS them: the cone arcs up, tumbles, bounces with
// friction, and settles back upright wherever it lands — pure render-side juice,
// consistent across every split-screen view (one shared scene). Starting values.
const OIL_RADIUS_FALLBACK = 0.7; // puddle radius when a hazard omits one (display normally sizes it to track width)
const CONE_H = 0.3;            // cone height in world units (small toy marker)
const CONE_KICK_R = 0.7;      // car-centre → cone distance (world units) that punts a cone
const CONE_KICK_MIN = 2.5;    // launch speed even at a crawl
const CONE_KICK_GAIN = 6.0;   // extra launch speed at full pace (× the car's normalised speed)
const CONE_KICK_UP = 2.6;     // upward pop on a kick
const CONE_GRAVITY = 16.0;    // fall acceleration (units/s²)
const CONE_RESTITUTION = 0.42;// vertical bounciness on hitting the road
const CONE_FRICTION = 0.6;    // horizontal speed + tumble retained per ground contact
const CONE_SETTLE = 0.4;      // residual speed below which a cone comes to rest
const CONE_EDGE_MARGIN = 0.35;// keep cones this far inside the road edge (off the curb/wall)
const CONE_WALL_RESTITUTION = 0.5; // bounce energy kept when a kicked cone hits the curb

// Item-box "flashy" idle animation (see _stepBoxes): spin about its up axis, bob on
// a sine, and pulse a gold emissive sparkle so it reads as a grabbable pickup.
const BOX_SPIN = 1.6;    // rad/s
const BOX_BOB_AMP = 0.07; // world units of bob
const BOX_BOB_W = 3.0;    // bob angular speed (rad/s)
const BOX_H = 0.3;        // item-box height in world units (0.6× the previous 0.5)
// Collect burst: when a box is picked up it GROWS while it FADES out, then hides
// (a clear "poof, grabbed" beat to pair with the HUD roulette). Starting values:
// tune BOX_COLLECT_TIME up if it's too quick to read, BOX_COLLECT_GROW for punch.
const BOX_COLLECT_TIME = 0.35; // seconds the grow+fade burst lasts
const BOX_COLLECT_GROW = 1.1;  // extra scale at burst end (final ≈ 2.1× rest)

export class TrackProps {
  constructor(scene, protos, bbox) {
    this.protos = protos;     // shared GLB prototype cache (filled by SceneRenderer.load)
    this._bbox = bbox;        // ?bbox=1 debug-outline flag
    this._padTex = makePadTexture();
    // Hazards/props live in their own group so they clear with the track without
    // touching the cars/decals; the debug group persists across tracks.
    this.hazardGroup = new THREE.Group();
    scene.add(this.hazardGroup);
    this._dbgGroup = new THREE.Group();
    scene.add(this._dbgGroup);
    this._cones = [];          // kickable cone state {mesh, home, homeQuat, vel, spinAxis, spinRate, airborne}
    this._boxes = [];          // item-box meshes (indexed parallel to track.boxes)
    this._bananaMeshes = new Map(); // banana id -> mesh, reconciled from snapshot.bananas
    this._dbgStatic = [];      // [{kind, s, lat, radius}] static props for the ?bbox overlay
    this._centerline = null;
    this._roadHalf = 1.8;
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._coneTmp = new THREE.Vector3();   // scratch for the airborne-cone road clamp
    this._coneTmp2 = new THREE.Vector3();
    this._sBananaUp = new THREE.Vector3(); // scratch for the per-frame banana up vector
    this._liveBananas = new Set();         // reused per-frame live-id set; cleared, never reallocated
  }

  // Rebuild everything for a new track layout.
  setTrack(track) {
    this._buildHazards(track);
    this._buildProps(track);
    this._drawDebug({}); // static-prop bbox rings (cars/bananas added per-frame in sync)
  }

  // Advance the cosmetic prop animations one frame.
  step(dt, cars) {
    this._stepCones(dt, cars);
    this._stepBoxes(dt);
  }

  // Boost pads + item boxes (static, authored). Pads are glowing chevron discs;
  // boxes float above the road and are shown/hidden per frame from the snapshot
  // (see syncProps). Added to hazardGroup so they clear with the track; box meshes
  // share the proto (not `owned`, so the hazard cleanup removes but never disposes
  // them). Resets the box list + banana-mesh map (their meshes were just cleared).
  _buildProps(track) {
    for (const b of (this._boxes || [])) { for (const m of (b.mats || [])) m.dispose(); if (b.geom) b.geom.dispose(); }
    this._boxes = [];
    this._bananaMeshes = new Map();
    const cl = track.centerline;
    const Y = new THREE.Vector3(0, 1, 0);
    for (const p of (track.pads || [])) {
      const radius = p.radius || 0.65;
      this._dbgStatic.push({ kind: 'pad', s: p.s, lat: p.lat || 0, radius });
      const f = cl.sampleAt(p.s);
      const up = f.up.clone().normalize();
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 28),
        new THREE.MeshBasicMaterial({
          map: this._padTex, transparent: true, opacity: 0.95, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
        })
      );
      disc.userData.owned = true; // owns its geometry+material (dispose on rebuild)
      disc.position.copy(f.pos).addScaledVector(f.lateral, p.lat).addScaledVector(up, 0.025);
      // basis (lateral=X, tangent=Y, up=Z) lays the disc in the road plane with its
      // texture +Y (chevrons) pointing along travel.
      disc.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(f.lateral.clone().normalize(), f.tangent.clone().normalize(), up));
      disc.renderOrder = -1;
      this.hazardGroup.add(disc);
    }
    const boxProto = this.protos.get('item-box');
    for (const b of (track.boxes || [])) {
      this._dbgStatic.push({ kind: 'box', s: b.s, lat: b.lat || 0, radius: b.radius || 0.65 });
      const f = cl.sampleAt(b.s);
      const up = f.up.clone().normalize();
      let mesh;
      if (boxProto) {
        mesh = boxProto.clone(true);
        const bb = new THREE.Box3().setFromObject(mesh);
        mesh.scale.setScalar(BOX_H / Math.max(1e-3, bb.max.y - bb.min.y));
        mesh.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      } else {
        // No GLB: a plain box that OWNS its geometry. Not flagged `owned` — its cloned
        // material goes in `mats` and its geometry in `geom` (both disposed in the
        // _buildProps preamble), so the hazard cleanup must not also dispose them.
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4),
          new THREE.MeshStandardMaterial({ color: 0xffc94d }));
      }
      mesh.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, 0.28); // float above the road
      mesh.quaternion.setFromUnitVectors(Y, up);
      // Clone this box's materials so it can fade + pulse INDEPENDENTLY of its
      // siblings (boxProto.clone shares materials by reference). transparent:true lets
      // the collect burst taper opacity to zero. Disposed at the top of _buildProps on
      // a track change (the GLB box meshes aren't flagged `owned`, so cleanup skips them).
      const mats = [];
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const arr = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = arr.map((m) => { const cm = m.clone(); cm.transparent = true; return cm; });
        o.material = Array.isArray(o.material) ? cloned : cloned[0];
        for (const cm of cloned) mats.push(cm);
      });
      this.hazardGroup.add(mesh);
      // spin/bob/collect state (see _stepBoxes). homeY is the rest height, phase
      // desyncs the bob, baseS the rest scale to grow from / restore to, collectT
      // counts down the grow+fade pickup burst, available mirrors the snapshot.
      this._boxes.push({
        mesh, mats, geom: boxProto ? null : mesh.geometry, homeY: mesh.position.y, baseS: mesh.scale.x,
        phase: this._boxes.length * 0.9, collectT: 0, available: true
      });
    }
  }

  // A flat circle outline (LineLoop) of radius r in the plane spanned by axisA/axisB,
  // for the ?bbox debug overlay. depthTest off so it shows through geometry.
  _dbgCircle(center, axisA, axisB, r, color) {
    const seg = 28, pts = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(center.clone().addScaledVector(axisA, Math.cos(a) * r).addScaledVector(axisB, Math.sin(a) * r));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 20;
    return line;
  }

  // A rectangle outline for a car's collision footprint (2·hl along × 2·hw across).
  _dbgRect(center, along, side, hl, hw, color) {
    const pts = [
      center.clone().addScaledVector(along, hl).addScaledVector(side, hw),
      center.clone().addScaledVector(along, hl).addScaledVector(side, -hw),
      center.clone().addScaledVector(along, -hl).addScaledVector(side, -hw),
      center.clone().addScaledVector(along, -hl).addScaledVector(side, hw),
    ];
    pts.push(pts[0]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 20;
    return line;
  }

  // ?bbox debug: redraw the collision/trigger outlines each frame. Static props
  // (oil/pad/box) come from _dbgStatic; bananas + cars from the live snapshot.
  // Cars use the exact (s, lat) collision frame (centreline tangent/lateral), so the
  // box matches the engine's AABB rather than the heading-rotated render pose.
  _drawDebug(snap) {
    if (!this._bbox) return;
    const g = this._dbgGroup;
    // each child owns a one-off geometry AND material (made fresh per frame in
    // _dbgCircle/_dbgRect) — dispose both or the LineBasicMaterials pile up on the GPU.
    for (const ch of g.children) { ch.geometry.dispose(); if (ch.material) ch.material.dispose(); }
    g.clear();
    const cl = this._centerline;
    if (!cl) return;
    const COL = { oil: 0xff3b3b, pad: 0x2bd1c4, box: 0xffd23f };
    const ring = (s, lat, r, color) => {
      const f = cl.sampleAt(s), up = f.up.clone().normalize();
      const center = f.pos.clone().addScaledVector(f.lateral, lat).addScaledVector(up, 0.06);
      g.add(this._dbgCircle(center, f.tangent.clone().normalize(), f.lateral.clone().normalize(), r, color));
    };
    for (const d of this._dbgStatic) ring(d.s, d.lat, d.radius, COL[d.kind] || 0xffffff);
    for (const b of (snap.bananas || [])) ring(b.s, b.lat, b.radius || 0.6, 0xff9f1c);
    for (const c of (snap.cars || [])) {
      if (c.totalS == null) continue;
      const f = cl.sampleAt(c.totalS), up = f.up.clone().normalize();
      const center = f.pos.clone().addScaledVector(f.lateral, c.lat || 0).addScaledVector(up, 0.06);
      g.add(this._dbgRect(center, f.tangent.clone().normalize(), f.lateral.clone().normalize(), c.halfLen || 0.44, c.halfWid || 0.26, 0x39e639));
    }
  }

  // Per-frame prop reconcile from the engine snapshot: show only available (off-
  // cooldown) item boxes, and create/move/remove dropped-banana meshes by id.
  sync(snap) {
    this._drawDebug(snap); // ?bbox overlay (no-op unless enabled)
    if (this._boxes && snap.boxes) {
      for (let i = 0; i < this._boxes.length; i++) {
        const b = this._boxes[i];
        const avail = !!snap.boxes[i];
        if (avail === b.available) continue; // no edge → leave the burst/idle running
        b.available = avail;
        if (avail) {                         // respawned: cancel any burst, restore, show
          b.collectT = 0;
          b.mesh.scale.setScalar(b.baseS);
          for (const m of b.mats) m.opacity = 1;
          b.mesh.visible = true;
        } else {                             // collected: kick off the grow+fade burst
          b.collectT = BOX_COLLECT_TIME;
        }
      }
    }
    if (!this._bananaMeshes) return;
    const incoming = snap.bananas || [];
    if (incoming.length === 0 && this._bananaMeshes.size === 0) return; // steady state: no allocations
    const proto = this.protos.get('item-banana');
    const live = this._liveBananas; live.clear(); // reused scratch set — no per-frame alloc while bananas are in flight
    for (const b of incoming) {
      live.add(b.id);
      let m = this._bananaMeshes.get(b.id);
      if (!m && this._centerline) {
        if (proto) {
          m = proto.clone(true);
          const bb = new THREE.Box3().setFromObject(m);
          m.scale.setScalar(0.35 / Math.max(1e-3, bb.max.y - bb.min.y));
          m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        } else {
          m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffe14d }));
          m.userData.owned = true;
        }
        this.hazardGroup.add(m);
        this._bananaMeshes.set(b.id, m);
      }
      if (m) {
        const f = this._centerline.sampleAt(b.s);
        const up = this._sBananaUp.copy(f.up).normalize(); // scratch — no per-frame alloc
        m.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, 0.05);
        m.quaternion.setFromUnitVectors(this._worldUp, up);
      }
    }
    for (const [id, m] of this._bananaMeshes) {
      if (!live.has(id)) {
        if (m.userData.owned) { m.geometry.dispose(); m.material.dispose(); } // fallback mesh owns its geo/mat
        this.hazardGroup.remove(m); this._bananaMeshes.delete(id);
      }
    }
  }

  // Draw the track's oil slicks: a glossy dark disc on the road per hazard, ringed
  // with item-cone warning markers. Static (placed once from track.hazards +
  // centreline), so this just rebuilds the hazardGroup when the track changes.
  // Cone meshes share the cached proto geometry/material, so only the disc (its
  // own geometry + material) is disposed on rebuild — never the shared proto.
  _buildHazards(track) {
    this.hazardGroup.traverse((m) => {
      if (m.isMesh && m.userData.owned) { m.geometry.dispose(); m.material.dispose(); }
    });
    this.hazardGroup.clear();
    this._cones = [];
    this._dbgStatic = []; // rebuilt here (oil) + in _buildProps (pads, boxes), called right after
    // Set the centerline + road half-width UNCONDITIONALLY (before the no-oil early
    // return): _stepCones and syncProps (banana meshes) both need them even on a
    // track that has boxes/pads but no oil slicks.
    this._centerline = track.centerline;
    this._roadHalf = (track.roadWidth || 3.6) / 2;
    const hz = track.hazards || [];
    for (const h of hz) this._dbgStatic.push({ kind: 'oil', s: h.s, lat: h.lat || 0, radius: h.radius || OIL_RADIUS_FALLBACK });
    if (!hz.length) return;
    const cl = track.centerline;
    const coneEdge = this._roadHalf - CONE_EDGE_MARGIN; // max lateral offset that stays off the curb
    const coneProto = this.protos.get('item-cone');
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
    for (const h of hz) {
      const radius = h.radius || OIL_RADIUS_FALLBACK;
      const f = cl.sampleAt(h.s);
      const up = f.up.clone().normalize();
      // oil disc — flat on the road, a hair above it, pulled forward in depth so it
      // never z-fights the road tiles (same polygonOffset trick as the skid decals).
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 36),
        // A wet FILM on the road, not a hole: dark slate-blue and semi-transparent
        // so the road grain reads through it (there's no env map, so gloss/metalness
        // can't sell "wet" — translucency + tint does). depthWrite off + polygon
        // offset keep it from z-fighting the road, same as the skid decals.
        new THREE.MeshStandardMaterial({
          color: 0x161425, roughness: 0.25, metalness: 0.2,
          transparent: true, opacity: 0.7, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        })
      );
      disc.userData.owned = true; // disc owns its geometry+material (dispose on rebuild)
      disc.position.copy(f.pos).addScaledVector(f.lateral, h.lat).addScaledVector(up, 0.02);
      disc.quaternion.setFromUnitVectors(Z, up); // CircleGeometry faces +Z → lay it in the road plane
      disc.receiveShadow = true;
      disc.renderOrder = -1; // under the cars' skid decals
      this.hazardGroup.add(disc);
      // cones ringing the slick. Phase by half a step so a 4-cone ring lands on the
      // corners (none dead-centre on the racing line). Non-collidable — a warning.
      if (!coneProto) continue;
      const n = h.cones || 4;
      const ring = radius * 1.05;
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) * (2 * Math.PI / n);
        const ds = Math.cos(a) * ring, dl = Math.sin(a) * ring;
        const coneS = h.s + ds;
        const cf = cl.sampleAt(coneS);                // re-sample so cones follow track curvature
        const cup = cf.up.clone().normalize();
        const clat = Math.max(-coneEdge, Math.min(coneEdge, h.lat + dl)); // keep it inside the curb
        const cone = coneProto.clone(true);
        const box = new THREE.Box3().setFromObject(cone);
        cone.scale.setScalar(CONE_H / Math.max(1e-3, box.max.y - box.min.y));
        cone.position.copy(cf.pos).addScaledVector(cf.lateral, clat);
        cone.quaternion.setFromUnitVectors(Y, cup); // stand the cone up on the road normal
        cone.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        this.hazardGroup.add(cone);
        // register it as a kickable prop (see _stepCones): rest pose + scratch state
        this._cones.push({
          mesh: cone, home: cone.position.clone(), homeQuat: cone.quaternion.clone(), homeS: coneS,
          vel: new THREE.Vector3(), spinAxis: new THREE.Vector3(0, 1, 0), spinRate: 0, airborne: false
        });
      }
    }
  }

  // Advance the kickable warning cones one frame. A resting cone slerps back
  // upright and watches for a car centre within CONE_KICK_R — contact punts it
  // away from the car (faster the quicker the car), arcing + tumbling. An airborne
  // cone falls under gravity, bounces off the road with restitution + friction,
  // and settles where it lands once its energy drops below CONE_SETTLE. Purely
  // cosmetic (the sim ignores cones), so it lives entirely here.
  _stepCones(dt, cars) {
    if (!this._cones || !this._cones.length) return;
    for (const cn of this._cones) {
      const m = cn.mesh;
      if (!cn.airborne) {
        if (!m.quaternion.equals(cn.homeQuat)) m.quaternion.slerp(cn.homeQuat, 1 - Math.exp(-8 * dt));
        for (const c of cars.values()) {
          if (!c.pose) continue;
          const spd = c.spd || 0;
          if (spd < 0.05) continue; // a stationary car doesn't kick
          const dx = m.position.x - c.group.position.x, dz = m.position.z - c.group.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= CONE_KICK_R * CONE_KICK_R) continue;
          let dirx, dirz;
          if (d2 < 1e-4) { const f = c.pose.forward, fl = Math.hypot(f.x, f.z) || 1; dirx = f.x / fl; dirz = f.z / fl; }
          else { const len = Math.sqrt(d2); dirx = dx / len; dirz = dz / len; }
          const power = CONE_KICK_MIN + CONE_KICK_GAIN * spd;
          cn.vel.set(dirx * power, CONE_KICK_UP, dirz * power);
          cn.spinAxis.set(-dirz, 0, dirx).normalize(); // tumble about a horizontal axis ⟂ to launch
          cn.spinRate = power * 2.2;
          cn.airborne = true;
          break;
        }
        continue;
      }
      // airborne: integrate, bounce off the road, settle
      cn.vel.y -= CONE_GRAVITY * dt;
      m.position.addScaledVector(cn.vel, dt);
      m.rotateOnWorldAxis(cn.spinAxis, cn.spinRate * dt);
      if (m.position.y <= cn.home.y) {
        m.position.y = cn.home.y;
        if (cn.vel.y < 0) cn.vel.y = -cn.vel.y * CONE_RESTITUTION;
        cn.vel.x *= CONE_FRICTION; cn.vel.z *= CONE_FRICTION; cn.spinRate *= CONE_FRICTION;
        if (cn.vel.y < CONE_SETTLE && (cn.vel.x * cn.vel.x + cn.vel.z * cn.vel.z) < CONE_SETTLE * CONE_SETTLE) {
          cn.vel.set(0, 0, 0); cn.spinRate = 0; cn.airborne = false;
        }
      }
      // keep it ON the road: clamp the lateral offset from the centreline (sampled at
      // the cone's current along-track position) so a kicked cone bounces off the curb
      // instead of clipping through it / sailing into the grass.
      if (this._centerline) {
        const f0 = this._centerline.sampleAt(cn.homeS);
        const along = this._coneTmp.copy(m.position).sub(cn.home).dot(f0.tangent);
        const f = this._centerline.sampleAt(cn.homeS + along);
        const latOff = this._coneTmp2.copy(m.position).sub(f.pos).dot(f.lateral);
        const edge = (f.width != null ? f.width / 2 : this._roadHalf) - CONE_EDGE_MARGIN; // per-sample edge: in a flared section the wall sits at the wider visible asphalt, not the scalar default
        if (Math.abs(latOff) > edge) {
          m.position.addScaledVector(f.lateral, Math.sign(latOff) * edge - latOff); // shove back inside
          const vLat = cn.vel.dot(f.lateral);
          if (vLat * Math.sign(latOff) > 0) cn.vel.addScaledVector(f.lateral, -vLat * (1 + CONE_WALL_RESTITUTION));
        }
      }
    }
  }

  // Idle-animate the item boxes: spin about their up axis, bob, and pulse a gold
  // emissive sparkle (synchronized across boxes) so they read as flashy pickups.
  _stepBoxes(dt) {
    if (!this._boxes || !this._boxes.length) return;
    this._boxClock = (this._boxClock || 0) + dt;
    const t = this._boxClock;
    const pulse = 0.16 + 0.18 * (0.5 + 0.5 * Math.sin(t * 4.5)); // gold emissive throb
    for (const b of this._boxes) {
      // Collect burst: a grabbed box GROWS while it FADES out, then hides. Driven by
      // collectT (set on the available→gone edge in syncProps); k runs 1→0.
      if (b.collectT > 0) {
        b.collectT -= dt;
        const k = Math.max(0, b.collectT / BOX_COLLECT_TIME);
        b.mesh.rotateY(BOX_SPIN * 2.2 * dt);                      // spin up as it pops
        b.mesh.scale.setScalar(b.baseS * (1 + (1 - k) * BOX_COLLECT_GROW));
        for (const m of b.mats) m.opacity = k;                    // fade out
        if (b.collectT <= 0) {                                    // done: reset + hide
          b.mesh.visible = false;
          b.mesh.scale.setScalar(b.baseS);
          for (const m of b.mats) m.opacity = 1;
        }
        continue;
      }
      if (!b.mesh.visible) continue;
      b.mesh.rotateY(BOX_SPIN * dt);                                    // spin about local up
      b.mesh.position.y = b.homeY + Math.sin(t * BOX_BOB_W + b.phase) * BOX_BOB_AMP;
      for (const m of b.mats) {
        if ('emissiveIntensity' in m) {
          if (m.emissive) m.emissive.setHex(0xffd23f);
          m.emissiveIntensity = pulse;
        }
      }
    }
  }

  // Restore every cone to its home pose — called on a new game so a fresh race
  // starts with the warning rings intact rather than wherever they were knocked.
  resetCones() {
    if (!this._cones) return;
    for (const cn of this._cones) {
      cn.mesh.position.copy(cn.home);
      cn.mesh.quaternion.copy(cn.homeQuat);
      cn.vel.set(0, 0, 0); cn.spinRate = 0; cn.airborne = false;
    }
  }
}
