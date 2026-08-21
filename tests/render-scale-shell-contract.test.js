'use strict';
// What the THREE SHELLS owe the render scale, checked statically.
//
// WHY A GREP AND NOT A BEHAVIOUR TEST. The rule and the controller are proved by
// the `render_scale` ctest on every leg, and the artifact by
// tests/render-scale-artifact.test.js. What neither can see is whether a shell
// still calls them, and the two TV shells are not reachable from Node at all —
// their frame loops are a CADisplayLink and a Choreographer, and their bodies
// only compile on one machine configuration each. The alternatives are a device
// farm or this.
//
// IT IS NOT A STYLE GATE. Every check below is a bug that HAPPENED, in shipped
// code, invisibly:
//
//   * both TV shells fed `ttp_perf_sample` only while their debug overlay was
//     visible, so pressing the toggle left the rule deciding a television's
//     resolution off an empty ring. Neither compiler nor test could see it,
//     because both halves were correct in isolation.
//   * two of the three folded their own p95 at `sorted[floor((n-1)*p)]` while
//     the shared fold behind the readout beside them used `sorted[floor(n*p)]`.
//     A television judged its resolution on different frames than it drew.
//
// Both are the same shape: a shell quietly re-deriving something the rule owns,
// or quietly starving it. A comment saying "do not do this" is not a mechanism;
// `docs/native-port/shells.md` item 15 states the contract, and this enforces it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The three shells, as the FILE SETS that make one. The perf feeder and the
// frame loop are separate files on every platform, and the contract spans both.
const SHELLS = {
  web: [
    'public/display/Stage.js',
    'public/display/render/Display.js',
    'public/display/render/PerfHud.js',
  ],
  tvos: [
    'shells/tvos/TinyTrackParty/Render/DisplayHost.swift',
    'shells/tvos/TinyTrackParty/Render/PerfOverlay.swift',
  ],
  androidtv: [
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/DisplayHost.kt',
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PerfOverlay.kt',
  ],
};

// The obligations every shell has, whatever its platform, as the CALL SITE that
// honours each — a file plus the symbol that must appear in it.
//
// A CALL, NOT A BINDING. The browser reaches the ABI through an adapter
// (`Display.js`), whose cwrap table names every export whether or not anything
// invokes it; searching the shell's files for the raw name therefore stays green
// while `Stage` quietly stops calling one. So the web rows name the adapter
// METHOD in the file that has to call it, and the TV rows name the C symbol in
// theirs. One hop each, and the hop is where the regression lives.
//
// NOT the whole export list: `ttp_display_scale_panel_ms` is owed only by a
// shell with no honest refresh-rate API to declare, which is the browser alone.
// The second test below covers the rest of the surface from the other end.
const OWED = {
  'feed the window the rule folds off': {
    web: ['public/display/render/PerfHud.js', 'perf.sample('],
    tvos: ['shells/tvos/TinyTrackParty/Render/PerfOverlay.swift', 'ttp_perf_sample('],
    androidtv: ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PerfOverlay.kt',
                'ttp_perf_sample('],
  },
  'tell it when a scene was built': {
    web: ['public/display/Stage.js', '.scaleScene('],
    tvos: ['shells/tvos/TinyTrackParty/Render/DisplayHost.swift', 'ttp_display_scale_scene('],
    androidtv: ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/DisplayHost.kt',
                'ttp_display_scale_scene('],
  },
  'ask for the operating point rather than choosing one': {
    web: ['public/display/Stage.js', '.scalePoll('],
    tvos: ['shells/tvos/TinyTrackParty/Render/DisplayHost.swift', 'ttp_display_scale_poll('],
    androidtv: ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/DisplayHost.kt',
                'ttp_display_scale_poll('],
  },
  "declare that point as the readout's budget": {
    web: ['public/display/Stage.js', 'perf.pacing('],
    tvos: ['shells/tvos/TinyTrackParty/Render/DisplayHost.swift', 'ttp_perf_pacing('],
    androidtv: ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/DisplayHost.kt',
                'ttp_perf_pacing('],
  },
};

const sources = (name) => SHELLS[name].map(read).join('\n');

test('every shell calls the four things the ledger says it owes', () => {
  for (const [duty, perShell] of Object.entries(OWED)) {
    for (const [name, [file, symbol]] of Object.entries(perShell)) {
      assert.ok(SHELLS[name].includes(file), `${file} is not listed under SHELLS.${name}`);
      assert.ok(read(file).includes(symbol),
        `the ${name} shell does not ${duty}: no \`${symbol}\` in ${file}.\n`
        + '  See docs/native-port/shells.md item 15. If the call moved to another file,\n'
        + '  move the row rather than deleting the check.');
    }
  }
});

