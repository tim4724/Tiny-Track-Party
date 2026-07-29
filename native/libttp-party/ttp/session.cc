#include "ttp/session.h"

#include <cmath>
#include <cstdlib>
#include <set>

#include "ttp/json_read.h"
#include "ttp/jsonnum.h"
#include "ttp/protocol.h"
#include "ttp/relay_framing.h"

namespace ttp {
namespace session {
namespace {

// The one presence window this layer spends directly. protocol.h is the
// manifest; naming it here rather than restating 6000 is what stops a tvOS shell
// inventing its own canary. Everything else (the drop timeout, the abandoned-race
// grace, the tick cadence) is fed into RoomFlow by the shell, not decided here.
constexpr double kHeartbeatDeadMs = protocol::LIVENESS_HEARTBEAT_DEAD_MS;

// JS whitespace for String -> Number trimming: WhiteSpace + LineTerminator.
// The non-ASCII members (U+00A0, U+FEFF and the Unicode Zs class) arrive as
// UTF-8 byte sequences; the two that actually turn up in the wild are handled,
// and anything else is junk -> NaN, which is also what a stray byte should be.
bool isJsSpaceAt(const std::string& s, size_t i, size_t* width) {
  const unsigned char c = static_cast<unsigned char>(s[i]);
  if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
    *width = 1;
    return true;
  }
  if (c == 0xC2 && i + 1 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xA0) {
    *width = 2;  // U+00A0 NO-BREAK SPACE
    return true;
  }
  if (c == 0xEF && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xBB &&
      static_cast<unsigned char>(s[i + 2]) == 0xBF) {
    *width = 3;  // U+FEFF BOM
    return true;
  }
  return false;
}

std::string jsTrim(const std::string& s) {
  size_t a = 0;
  size_t w = 0;
  while (a < s.size() && isJsSpaceAt(s, a, &w)) a += w;
  size_t b = s.size();
  while (b > a) {
    // Walk back over the (1..3 byte) space forms.
    size_t step = 0;
    if (b >= a + 3 && isJsSpaceAt(s, b - 3, &w) && w == 3) step = 3;
    else if (b >= a + 2 && isJsSpaceAt(s, b - 2, &w) && w == 2) step = 2;
    else if (isJsSpaceAt(s, b - 1, &w) && w == 1) step = 1;
    if (!step) break;
    b -= step;
  }
  return s.substr(a, b - a);
}

const double kNaN = std::nan("");

// digitValue for a radix prefix (0x / 0o / 0b). -1 = not a digit.
int radixDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool parseRadix(const std::string& s, int radix, double* out) {
  if (s.empty()) return false;
  double v = 0;
  for (char c : s) {
    const int d = radixDigit(c);
    if (d < 0 || d >= radix) return false;
    v = v * radix + d;
  }
  *out = v;
  return true;
}

// StrDecimalLiteral, validated before strtod so the things C accepts and JS does
// not ("inf", "nan", "0x1p3", "1_0", a bare "." or "e5", trailing junk) all fall
// through to NaN.
bool validDecimal(const std::string& s) {
  size_t i = 0;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
  size_t intDigits = 0;
  while (i < s.size() && s[i] >= '0' && s[i] <= '9') { i++; intDigits++; }
  size_t fracDigits = 0;
  if (i < s.size() && s[i] == '.') {
    i++;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') { i++; fracDigits++; }
  }
  if (intDigits == 0 && fracDigits == 0) return false;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    i++;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
    size_t expDigits = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') { i++; expDigits++; }
    if (expDigits == 0) return false;
  }
  return i == s.size();
}

double jsStringToNumber(const std::string& raw) {
  const std::string s = jsTrim(raw);
  if (s.empty()) return 0;  // Number('') === 0, and Number('   ') too
  if (s.size() > 2 && s[0] == '0') {
    double v = 0;
    const char p = s[1];
    if ((p == 'x' || p == 'X') && parseRadix(s.substr(2), 16, &v)) return v;
    if ((p == 'o' || p == 'O') && parseRadix(s.substr(2), 8, &v)) return v;
    if ((p == 'b' || p == 'B') && parseRadix(s.substr(2), 2, &v)) return v;
    if (p == 'x' || p == 'X' || p == 'o' || p == 'O' || p == 'b' || p == 'B') return kNaN;
  }
  if (s == "Infinity" || s == "+Infinity") return HUGE_VAL;
  if (s == "-Infinity") return -HUGE_VAL;
  if (!validDecimal(s)) return kNaN;
  return std::strtod(s.c_str(), nullptr);  // correctly rounded (json_parse.h §number)
}

// String(value) for the ToPrimitive step an ARRAY takes: elements joined by ','
// with null/undefined contributing the empty string, an object contributing
// "[object Object]" and a nested array recursing. That is why Number([7]) is 7,
// Number([]) is 0 and Number([1,2]) is NaN.
std::string jsToString(const Value& v) {
  switch (v.type) {
    case Value::UNDEF:
    case Value::NUL: return "";
    case Value::BOOL: return v.b ? "true" : "false";
    case Value::NUM: return js_number_to_string(v.num);
    case Value::STR: return v.str;
    case Value::OBJ: return "[object Object]";
    case Value::ARR: {
      std::string out;
      for (size_t i = 0; i < v.arr.size(); i++) {
        if (i) out += ',';
        const Value& e = v.arr[i];
        // Array#join treats null/undefined as empty, which jsToString already does.
        out += jsToString(e);
      }
      return out;
    }
  }
  return "";
}

using json::truthy;   // JS truthiness — libttp-json's, not a fourth copy of it

// Copy a key across VERBATIM, dropping it when the source has none — JS reads an
// absent field as undefined and JSON.stringify drops the key, and the roster row
// has to behave the same way or a seat with no name gains one spelled `null`.
void copyKey(Value& dst, const Value& src, const char* key) {
  const Value* v = src.find(key);
  if (v) dst.set(key, *v);
}

}  // namespace

