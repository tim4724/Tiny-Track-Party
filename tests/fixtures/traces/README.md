# Golden trace fixtures

Recorded runs of the JS engine (`public/display/engine/Game.js`), the
conformance oracle for the native C++ port. Format and tooling live in
`scripts/record-trace.mjs` / `scripts/verify-trace.mjs`; the replay contract
is EXACT float equality (same engine, same operation order).

## Status: ARMED

Fixtures are committed and `npm test` replays every one of them, everywhere.
Traces are engine- and platform-independent: the sim's transcendentals go
through `engine/math.js` (fdlibm compiled to WASM — see
`native/vendor/fdlibm/VENDOR.md`), not V8's `Math.*`, so a fixture recorded
on a macOS arm64 laptop replays bit-exactly on ubuntu x64 CI and,
eventually, against the native C++ engine linking the same vendored math.

The one provenance that must match is the mathlib build stamped in each
header (`math`); the `engine` stamp is informational. Fixtures with a stale
mathlib stamp fail the gate with a re-record message.

## Re-recording (after an intentional engine change)

Any machine works:

```
node scripts/record-fixtures.mjs
node scripts/verify-trace.mjs tests/fixtures/traces/*.jsonl   # belt & braces
git add tests/fixtures/traces
```

`scripts/record-fixtures.mjs` defines the standard set (two short starter
slices plus a full-race endgame fixture), asserts endgame coverage (all seven
event kinds, all four spin causes) and re-scans the seed automatically if an
engine change moved the race; when the seed changes, update `ENDGAME_SEED`
there. The record-traces workflow (`workflow_dispatch`) re-records on CI as
an independent cross-platform check — its artifact must be byte-identical to
the committed fixtures.

Never loosen the comparison; if the replay test fails after an engine
change, the behaviour change is real — re-record only if it was intentional.

Bump `CONTRACT_VERSION` (`public/display/engine/contract.js`) when the
snapshot shape itself changes; the verifier refuses traces from another
version. Rebuilding the WASM mathlib (new emsdk / flags) that changes
`MATHLIB` requires re-recording fixtures AND regenerating
`tests/fixtures/math-corpus.jsonl` in the same commit — deliberately.

## Current set

- `tidepool-4bots-600f-seed42.jsonl` — short starter slice, 4 bots
- `helix-3bots-1human-500f-seed7.jsonl` — short slice incl. scripted human
- `skysnake-5bots-2laps-seed39.jsonl` — full race to all-finished (endgame
  event coverage: finish, item_use, lap, monster_end, pickup, rocket_expire,
  spin; spin causes banana, monster, oil, rocket)
