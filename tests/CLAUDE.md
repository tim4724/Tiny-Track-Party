# tests/ — conformance

Conformance is the frozen corpora and golden traces under `tests/fixtures/`,
replayed by `native/` ctest — the same tests on every leg (linux / macOS / wasm /
tvOS-sim), because each leg just runs `ctest`.

## The rule that outranks everything here

The corpora exist so an entire module can be rewritten and still prove it does
what it did — regression evidence, not a freeze on the game's behaviour. (Rule
lowered 2026-08-08; before that they were permanent JS-recorded parity
evidence, never re-recordable, and the 2026-08-07 pace retune that first spent
that evidence is documented in the traces' README.)

**An unexplained replay failure is a defect in the change, never in the
fixture.** Fix the code; never touch a corpus to make a broken change pass.

**A deliberate behaviour change re-records, from green.** Prove the suite green
on the old recording FIRST, make the change, re-emit through the check's
`--record` mode (`npm run test:native -- -R "^record_"` names them), and read
the fixture diff — it must contain the intended change and nothing else. A
corpus whose check has no record mode (raceflow) is edited by hand under the
same green-first, read-the-diff rule.

## Two classes of fixture

**Class 1 — JS-recorded**: cross-implementation evidence from the port era. A
deliberate re-record demotes the fixture to class 2 from that commit on; the
JS-parity claim stays with the old bytes in git history. The traces, audio and
theme corpora have been demoted this way.

**Class 2 — C++-authored** (the `--record` mode of the sim, sweep and runtime
checks): regression evidence only. It proves the sim and cameras still do what
they did, never that the port was right.

`--record` exists on both and **means different things**. On a class-2 fixture it
AUTHORS: hand it a header and it produces a new fixture. On a class-1 fixture it
only RE-EMITS: each line's own recorded input is fed back through the port and the
answers written out again, so scenarios are read off the committed file and can
never be invented. Byte identity there proves the port reproduces every recorded
answer and its exact JSON spelling — strictly more than the structural replays
assert, and still **not** parity evidence. Every re-record is held by a `record_*`
ctest.

One fixture is **quantized** and has to be: the camera math is cosmetic float
calling the platform's trig, not the vendored fdlibm, and the four legs' libms
agree to a ulp rather than to the bit. **Do not read bit-exactness into it.**

See `tests/fixtures/traces/README.md`.

## The oracle generators

Some `scripts/gen-*-corpus.mjs` are **frozen** — their JS twin is retired, so they
can no longer run against a live implementation. Frozen headers name the `git show`
that restores a twin, and `npm run revive:js-oracle` does the set. The audio, ui,
session, schematic, theme and raceflow oracles were **deleted outright** with their
twins; those corpora can never be re-derived from JS at all. The `record_*`
roundtrip carries the freshness obligation for all of those except raceflow, whose
check replays structurally and deliberately has no record mode, so its obligation
simply ended with the oracle.

`tests/codegen-freshness.test.js` is the only thing in the tree that runs any
generator, so **an entry missing from it is not a weaker gate, it is no gate** —
live ones were dropped from it once already. What belongs there is a generator
that **re-derives a committed artifact from an input that can move**, whether that
input is JS or an ABI; a generator can rot without its own source changing.

**A frozen generator must stay OUT**, even though its source is still sitting
there. Running one would rewrite a corpus outside the deliberate green-first
re-record path. The list is the authority — read it rather than inferring
membership.

A corpus can still be judged redundant, but check what else covers its ground
first — the session corpus, for instance, is the only thing exercising the
SET_CAR/SET_READY **rejection** paths, the claim URL, the rejoin-token
normalizer and the cross-device seat claim, since wire-compat drives the
accepted paths only.

## A synthetic world rides in the corpus, never in the C++

A generator that invents cups, a catalogue, personas, stats or caps writes them
into the FIXTURE, and every replayer configures itself from what it reads.
Transcribing it instead is a constant edited in N places that rots in N−1 of them,
and one corpus has several replayers. **If you are typing a constant that also
exists in a `.mjs`, put it in the fixture instead.**

## What the traces cannot see