RoomState room_state_of(const std::string& name) {
  if (name == "lobby") return RoomState::LOBBY;
  if (name == "countdown") return RoomState::COUNTDOWN;
  if (name == "playing") return RoomState::PLAYING;
  if (name == "results") return RoomState::RESULTS;
  return RoomState::OTHER;
}

// ---- the retained room snapshot ---------------------------------------------

Value roster_rows(const Value& roster, const Value& inRace) {
  Value out = Value::Arr();
  if (roster.type != Value::ARR) return out;
  for (size_t i = 0; i < roster.arr.size(); i++) {
    const Value& p = roster.arr[i];
    Value row = Value::Obj();
    copyKey(row, p, "peerIndex");
    copyKey(row, p, "name");
    copyKey(row, p, "colorIndex");
    copyKey(row, p, "carIndex");
    copyKey(row, p, "connected");
    row.set("ready", Value::Bool(truthy(p.find("ready"))));
    const Value* flag = (inRace.type == Value::ARR && i < inRace.arr.size())
                            ? &inRace.arr[i] : nullptr;
    row.set("inRace", Value::Bool(truthy(flag)));
    out.push(std::move(row));
  }
  return out;
}

Value lobby_snapshot(const Value& input, const Value& chooser) {
  const Value* stateV = input.find("roomState");
  const bool lobby = stateV && stateV->type == Value::STR && stateV->str == "lobby";

  Value out = Value::Obj();
  out.set("type", Value::Str("lobby_update"));
  copyKey(out, input, "hostPeerIndex");
  copyKey(out, input, "roomState");
  out.set("paused", Value::Bool(truthy(input.find("paused"))));

  const Value* roster = input.find("roster");
  const Value* inRace = input.find("inRace");
  out.set("players", roster_rows(roster ? *roster : Value::Arr(),
                                 inRace ? *inRace : Value::Arr()));

  copyKey(out, input, "mode");
  copyKey(out, input, "cupId");
  // Between cupId and trackId because that is where the JS literal put it and
  // the key order of this message IS the wire (see the header). A 'random' pick's
  // run length: 0 endless, else that many races. Passthrough like every other
  // pick field — the shell clamps it before it gets here (Net.js normRandomRaces),
  // for the same reason the mode pick itself never crossed.
  copyKey(out, input, "randomRaces");
  copyKey(out, input, "trackId");
  copyKey(out, input, "standings");

  // The chooser is opaque passthrough. An absent key stays absent (JS reads
  // undefined off a missing chooser and JSON.stringify drops it); `tracks` is
  // lobby-gated and becomes an explicit null everywhere else.
  copyKey(out, chooser, "cars");
  copyKey(out, chooser, "colors");
  if (lobby) copyKey(out, chooser, "tracks");
  else out.set("tracks", Value::Null());
  return out;
}

// ---- URLs -------------------------------------------------------------------

