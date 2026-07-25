# Golden traces — FROZEN cross-implementation evidence

These are recorded runs of the **retired JS engine** (`public/display/engine/Game.js`,
deleted when the sim went native — see git history). That is exactly why they are
valuable and why they must **never be re-recorded from C++**: they are the only
artifacts that prove the C++ engine reproduces the JS engine bit for bit. A trace
re-recorded from C++ would only prove C++ matches itself.

The replay contract is EXACT float equality (same operation order, same vendored
math), compared per frame as an FNV-1a of the canonical snapshot plus the event
list, with periodic full snapshots.

## Status: ARMED

Replayed by `native/build/replay_cli <trace>` — the `replay_*` ctest entries — on
**linux, macOS, wasm/Node and the tvOS simulator**, because every leg runs the same
`ctest`. Note that this is `ctest`, not `npm test`: the Node suite touches these
files only through `tests/runtime-abi.test.js`, which replays ONE of them through
the shipped wasm's C ABI.

Traces are engine- and platform-independent: the sim's transcendentals go through
`engine/math.js` (fdlibm compiled to WASM — see `native/vendor/fdlibm/VENDOR.md`),
not V8's `Math.*`, so a fixture recorded on a macOS arm64 laptop replays bit-exactly
on ubuntu x64 CI and against the native C++ engine linking the same vendored math.

The one provenance that must match is the mathlib build stamped in each header
(`math`); headers deliberately carry nothing machine-varying, so a re-record is
byte-identical on every machine. Fixtures with a stale mathlib stamp fail the gate
with a re-record message.

## Two kinds of fixture, and the difference matters

**1. These traces: JS-recorded, frozen, never regenerated.** The recorder
(`scripts/record-trace.mjs`) and verifier (`scripts/verify-trace.mjs`) were retired
with the engine they drove, along with `scripts/record-fixtures.mjs` and the
`record-traces` CI workflow. There is deliberately no way left to re-record them,
and that is the point. The engine-free helpers those scripts shared live on in
`scripts/oracle-lib.mjs`.

If a sim change makes a replay fail, the behaviour change is real. Either it was
unintended — fix the code — or it was intended, in which case **the affected traces
stop being evidence**: you cannot re-record them against an engine that no longer
exists. Decide that consciously and say so in the commit.

**2. Natively-authored fixtures: regression evidence only.** `replay_cli --record
<header> --out=<f>` reproduces any committed trace BYTE-IDENTICALLY (the `record_*`
ctest entries hold that equality, which is what licenses the practice), so new
fixtures can be authored from C++: write a header JSON and record from it. Such a
fixture proves "the sim still does what it did when this was recorded" and says
NOTHING about JS parity.

`tests/fixtures/catalogue-sweep-corpus.jsonl` is the other member of this class —
all 20 tracks raced and digested, re-recordable with
`catalogue_sweep_check --record`. Keep the two classes distinct in your head: only
class 1 can ever settle a "did the port get it right" question.

## Blind spots these traces structurally cannot cover

- **ONE RACE PER PROCESS**, so no trace sees state leaking from one race into the
  next. That hid a real bug (a racing-line cache keyed by a recycled `Centerline*`).
  Covered instead by `race_isolation` (forces the address collision), the
  `catalogue_sweep` reverse-order pass, and `replay_sequence` (every trace in one
  process).
- **CATALOGUE TRACKS ONLY**, and only three of them race here, so anything a shipped
  layout never contains is unreachable: no track builds with a pole, so
  `collidePole` is covered by `hazard_check` instead.
- **THE C ABI IS NOT ON THIS PATH.** `replay_cli` calls C++ objects directly; the
  marshalling layer the browser actually talks to is covered by `abi_check`, which
  replays two of these traces through the exported C entry points.

Bump `CONTRACT_VERSION` (`public/display/engine/contract.js`) when the snapshot
shape itself changes; the replay refuses traces from another version. Rebuilding the
WASM mathlib (new emsdk / flags) so that `MATHLIB` changes would invalidate every
trace here at once — there is no re-record to fall back on, so treat the stamp as
load-bearing.

## Current set

- `tidepool-4bots-600f-seed42.jsonl` — short starter slice, 4 bots. No braking
  inputs at all, which is why `abi_check` replays helix too.
- `helix-3bots-1human-500f-seed7.jsonl` — short slice incl. scripted human
- `skysnake-5bots-2laps-seed39.jsonl` — full race to all-finished (endgame event
  coverage: finish, item_use, lap, monster_end, pickup, rocket_expire, spin; spin
  causes banana, monster, oil, rocket)

Oracle-expansion kinds:

- `tidepool-ailive-4bots-600f-seed42.jsonl` — AI-LIVE: the replay re-runs each bot's
  AiController and matches every control bit-for-bit
- `helix-session-jitter-3bots-1human-800f-seed7.jsonl` — RaceSession-driven with
  variable dt (seeded jitter + hitch spikes), countdown + racing flip
- `tidepool-schedule-5bots-1human-700f-seed42.jsonl` — every mid-race mutation op
  (giveItem/useItem/setCarStats/rekeyCar/removeCar/forceFinish), each asserted to
  have taken effect at record time
- `tidepool-session-ailive-4bots-900f-seed13.jsonl` — session + AI-LIVE combined
  under jittered dt
- `tidepool-session-beats-3bots-450f-seed21.jsonl` — session beats at dt 10
