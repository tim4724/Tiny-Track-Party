// A GATE WHOSE ANCHOR IS GONE CANNOT FAIL.
//
// Two dozen tests in this directory read a TV shell's source and assert
// something about it — that the mask is derived and never read off the wire,
// that the fast-forward burst freezes the field first, that the seat grid sends
// `connected`. Every one of them names its subject as a hard-coded path, and
// every one of them SKIPS when that path is missing:
//
//     if (!existsSync(full)) return;                       // or
//     assert.ok(file.startsWith('shells/'), 'not an optional shell');
//
// The skip is there on purpose — a checkout that carries no shell has nothing to
// check, and the alternative is a suite that cannot run without one. What it
// cannot tell apart is the other case: a file that was RENAMED or MOVED. The
// gates then all pass, in silence, having read nothing, and the whole tvOS half
// of the suite becomes decoration on the next refactor that tidies a directory.
//
// So this is the anchor check, exactly as `tests/wire-mutation-anchors.test.js`
// is for the wire mutations: every `shells/...` path any test names must exist.
// A rename fails HERE, once, naming the gates that need re-pointing, instead of
// quietly turning them all green.
//
// It is deliberately not clever. It reads string literals, not requires: a test
// that composes a path from parts is invisible to it, and the answer to that is
// to write the path as a literal like every other one does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// A path literal, not prose: several gates put `shells/tvos ...` in an assertion
// MESSAGE, and a message is not an anchor. Whitespace is the whole tell.
const LITERAL = /['"](shells\/[^'"\s]*)['"]/g;

/** Every `shells/...` path literal in the suite, with the test that names it. */
function anchors() {
  const found = new Map();
  for (const entry of readdirSync(__dirname)) {
    if (!entry.endsWith('.test.js')) continue;
    const src = readFileSync(path.join(__dirname, entry), 'utf8');
    for (const m of src.matchAll(LITERAL)) {
      // `shells/` and `shells/tvos` alone are directory roots a walker joins
      // onto — they anchor nothing on their own.
      const rel = m[1].replace(/\/$/, '');
      if (rel.split('/').length < 2) continue;
      if (!found.has(rel)) found.set(rel, new Set());
      found.get(rel).add(entry);
    }
  }
  return found;
}

test('the suite names shell paths at all', () => {
  // If this ever reads zero, the regex above has stopped matching and every
  // assertion below became vacuously true.
  assert.ok(anchors().size > 10, 'no shell path literals found — has the pattern rotted?');
});

test('every shell path a gate names still exists', () => {
  const missing = [];
  for (const [rel, tests] of anchors()) {
    if (existsSync(path.join(ROOT, rel))) continue;
    missing.push(`${rel}  (named by ${[...tests].sort().join(', ')})`);
  }
  assert.deepEqual(missing, [],
    'these gates read a file that is not there, so they skip rather than fail — '
    + 're-point them at wherever the code moved:\n  ' + missing.join('\n  '));
});
