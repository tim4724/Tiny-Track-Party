// Per-track world geometry: the procedural ribbon road (+ its collision-proxy
// chunks), deck support pillars, and trackside scenery. Each builder takes the
// SceneRenderer instance (R) and adds merged meshes to R.trackGroup, recording
// disposables in R._mergedGeoms/R._mergedMats (freed on the next setTrack).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Trackside scenery GLBs (always preloaded — every track scatters them, see
// _buildScenery). Order matters: [0] is the round tree, [1] the pine.
export const SCENERY_MODELS = ['tree', 'tree-pine'];

// Build the visible road + kerbs by sweeping a fixed cross-section along the track
// centreline, plus a chunked road-surface proxy for the ground-conform raycast. The
// road is fully procedural (no GLB tiles): width comes from the track, the kerb is a
// low toy profile, so widening the road only pushes the kerb outward — it never grows
// into a wall the way scaling the old GLB tiles did. One merged vertex-coloured mesh
// (asphalt + white edge lines + red/white kerb + side skirt); adds it to trackGroup
// and the collision chunks to `collide`.
export function buildRibbonRoad(R, track, collide) {
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
  const dashW = 0.09;                            // painted centre-dash width
  // Centre dash cadence: at top speed (~9 u/s) a 1.8u period streams past at
  // ~5 cycles/s — a readable flow, not a strobe. The dash is the near-field
  // speedometer: right at the chase cam's focus, its flow rate IS the car's
  // actual speed (the asphalt itself is flat colour, so without it nothing
  // close to the car streams past). Starting values.
  const DASH_PERIOD = 1.8, DASH_FRAC = 0.4;      // ~0.72u dash / ~1.08u gap

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
    { a: 4,  b: 5,  kind: 'road'  },            // gap asphalt between kerb and left line
    { a: 5,  b: 6,  kind: 'line'  },            // left white edge line
    { a: 6,  b: 7,  kind: 'road'  },            // asphalt, left half
    { a: 7,  b: 8,  kind: 'dash'  },            // centre dash (LINE/ASPHALT bands along the lap)
    { a: 8,  b: 9,  kind: 'road'  },            // asphalt, right half
    { a: 9,  b: 10, kind: 'line'  },            // right white edge line
    { a: 10, b: 11, kind: 'road'  },            // gap asphalt between right line and kerb
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

  // Centre-dash banding by centreline arclength (the resample is uniform, so
  // ring i sits at i/N of the lap). Snap the period so a WHOLE number of
  // dash+gap cycles closes the loop — no half-dash at the start/finish seam.
  const dashPeriod = cl.length / Math.max(2, Math.round(cl.length / DASH_PERIOD));
  const dashOn = (i) => ((i / N) * cl.length) % dashPeriod < dashPeriod * DASH_FRAC;

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

  // Sweep the profile around the closed loop into ONE vertex-coloured buffer.
  for (let i = 0; i < N; i++) {
    const ni = (i + 1) % N;
    const colL = bandCol(kerbL, i), colR = bandCol(kerbR, i);
    const bare = bareAsphalt(i);
    const colD = (dashOn(i) && !bare) ? LINE : ASPHALT;
    const colLine = bare ? ASPHALT : LINE;
    for (const st of STRIPS) {
      const ia = ring(i, st.a).clone(), ib = ring(i, st.b).clone();
      const na = ring(ni, st.a).clone(), nb = ring(ni, st.b).clone();
      push3(pos, ia); push3(pos, ib); push3(pos, nb); // tri 1
      push3(pos, ia); push3(pos, nb); push3(pos, na); // tri 2
      const kerbCol = st.side === 'R' ? colR : colL;
      pushStripCol(
        st.kind === 'kerb' ? kerbCol : st.kind === 'line' ? colLine : st.kind === 'dash' ? colD : ASPHALT,
        st);
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
  // …and casts too, so where the ribbon stacks over itself (loops, the climbing
  // spiral, the roll bridge) the upper deck shades the lower one. Without this the
  // deck is opaque to incoming shadows but transparent to the sun, so an elevated
  // car drops a lone, parentless silhouette onto the road below instead of the deck
  // overhead simply putting that road in shade. (Flat road casts onto grass, which
  // opts out of receiving — env.js — so ordinary track is unchanged.)
  mesh.castShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(geo);
  R._mergedMats.push(mat);

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
  for (let i = 0; i < N; i++) {
    const ni = (i + 1) % N;
    const ia = ring(i, 4).clone(), ib = ring(i, 11).clone();
    const na = ring(ni, 4).clone(), nb = ring(ni, 11).clone();
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
export function buildPillars(R, track) {
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
  // (its UVs run 0..1 over the 600u plane, so x/600 keeps the same texels-per-metre).
  const uv = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / 600, pos[i + 2] / 600);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: R.ground.material.map, roughness: 1, metalness: 0, side: THREE.DoubleSide });
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
export function buildPoles(R, track) {
  const list = track.poles;
  if (!list || !list.length || !track.centerline) return;
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
    const g = new THREE.CylinderGeometry(r, r, h, 16);
    g.translate(base.x, base.y - EMBED + h / 2, base.z);          // span road surface → just under the deck above
    geoms.push(g);
  }
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa1b4, roughness: 1, metalness: 0 }); // matte toy concrete (like pillars)
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// Loop support poles — a VERTICAL post under each 360° loop, one on each side, holding it up
// from below. The post stands beneath the loop's lower-OUTER flank (where the road is angled
// ~60° and its underside faces down-and-out, and the road has curved away below — so a vertical
// shaft there has clear air all the way to the ground). Its TOP is cut to the road's underside
// plane (a diagonal, not a flat top) so it meets the angled road flush instead of poking through
// it. We auto-detect loops and brace each at one lower-flank point per side. Purely visual.
export function buildLoopPoles(R, track) {
  const cl = track.centerline;
  if (!cl || !cl.samples.length) return;
  const ss = cl.samples, n = ss.length, gy = R.ground.position.y;
  const loops = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (ss[i].up.y < 0.3) { if (!cur) { cur = [i, i]; loops.push(cur); } else cur[1] = i; }
    else cur = null;
  }
  const RAD = 0.36, EMBED = 0.1, DECK = 0.34, OFFSET = 0.45; // OFFSET nudges the shaft out past the road's outer face; slim RAD keeps margin
  const geoms = [];
  for (const [a0, b0] of loops) {
    if (b0 - a0 < 4) continue;
    let a = a0, b = b0;
    while (a > 0 && ss[a].pos.y > 0.6) a--;
    while (b < n - 1 && ss[b].pos.y > 0.6) b++;
    let cx = 0, cz = 0, cnt = 0;
    for (let i = a; i <= b; i++) { cx += ss[i].pos.x; cz += ss[i].pos.z; cnt++; }
    cx /= cnt; cz /= cnt;
    let apex = a;
    for (let i = a; i <= b; i++) if (ss[i].pos.y > ss[apex].pos.y) apex = i; // top of the loop splits its two sides
    for (const [lo, hi] of [[a, apex], [apex, b]]) {
      // one contact per side: a lower-flank sample where the road is angled ~60° (up.y ≈ 0.5)
      let best = null;
      for (let i = lo; i <= hi; i++) { const s = ss[i]; if (s.pos.y < 1.5 || s.pos.y > 3.2 || s.up.y < 0.3) continue; const sc = Math.abs(s.up.y - 0.5); if (!best || sc < best.sc) best = { s, sc }; }
      if (!best) continue;
      const c = best.s;
      let ox = c.pos.x - cx, oz = c.pos.z - cz; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol; // outward (away from loop centre)
      const sx = c.pos.x + ox * OFFSET, sz = c.pos.z + oz * OFFSET; // shaft, nudged out to clear the road's outer face
      // road UNDERSIDE plane at the contact: a point a deck-thickness behind the surface, normal = up.
      const ux = c.up.x, uy = c.up.y, uz = c.up.z;
      const Ux = c.pos.x - ux * DECK, Uy = c.pos.y - uy * DECK, Uz = c.pos.z - uz * DECK;
      const H = (c.pos.y + 1.0) - (gy - EMBED); // build tall, then clip the top to the plane below
      const g = new THREE.CylinderGeometry(RAD, RAD, H, 16);
      g.translate(sx, gy - EMBED + H / 2, sz);
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
  }
  if (!geoms.length) return;
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) for (const g of geoms) g.dispose();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa1b4, roughness: 1, metalness: 0 }); // matte toy concrete (like pillars)
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  R.trackGroup.add(mesh);
  R._mergedGeoms.push(merged);
  R._mergedMats.push(mat);
}

