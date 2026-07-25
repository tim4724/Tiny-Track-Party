#include "ttp/relay_framing.h"

#include <algorithm>
#include <cmath>

namespace ttp {
namespace framing {

// ---- outbound encoders ------------------------------------------------------

Value encode_create(const std::string& clientId, double maxClients, const std::string* url) {
  Value m = Value::Obj();
  m.set("type", Value::Str("create"));
  m.set("clientId", Value::Str(clientId));
  m.set("maxClients", Value::Num(maxClients));
  if (url) m.set("url", Value::Str(*url));  // `if (url)` — omitted when absent
  return m;
}

Value encode_join(const std::string& clientId, const std::string& room) {
  Value m = Value::Obj();
  m.set("type", Value::Str("join"));
  m.set("clientId", Value::Str(clientId));
  m.set("room", Value::Str(room));
  return m;
}

Value encode_send_to(const Value& to, const Value& data) {
  Value m = Value::Obj();
  m.set("type", Value::Str("send"));
  m.set("data", data);
  m.set("to", to);
  return m;
}

Value encode_broadcast(const Value& data) {
  Value m = Value::Obj();
  m.set("type", Value::Str("send"));
  m.set("data", data);
  return m;  // no `to` field
}

Value encode_set_state(const Value& data) {
  Value m = Value::Obj();
  m.set("type", Value::Str("set_state"));
  m.set("data", data);
  return m;
}

Value encode_close_room() {
  Value m = Value::Obj();
  m.set("type", Value::Str("close_room"));
  return m;
}

// ---- inbound classification -------------------------------------------------

static const Value* field(const Value& frame, const char* key) {
  if (frame.type != Value::OBJ) return nullptr;
  for (const auto& kv : frame.obj) if (kv.first == key) return &kv.second;
  return nullptr;
}

Inbound classify_inbound(const Value& frame) {
  Inbound in;
  const Value* type = field(frame, "type");
  const bool isStr = type && type->type == Value::STR;

  if (isStr && type->str == "message") {
    in.route = Inbound::MESSAGE;
    if (const Value* f = field(frame, "from")) in.from = *f;
    if (const Value* d = field(frame, "data")) in.data = *d;
    return in;
  }
  if (isStr && type->str == "state") {
    in.route = Inbound::STATE;
    if (const Value* d = field(frame, "data")) in.data = *d;
    return in;
  }
  // Catch-all: onProtocol(msg.type, msg). type stays NUL when the frame has none.
  in.route = Inbound::PROTOCOL;
  in.type = type ? *type : Value::Null();
  in.msg = frame;
  return in;
}

// ---- close-code semantics ---------------------------------------------------

CloseOutcome close_outcome(bool hasCode, double code, double attemptBefore,
                           double maxAttempts, bool shouldReconnectBefore) {
  CloseOutcome o;
  if (hasCode && code == 4000) {                 // evicted: replaced
    o.stopReconnect = true;
    o.meta = Value::Obj();
    o.meta.set("replaced", Value::Bool(true));
    return o;                                    // closeAttempt/closeMax stay 0
  }
  if (hasCode && code == 4001) {                 // room gone
    o.stopReconnect = true;
    o.meta = Value::Obj();
    o.meta.set("roomClosed", Value::Bool(true));
    return o;
  }
  o.closeAttempt = attemptBefore + 1;            // reconnectAttempt++
  o.closeMax = maxAttempts;
  o.meta = Value::Null();
  // The else branch never touches _shouldReconnect, so its final state (and thus
  // stopReconnect) is just whatever it already was.
  o.stopReconnect = !shouldReconnectBefore;
  o.willReconnect = shouldReconnectBefore && o.closeAttempt <= maxAttempts;
  return o;
}

// ---- reconnect backoff ------------------------------------------------------

double backoff_delay_ms(double attempt) {
  return std::min(1000.0 * std::pow(1.5, attempt - 1.0), 5000.0);
}

// ---- sharded reconnect URL --------------------------------------------------

static bool isUnreserved(unsigned char c) {
  if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
    return true;
  switch (c) {
    case '-': case '_': case '.': case '!': case '~':
    case '*': case '\'': case '(': case ')':
      return true;
    default:
      return false;
  }
}

std::string encode_uri_component(const std::string& s) {
  static const char* HEX = "0123456789ABCDEF";
  std::string out;
  out.reserve(s.size());
  for (unsigned char c : s) {
    if (isUnreserved(c)) {
      out += static_cast<char>(c);
    } else {
      out += '%';
      out += HEX[c >> 4];
      out += HEX[c & 0x0F];
    }
  }
  return out;
}

std::string pin_instance_url(const std::string& base, const std::string& room,
                             const std::string& instance) {
  if (instance.empty()) return base;  // JS `if (!instance) return;`
  return base + '/' + encode_uri_component(room) + "?instance=" + encode_uri_component(instance);
}

}  // namespace framing
}  // namespace ttp
