#!/usr/bin/env node
// fetch-kits.mjs — put the three Kenney kits on disk so the asset gallery's KIT
// FIELD can stand every model in them, not just the ones the game draws.
//
// The game ships a HAND-PICKED handful of the kits' models under
// public/assets/toycar. Deciding what to add next means looking at all the
// others, and that is a browsing job rather than a checked-in one: the kits are
// CC0 and re-fetchable, so the reproducible source is a URL plus a hash, and the
// bytes are a cache. Same rule, and the same .cache/ home, as the race-music
// masters (scripts/fetch-music.mjs).
//
//   node scripts/fetch-kits.mjs            download + extract what the browser needs
//   node scripts/fetch-kits.mjs --verify   download + hash only, write nothing
//   node scripts/fetch-kits.mjs --force    re-extract even if the cache looks done
//
// Writes .cache/kenney-kits/ (gitignored AND dockerignored, so it never reaches
// an image): one previews/ PNG and one models/ GLB per model, plus the
// index.json the gallery reads. Every other format in the zips (fbx/obj/stl/dae,
// ~40 MB) is dropped — nothing here can read them. The GLBs go through the same
// repairs the shipped models did (see extract), so what the gallery stages is
// what the renderer can actually draw, and a model copied out of this cache into
// public/assets/toycar is already the file the repo wants.
//
// THE HASH IS ON THE ZIP. Kenney's download URLs carry a content hash and a
// timestamp, so a new kit version is a new URL: a mismatch means the bytes under
// a URL we still trust CHANGED, which is a provenance question, never something
// to fix by updating the hash. `version` below must stay in step with the kit
// versions credited in public/assets/toycar/KENNEY-License.txt.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache/kenney-kits');
const ZIPS = path.join(CACHE, 'zips');

// `previews` is a glob into the zip, and `previewSuffix` is what to strip off
// the extracted name so it lands beside the model it depicts. The nature kit
// renders four compass angles per model where the other two ship one shot, so
// take its north-east one: that is the same three-quarter view the others use.
const KITS = [
  {
    id: 'toy-car', label: 'Toy Car Kit', version: '1.2',
    url: 'https://kenney.nl/media/pages/assets/toy-car-kit/42e19cc426-1736346027/kenney_toy-car-kit.zip',
    sha256: '26c11bbb77102b8dd00cdaf7b2c7ab692416d750dd064de886d809acec346782',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png'
  },
  {
    id: 'nature', label: 'Nature Kit', version: '2.3',
    url: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip',
    sha256: 'fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d',
    models: 'Models/GLTF format/*.glb', previews: 'Isometric/*_NE.png', previewSuffix: '_NE'
  },
  {
    id: 'holiday', label: 'Holiday Kit', version: '1.0',
    url: 'https://kenney.nl/media/pages/assets/holiday-kit/3976a6496a-1733923970/kenney_holiday-kit.zip',
    sha256: 'fde4d514d7297388d98058e8933ff614e071886f7ce57f9aea4b00d7698dd769',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    // Its palette is NOT the toy-car one, but its models name it with the same
    // relative URI — so staged side by side, one of the two would wear the
    // other's colours. `colormap` re-points this kit at the second palette the
    // game already ships for the snow trees (they came from here), which is
    // also what a model copied out of this cache should reference.
    colormap: 'Textures/holiday-colormap.png'
  }
];

const argv = process.argv.slice(2);
const VERIFY_ONLY = argv.includes('--verify');
const FORCE = argv.includes('--force');

