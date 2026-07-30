'use strict';
// The UI model against the things the FROZEN corpus deliberately does not touch.
//
// tests/fixtures/ui-corpus.jsonl pins the model's behaviour byte for byte over a
// SYNTHETIC catalogue, because binding a frozen oracle to shared/tracks.js would
// turn every new track into a corpus re-record. This file is the other half: the
// links between the model and the data it is actually handed in the browser, and
// the invariants a recorded answer cannot state. It is free to change when the
// catalogue does — that is the point of keeping the two apart.
//
// IT DRIVES THE SHIPPED WASM. public/display/uiModel.js was the oracle the
// corpus was recorded off, and it went when the oracle was retired; the subject
// here is native/runtime/ttp_ui.h inside
// public/display/engine/native/ttp_runtime.{mjs,wasm} — the artifact the browser
// actually loads. For these questions that is strictly better than the JS twin
// was: they all ask "does the REAL catalogue meet the model correctly", and the
// model it meets in a browser is the C++ one.
//
// Two tests that lived here are gone with the twin rather than rewritten, and
// both moved rather than vanished: uiModel's ROOM_STATE mirror and its
// SCREENS/SCREEN_ORDER/BACK_EFFECT tables were JS module constants with no ABI
// of their own. ui_check.cc pins the first to ttp::protocol::ROOM_STATE and the
// second to its own enum, on all four legs. What is still reachable from here —
// the back EFFECT of each screen — is kept below.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');

// The shipped module, loaded once and configured with the REAL catalogue.
let uiPromise = null;
function ui_() {
  return (uiPromise = uiPromise || (async () => {
    const M = await (await import(pathToFileURL(MJS).href)).default();
    const c = (n, ret, args) => M.cwrap(n, ret, args);
    const J = JSON.stringify;
    const raw = {
      configure: c('ttp_ui_configure', 'number', ['string']),
      backEffect: c('ttp_ui_back_effect', 'string', ['string']),
      screenStep: c('ttp_ui_screen_step', 'number', ['string', 'string']),
      cupSlot: c('ttp_ui_cup_slot_json', 'string', ['string']),
      seatGrid: c('ttp_ui_seat_grid_json', 'string', ['string']),
      standings: c('ttp_ui_standings_json', 'string', ['string']),
      resultsView: c('ttp_ui_results_view_json', 'string', ['string', 'number']),
      autoPauseAsks: c('ttp_ui_auto_pause_asks', 'number', ['string']),
      autoPause: c('ttp_ui_auto_pause_json', 'string', ['string', 'number']),
      seriesInfo: c('ttp_ui_series_info_json', 'string', ['string']),
      catalogue: c('ttp_ui_catalogue_json', 'string', []),
      cupTintRgb: c('ttp_ui_cup_tint_rgb', 'number', ['string', 'number']),
      cupFieldTintPct: c('ttp_ui_cup_field_tint_pct', 'number', [])
    };
    const { CUPS, TRACK_LIST } = await load('public/shared/tracks.js');
    const protocol = require('../public/shared/protocol.js');
    // NO CATALOGUE IS PASSED, on purpose. The cups, the names and the tendency
    // rule are codegen'd into this artifact, so the two field sizes are the
    // whole of what a shell owes it. What tracks.js is still used for here is
    // the OPPOSITE direction — checking that what came out matches what was
    // authored (see the first test below).
    raw.configure(J({
      maxPlayers: protocol.MAX_PLAYERS,
      carCount: protocol.CAR_MODELS.length
    }));
    // The autoPause pair takes Sets in the shell; the ABI takes arrays.
    const apArg = ({ hasSession, raceEnded, roomState, carIds, aiIds, seatedIds }) => J({
      hasSession: !!hasSession, raceEnded: !!raceEnded, roomState: roomState || '',
      carIds: [...carIds], aiIds: [...aiIds], seatedIds: [...seatedIds]
    });
    return {
      CUPS, TRACK_LIST, protocol,
      catalogue: () => JSON.parse(raw.catalogue()),
      backEffect: (s) => raw.backEffect(s),
      screenStep: (a, b) => raw.screenStep(a, b),
      cupSlot: (x) => JSON.parse(raw.cupSlot(J(x))),
      seatGrid: (seats) => JSON.parse(raw.seatGrid(J(seats))),
      standingsPayload: (x) => JSON.parse(raw.standings(J(x))),
      resultsView: (board, o) => JSON.parse(raw.resultsView(J(board), o.intermissionMs)),
      autoPauseAsksParticipants: (x) => !!raw.autoPauseAsks(apArg(x)),
      autoPause: (x) => JSON.parse(raw.autoPause(apArg(x), x.allParticipantsDisconnected ? 1 : 0)),
      seriesInfo: (x) => JSON.parse(raw.seriesInfo(J(x))),
      cupTintRgb: (cupId, pct) => raw.cupTintRgb(cupId == null ? '' : cupId, pct) >>> 0,
      cupFieldTintPct: () => raw.cupFieldTintPct()
    };
  })());
}

