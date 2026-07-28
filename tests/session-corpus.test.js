'use strict';
// The session-model oracle, and the gate that keeps it renewable.
//
// tests/fixtures/session-corpus.jsonl is JS-RECORDED evidence: the answers
// public/display/sessionModel.js gives, recorded over scripted room arcs before
// the policy moved to C++ (native/libttp-party/ttp/session.h). The moment that
// JS goes, the corpus can never be re-recorded — the one-way ratchet that
// already froze gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs. So this
// file holds three lines:
//
//   1. RENEWABLE. The generator is re-run in-process and must reproduce the
//      committed bytes exactly. While this passes, the oracle can be re-derived
//      from committed inputs alone (there is exactly one: sessionModel.js);
//      when it starts failing, either the model moved (re-record deliberately
//      and say so) or an input rotted (fix it NOW, while the JS still exists).
//   2. SELF-CONTAINED. Every step carries its own fully resolved input and the
//      heartbeat state it was recorded against, so the whole corpus replays out
//      of the file with no wasm, no relay and no DOM — which is exactly the
//      shape native/partytest/session_check.cc runs it in.
//   3. STILL COVERING. A corpus that stopped exercising a branch is a gate that
//      cannot fail, and this one exists mostly FOR the branches nothing else
//      covers (every SET_CAR/SET_READY rejection, the claim URL, the rejoinToken
//      quirk, the heartbeat's reconnect arm).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'tests/fixtures/session-corpus.jsonl');
const GEN = path.join(ROOT, 'scripts/gen-session-corpus.mjs');
const MODEL = path.join(ROOT, 'public/display/sessionModel.js');
const ORACLE = path.join(ROOT, 'scripts/oracle-lib.mjs');

const committed = fs.readFileSync(CORPUS, 'utf8');
const lines = committed.split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const records = lines.slice(1).map((l) => JSON.parse(l));

test('the committed session corpus re-derives from the live model', async () => {
  const { buildCorpus } = await import(pathToFileURL(GEN).href);
  const { text } = buildCorpus();
  if (text === committed) return;

  const a = committed.split('\n');
  const b = text.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const clip = (s) => (s === undefined ? '<missing>' : JSON.stringify(s.length > 300 ? s.slice(0, 300) + '…' : s));
  assert.fail(
    'tests/fixtures/session-corpus.jsonl no longer reproduces.\n'
    + `  first difference at line ${i + 1}\n`
    + `    committed:   ${clip(a[i])}\n`
    + `    re-derived:  ${clip(b[i])}\n`
    + '  If the session model changed on purpose: node scripts/gen-session-corpus.mjs, and say so\n'
    + '  in the commit — this fixture is the ONLY cross-implementation evidence the C++ port will\n'
    + '  ever have, and it cannot be recorded once public/display/sessionModel.js is gone.',
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
      st = newShellState();
      continue;
    }
    assert.ok(st, 'a step before its scenario line');
    assert.equal(rec.name, name, 'steps must follow their own scenario line');
    // The recorded input is already resolved, so a replay needs nothing threaded
    // in — which is the property the C++ check depends on.
    const out = applyOp(st, rec.in || {}, rec.op);
    assert.equal(
      canonicalStringify(out), canonicalStringify(rec.out),
      `${rec.name} step ${rec.step} (${rec.op}): the model no longer answers what was recorded\n`
      + `  input: ${canonicalStringify(rec.in)}`,
    );
    assert.equal(
      canonicalStringify(shellState(st)), canonicalStringify(rec.state),
      `${rec.name} step ${rec.step} (${rec.op}): the heartbeat state diverged after the step`,
    );
    seen++;
  }
  assert.equal(seen, header.steps, 'every recorded step was replayed');
});

