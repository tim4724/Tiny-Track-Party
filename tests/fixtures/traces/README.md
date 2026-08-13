# Traces — C++-authored regression evidence (parity evidence SPENT)

These were recorded runs of the **retired JS engine** (`public/display/engine/Game.js`,
deleted when the sim went native — see git history), and were the only artifacts
proving the C++ engine reproduced the JS engine bit for bit.

**That parity evidence is gone, spent deliberately on 2026-08-07.** The pace
retune (the base constants at the top of `native/libttp-sim/ttp/game.cc`, and
their two mirrors in `ai_driver.cc`) changed every car's motion, so every replay
diverged. The JS engine no longer exists to re-record against, so the files were
RE-EMITTED from C++ instead: each line's own recorded INPUT was fed back through
the port and the answers rewritten. **The scenarios are unchanged** — the same
inputs, session ops, dt jitter and schedule ops the JS recorder captured — but the
answers are now C++'s own.

What that costs, precisely: these files answer "did the sim change since the
retune", and **nothing about JS parity**. The sim has no cross-implementation
oracle left. A future port or refactor has a regression baseline to check itself
against, not a second implementation. Weigh that before spending the same way twice.

The audio corpus was re-emitted in the same move and for the same reason — its
scenarios are DRIVEN by replaying these traces (`audio_check` takes a traces dir),
so it could not survive them. Its own JS oracle was deleted long before, so it too
is now C++-authored only.

On 2026-08-08 the rule itself was lowered (`tests/CLAUDE.md`): any corpus may now
be re-recorded for a deliberate change, green-first. The theme corpus was the
first under the new rule — the ambient particle counts were re-authored (denser
snow, then the camera-box count semantics), `ambient.count` rows and nothing
else.

On 2026-08-13 finished cars became solid to each other (still ghosts to the
racing pack — `Game::resolveCollisions`). Only skysnake races to all-finished,
so only it drifted and was re-emitted: the divergence starts after the second
car finishes, and every finish time is byte-identical to the previous recording.

The replay contract is unchanged: EXACT float equality (same operation order, same
vendored math), compared per frame as an FNV-1a of the canonical snapshot plus the
event list, with periodic full snapshots.

## Status: ARMED (as regression evidence)

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

**All of them are now FROZEN.** `sessionModel.js`, `uiModel.js`,
`audio/decide.js`, `trackSchematic.js` and finally `raceFlow.js` were deleted
once their ports were conformance-proven, and their generators went with them:
those corpora can never be re-derived, exactly like the traces above. The
`record_*` roundtrips replaced the freshness checks where a re-emit mode
exists; the raceflow check replays structurally and has none on purpose.

The schematic one is worth a note, because retiring its twin also moved a
SHIPPING codegen path onto C++: `scripts/gen-track-schematics.js` bakes
`public/shared/trackSchematics.js` from `ttp_track_schematic_json` now. That is
licensed by this corpus and by the bake reproducing BYTE-IDENTICALLY — the
committed file is still the bytes the JS wrote, and the `schematic` ctest holds
the native projection to them for all 20 tracks. What no longer has JS evidence
is a track added AFTER the recording; `tests/track.test.js` covers those against
the live geometry, but as C++ agreeing with C++.

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

## Retiring an oracle: what it still feeds is not visible from the generator

All four JS oracles are gone now (`uiModel.js`, `sessionModel.js`,
`audio/decide.js`, `trackSchematic.js`), so this is a note for the next
retirement rather than a live checklist. Twice in that round the module fed
something the generator naming it could not show you, and both were found by
grepping rather than by reading:

- `audio/decide.js` was also the MUSIC CATALOGUE, imported by
  `public/gallery-music.js` — a SERVED PAGE. Retiring it meant extracting
  `audio/musicCatalogue.js` first, not deleting a test fixture's oracle.
- `trackSchematic.js` was also a CODEGEN SOURCE FOR SHIPPED DATA: `npm run
  gen:schematics` baked `public/shared/trackSchematics.js` with it, and
  `display/main.js` imports that bake for the lobby mini-maps. Retiring it meant
  moving the bake onto `ttp_track_schematic_json` and proving the output
  byte-identical, which is what `scripts/gen-track-schematics.js` does now.

So before planning one: grep the whole tree for the module, separate the real
`import`s from the mentions in comments, and check `scripts/` and `package.json`
for a codegen path as well as `public/` for a page. "It is only an oracle" is a
claim about the whole repo, and the generator is the one file that cannot
support it. (`raceFlow.js`, the last oracle, retired cleanly by exactly this
audit: its generator was its one importer.)

## A corpus carries its own world

A generator that invents a synthetic world — cups, a track catalogue, personas,
car stats, room sizes, a max-players cap — must **write that world into the
corpus**, and every replayer must **read it from there**. Do not transcribe it
into C++.

The reason is that one corpus has many replayers. `ui-corpus.jsonl` is replayed
by `runtimetest/ui_check.cc` (through the library), by `runtimetest/abi_check.cc`
(through the C boundary) and re-emitted by `record_ui`; a tvOS or Android shell
would be a fourth. A transcribed world is therefore a number that has to be
edited in N places and rots in N-1 of them — and it does not fail cleanly when it
does: a replayer configured for the wrong catalogue diffs on every step that
touches it, which reads as a broken port rather than a stale copy.

So the ui corpus carries its world in the header:

```jsonc
{"kind":"ui","scenarios":37,"steps":1568,"version":1,
 "world":{"carCount":6,"catalog":[…],"cups":[…],"intermissionMs":10000,"maxPlayers":4}}
```

`ui_check` builds the model's types from it, `abi_check` hands the same object
straight to `ttp_ui_configure` — which makes the configure export's own contract
part of what the replay proves — and `record_ui` copies the header through
verbatim and configures from it, so the re-emit and the replay cannot disagree
about which world they are in. `raceflow_check` and `abi_check` read
`raceflow-corpus.jsonl`'s world the same way, through `ttp_race_configure`. A
corpus with no `world` is refused rather than replayed against an empty
catalogue.

Two shapes satisfy the rule, and either is fine:

- **In the header**, when the world is fixed for the whole file (the ui corpus).
- **In every step**, when it varies or is small — `session-corpus.jsonl` carries a
  fully resolved `in` per step, including its chooser payload, which is why
  `session_check.cc` needs no world at all and a step replays standalone.

What is *not* fine is a `const` in the check that the generator also spells. If
you are typing a number that also exists in a `.mjs`, put it in the fixture.

`raceflow-corpus.jsonl` carries its world the same way. No corpus world moves
anymore — every oracle is retired — but a transcribed copy of one still rots
silently, which is the same argument pointing the same way.

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
