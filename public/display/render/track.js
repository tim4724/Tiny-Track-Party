// Per-track world geometry: the procedural ribbon road (+ its collision-proxy
// chunks), deck support pillars, and trackside scenery. Each builder takes the
// SceneRenderer instance (R) and adds merged meshes to R.trackGroup, recording
// disposables in R._mergedGeoms/R._mergedMats (freed on the next setTrack).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GROUND_SIZE, WATER_INNER, WATER_LIFT } from './environment.js';
import { makeCloudTexture, flipWinding } from './textures.js';

// Chimney-smoke sprite texture (the cabin landmark) — one shared soft puff,
// built lazily; SpriteMaterial.dispose never frees a shared texture, so the
// cache survives track switches.
let _smokeTex = null;
const smokeTexture = () => _smokeTex || (_smokeTex = makeCloudTexture());

// Support-structure tint (bridge pillars, corridor poles, loop shafts): the biome's
// `structure` hex — timber piles (beach), red-rock columns (canyon) — or the canonical
// toy concrete when the theme doesn't care.
const STRUCTURE = (theme) => (theme && theme.structure) || 0x9aa1b4;

// Build the visible road + kerbs by sweeping a fixed cross-section along the track
// centreline, plus a chunked road-surface proxy for the ground-conform raycast. The
// road is fully procedural (no GLB tiles): width comes from the track, the kerb is a
// low toy profile, so widening the road only pushes the kerb outward — it never grows
// into a wall the way scaling the old GLB tiles did. One merged vertex-coloured mesh
// (asphalt + white edge lines + red/white kerb + side skirt); adds it to trackGroup
// and the collision chunks to `collide`.
//
// LOOK comes from the biome's optional `road` palette (shared/themes.js): every
// default below is the verbatim pre-theming literal, so a theme without `road`
// (grass, sunset) builds byte-identical buffers. The palette recolours (asphalt/
// lines/dash/kerb/skirt), reshapes the kerb (kerbW/kerbH — snowbanks), drops the
// edge lines for a dusty shoulder (canyon), or repaints the whole deck as boardwalk
// planks (unused today — kept for the planned wooden Tabletop biome) — all vertex
// paint on the same sweep, no new geometry or textures.
export function buildRibbonRoad(R, track, collide, theme) {
  const cl = track.centerline;
  if (!cl || !cl.samples.length) return;
  const rd = (theme && theme.road) || {};

  // Drivable width is per-sample (centerline.width / roadWidth) — the road can flare
  // and pinch along the lap, and the physics curb corridor follows it (Game.maxLatAt).
  // `defHalf` is the fallback half-width; the kerb/line cross-section is fixed.
  const defHalf = (track.roadWidth || 5) / 2;
  const halfAt = (i) => (frames[i].width != null ? frames[i].width : track.roadWidth || 5) / 2;
  const cw = rd.kerbW ?? 0.22; // kerb lateral width (visual only — outside the physics corridor)
  const ch = rd.kerbH ?? 0.20; // kerb height — low; a kerb, not a wall
  const deck = 0.34;      // side-skirt drop (visual deck thickness below the road)
  const gap = Math.min(0.07, defHalf * 0.3);     // asphalt gap between kerb and edge line
  const lw = Math.min(0.20, defHalf * 0.5 - gap);// painted white edge-line width
  const stripeLen = 2.0;                         // kerb red/white band length (world units)
  const dashW = 0.18;                            // painted centre-dash width
  // Centre dash cadence: at top speed (~9 u/s) a 5.76u period streams past at
  // ~1.6 cycles/s — a readable flow, not a strobe. The dash is the near-field
  // speedometer: right at the chase cam's focus, its flow rate IS the car's
  // actual speed (the asphalt itself is flat colour, so without it nothing
  // close to the car streams past). Starting values.
  const DASH_PERIOD = 5.76, DASH_FRAC = 0.25;    // ~1.44u dash / ~4.32u gap

  // Resample the centreline at a uniform, fine arclength step. Raw samples are spaced
  // unevenly (~0.4 on tight corners, ~1.5 on straights) — far coarser than a painted
  // band — so colouring whole between-sample segments aliases the bands into uneven
  // blobs. Step a few× finer than the SMALLEST band so every band renders cleanly. The
  // kerb stripe is now long (stripeLen), so the centre dash's on-length is the finest
  // feature; driving ds off it keeps the dash from quantising to ragged ring counts.
  // Cap the step at 0.24 regardless of band size: the step also sets the GEOMETRY's
  // ring density (loop/crest silhouettes), which must not coarsen just because the
  // paint bands got longer (lengthening the dash once halved it — visible facets).
  const minBand = Math.min(stripeLen, DASH_PERIOD * DASH_FRAC);
  let N = Math.min(4000, Math.max(8, Math.round(cl.length / Math.min(0.24, Math.max(0.06, minBand / 3)))));
  // The centre dash needs every segment the SAME length, so snap N to a whole number of
  // dash cycles: each cycle is then an exact integer ring run (dashOn below) and the
  // start/finish seam lands on a cycle boundary. (The kerb bands snap themselves — see
  // kerbDist.) ringsPerCycle/dashRingsOn are reused by dashOn further down.
  const dashCycles = Math.max(2, Math.round(cl.length / DASH_PERIOD));
  let ringsPerCycle = Math.max(4, Math.round(N / dashCycles));
  if (ringsPerCycle * dashCycles > 4000) ringsPerCycle = Math.max(4, Math.floor(4000 / dashCycles));
  N = ringsPerCycle * dashCycles;
  const dashRingsOn = Math.min(ringsPerCycle - 1, Math.max(1, Math.round(ringsPerCycle * DASH_FRAC)));
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
  const ASPHALT = c(rd.asphalt ?? 0x5a6078);          // road surface
  const LINE = c(rd.line ?? 0xc4c4d9);                // painted road marking (Kenney's light road-line swatch)
  const DASH = c(rd.dash ?? rd.line ?? 0xc4c4d9);     // centre dash paint (canyon: highway yellow)
  const KERB_A = c(rd.kerb ? rd.kerb[0] : 0xfa6b41);  // kerb band A — Kenney's warm orange-red, not crimson
  const KERB_B = c(rd.kerb ? rd.kerb[1] : 0xf8f8fb);  // kerb band B — kerb white
  const SKIRT = c(rd.skirt ?? rd.asphalt ?? 0x5a6078);// deck sides + belly
  const SHOULDER = c(rd.shoulder ?? rd.asphalt ?? 0x5a6078); // edge band when edgeLines is off
  const edgeLines = rd.edgeLines !== false;

  // Boardwalk planks (rd.planks): repaint the deck as full-width planks. A plank is
  // ringsPerPlank rings; its FIRST ring paints the seam groove (one ring ≈ 0.2-0.3u —
  // chunky toy scale, streaming past at ~6 planks/s at top speed, the same readable
  // cadence as the centre dash), and the rings beside a seam get a bevel highlight/
  // shade (see the sweep) so each plank reads as a chamfered 3D piece. Tones cycle
  // per plank at WHISPER contrast — the regular seams are the "wood" cue; visible
  // tone steps were tried twice (full-width bands, then a per-board checkerboard)
  // and both read as painted patchwork, not timber. Keep it clean.
  const planks = rd.planks || null;
  let ringsPerPlank = 0, plankTones = null, plankSeam = null;
  if (planks) {
    ringsPerPlank = Math.max(2, Math.round(planks.period / (cl.length / N)));
    plankTones = planks.tones.map(c);
    plankSeam = c(planks.seam);
  }

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
    { sign:  0, off: -dashW / 2, y: 0    }, // 7  centre dash, left edge (sign 0 = road centre)
    { sign:  0, off: dashW / 2, y: 0     }, // 8  centre dash, right edge
    { sign:  1, off: -gap - lw, y: 0     }, // 9  inner edge of right line
    { sign:  1, off: -gap,      y: 0     }, // 10 outer edge of right line
    { sign:  1, off: 0,         y: 0     }, // 11 right asphalt edge
    { sign:  1, off: 0,         y: ch    }, // 12 right kerb inner top
    { sign:  1, off: cw,        y: ch    }, // 13 right kerb outer top
    { sign:  1, off: cw,        y: 0     }, // 14 right kerb outer base (top of deck skirt)
    { sign:  1, off: cw,        y: -deck }  // 15 right skirt foot
  ];
  // strip connects profile points (a,b); `kind` picks the colour rule.
  const STRIPS = [
    { a: 0,  b: 1,  kind: 'skirt' },            // left deck side, below road — road-grey
    { a: 1,  b: 2,  kind: 'kerb', side: 'L' },  // left kerb OUTER face (road level → top) — striped
    { a: 2,  b: 3,  kind: 'kerb', side: 'L' },  // left kerb top
    { a: 3,  b: 4,  kind: 'kerb', side: 'L' },  // left kerb inner face
    { a: 4,  b: 5,  kind: 'gap'   },            // gap asphalt between kerb and left line (shoulder when lines are off)
    { a: 5,  b: 6,  kind: 'line'  },            // left white edge line
    { a: 6,  b: 7,  kind: 'road'  },            // asphalt, left half
    { a: 7,  b: 8,  kind: 'dash'  },            // centre dash (DASH/deck bands along the lap)
    { a: 8,  b: 9,  kind: 'road'  },            // asphalt, right half
    { a: 9,  b: 10, kind: 'line'  },            // right white edge line
    { a: 10, b: 11, kind: 'gap'   },            // gap asphalt between right line and kerb
    { a: 11, b: 12, kind: 'kerb', side: 'R' },  // right kerb inner face
    { a: 12, b: 13, kind: 'kerb', side: 'R' },  // right kerb top
    { a: 13, b: 14, kind: 'kerb', side: 'R' },  // right kerb OUTER face (top → road level) — striped
    { a: 14, b: 15, kind: 'skirt' },            // right deck side, below road — road-grey
    // Deck BELLY: a plain face closing the underside between the two skirt feet.
    // Seen from below (under a loop, the bridge, the spiral) it occludes the
    // painted top surface entirely, so the track's bottom reads as solid plastic —
    // pure road-grey, no lines or kerb stripes shining through the DoubleSide mesh.
    { a: 15, b: 0,  kind: 'skirt' }
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
    1.00, // 7  centre dash left edge
    1.00, // 8  centre dash right edge
    1.00, // 9  road
    0.90, // 10 asphalt by the right kerb
    0.70, // 11 right kerb foot — contact shadow
    1.00, // 12 right kerb inner top
    0.90, // 13 right kerb outer top
    0.65, // 14 right kerb outer base (deck skirt top, shaded)
    0.55  // 15 right skirt foot
  ];

  // World position of every profile point on every ring, precomputed ONCE into a flat
  // Float32Array (x,y,z per point): centreline + height along the road normal (up) +
  // lateral offset across the road. The sweep below references each point up to ~4× (two
  // adjacent strips × current/next ring), so computing it per-reference (the old per-strip
  // ring() helper) recomputed the same trig ~4× AND allocated a Vector3 per reference —
  // ~256k throwaway vectors on a long track. One precompute kills both: the dominant cost
  // of setTrack (see the profile). Point p on ring i lives at rings[(i*NP + p)*3 ..].
  const NP = P.length, RP = NP * 3;
  const rings = new Float32Array(N * RP);
  for (let i = 0; i < N; i++) {
    const s = frames[i];
    const px = s.pos.x, py = s.pos.y, pz = s.pos.z;
    const ux = s.up.x, uy = s.up.y, uz = s.up.z;
    const ax = s.lateral.x, ay = s.lateral.y, az = s.lateral.z;
    const half = halfAt(i);
    const base = i * RP;
    for (let j = 0; j < NP; j++) {
      const pj = P[j], yj = pj.y, l = pj.sign * half + pj.off, o = base + j * 3;
      rings[o]     = px + ux * yj + ax * l;
      rings[o + 1] = py + uy * yj + ay * l;
      rings[o + 2] = pz + uz * yj + az * l;
    }
  }

  // ANALYTIC vertex normals, per ring × strip. The ribbon is non-indexed triangle soup
  // (each quad owns its 6 verts so paint bands stay crisp), and computeVertexNormals on
  // unindexed geometry is per-FACE — flat shading, which turns every ring into a lighting
  // facet wherever the road curves vertically (loops/crests read as banded strips). The
  // sweep frames give the exact surface instead: a strip's normal at ring i is
  // across×tangent (matching the face winding below — the DoubleSide material flips it
  // per-fragment), and both vary smoothly ring to ring, so shading is smooth ALONG the
  // road while the duplicated verts keep profile corners (kerb walls, skirt folds) hard.
  const S = STRIPS.length;
  const tans = new Float32Array(N * 3); // centreline tangent per ring (central difference, wraps)
  for (let i = 0; i < N; i++) {
    const p = frames[(i + 1) % N].pos, q = frames[(i - 1 + N) % N].pos, o = i * 3;
    tans[o] = p.x - q.x; tans[o + 1] = p.y - q.y; tans[o + 2] = p.z - q.z;
  }
  const norms = new Float32Array(N * S * 3);
  for (let i = 0; i < N; i++) {
    const tb = i * 3, tx = tans[tb], ty = tans[tb + 1], tz = tans[tb + 2];
    for (let s = 0; s < S; s++) {
      const st = STRIPS[s];
      const oa = i * RP + st.a * 3, ob = i * RP + st.b * 3;
      const ax = rings[ob] - rings[oa], ay = rings[ob + 1] - rings[oa + 1], az = rings[ob + 2] - rings[oa + 2];
      let nx = ay * tz - az * ty, ny = az * tx - ax * tz, nz = ax * ty - ay * tx; // across × tangent
      const len = Math.hypot(nx, ny, nz), o = (i * S + s) * 3;
      if (len > 1e-9) { norms[o] = nx / len; norms[o + 1] = ny / len; norms[o + 2] = nz / len; }
      else { const u = frames[i].up; norms[o] = -u.x; norms[o + 1] = -u.y; norms[o + 2] = -u.z; } // zero-width strip: winding-consistent "down"
    }
  }

  // Visible-mesh attributes, sized exactly (16 strips × 2 tris × 3 verts × 3 floats per
  // ring) and filled by cursor — no per-vertex array growth. Float32BufferAttribute takes
  // the typed array directly (no copy).
  const STRIDE = STRIPS.length * 6 * 3;
  const pos = new Float32Array(N * STRIDE);
  const col = new Float32Array(N * STRIDE);
  const nrm = new Float32Array(N * STRIDE);
  let pc = 0, cc = 0, nc = 0;
  const emitPt = (i, j) => { const o = i * RP + j * 3; pos[pc++] = rings[o]; pos[pc++] = rings[o + 1]; pos[pc++] = rings[o + 2]; };
  const emitN = (i, s) => { const o = (i * S + s) * 3; nrm[nc++] = norms[o]; nrm[nc++] = norms[o + 1]; nrm[nc++] = norms[o + 2]; };
  // Per-strip colour push: the two triangles below are wound ia,ib,nb / ia,nb,na, so
  // the 6 verts map to profile points [a,b,b,a,b,a]. Each gets its base colour times
  // its own AO, so the darkening varies ACROSS the strip (a gradient) — that's what
  // gives the kerb face and road edge their baked-in contact shadow. `mul` is a
  // whole-strip shade on top (the plank bevel); 1 everywhere planks are off, and
  // x·1 is exact in IEEE, so non-plank themes stay byte-identical.
  const VSEQ = ['a', 'b', 'b', 'a', 'b', 'a'];
  const pushStripCol = (cbase, st, mul = 1) => {
    for (let v = 0; v < 6; v++) { const f = ao[st[VSEQ[v]]] * mul; col[cc++] = cbase[0] * f; col[cc++] = cbase[1] * f; col[cc++] = cbase[2] * f; }
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
  const bandCol = (k, i) => ((Math.floor(k.d[i] / k.eff) % 2) === 0 ? KERB_A : KERB_B);

  // Centre dash: ring i is dash-on for the first dashRingsOn rings of each cycle. N is
  // an exact multiple of the cycle count (see resample above), so every dash spans the
  // same ring run — uniform dashes, clean seam — instead of quantising to ragged
  // lengths against a coarse resample.
  const dashOn = (i) => (i % ringsPerCycle) < dashRingsOn;

  // Bare-asphalt zone under each full-width launch strip (boost pad at a loop mouth):
  // blank the centre dash AND the white edge lines there so the teal pad reads as paint
  // on clean asphalt instead of a layer hovering OVER the road markings — otherwise the
  // dash/lines peek out at the strip's leading/trailing edge and give away the seam. The
  // margin clears a hair beyond the strip footprint so nothing emerges right at the edge.
  const STRIP_MARGIN = 0.12;
  const stripZones = (track.pads || [])
    .filter((p) => p.shape === 'strip')
    .map((p) => ({ s: p.s, half: (p.halfLen || 0) + STRIP_MARGIN }));
  const bareAsphalt = (i) => {
    if (!stripZones.length) return false;
    const sArc = (i / N) * cl.length;
    for (const z of stripZones) {
      let d = Math.abs(sArc - z.s);
      if (d > cl.length / 2) d = cl.length - d; // shortest way round the closed lap
      if (d < z.half) return true;
    }
    return false;
  };

  // Collision-proxy geometry: positions only. The proxy is an invisible MeshBasicMaterial
  // raycast for ground-conform Y — it never shades, so colour/normal attributes are pure
  // waste there. (The visible ribbon fills its own pos/col/nrm buffers in the sweep below,
  // with the ANALYTIC normals — computeVertexNormals would flat-shade that unindexed soup.)
  const mkGeom = (positions) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return g;
  };

  // One matte vertex-coloured asphalt material, shared by every road chunk.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); // matches Kenney track tiles (fully matte) — Lambert, no PBR specular; the road is the dominant near-camera fill so this cuts real per-fragment cost ×N cells
  R._mergedMats.push(mat);

  // Sweep the profile into CHUNKED vertex-coloured buffers (not one giant mesh). A single
  // merged ribbon can't be frustum-culled — its bounding sphere spans the whole circuit, so
  // it's always "in view" and the close chase cam paid to draw the ENTIRE lap in every
  // split-screen cell, and again in the shadow pass. Splitting the sweep into contiguous
  // arclength chunks lets three cull the ~90% of the lap behind the camera / past the race
  // fog: identical pixels, a fraction of the triangles submitted. Chunk K spans rings
  // [lo, hi]; its last quad shares ring `hi` with chunk K+1 (and the final chunk closes back
  // to ring 0), so the surface stays seamless. ~160 rings/chunk keeps the chunk count (hence
  // the drawn-when-visible draw calls) low while still culling most of a long track.
  // receiveShadow so the cars' shadows land on the road; castShadow is set per chunk below.
  //
  // Build the FULL ribbon once (positions + colours + the analytic normals above), THEN
  // slice it into fixed-ring chunks — a shared boundary ring carries identical normals on
  // both sides, so chunk seams shade seamlessly. Each ring contributes a fixed run of
  // vertices (STRIPS × 2 tris × 3), so a chunk is just a contiguous slice of the buffers.
  // The sweep fills the preallocated pos/col/nrm typed arrays via emitPt/emitN/pushStripCol.
  for (let i = 0; i < N; i++) {
    const ni = (i + 1) % N;
    const colL = bandCol(kerbL, i), colR = bandCol(kerbR, i);
    const bare = bareAsphalt(i);
    // Ring colour precedence: bare (launch-strip zone — clean deck, no seams or
    // bevels, so the pad reads as paint on a smooth patch) > plank seam (the groove
    // interrupts painted lines/dash — paint sits ON the boards) > the strip's own
    // paint > board cell / asphalt.
    const ppos = planks ? i % ringsPerPlank : -1; // ring's position inside its plank
    const seam = planks !== null && !bare && ppos === 0;
    // Plank bevel: the ring after a seam catches the sun, the ring before the next
    // seam falls into shade — each plank reads as a chamfered 3D piece, not a stripe.
    const bevel = (!planks || bare || seam) ? 1 : ppos === 1 ? 1.08 : ppos === ringsPerPlank - 1 ? 0.9 : 1;
    // Deck colour: the plank's (whisper-contrast) tone, or plain asphalt.
    const deckCol = planks ? plankTones[Math.floor(i / ringsPerPlank) % plankTones.length] : ASPHALT;
    for (let s = 0; s < S; s++) {
      const st = STRIPS[s];
      emitPt(i, st.a); emitPt(i, st.b); emitPt(ni, st.b);  // tri 1: ia, ib, nb
      emitPt(i, st.a); emitPt(ni, st.b); emitPt(ni, st.a); // tri 2: ia, nb, na
      emitN(i, s); emitN(i, s); emitN(ni, s);              // each vert takes ITS ring's
      emitN(i, s); emitN(ni, s); emitN(ni, s);             // strip normal → smooth sweep
      const k = st.kind;
      let cb, mul = 1;
      if (k === 'kerb') cb = st.side === 'R' ? colR : colL;
      else if (k === 'skirt') cb = SKIRT;
      else if (bare) cb = deckCol;                 // smooth clean deck under a launch strip
      else if (seam) cb = plankSeam;               // full-width groove between planks
      else if (k === 'dash') { cb = dashOn(i) ? DASH : deckCol; mul = bevel; }
      else if (k === 'line') { cb = edgeLines ? LINE : SHOULDER; mul = bevel; }
      // Kerb gap: shoulder-tinted only when the edge lines are off (canyon's dusty
      // edge); under planks it's deck — boardwalk planks run rail to rail.
      else if (k === 'gap') { cb = (planks || edgeLines) ? deckCol : SHOULDER; mul = bevel; }
      else { cb = deckCol; mul = bevel; }          // 'road' — plank / plain asphalt
      pushStripCol(cb, st, mul);
    }
  }
  const CHUNK_RINGS = 160; // keep chunk count (hence drawn-when-visible draw calls) low; STRIDE = floats/ring
  for (let lo = 0; lo < N; lo += CHUNK_RINGS) {
    const a = lo * STRIDE, z = Math.min(lo + CHUNK_RINGS, N) * STRIDE;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos.slice(a, z), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col.slice(a, z), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm.slice(a, z), 3));
    g.computeBoundingSphere(); // per-chunk sphere → three frustum-culls off-screen chunks
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false; // positions are already baked in world space
    mesh.receiveShadow = true;
    // Cast shadow ONLY from elevated chunks (bridge/ramp/loop decks). The shadow camera
    // frames the whole track, so it can't cull the road; a ground-level chunk only casts
    // onto grass, which opts out of receiving (env.js), so its shadow is invisible — skip
    // it for free. An elevated deck genuinely shades the road below, so it keeps casting.
    let maxY = -Infinity;
    for (let k = a + 1; k < z; k += 3) if (pos[k] > maxY) maxY = pos[k];
    mesh.castShadow = maxY > 0.8; // > flat road's kerb-top (~0.2), with margin
    R.trackGroup.add(mesh);
    R._mergedGeoms.push(g);
  }

  // Collision proxy: only the flat asphalt surface (kerbs/skirts aren't drivable),
  // spanning the full -hw..hw width (profile points 4 and 11), chunked so the existing
  // (x,z) bucket grid prunes the ground-conform raycast to the few chunks under the
  // car — the same contract the per-tile clones honour.
  const CHUNK = 8; // segments per collision mesh
  const collideMat = new THREE.MeshBasicMaterial({ visible: false });
  R._mergedMats.push(collideMat);
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    const cgeo = mkGeom(chunk);
    const m = new THREE.Mesh(cgeo, collideMat);
    m.matrixAutoUpdate = false;
    collide.add(m);
    R._mergedGeoms.push(cgeo);
    chunk = [];
  };
  const chunkPt = (i, j) => { const o = i * RP + j * 3; chunk.push(rings[o], rings[o + 1], rings[o + 2]); };
  for (let i = 0; i < N; i++) {
    const ni = (i + 1) % N;
    chunkPt(i, 4); chunkPt(i, 11); chunkPt(ni, 11);  // tri 1: ia, ib, nb
    chunkPt(i, 4); chunkPt(ni, 11); chunkPt(ni, 4);  // tri 2: ia, nb, na
    if ((i + 1) % CHUNK === 0) flush();
  }
  flush();
}

