// Every triangle of a GLB's scene, in the scene's own space, as [a, b, c]
// points. Dependency-free so the browser and Node read a model the same way:
// the landmark gallery's sight lines (TestHarness.js) and the set-piece check
// (scripts/set-check.mjs). Triangle lists only; other primitive modes are
// skipped. A triangle under a part the renderer DRAPES (a node named
// `drape...`, or an `anim_` node with the `drape` verb: set_motion.h) carries
// `drape: true`: it was built on the plain and is laid on the ground as drawn.

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Column-major 4x4 product a * b.
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function localMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1];
}

function accessor(json, bin, i) {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
  const stride = (v.byteStride || size * T.BYTES_PER_ELEMENT) / T.BYTES_PER_ELEMENT;
  const start = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
  // A copy where the offset is not aligned to the type (typed arrays need it).
  const base = start % T.BYTES_PER_ELEMENT
    ? new T(bin.buffer.slice(start, start + v.byteLength))
    : new T(bin.buffer, start, (a.count - 1) * stride + size);
  const out = new Array(a.count);
  for (let k = 0; k < a.count; k++) out[k] = size === 1 ? base[k * stride] : Array.from(base.subarray(k * stride, k * stride + size));
  return out;
}

export function glbTriangles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < bytes.byteLength) {
    const len = view.getUint32(off, true), type = view.getUint32(off + 4, true);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('expected a JSON and a BIN chunk');
  const tris = [];
  const draped = (name = '') => name.startsWith('drape')
    || (name.startsWith('anim_') && name.slice(5).split('#')[0].split('+').some((v) => v.split(':')[0] === 'drape'));
  const walk = (ni, parent, drape) => {
    const n = json.nodes[ni];
    const m = mul(parent, localMatrix(n));
    drape = drape || draped(n.name);
    if (n.mesh != null) {
      for (const p of json.meshes[n.mesh].primitives) {
        if ((p.mode ?? 4) !== 4) continue;
        const pos = accessor(json, bin, p.attributes.POSITION).map(([x, y, z]) => [
          m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]]);
        const idx = p.indices != null ? accessor(json, bin, p.indices) : pos.map((_, k) => k);
        for (let k = 0; k + 2 < idx.length; k += 3) {
          const t = [pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]];
          if (drape) t.drape = true;
          tris.push(t);
        }
      }
    }
    for (const c of n.children || []) walk(c, m, drape);
  };
  for (const ni of json.scenes[json.scene || 0].nodes) walk(ni, IDENTITY, false);
  return tris;
}
