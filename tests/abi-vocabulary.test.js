// A shell that switches on an ABI's answer must spell the ABI's own words.
//
// THREE TIMES NOW, and always the same shape. `ttp_race_start_json` answers
// `{"action":"launch"}` and the tvOS shell read a boolean `launch`, so every
// start there had ever been was rejected. `ttp_ui_auto_pause_json` answers a
// DECISION and the shell handed it to the effect walker, which found no
// `effects` and did nothing. And `ttp_ui_freeze_transition` answers
// `freeze`/`thaw` while the shell switched on `pause`/`resume` — so the pause
// overlay appeared, the snapshot published, the phones flipped to their paused
// screen, and the cars kept driving underneath all of it.
//
// Every one of them was SILENT, and for the same structural reason: a `switch`
// over strings has a `default`, and a `default` that swallows the miss turns a
// vocabulary error into a feature that quietly does nothing. The compiler
// cannot help — every arm is a valid `String`.
//
// So this reads the vocabulary out of the HEADER (the one place it is
// authoritative, written as `"a" | "b" | "c"` in the doc comment) and requires
// the shell that switches on that call to spell those words and no others.
//
// IT DELIBERATELY DOES NOT CHECK COVERAGE. A shell may legitimately ignore an
// arm — "none" is usually a no-op, and `default:` is the right way to say so.
// What it may not do is invent a word the ABI never says, because that arm can
// never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return read(rel).split('\n').filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join('\n');
}

/**
 * The alternatives a header documents for one export, taken from the `"a" |
 * "b"` run nearest its declaration. Headers are the source here because they
 * are what a porter reads.
 */
function vocabulary(header, symbol, marker) {
  const src = read(header);
  const decl = src.indexOf(symbol);
  assert.ok(decl > 0, `${header}: no ${symbol}`);
  // The doc comment is ABOVE the declaration; search back to the block start.
  const from = src.lastIndexOf('/*', decl);
  const doc = src.slice(from, decl);
  const at = doc.lastIndexOf(marker);
  assert.ok(at >= 0, `${header}: ${symbol}'s comment no longer says ${marker}`);
  const words = [...doc.slice(at).matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]);
  assert.ok(words.length >= 2, `${header}: could not read ${symbol}'s alternatives`);
  return new Set(words);
}

/** Where the next same-indent declaration starts, so a body stays its own. */
function nextDecl(src, from) {
  const at = src.indexOf('\n    func ', from + 10);
  return at < 0 ? src.length : at;
}

/** Every string literal a Swift `switch` over `expr` matches on. */
function swiftCases(src, afterMarker) {
  const i = src.indexOf(afterMarker);
  assert.ok(i > 0, `${afterMarker} has moved`);
  const body = src.slice(i, src.indexOf('\n    }', i));
  return [...body.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]);
}

/** Every string literal in the Kotlin `when` that starts at `afterMarker`. */
function kotlinWhenStrings(src, afterMarker) {
  const i = src.indexOf(afterMarker);
  assert.ok(i > 0, `${afterMarker} has moved`);
  const body = src.slice(i, src.indexOf('\n            }', i));
  return [...body.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]);
}

/**
 * One Kotlin method's body. Bounded at the next member OR the next KDoc block,
 * whichever comes first — a doc comment is prose and quotes the vocabulary
 * freely, so letting one in would report a neighbour's sentences as arms.
 */
function kotlinBody(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > 0, `${marker} has moved`);
  const ends = ['\n    fun ', '\n    /**', '\n    private fun ']
    .map((s) => src.indexOf(s, i + marker.length))
    .filter((n) => n > 0);
  return src.slice(i, ends.length ? Math.min(...ends) : src.length);
}

test('the freeze plan speaks its documented member ops', () => {
  // The plan answers the transition AND its ordered member ops
  // ("pause-session", "hold-cars", …). A shell arm spelling a word the header
  // never says can never run, and `default` swallows the miss in silence.
  const words = vocabulary('native/runtime/ttp_ui.h', 'ttp_ui_freeze_plan_json',
    '"pause-session"');

  const src = shell('shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift');
  if (src === null) return;
  const cases = swiftCases(src, 'func syncSessionFrozen');
  assert.ok(cases.length >= 5, 'syncSessionFrozen no longer switches on the plan ops');
  for (const c of cases) {
    assert.ok(words.has(c),
      `syncSessionFrozen matches "${c}", which ttp_ui_freeze_plan_json never says — `
      + `that arm can never run, and \`default\` swallows the miss in silence`);
  }
});

