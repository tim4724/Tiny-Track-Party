cmake_minimum_required(VERSION 3.21)
project(ttp-native LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- Strict FP: the determinism-bearing flags -------------------------------
# docs/native-port/fp-profile.md §6. These apply to EVERY target in this tree:
# the whole sim surface is conformance-gated, not just the mathlib.
#   -ffp-contract=off  no FMA contraction (WASM can't fuse; native must not).
#                      Apple clang and NDK clang default to 'fast' — this flag
#                      is the single highest-risk omission on device builds.
#   -fno-builtin       no libcall recognition/constant folding via host libm.
#   no fast-math family, ever.
add_library(ttp_strict_fp INTERFACE)
target_compile_options(ttp_strict_fp INTERFACE
  -ffp-contract=off
  -fno-builtin
  -fno-fast-math
)

# ---- Vendored fdlibm, native build ------------------------------------------
# Same sources the JS engine ships as WASM (public/display/engine/math.js —
# see vendor/fdlibm/VENDOR.md). Entry points are renamed ttp_fd_* via -D so
# the static lib never collides with system libm symbols; internal cross-calls
# (atan2→atan, pow/hypot→sqrt, k_rem_pio2→floor/scalbn) rename consistently
# because the -D rewrites every occurrence in every TU.
set(TTP_FDLIBM_RENAMES
  sin=ttp_fd_sin cos=ttp_fd_cos atan2=ttp_fd_atan2 atan=ttp_fd_atan
  exp=ttp_fd_exp pow=ttp_fd_pow hypot=ttp_fd_hypot sqrt=ttp_fd_sqrt
  fabs=ttp_fd_fabs floor=ttp_fd_floor scalbn=ttp_fd_scalbn
  copysign=ttp_fd_copysign
)
file(GLOB TTP_FDLIBM_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/vendor/fdlibm/src/*.c)
add_library(ttp_mathlib STATIC ${TTP_FDLIBM_SOURCES})
target_include_directories(ttp_mathlib PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor/fdlibm/include
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor/fdlibm/src
)
foreach(rename ${TTP_FDLIBM_RENAMES})
  target_compile_definitions(ttp_mathlib PRIVATE ${rename})
endforeach()
target_compile_options(ttp_mathlib PRIVATE -Wno-macro-redefined)
target_link_libraries(ttp_mathlib PUBLIC ttp_strict_fp)

# ---- Conformance: the shared math corpus ------------------------------------
# Replays tests/fixtures/math-corpus.jsonl (generated from the WASM build by
# scripts/gen-math-corpus.mjs) against THIS native build. Both passing is what
# makes golden traces valid conformance targets for the C++ engine.
enable_testing()
add_executable(mathlib_corpus_check mathlib/corpus_check.cc)
target_link_libraries(mathlib_corpus_check PRIVATE ttp_mathlib ttp_strict_fp)
add_test(NAME mathlib_corpus
  COMMAND mathlib_corpus_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/math-corpus.jsonl
)