// THE DRIFT GATE FOR THE CODEGEN'D CATALOGUE, and the only place that can be
// one: shared/tracks.js is the authored source and generated/track_defs.h is
// what the wasm ships, and nothing else in the tree sees both at once. Before
// the display half was codegen'd this could not drift — the browser sent the
// catalogue in — so the check is the price of the shell no longer carrying it.
//
// It compares the answer to the JS the codegen read, including cupTendency,
// which is a RULE (a rounded mean, or the cup's own override) rather than data.
// tracks.js still spells it in JS; a shell no longer has to.
test('the shipped catalogue in the wasm is the one shared/tracks.js authors', async () => {
  const u = await ui_();
  const { CUPS, TRACK_LIST } = await load('public/shared/tracks.js');
  const got = u.catalogue();

  // `color` joins the same deepEqual rather than being stripped out of it: a
  // cup's paper colour is authored data like its name, and the cheapest way for
  // it to rot is to be excluded from the check that already covers the row.
  const { CUP_COLOR } = await load('public/shared/trackPicker.js');
  assert.deepEqual(got.cups, CUPS.map((c) => ({
    id: c.id, name: c.name, tracks: c.tracks,
    color: parseInt(CUP_COLOR[c.id].slice(1), 16)
  })), 'cups, their display names, track order and paper colour come out as authored');
  assert.deepEqual(got.catalog, TRACK_LIST.map((t) => ({
    id: t.id, name: t.name, cup: t.cup, cupDifficulty: t.cupDifficulty
  })), 'every track name, its cup and its cup TENDENCY come out as authored');

  // The order is load-bearing twice over: ttp_ui.h reads a cup's difficulty off
  // its FIRST catalogue entry, and this list is what a picker draws.
  assert.deepEqual(got.catalog.map((t) => t.id), CUPS.flatMap((c) => c.tracks),
    'the catalogue is CUPS order flattened');
  // Dev ranges are in the wasm's track table (id lookup) but belong to no cup,
  // so they can never reach a player-visible list. Asserted over the whole dev
  // catalogue rather than one id: the invariant is "no dev track", and naming
  // one leaves the next one added covered by nothing.
  const { DEV_TRACKS } = await load('public/shared/devTracks.js');
  const ids = new Set(got.catalog.map((t) => t.id));
  for (const dev of Object.keys(DEV_TRACKS)) {
    assert.ok(!ids.has(dev), `dev track "${dev}" must not appear in the catalogue`);
  }
  assert.ok(Object.keys(DEV_TRACKS).length > 0, 'premise: there are dev tracks to exclude');
});

test('every board acts on back, and only the root swallows', async () => {
  const u = await ui_();
  // The ENUM and its order are pinned in ui_check.cc (they were JS module
  // constants with no ABI); what a shell can still ask is the EFFECT, so ask it.
  assert.equal(u.backEffect('welcome'), 'swallow');
  for (const s of ['lobby', 'race']) {
    assert.notEqual(u.backEffect(s), 'swallow', `${s} must act on back`);
  }
  // An unknown board counts as the root, which is what makes the first show() a
  // push rather than a replace.
  assert.equal(u.backEffect('nonsense'), 'swallow');
  assert.ok(u.screenStep('welcome', 'lobby') > 0, 'welcome -> lobby is a forward step');
  assert.ok(u.screenStep('race', 'lobby') < 0, 'race -> lobby is a retreat');
  assert.equal(u.screenStep('lobby', 'lobby'), 0);
});

