'use strict';
// The audio-decision oracle, and the gate that keeps it renewable.
//
// tests/fixtures/audio-corpus.jsonl is JS-RECORDED evidence: the command stream
// public/display/audio/decide.js produces, recorded off the frozen golden traces
// and a set of scripted scenarios. docs/native-port/shared-cpp-plan.md P7 ports
// those decisions to C++, and the moment the JS goes the corpus can never be
// re-recorded — the one-way ratchet that already froze gen-roomflow-corpus.mjs
// and gen-grandprix-corpus.mjs. So this file holds two different lines:
//
//   1. RENEWABLE. The generator is re-run in-process and must reproduce the
//      committed bytes exactly. While this passes, the oracle can be re-derived
//      from committed inputs alone; when it starts failing, either the decisions
//      moved (re-record deliberately and say so) or an input rotted (fix it
//      NOW, while the JS still exists).
//   2. SELF-CONTAINED. Every scripted case carries its own input, so they are
//      replayed straight out of the corpus with no engine, no traces and no wasm
//      — the check a C++ port will run in the same shape.
//
// The trace half is not replayed here from recorded inputs on purpose: its input
// is the golden trace itself, and the generator re-derives it through the shipped
// wasm's C ABI with a per-frame snapshot-hash check, which is strictly stronger
// than trusting a copy of the world state committed beside the answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'tests/fixtures/audio-corpus.jsonl');
const GEN = path.join(ROOT, 'scripts/gen-audio-corpus.mjs');
const DECIDE = path.join(ROOT, 'public/display/audio/decide.js');
const ORACLE = path.join(ROOT, 'scripts/oracle-lib.mjs');

const committed = fs.readFileSync(CORPUS, 'utf8');
const lines = committed.split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const records = lines.slice(1).map((l) => JSON.parse(l));

test('the committed audio corpus re-derives from the golden traces + the live decision layer', async () => {
  const { buildCorpus } = await import(pathToFileURL(GEN).href);
  const { text } = await buildCorpus();
  if (text === committed) return;

  const a = committed.split('\n');
  const b = text.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const clip = (s) => (s === undefined ? '<missing>' : JSON.stringify(s.length > 240 ? s.slice(0, 240) + '…' : s));
  assert.fail(
    'tests/fixtures/audio-corpus.jsonl no longer reproduces.\n'
    + `  first difference at line ${i + 1}\n`
    + `    committed:   ${clip(a[i])}\n`
    + `    re-derived:  ${clip(b[i])}\n`
    + '  If the audio decisions changed on purpose: node scripts/gen-audio-corpus.mjs, and say so\n'
    + '  in the commit — this fixture is the ONLY cross-implementation evidence a C++ audio port\n'
    + '  will ever have, and it cannot be recorded once public/display/audio/decide.js is gone.',
  );
});

test('every scripted case replays back through the decision layer, byte for byte', async () => {
  const { AudioDecider } = await import(pathToFileURL(DECIDE).href);
  const { canonicalStringify, mulberry32 } = await import(pathToFileURL(ORACLE).href);
  const { applyStep } = await import(pathToFileURL(GEN).href);

  let dec = null;
  let name = null;
  let seen = 0;
  for (const rec of records) {
    if (rec.case === 'scenario') {
      name = rec.name;
      dec = new AudioDecider(rec.seed === null
        ? { rng: () => { throw new Error(`scenario '${name}' must not draw randomness`); } }
        : { rng: mulberry32(rec.seed) });
      continue;
    }
    if (rec.case !== 'scripted') continue;
    assert.ok(dec, 'a scripted step before its scenario line');
    assert.equal(rec.name, name, 'scripted steps must follow their own scenario line');
    const got = applyStep(dec, { kind: rec.kind, in: rec.in });
    assert.equal(
      canonicalStringify(got), canonicalStringify(rec.cmds),
      `${rec.name} step ${rec.step} (${rec.kind}): the decision layer no longer emits what was recorded\n`
      + `  input: ${canonicalStringify(rec.in)}`,
    );
    seen++;
  }
  assert.equal(seen, header.scriptedSteps, 'every scripted step was replayed');
});

