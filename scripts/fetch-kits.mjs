#!/usr/bin/env node
// fetch-kits.mjs — put the Kenney kits on disk so the asset gallery's KIT
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
  },
  {
    id: 'pirate', label: 'Pirate Kit', version: '2.1',
    url: 'https://kenney.nl/media/pages/assets/pirate-kit/e6d4bb1525-1771333093/kenney_pirate-kit.zip',
    sha256: '667ed2caf92954ddb98f7b7cede831fe99ab75063c26b25e23d32715bee9c943',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    // The holiday kit's reason: a third palette under the same relative URI.
    colormap: 'Textures/pirate-colormap.png'
  },
  // Kits the decorations ship from (chosen in the kit browser's shortlists).
  // Each palette sits under a name of its own in public/assets/toycar/Textures.
  {
    id: 'survival', label: 'Survival Kit', version: '2.0',
    url: 'https://kenney.nl/media/pages/assets/survival-kit/4065a8185b-1712149243/kenney_survival-kit.zip',
    sha256: 'c3586341b5932c87eb43d75d915434f47daed168b17ed36a03e8ca9977c7443e',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: 'Textures/survival-colormap.png', palette: 'Models/GLB format/Textures/colormap.png'
  },
  {
    id: 'mini-forest', label: 'Mini Forest', version: '1.0',
    url: 'https://kenney.nl/media/pages/assets/mini-forest/44a89aed7f-1784024079/kenney_mini-forest_1.0.zip',
    sha256: '8691614018075a66458e35915b8c358c2e6178648aedadafcdf313b924aa6581',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: 'Textures/mini-forest-colormap.png', palette: 'Models/GLB format/Textures/colormap.png'
  },
  {
    id: 'mini-skate', label: 'Mini Skate', version: '2.0',
    url: 'https://kenney.nl/media/pages/assets/mini-skate/00b0c2b304-1791798670/kenney_mini-skate.zip',
    sha256: '0ded0e7f95cdc2c0513a41986fde49977e7d1f4fa8653b375a5c7e909ef9d74a',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: 'Textures/mini-skate-colormap.png', palette: 'Models/GLB format/Textures/colormap.png'
  },
  {
    id: 'city-roads', label: 'City Kit (Roads)', version: '2.2',
    url: 'https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1791628607/kenney_city-kit-roads.zip',
    sha256: '374a4552115cbd11b4ec5c930ee31a533562dc78a09af249a655d03f7ea3b959',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: 'Textures/city-roads-colormap.png', palette: 'Models/GLB format/Textures/colormap.png'
  },
  // CANDIDATES for dressing the tracks, browsed but not shipped from. Each
  // carries its own palette under the shared `Textures/colormap.png` name, so
  // each is re-pointed at a name of its own, and `palette` is that palette's
  // path in the zip: extract keeps it in the cache, where the dev server finds
  // it for the kit browser (server/index.js). Shipping a model from one of
  // these copies its palette into public/assets/toycar/Textures with it.
  {
    id: 'fantasy-town', label: 'Fantasy Town Kit', version: '2.0',
    url: 'https://kenney.nl/media/pages/assets/fantasy-town-kit/efe948d309-1754222374/kenney_fantasy-town-kit_2.0.zip',
    sha256: '1a7530c09f4d2fa2cdee259876f089334f8b1f27fa86a0c4f54ef86cdd8676ef',
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: 'Textures/town-colormap.png', palette: 'Models/GLB format/Textures/colormap.png'
  },
  ...[
    ['watercraft', 'Watercraft Kit', '2.1', 'watercraft-kit/a335cfed49-1713519620/kenney_watercraft-pack.zip', 'cd1470c1cf441c7f46d0944ae6d0d897242365dc97677c5079b3238965d659f3'],
    ['food', 'Food Kit', '2.0', 'food-kit/83086fa91c-1719418518/kenney_food-kit.zip', 'cdad90853682499b94c9fda2f87678b24bfd8f3264e0ed323f6b6a27fd7c6f6f'],
    ['brick', 'Brick Kit', '1.0', 'brick-kit/46a22f3d08-1716981002/kenney_brick-kit.zip', 'b303d293c278fab713eed28395829b18513b171d2562f7f518c3355c2896861a'],
    ['minigolf', 'Minigolf Kit', '3.1', 'minigolf-kit/3ae60d8b01-1741163874/kenney_minigolf-kit.zip', '74b7bf5cf82bf8a5225319ade1284600c64f9482ae66f0ccf1f22d2212d5a952'],
    ['tower-defense', 'Tower Defense Kit', '2.1', 'tower-defense-kit/a402493eaa-1726471567/kenney_tower-defense-kit.zip', 'd4c887680b709218315e4e1c17ae18c160635dcdfc4199763eeba97c02c77f00'],
    ['city-suburban', 'City Kit (Suburban)', '2.0', 'city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', '5869c35cf30b1c87bdb2d197b6d325eebadd2ef08ea27f04797e8e08d77a9a39'],
    ['train', 'Train Kit', '1.1', 'train-kit/cf8521d625-1727040883/kenney_train-kit.zip', 'cf50d77e8cbacbf38dd50826d4bce5392db8e4f67373d3c4e583b0ed0e474475'],
    ['mini-characters', 'Mini Characters', '1.0', 'mini-characters/bfc7e272b4-1774770718/kenney_mini-characters.zip', '9e1d48e6d7b8479ebbe84df71eb5bd8e1b3f0da546dea641890dccc8a02d0999'],
    ['platformer', 'Platformer Kit', '4.1', 'platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', '899605d237367688c6b42e41fff2206c0fb8d626163158294556353f7baa7c1b'],
    ['graveyard', 'Graveyard Kit', '5.0', 'graveyard-kit/ba8d4b4517-1760691807/kenney_graveyard-kit_5.0.zip', '1a93613f2e5675f3310acf49ec9ef13ae7adeb756ac3b205bfb6cc9311a81062'],
    ['castle', 'Castle Kit', '2.0', 'castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', '921f3f73927bb23106cae34bc21d5ab4b033a9fc120475e96f714a406e3169df'],
    ['coaster', 'Coaster Kit', '1.0', 'coaster-kit/546fdc554f-1731487890/kenney_coaster-kit.zip', '7723d02e3ea822371e12e14722e72d572fdb0384c1379c1469e0598a371f5c7a'],
    ['car', 'Car Kit', '3.1', 'car-kit/1a312ec241-1775131960/kenney_car-kit.zip', 'fac7dacac5c7874348cf19729af3ef205f3d366493edaf0a827d93f4fdf3d0c4'],
    ['mini-market', 'Mini Market', '1.0', 'mini-market/463f38da51-1729865423/kenney_mini-market.zip', '6f2e69090e359204ace43e4c98dc3fb8639b75e423109672b5c890d194c45203'],
    ['cube-pets', 'Cube Pets', '1.0', 'cube-pets/44e58e945f-1774520254/kenney_cube-pets_1.0.zip', 'b3bdc99a2ec92c687b875718c5d01e9231d2711ed0e2845f295b474bb42a1283'],
    ['city-commercial', 'City Kit (Commercial)', '2.1', 'city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip', 'f8b09b081c2bb88bcc126e2dec1cb40fd0dad7e7e591b6c26aaefe96fb35276b'],
    ['marble', 'Marble Kit', '2.0', 'marble-kit/56fd69e5ed-1716385090/kenney_marble-kit.zip', '4a289fe77fa4e71b943fb9a0df828a7987e62f665083ea9237d0bd9acd0b6dcb'],
    ['mini-arcade', 'Mini Arcade', '1.2', 'mini-arcade/ece1e8f320-1721638600/kenney_mini-arcade.zip', '2acfe5cb44d392e834f77cf5488528c7cd45427cdf5fb941ce99856276158c19'],
  ].map(([id, label, version, page, sha256]) => ({
    id, label, version, sha256,
    url: `https://kenney.nl/media/pages/assets/${page}`,
    models: 'Models/GLB format/*.glb', previews: 'Previews/*.png',
    colormap: `Textures/${id}-colormap.png`, palette: 'Models/GLB format/Textures/colormap.png'
  })),
  // The two 2018 kits: untextured flat materials (Racing embeds a few images),
  // GLBs under "GLTF format", four compass previews per model like Nature.
  {
    id: 'furniture', label: 'Furniture Kit', version: '1.0',
    url: 'https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip',
    sha256: 'e67652d0932cee41683f74711c03d3e192a2af9979ef8e6b237711f5482d46b0',
    models: 'Models/GLTF format/*.glb', previews: 'Isometric/*_NE.png', previewSuffix: '_NE'
  },
  {
    id: 'racing', label: 'Racing Kit', version: '1.0',
    url: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip',
    sha256: '8a71ea16219315a01d00d5a90c4f6b5c090faddbc56d80ecf727e2b3b853c6c0',
    models: 'Models/GLTF format/*.glb', previews: 'Isometric/*_NE.png', previewSuffix: '_NE'
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
  // -j flattens the zip's folders, which is the whole point: the kits keep
  // their models under different paths and the browser wants one shape.
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
    // A kit can carry the odd untextured model (Marble does); it has no palette to re-point.
    const textured = [];
    for (const g of glbs) {
      const buf = await readFile(g);
      if (JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')).images?.length) textured.push(g);
    }
    await run('node', [path.join(ROOT, 'scripts/replace-glb-colormap.js'), kit.colormap, ...textured]);
  }
  if (kit.palette) {
    const tex = path.join(CACHE, 'textures');
    await mkdir(tex, { recursive: true });
    await run('unzip', ['-qoj', zip, kit.palette, '-d', tex]);
    await rename(path.join(tex, path.basename(kit.palette)), path.join(tex, path.basename(kit.colormap)));
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
  // Per KIT: one already in the index (and on disk) keeps its entry, so adding
  // a kit to the list extracts only that kit.
  const indexPath = path.join(CACHE, 'index.json');
  const prior = !FORCE && await exists(indexPath)
    ? JSON.parse(await readFile(indexPath, 'utf8')).kits : [];

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
    const cached = prior.find((k) => k.id === kit.id && k.version === kit.version);
    if (cached && await exists(path.join(CACHE, kit.id))) {
      index.kits.push(cached);
      console.log(`✓ ${kit.label} ${kit.version} (cached)`);
      continue;
    }
    const built = await extract(kit);
    index.kits.push(built);
    console.log(`✓ ${kit.label} ${kit.version} — ${built.models.length} models`);
  }

  if (VERIFY_ONLY) return;
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const total = index.kits.reduce((n, k) => n + k.models.length, 0);
  console.log(`\n${total} models in ${path.relative(ROOT, CACHE)}.`
    + '\nStand them up at /gallery-assets.html with "Kit field" ticked.');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