const exists = (p) => stat(p).then(() => true, () => false);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}\n${err.trim()}`)));
  });
}

// Download to a .part and rename on success, so an interrupted run never leaves
// a truncated file that the next run's cache check would happily accept.
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const part = `${dest}.part`;
  await writeFile(part, Buffer.from(await res.arrayBuffer()));
  await rename(part, dest);
}

// A GLB is a 12-byte header then length-prefixed chunks, JSON first. The one
// thing the field wants out of it up front is the TRIANGLE COUNT, which is most
// of what decides whether a model can be afforded; its size and where it stands
// are the renderer's answer, and are not knowable here.
function triangleCount(buf) {
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const accessors = json.accessors || [];
  let tris = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives) {
      if (prim.indices != null) tris += accessors[prim.indices].count / 3;
      else if (prim.attributes.POSITION != null) tris += accessors[prim.attributes.POSITION].count / 3;
    }
  }
  return Math.round(tris);
}

async function extract(kit) {
  const dir = path.join(CACHE, kit.id);
  const zip = path.join(ZIPS, path.basename(kit.url));
  await rm(dir, { recursive: true, force: true });
  // unzip -d makes ONE level of directory, so make both ends of the path first.
  await mkdir(path.join(dir, 'models'), { recursive: true });
  await mkdir(path.join(dir, 'previews'), { recursive: true });
  // -j flattens the zip's folders, which is the whole point: the three kits keep
  // their models under three different paths and the browser wants one shape.
  await run('unzip', ['-qoj', zip, kit.models, '-d', path.join(dir, 'models')]);
  await run('unzip', ['-qoj', zip, kit.previews, '-d', path.join(dir, 'previews')]);

  if (kit.previewSuffix) {
    for (const f of await readdir(path.join(dir, 'previews'))) {
      const stripped = f.replace(`${kit.previewSuffix}.png`, '.png');
      if (stripped !== f) await rename(path.join(dir, 'previews', f), path.join(dir, 'previews', stripped));
    }
  }

  // The SAME repair the shipped models went through, and for the same reason:
  // the Nature Kit exports a scene root that is also a wrapper node's child,
  // which cgltf rejects outright — gltfio answers "Unable to parse glTF file"
  // and the renderer draws nothing. Staging a candidate has to survive that, so
  // it is fixed once here rather than being a trap per model. Idempotent, so
  // the kits that do not need it are untouched.
  const glbs = (await readdir(path.join(dir, 'models')))
    .filter((f) => f.endsWith('.glb')).map((f) => path.join(dir, 'models', f));
  await run('node', [path.join(ROOT, 'scripts/fix-glb-scene-roots.mjs'), ...glbs]);
  if (kit.colormap) {
    await run('node', [path.join(ROOT, 'scripts/replace-glb-colormap.js'), kit.colormap, ...glbs]);
  }

  const previews = new Set(await readdir(path.join(dir, 'previews')));
  const models = [];
  for (const f of (await readdir(path.join(dir, 'models'))).sort()) {
    if (!f.endsWith('.glb')) continue;
    const name = f.slice(0, -4);
    if (!previews.has(`${name}.png`)) throw new Error(`${kit.id}: ${name} has no preview`);
    models.push({ name, tris: triangleCount(await readFile(path.join(dir, 'models', f))) });
  }
  return { id: kit.id, label: kit.label, version: kit.version, models };
}

async function main() {
  await mkdir(ZIPS, { recursive: true });
  const done = !FORCE && await exists(path.join(CACHE, 'index.json'));

  const index = { kits: [] };
  for (const kit of KITS) {
    const zip = path.join(ZIPS, path.basename(kit.url));
    if (!await exists(zip)) {
      process.stdout.write(`↓ ${kit.label} ${kit.version} … `);
      await download(kit.url, zip);
      console.log(mb((await stat(zip)).size));
    }
    const hash = createHash('sha256').update(await readFile(zip)).digest('hex');
    if (hash !== kit.sha256) {
      throw new Error(`${kit.label}: sha256 mismatch\n  expected ${kit.sha256}\n  got      ${hash}\n`
        + '  The bytes under a URL we trust changed. Check the kit version upstream '
        + 'before touching the hash.');
    }
    if (VERIFY_ONLY) { console.log(`✓ ${kit.label} ${kit.version}`); continue; }
    if (done) { console.log(`✓ ${kit.label} ${kit.version} (cached)`); continue; }
    const built = await extract(kit);
    index.kits.push(built);
    console.log(`✓ ${kit.label} ${kit.version} — ${built.models.length} models`);
  }

  if (VERIFY_ONLY || done) {
    if (done && !VERIFY_ONLY) {
      console.log(`\nAlready extracted in ${path.relative(ROOT, CACHE)} — --force re-extracts.`);
    }
    return;
  }
  await writeFile(path.join(CACHE, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const total = index.kits.reduce((n, k) => n + k.models.length, 0);
  console.log(`\n${total} models in ${path.relative(ROOT, CACHE)}.`
    + '\nStand them up at /gallery-assets.html with "Kit field" ticked.');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
