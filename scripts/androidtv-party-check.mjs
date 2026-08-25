// END-TO-END: a real party, against a real Android TV app, over the real relay.
//
// WHAT THIS COVERS THAT NOTHING ELSE DOES. Every game rule is C++ and already
// gated four ways, and `tests/wire-compat/` pins the C++ against the real JS
// controller byte for byte. None of that sees the KOTLIN: PartyNet's room
// lifecycle, the payloads GameCoordinator composes, and what the app does when it
// leaves the screen are a shell, and a shell is exactly the part a corpus cannot
// replay. `docs/native-port/shells.md` is blunt about it: an end-to-end test with
// a real peer is "the only detector for this class", and it found four of the
// first TV shell's six launch bugs where no corpus, screenshot or unit test found
// any.
//
// It is the sibling of `scripts/tvos-party-check.mjs` and asserts the same list,
// because the list is about the WIRE a phone sees rather than about a platform.
// What differs is only how the app is driven: adb rather than devicectl, and the
// room code read out of logcat rather than a console pipe.
//
// USAGE
//   node scripts/androidtv-party-check.mjs                 # first TV device found
//   node scripts/androidtv-party-check.mjs --serial=<id>   # a specific one
//   node scripts/androidtv-party-check.mjs --keep          # leave the app running
//   node scripts/androidtv-party-check.mjs --full          # + race it to the flag
//
// IT IS NOT AN `npm test` ENTRY, and cannot be: it needs an Android TV box and the
// public relay. `npm test` stays hermetic and fast.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ACTIVITY } from './lib/androidtv-bench.mjs';
import { ADB, findTvDevice } from './lib/androidtv-device.mjs';
import { Phone, loadProtocol } from './lib/phone.mjs';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const FULL = args.includes('--full');
const SERIAL = args.find((a) => a.startsWith('--serial='))?.slice('--serial='.length) ?? null;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serial = null;
const adb = (...argv) => execFileSync(ADB, ['-s', serial, ...argv], { encoding: 'utf8' });

// ---- the app under test -----------------------------------------------------

/**
 * Launch, and stream logcat to a file. The ROOM CODE is read back out of it
 * (`PartyNet` logs `room <code> — <url>`), which is also why that line exists at
 * all: a TV has no address bar, so without it the only way to learn which room the
 * app is in is to read it off the screen with your eyes.
 */
function launchApp(logPath) {
  rmSync(logPath, { force: true });
  adb('logcat', '-c');
  const out = openSync(logPath, 'w');
  spawn(ADB, ['-s', serial, 'logcat', '-v', 'brief'],
    { stdio: ['ignore', out, 'ignore'], detached: true }).unref();
  // WAKE FIRST. A sleeping box never creates a surface, so the app boots, logs
  // its version and then sits there — which reads exactly like a hung room.
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  // `-S`, and ONLY on this launch. Without it `am start` brings an EXISTING
  // task to the front instead of restarting the activity, so an app left up by
  // something else — `perf-race --platform androidtv` leaves its box in the
  // `bench` scenario on purpose — stays in that scenario, warms no room, and
  // this check fails with "the app never logged a room code", which points
  // nowhere near the cause.
  //
  // foregroundApp() below must NOT do this: bringing the existing task forward
  // is precisely the come-back behaviour it asserts.
  adb('shell', 'am', 'start', '-S', '-n', ACTIVITY);
}

/**
 * The LAST room code the app logged, optionally waiting for one that is not
 * `notThis` — the whole log is kept for the run, so one stream serves it all.
 */
async function waitForRoom(logPath, timeout = 60000, notThis = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const all = [...readFileSync(logPath, 'utf8')
        .matchAll(/room ([A-Za-z0-9]+) — (\S+)/g)];
      const hit = notThis ? all.reverse().find((m) => m[1] !== notThis) : all.at(-1);
      if (hit) return { room: hit[1], url: hit[2] };
    }
    await sleep(500);
  }
  throw new Error(notThis ? `no room other than ${notThis} appeared`
                          : 'the app never logged a room code');
}

/**
 * HOME, not force-stop. The party ending is `onStop`'s job, and a SIGKILL would
 * skip it — which is the very behaviour this check exists to assert.
 */
function backgroundApp() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
}

function foregroundApp() {
  adb('shell', 'am', 'start', '-n', ACTIVITY);
}

// ---- the run ----------------------------------------------------------------

