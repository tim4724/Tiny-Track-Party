// Paper, or the live 3D behind it.
//
// The rule has THREE clauses and each one earns its place:
//
//   never over the welcome board   — its copy is unreadable over a live track
//   in the LOBBY, only once picked — there is no scene built before that
//   anywhere else, always          — a race is the 3D, by definition
//
// A shell that keeps only the first shows a 3D surface with nothing built on it
// for the whole of a fresh lobby. That is a BLACK SCREEN where the web shows the
// warm paper diorama, and it is the first thing a viewer sees — before anyone
// has picked anything, which is exactly the state a party starts in.
//
// It shipped on tvOS as `screen != .welcome`, and it hid behind the screenshot
// harness twice over: the lobby scenarios never pick a track, so every lobby
// photograph was black and looked like a deliberate dark theme rather than a
// missing backdrop.
//
// THIS IS A SOURCE CHECK because the rule is a shell's — the web spells it in
// `backdropShow3D()`, tvOS and Android in `refreshBackdrop()`, and there is no
// ABI in between to ask.
//
// BUT IT IS NOT A GREP. This gate used to be `assert.match(body, /welcome/)` and
// two more like it, which a body with every clause INVERTED passes identically —
// coverage in name only, over one shell out of three. So each shell's predicate
// is EXTRACTED and EVALUATED here, over the state space the rule is about: the
// web's real JS body is run as written, and the two TV shells' expressions are
// translated term by term into the same three booleans. A translation that no
// longer covers the whole expression FAILS rather than quietly evaluating a
// fragment — that residue check is what keeps this from decaying back into a
// grep.
//
// OUT OF SCOPE, deliberately: the fourth term the web and tvOS carry
// (`sceneReady` / `hasPainted`), which suppresses the reveal until the surface
// has drawn a frame. That is a different rule — "do not fade paper off an
// undrawn canvas" — and it is substituted TRUE here so this file stays about
// the three clauses above.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const codeOf = (rel) => read(rel)
  .split('\n').filter((l) => !/^\s*(\/\/|\/\/\/|\*|\/\*)/.test(l)).join('\n');

// The room state the rule compares against, from the one place it is declared.
const LOBBY = read('public/shared/protocol.js')
  .match(/LOBBY:\s*'([a-z]+)'/)[1];

// The whole state space the three clauses divide, and the answer in each cell.
// `welcome` and `racing` are never both true in the live game, but a predicate
// is asserted over its inputs, not over the ones someone believes reachable.
const TRUTH = [
  { welcome: true,  hasTrack: false, racing: false, show: false },
  { welcome: true,  hasTrack: true,  racing: false, show: false },
  { welcome: true,  hasTrack: false, racing: true,  show: false },
  { welcome: true,  hasTrack: true,  racing: true,  show: false },
  { welcome: false, hasTrack: false, racing: false, show: false },
  { welcome: false, hasTrack: true,  racing: false, show: true  },
  { welcome: false, hasTrack: false, racing: true,  show: true  },
  { welcome: false, hasTrack: true,  racing: true,  show: true  }
];

const WHY = {
  'true,false,false': 'the welcome board sits on paper even with a track picked behind it',
  'false,false,false': 'a fresh lobby with no pick must show PAPER — otherwise it is a black screen',
  'false,true,false': 'a pick lifts the paper',
  'false,false,true': 'a race shows the 3D whatever the lobby had'
};

/** Run a predicate over the whole table and report the first cell it gets wrong. */
function assertRule(name, predicate) {
  for (const row of TRUTH) {
    const got = predicate(row);
    const key = `${row.welcome},${row.hasTrack},${row.racing}`;
    assert.equal(got, row.show,
      `${name}: welcome=${row.welcome} pick=${row.hasTrack} racing=${row.racing} `
      + `answered ${got}. ${WHY[key] || 'the three clauses disagree with this shell'}`);
  }
}

// ---- the web: its own body, run as written --------------------------------

test('the web predicate answers the rule', () => {
  const src = codeOf('public/display/main.js');
  const i = src.indexOf('function backdropShow3D');
  assert.ok(i > 0, 'backdropShow3D has moved');
  const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('\n}', i));

  // The free variables the body closes over, supplied as the state under test.
  // `sceneReady` is pinned true: see the header on the fourth term.
  const fn = new Function('sceneReady', 'currentScreen', 'selectedTrackId', 'net',
                          'ROOM_STATE', body);
  assertRule('main.js backdropShow3D', ({ welcome, hasTrack, racing }) => fn(
    true,
    welcome ? 'welcome' : 'lobby',
    hasTrack ? 'tidepool' : null,
    { roomState: racing ? 'playing' : LOBBY },
    { LOBBY }
  ));
});

// ---- the TV shells: the expression, translated term by term ----------------

