// SceneRenderer — Three.js scene for the race. Per-player CHASE camera in a
// SPLIT-SCREEN viewport (each player sees behind their own car). One shared
// scene; we render it once per player into their screen cell, with per-view
// name/position labels overlaid. Falls back to a single overview camera in the
// lobby (no cars). The game layer calls setCarPose()/setCarHud() each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ordinal } from '../shared/format.js';
import {
  flipWinding, bestGrid, streakBillboard, makeStreakTexture, makeStreakGeometry,
  makeBoostDiskTexture, makeBoostDiskGeometry, makeUnderShadowTexture, makePlate, PLATE_Y, PLATE_Y_FRAC
} from './render/textures.js';
import { buildEnvironment, applyEnvTheme, applyAmbient, stepAmbient, stepKites, stepBalloon, stepPaperPlane, fitWater } from './render/environment.js';
import { THEMES, themeForCup, SCENERY_MODELS } from '../shared/themes.js';
import { buildRibbonRoad, buildPillars, buildHills, buildPoles, buildLoopPoles, buildScenery, buildLandmarks } from './render/track.js';
import { buildFinishGate } from './render/FinishGate.js';
import { SkidMarks, SKID_WIDTH } from './render/SkidMarks.js';
import { TrackProps } from './render/TrackProps.js';
import { FpsMeter } from './render/FpsMeter.js';
import { buildMonsterRig, MONSTER_BASE_ASSET } from './render/MonsterRig.js';
import { ChaseCamera } from './ChaseCamera.js';

const ASSET = (name) => `/assets/toycar/${name}.glb`;

// Shared with the controller's car picker + protocol (one source of truth).
// protocol.js (classic script) sets this global before the display modules load.
const CAR_MODELS = window.CAR_MODELS;
const CAR_MODEL_YAW = window.CAR_MODEL_YAW || []; // per-model facing fix (see protocol.js)

// The per-player spring chase camera (position/look-target damping, speed FOV +
// pull-back) lives in ./ChaseCamera.js — one instance per car (c.chase).
const LEAN_MAX = 0.05;        // max body roll (rad) at full steer — subtle
const WHEEL_TURN_MAX = 0.5;   // max front-wheel turn (rad) at full steer
// Weight transfer: smoothed d(spd)/dt pitches the body — nose-down dive under
// braking, squat under throttle. Suspension responding to the road is contact
// evidence; a body rigid against the world reads as suspended above it. The
// dive is deliberately stronger than the squat (real suspension is too, and the
// brake dip is the beat the player should FEEL on a tap). The dive is gated on
// the car's REAL brake input (see setCarPose): steer scrub / curb rash / boost
// bleed decelerate at the same rate, and diving on turn-in reads as phantom
// braking — the dive is the BRAKE's cue, matching the brake-bite skids.
const PITCH_DIVE_MAX = 0.08;  // nose-down (rad) at full braking — starting value
const PITCH_SQUAT_MAX = 0.03; // nose-up (rad) at full throttle — subtle
const PITCH_ACCEL_NORM = 0.8; // |d(spd)/dt| mapping to full pitch ≈ engine full throttle (ACCEL/VMAX)
const PITCH_RATE = 6;         // pitch damping (1/s) — a soft suspension settle, not a snap
// Wheel roll: rate comes from the car's REAL travel (arclength / tyre radius,
// ω = v/r, measured from the pose delta — `spd` is normalised, so it can't drive
// this), then scaled by WHEEL_SPIN_SCALE for READABILITY (NOT a cap — a smooth
// proportional factor, so the spin still tracks speed and radius).
// WHY scale (2026-06-16): the literal rate is geometrically correct — even
// conservative (1.3 wheel-revs per car-length vs ~2.2 for a real car) — but at
// racing speed the car covers ~9 car-lengths/s, so ω hits ~70 rad/s ≈ 11 rev/s.
// Two perceptual problems with shipping that literally: (1) the chase cam
// compresses apparent translation, so honest wheels visibly outrun how fast the
// car LOOKS like it's going ("too fast by a huge margin"); (2) past ~10 rad/s it
// wagon-wheel strobes on a 60Hz TV. Every racing game cheats wheels slower than
// physical for exactly this reason (1). This factor is the one dial: 1.0 = literal,
// lower = calmer / reads-right. Dialed to 0.40 by eye via a temp on-screen slider
// (≈28 rad/s ≈ 4.5 rev/s at racing speed). (A hard cap was tried, 9 then 14 rad/s,
// and rejected for clipping the speed feel — a proportional scale keeps it.)
const ROLL_SEG_MAX = 1.5;      // per-frame travel beyond this = respawn/teleport → don't spin across it
const WHEEL_SPIN_SCALE = 0.4;  // visual roll as a fraction of literal ω=v/r (1.0 = physically literal)
// (FOV-at-speed + chase pull-back constants moved to ChaseCamera.js)
// BOOST wind streaks: a few additive white-teal streaks slicing past the car while
// boostMul > 1 — the Mario-Kart "cutting through air" idiom. World-space (not a
// screen overlay) so every split-screen cell sees a rival's boost too, same as the
// aura. Each streak is an AXIAL BILLBOARD (see streakBillboard): it spins about
// its travel axis per render pass to face that cell's camera — a fixed quad is
// near edge-on from dead astern, where every chase cam sits. Gated to boost on
// purpose: the baseline stays clean (cap what strobes, exaggerate what
// communicates). Starting values.
const STREAK_N = 4;           // streaks per car
const STREAK_COLOR = 0xdffcf8;// near-white with a teal cast (ties to the boost identity)
const STREAK_FRONT = 0.7, STREAK_BACK = -2.4; // travel span in car-local Z (world units)
const STREAK_OPACITY = 0.15;  // peak opacity at max boost — a whisper of airflow, not lasers
// Lobby attract-mode: when no cars are on track (the lobby), slowly orbit the
// overview camera around the selected track so it reads as a live 3D preview.
const LOBBY_ORBIT_SPEED = 0.1; // rad/s (~63 s per turn) — calm, never dizzying
// Lobby perimeter orbit: sweep an ELLIPSE fitted to the track's XZ bounding box (elongated
// like the track), hugging just outside its outer edge and looking at the centre — so the
// camera circles the track's overall SHAPE up close, without weaving along every curve. The
// open field hazes out for depth. Gated to the lobby (scene.bboxOrbit); the gallery grid keeps
// its whole-track turntable. See _loop's overview branch + setTrack.
const BBOX_ORBIT_SPEED = 0.16;   // rad/s (~39 s per loop) — calm, never dizzying
const BBOX_CLEARANCE = 8;        // world units the orbit sits OUTSIDE the track bbox edge — tight, so the
                                 // foreground field is minimal and the track fills the frame
const BBOX_HEIGHT_K = 0.7;       // camera height = this × the AVERAGE bbox half-extent …
const BBOX_HEIGHT_BASE = 24;     // … + this base — high enough to look DOWN onto the track so the frame
                                 // fills with ground + hazed field, not the empty sky/horizon
// Race chase-cam fog profile (clear-air baseline). A biome's `fogTune` scalar (<1 =
// dusty air, e.g. canyon sand-fog) multiplies BOTH distances here and the lobby
// perimeter fog's — the overview/gallery fog is exempt so track framing stays crisp.
const RACE_FOG_NEAR = 70;
const RACE_FOG_FAR = 170;
// Tyre-contact cues that ground the car ON the road (vs hovering over it):
//   • Skidmarks — dark tyre tracks laid under the rear wheels while cornering /
//     curb-scrubbing / hard-braking / launching, fading over SKID_LIFE down to
//     a lingering patina floor (see SKID_PATINA). Each stamp bridges the wheel's
//     last contact point to its current one (end-to-end, no overlap), so it
//     forms one continuous ribbon along the exact wheel path at ANY speed (the
//     engine reports speed normalised, so we measure real travel, not a guess).
//   • Ground shadow — a soft dark plane under the chassis carrying the car's real
//     top-down SILHOUETTE (cabin + wheels), baked once per model (_bakeCarShadow);
//     a soft oval is the fallback. This is the car's WHOLE shadow now: cars don't
//     cast the real sun shadow (the directional map is baked once per track and
//     frozen — a moving car can't be in it), so this stands in for it. Like the boost
//     disk it's a SCENE child whose grid verts are CONFORMED to the road each frame
//     (setCarPose), so it bends with whatever the car drives — flat road, bank, hill,
//     even an inverted loop deck — instead of clipping as a flat quad. Scaled a bit
//     PAST the footprint (SHADOW_OVERSCAN) so the silhouette's penumbra reads beyond
//     the wheels like a real drop shadow.
//     The shadow is centred under the car; the sun was steepened toward vertical (see
//     setTrack `dir`) so the baked TRACK shadows also drop nearly straight down,
//     keeping the two consistent.
// The car shadow's silhouette is SOFT (a blurred, penumbra-heavy bake), so although its
// opaque core already matches a real cast shadow's darkening (~0.85× the lit road, measured
// against the loop's cast shadow), the parts that read around the car are faded penumbra and
// looked lighter than the loop's harder-edged shadow. Raise the opacity so that VISIBLE
// penumbra reads as dark as the loop shadow; the over-dark core is hidden under the car.
const UNDER_AO_OPACITY = 0.55;
const UNDER_AO_COLOR = 0x171513;   // near-black warm, a touch deeper than the skid scuffs so the blob carries as a shadow
const SHADOW_OVERSCAN = 1.45;      // blob scale past the car footprint → soft penumbra beyond the wheels
// Load shift: the harder the body pitches (brake dive / throttle squat), the closer the
// chassis presses to the road — darken the shadow a little with |pitch| so braking visibly
// plants the car. A small cue ON TOP of the track-matched base. Starting value.
const AO_LOAD_GAIN = 0.08;
// NOTE: body "road feel" vibration was tried and removed — a speed-scaled
// suspension murmur (twin sines, ±0.005 then ±0.0017) plus a kerb-scrub shudder.
// Even at 1/3 amplitude it read as a rendering bug/jitter from the chase cam,
// not as suspension responding to the road. Contact evidence stays with the
// event-driven cues instead: brake dive/squat, the AO load shift, and the skids.
// NOTE: under-wheel dust was attempted FOUR ways and removed for good — the
// concept doesn't fit this game, don't re-propose it:
//   1. curb-scrub puffs, per-frame emission — saturated into impact smoke on
//      wall hits (read as damage, which the game doesn't have);
//   2. soft sprite blobs on clean driving — read as miniature CLOUDS (the
//      clouds' exact visual language);
//   3. faceted low-poly chips — read as kicked-up STONES;
//   4. fine multi-speck particle spray (one Points buffer, gravity arcs) —
//      correct "dust" idiom, still rejected: not wanted on an asphalt toy road.
// Grounding on straights is carried by the contact cues that DID land: the
// underbody shading + load shift, brake dive/squat, skid marks + patina, and
// the centre dash line streaming past.

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

// Ground-conform: each frame we raycast the rendered track under the front + rear
// axles and drop the car onto it, so the wheels ride ON the road over bumps/hills
// (the centreline only approximates the GLB, so following it directly clips the
// body in). The model's wheel-bottom sits at the group origin, so RIDE_HEIGHT is
// the SIGNED gap from wheel to road — keep it tiny. A slightly NEGATIVE value
// sinks the contact patch a hair into the deck, killing the last of the
// "floating" look. The underbody AO disk tracks the road regardless: it offsets
// by −RIDE_HEIGHT (see addCar), so the shadow stays planted on the asphalt
// whether the wheel hovers above the road or is pushed a touch into it.
const RIDE_HEIGHT = -0.004;
// Boost circle: a filled teal disk CONFORMED to the road under a boosting car (see
// setCarPose). `SEG` angular × `RINGS` radial samples — each raycast onto the deck
// per frame, so keep them modest. The intermediate ring lets the disk bend with the
// road. LIFT sits it a hair above the asphalt (with polygonOffset) to kill z-fighting;
// RAY_UP is how far out along the surface normal the conform ray starts before casting
// back down toward the road.
const BOOST_DISK_SEG = 16;
const BOOST_DISK_RINGS = 2;
const BOOST_DISK_LIFT = 0.02;
const BOOST_RAY_UP = 1.6;
// Car ground shadow: a SILHOUETTE-textured grid CONFORMED to the road like the boost disk
// (see setCarPose), so it bends through loops / crests / ramps instead of clipping as a
// flat quad. SEG_W×SEG_L cells → (SEG_W+1)(SEG_L+1) verts raycast onto the deck per car per
// frame; the footprint is small so a coarse grid bends smoothly. Reuses BOOST_DISK_LIFT/
// BOOST_RAY_UP and the _conformDiskVert raycast.
const SHADOW_SEG_W = 2;
const SHADOW_SEG_L = 3;
// Ride-height smoothing rate (1/s) for the damped offset from the centreline (see
// setCarPose). Applied as 1 - exp(-RIDE_DAMP·dt) so it's frame-rate-independent;
// ~18 reproduces the old per-frame 0.25 lerp at 60fps but stays stable at 30fps.
const RIDE_DAMP = 18;

