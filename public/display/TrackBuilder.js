// TrackBuilder — integrates a list of parametric SEGMENTS into a drivable centerline
// ribbon the car physics follows AND the renderer sweeps the procedural road over
// (see SceneRenderer._buildRibbonRoad). There are no road meshes here — only geometry.
//
// A track is authored as a sequence of segments (see ../shared/tracks.js):
//   straight(length, opts)         — a run, optionally with an elevation `rise` or a
//                                    `roll` (heartline corkscrew: the frame twists about
//                                    the straight centerline, ±360° = one full barrel roll).
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
import { Vec3 } from './engine/Vec3.js';
import * as dmath from './engine/math.js';
import { CONTRACT_VERSION } from './engine/contract.js';
import { Centerline } from './Centerline.js';
// Track DEFINITIONS (the catalogue) live in a dependency-free data module so the
// gallery + tests can read them without pulling in Three.js. We re-export the few
// that callers still import via TrackBuilder; everything else imports from tracks.js.
import { TRACKS, TRACK_LIST } from '../shared/tracks.js';

export const SCALE = 2;    // unscaled track units → world (bigger track, more room for cars). Exported so the offline generator (scripts/track-gen.mjs) shares the exact value rather than duplicating it.
const ROAD_WIDTH = 2.5;    // default drivable width (unscaled); ×SCALE = 5.0 world. The
                           // single source of truth, read by the physics (maxLat in Game.js)
                           // AND the procedural road ribbon in SceneRenderer.
const DS = 0.25;           // centerline sample step (unscaled) — uniform arclength spacing,
                           // a few× finer than a kerb stripe and well above the min-seg floor.

// SMOOTHERSTEP (Perlin): zero FIRST and SECOND derivative at the ends, so a grade eases
// its pitch on/off smoothly (a plain ramp snaps to full pitch the instant it starts).
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const smoothstep = (t) => t * t * (3 - 2 * t); // C1 ends — used for the tilted loop's drift
// Bank easing across a segment: 0 at both ends, full in the middle (ease in over the
// first BANK_RAMP, hold, ease out) — so a banked corner leans in/out smoothly and is
// flat where it meets a straight.
const BANK_RAMP = 0.35;
const bankWindow = (f) => f < BANK_RAMP ? smootherstep(f / BANK_RAMP)
  : f > 1 - BANK_RAMP ? smootherstep((1 - f) / BANK_RAMP) : 1;
// Every vector on the build path is minted here: the sim's own Vec3 (bit-identical
// to THREE.Vector3 — see engine/Vec3.js), so the whole data path is three-free.
const v = (x, y, z) => new Vec3(x, y, z);

// Plan-frame basis at heading θ: travel direction and lateral-LEFT direction (the
// inward normal of a left turn). d = dL/dθ, so rotating L by φ gives L(θ+φ) — which is
// what makes the closed-form arc below exact.
const dirX = (th) => -dmath.sin(th), dirZ = (th) => dmath.cos(th);
const latX = (th) => -dmath.cos(th), latZ = (th) => -dmath.sin(th);
const DEG = Math.PI / 180;