// Trackside scenery — the kit's own GLB trees (round + pine, with small
// sunken trees standing in for bushes) plus faceted boulders, scattered on
// the grass outside the racing corridor. The parallax of things streaming
// past is the strongest speed cue there is (trackside, not on the car — see
// the wheel-roll notes above). Trees + bushes bake into ONE textured mesh
// (they all share the kit colormap) and the boulders into ONE vertex-
// coloured mesh — two draw calls total, like the road; castShadow stays
// off because the grass doesn't receive shadows anyway.
export function buildScenery(R, track) {
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

  // Tree sources: each SCENERY_MODELS proto reduced to bake-ready
  // {geometry, matrixWorld} parts plus the shared colormap material. The kit
  // models are toy-tiny (0.83 tall — shorter than two cars), so placements
  // scale them up to diorama size below.
  const treeSrc = [];
  let colorMat = null;
  for (const name of SCENERY_MODELS) {
    const root = R.protos.get(name);
    if (!root) continue;
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      parts.push({ geo: o.geometry, mw: o.matrixWorld.clone() });
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!colorMat && m && m.map) colorMat = m;
    });
    if (parts.length) treeSrc.push(parts);
  }

  const KEEP = ['position', 'normal', 'uv']; // merged attribute sets must match
  const groundY = R.ground.position.y;
  const treeGeoms = [];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
  const P = new THREE.Vector3(), S = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const placeTree = (x, z, opts = {}) => {
    if (!treeSrc.length) return;
    // 65% round / 35% pine — pines as the accent, not an evergreen forest
    const parts = opts.parts || treeSrc[rand() < 0.65 ? 0 : treeSrc.length - 1];
    const s = opts.s != null ? opts.s : 2.3 + rand() * 1.1; // ≈1.9–2.8 world tall (≈3–5 car heights)
    Q.setFromAxisAngle(UP, rand() * Math.PI * 2);
    S.set(s, s * (0.92 + rand() * 0.16), s); // slight height jitter
    P.set(x, groundY - (opts.sink || 0) * s, z); // sink: bury the trunk (bushes, below)
    M.compose(P, Q, S);
    // Per-vertex shade multiplier over the colormap (1 = as-authored): a touch
    // of brightness variation keeps a copse from reading as stamped clones.
    const shade = 0.88 + rand() * 0.2;
    for (const part of parts) {
      const g = part.geo.clone();
      for (const nm of Object.keys(g.attributes)) {
        if (!KEEP.includes(nm)) g.deleteAttribute(nm);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(part.mw).applyMatrix4(M);
      const n = g.attributes.position.count;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(shade), 3));
      treeGeoms.push(g);
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
  const ROCK_GREYS = [0xc6cbd6, 0xb4bac8, 0x9aa1b4]; // pillar-concrete family

  const plainGeoms = [];
  const step = 7; // candidate spacing along the lap (world units)
  for (let d = 0; d < cl.length && treeGeoms.length + plainGeoms.length < 500; d += step) {
    const f = cl.sampleAt(d);
    const half = (f.width != null ? f.width : track.roadWidth || 5) / 2;
    for (const side of [-1, 1]) {
      if (rand() > 0.62) continue; // leave gaps — a hedge-wall reads fake
      const lat = side * (half + 2.5 + rand() * 9);
      const x = f.pos.x + f.lateral.x * lat + (rand() - 0.5) * 3;
      const z = f.pos.z + f.lateral.z * lat + (rand() - 0.5) * 3;
      if (!isClear(x, z)) continue;
      const roll = rand();
      if (roll < 0.62) {
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
      } else if (roll < 0.9) {
        // "bush" = a small round tree sunk to its canopy. The kit has no bush
        // model, and procedural domes never matched (flat side facets render
        // as dark holes against the sunlit lawn) — a buried trunk reuses the
        // canopy's authored colours/facets for an exact style match, free.
        placeTree(x, z, { parts: treeSrc[0], s: 1.1 + rand() * 0.7, sink: 0.3 });
      } else {
        // half-sunk boulder
        const rr = 0.3 + rand() * 0.45;
        const grey = ROCK_GREYS[Math.floor(rand() * ROCK_GREYS.length)];
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
  addMerged(plainGeoms, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }));
}
