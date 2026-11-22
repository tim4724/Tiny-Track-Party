// Gives every file of a tree the time its CONTENT first went up, so the upload
// (hetzner-deploy.yml) sends only what changed:
//   node scripts/deploy-mtimes.mjs <dir> <previous manifest>
//
// A fresh checkout stamps every file with now. lftp's mirror then re-sends
// all of them, and each gets a new Last-Modified, which is what browsers
// revalidate the assets by: every deploy made every visitor fetch the whole
// soundtrack again.
//
// The manifest, <dir>/.deploy.json, maps each file to [sha256, mtime] and is
// uploaded with the tree (a dotfile, which .htaccess never serves). The next
// deploy downloads it and passes it here. A file whose hash is in it keeps
// that mtime, so mirror sees the server's copy as current and skips it. A new
// or changed file gets now, which is always later than what the server has:
// mirror skips a file that is the same size and OLDER than the server's, so a
// time that could go backwards (a commit date, say) would leave a changed
// file behind. With no previous manifest everything is new and goes up once.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, previousFile] = process.argv.slice(2);
const MANIFEST = '.deploy.json';

let previous = {};
try { previous = JSON.parse(fs.readFileSync(previousFile, 'utf8')); } catch { /* first deploy */ }

const now = Math.floor(Date.now() / 1000);
const manifest = {};
let changed = 0;
for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const rel = path.relative(dir, file).split(path.sep).join('/');
  if (rel === MANIFEST) continue;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const known = previous[rel];
  const same = Array.isArray(known) && known[0] === hash && Number.isInteger(known[1]);
  const mtime = same ? known[1] : now;
  if (!same) changed++;
  fs.utimesSync(file, mtime, mtime);
  manifest[rel] = [hash, mtime];
}
fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest));

console.log(`deploy-mtimes: ${changed} of ${Object.keys(manifest).length} files are new or changed`);
