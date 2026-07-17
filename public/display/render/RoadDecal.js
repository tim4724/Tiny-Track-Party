// Road-clipped decals: cut a decal's geometry OUT of the road ribbon's own
// triangles instead of approximating the surface with an independent mesh.
//
// Why: anything that "sits on the road" (oil sheets, boost pads, blob shadows)
// used to be its own flat/conformed mesh over the deck. Two meshes can only
// approximate each other — between their vertices the finer road ribbon bulges
// through the coarser decal on any crest or roll transition, and polygonOffset's
// screen-slope-scaled margin then wins or loses PER ANGLE (the puddle flickers,
// or is swallowed whole at grazing views). Clipping the ribbon's triangles to the
// decal footprint makes the decal a true sub-surface of the road: every output
// triangle is a sub-triangle of a road triangle, so it's exactly coplanar with the
// deck and polygonOffset wins deterministically from every camera. No lift.
//
// Contract: `clipRoadDecal(deckMeshes, frame, region)` → BufferGeometry in WORLD
// space (use with matrixAutoUpdate=false at identity), or null when the footprint
// misses the deck entirely (caller falls back to its flat tangent-plane shape).
//   deckMeshes  visible road-ribbon chunk meshes (userData.roadDeck; non-indexed
//               soup with position + normal; world-space, identity transform)
//   frame       { centre, right, fwd, up } — right/fwd/up unit vectors; right =
//               lateral, fwd = travel (UV +v), up = road normal at the centre
//   region      { kind: 'circle', r } | { kind: 'rect', halfW, halfL }
//               | { kind: 'annulus', r0, r1 }
//
// A single CONNECTED road layer is kept: at a loop mouth (or any fold) the flat
// footprint can overlap two stacked strands of road, so we region-grow from the
// triangle under the centre across shared edges and clip only that component —
// a stray strand elsewhere in the lap shares no vertices with it and is dropped.
//
// UVs map the footprint's bounding square to 0..1 (u along `right`, v along
// `fwd`) — the same mapping CircleGeometry/PlaneGeometry gave the old flat pads.
// Normals are barycentric-lerped from the ribbon (the decal shades EXACTLY like
// the road it sits on) and flipped to face `up`, with the winding matched, so
// FrontSide materials work.
import * as THREE from 'three';

const HBAND = 1.2;      // reject triangles further than this from the frame plane along `up` (stacked decks)
const MIN_NORMAL = 0.35; // reject faces steeper than ~70° to `up` (kerb sides, skirts, walls)
const CIRCLE_SEGS = 36;  // circle footprint = inscribed 36-gon (matches the old CircleGeometry discs)
const WELD = 1e4;        // vertex-key quantisation (0.1mm) for edge-adjacency welding

// Convex clip polygons in footprint-local (l, f) coords, wound CCW.
function regionPolys(region) {
  if (region.kind === 'rect') {
    const w = region.halfW, l = region.halfL;
    return [[[-w, -l], [w, -l], [w, l], [-w, l]]];
  }
  if (region.kind === 'circle') {
    const poly = [];
    for (let i = 0; i < CIRCLE_SEGS; i++) {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2;
      poly.push([Math.cos(a) * region.r, Math.sin(a) * region.r]);
    }
    return [poly];
  }
  // annulus: not convex — split into CIRCLE_SEGS convex sector quads
  const polys = [];
  for (let i = 0; i < CIRCLE_SEGS; i++) {
    const a0 = (i / CIRCLE_SEGS) * Math.PI * 2, a1 = ((i + 1) / CIRCLE_SEGS) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    polys.push([
      [c0 * region.r0, s0 * region.r0], [c0 * region.r1, s0 * region.r1],
      [c1 * region.r1, s1 * region.r1], [c1 * region.r0, s1 * region.r0]
    ]);
  }
  return polys;
}

function regionRadius(region) {
  if (region.kind === 'rect') return Math.hypot(region.halfW, region.halfL);
  if (region.kind === 'circle') return region.r;
  return region.r1;
}

// Sutherland–Hodgman: clip a polygon (vertices carry 3D pos/normal + 2D l/f)
// against one CCW edge a→b of the convex region. Interpolation is linear along
// the polygon edge, so clipped points stay on the source triangle's plane.
function clipEdge(poly, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % poly.length];
    const dc = ex * (cur.f - ay) - ey * (cur.l - ax); // >= 0 = inside (left of the edge)
    const dn = ex * (nxt.f - ay) - ey * (nxt.l - ax);
    if (dc >= 0) out.push(cur);
    if ((dc >= 0) !== (dn >= 0)) {
      const t = dc / (dc - dn);
      out.push({
        p: cur.p.clone().lerp(nxt.p, t),
        n: cur.n.clone().lerp(nxt.n, t),
        l: cur.l + (nxt.l - cur.l) * t,
        f: cur.f + (nxt.f - cur.f) * t
      });
    }
  }
  return out;
}

