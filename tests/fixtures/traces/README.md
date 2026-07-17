# Golden trace fixtures

Recorded runs of the JS engine (`public/display/engine/Game.js`), the
conformance oracle for the native C++ port. Format and tooling live in
`scripts/record-trace.mjs` / `scripts/verify-trace.mjs`; the replay contract
is EXACT float equality (same engine, same operation order).

## Status: DISARMED (no fixtures committed)

While no second engine exists, committed fixtures only distinguish
intentional from accidental behaviour change, and every intentional
physics/stats/track change costs a CI re-record round-trip (it happened twice
on the first two days). So the directory is deliberately empty and the
fixture-replay tests pass vacuously. The tooling itself stays exercised by
the in-process record/verify unit tests in `tests/trace.test.js` on every
`npm test`.

Guarding a refactor meanwhile needs no committed fixtures: record locally
before the change, replay after (same machine = same platform, bit-exact):

```
node scripts/record-fixtures.mjs        # before the refactor
node scripts/verify-trace.mjs tests/fixtures/traces/*.jsonl   # after
git checkout -- tests/fixtures/traces   # do not commit them
```

## Re-arming (before C++ conformance work starts)

Fixtures must be recorded on the REFERENCE PLATFORM, the CI unit job:
ubuntu x64, Node major pinned in `.github/workflows/test.yml`. Traces replay
bit-exactly only on the JS engine AND platform that recorded them:
transcendental `Math.*` results differ in the last bit across V8 versions,
and across architectures on the same V8 (per-arch codegen of V8's compiled
fdlibm; observed as identical Node 26.5.0 diverging between macOS arm64 and
Linux x64). Each header records its provenance
(`engine: { node, v8, os, arch }`) and the verifier names a mismatch in its
divergence report.

```
gh workflow run record-traces.yml --ref <branch>
gh run download <run-id> --name trace-fixtures --dir tests/fixtures/traces
```

`scripts/record-fixtures.mjs` defines the standard set (two short starter
slices plus a full-race endgame fixture), asserts endgame coverage (all nine
event kinds, all four spin causes) and re-scans the seed automatically if an
engine change moved the race; when the seed changes, update `ENDGAME_SEED`
there. Once fixtures are committed, `npm test` replays them on CI (a
wrong-platform fixture is a hard failure there) and skips them with a
diagnostic on dev machines. If you bump the CI Node pin, re-record all
fixtures in the same commit. Never loosen the comparison; if the replay test
fails after an engine change, the behaviour change is real — re-record only
if it was intentional.

Bump `CONTRACT_VERSION` (`public/display/engine/contract.js`) when the
snapshot shape itself changes; the verifier refuses traces from another
version.
