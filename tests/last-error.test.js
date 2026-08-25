// ttp_last_error: does a refusal say WHY, and does the shell surface it.
//
// Every refusal in this ABI used to be a bare 0, a null or an empty array, so
// each shell composed its own message at its own throw site — and every one of
// those was a guess. `ttp_session_begin failed for track 'x'` cannot say whether
// the track is unknown, the lap count was refused, or nothing was configured,
// because the C++ did not say.
//
// That mattered more than it sounds. The first TV port shipped six bugs and all
// six were SILENT — a legal-looking 0, or a key that read as absent. A refusal
// that explains itself turns a device round trip into a line of output.
//
// WHAT IS PINNED HERE is the property, not the prose: a failing call leaves a
// NON-EMPTY reason that NAMES the thing that was wrong. Asserting the exact
// sentence would make every future improvement to a message a test edit, which
// is how a message ends up frozen and useless. So each case asserts the reason
// mentions the offending input — a substring a human would look for.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// THROUGH THE SHELL'S OWN LOADER, not a second instantiation. The error slot
// lives in the wasm heap, so a test that loads its own module gets its own slot
// and can never see what the shell's module recorded — which is also the one
// real constraint on this API: it is per-module, and the display instantiates
// exactly one (nativeRuntime.js exists to guarantee that).
let modPromise = null;
function abi() {
  return (modPromise = modPromise || (async () => {
    const { loadNativeRuntime } = await import(
      pathToFileURL(path.join(ROOT, 'public/display/nativeRuntime.js')).href);
    const M = await loadNativeRuntime();
    const c = (n, r, a) => M.cwrap(n, r, a);
    return {
      lastError: c('ttp_last_error', 'string', []),
      gpCreate: c('ttp_gp_create', 'number', ['string', 'number']),
      begin: c('ttp_session_begin', 'number', ['string', 'number', 'number', 'string']),
      uiConfigure: c('ttp_ui_configure', 'number', ['string']),
      netConfigure: c('ttp_net_configure', 'number', ['string']),
      raceConfigure: c('ttp_race_configure', 'number', ['string'])
    };
  })());
}

test('a refused session says which track and that laps could be the problem', async () => {
  const a = await abi();
  assert.equal(a.begin('no-such-track', 1, 3, null), 0, 'premise: the track is unknown');
  const why = a.lastError();
  assert.ok(why.length > 0, 'a refusal with no reason is the thing this exists to remove');
  assert.match(why, /no-such-track/, 'the reason must name the input that was refused');
  assert.match(why, /laps/, 'and the other way it can fail, since the shell cannot tell them apart');
});

test('an empty trackId is a different message from an unknown one', async () => {
  // Two different mistakes: a shell that passed nothing, and one that passed a
  // typo. Collapsing them into one sentence is what made the old bare 0 useless.
  const a = await abi();
  assert.equal(a.begin('', 1, 3, null), 0);
  const why = a.lastError();
  assert.match(why, /no trackId/i);
  assert.doesNotMatch(why, /laps/, 'nothing was refused about the laps here');
});

test('each configure names ITSELF, so a boot failure says which one', async () => {
  // Three configure calls run back to back at boot. A reason that did not name
  // the call would leave a shell knowing only that "a configure" failed.
  const a = await abi();
  for (const [name, fn] of [['ttp_ui_configure', a.uiConfigure],
                            ['ttp_net_configure', a.netConfigure],
                            ['ttp_race_configure', a.raceConfigure]]) {
    assert.equal(fn('not json at all'), 0, `premise: ${name} refuses this`);
    assert.match(a.lastError(), new RegExp(name));
  }
});

