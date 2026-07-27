'use strict';
// The UI-model oracle, and the gate that keeps it renewable.
//
// tests/fixtures/ui-corpus.jsonl is JS-RECORDED evidence: the answers
// public/display/uiModel.js gives, recorded over scripted room+race scenarios.
// docs/native-port/shared-cpp-plan.md P8 ports that model to C++, and the moment
// the JS goes the corpus can never be re-recorded — the one-way ratchet that
// already froze gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs. So this
// file holds two different lines:
//
//   1. RENEWABLE. The generator is re-run in-process and must reproduce the
//      committed bytes exactly. While this passes, the oracle can be re-derived
//      from committed inputs alone (there is exactly one: uiModel.js itself);
//      when it starts failing, either the model moved (re-record deliberately
//      and say so) or an input rotted (fix it NOW, while the JS still exists).
//   2. SELF-CONTAINED. Every step carries its own input and the shell state it
//      was recorded against, so the whole corpus replays out of the file with no
//      wasm, no relay and no DOM — the check a C++ port will run in the same
//      shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'tests/fixtures/ui-corpus.jsonl');
const GEN = path.join(ROOT, 'scripts/gen-ui-corpus.mjs');
const MODEL = path.join(ROOT, 'public/display/uiModel.js');
const ORACLE = path.join(ROOT, 'scripts/oracle-lib.mjs');

const committed = fs.readFileSync(CORPUS, 'utf8');
const lines = committed.split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const records = lines.slice(1).map((l) => JSON.parse(l));

test('the committed UI corpus re-derives from the live model', async () => {
  const { buildCorpus } = await import(pathToFileURL(GEN).href);
  const { text } = buildCorpus();
  if (text === committed) return;

  const a = committed.split('\n');
  const b = text.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const clip = (s) => (s === undefined ? '<missing>' : JSON.stringify(s.length > 300 ? s.slice(0, 300) + '…' : s));
  assert.fail(
    'tests/fixtures/ui-corpus.jsonl no longer reproduces.\n'
    + `  first difference at line ${i + 1}\n`
    + `    committed:   ${clip(a[i])}\n`
    + `    re-derived:  ${clip(b[i])}\n`
    + '  If the UI model changed on purpose: node scripts/gen-ui-corpus.mjs, and say so in the\n'
    + '  commit — this fixture is the ONLY cross-implementation evidence a C++ UI-model port\n'
    + '  will ever have, and it cannot be recorded once public/display/uiModel.js is gone.',
  );
});

test('every recorded step replays back through the model, byte for byte', async () => {
  const { canonicalStringify } = await import(pathToFileURL(ORACLE).href);
  const { applyOp, newShellState, shellState } = await import(pathToFileURL(GEN).href);

  let st = null;
  let name = null;
  let seen = 0;
  for (const rec of records) {
    if (rec.case === 'scenario') {
      name = rec.name;
      st = newShellState(rec.screen);
      continue;
    }
    assert.ok(st, 'a step before its scenario line');
    assert.equal(rec.name, name, 'steps must follow their own scenario line');
    const out = applyOp(st, { op: rec.op, ...(rec.in || {}) });
    assert.equal(
      canonicalStringify(out), canonicalStringify(rec.out),
      `${rec.name} step ${rec.step} (${rec.op}): the model no longer answers what was recorded\n`
      + `  input: ${canonicalStringify(rec.in)}`,
    );
    // The shell state the model feeds back into (screen, cards on screen, what
    // each phone was last told) is recorded too — a model that answers right but
    // threads wrong is still broken.
    assert.equal(
      canonicalStringify(shellState(st)), canonicalStringify(rec.state),
      `${rec.name} step ${rec.step} (${rec.op}): the shell state diverged after the step`,
    );
    seen++;
  }
  assert.equal(seen, header.steps, 'every recorded step was replayed');
});

