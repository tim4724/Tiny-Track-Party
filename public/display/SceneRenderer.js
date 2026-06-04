// SceneRenderer — Three.js scene for the race. Per-player CHASE camera in a
// SPLIT-SCREEN viewport (each player sees behind their own car). One shared
// scene; we render it once per player into their screen cell, with per-view
// name/position labels overlaid. Falls back to a single overview camera in the
// lobby (no cars). The game layer calls setCarPose()/setCarHud() each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

const CAR_MODELS = [
  'vehicle-racer', 'vehicle-speedster', 'vehicle-drag-racer', 'vehicle-racer-low',
  'vehicle-vintage-racer', 'vehicle-suv', 'vehicle-truck', 'vehicle-monster-truck'
];
const TRACK_GLBS = [
  'track-road-wide-straight', 'track-road-wide-corner-small', 'track-road-wide-corner-large', 'track-road-wide-curve'
];

// Chase camera: sits behind the CAR's heading and looks at it, with the position
// and look-target damped so it lags and swings smoothly behind through turns
// (the standard spring chase-cam every kart racer uses).
const CHASE_DIST = 1.8, CHASE_HEIGHT = 1.0, CHASE_LOOK = 2.6; // tight chase (close + low)
const CAM_POS_RATE = 7.0, CAM_TGT_RATE = 13.0; // damping speed per second (higher = snappier)
const LEAN_MAX = 0.05;        // max body roll (rad) at full steer — subtle
const WHEEL_TURN_MAX = 0.5;   // max front-wheel turn (rad) at full steer
const BASE_FOV = 64;          // camera FOV at rest
const FOV_GAIN = 6;           // extra FOV degrees at top speed (subtle sense of speed)
// Wheel-kick colour — dark grey (tyre scuff / asphalt grit). One knob to retint.
const DUST_COLOR = 0x4a4a4a;

// Split-screen grid that makes cells as SQUARE as possible for the current
// screen aspect: try every column count, score each by how far the resulting
// cell aspect is from 1:1 (square), with a small penalty for empty cells.
function bestGrid(n, W, H) {
  let best = { cols: 1, rows: n, cost: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = (W / cols) / (H / rows);
    // distance from square + a real penalty per wasted cell (so 4 → 2x2, not 3x2)
    const cost = Math.abs(Math.log(cellAspect)) + (cols * rows - n) * 0.4;
    if (cost < best.cost) best = { cols, rows, cost };
  }
  return best;
}