test('the back effect speaks swallow/end-party/pause/resume/return-to-lobby', () => {
  const words = vocabulary('native/runtime/ttp_ui.h', 'ttp_ui_back_effect', '"swallow"');
  // The switch lives in RootView (the Menu button's one dispatch site), not in
  // the coordinator — there is deliberately no second walker of this table.
  const swift = shell('shells/tvos/TinyTrackParty/Screens/RootView.swift');
  if (swift !== null) {
    for (const c of swiftCases(swift, 'var backAction')) {
      assert.ok(words.has(c), `backAction matches "${c}", which ttp_ui_back_effect never says`);
    }
  }
  // The Kotlin twin: MainActivity's OnBackPressedCallback is ITS one dispatch
  // site, and auditing only the tvOS switch is what let a dead Kotlin arm drift.
  const kotlin = shell(
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/MainActivity.kt');
  if (kotlin !== null) {
    const cases = kotlinWhenStrings(kotlin, 'handleOnBackPressed');
    assert.ok(cases.length >= 2, 'MainActivity no longer switches on the back effect');
    for (const c of cases) {
      assert.ok(words.has(c),
        `MainActivity matches "${c}", which ttp_ui_back_effect never says`);
    }
  }
});

test('the race-flow entry points read `action`, and only its values', () => {
  // The START bug: `{"action":"launch"}` read as a boolean `launch`. Nothing
  // errored — `verdict["launch"]` was nil and the guard rejected every start.
  const swift = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  // The Kotlin twin hand-writes the same three reads. Auditing only tvOS is the
  // gap the back-effect case above already names: a second shell can spell a
  // word the ABI never says and its `else -> Unit` swallows the miss.
  const kotlin = shell(
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt');
  const header = read('native/runtime/ttp_race.h');

  for (const [fn, marker] of [['ttp_race_start_live_json', 'startRace'],
                              ['ttp_race_advance_live_json', 'advanceSeriesRace'],
                              ['ttp_race_return_live_json', 'returnToLobby']]) {
    const decl = header.indexOf(fn);
    const doc = header.slice(header.lastIndexOf('/*', decl), decl);
    const actions = new Set([...doc.matchAll(/"action":"([a-z-]+)"/g)].map((m) => m[1])
      .concat([...doc.matchAll(/\|"([a-z-]+)"/g)].map((m) => m[1])));
    assert.ok(actions.size > 0, `${fn}: could not read its actions from the header`);

    if (swift !== null) {
      const i = swift.indexOf(`func ${marker}`);
      assert.ok(i > 0, `${marker} has moved`);
      // Bounded at the next declaration at the same indent — an unbounded slice
      // reads the whole rest of the file and reports its neighbours' cases.
      const body = swift.slice(i, nextDecl(swift, i));
      for (const m of body.matchAll(/\["action"\]\s+as\?\s+String\s*==\s*"([^"]+)"/g)) {
        assert.ok(actions.has(m[1]),
          `${marker} compares action to "${m[1]}", which ${fn} never answers`);
      }
      for (const m of body.matchAll(/case\s+"([a-z-]+)":/g)) {
        assert.ok(actions.has(m[1]),
          `${marker} matches action "${m[1]}", which ${fn} never answers`);
      }
    }

    if (kotlin !== null) {
      const body = kotlinBody(kotlin, `fun ${marker}(`);
      assert.match(body, /optString\("action"\)/,
        `Kotlin ${marker} no longer reads \`action\` — has it started trusting a bool?`);
      // Both spellings the shell uses: the guard (`!= "launch"`) and the `when`.
      const words = [
        ...[...body.matchAll(/optString\("action"\)\s*[!=]=\s*"([a-z-]+)"/g)].map((m) => m[1]),
        ...(/when\s*\([^)]*optString\("action"\)\s*\)/.test(body)
          ? [...body.matchAll(/"([a-z-]+)"\s*->/g)].map((m) => m[1])
          : []),
      ];
      assert.ok(words.length > 0, `Kotlin ${marker}: could not read which actions it matches`);
      for (const w of words) {
        assert.ok(actions.has(w),
          `Kotlin ${marker} matches action "${w}", which ${fn} never answers`);
      }
    }
  }
});

test('the auto-pause walk hands the effect walker EFFECTS, in one call', () => {
  // The historical bug: the UI model's bare DECISION was fed to run(), which
  // found no `effects` and did nothing, silently — the freeze never froze.
  // The live walk closed that hole structurally: the decision AND its effects
  // are one answer, so there is no decision object left to mis-route.
  const swift = shell('shells/tvos/TinyTrackParty/App/GameCoordinator.swift');
  if (swift !== null) {
    const i = swift.indexOf('func refreshAutoPause');
    assert.ok(i > 0, 'refreshAutoPause has moved');
    const body = swift.slice(i, swift.indexOf('\n    }', i));
    assert.match(body, /run\(TTP\.obj\(ttp_race_auto_pause_live_json/,
      'the one walk answers the effects the walker performs');
  }
  const kotlin = shell(
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt');
  if (kotlin !== null) {
    assert.match(kotlinBody(kotlin, 'fun refreshAutoPause('),
      /run\(TtpJson\.obj\(Ttp\.ttp_race_auto_pause_live_json/,
      'the Kotlin twin walks the same one answer, not a bare decision');
  }
});
