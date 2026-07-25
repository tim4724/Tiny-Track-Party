'use strict';
// Party C ABI conformance gate. Loads the browser wasm module
// (public/display/engine/native/ttp_runtime.mjs, built by native/scripts/
// build-runtime-web.sh) in Node and replays the FULL RoomFlow behavioural corpus
// THROUGH THE ABI — the same oracle native/partytest/roomflow_check.cc replays
// against the C++ objects directly, but crossing the extern "C" boundary the
// browser adapter actually uses.
//
// This is the layer the corpus check cannot reach: JSON-scalar peer identity
// (numeric 3 vs "3"), the event QUEUE standing in for RoomFlow's emit callback
// (exact intra-op order preserved across the boundary), scratch-buffer lifetime,
// and config marshalling. If the ABI mangles any of it, a step diverges here even
// though roomflow_check is green.
//
// Also covers ttp_room_lowest_free_slot (the display's colour-slot allocator).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');
const WASM = path.join(ROOT, 'public/display/engine/native/ttp_runtime.wasm');
const CORPUS = path.join(ROOT, 'tests/fixtures/roomflow-corpus.jsonl');

const skip = (fs.existsSync(MJS) && fs.existsSync(WASM))
  ? false
  : 'ttp_runtime.mjs/.wasm not built — run native/scripts/build-runtime-web.sh';

// A peer id crosses the ABI as a JSON scalar ("3" numeric, "\"a\"" string).
const idJson = (v) => JSON.stringify(v === undefined ? null : v);

// Recursive key sort, so ABI JSON and recorded JSON compare structurally
// regardless of key order (the ABI already emits canonical, but the recorded
// side comes from JSON.stringify with authored order).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

