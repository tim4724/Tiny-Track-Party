'use strict';
// THREE SHELLS, ONE GAME: the agreements no compiler can check.
//
// The web display, the tvOS app and the Android TV app bind the same ABIs and
// are supposed to have the same features. Where they drift, they drift SILENTLY
// — a `default:` swallows a verdict, a snapshot field is simply absent, a
// declared table stops matching the switch beside it. None of it throws and none
// of it shows up in a build.
//
// Everything here is a literal source-text guard in the idiom of
// tests/abi-vocabulary.test.js and tests/config-drift.test.js: a reformat that
// hides a subject FAILS rather than silently matching nothing, and every
// extraction asserts it found something.
//
// ---------------------------------------------------------------------------
// 1. A DECLARED PERFORMER TABLE THAT NO LONGER MATCHES ITS SWITCH.
//
// Both TV shells prove at boot that every op a walk can emit has an arm — they
// filter `ttp_race_effect_ops_json` / `ttp_net_effect_ops_json` against a
// hand-written `performable` / `PERFORMABLE` set. That proof is only as good as
// the set, and the set is a SECOND spelling of the switch beside it. Neither
// compiler can see the two disagree: adding a case and forgetting the row makes
// the boot proof fail for something the shell can in fact do; DELETING a case
// and leaving the row is the dangerous direction — the boot proof keeps passing
// while the op falls through to a `default` that fires mid-party.
//
// The web has no such hole, because there the table IS the switch
// (`NET_PERFORMERS` / `RACE_PERFORMERS` are objects keyed by op, and
// `assertNetOps` reads their keys). Swift and Kotlin cannot reflect a `switch`,
// so this file is the substitute: read both spellings out of the source and
// demand they are the same set.
//
// It says nothing about whether an arm is CORRECT; `tests/abi-vocabulary.test.js`
// covers spelling against the ABI, and the boot proofs cover coverage against
// the live vocabulary. This covers only the gap between a shell's two accounts
// of itself.
//
// ---------------------------------------------------------------------------
// 2. A VERDICT WORD A SHELL NEVER LEARNED.
//
// `ttp_net_controller_action` answers what a phone's button press MEANS, gates
// included. `tests/abi-vocabulary.test.js` checks that a shell spells only words
// the ABI says and deliberately does NOT check coverage — an arm may be
// legitimately ignored. But a word that the WEB acts on and a TV shell does not
// is a feature the TV does not have, and the phone still shows its control.
// `set-sound` was exactly that for both TV shells: the host's Sound row was
// drawn, pressed, and did nothing on either television.
//
// ---------------------------------------------------------------------------
// 3. A TIMING RULE SPELLED IN THREE LANGUAGES.
//
// The cup board's phase 2 accounts its points out one at a time, and how fast is
// a rule: a fraction of the model's own phase-1 hold, floored so a short hold
// cannot ask for a sub-frame beat. The model scales `racePhaseMs` off the
// intermission budget and stops there, so the two numbers that turn it into a
// beat are the shells' — and there are three shells. A `pointTickMs` beside
// `racePhaseMs` on `ttp_ui_results_view_json` is the fix that would delete this
// test; until then the numbers are pinned to the web's, which is the one a
// designer tunes.
//
// ---------------------------------------------------------------------------
// 4. A SNAPSHOT FIELD ONE SHELL DOES NOT PUBLISH.
//
// The lobby frame is the phone's ONLY source of truth. Most of it is composed in
// C++ off the room handle; what a shell supplies is the short list of facts only
// the game knows. tests/wire-compat.test.js pins that list for the WEB display
// against a live phone, and nothing sees the two TV shells at all — so a missing
// field there reads on the handset as a setting that is simply always off.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Source with `//` and `///` comment lines dropped — a commented-out arm is not an arm. */
function shell(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

/** The body between `from` and `to`, both of which must be present. */
function slice(src, rel, from, to) {
  const a = src.indexOf(from);
  assert.ok(a > 0, `${rel}: "${from}" has moved`);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `${rel}: "${to}" has moved`);
  return src.slice(a, b);
}

