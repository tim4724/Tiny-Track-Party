// Per-track world geometry: the procedural ribbon road (+ its collision-proxy
// chunks), deck support pillars, and trackside scenery. Each builder takes the
// SceneRenderer instance (R) and adds merged meshes to R.trackGroup, recording
// disposables in R._mergedGeoms/R._mergedMats (freed on the next setTrack).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GROUND_SIZE } from './environment.js';

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
// planks (beach) — all vertex paint on the same sweep, no new geometry or textures.
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
  // Centre dash cadence: at top speed (~9 u/s) a 1.8u period streams past at
  // ~5 cycles/s — a readable flow, not a strobe. The dash is the near-field
  // speedometer: right at the chase cam's focus, its flow rate IS the car's
  // actual speed (the asphalt itself is flat colour, so without it nothing
  // close to the car streams past). Starting values.
  const DASH_PERIOD = 1.8, DASH_FRAC = 0.4;      // ~0.72u dash / ~1.08u gap

  // Resample the centreline at a uniform, fine arclength step. Raw samples are spaced
  // unevenly (~0.4 on tight corners, ~1.5 on straights) — far coarser than a painted
  // band — so colouring whole between-sample segments aliases the bands into uneven
  // blobs. Step a few× finer than the SMALLEST band so every band renders cleanly. The
  // kerb stripe is now long (stripeLen), so the centre dash's on-length is the finest
  // feature; driving ds off it keeps the dash from quantising to ragged ring counts.
  const minBand = Math.min(stripeLen, DASH_PERIOD * DASH_FRAC);
  let N = Math.min(4000, Math.max(8, Math.round(cl.length / Math.max(0.06, minBand / 3))));
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
  const SKIRT = c(rd.skirt ?? rd.asphalt ?? 0x5a6078);// deck sides + belly (boardwalk: timber)
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

  // Visible-mesh attributes, sized exactly (16 strips × 2 tris × 3 verts × 3 floats per
  // ring) and filled by cursor — no per-vertex array growth. Float32BufferAttribute takes
  // the typed array directly (no copy).
  const STRIDE = STRIPS.length * 6 * 3;
  const pos = new Float32Array(N * STRIDE);
  const col = new Float32Array(N * STRIDE);
  let pc = 0, cc = 0;
  const emitPt = (i, j) => { const o = i * RP + j * 3; pos[pc++] = rings[o]; pos[pc++] = rings[o + 1]; pos[pc++] = rings[o + 2]; };
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

  const mkGeom = (positions, colors) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // Normals only matter for the lit, visible road (colors set). The collision proxy is an
    // invisible MeshBasicMaterial raycast for ground-conform Y — it never shades, so a normal
    // attribute is pure waste there (one computeVertexNormals per 8-segment chunk).
    if (colors) { g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); g.computeVertexNormals(); }
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
  // Build the FULL ribbon once and solve its vertex normals across the whole surface, THEN
  // slice it into fixed-ring chunks. Solving normals per-chunk would split them at every
  // seam (each boundary vertex seeing only one chunk's triangles), leaving a faint lighting
  // facet on banked/graded seams; slicing ONE normal-solved buffer keeps the shading
  // pixel-identical to the old single mesh. Each ring contributes a fixed run of vertices
  // (STRIPS × 2 tris × 3), so a chunk is just a contiguous slice of the buffers. The sweep
  // fills the preallocated pos/col typed arrays via emitPt/pushStripCol (cursor-advanced).
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
    for (const st of STRIPS) {
      emitPt(i, st.a); emitPt(i, st.b); emitPt(ni, st.b);  // tri 1: ia, ib, nb
      emitPt(i, st.a); emitPt(ni, st.b); emitPt(ni, st.a); // tri 2: ia, nb, na
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
  const full = mkGeom(pos, col); // solves vertex normals over the whole ribbon
  const fp = full.attributes.position.array, fc = full.attributes.color.array, fn = full.attributes.normal.array;
  const CHUNK_RINGS = 160; // keep chunk count (hence drawn-when-visible draw calls) low; STRIDE = floats/ring
  for (let lo = 0; lo < N; lo += CHUNK_RINGS) {
    const a = lo * STRIDE, z = Math.min(lo + CHUNK_RINGS, N) * STRIDE;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fp.slice(a, z), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(fc.slice(a, z), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(fn.slice(a, z), 3));
    g.computeBoundingSphere(); // per-chunk sphere → three frustum-culls off-screen chunks
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false; // positions are already baked in world space
    mesh.receiveShadow = true;
    // Cast shadow ONLY from elevated chunks (bridge/ramp/loop decks). The shadow camera
    // frames the whole track, so it can't cull the road; a ground-level chunk only casts
    // onto grass, which opts out of receiving (env.js), so its shadow is invisible — skip
    // it for free. An elevated deck genuinely shades the road below, so it keeps casting.
    let maxY = -Infinity;
    for (let k = a + 1; k < z; k += 3) if (fp[k] > maxY) maxY = fp[k];
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
    const cgeo = mkGeom(chunk, null);
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
}
