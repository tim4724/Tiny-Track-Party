// Procedural canvas textures, small geometry helpers, and the rear name-plate
// builder shared by the display renderer (see SceneRenderer.js for how each is
// used in the scene). Pure functions — no renderer state.
import * as THREE from 'three';

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

// Wind-streak alpha: a blurred ellipse — soft at both ends AND across its width
// (unlike the skid texture, streaks never tile end-to-end, so soft ends are
// wanted here). Drawn white; the material colour tints it.
function makeStreakTexture() {
  const w = 64, h = 16;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.filter = 'blur(3px)';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2 - 8, h / 2 - 5, 0, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Streak geometry: ONE unit quad, length along Z (travel), width along X,
// facing +Y. Orientation comes from axial billboarding (below) — a fixed quad
// (or crossed pair) along the travel axis is near edge-on from DEAD ASTERN,
// which is exactly where every chase camera sits. Texture u runs along the
// length, v across the width. Scaled per streak via mesh.scale.
function makeStreakGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// Axial billboard for a streak mesh: spin it about its long (local Z) axis so
// its face follows the camera. Installed as onBeforeRender, which the renderer
// calls once per render pass — BEFORE it derives the modelViewMatrix from
// matrixWorld — so every split-screen cell sees the streak turned toward its
// OWN camera, even though all cells share the one scene.
const _sbV = new THREE.Vector3();
const _sbM = new THREE.Matrix4();
function streakBillboard(renderer, scn, camera) {
  _sbV.setFromMatrixPosition(camera.matrixWorld);
  _sbM.copy(this.parent.matrixWorld).invert();
  _sbV.applyMatrix4(_sbM).sub(this.position); // camera dir in the parent's frame
  // rotate +Y (the face normal) about Z onto the camera's bearing in the XY plane
  this.rotation.z = Math.atan2(-_sbV.x, _sbV.y);
  this.updateMatrix();
  this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
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

// Underbody-shading alpha: a feathered rounded rect (white core, soft edges),
// drawn portrait (texture v = car length) and stretched to each car's footprint.
// The feather lives INSIDE the quad, so the dark core sits ~inset under the
// chassis and fades out before the quad edge — the silhouette rule above.
function makeUnderShadowTexture() {
  const w = 64, h = 128;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const inset = 12; // blur tail stays clear of the canvas edge (no clipped feather)
  ctx.filter = 'blur(7px)';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.roundRect(inset, inset, w - inset * 2, h - inset * 2, 18);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cloud sprite: a few overlapping blurred white blobs — a soft toy cumulus.
// Every blob keeps blur-tail clearance (~2× the blur radius) from the canvas
// edges: a tail that crosses the edge gets sliced into a hard flat line — the
// "clipped cloud" artefact.
function makeCloudTexture() {
  const w = 128, h = 64;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.filter = 'blur(5px)';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  for (const [x, y, r] of [[36, 36, 14], [58, 30, 17], [84, 36, 14], [68, 42, 11], [46, 42, 10]]) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Lawn: mowing stripes (alternating ±4% luminance bands) plus a few soft
// blotches, tiled across the ground plane. Subtle — it should read as "lawn"
// only when you look, never as a pattern.
function makeLawnTexture() {
  const s = 256, stripes = 8;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const base = [106, 168, 79]; // the old flat ground colour, #6aa84f
  for (let i = 0; i < stripes; i++) {
    const f = i % 2 ? 1.04 : 0.965;
    ctx.fillStyle = `rgb(${Math.round(base[0] * f)},${Math.round(base[1] * f)},${Math.round(base[2] * f)})`;
    ctx.fillRect(Math.floor(i * s / stripes), 0, Math.ceil(s / stripes), s);
  }
  // faint organic blotches so the stripes don't read as a perfect print
  ctx.filter = 'blur(7px)';
  for (let i = 0; i < 26; i++) {
    const f = (i % 2 ? 1.05 : 0.95);
    ctx.fillStyle = `rgba(${Math.round(base[0] * f)},${Math.round(base[1] * f)},${Math.round(base[2] * f)},0.35)`;
    const x = (i * 73) % s, y = (i * 131) % s, r = 10 + (i * 37) % 22;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.6, i, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 18); // ~33u per tile on the 600u plane → stripes ≈ 4u wide
  tex.anisotropy = 4;
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

export {
  flipWinding, bestGrid,
  makeSkidTexture, makeStreakTexture, makeStreakGeometry, streakBillboard,
  makeSoftBlobTexture, makeUnderShadowTexture, makeCloudTexture, makeLawnTexture,
  makePadTexture, makePlate, PLATE_Y, PLATE_Y_FRAC
};