/**
 * The ops a switch body dispatches on, AT ITS OWN LEVEL.
 *
 * Indentation is the discriminator, and it has to be: `show-screen`'s arm opens
 * a NESTED switch over the screen name, whose arms are string literals in the
 * same shape. Taking every literal would read `welcome`/`lobby`/`race` as race
 * ops. Only the arm's HEAD counts — one arm may list several ops
 * (`case "reveal-chrome", "hold-chrome":`), while its BODY routinely quotes keys
 * off the effect (`game.audio.music(e.optString("biome"))`) that are not ops.
 */
function arms(body, rel, armLine) {
  const heads = body.split('\n')
    .map((l) => ({ line: l, m: l.match(armLine) }))
    .filter((x) => x.m);
  assert.ok(heads.length > 0, `${rel}: found no arms — the switch has been reshaped`);
  const indent = heads[0].m[1];
  const own = heads.filter((x) => x.line.startsWith(indent) && !x.line.startsWith(`${indent} `));
  assert.ok(own.length > 0, `${rel}: no arms at the switch's own indentation`);
  return new Set(own.flatMap((x) => [...x.m[2].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1])));
}

// How each LANGUAGE spells an arm and a declared table. A fourth shell adds a
// path and a switch anchor; only a new language adds one of these.
const SWIFT = {
  switchTo: '\n        default:',
  armLine: /^(\s*)case\s+((?:"[a-z][a-z0-9-]*"\s*,\s*)*"[a-z][a-z0-9-]*")\s*:/,
  decl: 'static let performable: Set<String> = [',
  declTo: '\n    ]\n',
};
const KOTLIN = {
  switchTo: '\n            else ->',
  armLine: /^(\s*)((?:"[a-z][a-z0-9-]*"\s*,\s*)*"[a-z][a-z0-9-]*")\s*->/,
  decl: 'val PERFORMABLE: Set<String> = setOf(',
  declTo: '\n        )\n',
};

