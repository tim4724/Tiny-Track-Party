// TrackBuilder — integrates a list of parametric SEGMENTS into a drivable centerline
// ribbon the car physics follows AND the renderer sweeps the procedural road over
// (see SceneRenderer._buildRibbonRoad). There are no road meshes here — only geometry.
//
// A track is authored as a sequence of segments (see ../shared/tracks.js):
//   straight(length, opts)         — a run, optionally with a lateral S-shift (chicane),
//                                    an elevation `rise`, a net-flat `bump`, or a `roll`
//                                    (heartline corkscrew: the frame twists about the
//                                    straight centerline, ±360° = one full barrel roll).
//   arc(radius, angleDeg, opts)    — a turn; angle>0 = LEFT, <0 = RIGHT; optional `rise`.
//   loop(radius, opts)             — a vertical loop: a 180° HALF-loop by default (exits at
//                                    ±2·radius heading the opposite way, frame flipped), or
//                                    with `drift` the FULL 360° TILTED toy loop (exit lands
//                                    `drift` beside the entry, parallel, same elevation).
// We walk a scalar cursor (plan position, heading, elevation) forward, emitting samples
// at a uniform arclength step. Heading 0 = +Z travel; +heading turns toward -X (left).
// The frame's `up` is parallel-transported (rotation-minimizing) so it stays perpendicular
// through hills, and the start/finish twist (holonomy) is unwound so `up` doesn't jump
// at the seam. (Banking + variable width layer onto this in later passes.)
import * as THREE from 'three';
import { Centerline } from './Centerline.js';
// Track DEFINITIONS (the catalogue) live in a dependency-free data module so the
// gallery + tests can read them without pulling in Three.js. We re-export the few
// that callers still import via TrackBuilder; everything else imports from tracks.js.
import { TRACKS, TRACK_LIST } from '../shared/tracks.js';

const SCALE = 2;           // unscaled track units → world (bigger track, more room for cars)
const ROAD_WIDTH = 2.5;    // default drivable width (unscaled); ×SCALE = 5.0 world. The
                           // single source of truth, read by the physics (maxLat in Game.js)
                           // AND the procedural road ribbon in SceneRenderer.
const GATE_WIDTH = 1.55;   // gate-finish arch span (measured) — scaled up to span the road
const DS = 0.25;           // centerline sample step (unscaled) — uniform arclength spacing,
                           // a few× finer than a kerb stripe and well above the min-seg floor.

// SMOOTHERSTEP (Perlin): zero FIRST and SECOND derivative at the ends, so a grade eases
// its pitch on/off smoothly (a plain ramp snaps to full pitch the instant it starts).
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const smoothstep = (t) => t * t * (3 - 2 * t); // C1 ends — used for the chicane lateral shift
// Bank easing across a segment: 0 at both ends, full in the middle (ease in over the
// first BANK_RAMP, hold, ease out) — so a banked corner leans in/out smoothly and is
// flat where it meets a straight.
const BANK_RAMP = 0.35;
const bankWindow = (f) => f < BANK_RAMP ? smootherstep(f / BANK_RAMP)
  : f > 1 - BANK_RAMP ? smootherstep((1 - f) / BANK_RAMP) : 1;
const v = (x, y, z) => new THREE.Vector3(x, y, z);

// Plan-frame basis at heading θ: travel direction and lateral-LEFT direction (the
// inward normal of a left turn). d = dL/dθ, so rotating L by φ gives L(θ+φ) — which is
// what makes the closed-form arc below exact.
const dirX = (th) => -Math.sin(th), dirZ = (th) => Math.cos(th);
const latX = (th) => -Math.cos(th), latZ = (th) => -Math.sin(th);
const DEG = Math.PI / 180;

