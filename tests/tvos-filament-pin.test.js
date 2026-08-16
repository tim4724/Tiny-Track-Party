'use strict';
// The Apple TV app must link the PINNED Filament — the same tree the engine
// archive it links was compiled against.
//
// WHY THIS IS A GATE AND NOT A COMMENT. `native/scripts/filament-checkout.sh`
// resolves native/filament.pin into a version-addressed checkout, and every
// artifact build sources it, precisely so no two things can name different
// Filament trees (a shared mutable checkout was rebased under a concurrent build
// once, which is why the resolver exists). The tvOS APP LINK was the one step
// that never got converted: project.yml carried
//
//     FILAMENT_TVOS_OUT: $(HOME)/Projects/filament/out/tvos-release
//
// a literal path to that same shared mutable tree. So libttp_runtime_tvos.a
// compiled against the pinned commit while the app linked Filament from whatever
// the shared checkout happened to be sitting at, with the two on one link line.
//
// It is invisible in every direction available to this tree. No ctest compiles
// the tvOS surface. The web leg's equivalent — a mixed-toolchain artifact — is
// caught by tests/native-artifact.test.js against BUILD_STAMP.json, but the
// tvOS archives are build output and carry no stamp. And the symptom is not a
// build error: .filamat blobs are MATERIAL_VERSION-locked, so a divergence
// surfaces as a material-load failure inside the app, on the television.
//
// The fix is that shells/tvos/scripts/prepare.sh derives the path from the pin
// into Generated/filament.xcconfig, and project.yml reads that. This holds both
// halves of that arrangement in place. The guards are deliberately literal, as
// tests/config-drift.test.js's are: a reformat fails loudly rather than quietly
// matching nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PROJECT_YML = 'shells/tvos/project.yml';
const PREPARE = 'shells/tvos/scripts/prepare.sh';
const XCCONFIG = 'Generated/filament.xcconfig';

test('project.yml declares no Filament path of its own', () => {
  const yml = read(PROJECT_YML);
  // Comments explain the arrangement and must stay readable, so judge only the
  // lines that would actually become build settings.
  const settings = yml.split('\n').filter((l) => !/^\s*#/.test(l));

  const assignment = settings.find((l) => /^\s*FILAMENT_TVOS_OUT\s*:/.test(l));
  assert.equal(
    assignment, undefined,
    `${PROJECT_YML} sets FILAMENT_TVOS_OUT itself:\n    ${assignment}\n`
    + `A project-level build setting OVERRIDES the xcconfig, so this silently\n`
    + `takes the app off the pin while ${XCCONFIG} sits there looking authoritative.\n`
    + `Delete the setting; ${PREPARE} is what answers this.`
  );

  const literal = settings.find((l) => /Projects\/filament/.test(l));
  assert.equal(
    literal, undefined,
    `${PROJECT_YML} names a Filament checkout by path:\n    ${literal}\n`
    + `The tree is whichever native/filament.pin resolves to, and only\n`
    + `native/scripts/filament-checkout.sh gets to answer that.`
  );
});

test('project.yml takes its Filament path from the generated xcconfig', () => {
  const yml = read(PROJECT_YML);
  assert.match(
    yml, /^configFiles:/m,
    `${PROJECT_YML} has no configFiles block, so nothing supplies FILAMENT_TVOS_OUT\n`
    + `and the header/library search paths resolve to bare $(PLATFORM_NAME) subtrees\n`
    + `of nothing. It must point at ${XCCONFIG}.`
  );
  for (const config of ['Debug', 'Release']) {
    assert.match(
      yml, new RegExp(`^\\s+${config}:\\s*${XCCONFIG}\\s*$`, 'm'),
      `${PROJECT_YML} does not point its ${config} configuration at ${XCCONFIG}.\n`
      + `Both configurations need it — a build in the one that lacks it links a\n`
      + `different Filament than the one that has it.`
    );
  }
});

test('prepare.sh derives that xcconfig from the pin, every run', () => {
  const sh = read(PREPARE);
  assert.match(
    sh, /source\s+"\$ROOT\/native\/scripts\/filament-checkout\.sh"/,
    `${PREPARE} no longer sources filament-checkout.sh, so the path it writes into\n`
    + `${XCCONFIG} is not the pin's answer. That is the whole point of the file.`
  );
  assert.match(
    sh, /FILAMENT_TVOS_OUT = \$FILAMENT_SRC\/out\/tvos-release/,
    `${PREPARE} does not write FILAMENT_TVOS_OUT from $FILAMENT_SRC — the resolved\n`
    + `tree — so whatever it does write is a second source for the pin.`
  );
  assert.ok(
    !/if\s*\[\s*!\s*-f\s*"\$TVOS\/Generated\/filament\.xcconfig"/.test(sh),
    `${PREPARE} only writes ${XCCONFIG} when it is absent. A cached copy is wrong\n`
    + `exactly when the pin moves, which is the one moment this has to be right.`
  );
});
