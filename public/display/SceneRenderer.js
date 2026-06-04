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
  'track-wide-straight', 'track-wide-corner-small', 'track-wide-corner-large', 'track-wide-curve'
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

// Soft white puff for exhaust / curb-dust sprites (tinted per-emit).
function makePuffTexture() {
  const s = 48;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
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

  // Pooled puff sprites for exhaust + curb dust. Sprites face whichever camera
  // renders them, so they look right in every split-screen viewport.
  _initParticles() {
    this._puffTex = makePuffTexture();
    this._puffs = [];
    this._puffN = 0;
    for (let i = 0; i < 120; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._puffTex, transparent: true, depthWrite: false, opacity: 0
      }));
      sp.visible = false;
      sp.userData.life = 0;
      this.scene.add(sp);
      this._puffs.push(sp);
    }
  }

  _emitPuff(pos, color, size, life, rise) {
    const sp = this._puffs[this._puffN];
    this._puffN = (this._puffN + 1) % this._puffs.length;
    sp.visible = true;
    sp.position.copy(pos);
    sp.material.color.set(color);
    sp.scale.setScalar(size);
    sp.userData.life = life;
    sp.userData.maxLife = life;
    sp.userData.size = size;
    sp.userData.rise = rise;
  }

  _stepPuffs(dt) {
    for (const sp of this._puffs) {
      if (!sp.visible) continue;
      sp.userData.life -= dt;
      if (sp.userData.life <= 0) { sp.visible = false; sp.material.opacity = 0; continue; }
      const f = sp.userData.life / sp.userData.maxLife; // 1 → 0
      sp.material.opacity = 0.5 * f;
      sp.scale.setScalar(sp.userData.size * (1.6 - f)); // grow as it fades
      sp.position.y += sp.userData.rise * dt;
    }
  }

  _initThree() {
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.autoClear = false; // we clear once per frame, then render N viewports
    this.container.appendChild(r.domElement);
    this.renderer = r;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ecae6);
    scene.fog = new THREE.Fog(0x8ecae6, 70, 170);
    this.scene = scene;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a7a4a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
    sun.position.set(20, 40, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 60;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 140;
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: 0x6aa84f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.0;
    ground.receiveShadow = true;
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
        gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.protos.set(name, gltf.scene);
        resolve();
      }, undefined, reject);
    })));
  }

  // Sample the average colour of the track's UP-facing surfaces straight from the
  // GLB texture atlas, so dust matches the road and auto-updates if the track
  // model/colour changes. Falls back to tan if anything is unavailable.
  _sampleTrackColor() {
    const fallback = new THREE.Color(0xc9b78f);
    let mesh = null;
    const proto = this.protos.get('track-wide-straight');
    if (proto) proto.traverse((o) => {
      if (!mesh && o.isMesh && o.geometry.attributes.uv && o.material && o.material.map && o.material.map.image) mesh = o;
    });
    if (!mesh) return fallback;
    const map = mesh.material.map, img = map.image, w = img.width, h = img.height;
    if (!w || !h) return fallback;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const pos = mesh.geometry.attributes.position, nrm = mesh.geometry.attributes.normal, uv = mesh.geometry.attributes.uv;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (nrm && nrm.getY(i) < 0.7) continue; // up-facing only (road + curb tops)
      let u = uv.getX(i), v = uv.getY(i);
      if (map.flipY) v = 1 - v;
      const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
      const py = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
      const idx = (py * w + px) * 4;
      r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; n++;
    }
    if (!n) return fallback;
    return new THREE.Color((r / n) / 255, (g / n) / 255, (b / n) / 255);
  }

  setTrack(track, { debug = false } = {}) {
    this.trackGroup.clear();
    this._dustColor = this._sampleTrackColor();
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

    const col = new THREE.Color(this.colors[colorIndex % this.colors.length] || '#ffffff');
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.42, 5),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 })
    );
    marker.rotation.x = Math.PI; marker.position.y = 1.25;
    group.add(marker);
    this.scene.add(group);

    // soft contact shadow that grounds the car (separate from the group so it
    // stays flat on the road and doesn't lean/bob with the body)
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.7),
      new THREE.MeshBasicMaterial({ map: this._shadowTex, transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    this.scene.add(shadow);

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    const label = document.createElement('div');
    label.className = 'cell-label';
    label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
    label.querySelector('.cell-label__name').textContent = name || ('P' + id);
    label.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
    this.overlay.appendChild(label);

    this.cars.set(id, {
      group, car, body, bodyBaseQuat, frontWheels, marker, shadow, cam,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, pose: null, init: false, lean: 0
    });
    if (!this._order.includes(id)) this._order.push(id);
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    if (c.shadow) this.scene.remove(c.shadow);
    if (c.label.parentNode) c.label.parentNode.removeChild(c.label);
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
  }

  setCarPose(id, pos, forward, up, tangent, lookAhead, steer = 0, spd = 0, scrub = false) {
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

    // contact shadow: flat on the road, directly under the car (no lean/bob)
    c.shadow.position.copy(pos).addScaledVector(u, 0.04);
    const a = Math.atan2(fwd.x, fwd.z); // yaw so the elliptical blob aligns with the car
    c.shadow.rotation.set(-Math.PI / 2, 0, -a);

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

    // kick up ground DUST from behind the wheels (toy car → dust, not smoke)
    for (const c of this.cars.values()) {
      if (!c.pose) continue;
      const spd = c.spd || 0;
      if (spd > 0.15) {
        c.emitT = (c.emitT || 0) + dt;
        const interval = 0.10 - spd * 0.05;
        if (c.emitT >= interval) {
          c.emitT = 0;
          const lat = c.pose.forward.clone().cross(c.pose.up); // car-lateral for spread
          const p = c.pose.pos.clone()
            .addScaledVector(c.pose.forward, -0.45)        // behind the car
            .addScaledVector(c.pose.up, 0.02)              // just off the ground
            .addScaledVector(lat, (Math.random() - 0.5) * 0.4);
          this._emitPuff(p, this._dustColor || 0xc9b78f, 0.22, 0.5, 0.25); // track-coloured dust
        }
      }
      if (c.scrub) {
        const p = c.pose.pos.clone().addScaledVector(c.pose.up, 0.03);
        this._emitPuff(p, this._dustColor || 0xb8975f, 0.5, 0.5, 0.3);     // heavier dust at the curb
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
      for (const c of this.cars.values()) c.label.style.display = 'none';
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
    });

    requestAnimationFrame((tt) => this._loop(tt));
  }
}