// Held-item display: a fixed square slot on the cell HUD shows an ICON (not text).
// Labels are kept for the slot's tooltip/aria. Boost is inline SVG; banana is a
// 2D render of the actual Kenney item-banana GLB, baked offline like the car
// picker thumbs (scripts/capture-item-icon.js → assets/toycar/thumbs/).
const ITEM_LABELS = { boost: 'BOOST', banana: 'BANANA', rocket: 'ROCKET', monster: 'MONSTER' };
const ITEM_ICONS = {
  boost: '<svg viewBox="0 0 24 24" fill="none" stroke="#12a99a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,13.5 12,7.5 19,13.5"/><polyline points="5,18.5 12,12.5 19,18.5"/></svg>',
  banana: '<img src="/assets/toycar/thumbs/item-banana.png" alt="" draggable="false" decoding="async">',
  // Toy rocket: cream body (red outline), blue porthole, red fins, orange flame — the
  // 2D echo of the in-race procedural model (matched to the same toy palette). Inline
  // SVG like boost, so no baked asset / CSP change is needed.
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="#e6492d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.2c2.7 2.3 4 5.4 4 9.3 0 2-.5 3.8-1.3 5.2H9.3C8.5 15.3 8 13.5 8 11.5c0-3.9 1.3-7 4-9.3z" fill="#fff3e0"/><circle cx="12" cy="9.2" r="1.5" fill="#2d9cdb" stroke="none"/><path d="M8.2 14.2 5.5 16.6l.3 3 2.9-1.4M15.8 14.2l2.7 2.4-.3 3-2.9-1.4z" fill="#e6492d"/><path d="M10.3 19.6c.5 1.3 1.7 2.2 1.7 2.2s1.2-.9 1.7-2.2" stroke="#f2784b"/></svg>',
  // Monster truck: a chunky cab on a high frame over two fat tyres — the 2D echo of
  // the in-race transform (gunmetal frame, purple cab nod to the kit body, dark
  // tyres). Inline SVG like boost/rocket, so no baked asset / CSP change is needed.
  monster: '<svg viewBox="0 0 24 24" fill="none" stroke="#3a3f47" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11.5h14l-1.3-3.2a1.6 1.6 0 0 0-1.5-1H7.8a1.6 1.6 0 0 0-1.5 1L5 11.5z" fill="#7b4fc0"/><path d="M3.5 11.5h17v2.2a1.4 1.4 0 0 1-1.4 1.4H4.9a1.4 1.4 0 0 1-1.4-1.4z" fill="#565b63"/><circle cx="7.2" cy="17.4" r="3.1" fill="#2b2f36" stroke="#1c1f24"/><circle cx="16.8" cy="17.4" r="3.1" fill="#2b2f36" stroke="#1c1f24"/><circle cx="7.2" cy="17.4" r="1.1" fill="#aeb4bd" stroke="none"/><circle cx="16.8" cy="17.4" r="1.1" fill="#aeb4bd" stroke="none"/></svg>'
};
const ITEM_KEYS = Object.keys(ITEM_ICONS);

// The exact per-car handles setCarPose / SkidMarks read each frame. Swapping these (and
// the visible model) IS the whole monster transform — everything else (the chase cam,
// boost disk, ground shadow, HUD) is model-agnostic and just follows. See setCarMonster.
const MONSTER_HANDLE_KEYS = ['car', 'body', 'bodyBaseQuat', 'frontWheels', 'backWheels', 'allWheels', 'baseYaw', 'pitchSign', 'wheelbase', 'wheelRadius', 'skidWidth', 'footW', 'footL'];

// Transform cue: the rig springs from small to full (ease-OUT-back, a clean overshoot) on the
// way IN, and on lapse shrinks back the SAME way over the SAME duration with an ease-IN-back
// anticipation — a little "jitter" where it bulges a touch before deflating. The grow/shrink
// alone is the cue: no burst FX (an earlier fireball + ring read as a violent explosion).
const MONSTER_POP_TIME = 0.34;     // grow-in AND shrink-out duration (s) — same for both
const MONSTER_POP_START = 0.5;     // scale the rig grows from / shrinks back to before the model swap
const MONSTER_GROW_BACK = 1.70158; // ease-out-back overshoot on the way in (the grow looks good — leave it)
const MONSTER_SHRINK_BACK = 2.8;   // ease-in-back anticipation on the way out — higher = more pre-shrink jitter
// Occlusion fade: a monster truck is big and tall, so in a split-screen cell it can loom in front
// of that cell's own car (between the close, elevated chase cam and the car) and hide it. Fade it
// to MONSTER_FADE_OPACITY IN THAT CELL ONLY (per-cell — the scene renders once per camera). The
// test is pure proximity: the monster is in FRONT of the camera, CLOSER to it than the car (so
// between cam and car, not beyond it), and within MONSTER_BLOCK_DIST of the car. (Screen-projection
// of the monster's centre misreads here — its ground origin projects off-frame while its tall body
// fills it — so distance-in-front is the reliable signal.)
const MONSTER_FADE_OPACITY = 0.5;  // how see-through a view-blocking monster goes
const MONSTER_BLOCK_DIST = 3.0;    // world-units: a monster this close to the car, in front of it, counts as blocking