test('the reason quotes what actually arrived, bounded', async () => {
  const a = await abi();
  assert.equal(a.netConfigure('["not","an","object"]'), 0);
  assert.match(a.lastError(), /\["not","an","object"\]/,
    'a short input is quoted whole — that IS the answer, usually');

  // A chooser payload is ~7 KB and is normally wrong in its first bytes, so the
  // whole thing in an error string hides the answer rather than giving it.
  const huge = JSON.stringify(Array.from({ length: 4000 }, (_, i) => i));
  assert.equal(a.netConfigure(huge), 0);
  const why = a.lastError();
  assert.ok(why.length < 300, `a bounded excerpt, not the payload (got ${why.length} chars)`);
  assert.match(why, /bytes\)/, 'and it says how much was elided');
});

test('the shell surfaces the reason rather than composing its own', async () => {
  // nativeError() is what every adapter throws through now. It must carry the
  // engine's sentence, not just the shell's description of what it was doing.
  const { nativeError } = await import(
    pathToFileURL(path.join(ROOT, 'public/display/nativeRuntime.js')).href);
  const a = await abi();
  a.begin('definitely-not-a-track', 1, 3, null);

  const err = nativeError('starting a race');
  assert.match(err.message, /starting a race/, 'what the shell was doing');
  assert.match(err.message, /definitely-not-a-track/, "and the engine's reason");
});

test('a failure never reports an EARLIER, unrelated one', async () => {
  // THE TRAP THIS FEATURE COULD HAVE BECOME. Every instrumented export clears
  // the slot on entry, so a call that refuses without explaining itself leaves
  // "" rather than whatever somebody else left behind.
  //
  // Without that clearing, a shell wrapping `if (!h) throw` around a call whose
  // refusal paths are not instrumented reports a confident, plausible and
  // completely wrong cause — which is precisely the failure ttp_last_error
  // exists to remove, wearing a nicer wrapper.
  const a = await abi();
  a.begin('typo-track', 1, 3, null);
  assert.match(a.lastError(), /typo-track/, 'premise: an unrelated failure is in the slot');

  assert.equal(a.gpCreate(JSON.stringify({ id: 'x', name: 'X', tracks: [] }), 0), 0);
  const why = a.lastError();
  assert.doesNotMatch(why, /typo-track/, 'the cup failure must not inherit the track failure');
  assert.match(why, /ttp_gp_create/);
});

test('a SUCCESSFUL call leaves the slot empty', async () => {
  // So "empty" reliably means "this call did not explain itself", not "nothing
  // has ever failed" — which is what makes the previous test's guarantee hold
  // for a call that succeeds between two failures.
  const a = await abi();
  a.begin('no-such-track', 1, 3, null);
  assert.ok(a.lastError().length > 0, 'premise');
  assert.ok(a.gpCreate(JSON.stringify({ id: 'x', name: 'X', tracks: ['a'] }), 0) > 0);
  assert.equal(a.lastError(), '');
});

test('every shell surfaces the reason instead of composing its own', () => {
  // The point of the export. A shell that discards the return of a call that
  // can refuse, or invents a message for one that did, has all of this and uses
  // none of it — which is what the first TV shell did with all three configures.
  const fs = require('node:fs');
  const shells = {
    'public/display/nativeRuntime.js': /ttp_last_error/,
    'shells/tvos/TinyTrackParty/App/GameCoordinator.swift': /ttp_last_error/,
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt':
      /ttp_last_error/
  };
  for (const [file, needs] of Object.entries(shells)) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      assert.ok(file.startsWith('shells/'), `${file} is missing and is not an optional shell`);
      continue;
    }
    const code = fs.readFileSync(full, 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.match(code, needs, `${file}: never reads the engine's reason`);
  }
});

test('no shell DISCARDS the return of a call that can refuse', () => {
  // `_ = ttp_ui_configure(…)` compiles, runs, and carries a malformed boot
  // straight into a game with no catalogue — every symptom of which shows up
  // somewhere else entirely.
  const fs = require('node:fs');
  const file = 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift';
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return;
  const code = fs.readFileSync(full, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join('\n');
  assert.doesNotMatch(code, /_\s*=\s*ttp_\w*_configure\(/,
    `${file}: discards a configure return — a refused boot then looks like a bug elsewhere`);
});
