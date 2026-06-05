// SceneRenderer — Three.js scene for the race. Per-player CHASE camera in a
// SPLIT-SCREEN viewport (each player sees behind their own car). One shared
// scene; we render it once per player into their screen cell, with per-view
// name/position labels overlaid. Falls back to a single overview camera in the
// lobby (no cars). The game layer calls setCarPose()/setCarHud() each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

// Shared with the controller's car picker + protocol (one source of truth).
// protocol.js (classic script) sets this global before the display modules load.
const CAR_MODELS = window.CAR_MODELS;
const TRACK_GLBS = [
  'track-road-wide-straight', 'track-road-wide-corner-small', 'track-road-wide-corner-large', 'track-road-wide-curve'
];

// Chase camera: sits behind the CAR's heading and looks at it, with the position
// and look-target damped so it lags and swings smoothly behind through turns
// (the standard spring chase-cam every kart racer uses).
// Close chase that sits LOW and just behind the car with a fairly tight lens —
// the tilt-shift blur (below) does the heavy lifting for the miniature read, so
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

// Tilt-shift (fake depth-of-field) — the core miniature cue. We render the scene
// to an offscreen target, make a blurred copy, then composite them: a sharp
// horizontal FOCUS BAND sits on the car, with everything above (far track) and
// below (near foreground) blurred. Because the chase cam frames the car at a
// fixed spot in its cell, the band is a fixed position WITHIN each cell — so it
// lands on every player's car in split-screen. focusV/band/feather are in
// per-cell UV (0 = cell bottom, 1 = cell top).
const TS_FOCUS_V = 0.42;    // band centre within a cell (where the car sits)
const TS_BAND_HALF = 0.13;  // half-height of the fully-sharp band (wider = more in focus)
const TS_FEATHER = 0.28;    // fade distance from sharp → full blur
const TS_BLUR_DIV = 4;      // blur-target resolution divisor (4 = quarter-res: 4× fewer blur pixels; invisible since the region is blurred anyway)
const TS_BLUR_REF = 2;      // blur radius is calibrated to THIS divisor, so changing TS_BLUR_DIV only trades quality↔cost, never the look
const TS_BLUR_SPREAD = 2.0; // Gaussian spread → screen-space blur radius (clear miniature pop)

