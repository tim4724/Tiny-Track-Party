// protocol — the C++ twin of public/shared/protocol.js: the wire vocabulary
// (message types, room states, fastlane set) and shared game constants (car
// models/colours/stats) both sides of the party agree on. Pure data plus one
// pure function (car_stats). It mirrors the JS source file 1:1; the C++ module
// boundary is deliberately loose (it lives under libttp-party for now, next to
// the transport port, and may relocate into libttp-runtime once that exists).
//
// The oracle is tests/fixtures/protocol-corpus.jsonl (scripts/gen-protocol-
// corpus.mjs, read straight from protocol.js): manifest() must byte-match the
// recorded constant tables, and car_stats() the recorded lookup table — a
// decimal round-trip (double-conversion == JSON.stringify) pins each authored
// double, so a one-ulp transcription typo diverges.
#pragma once

#include <string>
#include <utility>
#include <vector>

#include "ttp/canonical.h"  // ttp::Value

namespace ttp {
namespace protocol {

// Per-model handling stats, parallel to CAR_MODELS/CAR_NAMES (protocol.js
// CAR_STATS). accel/vmax/turn are multipliers on the Dash baseline; mass is
// relative; halfLen/halfWid are collision half-extents in world units.
struct CarStat {
  double accel, vmax, turn, mass, halfLen, halfWid;
};

// ---- constant tables (mirror protocol.js exactly) ---------------------------
inline const std::vector<std::pair<std::string, std::string>> MSG = {
    {"HELLO", "hello"},         {"CONTROL", "control"},
    {"START_GAME", "start_game"}, {"RETURN_TO_LOBBY", "return_to_lobby"},
    {"PAUSE_GAME", "pause_game"}, {"RESUME_GAME", "resume_game"},
    {"SET_CAR", "set_car"},     {"SET_READY", "set_ready"},
    {"SELECT_MODE", "select_mode"}, {"SERIES_NEXT", "series_next"},
    {"LEAVE", "leave"},         {"PING", "ping"},
    {"LOBBY_UPDATE", "lobby_update"}, {"ITEM", "item"},
    {"PONG", "pong"},           {"COUNTDOWN", "countdown"},
    // Display -> its own slot; never reaches a controller. See protocol.js.
    {"HEARTBEAT", "_heartbeat"},
};

// FASTLANE_TYPES is keyed by the wire type string; value true = rides the
// unreliable fastlane. Only 'control' today.
inline const std::vector<std::pair<std::string, bool>> FASTLANE_TYPES = {
    {"control", true},
};

inline const std::vector<std::pair<std::string, std::string>> ROOM_STATE = {
    {"LOBBY", "lobby"}, {"COUNTDOWN", "countdown"},
    {"PLAYING", "playing"}, {"RESULTS", "results"},
};

inline const std::string RELAY_URL = "wss://ws.couchpad.games";
inline const std::string STUN_URL = "stun:stun.couchpad.games:3478";
inline const std::string STUN_FALLBACK_URL = "stun:stun.l.google.com:19302";

inline constexpr int MAX_PLAYERS = 4;
// Cars in every race (humans + the CPU fill); humans start from the back.
inline constexpr int FIELD_SIZE = 8;
inline constexpr int TOTAL_LAPS = 3;
inline constexpr int COUNTDOWN_SECONDS = 3;
// The schematic codec's max deviation — schematic.h EPS must equal this
// (abi_check pins it), exactly as getSteerExpo() must equal STEER_EXPO.
inline constexpr double SCHEMATIC_EPS = 0.35;

// ---- the presence contract (protocol.js LIVENESS) ---------------------------
// The phone's ping cadence and the display's drop / grace / canary windows.
// Mirrored here for the same reason STEER is: these are the numbers two
// implementations must agree on, and "a seat silent past 3 s is dropped" is
// only true against a 1 Hz ping. ttp::session (session.h) spends
// LIVENESS_HEARTBEAT_DEAD_MS directly; the rest are the shell's to feed into
// RoomFlow's liveness config and its timers.
inline constexpr double LIVENESS_PING_INTERVAL_MS = 1000;
inline constexpr double LIVENESS_TIMEOUT_MS = 3000;
inline constexpr double LIVENESS_TICK_MS = 1000;
inline constexpr double LIVENESS_HEARTBEAT_DEAD_MS = 6000;
inline constexpr double LIVENESS_ABANDONED_RACE_GRACE_MS = 15000;
inline constexpr double LIVENESS_CREATE_TIMEOUT_MS = 8000;

// ---- the random run length (protocol.js RANDOM_RACES) -----------------------
// The picker's only finite run length, and the ceiling the display clamps an
// incoming SELECT_MODE against. 0 is a legal length and means ENDLESS, so MAX
// is a ceiling rather than half of a range. Mirrored here for the same reason
// LIVENESS is: a shell that invents its own default advertises a run the host
// cannot pick, which is exactly what the first TV shell did with 1.
inline constexpr double RANDOM_RACES_DEFAULT = 4;
inline constexpr double RANDOM_RACES_MAX = 8;

// ---- the steering contract (protocol.js STEER) ------------------------------
// The numbers the phone and the display's sim must agree on; see the JS block
// for what each one does and why they only mean anything together. Only STEER_
// EXPO has a C++ consumer today (libttp-sim's steering curve — partytest/
// protocol_check.cc asserts ttp::getSteerExpo() equals it, which is what stops
// game.cc drifting from the phone), but all are mirrored because this header
// mirrors protocol.js 1:1 and a TV shell will want the tilt numbers the moment
// one exists.
inline constexpr double STEER_EXPO = 1.25;
inline constexpr double STEER_ROLL_LOCK_DEG = 30;
inline constexpr double STEER_DEADZONE = 0.06;
inline constexpr double STEER_SMOOTH = 0.5;
inline constexpr double STEER_GATE_THRESHOLD = 0.03;
inline constexpr double STEER_STRONG_THRESHOLD = 0.15;
inline constexpr double STEER_SEND_INTERVAL_MS = 100;
inline constexpr double STEER_SEND_MIN_INTERVAL_MS = 40;

inline const std::vector<std::string> CAR_COLORS = {
    "#e6492d", "#f2b134", "#2bb673", "#2d9cdb",
    "#9b51e0", "#eb5e9c", "#f2784b", "#56ccf2",
};
inline const std::vector<std::string> CAR_MODELS = {
    "vehicle-racer-low", "vehicle-speedster", "vehicle-racer", "vehicle-vintage-racer",
};
inline const std::vector<std::string> CAR_NAMES = {"Dash", "Bolt", "Carve", "Rumble"};
inline const std::vector<double> CAR_MODEL_YAW = {0, 0, 0, 0};

inline const std::vector<CarStat> CAR_STATS = {
    {1.04, 1.02, 1.10, 1.00, 0.44, 0.26},  // Dash
    {1.05, 1.06, 0.95, 0.78, 0.44, 0.28},  // Bolt
    {1.02, 0.98, 1.27, 0.86, 0.44, 0.26},  // Carve
    {0.96, 1.04, 0.98, 1.35, 0.44, 0.28},  // Rumble
};

// ---- pure surface -----------------------------------------------------------

// carStats(carIndex): wraps a (possibly null/NaN/non-integer) index into
// CAR_STATS. carIndex is a Value (NUL or NUM), mirroring the JS value the kit
// receives. Returns the stat object as a Value::Obj, or Value::Null() where JS
// yields undefined (a non-integer index survives the modulo but misses the
// array). Semantics: `(carIndex == null || isNaN) ? 0 : ((n % len) + len) % len`.
Value car_stats(const Value& carIndex);

// The full constant surface as one Value::Obj, in the shape gen-protocol-
// corpus.mjs records (keys: MSG, FASTLANE_TYPES, ROOM_STATE, RELAY_URL, ...).
Value manifest();

}  // namespace protocol
}  // namespace ttp