**Traces are one race per process**, so they cannot see state leaking from one race
into the next — a racing-line cache keyed by a recycled pointer made bots drive the
previous track's line, invisible to every trace. Three gates cover that blind spot:
`race_isolation` forces the address collision, `catalogue_sweep` re-races the
catalogue in reverse order demanding identical digests, and `replay_sequence`
replays every trace in one process. **When adding cross-race state, own it per
`Game`.**

**Traces also only race CATALOGUE tracks**, so anything no shipped layout contains
is unreachable by any fixture. No track builds with a pole, which is why pole
collision is covered by `hazards` constructing the situation directly.

## The abi ctest

The C ABI is not on the replay path, so the `abi` ctest covers the marshalling
layer the browser actually talks to — every ABI except the display shim (which no
ctest compiles) and the GLB loader, wire bytes included, plus every boundary
export against its header contract. It recompiles the shims rather than
linking a lib, so the shipped export list is untouched.

`tests/party-abi.test.js` covers the same ground in Node against the SHIPPED wasm,
**the only place that artifact is exercised**.

**A known, deliberate hole:** the audio decisions, the world they read and the ABI
wiring are each gated, but their ASSEMBLY inside the shipped wasm is not — the
check that raced the artifact against a second live implementation went with the
retired JS oracle. Do not claim coverage there that no longer exists.

## Wire-compat

`tests/wire-compat.test.js` + `tests/wire-fastlane.test.js` are the only place two
LANGUAGES must agree on bytes at RUNTIME — phones stay on the JS controller
forever on all three TV platforms.

**Both ends are real:** the shipped wasm through the display's own adapters, and
`partyplug/` plus the controller's modules unmodified. Only TRANSPORT is
fabricated. It covers what neither the corpora nor E2E can, since the corpora
replay recorded JS rather than a live peer, and E2E's stub relay is permissive
enough that it cannot produce the frames that break a real party.

So the relay here is a **model** of Party-Sockets with every prod/stub divergence
cited to a line of the real server, frozen in `relay-contract.json` by
`scripts/wire-relay-contract.mjs` (`--check` verifies without rewriting), which
re-derives it from a checkout and fails loudly when a cited behaviour moves.
**Green is not "prod-faithful"**: read that file's header for what the model still
is not.

`scripts/wire-mutate.mjs` is the gate's own gate — it patches `native/`, rebuilds,
swaps the artifact in and requires the named test to go red. It immediately found
the suite's blind spot: the display is the RECEIVER, so nothing ran the C++ link
as a SENDER. The cases are data in `scripts/wire-mutations.mjs`; **add one
whenever a shell gains a new send path.** `tests/wire-mutation-anchors.test.js`
runs on every `npm test` and exists because mutations silently stopped matching
anything when code moved — a mutation whose anchor is gone cannot fail.

## E2E

`tests/e2e/` drives real display + controller pages against a local relay stub via
the server's `RELAY_URL`, so it needs no production relay. Import `test`/`expect`
from `tests/e2e/helpers.js` (it reaps leaked phone contexts), and run
`npx playwright install chromium` once.

`airconsole.spec.js` is the exception to the relay stub: it drives the generated
AC entries over a mocked SDK (`airconsole-mock.js`, a BroadcastChannel transport)
with the real SDK's CDN URL blocked — controllers must share the DISPLAY's
browser context, or the channel cannot reach them.

`/gallery.html` is a manual no-relay preview surface; `/gallery-assets.html` is one
live scene you fly, and is dev-only. Its KIT FIELD stands models the game does not
ship, out of a cache no test has (`npm run fetch:kits`) — so what is gated is the
packing, in the `kitfield` ctest, and nothing asserts that a kit is on the disk.

## Auditing the suite itself

Two checks audit the SUITE rather than the code, weekly and on demand, never on
PRs: `npm run mutation-check` breaks the engine many ways and requires the matching
ctest to go red for each (gates have been found blind this way), and
`npm run revive:js-oracle` restores the retired JS sim and track builder from git —
each file from its own retirement commit — and re-records the golden traces
byte-identically. It pulls its whole dependency set out of history rather than
leaning on surviving modules, so it cannot rot from under itself.

While that passes, parity evidence is renewable. When it starts failing, decide
consciously whether to repair the twin or accept that the traces are frozen.
