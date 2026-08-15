// The screenshot gallery's manifest, read and written by both capture scripts
// and read by tests/shots-manifest.test.js and the browser page.
//
// public/assets/shots/ deliberately, not public/shots/: the Dockerfile gives
// public/assets its OWN COPY layer above every code copy, so a re-frozen gallery
// does not re-push the image on an unrelated edit — the same reasoning that took
// the preview deploy from 973 MB to 216 MB.

import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_REL = 'public/assets/shots/manifest.json';

export function shotDir(root, platform) {
  return path.join(root, 'public/assets/shots', platform);
}

export function manifestPath(root) {
  return path.join(root, MANIFEST_REL);
}

export function readManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
  } catch {
    return { generated: 'scripts/capture-shots.mjs + capture-shots-tvos.mjs', shots: [] };
  }
}

export function writeManifest(root, manifest) {
  // Sorted by scenario then platform so a re-capture of one platform produces a
  // readable diff instead of shuffling the file.
  const shots = [...manifest.shots].sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.platform.localeCompare(b.platform)
  );
  const out = { ...manifest, shots };
  fs.mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
  fs.writeFileSync(manifestPath(root), JSON.stringify(out, null, 2) + '\n');
}
