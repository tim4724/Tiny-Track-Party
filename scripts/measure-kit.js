'use strict';

// Measure Kenney Toy Car Kit GLB geometry WITHOUT a 3D engine or build step.
// glTF requires POSITION accessors to carry min/max, so we can read per-mesh
// bounding boxes straight from the JSON chunk, transform them through the node
// hierarchy, and derive the grid module / curve radii / loop dimensions that the
// track builder needs to chain pieces. Usage: node measure-kit.js <glb-dir> [name-filter]

const fs = require('fs');
const path = require('path');
const { walkScene, transformPoint, parseGLB } = require('./glb');

const DIR = process.argv[2];
const FILTER = process.argv[3] || '';
if (!DIR) { console.error('usage: node measure-kit.js <glb-dir> [name-filter]'); process.exit(1); }

// Walk the scene and accumulate a global AABB over all mesh primitives + a tri
// count. glTF requires POSITION accessors to carry min/max, so this reads the
// per-mesh bounds straight from the JSON without ever decoding the BIN chunk.
function measure(gltf) {
  const accessors = gltf.accessors || [];
  const meshes = gltf.meshes || [];
  let min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity], tris = 0;
  walkScene(gltf, (node, world) => {
    if (node.mesh == null) return;
    for (const prim of meshes[node.mesh].primitives) {
      const acc = accessors[prim.attributes.POSITION];
      if (acc && acc.min && acc.max) {
        const lo = acc.min, hi = acc.max;
        for (let i = 0; i < 8; i++) { // transform all 8 AABB corners
          const corner = [ (i&1)?hi[0]:lo[0], (i&2)?hi[1]:lo[1], (i&4)?hi[2]:lo[2] ];
          const w = transformPoint(world, corner);
          for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
        }
      }
      if (prim.indices != null) tris += accessors[prim.indices].count / 3;
      else if (acc) tris += acc.count / 3;
    }
  });
  return { min, max, tris: Math.round(tris) };
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.glb') && f.includes(FILTER)).sort();
const r3 = n => Math.round(n * 1000) / 1000;
console.log('file'.padEnd(46), 'sizeX  sizeY  sizeZ'.padEnd(22), 'minY   maxY'.padEnd(14), 'tris');
console.log('-'.repeat(92));
const rows = [];
for (const f of files) {
  try {
    const { json } = parseGLB(fs.readFileSync(path.join(DIR, f)));
    const { min, max, tris } = measure(json);
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
