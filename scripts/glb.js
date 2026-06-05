'use strict';

// Shared GLB geometry helpers for the dev inspection scripts — no 3D engine, no
// build step. A GLB is a 12-byte header + length-prefixed chunks: the JSON chunk
// describes nodes/meshes/accessors, the BIN chunk holds raw vertex data. These
// scripts decode that directly to measure Kenney kit geometry (track-piece
// connectors, car footprints) so the hardcoded numbers in TrackBuilder/protocol
// can be re-derived when assets change.

const fs = require('fs');

// --- minimal column-major mat4 ---
function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
  }
  return o;
}
function fromTRS(t, q, s) {
  t = t || [0,0,0]; q = q || [0,0,0,1]; s = s || [1,1,1];
  const [x,y,z,w] = q;
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;
  const [sx,sy,sz] = s;
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx, (xz-wy)*sx, 0,
    (xy-wz)*sy, (1-(xx+zz))*sy, (yz+wx)*sy, 0,
    (xz+wy)*sz, (yz-wx)*sz, (1-(xx+yy))*sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
// Transform a point [x,y,z] by a column-major mat4.
function transformPoint(m, p) {
  const [x,y,z] = p;
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}
// A node's local transform: an explicit matrix, or composed from TRS.
function nodeMatrix(node) {
  return node.matrix ? node.matrix.slice() : fromTRS(node.translation, node.rotation, node.scale);
}

// Split a GLB buffer into its JSON + BIN chunks. Throws if the magic is wrong.
function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));  // JSON
    else if (type === 0x004e4942) bin = data;                           // BIN
    off += 8 + len;
  }
  return { json, bin };
}

const COMP = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
// Read accessor `idx` as a typed-array view onto the BIN chunk.
function readAccessor(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const Ctor = COMP[acc.componentType];
  const n = NUM[acc.type];
  const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  return new Ctor(bin.buffer, bin.byteOffset + byteOffset, acc.count * n);
}

// Walk the default scene, calling visit(node, worldMatrix) for every node.
function walkScene(gltf, visit) {
  const nodes = gltf.nodes || [];
  function recur(idx, parent) {
    const node = nodes[idx];
    const world = multiply(parent, nodeMatrix(node));
    visit(node, world);
    for (const c of node.children || []) recur(c, world);
  }
  for (const r of gltf.scenes[gltf.scene || 0].nodes) recur(r, identity());
}

// Decode every POSITION vertex of a GLB file into world space. Returns a flat
// array of [x,y,z] points.
function loadVerts(filePath) {
  const { json, bin } = parseGLB(fs.readFileSync(filePath));
  const meshes = json.meshes || [];
  const verts = [];
  walkScene(json, (node, world) => {
    if (node.mesh == null) return;
    for (const prim of meshes[node.mesh].primitives) {
      const pos = readAccessor(json, bin, prim.attributes.POSITION);
      for (let i = 0; i < pos.length; i += 3) verts.push(transformPoint(world, [pos[i], pos[i+1], pos[i+2]]));
    }
  });
  return verts;
}

module.exports = {
  identity, multiply, fromTRS, transformPoint, nodeMatrix,
  parseGLB, readAccessor, walkScene, loadVerts,
};
