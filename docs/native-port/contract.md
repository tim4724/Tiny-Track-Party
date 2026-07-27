# Sim data contract

> **The JS sources cited below are RETIRED.** Every `public/display/…` path in
> this document — `Game.js`, `AiDriver.js`, `TrackBuilder.js`, `Centerline.js`,
> `engine/{Vec3,math,util}.js` — was deleted once its C++ twin was
> conformance-proven; the `file:line` citations are historical provenance for how
> each rule was derived, not places you can open today. `git log --diff-filter=D`
> finds each one, and `node scripts/revive-js-oracle.mjs` restores the whole set
> into a throwaway worktree. This document stays as written because rewriting the
> citations would erase the only record of what the port was judged against.


The seam between the game engine and everything else (renderers, host UI,
tests, the future C++ port). The reference implementation is the JS engine at
`public/display/engine/Game.js`; every shape below is verified against that
code and against the committed golden traces in `tests/fixtures/traces/`.

Machine-readable JSON Schemas live in [contract/](contract/), one file per
structure:

| Schema | Structure |
|---|---|
| [snapshot.schema.json](contract/snapshot.schema.json) | `Game.getSnapshot()` |
| [events.schema.json](contract/events.schema.json) | `onEvent` payloads |
| [input.schema.json](contract/input.schema.json) | the CONTROL input message `{s, b, u}` |
| [track.schema.json](contract/track.schema.json) | `TrackBuilder.buildTrack()` output |
| [results.schema.json](contract/results.schema.json) | `Game.getResults()` |

`tests/schemas.test.js` asserts on every `npm test` run that the schemas'
field sets match a live snapshot, the engine's emitted event vocabulary, and
the committed trace fixtures.

## Contract version

`CONTRACT_VERSION = 2`, exported from `public/display/engine/contract.js` and
re-exported by `Game.js`. It is stamped as `version` on both `getSnapshot()`
and `buildTrack()` output, recorded in every golden-trace header
(`contractVersion`), and pinned by `const` in the snapshot and track schemas.
Bump it on ANY change to the shapes in this document: fields added, removed,
retyped, or units changed. The trace verifier refuses traces recorded against
another version.

## Coordinate system

Three.js convention: right-handed, +Y up, world units on all axes. Track
frames are orthonormal: `tangent` points along travel, `up` is the road
normal, and `lateral = tangent x up` (cross product), which points to the
driver's RIGHT. Positive `lat` therefore offsets a car to the right of the
centerline in the direction of travel. Yaw/heading angles are radians about
the local `up`.

## Units and time

- **World units**: the track arclength/position unit. Base top speed
  `VMAX = 9` world units/s; a lap is roughly 350 to 480 units (40 to 60 s).
  The default drivable road width is 5.0 world units
  (`TrackBuilder.SCALE = 2` times the unscaled default of 2.5).
- **Seconds**: all engine-side times. `elapsed`, `finishTime`, item and boost
  durations are seconds of SIMULATED race time.
- **Milliseconds**: only at the update boundary. The host feeds
  `Game.update(dtMs)` and `RaceSession.update(dtMs)` in ms; the engine
  converts to seconds internally and clamps each physics step to 0.05 s.
  Neither the engine nor RaceSession reads any clock: time only advances when
  the host injects dt, so pause is simply the host not calling update (or
  RaceSession dropping dt while paused).

## Determinism guarantee

Same seed + same dt sequence + same input sequence = bit-identical snapshots,
frame for frame. Specifically:

- The sim path (engine, Centerline, TrackBuilder data path, AiDriver,
  RaceSession) contains no `Math.random`, no clock reads, no platform timers,
  and no three.js. `tests/portable-purity.test.js` enforces this by source
  scan.
- All randomness is seeded: the HOST draws a per-race 32-bit seed with
  `Math.random` (`main.js`) and passes it as `track.seed`; the engine's item
  rolls consume a `mulberry32(track.seed)` stream, and each AI bot consumes
  its own `mulberry32` stream seeded from the race seed. The split is
  deliberate: hosts draw seeds, the sim only consumes streams.
- Vector math runs through the engine's own `Vec3`
  (`public/display/engine/Vec3.js`), whose method bodies are copied verbatim
  from three.js r184 so operation order (and therefore float rounding) is
  pinned.