test('party ABI replays the RoomFlow corpus through the C boundary', { skip }, async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const abi = {
    create: cw('ttp_room_create', 'number', ['string']),
    dispose: cw('ttp_room_dispose', null, ['number']),
    reset: cw('ttp_room_reset', null, ['number']),
    addPlayer: cw('ttp_room_add_player', 'string', ['number', 'string', 'string']),
    removePlayer: cw('ttp_room_remove_player', null, ['number', 'string']),
    rekey: cw('ttp_room_rekey', 'number', ['number', 'string', 'string']),
    setField: cw('ttp_room_set_field', 'number', ['number', 'string', 'string', 'string']),
    markDisc: cw('ttp_room_mark_disconnected', null, ['number', 'string']),
    markReconn: cw('ttp_room_mark_reconnected', null, ['number', 'string']),
    clearDisc: cw('ttp_room_clear_disconnected', null, ['number', 'number', 'number']),
    transitionTo: cw('ttp_room_transition_to', 'number', ['number', 'string']),
    state: cw('ttp_room_state', 'string', ['number']),
    setActiveOrder: cw('ttp_room_set_active_order', null, ['number', 'string']),
    onSeen: cw('ttp_room_on_seen', null, ['number', 'string', 'number']),
    isExpired: cw('ttp_room_is_expired', 'number', ['number', 'string', 'number']),
    expiredPeers: cw('ttp_room_expired_peers_json', 'string', ['number', 'number']),
    allDisconnected: cw('ttp_room_all_participants_disconnected', 'number', ['number']),
    hasLateJoiners: cw('ttp_room_has_late_joiners', 'number', ['number']),
    graceTick: cw('ttp_room_grace_tick', 'number', ['number', 'number']),
    setMaster: cw('ttp_room_set_master', null, ['number', 'string']),
    setLivenessEnabled: cw('ttp_room_set_liveness_enabled', null, ['number', 'number']),
    host: cw('ttp_room_host_json', 'string', ['number']),
    isHost: cw('ttp_room_is_host', 'number', ['number', 'string']),
    size: cw('ttp_room_size', 'number', ['number']),
    connectedCount: cw('ttp_room_connected_count', 'number', ['number']),
    list: cw('ttp_room_list_json', 'string', ['number']),
    has: cw('ttp_room_has', 'number', ['number', 'string']),
    isDisconnected: cw('ttp_room_is_disconnected', 'number', ['number', 'string']),
    get: cw('ttp_room_get_json', 'string', ['number', 'string']),
    events: cw('ttp_room_events_json', 'string', ['number']),
    lowestFreeSlot: cw('ttp_room_lowest_free_slot', 'number', ['string', 'number']),
    version: cw('ttp_party_version', 'string', [])
  };

  assert.deepEqual(JSON.parse(abi.version()), { contractVersion: 2, layer: 'party' });

  const lines = fs.readFileSync(CORPUS, 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0]);
  let scripts = 0, steps = 0, slotCases = 0;

  for (const line of lines.slice(1)) {
    const rec = JSON.parse(line);

    // lowestFreeSlot lines (static helper, no handle)
    if (rec.slotCase) {
      const { used, max, expect } = rec.slotCase;
      assert.equal(abi.lowestFreeSlot(JSON.stringify(used), max), expect,
        `lowestFreeSlot(${JSON.stringify(used)}, ${max})`);
      slotCases++;
      continue;
    }

    // ---- build the room from the recorded config ----
    const cfg = {};
    if (rec.config.useMasterProvider) cfg.master = rec.config.master ?? null;
    if (rec.config.liveness) cfg.liveness = rec.config.liveness;
    const h = abi.create(JSON.stringify(cfg));
    assert.ok(h > 0, 'ttp_room_create returned a handle');
    scripts++;

    for (const [si, step] of rec.steps.entries()) {
      const op = step.op;
      let ret = null;

      switch (op.op) {
        case 'add':
          ret = JSON.parse(abi.addPlayer(h, idJson(op.p), JSON.stringify(op.fields ?? {})));
          break;
        case 'remove': abi.removePlayer(h, idJson(op.p)); break;
        case 'rekey': ret = abi.rekey(h, idJson(op.oldId), idJson(op.newId)) === 1; break;
        case 'markDisc': abi.markDisc(h, idJson(op.p)); break;
        case 'markReconn': abi.markReconn(h, idJson(op.p)); break;
        case 'clearDisc':
          abi.clearDisc(h, op.t === undefined ? 0 : 1, op.t ?? 0);
          break;
        case 'transition': ret = abi.transitionTo(h, op.to) === 1; break;
        case 'endGame': ret = abi.transitionTo(h, 'results') === 1; break;
        case 'returnToLobby': ret = abi.transitionTo(h, 'lobby') === 1; break;
        case 'setOrder': abi.setActiveOrder(h, JSON.stringify(op.order ?? [])); break;
        case 'seen': abi.onSeen(h, idJson(op.p), op.t); break;
        case 'isExpired': ret = abi.isExpired(h, idJson(op.p), op.t) === 1; break;
        case 'expiredPeers': ret = JSON.parse(abi.expiredPeers(h, op.t)); break;
        case 'graceTick': ret = abi.graceTick(h, op.t) === 1; break;
        case 'setMaster': abi.setMaster(h, idJson(op.v)); break;
        case 'setLivenessEnabled': abi.setLivenessEnabled(h, op.v ? 1 : 0); break;
        case 'reset': abi.reset(h); break;
        case 'setField': {
          // The display's direct live-record write, as an ABI call.
          const applied = abi.setField(h, idJson(op.p), op.key, JSON.stringify(op.value ?? null)) === 1;
          const rec = applied ? JSON.parse(abi.get(h, idJson(op.p))) : null;
          ret = rec ? (rec[op.key] ?? null) : null;
          break;
        }
        default: throw new Error(`unknown op ${op.op}`);
      }

      // Events emitted during THIS op, in order (the queue drains per op, so
      // ordering across the boundary is asserted, not just membership).
      const events = JSON.parse(abi.events(h));
      if (step.events !== undefined) {
        assert.ok(same(events, step.events),
          `${rec.name} step ${si} (${op.op}) events\n  want ${JSON.stringify(step.events)}\n  got  ${JSON.stringify(events)}`);
      }
      if (step.ret !== undefined && step.ret !== null) {
        assert.ok(same(ret, step.ret),
          `${rec.name} step ${si} (${op.op}) ret\n  want ${JSON.stringify(step.ret)}\n  got  ${JSON.stringify(ret)}`);
      }

      // Public-surface digest, exactly as the corpus records it.
      if (step.digest !== undefined) {
        const d = step.digest;
        assert.equal(abi.state(h), d.state, `${rec.name} step ${si} state`);
        assert.ok(same(JSON.parse(abi.host(h)), d.host), `${rec.name} step ${si} host`);
        assert.equal(abi.size(h), d.size, `${rec.name} step ${si} size`);
        assert.equal(abi.connectedCount(h), d.connectedCount, `${rec.name} step ${si} connectedCount`);
        assert.ok(same(JSON.parse(abi.list(h)), d.list), `${rec.name} step ${si} list`);
        assert.equal(abi.allDisconnected(h) === 1, d.allDisconnected, `${rec.name} step ${si} allDisconnected`);
        assert.equal(abi.hasLateJoiners(h) === 1, d.hasLateJoiners, `${rec.name} step ${si} hasLateJoiners`);
        for (const pp of d.perPeer) {
          const pj = idJson(pp.p);
          assert.equal(abi.has(h, pj) === 1, pp.has, `${rec.name} step ${si} has(${pj})`);
          assert.equal(abi.isHost(h, pj) === 1, pp.isHost, `${rec.name} step ${si} isHost(${pj})`);
          assert.equal(abi.isDisconnected(h, pj) === 1, pp.disc, `${rec.name} step ${si} disc(${pj})`);
        }
      }
      steps++;
    }
    abi.dispose(h);
  }

  assert.equal(scripts, header.scripts, 'every corpus script replayed');
  assert.equal(slotCases, header.slotCases, 'every lowestFreeSlot case replayed');
  console.info(`[party-abi] ${scripts} scripts / ${steps} steps / ${slotCases} slot cases through the ABI`);
});

