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
//
// THE BOARD AND THE CHIP ARE DRIVEN OFF LIVE HANDLES. Their hand-assembled JSON
// spellings are gone from the ABI: the standings board gathers its late joiners,
// its host and (without an explicit results object) its result rows off the
// session/room/gp handles in C++, and the cup chip's eight fields off the series.
// So the questions below are asked the way the display asks them — a real room,
// a real race, a real cup series, built here through the same shipped wasm.
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
      standingsLive: c('ttp_ui_standings_live_json', 'string',
        ['number', 'number', 'number', 'string', 'number']),
      resultsView: c('ttp_ui_results_view_json', 'string', ['string', 'number']),
      seriesInfoLive: c('ttp_ui_series_info_live_json', 'string', ['number', 'number']),
      catalogue: c('ttp_ui_catalogue_json', 'string', []),
      progressLoad: c('ttp_ui_progress_load', 'number', ['string', 'number']),
      progressJson: c('ttp_ui_progress_json', 'string', []),
      cupTintRgb: c('ttp_ui_cup_tint_rgb', 'number', ['string', 'number']),
      neutralTintRgb: c('ttp_ui_neutral_tint_rgb', 'number', ['number']),
      cupFieldTintPct: c('ttp_ui_cup_field_tint_pct', 'number', []),
      // The walks a party is driven through. Same module, so the room, the race
      // and the series the board gathers off are the ones played here.
      netConfigure: c('ttp_net_configure', 'number', ['string']),
      raceConfigure: c('ttp_race_configure', 'number', ['string']),
      roomCreate: c('ttp_room_create', 'number', ['string']),
      roomList: c('ttp_room_list_json', 'string', ['number']),
      roomEvents: c('ttp_room_events_json', 'string', ['number']),
      roomTransition: c('ttp_room_transition_to', 'number', ['number', 'string']),
      netOnOpen: c('ttp_net_on_open_json', 'string', ['number']),
      netOnProtocol: c('ttp_net_on_protocol_json', 'string', ['number', 'string', 'string', 'number']),
      netOnPeerMessage: c('ttp_net_on_peer_message_json', 'string',
        ['number', 'number', 'string', 'string', 'number', 'number']),
      netInitPick: c('ttp_net_init_pick', null, ['number', 'string', 'number', 'number']),
      raceStartLive: c('ttp_race_start_live_json', 'string',
        ['number', 'number', 'number', 'number', 'string', 'string']),
      raceAdvanceLive: c('ttp_race_advance_live_json', 'string',
        ['number', 'number', 'number', 'number', 'string', 'string']),
      raceEventsLive: c('ttp_race_events_live_json', 'string',
        ['number', 'number', 'string', 'number', 'number', 'number', 'number', 'number']),
      raceSeriesState: c('ttp_race_series_state_json', 'string', ['number']),
      raceBegin: c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
      raceAddHuman: c('ttp_add_human', null, ['number', 'string', 'string']),
      raceStart: c('ttp_session_start', null, ['number', 'number']),
      raceUpdate: c('ttp_update', null, ['number', 'number']),
      raceForceFinish: c('ttp_force_finish', null, ['number', 'string', 'number']),
      raceDispose: c('ttp_dispose', null, ['number']),
      gpCreate: c('ttp_gp_create', 'number', ['string', 'number']),
      gpApplyRace: c('ttp_gp_apply_race', null, ['number', 'string', 'string', 'string']),
      gpAdvance: c('ttp_gp_advance', null, ['number']),
      gpState: c('ttp_gp_state_json', 'string', ['number'])
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
    // The two other worlds a party needs, from the same authored source: the
    // net walks' chooser (what a mode pick may resolve to) and the race walks'
    // field rules. fieldSize is the one thing a caller varies, so it is set per
    // party rather than here — see party() below.
    raw.netConfigure(J({
      cars: protocol.CAR_MODELS.map((id) => ({ id })),
      colors: protocol.CAR_COLORS,
      tracks: TRACK_LIST.map((t) => ({ id: t.id, cup: t.cup }))
    }));
    const raceWorld = (fieldSize) => raw.raceConfigure(J({
      fieldSize, carCount: protocol.CAR_MODELS.length,
      colorCount: protocol.CAR_COLORS.length, aiPrefix: 'ai-',
      cups: CUPS.map((c2) => ({ id: c2.id, name: c2.name, tracks: c2.tracks }))
    }));
    return {
      CUPS, TRACK_LIST, protocol,
      catalogue: () => JSON.parse(raw.catalogue()),
      progressLoad: (json, unlockAll) => raw.progressLoad(json || '', unlockAll ? 1 : 0),
      progressJson: () => raw.progressJson(),
      backEffect: (s) => raw.backEffect(s),
      screenStep: (a, b) => raw.screenStep(a, b),
      cupSlot: (x) => JSON.parse(raw.cupSlot(J(x))),
      seatGrid: (seats) => JSON.parse(raw.seatGrid(J(seats))),
      resultsView: (board, o) => JSON.parse(raw.resultsView(J(board), o.intermissionMs)),
      cupTintRgb: (cupId, pct) => raw.cupTintRgb(cupId == null ? '' : cupId, pct) >>> 0,
      neutralTintRgb: (pct) => raw.neutralTintRgb(pct) >>> 0,
      cupFieldTintPct: () => raw.cupFieldTintPct(),

      cup: (cup) => raw.gpCreate(J(cup), 0),
      applyRace: (gp, results, field) => raw.gpApplyRace(gp, J(results), J(field), null),
      advance: (gp) => raw.gpAdvance(gp),
      gpState: (gp) => JSON.parse(raw.gpState(gp)),
      seriesInfo: (gp, autoAdvanceMs = 10000) => JSON.parse(raw.seriesInfoLive(gp, autoAdvanceMs)),

      // ---- A PARTY IN A JAR ----------------------------------------------
      // Every input to the standings board is a HANDLE now. The race field is
      // the room's launch copy and the cup half is the room's stored series,
      // both written by the walks and reachable through nothing else — so the
      // only way to ask the board a question is to have played the game. This
      // drives the same walks main.js drives, and performs the two ops a test
      // needs out of the answer (the room transition and the session).
      //
      // Seats are peerIndex 1..n in join order, which is what the walks assign.
      party: ({ names, pick, fieldSize = names.length }) => {
        const room = raw.roomCreate('{}');
        raw.netOnOpen(room);
        raw.netOnProtocol(room, 'created', '{"room":"ABCD"}', 1000);
        raw.netInitPick(room, null, 1, 20260731);
        let session = 0;
        let clock = 2000;
        // A phone arriving: seated, named, and picking a car. Joining DURING a
        // race still leaves it out of the launched field, which is what the
        // board draws as a joining row.
        const join = (name) => {
          const peer = JSON.parse(raw.roomList(room)).length + 1;
          raw.netOnProtocol(room, 'peer_joined', J({ index: peer }), (clock += 10));
          raw.netOnPeerMessage(room, 0, J(peer),
            J({ type: 'hello', name, rejoinToken: null }), 0, (clock += 10));
          raw.netOnPeerMessage(room, 0, J(peer),
            J({ type: 'set_car', carIndex: peer - 1 }), 0, (clock += 10));
          raw.roomEvents(room);
          return peer;
        };
        names.forEach((n) => join(n));
        raw.netOnPeerMessage(room, 0, '1', J({ type: 'select_mode', ...pick }), 0, (clock += 10));
        raw.roomEvents(room);

        // The two effects this jar performs; everything else names a platform
        // API no Node test has, and the executor already moved the rest.
        const perform = (effects) => {
          for (const e of effects) {
            if (e.op === 'transition') raw.roomTransition(room, e.to);
            else if (e.op === 'create-session') {
              session = raw.raceBegin(e.trackId, 42, 3, null);
              for (const row of e.field) raw.raceAddHuman(session, J(row.peerIndex), null);
              raw.raceStart(session, 3);
              raw.raceUpdate(session, 4000);   // out of the countdown
            } else if (e.op === 'dispose-session') { raw.raceDispose(session); session = 0; }
          }
        };
        // The field rules are global to the module, so re-assert this party's
        // before every launch: two parties in one test file must not size each
        // other's CPU fill.
        const launch = (walk) => {
          raceWorld(fieldSize);
          const d = JSON.parse(walk(room, 1, 42, 3, null, null));
          assert.ok(d.effects, `the launch walk refused: ${d.reason || d.action}`);
          perform(d.effects);
          return d;
        };
        launch(raw.raceStartLive);
        return {
          room, join,
          get session() { return session; },
          roster: () => JSON.parse(raw.roomList(room)),
          // The room's cup series — no shell holds a handle to it any more.
          seriesState: () => JSON.parse(raw.raceSeriesState(room)),
          // Run the current race out in the order given (ids finish 60s, 61s,
          // ...) and drain it. The drain is where the executor banks the cup
          // points, so `results` and the series move together, as at a party.
          finish: (order) => {
            order.forEach((id, i) => raw.raceForceFinish(session, J(id), 60 + i));
            raw.raceUpdate(session, 16);
            const d = JSON.parse(raw.raceEventsLive(session, room, 'beach', 0, 0,
                                                    8000, 100000, 20000));
            perform(d.effects);
            return d.results;
          },
          nextRace: () => launch(raw.raceAdvanceLive),
          board: ({ over = false, results = null, autoAdvanceMs = 10000 } = {}) =>
            JSON.parse(raw.standingsLive(session, room, over ? 1 : 0,
                                         results == null ? null : J(results), autoAdvanceMs))
        };
      }
    };
  })());
}