- Transcendentals (`sin/cos/atan2/exp/pow/hypot`) sit on the byte path and
  are implementation-approximated, so the sim does NOT call V8's `Math.*`
  for them: it calls `engine/math.js`, fdlibm (FreeBSD msun via openlibm,
  `native/vendor/fdlibm/`) compiled to an embedded WASM module. WASM f64
  arithmetic is fully deterministic, so results are bit-identical on every
  JS engine, every platform, and every browser. The C++ port links the SAME
  vendored sources natively (strict FP flags: double-only,
  `-ffp-contract=off`, no fast-math); bit-equality between the two builds is
  pinned by the shared corpus `tests/fixtures/math-corpus.jsonl`
  (`tests/mathlib.test.js` on the JS side, its twin in `native/` on the C++
  side). Plain arithmetic and `Math.sqrt` are exact IEEE-754 everywhere and
  stay on native `Math`. The exhaustive FP + JS-semantics rules the C++ build
  must follow (double-only, `-ffp-contract=off`, `Math.round`/`%`/signed-zero/
  `mulberry32` semantics, the `JSON.stringify`-matching serializer) are in
  [fp-profile.md](fp-profile.md).
- Traces are therefore engine- and platform-independent: record fixtures on
  any machine, replay them anywhere. The one provenance that must match is
  the mathlib build stamped in each trace header (`math`); headers carry
  nothing machine-varying, so a re-record is byte-identical everywhere
  (`record-traces.yml` enforces this on CI). A fixture with a different (or
  missing) mathlib stamp is stale — the verifier and the fixture gate say so
  explicitly instead of reporting phantom divergence.

The executable form of this guarantee is the golden-trace tooling:
`scripts/record-trace.mjs` records a seeded headless race (inputs, events,
FNV-1a hash of the canonical-JSON snapshot every frame, full snapshots on a
cadence), `scripts/verify-trace.mjs` replays the recorded inputs through the
engine and demands EXACT float equality, and `tests/trace.test.js` replays
every committed fixture on `npm test`. The committed-fixture gate is ARMED
(since the mathlib swap, Milestone 0 of Track S): fixtures are committed and
replay everywhere; re-recording after an intentional behaviour change is one
local command (`node scripts/record-fixtures.mjs`, see
`tests/fixtures/traces/README.md`). The C++ port passes conformance when it
verifies every committed fixture at that point. The fixture set must cover
the whole event vocabulary and the endgame path, not just early-race
physics; `scripts/record-fixtures.mjs` defines the set and asserts that
coverage (two starter slices plus a full skysnake race exercising all seven
event kinds, all four spin causes, rocket flight, the monster transform, lap
counting across the s = 0 seam, and every car finishing inside the budget).

## Input: the CONTROL message

Schema: [input.schema.json](contract/input.schema.json). Shape on the wire
(`public/shared/protocol.js`): `{type:'control', s, b, u}`, sent at ~25 Hz.
The engine's `processInput(id, msg)` consumes `{s, b, u}`:

- `s`: steer, number, clamped by the receiver to [-1, 1]. Positive is one
  full lock, negative the other; the engine applies `STEER_SIGN = -1`
  internally so tilt-right steers right (see `steer` vs `steerInput` below).
- `b`: brake, analog number, clamped to [0, 1]. A boolean is accepted as a
  legacy form and mapped to 1/0. The shipped phone controller only ever sends
  0 or 1; the protocol is analog and AI bots use the full range.
- `u`: use-counter, integer 0 to 255, wrapping via `(x + 1) & 255` on each
  ACTION press edge. The engine fires the held item on ANY CHANGE from the
  last seen value (not increment-by-one), so the 255 to 0 wrap fires normally
  and delivery over a lossy channel is safe: every frame re-carries the
  current value, so a dropped frame just re-delivers it 40 ms later. Multiple
  presses between two delivered frames collapse into at most one fire. The
  fire request is LATCHED (`wantUse`), consumed on the first frame where the
  car holds an item, is not spinning, and the item has aged past the 0.9 s
  roulette-reveal gate; a latched press with no item clears harmlessly. Both
  sides start each race at 0 (the engine seeds `useSeq: 0`, the controller
  resets its counter when driving stops).

Each field is applied independently and only when present with the right type,
so a partial message is valid; production senders always include all three.
Inputs are rejected wholesale for unknown or finished cars (finished cars
victory-lap on autopilot).

Transport (not part of the sim contract, for context): CONTROL rides the
WebRTC fastlane when open, falling back to the WS relay; delivery is
lossy-but-ordered, which the level-coded fields above are designed for.