// Build the track. `track` is a bare segment array OR a catalogue descriptor
// ({ segments, width, startU, ... }) from shared/tracks.js. `opts.startGate` (default true)
// straddles the start/finish line with the procedural finish gantry (`startGate` on the
// returned track — built render-side, see render/FinishGate.js). `startU` (default 0, also
// takeable from the descriptor) moves that line a fraction of a lap around the ring so the
// grid — which sits BEHIND it — lands on a straight; see finalizeTrack.
// Returns { version, instances, startGate, centerline, length, closed, gap, roadWidth, groundY }.
// `instances` carries non-road scenery GLBs to place (none today); the road surface
// itself is generated procedurally from `centerline`, as are the support pillars
// (`pillars`: vertical columns under any `pillars`-flagged bridge/ramp).
export function buildTrack(track, opts = {}) {
  // Two authoring models: a closed loop of WAYPOINTS (organic, flowing — buildSplineTrack)
  // or a sequence of parametric SEGMENTS (the turtle walk below; required for loops/spirals).
  if (track && !Array.isArray(track) && Array.isArray(track.waypoints)) return buildSplineTrack(track, opts);
  const desc = (track && !Array.isArray(track)) ? track : null;
  const { startGate = true } = opts;
  const startU = opts.startU ?? (desc && desc.startU) ?? 0;
  const segments = Array.isArray(track) ? track : (desc && desc.segments);
  if (!Array.isArray(segments)) {
    throw new Error('buildTrack: expected a segment array or a track descriptor with a .segments array');
  }
  const trackWidth = (desc && desc.width) || ROAD_WIDTH;

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
  const hillFlags = [false];                  // per-sample: a non-pillared straight rise → can carry a grass hill
  const loopEntryIdx = [];                    // worldPts index of each loop's MOUTH (the flat sample just before it climbs)

  for (const seg of segments) {
    if (seg.kind === 'straight') {
      const len = seg.length, rise = seg.rise || 0;
      const N = Math.max(1, Math.round(len / DS));
      const dx = dirX(theta), dz = dirZ(theta);
      const x0 = X, z0 = Z, y0 = elev;
      for (let i = 1; i <= N; i++) {
        const f = i / N;
        worldPts.push(v(
          x0 + dx * len * f,
          y0 + rise * smootherstep(f), // smootherstep — grades want the C2 ends
          z0 + dz * len * f
        ));
        widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
        hillFlags.push(!seg.pillars && !!seg.rise); // open-ground grade → a grass hill
      }
      X = x0 + dx * len; Z = z0 + dz * len; elev = y0 + rise;
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
          const fwd = r * dmath.sin(phi);
          worldPts.push(v(x0 + dx * fwd + lx * off, y0 + vert * r * (1 - dmath.cos(phi)), z0 + dz * fwd + lz * off));
          widths.push(segWidth(seg, f)); banks.push(segTwist(seg, f)); pillarFlags.push(!!seg.pillars);
          hillFlags.push(false); // a loop is a stunt, never a hill
        }
        X = x0 + lx * drift; Z = z0 + lz * drift; // beside the entry; heading + elev unchanged
      } else {
        const N = Math.max(8, Math.round(Math.PI * r / DS));
        for (let i = 1; i <= N; i++) {
          const f = i / N, phi = Math.PI * f;
          const fwd = r * dmath.sin(phi); // along-travel excursion; back to 0 at the apex
          worldPts.push(v(x0 + dx * fwd, y0 + vert * r * (1 - dmath.cos(phi)), z0 + dz * fwd));
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

  return finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, loopEntryIdx, trackWidth, { startGate, startU });
}

// A support post's relation to ONE centreline sample — the single source of truth for
// "does this column stand in this corridor, and how deep". Returns null unless the
// sample is an upright corridor (not a tilted stunt flank), the post's vertical span
// crosses the road there, and the post is ABEAM of it (tangential offset within the
// post's own footprint plus sampling slack). Intrusion is then the LATERAL protrusion
// of the post's edge past the kerb (negative = clear by that much). The RADIAL
// post→sample distance must never stand in for intrusion: a strand climbing over its
// own support re-enters the pillar's height band ~2.5 units down the road while still
// radially close, which fabricated "deep intruders" and planted collision poles
// mid-lane on the approach — the invisible pole that survived its own sliver ban
// (shipped on Sidewinder; retired Crossover had one dead-centre). Exported so the
// geometry audit (scripts/audit-tracks.mjs) and the unit tests measure with THIS
// function — a hand-synced copy is how the radial bug slipped its regression test.
export function postAtSample(sm, post) {
  if (sm.up.y < 0.9) return null;                                        // tilted stunt flank — not a corridor
  if (sm.pos.y < post.baseY - 0.5 || sm.pos.y > post.topY - 0.5) return null; // column doesn't cross this road
  const dx = post.x - sm.pos.x, dz = post.z - sm.pos.z;
  const tl = dmath.hypot(sm.tangent.x, sm.tangent.z) || 1;
  const tan = (dx * sm.tangent.x + dz * sm.tangent.z) / tl;
  if (Math.abs(tan) > post.radius + 0.35) return null;                   // not abeam — no say
  const ll = dmath.hypot(sm.lateral.x, sm.lateral.z) || 1;
  const lat = (dx * sm.lateral.x + dz * sm.lateral.z) / ll;
  return { lat, tan, intrusion: sm.width / 2 + post.radius - Math.abs(lat) };
}

// Shared finalize — frames (parallel transport + banking + holonomy unwind), support pillars,
// grass-hill berms, the start gate, and the Centerline. Fed by BOTH the segment walk
// (buildTrack) and the waypoint sampler (buildSplineTrack): the integrated centreline points
// (UNSCALED) plus per-sample width / bank(radians) / pillar / hill flags, and loop mouths.
function finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, loopEntryIdx, trackWidth, { startGate = true, startU = 0 } = {}) {
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
      up.applyAxisAngle(axis, dmath.atan2(sin, Math.max(-1, Math.min(1, t0.dot(t1)))));
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
  const resid = dmath.atan2(ups[n - 1].clone().cross(ups[0]).dot(t0), ups[n - 1].dot(ups[0]));
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

  // A support post standing in (or near) a drivable corridor must be CLEARLY placed:
  // either at least POST_CLEAR outside every corridor, or a POST_DEEP-visible obstacle
  // inside one (which then gets a collision autoPole below). The sliver zone between —
  // a post peeking a few cm past the kerb — is banned: its ghost collision pole would
  // bonk rail-riding cars off something they can't see ("the invisible pole").
  const POST_CLEAR = 0.15, POST_DEEP = 0.5;
  // intrusionOf: how far a column's edge protrudes past the kerb into the deepest
  // upright corridor its vertical span crosses (negative = clear by that much;
  // -Infinity = abeam of no corridor at all).
  const intrusionOf = (post) => {
    let worst = -Infinity;
    for (let j = 0; j < n; j++) {
      const hit = postAtSample(samples[j], post);
      if (hit) worst = Math.max(worst, hit.intrusion);
    }
    return worst;
  };

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
      // Ban the sliver zone against ANY corridor the column crosses (the check above
      // only sees clearly-lower roads; a graze against a similar-height deck slipped
      // through). Deep intruders are kept — a visible on-road post with collision.
      const intr = intrusionOf({ x: smp.pos.x, z: smp.pos.z, radius: RADIUS, baseY: groundY - EMBED, topY });
      if (intr > -POST_CLEAR && intr < POST_DEEP) continue;
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
        const ll = dmath.hypot(lx, lz);
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

  // ---- Loop support shafts — a vertical post bracing each 360° loop's lower-OUTER flank
  // (one per side), from the grass up to the ring's underside. The PLACEMENT lives here
  // (single source of truth) so the collision pass below can see it; the renderer
  // (render/track.js buildLoopPoles) just skins each entry, clipping the shaft top to the
  // contact sample's underside plane. Detection: inverted stretches (up.y < 0.3) are loop
  // crowns; walk each out to ground level, brace where the road is angled ~60° (up.y≈0.5).
  const supportPosts = [];
  {
    const RAD = 0.36, OFFSET = 0.45; // slim shaft, nudged out past the road's outer face
    const crowns = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (samples[i].up.y < 0.3) { if (!cur) { cur = [i, i]; crowns.push(cur); } else cur[1] = i; }
      else cur = null;
    }
    for (const [a0, b0] of crowns) {
      if (b0 - a0 < 4) continue;
      let a = a0, b = b0;
      while (a > 0 && samples[a].pos.y > 0.6) a--;
      while (b < n - 1 && samples[b].pos.y > 0.6) b++;
      let cx = 0, cz = 0, cnt = 0;
      for (let i = a; i <= b; i++) { cx += samples[i].pos.x; cz += samples[i].pos.z; cnt++; }
      cx /= cnt; cz /= cnt;
      let apex = a;
      for (let i = a; i <= b; i++) if (samples[i].pos.y > samples[apex].pos.y) apex = i;
      for (const [lo, hi] of [[a, apex], [apex, b]]) {
        let best = null;
        for (let i = lo; i <= hi; i++) {
          const s = samples[i];
          if (s.pos.y < 1.5 || s.pos.y > 3.2 || s.up.y < 0.3) continue;
          const sc = Math.abs(s.up.y - 0.5);
          if (!best || sc < best.sc) best = { s, sc };
        }
        if (!best) continue;
        const c = best.s;
        let ox = c.pos.x - cx, oz = c.pos.z - cz;
        const ol = dmath.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
        // The default offset leaves the shaft grazing the ring's own mouth corridor by
        // ~0.2 — the invisible-pole sliver. Step it outward until it clears every
        // corridor by POST_CLEAR (the diagonal top-clip keeps it flush against the
        // flank's underside wherever it lands); a shaft that can't clear is dropped —
        // a ring missing one brace reads fine, a phantom wall does not.
        let placed = null;
        for (let off = OFFSET; off <= OFFSET + 0.61; off += 0.15) {
          const x = c.pos.x + ox * off, z = c.pos.z + oz * off;
          if (intrusionOf({ x, z, radius: RAD, baseY: groundY, topY: c.pos.y }) <= -POST_CLEAR) { placed = { x, z }; break; }
        }
        if (!placed) continue;
        supportPosts.push({
          x: placed.x, z: placed.z, radius: RAD, baseY: groundY,
          contact: { pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, up: { x: c.up.x, y: c.up.y, z: c.up.z } }
        });
      }
    }
  }

  // ---- Collision poles for supports standing IN a drivable corridor. A pillar or loop
  // shaft is a real column the player can see; where one rises through the road corridor
  // cars must HIT it, not ghost through. Placement above bans the sliver zone, so any
  // intrusion that reaches here is ≥ POST_DEEP at its deepest — a visible obstacle;
  // runs whose deepest intrusion stays under 0.25 are skipped (a kerb-grazer's collision
  // disc would outweigh what's visible). Each contiguous abeam run is ONE road-crossing
  // of the post: emit ONE engine pole (the same (s, lat) collision an authored pole
  // uses) at the run's closest-abeam sample — that (s, lat) reconstructs to the visible
  // column's own footprint, so the bonk always has a post to look at. `ghost: true`
  // tells the renderer it's already drawn as pillar/shaft, so buildPoles must not draw
  // it again. main.js merges these into track.poles for the engine + AI.
  const autoPoles = [];
  {
    const posts = [
      ...pillars.map((p) => ({ x: p.x, z: p.z, radius: p.radius, baseY: p.baseY, topY: p.topY })),
      ...supportPosts.map((p) => ({ x: p.x, z: p.z, radius: p.radius, baseY: p.baseY, topY: p.contact.pos.y }))
    ];
    for (const post of posts) {
      let run = null; // current contiguous abeam run: deepest intrusion gates, closest-abeam places
      const flush = () => {
        if (run && run.intrusion >= 0.25) autoPoles.push({ s: run.s, lat: run.lat, radius: post.radius, ghost: true });
        run = null;
      };
      for (let j = 0; j < n; j++) {
        const sm = samples[j];
        const hit = postAtSample(sm, post);
        if (!hit) continue;                                            // post doesn't stand in this road here
        if (run && sm.s - run.lastS > 1.0) flush();                    // arclength gap → a separate crossing
        if (!run) run = { s: sm.s, lat: hit.lat, tan: hit.tan, intrusion: hit.intrusion, lastS: sm.s };
        else {
          run.lastS = sm.s;
          run.intrusion = Math.max(run.intrusion, hit.intrusion);
          if (Math.abs(hit.tan) < Math.abs(run.tan)) { run.s = sm.s; run.lat = hit.lat; run.tan = hit.tan; }
        }
      }
      flush();
    }
  }

  // ---- Move the start/finish line (opt `startU`, a fraction of the lap) ----
  // The start is otherwise wherever the walk began — and the GRID sits BEHIND it (Game.js
  // seeds the cars at totalS -2.5…-6.5, so lap 1 opens by driving across the line). A lap
  // whose opening straight runs FORWARD from the origin therefore parks its grid in
  // whatever precedes the origin, which for a closed course is a corner. Generated tracks
  // fix this at BAKE time, choosing the anchor before the elevation solve (see
  // scripts/track-gen.mjs chooseAnchor); a hand-authored walk has no solve to re-anchor, so
  // it simply declares where its line goes.
  //
  // This must run LAST. Everything above is computed from the walk's own anchor and has to
  // stay that way: the parallel-transport frames start at index 0 and unwind their holonomy
  // residual as a ramp across the ring, and the pillar/hill passes march the sample array on
  // index accumulators — rotating before any of that would re-time the twist and re-space
  // the columns. Rotating HERE only RELABELS: every sample keeps its exact pos/tangent/up/
  // lateral, so the road stays the same geometry down to the float, and only which point
  // calls itself s=0 changes. pillars/hills/supportPosts are world-space and need no remap;
  // the two arclength-carrying outputs (loopStarts, autoPoles) take the same shift as the
  // samples. Furniture is NOT remapped — `u` is authored against the line, so a track that
  // sets startU must re-place its oils/pads/boxes with it (placeFurniture does this).
  let ring = samples;
  if (startU) {
    const target = (((startU % 1) + 1) % 1) * length;
    let k = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(samples[i].s - target); if (d < bd) { bd = d; k = i; } }
    const off = samples[k].s; // snap to the nearest sample — the ring rotates by whole samples
    const reS = (s) => { const t = s - off; return t < 0 ? t + length : t; };
    for (const l of loopStarts) l.s = reS(l.s);
    for (const p of autoPoles) p.s = reS(p.s);
    for (const sm of samples) sm.s = reS(sm.s);
    ring = samples.slice(k).concat(samples.slice(0, k));
  }

  return {
    version: CONTRACT_VERSION, // engine data-contract stamp (see engine/contract.js)
    instances,
    startGate, // straddle s=0 with the finish gantry (built render-side — see render/FinishGate.js)
    pillars,
    hills,
    loopStarts,
    supportPosts,
    autoPoles,
    centerline: new Centerline(ring, length),
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
  // Waypoint tracks are BAKED with their start already chosen (track-gen's chooseAnchor
  // rotates the plan before the elevation solve), so startU is here only for completeness.
  const startU = opts.startU ?? track.startU ?? 0;
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
      hillFlags.push(!bridge && c.y > 0.075); // a raised, non-bridge stretch grows a grass berm; 0.075 = finalize's HILL_MIN(0.15)/SCALE(2), so the unscaled gate here matches the world-space one there
    }
  }
  return finalizeTrack(worldPts, widths, banks, pillarFlags, hillFlags, [], trackWidth, { startGate, startU });
}

