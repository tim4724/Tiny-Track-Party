# Vendored google/double-conversion

Upstream: https://github.com/google/double-conversion

- **Tag:** `v3.3.1`
- **Tarball:** `https://github.com/google/double-conversion/archive/refs/tags/v3.3.1.tar.gz`
- **Tarball sha256:** `fe54901055c71302dcdc5c3ccbe265a6c191978f3761ce1414d0895d6b0ea90e`
- **License:** BSD-3-Clause (see `LICENSE`).

## What's here

Only the library source subdirectory `double-conversion/` (all `*.cc` + `*.h`)
plus `LICENSE`. The upstream `SConscript`, CMake glue, tests, docs, and MSVC
project files are dropped — `libttp-sim`'s CMake builds the 8 translation units
directly under the tree's strict-FP flags (`native/CMakeLists.txt`, target
`ttp_double_conversion`).

## Rationale

The golden-trace conformance surface is byte-exact JSON. `JSON.stringify` prints
each number as the **shortest decimal string that round-trips** to the same
IEEE-754 binary64 (ECMA-262 `Number::toString`, Grisu/Ryū class). `printf`
families (`%.17g`, `%g`) do NOT reproduce this. double-conversion's
`DoubleToStringConverter` in shortest mode emits exactly those digits; the
ECMA-262 formatting shell (integer forms, the `[1e-6, 1e21)` exponent window,
`-0 -> "0"`) is layered on top in `ttp/jsonnum.cc`.

`strtod` (via `StringToDoubleConverter`) is not used for output but the
correctly-rounded parse is validated round-trip in `replay_cli.cc`: every parsed
number is reformatted with `js_number_to_string` and compared to the source
text, proving the parse per value rather than assuming it.

## Updating

Re-download the tag tarball, verify the sha256 above, and replace the
`double-conversion/` subdir + `LICENSE` wholesale. No local modifications are
made to upstream sources.
