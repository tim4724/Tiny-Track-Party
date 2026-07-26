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

# ---- Warnings, on OUR code only ---------------------------------------------
# Deliberately NOT on ttp_strict_fp, which the vendored fdlibm and
# double-conversion also link: those are taken whole from upstream and must never
# be edited to satisfy our warning taste (see their VENDOR notes).
#
# This exists because two pieces of dead code — an AiController field never read
# and a track-def lookup duplicating race_track.h's — sat in the tree unnoticed
# through the whole port. Nothing built with -Wall, so nothing said so. Enabling
# it here means the next one shows up in the first local build rather than in a
# one-off audit. Not -Werror: a newer compiler inventing a warning should not
# stop a contributor from building, and CI can add -Werror explicitly if wanted.
add_library(ttp_warnings INTERFACE)
target_compile_options(ttp_warnings INTERFACE
  -Wall
  -Wextra
  -Wno-unused-parameter   # ABI stubs and callback signatures keep unused params by contract
)

# Emscripten leg (Track S M4): the same check binaries and replay CLI compile
# to WASM and run under Node — `emcmake cmake ... -DCMAKE_CROSSCOMPILING_EMULATOR=$(which node)`
# lets ctest run them transparently. NODERAWFS reads the fixture files straight
# from the host filesystem; EXIT_RUNTIME lets ctest observe the exit code.
#
# These link options belong on the ctest EXECUTABLES ONLY, applied through
# ttp_emscripten_cli() below — NOT on the ttp_strict_fp INTERFACE, whose flags
# leak to every consumer including the browser module ttp_runtime_web (which must
# have neither NODERAWFS nor EXIT_RUNTIME). wasm f64 needs no FP flags.
function(ttp_emscripten_cli target)
  if(EMSCRIPTEN)
    target_link_options(${target} PRIVATE
      -sNODERAWFS=1
      -sALLOW_MEMORY_GROWTH=1
      -sEXIT_RUNTIME=1
    )
  endif()
endfunction()

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

