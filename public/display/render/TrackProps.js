// Track props with per-frame behaviour: oil slicks + their kickable warning
// cones, boost pads, item boxes (idle/collect animation), dropped bananas, and
// the ?bbox collision-outline debug overlay. Owns the hazard scene group; the
// engine stays authoritative — everything here is render-side juice.
import * as THREE from 'three';
import { makePadTexture, makePadStripTexture, makeBlobShadowTexture } from './textures.js';

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
const BOX_FLOAT = 0.18;  // clearance of the box's base above the road (it hovers); bobs ±BOX_BOB_AMP around this
// Collect burst: when a box is picked up it GROWS while it FADES out, then hides
// (a clear "poof, grabbed" beat to pair with the HUD roulette). Starting values:
// tune BOX_COLLECT_TIME up if it's too quick to read, BOX_COLLECT_GROW for punch.
const BOX_COLLECT_TIME = 0.35; // seconds the grow+fade burst lasts
const BOX_COLLECT_GROW = 1.1;  // extra scale at burst end (final ≈ 2.1× rest)
// Static contact shadow painted on the road directly under each (floating) box —
// the box's real sun shadow lands raked off to one side, so it can't be read as a
// position cue (see makeBlobShadowTexture). Slightly wider than the box footprint
// so it reads as a soft halo; tint/strength match the car underbody AO family.
const BOX_SHADOW_R = 0.3;       // blob radius in world units (box footprint ≈ ±0.15)
const BOX_SHADOW_COLOR = 0x1c1a18; // near-black warm, same as the car under-AO + skid scuffs
const BOX_SHADOW_OPACITY = 0.4;

// In-flight homing rocket (see _buildRocketProto + _syncRockets): a small toy rocket
// that flies a touch above the road, nose along travel, spinning about its axis with a
// flickering tail flame. Built once (shared geo/mats) and cloned per live rocket.
const ROCKET_SCALE = 1.12;     // overall size multiplier on the built proto (still reads at race speed)
const ROCKET_HOVER = 0.32;     // how high the rocket flies above the road surface (world units)
const ROCKET_ROLL = 9.0;       // spin about its travel axis (rad/s) — the toy "whizzing" read

// Rocket impact burst (see spawnImpact + _stepImpacts): a warm additive flash ball plus a
// thin shockwave RING — both at the detonation point on the car body (in the AIR, not painted
// on the road), so the blast and its wave read as one event. The ring billboards to face each
// cell's camera (impactRingBillboard) and expands at CONSTANT width, so it's a crisp pulse,
// not a fattening donut. No smoke/particles — clean asphalt has nothing to kick up.
const IMPACT_TIME = 0.7;        // total burst lifetime (s) — deliberately SLOW so the explosion lingers long
                               // enough to read ("a rocket hit them"), not a blink-and-miss flash
const IMPACT_FLASH_TIME = 0.5;  // flash ball: a brief hold then a slow fade over this window
const IMPACT_FLASH_R = 0.62;    // flash ball peak radius (world units) — bigger fireball
const IMPACT_RING_R0 = 0.25;    // shockwave ring start radius
const IMPACT_RING_R1 = 2.0;     // shockwave ring end radius — sweeps wider for an explosion read
const IMPACT_RING_W = 0.05;     // ring half-thickness — held CONSTANT as it expands (thin pulse, not a donut)
const IMPACT_RING_OPACITY = 0.55; // ring peak alpha — kept subordinate to the flash
const IMPACT_FOLLOW = 10;       // how hard the flash ball tracks the (spinning-away) car (per second); the
                               // shockwave ring stays put at the impact point, the fireball trails the car

// Camera-facing billboard for the impact ring: orient its plane toward each rendering camera,
// then rebuild matrixWorld by hand — onBeforeRender runs AFTER the renderer derived it, and it
// fires once per split-screen cell, so the ring reads as a flat halo in every cell at once.
function impactRingBillboard(renderer, scene, camera) {
  this.quaternion.setFromRotationMatrix(camera.matrixWorld);
  this.updateMatrix();
  this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
}

