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

// Held-item display: a fixed square slot on the cell HUD shows an ICON (not text).
// Labels are kept for the slot's tooltip/aria. Boost is inline SVG; banana is a
// 2D render of the actual Kenney item-banana GLB, baked offline like the car
// picker thumbs (scripts/capture-item-icon.js → assets/toycar/thumbs/).
const ITEM_LABELS = { boost: 'BOOST', banana: 'BANANA' };
const ITEM_ICONS = {
  boost: '<svg viewBox="0 0 24 24" fill="none" stroke="#12a99a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,13.5 12,7.5 19,13.5"/><polyline points="5,18.5 12,12.5 19,18.5"/></svg>',
  banana: '<img src="/assets/toycar/thumbs/item-banana.png" alt="" draggable="false" decoding="async">'
};
const ITEM_KEYS = Object.keys(ITEM_ICONS);

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

// Boost-pad face: a glowing teal disc with gold forward chevrons. Drawn opaque
// (the CircleGeometry masks it to a disc) so it reads as a bright speed strip on
// the road. The chevron apexes point toward canvas-top → texture v=1 → the pad's
// +tangent axis (see _buildProps' basis), i.e. the direction of travel.
function makePadTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, '#7dffe8'); g.addColorStop(0.7, '#22c9b6'); g.addColorStop(1, '#0e8f82');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff4cc'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // Three forward chevrons, CENTRED on the disc both ways: apex on the vertical
  // axis (x = s/2), and the stack — (n-1)·gap plus the chevron's own height — offset
  // by y0 so it sits centred in the s×s texture instead of low-and-left.
  const n = 3, gap = 13, chev = 10, y0 = (s - ((n - 1) * gap + chev)) / 2;
  for (let i = 0; i < n; i++) {
    const y = y0 + i * gap;
    ctx.beginPath(); ctx.moveTo(s / 2 - 16, y + chev); ctx.lineTo(s / 2, y); ctx.lineTo(s / 2 + 16, y + chev); ctx.stroke();
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
    // Offscreen MSAA sample count (?msaa=0|2|4), read before _initThree since the
    // present target is built from it. MSAA was the single biggest GPU cost (≈5.4ms/
    // frame at 4× on a 12MP buffer, vs 1.1ms with none — measured via GPU timer
    // query). The plate — the one thin feature that needed it — now self-antialiases
    // via its soft feathered edge, so we default MSAA OFF; the chunky toy geometry
    // tolerates it. Override with ?msaa=2 / ?msaa=4 if wanted.
    const msaa = parseInt(new URLSearchParams(location.search).get('msaa'), 10);
    this._msaaSamples = Number.isFinite(msaa) ? Math.max(0, Math.min(4, msaa)) : 0;
    // ?bbox=1 → draw collision/trigger outlines for oil, boost pads, item boxes,
    // bananas, and cars (debug aid; see _drawDebug). Off by default.
    this._bbox = (() => { try { return new URLSearchParams(location.search).get('bbox') === '1'; } catch (_) { return false; } })();
    this._dbgStatic = []; // [{kind, s, lat, radius}] for the static props (filled in setTrack)
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
    this._coneTmp = new THREE.Vector3();   // scratch for the airborne-cone road clamp
    this._coneTmp2 = new THREE.Vector3();
    this._sBananaUp = new THREE.Vector3(); // scratch for the per-frame banana up vector (syncProps)
    this._liveBananas = new Set();         // reused per-frame live-id set (syncProps); cleared, never reallocated
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
        // Keep only NEAR-HORIZONTAL surfaces (|normal.y| > 0.1, i.e. the face leans no
        // more than ~84° off horizontal); skip the kerbs' near-vertical inner/outer
        // faces. |normal.y| (not normal.y) is used so a back-wound road face still
        // registers; the nearest-to-refY pick below selects the true road top. Loose
        // enough that sloped hills/ramps AND banked corners (≤ ~25° here) all count —
        // only a near-vertical wall or a loop-the-loop would need a tighter bound.
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
    this._softTex = makeSoftBlobTexture(); // round blob for the boost aura
    this._padTex = makePadTexture();       // boost-pad face (teal disc + gold chevrons)
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
    // antialias:false — the whole scene renders through the offscreen MSAA target
    // (_rtScene, samples = _msaaSamples); the canvas framebuffer only ever receives
    // the full-screen present quad, so canvas AA would be a no-op (and an unused
    // multisample backbuffer).
    const r = new THREE.WebGLRenderer({ antialias: false });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.autoClear = false; // we clear once per frame, then render N viewports
    // Real shadow map: cars cast a soft shadow the road RECEIVES, so it wraps over
    // bumps/hills with no clipping (a flat painted blob can't sit on curved ground).
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // soft PCF; the Soft variant is deprecated in our three build
    // Rebuild the shadow map at most ONCE per frame, not once per split-screen cell:
    // _loop raises renderer.shadowMap.needsUpdate before the first cell renders and that
    // render consumes it. The gate (WebGLShadowMap) reads renderer.shadowMap — NOT
    // light.shadow — so the flag has to live here, else autoUpdate stays on and every
    // one of the N cameras re-rasterises the whole map (4× the shadow cost at 4 players).
    r.shadowMap.autoUpdate = false;
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
    // extent); _loop refreshes the map once per frame (see renderer.shadowMap.autoUpdate
    // above). 4096² keeps the per-texel size small even on the biggest track's fitted
    // frustum (~0.03 world units/texel), so the cast shadow's edge stays crisp instead
    // of shimmering as the car moves — coarse texels were the source of the flicker.
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
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
    // Track hazards (oil slicks + their warning cones), rebuilt per setTrack. Kept
    // in its own group so it clears with the track without touching the cars/decals.
    this.hazardGroup = new THREE.Group();
    scene.add(this.hazardGroup);
    this._cones = []; // kickable cone state {mesh, home, homeQuat, vel, spinAxis, spinRate, airborne}
    this._boxes = [];          // item-box meshes (indexed parallel to track.boxes), toggled by snapshot.boxes
    this._bananaMeshes = new Map(); // banana id → mesh, reconciled from snapshot.bananas
    this._dbgGroup = new THREE.Group(); // ?bbox debug outlines (redrawn each frame); persists across tracks
    scene.add(this._dbgGroup);
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
  // RT pixel dims = the full canvas drawing buffer (the present pass is a 1:1 copy).
  _rtDims() {
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { w: Math.max(2, db.x), h: Math.max(2, db.y) };
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
  }

  _resizePost() {
    if (!this._rtScene) return;
    const { w, h } = this._rtDims();
    this._rtScene.setSize(w, h);
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
      el.textContent = `${fps.toFixed(0)} fps\n${mean.toFixed(1)} ms (⤒${worst.toFixed(0)})`;
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
        if (CAR_MODELS.includes(name)) this._glossCarMats(gltf.scene);
        this.protos.set(name, gltf.scene);
        resolve();
      }, undefined, reject);
    })));
  }

  // Give car materials the toy "shine" once at load: scale stock roughness toward
  // gloss (DEF_CAR_ROUGH, lower → sharper key-light highlight) and cap metalness.
  // A per-material guard keeps it idempotent for materials shared across a proto's
  // meshes (cloned cars share them too, so this updates every car).
  _glossCarMats(root) {
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || m.userData.glossed) continue; // shared material: gloss exactly once
        m.userData.glossed = true;
        if ('roughness' in m) m.roughness = Math.max(0.08, (m.roughness ?? 1) * DEF_CAR_ROUGH);
        if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.1);
        m.needsUpdate = true;
      }
    });
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

  // Build the visible road + kerbs by sweeping a fixed cross-section along the track
  // centreline, plus a chunked road-surface proxy for the ground-conform raycast. The
  // road is fully procedural (no GLB tiles): width comes from the track, the kerb is a
  // low toy profile, so widening the road only pushes the kerb outward — it never grows
  // into a wall the way scaling the old GLB tiles did. One merged vertex-coloured mesh
  // (asphalt + white edge lines + red/white kerb + side skirt); adds it to trackGroup
  // and the collision chunks to `collide`.
  _buildRibbonRoad(track, collide) {
    const cl = track.centerline;
    if (!cl || !cl.samples.length) return;

    // Drivable width is per-sample (centerline.width / roadWidth) — the road can flare
    // and pinch along the lap, and the physics curb corridor follows it (Game.maxLatAt).
    // `defHalf` is the fallback half-width; the kerb/line cross-section is fixed.
    const defHalf = (track.roadWidth || 5) / 2;
    const halfAt = (i) => (frames[i].width != null ? frames[i].width : track.roadWidth || 5) / 2;
    const cw = 0.22;        // kerb lateral width
    const ch = 0.20;        // kerb height — low; a kerb, not a wall
    const deck = 0.34;      // side-skirt drop (visual deck thickness below the road)
    const gap = Math.min(0.07, defHalf * 0.3);     // asphalt gap between kerb and edge line
    const lw = Math.min(0.10, defHalf * 0.5 - gap);// painted white edge-line width
    const stripeLen = 0.32;                        // kerb red/white band length (world units)

    // Resample the centreline at a uniform, fine arclength step. The raw samples are
    // spaced unevenly (~0.4 on tight corners, ~1.5 on straights) — far coarser than a
    // stripe — so colouring whole between-sample segments aliased the bands into uneven
    // blobs (a stripe shorter than a segment simply can't be drawn). A uniform step a
    // few× finer than a stripe renders every band cleanly and also smooths the surface.
    const ds = Math.min(0.5, Math.max(0.06, stripeLen / 3));
    const N = Math.min(4000, Math.max(8, Math.round(cl.length / ds)));
    const frames = [];
    for (let i = 0; i < N; i++) frames.push(cl.sampleAt((i / N) * cl.length));

    // Colours — sampled directly from the Kenney colormap (colormap.png) at the real
    // kerb/road face UVs, so the procedural road matches the GLB tiles' plastic look.
    // Kenney bakes per-face shading into the texture (darker side swatches, brighter
    // tops); we take the TOP/brightest swatch as the base albedo and let the scene's
    // real-time lighting do the side shading. Built through THREE.Color so the sRGB
    // hexes convert to the renderer's linear working space the same way material.color
    // does (raw vertex-colour floats are NOT auto-converted — doing it here keeps the
    // albedo identical to what the textured tiles sample).
    const c = (hex) => { const k = new THREE.Color(hex); return [k.r, k.g, k.b]; };
    const ASPHALT = c(0x5a6078);   // road surface
    const LINE = c(0xc4c4d9);      // painted road marking (Kenney's light road-line swatch)
    const KERB_RED = c(0xfa6b41);  // kerb red — Kenney's is a warm orange-red, not crimson
    const KERB_WHITE = c(0xf8f8fb);// kerb white

    // Cross-section anatomy, left → right: asphalt is flat (y=0) across the drivable width;
    // inside each kerb sits a small asphalt `gap`, then a thin painted white line, then the
    // main asphalt. A low kerb rises to `ch` just outside; a skirt drops to -deck so the deck
    // reads as solid from the side and over crests (a zero-thickness ribbon looks like paper
    // and shows daylight under hill tops).
    // Cross-section as { sign: which kerb edge (−1 left, +1 right), off: lateral offset
    // from that edge, y: height above the drive surface }. A point's lateral position on
    // ring i is sign·halfAt(i) + off, so the whole profile flares/pinches with the
    // per-sample road width while the kerb + line widths stay constant.
    const P = [
      { sign: -1, off: -cw,       y: -deck }, // 0  left skirt foot
      { sign: -1, off: -cw,       y: 0     }, // 1  left kerb outer base (top of deck skirt)
      { sign: -1, off: -cw,       y: ch    }, // 2  left kerb outer top
      { sign: -1, off: 0,         y: ch    }, // 3  left kerb inner top
      { sign: -1, off: 0,         y: 0     }, // 4  left asphalt edge (foot of kerb)
      { sign: -1, off: gap,       y: 0     }, // 5  outer edge of left line (after the gap)
      { sign: -1, off: gap + lw,  y: 0     }, // 6  inner edge of left line
      { sign:  1, off: -gap - lw, y: 0     }, // 7  inner edge of right line
      { sign:  1, off: -gap,      y: 0     }, // 8  outer edge of right line
      { sign:  1, off: 0,         y: 0     }, // 9  right asphalt edge
      { sign:  1, off: 0,         y: ch    }, // 10 right kerb inner top
      { sign:  1, off: cw,        y: ch    }, // 11 right kerb outer top
      { sign:  1, off: cw,        y: 0     }, // 12 right kerb outer base (top of deck skirt)
      { sign:  1, off: cw,        y: -deck }  // 13 right skirt foot
    ];
    // strip connects profile points (a,b); `kind` picks the colour rule.
    const STRIPS = [
      { a: 0,  b: 1,  kind: 'skirt' },            // left deck side, below road — road-grey
      { a: 1,  b: 2,  kind: 'kerb', side: 'L' },  // left kerb OUTER face (road level → top) — striped
      { a: 2,  b: 3,  kind: 'kerb', side: 'L' },  // left kerb top
      { a: 3,  b: 4,  kind: 'kerb', side: 'L' },  // left kerb inner face
      { a: 4,  b: 5,  kind: 'road'  },            // gap asphalt between kerb and left line
      { a: 5,  b: 6,  kind: 'line'  },            // left white edge line
      { a: 6,  b: 7,  kind: 'road'  },            // main asphalt
      { a: 7,  b: 8,  kind: 'line'  },            // right white edge line
      { a: 8,  b: 9,  kind: 'road'  },            // gap asphalt between right line and kerb
      { a: 9,  b: 10, kind: 'kerb', side: 'R' },  // right kerb inner face
      { a: 10, b: 11, kind: 'kerb', side: 'R' },  // right kerb top
      { a: 11, b: 12, kind: 'kerb', side: 'R' },  // right kerb OUTER face (top → road level) — striped
      { a: 12, b: 13, kind: 'skirt' }             // right deck side, below road — road-grey
    ];
    // Baked ambient-occlusion per profile point — a brightness multiplier on the
    // vertex colour. Kenney paints this contact shading into its texture (dark side
    // swatches, darkened edges); we approximate it so the flat-albedo ribbon gets the
    // same plastic-toy form: deep shade at the skirt feet, a contact shadow where the
    // kerb meets the road, and the asphalt easing darker as it nears the kerb. Road
    // centre and kerb tops stay full bright. (Multiplies LINEAR colour = physically
    // how occlusion attenuates reflected light.)
    const ao = [
      0.55, // 0  left skirt foot — deep shadow against the grass
      0.65, // 1  left kerb outer base (deck skirt top, shaded)
      0.90, // 2  left kerb outer top
      1.00, // 3  left kerb inner top
      0.70, // 4  left kerb foot — contact shadow where kerb meets road
      0.90, // 5  asphalt by the left kerb
      1.00, // 6  road
      1.00, // 7  road
      0.90, // 8  asphalt by the right kerb
      0.70, // 9  right kerb foot — contact shadow
      1.00, // 10 right kerb inner top
      0.90, // 11 right kerb outer top
      0.65, // 12 right kerb outer base (deck skirt top, shaded)
      0.55  // 13 right skirt foot
    ];

    // World position of profile point j on ring i: centreline + height along the road
    // normal (up) + lateral offset across the road. Returns shared scratch — clone it.
    const tmp = new THREE.Vector3();
    const ring = (i, j) => {
      const s = frames[i];
      const l = P[j].sign * halfAt(i) + P[j].off;
      return tmp.copy(s.pos).addScaledVector(s.up, P[j].y).addScaledVector(s.lateral, l);
    };
    const pos = [], col = [];
    const push3 = (arr, p) => { arr.push(p.x, p.y, p.z); };
    // Per-strip colour push: the two triangles below are wound ia,ib,nb / ia,nb,na, so
    // the 6 verts map to profile points [a,b,b,a,b,a]. Each gets its base colour times
    // its own AO, so the darkening varies ACROSS the strip (a gradient) — that's what
    // gives the kerb face and road edge their baked-in contact shadow.
    const VSEQ = ['a', 'b', 'b', 'a', 'b', 'a'];
    const pushStripCol = (base, st) => {
      for (const v of VSEQ) { const f = ao[st[v]]; col.push(base[0] * f, base[1] * f, base[2] * f); }
    };

    // Kerb stripes: band by arclength measured ALONG EACH KERB EDGE, not the
    // centreline. On a bend the outer kerb is longer than the centreline and the inner
    // is shorter, so banding by centreline arclength stretched the outside bands and
    // squashed the inside ones (the uneven look). Measure each side independently at
    // its kerb mid-line and snap its band length so an EVEN number of bands closes the
    // loop — that keeps every band a uniform physical size and the start/finish seam
    // free of a red-on-red (or white-on-white) join.
    const kerbDist = (side) => {
      const d = new Array(N);
      const at = (k) => new THREE.Vector3().copy(frames[k].pos)
        .addScaledVector(frames[k].up, ch)
        .addScaledVector(frames[k].lateral, side * (halfAt(k) + cw / 2)); // kerb mid-line (per-sample width)
      let prev = at(0), acc = 0;
      d[0] = 0;
      for (let i = 1; i < N; i++) { const cur = at(i); acc += cur.distanceTo(prev); d[i] = acc; prev = cur; }
      const total = acc + at(0).distanceTo(prev); // close the loop
      const bands = Math.max(2, 2 * Math.round(total / (2 * stripeLen)));
      return { d, eff: total / bands };
    };
    const kerbL = kerbDist(-1), kerbR = kerbDist(1);
    const bandCol = (k, i) => ((Math.floor(k.d[i] / k.eff) % 2) === 0 ? KERB_RED : KERB_WHITE);

    // Sweep the profile around the closed loop into ONE vertex-coloured buffer.
    for (let i = 0; i < N; i++) {
      const ni = (i + 1) % N;
      const colL = bandCol(kerbL, i), colR = bandCol(kerbR, i);
      for (const st of STRIPS) {
        const ia = ring(i, st.a).clone(), ib = ring(i, st.b).clone();
        const na = ring(ni, st.a).clone(), nb = ring(ni, st.b).clone();
        push3(pos, ia); push3(pos, ib); push3(pos, nb); // tri 1
        push3(pos, ia); push3(pos, nb); push3(pos, na); // tri 2
        const kerbCol = st.side === 'R' ? colR : colL;
        pushStripCol(st.kind === 'kerb' ? kerbCol : st.kind === 'line' ? LINE : ASPHALT, st);
      }
    }

    const mkGeom = (positions, colors) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.computeVertexNormals();
      return g;
    };
    const geo = mkGeom(pos, col);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide }); // matches Kenney track tiles (fully matte)
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false; // positions are already baked in world space
    mesh.receiveShadow = true;     // road catches the cars' cast shadows
    this.trackGroup.add(mesh);
    this._mergedGeoms.push(geo);
    this._mergedMats.push(mat);

    // Collision proxy: only the flat asphalt surface (kerbs/skirts aren't drivable),
    // spanning the full -hw..hw width (profile points 4 and 9), chunked so the existing
    // (x,z) bucket grid prunes the ground-conform raycast to the few chunks under the
    // car — the same contract the per-tile clones honour.
    const CHUNK = 8; // segments per collision mesh
    const collideMat = new THREE.MeshBasicMaterial({ visible: false });
    this._mergedMats.push(collideMat);
    let chunk = [];
    const flush = () => {
      if (!chunk.length) return;
      const cgeo = mkGeom(chunk, null);
      const m = new THREE.Mesh(cgeo, collideMat);
      m.matrixAutoUpdate = false;
      collide.add(m);
      this._mergedGeoms.push(cgeo);
      chunk = [];
    };
    for (let i = 0; i < N; i++) {
      const ni = (i + 1) % N;
      const ia = ring(i, 4).clone(), ib = ring(i, 9).clone();
      const na = ring(ni, 4).clone(), nb = ring(ni, 9).clone();
      push3(chunk, ia); push3(chunk, ib); push3(chunk, nb);
      push3(chunk, ia); push3(chunk, nb); push3(chunk, na);
      if ((i + 1) % CHUNK === 0) flush();
    }
    flush();
  }

  // Support pillars under raised decks (bridge/ramp). TrackBuilder computes the placements
  // (the `pillars` opt + the under-bridge skip); each is a simple vertical cylinder from
  // the grass plane up to just under the deck, merged into ONE matte mesh. They cast a
  // contact shadow so the column reads as planted on the ground. Off-road, so they're kept
  // OUT of the collision proxy — purely visual (a car never drives onto a pillar).
  _buildPillars(track) {
    const list = track.pillars;
    if (!list || !list.length) return;
    const geoms = [];
    for (const p of list) {
      const h = Math.max(0.1, p.topY - p.baseY);
      const g = new THREE.CylinderGeometry(p.radius, p.radius, h, 16);
      g.translate(p.x, p.baseY + h / 2, p.z); // cylinder is centred on its axis → lift to span base…top
      geoms.push(g);
    }
    const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
    if (geoms.length > 1) for (const g of geoms) g.dispose(); // copied into `merged`
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa1b4, roughness: 1, metalness: 0 }); // matte toy concrete
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false; // geometry is baked in world space (translate above)
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.trackGroup.add(mesh);
    this._mergedGeoms.push(merged);
    this._mergedMats.push(mat);
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
    // The road surface is procedural — swept along the centreline (fills `collide` +
    // trackGroup itself). The loop below then bakes the remaining GLB scenery (the
    // start/finish gate); the grid/framing/shadow afterwards run on `collide.children`
    // + centreline samples regardless.
    this._buildRibbonRoad(track, collide);
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

    this._buildPillars(track);

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
    // (6,12,4) DIRECTION (so gloss/highlights are unchanged); we move it far out along
    // that direction and FIT the orthographic frustum to the track's bounding box as
    // projected into the light's view. A symmetric ±max(size)/2 box (the old approach)
    // under-covers a large or L-shaped track seen from the raked angle: its diagonal
    // corners fall OUTSIDE the frustum, so cars there cast no shadow. On Riverside that
    // dropped the shadow near the start/finish and on a couple of the L's arms — the
    // shadow "blinked" as you drove. Fitting the projected AABB guarantees full coverage.
    const k = this._key;
    const dir = new THREE.Vector3(6, 12, 4).normalize();
    const diag = Math.hypot(size.x, size.y, size.z);
    k.position.copy(this._trackCenter).addScaledVector(dir, diag + 20); // far enough that near > 0
    k.target.position.copy(this._trackCenter); k.target.updateMatrixWorld();
    // Build the exact view matrix the shadow camera will use at render time (it re-derives
    // this each frame from light.position/target with up +Y), so our fit matches what gets
    // rasterised into the shadow map.
    const sc = k.shadow.camera;
    sc.position.copy(k.position); sc.up.set(0, 1, 0); sc.lookAt(this._trackCenter);
    sc.updateMatrixWorld(true);
    const view = sc.matrixWorld.clone().invert();
    // Project the 8 AABB corners (top corners lifted by the car body height so a tall
    // caster at the track edge still fits) and fit left/right/top/bottom + near/far to them.
    const CAR_H = 1.2, M = 4; // M: world-unit slack absorbing road width + caster overhang
    const corner = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      corner.set(xi ? box.max.x : box.min.x, (yi ? box.max.y : box.min.y) + (yi ? CAR_H : 0), zi ? box.max.z : box.min.z).applyMatrix4(view);
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z); // view looks down -z
    }
    sc.left = minX - M; sc.right = maxX + M; sc.bottom = minY - M; sc.top = maxY + M;
    sc.near = Math.max(0.5, -maxZ - M); sc.far = -minZ + M;
    sc.updateProjectionMatrix();
    k.shadow.needsUpdate = true; // rebuild the map for the new track

    this._buildHazards(track);
    this._buildProps(track);
    this._drawDebug({}); // static-prop bbox rings (cars/bananas added per-frame in syncProps)
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
  syncProps(snap) {
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
      disc.renderOrder = -1; // under the cars' dust/skid decals
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
  _stepCones(dt) {
    if (!this._cones || !this._cones.length) return;
    for (const cn of this._cones) {
      const m = cn.mesh;
      if (!cn.airborne) {
        if (!m.quaternion.equals(cn.homeQuat)) m.quaternion.slerp(cn.homeQuat, 1 - Math.exp(-8 * dt));
        for (const c of this.cars.values()) {
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

    // Car footprint (width × length), used to size the boost aura below. The sun's
    // directional light is the only car shadow now — a single raked light leaves a
    // faint gap under the chassis, but a generic oval blob there read as a separate
    // "second shadow", so it's gone; the cast silhouette alone keeps the car planted.
    // updateWorldMatrix first so the bounding box reflects the posed car transform.
    group.updateWorldMatrix(true, true);
    const fb = new THREE.Box3().setFromObject(car);
    const footW = fb.max.x - fb.min.x, footL = fb.max.z - fb.min.z;

    // BOOST aura: an additive gold glow under the car, shown only while boosting and
    // sized/brightened by boostMul — so the catch-up scaling (leader vs back-marker)
    // is visible on the shared screen, not silent rubber-banding. Set in setCarPose.
    const boostAura = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this._softTex, color: 0x2bd1c4, transparent: true, opacity: 0, // teal — matches the boost pad/item
        depthWrite: false, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      })
    );
    boostAura.rotation.x = -Math.PI / 2;
    boostAura.position.y = -RIDE_HEIGHT + 0.008;
    boostAura.visible = false;
    group.add(boostAura);

    const cam = new THREE.PerspectiveCamera(62, 1, 0.1, 600);

    // AI/CPU cars (opts.cell === false) race in the shared world — so they show up
    // in every human's chase view — but get NO split-screen cell of their own. A
    // solo human then sees one viewport, not their own cell plus three bot cameras.
    // Cell-less cars skip the DOM overlay (label + steer bar) and the cell order.
    const cell = opts.cell !== false;
    const colHexUi = this.colors[colorIndex % this.colors.length] || '#fff';
    let label = null, steerBar = null, steerFill = null, finishEl = null, placeEl = null;
    if (cell) {
      label = document.createElement('div');
      label.className = 'cell-label';
      label.innerHTML = `<div class="cell-label__row"><span class="cell-label__name"></span><div class="cell-label__item is-empty"></div></div>`;
      label.querySelector('.cell-label__name').textContent = name || ('P' + id);
      label.style.setProperty('--c', colHexUi);
      this.overlay.appendChild(label);

      // place + lap readout — pinned to this player's cell top-right, no card, white
      // text over the scene (positioned by _loop, filled by setCarHud).
      placeEl = document.createElement('div');
      placeEl.className = 'cell-rank';
      placeEl.innerHTML = `<div class="cell-rank__place"></div><div class="cell-rank__lap"></div>`;
      this.overlay.appendChild(placeEl);

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
      wheelbase, skidWidth, plate, cam, boostAura, footW, footL,
      carIndex, anchorZ: anchor.z, plateY: anchor.y, baseYaw: car.rotation.y,
      camPos: new THREE.Vector3(), camTarget: new THREE.Vector3(),
      label, steerBar, steerFill, finishEl, placeEl, finished: false, pose: null, init: false, lean: 0,
      reconnecting: false, reconnectEl: null, // dropped-player reconnect card (centred in this cell, like finishEl)
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
    // Dispose what addCar created fresh per car (the name plate + boost aura). The car
    // mesh shares its geometry/material with the cached prototype — leave it for the
    // next race.
    c.plate.geometry.dispose(); c.plate.material.map.dispose(); c.plate.material.dispose();
    // boost aura owns its geometry + material (the map is the shared this._softTex — leave it)
    if (c.boostAura) { c.boostAura.geometry.dispose(); c.boostAura.material.dispose(); }
    if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; } // stop any running item roulette
    if (c.label && c.label.parentNode) c.label.parentNode.removeChild(c.label);
    if (c.steerBar && c.steerBar.parentNode) c.steerBar.parentNode.removeChild(c.steerBar);
    if (c.finishEl && c.finishEl.parentNode) c.finishEl.parentNode.removeChild(c.finishEl);
    if (c.placeEl && c.placeEl.parentNode) c.placeEl.parentNode.removeChild(c.placeEl);
    if (c.reconnectEl && c.reconnectEl.parentNode) c.reconnectEl.parentNode.removeChild(c.reconnectEl);
    this.cars.delete(id);
    this._order = this._order.filter((x) => x !== id);
  }

  // Re-key a car's render entry from one id to another (a dropped player
  // reconnects on a different device). Keeps the same mesh, plate and split-screen
  // cell — only the id it's filed under changes, so the camera keeps following it.
  // The reconnect card is dropped: a re-key means the seat is back.
  rekeyCar(oldId, newId) {
    if (oldId === newId) return false;
    const c = this.cars.get(oldId);
    if (!c || this.cars.has(newId)) return false;
    this.setCarReconnect(oldId, null);
    this.cars.delete(oldId);
    this.cars.set(newId, c);
    for (let i = 0; i < this._order.length; i++) {
      if (this._order[i] === oldId) this._order[i] = newId;
    }
    return true;
  }

  // Show (el) or clear (null) a dropped player's reconnect card, centred in their
  // split-screen cell by _loop — same placement as the FINISHED card. `el` is the
  // card DOM built by the display layer (carries the rejoin QR). No-op if the car
  // has no cell (e.g. nobody's racing), so reconnect cards only show in-race.
  setCarReconnect(id, el) {
    const c = this.cars.get(id);
    if (!c || !c.label) return false; // cell-less / unknown car → nowhere to centre it
    if (c.reconnectEl && c.reconnectEl !== el && c.reconnectEl.parentNode) {
      c.reconnectEl.parentNode.removeChild(c.reconnectEl);
    }
    if (!el) { c.reconnectEl = null; c.reconnecting = false; return true; }
    c.reconnectEl = el;
    c.reconnecting = true;
    if (el.parentNode !== this.overlay) this.overlay.appendChild(el);
    return true;
  }

  setCarPose(id, pos, forward, up, steer = 0, spd = 0, scrub = false, steerInput = steer, spin = 0, boostMul = 1) {
    const c = this.cars.get(id);
    if (!c) return;
    c.spd = spd; c.scrub = scrub; c.steerAmt = steer;
    // spin-out whirl: rotate the whole car model about its up axis on top of its
    // model-facing fix (the sim heading is untouched — this is purely cosmetic).
    c.car.rotation.y = c.baseYaw + spin;
    // boost aura: a subtle teal glow below the car while boosting, gently PULSATING,
    // scaled by the boost size (a back-marker's bigger catch-up boost glows a touch
    // bigger than the leader's floor). Teal matches the boost pad/item colour.
    if (c.boostAura) {
      if (boostMul > 1.001) {
        const k = boostMul - 1;            // 0.25 (leader floor) … 0.60 (last)
        const pulse = 0.62 + 0.38 * Math.sin(performance.now() * 0.011); // ~1.8 Hz
        c.boostAura.visible = true;
        c.boostAura.material.opacity = Math.min(0.42, 0.18 + k * 0.5) * pulse; // subtle
        const sc = (1.25 + k * 2.0) * (0.96 + 0.06 * pulse);                   // gentle breathing
        c.boostAura.scale.set(c.footW * sc, c.footL * sc, 1);
      } else if (c.boostAura.visible) {
        c.boostAura.visible = false;
      }
    }
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
    // (yaw) is the centreline's; roll stays level (world up) ON PURPOSE — the body stays
    // level even through a banked corner (Mario-Kart style, reads cleaner than a tilting
    // cabin). The banked road normal is still carried in c.pose.up for any caller that wants it.
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
    // Models with no separate body node (body === car — e.g. the monster truck, whose
    // wheels aren't named like the others) carry the spin-out whirl on this SAME node,
    // so the copy above just wiped the whirl set near the top of setCarPose. Fold it
    // back in here (only while spinning out) or the car spins out in the sim but never
    // visibly whirls on screen.
    if (spin && c.body === c.car) c.body.rotateY(spin);
    c.body.rotateZ(c.lean);
    // turn the front wheels with steering (steer>0 = right)
    for (const w of c.frontWheels) w.rotation.y = steer * WHEEL_TURN_MAX;
    // on-screen steer indicator: mirror the player's RAW input (same as the phone
    // bar) so it slides the way they tilt — not the turn-aligned/STEER_SIGN value.
    if (c.steerFill) c.steerFill.style.transform = `translateX(${(steerInput * 50).toFixed(1)}%)`;

    // (nothing else to update here: the cast shadow follows the car automatically,
    // and the name plate is parented to the body so it banks with the steering lean.)
  }

  // Paint the item slot: an item ICON (graphic), or the reserved empty square.
  _paintSlot(el, item, rolling) {
    if (item) {
      el.innerHTML = ITEM_ICONS[item] || '';
      el.className = 'cell-label__item is-' + item + (rolling ? ' rolling' : '');
      el.title = ITEM_LABELS[item] || '';
    } else {
      el.innerHTML = '';
      el.className = 'cell-label__item is-empty';
      el.title = '';
    }
  }

  // Slot-machine the cell's item slot: flick through the item ICONS, decelerating,
  // then land on `item` with a pop. Self-driven (setTimeout chain on c._chipTimer) so
  // it animates faster than the ~6 Hz setCarHud cadence; cancelled on change/teardown.
  _rouletteChip(c, item) {
    const el = c.label && c.label.querySelector('.cell-label__item');
    if (!el) return;
    let i = 0, n = 0; const TOTAL = 9;
    const spin = () => {
      this._paintSlot(el, ITEM_KEYS[i % ITEM_KEYS.length], true); i++; n++;
      if (n >= TOTAL) { // land on the real item
        c._chipTimer = null;
        this._paintSlot(el, item, false);
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
        return;
      }
      c._chipTimer = setTimeout(spin, 35 + n * 16); // decelerate ~35ms → ~165ms
    };
    spin();
  }

  setCarHud(id, info) {
    const c = this.cars.get(id);
    if (!c || !c.label) return; // cell-less AI cars have no HUD label
    // place + lap, top-right (no card): a big ordinal over a smaller "Lap n/N". Hidden
    // while finished — the centred FINISHED overlay shows their place + time instead.
    if (c.placeEl) {
      c.placeEl.querySelector('.cell-rank__place').textContent = ordinal(info.position);
      c.placeEl.querySelector('.cell-rank__lap').textContent = `Lap ${info.lap}/${info.totalLaps}`;
    }
    // held-item slot on this player's cell (shared screen) — a fixed reserved square.
    // On a fresh pickup it SLOT-MACHINES the item icons and lands on what they got;
    // on use it returns to the empty square (the square is always present, no reflow).
    const next = (!info.finished && info.item) ? info.item : null;
    if (next !== c._chipItem) {
      c._chipItem = next;
      if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; }
      if (next) this._rouletteChip(c, next);
      else { const e = c.label.querySelector('.cell-label__item'); if (e) this._paintSlot(e, null, false); }
    }
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
    if (rawMs > 0 && rawMs < 1000) this._tickFpsMeter(t, rawMs); // skip absurd post-stall deltas
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
    this._stepCones(dt);
    this._stepBoxes(dt);

    const W = window.innerWidth, H = window.innerHeight;
    const r = this.renderer;
    // Everything renders into the offscreen scene target (drawing-buffer pixels);
    // _present then grades it (exposure + sRGB) and copies it to the canvas.
    const rt = this._rtScene;
    // Viewport math uses the RT's actual size (= the full drawing buffer), so the
    // split-screen cells fill the target and the present is a 1:1 copy to the canvas.
    const DBW = rt.width, DBH = rt.height;
    // clear the WHOLE target first (colour + depth) so empty split-screen cells
    // and rounding strips don't keep last frame's pixels
    rt.scissorTest = false;
    rt.viewport.set(0, 0, DBW, DBH);
    r.setRenderTarget(rt);
    r.clear();

    // Refresh the sun's shadow map ONCE this frame (renderer.shadowMap.autoUpdate is
    // off); the first render() below consumes it and every split-screen cell reuses the
    // same map. The flag lives on renderer.shadowMap — the gate ignores light.shadow.
    if (this._key) r.shadowMap.needsUpdate = true;

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
      for (const c of this.cars.values()) { if (c.label) c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; if (c.finishEl) c.finishEl.style.display = 'none'; if (c.placeEl) c.placeEl.style.display = 'none'; if (c.reconnectEl) c.reconnectEl.style.display = 'none'; }
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

      // position the DOM label at the cell's top-left (CSS px). Guarded like the
      // steer/finish overlays below: carded cars always have a label, but keep all
      // three cell overlays consistently null-safe. Hidden while the reconnect card
      // owns the cell — that card already shows the name, so the corner label would
      // just duplicate it (the FINISHED card has no name, so it keeps the label).
      const x = col * cw;
      if (c.label) {
        c.label.style.display = c.reconnecting ? 'none' : 'block';
        c.label.style.left = x + 'px';
        c.label.style.top = (row * ch) + 'px';
      }

      // place/lap + steer are hidden while a centred card owns the cell — when the
      // player has FINISHED or has dropped and is shown the reconnect QR.
      const cardInCell = c.finished || c.reconnecting;

      // place + lap: pinned to the cell's top-right (its own transform anchors the
      // right edge to this left). Hidden once a centred card takes the cell.
      if (c.placeEl) {
        c.placeEl.style.display = cardInCell ? 'none' : 'block';
        c.placeEl.style.left = (x + cw - 12) + 'px';
        c.placeEl.style.top = (row * ch + 11) + 'px';
      }

      // steer indicator: centered along the bottom of this player's cell — hidden
      // once a centred card takes the cell (finished, or dropped/reconnecting).
      if (c.steerBar) {
        c.steerBar.style.display = cardInCell ? 'none' : 'block';
        c.steerBar.style.left = (x + cw / 2) + 'px';
        // bottom-anchored: bar height is 1.6rem (~26px); the offset keeps its
        // bottom edge at the same place it sat at the old 0.8rem height.
        c.steerBar.style.top = (row * ch + ch - 47) + 'px';
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

      // Reconnect QR: centred in the dropped player's cell exactly like FINISHED,
      // while their car keeps its place on track. Finished wins the cell if both.
      if (c.reconnectEl) {
        const showRc = c.reconnecting && !c.finished;
        c.reconnectEl.style.display = showRc ? 'flex' : 'none';
        if (showRc) {
          c.reconnectEl.style.left = (x + cw / 2) + 'px';
          c.reconnectEl.style.top = (row * ch + ch / 2) + 'px';
        }
      }
    });

    this._present();
    requestAnimationFrame((tt) => this._loop(tt));
  }
}
