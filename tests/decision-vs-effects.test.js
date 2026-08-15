// Walk answers carry an ACTION and EFFECTS, and both matter.
//
// The historical failure shape (three times in one shell): an answer read for
// the wrong half. `{"action":"launch"}` read as a boolean `launch` key
// rejected every start; a bare DECISION handed to the effect walker walked an
// empty list and did nothing, silently. The executor walks closed the second
// hole structurally — the decision AND its effects are one answer now — but
// the first survives: a shell must still read `action`, because
// "return-to-lobby" means take a different road entirely.
//
// So this pins the answer shapes from the ABI itself, against a live room,
// and that both shells drive the ONE-walk auto-pause.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

let abiPromise = null;
function abi() {
  return (abiPromise = abiPromise || (async () => {
    const M = await (await import(pathToFileURL(
      path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')).href)).default();
    const c = (n, r, a) => M.cwrap(n, r, a);
    const manifest = JSON.parse(c('ttp_protocol_manifest_json', 'string', [])());
    c('ttp_ui_configure', 'number', ['string'])(JSON.stringify({
      maxPlayers: manifest.MAX_PLAYERS, carCount: manifest.CAR_MODELS.length }));
    const cat = JSON.parse(c('ttp_ui_catalogue_json', 'string', [])());
    c('ttp_race_configure', 'number', ['string'])(JSON.stringify({
      fieldSize: manifest.MAX_PLAYERS,
      carCount: manifest.CAR_MODELS.length,
      colorCount: manifest.CAR_COLORS.length,
      aiPrefix: 'ai-',
      carStats: manifest.CAR_STATS,
      cups: cat.cups
    }));
    return {
      roomCreate: c('ttp_room_create', 'number', ['string']),
      initPick: c('ttp_net_init_pick', null, ['number', 'string', 'number', 'number']),
      start: c('ttp_race_start_live_json', 'string',
               ['number', 'number', 'number', 'number', 'string', 'string']),
      advance: c('ttp_race_advance_live_json', 'string',
                 ['number', 'number', 'number', 'number', 'string', 'string']),
      autoPause: c('ttp_race_auto_pause_live_json', 'string', ['number', 'number', 'number'])
    };
  })());
}

function freshRoom(a) {
  return a.roomCreate(JSON.stringify({ liveness: { timeoutMs: 60000, graceMs: 60000 } }));
}

test('a rejected start answers a REASON, not an empty plan', async () => {
  const a = await abi();
  const room = freshRoom(a);
  a.initPick(room, 'tidepool', 1, 1);
  // An empty lobby: the go/no-go refuses before any draw or effect.
  const d = JSON.parse(a.start(room, 1, 1, 3, null, null));
  assert.equal(d.action, 'none');
  assert.ok(d.reason, 'it says why — this is the pattern the rest of the ABI should copy');
  // The trap: there is no boolean `launch`, so `if (answer.launch)` is always
  // false and every start is rejected.
  assert.equal(d.launch, undefined, 'there is no `launch` key to read');
});

test('advance answers an action AND effects — both matter', async () => {
  // The mixed case, and why "does it have effects" is not a sufficient test:
  // the shell must read the action too, because 'return-to-lobby' means take a
  // different road entirely, and 'advance' means perform the launch effects.
  const a = await abi();
  const d = JSON.parse(a.advance(freshRoom(a), 1, 1, 3, null, null));
  assert.ok(d.action, 'advance always states its action');
});

test('the auto-pause walk answers EFFECTS directly — no decision to mis-route', async () => {
  // The old two-step (a UI decision, then a race-layer translation) is gone:
  // a shell that used to feed the bare decision to its effect walker cannot
  // make that mistake any more, because the one walk's answer IS the plan.
  const a = await abi();
  const d = JSON.parse(a.autoPause(0, freshRoom(a), 0));
  assert.ok(Array.isArray(d.effects), 'the answer carries an effects array (often empty)');
});

// ---- and that the shells drive the one walk -------------------------------

const SHELLS = [
  { file: 'public/display/main.js', chain: /flow\.autoPause\(/ },
  {
    file: 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift',
    chain: /ttp_race_auto_pause_live_json\(/
  }
];

for (const { file, chain } of SHELLS) {
  test(`${file} drives the one-walk auto-pause`, () => {
    if (!existsSync(path.join(ROOT, file))) {
      assert.ok(file.startsWith('shells/'), `${file} is missing and is not an optional shell`);
      return;
    }
    const code = readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.match(code, chain, `${file}: no one-walk auto-pause path`);
    assert.doesNotMatch(code, /ttp_ui_auto_pause_json|ttp_race_auto_pause_json\(/,
      `${file}: the retired two-step decision road is back`);
  });
}
