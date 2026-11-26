'use strict';
// partyplug/ is a VERBATIM copy of upstream's (docs/partyplug.md): nothing in it
// is edited here. This computes the folder's git tree id from the files on disk,
// exactly as git does, and holds it to the id docs/partyplug.md records — which
// is upstream's own `git rev-parse <commit>:partyplug`. So one number proves the
// copy byte-identical to upstream at that commit, and any local edit, added or
// missing file fails here instead of reaching the next sync as an unexplained
// diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'partyplug');
const DOC = path.join(ROOT, 'docs', 'partyplug.md');

const sha1 = (type, body) =>
  crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();

// Git's tree object: entries sorted by name (a directory sorts as `name/`), each
// `<mode> <name>\0<20-byte id>`. Dotfiles are skipped: upstream has none, and a
// stray .DS_Store must not fail a clean copy.
function treeId(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return { name: e.name, key: `${e.name}/`, mode: '40000', id: treeId(full) };
      const exec = fs.statSync(full).mode & 0o111;
      return { name: e.name, key: e.name, mode: exec ? '100755' : '100644', id: sha1('blob', fs.readFileSync(full)) };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha1('tree', Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), e.id])));
}

test('partyplug/ is byte-identical to upstream at the recorded commit', () => {
  const m = /\*\*Synced to:\*\* `([0-9a-f]{7,})`.*tree `([0-9a-f]{40})`/.exec(fs.readFileSync(DOC, 'utf8'));
  assert.ok(m, 'could not read the commit + tree id out of docs/partyplug.md — did its header format change?');
  assert.equal(treeId(KIT).toString('hex'), m[2],
    `partyplug/ is not upstream's partyplug/ at ${m[1]}. The kit is never edited here: make the change `
    + 'upstream, land it, then copy the folder back whole (docs/partyplug.md, "Syncing").');
});