test('the lobby race card resolves the SHIPPED cups and tracks', async () => {
  const ui = await ui_();
  const { CUPS, TRACK_LIST } = await load('public/shared/tracks.js');
  const catalog = TRACK_LIST.map((t) => ({ id: t.id, name: t.name, cup: t.cup, cupDifficulty: t.cupDifficulty }));

  for (const cup of CUPS) {
    const slot = ui.cupSlot({ mode: 'cup', cupId: cup.id, trackId: cup.tracks[0], cups: CUPS, catalog });
    assert.equal(slot.name, cup.name, `cup ${cup.id} did not resolve its name`);
    assert.equal(slot.raceCount, cup.tracks.length);
    assert.deepEqual(slot.maps.map((m) => m.trackId), cup.tracks, 'the minis must be the cup, in order');
    assert.deepEqual(slot.maps.map((m) => m.n), cup.tracks.map((_, i) => i + 1), 'the minis are numbered 1..N');
    assert.ok(slot.difficulty >= 0 && slot.difficulty <= 4, `cup ${cup.id} has no difficulty in 0..4`);
  }
  for (const t of TRACK_LIST) {
    const slot = ui.cupSlot({ mode: 'track', trackId: t.id, cups: CUPS, catalog });
    assert.equal(slot.name, t.name);
    assert.equal(slot.cupId, t.cup, `${t.id} must tint with its own cup`);
    assert.deepEqual(slot.maps, [{ trackId: t.id }]);
  }
  // The random sticker never names a track — the mini carries the draw instead.
  const rnd = ui.cupSlot({ mode: 'random', trackId: TRACK_LIST[3].id, cups: CUPS, catalog });
  assert.equal(rnd.nameKey, 'random');
  assert.equal(rnd.name, null);
  assert.equal(rnd.difficulty, null, 'a random draw shows no difficulty meter');
});

test('the cup chip names the next race out of the shipped catalogue', async () => {
  const ui = await ui_();
  const { CUPS, TRACK_LIST } = await load('public/shared/tracks.js');
  const cup = CUPS[0];
  const info = ui.seriesInfo({
    cupId: cup.id, cupName: cup.name, endless: false, raceIndex: 1, raceCount: 4,
    finished: false, nextTrackId: cup.tracks[2], catalog: TRACK_LIST, autoAdvanceMs: 10000
  });
  assert.equal(info.nextTrackId, cup.tracks[2]);
  assert.equal(info.nextTrackName, TRACK_LIST.find((t) => t.id === cup.tracks[2]).name);
  assert.equal(info.final, false);
  const done = ui.seriesInfo({ ...{
    cupId: cup.id, cupName: cup.name, endless: false, raceIndex: 3, raceCount: 4,
    catalog: TRACK_LIST, autoAdvanceMs: 10000
  }, finished: true, nextTrackId: cup.tracks[3] });
  assert.equal(done.nextTrackId, null, 'a finished cup queues nothing');
  assert.equal(done.nextTrackName, null);
  assert.equal(done.final, true);
});

test('the standings board keeps its wire key order', async () => {
  const ui = await ui_();
  const board = ui.standingsPayload({
    results: [{ playerId: 0, rank: 1, finished: true, time: 60 }],
    field: [{ peerIndex: 0, name: 'Ada', colorIndex: 2 }],
    cup: null,
    lateJoiners: [{ peerIndex: 1, name: 'Bo', colorIndex: 3 }],
    hostPeerIndex: 0,
    over: true
  });
  // The controller reads this by key, but the shape is a contract two languages
  // will implement, so pin it rather than leave it to whoever writes the struct.
  assert.deepEqual(Object.keys(board), ['over', 'hostPeerIndex', 'total', 'order']);
  assert.deepEqual(Object.keys(board.order[0]), ['playerId', 'name', 'colorIndex', 'ai', 'finished', 'time']);
  assert.deepEqual(Object.keys(board.order[1]), ['playerId', 'name', 'colorIndex', 'joining']);
  assert.equal(board.total, board.order.length, 'total always counts the joining rows too');

  const cupBoard = ui.standingsPayload({
    results: [{ playerId: 0, rank: 1, finished: true, time: 60 }],
    field: [{ peerIndex: 0, name: 'Ada', colorIndex: 2 }],
    cup: { standings: [{ playerId: 0, points: 9, gained: 9 }], info: { cupId: 'c', final: false } },
    lateJoiners: [], hostPeerIndex: 0, over: true
  });
  assert.deepEqual(Object.keys(cupBoard), ['over', 'hostPeerIndex', 'series', 'total', 'order']);
  assert.deepEqual(Object.keys(cupBoard.order[0]),
    ['playerId', 'name', 'colorIndex', 'ai', 'finished', 'time', 'points', 'gained']);
});

