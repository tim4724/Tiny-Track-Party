# Golden traces — FROZEN cross-implementation evidence

These are recorded runs of the **retired JS engine** (`public/display/engine/Game.js`,
deleted when the sim went native — see git history). That is exactly why they are
valuable and why they must **never be re-recorded from C++**: they are the only
artifacts that prove the C++ engine reproduces the JS engine bit for bit. A trace
re-recorded from C++ would only prove C++ matches itself.

Replayed by `native/build/replay_cli <trace>` (the `replay_*` ctest entries) on
linux, macOS, wasm/Node and the tvOS simulator. `native/build/replay_cli --record
<trace> --out=<f>` reproduces each one BYTE-IDENTICALLY (the `record_*` ctest
entries hold that), which is what allows new fixtures to be authored natively now
that the JS recorder is gone: write a header JSON and record from it.

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
header (`math`); headers deliberately carry nothing machine-varying, so a
re-record is byte-identical on every machine. Fixtures with a stale mathlib
stamp fail the gate with a re-record message.

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

Milestone-1 oracle-expansion kinds (see `scripts/record-trace.mjs` header):

- `tidepool-ailive-4bots-600f-seed42.jsonl` — AI-LIVE: verify re-runs each
  bot's AiController and matches every control bit-for-bit
- `helix-session-jitter-3bots-1human-800f-seed7.jsonl` — RaceSession-driven
  with variable dt (seeded jitter + hitch spikes), countdown + racing flip
- `tidepool-schedule-5bots-1human-700f-seed42.jsonl` — every mid-race
  mutation op (giveItem/useItem/setCarStats/rekeyCar/removeCar/forceFinish),
  each asserted to have taken effect at record time
- `tidepool-session-ailive-4bots-900f-seed13.jsonl` — session + AI-LIVE
  combined under jittered dt
