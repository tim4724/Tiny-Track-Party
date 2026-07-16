// Procedural start/finish gantry — two chunky plastic pylons carrying a chequered
// banner across the line at s=0. Replaces the Kenney gate-finish arch (a faceted
// inflatable ring that never read as a finish line). Built from primitives in the
// road frame at s=0 (X=lateral, Y=up, Z=travel) so it tilts with any bank/grade,
// then baked to world space like every other static track piece. Purely visual —
// the pylons stand beyond the kerbs, off the racing line and the collision proxy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Palette: the game's celebration red for the frame, warm ink + paper for the
// chequer (the Sticker Bash pair — never pure black/white in this world).
const RED = 0xff5040, INK = 0x2a2735, PAPER = 0xfff6eb;

const PYLON_R = 0.3;       // pylon radius — chunky toy tube, not scaffolding
const OVERHANG = 0.55;     // pylon centre beyond the road edge, onto the grass
const SINK = 0.6;          // pylon base sunk below road level (reaches the lawn/berm)
const ROWS = 2;            // chequer rows — big bold checks, not confetti
const BANNER_H = 0.8;      // banner face height
const BANNER_D = 0.12;     // banner thickness along travel
const CLEAR = 2.0;         // banner underside above the road — cars & cameras pass under
const FINIAL_R = 0.34;     // ball on each pylon top (toy flag-pole knob)

// The chequer canvas is identical for every track — build it once and share it.
let _checkerTex = null;
function checkerTexture(cols, rows) {
  if (_checkerTex) return _checkerTex;
  const PX = 16;
  const cv = document.createElement('canvas');
  cv.width = cols * PX; cv.height = rows * PX;
  const ctx = cv.getContext('2d');
  const ink = '#2a2735', paper = '#fff6eb';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 ? paper : ink;
      ctx.fillRect(x * PX, y * PX, PX, PX);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; // crisp check edges up close
  _checkerTex = tex;
  return tex;
}

export function buildFinishGate(R, track, theme) {
  if (!track.startGate) return;
  const f = track.centerline.sampleAt(0);
  const halfSpan = track.roadWidth / 2 + OVERHANG;
  const topY = CLEAR + BANNER_H;               // pylon top = banner top
  const grade = new THREE.Color((theme && theme.gate) || 0xffffff); // biome colour-grade (sun-bleach/cold-cast)

  // Local frame at the line: X across the road, Y up, Z along travel.
  const basis = new THREE.Matrix4().makeBasis(f.lateral.clone(), f.up.clone(), f.tangent.clone());
  basis.setPosition(f.pos.clone().addScaledVector(f.up, -0.02));

  const addMesh = (geo, mat) => {
    geo.applyMatrix4(basis); // bake to world space, like the merged track tiles
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;    // drops into the frozen per-track sun-shadow bake
    mesh.receiveShadow = true;
    R.trackGroup.add(mesh);
    R._mergedGeoms.push(geo);
    // register each material ONCE for _disposeTrack (a face-material array repeats entries)
    for (const m of new Set(Array.isArray(mat) ? mat : [mat])) R._mergedMats.push(m);
  };
  const lambert = (color) => { // matte toy plastic (structures never carry the cars' gloss)
    const m = new THREE.MeshLambertMaterial({ color });
    m.color.multiply(grade);
    return m;
  };

  // Pylons — one cylinder each side, sunk through the kerb drop to the lawn.
  const pylons = [];
  for (const side of [-1, 1]) {
    const g = new THREE.CylinderGeometry(PYLON_R, PYLON_R, topY + SINK, 16);
    g.translate(side * halfSpan, (topY - SINK) / 2, 0);
    pylons.push(g);
  }
  const pylonGeo = mergeGeometries(pylons, false);
  for (const g of pylons) g.dispose(); // copied into the merge
  addMesh(pylonGeo, lambert(RED));

  // Finials — a paper-white ball on each pylon top.
  const finials = [];
  for (const side of [-1, 1]) {
    const g = new THREE.SphereGeometry(FINIAL_R, 16, 12);
    g.translate(side * halfSpan, topY + FINIAL_R * 0.55, 0);
    finials.push(g);
  }
  const finialGeo = mergeGeometries(finials, false);
  for (const g of finials) g.dispose();
  addMesh(finialGeo, lambert(PAPER));

  // Banner — the chequered beam between the pylons. Front/back faces carry the
  // chequer; the thin edges stay frame-red so it reads as one built gantry.
  const rows = ROWS;
  const cols = 2 * Math.round(halfSpan * rows / BANNER_H) + 1; // ~square checks, odd count so both ends match
  const banner = new THREE.BoxGeometry(halfSpan * 2, BANNER_H, BANNER_D);
  banner.translate(0, CLEAR + BANNER_H / 2, 0);
  const checker = new THREE.MeshLambertMaterial({ map: checkerTexture(cols, rows) });
  checker.color.copy(grade);
  const edge = lambert(RED);
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z — chequer on the ±z (travel) faces.
  addMesh(banner, [edge, edge, edge, edge, checker, checker]);
}