// Build the track. `track` is a bare segment array OR a catalogue descriptor
// ({ segments, width, ... }) from shared/tracks.js. `opts.startGate` (default true)
// straddles the start/finish line with the gate-finish arch.
// Returns { instances, centerline, length, closed, gap, roadWidth, groundY }.
// `instances` carries only non-road scenery GLBs to place (currently the start/finish
// gate); the road surface itself is generated procedurally from `centerline`, as are the
// support pillars (`pillars`: vertical columns under any `pillars`-flagged bridge/ramp).
export function buildTrack(track, opts = {}) {
  // Two authoring models: a closed loop of WAYPOINTS (organic, flowing — buildSplineTrack)
  // or a sequence of parametric SEGMENTS (the turtle walk below; required for loops/spirals).
  if (track && !Array.isArray(track) && Array.isArray(track.waypoints)) return buildSplineTrack(track, opts);
  const { startGate = true } = opts;
  const segments = Array.isArray(track) ? track : (track && track.segments);
  if (!Array.isArray(segments)) {
    throw new Error('buildTrack: expected a segment array or a track descriptor with a .segments array');
  }
  const trackWidth = (track && !Array.isArray(track) && track.width) || ROAD_WIDTH;

  // Per-segment drivable width at local fraction f: a number (constant), an [a,b] taper,
  // or the track default. Carried per sample so the road can flare/pinch along the lap.
  const segWidth = (seg, f) => {
    const w = seg.width;
    if (w == null) return trackWidth;
    return Array.isArray(w) ? w[0] + (w[1] - w[0]) * f : w;
  };
  // Per-sample bank roll (radians, eased), signed to lean INTO the turn: a positive
  // `bank` on a left arc rolls `up` one way, on a right arc the other. A straight has no
  // turn direction, so by convention it banks toward +lateral (no shipped track banks a
  // straight). Applied to the frame after parallel-transport (a roll about the tangent),
  // so it can't break closure.
  const segBank = (seg, f) => {
    if (!seg.bank) return 0;
    const sign = seg.kind === 'arc' ? Math.sign(seg.angle || 1) : 1;
    return seg.bank * DEG * bankWindow(f) * sign;
  };
  // Heartline ROLL (corkscrew): `roll: ±360` twists the frame fully about the tangent
  // across the segment, eased (smootherstep) so the twist RATE is zero at both ends.
  // The centerline itself doesn't move (it's the road that corkscrews around it), so
  // put a rolled straight on a RAISED run: at 90° the road edge hangs a half-width
  // below the centerline and must still clear the grass. Stacks with `bank`.
  //
  // Roll is CUMULATIVE (`rollAcc`): unlike bank (a local lean that returns to 0), a
  // roll permanently re-clocks the frame, so every later sample carries the running
  // total. That's what lets `roll: 180` right a frame that a half-loop left INVERTED
  // — parallel transport says the rest of the lap is upside down, and the held +180°
  // counter-roll corrects every sample downstream. A lap must net to 0 (mod 360°):
  // each half-loop contributes 180° of transported flip, each roll its angle — e.g.
  // loop + roll:180 + roll:360 + roll:-360 ≡ 0. (Get it wrong and the seam unwind
  // smears the residual twist around the whole lap — the upright-seam test catches it.)
  let rollAcc = 0;
  const segTwist = (seg, f) => segBank(seg, f) + rollAcc + (seg.roll ? seg.roll * DEG * smootherstep(f) : 0);

  // ---- Forward integrate the centerline (unscaled plan coords) ----
  let X = 0, Z = 0, theta = 0, elev = 0;     // cursor
  const worldPts = [v(0, 0, 0)];             // start at origin; scaled to world after the walk
  const widths = [trackWidth];               // per-sample drivable width (unscaled), parallel to worldPts
  const banks = [0];                          // per-sample bank roll (radians), parallel to worldPts
  const pillarFlags = [false];                // per-sample: emitted by a `pillars` (raised bridge/ramp) segment
  const hillFlags = [false];                  // per-sample: a non-pillared straight rise/bump → can carry a grass hill
  const loopEntryIdx = [];                    // worldPts index of each loop's MOUTH (the flat sample just before it climbs)

  for (const seg of segments) {
    if (seg.kind === 'straight') {
      const len = seg.length, lat = seg.lateral || 0, rise = seg.rise || 0, bump = seg.bump || 0;
      const N = Math.max(1, Math.round(len / DS));
      const dx = dirX(theta), dz = dirZ(theta), lx = latX(theta), lz = latZ(theta);
      const x0 = X, z0 = Z, y0 = elev;
      for (let i = 1; i <= N; i++) {
        // Lateral shift eases with SMOOTHstep, not smootherstep: smootherstep zeroes the
        // 2nd derivative at both ends, so at a chicane's interior joint the turn-rate dwells
        // to ~0 (a hitch felt as a left-right "shift" mid-S). smoothstep carries a continuous
        // non-zero curvature through that joint, and its gentler peak slope (1.5 vs 1.875)
        // softens the swing. (rise/bump below stay smootherstep — grades want the C2 ends.)
        const f = i / N, off = lat * smoothstep(f);
        worldPts.push(v(
          x0 + dx * len * f + lx * off,
          y0 + rise * smootherstep(f) + bump * (1 - Math.cos(2 * Math.PI * f)) / 2,
          z0 + dz * len * f + lz * off
        ));
        widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
        hillFlags.push(!seg.pillars && (!!seg.rise || !!seg.bump)); // open-ground grade → a grass hill
      }
      X = x0 + dx * len + lx * lat; Z = z0 + dz * len + lz * lat; elev = y0 + rise;
    } else if (seg.kind === 'arc') {
      const R = seg.radius, ang = (seg.angle || 0) * DEG, rise = seg.rise || 0;
      const sgn = Math.sign(ang) || 1, A = Math.abs(ang);
      const x0 = X, z0 = Z, y0 = elev, th0 = theta;
      // Exact arc: point(φ) = P0 + R·sgn·(L(θ0) − L(θ0+φ)), left/right via sgn.
      const N = Math.max(1, Math.round(R * A / DS));
      for (let i = 1; i <= N; i++) {
        const f = i / N, th = th0 + ang * f;
        worldPts.push(v(x0 + R * sgn * (latX(th0) - latX(th)), y0 + rise * smootherstep(f), z0 + R * sgn * (latZ(th0) - latZ(th))));
        widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
        hillFlags.push(false); // arcs (corners, the spiral) never carry a hill
      }
      X = x0 + R * sgn * (latX(th0) - latX(th0 + ang));
      Z = z0 + R * sgn * (latZ(th0) - latZ(th0 + ang));
      theta = th0 + ang; elev = y0 + rise;
    } else if (seg.kind === 'loop') {
      // Vertical LOOP. Default: a HALF-loop — 180° of a circle in the (travel, up)
      // plane, exiting directly above (or below, `over: false`) the entry, heading
      // the OPPOSITE way; planar, so transport adds no twist and the curvature is
      // pure in-frame pitch (cars auto-follow, no steering, no wash) — the frame
      // simply exits flipped. With `drift`: the full tilted loop below — the one
      // 360° shape whose exit corridor CAN'T collide with its own entry climb,
      // because the sideways lean lands it a road width over.
      loopEntryIdx.push(worldPts.length - 1); // the last point IS the cursor = the loop's flat mouth
      const r = seg.radius;
      const vert = seg.over === false ? -1 : 1;
      const drift = seg.drift || 0;
      const dx = dirX(theta), dz = dirZ(theta), lx = latX(theta), lz = latZ(theta);
      const x0 = X, z0 = Z, y0 = elev;
      if (drift) {
        // FULL 360° TILTED LOOP (the toy-track loop): one complete circle whose
        // plane leans sideways — a single helix turn about the LATERAL axis — so
        // going around lands the exit `drift` beside the entry, parallel, at the
        // same elevation, heading unchanged. No crown, no roll-out: the only
        // upside-down moment is the instant over the top. The drift eases with
        // smoothstep so both feet leave/land dead straight (zero side-rate at the
        // joints); mid-loop the gentle steady heading lean is what the cars steer
        // (and what reads as the ring's tilt). Plan-wise the whole element is a
        // pure lateral jog of `drift`.
        const N = Math.max(16, Math.round(2 * Math.PI * r / DS));
        for (let i = 1; i <= N; i++) {
          const f = i / N, phi = 2 * Math.PI * f, off = drift * smoothstep(f);
          const fwd = r * Math.sin(phi);
          worldPts.push(v(x0 + dx * fwd + lx * off, y0 + vert * r * (1 - Math.cos(phi)), z0 + dz * fwd + lz * off));
          widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
          hillFlags.push(false); // a loop is a stunt, never a hill
        }
        X = x0 + lx * drift; Z = z0 + lz * drift; // beside the entry; heading + elev unchanged
      } else {
        const N = Math.max(8, Math.round(Math.PI * r / DS));
        for (let i = 1; i <= N; i++) {
          const f = i / N, phi = Math.PI * f;
          const fwd = r * Math.sin(phi); // along-travel excursion; back to 0 at the apex
          worldPts.push(v(x0 + dx * fwd, y0 + vert * r * (1 - Math.cos(phi)), z0 + dz * fwd));
          widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
          hillFlags.push(false); // a loop is a stunt, never a hill
        }
        theta += Math.PI;           // heading reversed
        elev = y0 + vert * 2 * r;   // apex directly above/below the entry; X/Z unchanged
      }
        } else {
      throw new Error(`Unknown segment kind "${seg && seg.kind}" (expected "straight", "arc" or "loop")`);
    }
    if (seg.roll) rollAcc = (rollAcc + seg.roll * DEG) % (2 * Math.PI); // re-clock the frame for everything downstream
  }

  return finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, loopEntryIdx, trackWidth, { startGate });
}