// ---------------------------------------------------------------------------
// Relay framing through the ABI. Replays tests/fixtures/framing-corpus.jsonl —
// the same oracle native/partytest/framing_check.cc uses — but crossing the C
// boundary: string marshalling, the per-entry-point scratch buffers, and
// classify taking RAW socket text instead of a parsed object.
// ---------------------------------------------------------------------------
test('party ABI reproduces the relay-framing corpus', { skip }, async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const f = {
    create: cw('ttp_framing_encode_create', 'string', ['string', 'number', 'string']),
    join: cw('ttp_framing_encode_join', 'string', ['string', 'string']),
    sendTo: cw('ttp_framing_encode_send_to', 'string', ['string', 'string']),
    broadcast: cw('ttp_framing_encode_broadcast', 'string', ['string']),
    setState: cw('ttp_framing_encode_set_state', 'string', ['string']),
    closeRoom: cw('ttp_framing_encode_close_room', 'string', []),
    classify: cw('ttp_framing_classify', 'string', ['string']),
    closeOutcome: cw('ttp_framing_close_outcome', 'string', ['number', 'number', 'number', 'number', 'number']),
    backoff: cw('ttp_framing_backoff_ms', 'number', ['number']),
    pinUrl: cw('ttp_framing_pin_url', 'string', ['string', 'string', 'string'])
  };

  const lines = fs.readFileSync(path.join(ROOT, 'tests/fixtures/framing-corpus.jsonl'), 'utf8')
    .trim().split('\n').slice(1);
  let n = 0;
  for (const line of lines) {
    const r = JSON.parse(line);
    const label = `${r.op}${r.kind ? ':' + r.kind : ''}`;
    if (r.op === 'encode') {
      let got;
      if (r.kind === 'create') got = f.create(r.clientId, r.maxClients, r.url ?? null);
      else if (r.kind === 'join') got = f.join(r.clientId, r.room);
      else if (r.kind === 'sendTo') got = f.sendTo(JSON.stringify(r.to), JSON.stringify(r.data));
      else if (r.kind === 'broadcast') got = f.broadcast(JSON.stringify(r.data));
      else if (r.kind === 'setState') got = f.setState(JSON.stringify(r.data));
      else if (r.kind === 'closeRoom') got = f.closeRoom();
      else throw new Error('unknown encode kind ' + r.kind);
      assert.ok(same(JSON.parse(got), r.expect), `${label}: ${got}`);
    } else if (r.op === 'classify') {
      // The ABI takes the raw text the socket delivered, exactly as the adapter does.
      const got = JSON.parse(f.classify(JSON.stringify(r.wire)));
      assert.equal(got.route, r.expect.route, `${label}: route`);
      for (const k of ['from', 'data', 'type', 'msg']) {
        if (k in r.expect) assert.ok(same(got[k], r.expect[k]), `${label}: ${k}`);
      }
    } else if (r.op === 'close') {
      const got = JSON.parse(f.closeOutcome(
        r.hasCode ? 1 : 0, r.code ?? 0, r.attemptBefore, r.maxAttempts, r.shouldReconnectBefore ? 1 : 0));
      assert.ok(same(got, r.expect), `${label}: ${JSON.stringify(got)}`);
    } else if (r.op === 'backoff') {
      assert.equal(f.backoff(r.attempt), r.expect, `${label}(${r.attempt})`);
    } else if (r.op === 'pin') {
      assert.equal(f.pinUrl(r.base, r.room, r.instance ?? ''), r.expect, `${label}(${r.room})`);
    } else {
      throw new Error('unknown op ' + r.op);
    }
    n++;
  }
  console.info(`[party-abi] ${n} framing cases through the ABI`);
});

