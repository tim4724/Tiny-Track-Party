# Golden trace fixtures

Recorded runs of the JS engine (`public/display/engine/Game.js`), the
conformance oracle for the native C++ port. Format and tooling live in
`scripts/record-trace.mjs` / `scripts/verify-trace.mjs`; the replay contract
is EXACT float equality (same engine, same operation order).

`tests/trace.test.js` verifies every `.jsonl` in this directory on `npm test`.
If that test fails after an engine change, the behaviour change is real. If it
was intentional, re-record the fixtures with the exact commands below and
commit them with the engine change. Never loosen the comparison.

```
node scripts/record-trace.mjs --track=tidepool --frames=600 --bots=4 --seed=42 --snapshot-every=100 --out=tests/fixtures/traces/tidepool-4bots-600f-seed42.jsonl
node scripts/record-trace.mjs --track=helix --frames=500 --bots=3 --humans=1 --seed=7 --snapshot-every=100 --out=tests/fixtures/traces/helix-3bots-1human-500f-seed7.jsonl
```

Current set:

- `tidepool-4bots-600f-seed42.jsonl`: Beach Cup spline track, 4 persona bots,
  600 frames (10 s at 60 Hz). Covers spline geometry, item boxes, pickups and
  a bot item use.
- `helix-3bots-1human-500f-seed7.jsonl`: Rooftop stunt track (segment DSL with
  a loop), 3 bots plus one scripted human that deliberately kisses walls and
  curbs. Covers loop launch strips (pad boosts), wall scrub, pickups.

Keep fixtures short (a few hundred frames) and sized for git. Bump
`CONTRACT_VERSION` (`public/display/engine/contract.js`) when the snapshot
shape itself changes; the verifier refuses traces from another version.