// Soft radial blob used as a fake contact shadow under each car (grounds it).
function makeShadowTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A few small HARD-edged grains (tinted per-emit) — solid dirt specks, not the
// soft feathered gradient that read as smoke. Drawn white so the colour tint
// shows true.
function makeDustTexture() {
  const s = 48;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const cx = s * (0.3 + Math.random() * 0.4);
    const cy = s * (0.3 + Math.random() * 0.4);
    const rad = s * (0.1 + Math.random() * 0.1);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');   // solid body — hard grain
    g.addColorStop(1, 'rgba(255,255,255,0)');     // 1px feather only at the rim
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SceneRenderer {
  constructor(container, colors) {
    this.container = container;
    this.colors = colors || ['#e6492d'];
    this.protos = new Map();
    this.cars = new Map();      // id -> { group, marker, cam, camPos, camTarget, label, pose }
    this._order = [];           // stable cell order
    this._running = false;
    this._last = 0;
    this._initThree();
    this._initOverlay();
    this._shadowTex = makeShadowTexture();
    this._initParticles();
  }

  // Pooled dust sprites kicked up from the wheels + curb. Sprites face whichever
  // camera renders them, so they look right in every split-screen viewport.
  _initParticles() {
    this._dustTex = makeDustTexture();
    this._puffs = [];
    this._puffN = 0;
    for (let i = 0; i < 200; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._dustTex, transparent: true, depthWrite: false, opacity: 0
      }));
      sp.visible = false;
      sp.userData.life = 0;
      this.scene.add(sp);
      this._puffs.push(sp);
    }
  }

  // pos = world spawn, vel = world velocity (it then settles under gravity + drag)
  _emitDust(pos, color, size, life, vel) {
    const sp = this._puffs[this._puffN];
    this._puffN = (this._puffN + 1) % this._puffs.length;
    sp.visible = true;
    sp.position.copy(pos);
    // per-grain brightness jitter so the trail has grit/depth, not one flat tone
    sp.material.color.set(color).multiplyScalar(0.7 + Math.random() * 0.6);
    sp.material.rotation = Math.random() * Math.PI * 2; // random start angle per grain
    sp.scale.setScalar(size);
    sp.userData.life = life;
    sp.userData.maxLife = life;
    sp.userData.size = size;
    sp.userData.spin = (Math.random() - 0.5) * 6; // tumble as it flies
    sp.userData.vel = vel || new THREE.Vector3();
  }

  _stepPuffs(dt) {
    for (const sp of this._puffs) {
      if (!sp.visible) continue;
      sp.userData.life -= dt;
      if (sp.userData.life <= 0) { sp.visible = false; sp.material.opacity = 0; continue; }
      const f = sp.userData.life / sp.userData.maxLife; // 1 → 0
      const v = sp.userData.vel;
      if (v) {
        sp.position.addScaledVector(v, dt);
        v.y -= 4.5 * dt;                           // strong gravity: grains fall fast, don't billow
        v.multiplyScalar(1 - Math.min(1, 5 * dt)); // air drag
      }
      if (sp.userData.spin) sp.material.rotation += sp.userData.spin * dt; // tumble
      sp.material.opacity = 0.5 * f;               // light grains, not an opaque cloud
      sp.scale.setScalar(sp.userData.size);        // fixed size — grains don't expand like smoke
    }
  }

  _initThree() {
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.autoClear = false; // we clear once per frame, then render N viewports
    this.container.appendChild(r.domElement);
    this.renderer = r;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ecae6);
    scene.fog = new THREE.Fog(0x8ecae6, 70, 170);
    this.scene = scene;

    // Flat toy lighting: a single soft sky/ground hemisphere — no directional sun
    // and no shadow map. Every surface is evenly lit with a gentle top-down form
    // cue, and each car carries its own painted blob shadow instead of a cast one.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 3.0));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: 0x6aa84f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.0;
    scene.add(ground);
    this.ground = ground;

    this.trackGroup = new THREE.Group();
    scene.add(this.trackGroup);

    this.overview = new THREE.PerspectiveCamera(50, this._aspect(), 0.1, 600);
    this.overview.position.set(25, 22, 25);
    this._ovPos = this.overview.position.clone();
    this._ovTarget = new THREE.Vector3();

    window.addEventListener('resize', () => this._onResize());
  }

  _initOverlay() {
    const o = document.createElement('div');
    o.className = 'race-labels';
    o.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    this.container.appendChild(o);
    this.overlay = o;
  }

  _aspect() { return window.innerWidth / Math.max(1, window.innerHeight); }
  _onResize() { this.renderer.setSize(window.innerWidth, window.innerHeight); }

  async load() {
    const loader = new GLTFLoader();
    const need = [...new Set([...TRACK_GLBS, ...CAR_MODELS])];
    await Promise.all(need.map((name) => new Promise((resolve, reject) => {
      loader.load(ASSET(name), (gltf) => {
        this.protos.set(name, gltf.scene);
        resolve();
      }, undefined, reject);
    })));
  }


  setTrack(track, { debug = false } = {}) {
    this.trackGroup.clear();
    this._dustColor = new THREE.Color(DUST_COLOR); // explicit orange (see DUST_COLOR note)
    if (track.groundY != null) this.ground.position.y = track.groundY;
    for (const inst of track.instances) {
      const proto = this.protos.get(inst.glb);
      if (!proto) continue;
      const node = proto.clone(true);
      node.matrixAutoUpdate = false;
      node.matrix.copy(inst.matrix);
      this.trackGroup.add(node);
    }
    if (debug) {
      const pts = track.centerline.samples.map((s) => s.pos.clone());
      pts.push(pts[0].clone());
      this.trackGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xff00ff })));
    }
    // overview framing
    const box = new THREE.Box3();
    for (const s of track.centerline.samples) box.expandByPoint(s.pos);
    this._trackCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.5 + 8;
    const dist = radius / Math.tan((this.overview.fov * Math.PI / 180) / 2) * 0.9;
    this._ovPos = this._trackCenter.clone().add(new THREE.Vector3(0.35, 0.8, 0.9).normalize().multiplyScalar(dist));
    this._ovTarget = this._trackCenter.clone();
  }

  // Render a car model's TOP-DOWN silhouette once into a soft, car-shaped shadow
  // texture (cached per model). Returns { tex, size }, where `size` is the square
  // world footprint the texture spans. The shadow plane is parented to the car
  // group, so the silhouette inherits the car's heading + road tilt for free.
  _carShadowTexture(model, proto) {
    if (!this._carShadowCache) this._carShadowCache = new Map();
    if (this._carShadowCache.has(model)) return this._carShadowCache.get(model);

    const r = this.renderer;
    let result;
    try {
      proto.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(proto);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const S = Math.max(size.x, size.z) * 1.25; // square footprint + edge padding

      const RES = 128;
      const rt = new THREE.WebGLRenderTarget(RES, RES, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
      });
      // top-down orthographic camera; up = +Z so the model's BACK (+Z) is image-up
      // and its nose (-Z) is image-down — which becomes the car's forward once the
      // plane is parented to the group (group +Z = heading).
      const cam = new THREE.OrthographicCamera(-S / 2, S / 2, S / 2, -S / 2, 0.01, size.y + 2);
      cam.position.set(center.x, box.max.y + 1, center.z);
      cam.up.set(0, 0, 1);
      cam.lookAt(center.x, box.min.y, center.z);

      const sscene = new THREE.Scene();
      const sil = proto.clone(true);
      const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
      sil.traverse((o) => { if (o.isMesh) o.material = black; });
      sscene.add(sil);

      const prevRT = r.getRenderTarget();
      const prevClear = r.getClearColor(new THREE.Color());
      const prevAlpha = r.getClearAlpha();
      const prevAuto = r.autoClear;
      r.autoClear = true;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(sscene, cam);

      const buf = new Uint8Array(RES * RES * 4);
      r.readRenderTargetPixels(rt, 0, 0, RES, RES, buf);

      r.setRenderTarget(prevRT);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAuto;
      rt.dispose();
      black.dispose();

      // Coverage (alpha) -> soft black shadow. GL pixels are bottom-up, so flip V.
      const raw = document.createElement('canvas'); raw.width = raw.height = RES;
      const img = new ImageData(RES, RES);
      for (let y = 0; y < RES; y++) {
        for (let x = 0; x < RES; x++) {
          const src = ((RES - 1 - y) * RES + x) * 4; // flip vertically
          img.data[(y * RES + x) * 4 + 3] = buf[src + 3]; // RGB stays 0 (black)
        }
      }
      raw.getContext('2d').putImageData(img, 0, 0);
      // blur into a second canvas for a soft penumbra edge
      const cv = document.createElement('canvas'); cv.width = cv.height = RES;
      const ctx = cv.getContext('2d');
      ctx.filter = 'blur(3px)';
      ctx.drawImage(raw, 0, 0);

      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      result = { tex, size: S };
    } catch (e) {
      console.warn('car-shadow silhouette failed; falling back to round blob', e);
      result = { tex: this._shadowTex, size: 1.5 };
    }
    this._carShadowCache.set(model, result);
    return result;
  }

  addCar(id, colorIndex, name) {
    const model = CAR_MODELS[colorIndex % CAR_MODELS.length];
    const proto = this.protos.get(model) || this.protos.get(CAR_MODELS[0]);
    const group = new THREE.Group();
    const car = proto.clone(true);
    car.rotation.y = Math.PI; // Kenney vehicles face -Z; turn to face travel (+Z)
    group.add(car);

    // In the GLB the 4 wheels are children of the body node, so rolling the body
    // would roll the wheels too (the "boat" feel). Reparent the wheels onto `car`
    // (preserving world transform) so we can lean ONLY the body; wheels stay flat.
    const wheels = ['wheel-fl', 'wheel-fr', 'wheel-bl', 'wheel-br']
      .map((n) => car.getObjectByName(n)).filter(Boolean);
    const body = wheels.length ? wheels[0].parent : car;
    for (const w of wheels) car.attach(w);
    const bodyBaseQuat = body.quaternion.clone();
    const frontWheels = ['wheel-fl', 'wheel-fr'].map((n) => car.getObjectByName(n)).filter(Boolean);
    const backWheels = ['wheel-bl', 'wheel-br'].map((n) => car.getObjectByName(n)).filter(Boolean);

    const col = new THREE.Color(this.colors[colorIndex % this.colors.length] || '#ffffff');
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.42, 5),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 })
    );
    marker.rotation.x = Math.PI; marker.position.y = 1.25;
    group.add(marker);
    this.scene.add(group);

    // car-shaped contact shadow: the model's own top-down silhouette. Parented to
    // the group so it inherits heading + road tilt (but not the body's lean), and
    // lies flat just above the road. group +Z = heading, so plane +Y (image-up,
    // the model's back) maps to the car's rear — the silhouette lines up.
    const sh = this._carShadowTexture(model, proto);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(sh.size, sh.size),
      new THREE.MeshBasicMaterial({ map: sh.tex, transparent: true, opacity: 0.5, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02; // a hair above the road to avoid z-fighting
    group.add(shadow);

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    const label = document.createElement('div');
    label.className = 'cell-label';
    label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
    label.querySelector('.cell-label__name').textContent = name || ('P' + id);
    label.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
    this.overlay.appendChild(label);

    // on-screen steer indicator for this player's cell (mirrors the phone bar)
    const steerBar = document.createElement('div');
    steerBar.className = 'cell-steer';
    steerBar.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
    steerBar.innerHTML = `<div class="cell-steer__fill"></div>`;
    this.overlay.appendChild(steerBar);
    const steerFill = steerBar.querySelector('.cell-steer__fill');

    this.cars.set(id, {
      group, car, body, bodyBaseQuat, frontWheels, backWheels, marker, shadow, cam,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, steerBar, steerFill, pose: null, init: false, lean: 0
    });
    if (!this._order.includes(id)) this._order.push(id);
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    if (c.shadow) this.scene.remove(c.shadow);
    if (c.label.parentNode) c.label.parentNode.removeChild(c.label);
    if (c.steerBar && c.steerBar.parentNode) c.steerBar.parentNode.removeChild(c.steerBar);
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
  }

  setCarPose(id, pos, forward, up, tangent, lookAhead, steer = 0, spd = 0, scrub = false, steerInput = steer) {
    const c = this.cars.get(id);
    if (!c) return;
    c.spd = spd; c.scrub = scrub; c.steerAmt = steer;
    const fwd = forward.clone().normalize();
    const u = up.clone().normalize();
    // mesh faces its heading (forward); camera aims at the look-ahead point
    c.pose = {
      pos: pos.clone(), forward: fwd, up: u,
      tangent: (tangent || forward).clone().normalize(),
      lookAhead: lookAhead ? lookAhead.clone() : null
    };
    c.group.position.copy(pos);
    const z = fwd, y = u;
    const x = y.clone().cross(z).normalize();
    const yy = z.clone().cross(x).normalize();
    c.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, yy, z));

    // body lean into the turn — roll ONLY the body (wheels stay flat on the road)
    c.lean += (steer * LEAN_MAX - c.lean) * 0.2;
    c.body.quaternion.copy(c.bodyBaseQuat);
    c.body.rotateZ(c.lean);
    // turn the front wheels with steering (steer>0 = right)
    for (const w of c.frontWheels) w.rotation.y = steer * WHEEL_TURN_MAX;
    // on-screen steer indicator: mirror the player's RAW input (same as the phone
    // bar) so it slides the way they tilt — not the turn-aligned/STEER_SIGN value.
    if (c.steerFill) c.steerFill.style.transform = `translateX(${(steerInput * 50).toFixed(1)}%)`;

    // (the car-shaped shadow is parented to the group, so it follows position,
    // heading and road tilt automatically — nothing to update here)
    c.marker.rotation.z += 0.05;
  }

  setCarHud(id, info) {
    const c = this.cars.get(id);
    if (!c) return;
    const stat = c.label.querySelector('.cell-label__stat');
    stat.textContent = info.finished ? `Finished P${info.position}` : `P${info.position} · L${info.lap}/${info.totalLaps}`;
  }

  start() { if (!this._running) { this._running = true; this._last = performance.now(); requestAnimationFrame((t) => this._loop(t)); } }
  stop() { this._running = false; }

  _updateChase(c, dt) {
    const { pos, forward, up } = c.pose;
    // ideal pose: rigidly behind the CAR's heading, looking just ahead of it
    const want = pos.clone().addScaledVector(forward, -CHASE_DIST).addScaledVector(up, CHASE_HEIGHT);
    const target = pos.clone().addScaledVector(forward, CHASE_LOOK).addScaledVector(up, 0.5);
    // frame-rate-independent damping → smooth lag/swing behind the car through turns
    const aPos = 1 - Math.exp(-CAM_POS_RATE * dt);
    const aTgt = 1 - Math.exp(-CAM_TGT_RATE * dt);
    if (!c.init) { c.camPos.copy(want); c.camTarget.copy(target); c.init = true; }
    else { c.camPos.lerp(want, aPos); c.camTarget.lerp(target, aTgt); }
    c.cam.position.copy(c.camPos);
    // sense of speed: gently widen FOV with speed (no shake)
    const spd = c.spd || 0;
    c.fov = (c.fov || BASE_FOV) + (BASE_FOV + spd * FOV_GAIN - (c.fov || BASE_FOV)) * (1 - Math.exp(-6 * dt));
    c.cam.fov = c.fov;
    c.cam.up.copy(up);
    c.cam.lookAt(c.camTarget);
  }

  _loop(t) {
    if (!this._running) return;
    const dt = Math.min((t - this._last) / 1000, 0.05);
    this._last = t;
    if (this.onFrame) this.onFrame(dt);

    // Kick up small orange dust GRAINS from the ground directly under the wheels
    // (never the car body). Each grain spawns at the wheel's contact patch
    // (projected onto the road plane), pops up a touch and falls — a sparse, low
    // trail that reads as dust, not a plume.
    for (const c of this.cars.values()) {
      if (!c.pose) continue;
      const spd = c.spd || 0;
      const up = c.pose.up, fwd = c.pose.forward;
      const lat = fwd.clone().cross(up); // car-right
      const turn = Math.min(1, Math.abs(c.steerAmt || 0)); // how hard we're cornering
      const driving = spd > 0.2 && c.backWheels && c.backWheels.length;
      if (driving || c.scrub) {
        c.emitT = (c.emitT || 0) + dt;
        // emit FASTER the faster we go and the harder we corner (sense of effort);
        // the curb grind is the densest.
        const interval = c.scrub ? 0.045 : Math.max(0.04, 0.13 - spd * 0.07 - turn * 0.03);
        if (c.emitT >= interval) {
          c.emitT = 0;
          c.group.updateWorldMatrix(false, true); // fresh wheel world transforms
          // curb grind sprays from all four wheels; normal driving just the rears
          const wheels = c.scrub ? [...c.backWheels, ...c.frontWheels] : c.backWheels;
          // wider scatter when cornering/grinding so corners visibly kick up more
          const spread = c.scrub ? 0.9 : 0.3 + turn * 0.6;
          for (const w of wheels) {
            // wheel position dropped straight down onto the road plane = contact patch
            const gp = w.getWorldPosition(new THREE.Vector3());
            gp.addScaledVector(up, -gp.clone().sub(c.pose.pos).dot(up));
            const vel = new THREE.Vector3()
              .addScaledVector(fwd, -(0.2 + spd * 0.8))          // longer trail the faster you go
              .addScaledVector(up, 0.1 + Math.random() * 0.12)   // small pop, then falls
              .addScaledVector(lat, (Math.random() - 0.5) * spread);
            // bigger grains at speed / when grinding; randomised so it's not a stamp
            const size = (c.scrub ? 0.07 : 0.045 + spd * 0.045) + Math.random() * 0.03;
            this._emitDust(gp, this._dustColor || DUST_COLOR, size, 0.25 + Math.random() * 0.12, vel);
          }
        }
      }
    }
    this._stepPuffs(dt);

    const W = window.innerWidth, H = window.innerHeight;
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear();

    const ids = this._order.filter((id) => this.cars.has(id));
    if (ids.length === 0) {
      // lobby / no cars: single overview camera
      this.overview.aspect = W / H; this.overview.updateProjectionMatrix();
      this.overview.position.lerp(this._ovPos || this.overview.position, 0.05);
      this.overview.lookAt(this._ovTarget || new THREE.Vector3());
      r.setViewport(0, 0, W, H); r.setScissor(0, 0, W, H); r.setScissorTest(true);
      r.render(this.scene, this.overview);
      for (const c of this.cars.values()) { c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; }
      requestAnimationFrame((tt) => this._loop(tt));
      return;
    }

    const { cols, rows } = bestGrid(ids.length, W, H);
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);

    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (!c.pose) return;
      const col = i % cols, row = Math.floor(i / cols);
      const x = col * cw;
      const yBottom = H - (row + 1) * ch;  // three viewport origin = lower-left
      this._updateChase(c, dt);
      c.cam.aspect = cw / ch; c.cam.updateProjectionMatrix();

      // hide own marker so it doesn't block the chase view
      c.marker.visible = false;
      r.setViewport(x, yBottom, cw, ch);
      r.setScissor(x, yBottom, cw, ch);
      r.setScissorTest(true);
      r.render(this.scene, c.cam);
      c.marker.visible = true;

      // position the DOM label at the cell's top-left
      c.label.style.display = 'block';
      c.label.style.left = x + 'px';
      c.label.style.top = (row * ch) + 'px';

      // steer indicator: centered along the bottom of this player's cell
      if (c.steerBar) {
        c.steerBar.style.display = 'block';
        c.steerBar.style.left = (x + cw / 2) + 'px';
        c.steerBar.style.top = (row * ch + ch - 34) + 'px';
      }
    });

    requestAnimationFrame((tt) => this._loop(tt));
  }
}
