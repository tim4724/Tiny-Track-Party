'use strict';
// The item/hazard TRIGGER mechanics and the debug hooks the dev collision range
// leans on, exercised against the native sim through its C ABI (the wasm build of
// native/libttp-sim, loaded exactly as tests/runtime-abi.test.js does).
//
// WHAT MOVED, AND WHAT IS NO LONGER COVERED. This suite used to drive a pure-
// pursuit car around the dev-only Gym track (shared/devTracks.js) and poke the
// engine's internals directly. Neither is possible on the native engine:
//
//   * The ABI exposes no car teleport and no trigger poll, so a check cannot park
//     a car at a chosen (s, lat) and fire one trigger in isolation.
//
// So the portable half (the ?item= force hook, the monster transform, box respawn
// cooldowns, and oil/banana spin-outs) is re-expressed below as REAL races on
// catalogue tracks. One Gym-specific check is left explicitly skipped rather than
// quietly dropped; see the comment on it.
//
// The OTHER blocker is gone: gen-track-defs-header.mjs now carries DEV_TRACKS past
// the shipped catalogue, so ttp_session_begin('gym') resolves and ?solo&track=gym
// races again. The Gym check below is live.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');

const skip = fs.existsSync(MJS) && fs.existsSync(WASM)
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

// [car id, caution, laneBias] — the four AI_PERSONALITIES knob pairs from
// native/libttp-sim/ttp/ai_driver.cc, under the traces' cpu-<name> id convention.
const PERSONAS = [
  ['cpu-bolt', 1.05, -0.6], ['cpu-pixel', 1.00, 0.6],
  ['cpu-rusty', 0.97, -0.25], ['cpu-zippy', 0.94, 0.25]
];
const DT = 1000 / 60;

