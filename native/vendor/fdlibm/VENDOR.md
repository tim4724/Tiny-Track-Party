# Vendored deterministic math (fdlibm lineage)

- **Upstream**: JuliaLang/openlibm `v0.8.7`
  (https://github.com/JuliaLang/openlibm/archive/refs/tags/v0.8.7.tar.gz,
  sha256 `e328a1d59b94748b111e022bca6a9d2fc0481fb57d23c87d90f394b559d4f062`)
- **Why openlibm, not raw FreeBSD msun**: identical Sun fdlibm / msun sources
  (V8's Math.* forked the same lineage), but already made standalone — raw
  msun's `math_private.h` drags in FreeBSD kernel headers that would need
  hand-surgery we'd then own.
- **Local modifications**: none. Files are byte-identical to upstream.
- **License**: see LICENSE.md (MIT + Sun/fdlibm notice).

## What this is for

The six transcendentals on the sim's byte path — `sin, cos, atan2, exp, pow,
hypot` — are implementation-approximated: V8's results differ in the last bit
across V8 versions and CPU architectures, which used to pin golden traces to
one platform. This ONE C source is compiled two ways:

- **WASM** (emscripten) → embedded in `public/display/engine/math.js`, called
  by the JS engine. Built by `native/scripts/build-mathlib.sh`.
- **Native** (clang/NDK/Xcode) → linked by the C++ port (`libttp-sim`).

WASM f64 arithmetic is fully deterministic and native builds use strict FP
flags (`-ffp-contract=off`, no fast-math, double-only), so both builds produce
bit-identical results — verified continuously by the shared corpus fixture
`tests/fixtures/math-corpus.jsonl`.

`sqrt` (`e_sqrt.c`) is included only for self-containment of internal calls
in `pow`/`hypot`; it is correctly rounded and therefore identical to any
IEEE `sqrt`. Exact ops (`abs/min/max/floor/round/imul/%`) stay on native
`Math.` in JS — they are bit-exact everywhere already.

## File inventory

Sources (`src/`): s_sin.c s_cos.c k_sin.c k_cos.c e_rem_pio2.c k_rem_pio2.c
e_atan2.c s_atan.c e_exp.c e_pow.c e_hypot.c e_sqrt.c s_fabs.c s_floor.c
s_scalbn.c s_copysign.c + private headers (cdefs-compat.h, math_private.h,
math_private_openbsd.h, types-compat.h, fpmath.h, aarch64_fpmath.h,
amd64_fpmath.h — the per-arch long-double layout headers fpmath.h selects;
irrelevant to our double-only surface but required to compile natively).
Headers (`include/`): openlibm_math.h openlibm_complex.h openlibm_defs.h.

Native builds (native/CMakeLists.txt) rename the entry points to `ttp_fd_*`
via `-Dsin=ttp_fd_sin ...` so the static lib never collides with system libm;
the WASM build keeps the plain names (they become the module's exports).
