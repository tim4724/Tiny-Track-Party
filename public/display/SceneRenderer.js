// SceneRenderer — Three.js scene for the race. Per-player CHASE camera in a
// SPLIT-SCREEN viewport (each player sees behind their own car). One shared
// scene; we render it once per player into their screen cell, with per-view
// name/position labels overlaid. Falls back to a single overview camera in the
// lobby (no cars). The game layer calls setCarPose()/setCarHud() each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

// English ordinal for a finishing place: 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th".
function ordinal(n) {
  const t = n % 100, u = n % 10;
  const suffix = (t >= 11 && t <= 13) ? 'th' : (u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
  return `${n}${suffix}`;
}

// Reverse a BufferGeometry's triangle winding in place. Used when baking MIRRORED
// track tiles: a mirror placement has a negative-determinant matrix, so applyMatrix4
// flips the winding while leaving the (correct, +Y) road-top normal alone. Under the
// merged DoubleSide material that turns the up-facing road top into a BACK face, so
// the shader flips its normal DOWN and lights it from underneath — the tile renders
// much darker than its non-mirrored twin. Flipping the winding back makes it a front
// face again, consistent with the rest of the merged mesh.
function flipWinding(geo) {
  const idx = geo.index;
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
    return;
  }
  for (const attr of Object.values(geo.attributes)) {
    const arr = attr.array, n = attr.itemSize;
    for (let i = 0; i + 3 * n <= arr.length; i += 3 * n) {
      for (let k = 0; k < n; k++) { const t = arr[i + k]; arr[i + k] = arr[i + 2 * n + k]; arr[i + 2 * n + k] = t; }
    }
    attr.needsUpdate = true;
  }
}

// Shared with the controller's car picker + protocol (one source of truth).
// protocol.js (classic script) sets this global before the display modules load.
const CAR_MODELS = window.CAR_MODELS;
const CAR_MODEL_YAW = window.CAR_MODEL_YAW || []; // per-model facing fix (see protocol.js)

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
// Lobby attract-mode: when no cars are on track (the lobby), slowly orbit the
// overview camera around the selected track so it reads as a live 3D preview.
const LOBBY_ORBIT_SPEED = 0.1; // rad/s (~63 s per turn) — calm, never dizzying
// Tyre-contact cues that ground the car ON the road (vs hovering over it):
//   • Skidmarks — dark tyre tracks laid under the rear wheels while cornering /
//     curb-scrubbing, fading out over SKID_LIFE. Each stamp bridges the wheel's
//     last contact point to its current one (end-to-end, no overlap), so it
//     forms one continuous ribbon along the exact wheel path at ANY speed (the
//     engine reports speed normalised, so we measure real travel, not a guess).
//   • Contact shadow — a soft dark blob that rides flat on the road directly
//     under each car, filling the gap the (offset) sun shadow leaves so the car
//     reads planted rather than floating above its own shadow.
const SKID_COLOR = 0x241f1c;       // near-black warm scuff
const SKID_MAX_OPACITY = 0.28;     // opacity of a fresh mark at full slip (hard scrub)
const SKID_THRESH = 0.2;           // |steer| at which tyres start to scuff (below this: no mark)
const SKID_LIFE = 1.2;             // seconds to fully fade
const SKID_WIDTH = 0.12;           // fallback tyre-contact width; per-car width is measured in addCar
const SKID_SEG_MIN = 0.04;         // min wheel travel before laying the next stamp
const SKID_SEG_MAX = 1.5;          // gap bigger than this = a respawn/teleport → don't bridge it
const CONTACT_OPACITY = 0.36;      // peak darkness of the under-car contact blob

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
// Ride-height smoothing rate (1/s) for the damped offset from the centreline (see
// setCarPose). Applied as 1 - exp(-RIDE_DAMP·dt) so it's frame-rate-independent;
// ~18 reproduces the old per-frame 0.25 lerp at 60fps but stays stable at 30fps.
const RIDE_DAMP = 18;

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

// Skid streak alpha: SOFT across its width, SOLID along its length. Each stamp
// bridges the wheel's last contact to its current one and they're laid end-to-
// end (abutting, no overlap), so a solid length tiles into one continuous tyre
// track with no scalloping — a round blob or feathered ends would dip to zero at
// every join and read as a dotted line; overlap would stack alpha into dark bands.
function makeSkidTexture() {
  const w = 16, h = 8;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  // width profile only: feather the left/right edges so the track has soft sides
  const gx = ctx.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, 'rgba(255,255,255,0)');
  gx.addColorStop(0.5, 'rgba(255,255,255,1)');
  gx.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A single soft round alpha blob (white core feathering to transparent). Drawn
// white so the material colour tint shows true; used for the under-car contact
// shadow (scaled to the footprint).
function makeSoftBlobTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
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
// with the name in white, auto-shrunk to fit. Returns { tex, aspect, contentFrac }.
//
// The plate sits in a TRANSPARENT MARGIN (M) inside the canvas, so its outer edge
// is a soft alpha edge (smoothed for free by the texture's mipmaps + anisotropy),
// NOT the quad's hard polygon silhouette. That silhouette is what aliased and
// crawled as the car tilted — the reason scene-wide MSAA was needed. With the
// margin the plate self-antialiases, so it stays crisp regardless of MSAA.
// contentFrac = the visible plate's fraction of the canvas, so makePlate can size
// the mesh to keep the plate the same on-screen size despite the added margin.
function makePlateTexture(name, colorHex) {
  const text = (name == null ? '' : String(name)).trim() || '—';
  const S = 4;                 // supersample → crisp even though the plate is small on screen
  const W = 232, H = 92;       // logical plate size (~2.5 : 1)
  const M = 7;                 // transparent margin around the plate (logical px) → soft edge
  const CW = W + 2 * M, CH = H + 2 * M; // full canvas incl. margin
  const cv = document.createElement('canvas');
  cv.width = CW * S; cv.height = CH * S;
  const ctx = cv.getContext('2d');
  ctx.scale(S, S);
  ctx.translate(M, M);         // draw the plate inset, leaving the transparent margin

  // white rim, then livery field inset, then a darker inner hairline.
  // FEATHER the outer rim: a small blur turns its axis-aligned edges (which canvas
  // fill leaves as a hard alpha step) into a soft gradient, so the border self-AAs
  // and never crawls — even with scene MSAA off. The filter is in device pixels
  // (unaffected by ctx.scale), so scale the radius by S. Interior is drawn crisp.
  const pad = 6, r = 16;
  ctx.filter = `blur(${(S * 1.1).toFixed(2)}px)`;
  ctx.beginPath(); ctx.roundRect(0, 0, W, H, r); ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.filter = 'none';
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
  return { tex, aspect: CW / CH, contentFrac: W / CW };
}