// A corpus that stopped covering something is a gate that cannot fail. These are
// the coverage claims the two tests above rest on; they are asserted rather than
// assumed because trimming the generator would otherwise pass silently.
test('the corpus still covers every decision the model can make', () => {
  const ops = new Set();
  const outcomes = new Set();
  let boards = 0;
  let podiums = 0;
  let joiningRows = 0;
  let cupSortedBoards = 0;
  for (const rec of records) {
    if (rec.case !== 'step') continue;
    ops.add(rec.op);
    const o = rec.out || {};
    if (o.nav) outcomes.add(`nav:${o.nav}`);
    if (o.effect) outcomes.add(`back:${o.effect}`);
    if (o.move) outcomes.add(`freeze:${o.move}`);
    if (o.decision) outcomes.add(`autopause:${o.decision.action}${o.decision.asked ? '/asked' : ''}`);
    if (o.slot) outcomes.add(`slot:${o.slot.nameKey}/${o.slot.racesKey}`);
    if (rec.op === 'pick' && !o.slot) outcomes.add('slot:none');
    if (o.pushes && o.pushes.length) outcomes.add('item:push');
    if (o.rows && o.rows.some((r) => r.finished)) outcomes.add('hud:finished');
    if (o.forfeit && o.forfeit.length) outcomes.add('flow:forfeit');
    if (o.allDone === true) outcomes.add('flow:all-done');
    if (o.remove && o.remove.length) outcomes.add('reconnect:remove');
    if (o.add && o.add.length) outcomes.add('reconnect:add');
    if (o.board) {
      boards++;
      if (o.board.series) cupSortedBoards++;
      joiningRows += o.board.order.filter((r) => r.joining).length;
    }
    if (o.view) {
      outcomes.add(`title:${o.view.titleKey}`);
      outcomes.add(`newgame:${o.view.newGameKey}`);
      if (o.view.sub) outcomes.add(`sub:${o.view.sub.key}`);
      if (o.view.podium) podiums++;
      for (const r of o.view.listRows) outcomes.add(`row:${r.kind}`);
    }
  }

  for (const op of ['show', 'back', 'roster', 'pick', 'reconnect', 'hud', 'clearItems',
    'welcomeItem', 'flow', 'autopause', 'freeze', 'board', 'intermission']) {
    assert.ok(ops.has(op), `the corpus no longer exercises the '${op}' op`);
  }
  const required = [
    // screens + the back-effect table
    'nav:push', 'nav:pop', 'nav:none', 'back:swallow', 'back:end-party', 'back:return-to-lobby',
    // the lobby's race card, in every state it has
    'slot:none', 'slot:cup/count', 'slot:track/one', 'slot:random/endless',
    // the racing HUD
    'item:push', 'hud:finished',
    // race flow + reconnect cards
    'flow:all-done', 'flow:forfeit', 'reconnect:add', 'reconnect:remove',
    // pause arbitration, including the branch that reads the party layer
    'autopause:none', 'autopause:return-to-lobby', 'autopause:set', 'autopause:set/asked',
    'freeze:freeze', 'freeze:thaw', 'freeze:none',
    // the results overlay in all three dressings, and every row kind
    'title:results', 'title:standings', 'title:cup_champs',
    'sub:cup_race', 'sub:cup_race_of', 'newgame:next_race', 'newgame:new_game',
    'row:time', 'row:points', 'row:joining',
  ];
  for (const k of required) assert.ok(outcomes.has(k), `the corpus no longer records ${k}`);

  assert.ok(boards > 40, `only ${boards} recorded standings boards`);
  assert.ok(cupSortedBoards > 20, `only ${cupSortedBoards} recorded CUP boards`);
  assert.ok(podiums >= 5, `only ${podiums} recorded podium boards`);
  assert.ok(joiningRows > 10, `only ${joiningRows} recorded late-joiner rows`);
});

test('the model stays dependency-free, so Node and C++ can both read it', () => {
  const src = fs.readFileSync(MODEL, 'utf8');
  const imports = src.match(/^\s*import\s.+$/gm) || [];
  assert.deepEqual(imports, [], 'uiModel.js must import nothing (CLAUDE.md: modules Node loads directly stay dependency-free)');
  // Comments name several of these while explaining why they are absent, so scan
  // the code only.
  const code = src.replace(/\/\/.*$/gm, '');
  for (const forbidden of ['window.', 'document.', 'localStorage', 'performance.now',
    'Date.now', 'Math.random', 'history.', 'requestAnimationFrame']) {
    assert.ok(!code.includes(forbidden),
      `uiModel.js must not reach for ${forbidden} — the clock, the DOM and the history stack are the shell's`);
  }
});
