// SceneRenderer — Three.js scene for the race. Per-player CHASE camera in a
// SPLIT-SCREEN viewport (each player sees behind their own car). One shared
// scene; we render it once per player into their screen cell, with per-view
// name/position labels overlaid. Falls back to a single overview camera in the
// lobby (no cars). The game layer calls setCarPose()/setCarHud() each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

// Debug aid: expose the THREE namespace so test harnesses can raycast against the
// rendered track to verify the centerline rides the actual GLB road surface.
if (typeof window !== 'undefined') window.__THREE = THREE;

// Shared with the controller's car picker + protocol (one source of truth).
// protocol.js (classic script) sets this global before the display modules load.
const CAR_MODELS = window.CAR_MODELS;
const CAR_MODEL_YAW = window.CAR_MODEL_YAW || []; // per-model facing fix (see protocol.js)
const TRACK_GLBS = [
  'track-road-wide-straight', 'track-road-wide-corner-small', 'track-road-wide-corner-large', 'track-road-wide-curve'
];

// Chase camera: sits behind the CAR's heading and looks at it, with the position
// and look-target damped so it lags and swings smoothly behind through turns
// (the standard spring chase-cam every kart racer uses).
// Close chase that sits LOW and just behind the car with a fairly tight lens, so
// the camera stays comfortable to drive rather than steeply top-down.
const CHASE_DIST = 1.8, CHASE_HEIGHT = 0.85, CHASE_LOOK = 2.0; // close, low, slight look-down
const CHASE_TGT_UP = 0.15;    // look point barely above the road → camera pitches onto the car
const CAM_POS_RATE = 7.0, CAM_TGT_RATE = 13.0; // damping speed per second (higher = snappier)
const LEAN_MAX = 0.05;        // max body roll (rad) at full steer — subtle
const WHEEL_TURN_MAX = 0.5;   // max front-wheel turn (rad) at full steer
const BASE_FOV = 55;          // camera FOV at rest — tighter lens, less wide-angle stretch
const FOV_GAIN = 5;           // extra FOV degrees at top speed (subtle sense of speed)
// Wheel-kick colour — dark grey (tyre scuff / asphalt grit). One knob to retint.
const DUST_COLOR = 0x4a4a4a;

// NOTE: tilt-shift depth-of-field was removed — it didn't read well in motion. The
// scene still renders to an offscreen LINEAR target and is presented through a
// single full-screen pass that applies exposure + the linear→sRGB encode (see
// _present / _matPresent). To bring DOF back later, reinstate the blur render
// targets + a depth texture on _rtScene and mix sharp↔blur by depth in that pass.

// Look constants. Colour grading is done in the PRESENT shader, not via the
// renderer's tone mapping: Three disables tone mapping (and sRGB output) when a
// pass renders into an offscreen target, which ours does. So the present pass
// applies exposure and the linear→sRGB encode itself.
const DEF_EXPOSURE = 1.1;    // brightness multiplier (1 = stock)
const DEF_CAR_ROUGH = 1.2;   // car roughness multiplier (>1 = more matte than stock; <1 = glossier)
const DEF_KEY_LIGHT = 1.4;   // warm key-light intensity (the plastic "shine")

// Ground-conform: each frame we raycast the rendered track under the front + rear
// axles and drop the car onto it, so the wheels ride ON the road over bumps/hills
// (the centreline only approximates the GLB, so following it directly clips the
// body in). The model's wheel-bottom sits at the group origin, so RIDE_HEIGHT is
// the gap from wheel to road — keep it tiny so the car looks planted, not hovering.
const RIDE_HEIGHT = 0.012;

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

// ---------------------------------------------------------------------------
// Rear NAME PLATE — replaces the old rotating cone marker. A small livery-
// coloured "license plate" fixed to the back of each car with the player's
// name. The chase cam looks at the back of every car, so you read the plate of
// whoever you're chasing. The plate is a flat mesh
// parented to the car body (so it banks with the steering lean), facing rearward.
const PLATE_MAX_W = 0.2;     // plate width cap in world units (also clamped to the car's width)
const PLATE_Y_FRAC = 0.46;   // fallback height up the body's rear face (0 = underside, 1 = roof)

