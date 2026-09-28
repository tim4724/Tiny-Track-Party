// A METHOD A SHELL DEFINES AND NEVER CALLS.
//
// Neither Swift nor Kotlin will tell you about this. An unused `private`
// function warns, but anything `internal` — the default, and what every method
// on `PartyNet`, `GameCoordinator` and `DisplayHost` is — can be written,
// documented, and called by nothing at all with a perfectly clean build.
//
// That is not hypothetical, and it happened in BOTH shells. `PartyNet.shutdown()`
// shipped complete: it sends `close_room`, waits for the FLUSH before closing the
// socket, drops the crash-recovery blob only on a confirmed flush, and carries a
// long comment explaining that "the app going away IS the party ending". Its doc
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
// walks a fixed list of types whose methods are all called from ELSEWHERE in the
// shell by design — the transport, the coordinator, the display host, the two
// performers they drive, and the perf monitor — and skips the families that are
// legitimately invoked by something other than a call site (protocol
// conformances, overrides, the UI framework's own entry points). A name is
// "used" if it appears anywhere outside its own declaration, which is
// deliberately generous: the goal is to catch ZERO call sites, not to audit how
// many there are.
//
// The perf monitor is in that list because it is exactly the shape of the bug:
// a debug surface whose show/record path a shell can simply never call, leaving
// a HUD that exists in the tree and cannot be seen on the device it was built
// for.
//
// Widening it past that list costs more than it pays: a whole-shell sweep on tvOS
// is mostly `makeBody`/`makeUIView` protocol requirements, and every one of them
// added to the skip set is a real name this can no longer see.
//
// ONE ALGORITHM, TWO LANGUAGES. The languages differ in the declaration spelling,
// the modifier keywords and which names the framework calls for you; nothing else
// about the audit changes, so those are the only things in the table below.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SHELLS = [
  {
    lang: 'Swift',
    dir: 'shells/tvos/TinyTrackParty',
    ext: '.swift',
    decl: /^\s*(?:@\w+\s+)*(?:public |internal |fileprivate |private )?(?:static |class |final )*func\s+(\w+)\s*[(<]/gm,
    // `private` is already covered by the compiler's own unused warning, and
    // including it here would flag helpers reached only via `self.` shorthand.
    priv: /\bprivate\s+(?:static\s+|class\s+|final\s+)*func\s/,
    self: (n) => new RegExp(`\\bfunc\\s+${n}\\s*[(<]`),
    // Invoked by something that is not a call site, so a zero-reference count
    // says nothing about them.
    framework: ['init', 'deinit', 'body',   // Swift / SwiftUI entry points
                'urlSession',                // URLSessionWebSocketDelegate
                'encode', 'decode', 'hash'], // protocol conformances
    audited: [
      'Net/PartyNet.swift', 'App/GameCoordinator.swift', 'Render/DisplayHost.swift',
      'App/RaceFlowPerformer.swift', 'App/LobbyDemo.swift', 'Render/PerfOverlay.swift'
    ]
  },
  {
    lang: 'Kotlin',
    dir: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack',
    ext: '.kt',
    decl: /^\s*(?:@\w+\s+)*(?:public |internal |protected )?(?:override |open |suspend |inline )*fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/gm,
    priv: /\bprivate\s+(?:inline\s+|suspend\s+)*fun\s/,
    self: (n) => new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?${n}\\s*\\(`),
    framework: ['run',      // Runnable, and Kotlin's own scope function
                'invoke',   // functional types
                'toString', 'equals', 'hashCode'],
    audited: [
      'PartyNet.kt', 'GameCoordinator.kt', 'DisplayHost.kt',
      'RaceFlowPerformer.kt', 'LobbyDemo.kt', 'PerfOverlay.kt', 'PerfDebug.kt'
    ]
  }
];

function sourcesUnder(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p, ext));
    else if (entry.endsWith(ext)) out.push(p);
  }
  return out;
}

// Comment lines are OUT of the use-counting corpus. `shutdown` is mentioned in
// several doc comments across each shell, so a corpus that read them would stay
// green with the one real call site deleted — the exact bug the header
// describes, invisible again because the prose still "uses" the name.
const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

for (const shell of SHELLS) {
  const dir = path.join(ROOT, shell.dir);

  test(`the ${shell.lang} shell has sources to audit`, () => {
    // Both shells are checked in, so an absent one is a broken checkout rather
    // than an optional extra — a silent return here would report coverage the
    // run never had.
    assert.ok(existsSync(dir), `no ${shell.lang} shell at ${shell.dir}`);
    const files = sourcesUnder(dir, shell.ext);
    assert.ok(files.length > 10,
      `only found ${files.length} ${shell.ext} files — has the tree moved?`);
    for (const rel of shell.audited) {
      assert.ok(files.some((f) => f.endsWith(rel)), `audited file missing: ${rel}`);
    }
  });

  test(`every method the ${shell.lang} shell's seams define is called by something`, () => {
    const files = sourcesUnder(dir, shell.ext);
    const corpus = files.map((f) => strip(readFileSync(f, 'utf8')));
    const skip = new Set(shell.framework);
    const orphans = [];

    for (const rel of shell.audited) {
      const src = strip(readFileSync(files.find((f) => f.endsWith(rel)), 'utf8'));

      for (const m of src.matchAll(shell.decl)) {
        const name = m[1];
        if (skip.has(name)) continue;
        if (shell.priv.test(m[0])) continue;
        if (/\boverride\b/.test(m[0])) continue;

        // Any mention outside the declaration line itself. Counting `name(`
        // alone would miss a method passed as a value (`onTick = tick`), which
        // is a real and legitimate way to be used.
        const self = shell.self(name);
        let uses = 0;
        for (const text of corpus) {
          for (const hit of text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
            const start = text.lastIndexOf('\n', hit.index) + 1;
            const end = text.indexOf('\n', hit.index);
            // The declaration itself is not a use of itself.
            if (self.test(text.slice(start, end === -1 ? undefined : end))) continue;
            uses++;
          }
        }

        if (uses === 0) orphans.push(`${rel}: ${name}()`);
      }
    }

    assert.deepEqual(orphans, [],
      `defined and never called — ${shell.lang} will not warn about an unused `
      + 'internal method, and a teardown nothing invokes reads as implemented:\n  '
      + orphans.join('\n  '));
  });
}