// `color-mix(in srgb, C pct%, #fff)`, as the cup-wash and neutral-tint tests
// expect it. Re-derived here rather than read from the source under test: it is
// a per-channel lerp on the ENCODED values. Doing it in linear light instead is
// a one-line change that comes out visibly darker and would still pass a test
// that only compared the C++ to itself.
const mix = (hex, pct) => {
  const k = pct / 100;
  const ch = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(c * k + 255 * (1 - k));
  };
  return (ch(0) << 16) | (ch(1) << 8) | ch(2);
};

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
  // Progression rides the same rows (stars/locked, unlock progress on the one
  // locked cup) — asserted here at its FRESH-COUCH values: nothing loaded, so
  // zero stars everywhere and only the Playroom locked. The derivations behind
  // these numbers are pinned by the progression ctest; the loaded-record path
  // is the next test's.
  assert.deepEqual(got.cups, CUPS.map((c) => ({
    id: c.id, name: c.name, tracks: c.tracks,
    color: parseInt(CUP_COLOR[c.id].slice(1), 16),
    stars: 0, locked: c.id === 'rooftop',
    ...(c.id === 'rooftop' ? { unlockDone: 0, unlockNeed: CUPS.length - 1 } : {})
  })), 'cups, their display names, track order, paper colour and fresh progression come out as authored');
  assert.ok(!('tour' in got), 'the tour earns no badge — stars are the cups\' reward arc');
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

