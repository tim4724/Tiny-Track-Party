// The screenshot gallery's manifest, read and written by both capture scripts
// and read by tests/shots-manifest.test.js and the browser page.
//
// public/assets/shots/ deliberately, not public/shots/: the Dockerfile gives
// public/assets its OWN COPY layer above every code copy, so a re-frozen gallery
// does not re-push the image on an unrelated edit — the same reasoning that took
// the preview deploy from 973 MB to 216 MB.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * Merge one platform's fresh rows into the manifest and write it.
 *
 * MERGE, NEVER REPLACE, and this exists because all three capture scripts were
 * about to hand-roll the same filter. `--only lobby` must not wipe the fifteen
 * scenarios this run did not shoot, and no capture may touch another platform's
 * rows at all — the columns are captured on different machines, hours apart.
 */
export function mergeShots(root, platform, entries) {
  const manifest = readManifest(root);
  const fresh = new Set(entries.map((e) => e.scenario));
  const keep = manifest.shots.filter((s) => !(s.platform === platform && fresh.has(s.scenario)));
  writeManifest(root, { ...manifest, shots: [...keep, ...entries] });
}

/** The short sha a capture stamps its rows with. 'unknown' outside a git tree. */
export function gitSha(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Resize and encode one exported PNG to WebP, in place of the source.
 *
 * Two attempts in order, because none of the four candidates is reliably present
 * and the two obvious ones are both wrong on a stock machine:
 *   - `sips` ships with macOS and resizes fine, but CANNOT WRITE WebP ("Can't
 *     write format: org.webmproject.webp") — it is not in `sips --formats`'
 *     writable list at all.
 *   - Homebrew's `ffmpeg` is commonly built without the libwebp encoder
 *     ("Default encoder for format webp is probably disabled").
 *   - `cwebp` is Google's own encoder and does both jobs in one call; Pillow is
 *     the fallback for a machine that has Python imaging but not the webp package.
 *
 * Falling back to PNG is deliberately NOT an option: the whole table across four
 * platforms at 1080p PNG is tens of megabytes, which would undo the deliberate
 * 170 -> 87 MB asset work. Byte-exactness buys nothing here, because nothing diffs
 * these programmatically — this is a human-judgement surface.
 *
 * The web capture does NOT use this: Chromium already has an encoder and the bytes
 * come back over the CDP bridge, so that leg needs no tool on the machine at all.
 * Every leg that photographs a REAL DEVICE arrives holding a PNG and lands here.
 */
export function toWebp(src, dest, width) {
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const attempts = [
    // -resize W 0 preserves the aspect ratio.
    () => run('cwebp', ['-quiet', '-q', '80', '-resize', String(width), '0', src, '-o', dest]),
    () => run('python3', ['-c',
      'import sys;from PIL import Image;' +
      'i=Image.open(sys.argv[1]);' +
      'w=int(sys.argv[3]);' +
      'i=i.resize((w,round(i.height*w/i.width)),Image.LANCZOS);' +
      'i.save(sys.argv[2],"WEBP",quality=80)',
      src, dest, String(width)])
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      attempt();
      return;
    } catch (e) {
      errors.push(String(e.message).split('\n')[0]);
    }
  }
  throw new Error('no WebP encoder worked. Install one:  brew install webp\n  ' + errors.join('\n  '));
}