test('a live cup board stays in race order; only the final board re-sorts', async () => {
  const ui = await ui_();
  const results = [
    { playerId: 1, rank: 1, finished: true, time: 60 },
    { playerId: 0, rank: 2, finished: true, time: 61 }
  ];
  const field = [{ peerIndex: 0, name: 'Ada' }, { peerIndex: 1, name: 'Bo' }];
  // Ada leads the CUP, Bo won this RACE.
  const cup = { standings: [{ playerId: 0, points: 20, gained: 6 }, { playerId: 1, points: 12, gained: 9 }], info: {} };

  const live = ui.standingsPayload({ results, field, cup, lateJoiners: [], hostPeerIndex: 0, over: false });
  assert.deepEqual(live.order.map((r) => r.playerId), [1, 0], 'mid-race the drama is who crossed the line');
  assert.ok(live.order.every((r) => r.gained === undefined), 'gains only appear on the final board');

  const final = ui.standingsPayload({ results, field, cup, lateJoiners: [], hostPeerIndex: 0, over: true });
  assert.deepEqual(final.order.map((r) => r.playerId), [0, 1], 'the final board tells the cup story');
  assert.deepEqual(final.order.map((r) => r.gained), [6, 9]);
});

test('the results overlay splits the podium from the list the frozen way', async () => {
  const ui = await ui_();
  const row = (playerId, o = {}) => ({ playerId, name: `P${playerId}`, colorIndex: 0, ...o });
  const board = {
    over: true, hostPeerIndex: 0,
    series: { cupName: 'Sunrise', final: true, endless: false, raceIndex: 3, raceCount: 4 },
    total: 5,
    order: [row(0), row(1), row(9, { joining: true }), row(2), row(3)]
  };
  const v = ui.resultsView(board, { intermissionMs: 10000 });
  assert.equal(v.podium, true);
  // The steps skip the joining row; the list still starts at index 3. That gap
  // is the recorded quirk — 2 lands on neither.
  assert.deepEqual(v.podiumRows.map((r) => r.playerId), [0, 1, 2]);
  assert.deepEqual(v.listRows.map((r) => r.playerId), [2, 3]);
  assert.equal(v.next, null, 'a podium queues nothing');
  assert.equal(v.newGameKey, 'new_game');
});

test('the auto-pause read is deferred to exactly the ticks that use it', async () => {
  const ui = await ui_();
  const base = { hasSession: true, raceEnded: false, carIds: [0, 'ai-0'], aiIds: new Set(['ai-0']), seatedIds: new Set([0]) };
  // The party layer's answer is only consulted while PLAYING with a human seat
  // still in the race — everywhere else the shell must not pay for the read.
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'playing' }), true);
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'countdown' }), false);
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'results' }), false);
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'playing', seatedIds: new Set() }), false);
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'playing', hasSession: false }), false);
  assert.equal(ui.autoPauseAsksParticipants({ ...base, roomState: 'playing', raceEnded: true }), false);
  // ... and when it is not consulted, passing it cannot change the answer.
  for (const roomState of ['lobby', 'countdown', 'playing', 'results']) {
    const a = ui.autoPause({ ...base, roomState, allParticipantsDisconnected: false });
    const b = ui.autoPause({ ...base, roomState, allParticipantsDisconnected: true });
    if (!a.asked) assert.deepEqual(a, b, `${roomState}: an unconsulted input changed the decision`);
  }
});