// The progression exports through the SHIPPED wasm — the abi ctest gates the
// same agreement on every leg, but only this file exercises the artifact the
// browser actually loads. Values here restate the decided rules (won=3,
// podium=2, finished=1; the Playroom opens on four finished cups) rather than
// deriving them, so a wasm that drifts from the decision fails loudly.
test('a loaded record stamps stars and the unlock onto the catalogue', async () => {
  const u = await ui_();
  u.progressLoad(JSON.stringify({
    v: 1,
    cups: { beach: { best: 1 }, snow: { best: 3 }, backyard: { best: 6 }, canyon: { best: 8 }, tour: { best: 2 } }
  }), false);
  try {
    const got = u.catalogue();
    const byId = Object.fromEntries(got.cups.map((c) => [c.id, c]));
    assert.equal(byId.beach.stars, 3, 'a win is three stars');
    assert.equal(byId.snow.stars, 2, 'a podium is two stars');
    assert.equal(byId.backyard.stars, 1, 'a finish is one star');
    assert.equal(byId.canyon.stars, 1);
    assert.ok(!('tour' in got), 'a stored "tour" row (the brief era it banked) derives nothing');
    assert.equal(byId.rooftop.locked, false, 'four finished cups unlock the Playroom');
    assert.ok(!('unlockDone' in byId.rooftop), 'unlock progress exists only while locked');
    assert.equal(u.progressJson(), JSON.stringify({
      cups: {
        backyard: { best: 6 }, beach: { best: 1 }, canyon: { best: 8 },
        snow: { best: 3 }, tour: { best: 2 }
      }, v: 1
    }), 'the read-back is the record, canonical and byte-stable');
  } finally {
    u.progressLoad(null, false);   // leave the fresh couch other tests assume
  }
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

  // The World Tour: the card shows the WHOLE ladder, one chip per cup in cup
  // (difficulty) order — ALL undrawn ("?"), the already-drawn first race
  // included, each wearing its own cup for the tint — but it only COUNTS the
  // unlocked cups. This test runs on a fresh couch, so the locked Playroom
  // ('rooftop') rides as a locked teaser chip and contributes no race; the
  // unlock rule itself is the progression ctest's.
  const openCups = CUPS.filter((c) => c.id !== 'rooftop');
  const tour = ui.cupSlot({ mode: 'tour', trackId: TRACK_LIST[0].id, cups: CUPS, catalog });
  assert.equal(tour.nameKey, 'tour');
  assert.equal(tour.name, null);
  assert.equal(tour.raceCount, openCups.length, 'the locked teaser is a chip, never a race');
  assert.equal(tour.difficulty, null, 'the tour spans the whole ladder — no single meter');
  assert.equal(tour.cupId, null, 'no single cup owns the card');
  assert.deepEqual(tour.maps.map((m) => m.trackId), CUPS.map(() => null),
    'every chip is undrawn — the drawn first included');
  assert.deepEqual(tour.maps.map((m) => m.cup), CUPS.map((c) => c.id),
    'each chip wears its cup, in cup order');
  assert.deepEqual(tour.maps.map((m) => !!m.locked), CUPS.map((c) => c.id === 'rooftop'),
    'the locked cup rides as a teaser chip, marked and nothing else');
});