## Snapshot: `getSnapshot()`

Schema: [snapshot.schema.json](contract/snapshot.schema.json). Returns a fresh
tree of PLAIN data per call: JSON-serializable throughout, no vector classes,
no live references into the engine (`deepStrictEqual` against its own
JSON round-trip holds; a unit test asserts this).

Top level:

| field | type | meaning |
|---|---|---|
| `version` | integer | `CONTRACT_VERSION` stamp |
| `cars` | CarSnap[] | order = car insertion order (the starting grid at construction), NOT rank order. `rekeyCar` re-inserts the car at the TAIL of the order (Map delete + set), so after a device reconnect the array order differs from the grid |
| `boxes` | boolean[] | index-aligned with the track's authored `boxes` list; true = available (respawn cooldown expired) |
| `bananas` | object[] | `{id, s, lat, radius}`; only bananas currently live |
| `rockets` | object[] | `{id, s, lat}`; live homing rockets |

Prop notes: `bananas[].id` and `rockets[].id` are monotonically increasing
integers in two SEPARATE id namespaces (and separate from car ids).
`bananas[].s` is wrapped to [0, length) at drop time; `rockets[].s` is wrapped
at snapshot time. `bananas[].radius` is currently always the constant 0.5.

Per-car `CarSnap`:

| field | type | units / range | notes |
|---|---|---|---|
| `id` | number or string | | peerIndex (number) in live games; strings like `'cpu-bolt'` in bots/tests/traces |
| `pose` | object | world units | `{pos, forward, up}`, each a plain `{x, y, z}`; `forward`/`up` are unit vectors |
| `lat` | number | world units | signed lateral offset from the centerline (positive = right of travel), clamped inside the local curbs |
| `spd` | number | ratio | raw speed / vmax (per-car base top speed). EXCEEDS 1 under boost/monster: pad boost ceiling x1.60, item boost x1.5, monster x1.25, stacking to ~2.0. Do not assume [0, 1] |
| `lap` | integer | 1 to totalLaps | 1-based DISPLAY lap, clamped; grid cars (totalS < 0) show 1 |
| `totalLaps` | integer | | race length (default 3) |
| `position` | integer | 1 to N | live race rank; finished cars first by finish time |
| `finished` | boolean | | |
| `finishTime` | number or null | seconds | simulated race time at the line crossing; null until finished |
| `steer` | number | [-1, 1] | TURN-ALIGNED steer: sign matches the actual turn direction (`STEER_SIGN x` raw input), so renderers need not know the sign convention |
| `steerInput` | number | [-1, 1] | RAW controller input (drives the on-screen steer bar). The steer/steerInput asymmetry is deliberate |
| `brake` | number | [0, 1] | analog |
| `onWall` | boolean | | touching a curb this frame |
| `spin` | number | radians, >= 0, UNBOUNDED | cosmetic spin-out whirl angle; 0 when in control. A single spin sweeps 0 to 4 pi (SPIN_TURNS = 2 over SPIN_TIME = 1 s), but a SECOND oil/banana entered mid-spin re-arms the timer while keeping the angle continuous, so chained hazards grow it past 4 pi with no ceiling. Do not clamp or size anything to 4 pi |
| `item` | string or null | | one of `boost`, `banana`, `rocket`, `monster` |
| `boostMul` | number | [1, 1.6] | current speed-ceiling multiplier |
| `monster` | boolean | | transformed into the monster truck; renderer morphs the model |
| `totalS` | number | world units | CUMULATIVE arclength; negative on the starting grid; grows monotonically across laps, never wrapped |
| `heading` | number | radians, [-1.25, 1.25] | car yaw relative to the track tangent (clamped, no u-turns) |
| `halfLen` | number | world units | collision half-length, x1.3 while monster. Debug bbox overlay only |
| `halfWid` | number | world units | collision half-width, x1.3 while monster. Debug bbox overlay only |

## Events: `onEvent(e)`

Schema: [events.schema.json](contract/events.schema.json). Events are
synchronous calls from inside `Game.update()`; all payloads are plain data.
`id` is the car id in every event except `rocket_expire`, where it is the
ROCKET's id. Exactly seven kinds:

| type | payload | when |
|---|---|---|
| `spin` | `{id, cause}` | car spins out; `cause` is `banana`, `oil`, `rocket`, or `monster` (body-checked by a monster truck) |
| `monster_end` | `{id}` | monster transform timer lapses |
| `finish` | `{id, rank, time}` | car crosses the line on its final lap; `rank` = 1-based finish order, `time` = seconds. The race is over when the LAST car's finish arrives (hosts may also poll RaceSession's `raceOver` getter) |
| `lap` | `{id, lap}` | non-final line crossing; `lap` = completed-lap count (NOT the display lap). The first crossing from the s < 0 grid emits nothing |
| `pickup` | `{id, item, finished}` | item box collected; on a finished car with a full slot, `item` is the HELD item (no reroll) and `finished` is true |
| `item_use` | `{id, item}` | fired BEFORE the effect applies; `item` is the slot being fired |
| `rocket_expire` | `{id, s, lat}` | rocket self-destructs without a hit; `id` = rocket id, `s` wrapped to [0, length) |

## Results: `getResults()`

Schema: [results.schema.json](contract/results.schema.json).

```
{
  results: [
    { playerId,           // car id
      rank,               // 1-based, dense (index + 1 in this sorted array)
      finished,           // false = DNF or still racing at the failsafe timeout
      time }              // seconds, or null when !finished
  ]
}
```

Sorted by race order: finished cars first by finish time, then live cars by
race position. Removed (forfeited) cars are absent entirely. All plain data,
fresh objects.

## Track: `buildTrack()` output

Schema: [track.schema.json](contract/track.schema.json). Built by
`public/display/TrackBuilder.js` from either a segment-DSL list or a
`{waypoints}` spline descriptor; both feed the same finalize step and the same
output shape. Everything is world units. Fields:

- `version`: `CONTRACT_VERSION` stamp.
- `instances`: reserved scenery placement list, always `[]` today (the road is
  procedural).
- `startGate`: boolean flag (render the procedural finish gantry at s = 0).
  Not geometry.
- `pillars`: `{x, z, baseY, topY, radius}[]`, vertical support columns under
  raised bridge/ramp samples.
- `hills`: `Ring[][]`, grass berm runs under raised non-pillared road. Each
  ring is `{cx, cz, lx, lz, halfW, topL, topR}`: plan center, unit plan-lateral
  direction, half width, and the two top-corner heights (following the road's
  bank, clamped to ground).
- `loopStarts`: `{s, width}[]`, the arclength and local road width of each
  vertical-loop mouth. The host auto-places a full-width launch strip there.
- `supportPosts`: `{x, z, radius, baseY, contact: {pos: {x,y,z}, up: {x,y,z}}}[]`,
  loop-brace shafts; `contact` is the road sample whose underside the renderer
  clips the shaft top to (plain objects).
- `autoPoles`: `{s, lat, radius, ghost: true}[]`, engine collision poles for
  any pillar/shaft standing in a drivable corridor. `ghost` means the renderer
  must not draw it (the support is already the visual). The host merges these
  into `track.poles` for the engine and AI.
