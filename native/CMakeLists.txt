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
target_link_libraries(libttp_track PUBLIC ttp_mathlib ttp_strict_fp)

# ---- Conformance: the shared math corpus ------------------------------------
# Replays tests/fixtures/math-corpus.jsonl (generated from the WASM build by
# scripts/gen-math-corpus.mjs) against THIS native build. Both passing is what
# makes golden traces valid conformance targets for the C++ engine.
enable_testing()
add_executable(mathlib_corpus_check mathlib/corpus_check.cc)
target_link_libraries(mathlib_corpus_check PRIVATE ttp_mathlib ttp_strict_fp)
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
target_link_libraries(sampler_check PRIVATE libttp_track ttp_strict_fp)
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
target_link_libraries(trackbuilder_check PRIVATE libttp_track ttp_strict_fp)
ttp_emscripten_cli(trackbuilder_check)
add_test(NAME trackbuilder
  COMMAND trackbuilder_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/trackbuilder-corpus.jsonl
)

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

# ---- libttp-sim: the sim-core port ------------------------------------------
# The C++ twin of public/display/engine/Game.js + AiDriver.js + RaceSession.js +
# GrandPrix.js plus the trace serializer (jsonnum/canonical). Reuses libttp-track
# (Vec3/Centerline/util/jsmath) wholesale; all under strict FP (fp-profile.md).
add_library(libttp_sim STATIC
  libttp-sim/ttp/jsonnum.cc
  libttp-sim/ttp/canonical.cc
  libttp-sim/ttp/ai_driver.cc
  libttp-sim/ttp/game.cc
  libttp-sim/ttp/race_session.cc
  libttp-sim/ttp/grand_prix.cc
)
target_include_directories(libttp_sim PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-sim
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-track)
target_link_libraries(libttp_sim PUBLIC libttp_track ttp_double_conversion ttp_strict_fp)

# ---- Conformance: the JSON number corpus (serializer gate) -------------------
# Replays tests/fixtures/json-number-corpus.jsonl (52,357 cases) — byte-exact
# ECMA-262 Number::toString. Phase A gate: green before the sim replay work.
add_executable(serializer_check simtest/serializer_check.cc)
target_link_libraries(serializer_check PRIVATE libttp_sim ttp_strict_fp)
ttp_emscripten_cli(serializer_check)
add_test(NAME serializer
  COMMAND serializer_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/json-number-corpus.jsonl
)

# ---- Conformance: the golden-trace replay CLI -------------------------------
# Reproduces scripts/verify-trace.mjs against libttp-sim: rebuilds the race,
# replays recorded inputs (+ ai-live re-run, session driver, dt jitter, schedule
# ops), and demands exact per-frame event/snapshot/hash agreement.
add_executable(replay_cli replay/replay_cli.cc)
target_link_libraries(replay_cli PRIVATE libttp_sim ttp_strict_fp)
ttp_emscripten_cli(replay_cli)
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
endforeach()

# ---- libttp-party: the room-semantics + wire-framing port -------------------
# The C++ twin of the partyplug transport layer: RoomFlow.js (sans-IO room state
# machine — roster identity/join order, presence, host election, liveness
# predicates; ORDER and IDENTITY semantics load-bearing) plus the pure surface of
# PartyConnection.js (relay_framing: outbound encoders, inbound routing, close-
# code semantics, backoff, sharded URL) and protocol.js (the shared wire
# vocabulary + car constants). Depends only on ttp::Value (canonical.h,
# header-only); a local PeerId mirrors libttp-sim's Id JSON-scalar identity.
add_library(libttp_party STATIC
  libttp-party/ttp/room_flow.cc
  libttp-party/ttp/protocol.cc
  libttp-party/ttp/relay_framing.cc
  libttp-party/ttp/fastlane.cc
)
target_include_directories(libttp_party PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-party
  ${CMAKE_CURRENT_SOURCE_DIR}/libttp-sim)  # ttp/canonical.h (Value struct)
target_link_libraries(libttp_party PUBLIC ttp_strict_fp)

# ---- Conformance: the RoomFlow behavioural corpus ---------------------------
# Replays tests/fixtures/roomflow-corpus.jsonl (scripts/gen-roomflow-corpus.mjs)
# against the port: per scripted op, reproduces ret + emitted events (order +
# detail) + a public-surface digest, compared as canonical JSON (canonical_stringify
# from libttp_sim). 34 scripts, every step exact.
add_executable(roomflow_check partytest/roomflow_check.cc)
target_link_libraries(roomflow_check PRIVATE libttp_party libttp_sim ttp_strict_fp)
ttp_emscripten_cli(roomflow_check)
add_test(NAME roomflow
  COMMAND roomflow_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/roomflow-corpus.jsonl
)