std::string join_url(const std::string& base, const std::string& room,
                     const std::string& instance) {
  std::string url = base + "/" + room;
  if (!instance.empty()) url += "#" + framing::encode_uri_component(instance);
  return url;
}

std::string claim_url(const std::string& url, double peerIndex) {
  const size_t h = url.find('#');
  const std::string base = (h == std::string::npos) ? url : url.substr(0, h);
  const std::string frag = (h == std::string::npos) ? std::string() : url.substr(h);
  const char* sep = (base.find('?') != std::string::npos) ? "&" : "?";
  return base + sep + "claim=" +
         framing::encode_uri_component(js_number_to_string(peerIndex)) + frag;
}

bool controller_url_template(const std::string& base, std::string* out) {
  size_t end = base.size();
  while (end > 0 && base[end - 1] == '/') end--;   // /\/+$/ -> ''
  const std::string trimmed = base.substr(0, end);
  if (trimmed.rfind("https://", 0) != 0) return false;
  *out = trimmed + "/{room}#{instance}";
  return true;
}

double js_to_number(const Value* v) {
  if (!v) return kNaN;  // Number(undefined)
  switch (v->type) {
    case Value::UNDEF: return kNaN;
    case Value::NUL: return 0;
    case Value::BOOL: return v->b ? 1 : 0;
    case Value::NUM: return v->num;
    case Value::STR: return jsStringToNumber(v->str);
    case Value::OBJ: return kNaN;
    case Value::ARR: return jsStringToNumber(jsToString(*v));
  }
  return kNaN;
}

bool norm_index(const Value* v, double* out) {
  const double n = js_to_number(v);
  // Number.isInteger: finite and equal to its own truncation. NaN and both
  // infinities fail, which is what makes 'abc' and 'Infinity' null rather than 0.
  if (!std::isfinite(n) || std::trunc(n) != n) return false;
  if (!(n >= 0)) return false;
  *out = n;
  return true;
}

// ---- seats ------------------------------------------------------------------

SeatDefaults seat_defaults(double colorIndex) {
  SeatDefaults d;
  d.nameKey = "player_n";
  d.nameArg = colorIndex + 1;
  d.colorIndex = colorIndex;
  d.carIndex = colorIndex;
  d.ready = false;
  return d;
}

AddPeerPlan add_peer_plan(bool has, double size, double maxPlayers, double colorIndex) {
  AddPeerPlan plan;
  if (has) {
    plan.hasSeat = false;
    plan.stamp = true;
    return plan;
  }
  if (size >= maxPlayers) {
    plan.hasSeat = false;
    plan.stamp = false;
    return plan;
  }
  plan.hasSeat = true;
  plan.seat = seat_defaults(colorIndex);
  plan.stamp = true;
  return plan;
}

PresenceAction presence_action(RoomState state) {
  return state == RoomState::LOBBY ? PresenceAction::FREE : PresenceAction::DROP;
}

LeaveAction leave_action(RoomState state) {
  return (state == RoomState::COUNTDOWN || state == RoomState::PLAYING)
             ? LeaveAction::DROP : LeaveAction::EXPIRE;
}

Value reconnect_card(const Value& seat, const std::string& url) {
  Value card = Value::Obj();
  copyKey(card, seat, "peerIndex");
  copyKey(card, seat, "name");
  copyKey(card, seat, "colorIndex");
  card.set("url", Value::Str(url));
  return card;
}

// ---- controller messages -----------------------------------------------------

InboundRoute inbound_route(double from, const std::string& type) {
  if (from != 0) return InboundRoute::PEER;
  return type == "_heartbeat" ? InboundRoute::SELF_HEARTBEAT : InboundRoute::SELF_IGNORE;
}

MessageAction message_action(const std::string& type) {
  if (type == "hello") return MessageAction::HELLO;
  if (type == "leave") return MessageAction::LEAVE;
  if (type == "set_car") return MessageAction::SET_CAR;
  if (type == "set_ready") return MessageAction::SET_READY;
  if (type == "select_mode") return MessageAction::SELECT_MODE;
  if (type == "ping") return MessageAction::PING;
  return MessageAction::GAME;
}