// Shared finalize — frames (parallel transport + banking + holonomy unwind), support pillars,
// grass-hill berms, the start gate, and the Centerline. Fed by BOTH the segment walk
// (buildTrack) and the waypoint sampler (buildSplineTrack): the integrated centreline points
// (UNSCALED) plus per-sample width / bank(radians) / pillar / hill flags, and loop mouths.
function finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, loopEntryIdx, trackWidth, { startGate = true } = {}) {
  // Closure: the last emitted point duplicates the start on a closed loop — drop it so the
  // ring has no zero-length seam segment (the wrap last→first then spans one step).
  const gap = worldPts[worldPts.length - 1].distanceTo(worldPts[0]);
  // `closed` tolerates up to 0.5 (unscaled); the duplicate-point drop below only fires within
  // DS. Tracks close to gap≈0 in practice (the "every named track closes" test guards it).
  const closed = gap < 0.5;
  if (worldPts.length > 3 && worldPts[worldPts.length - 1].distanceTo(worldPts[0]) < DS) { worldPts.pop(); widths.pop(); banks.pop(); pillarFlags.pop(); hillFlags.pop(); }

  // Scale positions + widths to world.
  for (const p of worldPts) p.multiplyScalar(SCALE);
  for (let i = 0; i < widths.length; i++) widths[i] *= SCALE;
  // Ease width transitions across segment joints so a flare/pinch ramps over a short
  // span instead of stepping at one sample (a few light wrapping-average passes).
  for (let pass = 0; pass < 3; pass++) {
    const w = widths.slice();
    for (let i = 0; i < widths.length; i++) {
      widths[i] = 0.5 * w[i] + 0.25 * (w[(i - 1 + widths.length) % widths.length] + w[(i + 1) % widths.length]);
    }
  }

  // (No position smoothing pass: clothoid arc transitions + the C2 chicane ease give a
  // curvature-continuous centreline by construction, so the old Laplacian — which also
  // rippled the steady arc and shrank the radius — is gone.)
  const n = worldPts.length;

  // Tangents via central differences around the closed ring.
  const tangents = [];
  for (let i = 0; i < n; i++) {
    tangents.push(worldPts[(i + 1) % n].clone().sub(worldPts[(i - 1 + n) % n]).normalize());
  }
  // Parallel-transport (rotation-minimizing frame) an `up` vector around the ring so the
  // ribbon carries REAL 3D orientation: ~+Y on flat track, tilting to stay perpendicular
  // through hills. Each step rotates `up` by the rotation that turns the previous tangent
  // into the current one, then re-orthogonalizes against drift.
  let up = v(0, 1, 0);
  up.addScaledVector(tangents[0], -up.dot(tangents[0]));
  if (up.lengthSq() < 1e-6) up = v(0, 0, 1).addScaledVector(tangents[0], -tangents[0].z);
  up.normalize();
  const ups = [up.clone()];
  for (let i = 1; i < n; i++) {
    const t0 = tangents[i - 1], t1 = tangents[i];
    const axis = t0.clone().cross(t1);
    const sin = axis.length();
    if (sin > 1e-8) {
      axis.multiplyScalar(1 / sin);
      up.applyAxisAngle(axis, Math.atan2(sin, Math.max(-1, Math.min(1, t0.dot(t1)))));
    }
    up.addScaledVector(t1, -up.dot(t1)).normalize();
    ups.push(up.clone());
  }
  // Banking + roll: roll each frame about its tangent by the per-sample twist angle, so
  // `lateral = tangent × up` (computed below) tilts with the road and the physics/car/
  // ribbon all lean together. Applied BEFORE the holonomy unwind: a half-loop leaves the
  // transported frame inverted and the cumulative roll is what rights it — the unwind
  // must measure the CORRECTED frames, or it would read that inversion as a fake π
  // residual and smear a full twist around the lap.
  for (let i = 0; i < n; i++) if (banks[i]) ups[i].applyAxisAngle(tangents[i], banks[i]);
  // Unwind the residual twist (frame holonomy) evenly so `up` doesn't jump at the seam.
  const t0 = tangents[0];
  const resid = Math.atan2(ups[n - 1].clone().cross(ups[0]).dot(t0), ups[n - 1].dot(ups[0]));
  for (let i = 0; i < n; i++) {
    up.copy(ups[i]).applyAxisAngle(tangents[i], resid * (i / n));
    ups[i].copy(up);
  }

  const samples = [];
  let s = 0, minY = Infinity, minEdgeY = Infinity;
  for (let i = 0; i < n; i++) {
    const tangent = tangents[i], u = ups[i];
    const lateral = tangent.clone().cross(u).normalize();
    if (i > 0) s += worldPts[i].distanceTo(worldPts[i - 1]);
    minY = Math.min(minY, worldPts[i].y);
    minEdgeY = Math.min(minEdgeY, worldPts[i].y - Math.abs(lateral.y) * widths[i] / 2);
    samples.push({ pos: worldPts[i].clone(), tangent, up: u, lateral, s, width: widths[i], pillars: pillarFlags[i], hillable: hillFlags[i] });
  }
  const length = s + worldPts[n - 1].distanceTo(worldPts[0]); // close the loop
  // Loop mouths in arclength (+ the local road width there): the display auto-places a
  // full-width launch pad at each, so a looping is always entered on boost. Interior
  // indices, so the seam duplicate-point drop (last point only) never invalidates them.
  const loopStarts = loopEntryIdx.map((idx) => ({ s: samples[idx].s, width: samples[idx].width }));
  // Grass plane: just under the lowest point of the track — measured at the road
  // EDGE, not the centreline, so a banked corner's leaned-in kerb can't clip through
  // the lawn (on a flat track edge == centreline and this is the classic minY − 0.3).
  const groundY = Math.min(minY - 0.3, minEdgeY - 0.12);

  const instances = [];
  // Start/finish gate: the gate-finish arch straddling the line at s=0, oriented across
  // the lane (X=lateral, Y=up, Z=travel), legs straddling the road onto the grass.
  if (startGate) {
    const g = samples[0];
    const LEG_OVERHANG = 0.9; // how far each leg lands beyond the road edge, onto the grass
    const GS = (trackWidth * SCALE + 2 * LEG_OVERHANG) / GATE_WIDTH; // straddle the full road
    const m = new THREE.Matrix4().makeBasis(g.lateral.clone(), g.up.clone(), g.tangent.clone());
    m.scale(new THREE.Vector3(GS, GS, GS));
    m.setPosition(g.pos.clone().addScaledVector(g.up, -0.02 * SCALE)); // a hair into the road
    instances.push({ glb: 'gate-finish', matrix: m });
  }

  // ---- Support pillars under raised bridge/ramp segments (opt `pillars: true`) ----
  // March the flagged samples at a fixed arclength spacing and record a vertical column
  // running from the grass plane up to just under the deck (SceneRenderer renders each as
  // a simple cylinder). A station is SKIPPED where the foot would land on a LOWER stretch
  // of road (the spine a crossover bridge flies over): there the deck must clear the
  // roadway, so we leave the gap unsupported rather than drop a column onto the track below.
  const pillars = [];
  if (samples.some((p) => p.pillars)) {
    const SPACING = 3.2;     // world units between pillars along the deck
    const MIN_H = 0.7;       // skip pillars shorter than this — trims the stubby ramp feet
    const RADIUS = 0.5;      // column radius (world units)
    const TUCK = 0.3;        // top nestles just under the deck skirt
    const EMBED = 0.1;       // sink the base below the grass plane so the cap isn't coplanar (z-fighting)
    const LEVEL_GAP = 1.0;   // a sample this far BELOW a deck counts as "road running underneath"
    const MARGIN = 0.3;      // keep the foot this far clear of a lower road's edge
    let acc = SPACING;       // prime so the first flagged sample places a pillar
    for (let i = 0; i < n; i++) {
      if (i > 0) acc += worldPts[i].distanceTo(worldPts[i - 1]);
      const smp = samples[i];
      if (!smp.pillars || acc < SPACING) continue;
      // Only prop up a deck that's roughly RIGHT-SIDE-UP: under a rolled (corkscrew)
      // or looping stretch, "just below the centerline" is inside or above the road
      // surface, so a column there would stab through the ribbon.
      if (smp.up.y < 0.7) continue;
      acc = 0;
      const topY = smp.pos.y - TUCK;
      if (topY - groundY < MIN_H) continue;
      // Keep the roadway below clear: skip if the round foot would overlap a clearly-lower
      // road (centre-to-centre < its half-width + our radius + margin). A round column has
      // no orientation, so a plain radial clearance is exact.
      let onRoad = false;
      for (let j = 0; j < n; j++) {
        if (smp.pos.y - samples[j].pos.y < LEVEL_GAP) continue;
        const dx = samples[j].pos.x - smp.pos.x, dz = samples[j].pos.z - smp.pos.z;
        const clear = samples[j].width / 2 + RADIUS + MARGIN;
        if (dx * dx + dz * dz < clear * clear) { onRoad = true; break; }
      }
      if (onRoad) continue;
      pillars.push({ x: smp.pos.x, z: smp.pos.z, baseY: groundY - EMBED, topY, radius: RADIUS });
    }
  }

  // ---- Grass hills (berms) under raised, NON-pillared road — the organic counterpart
  // to pillars. A raised deck needs something beneath it or it floats over the flat lawn:
  // a bridge gets pillars (above), a hill gets terrain — a grass berm lofted up to meet
  // the road underside, flaring back down to the lawn (hiding the deck's grey skirt). A
  // sample berms when it's `hillable` (its segment is an open-ground straight rise/bump —
  // loops, arcs/the spiral and bridges are NOT, so a berm can never mound up a stunt),
  // it rises above the lawn (HILL_MIN skips the dead-flat ends), and NO road runs beneath
  // it (else the berm would bury the lower road — that span stays open air). Contiguous
  // hill samples form a run; runs shorter than MIN_RUN are dropped as noise. Each run is
  // emitted as lofted cross-section rings (left foot → left top → right top → right foot),
  // feathered to lawn level one sample past each end so the berm rises smoothly out of
  // flat ground. SceneRenderer.buildHills stitches the rings into a grass surface.
  const hills = [];
  {
    const HILL_MIN = 0.15;  // a hillable sample this close to the lawn is essentially flat — skip it
    const MIN_RUN = 1.0;    // world units; drop any stray sub-threshold run as noise
    const TUCK = 0.15;      // berm top sits this far under the road surface — grass hugs the road edge, hiding the skirt
    const EDGE = 0.25;      // berm top reaches this far past the drivable edge, hiding the skirt
    const LEVEL_GAP = 1.0;  // a sample this far BELOW counts as road running underneath
    const REACH = 3.2;      // berm footprint half-extent for the under-road clearance test
    const ARC_GUARD = 12;   // ignore road within this arclength — it's the hill's OWN flanks, not a crossing
    const isHill = (i) => {
      const s = samples[i];
      if (!s.hillable || s.pos.y - groundY < HILL_MIN) return false;
      for (let j = 0; j < n; j++) {
        if (s.pos.y - samples[j].pos.y < LEVEL_GAP) continue; // not clearly below us
        const ds = Math.abs(s.s - samples[j].s);
        if (Math.min(ds, length - ds) < ARC_GUARD) continue;  // the hill's own descending flank, not a road it flies over
        const dx = samples[j].pos.x - s.pos.x, dz = samples[j].pos.z - s.pos.z;
        const clear = samples[j].width / 2 + REACH;
        if (dx * dx + dz * dz < clear * clear) return false;  // a genuinely lower, separate road below — keep open air
      }
      return true;
    };
    let i = 0;
    while (i < n) {
      if (!isHill(i)) { i++; continue; }
      const a = i; while (i < n && isHill(i)) i++;
      const b = i - 1;
      if (samples[b].s - samples[a].s < MIN_RUN) continue; // drop noise
      const lo = Math.max(0, a - 1), hi = Math.min(n - 1, b + 1); // feather one sample past each end
      const rings = [];
      for (let k = lo; k <= hi; k++) {
        const s = samples[k];
        let lx = s.lateral.x, lz = s.lateral.z;
        const ll = Math.hypot(lx, lz);
        if (ll < 1e-6) { lx = 1; lz = 0; } else { lx /= ll; lz /= ll; }
        const feather = (k < a || k > b);
        const halfW = s.width / 2 + EDGE;
        // topY = road − TUCK, but never below the lawn: where the road is within TUCK of
        // the ground (the hill's foot) the berm just meets the lawn flush rather than dipping
        // under. The two top corners FOLLOW THE ROAD'S BANK: a tilted deck (authored bank, or
        // the transport frame rolling on a curving descent) has one edge lower than the other,
        // so a flat berm top would poke up through the low edge. slope = Δy per unit horizontal
        // along the lateral; the corners ride ±slope·halfW off the centre, TUCK under the deck.
        const slope = ll < 1e-6 ? 0 : s.lateral.y / ll;
        const top = (sign) => feather ? groundY : Math.max(groundY, s.pos.y + sign * slope * halfW - TUCK);
        rings.push({ cx: s.pos.x, cz: s.pos.z, lx, lz, halfW, topL: top(-1), topR: top(1) });
      }
      hills.push(rings);
    }
  }

  return {
    instances,
    pillars,
    hills,
    loopStarts,
    centerline: new Centerline(samples, length),
    length, closed, gap,
    roadWidth: trackWidth * SCALE,
    groundY // grass plane just under the road
  };
}

