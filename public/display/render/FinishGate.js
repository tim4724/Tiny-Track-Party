// Procedural start/finish gantry — two chunky plastic pylons on flag-stand feet
// carrying a chequered banner across the line at s=0. Replaces the Kenney
// gate-finish arch (a faceted inflatable ring that never read as a finish line).
//
// `gantryGroup` builds the gate as a plain THREE.Group in the ROAD FRAME at the
// line (X across the road, Y up, Z along travel, origin on the road surface) —
// pure geometry, no renderer coupling — so the assets gallery can show one per
// biome. `buildFinishGate` orients that group into the world (it banks with the
// road) and registers it with the scene's per-track lifecycle.
//
// Biomes re-dress the gate two ways: `theme.gantry` picks the plastic colours
// (lighthouse rings on the beach, timber in the canyon, …) and `theme.gate`
// multiplies its near-white colour-grade on top (sun-bleach/heat/cold), same as
// every other structure.
import * as THREE from 'three';

// Palette: the game's celebration red for the default frame, warm ink + paper
// for the chequer (the Sticker Bash pair — never pure black/white in this world).
const RED = 0xff5040, INK = 0x2a2735, PAPER = 0xfff6eb;
const DEFAULT_GANTRY = { pylon: RED, finial: PAPER };

const PYLON_R = 0.3;       // pylon radius — chunky toy tube, not scaffolding
const KERB_CLEAR = 0.25;   // gap between the kerb's outer edge and the pylon face —
                           // covers the kerb sweeping toward the post on a curved line
const DEF_KERB_W = 0.22;   // buildRibbonRoad's default kerb width (theme.road.kerbW overrides)
const ROWS = 2;            // chequer rows — big bold checks, not confetti
const BANNER_H = 0.8;      // banner face height
const BANNER_D = 0.12;     // banner thickness along travel
const CLEAR = 2.0;         // banner underside above the road — cars & cameras pass under
const FOOT_R = 0.55;       // flag-stand foot radius (grounds the post on lawn or skirt)
const FOOT_H = 0.24;       // foot height above the lawn
const RING_H = 0.42;       // striped-pylon ring height (lighthouse bands)

// Chequer / ring canvases are tiny and re-used across tracks — cache by key.
const _texCache = new Map();
function checkerTexture(cols, rows) {
  const key = `check:${cols}x${rows}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const PX = 16;
  const cv = document.createElement('canvas');
  cv.width = cols * PX; cv.height = rows * PX;
  const ctx = cv.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#fff6eb' : '#2a2735';
      ctx.fillRect(x * PX, y * PX, PX, PX);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; // crisp check edges up close
  _texCache.set(key, tex);
  return tex;
}
// Horizontal two-colour bands for a striped pylon (the beach lighthouse look).
// `bands` = how many rings the pylon's visible height is split into (odd count
// so it starts and ends on the base colour).
function ringTexture(baseHex, ringHex, bands) {
  const key = `rings:${baseHex}:${ringHex}:${bands}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const PX = 16;
  const cv = document.createElement('canvas');
  cv.width = PX; cv.height = bands * PX;
  const ctx = cv.getContext('2d');
  const hex = (h) => `#${h.toString(16).padStart(6, '0')}`;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = i % 2 ? hex(ringHex) : hex(baseHex);
    // canvas y runs top-down = cylinder v runs bottom-up — symmetric bands, no matter
    ctx.fillRect(0, i * PX, PX, PX);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  _texCache.set(key, tex);
  return tex;
}

