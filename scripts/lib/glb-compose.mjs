// glb-compose.mjs — compose Kenney kit pieces into ONE GLB: read a piece,
// append it once, place it as many times as wanted under a transform node, and
// write the result. The gen-* scripts that build composed models (the train
// set, the per-track set pieces) all go through here, so the two traps below
// are solved once.
//
// Every piece must come from ONE kit: the output keeps a single material over
// that kit's atlas (`texture`), which is also what lets the renderer draw a
// composition as one merged, baked run.

import { readFileSync, writeFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

export function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error(`${file}: expected a JSON and a BIN chunk`);
  return { json, bin };
}

// A glTF document and its binary buffer as GLB bytes, both chunks padded to
// the 4-byte alignment the container requires.
export function encodeGlb(json, bin) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = Buffer.from(text, 'utf8');
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const glb = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binBytes.length);
  glb.writeUInt32LE(GLB_MAGIC, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonBytes.length, 12);
  glb.writeUInt32LE(JSON_CHUNK, 16);
  jsonBytes.copy(glb, 20);
  glb.writeUInt32LE(binBytes.length, 20 + jsonBytes.length);
  glb.writeUInt32LE(BIN_CHUNK, 24 + jsonBytes.length);
  binBytes.copy(glb, 28 + jsonBytes.length);
  return glb;
}

export function createComposer({ generator, texture }) {
  // One output glTF, built by appending each source whole and remapping its
  // indices. Every piece is the same kit with the same single material, so the
  // merge keeps ONE material and points every primitive at it.
  const out = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    materials: [{
      name: 'colormap',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 },
      doubleSided: true,
    }],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: texture, name: 'colormap' }],
    samplers: [{}],
  };
  const binParts = [];
  let binLen = 0;

  // Append a source's meshes and buffers ONCE, and hand back where its roots
  // landed. Every copy of a piece is its own node over ONE copy of the
  // geometry — appending per placement instead cost the train set 280 kB for
  // a 40 kB model.
  function load(src) {
    const base = {
      node: out.nodes.length,
      mesh: out.meshes.length,
      accessor: out.accessors.length,
      view: out.bufferViews.length,
      bin: binLen,
    };
    for (const bv of src.json.bufferViews || []) {
      out.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset || 0) + base.bin });
    }
    for (const acc of src.json.accessors || []) {
      out.accessors.push(acc.bufferView == null
        ? { ...acc }
        : { ...acc, bufferView: acc.bufferView + base.view });
    }
    for (const mesh of src.json.meshes || []) {
      out.meshes.push({
        ...mesh,
        primitives: mesh.primitives.map((p) => ({
          ...p,
          material: 0,
          indices: p.indices == null ? undefined : p.indices + base.accessor,
          attributes: Object.fromEntries(
            Object.entries(p.attributes).map(([k, v]) => [k, v + base.accessor])),
        })),
      });
    }
    // The source's nodes keep their own transforms; only their indices move.
    //
    // A MESH NODE IS RENAMED after its mesh, uniquely. The renderer's merged
    // draw groups find each loaded entity's geometry BY NODE NAME and refuse a
    // whole model whose names are ambiguous across meshes — and the kit reuses
    // names freely (the pirate ship's three flags are all "flag-c", the
    // cannon's two halves both "Group"). A refused model draws live-lit, at
    // several times the cost of a baked one, and looks no different.
    for (const n of src.json.nodes || []) {
      const copy = { ...n };
      if (n.children) copy.children = n.children.map((c) => c + base.node);
      if (n.mesh != null) {
        copy.mesh = n.mesh + base.mesh;
        copy.name = `${n.name || 'mesh'}#${copy.mesh}`;
      }
      out.nodes.push(copy);
    }
    binParts.push(src.bin);
    binLen += src.bin.length;
    if (binLen % 4) { const pad = 4 - (binLen % 4); binParts.push(Buffer.alloc(pad)); binLen += pad; }
    const roots = (src.json.scenes || [{ nodes: [] }])[src.json.scene || 0].nodes || [];
    return roots.map((r) => r + base.node);
  }

  // One placement of an already-loaded source: a node carrying the transform,
  // with the source's own roots as its children. glTF allows a node to be the
  // child of only ONE parent, so a repeated piece gets a fresh copy of its
  // WHOLE node subtree — a copy of the root alone would hand its children a
  // second parent, which importers reject outright. Cheap either way: a node is
  // a transform and a mesh index, not geometry.
  //
  // Returns the placement node, so a caller can put it under a pivot instead
  // of straight on the scene. `scale` is uniform and written only when set, so
  // a composition that never scales keeps the train set's exact bytes.
  function copyTree(i) {
    const n = { ...out.nodes[i] };
    if (n.children) n.children = n.children.map(copyTree);
    out.nodes.push(n);
    return out.nodes.length - 1;
  }
  function place(roots, { x, z, yaw, y = 0, scale, scene = true }) {
    const half = yaw / 2;
    const kids = roots.map(copyTree);
    const node = {
      translation: [x, y, z],
      rotation: [0, Math.sin(half), 0, Math.cos(half)],  // yaw about +y
    };
    if (scale != null) node.scale = [scale, scale, scale];
    node.children = kids;
    out.nodes.push(node);
    const index = out.nodes.length - 1;
    if (scene) out.scenes[0].nodes.push(index);
    return index;
  }

  // A named group over placement nodes, on the scene.
  function group(name, children) {
    out.nodes.push({ name, children });
    out.scenes[0].nodes.push(out.nodes.length - 1);
    return out.nodes.length - 1;
  }

  // DROP EVERY NODE THE SCENE CANNOT REACH, then write. `load` appends a
  // source's nodes so `place` has something to copy, and those templates are
  // then parented to nothing — which is not the same as invisible: gltfio
  // instantiates the node ARRAY, so an orphan is drawn, at identity, wherever
  // the model is placed. That is what parked a second locomotive, a tender, a
  // wagon and a rail on top of each other in the middle of the train set.
  //
  // Returns { bytes, tris } for the caller's report.
  function write(file) {
    const keep = new Set();
    const reach = (i) => {
      if (keep.has(i)) return;
      keep.add(i);
      for (const c of out.nodes[i].children || []) reach(c);
    };
    out.scenes[0].nodes.forEach(reach);
    const remap = new Map();
    const kept = [];
    out.nodes.forEach((n, i) => { if (keep.has(i)) { remap.set(i, kept.length); kept.push(n); } });
    out.nodes = kept.map((n) => (n.children
      ? { ...n, children: n.children.map((c) => remap.get(c)) }
      : n));
    out.scenes[0].nodes = out.scenes[0].nodes.map((r) => remap.get(r));

    const bin = Buffer.concat(binParts, binLen);
    out.buffers = [{ byteLength: bin.length }];
    const glb = encodeGlb(out, bin);
    writeFileSync(file, glb);

    // Triangles AS PLACED: a piece's geometry is stored once but drawn once per
    // node that reaches it.
    let tris = 0;
    const count = (i) => {
      const n = out.nodes[i];
      if (n.mesh != null) {
        for (const p of out.meshes[n.mesh].primitives) {
          if (p.indices != null) tris += out.accessors[p.indices].count / 3;
        }
      }
      for (const c of n.children || []) count(c);
    };
    out.scenes[0].nodes.forEach(count);
    return { bytes: glb.length, tris: Math.round(tris) };
  }

  return { load, place, group, write };
}