test('the cup chip names the next race out of the shipped catalogue', async () => {
  const ui = await ui_();
  const { CUPS, TRACK_LIST } = await load('public/shared/tracks.js');
  const cup = CUPS[0];
  assert.ok(cup.tracks.length >= 3, 'premise: the cup has a race after next');

  // A real series, driven the way a party drives it. The chip's fields are
  // gathered off the handle in C++, so nothing here can hand it a cup id and a
  // "finished" that disagree — which is exactly how the first TV shell shipped
  // a podium that never said `final`.
  const gp = ui.cup({ id: cup.id, name: cup.name, tracks: cup.tracks });
  ui.advance(gp);                                   // race 2 of the cup is up
  const info = ui.seriesInfo(gp);
  assert.equal(info.nextTrackId, cup.tracks[2]);
  assert.equal(info.nextTrackName, TRACK_LIST.find((t) => t.id === cup.tracks[2]).name);
  assert.equal(info.final, false);

  // Run it out. A cup finishes when its LAST race is applied, and the chip must
  // follow: no next race queued, and the board it dresses is the podium.
  while (ui.gpState(gp).raceIndex < cup.tracks.length - 1) ui.advance(gp);
  ui.applyRace(gp, [{ playerId: 0, rank: 1, finished: true }], [{ peerIndex: 0, name: 'Ada' }]);
  const done = ui.seriesInfo(gp);
  assert.equal(done.nextTrackId, null, 'a finished cup queues nothing');
  assert.equal(done.nextTrackName, null);
  assert.equal(done.final, true);
});

test('the standings board keeps its wire key order', async () => {
  const ui = await ui_();

  // Ada races alone; Bo's phone arrives AFTER the launch, so he holds a seat
  // with no car — the only way to get a joining row now, because the late-joiner
  // list is subtracted from the live race inside C++ rather than handed in.
  const p = ui.party({ names: ['Ada'], pick: { mode: 'track', trackId: 'tidepool' } });
  const bo = p.join('Bo');
  const board = p.board({ over: true, results: p.finish([1]) });

  // The controller reads this by key, but the shape is a contract two languages
  // will implement, so pin it rather than leave it to whoever writes the struct.
  assert.deepEqual(Object.keys(board), ['over', 'hostPeerIndex', 'total', 'order']);
  assert.deepEqual(Object.keys(board.order[0]),
    ['playerId', 'name', 'colorIndex', 'ai', 'finished', 'time', 'racePlace']);
  assert.deepEqual(Object.keys(board.order[1]), ['playerId', 'name', 'colorIndex', 'joining']);
  assert.equal(board.total, board.order.length, 'total always counts the joining rows too');
  // The joining row is dressed from the ROOM record, not from the race field.
  assert.deepEqual(board.order[1], {
    playerId: bo, name: 'Bo', joining: true,
    colorIndex: p.roster().find((r) => r.peerIndex === bo).colorIndex
  });
  assert.equal(board.hostPeerIndex, 1, 'the host comes off the room election');

  // The cup half is ONE nested object composed here, never two sibling keys.
  // A cup pick is the whole difference: same walks, same board, one more key.
  const gp = ui.party({ names: ['Ada'], pick: { mode: 'cup', cupId: ui.CUPS[0].id } });
  const cupBoard = gp.board({ over: true, results: gp.finish([1]) });
  assert.deepEqual(Object.keys(cupBoard), ['over', 'hostPeerIndex', 'series', 'total', 'order']);
  assert.deepEqual(Object.keys(cupBoard.order[0]),
    ['playerId', 'name', 'colorIndex', 'ai', 'finished', 'time', 'racePlace', 'points', 'gained']);
});