export function clipRoadDecal(deckMeshes, frame, region) {
  const { centre, right, fwd, up } = frame;
  const reach = regionRadius(region);
  const d = new THREE.Vector3(), gn = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
  const local = (v) => { d.subVectors(v, centre); return { l: d.dot(right), f: d.dot(fwd), h: d.dot(up) }; };
  const keyOf = (v) => `${Math.round(v.x * WELD)},${Math.round(v.y * WELD)},${Math.round(v.z * WELD)}`;
  // ribbon normals are wound "down"; flip each up-facing so the decal lights as an
  // up-facing surface (and phase 3 never has to touch a shared normal).
  const orient = (n) => { const c = n.clone(); if (c.dot(up) < 0) c.negate(); return c.normalize(); };

  // ---- Phase 1: gather candidate triangles (footprint ∩ near the frame plane, near-flat).
  // Each carries its 3 world verts, up-facing normals, and per-vertex (l,f); we keep the
  // topology (shared vertex keys) so we can region-grow one connected layer next.
  const cands = [];
  const vertTris = new Map(); // welded vertex key -> [candidate index]
  for (const mesh of deckMeshes) {
    const sphere = mesh.geometry.boundingSphere;
    if (sphere && sphere.center.distanceTo(centre) > sphere.radius + reach + 1) continue;
    const pos = mesh.geometry.attributes.position, nrm = mesh.geometry.attributes.normal;
    for (let i = 0; i < pos.count; i += 3) {
      va.fromBufferAttribute(pos, i); vb.fromBufferAttribute(pos, i + 1); vc.fromBufferAttribute(pos, i + 2);
      const la = local(va), lb = local(vb), lc = local(vc);
      if (Math.min(Math.abs(la.h), Math.abs(lb.h), Math.abs(lc.h)) > HBAND) continue; // a stacked deck
      if (Math.min(la.l, lb.l, lc.l) > reach || Math.max(la.l, lb.l, lc.l) < -reach ||
          Math.min(la.f, lb.f, lc.f) > reach || Math.max(la.f, lb.f, lc.f) < -reach) continue; // outside footprint bbox
      gn.crossVectors(e1.subVectors(vb, va), e2.subVectors(vc, va));
      const glen = gn.length();
      if (glen < 1e-10) continue; // degenerate sliver
      const facing = gn.dot(up) / glen; // sign also tells us the source winding
      if (Math.abs(facing) < MIN_NORMAL) continue; // kerb side / skirt / loop wall
      na.fromBufferAttribute(nrm, i); nb.fromBufferAttribute(nrm, i + 1); nc.fromBufferAttribute(nrm, i + 2);
      // wind CCW-from-up regardless of the ribbon's own (downward) winding
      const V = facing >= 0
        ? [[va, na, la], [vb, nb, lb], [vc, nc, lc]]
        : [[va, na, la], [vc, nc, lc], [vb, nb, lb]];
      const tri = {
        keys: [keyOf(va), keyOf(vb), keyOf(vc)],
        v: V.map(([p, n, lf]) => ({ p: p.clone(), n: orient(n), l: lf.l, f: lf.f })),
        // score for the seed pick: nearest the centre in-plane, with a strong pull to the centre layer (small |h|)
        score: ((la.l + lb.l + lc.l) ** 2 + (la.f + lb.f + lc.f) ** 2) / 9 + 16 * ((la.h + lb.h + lc.h) / 3) ** 2
      };
      const idx = cands.length;
      cands.push(tri);
      for (const k of tri.keys) { let a = vertTris.get(k); if (!a) vertTris.set(k, a = []); a.push(idx); }
    }
  }
  if (!cands.length) return null;

  // ---- Phase 2: region-grow the connected layer under the centre. Two triangles are
  // adjacent when they share an edge (two welded vertices); the ribbon is a connected
  // soup with exactly-shared ring/strip verts, so BFS stays on one strand and never
  // hops to a folded-over strand (which shares no vertices here).
  let seed = 0;
  for (let i = 1; i < cands.length; i++) if (cands[i].score < cands[seed].score) seed = i;
  const keep = new Uint8Array(cands.length);
  const stack = [seed]; keep[seed] = 1;
  while (stack.length) {
    const ci = stack.pop(), tri = cands[ci];
    const neigh = new Map(); // candidate index -> shared-vertex count
    for (const k of tri.keys) for (const nj of vertTris.get(k)) if (nj !== ci) neigh.set(nj, (neigh.get(nj) || 0) + 1);
    for (const [nj, shared] of neigh) if (shared >= 2 && !keep[nj]) { keep[nj] = 1; stack.push(nj); }
  }

  // ---- Phase 3: clip the kept triangles to the region and emit world-space geometry.
  const polys = regionPolys(region);
  const uw = region.kind === 'rect' ? region.halfW : (region.kind === 'circle' ? region.r : region.r1);
  const ul = region.kind === 'rect' ? region.halfL : uw;
  const positions = [], normals = [], uvs = [];
  for (let ci = 0; ci < cands.length; ci++) {
    if (!keep[ci]) continue;
    const tri = cands[ci].v; // clipEdge never mutates its input verts, so no copy needed
    for (const poly of polys) {
      let clipped = tri;
      for (let e = 0; e < poly.length && clipped.length; e++) {
        const [ax, ay] = poly[e], [bx, by] = poly[(e + 1) % poly.length];
        clipped = clipEdge(clipped, ax, ay, bx, by);
      }
      for (let k = 2; k < clipped.length; k++) { // fan-triangulate the clipped polygon
        for (const vtx of [clipped[0], clipped[k - 1], clipped[k]]) {
          positions.push(vtx.p.x, vtx.p.y, vtx.p.z);
          const nv = vtx.n.clone().normalize(); // already up-facing (oriented in phase 1); lerp may have denormalised
          normals.push(nv.x, nv.y, nv.z);
          uvs.push(vtx.l / (2 * uw) + 0.5, vtx.f / (2 * ul) + 0.5);
        }
      }
    }
  }
  if (!positions.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeBoundingSphere();
  return g;
}
