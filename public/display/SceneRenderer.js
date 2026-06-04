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

// chase camera placement (relative to the car)
const CHASE_DIST = 5.0, CHASE_HEIGHT = 2.4, CHASE_LOOK = 5.0;
const CAM_LERP_POS = 0.16, CAM_LERP_TARGET = 0.22;

// split-screen grid per player count (cols × rows), filled top-to-bottom.
const LAYOUTS = {
  1: [1, 1], 2: [1, 2], 3: [2, 2], 4: [2, 2],
  5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2]
};

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

  setTrack(track, { debug = false } = {}) {
    this.trackGroup.clear();
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
    group.add(proto.clone(true));

    const col = new THREE.Color(this.colors[colorIndex % this.colors.length] || '#ffffff');
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.42, 5),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 })
    );
    marker.rotation.x = Math.PI; marker.position.y = 1.25;
    group.add(marker);
    this.scene.add(group);

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    const label = document.createElement('div');
    label.className = 'cell-label';
    label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
    label.querySelector('.cell-label__name').textContent = name || ('P' + id);
    label.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
    this.overlay.appendChild(label);

    this.cars.set(id, { group, marker, cam, camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(), label, pose: null, init: false });
    if (!this._order.includes(id)) this._order.push(id);
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    if (c.label.parentNode) c.label.parentNode.removeChild(c.label);
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
  }

  setCarPose(id, pos, tangent, up, yaw = 0) {
    const c = this.cars.get(id);
    if (!c) return;
    c.pose = { pos: pos.clone(), tangent: tangent.clone().normalize(), up: up.clone().normalize() };
    c.group.position.copy(pos);
    const z = c.pose.tangent, y = c.pose.up;
    const x = y.clone().cross(z).normalize();
    const yy = z.clone().cross(x).normalize();
    c.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, yy, z));
    if (yaw) c.group.rotateY(yaw);
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

  _updateChase(c) {
    const { pos, tangent, up } = c.pose;
    const want = pos.clone()
      .addScaledVector(tangent, -CHASE_DIST)
      .addScaledVector(up, CHASE_HEIGHT);
    const target = pos.clone()
      .addScaledVector(tangent, CHASE_LOOK)
      .addScaledVector(up, 0.4);
    if (!c.init) { c.camPos.copy(want); c.camTarget.copy(target); c.init = true; }
    else { c.camPos.lerp(want, CAM_LERP_POS); c.camTarget.lerp(target, CAM_LERP_TARGET); }
    c.cam.position.copy(c.camPos);
    c.cam.up.copy(up);
    c.cam.lookAt(c.camTarget);
  }

  _loop(t) {
    if (!this._running) return;
    const dt = Math.min((t - this._last) / 1000, 0.05);
    this._last = t;
    if (this.onFrame) this.onFrame(dt);

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

    const [cols, rows] = LAYOUTS[Math.min(8, ids.length)] || [Math.ceil(Math.sqrt(ids.length)), Math.ceil(Math.sqrt(ids.length))];
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);

    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (!c.pose) return;
      const col = i % cols, row = Math.floor(i / cols);
      const x = col * cw;
      const yBottom = H - (row + 1) * ch;  // three viewport origin = lower-left
      this._updateChase(c);
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
