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

import { STORE_SHOT } from '../../public/shared/galleryScenarios.js';

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
    return { generated: 'scripts/capture-shots{,-tvos,-androidtv}.mjs', shots: [] };
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
  const fresh = new Map(entries.map((e) => [e.scenario, e]));
  const replaced = manifest.shots.filter((s) => s.platform === platform && fresh.has(s.scenario));
  // A card that became a store card (or stopped being one) changes extension, so
  // the file it replaces is not overwritten and would be left orphaned.
  for (const old of replaced) {
    if (old.file !== fresh.get(old.scenario).file) {
      fs.rmSync(path.join(root, 'public/assets/shots', old.file), { force: true });
    }
  }
  const keep = manifest.shots.filter((s) => !replaced.includes(s));
  writeManifest(root, { ...manifest, shots: [...keep, ...entries] });
}

/** The shot's filename: a store card is STORE_SHOT's format, everything else WebP. */
export function shotFile(scenario) {
  return `${scenario.id}.${scenario.store ? STORE_SHOT.ext : 'webp'}`;
}

/**
 * Encode one exported PNG from a device leg into the platform's directory, and
 * return the manifest fields that describe the file.
 *
 * Gallery cards go to WebP at `width` (aspect kept); store cards go to STORE_SHOT
 * exactly, because the stores check the pixel size.
 */
export function writeShot(root, platform, scenario, src, width) {
  const file = shotFile(scenario);
  const dest = path.join(shotDir(root, platform), file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (scenario.store) {
    toJpeg(src, dest, STORE_SHOT.w, STORE_SHOT.h);
  } else {
    toWebp(src, dest, width);
  }
  return {
    file: `${platform}/${file}`,
    w: scenario.store ? STORE_SHOT.w : width,
    h: scenario.store ? STORE_SHOT.h : Math.round((width * 1080) / 1920),
    bytes: fs.statSync(dest).size
  };
}

/**
 * Resize one PNG to exactly w x h and write it as JPEG q90.
 *
 * `sips` ships with macOS and CAN write JPEG (unlike WebP, see below); Pillow is
 * the fallback for a machine without it.
 */
function toJpeg(src, dest, w, h) {
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const attempts = [
    () => run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90',
      '-z', String(h), String(w), src, '--out', dest]),
    () => run('python3', ['-c',
      'import sys;from PIL import Image;' +
      'i=Image.open(sys.argv[1]).convert("RGB");' +
      'i=i.resize((int(sys.argv[3]),int(sys.argv[4])),Image.LANCZOS);' +
      'i.save(sys.argv[2],"JPEG",quality=90)',
      src, dest, String(w), String(h)])
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
  throw new Error('no JPEG encoder worked (sips, or python3 with Pillow)\n  ' + errors.join('\n  '));
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
 * Falling back to PNG is deliberately NOT an option: the whole table across three
 * platforms at 1080p PNG is tens of megabytes, which would undo the deliberate
 * 170 -> 87 MB asset work. Byte-exactness buys nothing here, because nothing diffs
 * these programmatically — this is a human-judgement surface.
 *
 * The web capture does NOT use this: Chromium already has an encoder and the bytes
 * come back over the CDP bridge, so that leg needs no tool on the machine at all.
 * Every leg that photographs a REAL DEVICE arrives holding a PNG and lands here.
 */
function toWebp(src, dest, width) {
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