// Build the plate mesh for one car. `anchor` = { z (rear face), y, w (car width) }
// in the car group's local space, derived from the model's bounding box.
function makePlate(name, colorHex, anchor) {
  const pt = makePlateTexture(name, colorHex);
  // Size to the VISIBLE plate (cap to the car's rear), then expand the quad to
  // include the transparent margin so the plate's on-screen size is unchanged.
  const visW = Math.min(PLATE_MAX_W, anchor.w * 0.92); // never wider than the car's rear
  const planeW = visW / pt.contentFrac;
  const planeH = planeW / pt.aspect;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
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
    // Lobby orbit (set true by the display in the lobby). Start at the same iso
    // bearing the static overview used so the first frame matches.
    this.orbit = false;
    this._orbitAngle = Math.atan2(0.9, 0.35);
    // Dynamic resolution must be configured BEFORE _initThree (it sizes the offscreen
    // target from _renderScale). The scene renders into a target we shrink when frames
    // can't hold 60; the present pass upscales it to the canvas — trading sharpness for
    // framerate only on GPUs that need it. The learned scale persists across sessions
    // (localStorage) so a weak machine starts at the right resolution instead of
    // re-dipping every race; each fresh load probes one step back UP to reclaim
    // sharpness if the hardware/window improved. ?renderscale=N pins it; ?noscale off.
    this._renderScaleFloor = 0.6; // never below 60% linear res (~36% of the pixels)
    this._dtEma = null;           // smoothed real frame time (ms), drives adaptation
    this._adaptCooldown = 0;      // frames to wait before the next scale change
    {
      const q = new URLSearchParams(location.search);
      // Offscreen MSAA sample count (?msaa=0|2|4). MSAA was the single biggest GPU
      // cost (≈5.4ms/frame at 4× on a 12MP buffer, vs 1.1ms with none — measured via
      // GPU timer query). The plate — the one thin feature that needed it — now self-
      // antialiases via its soft feathered edge, so we default MSAA OFF; the chunky
      // toy geometry tolerates it. Override with ?msaa=2 / ?msaa=4 if wanted.
      const msaa = parseInt(q.get('msaa'), 10);
      this._msaaSamples = Number.isFinite(msaa) ? Math.max(0, Math.min(4, msaa)) : 0;
      const fixed = parseFloat(q.get('renderscale'));
      this._dynRes = !q.has('noscale') && !Number.isFinite(fixed);
      if (Number.isFinite(fixed)) {
        this._renderScale = Math.min(1, Math.max(0.4, fixed));
      } else {
        const saved = parseFloat(this._loadScale());
        // probe one step above the saved scale each load; shrink-only adaptation
        // settles it back down if that's too high (so it converges, never hunts).
        this._renderScale = Number.isFinite(saved) ? Math.min(1, Math.max(this._renderScaleFloor, saved + 0.1)) : 1;
      }
    }
    this._initThree();
    this._initOverlay();
    this._initParticles();
    this._initFpsMeter();
    this._groundRay = new THREE.Raycaster();
    this._groundRay.far = 14; // cast 6 above refY, reach ~8 below — never escapes the track
    this._rayFrom = new THREE.Vector3();
    this._rayDown = new THREE.Vector3(0, -1, 0);
    this._headFlat = new THREE.Vector3();  // car heading flattened to horizontal (probe placement)
    this._frameDt = 1 / 60;                 // last frame dt (set in _loop; setCarPose reads it)
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._normalMat = new THREE.Matrix3(); // for road-tile world normals
    this._hitNormal = new THREE.Vector3();
    // Spatial bucket for the ground-conform raycast: a grid (x,z) -> tiles
    // overlapping that cell, built in setTrack. _roadHitY then casts only against
    // the 1-few tiles under the car instead of walking every tile in the track —
    // the per-cast cost was growing with track length (setCarPose's hot path).
    this._collideGrid = null;
    this._collideCell = 6; // world units per cell (~tile-sized; tracks use SCALE=2)
    // Scratch objects reused every frame so the per-car hot paths (setCarPose,
    // _updateChase) allocate NOTHING — steady-state garbage was forcing GC pauses
    // that showed up as frame-time spikes (the stutter under load).
    this._sx = new THREE.Vector3();
    this._syy = new THREE.Vector3();
    this._sBasis = new THREE.Matrix4();
    this._sWant = new THREE.Vector3();
    this._sTarget = new THREE.Vector3();
  }

  // Pack a signed cell coord into one integer key (avoids per-lookup string alloc
  // in the raycast hot path). Tracks are tiny, so |g| never approaches 32768.
  _cellKey(gx, gz) { return (gx + 32768) * 65536 + (gz + 32768); }

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
    // Only the tiles whose footprint covers (x,z) can be under a straight-down
    // ray there — look them up in the spatial bucket. A vertical ray at (x,z)
    // can't hit geometry outside that geometry's x/z AABB, and every tile is
    // registered in all cells its AABB spans, so this single cell holds the
    // complete candidate set (both decks where an overpass stacks two strands).
    const cands = this._collideGrid && this._collideGrid.get(this._cellKey(Math.floor(x / this._collideCell), Math.floor(z / this._collideCell)));
    if (!cands) return null; // off-track (gap/edge): caller falls back to centreline
    this._rayFrom.set(x, refY + 6, z);
    this._groundRay.set(this._rayFrom, this._rayDown);
    const hits = this._groundRay.intersectObjects(cands, true);
    let best = null, bestErr = Infinity;
    for (const h of hits) {
      if (h.face) {
        this._normalMat.getNormalMatrix(h.object.matrixWorld);
        // Keep only NEAR-HORIZONTAL surfaces (|normal.y| > 0.1, i.e. the face leans
        // no more than ~84° off horizontal); skip vertical walls. Using |normal.y|
        // (not normal.y > 0.1) means MIRRORED tiles — reflected across X, which flips
        // their winding so the road top face's normal points DOWN — still register;
        // the nearest-to-refY pick below still selects the true road top (Y is
        // unaffected by an X-reflection). Deliberately loose so sloped road tiles
        // (hills/ramps) still count — the tracks have no banking, so nothing
        // near-vertical is drivable. Tighten if a banked turn or loop is added.
        const ny = this._hitNormal.copy(h.face.normal).applyNormalMatrix(this._normalMat).y;
        if (Math.abs(ny) <= 0.1) continue;
      }
      const err = Math.abs(h.point.y - refY);
      if (err < bestErr) { bestErr = err; best = h.point.y; }
    }
    return best;
  }

  // Pooled skidmark decals — flat quads laid on the road that fade out. Shared
  // across all cars (the marks stay where they were laid; they don't move with
  // the car), so a ring buffer recycles the oldest when busy.
  _initParticles() {
    this._skidTex = makeSkidTexture();
    this._softTex = makeSoftBlobTexture(); // round blob for the contact shadow
    this._skids = [];
    this._skidN = 0;
    // scratch vectors for orientation maths + the per-wheel travel measurement,
    // so the hot path allocates nothing per frame.
    this._skU = new THREE.Vector3();
    this._skF = new THREE.Vector3();
    this._skL = new THREE.Vector3();
    this._skMat = new THREE.Matrix4();
    this._gpA = new THREE.Vector3();
    this._projV = new THREE.Vector3(); // scratch for the contact-patch projection
    this._segV = new THREE.Vector3();
    this._dirV = new THREE.Vector3();
    this._midV = new THREE.Vector3();
    // Pool sized for the worst case — all 4 cars cornering at 60 fps, one stamp per
    // rear wheel per frame held for SKID_LIFE: 60 × 1.2 × 2 × 4 ≈ 580. 640 gives a
    // little headroom; curb scrub (4 wheels) can still exceed it, and the ring
    // buffer then recycles the oldest (most-faded) marks, which is invisible.
    for (let i = 0; i < 640; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this._skidTex, color: SKID_COLOR, transparent: true,
          depthWrite: false, opacity: 0,
          // pull the decal toward the camera in depth so it never z-fights the road
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        })
      );
      m.visible = false;
      m.userData.life = 0;
      this.scene.add(m);
      this._skids.push(m);
    }
  }

  // Lay one skid stamp centred at world `mid`, lying in the road plane
  // (normal = up) with its length along `dir` (a unit travel direction).
  // `width` is the car's tyre-contact width; `strength` (0..1) scales peak
  // opacity; `length` spans the wheel's last→now travel so consecutive stamps
  // butt together into one seamless ribbon.
  _emitSkidSeg(mid, up, dir, length, width, strength) {
    const m = this._skids[this._skidN];
    this._skidN = (this._skidN + 1) % this._skids.length;
    // basis: geometry X → lateral, Y → travel-in-plane, Z(normal) → road up
    this._skU.copy(up).normalize();
    this._skF.copy(dir).addScaledVector(this._skU, -dir.dot(this._skU));
    if (this._skF.lengthSq() < 1e-9) return;             // travel parallel to up (shouldn't happen)
    this._skF.normalize();
    this._skL.copy(this._skF).cross(this._skU);          // L = F × U  (right-handed)
    this._skMat.makeBasis(this._skL, this._skF, this._skU);
    m.quaternion.setFromRotationMatrix(this._skMat);
    m.position.copy(mid).addScaledVector(this._skU, 0.006); // a hair above the road
    m.scale.set(width, length, 1);
    m.visible = true;
    m.userData.life = SKID_LIFE;
    m.userData.peak = SKID_MAX_OPACITY * strength;
    m.material.opacity = m.userData.peak;
  }

  _stepSkids(dt) {
    for (const m of this._skids) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      if (m.userData.life <= 0) { m.visible = false; m.material.opacity = 0; continue; }
      m.material.opacity = m.userData.peak * (m.userData.life / SKID_LIFE); // linear autofade
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
    // The grass does NOT receive shadows. Cars only ever drive on road tiles (which
    // do receive), so on-track shadows are unaffected — but an ELEVATED car on an
    // overpass would otherwise cast a detached blob onto the grass far below the
    // narrow deck (the light is raked, so the shadow lands off the deck edge). With
    // the grass opted out, that car's shadow stays on the deck under it; only the
    // part that would spill past the deck onto grass is clipped (invisible anyway).
    ground.receiveShadow = false;
    scene.add(ground);
    this.ground = ground;

    // Visible track = a few MERGED meshes (see setTrack): the static tiles are
    // baked into one geometry per texture so the whole circuit draws in ~1-3 calls
    // instead of one per tile (draw-call count was scaling with track length).
    this.trackGroup = new THREE.Group();
    scene.add(this.trackGroup);
    // Collision proxy: the per-tile clones, kept OUT of the scene graph (so they
    // cost nothing to render/cull) but raycast by _roadHitY for ground-conform.
    // Per-tile bounding spheres prune the cast to the 1-2 tiles under the car —
    // pruning the merged mesh can't give (it's one sphere over the whole track).
    this.trackCollide = new THREE.Group();
    this._mergedGeoms = []; // merged BufferGeometries to dispose on track change
    this._mergedMats = [];  // merged materials to dispose on track change

    this.overview = new THREE.PerspectiveCamera(50, this._aspect(), 0.1, 600);
    this.overview.position.set(25, 22, 25);
    this._ovPos = this.overview.position.clone();
    this._ovTarget = new THREE.Vector3();
    // Overview-orbit framing (radius/height), computed per-track in setTrack and
    // ridden by the lobby/gallery turntable (see `this.orbit` + the render loop).
    this._ovRadius = null;
    this._ovHeight = 0;

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
  // Persist the learned render scale across sessions (best-effort; private mode or a
  // blocked storage just disables persistence). Keyed so it's per-origin.
  _loadScale() { try { return localStorage.getItem('tt.renderScale'); } catch (e) { return null; } }
  _saveScale(s) { try { localStorage.setItem('tt.renderScale', String(s)); } catch (e) { /* ignore */ } }

  // RT pixel dims = canvas drawing buffer × the current render scale (dynamic res).
  _rtDims() {
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const s = this._renderScale || 1;
    return { w: Math.max(2, Math.round(db.x * s)), h: Math.max(2, Math.round(db.y * s)) };
  }

  _initPost() {
    const { w: W, h: H } = this._rtDims();
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };

    this._rtScene = new THREE.WebGLRenderTarget(W, H, { ...opts, depthBuffer: true, samples: this._msaaSamples });
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
    const { w, h } = this._rtDims();
    this._rtScene.setSize(w, h);
  }

  // Adapt the render scale from the smoothed REAL frame time (rAF delta) — that's
  // what reflects GPU fill, which is async and invisible to CPU-submit timing. The
  // scene's fill (5K × split-screen × MSAA) is the dominant cost on weak GPUs.
  //
  // SHRINK-ONLY: when frames slip off 60 (ema climbs past the budget) we shed
  // resolution to claw the framerate back, and stay there. We deliberately do NOT
  // auto-grow — reclaiming res risks dropping below 60 again, then shrinking, then
  // growing… a hunt that shows up as a periodic stutter, which is exactly what a
  // hard "60fps minimum" goal can't tolerate. The scale resets to full each race
  // (setTrack), so a new race re-probes from sharp. A SLOW EMA (0.95) means a lone
  // GC/alt-tab spike won't trigger a shrink — only sustained slowness does. Skipped
  // while the tab is hidden (rAF throttles there and would misfire). ?renderscale
  // pins a fixed scale; ?noscale disables this entirely.
  _adaptScale(dtMs) {
    if (!this._dynRes) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this._dtEma = this._dtEma == null ? dtMs : this._dtEma * 0.95 + dtMs * 0.05;
    // Warmup grace: the first seconds of a race hitch on GLB/texture uploads and JIT
    // warmup — transient, not the steady-state load. Warm the EMA but don't shrink
    // yet, or a capable machine gets permanently downscaled by one-time load spikes.
    this._adaptAge = (this._adaptAge || 0) + dtMs;
    if (this._adaptAge < 2500) return;
    if (this._adaptCooldown > 0) { this._adaptCooldown--; return; }
    if (this._dtEma > 18 && this._renderScale > this._renderScaleFloor) { // sustained < ~55fps
      this._renderScale = Math.max(this._renderScaleFloor, this._renderScale - 0.1);
      this._resizePost();
      this._saveScale(this._renderScale); // remember for next race/session
      this._adaptCooldown = 90; // ~1.5s for the new scale to settle before reassessing
    }
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

  // Bottom-right FPS/frame-time readout (debug aid). Shows smoothed FPS, the mean
  // frame time, and the WORST frame time in each ~250ms window (the worst is what
  // you feel — vsync bounces a single 17ms frame to 33ms). Reads the REAL rAF
  // cadence (the loop's raw delta, before the sim's dt clamp). Toggle with the "P"
  // key; shown by default (it's a debug build aid).
  _initFpsMeter() {
    const el = document.createElement('div');
    el.className = 'fps-meter';
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;'
      + 'font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
      + 'color:#7CFC8A;background:rgba(0,0,0,0.55);padding:4px 8px;border-radius:7px;'
      + 'pointer-events:none;white-space:pre;text-align:right;letter-spacing:.3px;';
    el.textContent = '— fps';
    (this.container || document.body).appendChild(el);
    this._fpsEl = el;
    this._fpsFrames = 0;      // frames since last text update
    this._fpsAccumMs = 0;     // summed real frame time since last update
    this._fpsWorstMs = 0;     // worst frame in this window
    this._fpsLastUpdate = 0;  // timestamp of last text update
    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P') el.style.display = (el.style.display === 'none') ? '' : 'none';
    });
  }

  // Fold one real frame (rawMs = unclamped rAF delta) into the meter and refresh
  // the text every ~250ms. Colour goes amber/red as the worst frame degrades.
  _tickFpsMeter(t, rawMs) {
    this._fpsFrames++;
    this._fpsAccumMs += rawMs;
    if (rawMs > this._fpsWorstMs) this._fpsWorstMs = rawMs;
    if (t - this._fpsLastUpdate < 250) return;
    const mean = this._fpsAccumMs / this._fpsFrames;
    const fps = 1000 / mean;
    const worst = this._fpsWorstMs;
    const el = this._fpsEl;
    if (el) {
      // Show the render scale only when dynamic-res has pulled it below full.
      const scaleTag = this._renderScale < 0.999 ? `\n${Math.round(this._renderScale * 100)}% res` : '';
      el.textContent = `${fps.toFixed(0)} fps\n${mean.toFixed(1)} ms (⤒${worst.toFixed(0)})${scaleTag}`;
      el.style.color = worst > 32 ? '#FF6B6B' : worst > 20 ? '#FFD166' : '#7CFC8A';
    }
    this._fpsFrames = 0; this._fpsAccumMs = 0; this._fpsWorstMs = 0; this._fpsLastUpdate = t;
  }

  _aspect() { return window.innerWidth / Math.max(1, window.innerHeight); }
  _onResize() { this.renderer.setSize(window.innerWidth, window.innerHeight); this._resizePost(); }

  // Preload the GLBs this scene needs: the car models plus `trackGlbs`, the exact
  // set of track tiles the chosen layout uses. The caller derives that set from
  // track.instances (see main.js), so adding a new piece needs no change here.
  async load(trackGlbs) {
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

  // Free the previous track's MERGED geometries/materials (each setTrack makes
  // fresh ones). The collision clones share the cached proto geometry, so there's
  // nothing per-tile to dispose — just drop the group for GC. Merged materials
  // keep the shared colormap (owned by the proto), so don't dispose textures.
  _disposeTrack() {
    for (const g of this._mergedGeoms) g.dispose();
    for (const m of this._mergedMats) m.dispose();
    this._mergedGeoms = [];
    this._mergedMats = [];
  }

  setTrack(track, { debug = false } = {}) {
    this._disposeTrack();
    this.trackGroup.clear();
    if (track.groundY != null) this.ground.position.y = track.groundY;

    // Build the track in two parallel forms:
    //   • collision proxy — one clone per tile (geometry shared with the proto,
    //     matrix baked), kept OUT of the scene so it's free to render but still
    //     raycast by _roadHitY with per-tile bounding-sphere pruning intact.
    //   • visible render — every tile's geometry baked into WORLD space and merged
    //     by source texture, so the whole circuit draws in one call per texture
    //     (~1-3) instead of one per tile. Draw-call count no longer grows with
    //     track length (the cause of the slowdown on longer layouts).
    const collide = new THREE.Group();
    const buckets = new Map(); // texture.uuid -> { srcMat, geoms: [] }
    const KEEP = ['position', 'normal', 'uv']; // attributes merged tiles must share
    for (const inst of track.instances) {
      const proto = this.protos.get(inst.glb);
      if (!proto) continue;

      // collision clone (shares proto geometry; lives off-scene)
      const cnode = proto.clone(true);
      cnode.matrixAutoUpdate = false;
      cnode.matrix.copy(inst.matrix);
      collide.add(cnode);

      // render: bake each mesh's geometry to world space and bucket by texture.
      // Each GLB bundles its own copy of the shared "colormap", so a bucket holds
      // one tile type — same attributes/indexing, so the merge always succeeds.
      // Mirrored tiles (negative-determinant matrix) bake in with reversed winding;
      // flipWinding (below) puts it back so they shade like their non-mirrored twins
      // instead of dark, and the merged material stays DoubleSide as a safety net.
      const wnode = proto.clone(true);
      wnode.matrix.copy(inst.matrix);
      wnode.matrixAutoUpdate = false;
      wnode.updateMatrixWorld(true);
      wnode.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const srcMat = Array.isArray(o.material) ? o.material[0] : o.material;
        const key = srcMat && srcMat.map ? srcMat.map.uuid : 'nomap';
        let b = buckets.get(key);
        if (!b) { b = { srcMat, geoms: [] }; buckets.set(key, b); }
        const g = o.geometry.clone();
        for (const name of Object.keys(g.attributes)) {
          if (!KEEP.includes(name)) g.deleteAttribute(name);
        }
        if (!g.attributes.normal) g.computeVertexNormals();
        g.applyMatrix4(o.matrixWorld);
        // Mirrored tile (negative-determinant placement): applyMatrix4 reversed the
        // winding but kept the road-top normal pointing up, so without this it would
        // bake in as a back face and shade dark under the DoubleSide merge. Flip it
        // back so the whole merged mesh winds consistently (see flipWinding).
        if (o.matrixWorld.determinant() < 0) flipWinding(g);
        b.geoms.push(g);
      });
    }
    collide.updateMatrixWorld(true); // static — compute world matrices once for the raycast
    this.trackCollide = collide;

    // Index each tile into a coarse (x,z) grid so _roadHitY tests only the tiles
    // under the car, not all of them. Register a tile in every cell its world
    // AABB spans, so a single-cell lookup returns every tile a vertical ray there
    // could hit. Built once per track (cheap); queried 3×/car/frame.
    const grid = new Map();
    const tbox = new THREE.Box3();
    const CELL = this._collideCell;
    for (const cnode of collide.children) {
      tbox.setFromObject(cnode);
      if (tbox.isEmpty()) continue;
      const gx0 = Math.floor(tbox.min.x / CELL), gx1 = Math.floor(tbox.max.x / CELL);
      const gz0 = Math.floor(tbox.min.z / CELL), gz1 = Math.floor(tbox.max.z / CELL);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const key = this._cellKey(gx, gz);
          let list = grid.get(key);
          if (!list) grid.set(key, list = []);
          list.push(cnode);
        }
      }
    }
    this._collideGrid = grid;

    for (const { srcMat, geoms } of buckets.values()) {
      const mat = srcMat.clone();          // shares the proto's colormap texture
      mat.side = THREE.DoubleSide;          // keep mirrored-tile faces drawn + lit
      this._mergedMats.push(mat);
      const addMesh = (geo) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false;      // geometry is baked in world space
        mesh.receiveShadow = true;          // road catches the cars' cast shadows
        this.trackGroup.add(mesh);
        this._mergedGeoms.push(geo);
      };
      const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
      if (merged) {
        if (geoms.length > 1) for (const g of geoms) g.dispose(); // copied into `merged`
        addMesh(merged);
      } else {
        // Merge failed (mismatched attributes) — never leave road missing; fall
        // back to one mesh per tile geometry (still one shared material/texture).
        for (const g of geoms) addMesh(g);
      }
    }

    if (debug) {
      // Magenta centreline overlay (inspection aid). Lift each point a little along
      // its up vector and disable depth-test so the line is NEVER buried under the
      // road: on ramps the centreline can sit a few cm BELOW the GLB road surface,
      // which otherwise hides the line on the bend. renderOrder draws it last.
      const pts = track.centerline.samples.map((s) => s.pos.clone().addScaledVector(s.up, 0.12));
      pts.push(pts[0].clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xff00ff, depthTest: false }));
      line.renderOrder = 10;
      this.trackGroup.add(line);
    }
    // overview framing
    const box = new THREE.Box3();
    for (const s of track.centerline.samples) box.expandByPoint(s.pos);
    this._trackCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.5 + 8;
    const dist = radius / Math.tan((this.overview.fov * Math.PI / 180) / 2) * 0.9;
    const ovDir = new THREE.Vector3(0.35, 0.8, 0.9).normalize();
    this._ovPos = this._trackCenter.clone().add(ovDir.clone().multiplyScalar(dist));
    this._ovTarget = this._trackCenter.clone();
    // Horizontal radius + height of that iso offset, reused by the lobby/gallery
    // orbit so the moving camera keeps the same framing as the static overview.
    const ovOff = this._ovPos.clone().sub(this._trackCenter);
    this._ovRadius = Math.hypot(ovOff.x, ovOff.z);
    this._ovHeight = ovOff.y;

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

  // Slowly orbit the overview camera around the whole track — used by the track
  // gallery to inspect a layout. Drives the same turntable as the lobby preview
  // (`this.orbit`). Only takes effect while the overview is the active camera (no
  // split-screen cars on screen); normal play leaves it off.
  setOverviewOrbit(on) {
    this.orbit = !!on;
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

    // Soft CONTACT SHADOW: a dark blob that rides flat on the road directly under
    // the car. The sun also casts a real shadow, but a single directional light
    // throws it off to one side — leaving a bright gap under the chassis that
    // reads as "hovering". This blob fills that gap so the car looks planted.
    // Parented to the GROUP (not the leaning body) so it stays flush with the
    // road — it inherits the road pitch/heading but never the steering lean.
    group.updateWorldMatrix(true, true);
    const fb = new THREE.Box3().setFromObject(car);
    const footW = fb.max.x - fb.min.x, footL = fb.max.z - fb.min.z;
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this._softTex, color: 0x000000, transparent: true, depthWrite: false,
        opacity: CONTACT_OPACITY,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
      })
    );
    contact.rotation.x = -Math.PI / 2;               // lie in the group's road plane
    contact.scale.set(footW * 1.55, footL * 1.3, 1); // a touch larger than the footprint
    contact.position.y = -RIDE_HEIGHT + 0.006;       // hug the road just under the wheels
    contact.renderOrder = -1;                         // under the dust/skid decals
    group.add(contact);

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    // AI/CPU cars (opts.cell === false) race in the shared world — so they show up
    // in every human's chase view — but get NO split-screen cell of their own. A
    // solo human then sees one viewport, not their own cell plus three bot cameras.
    // Cell-less cars skip the DOM overlay (label + steer bar) and the cell order.
    const cell = opts.cell !== false;
    const colHexUi = this.colors[colorIndex % this.colors.length] || '#fff';
    let label = null, steerBar = null, steerFill = null, finishEl = null;
    if (cell) {
      label = document.createElement('div');
      label.className = 'cell-label';
      label.innerHTML = `<span class="cell-label__name"></span><span class="cell-label__stat"></span>`;
      label.querySelector('.cell-label__name').textContent = name || ('P' + id);
      label.style.setProperty('--c', colHexUi);
      this.overlay.appendChild(label);

      // on-screen steer indicator for this player's cell (mirrors the phone bar)
      steerBar = document.createElement('div');
      steerBar.className = 'cell-steer';
      steerBar.style.setProperty('--c', colHexUi);
      steerBar.innerHTML = `<div class="cell-steer__fill"></div>`;
      this.overlay.appendChild(steerBar);
      steerFill = steerBar.querySelector('.cell-steer__fill');

      // "FINISHED / place / time" overlay — shown centred in this player's cell
      // the instant they cross the line while the rest of the field is still
      // racing. Populated by setCarHud, shown/positioned by _loop. Replaces the
      // steer bar (they're on a victory lap now, not steering).
      finishEl = document.createElement('div');
      finishEl.className = 'cell-finish';
      finishEl.style.setProperty('--c', colHexUi);
      finishEl.innerHTML =
        `<div class="cell-finish__badge">FINISHED</div>` +
        `<div class="cell-finish__place"></div>` +
        `<div class="cell-finish__time"></div>`;
      this.overlay.appendChild(finishEl);
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

    // Tyre-contact width for the skidmarks — measured from a rear wheel so the
    // track matches the model's tyre (the monster truck's fat tyres mark wider
    // than the racer's). The wheel is a thin disc: its smallest horizontal extent
    // is the tread width (the larger horizontal + the vertical are the diameter).
    let skidWidth = SKID_WIDTH;
    if (backWheels.length) {
      const wb = new THREE.Box3().setFromObject(backWheels[0]).getSize(new THREE.Vector3());
      skidWidth = Math.min(0.24, Math.max(0.06, Math.min(wb.x, wb.z)));
    }

    const c = {
      group, car, body, bodyBaseQuat, frontWheels, backWheels, allWheels: [...backWheels, ...frontWheels],
      wheelbase, skidWidth, plate, contact, cam,
      carIndex, anchorZ: anchor.z, plateY: anchor.y,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, steerBar, steerFill, finishEl, finished: false, pose: null, init: false, lean: 0,
      rideOff: null // damped ride-height offset from the centreline (setCarPose)
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
    // Dispose what addCar created fresh per car (the name plate + contact-shadow
    // blob). The car mesh shares its geometry/material with the cached prototype —
    // leave it for the next race. The contact blob shares the pooled soft texture,
    // so dispose its geometry/material but NOT the map.
    c.plate.geometry.dispose(); c.plate.material.map.dispose(); c.plate.material.dispose();
    if (c.contact) { c.contact.geometry.dispose(); c.contact.material.dispose(); }
    if (c.label && c.label.parentNode) c.label.parentNode.removeChild(c.label);
    if (c.steerBar && c.steerBar.parentNode) c.steerBar.parentNode.removeChild(c.steerBar);
    if (c.finishEl && c.finishEl.parentNode) c.finishEl.parentNode.removeChild(c.finishEl);
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
  }

  setCarPose(id, pos, forward, up, steer = 0, spd = 0, scrub = false, steerInput = steer) {
    const c = this.cars.get(id);
    if (!c) return;
    c.spd = spd; c.scrub = scrub; c.steerAmt = steer;
    // Persistent pose vectors (created once per car) reused every frame — no GC.
    // Safe because c.pose is only read within the same frame it's written.
    if (!c.pose) c.pose = { pos: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3() };
    const fwd = c.pose.forward.copy(forward).normalize();
    const u = c.pose.up.copy(up).normalize();
    c.pose.pos.copy(pos);
    c.group.position.copy(pos);

    // Ground-conform. PITCH comes from the centreline forward (`fwd`): the centreline
    // is built once and filtered, so fwd.y is a SMOOTH road slope (the smootherstep
    // climb on a ramp). HEIGHT comes from raycasting the rendered road under the axles
    // so the wheels sit on the actual GLB. We split the two deliberately — re-pitching
    // from the front/rear probe slope twitched the car at ramp seams (that probe is
    // noisy: the GLB floor isn't a perfect smootherstep and tiles overlap). Heading
    // (yaw) is the centreline's; roll stays level (world up) — the tracks have no banking.
    let z = fwd;
    const yC = this._roadHitY(pos.x, pos.z, pos.y); // road directly under the car centre
    this._headFlat.copy(fwd).setY(0);
    if (this._headFlat.lengthSq() > 1e-6) {
      this._headFlat.normalize();
      const half = c.wheelbase * 0.5;
      const yF = this._roadHitY(pos.x + this._headFlat.x * half, pos.z + this._headFlat.z * half, pos.y);
      const yB = this._roadHitY(pos.x - this._headFlat.x * half, pos.z - this._headFlat.z * half, pos.y);
      // Ride on the HIGHEST road point under the footprint (front/centre/rear), not
      // the chord mean: on flat/gentle ground these agree (still planted), but at a
      // sharp crest it rides the peak so the road never pokes up through the belly.
      let roadY = null;
      if (yF != null && yB != null) roadY = (yC != null ? Math.max(yF, yB, yC) : Math.max(yF, yB));
      else if (yC != null) roadY = yC; // off the edge / gate seam: centre probe only
      if (roadY != null) {
        // Snap to the road, but DAMP the OFFSET from the (smooth) centreline rather
        // than the absolute height. The max() above jumps abruptly where ramp tiles
        // overlap — a ~0.15-unit vertical POP at the ramp seams. Damping the small
        // offset smooths those pops; the climb itself lives in the centreline height
        // (pos.y), so it stays lag-free and the wheels keep tracking the road.
        const offTarget = roadY - pos.y;
        const a = 1 - Math.exp(-RIDE_DAMP * this._frameDt); // frame-rate-independent smoothing
        c.rideOff = (c.rideOff == null) ? offTarget : c.rideOff + (offTarget - c.rideOff) * a;
        c.group.position.y = pos.y + c.rideOff + RIDE_HEIGHT;
      }
    }
    // Build the car basis from the (centreline-pitched) forward + a level (world-up)
    // reference, so x (lateral) stays horizontal and the body owns pitch, nothing else.
    const x = this._sx.copy(this._worldUp).cross(z).normalize();
    const yy = this._syy.copy(z).cross(x).normalize();
    c.group.quaternion.setFromRotationMatrix(this._sBasis.makeBasis(x, yy, z));

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
    // Finish overlay: the moment this player crosses the line, fill in their
    // place + time. _loop shows + positions it (and hides the steer bar) while
    // c.finished holds; it's covered by the full results screen once the race ends.
    c.finished = !!info.finished;
    if (c.finished && c.finishEl) {
      c.finishEl.querySelector('.cell-finish__place').textContent = ordinal(info.position);
      c.finishEl.querySelector('.cell-finish__time').textContent =
        info.finishTime != null ? `${info.finishTime.toFixed(1)}s` : '';
    }
  }

  start() { if (!this._running) { this._running = true; this._last = performance.now(); requestAnimationFrame((t) => this._loop(t)); } }
  stop() { this._running = false; }

  _updateChase(c, dt) {
    const { pos, forward, up } = c.pose;
    const baseFov = BASE_FOV, height = CHASE_HEIGHT;
    // ideal pose: rigidly behind the CAR's heading, looking just ahead of it
    const want = this._sWant.copy(pos).addScaledVector(forward, -CHASE_DIST).addScaledVector(up, height);
    const target = this._sTarget.copy(pos).addScaledVector(forward, CHASE_LOOK).addScaledVector(up, CHASE_TGT_UP);
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
    const rawMs = t - this._last;            // true rAF cadence (pre-clamp) for the FPS meter
    const dt = Math.min(rawMs / 1000, 0.05);
    this._last = t;
    this._frameDt = dt; // exposed so setCarPose can damp frame-rate-independently
    if (rawMs > 0 && rawMs < 1000) {
      this._tickFpsMeter(t, rawMs); // skip absurd post-stall deltas
      this._adaptScale(rawMs);      // dynamic resolution reacts to real frame time
    }
    if (this.onFrame) this.onFrame(dt);

    // SKIDMARK ribbon. Each rear wheel's contact point is tracked CONTINUOUSLY
    // while moving (so a new mark only ever bridges one short segment — no gaps),
    // but a mark's opacity ramps smoothly from ZERO at the scuff threshold: a dead-
    // straight cruise leaves nothing (the contact shadow grounds it there), gentle
    // bends fade in faintly, and hard cornering / curb grinding marks clearly.
    // Stamps are laid end-to-end (no overlap, so faint quads don't stack into
    // darker blobs) at the car's tyre width → one even ribbon along the exact
    // wheel path at any speed.
    for (const c of this.cars.values()) {
      if (!c.pose) continue;
      const spd = c.spd || 0;                                // normalised 0..1 (per-car top speed)
      if (spd <= 0.05 && !c.scrub) {
        // stopped: forget every wheel's last contact so we never bridge across a stop
        if (c.backWheels) for (const w of c.backWheels) w.userData.skidLast = null;
        if (c.frontWheels) for (const w of c.frontWheels) w.userData.skidLast = null;
        continue;
      }
      const up = c.pose.up;
      const turn = Math.min(1, Math.abs(c.steerAmt || 0));   // how hard we're cornering
      // slip 0..1: 1 grinding the curb, else how far past the scuff threshold the corner is
      const slip = c.scrub ? 1 : Math.max(0, (turn - SKID_THRESH) / (1 - SKID_THRESH));
      const strength = c.scrub ? 1 : Math.min(1, slip * 1.3); // 0 at threshold → smooth fade-in
      c.group.updateWorldMatrix(false, true); // fresh wheel world transforms
      // curb grind marks all four wheels; otherwise just the loaded rears (clear
      // the fronts so a later scrub doesn't bridge from a stale spot)
      const wheels = c.scrub ? c.allWheels : c.backWheels;
      if (!c.scrub && c.frontWheels) for (const w of c.frontWheels) w.userData.skidLast = null;
      for (const w of wheels) {
        // wheel position dropped onto the road plane under the car = contact patch
        const gp = w.getWorldPosition(this._gpA);
        gp.addScaledVector(up, -this._projV.copy(gp).sub(c.pose.pos).dot(up));
        // `last` is a live reference to w.userData.skidLast, so last.copy(...) below
        // advances the stored point in place.
        let last = w.userData.skidLast;
        if (!last) { w.userData.skidLast = gp.clone(); continue; } // first contact: seed it
        const seg = this._segV.copy(gp).sub(last);
        const dist = seg.length();
        if (dist < SKID_SEG_MIN) continue;                  // not moved enough yet — accumulate
        if (dist > SKID_SEG_MAX) { last.copy(gp); continue; } // respawn/teleport — don't streak across it
        // only draw if the corner is hard enough to scuff; otherwise just keep the
        // contact point marching forward so the next real mark bridges one segment
        if (strength > 0.02) {
          const dir = this._dirV.copy(seg).multiplyScalar(1 / dist);
          const mid = this._midV.copy(last).addScaledVector(seg, 0.5);
          this._emitSkidSeg(mid, up, dir, dist, c.skidWidth, strength); // end-to-end, no overlap
        }
        last.copy(gp); // always advance (even on a straight) → next mark starts adjacent
      }
    }
    this._stepSkids(dt);

    const W = window.innerWidth, H = window.innerHeight;
    const r = this.renderer;
    // Everything renders into the offscreen scene target (drawing-buffer pixels);
    // _present then grades it (exposure + sRGB) and copies it to the canvas.
    const rt = this._rtScene;
    // Viewport math uses the RT's ACTUAL size (= drawing buffer × render scale), so
    // split-screen cells fill the dynamically-scaled target; the present upscales it.
    const DBW = rt.width, DBH = rt.height;
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
      if (this.orbit && this._trackCenter) {
        // attract-mode turntable: ride a circle around the track at the overview
        // radius/height, advancing the bearing each frame.
        this._orbitAngle += LOBBY_ORBIT_SPEED * dt;
        const ctr = this._trackCenter;
        this.overview.position.set(
          ctr.x + Math.cos(this._orbitAngle) * this._ovRadius,
          ctr.y + this._ovHeight,
          ctr.z + Math.sin(this._orbitAngle) * this._ovRadius
        );
      } else {
        this.overview.position.lerp(this._ovPos || this.overview.position, 0.05);
      }
      this.overview.lookAt(this._ovTarget || new THREE.Vector3());
      r.render(this.scene, this.overview);
      for (const c of this.cars.values()) { if (c.label) c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; if (c.finishEl) c.finishEl.style.display = 'none'; }
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

      // steer indicator: centered along the bottom of this player's cell — hidden
      // once they finish (on a victory lap now, the finish overlay takes its place)
      if (c.steerBar) {
        c.steerBar.style.display = c.finished ? 'none' : 'block';
        c.steerBar.style.left = (x + cw / 2) + 'px';
        c.steerBar.style.top = (row * ch + ch - 34) + 'px';
      }

      // FINISHED overlay: centred in the cell while this player is finished and
      // the race is still on (the results screen covers it once the race ends).
      if (c.finishEl) {
        c.finishEl.style.display = c.finished ? 'flex' : 'none';
        if (c.finished) {
          c.finishEl.style.left = (x + cw / 2) + 'px';
          c.finishEl.style.top = (row * ch + ch / 2) + 'px';
        }
      }
    });

    this._present();
    requestAnimationFrame((tt) => this._loop(tt));
  }
}
