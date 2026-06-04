'use strict';

// Measure Kenney Toy Car Kit GLB geometry WITHOUT a 3D engine or build step.
// glTF requires POSITION accessors to carry min/max, so we can read per-mesh
// bounding boxes straight from the JSON chunk, transform them through the node
// hierarchy, and derive the grid module / curve radii / loop dimensions that the
// track builder needs to chain pieces. Usage: node measure-kit.js <glb-dir> [name-filter]

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2];
const FILTER = process.argv[3] || '';
if (!DIR) { console.error('usage: node measure-kit.js <glb-dir> [name-filter]'); process.exit(1); }

// --- minimal mat4 (column-major) ---
function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
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
function transformPoint(m, p) {
  const [x,y,z] = p;
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

function parseGLB(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8')); // JSON
    off += 8 + len;
  }
  return json;
}

function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  return fromTRS(node.translation, node.rotation, node.scale);
}

// Walk scene, accumulate a global AABB over all mesh primitives, count tris.
function measure(gltf) {
  const accessors = gltf.accessors || [];
  const meshes = gltf.meshes || [];
  const nodes = gltf.nodes || [];
  const scene = gltf.scenes[gltf.scene || 0];
  let min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  let tris = 0;

  function visit(idx, parent) {
    const node = nodes[idx];
    const world = multiply(parent, nodeLocalMatrix(node));
    if (node.mesh != null) {
      const mesh = meshes[node.mesh];
      for (const prim of mesh.primitives) {
        const posIdx = prim.attributes.POSITION;
        const acc = accessors[posIdx];
        if (acc && acc.min && acc.max) {
          const lo = acc.min, hi = acc.max;
          // transform all 8 corners
          for (let i = 0; i < 8; i++) {
            const corner = [ (i&1)?hi[0]:lo[0], (i&2)?hi[1]:lo[1], (i&4)?hi[2]:lo[2] ];
            const w = transformPoint(world, corner);
            for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
          }
        }
        if (prim.indices != null) tris += (accessors[prim.indices].count / 3);
        else if (acc) tris += acc.count / 3;
      }
    }
    for (const c of node.children || []) visit(c, world);
  }
  for (const r of scene.nodes) visit(r, identity());
  return { min, max, tris: Math.round(tris) };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.glb') && f.includes(FILTER)).sort();
const r3 = n => Math.round(n * 1000) / 1000;
console.log('file'.padEnd(46), 'sizeX  sizeY  sizeZ'.padEnd(22), 'minY   maxY'.padEnd(14), 'tris');
console.log('-'.repeat(92));
const rows = [];
for (const f of files) {
  try {
    const gltf = parseGLB(fs.readFileSync(path.join(DIR, f)));
    const { min, max, tris } = measure(gltf);
    const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
    rows.push({ f, min, max, size, tris });
    console.log(
      f.replace('.glb','').padEnd(46),
      `${r3(size[0])}  ${r3(size[1])}  ${r3(size[2])}`.padEnd(22),
      `${r3(min[1])}  ${r3(max[1])}`.padEnd(14),
      tris
    );
  } catch (e) {
    console.log(f.padEnd(46), 'ERROR', e.message);
  }
}