// ---- Furniture resolve: descriptor (fraction-of-lap u) → built track (arclength s) ----
// The SINGLE source for the augmentation layer every race host applies on top of
// buildTrack (the live display, the trace recorder, the unit tests): oils→hazards,
// pads (+ the auto loop-mouth launch strips), item boxes, poles (+ builder autoPoles),
// authored bananas. Default radii live HERE, nowhere else. Triggers are
// point-car-vs-circle (Game._inZone) — deliberately simple and identical for every
// car — so a radius means "prop size + the car reach folded in".
const LOOP_PAD_LEN = 2.2;      // launch strip length (world units along travel)
const OIL_RADIUS_FRAC = 0.2;   // slick radius = 20% of road width (diameter 40% — dodgeable on any track)
const PAD_RADIUS_FRAC = 0.18;  // boost disc = ~18% of road width (the painted disc)
// Item boxes: ~9% of road width (0.45 on the standard 5-wide road) ≈ the box mesh
// (±0.15) + car half-width (0.26) + a whisker of forgiveness — "visually touching,
// slightly generous". Was 0.18 (0.9): that made a 4-lane row an unbroken wall-to-wall
// tripwire and collected boxes half a lane away. Still comfortably over one frame of
// travel at boosted top speed (~0.24 @60fps), so a fast car can't tunnel through.
const BOX_RADIUS_FRAC = 0.09;
const POLE_RADIUS = 0.45;      // authored support-pole default (world units)