const SHELLS = [
  { ...SWIFT, name: 'tvOS race', switchFrom: 'switch op {',
    file: 'shells/tvos/TinyTrackParty/App/RaceFlowPerformer.swift' },
  { ...SWIFT, name: 'tvOS net', switchFrom: 'switch e["op"] as? String {',
    file: 'shells/tvos/TinyTrackParty/Net/PartyNet.swift' },
  { ...KOTLIN, name: 'Android race', switchFrom: 'when (op) {',
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/RaceFlowPerformer.kt' },
  { ...KOTLIN, name: 'Android net', switchFrom: 'when (e.optString("op")) {',
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PartyNet.kt' },
];

for (const s of SHELLS) {
  test(`${s.name}: the declared performer table is exactly the switch's arms`, () => {
    const src = shell(s.file);
    if (!src) return;   // a checkout without this shell (tests/shell-gate-anchors.test.js holds the path)

    const performed = arms(slice(src, s.file, s.switchFrom, s.switchTo), s.file, s.armLine);

    const declBody = slice(src, s.file, s.decl, s.declTo);
    const declared = new Set([...declBody.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
    assert.ok(declared.size > 0, `${s.file}: "${s.decl}" declares no ops`);

    const missing = [...performed].filter((op) => !declared.has(op)).sort();
    const stale = [...declared].filter((op) => !performed.has(op)).sort();
    assert.deepEqual({ missing, stale }, { missing: [], stale: [] },
      `${s.file}: the performable table and the switch disagree — `
      + `"missing" are arms the boot proof will reject, `
      + `"stale" are rows claiming an arm that no longer exists (the silent direction)`);
  });
}

// The web's own spellings, which are the reference for both checks below: the
// display page is the one shell a live phone is tested against.
const WEB_ACTION = 'public/display/main.js';
const WEB_PUBLISH = 'public/display/Net.js';

test('every TV shell acts on every controller verdict the web acts on', () => {
  const web = shell(WEB_ACTION);
  const verdicts = new Set(
    [...slice(web, WEB_ACTION, 'net.controllerAction(', '\n  }\n})')
      .matchAll(/^\s*case '([a-z][a-z0-9-]*)':/gm)].map((m) => m[1]));
  assert.ok(verdicts.size >= 5, `${WEB_ACTION}: could not read the verdict switch`);

  // AN ARM, NOT A MENTION. `shell()` drops `//` lines but not `/** … */` bodies,
  // and both shells carry doc comments that quote verdicts — so a substring test
  // would let a shell satisfy this gate with prose and no arm behind it, which
  // is the exact failure the gate exists to catch.
  for (const [file, shape] of [
    ['shells/tvos/TinyTrackParty/App/GameCoordinator+Lobby.swift', SWIFT],
    ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt', KOTLIN],
  ]) {
    const src = shell(file);
    if (!src) continue;
    const acted = new Set(src.split('\n').flatMap((l) => {
      const m = l.match(shape.armLine);
      return m ? [...m[2].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((x) => x[1]) : [];
    }));
    const missing = [...verdicts].filter((v) => !acted.has(v)).sort();
    assert.deepEqual(missing, [],
      `${file} has no arm for ${missing.join(', ')} — `
      + 'a verdict the web acts on that this shell drops into its default arm, '
      + 'so the phone control that produces it does nothing on this television');
  }
});

test('every shell paces the points tally by the same two numbers', () => {
  // Read off the web, never typed here, so tuning the beat needs no test edit.
  const WEB = 'public/display/raceOverlays.js';
  const web = shell(WEB);
  const at = (re, what) => {
    const m = re.exec(web);
    assert.ok(m, `${WEB} no longer states ${what} — has the board been rewritten?`);
    return Number(m[1]);
  };
  const want = {
    share: at(/const TICK_OF_PHASE = ([\d.]+);/, "the tally's share of phase 1"),
    floorMs: at(/Math\.max\((\d+), v\.racePhaseMs \* TICK_OF_PHASE\)/, "the beat's floor"),
  };

  for (const [file, share, floor] of [
    ['shells/tvos/TinyTrackParty/Screens/ResultsView.swift',
      /tickOfPhase = ([\d.]+)/, /max\(([\d.]+), view\.racePhaseMs \* Self\.tickOfPhase\)/],
    ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/ResultsScreen.kt',
      /TICK_OF_PHASE = ([\d.]+)/, /max\(([\d.]+), results\.racePhaseMs \* TICK_OF_PHASE\)/],
  ]) {
    const src = shell(file);
    if (!src) continue;
    for (const [name, re] of [['share', share], ['floorMs', floor]]) {
      const m = re.exec(src);
      assert.ok(m, `${file}: could not read its ${name} — the anchor has moved`);
      assert.equal(Number(m[1]), want[name],
        `${file}'s ${name} is ${m[1]} but ${WEB} says ${want[name]} — `
        + 'the tally is one rule, and a shell that has drifted counts a cup out '
        + 'at a speed nobody chose');
    }
  }
});

test('every shell puts the same facts on the lobby snapshot', () => {
  // What the shell SUPPLIES; everything else on the frame is composed in C++ off
  // the room handle (ttp_net_lobby_frame) and cannot go missing per platform.
  const EXTRAS = ['paused', 'soundOn', 'standings'];
  const web = shell(WEB_PUBLISH);
  for (const key of EXTRAS) {
    assert.match(web, new RegExp(`\\b${key}:`),
      `${WEB_PUBLISH} no longer supplies ${key} — this list is read off it`);
  }
  for (const file of [
    'shells/tvos/TinyTrackParty/Net/PartyNet.swift',
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PartyNet.kt',
  ]) {
    const src = shell(file);
    if (!src) continue;
    const missing = EXTRAS.filter((k) => !src.includes(`"${k}"`)).sort();
    assert.deepEqual(missing, [],
      `${file}'s publishSnapshot omits ${missing.join(', ')} — `
      + 'absent reads on the phone as a legal value, so the setting is simply '
      + 'always off there and nothing anywhere says so');
  }
});

test('every shell that performs the walks runs BOTH boot proofs', () => {
  // The race walk and the net walk are two vocabularies with two switches, so
  // one proof says nothing about the other. tvOS shipped with only the race one.
  const PROOFS = [
    ['shells/tvos/TinyTrackParty/App/GameCoordinator.swift',
      'ttp_race_effect_ops_json', 'ttp_net_effect_ops_json'],
    ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt',
      'ttp_race_effect_ops_json', 'ttp_net_effect_ops_json'],
  ];
  for (const [file, ...symbols] of PROOFS) {
    const src = shell(file);
    if (!src) continue;
    for (const sym of symbols) {
      assert.match(src, new RegExp(sym),
        `${file} never asks for ${sym} — an op it cannot perform will be discovered at a party`);
    }
  }
});