export class SceneRenderer {
  constructor(container, colors) {
    this.container = container;
    this.colors = colors || ['#e6492d'];
    this.protos = new Map();
    this.cars = new Map();      // id -> { group, plate, chase, cam, label, pose }
    this._plateAnchors = new Map(); // model name -> { z, y, w } rear-plate placement (per model)
    this._order = [];           // stable cell order
    this._running = false;
    this._last = 0;
    // Lobby orbit (set true by the display in the lobby). Start at the same iso
    // bearing the static overview used so the first frame matches.
    this.orbit = false;
    this._orbitAngle = Math.atan2(0.9, 0.35);
    // User-driven overview camera (OrbitControls), lazily wired by
    // enableUserCamera() for the standalone track preview. Null in the live game
    // and the gallery grid, where the turntable / chase cams own the camera.
    this.controls = null;
    // Offscreen MSAA sample count (?msaa=0|2|4), read before _initThree since the
    // present target is built from it. MSAA was the single biggest GPU cost (≈5.4ms/
    // frame at 4× on a 12MP buffer, vs 1.1ms with none — measured via GPU timer
    // query). The plate — the one thin feature that needed it — now self-antialiases
    // via its soft feathered edge, so we default MSAA OFF; the chunky toy geometry
    // tolerates it. Override with ?msaa=2 / ?msaa=4 if wanted.
    const msaa = parseInt(new URLSearchParams(location.search).get('msaa'), 10);
    this._msaaSamples = Number.isFinite(msaa) ? Math.max(0, Math.min(4, msaa)) : 0;
    // ?bbox=1 → draw collision/trigger outlines for oil, boost pads, item boxes,
    // bananas, and cars (debug aid; see render/TrackProps.js). Off by default.
    this._bbox = (() => { try { return new URLSearchParams(location.search).get('bbox') === '1'; } catch (_) { return false; } })();
    this._initThree();
    this._initOverlay();
    this._initCarFx();
    this.skids = new SkidMarks(this.scene);
    this.props = new TrackProps(this.scene, this.protos, this._bbox);
    this._fps = new FpsMeter(this.container);
    this._groundRay = new THREE.Raycaster();
    this._groundRay.far = 14; // cast 6 above refY, reach ~8 below — never escapes the track
    this._rayFrom = new THREE.Vector3();
    this._rayDown = new THREE.Vector3(0, -1, 0);
    this._headFlat = new THREE.Vector3();  // car heading flattened to horizontal (probe placement)
    this._frameDt = 1 / 60;                 // last frame dt (set in _loop; setCarPose reads it)
    this._timeScale = 1;                    // DEBUG slow-mo: _loop scales dt by this (1 = normal); see setTimeScale
    this._normalMat = new THREE.Matrix3(); // for road-tile world normals
    this._hitNormal = new THREE.Vector3();
    // Spatial bucket for the ground-conform raycast: a grid (x,z) -> tiles
    // overlapping that cell, built in setTrack. _roadHitY then casts only against
    // the 1-few tiles under the car instead of walking every tile in the track —
    // the per-cast cost was growing with track length (setCarPose's hot path).
    this._collideGrid = null;
    this._collideCell = 6; // world units per cell (~tile-sized; tracks use SCALE=2)
    // Scratch objects reused every frame so the per-car hot path (setCarPose)
    // allocates NOTHING — steady-state garbage was forcing GC pauses that showed
    // up as frame-time spikes (the stutter under load). (The chase camera owns its
    // own scratch in ChaseCamera.js.)
    this._sx = new THREE.Vector3();
    this._syy = new THREE.Vector3();
    this._sBasis = new THREE.Matrix4();
    this._dsV = new THREE.Vector3();       // scratch for the per-frame travel delta (wheel roll)
    // Boost-disk conform: a dedicated raycaster (cast along the surface normal, not
    // straight down — so it works on a loop's wall/ceiling) plus the scratch vectors
    // that rewrite the disk's verts onto the road each frame. All reused → no GC.
    this._conformRay = new THREE.Raycaster();
    this._conformRay.far = BOOST_RAY_UP + 4;
    this._conformDir = new THREE.Vector3();
    this._diskHit = new THREE.Vector3();
    this._diskRight = new THREE.Vector3();
    this._diskFwd = new THREE.Vector3();
    this._diskRadial = new THREE.Vector3();
    this._diskMid = new THREE.Vector3();
    this._diskOrigin = new THREE.Vector3();
    this._diskBase = new THREE.Vector3();
    this._shR = new THREE.Vector3(); // car-shadow conform: in-surface right axis, spun by the whirl
    this._shF = new THREE.Vector3(); // car-shadow conform: in-surface forward axis, spun by the whirl
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

  // Like _roadHitY but casts along an arbitrary `axis` (the car's surface normal)
  // instead of straight down, keeping only the road DECK — faces roughly square to
  // the cast axis — so a loop wall, kerb or bank doesn't fool it. Used to conform
  // the boost disk onto the road wherever the track points, including the inside
  // of a loop where a straight-down probe is meaningless. `origin` starts out along
  // +axis above the surface; the ray runs back down −axis. Picks the hit nearest
  // `near` (the tangent-plane sample) to resolve stacked decks. Returns a shared
  // scratch point (copy it before the next call) or null when off-track.
  _roadHitAlong(origin, axis, near) {
    const cands = this._collideGrid && this._collideGrid.get(this._cellKey(Math.floor(near.x / this._collideCell), Math.floor(near.z / this._collideCell)));
    if (!cands) return null;
    this._conformDir.copy(axis).multiplyScalar(-1);
    this._conformRay.set(origin, this._conformDir);
    const hits = this._conformRay.intersectObjects(cands, true);
    let best = null, bestErr = Infinity;
    for (const h of hits) {
      if (h.face) {
        this._normalMat.getNormalMatrix(h.object.matrixWorld);
        const d = this._hitNormal.copy(h.face.normal).applyNormalMatrix(this._normalMat).normalize().dot(axis);
        if (Math.abs(d) < 0.35) continue; // skip near-vertical faces (kerbs/walls)
      }
      const err = h.point.distanceTo(near);
      if (err < bestErr) { bestErr = err; best = this._diskHit.copy(h.point); }
    }
    return best;
  }

  // Snap one boost-disk vertex onto the road and write it into `arr` at `vi`. The
  // tangent-plane sample is in this._diskMid (set by the caller); cast from a touch
  // out along `axis` (the surface normal), drop onto the deck, and lift a hair so it
  // sits flush without z-fighting. Falls back to the tangent point when off-track. A
  // method (not a per-frame closure) so the hot path allocates nothing.
  _conformDiskVert(arr, vi, axis) {
    this._diskOrigin.copy(this._diskMid).addScaledVector(axis, BOOST_RAY_UP);
    const hit = this._roadHitAlong(this._diskOrigin, axis, this._diskMid); // road point, or null off-track
    this._diskBase.copy(hit || this._diskMid).addScaledVector(axis, BOOST_DISK_LIFT);
    arr[vi] = this._diskBase.x; arr[vi + 1] = this._diskBase.y; arr[vi + 2] = this._diskBase.z;
  }

  // Shared textures/materials for the per-car visual effects (boost disk, wind
  // streaks, underbody shading). These are the templates; addCar clones the ones
  // that must animate per instance.
  _initCarFx() {
    this._diskTex = makeBoostDiskTexture(); // radial falloff for the filled boost circle
    this._streakTex = makeStreakTexture(); // boost wind streak
    this._streakGeo = makeStreakGeometry();
    // Template material for the boost wind streaks (cloned per streak so each can
    // fade independently). fog off — a streak is a near-camera effect.
    this._streakMat = new THREE.MeshBasicMaterial({
      map: this._streakTex, color: STREAK_COLOR, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false
    });
    // Car ground shadow (see the cue notes up top): shared geometry, but the MATERIAL is
    // cloned per car in addCar — its opacity animates with body pitch (the load-shift cue),
    // so cars can't share one. Its MAP is a per-MODEL baked top-down silhouette of the car
    // (see _bakeCarShadow), cached in _carShadowTex; _aoTex is the soft-oval fallback if a
    // bake fails. This template carries the tint/opacity/offset.
    this._aoTex = makeUnderShadowTexture();
    // A tessellated grid (not a flat quad) so it can be CONFORMED to the road per frame
    // (see setCarPose) and never clips on a curving deck. Cloned per car (each conforms its
    // own verts). _aoBaseXY holds the rest local (x,y) ∈ [-0.5,0.5] of every grid vertex,
    // shared by all cars to recompute world positions each frame.
    this._aoGeo = new THREE.PlaneGeometry(1, 1, SHADOW_SEG_W, SHADOW_SEG_L);
    {
      const p = this._aoGeo.getAttribute('position');
      this._aoBaseXY = new Float32Array(p.count * 2);
      for (let i = 0; i < p.count; i++) { this._aoBaseXY[i * 2] = p.getX(i); this._aoBaseXY[i * 2 + 1] = p.getY(i); }
    }
    this._carShadowTex = new Map(); // model name → baked silhouette CanvasTexture (or null on failure)
    this._aoMat = new THREE.MeshBasicMaterial({
      map: this._aoTex, color: UNDER_AO_COLOR, transparent: true, opacity: UNDER_AO_OPACITY,
      depthWrite: false, side: THREE.DoubleSide, // conform writes world verts wound front-DOWN (right×fwd = −u); DoubleSide so it isn't backface-culled from above (same as the boost disk)
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
  }

  // Bake a soft top-down SILHOUETTE of a car model into a texture, so its ground shadow
  // has the car's real outline (cabin + wheels poking out) instead of a generic oval —
  // the "more realistic" shadow. Rendered ONCE per model (cached): an orthographic camera
  // straight above the model paints a flat-white mask on transparent, framed to the same
  // footprint×SHADOW_OVERSCAN the shadow quad uses (so the silhouette lands at footprint
  // size with room for the penumbra), then read back and blurred on a 2D canvas for the
  // soft edge. The car's length runs up the texture (+Z → vertical) and width across
  // (+X → horizontal), matching the quad's UVs. `rotationY` is the car's posed yaw so the
  // silhouette aligns with the footW/footL the quad is scaled to.
  _bakeCarShadow(model, proto, rotationY) {
    if (this._carShadowTex.has(model)) return this._carShadowTex.get(model);
    let tex = null;
    try {
      const r = this.renderer;
      const tmp = new THREE.Scene();
      const c = proto.clone(true);
      c.rotation.y = rotationY;
      tmp.add(c);
      tmp.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(c);
      const w = (bb.max.x - bb.min.x) || 0.1, l = (bb.max.z - bb.min.z) || 0.1;
      const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const hw = (w / 2) * SHADOW_OVERSCAN, hl = (l / 2) * SHADOW_OVERSCAN;
      const cam = new THREE.OrthographicCamera(-hw, hw, hl, -hl, 0.01, (bb.max.y - bb.min.y) + 2);
      cam.position.set(cx, bb.max.y + 1, cz);
      cam.up.set(0, 0, 1);            // world +Z (car length) → texture vertical
      cam.lookAt(cx, bb.min.y, cz);
      const TW = 128, TH = Math.max(16, Math.round(TW * (hl / hw)));
      const rt = new THREE.WebGLRenderTarget(TW, TH);
      const override = new THREE.MeshBasicMaterial({ color: 0xffffff }); // flat unlit → pure silhouette
      tmp.overrideMaterial = override;
      const prevRT = r.getRenderTarget();
      const prevC = r.getClearColor(new THREE.Color()), prevA = r.getClearAlpha();
      const prevShadow = r.shadowMap.enabled;
      r.shadowMap.enabled = false; // don't let this render consume setTrack's pending track-shadow bake
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(tmp, cam);
      const px = new Uint8Array(TW * TH * 4);
      r.readRenderTargetPixels(rt, 0, 0, TW, TH, px);
      r.setRenderTarget(prevRT);
      r.setClearColor(prevC, prevA);
      r.shadowMap.enabled = prevShadow;
      tmp.overrideMaterial = null;
      override.dispose(); rt.dispose();
      // White-on-transparent mask (force rgb white so blurring the edge fades ALPHA only,
      // no dark fringe), then blur on a 2D canvas for the soft penumbra. The footprint sits
      // inside the SHADOW_OVERSCAN border, so the blur tail has room and never clips.
      const mask = document.createElement('canvas'); mask.width = TW; mask.height = TH;
      const mctx = mask.getContext('2d');
      const img = mctx.createImageData(TW, TH);
      for (let i = 0; i < TW * TH; i++) {
        img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = px[i * 4 + 3];
      }
      mctx.putImageData(img, 0, 0);
      const out = document.createElement('canvas'); out.width = TW; out.height = TH;
      const octx = out.getContext('2d');
      octx.filter = `blur(${Math.max(2, Math.round(TW * 0.022))}px)`; // tight penumbra: a crisp shadow edge near the loop's hard cast shadow, not a wide soft ring
      octx.drawImage(mask, 0, 0);
      tex = new THREE.CanvasTexture(out);
      tex.colorSpace = THREE.SRGBColorSpace;
    } catch (e) {
      console.warn('[shadow] car silhouette bake failed for', model, e);
      tex = null;
    }
    this._carShadowTex.set(model, tex);
    return tex;
  }

  // Wipe every skid mark + the accumulated patina (track change / fresh race).
  clearSkids() { this.skids.clear(); }

  // Per-frame prop reconcile from the engine snapshot (item boxes, bananas, ?bbox).
  syncProps(snap) { this.props.sync(snap); }

  // Spawn a rocket-impact burst at a car (the detonation point). Driven from the engine's
  // rocket spin event; no-op if the car has no render mesh (e.g. just removed).
  rocketImpact(id) {
    const c = this.cars.get(id);
    if (c && c.group) this.props.spawnImpact(c.group);
  }

  // Detonate a timed-out rocket where it died — same burst as a hit, but at a track point (s, lat)
  // instead of on a car. Driven from the engine's rocket_expire event (a whiff self-destructing).
  rocketExpire(s, lat) { this.props.spawnImpactAt(s, lat); }

  // Restore every warning cone to its home pose (new game / fresh race).
  resetCones() { this.props.resetCones(); }

  _initThree() {
    // antialias:false — the whole scene renders through the offscreen target (_rtScene,
    // optional MSAA via samples = _msaaSamples, off by default); edge AA comes from the
    // FXAA pass folded into _present. The canvas framebuffer only ever receives the
    // full-screen present quad, so canvas AA would be a no-op (and an unused multisample
    // backbuffer).
    const r = new THREE.WebGLRenderer({ antialias: false });
    // Opt-in resolution cap (?dpr=0.5): gallery preview iframes lay out at full logical
    // size (1920×1080) and are only shrunk by a parent CSS transform, which changes
    // neither innerWidth nor devicePixelRatio — so without the cap each thumbnail
    // renders and RETAINS 4K-class buffers (~100MB of framebuffers per card on a 2×
    // screen) for a ~500px card. The gallery passes dpr=0.5; the card's "open" link
    // strips it, so a real tab stays full-res. Guarded > 0: dpr=0 would allocate a
    // zero-sized drawing buffer.
    const dprCap = (() => { try { return parseFloat(new URLSearchParams(location.search).get('dpr')); } catch (_) { return NaN; } })();
    r.setPixelRatio(Math.min(devicePixelRatio, Number.isFinite(dprCap) && dprCap > 0 ? dprCap : 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.autoClear = false; // we clear once per frame, then render N viewports
    // Real shadow map for the STATIC TRACK only: the fixed track geometry casts a soft
    // shadow the road RECEIVES, so it wraps over bumps/hills/overpasses with no clipping.
    // It's baked ONCE per track (setTrack) and frozen — moving cars/props don't cast (they
    // carry ground blobs), so nothing needs a per-frame rebuild.
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // soft PCF; the Soft variant is deprecated in our three build
    // autoUpdate OFF + needsUpdate raised exactly once (in setTrack): the gate
    // (WebGLShadowMap) reads renderer.shadowMap — NOT light.shadow — so with autoUpdate
    // off and needsUpdate cleared after the bake, the whole-track shadow pass never runs
    // again. (Previously _loop raised needsUpdate every frame to capture moving cars; now
    // that cars don't cast, that per-frame whole-track re-raster is gone entirely.)
    r.shadowMap.autoUpdate = false;
    this.container.appendChild(r.domElement);
    this.renderer = r;

    // No renderer tone mapping: it would be ignored on our offscreen pass anyway
    // (Three only tone-maps when rendering straight to the canvas). The composite
    // shader does exposure + linear→sRGB explicitly instead.
    r.toneMapping = THREE.NoToneMapping;

    // Per-cup BIOME: the renderer boots on the canonical grass theme (so the lobby
    // diorama, before any track is picked, looks exactly as it always did). setTrack
    // re-skins to the picked track's cup biome via _applyTheme (guarded: a grass-cup
    // track is a no-op, so existing cups stay byte-identical). `_themeFog` is the colour
    // the three fog profiles + the background share; it tracks the active biome.
    const baseTheme = THEMES.grass;
    this._theme = baseTheme;
    this._themeFog = baseTheme.fog;
    // Inspector override (set by main.js from ?biome=<name>): when non-null, every track
    // renders in this biome regardless of its cup. Null in normal play → cup decides.
    this.biomeOverride = null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(baseTheme.fog);
    // Two fog profiles, chosen per-frame by camera mode (see _loop). The RACE fog is a
    // tight atmospheric tail for the close chase cam; the OVERVIEW fog (built per track in
    // setTrack) is pushed out so the lobby/gallery turntable can frame the WHOLE circuit
    // crisply while still dissolving the finite ground plane's edge + horizon into the sky
    // (fog colour == sky colour). Both are THREE.Fog of the same type, so swapping between
    // them only changes near/far uniforms — it never recompiles materials (no hitch on
    // weak GPUs). setFog(false) forces fog off entirely (gallery grid / inspector).
    this._raceFog = new THREE.Fog(this._themeFog, RACE_FOG_NEAR, RACE_FOG_FAR);
    this._overviewFog = null;
    this._fogEnabled = true;
    scene.fog = this._raceFog;
    this.scene = scene;

    // Sky dome, drifting clouds, horizon hills, toy lighting and the ground plane —
    // track-independent, built once (render/environment.js) for the base biome. `_env`
    // keeps the recolourable handles (sky/hemi/hills/ground) for _applyTheme.
    const env = buildEnvironment(scene, baseTheme);
    this._env = env;
    this._clouds = env.clouds; // drifted in _loop
    this._haze = env.haze;     // low dust banks (canyon) — drifted in _loop, pushed out in setTrack
    this._water = env.water;   // sea ring (beach) — pushed out with the hills in setTrack
    this._birds = env.birds;   // circling fliers (gulls/vultures/butterflies/plane) — stepped in _loop
    this._birdT = 0;           // shared soaring phase
    this._kites = env.kites;   // anchored shore kites (beach) — stepped in _loop
    this._balloon = env.balloon; // far-field hot-air balloon (grass/sunset) — stepped in _loop
    this._paperPlane = env.paperPlane; // 3D paper dart (playroom) — stepped in _loop
    this._ambient = env.ambient; // ambient particles (flakes/motes/sand/pollen) — stepped in _loop, spread scaled in setTrack
    this._trackAnims = [];     // per-track animated set-pieces (windmill rotor, toy train, chimney smoke) — rebuilt with the track, stepped in _loop
    this._key = env.key;       // shadow camera fitted per-track in setTrack
    this.ground = env.ground;
    this._hills = env.hills;   // horizon-hill ring; pushed out past the track in setTrack

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

    // near 4 (not 0.1) so the depth buffer keeps real precision out at the horizon: the
    // overview orbits ~80-190u from everything, and the far hill domes sit ON the lawn
    // (their bases sunk into it), so a 0.1/600 frustum (ratio 6000) left their waterline
    // z-fighting the ground and shimmering as the camera moved. far 1500 also clears the
    // sky dome (radius 420, up to ~600u from an offset camera) which 600 was clipping. The
    // free-cam inspector drops near back to 0.1 in enableUserCamera so it can fly in close.
    this.overview = new THREE.PerspectiveCamera(50, this._aspect(), 4, 1500);
    this.overview.position.set(25, 22, 25);
    this._ovPos = this.overview.position.clone();
    this._ovTarget = new THREE.Vector3();
    // Overview-orbit framing (radius/height), computed per-track in setTrack and ridden by
    // the gallery turntable (`this.orbit`) — also the lobby's fallback before the bbox path.
    this._ovRadius = null;
    this._ovHeight = 0;
    // Lobby perimeter orbit (the lobby sets bboxOrbit=true): sweep an ellipse around the
    // track's bounding box instead of the gallery's whole-track circle.
    this.bboxOrbit = false;
    this._bbAx = null;     // ellipse semi-axes (X/Z), fitted to the bbox in setTrack
    this._bbAz = null;
    this._bbHeight = 0;
    this._bbFog = null;

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
    // encode — then run FXAA on the graded image and write straight to the canvas.
    // toneMapped=false so Three doesn't touch our output.
    //
    // FXAA (in lieu of MSAA): the scene is flat-shaded toy geometry painted with
    // VERTEX COLOURS (the swept road ribbon's white edge lines + red/white kerb), so the
    // white↔asphalt boundary is a hard geometric edge that crawls and jags when seen
    // near edge-on — and MSAA is off by default (it was the single biggest GPU cost,
    // ~5.4ms/frame at 4×). We already pay for this full-screen present pass, so we fold a
    // single-pass FXAA into it: ~9 extra taps (~0.4ms) vs MSAA's ~5.4ms, ~10× cheaper.
    // FXAA is a perceptual (gamma-space) edge filter, so it runs on `graded()` — the
    // exposed, sRGB-encoded colour that actually reaches the panel — not the linear
    // buffer. HUD labels are DOM overlays (not in the canvas), so text stays crisp.
    this._matPresent = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: {
        tScene: { value: null },
        exposure: { value: DEF_EXPOSURE },
        texel: { value: new THREE.Vector2(1 / W, 1 / H) }, // 1/drawing-buffer px, kept in sync by _resizePost
      },
      vertexShader: VERT,
      fragmentShader: `
        uniform sampler2D tScene; uniform float exposure; uniform vec2 texel;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c){
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        // The displayed colour at a uv: exposure + linear→sRGB, clamped. FXAA blends
        // these, so every tap is the real on-panel colour (correct sRGB, not an approx).
        vec3 graded(vec2 uv){ return clamp(toSRGB(texture2D(tScene, uv).rgb * exposure), 0.0, 1.0); }

        // Compact FXAA (Timothy Lottes' console variant). Detects the local edge from a
        // 5-tap luma cross, then blends along it; falls back to the unfiltered centre on
        // flat areas, so interiors stay sharp and only contrast edges soften.
        const float SPAN_MAX = 8.0, REDUCE_MUL = 1.0 / 8.0, REDUCE_MIN = 1.0 / 128.0;
        const vec3 LUMA = vec3(0.299, 0.587, 0.114);
        void main(){
          vec3 mC = graded(vUv);
          vec3 nw = graded(vUv + vec2(-1.0, -1.0) * texel);
          vec3 ne = graded(vUv + vec2( 1.0, -1.0) * texel);
          vec3 sw = graded(vUv + vec2(-1.0,  1.0) * texel);
          vec3 se = graded(vUv + vec2( 1.0,  1.0) * texel);
          float lM = dot(mC, LUMA);
          float lNW = dot(nw, LUMA), lNE = dot(ne, LUMA), lSW = dot(sw, LUMA), lSE = dot(se, LUMA);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
          float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
          float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
          dir = clamp(dir * rcp, -SPAN_MAX, SPAN_MAX) * texel;

          vec3 rgbA = 0.5 * (graded(vUv + dir * (1.0 / 3.0 - 0.5)) + graded(vUv + dir * (2.0 / 3.0 - 0.5)));
          vec3 rgbB = rgbA * 0.5 + 0.25 * (graded(vUv + dir * -0.5) + graded(vUv + dir * 0.5));
          float lB = dot(rgbB, LUMA);
          // rgbB samples the wider span; if it overshoots the local luma range it has
          // strayed off the edge, so use the safer narrow blend rgbA.
          gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
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
    this._matPresent.uniforms.texel.value.set(1 / w, 1 / h); // FXAA samples in drawing-buffer texels
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

  // Chunky ink rules between split-screen cells (.cell-divider, display.css).
  // Default ON; main.js flips showDividers from the debug panel (?dividers=0)
  // so the look can be A/B'd at a party. Rebuilt only when the grid layout (or
  // the toggle) changes; the overview branch hides them with the other overlays.
  _syncDividers(cols, rows, cw, ch, W, H) {
    const sig = this.showDividers === false ? 'off' : `${cols}x${rows}:${cw}x${ch}`;
    if (sig === this._divSig) return;
    this._divSig = sig;
    for (const d of this._dividers || []) d.remove();
    this._dividers = [];
    if (this.showDividers === false) return;
    const mk = (x, y, w, h) => {
      const d = document.createElement('div');
      d.className = 'cell-divider';
      d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
      this.overlay.appendChild(d);
      this._dividers.push(d);
    };
    for (let c = 1; c < cols; c++) mk(c * cw - 2, 0, 4, H);
    for (let r = 1; r < rows; r++) mk(0, r * ch - 2, W, 4);
  }
  _hideDividers() {
    if (this._divSig === 'hidden' || !(this._dividers || []).length) return;
    this._divSig = 'hidden';
    for (const d of this._dividers) d.remove();
    this._dividers = [];
  }

  _aspect() { return window.innerWidth / Math.max(1, window.innerHeight); }
  _onResize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._resizePost();
    // setSize/_resizePost reallocate (and clear) the drawing buffer + render target. A
    // running loop repaints on the next rAF, but a preview idled by pauseAfterFrame would
    // stay blank forever (frozen cards have no play button) — repaint one frame, re-idle.
    if (!this._running) { this.start(); this.pauseAfterFrame(); }
  }

  // Force the distance fog fully OFF (the gallery grid + free-cam inspector want the whole
  // circuit with zero haze). When left enabled (the default), the render loop picks the
  // right profile by camera mode each frame — tight race fog for the chase cams, pushed-out
  // overview fog for the lobby/orbit turntable (see _loop). Takes effect next frame.
  setFog(enabled) {
    this._fogEnabled = enabled;
  }

  // Grab the CURRENT frame as a frozen still (a detached 2D canvas). The lobby uses this to
  // crossfade one track STRAIGHT into the next: snapshot track A, rebuild the live scene to
  // track B underneath, then fade the still out so B emerges through A — no dip through the
  // diorama. We re-grade the last rendered frame straight to the canvas (_present reads the
  // still-intact _rtScene) and copy it back SYNCHRONOUSLY, in this same task, before the
  // browser presents+clears the drawing buffer — so no preserveDrawingBuffer is needed.
  // Returns null if there's nothing to capture yet (caller falls back to the diorama reveal).
  snapshot() {
    if (!this.renderer || !this._rtScene) return null;
    this._present();
    const src = this.renderer.domElement;
    if (!src.width || !src.height) return null;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // Hand the overview camera to the viewer: drag to LOOK AROUND in place, scroll
  // to fly forward, WASD to glide and Q/E to drop/rise. Used by the standalone
  // track preview (the track gallery's "open ↗" — i.e. NOT the grid iframe) so a
  // track can be inspected up close. It replaces the auto-orbit turntable: once
  // `this.controls` exists the render loop ticks the inspector instead of posing
  // the camera. OrbitControls supplies the rotate-drag + damping (we re-aim it so
  // it spins around the camera, not the track — see _tickInspectorControls); it's
  // lazy-imported so the live race + gallery-grid path never downloads it. Call
  // AFTER setTrack so the framing fields are populated.
  async enableUserCamera() {
    if (this.controls) return this.controls;
    this.orbit = false; // the viewer drives the camera now — no turntable
    this.overview.near = 0.1; // free-cam can fly right up to geometry; restore the close near plane
    this.overview.updateProjectionMatrix();
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    if (this.controls) return this.controls; // a second call raced us during the import
    const dom = this.renderer.domElement;
    const c = new OrbitControls(this.overview, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.6;
    // Look-around inspector, not an orbit rig: the wheel flies forward (custom
    // handler below), A/D strafe and Q/E rise/dip, so OrbitControls' own zoom &
    // pan are off. Free the pitch so you can look right down at the track or up
    // to the sky (a small epsilon avoids the straight-up/down azimuth flip).
    c.enableZoom = false;
    c.enablePan = false;
    c.minPolarAngle = 0.02;
    c.maxPolarAngle = Math.PI - 0.02;
    // Start from the same iso framing the static overview uses; remember that
    // distance so the fly speed feels the same as the turntable's framing.
    if (this._ovPos) this.overview.position.copy(this._ovPos);
    // Aim at whatever the scenario framed: the track centre for the whole-circuit
    // preview, a feature cluster for the mechanics showcase. Both set _ovTarget.
    c.target.copy(this._ovTarget);
    this._flyDist = this.overview.position.distanceTo(c.target);
    c.update();
    // Cursor affordance: grab while idle, grabbing mid-drag.
    dom.style.cursor = 'grab';
    c.addEventListener('start', () => { dom.style.cursor = 'grabbing'; });
    c.addEventListener('end', () => { dom.style.cursor = 'grab'; });
    // Keyboard fly: WASD glides the rig across the ground, Q drops & E rises.
    // Held keys are collected here and applied each frame in _moveCameraKeys (the
    // render loop), so diagonals and held presses move smoothly + framerate-free.
    const keys = this._camKeys = new Set();
    const HANDLED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
    const editable = (t) => !!t && (t.isContentEditable ||
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    window.addEventListener('keydown', (e) => {
      if (!HANDLED.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editable(e.target)) return; // don't hijack keys typed into a field (e.g. the debug panel)
      keys.add(e.code);
      e.preventDefault(); // claim the key while flying (no default key action)
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    // Stop drifting if focus leaves the tab mid-press (no keyup arrives).
    window.addEventListener('blur', () => keys.clear());
    // Wheel flies the rig forward/back along the look direction (OrbitControls'
    // own zoom is off). Scaled by the framing distance so a notch feels the same
    // near or far; passive:false so we can swallow the page scroll.
    dom.addEventListener('wheel', (e) => {
      if (editable(e.target)) return;
      e.preventDefault();
      const step = Math.max(8, this._flyDist || 30) * 0.0009 * -e.deltaY;
      const fwd = this.overview.getWorldDirection(new THREE.Vector3());
      this.overview.position.addScaledVector(fwd, step);
    }, { passive: false });
    this.controls = c;
    return c;
  }

  // Apply the WASD / QE fly keys for the inspector camera. WASD ride the camera's
  // GROUND-plane forward/right so you skim level over the track; Q drops and E
  // rises (world up). Both are fractions of a framing-anchored reference speed
  // (this._flyDist, so it feels the same everywhere): WASD at 50%, rise/dip at a
  // gentler 25% for fine height tweaks. Rotation is handled separately
  // (_tickInspectorControls), so this only ever translates the camera.
  _moveCameraKeys(dt) {
    const keys = this._camKeys;
    if (!keys || !keys.size) return;
    const cam = this.overview;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    // Forward/right flattened onto the ground; right = fwdFlat × worldUp.
    const fwdFlat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (fwdFlat.lengthSq() < 1e-6) fwdFlat.set(0, 0, -1); // looking straight down
    fwdFlat.normalize();
    const right = new THREE.Vector3(-fwdFlat.z, 0, fwdFlat.x);
    const horiz = new THREE.Vector3();
    if (keys.has('KeyW')) horiz.add(fwdFlat);
    if (keys.has('KeyS')) horiz.sub(fwdFlat);
    if (keys.has('KeyD')) horiz.add(right);
    if (keys.has('KeyA')) horiz.sub(right);
    let vy = 0;
    if (keys.has('KeyE')) vy += 1; // E rises
    if (keys.has('KeyQ')) vy -= 1; // Q drops
    if (horiz.lengthSq() === 0 && vy === 0) return;
    const ref = Math.max(8, this._flyDist || 8) * 0.9 * dt; // framing-anchored reference
    if (horiz.lengthSq() > 0) cam.position.addScaledVector(horiz.normalize(), ref * 0.5); // WASD at 50%
    cam.position.y += vy * ref * 0.25; // rise/dip at 25%
  }

  // Tick the inspector OrbitControls so a rotate-drag spins the view IN PLACE
  // (around the camera's own position) rather than orbiting the track centre.
  // OrbitControls only ever orbits its `target`, so: pin the target a unit ahead
  // of the camera, let update() apply the drag (+ damping), then snap the camera
  // back to where it was — keeping only the freshly-aimed look direction. Zoom &
  // pan are off and WASD/QE/wheel do all translation, so rotation is the only
  // thing update() moves, which makes that restore exact (no orbital drift).
  _tickInspectorControls() {
    const c = this.controls;
    if (!c) return;
    const cam = this.overview, tgt = c.target;
    const D = 1; // pivot offset; cancelled by the restore, so its size is moot
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    tgt.copy(cam.position).addScaledVector(fwd, D);
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    c.update(); // applies the rotate drag + damping; orbits the camera around tgt
    const dir = new THREE.Vector3().subVectors(tgt, cam.position).normalize();
    cam.position.set(px, py, pz);
    tgt.copy(cam.position).addScaledVector(dir, D);
  }

  // Preload the GLBs this scene needs: the car models plus `trackGlbs`, the exact
  // set of track tiles the chosen layout uses. The caller derives that set from
  // track.instances (see main.js), so adding a new piece needs no change here.
  async load(trackGlbs) {
    const loader = new GLTFLoader();
    // The monster-truck base GLB is the chassis+wheels the "monster" item grafts the
    // player's car body onto (built per car on first transform — see setCarMonster).
    const need = [...new Set([...trackGlbs, ...CAR_MODELS, MONSTER_BASE_ASSET, ...SCENERY_MODELS])];
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

  // Re-skin the world to a biome: world dressing (sky/hills/ground/lights) via the
  // environment, then the fog + background colour the renderer owns. Cheap (in-place
  // recolours + cached textures), so switching cups in the lobby has no hitch. Called
  // from setTrack only when the biome actually changes (object-identity guard).
  _applyTheme(theme) {
    applyEnvTheme(this._env, theme);
    this._themeFog = theme.fog;
    this.scene.background.set(theme.fog);
    this._raceFog.color.set(theme.fog);
    // Dusty biomes pull the chase-cam fog in (fogTune < 1 — canyon sand-haze); the
    // perimeter fog gets the same scalar where it's built (setTrack). Overview fog
    // is exempt: the track picker must frame the whole circuit crisply in any air.
    const tune = theme.fogTune || 1;
    this._raceFog.near = RACE_FOG_NEAR * tune;
    this._raceFog.far = RACE_FOG_FAR * tune;
    if (this._overviewFog) this._overviewFog.color.set(theme.fog);
    if (this._bbFog) this._bbFog.color.set(theme.fog);
    this._theme = theme;
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
    this.clearSkids(); // marks/patina are world-space — they belong to the old track
    // Re-skin to this track's cup biome BEFORE building any track geometry: the grass
    // skirt/berms (render/track.js) copy ground.material.map at build time, so the
    // ground texture must already be the biome's. Guarded so a same-biome switch (and
    // every grass-cup track) costs nothing and stays byte-identical.
    const theme = this.biomeOverride || themeForCup(track.cup);
    if (theme !== this._theme) this._applyTheme(theme);
    if (track.groundY != null) this.ground.position.y = track.groundY;
    // Per-track ambient patch (theme.ambientByTrack, keyed on the registry id):
    // the snow cup scales its flurry density per track. Re-applied every switch —
    // the previous track may have patched the same theme's numbers.
    applyAmbient(this._ambient, theme, theme.ambientByTrack && theme.ambientByTrack[track.trackId]);
    // Animated set-pieces (windmill rotor, toy train, chimney smoke) are rebuilt
    // with the track — buildLandmarks registers steppers here, _loop runs them.
    this._trackAnims = [];

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
    // trackGroup itself). The loop below then bakes any remaining GLB scenery (none
    // today — the finish gantry is procedural too, see render/FinishGate.js); the
    // grid/framing/shadow afterwards run on `collide.children` + centreline samples
    // regardless.
    buildRibbonRoad(this, track, collide, theme); // road palette (asphalt/kerbs/planks) is the biome's
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
      // Biome colour-grade on the GLB scenery (none today; FinishGate applies the
      // same grade itself). material.color MULTIPLIES the colormap, so themes use
      // near-white tints — sun-bleach/heat/cold grades, not repaints.
      if (theme.gate) mat.color.set(theme.gate);
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

    buildFinishGate(this, track, theme); // the chequered gantry over the line at s=0
    buildPillars(this, track, theme);  // supports carry the biome's structure tint
    buildHills(this, track);
    buildPoles(this, track, theme);
    buildLoopPoles(this, track, theme);
    buildScenery(this, track, theme); // scenery palette (which props, tints, density) is the biome's

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
    let maxR = 0;
    for (const s of track.centerline.samples) { box.expandByPoint(s.pos); maxR = Math.max(maxR, Math.hypot(s.pos.x, s.pos.z)); }
    // Push the horizon-hill ring (built at radius ~150 about the world origin) out past the
    // track's farthest reach so a large circuit can't drive into the scenery. XZ only (keep
    // the squashed height + base sink); never below 1× (small tracks keep the authored ring).
    // The dust banks ride the SAME factor — they keep drifting among the mesas rather
    // than hanging over (or under) a big circuit. The sea gets its own per-angle fit
    // below, tighter than the hills' so the headlands stay offshore.
    if (this._hills) {
      const sf = Math.max(1, (maxR + 60) / 150);
      this._hills.scale.set(sf, 1, sf);
      // The shoreline is fitted to the track's own outline (see fitWater), not scaled
      // from a circle: it hugs just past the scenery band, so the water starts close
      // enough to survive the race fog from the low chase cam yet never floods the
      // road. Headlands intruding past it become islands — that's the look.
      // (A tidal breathing pulse on this fit was tried and cut — not worth it.)
      fitWater(this._water, track, this.ground.position.y);
      if (this._ambient) {
        this._ambient.scale.set(sf, 1, sf); // particle spread follows the hill push-out
        this._ambient.position.y = this.ground.position.y;
      }
      if (this._haze) for (const h of this._haze) {
        h.position.x = h.userData.home.x * sf;
        h.position.z = h.userData.home.z * sf;
      }
    }
    // Biome landmarks (lighthouse/sailboat/hoodoo/snowman) — AFTER the hills fit
    // above: the offshore pieces anchor to the just-scaled ring and shoreline fit.
    // They join trackGroup, so they're rebuilt/disposed with the track.
    buildLandmarks(this, track, theme);
    this._trackCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.5 + 8;
    // Whole-track fit distance for the gallery turntable (and the lobby's bbox-orbit
    // fallback). The overview fog below derives from the resulting _ovRadius.
    const dist = radius / Math.tan((this.overview.fov * Math.PI / 180) / 2) * 0.9;
    const ovDir = new THREE.Vector3(0.35, 0.8, 0.9).normalize();
    this._ovPos = this._trackCenter.clone().add(ovDir.clone().multiplyScalar(dist));
    this._ovTarget = this._trackCenter.clone();
    // Horizontal radius + height of that iso offset, reused by the lobby/gallery
    // orbit so the moving camera keeps the same framing as the static overview.
    const ovOff = this._ovPos.clone().sub(this._trackCenter);
    this._ovRadius = Math.hypot(ovOff.x, ovOff.z);
    this._ovHeight = ovOff.y;

    // Overview fog profile — the gallery whole-track turntable (and the lobby's bbox-orbit
    // fallback). Reusing the race fog here would veil the far half of a track framed from
    // ~100-190u out, so instead: start the fog just PAST the farthest the track can sit from
    // the orbiting camera — so the whole circuit stays crisp — then dissolve over a WIDE band so the (huge) lawn
    // fades gently into the sky. A narrow band gets compressed into a hard line at the
    // grazing horizon angle; a wide one reads as natural haze. The lawn extends far beyond
    // fogFar (see environment GROUND_SIZE), so there's no plane edge to clamp against.
    // Built once per track (samples are walked here already); the loop just swaps it in
    // (no recompile — same Fog type).
    let maxCamDist = 0;                                   // worst-case camera→track-point distance over a full orbit
    const ringY = this._trackCenter.y + this._ovHeight;   // height of the orbit ring
    for (const s of track.centerline.samples) {
      const horiz = Math.hypot(s.pos.x - this._trackCenter.x, s.pos.z - this._trackCenter.z) + this._ovRadius;
      const d = Math.hypot(horiz, s.pos.y - ringY);       // a sample sitting diametrically opposite the camera
      if (d > maxCamDist) maxCamDist = d;
    }
    const fogNear = maxCamDist + 12;                       // entire track inside near → zero fog on it
    const fogFar = fogNear + Math.max(220, radius * 2);    // wide, gentle dissolve into the sky
    this._overviewFog = new THREE.Fog(this._themeFog, fogNear, fogFar);

    // Lobby perimeter-orbit ellipse (see _loop): hug just outside the track's XZ bbox, so the
    // camera traces the track's overall shape up close (elongated tracks → elongated path).
    const halfX = size.x / 2, halfZ = size.z / 2;
    this._bbAx = halfX + BBOX_CLEARANCE;
    this._bbAz = halfZ + BBOX_CLEARANCE;
    // Height off the AVERAGE half-extent (not the max) so a very elongated track isn't
    // over-elevated into a top-down view on its narrow sides — keeps the tilt low + the
    // open field below the horizon (hazed) rather than a flat empty plane.
    this._bbHeight = BBOX_HEIGHT_K * (halfX + halfZ) * 0.5 + BBOX_HEIGHT_BASE;
    // Perimeter-orbit fog: with the camera hugging the track, keep the near road crisp but
    // haze the open field SOON so the empty grass outside the circuit dissolves into the sky
    // instead of reading as a flat plane (tighter than the whole-track overview fog above).
    // Scaled by the biome's fogTune like the race fog (dusty canyon air thickens here too).
    const fogTune = this._theme.fogTune || 1;
    this._bbFog = new THREE.Fog(this._themeFog,
      55 * fogTune, (55 + Math.max(110, Math.max(halfX, halfZ) * 1.2)) * fogTune);

    // Aim + size the sun's shadow camera to cover the whole track. The light direction
    // is near-VERTICAL (2,12,1.5) — only slightly raked: cars/props no longer cast the
    // sun shadow (they carry centred ground blobs), so the only thing this direction
    // shadows is the static track geometry, and a near-overhead sun drops those track
    // shadows nearly straight DOWN — consistent with the centred blobs — while the small
    // residual rake keeps a little gloss directionality on the plastic. We move the light
    // far out along this direction and FIT the orthographic frustum to the track's
    // bounding box as projected into the light's view (a symmetric box under-covers a
    // large/L-shaped track from an angle — diagonal corners fall outside and the shadow
    // "blinks"; fitting the projected AABB guarantees full coverage). MUST stay in sync
    // with the light's authored position in environment.js (buildEnvironment).
    const k = this._key;
    const dir = new THREE.Vector3(2, 12, 1.5).normalize();
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
    // Refit the acne guard to THIS track's shadow texel size: the frustum above scales
    // with the track, so a fixed normalBias tuned on small circuits under-biases big
    // stunt layouts — steep receivers (loop interiors, banked walls) then show banded
    // self-shadowing. ~2.5 texels clears the banding; 0.06 stays the small-track floor.
    const texel = Math.max(sc.right - sc.left, sc.top - sc.bottom) / k.shadow.mapSize.x;
    k.shadow.normalBias = Math.max(0.06, 2.5 * texel);

    // Road decals (oil/water/ice slicks, boost pads, box contact shadows) are cut
    // straight out of the road ribbon's own triangles AT BUILD TIME — hand props the
    // deck chunk meshes (render/RoadDecal.clipRoadDecal). A clipped decal shares the
    // road's exact surface, so it can't be poked through on a crest/bank the way a
    // separate conformed sheet could. They're static, so the clip bakes once here.
    const deck = this.trackGroup.children.filter((m) => m.userData.roadDeck);
    this.props.setTrack(track, theme, deck);
    // Bake the sun shadow ONCE for this static track. The track geometry above is the
    // only shadow caster (cars/boxes/bananas/cones cast no real shadow — they carry
    // ground blobs instead), and both it and the light are fixed, so one render here is
    // enough; _loop never refreshes it again (see the note there). Raising the renderer-
    // level flag (the gate ignores light.shadow) makes the NEXT frame render the map and
    // then auto-clear it back to frozen. A track change re-runs setTrack → re-bakes.
    this.renderer.shadowMap.needsUpdate = true;
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
    // Cars do NOT cast the real sun shadow: the directional map is baked once per track
    // (frozen — see setTrack/_loop) and a moving car can't be in it. Each car instead
    // carries a soft ground blob (the `ao` plane below) that follows it and sits flat on
    // whatever surface it drives — flat road, bank, hill, even a loop deck — because the
    // blob is parented to the road-aligned group, not the leaning body.
    car.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    group.add(car);

    // In the GLB the 4 wheels are children of the body node, so rolling the body
    // would roll the wheels too (the "boat" feel). Reparent the wheels onto `car`
    // (preserving world transform) so we can lean ONLY the body; wheels stay flat.
    const wheels = ['wheel-fl', 'wheel-fr', 'wheel-bl', 'wheel-br']
      .map((n) => car.getObjectByName(n)).filter(Boolean);
    const body = wheels.length ? wheels[0].parent : car;
    for (const w of wheels) car.attach(w);
    // Some models (Bolt, Rumble) expose a cross-axle — the rod between the wheels.
    // In the source GLB it was welded into the body mesh, so it tilted with the
    // leaning/diving body (wrong: an axle is unsprung, it rides with the wheels).
    // scripts/extract-rod.js split it into its own `axle` node; reparent it off
    // the body too so it stays flat with the wheels. Models without one no-op.
    const axle = car.getObjectByName('axle');
    if (axle) car.attach(axle);
    const bodyBaseQuat = body.quaternion.clone();
    const frontWheels = ['wheel-fl', 'wheel-fr'].map((n) => car.getObjectByName(n)).filter(Boolean);
    const backWheels = ['wheel-bl', 'wheel-br'].map((n) => car.getObjectByName(n)).filter(Boolean);
    // Front wheels both STEER (yaw, setCarPose) and ROLL (about the axle). YXZ
    // applies the steer yaw first, then the roll about the already-yawed axle —
    // the composition a real steered wheel has. Rears roll on default-order X alone.
    for (const w of frontWheels) w.rotation.order = 'YXZ';

    // livery "license plate" on the car's rear bumper, showing the player name.
    // Parented to the BODY (not the group) so it banks WITH the steering lean.
    // _positionPlate (below) sets its body-local transform from the auto-detected
    // rear panel, applying any per-model height override (PLATE_Y).
    const colHex = this.colors[colorIndex % this.colors.length] || '#ffffff';
    const anchor = this._plateAnchor(model, group, body);
    const plate = makePlate(name, colHex, anchor);
    body.add(plate);
    this.scene.add(group);

    // Car footprint (width × length), used to size the boost disk and the underbody
    // shading quad below (see the tyre-contact cue notes up top for the silhouette
    // rule that shape obeys).
    // updateWorldMatrix first so the bounding box reflects the posed car transform.
    group.updateWorldMatrix(true, true);
    const fb = new THREE.Box3().setFromObject(car);
    const footW = fb.max.x - fb.min.x, footL = fb.max.z - fb.min.z;

    // BOOST circle: an additive teal disk painted on the road under the car, shown
    // only while boosting and sized/brightened by boostMul — so the catch-up scaling
    // (leader vs back-marker) is visible on the shared screen, not silent rubber-
    // banding. Unlike a flat quad (which slices through the deck where the road curls
    // up — loops, crests, bank ramps), its verts are CONFORMED to the road surface
    // every frame in setCarPose, so the circle bends with the track. A child of the
    // SCENE, not the car group: the conform writes world-space positions directly.
    const boostDisk = new THREE.Mesh(
      makeBoostDiskGeometry(BOOST_DISK_SEG, BOOST_DISK_RINGS),
      new THREE.MeshBasicMaterial({
        map: this._diskTex, color: 0x2bd1c4, transparent: true, opacity: 0, // teal — matches the boost pad/item
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      })
    );
    boostDisk.frustumCulled = false; // identity transform at the origin; the verts roam the whole track
    boostDisk.visible = false;
    this.scene.add(boostDisk);

    const chase = new ChaseCamera();

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
    let skidWidth = SKID_WIDTH, wheelRadius = 0.09;
    if (backWheels.length) {
      const wb = new THREE.Box3().setFromObject(backWheels[0]).getSize(new THREE.Vector3());
      skidWidth = Math.min(0.24, Math.max(0.06, Math.min(wb.x, wb.z)));
      wheelRadius = Math.max(0.04, wb.y / 2); // the disc's vertical extent IS the tyre diameter
    }

    // Axis signs for the roll/pitch animations, MEASURED from the rest transform
    // (the group was just added at the origin with identity rotation, so world
    // space = group space here). The model-facing yaw fix flips local axes
    // relative to the group — the stock PI flip maps local +X onto group −X — so
    // a hard-coded sign would spin the wheels backwards (and pitch the body the
    // wrong way) on a differently-authored model or a future CAR_MODEL_YAW entry.
    // Convention: positive rotation about GROUP +X = rolling forward / nose-down.
    const axisV = new THREE.Vector3();
    for (const w of [...frontWheels, ...backWheels]) {
      axisV.setFromMatrixColumn(w.matrixWorld, 0); // wheel local X (the axle) in group space
      w.userData.rollSign = axisV.x >= 0 ? 1 : -1;
    }
    const pitchSign = (axisV.setFromMatrixColumn(body.matrixWorld, 0).x >= 0) ? 1 : -1;

    // GROUND SHADOW — a dark plane under the chassis carrying the car's real top-down
    // SILHOUETTE (cabin + wheels), baked once per model (see _bakeCarShadow); _aoTex's soft
    // oval is the fallback. This is the car's entire shadow: cars no longer cast the real
    // sun shadow (the directional map is baked once per track and frozen), so this replaces
    // it. Like the boost disk, it's a SCENE child whose grid verts are CONFORMED to the road
    // each frame (setCarPose) — so it bends through loops / crests / ramps instead of clipping
    // as a flat quad, and tracks the car's spin-out whirl. Own geometry (per-car conform);
    // material is a per-car clone (its opacity tracks body pitch — the load-shift cue).
    const aoMat = this._aoMat.clone();
    const sil = this._bakeCarShadow(model, proto, car.rotation.y); // car.rotation.y = posed yaw the footprint was measured at
    if (sil) aoMat.map = sil;
    const ao = new THREE.Mesh(this._aoGeo.clone(), aoMat); // own grid: verts conformed per frame
    ao.frustumCulled = false; // conformed verts roam the whole track (like the boost disk)
    ao.visible = false;       // shown once the first setCarPose conforms it (no flash at the origin)
    this.scene.add(ao);       // a SCENE child (world-space conform), not a group child

    // BOOST wind streaks (see the constants up top): a small rig of axial-
    // billboard quads parented to the GROUP (so they align with the heading),
    // cycling front→back past the body while boosting. Hidden otherwise; stepped
    // in setCarPose, which knows boostMul and the frame's real travel.
    const streakGroup = new THREE.Group();
    streakGroup.visible = false;
    const streaks = [];
    for (let i = 0; i < STREAK_N; i++) {
      const m = new THREE.Mesh(this._streakGeo, this._streakMat.clone()); // per-streak opacity
      m.onBeforeRender = streakBillboard; // face each cell's camera (axial billboard)
      streakGroup.add(m);
      streaks.push({ mesh: m, z: 0, dead: true });
    }
    group.add(streakGroup);

    const c = {
      group, car, body, bodyBaseQuat,
      frontWheels, backWheels, allWheels: [...backWheels, ...frontWheels],
      wheelbase, skidWidth, wheelRadius, pitchSign, plate, chase, cam: chase.camera, boostDisk, aoMat, ao,
      streakGroup, streaks, footW, footL,
      carIndex, anchorZ: anchor.z, plateY: anchor.y, baseYaw: car.rotation.y,
      label, steerBar, steerFill, finishEl, placeEl, finished: false, pose: null, lean: 0,
      wheelRoll: 0, pitch: 0, prevSpd: 0, lastPos: null, // wheel-roll + weight-transfer state (setCarPose)
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

  // Build (once, lazily) the MONSTER-TRUCK visual for a car: the kit's monster
  // chassis + wheels with THIS car's body grafted where the cab was (see MonsterRig).
  // The rig is parented INTO the car's group, hidden; setCarMonster toggles it and
  // repoints the per-frame animation handles onto it, so the existing setCarPose /
  // SkidMarks machinery drives it unchanged. Returns false if the monster proto isn't
  // loaded (the engine transform still runs — there's just no on-screen morph).
  _buildMonsterVisual(c) {
    const monProto = this.protos.get(MONSTER_BASE_ASSET);
    const carProto = this.protos.get(CAR_MODELS[c.carIndex % CAR_MODELS.length]) || this.protos.get(CAR_MODELS[0]);
    if (!monProto || !carProto) return false;
    const rig = buildMonsterRig(carProto, monProto);
    // Face travel like the normal car (kit models face -Z; addCar applies this same PI
    // flip + any per-model yaw fix). Apply the yaw with the rig ISOLATED (not yet under
    // the posed group) and measure the animation signs there, so its world matrix equals
    // the group-local frame addCar measures in (group at identity).
    const baseYaw = Math.PI + (CAR_MODEL_YAW[c.carIndex % CAR_MODELS.length] || 0);
    rig.rotation.y = baseYaw;
    rig.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    rig.updateWorldMatrix(true, true);

    const byName = (n) => rig.getObjectByName(n);
    const frontWheels = ['wheel-fl', 'wheel-fr'].map(byName).filter(Boolean);
    const backWheels = ['wheel-bl', 'wheel-br'].map(byName).filter(Boolean);
    const allWheels = [...backWheels, ...frontWheels];
    const body = byName('monster-body') || rig; // the grafted car body = the lean/pitch handle
    for (const w of frontWheels) w.rotation.order = 'YXZ'; // steer yaw before roll (matches addCar)

    // Roll/pitch axis signs, measured exactly as addCar does (local +X column of each
    // node, in the isolated rig frame = group space): +rotation about group +X rolls
    // forward / noses down.
    const axisV = new THREE.Vector3();
    for (const w of allWheels) { axisV.setFromMatrixColumn(w.matrixWorld, 0); w.userData.rollSign = axisV.x >= 0 ? 1 : -1; }
    const pitchSign = (axisV.setFromMatrixColumn(body.matrixWorld, 0).x >= 0) ? 1 : -1;

    // Wheelbase for the ground-conform probes; footprint for the boost disk + shadow
    // sizing; tyre radius/width for wheel roll + skid marks. Same measurements as addCar.
    const axleMid = (arr) => {
      const v = new THREE.Vector3();
      for (const o of arr) v.add(o.getWorldPosition(new THREE.Vector3()));
      return arr.length ? v.multiplyScalar(1 / arr.length) : v;
    };
    const wheelbase = (frontWheels.length && backWheels.length) ? axleMid(frontWheels).distanceTo(axleMid(backWheels)) : c.wheelbase;
    const fb = new THREE.Box3().setFromObject(rig);
    const footW = fb.max.x - fb.min.x, footL = fb.max.z - fb.min.z;
    let skidWidth = c.skidWidth, wheelRadius = c.wheelRadius;
    if (backWheels.length) {
      const wb = new THREE.Box3().setFromObject(backWheels[0]).getSize(new THREE.Vector3());
      skidWidth = Math.min(0.3, Math.max(0.06, Math.min(wb.x, wb.z))); // fat monster tyres mark wider
      wheelRadius = Math.max(0.04, wb.y / 2);
    }

    rig.visible = false;
    c.group.add(rig); // now inherits the group's per-frame track pose
    c.monsterRig = rig;
    c.monsterHandles = {
      car: rig, body, bodyBaseQuat: body.quaternion.clone(), frontWheels, backWheels, allWheels,
      baseYaw, pitchSign, wheelbase, wheelRadius, skidWidth, footW, footL
    };
    // Clone every material on the rig so the view-blocking fade (setCarMonster occlusion) can
    // change THIS monster's opacity without touching other cars that share the source materials.
    // Kept transparent always (opacity 1 reads opaque) so the per-cell fade only flips opacity +
    // depthWrite — no per-cell material recompile (toggling `transparent` would thrash the cache).
    const fadeMats = [];
    const cloneMat = (m) => { const cm = m.clone(); cm.transparent = true; cm.depthWrite = true; cm.opacity = 1; fadeMats.push(cm); return cm; };
    rig.traverse((o) => { if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material); });
    c.monsterMats = fadeMats;
    c._monsterOpacity = 1;
    return true;
  }

  // Set a monster rig's opacity for the cell about to render (1 = solid, <1 = see-through so
  // it doesn't hide the car behind it). depthWrite follows: a faded monster must NOT write depth
  // or the car behind it would be depth-rejected and stay invisible. No-op if unchanged.
  _setMonsterOpacity(c, op) {
    if (!c.monsterMats || c._monsterOpacity === op) return;
    c._monsterOpacity = op;
    const dw = op >= 1;
    for (const m of c.monsterMats) { m.opacity = op; m.depthWrite = dw; }
  }

  // Does monster rig `m` loom in front of cell-focus car `f` from `f`'s chase camera? Pure proximity:
  // `m` is in FRONT of the camera (not behind it), CLOSER to the camera than `f` (between cam and car,
  // not beyond it), and within MONSTER_BLOCK_DIST of `f`. No projection — just positions.
  _monsterBlocksView(m, f) {
    const cam = f.cam.position, fp = f.group.position, mp = m.group.position;
    const fx = fp.x - cam.x, fy = fp.y - cam.y, fz = fp.z - cam.z;     // cam → car
    const mx = mp.x - cam.x, my = mp.y - cam.y, mz = mp.z - cam.z;     // cam → monster
    if (mx * fx + my * fy + mz * fz <= 0) return false;               // monster is behind the camera → not in view
    if (mx * mx + my * my + mz * mz >= fx * fx + fy * fy + fz * fz) return false; // monster farther than the car → beyond it, not occluding
    const dx = mp.x - fp.x, dy = mp.y - fp.y, dz = mp.z - fp.z;
    return dx * dx + dy * dy + dz * dz < MONSTER_BLOCK_DIST * MONSTER_BLOCK_DIST; // close enough to the car to loom over it
  }

  // Toggle a car's MONSTER-TRUCK transform (driven from the engine snapshot's `monster`
  // flag — see main.js; idempotent, so it's safe to call every frame). The name plate is
  // a child of the normal body, so it hides with the normal car while transformed — the
  // player's identity stays on the cell HUD.
  setCarMonster(id, on) {
    const c = this.cars.get(id);
    if (!c) return;
    const want = !!on;
    if (want === !!c._monsterOn) return; // engine desire unchanged
    c._monsterOn = want;
    const KEYS = MONSTER_HANDLE_KEYS;
    if (want) {
      // Become a monster: swap the visible model + animation handles to the rig (unless an
      // in-flight shrink is still showing it), then run the GROW-IN. setCarPose ticks the scale.
      const showing = c._monsterPhase === 'in' || c._monsterPhase === 'on' || c._monsterPhase === 'out';
      if (!showing) {
        if (!c.monsterRig && !this._buildMonsterVisual(c)) { c._monsterOn = false; return; } // proto missing → no morph
        c._normal = {};
        for (const k of KEYS) c._normal[k] = c[k];
        c._normal.car.visible = false;        // hide the normal model
        c.monsterRig.visible = true;
        for (const k of KEYS) c[k] = c.monsterHandles[k];
        c.monsterRig.scale.setScalar(MONSTER_POP_START); // start small; setCarPose springs it up
        this._setMonsterOpacity(c, 1); // show solid; the per-cell render fades it only where it blocks
      }
      c._monsterPhase = 'in';
      c.monsterPopT = 0;
    } else {
      // Lapse: run the DEFLATE (shrink) — keep the rig + handles until setCarPose finishes the
      // shrink and swaps the normal car back in. No-op if nothing is currently showing.
      if (c._monsterPhase === 'in' || c._monsterPhase === 'on') {
        c._monsterPhase = 'out';
        c.monsterPopT = 0;
      }
    }
  }

  removeCar(id) {
    const c = this.cars.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    // Dispose what addCar created fresh per car (name plate, boost disk, ground shadow). The
    // car mesh shares its geometry/material with the cached prototype; the shadow's silhouette
    // map (_carShadowTex) and the _aoGeo template are shared — leave those for the next race.
    c.plate.geometry.dispose(); c.plate.material.map.dispose(); c.plate.material.dispose();
    // boost disk owns its geometry + material (the falloff map is the shared this._diskTex — leave it).
    // It's a child of the SCENE (not the group removed above), so pull it out too.
    if (c.boostDisk) { this.scene.remove(c.boostDisk); c.boostDisk.geometry.dispose(); c.boostDisk.material.dispose(); }
    // ground shadow: now a SCENE child (conformed) with its OWN cloned grid geometry +
    // per-car material (opacity animates with load). The silhouette map is the cached
    // per-model texture — shared, leave it. Pull the mesh from the scene and dispose its geo.
    if (c.ao) { this.scene.remove(c.ao); c.ao.geometry.dispose(); }
    if (c.aoMat) c.aoMat.dispose();
    if (c.streaks) for (const st of c.streaks) st.mesh.material.dispose();
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

  // The car's per-frame pose + animation inputs. `pos/forward/up` are the required
  // world pose; the rest ride in an options bag (was an 8-deep positional tail that
  // forced callers to pad `false, 0, 0` to reach boostMul). `steerInput` still
  // defaults to `steer` — the on-screen indicator mirrors raw tilt unless told otherwise.
  setCarPose(id, pos, forward, up, {
    steer = 0, spd = 0, scrub = false, steerInput = steer, spin = 0, boostMul = 1, brake = 0,
  } = {}) {
    const c = this.cars.get(id);
    if (!c) return;
    c.spd = spd; c.scrub = scrub; c.steerAmt = steer; c.brakeAmt = brake;
    c.spinAmt = spin; // spin-out whirl angle — the skid trails read it (all four tyres scribble)
    // spin-out whirl: rotate the whole car model about its up axis on top of its
    // model-facing fix (the sim heading is untouched — this is purely cosmetic). The car
    // shadow's silhouette whirls with it too, folded into the conform basis at the END of
    // setCarPose (it spins the in-surface forward/right by `spin`).
    c.car.rotation.y = c.baseYaw + spin;
    // Monster transform scale animation. c.car IS the rig during 'in'/'out', so scaling it
    // scales the whole monster. GROW-IN ('in'): ease-out-back spring from MONSTER_POP_START to
    // full — reads as the car BURSTING into a monster. SHRINK-OUT ('out'): ease-in-back back
    // down, so it bulges a touch (the pre-shrink "jitter") before deflating; when it finishes
    // we swap the normal car back in. Both run over MONSTER_POP_TIME.
    if (c._monsterPhase === 'in') {
      c.monsterPopT = Math.min(MONSTER_POP_TIME, c.monsterPopT + this._frameDt);
      const p = c.monsterPopT / MONSTER_POP_TIME, k = MONSTER_GROW_BACK;
      const eb = 1 + (k + 1) * Math.pow(p - 1, 3) + k * Math.pow(p - 1, 2); // ease-out-back (overshoots past 1)
      c.car.scale.setScalar(MONSTER_POP_START + (1 - MONSTER_POP_START) * eb);
      if (p >= 1) { c.car.scale.setScalar(1); c._monsterPhase = 'on'; }
    } else if (c._monsterPhase === 'out') {
      c.monsterPopT = Math.min(MONSTER_POP_TIME, c.monsterPopT + this._frameDt);
      const p = c.monsterPopT / MONSTER_POP_TIME, k = MONSTER_SHRINK_BACK;
      const eib = (k + 1) * p * p * p - k * p * p; // ease-in-back (dips <0 early → bulges >1 = the jitter)
      c.monsterRig.scale.setScalar(1 + (MONSTER_POP_START - 1) * eib);
      if (p >= 1) {
        // shrink done → swap the normal car back in
        c.monsterRig.visible = false; c.monsterRig.scale.setScalar(1);
        if (c._normal) { c._normal.car.visible = true; for (const kk of MONSTER_HANDLE_KEYS) c[kk] = c._normal[kk]; }
        c._monsterPhase = undefined;
      }
    }
    // (The boost disk is updated at the END of setCarPose — it needs the surface
    // basis computed below to conform its circle onto the road.)
    // Persistent pose vectors (created once per car) reused every frame — no GC.
    // Safe because c.pose is only read within the same frame it's written.
    if (!c.pose) c.pose = { pos: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3() };
    const fwd = c.pose.forward.copy(forward).normalize();
    const u = c.pose.up.copy(up).normalize();
    // Travel since last frame — drives the wheel roll. FULL ground travel,
    // signed by the heading component: the physically-strict roll would be the
    // heading projection (a drifting tyre rolls slower than the car moves), but
    // this game's handling is all drift — the projection left the wheels
    // visibly under-rolling through every corner and wall scrub, which read as
    // slip (readability > physics; same call as the brake dive).
    let ds = 0;
    if (c.lastPos) {
      this._dsV.copy(pos).sub(c.lastPos);
      ds = this._dsV.length() * (Math.sign(this._dsV.dot(fwd)) || 1);
    }
    (c.lastPos || (c.lastPos = new THREE.Vector3())).copy(pos);
    c.pose.pos.copy(pos);
    c.group.position.copy(pos);

    // BOOST wind streaks: while boosting, cycle each streak front→back past the
    // body at the car's REAL speed through the air (this frame's travel), so the
    // rush rate IS how fast the car actually moves. Each pass respawns at a fresh
    // offset around the body; the sin() envelope fades a streak in and out over
    // its pass so neither end pops. (Math.random is fine here: the streaks live
    // in the one shared scene, so every split-screen cell sees the same ones.)
    if (boostMul > 1.001) {
      const dtf = Math.max(this._frameDt, 1e-3);
      const wspd = Math.min(Math.abs(ds), ROLL_SEG_MAX) / dtf + 3; // +floor: visible even from a standstill
      const span = STREAK_FRONT - STREAK_BACK;
      const k = Math.min(1, (boostMul - 1) / 0.6); // boost size (leader floor → last place) scales brightness
      c.streakGroup.visible = true;
      for (const st of c.streaks) {
        if (st.dead) {
          // respawn ahead of the nose at a fresh offset; staggered entry via the random z
          st.z = STREAK_FRONT + Math.random() * span * 0.8;
          st.mesh.position.x = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.4) * c.footW;
          st.mesh.position.y = 0.1 + Math.random() * 0.3;
          st.mesh.scale.set(0.07, 1, 0.6 + Math.random() * 0.5); // width × (face) × length
          st.dead = false;
        }
        st.z -= wspd * dtf;
        if (st.z < STREAK_BACK) { st.dead = true; st.mesh.material.opacity = 0; continue; }
        st.mesh.position.z = st.z;
        const p = Math.min(1, Math.max(0, (STREAK_FRONT - st.z) / span)); // 0 entering → 1 leaving
        st.mesh.material.opacity = Math.sin(Math.PI * p) * STREAK_OPACITY * (0.5 + 0.5 * k);
      }
    } else if (c.streakGroup.visible) {
      c.streakGroup.visible = false;
      for (const st of c.streaks) { st.dead = true; st.mesh.material.opacity = 0; }
    }

    // Ground-conform. PITCH comes from the centreline forward (`fwd`): the centreline
    // is built once and filtered, so fwd.y is a SMOOTH road slope (the smootherstep
    // climb on a ramp — and since the engine pose pitches it to the AXLE CHORD, it's
    // the slope the wheelbase actually rests on through transitions). HEIGHT comes
    // from raycasting the rendered road under the axles so the wheels sit on the
    // actual mesh. We split the two deliberately — re-pitching from the front/rear
    // probe slope twitched the car at ramp seams (that probe is noisy: the road
    // floor isn't a perfect smootherstep and overlaps at seams). Heading
    // (yaw) is the centreline's; ROLL follows the road surface (`pose.up` — the local
    // swept-surface normal under the car): level on flat road, leaned with a banked
    // corner's cross slope, riding the wall through a corkscrew. (An earlier world-up
    // reference kept the body level "Mario-Kart style" — that predates banked corners,
    // read as the car counter-rotating once real cross slope shipped, and snapped past
    // 90° of roll where worldUp×forward flips sign.) `stunt` below only fades out the
    // straight-down road probe, which is meaningless on a steep or inverted deck.
    let z = fwd;
    const stunt = Math.min(1, Math.max(0, (0.97 - u.y) / 0.10)); // 0 ≤ ~14° of roll, 1 past ~29°
    if (stunt < 1) {
      const yC = this._roadHitY(pos.x, pos.z, pos.y); // road directly under the car centre
      this._headFlat.copy(fwd).setY(0);
      if (this._headFlat.lengthSq() > 1e-6) {
        this._headFlat.normalize();
        const half = c.wheelbase * 0.5;
        const yF = this._roadHitY(pos.x + this._headFlat.x * half, pos.z + this._headFlat.z * half, pos.y);
        const yB = this._roadHitY(pos.x - this._headFlat.x * half, pos.z - this._headFlat.z * half, pos.y);
        // Ride on the AXLE MEAN (front+rear)/2 — the body is pitched to the axle
        // chord (see the engine pose), so the mean is the height where BOTH axles
        // touch the road. Riding max() instead floated the whole car by half the
        // front↔rear height difference on every slope (visible daylight under the
        // wheels all the way up a ramp). The centre probe survives only as a crest
        // guard: where the deck bulges above the chord, ride the peak so the road
        // never pokes up through the belly.
        let roadY = null;
        if (yF != null && yB != null) {
          const mid = (yF + yB) / 2;
          roadY = (yC != null ? Math.max(mid, yC) : mid);
        } else if (yC != null) roadY = yC; // off the edge / gate seam: centre probe only
        if (roadY != null) {
          // Snap to the road, but DAMP the OFFSET from the (smooth) centreline rather
          // than the absolute height. The probes (and the crest guard switching in and
          // out) jump abruptly where road pieces overlap at a seam — a ~0.15-unit
          // vertical POP. Damping the small offset smooths those pops; the climb itself
          // lives in the centreline height (pos.y), so it stays lag-free and the wheels
          // keep tracking the road.
          const offTarget = roadY - pos.y;
          const a = 1 - Math.exp(-RIDE_DAMP * this._frameDt); // frame-rate-independent smoothing
          c.rideOff = (c.rideOff == null) ? offTarget : c.rideOff + (offTarget - c.rideOff) * a;
          // A straight-down probe is meaningless on a rolled/steep surface — fade its
          // contribution out with `stunt` and lift along the FRAME's up instead below.
          c.group.position.y = pos.y + (c.rideOff + RIDE_HEIGHT) * (1 - stunt);
        }
      }
    } else {
      c.rideOff = null; // re-seed the damped offset when the car comes back off a stunt
    }
    if (stunt > 0) c.group.position.addScaledVector(u, RIDE_HEIGHT * stunt);
    // Build the car basis from the (centreline-pitched) forward + the road-surface up.
    // Never degenerates: u is perpendicular to the frame tangent by construction, and
    // stays well clear of z (the car's pitched forward) everywhere a track can go.
    const x = this._sx.copy(u).cross(z).normalize();
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
    // Weight transfer: smoothed d(spd)/dt → body pitch — dive under braking,
    // squat under throttle. c.pitch is the NOSE-DOWN angle; pitchSign maps it
    // onto the body's local X (which the model-facing yaw fix may have flipped).
    const dspd = (spd - c.prevSpd) / Math.max(this._frameDt, 1e-3);
    c.prevSpd = spd;
    const pitchAmt = Math.max(-1, Math.min(1, dspd / PITCH_ACCEL_NORM)); // <0 braking, >0 throttle
    c.accelNorm = pitchAmt > 0 ? pitchAmt : 0; // forward bite — the launch-scratch skids read this
    // The nose dive is gated on REAL brake input: steer scrub, curb rash and boost
    // bleed-off decelerate at the same rate as the brake, and a dive on turn-in reads
    // as phantom braking. Ramp saturates at 1/3 pedal so firm braking always dives full.
    const diveGate = Math.min(1, c.brakeAmt * 3);
    const pitchTarget = -pitchAmt * (pitchAmt < 0 ? PITCH_DIVE_MAX * diveGate : PITCH_SQUAT_MAX);
    c.pitch += (pitchTarget - c.pitch) * (1 - Math.exp(-PITCH_RATE * this._frameDt));
    c.body.rotateX(c.pitch * c.pitchSign);
    // Load shift: the harder the body pitches (dive/squat), the closer the chassis
    // presses to the road — darken the underbody shading in step with it.
    c.aoMat.opacity = UNDER_AO_OPACITY + AO_LOAD_GAIN * Math.min(1, Math.abs(c.pitch) / PITCH_DIVE_MAX);
    // Roll every wheel from the car's real travel (ds / tyre radius), scaled by
    // WHEEL_SPIN_SCALE for readability — see the constants up top (the literal
    // rate is correct but reads "too fast" under the chase cam, and strobes).
    // Teleport-sized jumps (respawn) don't spin the wheels; the accumulator is
    // wrapped into (−π, π] each frame so it never loses precision.
    if (Math.abs(ds) < ROLL_SEG_MAX) {
      c.wheelRoll += (ds / c.wheelRadius) * WHEEL_SPIN_SCALE;
      c.wheelRoll = ((c.wheelRoll + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    }
    for (const w of c.backWheels) w.rotation.x = c.wheelRoll * w.userData.rollSign;
    // front wheels: steer yaw + roll (YXZ order set in addCar; steer>0 = right)
    for (const w of c.frontWheels) {
      w.rotation.y = steer * WHEEL_TURN_MAX;
      w.rotation.x = c.wheelRoll * w.userData.rollSign;
    }
    // on-screen steer indicator: mirror the player's RAW input (same as the phone
    // bar) so it slides the way they tilt — not the turn-aligned/STEER_SIGN value.
    if (c.steerFill) c.steerFill.style.transform = `translateX(${(steerInput * 50).toFixed(1)}%)`;

    // BOOST circle: a filled teal disk painted on the road under the car while
    // boosting, gently pulsating and scaled by the boost size (a back-marker's bigger
    // catch-up boost glows a touch bigger than the leader's floor). Every vertex —
    // the centre and each concentric-ring sample — is CONFORMED to the actual road
    // surface (raycast back down the surface normal `u`) so the disk follows the track
    // through loops, crests and banks instead of clipping through a curling deck. Done
    // here — after the surface basis (this._sx = right, u = up, fwd) and the car's
    // road-snapped position are final this frame.
    const disk = c.boostDisk;
    if (disk) {
      if (boostMul > 1.001) {
        const k = boostMul - 1;            // ~0.25 (leader floor) … 0.60 (last)
        const pulse = 0.62 + 0.38 * Math.sin(this._last * 0.011); // ~1.8 Hz (rAF clock)
        disk.visible = true;
        disk.material.opacity = Math.min(0.42, 0.18 + k * 0.5) * pulse;
        const sc = (1.25 + k * 2.0) * (0.96 + 0.06 * pulse);       // size breathes with the pulse
        const outerR = (c.footW + c.footL) * 0.5 * sc * 0.5;       // disk radius from the footprint
        // Two in-surface axes (both ⟂ the surface normal u): right from the car basis,
        // and the car forward projected back into the surface plane.
        this._diskRight.copy(this._sx);
        this._diskFwd.copy(fwd).addScaledVector(u, -fwd.dot(u));
        if (this._diskFwd.lengthSq() > 1e-6) this._diskFwd.normalize(); else this._diskFwd.copy(fwd);
        const center = c.group.position;
        const geo = disk.geometry;
        const arr = geo.getAttribute('position').array;
        const seg = geo.userData.seg, rings = geo.userData.rings;
        // centre vertex (index 0): the road directly under the car
        this._diskMid.copy(center);
        this._conformDiskVert(arr, 0, u);
        // each concentric ring outward to the rim
        for (let r = 1; r <= rings; r++) {
          const rad = outerR * (r / rings);
          for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            const ct = Math.cos(a), st = Math.sin(a);
            this._diskRadial.copy(this._diskRight).multiplyScalar(ct).addScaledVector(this._diskFwd, st);
            this._diskMid.copy(center).addScaledVector(this._diskRadial, rad);
            this._conformDiskVert(arr, (1 + (r - 1) * seg + i) * 3, u);
          }
        }
        geo.getAttribute('position').needsUpdate = true;
      } else if (disk.visible) {
        disk.visible = false;
      }
    }

    // CAR SHADOW conform: bend the silhouette grid onto the deck (same raycast as the boost
    // disk) so it never clips on a loop / crest / ramp. The in-surface basis — right (this._sx)
    // and forward (fwd projected into the surface) — is spun by the spin-out whirl so the
    // silhouette tracks the car; each grid vertex's rest (lx,ly) ∈ [-0.5,0.5] places it across
    // the footprint×overscan, then _conformDiskVert drops it on the road. Done after the basis
    // and road-snapped position are final.
    const shdw = c.ao;
    if (shdw) {
      const right = this._diskRight.copy(this._sx);
      const sfwd = this._diskFwd.copy(fwd).addScaledVector(u, -fwd.dot(u));
      if (sfwd.lengthSq() > 1e-6) sfwd.normalize(); else sfwd.copy(fwd);
      const cs = Math.cos(spin), sn = Math.sin(spin);
      this._shR.copy(right).multiplyScalar(cs).addScaledVector(sfwd, -sn); // right rotated by +spin about u
      this._shF.copy(sfwd).multiplyScalar(cs).addScaledVector(right, sn);  // forward rotated by +spin about u
      const hw = c.footW * SHADOW_OVERSCAN, hl = c.footL * SHADOW_OVERSCAN;
      const center = c.group.position;
      const base = this._aoBaseXY, arr = shdw.geometry.getAttribute('position').array;
      const n = base.length >> 1;
      for (let vi = 0; vi < n; vi++) {
        this._diskMid.copy(center).addScaledVector(this._shR, base[vi * 2] * hw).addScaledVector(this._shF, base[vi * 2 + 1] * hl);
        this._conformDiskVert(arr, vi * 3, u);
      }
      shdw.geometry.getAttribute('position').needsUpdate = true;
      shdw.visible = true;
    }

    // (nothing else to update here: the name plate is parented to the body so it banks
    // with the steering lean.)
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

  // A fresh grab (fired once per pickup by onRaceEvent): ALWAYS re-spin the cell's
  // roulette, even when a box swap re-rolls the SAME item id — so every pickup reads.
  // setCarHud's polling only reveals a late-joiner's held item + clears the slot on use;
  // it won't double-spin because this sets _chipItem before the next 6 Hz HUD poll.
  itemPickup(id, item) {
    const c = this.cars.get(id);
    if (!c || !c.label || !item) return; // cell-less AI car → no HUD chip
    c._chipItem = item;
    if (c._chipTimer) { clearTimeout(c._chipTimer); c._chipTimer = null; }
    this._rouletteChip(c, item);
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

  start() {
    this._idleAfterFrame = false;                 // re-entering cancels a pending idle (hover after a leave)
    if (!this._running) { this._running = true; this._last = performance.now(); requestAnimationFrame((t) => this._loop(t)); }
  }
  stop() { this._running = false; }
  // Is the render loop live right now? (false once pauseAfterFrame has idled it.)
  // The gallery play overlay derives its ▶/❚❚ state from this instead of guessing.
  isRunning() { return !!this._running; }
  // DEBUG slow-mo: scale the per-frame dt the whole scene runs on (1 = normal, 0.1 = tenth speed). Driven
  // live by the debug panel's "Time scale" slider (and the ?timescale= query param it prefills from).
  setTimeScale(n) { const v = parseFloat(n); this._timeScale = Number.isFinite(v) ? Math.max(0.05, Math.min(4, v)) : 1; return this._timeScale; }
  // Render exactly one more frame with the state set so far, then halt the loop.
  // Gallery previews hold a still frame this way instead of redrawing an unchanged
  // scene at 60fps: frozen previews never resume; animated cards resume via start()
  // when their play button is clicked. The held frame still renders fully, so
  // resuming picks up seamlessly.
  pauseAfterFrame() { if (this._running) this._idleAfterFrame = true; }
  // Tail of every _loop iteration: idle if asked (after this frame's present), else
  // queue the next frame.
  _scheduleNext() {
    if (this._idleAfterFrame) { this._idleAfterFrame = false; this._running = false; return; }
    requestAnimationFrame((tt) => this._loop(tt));
  }

  _loop(t) {
    if (!this._running) return;
    const rawMs = t - this._last;            // true rAF cadence (pre-clamp) for the FPS meter
    // One global dt drives EVERYTHING downstream (sim, props, skids, clouds, camera damping), so the
    // DEBUG slow-mo scale here slows the whole scene uniformly. rawMs stays real → the FPS meter is honest.
    const dt = Math.min(rawMs / 1000, 0.05) * this._timeScale;
    this._last = t;
    this._frameDt = dt; // exposed so setCarPose can damp frame-rate-independently
    if (rawMs > 0 && rawMs < 1000) this._fps.tick(t, rawMs); // skip absurd post-stall deltas
    if (this.onFrame) this.onFrame(dt);

    // Skidmark trails: bridge each wheel's contact path into the merged decal
    // pool (cornering scuffs, curb grinds, brake streaks, launch scratches).
    this.skids.layTrails(this.cars);
    this.skids.step(dt);
    this.props.step(dt, this.cars); // kickable cones + item-box idle/collect anims
    // clouds drift slowly east, wrapping well outside the playfield
    for (const cl of this._clouds) {
      cl.position.x += 0.7 * dt;
      if (cl.position.x > 300) cl.position.x = -300;
    }
    // dust banks blow faster than the clouds above them (wind shear sells "dust",
    // not "low cloud"); wrap scales with the hill push-out so banks re-enter from
    // outside the horizon ring even on a big circuit
    const hazeWrap = 300 * (this._hills ? this._hills.scale.x : 1);
    for (const h of this._haze) {
      if (!h.visible) continue;
      h.position.x += 2.2 * dt;
      if (h.position.x > hazeWrap) h.position.x = -hazeWrap;
    }
    // birds: each circles its authored roost (gulls over the shoreline, vultures
    // over a mesa, geese across the winter sky), with per-bird phase/speed
    // offsets and a gentle vertical bob. Roost centres follow the hill push-out
    // live. The WING-BEAT is a flap envelope on the sprite's height — squashing
    // the glyph toward a line and back reads as beating wings even at speck
    // size, and the motion (not the glyph) is what makes a distant sprite read
    // "bird" at all. cfg.flap = beat depth (gulls ~1 flap busily, vultures
    // ~0.15 mostly soar). _birdT doubles as the shared clock for every stepped
    // sky piece (kites/balloon/paper plane) and the track anims below.
    this._birdT += dt;
    if (this._birds.cfg) {
      const bsf = this._hills ? this._hills.scale.x : 1;
      const cfg = this._birds.cfg;
      for (const b of this._birds) {
        if (!b.visible) continue;
        const u = b.userData;
        const ph = u.ph + this._birdT * cfg.speed * u.sp;
        b.position.set(
          Math.cos(u.a0) * cfg.rc * bsf + Math.cos(ph) * cfg.rb,
          cfg.y + u.dy * cfg.dys + Math.sin(ph * 2.3) * 0.9,
          Math.sin(u.a0) * cfg.rc * bsf + Math.sin(ph) * cfg.rb
        );
        const beat = 0.5 + 0.5 * Math.sin((this._birdT * u.sp * cfg.flapHz + u.ph) * Math.PI * 2);
        b.scale.y = cfg.size * 0.5 * (1 - cfg.flap * 0.48 * beat);
      }
    }
    {
      const sf = this._hills ? this._hills.scale.x : 1;
      stepKites(this._kites, dt, this._birdT, sf);           // shore kites bob on their strings
      stepBalloon(this._balloon, dt, this._birdT, sf);       // the balloon drifts its slow lap
      stepPaperPlane(this._paperPlane, dt, this._birdT, sf); // the paper dart glides + banks
    }
    // ambient particles (flakes/motes/sand/pollen) sink/ride the wind per their
    // kind, wrapping within the authored spread (mesh scale handles big circuits)
    stepAmbient(this._ambient, dt, this._birdT);
    // per-track animated set-pieces (windmill rotor, wind-up train, chimney smoke)
    for (const fn of this._trackAnims) fn(dt, this._birdT);

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

    // The sun's shadow map is NOT refreshed per frame: it's BAKED ONCE per track in
    // setTrack (the only casters are the fixed track geometry — cars/props carry their
    // own ground-blob shadows and no longer cast), then frozen and reused every frame
    // and every split-screen cell. The light + track are both static, so re-rasterising
    // them each frame was pure waste; this drops the whole-track shadow pass — the
    // biggest per-frame GPU cost on weak hardware — to a single render at track load.

    const ids = this._order.filter((id) => this.cars.has(id));
    // Pick the fog profile for this frame by camera mode: the overview turntable (no cells)
    // frames the whole track and wants the pushed-out overview fog; the race chase cams
    // want the tight race fog. Reassign only on an actual change so the material program
    // cache never thrashes (both are THREE.Fog, so even a swap is a uniform-only change).
    const wantFog = !this._fogEnabled ? null
      : (ids.length !== 0) ? this._raceFog                                   // race: cars in cells → tight chase fog
      : (this.bboxOrbit && this._bbFog) ? this._bbFog                        // lobby perimeter orbit → track-hugging fog
      : (this._overviewFog || this._raceFog);                                // gallery turntable → wide overview fog
    if (this.scene.fog !== wantFog) this.scene.fog = wantFog;
    if (ids.length === 0) {
      // lobby / no cars: single overview camera fills the target
      this.overview.aspect = W / H; this.overview.updateProjectionMatrix();
      if (this.controls) {
        // Viewer-driven inspector camera (standalone track preview) owns the
        // overview's position + aim: apply the WASD/QE fly keys, then tick the
        // inspector (which turns a rotate-drag into an in-place look, plus damping).
        this._moveCameraKeys(dt);
        this._tickInspectorControls();
      } else if (this.bboxOrbit && this._bbAx != null && this._trackCenter) {
        // Lobby perimeter orbit: sweep an ellipse around the track's bounding box (elongated
        // like the track), hugging just outside it and looking at the centre — circles the
        // track's overall SHAPE up close without weaving along every curve.
        this._orbitAngle += BBOX_ORBIT_SPEED * dt;
        const ctr = this._trackCenter;
        this.overview.position.set(
          ctr.x + Math.cos(this._orbitAngle) * this._bbAx,
          ctr.y + this._bbHeight,
          ctr.z + Math.sin(this._orbitAngle) * this._bbAz
        );
        this.overview.lookAt(ctr);
      } else {
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
      }
      r.render(this.scene, this.overview);
      for (const c of this.cars.values()) { if (c.label) c.label.style.display = 'none'; if (c.steerBar) c.steerBar.style.display = 'none'; if (c.finishEl) c.finishEl.style.display = 'none'; if (c.placeEl) c.placeEl.style.display = 'none'; if (c.reconnectEl) c.reconnectEl.style.display = 'none'; }
      this._hideDividers();
      this._present();
      this._scheduleNext();
      return;
    }

    const { cols, rows } = bestGrid(ids.length, W, H);
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);          // CSS px → DOM labels
    const cwDB = Math.floor(DBW / cols), chDB = Math.floor(DBH / rows);  // target px → cell viewports
    this._syncDividers(cols, rows, cw, ch, W, H);

    // Monster trucks currently on screen — for the per-cell occlusion fade below.
    const monsters = [];
    for (const cc of this.cars.values()) if (cc.monsterRig && cc.monsterRig.visible) monsters.push(cc);

    ids.forEach((id, i) => {
      const c = this.cars.get(id);
      if (!c.pose) return;
      const col = i % cols, row = Math.floor(i / cols);
      const xDB = col * cwDB;
      const yBottomDB = DBH - (row + 1) * chDB;  // three viewport origin = lower-left
      c.chase.update(c.pose, c.spd, dt);
      c.cam.aspect = cwDB / chDB; c.cam.updateProjectionMatrix();

      // Fade any monster looming in front of THIS cell's own car to 50% so it doesn't hide it
      // (per-cell — the chase cam is current after c.chase.update). A monster never fades in its
      // own cell. Usually 0 monsters, so this whole pass is a no-op.
      for (const m of monsters) this._setMonsterOpacity(m, (m !== c && this._monsterBlocksView(m, c)) ? MONSTER_FADE_OPACITY : 1);

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
        // bottom-anchored: bar height is 34px (.cell-steer); the offset keeps
        // a ~27px gap between its bottom edge and the cell bottom.
        c.steerBar.style.top = (row * ch + ch - 61) + 'px';
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
    this._scheduleNext();
  }
}