async function main() {
  serial = findTvDevice(SERIAL);
  console.log(`\n== device ${serial} ==`);
  const proto = await loadProtocol();
  const logPath = join(tmpdir(), 'ttp-android-party-check.log');

  // WIND DOWN ANY RUNNING INSTANCE FIRST, gracefully — so the launch below is
  // cold. Force-stopping is a crash as far as the app is concerned, so the
  // crash-recovery blob survives and the new launch correctly REJOINS the old
  // room, stale seats and all. Right product behaviour, wrong starting state.
  console.log('\n== launching the app ==');
  backgroundApp();
  await sleep(2500);
  launchApp(logPath);
  const { room, url } = await waitForRoom(logPath);
  console.log(`   room ${room} — ${url}\n`);

  check('the join URL declares this platform', /[?&]cpp=androidtv\b/.test(url), url);

  console.log('== a phone scans the QR ==');
  const alice = new Phone(proto, { name: 'Alice' });
  await alice.join(room);
  check('the relay accepts the join', alice.peerIndex != null,
    alice.relayErrors.join(', ') || `peerIndex ${alice.peerIndex}`);

  // HELLO GOES OUT AT ONCE, because that is what the real controller does and the
  // ordering is load-bearing: a phone that waited for the snapshot first would
  // deadlock against a display that only publishes on a roster change.
  alice.hello();

  await alice.waitFor(() => alice.snapshot != null, 'the retained snapshot');
  const s = alice.snapshot;
  check('the display has published a retained snapshot', !!s);

  // THE CHOOSER, field by field. Each of these was undefined in the shipped tvOS
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
  // the phone's results overlay, so a new party carrying one shows "the race has
  // ended" to somebody who just walked in.
  check('a fresh room is in the lobby', s.roomState === 'lobby', `roomState=${s.roomState}`);
  check('a fresh room has no standings board', s.standings == null,
    s.standings ? 'stale results would raise the phone’s "race over" overlay' : 'null');

  console.log('\n== the phone takes a seat ==');
  await alice.waitFor(() => alice.seat != null, 'our seat to appear in the roster');
  check('HELLO seats us', alice.seat != null, JSON.stringify(alice.seat));
  // WAITED FOR, not read once: the seat can appear from `peer_joined` carrying the
  // display's placeholder a beat before the HELLO's name lands.
  let named = true;
  try {
    await alice.waitFor(() => alice.seat?.name === 'Alice', "HELLO's name to reach the roster", 6000);
  } catch { named = false; }
  check('HELLO renames the seat', named, `name=${alice.seat?.name}`);

  console.log('\n== the phone picks a car ==');
  // carIndex ONLY: the livery is display-assigned and a phone never sends one.
  alice.setCar(1);
  let picked = true;
  try {
    await alice.waitFor(() => alice.seat?.carIndex === 1, 'the car pick to land', 6000);
  } catch { picked = false; }
  check('SET_CAR moves the seat', picked, `car ${alice.seat?.carIndex}`);
  check('the display still owns the livery', typeof alice.seat?.colorIndex === 'number',
    `colour ${alice.seat?.colorIndex}`);

  const amHost = alice.snapshot.hostPeerIndex === alice.peerIndex;
  check('the first phone is the host', amHost,
    `host=${alice.snapshot.hostPeerIndex}, me=${alice.peerIndex}`);

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
  // The check that was missing on tvOS, and its absence is why a shell that could
  // not start a race at all passed everything else: the screenshot harness reaches
  // the launch DIRECTLY, so every race screen photographed beautifully while the
  // only road a phone can take was broken end to end. Nothing that photographs a
  // screen can tell you a button works.
  console.log('\n== the guest readies up ==');
  // The GUEST readies; the host never does, because the host's Start IS their
  // commitment. Asserting the host's flag stays false is what keeps a future "fix"
  // from making the host ready themselves and quietly requiring two presses.
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
    await alice.waitFor(() => alice.snapshot.roomState !== 'lobby',
      'the room to leave the lobby', 15000);
  } catch { started = false; }
  check('START_GAME starts the race', started, `roomState=${alice.snapshot.roomState}`);

  if (started) {
    check('the racers are marked in-race', (alice.snapshot.players || []).some((p) => p.inRace),
      JSON.stringify((alice.snapshot.players || []).map((p) => ({ n: p.name, inRace: p.inRace }))));
    // The countdown is a direct message, not a snapshot field — a phone that never
    // gets it shows a lobby while the TV counts down.
    let counted = true;
    try {
      await alice.waitFor(() => alice.received(proto.MSG.COUNTDOWN).length > 0,
        'a COUNTDOWN message', 8000);
    } catch { counted = false; }
    check('phones are sent the countdown', counted,
      JSON.stringify(alice.received(proto.MSG.COUNTDOWN)[0] ?? null));

    let racing = true;
    try {
      await alice.waitFor(() => alice.snapshot.roomState === 'playing',
        'the countdown to reach GO', 20000);
    } catch { racing = false; }
    check('the countdown reaches GO', racing, `roomState=${alice.snapshot.roomState}`);

    if (FULL && racing) {
      console.log('   driving to the flag (a few minutes: a scripted phone cannot finish, so the race runs to its own end)');
      // A slow weave rather than a straight line: it exercises the CONTROL path
      // with changing values, which is what a real handset sends.
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

      // WAITED FOR, not read off the phase flip: the board is published by its own
      // effect (points are banked BEFORE it goes out), so it lands a beat after
      // `results`.
      let boarded = true;
      try {
        await alice.waitFor(() => alice.snapshot.standings != null,
          'the standings board to reach the phones', 20000);
      } catch { boarded = false; }
      check('the standings ride the snapshot', boarded,
        boarded ? 'present' : 'MISSING — phones show no results');

      const rows = (alice.snapshot.standings?.order || []);
      const mine = rows.filter((r) => [alice.peerIndex, bob.peerIndex]
        .some((i) => String(r.playerId) === String(i)));
      check('both phones appear on the results board', mine.length === 2,
        `${mine.length}/2 human rows`);

      // THE FIELD MUST HAVE BOTS IN IT, and they must have raced. This is the
      // check that would have caught a race running with the humans alone: the bot
      // specs are keyed `peerIndex` and a shell reading `id` skips every one with
      // a silent `continue`, while the launch answer, the field and the board are
      // all correct about the cars that EXIST.
      const racers = rows.filter((r) => r.kind !== 'joining');
      const ai = racers.filter((r) => String(r.playerId).startsWith('ai-'));
      check('the field was filled with AI racers', ai.length > 0,
        `${ai.length} AI of ${racers.length} racers`);
      check('and the bots actually raced (they finished)',
        ai.length > 0 && ai.every((r) => r.finished === true),
        `${ai.filter((r) => r.finished === true).length}/${ai.length} AI finished`);

      // ITEMS MUST ROLL, AND THEY MUST ROLL SOMETHING REAL. This is the check
      // that would have caught the forceItem bug: `create-session` always carries
      // the key and spells it JSON null when there is no `?item`, and Android's
      // optString turns an explicit null into the STRING "null" — which the sim
      // then honoured as the forced item for every box in the race. Every phone's
      // USE button lit, every TV slot stayed empty, and nothing anywhere failed.
      // A shell that reads the key correctly cannot produce it, so assert on the
      // VALUE, not merely on the message arriving.
      const items = [...alice.fromDisplay, ...bob.fromDisplay]
        .filter((d) => d?.type === proto.MSG.ITEM);
      const held = items.map((d) => d.item).filter((i) => i != null && i !== '');
      // ASSERT THE HELD VALUE, not that ITEM messages arrive. With the bug the
      // messages still arrive — every box rolls, so the slot still CHANGES — they
      // just carry an empty item forever, because ttp_item_code("null") is 0. A
      // check for "never the string null" passes vacuously on an empty list, which
      // is exactly the trap this bug set: everything looks like it is working.
      check('items were dealt to the phones', items.length > 0,
        `${items.length} ITEM message(s)`);
      // REPORTED, NOT ASSERTED, and the distinction is deliberate. A box has a
      // lateral position and a radius, so whether a scripted weave crosses one in
      // a given race is chance: asserting it went red on roughly one run in three
      // with the bug FIXED, and a check that cries wolf that often trains people
      // to re-run rather than read. `tests/androidtv-nullable-json.test.js` is the
      // deterministic gate for the CAUSE — it fails on the source, with no device
      // and no race. This line is the end-to-end corroboration: an empty roll here
      // across several runs means the items path is dead, and that is worth
      // knowing even though one empty run means nothing.
      if (held.length && !held.includes('null')) {
        console.log(`  \x1b[90mnote\x1b[0m  items rolled real ids  — ${[...new Set(held)].join(', ')}`);
      } else {
        console.log(`  \x1b[90mnote\x1b[0m  no item was held this run — chance, unless it repeats`);
      }
    }

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
  // The display leaving the screen IS the party ending. Without it the room
  // lingers for the relay's ~2 min hostless grace, and a phone sits on a dead
  // party with no idea; worse, the next launch dials the corpse back and can serve
  // a stale board to somebody who just scanned a fresh code. On tvOS the method
  // that does this shipped complete and CALLED BY NOTHING.
  console.log('\n== the viewer leaves the app ==');
  backgroundApp();
  let closedInTime = true;
  try {
    await alice.waitFor(() => alice.closed != null, 'the room to close behind us', 20000);
  } catch { closedInTime = false; }
  check('the room closes when the app leaves the screen', closedInTime,
    closedInTime ? `close code ${alice.closed?.code}` :
      'the room outlived the app — phones sit on a dead party until the relay’s ~2 min grace');
  if (closedInTime) {
    // 4001 is the relay's room-closed code and is TERMINAL on the controller: no
    // auto-reconnect, a party-over overlay, and the only move left is to scan
    // again. Any other code puts the phone into a retry loop against a room that
    // will never answer.
    check('phones are told the party ENDED, not that they dropped', alice.closed?.code === 4001,
      `code ${alice.closed?.code}`);
  }
  alice.close();

  // ---- AND COMING BACK IS A NEW PARTY -------------------------------------
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
