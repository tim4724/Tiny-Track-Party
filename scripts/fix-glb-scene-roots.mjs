#!/usr/bin/env node
// Repair GLBs whose SCENE ROOT node is also somebody's child.
//
// The Nature Kit models (palm/cactus) come out of UniGLTF with a stray
// "tmpParent" wrapper: nodes[0] is an identity-transform parent of nodes[1],
// but the scene lists nodes[1] as its root. That violates the glTF spec (a
// scene root must have no parent) — some loaders tolerate it, cgltf does NOT, so
// gltfio refuses the whole file ("Unable to parse glTF file") and the native
// renderer silently loses those trees.
//
// The fix drops the identity wrapper and points the scene at the mesh node,
// which is what every loader was rendering anyway. Idempotent: files that are
// already valid are left untouched.
//
//   node scripts/fix-glb-scene-roots.mjs [files…]     (default: public/assets/toycar/*.glb)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/assets/toycar';
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(DIR).filter((f) => f.endsWith('.glb')).map((f) => join(DIR, f));

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a;

for (const path of files) {
  const buf = readFileSync(path);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) continue;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK) continue;
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const nodes = json.nodes || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));

  // Every scene root that has a parent: if that parent is an identity-transform
  // wrapper whose ONLY child is this root, delete the wrapper and reindex.
  let changed = false;
  for (const scene of json.scenes || []) {
    scene.nodes = (scene.nodes || []).map((root) => {
      const p = parent.get(root);
      if (p == null) return root;
      const w = nodes[p];
      const identity = (w.children || []).length === 1
        && !w.mesh && !w.matrix
        && (!w.translation || w.translation.every((v) => v === 0))
        && (!w.rotation || (w.rotation[0] === 0 && w.rotation[1] === 0 && w.rotation[2] === 0 && Math.abs(w.rotation[3]) === 1))
        && (!w.scale || w.scale.every((v) => v === 1));
      if (!identity) {
        console.warn(`${path}: scene root ${root} has a NON-identity parent ${p} — left alone`);
        return root;
      }
      nodes[p] = null; // drop the wrapper
      changed = true;
      return root;
    });
  }
  if (!changed) continue;

  // Compact the node array and remap every index that points into it.
  const remap = new Map();
  const kept = [];
  nodes.forEach((n, i) => { if (n) { remap.set(i, kept.length); kept.push(n); } });
  json.nodes = kept;
  for (const n of kept) {
    if (n.children) n.children = n.children.map((c) => remap.get(c)).filter((c) => c != null);
    if (n.children && !n.children.length) delete n.children;
  }
  for (const scene of json.scenes || []) {
    scene.nodes = scene.nodes.map((r) => remap.get(r)).filter((r) => r != null);
  }
  for (const skin of json.skins || []) {
    if (skin.joints) skin.joints = skin.joints.map((j) => remap.get(j) ?? j);
    if (skin.skeleton != null) skin.skeleton = remap.get(skin.skeleton) ?? skin.skeleton;
  }
  for (const anim of json.animations || []) {
    for (const ch of anim.channels || []) {
      if (ch.target && ch.target.node != null) ch.target.node = remap.get(ch.target.node) ?? ch.target.node;
    }
  }

  let text = JSON.stringify(json);
  while (text.length % 4) text += ' '; // chunks are 4-byte aligned, padded with spaces
  const jsonBytes = Buffer.from(text, 'utf8');
  const rest = buf.subarray(20 + jsonLen); // remaining chunks (BIN) unchanged
  const out = Buffer.alloc(20 + jsonBytes.length + rest.length);
  buf.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonBytes.copy(out, 20);
  rest.copy(out, 20 + jsonBytes.length);
  writeFileSync(path, out);
  console.log(`fixed ${path} (${nodes.length} → ${kept.length} nodes)`);
}