test('a live cup board stays in race order; only the final board re-sorts', async () => {
  const ui = await ui_();
  const [ADA, BO] = [1, 2];
  const p = ui.party({ names: ['Ada', 'Bo'], pick: { mode: 'cup', cupId: ui.CUPS[0].id } });

  // Ada takes the first two races, so she leads the CUP while Bo goes on to win
  // the RACE this board is showing — the one state where the two orders
  // disagree, and the reason the board has two of them.
  for (let i = 0; i < 2; i++) { p.finish([ADA, BO]); p.nextRace(); }
  assert.deepEqual(p.seriesState().standings.map((r) => r.playerId), [ADA, BO],
    'premise: Ada leads the cup');

  // Mid-race, Bo has crossed first. The board is asked with the results in hand
  // but nothing banked yet — exactly the live push the shell makes per finish.
  const results = { results: [
    { playerId: BO, rank: 1, finished: true, time: 60 },
    { playerId: ADA, rank: 2, finished: true, time: 61 }
  ] };
  const live = p.board({ over: false, results });
  assert.deepEqual(live.order.map((r) => r.playerId), [BO, ADA],
    'mid-race the drama is who crossed the line');
  assert.ok(live.order.every((r) => r.gained === undefined), 'gains only appear on the final board');

  // Run it out for real: the drain banks Bo's 9 and Ada's 6 against the room's
  // series before the final board is composed, which is the order the corpus
  // pins. Ada still leads, so the final board re-sorts away from the race.
  const final = p.board({ over: true, results: p.finish([BO, ADA]) });
  assert.deepEqual(final.order.map((r) => r.playerId), [ADA, BO],
    'the final board tells the cup story');
  assert.deepEqual(final.order.map((r) => r.gained), [6, 9]);
  // …and the RACE the re-sort just hid survives on the rows, which is the only
  // way the board's first phase can still show who actually crossed first.
  assert.deepEqual(final.order.map((r) => r.racePlace), [2, 1]);

  const v = ui.resultsView(final, { intermissionMs: 10000 });
  assert.equal(v.twoPhase, true, 'a cup board has a race to show before the table');
  assert.deepEqual(v.raceRows.map((r) => r.playerId), [BO, ADA], 'phase 1 is the race');
  assert.deepEqual(v.listRows.map((r) => r.playerId), [ADA, BO], 'phase 2 is the cup');
  assert.deepEqual(v.raceRows.map((r) => r.kind), ['time_gain', 'time_gain'],
    'phase 1 shows the lap time AND what the place scored');
  // The two phases must lay out the SAME cells — time_gain and points differ by
  // the running total alone. A phase 1 of plain `time` rows is what made every
  // row change size the instant the shell started animating the re-sort.
  assert.deepEqual(v.listRows.map((r) => r.kind), ['points', 'points']);
  // Two races of 9/6 to Ada, then this one's 6/9 — so the totals climb 18→24
  // and 12→21 while the rows hold their order. pointsBefore is the count-up's
  // start, so no shell subtracts `gained` itself.
  assert.deepEqual(v.listRows.map((r) => r.pointsBefore), [18, 12]);
  assert.deepEqual(v.listRows.map((r) => r.points), [24, 21]);
});

test('the results overlay lists the whole field and medals the cup top three', async () => {
  const ui = await ui_();
  const row = (playerId, o = {}) => ({
    playerId, name: `P${playerId}`, colorIndex: 0, racePlace: playerId + 1, ...o
  });
  const board = {
    over: true, hostPeerIndex: 0,
    series: { cupName: 'Sunrise', final: true, endless: false, raceIndex: 3, raceCount: 4 },
    total: 5,
    order: [row(0), row(1), row(9, { joining: true }), row(2), row(3)]
  };
  const v = ui.resultsView(board, { intermissionMs: 10000 });
  assert.equal(v.podium, true);
  // Everyone is on the board. The old shape lifted the top three onto steps and
  // started the list at index 3 of the RAW order, so a joining row among the
  // first three dropped a racer off BOTH — P2 here landed on neither.
  assert.deepEqual(v.listRows.map((r) => r.playerId), [0, 1, 9, 2, 3]);
  // Medals rank the RACERS, so the joining row neither takes one nor shifts the
  // ones below it.
  assert.deepEqual(v.listRows.map((r) => r.medal || 0), [1, 2, 0, 3, 0]);
  assert.equal(v.next, null, 'a podium queues nothing');
  assert.equal(v.newGameKey, 'new_game');
});