// Look constants. Colour grading is done in the COMPOSITE shader, not via the
// renderer's tone mapping: Three disables tone mapping (and sRGB output) when a
// pass renders into an offscreen target, which ours does for the blur. So the
// composite applies exposure and the linear→sRGB encode itself.
const DEF_EXPOSURE = 1.1;    // brightness multiplier (1 = stock)
const DEF_CAR_ROUGH = 1.2;   // car roughness multiplier (>1 = more matte than stock; <1 = glossier)
const DEF_KEY_LIGHT = 1.4;   // warm key-light intensity (the plastic "shine")

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

    // No renderer tone mapping: it would be ignored on our offscreen pass anyway
    // (Three only tone-maps when rendering straight to the canvas). The composite
    // shader does exposure + linear→sRGB explicitly instead.
    r.toneMapping = THREE.NoToneMapping;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ecae6);
    scene.fog = new THREE.Fog(0x8ecae6, 70, 170);
    this.scene = scene;

    // Toy lighting: a soft sky/ground hemisphere for even fill, PLUS a warm key
    // light (NO shadow map — castShadow stays off, so we keep the painted blob
    // shadows). The key's specular highlight is the "shiny plastic" dot that sells
    // the injection-moulded-toy read; the hemisphere keeps shadowed sides from
    // going black. We still avoid a cast-shadow pass to stay cheap and flat.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
    const key = new THREE.DirectionalLight(0xfff1d0, DEF_KEY_LIGHT);
    key.position.set(6, 12, 4); // high and slightly to one side → raking gloss
    scene.add(key);
    this._key = key;

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

    this._initPost();

    window.addEventListener('resize', () => this._onResize());
  }

  // Offscreen tilt-shift pipeline. Three passes feed it (see _postProcess):
  //   scene → _rtScene (sharp)  →  blur H/V → _rtBlur (soft)  →  composite to screen.
  // The scene RT is full-res and sRGB-encoded (tone-mapping + colour conversion
  // happen here, exactly as when rendering straight to the canvas); the blur RTs
  // are half-res for a softer, cheaper blur. Custom ShaderMaterials sample these
  // texels raw and write the already-encoded result straight to the canvas, so
  // there's no double colour conversion.
  _initPost() {
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.max(2, db.x), H = Math.max(2, db.y);
    const bw = Math.max(1, Math.floor(W / TS_BLUR_DIV)), bh = Math.max(1, Math.floor(H / TS_BLUR_DIV));
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };

    // The scene pass writes LINEAR colour (Three forces the working space on
    // offscreen targets), untone-mapped. The composite handles grading + encode.
    this._rtScene = new THREE.WebGLRenderTarget(W, H, { ...opts, depthBuffer: true });
    this._rtScene.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._rtBlurA = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
    this._rtBlurB = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
    // Blur buffers hold linear colour too (sampled raw by the shaders); label
    // them so a future Three default-colourspace change can't silently decode.
    this._rtBlurA.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this._rtBlurB.texture.colorSpace = THREE.LinearSRGBColorSpace;

    const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

    // Separable Gaussian — LINEAR-SAMPLED: the same 9-tap kernel reconstructed in
    // 5 fetches by letting hardware bilinear filtering blend each adjacent tap
    // PAIR in one sample at a weighted offset (the blur RTs use LinearFilter, so
    // this is exact). The weights/offsets are the standard collapse of the 9-tap
    // weights {0.2270, 0.1946, 0.1216, 0.0541, 0.0162}. `dir` is the axis + step.
    this._matBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;
        void main(){
          vec2 o1 = dir * 1.3846153846;   // collapsed offset for taps ±1,±2
          vec2 o2 = dir * 3.2307692308;   // collapsed offset for taps ±3,±4
          vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
          c += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
          c += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
          c += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
          c += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }`
    });

    // Composite: pick sharp↔blur by vertical distance from the per-cell focus
    // band, then GRADE: exposure (brightness) → linear→sRGB encode. Inputs are
    // linear (see _rtScene); we own the encode since Three skips it on offscreen
    // passes. toneMapped=false so Three doesn't try to touch our output.
    this._matComposite = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: {
        tSharp: { value: null }, tBlur: { value: null },
        rows: { value: 1 }, focusV: { value: TS_FOCUS_V },
        bandHalf: { value: TS_BAND_HALF }, feather: { value: TS_FEATHER },
        exposure: { value: DEF_EXPOSURE }
      },
      vertexShader: VERT,
      fragmentShader: `
        uniform sampler2D tSharp; uniform sampler2D tBlur;
        uniform float rows, focusV, bandHalf, feather, exposure;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c){
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main(){
          float localV = fract(vUv.y * rows);            // position within this cell
          float d = abs(localV - focusV);
          float f = smoothstep(bandHalf, bandHalf + feather, d);
          vec3 col = mix(texture2D(tSharp, vUv).rgb, texture2D(tBlur, vUv).rgb, f);
          col = toSRGB(col * exposure);                  // brightness, then gamma-encode
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`
    });

    this._fsScene = new THREE.Scene();
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._matComposite);
    this._fsScene.add(this._fsQuad);
    this._dbSize = new THREE.Vector2();
  }

  _resizePost() {
    if (!this._rtScene) return;
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.max(2, db.x), H = Math.max(2, db.y);
    this._rtScene.setSize(W, H);
    this._rtBlurA.setSize(Math.max(1, Math.floor(W / TS_BLUR_DIV)), Math.max(1, Math.floor(H / TS_BLUR_DIV)));
    this._rtBlurB.setSize(Math.max(1, Math.floor(W / TS_BLUR_DIV)), Math.max(1, Math.floor(H / TS_BLUR_DIV)));
  }

  // Blur _rtScene into _rtBlurB, then composite (sharp band + blurred surround)
  // to the canvas. `rows` tells the shader the split-screen row count so the
  // focus band repeats once per cell. Renders straight to the canvas (target null).
  _postProcess(rows) {
    const r = this.renderer;
    // `dir` is a NORMALIZED UV offset (0..1), so it's independent of each blur
    // target's pixel resolution. Dividing the desired screen step by the FULL-res
    // width/height gives the same fraction-of-image for both passes → an equal
    // blur radius in screen pixels, even though the H pass samples full-res
    // _rtScene and the V pass samples quarter-res _rtBlurA. So TS_BLUR_DIV only
    // trades quality↔cost, never the radius.
    const fw = this._rtScene.width, fh = this._rtScene.height;
    const step = TS_BLUR_SPREAD * TS_BLUR_REF;

    // horizontal then vertical Gaussian, at blur-target resolution
    this._fsQuad.material = this._matBlur;
    this._matBlur.uniforms.tDiffuse.value = this._rtScene.texture;
    this._matBlur.uniforms.dir.value.set(step / fw, 0);
    r.setRenderTarget(this._rtBlurA);
    r.render(this._fsScene, this._fsCam);

    this._matBlur.uniforms.tDiffuse.value = this._rtBlurA.texture;
    this._matBlur.uniforms.dir.value.set(0, step / fh);
    r.setRenderTarget(this._rtBlurB);
    r.render(this._fsScene, this._fsCam);

    this._fsQuad.material = this._matComposite;
    const u = this._matComposite.uniforms;
    u.tSharp.value = this._rtScene.texture;
    u.tBlur.value = this._rtBlurB.texture;
    u.rows.value = rows;
    // focusV / bandHalf / feather / exposure are fixed (set once at material
    // creation from the look constants), so there's nothing to update per frame.
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

  async load() {
    const loader = new GLTFLoader();
    const need = [...new Set([...TRACK_GLBS, ...CAR_MODELS])];
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

  addCar(id, colorIndex, name, opts = {}) {
    // Car model is the player's pick (opts.carIndex), independent of the colour
    // livery; fall back to colorIndex when no pick is supplied (e.g. previews).
    const carIndex = (opts.carIndex == null ? colorIndex : opts.carIndex);
    const model = CAR_MODELS[carIndex % CAR_MODELS.length];
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

    this.cars.set(id, {
      group, car, body, bodyBaseQuat, frontWheels, backWheels, marker, shadow, cam,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, steerBar, steerFill, pose: null, init: false, lean: 0
    });
    if (cell && !this._order.includes(id)) this._order.push(id);
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group); // shadow is a child of group, so it goes too
    // Dispose only what addCar created fresh per car (marker + shadow plane).
    // The car mesh shares its geometry/material with the cached prototype, and
    // the shadow TEXTURE is cached per model — leave both for the next race.
    c.marker.geometry.dispose(); c.marker.material.dispose();
    c.shadow.geometry.dispose(); c.shadow.material.dispose();
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
    // _postProcess then blurs it and composites the tilt-shift result to the canvas.
    const rt = this._rtScene;
    const db = r.getDrawingBufferSize(this._dbSize);
    const DBW = db.x, DBH = db.y;
    // clear the WHOLE target first (colour + depth) so empty split-screen cells
    // and rounding strips don't keep last frame's pixels
    rt.scissorTest = false;
    rt.viewport.set(0, 0, DBW, DBH);
    r.setRenderTarget(rt);
    r.clear();

    const ids = this._order.filter((id) => this.cars.has(id));
    if (ids.length === 0) {
      // lobby / no cars: single overview camera fills the target
      this.overview.aspect = W / H; this.overview.updateProjectionMatrix();
      this.overview.position.lerp(this._ovPos || this.overview.position, 0.05);
      this.overview.lookAt(this._ovTarget || new THREE.Vector3());
      r.render(this.scene, this.overview);
      for (const c of this.cars.values()) { if (c.label) c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; }
      this._postProcess(1);
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

      // hide own marker so it doesn't block the chase view
      c.marker.visible = false;
      // render this cell into its sub-rectangle of the target (re-apply via
      // setRenderTarget so the new viewport/scissor take effect)
      rt.viewport.set(xDB, yBottomDB, cwDB, chDB);
      rt.scissor.set(xDB, yBottomDB, cwDB, chDB);
      rt.scissorTest = true;
      r.setRenderTarget(rt);
      r.render(this.scene, c.cam);
      c.marker.visible = true;

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

    this._postProcess(rows);
    requestAnimationFrame((tt) => this._loop(tt));
  }
}