test('the corpus still covers every decision the model can make', () => {
  const ops = new Set();
  const outcomes = new Set();
  let carAccepts = 0, carRejects = 0, readyAccepts = 0, readyRejects = 0;
  let lobbyTracks = 0, nonLobbyTracks = 0;

  for (const rec of records) {
    if (rec.case !== 'step') continue;
    ops.add(rec.op);
    const o = rec.out || {};
    if (o.action) outcomes.add(`${rec.op}:${o.action}`);
    if (o.route) outcomes.add(`route:${o.route}`);
    if (o.tick) outcomes.add(`hb:${o.tick.act}${o.tick.sweep ? '/sweep' : ''}`);
    if (rec.op === 'setCar') (o.accept ? carAccepts++ : carRejects++);
    if (rec.op === 'setReady') (o.accept ? readyAccepts++ : readyRejects++);
    if (rec.op === 'normIndex') outcomes.add(o.index === null ? 'norm:null' : 'norm:number');
    if (rec.op === 'claim') outcomes.add(o.plan.claim ? 'claim:yes' : 'claim:no');
    if (rec.op === 'addPeer') outcomes.add(o.plan.seat ? 'seat:new' : (o.plan.stamp ? 'seat:existing' : 'seat:full'));
    if (rec.op === 'template') outcomes.add(o.template === null ? 'template:none' : 'template:https');
    if (rec.op === 'claimUrl') outcomes.add(o.url.includes('#') ? 'claimUrl:fragment' : 'claimUrl:bare');
    if (rec.op === 'resync') {
      if (o.plan.expire.length) outcomes.add('resync:expire');
      if (o.plan.add.length) outcomes.add('resync:add');
    }
    if (rec.op === 'stateChange') {
      if (o.plan.restampConnected) outcomes.add('phase:restamp');
      if (o.plan.freeDisconnected) outcomes.add('phase:free');
      if (o.plan.clearStandings) outcomes.add('phase:clear');
    }
    if (rec.op === 'snapshot') {
      if (o.snapshot.tracks) lobbyTracks++;
      else nonLobbyTracks++;
    }
  }

  for (const op of ['roster', 'snapshot', 'joinUrl', 'claimUrl', 'template', 'normIndex',
    'seat', 'addPeer', 'presence', 'leave', 'card', 'route', 'action', 'setCar',
    'setReady', 'stateChange', 'hostChange', 'hb', 'claim', 'resync']) {
    assert.ok(ops.has(op), `the corpus no longer exercises the '${op}' op`);
  }

  const required = [
    // the presence fork, both ways, and the LEAVE fork's mid-race carve-out
    'presence:free', 'presence:drop', 'leave:expire', 'leave:drop',
    // the message routing table
    'route:peer', 'route:self-heartbeat', 'route:self-ignore',
    'action:hello', 'action:leave', 'action:set_car', 'action:set_ready',
    'action:select_mode', 'action:ping', 'action:game',
    // every arm of the heartbeat, including the one nothing else in the tree reaches
    'hb:idle', 'hb:send/sweep', 'hb:wait/sweep', 'hb:reconnect',
    // the frozen normalizer, answering both ways
    'norm:null', 'norm:number',
    // seat claiming
    'claim:yes', 'claim:no', 'seat:new', 'seat:existing', 'seat:full',
    // the URL rules
    'template:https', 'template:none', 'claimUrl:fragment', 'claimUrl:bare',
    // reconciliation, both halves
    'resync:expire', 'resync:add',
    // the phase-flip effects
    'phase:restamp', 'phase:free', 'phase:clear',
  ];
  for (const k of required) assert.ok(outcomes.has(k), `the corpus no longer records ${k}`);

  // The whole reason this corpus exists: wire-compat covers the ACCEPTED paths
  // of SET_CAR and SET_READY and nothing covered the rejections, so a port could
  // have dropped every guard and stayed green.
  assert.ok(carAccepts > 4, `only ${carAccepts} accepted SET_CAR cases`);
  assert.ok(carRejects > 20, `only ${carRejects} rejected SET_CAR cases`);
  assert.ok(readyAccepts > 4, `only ${readyAccepts} accepted SET_READY cases`);
  assert.ok(readyRejects > 20, `only ${readyRejects} rejected SET_READY cases`);
  // The tracks payload is lobby-only, and nothing about the other eleven keys
  // hints at it.
  assert.ok(lobbyTracks > 3 && nonLobbyTracks > 3,
    `the snapshot's lobby-only tracks gate needs both sides (${lobbyTracks}/${nonLobbyTracks})`);
});

test('the model stays dependency-free, so Node and C++ can both read it', () => {
  const src = fs.readFileSync(MODEL, 'utf8');
  const imports = src.match(/^\s*import\s.+$/gm) || [];
  assert.deepEqual(imports, [], 'sessionModel.js must import nothing (CLAUDE.md: modules Node loads directly stay dependency-free)');
  // Comments name several of these while explaining why they are absent, so scan
  // the code only.
  const code = src.replace(/\/\/.*$/gm, '');
  for (const forbidden of ['window.', 'document.', 'sessionStorage', 'localStorage',
    'performance.now', 'Date.now', 'Math.random', 'setInterval', 'setTimeout',
    'WebSocket', 'fetch(']) {
    assert.ok(!code.includes(forbidden),
      `sessionModel.js must not reach for ${forbidden} — the clock, the socket and the storage are the shell's`);
  }
});