// Support pillars under raised decks (bridge/ramp). TrackBuilder computes the placements
// (the `pillars` opt + the under-bridge skip); each is a simple vertical cylinder from
// the grass plane up to just under the deck, merged into ONE matte mesh. They cast a
// contact shadow so the column reads as planted on the ground. Off-road, so they're kept
// OUT of the collision proxy — purely visual (a car never drives onto a pillar).
export function buildPillars(R, track, theme) {
  const list = track.pillars;
  if (!list || !list.length) return;
  const geoms = [];
  for (const p of list) {
    const h = Math.max(0.1, p.topY - p.baseY);
    const g = new THREE.CylinderGeometry(p.radius, p.radius, h, 12);
    g.translate(p.x, p.baseY + h / 2, p.z); // cylinder is centred on its axis → lift to span base…top
    geoms.push(g);
  }
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose(); // copied into `merged`
  const mat = new THREE.MeshLambertMaterial({ color: STRUCTURE(theme) }); // matte toy concrete (or the biome's structure tint)
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false; // geometry is baked in world space (translate above)
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// Grass hills (berms) under raised, NON-pillared road — the organic counterpart to
// pillars. TrackBuilder marks each hill and lofts it into cross-section rings (left
// foot → left top → right top → right foot, feathered to lawn level at both ends);
// here we stitch consecutive rings into a grass surface that meets the road underside
// and flares down to the lawn, burying the deck's floating grey skirt. One merged mesh
// re-using the lawn texture so it reads as the same ground; DoubleSide so the slopes
// can't show a dark backface. Purely terrain — off the racing line and the collision
// proxy. The per-ring flare grows with height for a roughly constant slope angle.
export function buildHills(R, track) {
  const runs = track.hills;
  if (!runs || !runs.length) return;
  const gy = R.ground.position.y; // the lawn the berm feet rest on (set per-track in setTrack)
  // Four world-space corners of a ring's cross-section: outer feet at lawn level, the
  // two tops at the berm height under the road. Flare = horizontal run of each slope.
  const corners = (r) => {
    // tops follow the road's bank (topL ≠ topR on a tilted deck); flare off the taller side.
    const flare = 0.6 + 0.8 * Math.max(0, Math.max(r.topL, r.topR) - gy);
    const hw = r.halfW, ox = r.lx, oz = r.lz;
    return [
      [r.cx - ox * (hw + flare), gy,      r.cz - oz * (hw + flare)], // 0 left foot
      [r.cx - ox * hw,           r.topL,  r.cz - oz * hw],           // 1 left top
      [r.cx + ox * hw,           r.topR,  r.cz + oz * hw],           // 2 right top
      [r.cx + ox * (hw + flare), gy,      r.cz + oz * (hw + flare)]  // 3 right foot
    ];
  };
  const pos = [];
  const quad = (p, q, s, t) => pos.push(p[0],p[1],p[2], q[0],q[1],q[2], s[0],s[1],s[2],  p[0],p[1],p[2], s[0],s[1],s[2], t[0],t[1],t[2]);
  for (const rings of runs) {
    let A = corners(rings[0]);
    for (let i = 1; i < rings.length; i++) {
      const B = corners(rings[i]);
      quad(A[0], A[1], B[1], B[0]); // left slope
      quad(A[1], A[2], B[2], B[1]); // top (under the road)
      quad(A[2], A[3], B[3], B[2]); // right slope
      A = B;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Tile the lawn texture across the berm in world XZ, matching the ground plane's scale
  // (its UVs run 0..1 over the GROUND_SIZE plane, so xz/GROUND_SIZE keeps the same texels-per-metre).
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / GROUND_SIZE, pos[i + 2] / GROUND_SIZE);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: R.ground.material.map, side: THREE.DoubleSide }); // matte grass berm — Lambert (matches the lawn material class)
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false; // geometry baked in world space
  mesh.castShadow = false;
  mesh.receiveShadow = false; // like the lawn, the berm doesn't receive shadows
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(geo);
  R._mergedMats.push(mat); // the shared lawn .map is NOT disposed here (see _disposeTrack)
}