export class TrackProps {
  constructor(scene, protos, bbox) {
    this.protos = protos;     // shared GLB prototype cache (filled by SceneRenderer.load)
    this._bbox = bbox;        // ?bbox=1 debug-outline flag
    this._padTex = makePadTexture();
    this._padStripTex = makePadStripTexture(); // full-width rectangular launch strip (loop mouths)
    // Shared (renderer-lifetime) bits for the item-box contact shadows: one circle
    // geometry + one tinted soft-blob material reused by every box on every track.
    // Boxes only toggle their shadow mesh's `.visible`, so the material never needs
    // per-box cloning — nothing here is disposed on a track change.
    this._boxShadowGeo = new THREE.CircleGeometry(BOX_SHADOW_R, 24);
    this._boxShadowMat = new THREE.MeshBasicMaterial({
      map: makeBlobShadowTexture(), color: BOX_SHADOW_COLOR,
      transparent: true, opacity: BOX_SHADOW_OPACITY, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 // sit on the road, no z-fight (same as oil/pads)
    });
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
    this._zAxis = new THREE.Vector3(0, 0, 1); // CircleGeometry faces +Z → reused to lay blobs in the road plane
    this._coneTmp = new THREE.Vector3();   // scratch for the airborne-cone road clamp
    this._coneTmp2 = new THREE.Vector3();
    this._sBananaUp = new THREE.Vector3(); // scratch for the per-frame banana up vector
    this._liveBananas = new Set();         // reused per-frame live-id set; cleared, never reallocated
    // Homing rockets: reconciled by id from snapshot.rockets (like bananas), animated
    // in _stepRockets. The proto is built once (shared geo/mats) and cloned per rocket;
    // the flame material is held so its flicker can be driven once per frame.
    this._rocketMeshes = new Map();        // rocket id -> cloned mesh group
    this._liveRockets = new Set();         // reused per-frame live-id set
    this._rocketFlameMat = null;           // set by _buildRocketProto; flickered in _stepRockets
    this._rocketProto = this._buildRocketProto();
    this._rkFwd = new THREE.Vector3();     // scratch: per-frame rocket orientation basis
    this._rkUp = new THREE.Vector3();
    this._rkSide = new THREE.Vector3();
    this._rkBasis = new THREE.Matrix4();
    this._yAxis = new THREE.Vector3(0, 1, 0); // rocket builds nose-up (+Y); spun about this after orienting
    // Rocket impact bursts: shared unit geo (scaled per frame) + per-burst cloned additive
    // materials (so each fades independently). Geo is renderer-lifetime, never disposed.
    this._impacts = [];
    this._impactSphereGeo = new THREE.IcosahedronGeometry(1, 2); // unit flash ball (scaled per frame)
    this._impactFlashMatProto = new THREE.MeshBasicMaterial({
      color: 0xffe0a8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false
    });
    // Air shockwave ring: warm-white additive, billboarded to face the camera (impactRingBillboard).
    // No polygonOffset/road-decal tricks — it floats at the detonation point, not on the asphalt.
    this._impactRingMatProto = new THREE.MeshBasicMaterial({
      color: 0xffe6b0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false
    });
    this._impUp = new THREE.Vector3();   // scratch for the per-burst up vector
    this._impPos = new THREE.Vector3();
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
    this._stepRockets(dt);
    this._stepImpacts(dt);
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
    this._rocketMeshes = new Map(); // cleared with the hazardGroup on a track change; clones share the proto's geo/mats (never disposed)
    for (const im of (this._impacts || [])) { im.flash.material.dispose(); im.ring.geometry.dispose(); im.ring.material.dispose(); } // dispose per-burst clones/geo; meshes go with the hazardGroup clear
    this._impacts = [];
    const cl = track.centerline;
    const Y = new THREE.Vector3(0, 1, 0);
    for (const p of (track.pads || [])) {
      // A pad is a glowing chevron DISC by default, or a full-width rectangular launch
      // STRIP (`shape: 'strip'`, auto-placed at a loop mouth) — a plane spanning the lane.
      let geom, tex;
      if (p.shape === 'strip') {
        geom = new THREE.PlaneGeometry(p.halfWidth * 2, p.halfLen * 2); // X=width, Y=along travel
        tex = this._padStripTex;
        this._dbgStatic.push({ kind: 'pad', s: p.s, lat: p.lat || 0, shape: 'strip', halfLen: p.halfLen, halfWidth: p.halfWidth });
      } else {
        const radius = p.radius || 0.65;
        geom = new THREE.CircleGeometry(radius, 18);
        tex = this._padTex;
        this._dbgStatic.push({ kind: 'pad', s: p.s, lat: p.lat || 0, radius });
      }
      const f = cl.sampleAt(p.s);
      const up = f.up.clone().normalize();
      const face = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.95, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
      }));
      face.userData.owned = true; // owns its geometry+material (dispose on rebuild)
      face.position.copy(f.pos).addScaledVector(f.lateral, p.lat).addScaledVector(up, 0.025);
      // basis (lateral=X, tangent=Y, up=Z) lays the face in the road plane with its
      // texture +Y (chevrons) pointing along travel.
      face.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(f.lateral.clone().normalize(), f.tangent.clone().normalize(), up));
      face.renderOrder = -1;
      this.hazardGroup.add(face);
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
        // The box deliberately does NOT cast the sun shadow: it hovers, and the key
        // light is raked, so that shadow lands off to one side and reads as a detached
        // smudge. A static blob directly beneath it (below) is the position cue instead.
      } else {
        // No GLB: a plain box that OWNS its geometry. Not flagged `owned` — its cloned
        // material goes in `mats` and its geometry in `geom` (both disposed in the
        // _buildProps preamble), so the hazard cleanup must not also dispose them.
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4),
          new THREE.MeshStandardMaterial({ color: 0xffc94d }));
      }
      mesh.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, BOX_FLOAT); // hover above the road
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
      // Static contact shadow: a soft blob laid flat on the road DIRECTLY under the
      // box's hover point (f.pos + lat, before BOX_FLOAT lifts the box). Shares the
      // renderer-lifetime geo+material; only its `.visible` toggles (see sync), so
      // it's free per frame. CircleGeometry faces +Z → rotate Z to the road normal.
      const shadow = new THREE.Mesh(this._boxShadowGeo, this._boxShadowMat);
      shadow.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, 0.02);
      shadow.quaternion.setFromUnitVectors(this._zAxis, up);
      shadow.renderOrder = -1; // paint with the road decals, beneath the box
      this.hazardGroup.add(shadow);
      // spin/bob/collect state (see _stepBoxes). homeY is the rest height, phase
      // desyncs the bob, baseS the rest scale to grow from / restore to, collectT
      // counts down the grow+fade pickup burst, available mirrors the snapshot.
      this._boxes.push({
        mesh, mats, shadow, geom: boxProto ? null : mesh.geometry, homeY: mesh.position.y, baseS: mesh.scale.x,
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
  // Car boxes are oriented to the body's heading (yaw about the surface up), matching
  // the rendered pose — the engine collides from this same oriented footprint (projected
  // onto the (s, lat) axes), so the outline tracks the body instead of the old fixed
  // centreline-aligned box that an angled car would visibly poke through.
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
    for (const d of this._dbgStatic) {
      if (d.shape === 'strip') {
        const f = cl.sampleAt(d.s), up = f.up.clone().normalize();
        const center = f.pos.clone().addScaledVector(f.lateral, d.lat).addScaledVector(up, 0.06);
        g.add(this._dbgRect(center, f.tangent.clone().normalize(), f.lateral.clone().normalize(), d.halfLen, d.halfWidth, COL.pad));
      } else ring(d.s, d.lat, d.radius, COL[d.kind] || 0xffffff);
    }
    for (const b of (snap.bananas || [])) ring(b.s, b.lat, b.radius || 0.6, 0xff9f1c);
    for (const r of (snap.rockets || [])) ring(r.s, r.lat, 0.3, 0x2d9cdb);
    for (const c of (snap.cars || [])) {
      if (c.totalS == null) continue;
      const f = cl.sampleAt(c.totalS), up = f.up.clone().normalize();
      const center = f.pos.clone().addScaledVector(f.lateral, c.lat || 0).addScaledVector(up, 0.06);
      // Yaw the box basis by the car's heading about the surface up, matching the body's
      // render pose (forward = tangent rotated by heading about up). depthTest-off rect.
      const h = c.heading || 0;
      const along = f.tangent.clone().normalize().applyAxisAngle(up, h);
      const side = f.lateral.clone().normalize().applyAxisAngle(up, h);
      g.add(this._dbgRect(center, along, side, c.halfLen || 0.44, c.halfWid || 0.26, 0x39e639));
    }
  }

  // Per-frame prop reconcile from the engine snapshot: show only available (off-
  // cooldown) item boxes, and create/move/remove dropped-banana meshes by id.
  sync(snap) {
    this._drawDebug(snap); // ?bbox overlay (no-op unless enabled)
    this._syncRockets(snap); // before the banana block's early-return guards
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
          if (b.shadow) b.shadow.visible = true;
        } else {                             // collected: kick off the grow+fade burst
          b.collectT = BOX_COLLECT_TIME;
          if (b.shadow) b.shadow.visible = false; // box is grabbed → drop its ground cue too
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
          // Bananas cast no real sun shadow (the directional map is baked once per track
          // and frozen — a banana dropped mid-race can't be in it); the ground blob below
          // grounds it instead.
          // Anchor to the measured base, wherever the GLB pivot sits: re-measure
          // post-scale and remember the bottom offset so the model rests flush.
          m.userData.bottom = new THREE.Box3().setFromObject(m).min.y;
        } else {
          m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffe14d }));
          m.userData.owned = true;
          m.userData.bottom = -0.18; // sphere origin is its centre
        }
        // Soft contact shadow on the road under the banana — shares the renderer-lifetime
        // item-box blob geo+material (scaled down to the banana). Tracked on the mesh so
        // it's detached when the banana is removed; never disposed (shared resources).
        const sh = new THREE.Mesh(this._boxShadowGeo, this._boxShadowMat);
        sh.scale.setScalar(0.7);
        sh.renderOrder = -1;
        m.userData.shadow = sh;
        this.hazardGroup.add(sh);
        this.hazardGroup.add(m);
        this._bananaMeshes.set(b.id, m);
      }
      if (m) {
        const f = this._centerline.sampleAt(b.s);
        const up = this._sBananaUp.copy(f.up).normalize(); // scratch — no per-frame alloc
        // Sit the model's base on the road (+1mm to avoid z-fighting), not its pivot.
        const lift = 0.001 - (m.userData.bottom || 0);
        m.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, lift);
        m.quaternion.setFromUnitVectors(this._worldUp, up);
        const sh = m.userData.shadow; // ground blob: flat on the road directly under the banana
        if (sh) {
          sh.position.copy(f.pos).addScaledVector(f.lateral, b.lat).addScaledVector(up, 0.02);
          sh.quaternion.setFromUnitVectors(this._zAxis, up);
        }
      }
    }
    for (const [id, m] of this._bananaMeshes) {
      if (!live.has(id)) {
        if (m.userData.shadow) this.hazardGroup.remove(m.userData.shadow); // blob shares the shared geo/mat → just detach, never dispose
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
        // Cones cast no real sun shadow: the directional map is baked once per track and
        // frozen, but cones MOVE when a passing car kicks them (see _stepCones) — a baked
        // shadow would stick at the cone's home spot. They sit on the oil disc that already
        // grounds them, so no blob is needed.
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
      // airborne: integrate under gravity, then bounce off / settle onto the LOCAL road
      // surface — NOT the spawn height. A kicked cone travels along the track to where the
      // deck sits at a different elevation (and bank), so settling at its old home.y would
      // leave it floating over a descent or sunk into a rise. Sample the road at the cone's
      // current (s, lat) once and use it for BOTH the floor height and the curb clamp.
      cn.vel.y -= CONE_GRAVITY * dt;
      m.position.addScaledVector(cn.vel, dt);
      m.rotateOnWorldAxis(cn.spinAxis, cn.spinRate * dt);
      let roadY = cn.home.y, f = null, latOff = 0;
      if (this._centerline) {
        const f0 = this._centerline.sampleAt(cn.homeS);
        const along = this._coneTmp.copy(m.position).sub(cn.home).dot(f0.tangent);
        f = this._centerline.sampleAt(cn.homeS + along);
        latOff = this._coneTmp2.copy(m.position).sub(f.pos).dot(f.lateral);
        roadY = f.pos.y + f.lateral.y * latOff; // road surface at this lateral offset (follows the bank)
      }
      if (m.position.y <= roadY) {
        m.position.y = roadY;
        if (cn.vel.y < 0) cn.vel.y = -cn.vel.y * CONE_RESTITUTION;
        cn.vel.x *= CONE_FRICTION; cn.vel.z *= CONE_FRICTION; cn.spinRate *= CONE_FRICTION;
        if (cn.vel.y < CONE_SETTLE && (cn.vel.x * cn.vel.x + cn.vel.z * cn.vel.z) < CONE_SETTLE * CONE_SETTLE) {
          cn.vel.set(0, 0, 0); cn.spinRate = 0; cn.airborne = false;
        }
      }
      // keep it ON the road: clamp the lateral offset (per-sample edge: in a flared section
      // the wall sits at the wider visible asphalt) so a kicked cone bounces off the curb
      // instead of clipping through it / sailing into the grass.
      if (f) {
        const edge = (f.width != null ? f.width / 2 : this._roadHalf) - CONE_EDGE_MARGIN;
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

  // Build the shared toy-rocket prototype ONCE (cloned per live rocket in _syncRockets):
  // a cream nose cone + bright-red body + three dark fins, with an additive tail flame
  // whose flicker is driven via the held material. Built nose-up (local +Y) so
  // _syncRockets can map +Y onto the travel tangent. Geo/mats are renderer-lifetime
  // (shared across all clones), never disposed — like the box-shadow blob.
  _buildRocketProto() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe6492d, roughness: 0.5, metalness: 0.05 }); // toy red
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xfff3e0, roughness: 0.5 });                  // cream nose
    const finMat = new THREE.MeshStandardMaterial({ color: 0x37414f, roughness: 0.6 });                   // dark fins
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.2, 14), bodyMat);
    // A long, sharp nose (base radius = the body top, so no mushroom join) — the clear
    // "this end forward" cue that keeps the silhouette from reading bi-directional.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.17, 14), noseMat); nose.position.y = 0.185;
    g.add(body, nose);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.085, 0.07), finMat);
      const a = i * (2 * Math.PI / 3);
      fin.position.set(Math.cos(a) * 0.085, -0.055, Math.sin(a) * 0.085);
      fin.rotation.y = Math.PI / 2 - a; // turn the fin's depth (local +Z) to point radially outward
      g.add(fin);
    }
    // Additive tail flame — small + glowing (not a second cone), pointing out the BACK
    // (local -Y → trails the travel direction). Flicker driven via the held material.
    this._rocketFlameMat = new THREE.MeshBasicMaterial({
      color: 0xffb33b, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false
    });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.09, 12), this._rocketFlameMat);
    flame.position.y = -0.145; flame.rotation.x = Math.PI;
    g.add(flame);
    g.scale.setScalar(ROCKET_SCALE); // clones inherit this (the scale survives _syncRockets' quaternion/position writes)
    return g;
  }

  // Per-frame reconcile of in-flight rockets from the snapshot (mirrors the banana block):
  // clone the proto on first sight, place + orient it each frame (nose along the travel
  // tangent, flying ROCKET_HOVER above the road, spun about its axis), and remove it when
  // the engine drops the id (hit or expiry). Clones share the proto geo/mats, so removal
  // just detaches — nothing is disposed.
  _syncRockets(snap) {
    if (!this._rocketMeshes) return;
    const incoming = snap.rockets || [];
    if (incoming.length === 0 && this._rocketMeshes.size === 0) return; // steady state: no work
    const live = this._liveRockets; live.clear();
    for (const r of incoming) {
      live.add(r.id);
      let m = this._rocketMeshes.get(r.id);
      if (!m && this._centerline && this._rocketProto) {
        m = this._rocketProto.clone(true);
        m.userData.roll = 0;
        const sh = new THREE.Mesh(this._boxShadowGeo, this._boxShadowMat); // shared blob, scaled to the bigger rocket
        sh.scale.setScalar(0.95); sh.renderOrder = -1;
        m.userData.shadow = sh;
        this.hazardGroup.add(sh);
        this.hazardGroup.add(m);
        this._rocketMeshes.set(r.id, m);
      }
      if (m) {
        const f = this._centerline.sampleAt(r.s);
        const fwd = this._rkFwd.copy(f.tangent).normalize();
        const up = this._rkUp.copy(f.up).normalize();
        const side = this._rkSide.copy(fwd).cross(up).normalize();
        m.position.copy(f.pos).addScaledVector(f.lateral, r.lat).addScaledVector(up, ROCKET_HOVER);
        m.quaternion.setFromRotationMatrix(this._rkBasis.makeBasis(side, fwd, up)); // local +Y → travel
        m.rotateOnAxis(this._yAxis, m.userData.roll || 0);                          // spin about the travel axis
        const sh = m.userData.shadow; // ground blob flat on the road directly beneath
        if (sh) {
          sh.position.copy(f.pos).addScaledVector(f.lateral, r.lat).addScaledVector(up, 0.02);
          sh.quaternion.setFromUnitVectors(this._zAxis, up);
        }
      }
    }
    for (const [id, m] of this._rocketMeshes) {
      if (!live.has(id)) {
        if (m.userData.shadow) this.hazardGroup.remove(m.userData.shadow); // shared blob → detach, never dispose
        this.hazardGroup.remove(m);
        this._rocketMeshes.delete(id);
      }
    }
  }

  // Animate the live rockets: accumulate a spin angle (applied in _syncRockets after the
  // orientation) and flicker the shared tail flame. Cheap; a no-op when nothing's in flight.
  _stepRockets(dt) {
    if (!this._rocketMeshes || !this._rocketMeshes.size) return;
    for (const m of this._rocketMeshes.values()) m.userData.roll = (m.userData.roll || 0) + ROCKET_ROLL * dt;
    this._rocketClock = (this._rocketClock || 0) + dt;
    if (this._rocketFlameMat) this._rocketFlameMat.opacity = 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(this._rocketClock * 38));
  }

  // Spawn a one-shot impact burst at a car (the rocket's detonation point). `carGroup` is
  // the target car's render group — we read its position + up (road normal). Each burst owns
  // cloned additive materials (independent fade) over shared unit geo; _stepImpacts advances
  // and removes them. Driven from main.js on the rocket spin event.
  spawnImpact(carGroup) {
    if (!carGroup || !this._impacts) return;
    const up = this._impUp.set(0, 1, 0).applyQuaternion(carGroup.quaternion).normalize();
    const center = this._impPos.copy(carGroup.position).addScaledVector(up, 0.3); // detonation point on the car body
    this._spawnBurst(center, carGroup); // car ref → the flash trails it as it spins away (see _stepImpacts)
  }

  // Same burst at a fixed TRACK point (s along the ribbon, lat off-centre) rather than on a car —
  // a rocket self-destructing where it timed out (a whiff that detonates instead of vanishing).
  // Driven from the engine's rocket_expire event; no car ref, so the fireball stays put.
  spawnImpactAt(s, lat) {
    if (!this._impacts || !this._centerline) return;
    const f = this._centerline.sampleAt(s);
    const up = this._impUp.copy(f.up).normalize();
    const center = this._impPos.copy(f.pos).addScaledVector(f.lateral, lat || 0).addScaledVector(up, ROCKET_HOVER);
    this._spawnBurst(center, null);
  }

  // Build one impact burst at `center`: a warm flash ball + a camera-facing shockwave ring (each
  // owns cloned additive materials so they fade independently). `car` (or null) is stashed so
  // _stepImpacts can trail the flash after a spinning car — a null-car burst holds its spot.
  _spawnBurst(center, car) {
    const flash = new THREE.Mesh(this._impactSphereGeo, this._impactFlashMatProto.clone());
    flash.position.copy(center);
    const ring = new THREE.Mesh(new THREE.RingGeometry(IMPACT_RING_R0 - IMPACT_RING_W, IMPACT_RING_R0 + IMPACT_RING_W, 48),
      this._impactRingMatProto.clone());
    ring.position.copy(center);
    ring.onBeforeRender = impactRingBillboard; // re-faces each cell's camera every render
    this.hazardGroup.add(flash);
    this.hazardGroup.add(ring);
    this._impacts.push({ flash, ring, t: 0, car });
  }

  // Advance the impact bursts: the flash ball pops then fades fast; the shockwave ring expands
  // (ease-out) at CONSTANT width — rebuilt each frame from the new radius — then fades. Remove +
  // dispose finished bursts (each ring owns its geometry, so dispose it too).
  _stepImpacts(dt) {
    if (!this._impacts || !this._impacts.length) return;
    for (const im of this._impacts) {
      im.t += dt;
      const tr = Math.min(1, im.t / IMPACT_TIME);             // ring progress
      const tf = Math.min(1, im.t / IMPACT_FLASH_TIME);       // flash progress
      const R = IMPACT_RING_R0 + (IMPACT_RING_R1 - IMPACT_RING_R0) * (1 - (1 - tr) * (1 - tr)); // ease-out radius
      im.ring.geometry.dispose();
      im.ring.geometry = new THREE.RingGeometry(Math.max(0.001, R - IMPACT_RING_W), R + IMPACT_RING_W, 48); // thin, constant width
      im.ring.material.opacity = IMPACT_RING_OPACITY * (1 - tr);
      im.flash.scale.setScalar(IMPACT_FLASH_R * (0.5 + 0.5 * Math.min(1, tf * 5))); // pop to full fast (~0.1s)
      // hold the fireball bright briefly, then a slow ease-out — so the hit lingers and reads
      im.flash.material.opacity = tf < 0.25 ? 1 : Math.max(0, 1 - (tf - 0.25) / 0.75);
      if (tf >= 1) im.flash.visible = false;
      // The fireball TRAILS the car as it spins away (the ring stays at the impact point).
      if (im.car) {
        const up = this._impUp.set(0, 1, 0).applyQuaternion(im.car.quaternion).normalize();
        const target = this._impPos.copy(im.car.position).addScaledVector(up, 0.3);
        im.flash.position.lerp(target, Math.min(1, IMPACT_FOLLOW * dt));
      }
    }
    if (this._impacts.some((im) => im.t >= IMPACT_TIME)) {
      this._impacts = this._impacts.filter((im) => {
        if (im.t < IMPACT_TIME) return true;
        this.hazardGroup.remove(im.flash); this.hazardGroup.remove(im.ring);
        im.flash.material.dispose();
        im.ring.geometry.dispose(); im.ring.material.dispose(); // per-burst clones + per-ring geometry
        return false;
      });
    }
  }
}
