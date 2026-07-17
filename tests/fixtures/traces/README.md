# Golden trace fixtures

Recorded runs of the JS engine (`public/display/engine/Game.js`), the
conformance oracle for the native C++ port. Format and tooling live in
`scripts/record-trace.mjs` / `scripts/verify-trace.mjs`; the replay contract
is EXACT float equality (same engine, same operation order).

`tests/trace.test.js` verifies every `.jsonl` in this directory on `npm test`.
If that test fails after an engine change, the behaviour change is real. If it
was intentional, re-record the fixtures with the exact commands below and
commit them with the engine change. Never loosen the comparison.

Traces replay bit-exactly only on the JS engine AND platform that recorded
them: transcendental `Math.*` results differ in the last bit across V8
versions, and across architectures on the same V8 (per-arch codegen of V8's
compiled fdlibm; observed as identical Node 26.5.0 diverging between macOS
arm64 and Linux x64). Each header records its provenance
(`engine: { node, v8, os, arch }`) and the verifier names a mismatch in its
divergence report.

The REFERENCE PLATFORM is the CI unit job: ubuntu x64, Node major pinned in
`.github/workflows/test.yml`. Fixtures must be recorded there, via the
"Record golden-trace fixtures" workflow (workflow_dispatch on
`.github/workflows/record-traces.yml`, which runs
`scripts/record-fixtures.mjs`); download the `trace-fixtures` artifact and
commit it. On other machines `npm test` skips the fixture replay with a
diagnostic (the in-process record/verify tests still run); on CI a
wrong-platform fixture is a hard failure. If you bump the CI Node pin,
re-record all fixtures in the same commit.

```
gh workflow run record-traces.yml --ref <branch>
gh run download <run-id> --name trace-fixtures --dir tests/fixtures/traces
```

Current set (the port passes conformance when it verifies ALL of them; keep
the union of their coverage complete when re-recording):

- `tidepool-4bots-600f-seed42.jsonl`: Beach Cup spline track, 4 persona bots,
  600 frames (10 s at 60 Hz). A starter slice: spline geometry, item boxes,
  pickups and a bot item use.
- `helix-3bots-1human-500f-seed7.jsonl`: Rooftop stunt track (segment DSL with
  a loop), 3 bots plus one scripted human that deliberately kisses walls and
  curbs. A starter slice: loop launch strips (pad boosts), wall scrub,
  pickups, and the human-input record/replay path.
- `switchback-5bots-2laps-seed39.jsonl`: the ENDGAME fixture, a complete
  2-lap race on the shortest catalogue track (5 bots, 3600 frames, 60 s).
  Seed 39 was picked by scanning seeds for full coverage under the current
  physics: all nine event kinds (including `lap`, `finish`, `race_over` and
  `rocket_expire`), all four spin causes (banana, oil, rocket, monster
  body-check), rocket flight and homing, the monster transform, lap counting
  across the s = 0 seam, finish ranking and post-finish victory laps.
  Deliberately longer than the starter slices; do not trim it below
  `race_over` at frame 3519 (the last `rocket_expire`/`spin:oil` land at
  frames 3450/3460). An engine-behaviour change usually shifts coverage:
  after re-recording, re-check that the union still spans all nine kinds and
  all four spin causes, and re-scan seeds if it does not.

Keep the starter slices short (a few hundred frames); the endgame fixture is
the one deliberate exception. All sizes stay git-friendly (JSON compresses
well in packfiles). Bump `CONTRACT_VERSION`
(`public/display/engine/contract.js`) when the snapshot shape itself changes;
the verifier refuses traces from another version.