- `centerline`: a `Centerline` instance (`public/display/Centerline.js`). Its
  DATA is `samples` plus `length`; each sample is
  `{pos, tangent, up, lateral, s, width, pillars, hillable}` with `pos` and
  the three unit vectors as Vec3s, `s` the cumulative arclength
  (samples[0].s = 0, spacing ~0.5 world units), and `width` the local
  drivable width (can flare/pinch per sample). Methods the contract relies
  on: `sampleAt(s)` (fresh interpolated frame `{pos, tangent, up, lateral,
  width}`, s wraps mod length, non-uniform Catmull-Rom position with the
  spline's own derivative as tangent), `projectNear(point, sHint, maxStep)`
  (Newton projection returning `{s, lat, frame}` with s accumulated, NOT
  wrapped, and hard-clamped to sHint +- maxStep), and `widthAt(s)`. The track
  schema describes the serializable sample data; a port must reproduce the
  interpolation and projection semantics, which the golden traces pin down
  numerically.
- `length`: total closed-lap arclength, including the wrap span.
- `closed`: boolean, closure check (unscaled end gap < 0.5).
- `gap`: the unscaled closure gap the check measured.
- `roadWidth`: the track's DEFAULT drivable width (world units). Per-sample
  width may differ; the engine seeds its lateral clamp from this but the live
  curb clamp uses the per-sample width.
- `groundY`: grass plane elevation, just under the lowest road edge.

### Game-side augmentation (a separate layer)

The host's `buildEntry` (`public/display/main.js`) augments the built track
before handing it to the engine. These are NOT `buildTrack()` outputs; they
resolve authored fraction-of-lap positions (`u` in [0, 1)) to arclength `s`
against the built `length`:

- `cup`, `trackId`: identity for theming.
- `hazards`: oil slicks `{s, lat, radius, cones}`.
- `pads`: boost pads `{s, lat, radius}`, plus one auto `{s, lat: 0,
  shape: 'strip', halfLen, halfWidth}` launch strip per `loopStarts` entry.
- `boxes`: item boxes `{s, lat, radius}`.
- `poles`: authored solid poles `{s, lat, radius}` concatenated with the
  builder's `autoPoles`.
- `bananas`: authored pre-seeded bananas (dev tracks only) `{s, lat}`.
- `totalLaps` and the per-race `seed` (drawn by the host at race start).

The engine reads exactly this augmented object: `centerline`, `length`,
`roadWidth`, `totalLaps`, `hazards`, `pads`, `boxes`, `poles`, `bananas`,
`seed`. The golden-trace recorder (`scripts/record-trace.mjs
buildRaceTrack()`) mirrors this resolve so traces exercise the same layer.

### Schema and export

The whole augmented object has its own schema,
[race-track.schema.json](contract/race-track.schema.json): it carries the
built-track fields by `$ref` into `track.schema.json` and defines the
augmentation (identity, per-race inputs, and the resolved furniture `$defs` —
`hazard`, the `pad` disc/strip `oneOf`, `box`, `pole`, `banana`) in full,
`const`-pinned to `CONTRACT_VERSION`. `tests/schemas.test.js` enforces it the
same way as the others: top-level field vocabulary against a live augmented
track (a private descriptor exercising every furniture kind, plus a shipped
stunt track for the strip launch pad), plus a check that each built-field
`$ref` resolves into `track.schema.json`.

`scripts/export-track-data.mjs` dumps that object as canonical JSON — the
byte-for-byte fixture the C++ `TrackBuilder` + `resolveFurniture` port diffs
against. It reruns byte-identically (`buildTrack`/`resolveFurniture` are pure;
the machine-varying `seed` and `totalLaps` are pinned, default 1 and 3,
overridable with `--seed`/`--laps`), projects the live `Centerline` instance to
its serializable `{samples, length}`, and reuses `canonicalStringify`'s
recursive-sort semantics (reimplemented locally, not imported, so the exporter
and the recorder stay uncoupled). `--out=<dir>` writes one `<trackId>.json` per
shipped track; `--track=<id>` limits to one; without `--out` it prints to
stdout.

## Boundary query API

Outside the sim path, all engine reads go through `getSnapshot()`,
`getResults()`, the `raceOver` getter, and these plain-data queries (available
on `Game` and passed through by `RaceSession`); the purity test enforces the
seam. A port must expose the same surface:

- `carIds()`: fresh array of live car ids.
- `hasCar(id)`: boolean.
- `carFinished(id)`: boolean, or null for an unknown car.
- `carWorldPos(id)`: plain `{x, y, z}`, or null (unknown car or no pose yet).
- `trackPoint(s, lat)`: (arclength, lateral) to world `{x, y, z}`, s wraps
  mod length. The same frame math that poses cars.
- `driveBot(id, controller)`: steps one AI controller INSIDE the boundary
  (the controller sees the live car and engine; callers only pass ids).
- Mutations: `processInput(id, {s, b, u})`, `removeCar(id)` (forfeit),
  `rekeyCar(oldId, newId)` (device reconnect; moves the car to the tail of
  the snapshot `cars` order, see above), `setCarStats(id, stats)`.
- Staging hooks (demos and conformance tests, not live gameplay):
  `giveItem(id, item, {tCatch})`, `useItem(id)`, `forceFinish(id, time)`
  (silent: no `finish` event), `stageCar(id, {totalS, lat, v, boostMul,
  boostT})` (direct kinematic/boost write + pose refresh), `stageBanana(s,
  lat)` (live ownerless banana), `stageRocket(s, lat, {v, owner})` (live
  target-less rocket that whiffs at end of run).

## Removed dead fields

The 2026-07 pre-port cleanup removed the zero-consumer surface this contract
used to carry: `cars[].v`, `cars[].of`, `cars[].boostActive`, `cars[].tCatch`,
`elapsed` on both snapshot and results, `rockets[].owner`, and the `race_over`
and `pad` events. They live in git history; re-adding one is a contract
version bump like any other change.