// Each shell states the rule as one boolean expression. `terms` rewrites every
// term of it into the three booleans (or into the constant that takes the
// fourth term out of scope) — both shells already spell the room-state term
// `racing`, so it needs no rewrite. `residue` is then whatever the rewrites did
// not consume, and anything left in it that is not JS boolean punctuation means
// the shell no longer says what this file thinks it says.
const SHELLS = [
  {
    name: 'tvOS refreshBackdrop',
    file: 'shells/tvos/TinyTrackParty/App/GameCoordinator.swift',
    decl: 'func refreshBackdrop',
    assign: /state\.sceneVisible\s*=([\s\S]*?)\n\s*\}/,
    terms: [
      [/display\.hasPainted/g, 'true'],
      [/state\.screen\s*!=\s*\.welcome/g, '!welcome'],
      [/!trackId\.isEmpty/g, 'hasTrack']
    ]
  },
  {
    name: 'Android refreshBackdrop',
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt',
    decl: 'fun refreshBackdrop',
    assign: /state\.sceneVisible\s*=([\s\S]*?)\n\s*\}/,
    terms: [
      [/state\.screen\s*!=\s*GameState\.Screen\.WELCOME/g, '!welcome'],
      [/trackId\.isNotEmpty\(\)/g, 'hasTrack']
    ]
  }
];

for (const { name, file, decl, assign, terms } of SHELLS) {
  test(`${name} answers the rule`, () => {
    const src = codeOf(file);
    const i = src.indexOf(decl);
    assert.ok(i > 0, `${file}: ${decl} has moved — the rule is a line inside show() again?`);
    const m = src.slice(i).match(assign);
    assert.ok(m, `${file}: ${decl} no longer assigns state.sceneVisible`);

    let expr = m[1];
    for (const [re, js] of terms) expr = expr.replace(re, js);
    // `let racing = …` above the assignment is the roomState clause, named.
    assert.match(src.slice(i, i + m.index + m[0].length), /roomState\s*!=\s*"lobby"/,
      `${file}: the racing term is not "the room is not in the lobby" any more`);

    const residue = expr.replace(/welcome|hasTrack|racing|true|false/g, '')
      .replace(/[\s!&|()]/g, '');
    assert.equal(residue, '',
      `${file}: this file cannot read the rule any more — "${residue}" is left over `
      + 'after translating every term it knows. Update the terms above; do NOT let '
      + 'the check evaluate a fragment.');

    const fn = new Function('welcome', 'hasTrack', 'racing', `return (${expr});`);
    assertRule(name, ({ welcome, hasTrack, racing }) => !!fn(welcome, hasTrack, racing));
  });
}

// ---- and that each shell RE-ASKS, rather than deciding once ----------------

// The subtlety that makes this a function rather than a line in show(): the
// host picks from their phone, minutes after the lobby is already up, and the
// room state flips under a board that is already on screen. A rule evaluated
// only on navigation leaves the paper down over a built track.
const REASK = [
  {
    what: 'a PICK re-asks',
    sites: [
      ['shells/tvos/TinyTrackParty/App/GameCoordinator+Race.swift', 'func setTrack'],
      ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/GameCoordinator.kt',
       'fun setTrack']
    ]
  },
  {
    what: 'the room-state flip re-asks',
    sites: [
      ['shells/tvos/TinyTrackParty/App/RaceFlowPerformer.swift', 'case "transition"'],
      ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/RaceFlowPerformer.kt',
       '"transition" ->']
    ]
  }
];

for (const { what, sites } of REASK) {
  for (const [file, anchor] of sites) {
    test(`${what} — ${path.basename(file)}`, () => {
      const src = codeOf(file);
      const i = src.indexOf(anchor);
      assert.ok(i > 0, `${file}: ${anchor} has moved`);
      assert.match(src.slice(i, i + 500), /refreshBackdrop\(\)/,
        `${file}: ${anchor} does not re-ask — the state it changes is an INPUT to the rule`);
    });
  }
}

// ---- the harness must not photograph the welcome board over the 3D ---------

test('the gallery keeps the welcome board on paper', () => {
  // The fourth copy of the rule, keyed by SCENARIO rather than by state: the
  // harness overrides the backdrop wholesale for its previews. Only the welcome
  // clause is the rule; the rest of that list is the gallery's own taste about
  // which mid-boot moments to photograph.
  const m = codeOf('public/display/TestHarness.js').match(/DIORAMA_ONLY = \[([^\]]+)\]/);
  assert.ok(m, 'TestHarness DIORAMA_ONLY has moved');
  assert.ok([...m[1].matchAll(/'([a-z-]+)'/g)].some((x) => x[1] === 'welcome'),
    'the welcome scenario must stay diorama-only, or every welcome photograph is '
    + 'shot over a live track the game never shows there');
});
