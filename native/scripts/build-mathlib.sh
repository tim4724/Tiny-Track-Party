#!/usr/bin/env bash
# Build the deterministic fdlibm mathlib to standalone WASM and embed it
# (base64) into public/display/engine/math.js between the GENERATED markers.
#
# The C++ engine links the same sources natively; bit-equality between the
# two builds is enforced by tests/fixtures/math-corpus.jsonl on both sides.
#
# Flags matter for determinism:
#   -ffp-contract=off  no FMA contraction (wasm has none, native would)
#   -fno-builtin       no libcall recognition/constant-folding via host libm
#   no fast-math       (never add it)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EMCC="${EMCC:-$HOME/emsdk/upstream/emscripten/emcc}"
FDLIBM="$ROOT/native/vendor/fdlibm"
BUILD="$ROOT/native/build"
OUT="$BUILD/fdlibm.wasm"
TARGET="$ROOT/public/display/engine/math.js"

mkdir -p "$BUILD"

"$EMCC" -O2 -fno-builtin -ffp-contract=off \
  -I"$FDLIBM/include" -I"$FDLIBM/src" \
  "$FDLIBM"/src/*.c \
  --no-entry -o "$OUT" \
  -sEXPORTED_FUNCTIONS=_sin,_cos,_atan2,_exp,_pow,_hypot \
  -Wno-macro-redefined

node - "$OUT" "$TARGET" <<'EOF'
const fs = require('fs');
const [wasmPath, targetPath] = process.argv.slice(2);
const b64 = fs.readFileSync(wasmPath).toString('base64');
const src = fs.readFileSync(targetPath, 'utf8');
const begin = '// BEGIN GENERATED WASM — do not edit by hand (build-mathlib.sh)';
const end = '// END GENERATED WASM';
const [head, rest] = src.split(begin);
const tail = rest.split(end)[1];
if (tail === undefined) throw new Error('GENERATED markers not found in ' + targetPath);
fs.writeFileSync(targetPath,
  head + begin + "\nconst WASM_BASE64 = '" + b64 + "';\n" + end + tail);
console.log(`embedded ${b64.length} base64 chars into ${targetPath}`);
EOF
