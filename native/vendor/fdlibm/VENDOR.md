# Vendored deterministic math (fdlibm lineage)

- **Upstream**: JuliaLang/openlibm `v0.8.7`
  (https://github.com/JuliaLang/openlibm/archive/refs/tags/v0.8.7.tar.gz,
  sha256 `e328a1d59b94748b111e022bca6a9d2fc0481fb57d23c87d90f394b559d4f062`)
- **Why openlibm, not raw FreeBSD msun**: identical Sun fdlibm / msun sources
  (V8's Math.* forked the same lineage), but already made standalone — raw
  msun's `math_private.h` drags in FreeBSD kernel headers that would need
  hand-surgery we'd then own.
- **Local modifications**: the `openlibm_weak_reference(...)` /
  `openlibm_strong_reference(...)` long-double alias lines are deleted from
  the `.c` files (11 lines total). They alias `sinl/ldexpl/...` to the double
  functions — symbols nothing here references — and the ELF attribute-alias
  form they expand to breaks under our `ttp_fd_*` symbol renames on linux
  clang (macOS's asm form merely tolerated it). Function bodies are
  untouched; the regenerated WASM was verified result-identical against the
  pre-change corpus (4317/4317) and all trace fixtures before shipping.
  `e_sqrt.c` is deleted: see below.
- **License**: see LICENSE.md (MIT + Sun/fdlibm notice).

## What this is for

The six transcendentals on the sim's byte path — `sin, cos, atan2, exp, pow,
hypot` — are implementation-approximated: V8's results differ in the last bit
across V8 versions and CPU architectures, which used to pin golden traces to
one platform. The JS engine that recorded the corpus ran these sources as
WASM; the C++ engine links them (`ttp_mathlib`, native/CMakeLists.txt) under
strict FP flags (`-ffp-contract=off`, no fast-math, double-only), so every
build produces bit-identical results — verified continuously by the shared
corpus fixture `tests/fixtures/math-corpus.jsonl`.

`sqrt` is not taken from fdlibm: `pow`/`hypot` call the platform's, which
IEEE 754 requires to be correctly rounded, so it is identical to fdlibm's
`e_sqrt.c` and far cheaper than its bit-by-bit loop. Exact ops
(`abs/min/max/floor/round/%`) are bit-exact everywhere already.

## File inventory

Sources (`src/`): s_sin.c s_cos.c k_sin.c k_cos.c e_rem_pio2.c k_rem_pio2.c
e_atan2.c s_atan.c e_exp.c e_pow.c e_hypot.c s_fabs.c s_floor.c
s_scalbn.c s_copysign.c + private headers (cdefs-compat.h, math_private.h,
math_private_openbsd.h, types-compat.h, fpmath.h, aarch64_fpmath.h,
amd64_fpmath.h — the per-arch long-double layout headers fpmath.h selects;
irrelevant to our double-only surface but required to compile natively).
Headers (`include/`): openlibm_math.h openlibm_complex.h openlibm_defs.h.

native/CMakeLists.txt renames the entry points to `ttp_fd_*` via
`-Dsin=ttp_fd_sin ...` so the static lib never collides with system libm.
