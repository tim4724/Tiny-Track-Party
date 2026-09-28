// The keys a shell reads out of the LAUNCH answer.
//
// The start walk's `create-session` effect carries the whole race — the field
// and a persona spec per bot — and every shell then walks it to build the
// session. There is no schema on that walk: a shell reads `spec["id"]`, gets
// nil because the key is `peerIndex`, and skips the bot.
//
// That is not hypothetical. It shipped, and it made EVERY RACE on the TV run
// with the humans alone on a track built for a full grid. A `guard … else
// { continue }` per bot, and nothing anywhere said a word: the launch answer was
// correct, the field was correct, and the standings board was correct about the
// cars that existed. The screenshot harness passes four fake HUMANS, so every
// race photograph showed a full grid too.
//
// So this pins the ABI's actual key names against what each shell reads. It is a
// source check by necessity — from inside the ABI, a shell that ignores half the
// answer is indistinguishable from one that had nothing to add.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let launchPromise = null;
function launch() {
  return (launchPromise = launchPromise || (async () => {
    const M = await (await import(pathToFileURL(
      path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href)).default();
    const c = (n, r, a) => M.cwrap(n, r, a);
    const manifest = JSON.parse(c('ttp_protocol_manifest_json', 'string', [])());
    c('ttp_ui_configure', 'number', ['string'])(JSON.stringify({
      maxPlayers: manifest.MAX_PLAYERS, carCount: manifest.CAR_MODELS.length }));
    const cat = JSON.parse(c('ttp_ui_catalogue_json', 'string', [])());
    c('ttp_race_configure', 'number', ['string'])(JSON.stringify({
      fieldSize: manifest.FIELD_SIZE,
      carCount: manifest.CAR_MODELS.length,
      colorCount: manifest.CAR_COLORS.length,
      aiPrefix: 'ai-',
      personas: JSON.parse(c('ttp_race_personas_json', 'string', [])()),
      carStats: manifest.CAR_STATS,
      cups: cat.cups
    }));
    // TWO humans seated in a live room, against the SHIPPED field size, so the
    // answer must invent bots. A full lobby would produce an empty `bots` array
    // and this whole file would assert nothing. `fieldSize` is FIELD_SIZE and
    // not MAX_PLAYERS on purpose: this harness configured the phone cap for
    // months, so nothing in the Node suite had ever launched the 8-car grid the
    // game ships — the very mistake the tvOS check at the bottom of this file
    // exists to catch. The launch is the executor's (`ttp_race_start_live_json`);
    // the composed race rides its create-session effect.
    const room = c('ttp_room_create', 'number', ['string'])(JSON.stringify({
      liveness: { timeoutMs: 60000, graceMs: 60000 } }));
    const add = c('ttp_room_add_player', 'number', ['number', 'string', 'string']);
    add(room, '1', JSON.stringify({ name: 'Alice', carIndex: 0, colorIndex: 0, ready: false }));
    add(room, '2', JSON.stringify({ name: 'Bob', carIndex: 1, colorIndex: 1, ready: false }));
    c('ttp_net_init_pick', null, ['number', 'string', 'number', 'number'])(room, 'tidepool', 1, 1);
    const d = JSON.parse(c('ttp_race_start_live_json', 'string',
      ['number', 'number', 'number', 'number', 'string', 'string'])(room, 1, 1, 3, null, null));
    assert.equal(d.action, 'launch', `the seeded start was refused: ${d.reason}`);
    const cs = (d.effects || []).find((e) => e.op === 'create-session');
    assert.ok(cs, 'the launch answers a create-session effect');
    const ai = (cs.field || []).filter((e) => e.ai).map((e) => e.peerIndex);
    return { field: cs.field, bots: cs.bots, aiIds: ai, fieldSize: manifest.FIELD_SIZE };
  })());
}

const HUMANS = 2; // Alice and Bob, seated above

test('a part-full lobby is filled with bots (the premise)', async () => {
  const d = await launch();
  assert.equal(d.field.length, d.fieldSize, 'the field fills to the configured size');
  assert.equal(d.bots.length, d.fieldSize - HUMANS, 'and the rest of the grid is AI');
  assert.deepEqual(d.aiIds,
    Array.from({ length: d.fieldSize - HUMANS }, (_, i) => `ai-${i}`));
});

test('a bot spec is keyed peerIndex, and carries NO stats', async () => {
  const d = await launch();
  const spec = d.bots[0];
  assert.deepEqual(Object.keys(spec).sort(), ['caution', 'laneBias', 'peerIndex', 'seed']);
  // The two mistakes this shape invites, stated as assertions so they cannot
  // quietly become true and make the shells right by accident.
  assert.equal(spec.id, undefined, 'there is no `id` — a shell reading one gets nil and skips the bot');
  assert.equal(spec.stats, undefined,
    'and no `stats` — they belong to the FIELD entry, so a bot built from the spec alone '
    + 'races on benchmark defaults instead of the car it is driving');
});

test('the field entry is where a racer\'s stats and identity live', async () => {
  const d = await launch();
  for (const e of d.field) {
    assert.ok(e.peerIndex !== undefined, 'every field entry is keyed peerIndex');
    assert.ok(e.stats && typeof e.stats === 'object', 'and carries the car stats to race on');
  }
  // The field carries BOTH humans and AI, flagged — which is what lets one pass
  // over it build the whole session in grid order.
  assert.equal(d.field.filter((e) => e.ai).length, d.fieldSize - HUMANS);
});

// ---- and that each shell reads those keys ---------------------------------

const SHELLS = [
  {
    file: 'public/display/NativeRaceSession.js',
    // players keyed peerIndex + stats; the bot spec crosses VERBATIM — the
    // documented-keys read happens inside ttp_session_begin_field now
    needs: [/peerIndex: p\.peerIndex/, /p\.stats/, /JSON\.stringify\(opts\.bots \|\| \[\]\)/]
  },
  {
    file: 'shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift',
    // The field crosses VERBATIM into ttp_session_begin_field, which owns the
    // documented-keys read — the hand-written loop that once read stats off
    // the bot spec (which has none) is gone from this shell too.
    needs: [/ttp_session_begin_field/]
  },
  {
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt',
    // Same split as tvOS: the field crosses verbatim, the ABI reads the keys.
    needs: [/ttp_session_begin_field/]
  }
];

for (const { file, needs } of SHELLS) {
  test(`${file} builds the session from the documented keys`, () => {
    if (!existsSync(path.join(ROOT, file))) {
      assert.ok(file.startsWith('shells/'), `${file} is missing and is not an optional shell`);
      return;
    }
    // Code only: the comments deliberately quote the WRONG key, which is how a
    // note stops the mistake coming back.
    const code = readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const re of needs) {
      assert.match(code, re,
        `${file}: does not read the bot spec / stats the way ttp_race.h documents. `
        + 'Reading `id` off a spec keyed `peerIndex` silently drops every bot.');
    }
    assert.doesNotMatch(code, /\bb\["id"\]|\bspec\.id\b/,
      `${file}: reads \`id\` off a bot spec — there is no such key`);
  });
}

test('the tvOS shell configures the race with FIELD_SIZE, not the phone cap', () => {
  // `fieldSize` and `maxPlayers` are different manifest constants (8 cars vs
  // 4 phones). The shell once handed `ttp_race_configure` the phone cap and
  // every TV race seated half a field — silently, because a 4-car race is a
  // perfectly healthy race.
  const proto = path.join(ROOT, 'shells/tvos/TinyTrackParty/Net/Protocol.swift');
  const coord = path.join(ROOT, 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  if (!existsSync(proto) || !existsSync(coord)) return;
  const code = (p) => readFileSync(p, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code(proto), /FIELD_SIZE/,
    'Protocol.swift must mirror FIELD_SIZE from the manifest');
  assert.match(code(coord), /"fieldSize":\s*proto\.fieldSize/,
    'ttp_race_configure must receive the manifest FIELD_SIZE');
  assert.doesNotMatch(code(coord), /"fieldSize":\s*proto\.maxPlayers/,
    'the phone cap is not the field size');
});