let _abi = null;
async function abi() {
  if (_abi) return _abi;
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const Module = await factory();
  const cw = (name, ret, args) => Module.cwrap(name, ret, args);
  _abi = {
    begin: cw('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
    addBot: cw('ttp_add_bot', 'void', ['number', 'string', 'number', 'number', 'number', 'string']),
    start: cw('ttp_session_start', 'void', ['number', 'number']),
    update: cw('ttp_update', 'void', ['number', 'number']),
    snapshot: cw('ttp_snapshot_json', 'string', ['number']),
    events: cw('ttp_events_json', 'string', ['number']),
    dispose: cw('ttp_dispose', 'void', ['number']),
  };
  return _abi;
}

// A full four-bot race, collecting the engine's race events and a per-frame digest
// of the item/hazard state. `forceItem` is the ?item= debug hook: non-null makes
// every box roll that item.
async function race(trackId, forceItem, frames = 3000) {
  const a = await abi();
  const h = a.begin(trackId, 42, 3, forceItem);
  assert.ok(h > 0, `ttp_session_begin('${trackId}') returned a handle`);
  for (const [id, caution, laneBias] of PERSONAS) a.addBot(h, JSON.stringify(id), caution, laneBias, 1, null);
  a.start(h, -1); // no countdown: racing from frame 0
  const events = [];
  const boxState = { everTaken: false, rearmed: false };
  const monster = { seen: false, halfLen: 0, halfWid: 0, baseHalfLen: 0, baseHalfWid: 0 };
  let maxBananas = 0;
  for (let i = 0; i < frames; i++) {
    a.update(h, DT);
    // Session beats are reconstructed with an underscore prefix; only race events
    // are the engine's own vocabulary.
    for (const e of JSON.parse(a.events(h))) if (!String(e.type).startsWith('_')) events.push(e);
    const snap = JSON.parse(a.snapshot(h));
    if (snap.boxes.some((b) => !b)) boxState.everTaken = true;
    if (boxState.everTaken && snap.boxes.every((b) => b)) boxState.rearmed = true;
    maxBananas = Math.max(maxBananas, snap.bananas.length);
    for (const c of snap.cars) {
      if (c.monster) {
        monster.seen = true;
        monster.halfLen = c.halfLen;
        monster.halfWid = c.halfWid;
      } else if (!monster.baseHalfLen) {
        monster.baseHalfLen = c.halfLen;
        monster.baseHalfWid = c.halfWid;
      }
    }
  }
  a.dispose(h);
  return { events, boxState, monster, maxBananas };
}

const typesOf = (events) => new Set(events.map((e) => e.type));
const pickupItems = (events) => new Set(events.filter((e) => e.type === 'pickup').map((e) => e.item));
const spinCauses = (events) => new Set(events.filter((e) => e.type === 'spin').map((e) => e.cause));

test('?item= forces every box roll, and is really overriding the roll table', { skip }, async () => {
  // Unforced, the roll table is weighted and situational: `monster` is the deep-
  // back-field catch-up item, so a clean four-bot race never rolls one. Forcing it
  // is therefore a visible change, not a coincidence — which is what makes this a
  // test of the hook rather than of the table.
  const free = pickupItems((await race('tidepool', null)).events);
  assert.ok(free.size >= 2, 'the unforced roll table yields more than one item');
  assert.ok(!free.has('monster'), 'sanity: monster does not roll naturally in a clean race');

  for (const item of ['boost', 'banana', 'rocket', 'monster']) {
    const forced = await race('tidepool', item, 1500);
    const items = pickupItems(forced.events);
    assert.ok(items.size >= 1, `?item=${item}: cars still picked boxes up`);
    assert.deepEqual([...items], [item], `?item=${item} makes every roll a ${item}`);
  }
});

test('a forced monster transforms the car, grows its footprint x1.3, and times out', { skip }, async () => {
  const r = await race('tidepool', 'monster');
  assert.ok(typesOf(r.events).has('pickup'), 'drove over an item box');
  assert.ok(r.monster.seen, 'the forced monster item actually transformed a car');
  assert.ok(r.monster.baseHalfLen > 0, 'sanity: saw an untransformed car to compare against');
  // MONSTER_FOOTPRINT: the collision box grows 1.3x while transformed (the body
  // checks other cars), and the snapshot carries the multiplied figure.
  assert.ok(Math.abs(r.monster.halfLen / r.monster.baseHalfLen - 1.3) < 1e-9,
    `monster halfLen should be 1.3x (${r.monster.halfLen} vs ${r.monster.baseHalfLen})`);
  assert.ok(Math.abs(r.monster.halfWid / r.monster.baseHalfWid - 1.3) < 1e-9,
    `monster halfWid should be 1.3x (${r.monster.halfWid} vs ${r.monster.baseHalfWid})`);
  assert.ok(typesOf(r.events).has('monster_end'), 'the transform expires and fires monster_end');
});

test('item boxes go dark on pickup and rearm after their cooldown', { skip }, async () => {
  const r = await race('tidepool', 'boost');
  assert.ok(r.boxState.everTaken, 'a picked box reads false in the snapshot (index-aligned with the authored list)');
  assert.ok(r.boxState.rearmed, 'every box is back to true once its respawn cooldown expires');
});

test('a dropped banana is a live trigger: it spins the car that hits it', { skip }, async () => {
  // The Gym used AUTHORED bananas seeded at race start; catalogue tracks have none,
  // so the equivalent here is the dropped kind, forced onto every roll.
  const r = await race('tidepool', 'banana');
  assert.ok(r.maxBananas >= 1, 'a used banana appears in the snapshot as a live hazard');
  assert.ok(spinCauses(r.events).has('banana'), 'a car that hit the banana spun out');
});

test('oil puddles spin cars on the tracks that carry them', { skip }, async () => {
  // Skysnake's oils sit where the racing line has to cross them; tidepool's do not
  // reliably catch a clean field, so the hazard check rides skysnake.
  const r = await race('skysnake', 'monster');
  assert.ok(spinCauses(r.events).has('oil'), 'a car crossed an oil slick and spun out');
});

// ---------------------------------------------------------------------------
// NOT COVERED ANY MORE. Both of these need something the C ABI does not offer;
// they are skipped rather than deleted so the gap stays visible in the test
// output. Neither is a false alarm — the behaviour is still real, just untested.
// ---------------------------------------------------------------------------

// The Gym range itself. It is a DEV track, so it exercises two things no catalogue
// track does: authored bananas seeded at race start (every shipped track has none),
// and a furniture layout hand-placed in a known order along the lap.
//
// Authored bananas RESPAWN where dropped ones despawn: a hit one rearms
// (Game::enterBanana sets liveAt and keeps it in the list) instead of being erased,
// so the Gym's three are still standing at their authored spots after a full race.
// A regression that treated them as droppable would empty the range permanently.
test('gym: the authored range races, and its authored bananas respawn', { skip }, async () => {
  const { DEV_TRACKS } = await import('../public/shared/devTracks.js');
  const nt = await import('../scripts/native-track.mjs');
  await nt.init();

  const built = nt.buildTrack('gym');
  const authored = DEV_TRACKS.gym.bananas;
  assert.equal(built.bananas.length, authored.length,
    'the Gym seeds its authored bananas onto the built track');
  // Authored order along the lap is the layout's whole point: an isolated box, then
  // the lane row, the pad, the poles, the oils, and the bananas last.
  const lastBox = Math.max(...built.boxes.map((b) => b.s));
  const firstOil = Math.min(...built.hazards.map((h) => h.s));
  const firstBanana = Math.min(...built.bananas.map((b) => b.s));
  assert.ok(lastBox < firstOil, `boxes come before the oils (${lastBox} < ${firstOil})`);
  assert.ok(firstOil < firstBanana, `oils come before the bananas (${firstOil} < ${firstBanana})`);

  const r = await race('gym', null, 3000);
  assert.ok(r.events.length > 0, 'a four-bot field really races the Gym');
  assert.ok(r.maxBananas >= authored.length,
    `the authored bananas are live (saw at most ${r.maxBananas}, expected >= ${authored.length})`);
  assert.ok(typesOf(r.events).has('lap'), 'the field completes laps on the dev range');
});

// Box pickup is a POINT test with the tuned 0.45 radius (9% of the 5-wide road):
// a car centre at lat 0.40 grabs, at 0.50 does not, and a monster truck's larger
// footprint does NOT extend its reach (the trigger ignores the body box, so every
// car has identical reach — no footprint creep).
// BLOCKED ON: the ABI has no car teleport and no single-trigger poll, so the probe
// cannot park a car at a chosen (s, lat) and fire one box test in isolation.
// Unblocked by a debug ABI entry point that sets a car's (s, lat, heading) and one
// that evaluates the box trigger.
test('box pickup is point-based with the tuned 0.45 radius — same reach for every car',
  { skip: 'needs an ABI car-teleport + single-trigger poll (neither exists in ttp_runtime.h)' }, () => {});
