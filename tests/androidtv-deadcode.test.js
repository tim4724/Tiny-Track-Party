// A METHOD THE SHELL DEFINES AND NEVER CALLS.
//
// Kotlin will not tell you about this. An unused `private` function warns, but
// anything `internal` — the default, and what every method on `PartyNet` and
// `GameCoordinator` is — can be written, documented, and called by nothing at all
// with a perfectly clean build.
//
// That is not hypothetical. The tvOS twin of `PartyNet.shutdown()` shipped
// complete: it sends `close_room`, waits for the flush before closing the socket,
// drops the crash-recovery blob only on a confirmed flush, and carries a long
// comment explaining that "the app going away IS the party ending". Its doc
// comment said it ran "on termination". Nothing called it. So every exit left the
// room alive until the relay's ~2 min hostless grace killed it, and a phone still
// holding that code got a terminal 4001 and showed "that race has ended" — while a
// freshly warmed QR sat on the television.
//
// The cost of the gap was that the FEATURE looked present in review. Reading
// either file convinces you the teardown is handled; only the absence of a call
// site says otherwise, and absence is what nobody greps for.
//
// WHAT THIS IS NOT. It is not a general dead-code pass and does not try to be: it
// walks a fixed list of types whose methods are all called from elsewhere in the
// shell by design (the transport and the coordinator), and skips the families that
// are legitimately invoked by something other than a Kotlin call — overrides,
// operators, and the framework's own entry points. A name is "used" if it appears
// anywhere outside its own declaration, which is deliberately generous: the goal is
// to catch ZERO call sites, not to audit how many there are.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack');

function kotlinFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...kotlinFiles(p));
    else if (entry.endsWith('.kt')) out.push(p);
  }
  return out;
}

// Files whose methods are the subject. Everything else in the shell is still
// SEARCHED for call sites — it is only the declarations that are scoped, so a
// screen calling `game.pauseRace()` counts wherever that screen lives.
const AUDITED = ['PartyNet.kt', 'GameCoordinator.kt'];

// Invoked by something that is not a Kotlin call site, so a zero-reference count
// says nothing about them.
const NOT_CALLED_BY_NAME = new Set([
  'run',            // Runnable, and Kotlin's own scope function
  'invoke',         // functional types
  'toString', 'equals', 'hashCode',
]);

test('the shell has Kotlin sources to audit', () => {
  assert.ok(existsSync(SHELL), `no Kotlin shell at ${SHELL}`);
  const files = kotlinFiles(SHELL);
  assert.ok(files.length > 10, `only found ${files.length} .kt files — has the tree moved?`);
  for (const rel of AUDITED) {
    assert.ok(files.some((f) => f.endsWith(rel)), `audited file missing: ${rel}`);
  }
});

test('every method the transport and coordinator define is called by something', () => {
  const files = kotlinFiles(SHELL);
  // Comment lines are OUT of the use-counting corpus. `shutdown` is mentioned in
  // several doc comments across the shell, so a corpus that read them would stay
  // green with the one real call site deleted — the exact bug the header
  // describes, invisible again because the prose still "uses" the name.
  const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const corpus = files.map((f) => strip(readFileSync(f, 'utf8')));

  const orphans = [];

  for (const rel of AUDITED) {
    const file = files.find((f) => f.endsWith(rel));
    const src = strip(readFileSync(file, 'utf8'));

    for (const m of src.matchAll(/^\s*(?:@\w+\s+)*(?:public |internal |protected )?(?:override |open |suspend |inline )*fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/gm)) {
      const name = m[1];
      if (NOT_CALLED_BY_NAME.has(name)) continue;
      // `private` is already covered by the compiler's own unused warning, and
      // including it here would flag helpers reached only from inside the class.
      if (/\bprivate\s+(?:inline\s+|suspend\s+)*fun\s/.test(m[0])) continue;
      if (/\boverride\b/.test(m[0])) continue;

      // Any mention outside the declaration line itself. Counting `name(` alone
      // would miss a method passed as a value (`onTick = ::tick`), which is a real
      // and legitimate way to be used.
      let uses = 0;
      for (const text of corpus) {
        for (const hit of text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
          const start = text.lastIndexOf('\n', hit.index) + 1;
          const end = text.indexOf('\n', hit.index);
          const line = text.slice(start, end === -1 ? undefined : end);
          // The declaration itself is not a use of itself.
          if (new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?${name}\\s*\\(`).test(line)) continue;
          uses++;
        }
      }

      if (uses === 0) orphans.push(`${rel}: ${name}()`);
    }
  }

  assert.deepEqual(orphans, [],
    'defined and never called — Kotlin will not warn about an unused internal ' +
    'method, and a teardown nothing invokes reads as implemented:\n  ' +
    orphans.join('\n  '));
});
