// relay_framing — the C++ twin of partyplug/PartyConnection.js's PURE surface:
// the Party-Server wire framing the kit drives. It owns what bytes go out
// (outbound encoders), how an inbound relay frame is routed (classify), what a
// close code decides (terminal vs reconnect), the reconnect backoff, and the
// sharded reconnect URL. The socket lifecycle itself — opening, the reconnect
// loop, JSON.parse of inbound text, clientId generation — stays platform I/O
// (the native socket driver, a later slice); this is the logic that drives it.
//
// Oracle: tests/fixtures/framing-corpus.jsonl (scripts/gen-framing-corpus.mjs),
// recorded by driving the REAL PartyConnection with a mock WebSocket. Encoders
// compare as canonical JSON; classify/close/pin/backoff compare field by field.
#pragma once

#include <string>

#include "ttp/canonical.h"  // ttp::Value

namespace ttp {
namespace framing {

// ---- outbound encoders (the object handed to ws.send) -----------------------
Value encode_create(const std::string& clientId, double maxClients, const std::string* url);
Value encode_join(const std::string& clientId, const std::string& room);
Value encode_send_to(const Value& to, const Value& data);
Value encode_broadcast(const Value& data);
Value encode_set_state(const Value& data);
Value encode_close_room();

// ---- inbound classification (ws.onmessage routing) --------------------------
// 'message' -> onMessage(from, data); 'state' -> onState(data); anything else
// (incl. no type) -> onProtocol(type, wholeFrame). Missing from/data/type stay
// UNDEF (dropped under canonical stringify, matching JS undefined).
struct Inbound {
  enum Route { MESSAGE, STATE, PROTOCOL } route = PROTOCOL;
  Value from;  // MESSAGE
  Value data;  // MESSAGE / STATE
  Value type;  // PROTOCOL (STR, or NUL when the frame has no `type`)
  Value msg;   // PROTOCOL (the whole frame)
};
Inbound classify_inbound(const Value& frame);

// ---- close-code semantics (ws.onclose decision) -----------------------------
// 4000 -> {replaced:true}, terminal; 4001 -> {roomClosed:true}, terminal;
// otherwise attempt++ and reconnect if still allowed and within budget.
struct CloseOutcome {
  bool stopReconnect = false;  // sets _shouldReconnect = false
  double closeAttempt = 0;     // onClose arg 1
  double closeMax = 0;         // onClose arg 2
  Value meta = Value::Null();  // onClose arg 3: {replaced}/{roomClosed}/null
  bool willReconnect = false;  // a reconnect got scheduled
};
CloseOutcome close_outcome(bool hasCode, double code, double attemptBefore,
                           double maxAttempts, bool shouldReconnectBefore);

// ---- reconnect backoff ------------------------------------------------------
// min(1000 * 1.5^(attempt-1), 5000) ms. Local reconnect timing, NOT a wire
// conformance surface — two peers with different backoff still interoperate.
// The inputs (attempt 1..4 before the 5000 cap bites) yield exactly
// representable powers of 1.5, so any libm agrees; the V8-recorded corpus is
// the guard, and it is off the fdlibm byte path (bare Math.pow in JS).
double backoff_delay_ms(double attempt);

// ---- sharded reconnect URL --------------------------------------------------
// encodeURIComponent: percent-encode every UTF-8 byte except the ECMA-262
// unreserved set (A-Za-z0-9 and -_.!~*'()), hex uppercase.
std::string encode_uri_component(const std::string& s);
// base + '/' + enc(room) + '?instance=' + enc(instance); a falsy instance is a
// no-op that returns base unchanged (JS pinInstance's early return).
std::string pin_instance_url(const std::string& base, const std::string& room,
                             const std::string& instance);

}  // namespace framing
}  // namespace ttp