test('the race phase is scaled off the intermission, never a flat hold', async () => {
  const ui = await ui_();
  const row = (playerId) => ({ playerId, name: `P${playerId}`, colorIndex: 0, racePlace: playerId + 1 });
  const board = {
    over: true, hostPeerIndex: 0,
    series: { cupName: 'Sunrise', final: false, endless: false, raceIndex: 1, raceCount: 4 },
    total: 2, order: [row(0), row(1)]
  };
  // A full intermission caps at the authored hold; a shrunk one (E2E drives the
  // budget down to milliseconds) takes a share of it instead, so the board can
  // never still be on phase 1 when the next race starts.
  assert.equal(ui.resultsView(board, { intermissionMs: 10000 }).racePhaseMs, 2600);
  assert.equal(ui.resultsView(board, { intermissionMs: 400 }).racePhaseMs, 120);

  const single = { over: true, hostPeerIndex: 0, total: 1, order: [row(0)] };
  const sv = ui.resultsView(single, { intermissionMs: 10000 });
  assert.equal(sv.twoPhase, false, 'a single race has no cup table to become');
  assert.deepEqual(sv.raceRows, []);
  assert.equal(sv.racePhaseMs, 0);
});

// The auto-pause pair is gone from here with its ABI spelling. The consult rule
// and the decision are one walk now (ttp_race_auto_pause_live_json), which reads
// the participant set through the synced seam itself — there is no "did it ask"
// for a shell to observe, which was the whole of what this asserted. The rule
// stays gated in C++: runtimetest/ui_check.cc replays it against the frozen ui
// corpus, and runtimetest/abi_check.cc holds the walk to it over live handles.

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

  for (const [id, hex] of Object.entries(CUP_COLOR)) {
    for (const pct of [0, FIELD_TINT, 45, 72, 100]) {
      assert.equal(u.cupTintRgb(id, pct), mix(hex, pct) >>> 0,
        `${id} at ${pct}% disagrees with an sRGB lerp`);
    }
  }
  // An UNKNOWN cup id washes the fallback rather than black. Note that is a cup
  // COLOUR — the tile a cup-less selection wears is the neutral below, and the
  // two being different is the whole point of there being two exports.
  assert.equal(u.cupTintRgb(null, FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
  assert.equal(u.cupTintRgb('', FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
  assert.equal(u.cupTintRgb('no-such-cup', FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
});

test('the neutral tint mirrors neutralTint, and is NOT the cup fallback', async () => {
  const u = await ui_();
  const { NEUTRAL_COLOR, CUP_COLOR_FALLBACK, FIELD_TINT } =
    await load('public/shared/trackPicker.js');
  for (const pct of [0, FIELD_TINT, 45, 72, 100]) {
    assert.equal(u.neutralTintRgb(pct), mix(NEUTRAL_COLOR, pct) >>> 0,
      `the neutral wash at ${pct}% disagrees with an sRGB lerp`);
  }
  // THE POINT OF THE SECOND EXPORT. A shell that reached for cupTintRgb(null)
  // here would paint Random in the Backyard cup's lawn green — a real colour,
  // on a real tile, standing for a cup the selection has nothing to do with.
  assert.notEqual(u.neutralTintRgb(FIELD_TINT), mix(CUP_COLOR_FALLBACK, FIELD_TINT) >>> 0);
});

test('a pct outside 0..100 is clamped, not wrapped', async () => {
  // It arrives from a shell. Wrapping the channel arithmetic would produce a
  // colour nobody authored, and it would look deliberate.
  const u = await ui_();
  assert.equal(u.cupTintRgb('beach', -50), u.cupTintRgb('beach', 0));
  assert.equal(u.cupTintRgb('beach', 500), u.cupTintRgb('beach', 100));
});