# ---- Vendored google/double-conversion (v3.3.1) -----------------------------
# ECMA-262 Number::toString (shortest round-tripping decimal) for the trace
# serializer — printf can't match JSON.stringify (fp-profile §3.6). Only the
# library source subdir is vendored (see vendor/double-conversion/VENDOR.md);
# built here under the same strict-FP flags as the rest of the tree.
file(GLOB TTP_DC_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/vendor/double-conversion/double-conversion/*.cc)
add_library(ttp_double_conversion STATIC ${TTP_DC_SOURCES})
target_include_directories(ttp_double_conversion PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor/double-conversion)
target_link_libraries(ttp_double_conversion PUBLIC ttp_strict_fp)

# ---- libttp-json: the shared plain-data layer -------------------------------
# ttp::Value (a tagged JSON tree) plus its serializer and parser: canonical
# stringify + FNV-1a (the trace/corpus digest format), ECMA-262 Number::toString
# via double-conversion, and text -> Value. EVERY other target depends on this
# and nothing here depends on them, so it is its own library rather than a
# corner of libttp-sim: the party layer, both C ABIs and every conformance check
# need Value, and none of them should have to link a sim to get it.
add_library(libttp_json STATIC
  libttp-json/ttp/jsonnum.cc
  libttp-json/ttp/canonical.cc
)
target_include_directories(libttp_json PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/libttp-json)
target_link_libraries(libttp_json PUBLIC ttp_double_conversion ttp_strict_fp ttp_warnings)

# ---- Shared conformance-check machinery -------------------------------------
# testsupport/corpus_diff.h: ONE corpus reader (ttp/json_parse.h) and ONE
# structural comparator for every check below. It decides pass/fail for the whole
# scheme, so it exists exactly once — three hand-copied versions had already
# drifted before this target existed.
add_library(ttp_testsupport INTERFACE)
target_include_directories(ttp_testsupport INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/testsupport)
target_link_libraries(ttp_testsupport INTERFACE libttp_json)

# ---- libttp-track: the sampler math (util, Vec3, Centerline) -----------------
# The C++ twin of public/display/engine/{util,Vec3}.js + public/display/
# Centerline.js — a bit-exact transliteration (fp-profile.md). Links the
# vendored fdlibm because Vec3::applyAxisAngle routes sin/cos through it, exactly
# as the JS side routes through math.js.
add_library(libttp_track STATIC
  libttp-track/ttp/util.cc
  libttp-track/ttp/centerline.cc
  libttp-track/ttp/trackbuilder.cc
)
target_include_directories(libttp_track PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track)
target_link_libraries(libttp_track PUBLIC ttp_mathlib ttp_strict_fp ttp_warnings)

# ---- Conformance: the shared math corpus ------------------------------------
# Replays tests/fixtures/math-corpus.jsonl (generated from the WASM build by
# scripts/gen-math-corpus.mjs) against THIS native build. Both passing is what
# makes golden traces valid conformance targets for the C++ engine.
enable_testing()
add_executable(mathlib_corpus_check mathlib/corpus_check.cc)
target_link_libraries(mathlib_corpus_check PRIVATE ttp_mathlib ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(mathlib_corpus_check)
add_test(NAME mathlib_corpus
  COMMAND mathlib_corpus_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/math-corpus.jsonl
)

# ---- Conformance: the track sampler corpus ----------------------------------
# Replays tests/fixtures/track-sampler-corpus.jsonl (scripts/
# gen-track-sampler-corpus.mjs) against libttp-track's Centerline — sampleAt,
# widthAt, projectNear — demanding identical bit patterns. Isolates track-math
# divergence before whole-race trace replay.
add_executable(sampler_check tracktest/sampler_check.cc)
target_link_libraries(sampler_check PRIVATE libttp_track ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(sampler_check)
add_test(NAME track_sampler
  COMMAND sampler_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/track-sampler-corpus.jsonl
)

# ---- Conformance: the full TrackBuilder corpus ------------------------------
# Rebuilds all 20 shipped tracks from generated/track_defs.h through the native
# TrackBuilder port and diffs the augmented race-track object (geometry +
# resolved furniture) against tests/fixtures/trackbuilder-corpus.jsonl
# (scripts/gen-trackbuilder-corpus.mjs) — bit-exact per top-level key, per
# 64-sample chunk, and per furniture array.
add_executable(trackbuilder_check tracktest/trackbuilder_check.cc)
target_include_directories(trackbuilder_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track)
target_link_libraries(trackbuilder_check PRIVATE libttp_track ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(trackbuilder_check)
add_test(NAME trackbuilder
  COMMAND trackbuilder_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/trackbuilder-corpus.jsonl
)

# ---- libttp-sim: the sim-core port ------------------------------------------
# The C++ twin of public/display/engine/Game.js + AiDriver.js + RaceSession.js +
# GrandPrix.js. Reuses libttp-track (Vec3/Centerline/util/jsmath) and libttp-json
# (the snapshot/trace serializer) wholesale; all under strict FP (fp-profile.md).
add_library(libttp_sim STATIC
  libttp-sim/ttp/ai_driver.cc
  libttp-sim/ttp/game.cc
  libttp-sim/ttp/race_session.cc
  libttp-sim/ttp/grand_prix.cc
)
target_include_directories(libttp_sim PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-sim
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track)
target_link_libraries(libttp_sim PUBLIC libttp_track libttp_json ttp_strict_fp ttp_warnings)

# ---- Conformance: the JSON number corpus (serializer gate) -------------------
# Replays tests/fixtures/json-number-corpus.jsonl (52,357 cases) — byte-exact
# ECMA-262 Number::toString. Phase A gate: green before the sim replay work.
add_executable(serializer_check simtest/serializer_check.cc)
target_link_libraries(serializer_check PRIVATE libttp_json ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(serializer_check)
add_test(NAME serializer
  COMMAND serializer_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/json-number-corpus.jsonl
)

# ---- Conformance: the cup-series scoring corpus ------------------------------
# Replays tests/fixtures/grandprix-corpus.jsonl against CupSeries + ShuffleBag.
# The cup layer was ported for parity and then never replayed by anything — no
# golden trace reaches it (traces are ONE race) and the e2e cup spec only proves a
# series chains, never a points value. This is its first oracle.
add_executable(grandprix_check simtest/grandprix_check.cc)
target_link_libraries(grandprix_check PRIVATE libttp_sim ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(grandprix_check)
add_test(NAME grandprix
  COMMAND grandprix_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/grandprix-corpus.jsonl
)

# ---- Conformance: cross-race isolation --------------------------------------
# A Game must derive its AI racing line from its own centerline even when a
# previous race's centerline had the same address. Forces the collision with
# placement new, so the failure is deterministic rather than allocator luck; see
# the file header for the bug it pins (a process-global cache keyed by a recycled
# pointer, invisible to one-race-per-process traces).
add_executable(race_isolation_check simtest/race_isolation_check.cc)
target_link_libraries(race_isolation_check PRIVATE libttp_sim ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(race_isolation_check)
add_test(NAME race_isolation COMMAND race_isolation_check)

# ---- Regression: the whole catalogue raced -----------------------------------
# The golden traces race 3 of the 20 shipped tracks; the other 17 were proven as
# GEOMETRY only. This races every one and pins checkpoint hashes + end state, then
# races the catalogue again in REVERSE order and demands identical digests — 40
# races in one process is the widest cheap net for state that outlives a Game.
#
# C++-authored evidence, NOT a parity oracle (the JS engine was already gone). It
# answers "did the sim change", which is why it re-records like a golden trace, with
# a byte-identity gate on the recording path.
add_executable(catalogue_sweep_check simtest/catalogue_sweep_check.cc)
target_link_libraries(catalogue_sweep_check PRIVATE libttp_sim ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(catalogue_sweep_check)
add_test(NAME catalogue_sweep
  COMMAND catalogue_sweep_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/catalogue-sweep-corpus.jsonl
)
add_test(NAME record_catalogue_sweep
  COMMAND ${CMAKE_COMMAND}
    -DCLI=$<TARGET_FILE:catalogue_sweep_check>
    "-DEMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR}"
    -DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/catalogue-sweep-corpus.jsonl
    -DOUT=${CMAKE_CURRENT_BINARY_DIR}/rerecord/catalogue-sweep-corpus.jsonl
    -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/record_roundtrip.cmake)
# (record_roundtrip.cmake invokes "<cli> --record <fixture> --out=<f>"; the sweep
# regenerates from the catalogue, so it accepts and ignores that positional.)

# ---- Behaviour: hazard responses no fixture can reach -----------------------
# collidePole and stageBanana had never executed in EITHER suite. Not an oversight
# in the fixtures: no shipped track builds with a single pole (the JS TrackBuilder
# agrees), so a catalogue-racing fixture physically cannot reach the pole collision,
# and stageBanana is a trace-staging hook no fixture stages. See the file header.
add_executable(hazard_check simtest/hazard_check.cc)
target_link_libraries(hazard_check PRIVATE libttp_sim ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(hazard_check)
add_test(NAME hazards COMMAND hazard_check)

# ---- Conformance: the golden-trace replay CLI -------------------------------
# Reproduces scripts/verify-trace.mjs against libttp-sim: rebuilds the race,
# replays recorded inputs (+ ai-live re-run, session driver, dt jitter, schedule
# ops), and demands exact per-frame event/snapshot/hash agreement.
add_executable(replay_cli replay/replay_cli.cc)
target_link_libraries(replay_cli PRIVATE libttp_sim ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(replay_cli)
# --record is a DROP-IN for scripts/record-trace.mjs: re-recording a committed
# fixture from C++ must reproduce it BYTE FOR BYTE. That equality is the gate
# that lets fixture recording move off JS (and therefore lets the JS engine be
# frozen), so it runs per fixture on every platform leg.
foreach(fx
  helix-3bots-1human-500f-seed7
  helix-session-jitter-3bots-1human-800f-seed7
  skysnake-5bots-2laps-seed39
  tidepool-4bots-600f-seed42
  tidepool-ailive-4bots-600f-seed42
  tidepool-schedule-5bots-1human-700f-seed42
  tidepool-session-ailive-4bots-900f-seed13
  tidepool-session-beats-3bots-450f-seed21)
  add_test(NAME replay_${fx}
    COMMAND replay_cli ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/${fx}.jsonl)
  list(APPEND TTP_ALL_TRACES ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/${fx}.jsonl)
  # Re-record into the build tree and demand byte equality with the committed file.
  add_test(NAME record_${fx}
    COMMAND ${CMAKE_COMMAND}
      -DCLI=$<TARGET_FILE:replay_cli>
      "-DEMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR}"
      -DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/${fx}.jsonl
      -DOUT=${CMAKE_CURRENT_BINARY_DIR}/rerecord/${fx}.jsonl
      -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/record_roundtrip.cmake)
endforeach()


# Every trace through ONE process, in order: a general cross-race leak detector.
# Each replay is byte-exact alone, so anything that survives a Game and colours the
# next race shows up as a divergence. It is NOT the gate for the recycled-pointer
# bug (it cannot force the address collision — race_isolation does that); it is the
# cheap net for the next leak of that shape.
add_test(NAME replay_sequence COMMAND replay_cli ${TTP_ALL_TRACES})

# ---- Balance probes: the car/track tuning instruments -----------------------
# The C++ twin of scripts/probe-{laptime,car-matrix,packed-races}.js. Tuning
# tools, not conformance gates (no ctest entry — they PRINT numbers a human
# reads), and the last load-bearing reason the JS engine had to stay runnable in
# Node. Links libttp_party only for ttp::protocol's CAR_STATS/CAR_NAMES.
add_executable(probe_cli probe/probe_cli.cc)
target_link_libraries(probe_cli PRIVATE libttp_sim libttp_party ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(probe_cli)

# The probe IS a tuning tool, not a conformance gate — but it was also the only
# thing in the tree with zero coverage and no CI leg, which for the instrument that
# FOUND the racing-line bug is the wrong way round. This asserts the instrument
# still works: one row per catalogue track, every lap time plausible. 0.8s.
# TTP_TRACK_COUNT is compiled in, so the expected row count comes from the same
# generated catalogue rather than a number maintained by hand here.
file(STRINGS ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track/generated/track_defs.h
  _ttp_track_count_line REGEX "TTP_TRACK_COUNT *=")
string(REGEX MATCH "[0-9]+" TTP_TRACK_COUNT "${_ttp_track_count_line}")
if(NOT TTP_TRACK_COUNT)
  message(FATAL_ERROR "could not read TTP_TRACK_COUNT from generated/track_defs.h")
endif()
add_test(NAME probe_smoke
  COMMAND ${CMAKE_COMMAND}
    -DCLI=$<TARGET_FILE:probe_cli>
    "-DEMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR}"
    -DTRACKS=${TTP_TRACK_COUNT}
    -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/probe_smoke.cmake)

# ---- libttp-party: the room-semantics + wire-framing port -------------------
# The C++ twin of the partyplug transport layer: RoomFlow.js (sans-IO room state
# machine — roster identity/join order, presence, host election, liveness
# predicates; ORDER and IDENTITY semantics load-bearing) plus the pure surface of
# PartyConnection.js (relay_framing: outbound encoders, inbound routing, close-
# code semantics, backoff, sharded URL) and protocol.js (the shared wire
# vocabulary + car constants). Depends on libttp_json for ttp::Value and NOT on
# the sim: a local PeerId mirrors libttp-sim's Id JSON-scalar identity rather than
# sharing it, so the two layers stay independently portable.
add_library(libttp_party STATIC
  libttp-party/ttp/room_flow.cc
  libttp-party/ttp/protocol.cc
  libttp-party/ttp/relay_framing.cc
  libttp-party/ttp/fastlane.cc
)
target_include_directories(libttp_party PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/libttp-party)
target_link_libraries(libttp_party PUBLIC libttp_json ttp_strict_fp ttp_warnings)

# ---- Conformance: the RoomFlow behavioural corpus ---------------------------
# Replays tests/fixtures/roomflow-corpus.jsonl (scripts/gen-roomflow-corpus.mjs)
# against the port: per scripted op, reproduces ret + emitted events (order +
# detail) + a public-surface digest, compared as canonical JSON. 36 scripts (plus
# 13 lowestFreeSlot cases), every step exact.
add_executable(roomflow_check partytest/roomflow_check.cc)
target_link_libraries(roomflow_check PRIVATE libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(roomflow_check)
add_test(NAME roomflow
  COMMAND roomflow_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/roomflow-corpus.jsonl
)

# ---- Conformance: the protocol vocabulary + relay framing --------------------
# protocol_check replays protocol-corpus.jsonl (constants manifest + carStats
# table); framing_check replays framing-corpus.jsonl (encode/classify/close/
# backoff/pin), recorded by driving the real PartyConnection. Both compare via
# the shared structural diff in testsupport/corpus_diff.h (libttp_json supplies
# canonical_stringify + js_number_to_string for the expected side).
add_executable(protocol_check partytest/protocol_check.cc)
target_link_libraries(protocol_check PRIVATE libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(protocol_check)
add_test(NAME protocol
  COMMAND protocol_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/protocol-corpus.jsonl
)

add_executable(framing_check partytest/framing_check.cc)
target_link_libraries(framing_check PRIVATE libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(framing_check)
add_test(NAME framing
  COMMAND framing_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/framing-corpus.jsonl
)

# ---- Conformance: the fastlane netcode core ---------------------------------
# Replays fastlane-corpus.jsonl (scripted links recorded off the real
# PartyFastlane with a controlled clock + fake DataChannel) against
# ttp::fastlane::Link: per op the enqueue return, the packet written, the events
# applied, the RTT sample, and the full link-state digest. The srtt EWMA is real
# FP, so ttp_strict_fp (-ffp-contract=off) is load-bearing here.
add_executable(fastlane_check partytest/fastlane_check.cc)
target_link_libraries(fastlane_check PRIVATE libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(fastlane_check)
add_test(NAME fastlane
  COMMAND fastlane_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/fastlane-corpus.jsonl
)

# ---- Conformance: the C ABI itself ------------------------------------------
# The glue in runtime/ used to be compiled by the emscripten browser module ALONE,
# so ctest never saw a line of it and 21 of its 58 exports were exercised by
# nothing on any platform. This check drives the exported C surface directly:
# a golden trace through ttp_process_input/ttp_update, the cup-series corpus
# through ttp_gp_*, and the boundary/mutation exports against their header
# contracts.
#
# It COMPILES THE SOURCES AGAIN rather than linking a shared static library. That
# is deliberate: the shipped wasm's export list is EMSCRIPTEN_KEEPALIVE on each
# declaration, and moving those definitions into a static archive risks the linker
# dropping unreferenced objects. Recompiling two files costs nothing and leaves the
# artifact the browser runs bit-for-bit untouched.
add_executable(abi_check runtimetest/abi_check.cc runtime/ttp_runtime.cc runtime/ttp_party.cc)
target_include_directories(abi_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
target_link_libraries(abi_check PRIVATE libttp_sim libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(abi_check)
# Both BARE (no-countdown, input-replay) traces: tidepool is the one the Node ABI
# test uses, and helix adds 402 braking inputs — without it ttp_process_input's
# brake bit is never marshalled and could be deleted with every frame still green
# (found by mutation-testing this check). tidepool-ailive then replays the path
# the SHIPPED game actually runs: bots added with ttp_add_bot and driven INSIDE
# ttp_update, so the racing line, the persona knobs and the drive-then-step order
# are pinned by a recorded hash instead of only by replay_cli calling C++ direct.
# Only the SCHEDULE trace is unreplayable here: it scripts giveItem/useItem/
# setCarStats, which the C ABI deliberately does not export.
add_test(NAME abi
  COMMAND abi_check
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/grandprix-corpus.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/roomflow-corpus.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/framing-corpus.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/tidepool-4bots-600f-seed42.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/helix-3bots-1human-500f-seed7.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces/tidepool-ailive-4bots-600f-seed42.jsonl
)

# ---- Browser module: the native runtime (ttp_runtime.h + ttp_party.h) -------
# Emscripten-only. Wraps libttp-sim AND libttp-party behind their two extern "C"
# ABIs and emits one ES6 module (ttp_runtime.mjs + .wasm) that the display's
# display's Native* adapters share — one instantiation, one copy of
# double-conversion, and the shape libttp-runtime takes on the shells. Lean by
# design: -O2, no assertions, and NEITHER NODERAWFS NOR EXIT_RUNTIME (which the
# CLI helper adds and a browser module must not carry) — this is why those
# options were lifted off the ttp_strict_fp interface above. The artifacts are
# copied into public/display/engine/native/ (checked in, like engine/math.js) by
# native/scripts/build-runtime-web.sh.
if(EMSCRIPTEN)
  add_executable(ttp_runtime_web runtime/ttp_runtime.cc runtime/ttp_party.cc)
  target_include_directories(ttp_runtime_web PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
  target_link_libraries(ttp_runtime_web PRIVATE libttp_sim libttp_party ttp_strict_fp ttp_warnings)
  set_target_properties(ttp_runtime_web PROPERTIES OUTPUT_NAME "ttp_runtime" SUFFIX ".mjs")
  target_link_options(ttp_runtime_web PRIVATE
    -O2
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,node
    -sALLOW_MEMORY_GROWTH=1
    -sASSERTIONS=0
    # The ABI itself is exported by TTP_ABI (EMSCRIPTEN_KEEPALIVE) on every
    # declaration in ttp_runtime.h / ttp_party.h — 89 entry points, no list to
    # keep in sync here. malloc/free are the allocator the JS side needs for
    # stringToUTF8 buffers and have no declaration of ours to tag.
    "-sEXPORTED_FUNCTIONS=_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToUTF8,HEAPF64"
  )
endif()