// A corpus that stopped covering something is a gate that cannot fail. These are
// the coverage claims the two tests above rest on; they are asserted rather than
// assumed because trimming the generator would otherwise pass silently.
test('the corpus still covers every command kind the decisions can emit', () => {
  const kinds = new Set();
  let traceFrames = 0;
  const splits = new Set();
  for (const rec of records) {
    if (rec.case === 'trace') { traceFrames++; splits.add(rec.split); }
    for (const c of (rec.cmds || [])) {
      if (c.cue !== undefined) kinds.add(`cue:${c.cue}${c.part ? '/' + c.part : ''}`);
      else if (c.voice !== undefined) kinds.add(`voice:${c.voice}${c.stop ? '/stop' : ''}`);
      else if (c.voices !== undefined) kinds.add(`voices:${c.voices}`);
      else if (c.music !== undefined) kinds.add(`music:${c.music}`);
      else assert.fail(`unrecognised command in the corpus: ${JSON.stringify(c)}`);
    }
  }
  const required = [
    // one-shots: the whole event table plus the two HUD narrations
    'cue:pickup', 'cue:roulette', 'cue:banana_drop', 'cue:banana_slip',
    'cue:monster_inflate', 'cue:monster_deflate', 'cue:rocket_hit', 'cue:screech',
    'cue:lap', 'cue:join', 'cue:countdown/tick', 'cue:countdown/go',
    // sustained voices, each with a recorded stop (the falling edge is a decision)
    'voice:boost', 'voice:boost/stop', 'voice:corner', 'voice:corner/stop',
    'voice:brake', 'voice:brake/stop', 'voice:engine_putt', 'voice:engine_putt/stop',
    'voice:rocket_fire', 'voice:rocket_fire/stop',
    // lifecycle + music
    'voices:stop-all', 'voices:stop-car',
    'music:start', 'music:stop', 'music:pause', 'music:resume',
  ];
  for (const k of required) assert.ok(kinds.has(k), `the corpus no longer records ${k}`);

  assert.equal(traceFrames, header.traceFrames, 'trace frame count matches the header');
  assert.ok(traceFrames > 3000, `only ${traceFrames} recorded trace frames`);
  for (const s of ['none', 'first', 'firstTwo']) {
    assert.ok(splits.has(s), `no trace is recorded under the '${s}' AI/human split`);
  }
  // The monster-truck engine timbre is the one command that carries a modifier —
  // it rides on a voice level, so a dropped `mod` would be invisible otherwise.
  const withMod = records.some((r) => (r.cmds || []).some((c) => c.mod));
  assert.ok(withMod, 'the corpus no longer records the monster-truck engine modifier');
});

test('the decision layer stays dependency-free, so Node and C++ can both read it', () => {
  const src = fs.readFileSync(DECIDE, 'utf8');
  const imports = src.match(/^\s*import\s.+$/gm) || [];
  assert.deepEqual(imports, [], 'audio/decide.js must import nothing (CLAUDE.md: modules Node loads directly stay dependency-free)');
  // Comments name several of these while explaining why they are absent, so scan
  // the code only.
  const code = src.replace(/\/\/.*$/gm, '');
  for (const forbidden of ['window.', 'document.', 'localStorage', 'performance.now', 'AudioContext', 'Date.now']) {
    assert.ok(!code.includes(forbidden), `audio/decide.js must not reach for ${forbidden} — the clock and the RNG are injected`);
  }
  // Math.random appears EXACTLY once, as the injectable default: the shipped path
  // keeps drawing from it, and the corpus pins the music shuffle by passing a
  // seeded stream instead. A second use would be unrecordable randomness.
  const rand = code.match(/Math\.random/g) || [];
  assert.equal(rand.length, 1, 'Math.random must appear once, as the constructor default');
  assert.match(code, /this\.rng = opts\.rng \|\| Math\.random;/, 'the RNG default must stay injectable');
});

// The corpus is only cross-implementation evidence if a C++ port can actually
// reach the recorded numbers. docs/native-port/fp-profile.md §2: V8's
// sin/cos/atan2/exp/pow/hypot are IMPLEMENTATION-APPROXIMATED — they differ in the
// last bit from the fdlibm both sides vendor, and across V8 versions and CPUs. The
// sim keeps off them by routing through the mathlib; decide.js cannot, because it
// is deliberately import-free, so its only safe option is to not need them.
//
// This gate is retrospective. decide.js shipped with `Math.hypot` in the distance
// metric and `10 ** x` in the music trim, and BOTH reached recorded gains: 28 of
// the corpus's distances and 2 of its 23 song trims were values no port could have
// matched. `Math.sqrt` is the exception the profile grants (IEEE-754 requires it
// correctly rounded, so it is bit-identical everywhere) and is what the distance
// metric uses now; the trims are authored literals.
test('the decision layer computes nothing a C++ port cannot reproduce to the bit', () => {
  const code = fs.readFileSync(DECIDE, 'utf8').replace(/\/\/.*$/gm, '');
  // The six fp-profile §2 transcendentals, plus the operator form of pow.
  for (const fn of ['sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'pow', 'hypot', 'log', 'log2', 'log10', 'cbrt']) {
    assert.ok(!new RegExp(`Math\\.${fn}\\s*\\(`).test(code),
      `audio/decide.js must not call Math.${fn} — it is implementation-approximated (fp-profile.md §2), `
      + 'and every number this file computes is recorded as cross-implementation evidence. '
      + 'Math.sqrt is the correctly-rounded exception; constants belong in the table as literals.');
  }
  assert.ok(!/\*\*/.test(code),
    'audio/decide.js must not use `**` — it is V8 pow by another name. The music trims are baked '
    + 'literals for exactly this reason (tests/credits.test.js re-checks them against their LUFS).');
});
