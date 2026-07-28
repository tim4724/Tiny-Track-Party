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

**`--record` on a class-1 fixture means something different, and the difference
is the whole rule.** `ui_check`, `audio_check`, `session_check` and
`schematic_check` each take `--record <fixture> --out=<f>` too, gated by
`record_ui` / `record_audio` / `record_session` / `record_schematic`. Those do
NOT regenerate a corpus: they RE-EMIT the committed one, feeding each line's own
recorded INPUT back through the port and writing the answers out again. The
scenarios — which ops, in which order, with which arguments, sweeps included —
are read off the committed file, never rebuilt, so a re-record cannot invent a
case.

What that buys is real but bounded: byte identity proves the port reproduces
every recorded answer AND its exact JSON spelling (key set, null-vs-absent, every
number through `js_number_to_string`), which is strictly more than the structural
replays assert. It is NOT parity evidence. The committed bytes carry that, and
the JS wrote them. **If a re-record ever differs from the committed file, the
committed file is right.** Do not overwrite it to make the gate green.

Class 1 also has members that are not traces at all. `session-corpus.jsonl` (the
display's room policy), `ui-corpus.jsonl`, `audio-corpus.jsonl` and
`raceflow-corpus.jsonl` (the race orchestration) were each recorded off live JS
AHEAD of their port; `schematic-corpus.jsonl` is the odd one, its per-track
expectations being the committed `public/shared/trackSchematics.js` bake.

**Three of them are now FROZEN.** `sessionModel.js`, `uiModel.js` and
`audio/decide.js` were deleted once their ports were conformance-proven, and
their generators (`gen-session-corpus.mjs`, `gen-ui-corpus.mjs`,
`gen-audio-corpus.mjs`) went with them: those three corpora can never be
re-derived, exactly like the traces above, and the `record_*` roundtrips are what
replaced the freshness checks. `raceflow-corpus.jsonl` and
`schematic-corpus.jsonl` are still RENEWABLE — `public/display/raceFlow.js` and
`public/display/trackSchematic.js` survive, and
`tests/codegen-freshness.test.js` still re-derives the schematic one.

The consequence is the one the ratchet always had: a frozen corpus can be
replayed and re-emitted forever, but it can never GROW. A new scenario for the
UI, session or audio layers can only be authored from C++, which proves nothing
about the JS it replaced.

`tests/fixtures/catalogue-sweep-corpus.jsonl` and
`tests/fixtures/runtime-camera-corpus.jsonl` are the other members of this class —
all 20 tracks raced and digested (`catalogue_sweep_check --record`), and the chase
camera, the framing/fog solve and the split-screen grid (`runtime_check --record`).
Keep the two classes distinct in your head: only class 1 can ever settle a "did the
port get it right" question. The camera corpus is the sharpest example of why:
`ChaseCamera.js` and SceneRenderer's overview rigs were deleted with the JS
renderer, so it can only ever say "the cameras still do what they did when this was
recorded" — never that the port from JS was right.

`runtime-camera-corpus.jsonl` is also the ONE fixture here whose numbers are not
exact. Everything else is bit-exact because the sim routes every transcendental
through the vendored fdlibm; the camera math deliberately does not — it is cosmetic
float and calls the platform's `expf`/`logf`/`tanf`/`atan2f`, and Apple libm, glibc
and musl (which is what emscripten ships) agree on those to about a ulp rather than
to the bit. So each recorded value is rounded to 4 significant decimal digits, and
`--record` refuses to freeze one sitting close enough to a rounding boundary that a
one-ulp difference could flip it. That guard is what lets `record_runtime` hold byte
identity on all four legs; it also means the fixture pins behaviour to ~0.1%, not to
the bit. Do not copy the pattern anywhere the vendored math is available.

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
