// END-TO-END: a real party, against a real tvOS app, over the real relay.
//
// WHAT THIS COVERS THAT NOTHING ELSE DOES. Every game rule is C++ and already
// gated four ways, and `tests/wire-compat/` pins the C++ against the real JS
// controller byte for byte. None of that sees the SWIFT: PartyNet's room
// lifecycle, the payloads GameCoordinator composes, and what the app does when
// it exits are a shell, and a shell is exactly the part a corpus cannot replay.
// Two shipped bugs came out of that gap in one session — a chooser payload with
// invented key names, and a `shutdown()` that was documented as wired and called
// by nothing — and neither was visible to any test in the tree.
//
// So the assertions here are about the WIRE a phone actually sees, and are
// deliberately the ones a person would make holding a handset: can I join, is
// there something to pick, does the big screen answer, and when the app goes
// away does the room go with it.
//
// USAGE
//   node scripts/tvos-party-check.mjs                 # device (auto-detected)
//   node scripts/tvos-party-check.mjs --sim           # tvOS simulator
//   node scripts/tvos-party-check.mjs --keep          # leave the app running
//   node scripts/tvos-party-check.mjs --full          # + race it to the flag
//
// IT IS NOT AN `npm test` ENTRY, and cannot be: it needs an Apple TV (or a
// booted simulator) and the public relay. `npm test` stays hermetic and fast.
// What IS in `npm test` is `tests/chooser-contract.test.js`, which pins the one
// thing here that can be checked from source alone.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Phone, loadProtocol } from './lib/phone.mjs';

const BUNDLE_ID = 'com.couchgames.tinytrackparty';
const args = process.argv.slice(2);
const SIM = args.includes('--sim');
const KEEP = args.includes('--keep');
const FULL = args.includes('--full');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '[32mPASS[0m' : '[31mFAIL[0m'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sh = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' });

// ---- the app under test -----------------------------------------------------

function deviceId() {
  // `State` reads `connected` (not `available`) for a paired Apple TV that is
  // awake; matching only `available` finds nothing and reads as "no device".
  const out = sh('xcrun', ['devicectl', 'list', 'devices']);
  const row = out.split('\n').find((l) => /Apple TV/.test(l) && /connected|available/.test(l));
  if (!row) throw new Error('no Apple TV found — is it awake and paired?');
  return row.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i)[1];
}

/// Launch, and stream stdout to a file. The ROOM CODE is read back out of that
/// stream: a TV has no address bar, and reading the code off the screen with a
/// camera is not a thing a script can do.
function launchApp(logPath) {
  rmSync(logPath, { force: true });
  const out = openSync(logPath, 'w');
  const argv = SIM
    ? ['simctl', 'launch', '--console-pty', 'booted', BUNDLE_ID]
    : ['devicectl', 'device', 'process', 'launch', '--device', deviceId(),
       '--console', '--terminate-existing', BUNDLE_ID];
  const child = spawn('xcrun', argv, { stdio: ['ignore', out, out] });
  child.unref();
  return child;
}

/// The LAST room code the app logged, optionally waiting for one that is not
/// `notThis`. The app prints every room it warms, so a resume appends a second
/// line to the same stream — matching the last rather than the first is what
/// lets one log serve the whole run.
async function waitForRoom(logPath, timeout = 60000, notThis = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const all = [...readFileSync(logPath, 'utf8').matchAll(/\[ttp\] room ([A-Za-z0-9]+) — (\S+)/g)];
      const last = all[all.length - 1];
      if (last && (!notThis || last[1] !== notThis)) return { room: last[1], url: last[2] };
    }
    await sleep(500);
  }
  throw new Error(notThis ? 'the app never warmed a room other than ' + notThis
                          : 'the app never logged a room code');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Send the app to the background, the way a viewer pressing Home does.