// Solid poles (track.poles) — a concrete post. Where a deck crosses OVERHEAD it rises from
// the road up to just under that deck (a support column); where nothing is overhead (e.g. at
// the spiral's summit) it stands up from the road as a post you crest into. The engine owns
// the collision (cars hit its (s, lat) footprint); here we just draw it — matte toy concrete
// like the pillars.
export function buildPoles(R, track, theme) {
  // ghost poles are collision-only proxies for supports ALREADY drawn (bridge pillars /
  // loop shafts standing in the corridor — see TrackBuilder's autoPoles); skip their mesh.
  const list = (track.poles || []).filter((p) => !p.ghost);
  if (!list.length || !track.centerline) return;
  const cl = track.centerline, samples = cl.samples;
  const TUCK = 0.34, EMBED = 0.06, POST_UP = 2.0; // POST_UP = how far a no-deck-overhead post stands above the road
  const geoms = [];
  for (const p of list) {
    const f = cl.sampleAt(p.s);
    const base = f.pos.clone().addScaledVector(f.lateral, p.lat); // road surface at (s, lat)
    let topY = base.y + POST_UP, bestD = Infinity;                // no deck overhead → a post standing up from the road
    for (const s of samples) {
      if (s.pos.y - base.y < 1.5) continue;                       // must be a deck clearly ABOVE us
      const dx = s.pos.x - base.x, dz = s.pos.z - base.z, d = dx * dx + dz * dz;
      if (d < 4 && d < bestD) { bestD = d; topY = s.pos.y - TUCK; } // nearest overhead (within 2 world) → rise to tuck under it
    }
    const r = p.radius || 0.45;
    const h = Math.max(0.3, topY - (base.y - EMBED));
    const g = new THREE.CylinderGeometry(r, r, h, 12);
    g.translate(base.x, base.y - EMBED + h / 2, base.z);          // span road surface → just under the deck above
    geoms.push(g);
  }
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose();
  const mat = new THREE.MeshLambertMaterial({ color: STRUCTURE(theme) }); // matte structure tint (like pillars)
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// Loop support poles — a VERTICAL post under each 360° loop, one on each side, holding it up
// from below. PLACEMENT lives in TrackBuilder (track.supportPosts — the single source of
// truth, so the collision pass sees the same shafts; each carries the flank contact sample).
// Here we just skin each entry: a cylinder from the grass whose TOP is cut to the road's
// underside plane (a diagonal, not a flat top) so it meets the angled road flush instead of
// poking through it.
export function buildLoopPoles(R, track, theme) {
  const list = track.supportPosts;
  if (!list || !list.length) return;
  const gy = R.ground.position.y;
  const EMBED = 0.1, DECK = 0.34;
  const geoms = [];
  for (const post of list) {
    const c = post.contact;
    // road UNDERSIDE plane at the contact: a point a deck-thickness behind the surface, normal = up.
    const ux = c.up.x, uy = c.up.y, uz = c.up.z;
    const Ux = c.pos.x - ux * DECK, Uy = c.pos.y - uy * DECK, Uz = c.pos.z - uz * DECK;
    const H = (c.pos.y + 1.0) - (gy - EMBED); // build tall, then clip the top to the plane below
    const g = new THREE.CylinderGeometry(post.radius, post.radius, H, 12);
    g.translate(post.x, gy - EMBED + H / 2, post.z);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const vx = p.getX(v), vy = p.getY(v), vz = p.getZ(v);
      const planeY = Uy - (ux * (vx - Ux) + uz * (vz - Uz)) / uy; // y of the underside plane at (vx, vz)
      if (vy > planeY) p.setY(v, planeY);                          // diagonal cut → flush with the angled underside
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    geoms.push(g);
  }
  if (!geoms.length) return;
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose();
  const mat = new THREE.MeshLambertMaterial({ color: STRUCTURE(theme) }); // matte structure tint (like pillars)
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// ── Landmarks — hero set-pieces per biome (theme.landmark: one kind or an array),
// placed by rule like the loop launch pads, never hand-placed per track. Each is
// pure procedural toy geometry (faceted primitives, vertex colours, Lambert), all
// kinds merged into a single mesh in trackGroup — postcard moments, not a scenery
// system:
//   'lighthouse' — on the LOWEST offshore island of the horizon ring (beach)
//   'sailboat'   — anchored offshore, out in the shallows (beach)
//   'hoodoo'     — a balanced-rock family trackside at a clear stretch (canyon)
//   'snowman'    — trackside greeter just off the racing line (snow)
//   'blocks'     — stacked giant alphabet blocks trackside (playroom)
//   'duck'       — a bath-toy duck watching the race (playroom)
//   'ball'       — a panelled play ball settled askew trackside (playroom)
// A landmark that can't find a safe spot simply doesn't spawn (hoodoo/snowman scan;
// the offshore pair always can). Placement is deterministic per track — same every load.

// Bake a hex colour (× shade) into per-vertex colours — the boulders' tint idiom.
// Also normalises the geometry for the landmark merges: non-indexed, no uv, so
// primitives (indexed cylinders/cones, non-indexed icosahedra) mix freely.
function tintGeo(g0, hex, shade = 1) {
  const g = g0.index ? g0.toNonIndexed() : g0;
  if (g !== g0) g0.dispose();
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex).convertSRGBToLinear().multiplyScalar(shade);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// The lighthouse: stacked banded tower (the two red bands are the icon), gallery,
// glowing lamp room, dark cap. LH_SCALE sizes the whole build (~16.5 units tall at
// 1.75) — it stands 130-220u out on its island, so it must read as a proper tower
// through the sea haze, not a distant peg.
const LH_SCALE = 1.75;
function lighthouseGeoms(x, y, z) {
  const S = LH_SCALE;
  const parts = [];
  const seg = (r0, r1, h, cy, hex, radial = 10) => {
    const g = new THREE.CylinderGeometry(r0 * S, r1 * S, h * S, radial);
    g.translate(x, y + cy * S, z);
    parts.push(tintGeo(g, hex));
  };
  const bands = [0xf5efe2, 0xe4604a, 0xf5efe2, 0xe4604a]; // white/coral tower bands
  for (let i = 0; i < 4; i++) {
    const h = 1.9, r0 = 1.22 - (i + 1) * 0.09, r1 = 1.22 - i * 0.09;
    seg(r0, r1, h, i * h + h / 2, bands[i]);
  }
  seg(1.05, 1.05, 0.32, 7.76, 0x5c6470); // gallery deck
  seg(0.62, 0.62, 0.85, 8.35, 0xffd98a); // lamp room — warm, reads lit
  const cap = new THREE.ConeGeometry(0.85 * S, 0.9 * S, 10);
  cap.translate(x, y + 9.2 * S, z);
  parts.push(tintGeo(cap, 0xb2453a));
  return parts;
}

export function buildLandmarks(R, track, theme) {
  const kinds = theme.landmark ? [].concat(theme.landmark) : [];
  const cl = track.centerline;
  if (!kinds.length || !cl || !cl.samples.length) return;
  // Deterministic per-track stream, seeded like buildScenery (facet shading etc.).
  let seed = 51966;
  const idStr = String(track.id || track.name || '') + Math.round(cl.length * 100);
  for (let i = 0; i < idStr.length; i++) seed = ((seed ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const samples = cl.samples;
  const defHalf = (track.roadWidth || 5) / 2;
  const halfOf = (s) => (s.width != null ? s.width / 2 : defHalf);
  // Clear of the WHOLE corridor (all strands — the buildScenery rule) by `m` units.
  const isClear = (x, z, m) => {
    for (const s of samples) {
      const lim = halfOf(s) + m;
      const dx = x - s.pos.x, dz = z - s.pos.z;
      if (dx * dx + dz * dz < lim * lim) return false;
    }
    return true;
  };
  const gy = R.ground.position.y;
  const geoms = [];

  // Landmarks placed so far ({x, z, r} footprints): later kinds keep clear of
  // earlier ones, so a biome with several trackside pieces never stacks the
  // gnome inside the kennel. Pushing consumes no rand(), so recording the
  // ORIGINAL kinds' spots leaves their placement byte-identical.
  const placed = [];
  const clearSpot = (x, z, m) => isClear(x, z, m) && placed.every((p) => {
    const dx = x - p.x, dz = z - p.z, lim = m + p.r;
    return dx * dx + dz * dz >= lim * lim;
  });
  // Scan the lap from `s0` for a clear, ground-level roadside anchor — the shared
  // placement rule of every NEW trackside kind (the original kinds keep their own
  // verbatim loops: this helper draws rand() differently, and their streams must
  // not drift). Returns the anchor + a road-facing frame, records the footprint.
  //   off = lateral clearance past the kerb, m = footprint radius kept clear
  const findSpot = (s0, off, m) => {
    const L = cl.length;
    for (let s = s0; s < L - 10; s += 3) {
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // ground-level roadside only
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + off);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      if (!clearSpot(x, z, m)) continue;
      placed.push({ x, z, r: m });
      const fx = -f.lateral.x * side, fz = -f.lateral.z * side; // toward the road
      return { x, z, fx, fz, yaw: Math.atan2(fx, fz), tx: f.tangent.x, tz: f.tangent.z, side };
    }
    return null;
  };
  // Per-face vertex paint for multi-colour pieces (checker blankets, gore
  // stripes): colour each triangle by its centroid — per-face keeps the seams
  // crisp where per-vertex lerping would smear them (the play-ball trick).
  const paintFaces = (g0, pick) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (g !== g0) g0.dispose();
    g.deleteAttribute('uv');
    const p = g.attributes.position, n = p.count;
    const col = new Float32Array(n * 3);
    for (let t = 0; t < n; t += 3) {
      const c = pick(
        (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3,
        (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3,
        (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3
      );
      for (let v = t; v < t + 3; v++) { col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  // Register an animated set-piece: its own (small) mesh/group in trackGroup +
  // a stepper run by SceneRenderer._loop until the next setTrack rebuild.
  const animate = (fn) => (R._trackAnims || (R._trackAnims = [])).push(fn);

  // The LOWEST island of the horizon ring anchors both offshore pieces: the tower
  // dominates a low silhouette instead of poking out of a tall dune, and the boat
  // takes its bearing from the same island. Anchors are authored coords — scale XZ
  // by the hills' push-out (setTrack has already fitted the ring when this runs).
  const anchors = (R._hills && R._hills.userData.anchors) || [];
  let lowest = anchors[0];
  for (const a of anchors) if (a.top < lowest.top) lowest = a;

  if (kinds.includes('lighthouse') && lowest) {
    const sf = R._hills.scale.x;
    geoms.push(...lighthouseGeoms(lowest.x * sf, gy + lowest.top - 0.8, lowest.z * sf)); // base sunk into the island crown
  }

  if (kinds.includes('sailboat')) {
    // Anchored out in the shallows, a third of the way round from the lighthouse's
    // island so the two never share a sight-line. Radius = the per-track shoreline
    // fit (set just above in setTrack) + a margin into open water.
    const fit = (R._water && R._water.userData.fit) || 1;
    const ba = (lowest ? Math.atan2(lowest.z, lowest.x) : 0) + 2.3;
    const br = fit * WATER_INNER + 22; // shoreline + open-water margin
    const bx = Math.cos(ba) * br, bz = Math.sin(ba) * br;
    const wy = gy + WATER_LIFT; // ride ON the water sheet
    const yaw = rand() * Math.PI * 2;
    // Parts are authored in the boat's LOCAL frame (+Z = bow, origin at the
    // waterline under the mast), then heeled a few degrees — a sailing boat
    // leans — and swung to the anchorage bearing. Toy sloop anatomy: red hull
    // with a pointed bow wedge and a white gunwale stripe, cream cabin, and a
    // proper sloop rig (reworked on review — the old cone sails read as
    // blobs): mast + boom, a big triangular MAIN aft with a red racing band,
    // a smaller JIB forward, pennant at the masthead. Sails are thin 3-sided
    // prisms — crisp triangle silhouettes that still catch light edge-on
    // (paper-thin planes vanish; the cameras circle the whole island).
    const HEEL = 0.09;
    const part = (g, lx, ly, lz, hex) => {
      g.translate(lx, ly, lz);
      g.rotateZ(HEEL);
      g.rotateY(yaw);
      g.translate(bx, wy, bz);
      geoms.push(tintGeo(g, hex));
    };
    // a standing sail triangle: thin 3-prism in the boat's fore-aft plane,
    // apex up (cylinder axis → X for thickness; thetaStart puts a vertex at +Y)
    const sail = (sy, sz) => {
      const g = new THREE.CylinderGeometry(1, 1, 0.09, 3, 1, false, Math.PI / 2);
      g.rotateZ(Math.PI / 2);
      g.scale(1, sy, sz);
      return g;
    };
    part(new THREE.BoxGeometry(1.8, 1.0, 4.6), 0, 0.28, -0.5, 0xd94f3d);   // hull
    const bow = new THREE.ConeGeometry(0.9, 1.7, 4);                        // 4-sided pyramid...
    bow.rotateX(Math.PI / 2);                                               // ...apex swung to +Z
    bow.scale(1, 0.55, 1);                                                  // diamond squashed to hull height
    part(bow, 0, 0.28, 2.6, 0xd94f3d);                                      // pointed prow
    part(new THREE.BoxGeometry(1.92, 0.2, 4.7), 0, 0.82, -0.5, 0xf7f5ee);   // gunwale stripe
    part(new THREE.BoxGeometry(1.1, 0.6, 1.4), 0, 1.15, -1.3, 0xf3e9d8);    // cabin
    part(new THREE.CylinderGeometry(0.1, 0.07, 5.8, 6), 0, 2.9, 0.3, 0x8a6f4d); // mast, tapering
    const boom = new THREE.CylinderGeometry(0.06, 0.06, 2.7, 6);            // main boom, swung aft
    boom.rotateX(Math.PI / 2);
    part(boom, 0, 1.55, -0.85, 0x8a6f4d);
    part(sail(2.4, 1.3), 0, 2.85, -0.85, 0xf7f5ee);                         // MAIN: foot on the boom, leading edge on the mast
    part(new THREE.BoxGeometry(0.11, 0.42, 1.4), 0, 2.2, -0.85, 0xd94f3d);  // red racing band across the main
    part(sail(1.55, 0.95), 0, 2.25, 1.3, 0xfdf8ec);                         // JIB, forward of the mast
    const pennant = new THREE.ConeGeometry(0.26, 0.7, 3);
    pennant.rotateX(-Math.PI / 2);                                          // streams aft
    pennant.scale(1, 0.5, 1);
    part(pennant, 0, 5.85, -0.1, 0xd94f3d);                                 // masthead pennant
  }

  if (kinds.includes('hoodoo')) {
    // Balanced-rock hoodoos — the cartoon-desert icon: a tall eroded stem (stacked
    // tapered drums, waisted toward the top) with a wider boulder balanced on it.
    // A family of three at staggered heights stands trackside at the first clear,
    // ground-level spot: a landmark you drive PAST (a road-spanning rock arch was
    // tried and rejected). Rock tints cycle per drum — echoes the mesa strata.
    const rocks = (theme.scenery && theme.scenery.rocks) || [0xc07a55, 0xa8623f, 0xd39a70];
    const hoodoo = (hx, hz, T) => { // T = total height
      const radii = [0.20, 0.15, 0.115, 0.095].map((k) => k * T); // drum radii, bottom → waist
      const hts = [0.30, 0.24, 0.19].map((k) => k * T);           // drum heights (stem ≈ 0.73 T)
      let cy = 0;
      for (let li = 0; li < 3; li++) {
        const g = new THREE.CylinderGeometry(radii[li + 1], radii[li], hts[li], 8);
        g.rotateY(rand() * Math.PI * 2); // vary facet phase per drum
        g.translate(hx, gy + cy + hts[li] / 2 - 0.15, hz); // first drum sunk into the dirt
        geoms.push(tintGeo(g, rocks[li % rocks.length], 0.9 + rand() * 0.18));
        cy += hts[li];
      }
      const cap = new THREE.IcosahedronGeometry(0.24 * T, 0); // the balanced boulder — wider than the waist
      cap.scale(1, 0.62, 0.88);
      cap.rotateY(rand() * Math.PI * 2);
      cap.translate(hx, gy + cy + 0.1 * T - 0.15, hz);
      geoms.push(tintGeo(cap, rocks[Math.floor(rand() * rocks.length)], 0.95 + rand() * 0.15));
    };
    const L = cl.length, step = 3;
    for (let s = 35; s < L - 10; s += step) {
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // ground-level roadside only
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + 6.5);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      // the cluster spreads ~±4u around the anchor — clear the whole footprint
      if (!isClear(x, z, 5)) continue;
      const tx = f.tangent.x, tz = f.tangent.z;
      hoodoo(x, z, 8.6);                                              // the tall one
      hoodoo(x + tx * 3.8 + f.lateral.x * side * 1.6, z + tz * 3.8 + f.lateral.z * side * 1.6, 5.4);
      hoodoo(x - tx * 3.2 + f.lateral.x * side * 2.2, z - tz * 3.2 + f.lateral.z * side * 2.2, 3.6);
      placed.push({ x, z, r: 6 }); // keep later kinds off the family's footprint
      break; // one family is a landmark; a forest of them is scenery
    }
  }

  if (kinds.includes('snowman')) {
    // First clear spot past the opening straight, just off the racing line.
    const L = cl.length, step = 3;
    for (let s = 30; s < L - 10; s += step) {
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // keep him on the ground, not a ramp shoulder
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + 3.6);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      if (!isClear(x, z, 2.6)) continue;
      const fx = -f.lateral.x * side, fz = -f.lateral.z * side; // faces the road
      const yaw = Math.atan2(fx, fz);
      const ball = (r, cy, hex) => {
        // detail 2 → rounder silhouette so the body reads as soft as the snow pines
        const g = new THREE.IcosahedronGeometry(r, 2);
        g.translate(x, gy + cy, z);
        geoms.push(tintGeo(g, hex, 0.98));
      };
      ball(1.05, 0.72, 0xf6f9fc); // base, sunk into the snow
      ball(0.78, 2.02, 0xfafcfe);
      ball(0.54, 3.08, 0xf6f9fc); // head

      // Carrot nose — a short tapered cone whose narrow end is a NON-zero radius
      // capped with a small sphere, so the tip is a soft round nub, not a sharp apex
      // (a pointed cone read as a spike from the side). Drooped a touch, facing the road.
      {
        const noseLen = 0.32, tipR = 0.06;
        const cone = new THREE.CylinderGeometry(tipR, 0.19, noseLen, 16); // narrow end (+Y) = the tip
        const tip = new THREE.SphereGeometry(tipR, 12, 8);
        tip.translate(0, noseLen / 2, 0);                       // round off the narrow end
        for (const g of [cone, tip]) {
          g.rotateX(Math.PI / 2 + 0.16).rotateY(yaw);           // +Y → +Z (facing the road), tip dipped
          g.translate(x + fx * 0.58, gy + 3.12, z + fz * 0.58);
          geoms.push(tintGeo(g, 0xe8833a));
        }
      }

      // coal: eyes + smile on the head, three buttons down the belly. Offsets are in
      // the facing frame — ox = right (right vector = fz, -fx), oz = toward the road.
      const dot = (ox, oy, oz, r = 0.08) => {
        const g = new THREE.IcosahedronGeometry(r, 1); // detail 1 → rounder coal lumps
        g.translate(x + fx * oz + fz * ox, gy + oy, z + fz * oz - fx * ox);
        geoms.push(tintGeo(g, 0x343a44));
      };
      dot(-0.2, 3.32, 0.44); dot(0.2, 3.32, 0.44);              // eyes
      for (let i = -2; i <= 2; i++)                             // upturned coal smile below the nose
        dot(i * 0.12, 2.82 + i * i * 0.03, 0.46, 0.05);
      dot(0, 2.30, 0.72); dot(0, 2.00, 0.76); dot(0, 1.70, 0.72); // buttons

      // Soft knit beanie — a rolled torus brim, a rounded dome crown (not a sharp
      // cone — that spike read hard next to the round pines), and a white pom-pom.
      const HAT = 0x3b6fb0;
      const brim = new THREE.TorusGeometry(0.42, 0.15, 12, 24);
      brim.rotateX(Math.PI / 2);                                // rolled ring lies flat around the crown
      brim.translate(x, gy + 3.5, z);
      geoms.push(tintGeo(brim, HAT, 1.08));                     // lighter fold
      const crown = new THREE.SphereGeometry(0.42, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      crown.scale(1, 1.28, 1);                                  // upper hemisphere, stretched into a beanie
      crown.translate(x, gy + 3.5, z);
      geoms.push(tintGeo(crown, HAT));
      const bobble = new THREE.IcosahedronGeometry(0.17, 2);
      bobble.translate(x, gy + 4.12, z);
      geoms.push(tintGeo(bobble, 0xf6f9fc));

      // Knit scarf — a torus ring around the neck with a short tail draped down the
      // front, matching the hat's warm accent.
      const scarf = new THREE.TorusGeometry(0.47, 0.14, 12, 24);
      scarf.rotateX(Math.PI / 2);                               // ring lies flat (around +Y)
      scarf.translate(x, gy + 2.66, z);
      geoms.push(tintGeo(scarf, 0xd8463f));
      // draped over the belly, tilted forward so its face angles up into the sun — a
      // flat, camera-facing slab read almost black (grazing Lambert light); same red
      // as the ring so the two match.
      const tail = new THREE.BoxGeometry(0.26, 0.62, 0.14);
      tail.translate(0, -0.31, 0);                              // hang from the ring (pivot at the neck)
      tail.rotateX(0.45);                                       // drape forward, hugging the belly bulge
      tail.rotateY(yaw);
      tail.translate(x + fx * 0.5, gy + 2.62, z + fz * 0.5);   // ride the belly surface, not buried inside it
      geoms.push(tintGeo(tail, 0xd8463f, 1.04));

      // Twig arms — chunky rounded stubs swung out to each side and tilted up, built
      // along local +Y then rotated into the facing frame (local ±X → world right/left).
      // Kept short and thick (not thin needles) to sit softly beside the round pines.
      const arm = (s) => { // s = +1 right, -1 left
        const ax = x + fz * (s * 0.62), ay = gy + 2.24, az = z - fx * (s * 0.62); // shoulder anchor
        const a = new THREE.CylinderGeometry(0.06, 0.09, 0.95, 8);
        a.translate(0, 0.47, 0);                                // base at origin, extends +Y
        a.rotateZ(-s * (Math.PI / 2 - 0.5));                    // swing to the side, ~0.5rad upward
        a.rotateY(yaw);
        a.translate(ax, ay, az);
        geoms.push(tintGeo(a, 0x6b4a2f));
        // rounded knob at the shoulder so the twig doesn't end in a hard disc
        const knob = new THREE.IcosahedronGeometry(0.09, 1);
        knob.translate(ax, ay, az);
        geoms.push(tintGeo(knob, 0x6b4a2f));
      };
      arm(1); arm(-1);
      placed.push({ x, z, r: 3 });
      break;
    }
  }

  if (kinds.includes('blocks')) {
    // Giant alphabet blocks (playroom) — two on the floor, a third balanced on top
    // askew. Each block is a coloured cube with a lighter inset face panel proud of
    // every visible side (the classic toy-block anatomy — without the panels a plain
    // cube reads as a shipping crate). First clear trackside stretch, like the hoodoos.
    const tones = [0xe66a5a, 0x5a8fd8, 0xf2c14e]; // the theme's block primaries
    const block = (bx, bz, size, cy, yaw, hex) => {
      const body = new THREE.BoxGeometry(size, size, size);
      body.rotateY(yaw);
      body.translate(bx, gy + cy + size / 2, bz);
      geoms.push(tintGeo(body, hex, 0.97 + rand() * 0.06));
      // face panels: thin lighter plates centred on the 4 sides + top (bottom hidden)
      const p = size * 0.72, t = 0.05, off = size / 2 + t / 2 - 0.01;
      const plates = [
        [off, 0, 0, t, p, p], [-off, 0, 0, t, p, p],   // ±x sides
        [0, 0, off, p, p, t], [0, 0, -off, p, p, t],   // ±z sides
        [0, off, 0, p, t, p],                          // top
      ];
      for (const [px, py, pz, sx, sy, sz] of plates) {
        const plate = new THREE.BoxGeometry(sx, sy, sz);
        plate.translate(px, py, pz);
        plate.rotateY(yaw);
        plate.translate(bx, gy + cy + size / 2, bz);
        geoms.push(tintGeo(plate, 0xf7ead2, 0.98)); // warm cream face
      }
    };
    const L = cl.length, step = 3;
    for (let s = 55; s < L - 10; s += step) { // start past the duck's stretch — two spectators, two spots
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // ground-level roadside only
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + 6.0);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      if (!isClear(x, z, 5)) continue; // the stack spreads ~±3.5u around the anchor
      const tx = f.tangent.x, tz = f.tangent.z;
      block(x, z, 3.2, 0, rand() * 0.6, tones[0]);                                              // the big one
      block(x + tx * 3.4 + f.lateral.x * side * 1.3, z + tz * 3.4 + f.lateral.z * side * 1.3,
            2.6, 0, 0.5 + rand() * 0.5, tones[1]);                                              // its neighbour
      block(x + tx * 0.4, z + tz * 0.4, 2.4, 3.2, rand() * Math.PI * 0.5, tones[2]);            // balanced on top, askew
      placed.push({ x, z, r: 5.5 });
      break;
    }
  }

  if (kinds.includes('duck')) {
    // Bath-toy duck (playroom) — a chunky yellow spectator facing the road, built
    // like the snowman: first clear spot past the opening straight. Parts are
    // authored in the duck's LOCAL frame (+Z = bill) then swung to face the road.
    const YELLOW = 0xf6cf46, BILL = 0xf2953c;
    const L = cl.length, step = 3;
    for (let s = 30; s < L - 10; s += step) {
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // on the floor, not a ramp shoulder
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + 4.2);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      if (!isClear(x, z, 3)) continue;
      const fx = -f.lateral.x * side, fz = -f.lateral.z * side; // faces the road
      const yaw = Math.atan2(fx, fz);
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      const body = new THREE.IcosahedronGeometry(1.5, 1);
      body.scale(1.1, 0.82, 1.35);
      part(body, 0, 1.2, -0.2, YELLOW);                         // chesty hull, settled on the floor
      for (const sd of [-1, 1]) {                               // wing slabs against the hull
        const wing = new THREE.IcosahedronGeometry(0.8, 1);
        wing.scale(0.3, 0.66, 1.2);                             // flattened along the side, swept long
        wing.rotateX(-0.38);                                    // rear tip sweeps up
        wing.rotateZ(sd * 0.22);                                // top edge tucks into the hull
        part(wing, sd * 1.44, 1.55, -0.45, YELLOW, 0.94);       // a shade darker → reads as a part, not a lump
      }
      const tail = new THREE.ConeGeometry(0.55, 1.1, 6);
      tail.rotateX(-Math.PI / 2 - 0.65);                        // flicks up and aft
      part(tail, 0, 1.75, -1.85, YELLOW, 0.98);
      const head = new THREE.IcosahedronGeometry(0.9, 1);
      part(head, 0, 2.72, 0.7, YELLOW, 1.02);                   // chubby, settled into the body (no neck)
      // bill: one wide, flat, rounded shovel — a squashed sphere, not cones. The
      // pointed cone pair read as an open pecking beak (user: creepy); the
      // rubber-duck icon is a broad smiling paddle.
      const bill = new THREE.IcosahedronGeometry(0.5, 1);
      bill.scale(1.7, 0.45, 1.15);
      part(bill, 0, 2.55, 1.5, BILL);
      // eyes: simple dark toy dots WIDE APART on the SIDES of the head (the coal-dot
      // idiom the snowman uses). Close-set forward-facing eyes gave the duck a stare
      // — a duck's eyes sit lateral. Centres ON the head sphere's surface (r 0.9;
      // anything short of the radius buries the dot inside the head).
      for (const sd of [-1, 1]) {
        part(new THREE.IcosahedronGeometry(0.14, 1), sd * 0.68, 2.99, 1.23, 0x343a44);
      }
      placed.push({ x, z, r: 3 });
      break;
    }
  }

  if (kinds.includes('ball')) {
    // Toy play ball (playroom) — the classic panelled beach ball. Panels can't come
    // from tintGeo (one colour per geometry): paint per-vertex instead, colouring
    // each TRIANGLE by its centroid's longitude (per-face, so panel edges stay
    // crisp — per-vertex lerping would smear the seams) with white polar caps.
    // Both seam families must land ON the sphere's own grid lines or they saw-tooth:
    // widthSegments is a multiple of the panel count (meridian seams on column
    // lines) and the caps are cut by centroid LATITUDE at a whole ring (2 of 12),
    // not by a raw |y| threshold that slices through a triangle row. Painted in the
    // sphere's local frame, THEN tilted/yawed — a settled ball never sits pole-up,
    // and the tilt is what makes the panels read.
    const BR = 1.5; // ball radius (R is the renderer)
    const PANELS = [0xdf4a3c, 0xf5f2ea, 0x3f6fd1, 0xf5f2ea, 0xf2c14e, 0xf5f2ea]
      .map((h) => new THREE.Color(h).convertSRGBToLinear());
    const CAP = new THREE.Color(0xf5f2ea).convertSRGBToLinear();
    const L = cl.length, step = 3;
    for (let s = 85; s < L - 10; s += step) { // its own stretch, past the duck (30) and blocks (55)
      const f = cl.sampleAt(s);
      if (f.pos.y - gy > 0.8) continue; // on the floor
      const side = rand() < 0.5 ? -1 : 1;
      const lat = side * (halfOf(f) + 4.8);
      const x = f.pos.x + f.lateral.x * lat, z = f.pos.z + f.lateral.z * lat;
      if (!isClear(x, z, 2.8)) continue;
      const g = new THREE.SphereGeometry(BR, 18, 12).toNonIndexed();
      g.deleteAttribute('uv');
      const p = g.attributes.position, n = p.count;
      const col = new Float32Array(n * 3);
      const CAP_LAT = Math.PI / 6; // 2 of the 12 latitude rings at each pole stay white
      for (let t = 0; t < n; t += 3) {
        const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3;
        const cy = (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3;
        const cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
        // centroid polar angle — a triangle row never straddles a ring, so testing
        // against a ring angle keeps the cap edge a clean circle
        const polar = Math.acos(cy / Math.sqrt(cx * cx + cy * cy + cz * cz));
        const c = (polar < CAP_LAT || polar > Math.PI - CAP_LAT) ? CAP
          : PANELS[Math.floor(((Math.atan2(cz, cx) + Math.PI) / (2 * Math.PI)) * PANELS.length) % PANELS.length];
        for (let v = t; v < t + 3; v++) { col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.rotateZ(0.35 + rand() * 0.4);      // settled askew — poles off vertical
      g.rotateY(rand() * Math.PI * 2);
      g.translate(x, gy + BR * 0.92, z);    // a whisper of settle-sink into the floor
      geoms.push(g);
      placed.push({ x, z, r: 2.5 });
      break;
    }
  }

  // ── New kinds (biome round 2) — every block below runs AFTER the original
  // kinds, so the shared rand() stream's prefix (and the original landmarks'
  // placement) is byte-identical on every existing track. Each uses findSpot
  // (clear of the corridor AND of everything placed above).

  if (kinds.includes('umbrella')) {
    // A day at the beach: a tilted gore-striped parasol, a towel laid out
    // beside it, and a cooler. Local frame: +Z faces the road.
    const spot = findSpot(45, 5.2, 4);
    if (spot) {
      const { x, z, yaw } = spot;
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      const TILT = 0.2; // leans gently toward the road
      // pole runs UP INTO the dome (tip well above the canopy rim), so the
      // fabric visibly hangs off its stick instead of floating beside it
      const pole = new THREE.CylinderGeometry(0.07, 0.09, 4.1, 8);
      pole.translate(0, 2.05, 0);
      pole.rotateX(TILT);
      part(pole, 0, 0, 0, 0xf0e6d4);
      // canopy: an open dome, coral/cream gores by longitude (per-face — the
      // seams stay crisp). TWO shells: the merged landmark material is single-
      // sided, so a lone dome vanishes when seen from below — a slightly
      // smaller inner copy with flipped winding (darker, in shade) lines the
      // underside.
      const CA = new THREE.Color(0xe4604a).convertSRGBToLinear();
      const CB = new THREE.Color(0xf7f0e2).convertSRGBToLinear();
      const CAd = CA.clone().multiplyScalar(0.72), CBd = CB.clone().multiplyScalar(0.72);
      const gores = (dark) => (cx, cy, cz) =>
        (Math.floor(((Math.atan2(cz, cx) + Math.PI) / (2 * Math.PI)) * 10) % 2) ? (dark ? CAd : CA) : (dark ? CBd : CB);
      for (const inner of [false, true]) {
        const dome = new THREE.SphereGeometry(inner ? 1.97 : 2.0, 20, 5, 0, Math.PI * 2, 0, Math.PI / 2.15);
        dome.scale(1, 0.62, 1);
        const painted = paintFaces(dome, gores(inner));
        if (inner) flipWinding(painted); // faces point down/inward — visible from beneath
        painted.translate(0, 3.06, 0);   // rim wraps the pole tip…
        painted.rotateX(TILT);           // …and leans with it
        painted.rotateY(yaw);
        painted.translate(x, gy, z);
        geoms.push(painted);
      }
      const finial = new THREE.SphereGeometry(0.11, 8, 6);
      finial.translate(0, 4.36, 0); // caps the dome crown
      finial.rotateX(TILT);
      part(finial, 0, 0, 0, 0xe4604a);
      // towel, beside the shade with a cream end-stripe
      part(new THREE.BoxGeometry(2.7, 0.06, 1.5), 2.5, 0.05, 0.5, 0x5fc4b8);
      part(new THREE.BoxGeometry(2.7, 0.075, 0.34), 2.5, 0.05, 1.05, 0xf7f0e2);
      // cooler: red box, cream lid
      part(new THREE.BoxGeometry(0.7, 0.5, 0.45), -2.1, 0.27, 0.4, 0xd8463f);
      part(new THREE.BoxGeometry(0.74, 0.14, 0.49), -2.1, 0.59, 0.4, 0xf5f0e2);
    }
  }

  if (kinds.includes('sandcastle')) {
    // Bucket-castle on a patted-down mound: a tall keep, four corner towers,
    // curtain walls, and a little pennant. All in the dune-sand family.
    const spot = findSpot(80, 6.0, 4);
    if (spot) {
      const { x, z, yaw } = spot;
      const SAND = [0xe8d49e, 0xdfc98e];
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      // Toy-bucket scale — a knee-high castle, not a fort (shrunk on review).
      const S = 0.62;
      part(new THREE.CylinderGeometry(2.1 * S, 2.6 * S, 0.6 * S, 14), 0, 0.3 * S, 0, SAND[0], 0.97); // the mound
      const tower = (lx, lz, r, h) => { // upturned-bucket drum + patted cone cap
        part(new THREE.CylinderGeometry(r * 0.92, r, h, 10), lx, 0.6 * S + h / 2, lz, SAND[0], 1.02);
        part(new THREE.ConeGeometry(r * 1.08, r * 0.9, 10), lx, 0.6 * S + h + r * 0.42, lz, SAND[1], 0.96);
      };
      tower(0, 0, 0.85 * S, 2.1 * S); // the keep
      for (const [tx2, tz2] of [[1.35 * S, 1.35 * S], [-1.35 * S, 1.35 * S], [1.35 * S, -1.35 * S], [-1.35 * S, -1.35 * S]])
        tower(tx2, tz2, 0.5 * S, 1.25 * S);
      for (const [wx, wz, ww, wd] of [[0, 1.35 * S, 1.9 * S, 0.3 * S], [0, -1.35 * S, 1.9 * S, 0.3 * S], [1.35 * S, 0, 0.3 * S, 1.9 * S], [-1.35 * S, 0, 0.3 * S, 1.9 * S]])
        part(new THREE.BoxGeometry(ww, 0.8 * S, wd), wx, 1.0 * S, wz, SAND[0], 0.94); // curtain walls
      part(new THREE.CylinderGeometry(0.03, 0.03, 0.8 * S, 6), 0, 3.35 * S, 0, 0x8a6f4d); // mast
      const flag = new THREE.ConeGeometry(0.16 * S, 0.5 * S, 3);
      flag.rotateZ(-Math.PI / 2); // pennant streams sideways
      part(flag, 0.3 * S, 3.6 * S, 0, 0xd94f3d);
    }
  }

  if (kinds.includes('windmill')) {
    // Western water-pump windmill: a tapered timber derrick with a SPINNING
    // multi-blade steel rotor and a red tail fin. The rotor is its own small
    // mesh, stepped via the per-track anim registry; everything else merges.
    const spot = findSpot(70, 7.5, 5);
    if (spot) {
      const { x, z, yaw, fx, fz } = spot;
      const H = 10.5; // hub height
      const TIMBER = 0x9a7050, STEEL = 0xc6cbd6;
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      // four legs leaning in from a 2.7-square base to a 0.7-square at the platform
      const UPV = new THREE.Vector3(0, 1, 0);
      const legDir = new THREE.Vector3();
      const legM = new THREE.Matrix4();
      const legQ = new THREE.Quaternion();
      for (const [sx2, sz2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        legDir.set((0.35 - 1.35) * sx2, H, (0.35 - 1.35) * sz2);
        const len = legDir.length();
        const leg = new THREE.CylinderGeometry(0.1, 0.15, len, 6);
        leg.translate(0, len / 2, 0); // base at origin
        legQ.setFromUnitVectors(UPV, legDir.normalize());
        leg.applyMatrix4(legM.makeRotationFromQuaternion(legQ));
        part(leg, 1.35 * sx2, 0, 1.35 * sz2, TIMBER, 0.94 + ((sx2 + sz2 + 2) % 3) * 0.04);
      }
      // two brace frames girdling the tower
      for (const bh of [3.6, 7.0]) {
        const hw = 1.35 + (0.35 - 1.35) * (bh / H); // tower half-width at this height
        for (const [bx, bz, bw, bd] of [[0, hw, hw * 2 + 0.2, 0.09], [0, -hw, hw * 2 + 0.2, 0.09], [hw, 0, 0.09, hw * 2 + 0.2], [-hw, 0, 0.09, hw * 2 + 0.2]])
          part(new THREE.BoxGeometry(bw, 0.09, bd), bx, bh, bz, TIMBER, 0.9);
      }
      part(new THREE.BoxGeometry(1.35, 0.14, 1.35), 0, H + 0.07, 0, TIMBER, 1.05); // platform
      part(new THREE.BoxGeometry(0.45, 0.4, 0.8), 0, H + 0.35, 0.05, STEEL, 0.9);  // gear housing
      // tail vane: boom aft (away from the road) with a red fin
      part(new THREE.BoxGeometry(0.08, 0.08, 1.6), 0, H + 0.35, -0.95, STEEL, 0.85);
      const fin = new THREE.BoxGeometry(0.05, 0.75, 0.9);
      part(fin, 0, H + 0.42, -1.85, 0xd8463f);
      // the rotor: hub + 12 flat blades fanned in the local XY plane (faces +Z =
      // the road), spun about its facing axis every frame
      const rparts = [];
      const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.2, 10);
      hub.rotateX(Math.PI / 2);
      rparts.push(tintGeo(hub, STEEL, 1.05));
      for (let bi = 0; bi < 12; bi++) {
        const blade = new THREE.BoxGeometry(0.3, 1.8, 0.04);
        blade.translate(0, 1.1, 0);
        blade.rotateZ((bi / 12) * Math.PI * 2);
        rparts.push(tintGeo(blade, STEEL, 0.92 + (bi % 3) * 0.05));
      }
      const rim = new THREE.TorusGeometry(1.95, 0.045, 6, 28); // the outer band tying the fan together
      rparts.push(tintGeo(rim, STEEL, 0.88));
      const rotorGeo = mergeGeometries(rparts, false);
      for (const g of rparts) g.dispose();
      const rotor = new THREE.Mesh(rotorGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
      rotor.castShadow = rotor.receiveShadow = false;
      rotor.position.set(x + fx * 0.75, gy + H + 0.35, z + fz * 0.75); // proud of the housing, facing the road
      R.trackGroup.add(rotor);
      R._mergedGeoms.push(rotorGeo);
      R._mergedMats.push(rotor.material);
      const yawQ = new THREE.Quaternion().setFromAxisAngle(UPV, yaw);
      const spinQ = new THREE.Quaternion();
      const ZAX = new THREE.Vector3(0, 0, 1);
      animate((dt, t) => {
        rotor.quaternion.copy(yawQ).multiply(spinQ.setFromAxisAngle(ZAX, t * 0.85));
      });
    }
  }

  if (kinds.includes('cabin')) {
    // Log cabin under a snow-heaped roof, chimney smoke curling up: stacked
    // log courses (the alternating overlap makes the corner notches for free),
    // gable ends of shortening logs, a warm lit window. Local +Z faces the road.
    const spot = findSpot(65, 7.0, 5);
    if (spot) {
      const { x, z, yaw } = spot;
      const LOG = 0x8a6142, LOG2 = 0x7a5438, SNOWC = 0xf3f7fb;
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      for (let row = 0; row < 5; row++) { // log courses
        const ly = 0.26 + row * 0.5;
        for (const zoff of [1.8, -1.8]) { // front/back walls run along local X
          const g = new THREE.CylinderGeometry(0.26, 0.26, 5.0, 7);
          g.rotateZ(Math.PI / 2);
          part(g, 0, ly, zoff, row % 2 ? LOG : LOG2, 0.97 + (row % 3) * 0.03);
        }
        for (const xoff of [2.3, -2.3]) { // side walls along local Z, half a course up
          const g = new THREE.CylinderGeometry(0.26, 0.26, 4.0, 7);
          g.rotateX(Math.PI / 2);
          part(g, xoff, ly + 0.25, 0, row % 2 ? LOG2 : LOG, 0.96 + (row % 2) * 0.04);
        }
      }
      for (let gi = 0; gi < 3; gi++) { // gable ends: shortening courses up to the ridge
        const ly = 2.76 + gi * 0.48;
        for (const zoff of [1.8, -1.8]) {
          const g = new THREE.CylinderGeometry(0.24, 0.24, 3.4 - gi * 1.1, 7);
          g.rotateZ(Math.PI / 2);
          part(g, 0, ly, zoff, gi % 2 ? LOG : LOG2);
        }
      }
      for (const sd of [-1, 1]) { // snow-heaped roof slabs, ridge along local Z
        const slab = new THREE.BoxGeometry(3.05, 0.22, 5.4);
        slab.rotateZ(sd * 0.6);
        part(slab, sd * -1.2, 3.6, 0, SNOWC);
      }
      const ridge = new THREE.CylinderGeometry(0.18, 0.18, 5.45, 7); // snow-capped ridge log
      ridge.rotateX(Math.PI / 2);
      part(ridge, 0, 4.32, 0, SNOWC, 0.98);
      // door + the warm lit window (the postcard cue), on the road face
      part(new THREE.BoxGeometry(0.9, 1.5, 0.14), 0.95, 0.75, 1.98, 0x4a3a2e);
      part(new THREE.BoxGeometry(0.78, 0.68, 0.14), -1.0, 1.35, 1.98, 0xffd98a);
      part(new THREE.BoxGeometry(0.92, 0.1, 0.16), -1.0, 1.74, 1.99, 0x4a3a2e); // lintel
      // stone chimney breaking the rear roof slope
      part(new THREE.BoxGeometry(0.55, 2.3, 0.55), -0.95, 3.5, -0.95, 0x9fa8ba);
      part(new THREE.BoxGeometry(0.68, 0.14, 0.68), -0.95, 4.68, -0.95, 0xb9c1d0); // cap
      // smoke: three shared-texture puffs rising, growing and fading on a loop
      const cy2 = Math.cos(yaw), sy2 = Math.sin(yaw);
      const smx = x + (-0.95) * cy2 + (-0.95) * sy2;
      const smz = z - (-0.95) * sy2 + (-0.95) * cy2;
      const smTop = gy + 4.75;
      const puffs = [];
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: smokeTexture(), transparent: true, opacity: 0, depthWrite: false, color: 0xeef2f6,
        }));
        sp.position.set(smx, smTop, smz);
        R.trackGroup.add(sp);
        R._mergedMats.push(sp.material);
        puffs.push(sp);
      }
      animate((dt, t) => {
        for (let i = 0; i < 3; i++) {
          const u = (t * 0.16 + i / 3) % 1; // ~6s per puff, staggered thirds
          const sp = puffs[i];
          sp.position.set(smx + u * 1.7 + Math.sin(t * 0.8 + i * 2.1) * 0.15, smTop + u * 3.4, smz);
          const w = 0.7 + u * 2.2;
          sp.scale.set(w, w * 0.62, 1);
          sp.material.opacity = 0.42 * Math.min(1, u * 5) * (1 - u); // quick fade-in, slow dissolve
        }
      });
    }
  }

  if (kinds.includes('gnome')) {
    // Garden gnome greeting the racers: bell-cone coat, white beard, and THE
    // cue — a tall floppy red hat. Faces the road like the snowman.
    const spot = findSpot(30, 3.4, 2.2);
    if (spot) {
      const { x, z, yaw } = spot;
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      part(new THREE.ConeGeometry(0.62, 1.3, 10), 0, 0.65, 0, 0x3b6fb0); // coat
      for (const sd of [-1, 1]) // boots peeking out
        part(new THREE.IcosahedronGeometry(0.13, 1), sd * 0.24, 0.09, 0.14, 0x4a3a2e);
      part(new THREE.SphereGeometry(0.36, 12, 9), 0, 1.42, 0, 0xf0c8a2); // head
      part(new THREE.IcosahedronGeometry(0.1, 1), 0, 1.4, 0.35, 0xe8a87e); // nose
      const beard = new THREE.IcosahedronGeometry(0.32, 1); // soft white bib
      beard.scale(1, 1.2, 0.62);
      part(beard, 0, 1.12, 0.18, 0xf5f2ea);
      const hat = new THREE.ConeGeometry(0.42, 1.25, 10); // the hat
      hat.rotateX(-0.12); // a lazy kink back
      part(hat, 0, 2.1, -0.04, 0xd8463f);
    }
  }

  if (kinds.includes('doghouse')) {
    // Backyard kennel: warm red walls under a proper triangular gable (a
    // 45°-rotated box — its top half IS the prism, the rest hides in the
    // walls), dark overhanging roof slabs, a white-trimmed arched doorway,
    // and the food bowl + a bone out front. (Reworked on review — the first
    // pass faked the gable with a stepped box and read muddled.)
    const spot = findSpot(60, 4.6, 3.2);
    if (spot) {
      const { x, z, yaw } = spot;
      const WALL = 0xc4573f, ROOF = 0x5e4434, TRIM = 0xf5f0e2, DARK = 0x3a3040;
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      part(new THREE.BoxGeometry(2.3, 1.5, 2.6), 0, 0.75, 0, WALL);
      const gable = new THREE.BoxGeometry(1.64, 1.64, 2.55); // diamond: apex ~1.16 over the wall top
      gable.rotateZ(Math.PI / 4);
      part(gable, 0, 1.5, 0, WALL, 0.98);
      for (const sd of [-1, 1]) { // roof slabs follow the 45° gable, eaves overhanging
        const slab = new THREE.BoxGeometry(1.85, 0.13, 3.0);
        slab.rotateZ(sd * -Math.PI / 4);
        part(slab, sd * 0.62, 2.08, 0, ROOF);
      }
      const ridge = new THREE.BoxGeometry(0.26, 0.26, 3.05); // diamond ridge cap along the apex
      ridge.rotateZ(Math.PI / 4);
      part(ridge, 0, 2.7, 0, ROOF, 1.12);
      // doorway: white surround, dark arched opening proud of it
      part(new THREE.BoxGeometry(1.0, 0.98, 0.1), 0, 0.49, 1.31, TRIM);
      const rim = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 12);
      rim.rotateX(Math.PI / 2);
      part(rim, 0, 0.98, 1.31, TRIM);
      part(new THREE.BoxGeometry(0.84, 0.84, 0.12), 0, 0.42, 1.33, DARK);
      const arch = new THREE.CylinderGeometry(0.42, 0.42, 0.12, 12);
      arch.rotateX(Math.PI / 2);
      part(arch, 0, 0.84, 1.33, DARK);
      part(new THREE.CylinderGeometry(0.32, 0.26, 0.2, 10), 1.35, 0.1, 1.7, 0xd8463f); // food bowl
      // the bone: a cream bar with knuckle lobes at each end
      const boneYaw = 0.7;
      const bar = new THREE.CylinderGeometry(0.07, 0.07, 0.55, 6);
      bar.rotateZ(Math.PI / 2);
      bar.rotateY(boneYaw);
      part(bar, -1.15, 0.08, 1.55, 0xf3ecdc);
      for (const be of [-1, 1]) for (const bs of [-1, 1]) {
        const lobe = new THREE.SphereGeometry(0.09, 6, 5);
        lobe.translate(be * 0.28, 0, bs * 0.07);
        lobe.rotateY(boneYaw);
        part(lobe, -1.15, 0.09, 1.55, 0xf3ecdc);
      }
    }
  }

  if (kinds.includes('picnic')) {
    // Picnic spread: a red/cream checkered blanket thrown a touch askew, a
    // wicker basket with an arc handle, a cooler, two paper plates.
    const spot = findSpot(95, 4.8, 3.2);
    if (spot) {
      const { x, z, yaw } = spot;
      const CR = new THREE.Color(0xd8463f).convertSRGBToLinear();
      const CW = new THREE.Color(0xf5f0e2).convertSRGBToLinear();
      const blanket = new THREE.BoxGeometry(3.4, 0.06, 3.4, 5, 1, 5);
      const painted = paintFaces(blanket, (cx, cy, cz) =>
        ((Math.floor((cx + 1.7) / 0.68) + Math.floor((cz + 1.7) / 0.68)) % 2) ? CR : CW);
      painted.rotateY(yaw + 0.26);
      painted.translate(x, gy + 0.04, z);
      geoms.push(painted);
      const part = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        g.rotateY(yaw);
        g.translate(x, gy, z);
        geoms.push(tintGeo(g, hex, shade));
      };
      part(new THREE.BoxGeometry(0.85, 0.55, 0.55), 0.7, 0.3, 0.6, 0x8a6f4d); // basket
      const handle = new THREE.TorusGeometry(0.3, 0.05, 8, 14, Math.PI); // arc across it
      handle.rotateY(Math.PI / 2);
      part(handle, 0.7, 0.57, 0.6, 0x6e563c);
      part(new THREE.BoxGeometry(0.72, 0.5, 0.5), -0.85, 0.29, -0.7, 0xd8463f);  // cooler
      part(new THREE.BoxGeometry(0.76, 0.14, 0.54), -0.85, 0.6, -0.7, 0xf5f0e2); // its lid
      for (const [px2, pz2] of [[-0.35, 0.9], [0.55, -0.55]]) // plates
        part(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 12), px2, 0.07, pz2, 0xf7f5ee);
    }
  }

  if (kinds.includes('crayons')) {
    // Spilled crayons: four fat wax sticks lying loosely parallel — as if
    // tipped from their box — spaced wider than a crayon so nothing clips,
    // with a fifth thrown across the top of the row.
    const spot = findSpot(110, 4.4, 3);
    if (spot) {
      const { x, z } = spot;
      const COLS = [0xd8463f, 0x3f6fd1, 0x3fa14e, 0xf2a83c, 0x8a76d8];
      const a0 = rand() * Math.PI * 2;              // the spill's heading
      const px2 = Math.sin(a0), pz2 = Math.cos(a0); // spread axis (perpendicular to the sticks)
      for (let i = 0; i < 5; i++) {
        const onTop = i === 4;
        const ai = onTop ? a0 + 1.25 : a0 + (rand() - 0.5) * 0.2; // near-parallel; the top one crosses
        const off = onTop ? 0.15 : (i - 1.5) * 0.6;               // row spacing > crayon diameter (0.36)
        const slide = onTop ? 0 : (rand() - 0.5) * 0.8;           // stagger along each stick
        const ox = px2 * off + Math.cos(ai) * slide;
        const oz = pz2 * off - Math.sin(ai) * slide;
        const lift = onTop ? 0.33 : 0;                            // rests on the row's wraps
        const make = (g, hex, shade) => {
          g.rotateZ(Math.PI / 2); // lie flat along local X
          g.rotateY(ai);
          g.translate(x + ox, gy + 0.17 + lift, z + oz);
          geoms.push(tintGeo(g, hex, shade));
        };
        const body = new THREE.CylinderGeometry(0.16, 0.16, 2.3, 9);
        make(body, COLS[i], 1);
        const tipCone = new THREE.ConeGeometry(0.16, 0.42, 9);
        tipCone.translate(0, 1.36, 0);
        make(tipCone, COLS[i], 1.08);
        const wrap = new THREE.CylinderGeometry(0.18, 0.18, 1.3, 9); // the paper label band
        make(wrap, COLS[i], 0.88);
      }
    }
  }

  if (kinds.includes('books')) {
    // Three stacked picture books, spines offset askew: white page blocks
    // sandwiched by coloured cover boards.
    const spot = findSpot(130, 4.6, 3);
    if (spot) {
      const { x, z } = spot;
      const COVERS = [0x3f6fd1, 0xd8463f, 0x3fa14e];
      let ty = 0;
      for (let i = 0; i < 3; i++) {
        const w = 2.6 - i * 0.35, d = 1.9 - i * 0.22, h = 0.42;
        const a = (rand() - 0.5) * 0.7;
        const put = (g, hex, shade = 1) => {
          g.rotateY(a);
          g.translate(x, gy, z);
          geoms.push(tintGeo(g, hex, shade));
        };
        const pages = new THREE.BoxGeometry(w - 0.18, h - 0.13, d - 0.12);
        pages.translate(0.06, ty + h / 2, 0);
        put(pages, 0xf7f5ee);
        const top = new THREE.BoxGeometry(w, 0.07, d);
        top.translate(0, ty + h - 0.035, 0);
        put(top, COVERS[i]);
        const bot = new THREE.BoxGeometry(w, 0.07, d);
        bot.translate(0, ty + 0.035, 0);
        put(bot, COVERS[i], 0.94);
        const spine = new THREE.BoxGeometry(0.1, h, d);
        spine.translate(-w / 2 + 0.05, ty + h / 2, 0);
        put(spine, COVERS[i], 0.88);
        ty += h;
      }
    }
  }

  if (kinds.includes('train')) {
    // Wind-up toy train trundling a slow OVAL on the floor (a proper toy-train
    // stadium: two straights + two half-circle ends, long axis along the road),
    // key turning as it goes — needs a big clear patch; a layout that never
    // leaves one simply gets no train. Toy rails mark the route (static); the
    // loco is its own little group stepped by the anim registry.
    const RT = 5, LT = 7;          // end radius + straight length
    const OM = RT + LT / 2 + 1.5;  // footprint radius kept clear
    const spot = findSpot(40, OM + 2, OM);
    if (spot) {
      const cx2 = spot.x, cz2 = spot.z;
      const ao = Math.atan2(-spot.tz, spot.tx); // oval long axis rides the road tangent (rotateY frame)
      const co = Math.cos(ao), so = Math.sin(ao);
      for (const rr of [RT - 0.32, RT + 0.32]) { // the two rails: 2 straights + 2 half-torus ends each
        for (const zs of [-rr, rr]) {
          const straight = new THREE.CylinderGeometry(0.05, 0.05, LT, 6);
          straight.rotateZ(Math.PI / 2); // axis → local X
          straight.translate(0, 0, zs);
          straight.rotateY(ao);
          straight.translate(cx2, gy + 0.03, cz2);
          geoms.push(tintGeo(straight, 0x8a6f4d, 0.9));
        }
        for (const es of [1, -1]) {
          const end = new THREE.TorusGeometry(rr, 0.05, 6, 24, Math.PI);
          end.rotateX(Math.PI / 2);            // into the floor plane (arc bulges +Z…)
          end.rotateY(es * (Math.PI / 2));     // …swung to bulge past ±X (the straight ends)
          end.translate(es * (LT / 2), 0, 0);
          end.rotateY(ao);
          end.translate(cx2, gy + 0.03, cz2);
          geoms.push(tintGeo(end, 0x8a6f4d, 0.9));
        }
      }
      const parts = []; // the loco, authored facing +Z
      const lp = (g, lx, ly, lz, hex, shade = 1) => {
        g.translate(lx, ly, lz);
        const gg = tintGeo(g, hex, shade);
        parts.push(gg);
      };
      lp(new THREE.BoxGeometry(1.0, 0.36, 2.4), 0, 0.52, 0, 0x3b6fb0);      // chassis
      const boiler = new THREE.CylinderGeometry(0.44, 0.44, 1.45, 12);
      boiler.rotateX(Math.PI / 2);
      lp(boiler, 0, 1.02, 0.45, 0xd8463f);                                  // boiler
      lp(new THREE.BoxGeometry(1.05, 0.95, 0.85), 0, 1.15, -0.85, 0x3b6fb0); // cab
      lp(new THREE.BoxGeometry(1.15, 0.16, 1.0), 0, 1.72, -0.85, 0xd8463f);  // cab roof
      lp(new THREE.CylinderGeometry(0.14, 0.2, 0.5, 10), 0, 1.62, 0.95, 0xf2c14e); // funnel
      lp(new THREE.SphereGeometry(0.18, 10, 7), 0, 1.5, 0.25, 0xf2c14e);     // steam dome
      for (const sd of [-1, 1]) for (const wz of [0.65, -0.65]) {
        const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.14, 12);
        wheel.rotateZ(Math.PI / 2);
        lp(wheel, sd * 0.56, 0.3, wz, 0x2f2b38);
      }
      const trainGeo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const train = new THREE.Group();
      const body = new THREE.Mesh(trainGeo, mat);
      body.castShadow = body.receiveShadow = false;
      train.add(body);
      const keyParts = []; // the wind-up key over the cab
      const stem = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8);
      stem.translate(0, 0.25, 0);
      keyParts.push(tintGeo(stem, 0xf2c14e));
      for (const sd of [-1, 1]) {
        const wing = new THREE.BoxGeometry(0.5, 0.3, 0.09);
        wing.translate(sd * 0.28, 0.62, 0);
        keyParts.push(tintGeo(wing, 0xf2c14e, 0.95));
      }
      const keyGeo = mergeGeometries(keyParts, false);
      for (const g of keyParts) g.dispose();
      const key = new THREE.Mesh(keyGeo, mat);
      key.castShadow = key.receiveShadow = false;
      key.position.set(0, 1.8, -0.85);
      train.add(key);
      R.trackGroup.add(train);
      R._mergedGeoms.push(trainGeo, keyGeo);
      R._mergedMats.push(mat);
      const PERIM = 2 * LT + 2 * Math.PI * RT;
      animate((dt, t) => {
        const s = (t * 1.9) % PERIM; // ~1.9 u/s — a wind-up trundle
        let lpx, lpz, dx, dz;        // stadium frame: straights along X at z = ±RT, run CCW
        if (s < LT) {                                     // near straight, heading +X
          lpx = -LT / 2 + s; lpz = -RT; dx = 1; dz = 0;
        } else if (s < LT + Math.PI * RT) {               // right end
          const u = (s - LT) / RT;
          lpx = LT / 2 + Math.sin(u) * RT; lpz = -Math.cos(u) * RT;
          dx = Math.cos(u); dz = Math.sin(u);
        } else if (s < 2 * LT + Math.PI * RT) {           // far straight, heading -X
          lpx = LT / 2 - (s - LT - Math.PI * RT); lpz = RT; dx = -1; dz = 0;
        } else {                                          // left end
          const u = (s - 2 * LT - Math.PI * RT) / RT;
          lpx = -LT / 2 - Math.sin(u) * RT; lpz = Math.cos(u) * RT;
          dx = -Math.cos(u); dz = -Math.sin(u);
        }
        // into world through the same rotateY(ao) frame the rails were baked in
        train.position.set(cx2 + lpx * co + lpz * so, gy, cz2 - lpx * so + lpz * co);
        train.rotation.y = Math.atan2(dx * co + dz * so, -dx * so + dz * co); // nose along the tangent
        key.rotation.y = t * 2.6; // winding as it goes
      });
    }
  }

  if (!geoms.length) return;
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false; // trackside/offshore — their sun shadows would land on the non-receiving ground
  mesh.receiveShadow = false;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// ── Clutter builders — one tiny procedural build per ground-detail kind, shared
// by buildScenery's near-field pass (below) and the Asset World gallery
// (/assets-viewer.js shows one of each). Each takes a ctx of the caller's
// primitives — { rand, put, pick, groundY } — so the seeded stream and the
// merge pool stay the caller's:
//   rand()          the caller's seeded stream (order of calls is the contract)
//   put(g, hex, sh) tint + collect a primitive into the caller's pool
//   pick(tints)     one rand() draw from a tint family
//   groundY         the floor height to rest on
export const CLUTTER_BUILDERS = {
  // wildflower patch: daisy-style blossoms — a ring of flat oval petals around
  // a golden heart on a leafed stem (a single blob read as a lollipop, not a
  // flower — reworked on review)
  flower: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, r = rand() * 0.8;
      const fx = x + Math.cos(a) * r, fz = z + Math.sin(a) * r;
      const h = 0.4 + rand() * 0.16; // stem height
      const stem = new THREE.CylinderGeometry(0.025, 0.032, h, 5);
      stem.translate(fx, groundY + h / 2, fz);
      put(stem, 0x4e8a44, 0.92 + rand() * 0.16);
      const leaf = new THREE.SphereGeometry(0.07, 6, 4); // one leaf partway up
      leaf.scale(1.7, 0.35, 0.8);
      leaf.rotateY(a);
      leaf.translate(fx + 0.09, groundY + h * 0.45, fz);
      put(leaf, 0x5a9a50, 0.95);
      const hex = pick(tints);
      const ph = rand() * Math.PI * 2; // petal-ring phase
      for (let k = 0; k < 5; k++) {
        const pa = ph + (k / 5) * Math.PI * 2;
        const petal = new THREE.SphereGeometry(0.075, 6, 4);
        petal.scale(1.5, 0.45, 0.85); // flat oval, long axis outward
        petal.rotateY(-pa);
        petal.translate(fx + Math.cos(pa) * 0.115, groundY + h + 0.02, fz + Math.sin(pa) * 0.115);
        put(petal, hex, 0.95 + rand() * 0.1);
      }
      const heart = new THREE.SphereGeometry(0.06, 6, 5); // the golden centre
      heart.scale(1, 0.7, 1);
      heart.translate(fx, groundY + h + 0.045, fz);
      put(heart, 0xf2c14e, 1.05);
    }
  },
  // seashell: a squashed half-dome, tipped a touch
  shell: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const g = new THREE.SphereGeometry(0.24 + rand() * 0.1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, 0.55, 1.2);
    g.rotateZ(0.12 + rand() * 0.1);
    g.rotateY(rand() * Math.PI * 2);
    g.translate(x, groundY + 0.03, z);
    put(g, pick(tints), 0.96 + rand() * 0.1);
  },
  // starfish: five flattened arms radiating from a small hub
  starfish: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const hex = pick(tints), a0 = rand() * Math.PI * 2, s = 0.8 + rand() * 0.5;
    const hub = new THREE.CylinderGeometry(0.11 * s, 0.13 * s, 0.09 * s, 5);
    hub.translate(x, groundY + 0.045 * s, z);
    put(hub, hex);
    for (let k = 0; k < 5; k++) {
      const arm = new THREE.ConeGeometry(0.1 * s, 0.44 * s, 5);
      arm.rotateX(Math.PI / 2);       // apex points +Z
      arm.scale(1, 0.45, 1);          // flattened against the sand
      arm.translate(0, 0.045 * s, 0.28 * s);
      arm.rotateY(a0 + (k / 5) * Math.PI * 2);
      arm.translate(x, groundY, z);
      put(arm, hex, 0.94 + (k % 2) * 0.08);
    }
  },
  // bleached branch: two thin rods, kinked where they meet
  driftwood: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const hex = pick(tints), a = rand() * Math.PI * 2;
    const main = new THREE.CylinderGeometry(0.07, 0.09, 1.5, 6);
    main.rotateZ(Math.PI / 2);
    main.rotateY(a);
    main.translate(x, groundY + 0.08, z);
    put(main, hex);
    const limb = new THREE.CylinderGeometry(0.05, 0.06, 0.9, 6);
    limb.rotateZ(Math.PI / 2);
    limb.rotateY(a + 0.6);
    limb.translate(x + Math.cos(a) * 0.55, groundY + 0.06, z - Math.sin(a) * 0.55);
    put(limb, hex, 0.92);
  },
  // wind-blown snow heap
  drift: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const g = new THREE.IcosahedronGeometry(1, 1);
    g.scale(0.9 + rand() * 0.9, 0.28 + rand() * 0.12, 0.55 + rand() * 0.5);
    g.rotateY(rand() * Math.PI * 2);
    g.translate(x, groundY + 0.07, z);
    put(g, pick(tints), 0.97 + rand() * 0.06);
  },
  // dry sage tuft (sometimes two clumped)
  scrub: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const n = 1 + (rand() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const g = new THREE.IcosahedronGeometry(0.3 + rand() * 0.18, 0);
      g.scale(1, 0.55 + rand() * 0.2, 1);
      g.rotateY(rand() * Math.PI * 2);
      g.translate(x + i * 0.5, groundY + 0.12, z + i * 0.3);
      put(g, pick(tints), 0.9 + rand() * 0.2);
    }
  },
  // little cluster of rust pebbles
  pebbles: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const n = 3 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const rr = 0.09 + rand() * 0.09;
      const g = new THREE.IcosahedronGeometry(rr, 0);
      g.translate(x + (rand() - 0.5) * 0.7, groundY + rr * 0.5, z + (rand() - 0.5) * 0.7);
      put(g, pick(tints), 0.9 + rand() * 0.2);
    }
  },
  // studded toy brick
  brick: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const hex = pick(tints), a = rand() * Math.PI * 2;
    const body = new THREE.BoxGeometry(0.62, 0.3, 0.34);
    body.rotateY(a);
    body.translate(x, groundY + 0.15, z);
    put(body, hex);
    for (const sd of [-1, 1]) {
      const stud = new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8);
      stud.translate(sd * 0.15, 0.34, 0);
      stud.rotateY(a);
      stud.translate(x, groundY, z);
      put(stud, hex, 1.06);
    }
  },
  // lost marble
  marble: (ctx, x, z, tints) => {
    const { put, pick, groundY } = ctx;
    const g = new THREE.SphereGeometry(0.19, 10, 7);
    g.translate(x, groundY + 0.19, z);
    put(g, pick(tints), 1.05);
  },
  // fallen domino: white tile, dark midline, and PIPS — 3 up one half, 5 the
  // other — little dark studs proud of the face (the bare midline tile read as
  // a blank chip, not a domino — reworked on review)
  domino: (ctx, x, z, tints) => {
    const { rand, put, pick, groundY } = ctx;
    const a = rand() * Math.PI * 2;
    const loc = (g, lx, ly, lz, hex, shade) => { // tile-local frame
      g.translate(lx, ly, lz);
      g.rotateY(a);
      g.translate(x, groundY, z);
      put(g, hex, shade);
    };
    loc(new THREE.BoxGeometry(0.56, 0.12, 1.06), 0, 0.06, 0, pick(tints));
    loc(new THREE.BoxGeometry(0.58, 0.025, 0.06), 0, 0.12, 0, 0x3a3442);
    const PIPS = [
      [0, -0.28], [-0.14, -0.15], [0.14, -0.41],                            // 3, on the diagonal
      [-0.14, 0.15], [0.14, 0.15], [0, 0.28], [-0.14, 0.41], [0.14, 0.41],  // 5, corners + centre
    ];
    for (const [ux, uz] of PIPS) {
      loc(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 6), ux, 0.128, uz, 0x3a3442);
    }
  },
};