// Per-model plate height (world Y on the rear face), indexed by CAR_MODELS
// position. null = use the auto-detected flat-panel height; the values below
// were hand-tuned per model so the plate sits on each car's flat rear surface.
// Order: racer, speedster, drag-racer, racer-low, vintage-racer, suv, truck, monster-truck.
const PLATE_Y = [0.157, 0.245, 0.166, 0.156, 0.134, 0.158, 0.247, 0.522];

// Darken a #rrggbb by `amt` (0..1) — used for the plate's inner rim so it reads
// as a solid plastic chip rather than a flat fill.
function shade(hex, amt) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amt));
  const g = Math.round(((n >> 8) & 255) * (1 - amt));
  const b = Math.round((n & 255) * (1 - amt));
  return `rgb(${r},${g},${b})`;
}

// Draw the plate to a canvas: a livery-filled rounded rect inside a white rim,
// with the name in white, auto-shrunk to fit. Returns { tex, aspect }.
function makePlateTexture(name, colorHex) {
  const text = (name == null ? '' : String(name)).trim() || '—';
  const S = 4;                 // supersample → crisp even though the plate is small on screen
  const W = 232, H = 92;       // logical plate canvas (~2.5 : 1)
  const cv = document.createElement('canvas');
  cv.width = W * S; cv.height = H * S;
  const ctx = cv.getContext('2d');
  ctx.scale(S, S);

  // white rim, then livery field inset, then a darker inner hairline
  const pad = 6, r = 16;
  ctx.beginPath(); ctx.roundRect(0, 0, W, H, r); ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.beginPath(); ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, r - 4);
  ctx.fillStyle = colorHex; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = shade(colorHex, 0.28); ctx.stroke();

  // name — white, bold, auto-fit to the field width
  const maxW = W - pad * 2 - 24;
  let fontPx = 54;
  ctx.font = `700 ${fontPx}px Fredoka, Nunito, system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) {
    fontPx = Math.max(20, Math.floor(fontPx * maxW / tw));
    ctx.font = `700 ${fontPx}px Fredoka, Nunito, system-ui, sans-serif`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.32)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
  ctx.fillText(text, W / 2, H / 2 + 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, aspect: W / H };
}

// Build the plate mesh for one car. `anchor` = { z (rear face), y, w (car width) }
// in the car group's local space, derived from the model's bounding box.
function makePlate(name, colorHex, anchor) {
  const pt = makePlateTexture(name, colorHex);
  const w = Math.min(PLATE_MAX_W, anchor.w * 0.92); // never wider than the car's rear
  const h = w / pt.aspect;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: pt.tex, transparent: true, depthWrite: false })
  );
  // Transform (rear-facing + height) is set by SceneRenderer._positionPlate.
  return mesh;
}

export class SceneRenderer {
  constructor(container, colors) {
    this.container = container;
    this.colors = colors || ['#e6492d'];
    this.protos = new Map();
    this.cars = new Map();      // id -> { group, plate, cam, camPos, camTarget, label, pose }
    this._plateAnchors = new Map(); // model name -> { z, y, w } rear-plate placement (per model)
    this._order = [];           // stable cell order
    this._running = false;
    this._last = 0;
    this._initThree();
    this._initOverlay();
    this._initParticles();
    this._groundRay = new THREE.Raycaster();
    this._rayFrom = new THREE.Vector3();
    this._rayDown = new THREE.Vector3(0, -1, 0);
    this._headFlat = new THREE.Vector3();  // car heading flattened to horizontal
    this._fwdTilt = new THREE.Vector3();   // heading re-pitched onto the road slope
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._normalMat = new THREE.Matrix3(); // for road-tile world normals
    this._hitNormal = new THREE.Vector3();
  }

  // World-Y of the drivable road surface directly under (x, z), or null if no
  // tile is below. Casts straight down from well above. Two filters pick the road
  // top out of everything the ray hits:
  //   1. The road tiles are solid slabs — each returns a TOP face (normal up) and
  //      a BOTTOM face (normal down) ~0.1–0.2 below it. We keep only up-facing
  //      faces, so we never lock onto a tile's underside (which would sink the car
  //      and its wheels through the road).
  //   2. Among those, pick the hit nearest `refY` (the expected road height, i.e.
  //      the centreline) — that skips the start/finish GATE arch, whose up-facing
  //      top sits well ABOVE the road, and resolves overlapping tiles at a seam.
  _roadHitY(x, z, refY) {
    this._rayFrom.set(x, refY + 6, z);
    this._groundRay.set(this._rayFrom, this._rayDown);
    this._groundRay.far = 14;
    const hits = this._groundRay.intersectObject(this.trackGroup, true);
    let best = null, bestErr = Infinity;
    for (const h of hits) {
      if (h.face) {
        this._normalMat.getNormalMatrix(h.object.matrixWorld);
        if (this._hitNormal.copy(h.face.normal).applyNormalMatrix(this._normalMat).y <= 0.1) continue;
      }
      const err = Math.abs(h.point.y - refY);
      if (err < bestErr) { bestErr = err; best = h.point.y; }
    }
    return best;
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
    // Real shadow map: cars cast a soft shadow the road RECEIVES, so it wraps over
    // bumps/hills with no clipping (a flat painted blob can't sit on curved ground).
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // soft PCF; the Soft variant is deprecated in our three build
    this.container.appendChild(r.domElement);
    this.renderer = r;

    // No renderer tone mapping: it would be ignored on our offscreen pass anyway
    // (Three only tone-maps when rendering straight to the canvas). The composite
    // shader does exposure + linear→sRGB explicitly instead.
    r.toneMapping = THREE.NoToneMapping;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ecae6);
    scene.fog = new THREE.Fog(0x8ecae6, 70, 170);
    this.scene = scene;

    // Toy lighting: a soft sky/ground hemisphere for even fill, PLUS a warm key light
    // that also casts the "Sunny Circuit" shadow. The key's specular highlight is the
    // "shiny plastic" dot that sells the injection-moulded-toy read; the hemisphere
    // keeps shadowed sides from going black.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
    const key = new THREE.DirectionalLight(0xfff1d0, DEF_KEY_LIGHT);
    key.position.set(6, 12, 4); // high and slightly to one side → raking gloss + sun shadow
    // Shadow camera bounds/placement are set per-track in setTrack (needs the track
    // extent). autoUpdate off: _loop refreshes the map once per frame, not once per
    // split-screen cell, so N cameras stay one shadow pass.
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.autoUpdate = false;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.05; // curved road → bias along the normal kills acne
    scene.add(key);
    scene.add(key.target);
    this._key = key;

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

    this._initPost();

    window.addEventListener('resize', () => this._onResize());
  }

  // Offscreen present pipeline:  scene → _rtScene (linear, MSAA)  →  present to canvas.
  // The scene renders to an offscreen target so split-screen viewports compose into
  // one image; a single full-screen pass then grades it (exposure) and does the
  // linear→sRGB encode (Three skips both on offscreen targets, so we own them). The
  // MSAA samples here matter: the renderer's `antialias` flag only covers the default
  // canvas framebuffer, but the whole scene goes through this target — without it
  // every geometry edge (notably the plate's thin rim) aliases and crawls as the car
  // tilts. WebGL2 resolves the multisample buffer for us.
  // (Depth-of-field blur was removed; see the note near the look constants for how to
  // reinstate it — add blur targets + a depth texture and mix sharp↔blur here.)
  _initPost() {
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.max(2, db.x), H = Math.max(2, db.y);
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };

    this._rtScene = new THREE.WebGLRenderTarget(W, H, { ...opts, depthBuffer: true, samples: 4 });
    this._rtScene.texture.colorSpace = THREE.LinearSRGBColorSpace;

    const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

    // Present: sample the (linear) scene, GRADE — exposure (brightness) → linear→sRGB
    // encode — and write straight to the canvas. toneMapped=false so Three doesn't
    // touch our output.
    this._matPresent = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: { tScene: { value: null }, exposure: { value: DEF_EXPOSURE } },
      vertexShader: VERT,
      fragmentShader: `
        uniform sampler2D tScene; uniform float exposure;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c){
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main(){
          vec3 col = toSRGB(texture2D(tScene, vUv).rgb * exposure);
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`
    });

    this._fsScene = new THREE.Scene();
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._matPresent);
    this._fsScene.add(this._fsQuad);
    this._dbSize = new THREE.Vector2();
  }

  _resizePost() {
    if (!this._rtScene) return;
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this._rtScene.setSize(Math.max(2, db.x), Math.max(2, db.y));
  }

  // Grade _rtScene (exposure + linear→sRGB) straight to the canvas (target null).
  _present() {
    const r = this.renderer;
    this._matPresent.uniforms.tScene.value = this._rtScene.texture;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.render(this._fsScene, this._fsCam);
  }

  _initOverlay() {
    const o = document.createElement('div');
    o.className = 'race-labels';
    o.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    this.container.appendChild(o);
    this.overlay = o;
  }

  _aspect() { return window.innerWidth / Math.max(1, window.innerHeight); }
  _onResize() { this.renderer.setSize(window.innerWidth, window.innerHeight); this._resizePost(); }

  // `trackGlbs` lets the caller pass exactly the track tiles the chosen layout
  // uses (derived from track.instances) so new pieces load without editing the
  // hard-coded TRACK_GLBS fallback.
  async load(trackGlbs = TRACK_GLBS) {
    const loader = new GLTFLoader();
    const need = [...new Set([...trackGlbs, ...CAR_MODELS])];
    await Promise.all(need.map((name) => new Promise((resolve, reject) => {
      loader.load(ASSET(name), (gltf) => {
        if (CAR_MODELS.includes(name)) this._registerCarMats(gltf.scene);
        this.protos.set(name, gltf.scene);
        resolve();
      }, undefined, reject);
    })));
    this._applyCarLook(); // gloss pass on all car materials
  }

  // Collect every unique car material once, stashing its STOCK roughness so the
  // gloss can be re-derived from the original each time the slider moves (else
  // repeated multiplies would drift). Materials are shared across the proto's
  // meshes — and a cloned car shares them — so editing them updates every car live.
  _registerCarMats(root) {
    if (!this._carMats) this._carMats = new Set();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || this._carMats.has(m)) continue;
        m.userData.baseRough = ('roughness' in m) ? (m.roughness ?? 1) : null;
        if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.1);
        this._carMats.add(m);
      }
    });
  }

  // Apply the car gloss from stored stock roughness, scaled by DEF_CAR_ROUGH:
  // lower roughness → sharper key-light "toy shine".
  _applyCarLook() {
    if (!this._carMats) return;
    const mul = DEF_CAR_ROUGH;
    for (const m of this._carMats) {
      if (m.userData.baseRough != null) { m.roughness = Math.max(0.08, m.userData.baseRough * mul); m.needsUpdate = true; }
    }
  }

  setTrack(track, { debug = false } = {}) {
    this.trackGroup.clear();
    this._dustColor = new THREE.Color(DUST_COLOR); // asphalt grit grey (see DUST_COLOR)
    if (track.groundY != null) this.ground.position.y = track.groundY;
    for (const inst of track.instances) {
      const proto = this.protos.get(inst.glb);
      if (!proto) continue;
      const node = proto.clone(true);
      node.matrixAutoUpdate = false;
      node.matrix.copy(inst.matrix);
      node.traverse((o) => { if (o.isMesh) o.receiveShadow = true; }); // catch car shadows
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

    // Aim + size the sun's shadow camera to cover the whole track. The light keeps its
    // (6,12,4) DIRECTION (so gloss/highlights are unchanged); we just move it far out
    // along that direction and frame the track tightly for good shadow-map resolution.
    const half = Math.max(size.x, size.z) * 0.5 + 4;
    const k = this._key;
    k.target.position.copy(this._trackCenter); k.target.updateMatrixWorld();
    k.position.copy(this._trackCenter).add(new THREE.Vector3(6, 12, 4).normalize().multiplyScalar(half * 2.2));
    const sc = k.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = half * 0.6; sc.far = half * 3.6 + 12;
    sc.updateProjectionMatrix();
    k.shadow.needsUpdate = true; // rebuild the map for the new track
  }

  // Rear-plate placement for a model (cached per model): the rear-panel Z, the
  // height to mount the plate, and the body width — all in the car group's local
  // space (the group is at identity here, so body world coords = local).
  //
  // We auto-find each model's flat rear panel rather than guessing a fixed
  // height: cast rays forward (+Z) into the BODY at a ladder of heights and read
  // the rear surface depth at each. The plate wants the REARMOST near-vertical
  // wall (bumper / tailgate / hatch) — so we take the tallest contiguous run of
  // heights whose depth sits close to the rearmost hit, and centre the plate on
  // it. (A plain "flattest run" can latch onto a forward wall like the cabin
  // back; anchoring to the rearmost depth avoids that.) Wheels are already
  // reparented off the body, so they can't interfere.
  _plateAnchor(model, group, body) {
    if (this._plateAnchors.has(model)) return this._plateAnchors.get(model);
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(body);
    const cx = (box.min.x + box.max.x) / 2;
    const w = box.max.x - box.min.x;

    const N = 48;
    const dy = (box.max.y - box.min.y) / N;
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3(0, 0, 1);
    const startZ = box.min.z - 0.5;
    const origin = new THREE.Vector3();

    // Some models wind their rear shell so its outward faces would be back-face
    // culled — the ray would punch through. Force the body double-sided for the
    // cast so the first hit is always the nearest surface, then restore.
    const sideSaved = [];
    body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        sideSaved.push([m, m.side]); m.side = THREE.DoubleSide;
      }
    });

    const hits = [];      // per height: rear-surface z, or null on a miss
    let zMin = Infinity;
    for (let i = 0; i < N; i++) {
      const y = box.min.y + dy * (i + 0.5);
      ray.set(origin.set(cx, y, startZ), dir);
      const hit = ray.intersectObject(body, true)[0];
      const z = hit ? hit.point.z : null;
      hits.push(z);
      if (z != null && z < zMin) zMin = z;
    }
    for (const [m, side] of sideSaved) m.side = side; // restore

    // Tallest contiguous run of heights sitting within `nearTol` of the rearmost
    // depth — i.e. the rear wall, tolerating a little rake.
    const depth = box.max.z - box.min.z;
    const nearTol = Math.min(0.2, Math.max(0.05, depth * 0.18));
    let best = null, run = null;
    for (let i = 0; i < N; i++) {
      const z = hits[i];
      const y = box.min.y + dy * (i + 0.5);
      if (z != null && z <= zMin + nearTol) {
        if (run) { run.y1 = y; run.zMin = Math.min(run.zMin, z); }
        else run = { y0: y, y1: y, zMin: z };
        if (!best || (run.y1 - run.y0) > (best.y1 - best.y0)) best = run;
      } else { run = null; }
    }

    // Anchor to the REARMOST depth of the band (not its average): the flat wall
    // sits at the rearmost depth, while bevels/lips recede — averaging would sink
    // the plate behind a clean wall (e.g. the box truck) and hide it.
    const a = best
      ? { z: best.zMin, y: (best.y0 + best.y1) / 2, w }
      // fallback if the model resists raycasting: the old fixed-fraction guess
      : { z: box.min.z, y: box.min.y + (box.max.y - box.min.y) * PLATE_Y_FRAC, w };
    this._plateAnchors.set(model, a);
    return a;
  }

  addCar(id, colorIndex, name, opts = {}) {
    // Car model is the player's pick (opts.carIndex), independent of the colour
    // livery; fall back to colorIndex when no pick is supplied (e.g. previews).
    const carIndex = (opts.carIndex == null ? colorIndex : opts.carIndex);
    const model = CAR_MODELS[carIndex % CAR_MODELS.length];
    const proto = this.protos.get(model) || this.protos.get(CAR_MODELS[0]);
    const group = new THREE.Group();
    const car = proto.clone(true);
    // Kenney vehicles face -Z; turn to face travel (+Z). Some meshes (e.g. the
    // vintage racer) are modelled facing the other way, so add their per-model
    // yaw fix or they'd drive backwards.
    car.rotation.y = Math.PI + (CAR_MODEL_YAW[carIndex % CAR_MODELS.length] || 0);
    car.traverse((o) => { if (o.isMesh) o.castShadow = true; }); // sun shadow onto the road
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

    // livery "license plate" on the car's rear bumper, showing the player name.
    // Parented to the BODY (not the group) so it banks WITH the steering lean.
    // _positionPlate (below) sets its body-local transform from the auto-detected
    // rear panel, applying any per-model height override (PLATE_Y).
    const colHex = this.colors[colorIndex % this.colors.length] || '#ffffff';
    const anchor = this._plateAnchor(model, group, body);
    const plate = makePlate(name, colHex, anchor);
    body.add(plate);
    this.scene.add(group);

    // (Contact shadow is a real cast shadow now — car.castShadow above + road
    // receiveShadow in setTrack — so it conforms to bumps/hills with no fake quad.)

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    // AI/CPU cars (opts.cell === false) race in the shared world — so they show up
    // in every human's chase view — but get NO split-screen cell of their own. A
    // solo human then sees one viewport, not their own cell plus three bot cameras.
    // Cell-less cars skip the DOM overlay (label + steer bar) and the cell order.
    const cell = opts.cell !== false;
    let label = null, steerBar = null, steerFill = null;
    if (cell) {
      label = document.createElement('div');
      label.className = 'cell-label';
      label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
      label.querySelector('.cell-label__name').textContent = name || ('P' + id);
      label.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
      this.overlay.appendChild(label);

      // on-screen steer indicator for this player's cell (mirrors the phone bar)
      steerBar = document.createElement('div');
      steerBar.className = 'cell-steer';
      steerBar.style.setProperty('--c', this.colors[colorIndex % this.colors.length] || '#fff');
      steerBar.innerHTML = `<div class="cell-steer__fill"></div>`;
      this.overlay.appendChild(steerBar);
      steerFill = steerBar.querySelector('.cell-steer__fill');
    }

    // Longitudinal wheelbase (front axle → rear axle), measured from the model so
    // the ground-conform probes sit exactly under the axles. Rotation-invariant
    // distance, so reading it before the group is posed is fine.
    group.updateWorldMatrix(true, true);
    const axleMid = (arr) => {
      const v = new THREE.Vector3();
      for (const o of arr) v.add(o.getWorldPosition(new THREE.Vector3()));
      return arr.length ? v.multiplyScalar(1 / arr.length) : v;
    };
    const wheelbase = (frontWheels.length && backWheels.length)
      ? axleMid(frontWheels).distanceTo(axleMid(backWheels)) : 0.6;

    const c = {
      group, car, body, bodyBaseQuat, frontWheels, backWheels, wheelbase, plate, cam,
      carIndex, anchorZ: anchor.z, plateY: anchor.y,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, steerBar, steerFill, pose: null, init: false, lean: 0
    };
    this.cars.set(id, c);
    // Place the plate (applies a per-model PLATE_Y override if one is set).
    this._positionPlate(c, PLATE_Y[carIndex] != null ? PLATE_Y[carIndex] : anchor.y);
    if (cell && !this._order.includes(id)) this._order.push(id);
  }

  // Set a car's plate height to `y` (world units on the rear face). The plate is
  // a child of the BODY, so we convert the desired GROUP-space placement —
  // (0, y, anchorZ) facing rearward — into the body's local frame using the
  // body's REST transform (so it's independent of the car's current heading and
  // lean, and still banks once the body rolls).
  _positionPlate(c, y) {
    c.plateY = y;
    // Desired plate transform in the GROUP's frame: centred, at height y, just
    // behind the rear face, turned to face rearward.
    const pg = new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, c.anchorZ - 0.02),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      new THREE.Vector3(1, 1, 1)
    );
    // group <- body, at REST. Read it straight off the scene graph (with the
    // body un-leaned) so it's correct whether `body` is a child node OR the car
    // itself — the monster truck's wheels aren't named like the others, so its
    // `body` falls back to the car, and composing car×body would double-apply.
    const savedQ = c.body.quaternion.clone();
    c.body.quaternion.copy(c.bodyBaseQuat);
    c.body.updateWorldMatrix(true, false); // refresh body + ancestors (car, group)
    const gb = new THREE.Matrix4().copy(c.group.matrixWorld).invert().multiply(c.body.matrixWorld);
    c.body.quaternion.copy(savedQ);        // restore (the frame loop re-applies lean)
    // plate local (in the body's frame) = (group<-body)^-1 * desired
    gb.invert().multiply(pg).decompose(c.plate.position, c.plate.quaternion, c.plate.scale);
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    // Dispose only what addCar created fresh per car (the name plate). The car mesh
    // shares its geometry/material with the cached prototype — leave it for the next
    // race. (The contact shadow is a real cast shadow now — nothing per-car to free.)
    c.plate.geometry.dispose(); c.plate.material.map.dispose(); c.plate.material.dispose();
    if (c.label && c.label.parentNode) c.label.parentNode.removeChild(c.label);
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

    // Ground-conform: probe the rendered road under the FRONT and REAR axles, then
    // sit the car on the mean of the two and PITCH it along their slope — so the
    // wheels ride on top of bumps/hills instead of clipping through. A single
    // centre probe gets height but not slope, so the nose digs in / lifts off on a
    // crest; two probes give both. Heading (yaw) stays the centreline's; only
    // pitch + ride height come from the road. Roll is left level (world up) — this
    // track has no banking, and a flat car reads "wheels on the road" cleanly.
    let z = fwd; // default: follow the centreline forward (used if a probe misses)
    const yC = this._roadHitY(pos.x, pos.z, pos.y); // road directly under the car centre
    this._headFlat.copy(fwd).setY(0);
    if (this._headFlat.lengthSq() > 1e-6) {
      this._headFlat.normalize();
      const half = c.wheelbase * 0.5;
      const yF = this._roadHitY(pos.x + this._headFlat.x * half, pos.z + this._headFlat.z * half, pos.y);
      const yB = this._roadHitY(pos.x - this._headFlat.x * half, pos.z - this._headFlat.z * half, pos.y);
      if (yF != null && yB != null) {
        // re-pitch the (horizontal) heading onto the road slope: rise/run = Δy/wheelbase
        z = this._fwdTilt.set(this._headFlat.x, (yF - yB) / c.wheelbase, this._headFlat.z).normalize();
        // Rest on the HIGHEST road point under the footprint (front/centre/rear), not
        // the chord mean: on flat/gentle ground these agree (still planted), but at a
        // sharp crest it rides the peak so the road never pokes up through the belly —
        // at worst a wheel floats briefly cresting a bump, which beats clipping.
        c.group.position.y = (yC != null ? Math.max(yF, yB, yC) : Math.max(yF, yB)) + RIDE_HEIGHT;
      } else if (yC != null) {
        // off the edge / over the gate seam: fall back to the centre probe (height only)
        c.group.position.y = yC + RIDE_HEIGHT;
      }
    }
    // Build the car basis from the pitched forward + a level (world-up) reference,
    // so x (lateral) stays horizontal and the body owns pitch, nothing else.
    const x = this._worldUp.clone().cross(z).normalize();
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

    // (nothing else to update here: the cast shadow follows the car automatically,
    // and the name plate is parented to the body so it banks with the steering lean.)
  }

  setCarHud(id, info) {
    const c = this.cars.get(id);
    if (!c || !c.label) return; // cell-less AI cars have no HUD label
    const stat = c.label.querySelector('.cell-label__stat');
    stat.textContent = info.finished ? `Finished P${info.position}` : `P${info.position} · L${info.lap}/${info.totalLaps}`;
  }

  start() { if (!this._running) { this._running = true; this._last = performance.now(); requestAnimationFrame((t) => this._loop(t)); } }
  stop() { this._running = false; }

  _updateChase(c, dt) {
    const { pos, forward, up } = c.pose;
    const baseFov = BASE_FOV, height = CHASE_HEIGHT;
    // ideal pose: rigidly behind the CAR's heading, looking just ahead of it
    const want = pos.clone().addScaledVector(forward, -CHASE_DIST).addScaledVector(up, height);
    const target = pos.clone().addScaledVector(forward, CHASE_LOOK).addScaledVector(up, CHASE_TGT_UP);
    // frame-rate-independent damping → smooth lag/swing behind the car through turns
    const aPos = 1 - Math.exp(-CAM_POS_RATE * dt);
    const aTgt = 1 - Math.exp(-CAM_TGT_RATE * dt);
    if (!c.init) { c.camPos.copy(want); c.camTarget.copy(target); c.init = true; }
    else { c.camPos.lerp(want, aPos); c.camTarget.lerp(target, aTgt); }
    c.cam.position.copy(c.camPos);
    // sense of speed: gently widen FOV with speed (no shake)
    const spd = c.spd || 0;
    c.fov = (c.fov || baseFov) + (baseFov + spd * FOV_GAIN - (c.fov || baseFov)) * (1 - Math.exp(-6 * dt));
    c.cam.fov = c.fov;
    c.cam.up.copy(up);
    c.cam.lookAt(c.camTarget);
  }

  _loop(t) {
    if (!this._running) return;
    const dt = Math.min((t - this._last) / 1000, 0.05);
    this._last = t;
    if (this.onFrame) this.onFrame(dt);

    // Kick up small dust GRAINS from the ground directly under the wheels
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
    // Everything renders into the offscreen scene target (drawing-buffer pixels);
    // _present then grades it (exposure + sRGB) and copies it to the canvas.
    const rt = this._rtScene;
    const db = r.getDrawingBufferSize(this._dbSize);
    const DBW = db.x, DBH = db.y;
    // clear the WHOLE target first (colour + depth) so empty split-screen cells
    // and rounding strips don't keep last frame's pixels
    rt.scissorTest = false;
    rt.viewport.set(0, 0, DBW, DBH);
    r.setRenderTarget(rt);
    r.clear();

    // Refresh the sun's shadow map ONCE this frame (autoUpdate is off); the first
    // render() below consumes it and every split-screen cell reuses the same map.
    if (this._key) this._key.shadow.needsUpdate = true;

    const ids = this._order.filter((id) => this.cars.has(id));
    if (ids.length === 0) {
      // lobby / no cars: single overview camera fills the target
      this.overview.aspect = W / H; this.overview.updateProjectionMatrix();
      this.overview.position.lerp(this._ovPos || this.overview.position, 0.05);
      this.overview.lookAt(this._ovTarget || new THREE.Vector3());
      r.render(this.scene, this.overview);
      for (const c of this.cars.values()) { if (c.label) c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; }
      this._present();
      requestAnimationFrame((tt) => this._loop(tt));
      return;
    }

    const { cols, rows } = bestGrid(ids.length, W, H);
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);          // CSS px → DOM labels
    const cwDB = Math.floor(DBW / cols), chDB = Math.floor(DBH / rows);  // target px → cell viewports

    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (!c.pose) return;
      const col = i % cols, row = Math.floor(i / cols);
      const xDB = col * cwDB;
      const yBottomDB = DBH - (row + 1) * chDB;  // three viewport origin = lower-left
      this._updateChase(c, dt);
      c.cam.aspect = cwDB / chDB; c.cam.updateProjectionMatrix();

      // (the rear plate sits on the bumper, not over the track, so it never
      // blocks the chase view — no need to hide your own car's plate)
      // render this cell into its sub-rectangle of the target (re-apply via
      // setRenderTarget so the new viewport/scissor take effect)
      rt.viewport.set(xDB, yBottomDB, cwDB, chDB);
      rt.scissor.set(xDB, yBottomDB, cwDB, chDB);
      rt.scissorTest = true;
      r.setRenderTarget(rt);
      r.render(this.scene, c.cam);

      // position the DOM label at the cell's top-left (CSS px)
      const x = col * cw;
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

    this._present();
    requestAnimationFrame((tt) => this._loop(tt));
  }
}