// ---------------------------------------------------------------------------
// Fastlane netcode through the ABI. Replays tests/fixtures/fastlane-corpus.jsonl.
// The ABI deliberately exposes no ring/seq internals (fastlane_check covers those
// against the C++ objects), so this compares the OBSERVABLE contract: the enqueue
// return, the packet to write, the events to apply, the RTT sample, and the stats
// counters. Ring state still shows through indirectly, since each packet's ps/h
// reflect it.
// ---------------------------------------------------------------------------
test('party ABI reproduces the fastlane netcode corpus', { skip }, async () => {
  const factory = (await import(pathToFileURL(MJS).href)).default;
  const M = await factory();
  const cw = (n, ret, args) => M.cwrap(n, ret, args);
  const L = {
    create: cw('ttp_link_create', 'number', []),
    dispose: cw('ttp_link_dispose', null, ['number']),
    setOpen: cw('ttp_link_set_channel_open', null, ['number', 'number']),
    enqueue: cw('ttp_link_enqueue', 'string', ['number', 'string', 'number']),
    sendTick: cw('ttp_link_send_tick', 'string', ['number', 'number']),
    idle: cw('ttp_link_idle', 'string', ['number', 'number']),
    inbound: cw('ttp_link_inbound', 'string', ['number', 'string', 'number']),
    stats: cw('ttp_link_stats_json', 'string', ['number'])
  };

  const lines = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fastlane-corpus.jsonl'), 'utf8')
    .trim().split('\n');
  let scripts = 0, steps = 0;
  for (const line of lines.slice(1)) {
    const rec = JSON.parse(line);
    const h = L.create();
    assert.ok(h > 0, 'ttp_link_create returned a handle');
    scripts++;
    for (const [si, step] of rec.steps.entries()) {
      const op = step.op;
      let oc = null;
      if (op.op === 'enqueue') oc = JSON.parse(L.enqueue(h, JSON.stringify(op.ev), op.t));
      else if (op.op === 'sendTick') oc = JSON.parse(L.sendTick(h, op.t));
      else if (op.op === 'idle') oc = JSON.parse(L.idle(h, op.t));
      else if (op.op === 'recv') oc = JSON.parse(L.inbound(h, JSON.stringify(op.packet), op.t));
      else if (op.op === 'closeChannel') L.setOpen(h, 0);
      else throw new Error('unknown op ' + op.op);

      const where = `${rec.name} step ${si} (${op.op})`;
      if (oc) {
        assert.ok(same(oc.packet, step.sent), `${where}: packet\n  want ${JSON.stringify(step.sent)}\n  got  ${JSON.stringify(oc.packet)}`);
        assert.ok(same(oc.applied, step.applied), `${where}: applied`);
        assert.ok(same(oc.rtt, step.rtt), `${where}: rtt`);
        if (op.op === 'enqueue') {
          assert.equal(oc.dropped ? 'dropped' : 'p2p', step.ret, `${where}: enqueue return`);
        }
      }
      const st = JSON.parse(L.stats(h));
      assert.equal(st.out, step.digest.out, `${where}: stats.out`);
      assert.equal(st.received, step.digest.received, `${where}: stats.received`);
      assert.equal(st.lastPsSeen, step.digest.lastPsSeen, `${where}: stats.lastPsSeen`);
      steps++;
    }
    L.dispose(h);
  }
  console.info(`[party-abi] ${scripts} fastlane scripts / ${steps} steps through the ABI`);
});