// Trackside scenery — GLB silhouettes (trees/bushes via the sunk-tree trick) plus
// faceted boulders, scattered outside the racing corridor. The parallax of things
// streaming past is the strongest speed cue there is (trackside, not on the car —
// see the wheel-roll notes above). Everything bakes into at most three merged
// meshes/draw calls: colormap-textured silhouettes (one shared kit texture),
// untextured silhouettes (palette tint in vertex colours — Nature-Kit models),
// and the boulders; castShadow stays off because the ground doesn't receive
// shadows anyway.
//
// WHAT gets scattered comes from the biome's `theme.scenery` palette (shared/
// themes.js): model mix, bush donor, rock tints, density. The placement machinery
// below is palette-agnostic — but the rand() STREAM is part of the output, so the
// call order/values here must not drift for a fixed palette (the grass palette
// encodes the pre-theming literals; grass-cup tracks must stay byte-identical).
export function buildScenery(R, track, theme) {
  const sc = theme.scenery;
  const cl = track.centerline;
  if (!cl || !cl.samples.length) return;

  // Deterministic placement: a seeded LCG keyed on the track's identity, so a
  // layout's scenery is identical on every load and every display.
  let seed = 2166136261;
  const idStr = String(track.id || track.name || '') + Math.round(cl.length * 100);
  for (let i = 0; i < idStr.length; i++) seed = ((seed ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // A candidate is clear only if it's outside EVERY centreline sample's
  // corridor — the local sample being far away isn't enough on a figure-8,
  // where the other strand can pass right through the band (2D check on
  // purpose: under a bridge the lower strand still owns the ground).
  const samples = cl.samples;
  const defHalf = (track.roadWidth || 5) / 2;
  const MARGIN = 2.2; // kerb + canopy radius + breathing room
  const isClear = (x, z) => {
    for (const s of samples) {
      const half = (s.width != null ? s.width / 2 : defHalf) + MARGIN;
      const dx = x - s.pos.x, dz = z - s.pos.z;
      if (dx * dx + dz * dz < half * half) return false;
    }
    return true;
  };

  // Silhouette sources: every proto the palette references (tree entries + the bush
  // donor), reduced to bake-ready {geometry, matrixWorld} parts plus the shared
  // colormap material. The kit models are toy-tiny (0.83 tall — shorter than two
  // cars), so placements scale them up to diorama size below.
  const treeSrc = new Map(); // model name -> parts[]
  let colorMat = null;
  const modelNames = [...new Set([...sc.trees.map((e) => e.model),
                                  ...(sc.bush ? [sc.bush.model] : [])])];
  for (const name of modelNames) {
    const root = R.protos.get(name);
    if (!root) continue;
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      parts.push({ geo: o.geometry, mw: o.matrixWorld.clone(), mat: m });
      if (!colorMat && m && m.map) colorMat = m;
    });
    if (parts.length) treeSrc.set(name, parts);
  }

  const KEEP = ['position', 'normal', 'uv']; // merged attribute sets must match
  const groundY = R.ground.position.y;
  const treeGeoms = []; // colormap-textured silhouettes (a biome's textured models share ONE map)
  const bareGeoms = []; // untextured silhouettes — palette tint baked into vertex colours
  const _tintMisses = new Set(); // warn once per unmatched authored colour (see below)
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
  const P = new THREE.Vector3(), S = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const placeTree = (x, z, opts = {}) => {
    let parts = opts.parts, s = opts.s, tintHex = opts.tint;
    if (!parts) {
      if (!sc.trees.length) return;
      // weighted silhouette pick — ONE rand() regardless of entry count (grass:
      // 65% round / 35% pine — pines as the accent, not an evergreen forest)
      const r = rand();
      let acc = 0, entry = sc.trees[sc.trees.length - 1];
      for (const e of sc.trees) { acc += e.w; if (r < acc) { entry = e; break; } }
      parts = treeSrc.get(entry.model);
      if (s == null) s = entry.s[0] + rand() * entry.s[1]; // grass ≈1.9–2.8 world tall (≈3–5 car heights)
      if (tintHex == null) tintHex = entry.tint;
    }
    if (!parts) return;
    Q.setFromAxisAngle(UP, rand() * Math.PI * 2);
    S.set(s, s * (0.92 + rand() * 0.16), s); // slight height jitter
    P.set(x, groundY - (opts.sink || 0) * s, z); // sink: bury the trunk (bushes, below)
    M.compose(P, Q, S);
    // Per-vertex shade multiplier over the colormap (1 = as-authored): a touch
    // of brightness variation keeps a copse from reading as stamped clones.
    const shade = 0.88 + rand() * 0.2;
    for (const part of parts) {
      const g = part.geo.clone();
      const textured = !!(part.mat && part.mat.map);
      for (const nm of Object.keys(g.attributes)) {
        // untextured parts also drop uv: their pool merges without it
        if (!KEEP.includes(nm) || (!textured && nm === 'uv')) g.deleteAttribute(nm);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(part.mw).applyMatrix4(M);
      const n = g.attributes.position.count;
      if (textured) {
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(shade), 3));
        treeGeoms.push(g);
      } else {
        // No colormap to modulate — bake the actual colour: the palette entry's tint
        // (authorial control; the Nature-Kit plain colours rarely fit a biome) or the
        // model's own material colour as the fallback, shaded like the textured pool.
        // tint is a hex (whole model, e.g. a cactus) OR a map of authored-hex →
        // replacement-hex for multi-part models (e.g. a palm: fronds + trunk differ).
        let t = tintHex;
        if (t != null && typeof t === 'object') {
          const authored = part.mat ? part.mat.color.getHexString() : '';
          t = t[authored];
          // A miss means the palette's keys drifted from the model's authored colours
          // (re-exported kit, typo). The fallback still renders — flag it so an asset
          // swap shows up in the console, not just as an off-colour prop on screen.
          if (t == null && !_tintMisses.has(authored)) {
            _tintMisses.add(authored);
            console.warn(`buildScenery: tint map has no entry for authored colour #${authored}; using the model's own colour`);
          }
        }
        const c = new THREE.Color();
        if (t != null) c.set(t).convertSRGBToLinear();
        else if (part.mat) c.copy(part.mat.color); // GLTF material colours are already linear
        else c.set(0xffffff);
        c.multiplyScalar(shade);
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        bareGeoms.push(g);
      }
    }
  };

  // Boulders: faceted icosahedra (flat-shaded) — the low-poly read of the
  // kit, not smooth blobs. UVs dropped; colour comes from per-vertex tints
  // in the pillars' toy-concrete family so they sit in the same palette.
  const rockProto = new THREE.IcosahedronGeometry(1, 0);
  rockProto.deleteAttribute('uv');
  const tint = (g, hex, shade) => {
    const c = new THREE.Color(hex).convertSRGBToLinear().multiplyScalar(shade);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const plainGeoms = [];
  const step = 7; // candidate spacing along the lap (world units)
  for (let d = 0; d < cl.length && treeGeoms.length + bareGeoms.length + plainGeoms.length < 500; d += step) {
    const f = cl.sampleAt(d);
    const half = (f.width != null ? f.width : track.roadWidth || 5) / 2;
    for (const side of [-1, 1]) {
      if (rand() > sc.density) continue; // leave gaps — a hedge-wall reads fake
      const lat = side * (half + 2.5 + rand() * 9);
      const x = f.pos.x + f.lateral.x * lat + (rand() - 0.5) * 3;
      const z = f.pos.z + f.lateral.z * lat + (rand() - 0.5) * 3;
      if (!isClear(x, z)) continue;
      const roll = rand();
      if (roll < sc.mix.tree) {
        placeTree(x, z);
        // copse: sometimes 1–2 companions huddle by the first trunk —
        // clusters read as parkland, an even sprinkle reads as noise
        if (rand() < 0.45) {
          const extra = 1 + Math.floor(rand() * 2);
          for (let e = 0; e < extra; e++) {
            const a = rand() * Math.PI * 2, r = 1.6 + rand() * 1.6;
            const ex = x + Math.cos(a) * r, ez = z + Math.sin(a) * r;
            if (isClear(ex, ez)) placeTree(ex, ez);
          }
        }
      } else if (roll < sc.mix.bush) {
        // "bush" = the palette's donor silhouette sunk to its canopy. The kit has no
        // bush model, and procedural domes never matched (flat side facets render
        // as dark holes against the sunlit lawn) — a buried trunk reuses the
        // canopy's authored colours/facets for an exact style match, free.
        placeTree(x, z, { parts: treeSrc.get(sc.bush.model), tint: sc.bush.tint,
                          s: sc.bush.s[0] + rand() * sc.bush.s[1], sink: sc.bush.sink });
      } else {
        // half-sunk boulder
        const rr = sc.rockS[0] + rand() * sc.rockS[1];
        const grey = sc.rocks[Math.floor(rand() * sc.rocks.length)];
        const rock = tint(rockProto.clone(), grey, 0.92 + rand() * 0.16);
        rock.scale(rr, rr * (0.55 + rand() * 0.3), rr);
        rock.rotateY(rand() * Math.PI * 2);
        rock.translate(x, groundY + rr * 0.25, z);
        plainGeoms.push(rock);
      }
    }
  }
  rockProto.dispose();

  // ── Ground clutter (sc.clutter) — the NEAR-FIELD pass: small detail scattered
  // denser and closer to the kerb than the props above (the chase cam mostly
  // sees the first few metres of verge — that's where detail per pixel lives).
  // Placement draws from its OWN seeded stream: the tree/rock scatter above must
  // stay byte-identical when a palette adds or tunes clutter.
  const clutterGeoms = [];
  const cc = sc.clutter;
  if (cc && cc.kinds && cc.kinds.length) {
    let seed2 = 5381;
    for (let i = 0; i < idStr.length; i++) seed2 = ((seed2 ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
    const rand2 = () => ((seed2 = (seed2 * 1664525 + 1013904223) >>> 0) / 4294967296);
    const CL_MARGIN = 0.7; // hugs the verge, never the deck
    const isClearC = (x, z) => {
      for (const s of samples) {
        const half = (s.width != null ? s.width / 2 : defHalf) + CL_MARGIN;
        const dx = x - s.pos.x, dz = z - s.pos.z;
        if (dx * dx + dz * dz < half * half) return false;
      }
      return true;
    };
    // non-indexed + uv-free (like the landmark pieces) so mixed prims merge
    const put = (g, hex, shade = 1) => {
      const gg = g.index ? g.toNonIndexed() : g;
      if (gg !== g) g.dispose();
      gg.deleteAttribute('uv');
      const c = new THREE.Color(hex).convertSRGBToLinear().multiplyScalar(shade);
      const n = gg.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      gg.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      clutterGeoms.push(gg);
    };
    const ctx = { rand: rand2, put, pick: (tints) => tints[Math.floor(rand2() * tints.length)], groundY };
    for (let d = 0; d < cl.length && clutterGeoms.length < 700; d += 5) { // cap raised with the petal-count flowers — still one merged draw call
      const f = cl.sampleAt(d);
      const half = (f.width != null ? f.width : track.roadWidth || 5) / 2;
      for (const side of [-1, 1]) {
        if (rand2() > cc.density) continue;
        const lat = side * (half + 1.3 + rand2() * 3.4);
        const x = f.pos.x + f.lateral.x * lat + (rand2() - 0.5) * 1.6;
        const z = f.pos.z + f.lateral.z * lat + (rand2() - 0.5) * 1.6;
        if (!isClearC(x, z)) continue;
        // weighted kind pick — ONE rand2 regardless of entry count
        const r = rand2();
        let acc = 0, entry = cc.kinds[cc.kinds.length - 1];
        for (const e of cc.kinds) { acc += e.w; if (r < acc) { entry = e; break; } }
        const build = CLUTTER_BUILDERS[entry.kind];
        if (build) build(ctx, x, z, entry.tints || [0xffffff]);
      }
    }
  }

  const addMerged = (geoms, mat) => {
    if (!geoms.length) { mat.dispose(); return; }
    const merged = mergeGeometries(geoms, false);
    for (const g of geoms) g.dispose(); // copied into the merge
    if (!merged) { mat.dispose(); return; }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false;
    R.trackGroup.add(mesh); // cleared with the track; dispose via the merged-pools
    R._mergedGeoms.push(merged);
    R._mergedMats.push(mat);
  };
  if (colorMat) {
    const treeMat = colorMat.clone(); // shares the proto's colormap texture
    treeMat.vertexColors = true;      // the per-tree shade multiplier above
    addMerged(treeGeoms, treeMat);
  }
  // untextured silhouettes (tint baked per-vertex): matte like the hills/pillars —
  // smooth-shaded, unlike the deliberately faceted boulders below
  addMerged(bareGeoms, new THREE.MeshLambertMaterial({ vertexColors: true }));
  addMerged(plainGeoms, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }));
  // near-field ground clutter: one more merged mesh/draw call, matte like the rest
  addMerged(clutterGeoms, new THREE.MeshLambertMaterial({ vertexColors: true }));
}