test('every scale export the ABI declares is bound by at least one shell', () => {
  // DERIVED FROM THE HEADER, never listed here — an export declared and bound by
  // nobody is either dead or a shell that quietly stopped honouring it, and both
  // are worth a failure. (tests/render-scale-artifact.test.js proves the same
  // names survive the LINK; this proves someone calls them.)
  const src = read('native/runtime/ttp_display.h');
  const declared = [...src.matchAll(/TTP_ABI\s+[\w* ]+?\b(ttp_display_scale_\w+)\s*\(/g)]
    .map((m) => m[1]);
  assert.ok(declared.length >= 3, 'ttp_display.h declares no scale exports any more');
  const all = Object.keys(SHELLS).map(sources).join('\n');
  for (const fn of declared) {
    assert.ok(all.includes(fn), `${fn} is declared in ttp_display.h and no shell binds it`);
  }
});

test('no shell folds a percentile of its own', () => {
  // THE DRIFT THAT HAPPENED. `perf_stats.cc` carries "the one percentile
  // formula, so a p95 over one series is over the same frames as a p95 over
  // another" — and two shells had their own, off by one index, steering the
  // resolution of the picture their own overlay was describing.
  //
  // A DEFINITION, not a mention: the word is all over these files in comments
  // explaining why the shell does not compute one, which is exactly the state
  // this wants to preserve.
  const DEFN = /\b(?:fun|func|function)\s+percentile\b|\bpercentile\s*[:=]\s*(?:function|\()/;
  for (const [name, files] of Object.entries(SHELLS)) {
    for (const f of files) {
      assert.ok(!DEFN.test(read(f)),
        `${f} defines a percentile helper. The fold is ttp/perf_stats.cc's and the\n`
        + `  ${name} shell reads it off ttp_perf_readout_json — a second one is how the\n`
        + '  overlay and the render scale come to disagree about the same frames.');
    }
  }
});

test('the debug supersample ceiling cannot be reached under automation', () => {
  // `?supersample=` is the one path past all three of the band's real ceilings —
  // the panel's own resolution, the 2x cap and MAX_BUFFER_H — so it can ask for a
  // buffer twenty times the fill of a normal frame. The E2E cap (dpr 0.25) exists
  // to keep the suite fast, and a stray parameter on a URL a spec navigates to
  // must not be able to hand it that. Gated at the parse, once, so no later
  // reader has to remember.
  const src = read('public/display/Stage.js');
  const line = src.split('\n').find((l) => l.includes("params.get('supersample')"));
  assert.ok(line, 'Stage.js no longer reads ?supersample=');
  const guard = src.slice(src.indexOf(line), src.indexOf(line) + 400);
  assert.match(guard, /!automation/,
    '?supersample= is no longer gated on !automation — the E2E suite can be handed '
    + 'a multi-megapixel buffer per cell by a URL parameter');
  assert.match(guard, /MAX_SUPERSAMPLE/,
    '?supersample= is no longer clamped — a fat-fingered value takes the tab down');
});test('the perf sample is fed unconditionally, never behind the overlay', () => {
  // THE BUG THAT STARVED BOTH TELEVISIONS. `ttp_perf_sample` is one push into a
  // 120-frame ring; what costs anything is `ttp_perf_readout_json` and the
  // drawing, and both are behind their own rate limits. Gating the SAMPLE on a
  // debug panel's visibility means the render scale goes blind the moment
  // somebody presses the toggle — and it is what forced both TV shells to keep
  // measurement windows of their own.
  //
  // FOUR WAYS THIS GATE ITSELF WENT WRONG before it caught anything, every one
  // of them found by re-introducing the bug rather than by the suite going red.
  // A structural check like this is worth exactly what its anchors are worth:
  //
  //   * it matched the NAME, not the call — `ttp_perf_sample` appears in
  //     PerfHud.js's header prose 280 lines above the feed, so the search landed
  //     in a comment;
  //   * it looked for ANY early return, a shape only the TV shells have: the web
  //     feeds from a queue drain where `if (f.waiting) break` and `if (perf)`
  //     are both legitimate, so there it could only pass by accident;
  //   * it anchored the region on the nearest BLANK LINE, but stripping comments
  //     leaves blank lines behind — on tvOS that put the whole region 10
  //     characters from the call;
  //   * and `\bvisible\b` does not match `this._visible`, because `_` is a word
  //     character.
  //
  // So: comments stripped, region anchored on the enclosing FUNCTION by name,
  // the call matched as a call, and the thing looked for is the narrow shape
  // that actually shipped — a RETURN keyed on whether anyone is WATCHING,
  // between the function head and the feed.
  const decomment = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments, incl. Kotlin KDoc
    .replace(/^[ \t]*(?:\/\/\/?|\*).*$/gm, '');   // line comments, doc continuations

  // No leading \b: the flag is `_visible` on the web and `visible` on the TVs.
  const WATCHING = /(?:visible|benching|shown|hidden)\b/;
  // file -> [the function that feeds the monitor, the call that does it]
  const FEEDERS = {
    'public/display/render/PerfHud.js': ['_flush()', 'perf.sample('],
    'shells/tvos/TinyTrackParty/Render/PerfOverlay.swift':
      ['func record(', 'ttp_perf_sample('],
    'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PerfOverlay.kt':
      ['fun record(', 'ttp_perf_sample('],
  };
  for (const [file, [fn, callExpr]] of Object.entries(FEEDERS)) {
    const code = decomment(read(file));
    const head = code.indexOf(fn);
    const call = code.indexOf(callExpr, head < 0 ? 0 : head);
    assert.ok(head >= 0, `${file}: no \`${fn}\` — the feeder was renamed, fix the anchor`);
    assert.ok(call > head, `${file} no longer feeds the monitor (no \`${callExpr}\`)`);
    const gate = (code.slice(head, call).match(/^.*\breturn\b.*$/gm) || [])
      .find((l) => WATCHING.test(l));
    assert.ok(!gate,
      `${file} returns on a visibility flag before reaching ${callExpr}:\n`
      + `      ${gate && gate.trim()}\n`
      + '  The sample is unconditional; gate the DRAW and the per-phase profile read\n'
      + '  instead. A window kept only while a panel is up leaves the render scale\n'
      + '  deciding a television\'s resolution off an empty ring.');
  }
});

test('no shell puts the panel up on its own, and every shell can be asked to', () => {
  // TWO HALVES OF ONE DECISION, and the ledger (docs/native-port/shells.md) held
  // it open for a release because only the first half was ever in doubt: the
  // readout stays LIVE IN RELEASE — an instrument absent from the build that
  // ships cannot measure the thing people run — but it is OFF until somebody
  // asks. A player launching the game is not asking, and neither is a shot rig.
  //
  // The pair is what makes it safe. A default-off panel with no switch is the
  // "built, wired and unreachable" bug; a switch with no default is a black
  // diagnostic block over the corner of every television.
  //
  // Comments stripped, because all six anchors below are prose in these files as
  // well as code — the argument is written out at each site.
  const decomment = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(?:\/\/\/?|\*).*$/gm, '');

  // shell -> [the boot file that must NOT switch it on, the switch that must exist]
  const SWITCHES = {
    web: [
      ['public/display/render/PerfHud.js', /this\.show\(\)/],
      ['public/display/Stage.js', /params\.get\('perf'\)/],       // ?perf=1
    ],
    tvos: [
      ['shells/tvos/TinyTrackParty/App/GameCoordinator.swift', /^\s*display\.perf\.show\(\)/m],
      ['shells/tvos/TinyTrackParty/Render/PerfOverlay.swift', /forKey: "ttpPerf"/],  // -ttpPerf 1
    ],
    androidtv: [
      ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/MainActivity.kt',
       /PerfMonitor\.show\(\)/],
      ['shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/PerfDebug.kt',
       /debug\.ttp\.perf/],                                       // setprop debug.ttp.perf 1
    ],
  };
  for (const [name, [[bootFile, unconditional], [switchFile, asked]]] of Object.entries(SWITCHES)) {
    assert.doesNotMatch(decomment(read(bootFile)), unconditional,
      `the ${name} shell shows the perf panel at boot (${bootFile}).\n`
      + '  Default it off: gate it on the switch this shell already has.');
    assert.match(decomment(read(switchFile)), asked,
      `the ${name} shell has no way to ask for the perf panel (${switchFile}).\n`
      + '  A debug surface that cannot be reached on the device it was written for\n'
      + '  is not a debug surface. See docs/native-port/shells.md item 3.');
  }
});
