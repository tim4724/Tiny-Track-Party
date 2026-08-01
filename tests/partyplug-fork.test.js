'use strict';
// Fork tripwire for the partyplug kit.
//
// partyplug/ is a manual copy-fork (partyplug/UPSTREAM.md), so a local edit to a
// kit file is invisible until the next sync silently overwrites it. This test
// makes the edit loud instead: every kit source file is hashed in the ledger, and
// changing one fails here until the ledger says WHAT was changed and WHY. That
// note is the whole point — at sync time it is what separates "ours, keep it"
// from "theirs, take it".
//
// Only source is gated. README.md/package.json/UPSTREAM.md are forked wholesale
// and openly so; hashing them would charge every doc edit for nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KIT = path.join(__dirname, '..', 'partyplug');
const LEDGER = path.join(KIT, 'UPSTREAM.md');

const hashOf = (rel) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(KIT, rel))).digest('hex').slice(0, 16);

// Kit source as it sits on disk: the modules plus their types plus the kit's own
// suite. Discovered rather than listed, so a file ADDED to the fork is caught too.
function kitFiles() {
  const at = (dir) => fs.readdirSync(path.join(KIT, dir))
    .filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'))
    .map((f) => (dir ? `${dir}/${f}` : f));
  return [...at(''), ...at('tests')].sort();
}

// Ledger rows: | `file` | `hash` | note |
function ledgerRows() {
  const rows = new Map();
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{16})`\s*\|/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}

test('every partyplug source file is declared in the fork ledger', () => {
  const rows = ledgerRows();
  assert.ok(rows.size > 0, 'parsed no rows out of partyplug/UPSTREAM.md — did the table format change?');
  assert.deepEqual(kitFiles(), [...rows.keys()].sort(),
    'partyplug/UPSTREAM.md lists a different set of files than partyplug/ holds');
});

test('no partyplug source file has drifted since it was declared', () => {
  for (const [file, want] of ledgerRows()) {
    assert.equal(hashOf(file), want,
      `partyplug/${file} changed. If the edit is OURS, record what and why in the ledger and set its hash to ${hashOf(file)}. `
      + 'If it came from an upstream sync, update partyplug/UPSTREAM.md\'s "last synced from" too.');
  }
});