test('the seat grid never shrinks below the field that races', async () => {
  const ui = await ui_();
  const protocol = require('../public/shared/protocol.js');
  const MAX = protocol.MAX_PLAYERS;
  for (let n = 0; n <= MAX + 2; n++) {
    const seats = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, colorIndex: i }));
    const grid = ui.seatGrid(seats, MAX, protocol.CAR_MODELS.length);
    assert.equal(grid.length, Math.max(MAX, n), `a roster of ${n} must fill ${Math.max(MAX, n)} tiles`);
    assert.equal(grid.filter((g) => g.open).length, Math.max(0, MAX - n));
    // Every taken tile names a car that exists in the model roster.
    for (const g of grid.filter((x) => !x.open)) {
      assert.ok(protocol.CAR_MODELS[g.modelIndex], `seat car ${g.modelIndex} is not in CAR_MODELS`);
    }
  }
});

// ---- the cup paper colours --------------------------------------------------
//
// public/shared/trackPicker.js authors them and stays the source: the PHONE
// imports that file, and a phone has no wasm to ask. The codegen carries the
// table into the wasm so a native shell does not retype it — the first TV shell
// did exactly that, under a comment noting nothing in the tree watched the two
// lists. This is that watch, and it is the only place that can see both.

test('every shipped cup carries the colour trackPicker.js authors', async () => {
  const u = await ui_();
  const { CUP_COLOR } = await load('public/shared/trackPicker.js');
  const cups = u.catalogue().cups;

  // Both directions. Left to right catches a cup the codegen mispainted; right
  // to left catches a colour authored for a cup that no longer ships, which is
  // dead weight rather than a bug but is exactly how the table rots.
  assert.deepEqual(
    Object.fromEntries(cups.map((c) => [c.id, '#' + c.color.toString(16).toUpperCase().padStart(6, '0')])),
    Object.fromEntries(Object.entries(CUP_COLOR).map(([k, v]) => [k, v.toUpperCase()])),
    'the wasm catalogue and trackPicker.js paint different cups');
});

test('the field tint is one number, not two', async () => {
  const u = await ui_();
  const { FIELD_TINT } = await load('public/shared/trackPicker.js');
  assert.equal(u.cupFieldTintPct(), FIELD_TINT);
});

test('the cup wash is an sRGB lerp toward white, and Random gets the fallback', async () => {
  const u = await ui_();
  const { CUP_COLOR, CUP_COLOR_FALLBACK, FIELD_TINT } = await load('public/shared/trackPicker.js');

  // Re-derived here rather than read from the source under test: `color-mix(in
  // srgb, C pct%, #fff)` is a per-channel lerp on the ENCODED values. Doing it
  // in linear light instead is a one-line change that comes out visibly darker
  // and would still pass a test that only compared the C++ to itself.
  const mix = (hex, pct) => {
    const k = pct / 100;
    const ch = (i) => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
      return Math.round(c * k + 255 * (1 - k));
    };
    return (ch(0) << 16) | (ch(1) << 8) | ch(2);
  };

  for (const [id, hex] of Object.entries(CUP_COLOR)) {
    for (const pct of [0, FIELD_TINT, 45, 72, 100]) {
      assert.equal(u.cupTintRgb(id, pct), mix(hex, pct) >>> 0,
        `${id} at ${pct}% disagrees with an sRGB lerp`);
    }
  }
  // Random belongs to no cup, so it washes the fallback rather than black.
  assert.equal(u.cupTintRgb(null, FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
  assert.equal(u.cupTintRgb('', FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
  assert.equal(u.cupTintRgb('no-such-cup', FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
});

test('a pct outside 0..100 is clamped, not wrapped', async () => {
  // It arrives from a shell. Wrapping the channel arithmetic would produce a
  // colour nobody authored, and it would look deliberate.
  const u = await ui_();
  assert.equal(u.cupTintRgb('beach', -50), u.cupTintRgb('beach', 0));
  assert.equal(u.cupTintRgb('beach', 500), u.cupTintRgb('beach', 100));
});