# ---- Conformance: the protocol vocabulary + relay framing --------------------
# protocol_check replays protocol-corpus.jsonl (constants manifest + carStats
# table); framing_check replays framing-corpus.jsonl (encode/classify/close/
# backoff/pin), recorded by driving the real PartyConnection. Both compare via
# the shared structural diff in partytest/json_check.h. libttp_sim supplies
# canonical_stringify + js_number_to_string for the expected side.
add_executable(protocol_check partytest/protocol_check.cc)
target_link_libraries(protocol_check PRIVATE libttp_party libttp_sim ttp_strict_fp)
ttp_emscripten_cli(protocol_check)
add_test(NAME protocol
  COMMAND protocol_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/protocol-corpus.jsonl
)

add_executable(framing_check partytest/framing_check.cc)
target_link_libraries(framing_check PRIVATE libttp_party libttp_sim ttp_strict_fp)
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
target_link_libraries(fastlane_check PRIVATE libttp_party libttp_sim ttp_strict_fp)
ttp_emscripten_cli(fastlane_check)
add_test(NAME fastlane
  COMMAND fastlane_check ${CMAKE_CURRENT_SOURCE_DIR}/../tests/fixtures/fastlane-corpus.jsonl
)

# ---- Browser module: the native runtime (ttp_runtime.h + ttp_party.h) -------
# Emscripten-only. Wraps libttp-sim AND libttp-party behind their two extern "C"
# ABIs and emits one ES6 module (ttp_runtime.mjs + .wasm) that the display's
# ?sim=native and ?party=native adapters share — one instantiation, one copy of
# double-conversion, and the shape libttp-runtime takes on the shells. Lean by
# design: -O2, no assertions, and NEITHER NODERAWFS NOR EXIT_RUNTIME (which the
# CLI helper adds and a browser module must not carry) — this is why those
# options were lifted off the ttp_strict_fp interface above. The artifacts are
# copied into public/display/engine/native/ (checked in, like engine/math.js) by
# native/scripts/build-runtime-web.sh.
if(EMSCRIPTEN)
  add_executable(ttp_runtime_web runtime/ttp_runtime.cc runtime/ttp_party.cc)
  target_include_directories(ttp_runtime_web PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
  target_link_libraries(ttp_runtime_web PRIVATE libttp_sim libttp_party ttp_strict_fp)
  set_target_properties(ttp_runtime_web PROPERTIES OUTPUT_NAME "ttp_runtime" SUFFIX ".mjs")
  target_link_options(ttp_runtime_web PRIVATE
    -O2
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,node
    -sALLOW_MEMORY_GROWTH=1
    -sASSERTIONS=0
    "-sEXPORTED_FUNCTIONS=_ttp_session_begin,_ttp_add_human,_ttp_add_bot,_ttp_session_start,_ttp_update,_ttp_process_input,_ttp_snapshot_json,_ttp_results_json,_ttp_events_json,_ttp_has_car,_ttp_car_finished,_ttp_car_ids_json,_ttp_car_world_pos,_ttp_track_point,_ttp_force_remove_car,_ttp_rekey_car,_ttp_force_finish,_ttp_fast_forward,_ttp_pause,_ttp_resume,_ttp_racing,_ttp_paused,_ttp_dispose,_ttp_set_steer_expo,_ttp_get_steer_expo,_ttp_version,_ttp_room_create,_ttp_room_dispose,_ttp_room_reset,_ttp_room_add_player,_ttp_room_remove_player,_ttp_room_rekey,_ttp_room_set_field,_ttp_room_mark_disconnected,_ttp_room_mark_reconnected,_ttp_room_clear_disconnected,_ttp_room_transition_to,_ttp_room_state,_ttp_room_set_active_order,_ttp_room_on_seen,_ttp_room_is_expired,_ttp_room_expired_peers_json,_ttp_room_all_participants_disconnected,_ttp_room_has_late_joiners,_ttp_room_grace_tick,_ttp_room_set_master,_ttp_room_set_liveness_enabled,_ttp_room_host_json,_ttp_room_is_host,_ttp_room_size,_ttp_room_connected_count,_ttp_room_list_json,_ttp_room_has,_ttp_room_is_disconnected,_ttp_room_get_json,_ttp_room_events_json,_ttp_room_lowest_free_slot,_ttp_party_version,_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,stringToUTF8,HEAPF64"
  )
endif()