export function resolveFurniture(b, def) {
  const u2s = (u) => (((u % 1) + 1) % 1) * b.length;
  // Oil slicks — read by the engine (spin-out detection) and the renderer (puddle +
  // cones; `cones` is renderer-only and ignored by the engine).
  b.hazards = (def.oils || []).map((o) => ({
    s: u2s(o.u), lat: o.lat || 0,
    radius: o.radius != null ? o.radius : b.roadWidth * OIL_RADIUS_FRAC,
    cones: o.cones
  }));
  b.pads = (def.pads || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * PAD_RADIUS_FRAC }));
  // Every looping gets a full-width RECTANGULAR launch strip at its mouth, so a loop is
  // always entered on boost. The strip sits flat on the approach with its leading edge at
  // the loop entry (centre = entry − halfLen). Position-scaled like any pad (the engine
  // reads `shape: 'strip'` → a longitudinal band across the lane).
  for (const ls of (b.loopStarts || [])) {
    b.pads.push({
      s: (((ls.s - LOOP_PAD_LEN / 2) % b.length) + b.length) % b.length,
      lat: 0, shape: 'strip', halfLen: LOOP_PAD_LEN / 2, halfWidth: ls.width / 2
    });
  }
  b.boxes = (def.boxes || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : b.roadWidth * BOX_RADIUS_FRAC }));
  // Support poles: SOLID obstacles — read by the engine (car push-out), the AI (dodge
  // like an oil), and the renderer (the post mesh). The builder's autoPoles ride along:
  // collision proxies for pillars/loop shafts that stand in a drivable corridor
  // (ghost — already drawn as the support itself).
  b.poles = (def.poles || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: p.radius != null ? p.radius : POLE_RADIUS }))
    .concat(b.autoPoles || []);
  // Authored bananas (dev tracks only — see shared/devTracks.js): the engine seeds
  // them live at race start and respawns them after each hit.
  b.bananas = (def.bananas || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0 }));
  return b;
}

// Track definitions + the named registry live in the dependency-free catalogue
// (../shared/tracks.js). Re-export what callers import via TrackBuilder: TRACKS
// (the tests) and TRACK_LIST (main.js + the lobby track picker).
export { TRACKS, TRACK_LIST };