bool set_car_decision(bool ready, RoomState state, bool inRace,
                      const Value* carIndex, double carCount) {
  if (ready) return false;
  if (!(state == RoomState::LOBBY || !inRace)) return false;
  // Number.isInteger(x): x must BE a number. The string "1" and the boolean true
  // are refused here, not coerced — this is untrusted input from a phone.
  if (!carIndex || carIndex->type != Value::NUM) return false;
  const double idx = carIndex->num;
  if (!std::isfinite(idx) || std::trunc(idx) != idx) return false;
  return idx >= 0 && idx < carCount;
}

bool set_ready_decision(bool isHost, RoomState state, bool ready, bool current) {
  return !isHost && state == RoomState::LOBBY && ready != current;
}

// ---- room-state transitions ---------------------------------------------------

StateChangePlan state_change_plan(RoomState to) {
  StateChangePlan plan;
  plan.restampConnected = to == RoomState::COUNTDOWN;
  plan.freeDisconnected = to == RoomState::LOBBY;
  plan.clearStandings = to == RoomState::COUNTDOWN || to == RoomState::LOBBY;
  plan.publish = true;
  return plan;
}

HostChangePlan host_change_plan() { return HostChangePlan{}; }

// ---- liveness ----------------------------------------------------------------

HeartbeatTick heartbeat_tick(bool inRoom, bool hbPending, double hbSentAt, double now) {
  HeartbeatTick t;
  if (!inRoom) {
    t.act = HeartbeatAct::IDLE;
    t.hbPending = hbPending;
    t.hbSentAt = hbSentAt;
    t.sweep = false;
    return t;
  }
  if (hbPending && now - hbSentAt > kHeartbeatDeadMs) {
    t.act = HeartbeatAct::RECONNECT;
    t.hbPending = false;
    t.hbSentAt = hbSentAt;
    t.sweep = false;
    return t;
  }
  if (!hbPending) {
    t.act = HeartbeatAct::SEND;
    t.hbPending = true;
    t.hbSentAt = now;
    t.sweep = true;
    return t;
  }
  t.act = HeartbeatAct::WAIT;
  t.hbPending = true;
  t.hbSentAt = hbSentAt;
  t.sweep = true;
  return t;
}

// ---- claims + reconciliation ---------------------------------------------------

ClaimPlan claim_plan(double fromId, const Value* rejoinToken, bool hasOld,
                     bool oldDisconnected) {
  ClaimPlan plan;
  double oldId = 0;
  if (!norm_index(rejoinToken, &oldId)) return plan;
  if (oldId == fromId) return plan;
  if (!hasOld || !oldDisconnected) return plan;
  plan.claim = true;
  plan.oldId = oldId;
  plan.restamp = true;
  return plan;
}

ResyncPlan resync_plan(const std::vector<double>& rosterIds,
                       const std::vector<double>& relayPeers) {
  ResyncPlan plan;
  std::set<double> present(relayPeers.begin(), relayPeers.end());
  std::set<double> known;
  for (double id : rosterIds) {
    if (present.count(id)) known.insert(id);
    else plan.expire.push_back(id);
  }
  for (double idx : relayPeers) {
    if (idx == 0 || known.count(idx)) continue;
    known.insert(idx);
    plan.add.push_back(idx);
  }
  plan.publish = true;
  return plan;
}

// ---- wire spellings ----------------------------------------------------------

const char* key(PresenceAction a) { return a == PresenceAction::FREE ? "free" : "drop"; }
const char* key(LeaveAction a) { return a == LeaveAction::DROP ? "drop" : "expire"; }
const char* key(InboundRoute r) {
  switch (r) {
    case InboundRoute::PEER: return "peer";
    case InboundRoute::SELF_HEARTBEAT: return "self-heartbeat";
    case InboundRoute::SELF_IGNORE: return "self-ignore";
  }
  return "peer";
}
const char* key(MessageAction a) {
  switch (a) {
    case MessageAction::HELLO: return "hello";
    case MessageAction::LEAVE: return "leave";
    case MessageAction::SET_CAR: return "set_car";
    case MessageAction::SET_READY: return "set_ready";
    case MessageAction::SELECT_MODE: return "select_mode";
    case MessageAction::PING: return "ping";
    case MessageAction::GAME: return "game";
  }
  return "game";
}
const char* key(HeartbeatAct a) {
  switch (a) {
    case HeartbeatAct::IDLE: return "idle";
    case HeartbeatAct::RECONNECT: return "reconnect";
    case HeartbeatAct::SEND: return "send";
    case HeartbeatAct::WAIT: return "wait";
  }
  return "idle";
}

}  // namespace session
}  // namespace ttp
