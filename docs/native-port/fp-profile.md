# Native port: FP + JS-semantics profile

The porting checklist for bit-exact conformance. `libttp-track` and
`libttp-sim` must reproduce the JS engine's floating-point results to the last
bit, verified against the committed golden traces (`tests/fixtures/traces/`,
tooling in `scripts/record-trace.mjs` / `scripts/verify-trace.mjs`). This doc
is the exhaustive list of every place JS number semantics differ from a naive
C++ transliteration, each grounded in the reference source with `file:line`
citations. The reference is the JS engine at `public/display/engine/Game.js`
and its sim-path siblings; the determinism guarantee it backs is
[contract.md §Determinism guarantee](contract.md#determinism-guarantee).

Sim path (the files this profile inventories, all comment-stripped scans):
`public/display/engine/{Game,util,contract,Vec3,math}.js`,
`public/display/{TrackBuilder,AiDriver,Centerline,RaceSession,GrandPrix}.js`,
`public/shared/{tracks,genTracks}.js`.

## 1. FP regime

| Rule | Statement |
|---|---|
| Precision | **`double` only.** No `float` intermediates anywhere in `libttp-track` / `libttp-sim`. `Vec3` (`public/display/engine/Vec3.js`) and every scalar are IEEE-754 binary64. A single `float` temporary is a conformance bug. |
| Contraction | **`-ffp-contract=off`.** No FMA. WASM f64 has no fused multiply-add, so `a*b+c` on the web rounds twice; native clang contracts it to one rounding by default (Apple clang: `fast`). This is the single highest-risk flag — see §6. |
| Reassociation | **None.** One operation order. `Vec3`'s method bodies copy three.js r184 verbatim (`Vec3.js:1-9` header) precisely so rounding is pinned; e.g. `normalize()` multiplies by a reciprocal, it does not divide componentwise (`Vec3.js:63-67`). Do not "simplify" any expression. |
| Fast-math | **Never.** No `-ffast-math`, `-Ofast`, `-fassociative-math`, `-freciprocal-math`, or finite-math assumptions. These reorder ops and drop ±0/NaN handling the sim depends on. |
| Rounding mode | Default round-to-nearest-ties-to-even. Never set FE rounding modes; never `-frounding-math`. |
| x87 | Forbidden. 80-bit x87 intermediates break binary64 determinism. On 32-bit x86 add `-mfpmath=sse -msse2`; arm64 and wasm are unaffected. |

**Web-side anchor.** WASM f64 arithmetic is fully deterministic across every JS
engine, CPU, and browser. That is why the JS engine is a valid oracle at all:
the recorder stamps only the mathlib build in each trace header
(`record-trace.mjs:136-151`), nothing machine-varying, so a re-record is
byte-identical on any machine. The native build's job is to match that WASM
f64 behaviour, which strict-FP double arithmetic does exactly.

## 2. Transcendentals — the vendored fdlibm

V8's `Math.sin/cos/atan2/exp/pow/hypot` are implementation-approximated and
differ in the last bit across V8 versions and architectures. The sim does NOT
call them. It calls `public/display/engine/math.js`, which embeds fdlibm
(JuliaLang/openlibm `v0.8.7`, unmodified Sun/msun lineage — the same source
V8 forked; see `native/vendor/fdlibm/VENDOR.md`) compiled to WASM. The C++
port links the **same** vendored `src/*.c` natively under strict FP flags.

| fdlibm function | JS byte-path call sites (via `dmath.*`) |
|---|---|
| `sin` | `Game.js:829,1222,1252,1320,1341,1374`; `TrackBuilder.js:52,53,181,191`; `Vec3.applyAxisAngle` (`Vec3.js:96`) |
| `cos` | `Game.js:829,1222,1251,1319,1341,1374`; `TrackBuilder.js:52,53,182,192`; `Vec3.js:98` |
| `atan2` | `Game.js:762,1405`; `TrackBuilder.js:283,297`; `AiDriver.js:96,140,300,344` |
| `exp` | `Game.js:716,747,921` |
| `pow` | `Game.js:694` (steer expo) |
| `hypot` | `TrackBuilder.js:225,228,435,489` |

`Math.sqrt` is **exact IEEE-754 everywhere** (correctly rounded) and stays on
native `Math.sqrt` / `std::sqrt` — it is not routed through the mathlib. Sites:
`Vec3.js:60,88`, `Game.js:1233`, `TrackBuilder.js:612`. `e_sqrt.c` is vendored
only for `pow`/`hypot`'s internal use.

**Gate.** `tests/fixtures/math-corpus.jsonl` (header + 4317 cases, hex64
big-endian, canonical-NaN class) is replayed by `tests/mathlib.test.js`
demanding identical bit patterns for all six functions. The C++ twin
(`native/`, Milestone 2) replays the same corpus. Both passing is the
foundation that makes traces platform-independent. Regenerate with
`scripts/gen-math-corpus.mjs` only as a deliberate, both-sides act.

## 3. JS semantics traps

Each trap is a place a naive C++ transliteration silently diverges. Implement
the documented helper; do not use the C library function it resembles.

### 3.1 `Math.round` — round-half-toward-+∞ (NOT C `round`, NOT `rint`)

ECMA-262 `Math.round` is **not** `floor(x + 0.5)` and **not** C `round`
(half-away-from-zero) and **not** `rint` (ties-to-even). Ties round toward
**+∞**; ±0 and the sub-0.5 boundary are special-cased.

Spec (ECMA-262 `Math.round(x)`):
1. If `x` is NaN, +∞, −∞, or an integer → return `x` (preserving ±0).
2. If `0 < x < 0.5` → return **+0**.
3. If `−0.5 ≤ x < 0` → return **−0**.
4. Otherwise return the integer closest to `x`; ties → the one nearer **+∞**.

The load-bearing gotcha: `Math.round(0.49999999999999994) === 0`, but
`Math.floor(0.49999999999999994 + 0.5) === 1` (the add rounds up to `1.0`
first). `std::round(-1.5) == -2` and `std::rint(2.5) == 2` also both disagree
with JS (`-1` and `3`). A correct, allocation-free implementation:

```cpp
double js_round(double x) {                        // ECMA-262 Math.round, literal
  if (!std::isfinite(x) || x == 0.0) return x;     // NaN/±inf/±0 pass through
  if (x > 0.0 && x < 0.5) return 0.0;              // spec branch 2 → +0
  if (x < 0.0 && x >= -0.5) return -0.0;           // spec branch 3 → -0
  double f = std::floor(x);
  double frac = x - f;                             // exact in binary64
  return frac < 0.5 ? f : f + 1.0;                 // frac == 0.5 tie → +inf
}
```

The two explicit ±0 branches matter only when the sign of the rounded zero can
feed a later `atan2`/`js_sign`/branch; because `JSON.stringify(-0) === "0"`
(§3.6) a −0 that only lands in a snapshot field is invisible, and in
`wrapDelta` a rounded ±0 is multiplied by `len` and subtracted, so its sign is
dead there. Keep the spec-literal form anyway — the sub-0.5 boundary
(`frac < 0.5` covering `0.49999999999999994 → 0`) and the toward-+∞ tie are
the parts that are always load-bearing.

Call-site inventory (all on the byte path unless noted):

| Site | Expression | Argument sign |
|---|---|---|
| `util.js:20` | `wrapDelta`: `ds - Math.round(ds / len) * len` | **± (negative ties live here)** — every oil/pad/box/banana/rocket/AI along-track proximity test routes through `wrapDelta` |
| `Game.js:356` | `Math.round((b.s \|\| 0) * 100)` — box-row bucket key | ≥ 0 |
| `Game.js:1005` | `Math.round(t * last)` — item-place table index | ≥ 0 |
| `TrackBuilder.js:125` | `Math.max(1, Math.round(len / DS))` — sample count | ≥ 0 (build-time) |
| `TrackBuilder.js:144` | `Math.max(1, Math.round(R * A / DS))` | ≥ 0 (build-time) |
| `TrackBuilder.js:178` | `Math.max(16, Math.round(2π r / DS))` | ≥ 0 (build-time) |
| `TrackBuilder.js:188` | `Math.max(8, Math.round(π r / DS))` | ≥ 0 (build-time) |
| `AiDriver.js:83` | `Math.max(16, Math.round(L / RL_STEP))` | ≥ 0 |
| `AiDriver.js:158` | `Math.max(2, Math.round(4 / h))` | ≥ 0 |
| `tracks.js:339` | cup difficulty mean (UI only, off byte path) | ≥ 0 |

`wrapDelta` (`util.js:19-21`) is the dangerous one: it is on the per-frame byte
path and takes signed arguments, so the negative-tie behaviour is observable.

### 3.2 `%` on doubles — truncated remainder (C `fmod`)

JS `%` on numbers is truncated remainder: result takes the **dividend's**
sign, matching C `std::fmod` exactly for finite operands. `(-0) % y === -0`;
`x % (±0) === NaN` (never occurs — divisors are positive lengths/counts).

Distinguish two uses in the port:

- **Arclength / angle wrap → `std::fmod` on `double`.** These have
  fractional operands and MUST stay double `fmod`:
  - `util.js:28` `wrapS`: `((s % len) + len) % len` → `[0, len)`. `Centerline.js:60` and `TrackBuilder.js:660,675,569` use the same idiom.
  - `Centerline.js:67` `idx`, but see below.
  - `TrackBuilder.js:202` `(rollAcc + seg.roll*DEG) % (2*Math.PI)` — **genuine float modulo of an angle**; use `std::fmod`.
- **Array-index wrap → integer `%` on `int`.** Operands are exactly-representable small integers; compute as `int` so the sign convention of `((k % n) + n) % n` gives a non-negative index identical to JS:
  - `Game.js:381` `Math.floor(i/2)`, `Game.js:382` `i % 2`.
  - `TrackBuilder.js:254,266,610` neighbour indices; `AiDriver.js:93,122,134,135,163,165,168,169,172,186,193,194` ring indices; `Centerline.js:67`.

Guidance: keep index math in `int`/`size_t`; keep position/angle math in
`double std::fmod`. A double `fmod` used for an index (or vice-versa) is a
latent divergence if the operand ever exceeds exact-integer range.

### 3.3 `|0`, `>>>0`, `>>`, `<<`, `&`, `Math.imul` — ToInt32/ToUint32 wrap

JS bitwise ops coerce operands via **ToInt32** (`|`, `&`, `^`, `<<`, `>>`) or
**ToUint32** (`>>>`), producing 32-bit wraparound. `Math.imul` is a full
int32×int32 → int32 multiply (wraps, unlike `*` on doubles). The port must use
`int32_t` / `uint32_t` with defined wrap, never `double`.

Inventory:

| Site | Op | Semantics |
|---|---|---|
| `util.js:9` | `a \|= 0`, `(a + 0x6D2B79F5) \| 0` | ToInt32 (32-bit wrap add) |
| `util.js:10` | `Math.imul(a ^ (a>>>15), 1 \| a)` | imul + ToUint32 shift + ToInt32 or |
| `util.js:11` | `(t + Math.imul(t ^ (t>>>7), 61 \| t)) ^ t` | imul, xor, or |
| `util.js:12` | `((t ^ (t>>>14)) >>> 0) / 4294967296` | ToUint32 → `[0,1)` double |
| `Game.js:373` | `(track.seed ... >>> 0) \|\| 1` | seed normalize (see §3.7) |
| `AiDriver.js:367` | `(seed >>> 0) \|\| 1` | seed normalize |
| `AiDriver.js:441` | `(this._useSeq + 1) & 255` | use-counter wrap (mirrors the wire `u`, contract.md Input) |
| `Centerline.js:50` | `(lo + hi) >> 1` | binary-search midpoint (ToInt32; operands small positive → plain `int` shift) |

No `<<` occurs on the sim path. Everything in `mulberry32` (§3.7) is
ToInt32/ToUint32/imul and must be ported to fixed-width integers.

### 3.4 `Math.min` / `Math.max` / `Math.sign` — ±0 and NaN ordering

ECMA-262 `Math.max`/`Math.min` differ from C++ `std::max`/`std::min` **and**
from `std::fmax`/`std::fmin`:

- **NaN-propagating.** Any NaN argument → NaN. `std::max`/`std::min` return an
  argument (implementation-defined); `std::fmax`/`std::fmin` return the
  non-NaN argument. All three disagree with JS on NaN.
- **Signed-zero ordering.** JS treats `−0 < +0`, deterministically and
  independent of argument order: `Math.max(+0,−0) === +0`,
  `Math.max(−0,+0) === +0`, `Math.min(+0,−0) === −0`, `Math.min(−0,+0) === −0`.
  `std::max`/`std::min` do NOT special-case ±0 (they return the first argument
  on a tie, so they are order-dependent: `std::max(-0.0,+0.0)` returns −0.0).
  `std::fmax`/`std::fmin` leave ±0 selection unspecified.

Port helpers (implement ECMA-262 literally, do not use std):

```cpp
double js_max(double a, double b) {           // ECMA-262 Math.max (2-arg)
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return std::signbit(a) ? b : a;  // -0 < +0
  return a > b ? a : b;
}
double js_min(double a, double b) {           // ECMA-262 Math.min (2-arg)
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}
double js_sign(double x) {                     // Math.sign: ±0 and NaN preserved
  if (std::isnan(x) || x == 0.0) return x;     // -0 → -0, +0 → +0
  return x > 0.0 ? 1.0 : -1.0;
}
```

NaN never reaches these on the byte path (§3.5), so the NaN branch is
defensive; the ±0 branch is the real requirement, because a −0 out of a clamp
can feed `atan2`/`js_sign`/`pow` and diverge downstream even though the field
itself would serialize as `"0"`.

Signed-zero-exposed sites to audit first (clamps of the form `Math.max(0, …)`
whose lower operand can be −0, and any min/max feeding a transcendental):
`Game.js:694` (`Math.sign(steerEff) * pow(...)` — `steerEff` can be −0),
`Game.js:756,790,850,920,942,943,1377`, `Game.js:1142,1157` (rocket accel
clamps), `Game.js:1226,1227` (bbox clamp feeding `atan2`/pose). Full min/max
inventory: `Game.js:60,382,430,431,607,713,717,725,1005,1023,1040,1059,1070,1139,1142,1149,1150,1157,1226,1227,1447`;
`TrackBuilder.js:125,144,178,188,283,309,310,338,430,446,540,612,617`;
`AiDriver.js:53,83,158,168,169,178,262,326,405`. `Math.sign`: `Game.js:694`,
`TrackBuilder.js:93,141`.

### 3.5 `Math.trunc` / `Math.floor` / `Math.ceil` / `Math.abs` on negatives

`Math.floor`/`Math.ceil` match `std::floor`/`std::ceil` exactly, including on
negatives (`floor(-2.5) == -3`). No special handling needed; just do not
substitute truncation for floor. `Math.trunc` has **no** sim-path call site.
`Math.ceil`: `TrackBuilder.js:617`. `Math.floor`: `Game.js:381,776,777`,
`AiDriver.js:193,388,438`, `GrandPrix.js:24` (all non-negative or exact).
`Math.abs` = `std::fabs` exactly (sign-bit clear, NaN payload preserved);
ubiquitous (44 sim-path sites incl. the `projectNear` break test,
`Centerline.js:126`) and safe — listed here only for inventory completeness.

### 3.5b Numeric falsy guards — `x || eps`

JS code guards degenerate denominators with logical OR: `(sC - sA) || 1e-6`
(`Centerline.js:75,79,80`), `this.length() || 1` (`Vec3.js:66` normalize),
`dmath.hypot(...) || 1` (`TrackBuilder.js:225,228,435,489`). Related trap:
`Math.sign(ang) || 1` and `Math.sign(ang || 1)` BOTH appear in TrackBuilder
(arc walk vs segBank) and coincide only for nonzero angles — port them as
the distinct expressions they are.
JS falsiness on numbers triggers for `+0`, `-0` AND NaN. The faithful C++
transliteration is

```cpp
inline double or_else(double x, double eps) { return x != 0.0 ? x : eps; }
```

which catches both zeros (`-0.0 == 0.0`) — exactly the JS behaviour for the
values that occur (NaN never reaches these sites on the byte path; `x != x`
would extend the guard if it ever could). Do NOT write `x == 0.0 ? eps : x`
with a preceding fabs, and do not "fix" the sign of a −0 denominator — the
JS takes the eps branch there and so must the port.

### 3.6 Number coercions on the trace path — JSON, shortest-form, signed zero

The trace bytes are the conformance surface, so the C++ serializer must emit
**byte-identical** JSON.

- **Round-trip exactness.** Doubles round-trip through JSON exactly
  (`parse(stringify(x)) === x`), so no precision is lost recording or
  replaying (`record-trace.mjs:49-51`).
- **Shortest round-trip formatting.** `JSON.stringify` prints a number as the
  shortest decimal string that round-trips to the same binary64 (ECMA-262
  Number::toString, Ryū/Grisu class). The C++ serializer MUST match this
  exactly — `printf("%.17g")` / `%g` will NOT match. Integer-valued doubles
  print with no decimal point or exponent (`3`, not `3.0`); exponent form
  only outside `[1e-6, 1e21)`, matching ECMA's thresholds. **RESOLVED (M3):**
  vendored google/double-conversion's
  `DoubleToStringConverter::EcmaScriptConverter().ToShortest()` reproduces
  `JSON.stringify(number)` byte-exactly for all finite doubles — proven by
  `tests/fixtures/json-number-corpus.jsonl` (52,357 cases incl. every double
  in the committed traces); no hand-rolled formatting needed
  (`native/libttp-sim/ttp/jsonnum.cc`, gated by `serializer_check`).
- **Array sorts must be STABLE.** V8's `Array.prototype.sort` is stable
  (spec-required); any ported comparator (e.g. Game's race-order sort) must
  use `std::stable_sort` — `std::sort` may permute equal-keyed cars and
  diverge the snapshot.
- **`JSON.stringify(-0) === "0"`.** The sign of −0 is erased at the
  serialization boundary. The verifier's comparator relies on this: `firstDiff`
  compares with `===`/`!==`, and `0 === -0` in JS, so ±0 never false-alarms
  (`verify-trace.mjs:34-37` comment). **Consequence for the C++ comparator:**
  compare at the *serialized-string* / fnv1a-hash level (where −0 is already
  `"0"`), or compare doubles with `==` (which treats ±0 equal). Never
  bit-compare doubles at the trace boundary — that would flag a benign ±0. A
  −0 only matters when it changes a *serialized value* or a *branch*, never on
  its own.
- **The two conformance surfaces treat ±0 OPPOSITELY.** The hex corpora
  (`math-corpus`, `track-sampler-corpus`, `trackbuilder-corpus`) compare raw
  bit patterns, so there −0 MUST be reproduced exactly (e.g. tidepool
  `samples[0].lateral.y` is −0 and the trackbuilder corpus pins it) — those
  gates directly validate `js_min`/`js_max`/`js_sign` ±0 handling. The
  decimal-JSON trace surface erases it. Know which surface you are debugging.
- **FP-accumulated loops are not integer-stepped.** e.g. TrackBuilder's
  supportPosts offsets: `for (off = 0.45; off <= 0.45 + 0.61; off += 0.15)` —
  the loop bound test runs on accumulated doubles; port with identical double
  additions, never `for (int k...)` reconstruction.

### 3.7 `mulberry32` — the exact uint32 recipe

The engine's item rolls (`Game.js:373`) and each AI bot's jitter stream
(`AiDriver.js:367`) draw from `mulberry32` (`util.js:7-14`). Seed
normalization at both call sites is `(seed >>> 0) || 1` — ToUint32, then map
`0 → 1` (JS falsy-OR). Exact port:

```cpp
struct Mulberry32 {
  uint32_t a;
  explicit Mulberry32(uint32_t seed) : a(seed ? seed : 1u) {}  // (seed>>>0)||1
  double next() {                                              // → [0,1)
    a += 0x6D2B79F5u;                                          // (a + k)|0
    uint32_t t = a;
    t = imul(t ^ (t >> 15), 1u | a);
    t = (t + imul(t ^ (t >> 7), 61u | t)) ^ t;
    t = (t ^ (t >> 14));
    return (double)t / 4294967296.0;                           // (t>>>0)/2^32
  }
  static uint32_t imul(uint32_t x, uint32_t y) { return x * y; } // wraps == Math.imul
};
```

`uint32_t` multiply wraps identically to `Math.imul`, and unsigned `>>` is the
logical shift `>>>`. The `a |= 0` in the JS is a no-op given `a` is already a
uint32 in this port. Seed provenance: `Game.js:373` reads
`track.seed ?? 0x1A2B3C4D`; `record-trace.mjs:78` sets `b.seed = seed >>> 0`;
bot seeds derive as `(raceSeed*31 + i + 1) >>> 0` (`record-trace.mjs:123`,
`makeBots` `:221`). Reproduce that integer arithmetic (with wrap) exactly.

## 4. Serialization

The port must reproduce the trace bytes and the frame hash exactly.

- **`canonicalStringify`** (`record-trace.mjs:52-57`): `JSON.stringify` with a
  **recursive key sort**. Objects emit keys in `Object.keys(...).sort()` order,
  `undefined` values dropped, arrays keep index order with `undefined → null`.
  The C++ serializer must sort object keys with the same (code-unit
  lexicographic) order and emit the same shortest-form numbers (§3.6).
- **`fnv1a`** (`record-trace.mjs:61-66`): 32-bit FNV-1a over the **UTF-8
  bytes** of the canonical string:

  ```cpp
  uint32_t fnv1a(const std::string& utf8) {            // bytes, not code points
    uint32_t h = 0x811c9dc5u;
    for (unsigned char b : utf8) { h ^= b; h *= 0x01000193u; }  // *= == Math.imul
    return h;                                            // (h>>>0), print as 8 hex
  }
  ```
  Output is `h` lower-hex, `padStart(8,'0')`. `h *= prime` on `uint32_t` wraps
  exactly like the JS `Math.imul(h, 0x01000193)`.
- **Snapshot field ordering** is irrelevant to bytes (keys are sorted) but the
  *set* of fields and their types must match the schema
  ([contract/snapshot.schema.json](contract/snapshot.schema.json)); `getSnapshot`
  emits plain JSON-serializable data only, no vector classes.

## 5. NaN policy

**Invariant: no NaN ever reaches a serialized field on the sim byte path.** The
schemas and the golden traces assume finite numbers throughout. If a NaN did
appear, `JSON.stringify` would emit `null` and the divergence would surface as
a type mismatch — treat any such occurrence as a sim bug, not a tolerance to
absorb.

The only NaN caveat is scoped to the **mathlib**, not the sim: WASM f64 can
produce non-canonical NaN bit *payloads*, and the corpus therefore
canonicalizes the NaN class (`math-corpus.jsonl` header `"nan = canonical NaN
class"`, `mathlib.test.js` `toHex`). The six transcendentals are never called
on domains that return NaN in the shipped tracks, so this does not reach the
sim. The native mathlib inherits fdlibm's NaN handling from the same sources;
match the corpus, do not special-case beyond it.

## 6. Compiler flags per target

The emscripten build (`native/scripts/build-mathlib.sh`) is the established
reference; the native targets must match its FP behaviour.

| Target | Flags |
|---|---|
| **emscripten / WASM** (shipped) | `-O2 -fno-builtin -ffp-contract=off` `--no-entry`, no fast-math. WASM has no FMA, so `-ffp-contract=off` is redundant there but kept explicit. |
| **clang, desktop macOS/Linux (arm64/x86-64)** | `-O2 -ffp-contract=off -fno-fast-math -fno-associative-math -fno-reciprocal-math -fno-builtin`. On 32-bit x86 only: add `-mfpmath=sse -msse2` (no x87). |
| **Apple Xcode (arm64 tvOS + macOS)** | Same clang flags. **Critical:** Apple clang defaults `-ffp-contract=fast` at `-O`, so `-ffp-contract=off` MUST be set explicitly; also `GCC_FAST_MATH = NO`. |
| **Android NDK (clang, arm64-v8a / armeabi-v7a)** | Same clang flags. `-ffp-contract=off` is critical (NDK clang default contracts within statements). armv7: ensure the FPU selection does not re-enable FMA contraction (the flag disables it regardless). |

Global prohibitions on all targets: no `-ffast-math`, `-Ofast`,
`-funsafe-math-optimizations`, `-ffinite-math-only`, `-frounding-math`. Build
`libttp-track` and `libttp-sim` (and the vendored mathlib) with these flags;
they apply to the whole determinism-bearing surface, not just the mathlib.

## 7. Enforcing gates

| Gate | Enforces |
|---|---|
| `tests/fixtures/math-corpus.jsonl` + `tests/mathlib.test.js` (+ C++ twin, `native/`) | Both mathlib builds compute identical transcendentals bit-for-bit (§2). |
| `tests/fixtures/traces/*` + `tests/trace.test.js` (JS) + the headless trace-replay CLI (C++, links `libttp-sim` only) | Exact per-frame snapshot/event/hash agreement — the whole FP + serialization stack (§3–5). Fixtures cover the full event vocabulary and the endgame (`scripts/record-fixtures.mjs`). |
| `tests/schemas.test.js` | Snapshot/event/track/results field sets match the contract and the fixtures. |
| `tests/portable-purity.test.js` | The sim path stays free of `Math.random`, clocks, and three.js — no non-deterministic input to begin with. |
| `record-traces.yml` (CI, `workflow_dispatch`) | Cross-platform re-record is byte-identical (the header carries no machine-varying provenance beyond the mathlib stamp). |

## 8. Highest-risk items

Ordered by likelihood of a silent port bug:

1. **`-ffp-contract=off` on Apple/NDK clang.** Default contraction fuses
   `a*b+c` into an FMA that WASM cannot produce; every `Vec3` and physics step
   diverges. One missing flag breaks everything, invisibly, only on device.
2. **`Math.round` ≠ any C rounding function** (§3.1). `wrapDelta`
   (`util.js:20`) is on the per-frame byte path with signed arguments, so the
   half-toward-+∞ tie and the `0.49999999999999994` boundary are observable.
   `std::round`/`rint`/`floor(x+0.5)` all diverge.
3. **`Math.min`/`Math.max`/`Math.sign` ±0 and NaN** (§3.4). A −0 out of a
   `Math.max(0, …)` clamp can feed `atan2`/`sign`/`pow` and diverge, while
   `std::max`/`fmax` mishandle both ±0 ordering and NaN. Hand-roll `js_min`/
   `js_max`/`js_sign`.
4. **Shortest-form number serialization** (§3.6). `printf` families do not
   reproduce ECMA `Number::toString`; the trace bytes and thus the fnv1a hash
   will mismatch. Vendor google/double-conversion.
5. **`mulberry32` / imul integer wrap** (§3.3, §3.7). Any use of `double`
   instead of `uint32_t`, or `*` instead of a wrapping multiply, desyncs every
   item roll and AI jitter draw for the rest of the race.
6. **double-only, no `float`** (§1). A stray `float` temporary in track meshing
   or physics rounds differently from binary64 and is hard to spot.
</content>
</invoke>
