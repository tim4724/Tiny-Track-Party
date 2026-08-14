'use strict';
// Provenance guard for the 3D models: public/assets/toycar/SOURCES.json says
// which Kenney kit model each shipped .glb started as, and nothing can derive
// that (the files have been renamed and edited, and two are generated outright).
// Authored data with no gate rots on the first commit that adds a model, and it
// rots INVISIBLY — the asset gallery's kit browser would simply stop marking a
// model as already-in-the-game and offer it up again as a candidate.
//
// The kit ids, versions and URLs are guarded across the two places that name
// them: scripts/fetch-kits.mjs (what to download) and public/shared/credits.js
// (what the licenses page says we downloaded). A kit upgrade must move both.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOYCAR = path.join(ROOT, 'public/assets/toycar');
const SOURCES = JSON.parse(fs.readFileSync(path.join(TOYCAR, 'SOURCES.json'), 'utf8'));
const FETCHER = fs.readFileSync(path.join(ROOT, 'scripts/fetch-kits.mjs'), 'utf8');
// The kit cache is a local convenience, absent on a fresh worktree and in CI.
const KIT_INDEX = path.join(ROOT, '.cache/kenney-kits/index.json');
const noCache = fs.existsSync(KIT_INDEX) ? false : 'no kit cache — run `npm run fetch:kits`';

// Deliberately literal, like the other source-text tripwires in this suite: a
// reformat of the KITS table fails here loudly rather than matching nothing.
function fetcherKits() {
  const kits = [];
  const re = /id: '([\w-]+)', label: '([^']+)', version: '([\d.]+)',\s*\n\s*url: '([^']+)'/g;
  for (const m of FETCHER.matchAll(re)) kits.push({ id: m[1], label: m[2], version: m[3], url: m[4] });
  return kits;
}

let ASSET_CREDITS;
test.before(async () => { ({ ASSET_CREDITS } = await import('../public/shared/credits.js')); });

test('every shipped .glb declares where it came from, and nothing declares a file that is gone', () => {
  const onDisk = fs.readdirSync(TOYCAR).filter((f) => f.endsWith('.glb')).sort();
  assert.deepEqual(Object.keys(SOURCES.models).sort(), onDisk,
    'SOURCES.json must list exactly the .glb files beside it');
});

test('each entry names a kit model or the script that generates it', () => {
  const kitIds = new Set(fetcherKits().map((k) => k.id));
  assert.ok(kitIds.size, 'scraped the KITS table out of scripts/fetch-kits.mjs');
  for (const [file, src] of Object.entries(SOURCES.models)) {
    if (src.generated) {
      assert.ok(fs.existsSync(path.join(ROOT, src.generated)), `${file}: ${src.generated} is gone`);
      continue;
    }
    assert.ok(kitIds.has(src.kit), `${file}: unknown kit '${src.kit}'`);
    assert.ok(src.model, `${file}: names kit '${src.kit}' but no model in it`);
  }
});

test('the fetcher and the licenses page agree on the kits', () => {
  for (const kit of fetcherKits()) {
    const credit = ASSET_CREDITS.find((c) => c.url === kit.url.replace(/\/media\/pages\/assets\/([\w-]+)\/.*$/, '/assets/$1'));
    assert.ok(credit, `${kit.label}: no credit in shared/credits.js points at ${kit.id}`);
    assert.ok(credit.title.startsWith(`${kit.label} ${kit.version}`),
      `${kit.label}: fetcher says ${kit.version}, the licenses page says '${credit.title}'`);
  }
});

test('every declared kit model exists in the kits', { skip: noCache }, () => {
  const index = JSON.parse(fs.readFileSync(KIT_INDEX, 'utf8'));
  const models = new Set(index.kits.flatMap((k) => k.models.map((m) => `${k.id}/${m.name}`)));
  for (const [file, src] of Object.entries(SOURCES.models)) {
    if (src.generated) continue;
    assert.ok(models.has(`${src.kit}/${src.model}`), `${file}: ${src.kit}/${src.model} is not in that kit`);
  }
});
