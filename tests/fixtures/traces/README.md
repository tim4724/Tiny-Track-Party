# Golden trace fixtures

Recorded runs of the JS engine (`public/display/engine/Game.js`), the
conformance oracle for the native C++ port. Format and tooling live in
`scripts/record-trace.mjs` / `scripts/verify-trace.mjs`; the replay contract
is EXACT float equality (same engine, same operation order).

`tests/trace.test.js` verifies every `.jsonl` in this directory on `npm test`.
If that test fails after an engine change, the behaviour change is real. If it
was intentional, re-record the fixtures with the exact commands below and
commit them with the engine change. Never loosen the comparison.

Traces replay bit-exactly only on the JS engine that recorded them: V8's
transcendental `Math.*` results differ in the last bit across versions, so a
different Node major legitimately diverges. Each header records its engine
(`engine: { node, v8 }`), the verifier names an engine mismatch in its
divergence report, and CI (`.github/workflows/test.yml`) pins the matching
Node major. Record fixtures under that same Node major; if you bump the CI
pin, re-record all fixtures in the same commit.

```
node scripts/record-trace.mjs --track=tidepool --frames=600 --bots=4 --seed=42 --snapshot-every=100 --out=tests/fixtures/traces/tidepool-4bots-600f-seed42.jsonl
node scripts/record-trace.mjs --track=helix --frames=500 --bots=3 --humans=1 --seed=7 --snapshot-every=100 --out=tests/fixtures/traces/helix-3bots-1human-500f-seed7.jsonl
node scripts/record-trace.mjs --track=switchback --frames=3600 --bots=5 --humans=0 --seed=39 --laps=2 --snapshot-every=400 --out=tests/fixtures/traces/switchback-5bots-2laps-seed39.jsonl
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