// Build a track from a CLOSED loop of WAYPOINTS — the organic, flowing counterpart to the
// segment walk. Each waypoint: { x, z, y?, w?, bank?, bridge? } (unscaled plan coords; `y`
// elevation; `w` drivable-width override; `bank` degrees; `bridge: true` → a pillared deck
// that flies over a lower strand). A CENTRIPETAL Catmull-Rom (alpha=0.5 — no overshoot or
// cusps, unlike the uniform kind) threads the points; we sample it at ~DS spacing and hand
// the result to the SAME finalize the segment tracks use. Closes by construction (it's a
// loop), so there is no closure algebra — draw the shape you want.
function buildSplineTrack(track, opts = {}) {
  const { startGate = true } = opts;
  const pts = track.waypoints, m = pts.length;
  const trackWidth = track.width || ROAD_WIDTH;
  const at = (i) => pts[((i % m) + m) % m];
  const P = (i) => { const p = at(i); return v(p.x, p.y || 0, p.z); };
  const knot = (ti, a, b) => ti + Math.sqrt(Math.max(1e-6, a.distanceTo(b))); // centripetal (alpha=0.5)
  const worldPts = [], widths = [], banks = [], pillarFlags = [], hillFlags = [];
  for (let i = 0; i < m; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const SUB = Math.max(8, Math.ceil(p1.distanceTo(p2) / DS)); // ~DS spacing along this span
    const wA = at(i).w || trackWidth, wB = at(i + 1).w || trackWidth;
    const bA = (at(i).bank || 0) * DEG, bB = (at(i + 1).bank || 0) * DEG;
    const bridge = !!(at(i).bridge || at(i + 1).bridge); // ramp segments (one end flagged) bridge too
    for (let k = 0; k < SUB; k++) {
      const frac = k / SUB, t = t1 + (t2 - t1) * frac;
      // Barry-Goldman pyramid (works in 3D, x/y/z together). Mind the aliasing: a2 feeds
      // both b1 (by reference, unmutated) and b2 (cloned), so neither corrupts the other.
      const a1 = p0.clone().multiplyScalar((t1 - t) / (t1 - t0)).addScaledVector(p1, (t - t0) / (t1 - t0));
      const a2 = p1.clone().multiplyScalar((t2 - t) / (t2 - t1)).addScaledVector(p2, (t - t1) / (t2 - t1));
      const a3 = p2.clone().multiplyScalar((t3 - t) / (t3 - t2)).addScaledVector(p3, (t - t2) / (t3 - t2));
      const b1 = a1.multiplyScalar((t2 - t) / (t2 - t0)).addScaledVector(a2, (t - t0) / (t2 - t0));
      const b2 = a2.clone().multiplyScalar((t3 - t) / (t3 - t1)).addScaledVector(a3, (t - t1) / (t3 - t1));
      const c = b1.multiplyScalar((t2 - t) / (t2 - t1)).addScaledVector(b2, (t - t1) / (t2 - t1));
      worldPts.push(c);
      widths.push(wA + (wB - wA) * frac);
      banks.push(bA + (bB - bA) * frac);
      pillarFlags.push(bridge);
      hillFlags.push(!bridge && c.y > 0.1); // a raised, non-bridge stretch grows a grass berm
    }
  }
  return finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, [], trackWidth, { startGate });
}

// Track definitions + the named registry live in the dependency-free catalogue
// (../shared/tracks.js). Re-export what callers import via TrackBuilder: TRACKS
// (the tests) and TRACK_LIST (main.js + the lobby track picker).
export { TRACKS, TRACK_LIST };