///
/// BY LAUNCHING ANOTHER APP, because neither `devicectl` nor `simctl` can press
/// Home on a TV. Backgrounding is the case that matters and a force-kill is NOT
/// a substitute for it: SIGKILL runs no code at all, so it exercises the CRASH
/// path (where the room is supposed to survive and the next launch regathers it)
/// and would report the graceful teardown as broken no matter how well it works.
function backgroundApp() {
  if (SIM) { sh('xcrun', ['simctl', 'launch', 'booted', 'com.apple.TVSettings']); return; }
  sh('xcrun', ['devicectl', 'device', 'process', 'launch',
               '--device', deviceId(), '--terminate-existing', 'com.apple.TVSettings']);
}

/// Bring the game back to the front WITHOUT `--terminate-existing`, so this is a
/// genuine resume of the suspended process rather than a cold launch. The
/// distinction is the whole point: a cold launch would exercise
/// `restoreRoom()`, and what needs proving is that coming back from a
/// backgrounded party warms a fresh room.
function foregroundApp() {
  if (SIM) { sh('xcrun', ['simctl', 'launch', 'booted', BUNDLE_ID]); return; }
  sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', deviceId(), BUNDLE_ID]);
}

// ---- the party --------------------------------------------------------------

async function main() {
  const proto = await loadProtocol();
  const logPath = join(tmpdir(), `ttp-party-check-${SIM ? 'sim' : 'device'}.log`);

  console.log(`\n== launching ${SIM ? 'simulator' : 'device'} app ==`);
  // WIND DOWN ANY RUNNING INSTANCE FIRST, gracefully. `launchApp` passes
  // `--terminate-existing`, which is a SIGKILL and therefore a CRASH as far as
  // the app is concerned — so the crash-recovery blob survives and the new
  // launch correctly REJOINS the old room, stale seats and all. That is the
  // right product behaviour and the wrong starting state for a check: it opens
  // on somebody else's party, with a host that is not us. Backgrounding first
  // ends the party properly and drops the blob, so the launch below is cold.
  backgroundApp();
  await sleep(2500);
  // SIM ONLY: plant a crash-recovery blob naming a room the relay never had, so
  // this boot takes the join-refused -> fresh-create fallback. That path once
  // wedged the shell for real: the replaced socket's last receive re-armed on
  // the NEW connection and ate one inbound frame (RelaySocket.receive's guard),
  // which after a fallback create was always the first heartbeat echo — so the
  // canary re-minted the room every few seconds and every QR was stale by the
  // time a phone scanned it. Booting the WHOLE suite through the fallback keeps
  // that path load-bearing; the stability re-read below is the direct assert.
  if (SIM) {
    const dir = sh('xcrun', ['simctl', 'get_app_container', 'booted', BUNDLE_ID, 'data']).trim();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'Library/Caches'), { recursive: true });
    writeFileSync(join(dir, 'Library/Caches/tinytrack_display_room.json'),
      JSON.stringify({ room: 'zzZZzz', instance: null, clientId: 'display-party-check-dead-room' }));
  }
  launchApp(logPath);
  const { room, url } = await waitForRoom(logPath);
  console.log(`   room ${room} — ${url}\n`);
  if (SIM) {
    await sleep(6000);   // past the heartbeat window a re-minting canary fires in
    const now = await waitForRoom(logPath);
    check('the dead-room fallback lands in ONE stable room', now.room === room,
      now.room === room ? room : `was ${room}, re-minted ${now.room}`);
  }

  console.log('== a phone scans the QR ==');
  const alice = new Phone(proto, { name: 'Alice' });
  await alice.join(room);
  check('the relay accepts the join', alice.peerIndex != null,
    alice.relayErrors.join(', ') || `peerIndex ${alice.peerIndex}`);

  // HELLO GOES OUT AT ONCE, because that is what the real controller does
  // (`public/controller/Net.js` sends it straight off `joined`) and the ordering
  // is load-bearing rather than incidental. A phone that waited for the snapshot
  // first would deadlock against a display that only publishes on a roster
  // change: the relay has nothing retained yet in a brand-new room, so the seat
  // this HELLO creates IS what triggers the first publish.
  alice.hello();

  // The retained snapshot: pushed on every change and replayed to each later
  // (re)joiner. This is the assertion that would have caught a display that
  // published nothing at all.
  await alice.waitFor(() => alice.snapshot != null, 'the retained snapshot');
  const s = alice.snapshot;
  check('the display has published a retained snapshot', !!s);

  // THE CHOOSER, field by field. Each of these was undefined in the shipped
  // build and each cost a visible piece of the phone's UI.
  const car = (s.cars || [])[0];
  const track = (s.tracks || [])[0];
  check('cars carry an id (the picker loads images by it)', typeof car?.id === 'string', car?.id);
  check('cars carry a name', typeof car?.name === 'string', car?.name);
  check('cars carry handling stats', typeof car?.stats?.accel === 'number');
  check('the livery palette is present', (s.colors || []).length > 0, `${(s.colors || []).length} colours`);
  check('tracks are present', (s.tracks || []).length > 0, `${(s.tracks || []).length} tracks`);
  check('tracks carry a packed mini-map (`svg`)', typeof track?.svg === 'string' && track.svg.length > 0);
  check('tracks carry a cup (the mode picker groups by it)', typeof track?.cup === 'string', track?.cup);
  check('tracks carry a cup NAME', typeof track?.cupName === 'string', track?.cupName);

  // A FRESH ROOM IS A LOBBY WITH NO RESULTS. A non-null standings is what raises
  // the phone's results overlay, so a new party that arrives carrying one shows
  // "the race has ended" to somebody who just walked in.
  check('a fresh room is in the lobby', s.roomState === 'lobby', `roomState=${s.roomState}`);
  check('a fresh room has no standings board', s.standings == null,
    s.standings ? 'stale results would raise the phone’s "race over" overlay' : 'null');

  console.log('\n== the phone takes a seat ==');
  await alice.waitFor(() => alice.seat != null, 'our seat to appear in the roster');
  check('HELLO seats us', alice.seat != null, JSON.stringify(alice.seat));
  // WAITED FOR, not read once. The seat can appear from `peer_joined` carrying
  // the display's placeholder ("Player 1") a beat before the HELLO's name lands,
  // so asserting on the first roster that mentions us tests the arrival order
  // rather than the rename.
  let named = true;
  try {
    await alice.waitFor(() => alice.seat?.name === 'Alice', "HELLO's name to reach the roster", 6000);
  } catch { named = false; }
  check('HELLO renames the seat', named, `name=${alice.seat?.name}`);

  console.log('\n== the phone picks a car ==');
  // carIndex ONLY: the livery is display-assigned and a phone never sends one
  // (`public/controller/main.js` sends `{carIndex}` and reads `colorIndex` back).
  alice.setCar(1);
  let picked = true;
  try {
    await alice.waitFor(() => alice.seat?.carIndex === 1, 'the car pick to land', 6000);
  } catch { picked = false; }
  check('SET_CAR moves the seat', picked, `car ${alice.seat?.carIndex}`);
  check('the display still owns the livery', typeof alice.seat?.colorIndex === 'number',
    `colour ${alice.seat?.colorIndex}`);

  // The HOST is the first seat, and only the host may ready-up in this shell's
  // rules; the guard is the model's (`ttp_net_set_ready`).
  const amHost = s.hostPeerIndex === alice.peerIndex || alice.snapshot.hostPeerIndex === alice.peerIndex;
  check('the first phone is the host', amHost, `host=${alice.snapshot.hostPeerIndex}, me=${alice.peerIndex}`);

  console.log('\n== a second phone joins ==');
  const bob = new Phone(proto, { name: 'Bob' });
  await bob.join(room);
  bob.hello();
  await bob.waitFor(() => bob.seat != null, "Bob's seat");
  check('a second phone gets its own seat', bob.seat?.peerIndex !== alice.peerIndex,
    `Alice ${alice.peerIndex}, Bob ${bob.peerIndex}`);
  await alice.waitFor(() => (alice.snapshot.players || []).length === 2,
    'the roster to reach both phones');
  check('both phones see the same two-seat roster',
    (alice.snapshot.players || []).length === 2 && (bob.snapshot.players || []).length === 2);
  check('the seats have distinct liveries',
    new Set((alice.snapshot.players || []).map((p) => p.colorIndex)).size === 2);

  console.log('\n== the host picks a cup ==');
  alice.selectMode({ mode: 'cup', cupId: track.cup });
  await alice.waitFor(() => alice.snapshot.cupId === track.cup, 'the cup pick to publish');
  check('SELECT_MODE resolves a concrete track', alice.snapshot.trackId != null,
    `mode=${alice.snapshot.mode}, cup=${alice.snapshot.cupId}, track=${alice.snapshot.trackId}`);

  // ---- AND THE RACE ACTUALLY STARTS ---------------------------------------
  //
  // The check that was missing, and its absence is why a shell that could not
  // start a race at all passed everything: the screenshot harness reaches
  // `ttp_race_launch_json` DIRECTLY, so every race screen photographed
  // beautifully while the only road a phone can take was broken end to end.
  // Nothing that photographs a screen can tell you a button works.
  console.log('\n== the guest readies up ==');
  // The GUEST readies; the host never does, because the host's Start IS their
  // commitment (`ttp_ui_all_racers_ready`). Asserting the host's flag stays
  // false is what keeps a future "fix" from making the host ready themselves
  // and quietly requiring two presses.
  bob.setReady(true);
  let readied = true;
  try {
    await bob.waitFor(() => bob.seat?.ready === true, 'the ready flag to land', 8000);
  } catch { readied = false; }
  check('SET_READY marks a guest ready', readied, `ready=${bob.seat?.ready}`);
  check('the host does not ready up', alice.seat?.ready === false, `host ready=${alice.seat?.ready}`);

  console.log('\n== the host starts the race ==');
  alice.startGame();
  let started = true;
  try {
    // The room leaving the lobby is the display committing: `ttp_race_launch_json`
    // transitions to COUNTDOWN, and the snapshot that carries it is the phones'
    // signal to put a steering wheel up.
    await alice.waitFor(() => alice.snapshot.roomState !== 'lobby',
      'the room to leave the lobby', 15000);
  } catch { started = false; }
  check('START_GAME starts the race', started, `roomState=${alice.snapshot.roomState}`);

  if (started) {
    check('the racers are marked in-race', (alice.snapshot.players || []).some((p) => p.inRace),
      JSON.stringify((alice.snapshot.players || []).map((p) => ({ n: p.name, inRace: p.inRace }))));
    // The countdown is a direct message, not a snapshot field — a phone that
    // never gets it shows a lobby while the TV counts down.
    let counted = true;
    try {
      await alice.waitFor(() => alice.received(proto.MSG.COUNTDOWN).length > 0,
        'a COUNTDOWN message', 8000);
    } catch { counted = false; }
    check('phones are sent the countdown', counted,
      JSON.stringify(alice.received(proto.MSG.COUNTDOWN)[0] ?? null));

    // GO. The room reaching `playing` is the sim actually ticking.
    let racing = true;
    try {
      await alice.waitFor(() => alice.snapshot.roomState === 'playing',
        'the countdown to reach GO', 20000);
    } catch { racing = false; }
    check('the countdown reaches GO', racing, `roomState=${alice.snapshot.roomState}`);

    // --full: race it to the flag. Off by default because it is minutes rather
    // than seconds — the AI fast-forward burst fires only when every HUMAN is
    // home, and a scripted phone cannot finish a lap (see the note on the burst
    // below), so the bots run their remaining laps in real time — but it is the
    // only thing that covers the finish at all: endRace, the standings board,
    // and the results phase.
    if (FULL && racing) {
      console.log('   driving to the flag (a few minutes: a scripted phone cannot finish, so the race runs to its own end)');
      // Both phones hold the wheel with a slow weave, which is enough to get a
      // car round and also exercises the CONTROL path end to end.
      // A slow weave rather than a straight line: it exercises the CONTROL
      // path with changing values, which is what a real handset sends. It is
      // not trying to drive well — see the note on the board check below.
      const weave = (t) => Math.sin(t / 900) * 0.55;
      const driving = Promise.all([alice.drive(240000, weave), bob.drive(240000, weave)]);
      let done = true;
      try {
        await alice.waitFor(() => alice.snapshot.roomState === 'results',
          'the race to reach its results board', 300000);
      } catch { done = false; }
      alice.stopDriving(); bob.stopDriving();
      await driving.catch(() => {});
      check('the race reaches a results board', done, `roomState=${alice.snapshot.roomState}`);

      // WAITED FOR, not read off the phase flip. The board is published by its
      // own effect (points are banked BEFORE it goes out), so it lands a beat
      // after `results` — reading it the instant the phase changes tests the
      // ordering of two publishes rather than whether the board exists.
      let boarded = true;
      try {
        await alice.waitFor(() => alice.snapshot.standings != null,
          'the standings board to reach the phones', 20000);
      } catch { boarded = false; }
      check('the standings ride the snapshot', boarded,
        boarded ? 'present' : 'MISSING — phones show no results');

      // BOTH HUMANS ARE ON THE BOARD, which is all this can honestly claim
      // about them. `playerId` is the CAR's id — the peer index for a human
      // seat — compared loosely because an engine identity crosses as a JSON
      // scalar and may be a number or a string.
      //
      // WHETHER STEERING REACHED THE SIM IS NOT ASSERTABLE FROM HERE, and it is
      // worth being exact about why rather than shipping a check that looks
      // like it covers input. A phone is told nothing about where its car is:
      // no pose, no lap, no position. The tempting proxy — "a driven car
      // finishes, a dead one does not" — is wrong twice over. A car
      // auto-throttles, so a car with its CONTROL entirely discarded still
      // drives off the line and down the road; and a scripted client cannot
      // steer a lap of a real circuit, so a WORKING one does not finish either.
      // The first run of this check duly reported 0/2 with input fully fixed.
      //
      // The presence-mask semantics that broke input are pinned hermetically
      // instead, in `tests/control-mask.test.js`, against the shipped wasm.
      const rows = (alice.snapshot.standings?.order || []);
      const mine = rows.filter((r) => [alice.peerIndex, bob.peerIndex]
        .some((i) => String(r.playerId) === String(i)));
      check('both phones appear on the results board', mine.length === 2,
        `${mine.length}/2 human rows — ${JSON.stringify(rows.map((r) => r.playerId))}`);

      // THE FIELD MUST HAVE BOTS IN IT, and they must have raced.
      //
      // This is the check that would have caught a race running with the humans
      // alone: the bot specs are keyed `peerIndex` and the shell read `id`, so
      // every bot was skipped by a silent `continue`. The launch answer, the
      // field and the board were all correct about the cars that EXISTED, and
      // the screenshot harness passes four fake humans — so nothing else could
      // see it.
      //
      // Asserted on the AI rows FINISHING rather than merely appearing: a bot
      // that was added but never driven would still be listed.
      const racers = rows.filter((r) => r.kind !== 'joining');
      const ai = racers.filter((r) => String(r.playerId).startsWith('ai-'));
      check('the field was filled with AI racers', ai.length > 0,
        `${ai.length} AI of ${racers.length} racers`);
      check('and the bots actually raced (they finished)',
        ai.length > 0 && ai.every((r) => r.finished === true),
        `${ai.filter((r) => r.finished === true).length}/${ai.length} AI finished`);

      // NOT ASSERTED HERE: the AI fast-forward burst. It fires when every HUMAN
      // is home, and a scripted phone cannot steer a lap of a real circuit — so
      // this harness can never reach that state. `tests/fast-forward.test.js`
      // pins the burst hermetically instead, against the shipped wasm.
    }

    // And back out again, which is the other half nobody can see from a
    // screenshot: RETURN_TO_LOBBY is host-only and rides the same effect walk.
    console.log('\n== and back to the lobby ==');
    alice.sendToDisplay({ type: proto.MSG.RETURN_TO_LOBBY });
    let back = true;
    try {
      await alice.waitFor(() => alice.snapshot.roomState === 'lobby',
        'the room to return to the lobby', 15000);
    } catch { back = false; }
    check('RETURN_TO_LOBBY ends the race', back, `roomState=${alice.snapshot.roomState}`);
    check('nobody is left marked in-race',
      back && !(alice.snapshot.players || []).some((p) => p.inRace));
  }

  console.log('\n== a phone leaves ==');
  bob.leave();
  await alice.waitFor(() => (alice.snapshot.players || []).length === 1, 'the roster to shrink');
  check('LEAVE frees the seat in the lobby', (alice.snapshot.players || []).length === 1);
  bob.close();

  // ---- THE PARTY ENDS WITH THE APP ----------------------------------------
  //
  // The web's rule is that the display tab exiting IS the party ending: pagehide
  // fires close_room, so every phone gets a terminal 4001 and shows "party
  // over" AT ONCE. Without it the room lingers for the relay's ~2 min hostless
  // grace, and a phone sits on a dead party with no idea; worse, the next launch
  // dials the corpse back and can serve a stale board to somebody who just
  // scanned a fresh code.
  console.log('\n== the viewer leaves the app ==');
  backgroundApp();
  let closedInTime = true;
  try {
    await alice.waitFor(() => alice.closed != null, 'the room to close behind us', 20000);
  } catch {
    closedInTime = false;
  }
  check('the room closes when the app leaves the screen', closedInTime,
    closedInTime ? `close code ${alice.closed?.code}` :
      'the room outlived the app — phones sit on a dead party until the relay’s ~2 min ' +
      'grace, and then read "that race has ended" while a fresh QR is on the TV');
  if (closedInTime) {
    // 4001 is the relay's room-closed code and is TERMINAL on the controller:
    // no auto-reconnect, a party-over overlay, and the only move left is to
    // scan again. Any other code puts the phone into a retry loop against a
    // room that will never answer.
    check('phones are told the party ENDED, not that they dropped', alice.closed?.code === 4001,
      `code ${alice.closed?.code}`);
  }
  alice.close();

  // ---- AND COMING BACK IS A NEW PARTY -------------------------------------
  //
  // The other half of the same bug. Once the room is closed, returning to the
  // app has to warm a FRESH one: dialling the room we just told the relay to
  // close would spend a round trip being refused and would put a dead code on
  // the screen in the meantime — so somebody scanning the QR they can SEE gets
  // "that race has ended", which is precisely the report this check was written
  // for.
  console.log('\n== the viewer comes back ==');
  foregroundApp();
  let fresh = null;
  try {
    fresh = await waitForRoom(logPath, 45000, room);
  } catch { /* reported below */ }
  check('coming back warms a room', fresh != null, fresh?.room ?? 'none');
  check('and it is a NEW room, not the closed one', fresh != null && fresh.room !== room,
    `was ${room}, now ${fresh?.room}`);

  if (fresh) {
    const carol = new Phone(proto, { name: 'Carol' });
    await carol.join(fresh.room);
    carol.hello();
    let joined = true;
    try {
      await carol.waitFor(() => carol.snapshot != null && carol.seat != null,
        'the new room to seat a phone', 15000);
    } catch { joined = false; }
    check('a phone can join the new room', joined,
      carol.relayErrors.join(', ') || `seat ${JSON.stringify(carol.seat)}`);
    check('the new room is a clean lobby (no stale results board)',
      joined && carol.snapshot?.roomState === 'lobby' && carol.snapshot?.standings == null,
      `roomState=${carol.snapshot?.roomState}, standings=${carol.snapshot?.standings ? 'STALE' : 'null'}`);
    check('the new room has no ghosts of the old roster',
      joined && (carol.snapshot?.players || []).length === 1,
      `${(carol.snapshot?.players || []).length} seat(s)`);
    carol.close();
  }

  if (!KEEP) backgroundApp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nfailed:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  (${f.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
