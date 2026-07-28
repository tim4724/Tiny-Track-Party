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
  # The augmented-track serializer, in whichever number spelling the caller asks
  # for: hexJSON for the frozen corpus check, decimals for ttp_track_json. It
  # takes the number formatter as a function pointer so libttp-track keeps its
  # independence from libttp-json.
  libttp-track/ttp/race_track_json.cc
)
target_include_directories(libttp_track PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track)
# libttp_json is here for race_track_json's decimal spelling only (jsonnum's
# shortest-round-trip formatter). No cycle: libttp-json depends on nothing of ours.
target_link_libraries(libttp_track PUBLIC ttp_mathlib libttp_json ttp_strict_fp ttp_warnings)

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

# ---- Conformance: the JSON string corpus (escape gate) ----------------------
# The number corpus above gates doubles; nothing gated STRINGS. Across all 8
# traces and every other corpus there is not one backslash escape, so the
# quote/backslash/\b\t\n\f\r arms and the \u00XX control arm were executed
# nowhere — in the writer OR the parser — while the controller's free-text name
# field reaches them in production. Replays both directions against JSON.stringify.
add_executable(json_escape_check simtest/json_escape_check.cc)
target_link_libraries(json_escape_check PRIVATE ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(json_escape_check)
add_test(NAME json_escape
  COMMAND json_escape_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/json-escape-corpus.jsonl
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
# libttp_sim is here for ONE assertion: the sim's default steering exponent must
# equal protocol::STEER_EXPO (see the file header). The sim itself never links
# the party layer — that direction would be a layering inversion; a test binary
# linking both is not.
target_link_libraries(protocol_check PRIVATE libttp_party libttp_sim ttp_testsupport ttp_strict_fp ttp_warnings)
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
add_executable(abi_check runtimetest/abi_check.cc runtime/ttp_runtime.cc runtime/ttp_party.cc
  runtime/ttp_theme.cc)
target_include_directories(abi_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
# libttp_runtime carries libttp_sim PUBLICly (and brings the biome tables
# ttp_theme.cc marshals), so naming libttp_sim again here only makes the
# linker warn about a duplicate.
target_link_libraries(abi_check PRIVATE libttp_runtime libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
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

# ---- libttp-runtime: the platform-free half of the display runtime ----------
# Cameras (the spring chase per split-screen cell), the overview/lobby framing
# and fog solve, and the per-frame TtpFrameInput built straight off the live
# Game. All of it used to sit in runtime/ttp_display.cc, BEHIND the Filament
# gate — so it compiled on exactly one machine configuration in the world (a dev
# box with the Filament fork) and no ctest on any of the four legs ever saw a
# line of it. Nothing in here names a platform API, a renderer or emscripten, so
# nothing forced that.
#
# Includes renderer/include for ttp_render.h — the plain-data frame contract and
# ttp_grid_cols. That is a HEADER path, not a link edge: this library must never
# depend on ttp_renderer (which needs the SDK CI does not have).
#
# RaceSession deliberately stays in libttp-sim: replay_cli has to keep linking
# the sim alone.
add_library(libttp_runtime STATIC
  libttp-runtime/ttp/camera.cc
  libttp-runtime/ttp/framing.cc
  libttp-runtime/ttp/frame_builder.cc
  # The per-player HUD block the shell reads back, which is uiModel.js's
  # hudRows ported. Beside the frame builder because it reads the same live
  # Game through the same roster slots — but for the shell's ~6 Hz poll, not
  # for the renderer's frame.
  libttp-runtime/ttp/hud.cc
  # The rest of uiModel.js — the seat grid, the lobby rules, the race card, the
  # ITEM-push gate, the reconnect diff, the flow predicates, the pause
  # arbitration, the standings board and the results overlay, plus the screen
  # enum and its per-screen back EFFECT. Pure decisions over plain data, so it
  # sits beside hud.cc for the same reason: no platform API, every leg compiles
  # AND executes it. The back-stack TRAVERSAL is NOT here — that is the History
  # API wearing a C hat, and each shell owns its own.
  libttp-runtime/ttp/ui_model.cc
  # The audio DECISIONS — public/display/audio/decide.js ported. Here rather
  # than in a library of its own because it is the same thing the two files
  # above are: a display rule that names no platform API, so every leg compiles
  # AND executes it. The device half (AudioContext / the baked cue palette) is
  # per-platform and stays out of this tree entirely.
  libttp-runtime/ttp/audio.cc
  # The per-cup biome palettes and the rules that resolve one. Data, not
  # rendering: it was authored in the browser (public/shared/themes.js +
  # render/trackPayload.js) until the shells stopped being one.
  libttp-runtime/ttp/theme.cc
)
target_include_directories(libttp_runtime PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-runtime
  ${CMAKE_CURRENT_SOURCE_DIR}/renderer/include)
target_link_libraries(libttp_runtime PUBLIC libttp_json libttp_sim ttp_strict_fp)
target_link_libraries(libttp_runtime PRIVATE ttp_warnings)

# ---- Regression: the cameras, the framing solve and the split-screen grid ----
# C++-AUTHORED evidence, NOT a parity oracle: ChaseCamera.js and SceneRenderer's
# rigs were deleted with the JS renderer, so this proves the cameras still do
# what they did when it was recorded and says NOTHING about whether the port was
# right. Re-record deliberately with --record, exactly like the catalogue sweep.
#
# The corpus is QUANTIZED, unlike every other fixture in this tree. This is the
# only check whose subject calls the PLATFORM's libm (expf/logf/tanf/atan2f)
# rather than the vendored fdlibm — cosmetic float, by design — and Apple libm,
# glibc and musl/emscripten agree on those to about a ulp, not to the bit. See
# the file header.
add_executable(runtime_check runtimetest/runtime_check.cc)
target_link_libraries(runtime_check PRIVATE libttp_runtime ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(runtime_check)
add_test(NAME runtime_check
  COMMAND runtime_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/runtime-camera-corpus.jsonl
)
add_test(NAME record_runtime
  COMMAND ${CMAKE_COMMAND}
    -DCLI=$<TARGET_FILE:runtime_check>
    "-DEMULATOR=${CMAKE_CROSSCOMPILING_EMULATOR}"
    -DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/runtime-camera-corpus.jsonl
    -DOUT=${CMAKE_CURRENT_BINARY_DIR}/rerecord/runtime-camera-corpus.jsonl
    -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/record_roundtrip.cmake)
# (record_roundtrip.cmake invokes "<cli> --record <fixture> --out=<f>"; the cases
# are compiled in, so the check accepts and ignores that positional.)

# ---- Behaviour: the per-frame TtpFrameInput builder -------------------------
# runtime_check above pins the cameras, the framing solve and the grid, but it
# calls those three primitives ITSELF — it never runs the block that assembles a
# frame out of them. That block (roster-slot identity, cell-to-camera
# assignment, the hold, the banana liveness filter, the rocket wrap, the burst
# drain) is the largest thing lifted out of the Filament-gated shim, and moving
# it into libttp-runtime bought it COMPILE coverage on all four legs and nothing
# else. This executes it.
#
# Assertions rather than a corpus, like hazard_check: almost everything here is
# exactly reproducible on every leg (casts, integer mapping, copies), and the two
# places that touch the platform libm are checked against a reference ChaseCam
# driven in the same process. See the file header.
#
# It also carries the ONE binding between the frozen TTP_CAM_* ABI macros and
# libttp-runtime's CamMode enum, which is why it puts runtime/ on the include
# path — a test TU may include the emscripten-tagged ABI header, and unlike the
# shim that used to hold those static_asserts, this target is built on every leg.
add_executable(frame_check runtimetest/frame_check.cc)
target_include_directories(frame_check PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
target_link_libraries(frame_check PRIVATE libttp_runtime ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(frame_check)
add_test(NAME frame_builder COMMAND frame_check)

# ---- Conformance: the per-player race HUD -----------------------------------
# JS-RECORDED evidence, like the biome check below and unlike the two above: the
# `hud` steps of tests/fixtures/ui-corpus.jsonl were recorded off the live
# public/display/uiModel.js, so they settle whether hudRows was ported right.
# uiModel.js has not been deleted yet, which makes the corpus still RENEWABLE
# (tests/ui-corpus.test.js re-derives it) — but it is the recorded bytes this
# replays, and no --record mode exists here on purpose.
#
# It links libttp_runtime for ttp::rt::hudSlot and libttp_sim (carried PUBLICly)
# for ITEM_IDS, which is the table the packed item code decodes back through.
add_executable(hud_check runtimetest/hud_check.cc)
target_link_libraries(hud_check PRIVATE libttp_runtime ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(hud_check)
add_test(NAME ui_hud
  COMMAND hud_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/ui-corpus.jsonl
)

# ---- Conformance: the rest of the UI model ----------------------------------
# The same fixture as ui_hud above and the same class of evidence, one layer
# wider: this replays EVERY step of tests/fixtures/ui-corpus.jsonl — all 37
# scenarios, all thirteen op kinds — through ttp/ui_model.h, and checks the
# shell state the driver threads as well as each answer. Three rules are only
# correct IN SEQUENCE (the reconnect diff, the per-race ITEM map, the screen
# step), so a table of isolated calls would not settle them.
#
# It links libttp_party for ONE assertion: ui_model.h keeps a local mirror of
# protocol.h's ROOM_STATE rather than making libttp-runtime depend on the party
# layer, and this pins the copy (see the file header). The library itself never
# links libttp_party — that direction would be a layering inversion; a test
# binary linking both is not, exactly as protocol_check links libttp_sim.
add_executable(ui_check runtimetest/ui_check.cc)
target_link_libraries(ui_check PRIVATE libttp_runtime libttp_party ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(ui_check)
add_test(NAME ui_model
  COMMAND ui_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/ui-corpus.jsonl
)

# ---- Conformance: the audio decisions ---------------------------------------
# JS-RECORDED evidence, like the HUD check above: tests/fixtures/audio-corpus.jsonl
# was recorded off the live public/display/audio/decide.js in P5, so it settles
# whether the decisions were ported right. No --record mode here on purpose.
#
# It takes the TRACES DIRECTORY as well as the corpus, and that is the shape of
# the fixture rather than a convenience: the 5900 trace frames record only the
# COMMANDS, so the world they were decided from has to be re-raced here through
# libttp-sim (every roster entry a human, the recorded inputs fed back) with each
# frame's events and snapshot hash checked against the trace before anything is
# compared. The 497 scripted steps carry their own input and need none of that.
add_executable(audio_check runtimetest/audio_check.cc)
target_link_libraries(audio_check PRIVATE libttp_runtime ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(audio_check)
add_test(NAME audio
  COMMAND audio_check
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/audio-corpus.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/traces
)

# ---- Conformance: the biome palettes ----------------------------------------
# JS-RECORDED evidence, unlike the two checks above: the corpus was taken off the
# live public/shared/themes.js + render/trackPayload.js + shared/trackBin.js
# before they were deleted, so it settles the parity question the way the golden
# traces do for the sim. There is no --record mode here on purpose — the JS twin
# is gone, and re-recording from C++ would only prove C++ matches itself.
#
# It needs the shipped scenery GLBs, because half of the recolour rule is the
# models' own authored material colours (a palm's fronds and trunk differ).
add_executable(theme_check runtimetest/theme_check.cc)
target_link_libraries(theme_check PRIVATE libttp_runtime ttp_testsupport ttp_strict_fp ttp_warnings)
ttp_emscripten_cli(theme_check)
add_test(NAME theme
  COMMAND theme_check
    ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/theme-corpus.jsonl
    ${CMAKE_CURRENT_SOURCE_DIR}/../public/assets/toycar
)

# ---- libttp-renderer --------------------------------------------------------
# The Filament renderer, platform-free (no emscripten includes): the same code
# ships on tvOS and Android TV, where the shell hands init() a CAMetalLayer or
# ANativeWindow instead. Built only when a Filament SDK is pointed at, which is
# what keeps CI — which has no SDK — able to configure this tree at all.
#
# C++20 to match the Filament SDK build; no RTTI/exceptions, like Filament.
# Deliberately NOT ttp_strict_fp: nothing here is conformance-bearing, and the
# renderer wants the compiler's normal float latitude.
if(DEFINED FILAMENT_SDK)
  include(cmake/FilamentWasm.cmake)
  add_library(ttp_renderer STATIC renderer/src/TtpRenderer.cpp)
  target_include_directories(ttp_renderer PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/renderer/include
    ${CMAKE_CURRENT_SOURCE_DIR}/renderer/src
    # ttp/theme.h — the resolved biome buildScene takes. A HEADER path, the
    # mirror image of libttp_runtime's dependency on renderer/include, and for
    # the same reason: neither library may LINK the other, or libttp-runtime
    # would stop building on the legs with no Filament SDK.
    ${CMAKE_CURRENT_SOURCE_DIR}/libttp-runtime)
  # libttp_track is here for the built-track TYPE the scene is meshed from
  # (ttp::RaceTrack). The renderer never resolves a track ID — which track to
  # build stays the runtime's call — so this adds a struct, not a catalogue.
  target_link_libraries(ttp_renderer PUBLIC filament-sdk libttp_track PRIVATE ttp_warnings)
  target_compile_options(ttp_renderer PRIVATE -fno-rtti -fno-exceptions)
  set_target_properties(ttp_renderer PROPERTIES CXX_STANDARD 20)
endif()

# ---- Browser module: the whole game --------------------------------------
# Emscripten-only. ONE module: libttp-sim + libttp-party behind their extern "C"
# ABIs (runtime/ttp_runtime.h, runtime/ttp_party.h) AND libttp-renderer behind
# the display surface, so the sim state the renderer draws never leaves wasm.
# That is the whole point of merging them — the display calls ttp_display_frame
# and C++ reads the live Game directly, where the two-module shape had to
# serialize every car pose and camera through JS on every frame.
#
# Emits ttp_runtime.mjs + .wasm, copied into public/display/engine/native/
# (checked in, like engine/math.js) by native/scripts/build-runtime-web.sh.
# Lean by design: -O2, no assertions, and NEITHER NODERAWFS NOR EXIT_RUNTIME
# (which the CLI helper adds and a browser module must not carry) — this is why
# those options were lifted off the ttp_strict_fp interface above.
#
# WITHOUT a Filament SDK this links sim+party only. That is not a shippable
# artifact — it is CI's browser-ABI link check (the wasm leg has no SDK), which
# is the one build that would otherwise never compile these link options.
if(EMSCRIPTEN)
  # libttp-runtime's sources are compiled straight into the module, OUTSIDE the
  # renderer gate below: that is what puts the cameras and the frame builder
  # through CI's Filament-less wasm leg, which is otherwise the one build that
  # would never see them. (Sources, not a link against libttp_runtime, so they
  # are in the link whether or not anything in this module references them.)
  set(TTP_WEB_SOURCES runtime/ttp_runtime.cc runtime/ttp_party.cc
    # The biome ABI is OUTSIDE the renderer gate too: naming a biome (for the
    # music pool, for the ?biome= list) is not rendering, and CI's Filament-less
    # wasm leg is where the browser's link to it gets checked.
    runtime/ttp_theme.cc
    libttp-runtime/ttp/camera.cc
    libttp-runtime/ttp/framing.cc
    libttp-runtime/ttp/frame_builder.cc
    # The packed HUD block ttp_display_hud answers with. Outside the gate with
    # the rest of libttp-runtime, and for the extra reason that it is what the
    # SHELL reads rather than what the renderer draws: a Filament-less leg still
    # has every line of it in the link.
    libttp-runtime/ttp/hud.cc
    # The rest of the UI model. Nothing in the ABI reaches it YET — the shells
    # still render from public/display/uiModel.js — so wasm-ld strips it and the
    # artifact does not grow. It is listed anyway because THIS list is the sync
    # point: a source that lands in libttp_runtime alone makes this module
    # unlinkable the moment an export references it, and no ctest target says so.
    libttp-runtime/ttp/ui_model.cc
    # The audio decisions, for the same reason and with the same trap: this list
    # is COMPILED, not linked against libttp_runtime, so a source added to the
    # library alone leaves this module unlinkable and no ctest target notices.
    libttp-runtime/ttp/audio.cc
    libttp-runtime/ttp/theme.cc)
  if(TARGET ttp_renderer)
    list(APPEND TTP_WEB_SOURCES runtime/ttp_display_web.cc)
  endif()
  add_executable(ttp_runtime_web ${TTP_WEB_SOURCES})
  # renderer/include is ttp_render.h ONLY — the plain-data frame contract. It is
  # on the path with or without an SDK, because libttp-runtime's sources need it.
  target_include_directories(ttp_runtime_web PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/runtime
    ${CMAKE_CURRENT_SOURCE_DIR}/libttp-runtime
    ${CMAKE_CURRENT_SOURCE_DIR}/renderer/include)
  target_link_libraries(ttp_runtime_web PRIVATE libttp_sim libttp_party ttp_strict_fp ttp_warnings)
  set_target_properties(ttp_runtime_web PROPERTIES OUTPUT_NAME "ttp_runtime" SUFFIX ".mjs")
  target_link_options(ttp_runtime_web PRIVATE
    -O2
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    # node too: tests/{runtime,party}-abi.test.js load this exact artifact
    # headless. Filament only touches GL inside ttp_display_create, which needs
    # a canvas, so a headless load never reaches a GL call.
    -sENVIRONMENT=web,node
    -sALLOW_MEMORY_GROWTH=1
    -sASSERTIONS=0
    # The ABI itself is exported by TTP_ABI (EMSCRIPTEN_KEEPALIVE) on every
    # declaration in ttp_runtime.h / ttp_party.h — no list to keep in sync here.
    # malloc/free are the allocator the JS side needs for stringToUTF8 buffers
    # and have no declaration of ours to tag.
    "-sEXPORTED_FUNCTIONS=_malloc,_free"
    # HEAPF32 is the packed float readback (ttp_display_cell_rects); HEAPF64 the
    # profile block AND the HUD block's finish times; HEAPU8 the asset upload;
    # HEAP32/HEAPU32 the HUD block's signed values and its header/flags
    # (ttp_hud.h) — an unsigned field read through a signed view is exactly the
    # kind of thing that only bites once the numbers get big.
    "-sEXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToUTF8,HEAP32,HEAPU32,HEAPF32,HEAPF64,HEAPU8"
  )
  if(TARGET ttp_renderer)
    target_link_libraries(ttp_runtime_web PRIVATE ttp_renderer)
    target_link_options(ttp_runtime_web PRIVATE
      -sUSE_WEBGL2=1
      # NOT -sFULL_ES3. It implies -sFULL_ES2 (tools/link.py), whose GLES2
      # client-side-array emulation puts a SYNCHRONOUS
      # getParameter(ELEMENT_ARRAY_BUFFER_BINDING) inside every
      # glBindVertexArray, plus a per-draw scan of all 16 attribute slots.
      # Filament binds a VAO per draw, so that was ~180 blocking round-trips to
      # the GPU process every frame — measured as the single largest cost in the
      # whole renderer. Filament is a WebGL2/ES3 consumer and never passes
      # client-side arrays, so neither emulation applies to us.
      -sMIN_WEBGL_VERSION=2
      -sMAX_WEBGL_VERSION=2
      # ...and the two GLES3 entry points dropping FULL_ES3 takes away.
      --js-library ${CMAKE_CURRENT_SOURCE_DIR}/runtime/gl_map_buffer_stubs.js)
  endif()
endif()