// The gantry as a plain group in the road frame at s=0 (origin on the road
// surface). `roadWidth`/`kerbW` size the span so the pylons stand clear beyond
// the kerb; `dropDepth` is how far below the road surface the lawn lies there
// (the feet sit on it and the pylons run down to them).
export function gantryGroup(theme, { roadWidth = 5, kerbW = DEF_KERB_W, dropDepth = 0.35 } = {}) {
  const style = (theme && theme.gantry) || DEFAULT_GANTRY;
  const grade = new THREE.Color((theme && theme.gate) || 0xffffff); // biome colour-grade
  const halfSpan = roadWidth / 2 + kerbW + KERB_CLEAR + PYLON_R; // pylon axis, clear of the kerb
  const topY = CLEAR + BANNER_H;   // pylon top = banner top
  const footY = -dropDepth;        // lawn level in the road frame

  const group = new THREE.Group();
  const lambert = (color) => { // matte toy plastic (structures never carry the cars' gloss)
    const m = new THREE.MeshLambertMaterial({ color });
    m.color.multiply(grade);
    return m;
  };
  const add = (geo, mat, x = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.x = x;
    group.add(mesh);
    return mesh;
  };

  // Pylons — one tube each side, running from inside the foot up to the banner
  // top. A striped style (`gantry.rings`) wraps lighthouse bands around it.
  const pylonH = topY - footY;
  const pylonGeo = new THREE.CylinderGeometry(PYLON_R, PYLON_R, pylonH, 16);
  pylonGeo.translate(0, footY + pylonH / 2, 0);
  const pylonMat = style.rings
    ? (() => {
        const bands = 2 * Math.round((topY / RING_H - 1) / 2) + 1; // odd → base colour at both ends
        const m = new THREE.MeshLambertMaterial({ map: ringTexture(style.pylon, style.rings, bands) });
        m.color.copy(grade);
        return m;
      })()
    : lambert(style.pylon);
  // Finial — a flush dome cap, SAME radius as the tube so the colour joint is a
  // clean circle (an oversized ball swallowed the pylon top with a visible crease).
  const finialGeo = new THREE.SphereGeometry(PYLON_R, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  finialGeo.translate(0, topY, 0);
  const finialMat = lambert(style.finial);
  // Foot — a squat ink plinth on the lawn (the toy flag-stand base). Grounds the
  // post visually where the skirt slopes away instead of spearing bare grass.
  const footGeo = new THREE.CylinderGeometry(FOOT_R * 0.82, FOOT_R, FOOT_H, 16);
  footGeo.translate(0, footY + FOOT_H / 2, 0);
  const footMat = lambert(INK);
  for (const side of [-1, 1]) {
    add(pylonGeo, pylonMat, side * halfSpan);
    add(finialGeo, finialMat, side * halfSpan);
    add(footGeo, footMat, side * halfSpan);
  }

  // Banner — the chequered beam between the pylons. Front/back faces carry the
  // chequer; the thin edges match the pylons so it reads as one built gantry.
  // It ends ON the pylon axes: the slab's end cross-section (BANNER_D thin) hides
  // entirely inside each tube, so the joint is a clean curve, never a poke-through.
  const cols = 2 * Math.round(halfSpan * ROWS / BANNER_H) + 1; // ~square checks, odd count so both ends match
  const bannerGeo = new THREE.BoxGeometry(halfSpan * 2, BANNER_H, BANNER_D);
  bannerGeo.translate(0, CLEAR + BANNER_H / 2, 0);
  const checker = new THREE.MeshLambertMaterial({ map: checkerTexture(cols, ROWS) });
  checker.color.copy(grade);
  const edge = lambert(style.pylon);
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z — chequer on the ±z (travel) faces.
  add(bannerGeo, [edge, edge, edge, edge, checker, checker]);

  return group;
}

export function buildFinishGate(R, track, theme) {
  if (!track.startGate) return;
  const f = track.centerline.sampleAt(0);
  // How far the lawn lies below the road surface at the line (feet stand on it);
  // small floor so the feet still tuck under the kerb skirt on a flush track.
  const dropDepth = Math.max(0.15, f.pos.y - (track.groundY != null ? track.groundY : f.pos.y - 0.35));
  const kerbW = (theme && theme.road && theme.road.kerbW) || DEF_KERB_W;
  const group = gantryGroup(theme, { roadWidth: track.roadWidth, kerbW, dropDepth });

  // Orient into the world from the road frame at the line — banks with the road.
  group.matrix.makeBasis(f.lateral.clone(), f.up.clone(), f.tangent.clone());
  group.matrix.setPosition(f.pos.clone().addScaledVector(f.up, -0.02)); // a hair into the road
  group.matrixAutoUpdate = false;

  // Same per-track lifecycle as the merged tiles: cast into the frozen sun-shadow
  // bake, and register geometry/materials for _disposeTrack. Materials are pushed
  // individually and deduped (meshes share them; a face-material ARRAY can't be
  // dispose()d whole).
  const geos = new Set(), mats = new Set();
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    geos.add(o.geometry); // pylon/finial/foot geometries are shared by both sides
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
  });
  for (const g of geos) R._mergedGeoms.push(g);
  for (const m of mats) R._mergedMats.push(m);
  R.trackGroup.add(group);
}
