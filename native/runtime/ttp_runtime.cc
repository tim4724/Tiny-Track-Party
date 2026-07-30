// ttp_runtime.cc — the C ABI implementation (see ttp_runtime.h).
//
// Each handle owns a RuntimeSession: the built track, the added players, and
// either a RaceSession (countdown mode) or a bare Game (countdown < 0, the
// input-replay / golden-trace equivalent). The session's onEvent/onCountdown/
// onRaceEnd callbacks funnel into one ordered event queue that ttp_events_json
// drains. Bots are driven inside ttp_update, mirroring the live render loop.

#include "ttp_error.h"
#include "ttp_runtime.h"
#include "ttp_audio.h"
#include "ttp_session.h"

#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "generated/track_defs.h"
#include "ttp/ai_driver.h"
#include "ttp/audio.h"
#include "ttp/canonical.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/jsonnum.h"
#include "ttp/race_track.h"
#include "ttp/race_track_json.h"
#include "ttp/schematic.h"
#include "ttp/json_parse.h"
#include "ttp/grand_prix.h"
#include "ttp/race_session.h"
#include "ttp/trackbuilder.h"
#include "ttp/util.h"

using namespace ttp;

static const int CONTRACT_VERSION = 2;
static const char* MATHLIB = "fdlibm-openlibm-0.8.7";

// ---------------------------------------------------------------------------
// Flat stats parsing (ids parse via ttp/scalar_id.h).
// ---------------------------------------------------------------------------
// Flat numeric stats object; absent or non-numeric members keep the benchmark
// default. Each key is read as a real object member, not matched as a substring
// of the raw text.
static Stats parseStats(const char* json) {
  Stats st;
  if (!json) return st;
  bool ok = false;
  Value v = json::parse(json, &ok);
  if (!ok || v.type != Value::OBJ) return st;
  auto num = [&v](const char* key, double& dst) {
    const Value* f = v.find(key);
    if (f && f->type == Value::NUM) dst = f->num;
  };
  num("accel", st.accel);
  num("vmax", st.vmax);
  num("turn", st.turn);
  num("mass", st.mass);
  num("halfLen", st.halfLen);
  num("halfWid", st.halfWid);
  return st;
}

// ---------------------------------------------------------------------------
// Track descriptor -> TrackDef (ttp_track_build_json).
//
// The twin of scripts/gen-track-defs-header.mjs, which bakes the SHIPPED
// catalogue into generated/track_defs.h at build time. This does the same job at
// run time for a descriptor that is not in the catalogue — an authoring tool's
// candidate layout. Both must read a descriptor identically or a track would
// measure one way in the tool and build another way in the game, so the field
// rules below are deliberately the same rules, in the same order.
//
// The PRESENCE rules are the subtle part (the codegen's own notes spell out why):
//   furniture radius : absent -> derived from the road width, not 0
//   segment  width   : absent -> default, number -> scalar, [a,b] -> taper
//   segment  over    : absent -> true (only an explicit false flips it)
//   waypoint w       : absent -> the track width, carried as a 0 sentinel
// Everything else the builder reads as `x || 0`, so a missing field is a real 0.
// ---------------------------------------------------------------------------

// Owns the arrays TrackDef points into; `def` is only valid while this lives.
struct ParsedTrackDef {
  TrackDef def{};
  std::string id;
  std::vector<SegDef> segs;
  std::vector<WptDef> wpts;
  std::vector<FurnDef> oils, pads, boxes, poles;
  std::vector<BananaDef> bananas;
};

static const double kRoadWidthFallback = 2.5;  // TrackBuilder ROAD_WIDTH

static double numOr(const Value& v, const char* key, double dflt) {
  const Value* f = v.find(key);
  return (f && f->type == Value::NUM) ? f->num : dflt;
}
static bool boolOr(const Value& v, const char* key, bool dflt) {
  const Value* f = v.find(key);
  return (f && f->type == Value::BOOL) ? f->b : dflt;
}

static bool parseSeg(const Value& s, SegDef& out) {
  if (s.type != Value::OBJ) return false;
  const Value* kind = s.find("kind");
  if (!kind || kind->type != Value::STR) return false;
  if (kind->str == "straight") out.kind = SegKind::Straight;
  else if (kind->str == "arc") out.kind = SegKind::Arc;
  else if (kind->str == "loop") out.kind = SegKind::Loop;
  else return false;  // an unknown kind is a typo, not a track
  out.length = numOr(s, "length", 0);
  out.radius = numOr(s, "radius", 0);
  out.angle = numOr(s, "angle", 0);
  out.rise = numOr(s, "rise", 0);
  out.bank = numOr(s, "bank", 0);
  out.roll = numOr(s, "roll", 0);
  out.drift = numOr(s, "drift", 0);
  out.over = boolOr(s, "over", true);
  out.pillars = boolOr(s, "pillars", false);
  out.widthKind = 0;
  out.w0 = 0;
  out.w1 = 0;
  if (const Value* w = s.find("width")) {
    if (w->type == Value::NUM) { out.widthKind = 1; out.w0 = w->num; }
    else if (w->type == Value::ARR && w->arr.size() == 2
             && w->arr[0].type == Value::NUM && w->arr[1].type == Value::NUM) {
      out.widthKind = 2; out.w0 = w->arr[0].num; out.w1 = w->arr[1].num;
    } else if (w->type != Value::NUL) return false;
  }
  return true;
}

static bool parseWpt(const Value& w, WptDef& out) {
  if (w.type != Value::OBJ) return false;
  const Value* x = w.find("x");
  const Value* z = w.find("z");
  if (!x || x->type != Value::NUM || !z || z->type != Value::NUM) return false;
  out.x = x->num;
  out.z = z->num;
  out.y = numOr(w, "y", 0);
  out.w = numOr(w, "w", 0);  // 0 == absent: the builder substitutes the track width
  out.bank = numOr(w, "bank", 0);
  out.bridge = boolOr(w, "bridge", false);
  return true;
}

static bool parseFurn(const Value& f, FurnDef& out) {
  if (f.type != Value::OBJ) return false;
  const Value* u = f.find("u");
  if (!u || u->type != Value::NUM) return false;
  out.u = u->num;
  out.lat = numOr(f, "lat", 0);
  const Value* r = f.find("radius");
  out.hasRadius = r && r->type == Value::NUM;
  out.radius = out.hasRadius ? r->num : 0;
  return true;
}

template <class T, class F>
static bool parseList(const Value& desc, const char* key, std::vector<T>& out, F parse1) {
  const Value* arr = desc.find(key);
  if (!arr) return true;                       // absent == none
  if (arr->type == Value::NUL) return true;
  if (arr->type != Value::ARR) return false;
  out.reserve(arr->arr.size());
  for (const Value& e : arr->arr) {
    T item{};
    if (!parse1(e, item)) return false;
    out.push_back(item);
  }
  return true;
}

static bool parse_track_def(const Value& desc, ParsedTrackDef& p) {
  const Value* wpts = desc.find("waypoints");
  const Value* segs = desc.find("segments");
  const bool isSpline = wpts && wpts->type == Value::ARR;
  const bool hasSegs = segs && segs->type == Value::ARR;
  // Exactly one geometry source, matching the codegen's two failure cases.
  if (isSpline == hasSegs) return false;

  if (const Value* id = desc.find("id")) {
    if (id->type == Value::STR) p.id = id->str;
  }
  p.def.id = p.id.c_str();
  p.def.isSpline = isSpline;
  // The codegen's `(desc.width) || ROAD_WIDTH`, spelled out: C++ `||` is boolean,
  // so writing it the JS way silently yields 1.0 for every track that omits a
  // width — a half-width road, and every derived furniture radius with it.
  const double width = numOr(desc, "width", 0);
  p.def.width = width != 0 ? width : kRoadWidthFallback;
  p.def.startU = numOr(desc, "startU", 0);

  if (isSpline) {
    if (!parseList(desc, "waypoints", p.wpts, parseWpt)) return false;
    if (p.wpts.empty()) return false;
  } else {
    if (!parseList(desc, "segments", p.segs, parseSeg)) return false;
    if (p.segs.empty()) return false;
  }
  if (!parseList(desc, "oils", p.oils, parseFurn)) return false;
  if (!parseList(desc, "pads", p.pads, parseFurn)) return false;
  if (!parseList(desc, "boxes", p.boxes, parseFurn)) return false;
  if (!parseList(desc, "poles", p.poles, parseFurn)) return false;
  if (!parseList(desc, "bananas", p.bananas, [](const Value& b, BananaDef& out) {
        if (b.type != Value::OBJ) return false;
        const Value* u = b.find("u");
        if (!u || u->type != Value::NUM) return false;
        out.u = u->num;
        out.lat = numOr(b, "lat", 0);
        return true;
      })) return false;

  p.def.segs = p.segs.empty() ? nullptr : p.segs.data();
  p.def.nSegs = (int) p.segs.size();
  p.def.wpts = p.wpts.empty() ? nullptr : p.wpts.data();
  p.def.nWpts = (int) p.wpts.size();
  p.def.oils = p.oils.empty() ? nullptr : p.oils.data();
  p.def.nOils = (int) p.oils.size();
  p.def.pads = p.pads.empty() ? nullptr : p.pads.data();
  p.def.nPads = (int) p.pads.size();
  p.def.boxes = p.boxes.empty() ? nullptr : p.boxes.data();
  p.def.nBoxes = (int) p.boxes.size();
  p.def.poles = p.poles.empty() ? nullptr : p.poles.data();
  p.def.nPoles = (int) p.poles.size();
  p.def.bananas = p.bananas.empty() ? nullptr : p.bananas.data();
  p.def.nBananas = (int) p.bananas.size();
  return true;
}

// ---------------------------------------------------------------------------
// Per-handle session.
// ---------------------------------------------------------------------------
struct BotEntry {
  Id id;
  bool hasStats = false;
  Stats stats;
  double caution = 1, laneBias = 0;
  uint32_t aiSeed = 0;
  std::unique_ptr<AiController> ai;  // built at start
};

// Forward declarations of the audio bus's two taps (defined in the audio
// section at the bottom). A race event and a countdown beat are decided into
// sound HERE, as the sim fires them, rather than being serialized out and
// handed back — so the session's own callbacks are where they are picked up.
// `handle` is what tells the bus whether this is the session it is bound to.
static void audio_tap_event(int handle, const Event& e);
static void audio_tap_tick(int handle, int n);
static void audio_forget_session(int handle);

struct RuntimeSession {
  int handle = 0;
  std::unique_ptr<Centerline> centerline;
  GameTrack track;
  std::string forceItem;
  std::vector<PlayerDesc> humans;  // add order
  std::vector<BotEntry> bots;      // add order

  bool started = false;  // startCountdown fired (or bare mode running)
  bool built = false;    // session objects constructed (may precede started)
  bool bare = false;
  bool racingBare = false;
  bool pausedBare = false;

  std::unique_ptr<Game> game;            // bare-mode owner
  std::unique_ptr<RaceSession> session;  // countdown-mode owner
  Game* eng = nullptr;

  std::vector<Value> outQueue;
  std::string scratch;

  // Drive every bot's controller (a no-op for finished/removed cars). Add order.
  void driveBots() {
    for (auto& b : bots)
      if (b.ai) eng->driveBot(b.id, *b.ai, nullptr);
  }
};

static std::map<int, std::unique_ptr<RuntimeSession>> g_sessions;
static int g_next = 1;

static RuntimeSession* get(int h) {
  auto it = g_sessions.find(h);
  return it == g_sessions.end() ? nullptr : it->second.get();
}

// Track assembly is shared (ttp/race_track.h) so the ABI, the replay/record CLI
// and the probes cannot drift apart. The session owns the centerline the
// GameTrack points at, so the built pair is moved onto it wholesale.
static bool buildTrack(RuntimeSession& rs, const std::string& trackId, int laps, uint32_t seed) {
  BuiltRaceTrack bt;
  std::string err;
  if (!build_race_track_by_id(trackId, laps, seed, bt, err)) return false;
  rs.centerline = std::move(bt.centerline);
  rs.track = std::move(bt.game);
  rs.track.centerline = rs.centerline.get();   // re-point after the move
  return true;
}

// A shared "no session" string result for calls on a bad/unstarted handle.
static const char* NULL_JSON = "null";
static const char* EMPTY_ARR = "[]";

static void buildSession(RuntimeSession* rs);

// ttp_session.h — the display's read-only seam onto the live engine. Same lazy
// build every other query does, so binding a display to a begun-but-not-started
// handle draws the grid poses rather than nothing.
ttp::Game* ttp_session_engine(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return nullptr;
  if (!rs->eng) buildSession(rs);
  return rs->eng;
}

// ===========================================================================
// Audio decisions (ttp_audio.h).
//
// The rules themselves are libttp-runtime/ttp/audio.{h,cc} — the port of
// public/display/audio/decide.js, pinned to tests/fixtures/audio-corpus.jsonl
// on every leg. What lives here is the SEAM: one bus per process holding the
// Decider, the queue of commands it has decided and not yet been drained of,
// and the small amount of reading-the-live-race that the decisions are a pure
// function of.
//
// It sits in this file rather than in one of its own because it is the same
// thing every other function above it is: a shim over a RuntimeSession's
// internals. It needs the bound session's Game (the cars and rockets to voice),
// its BOTS (a CPU car is neither a listener nor a voice — the sim knows which
// cars it drives itself, so nothing has to tell it) and its event callbacks
// (the tap below). None of that is reachable through the seam ttp_session.h
// exposes, and widening that seam to keep a second file company would be the
// worse trade.
//
// The definitions are ABOVE the extern "C" block on purpose: they are already
// declared with C language linkage by ttp_audio.h, and the static helpers they
// share must not be declared in one linkage and defined in another.
// ===========================================================================
// A silent scope: the taps below drop everything fired inside it. The
// end-of-race fast-forward is SKIPPING, not racing — it runs the deterministic
// sim to the flag with no rendering, so a burst of laps, pickups and finishes
// fires in one call and none of it happened on screen.
static bool g_audioMute = false;
struct AudioMute {
  bool prev;
  AudioMute() : prev(g_audioMute) { g_audioMute = true; }
  ~AudioMute() { g_audioMute = prev; }
};

namespace {

namespace au = ttp::rt::audio;

// One queued beat: a race event, or a countdown tick. Both make sound and both
// fire from inside ttp_update, so both wait here in ONE ordered list until the
// shell's next audio call dates them with its clock.
struct AudioBeat {
  bool tick = false;
  int n = 0;
  Event ev;
};

struct AudioBus {
  au::Decider dec;
  std::vector<au::Command> cmds;   // decided, not yet drained
  std::vector<AudioBeat> pending;  // fired, not yet decided
  std::vector<uint8_t> block;      // the packed readback
  std::vector<Id> subjects;        // interned voice subjects (index + 1)
  int session = 0;
  double nowMs = 0;
};

AudioBus& bus() {
  // Function-local so the Decider's construction (which reaches for the
  // platform RNG) cannot race a static initializer in another translation unit.
  static AudioBus b;
  return b;
}

// The opaque voice identity TtpAudioCmd.subject carries. Interned per distinct
// source, so a car and a rocket can never collide the way their raw sim ids
// can, and no car id is ever handed to a shell. Reset by STOP_ALL, which is the
// one moment when the shell has no live voice left to key.
int32_t audioSubject(const Id& id) {
  AudioBus& b = bus();
  for (size_t i = 0; i < b.subjects.size(); i++) {
    if (b.subjects[i] == id) return (int32_t) (i + 1);
  }
  b.subjects.push_back(id);
  return (int32_t) b.subjects.size();
}

au::Point audioPoint(const Vec3& v) {
  au::Point p;
  p.x = v.x; p.y = v.y; p.z = v.z;
  return p;
}

// The world point of a track (arclength, lateral) pair — ttp_track_point's body,
// so a rocket's jet and its detonation are measured by the same sampler the
// shell used to ask for over the boundary.
au::Point audioTrackPoint(Game* eng, double s, double lat) {
  Frame f = eng->centerline()->sampleAt(s);
  f.pos.addScaledVector(f.lateral, lat);
  return audioPoint(f.pos);
}

// The cars the sim drives itself. They have no split-screen cell, so they are
// neither listeners nor voices.
au::AiIds audioAiIds(const RuntimeSession& rs) {
  au::AiIds ai;
  for (const auto& b : rs.bots) ai.add(b.id);
  return ai;
}

// Decide every queued beat, then empty the queue. Positions are resolved HERE,
// against the state the sim settled into at the end of the update that fired
// them — which is exactly where main.js read them when this was the shell's
// job, and what audio-corpus.jsonl therefore recorded.
void audioFlush() {
  AudioBus& b = bus();
  if (b.pending.empty()) return;
  std::vector<AudioBeat> beats;
  beats.swap(b.pending);

  RuntimeSession* rs = get(b.session);
  Game* eng = rs ? rs->eng : nullptr;
  if (!eng) return;  // the race is gone; so is anything it had left to say
  const au::AiIds ai = audioAiIds(*rs);

  // The listeners: every human car's world point. One set for the whole batch —
  // no time passes between the beats of one flush.
  std::vector<au::Point> pts;
  pts.reserve(eng->cars().size());
  for (const auto& c : eng->cars()) {
    if (!ai.has(c->id)) pts.push_back(audioPoint(c->pose.pos));
  }
  au::Listeners humans;
  humans.reserve(pts.size());
  for (const au::Point& p : pts) humans.push_back(&p);

  for (const AudioBeat& beat : beats) {
    if (beat.tick) { b.dec.countdown(beat.n, b.cmds); continue; }
    au::Point pos;
    bool hasPos = false;
    if (beat.ev.type == "rocket_expire") {
      pos = audioTrackPoint(eng, beat.ev.s, beat.ev.lat);
      hasPos = true;
    } else if (!beat.ev.id.isNull()) {
      for (const auto& c : eng->cars()) {
        if (c->id == beat.ev.id) { pos = audioPoint(c->pose.pos); hasPos = true; break; }
      }
    }
    b.dec.event(beat.ev, hasPos ? &pos : nullptr, humans, ai, b.nowMs, b.cmds);
  }
}

// ---- the cue vocabulary, as codes ----
// Index + 1 is the TTP_CUE_* value; the strings are the decision layer's own
// literals, so this table names cues rather than restating them.
const char* const AUDIO_CUES[] = {
  "pickup", "roulette", "banana_drop", "monster_inflate", "monster_deflate",
  "banana_slip", "rocket_hit", "screech", "lap", "join", "countdown",
  "boost", "corner", "brake", "engine_putt", "rocket_fire",
};
const int AUDIO_CUE_COUNT = (int) (sizeof(AUDIO_CUES) / sizeof(AUDIO_CUES[0]));
static_assert(AUDIO_CUE_COUNT == TTP_CUE_ROCKET_FIRE,
              "TTP_CUE_* must run 1..N over the table above");

int32_t audioCueCode(const char* name) {
  if (!name) return 0;
  for (int i = 0; i < AUDIO_CUE_COUNT; i++) {
    if (std::strcmp(name, AUDIO_CUES[i]) == 0) return (int32_t) (i + 1);
  }
  return 0;  // a cue this ABI has no code for: the shell drops it rather than
             // guessing, and the static_assert above is what keeps it empty
}

int32_t audioMusicOp(const char* name) {
  if (!name) return 0;
  if (std::strcmp(name, "start") == 0) return TTP_AUD_MUSIC_START;
  if (std::strcmp(name, "stop") == 0) return TTP_AUD_MUSIC_STOP;
  if (std::strcmp(name, "pause") == 0) return TTP_AUD_MUSIC_PAUSE;
  if (std::strcmp(name, "resume") == 0) return TTP_AUD_MUSIC_RESUME;
  return 0;
}

// A song's flat catalogue index: pools in table order, songs in pool order.
int32_t audioSongIndex(const au::Song* s) {
  int32_t n = 0;
  for (int i = 0; i < au::RACE_MUSIC_COUNT; i++) {
    const au::MusicPool& p = au::RACE_MUSIC[i];
    for (int j = 0; j < p.count; j++, n++) {
      if (&p.songs[j] == s) return n;
    }
  }
  return -1;
}

const au::Song* audioSongAt(int index) {
  int32_t n = 0;
  for (int i = 0; i < au::RACE_MUSIC_COUNT; i++) {
    const au::MusicPool& p = au::RACE_MUSIC[i];
    for (int j = 0; j < p.count; j++, n++) {
      if (n == index) return &p.songs[j];
    }
  }
  return nullptr;
}

}  // namespace

// The taps. Called from the session callbacks above, for EVERY session; only
// the bound one is heard, which is what keeps the lobby's attract race silent
// without the shell having to remember to mute it.
static void audio_tap_event(int handle, const Event& e) {
  AudioBus& b = bus();
  if (g_audioMute || !handle || handle != b.session) return;
  AudioBeat beat;
  beat.ev = e;
  b.pending.push_back(std::move(beat));
}

static void audio_tap_tick(int handle, int n) {
  AudioBus& b = bus();
  if (g_audioMute || !handle || handle != b.session) return;
  AudioBeat beat;
  beat.tick = true;
  beat.n = n;
  b.pending.push_back(std::move(beat));
}

static void audio_forget_session(int handle) {
  AudioBus& b = bus();
  if (b.session != handle) return;
  b.session = 0;
  b.pending.clear();
}

void ttp_audio_bind(int session) {
  AudioBus& b = bus();
  if (b.session == session) return;
  b.session = session;
  b.pending.clear();  // whatever the last race had left to say, it is over
}

void ttp_audio_frame(double nowMs) {
  AudioBus& b = bus();
  b.nowMs = nowMs;
  audioFlush();  // events first, then this frame's mix — the order they happened
  RuntimeSession* rs = get(b.session);
  if (!rs || !rs->eng) return;
  Game* eng = rs->eng;
  const au::AiIds ai = audioAiIds(*rs);

  // The snapshot's own derivations, taken off the live Car rather than out of a
  // serialized copy of it: `spd` is v/vmax, `steer` carries STEER_SIGN (the sim
  // turns the car by STEER_SIGN * steer, and the sign is what a snapshot
  // publishes), `monster` is the transform timer still running.
  std::vector<au::Car> cars;
  cars.reserve(eng->cars().size());
  for (const auto& cp : eng->cars()) {
    const Car& c = *cp;
    au::Car a;
    a.id = c.id;
    a.hasPos = true;
    a.pos = audioPoint(c.pose.pos);
    a.spd = c.v / c.vmax;
    a.steer = STEER_SIGN * c.steer;
    a.brake = c.brake;
    a.boostMul = c.boostMul;
    a.spin = c.spin;
    a.monster = c.monsterT > 0;
    a.onWall = c.onWall;
    cars.push_back(std::move(a));
  }

  std::vector<au::Rocket> rockets;
  rockets.reserve(eng->rockets().size());
  for (const RocketRt& r : eng->rockets()) {
    au::Rocket a;
    a.id = Id::Num((double) r.id);
    a.hasPos = true;
    // wrap_s first, exactly as the snapshot publishes a rocket's arclength: the
    // sampler wraps too, but the gains recorded in the corpus came off the
    // wrapped number and one ULP of `s` moves the jet's world point.
    a.pos = audioTrackPoint(eng, wrap_s(r.s, eng->length()), r.lat);
    rockets.push_back(std::move(a));
  }

  b.dec.frame(cars, rockets, ai, nowMs, b.cmds);
}

void ttp_audio_roster(int count, int inLobby) {
  AudioBus& b = bus();
  audioFlush();
  b.dec.roster(count, inLobby != 0, b.cmds);
}

void ttp_audio_stop_voices(void) {
  AudioBus& b = bus();
  audioFlush();
  b.dec.stopVoices(b.cmds);
}

void ttp_audio_stop_car(const char* idJson) {
  AudioBus& b = bus();
  audioFlush();
  b.dec.stopCar(parse_scalar_id(idJson), b.cmds);
}

void ttp_audio_music(int op, const char* biomeOrNull) {
  AudioBus& b = bus();
  audioFlush();
  switch (op) {
    case TTP_AUD_MUSIC_START:
      b.dec.startMusic(biomeOrNull ? std::string(biomeOrNull) : std::string(), b.cmds);
      break;
    case TTP_AUD_MUSIC_STOP: b.dec.stopMusic(b.cmds); break;
    case TTP_AUD_MUSIC_PAUSE: b.dec.pauseMusic(b.cmds); break;
    case TTP_AUD_MUSIC_RESUME: b.dec.resumeMusic(b.cmds); break;
    default: break;  // an op this build has no meaning for makes no sound
  }
}

const TtpAudioBlock* ttp_audio_drain(void) {
  AudioBus& b = bus();
  audioFlush();
  const size_t n = b.cmds.size();
  const size_t bytes = sizeof(TtpAudioBlock) + n * sizeof(TtpAudioCmd);
  if (b.block.size() < bytes) b.block.resize(bytes);
  auto* head = reinterpret_cast<TtpAudioBlock*>(b.block.data());
  head->version = TTP_AUDIO_BLOCK_VERSION;
  head->count = (uint32_t) n;
  head->stride = (uint32_t) sizeof(TtpAudioCmd);
  head->flags = 0;

  auto* out = const_cast<TtpAudioCmd*>(ttp_audio_cmds(head));
  std::memset(out, 0, n * sizeof(TtpAudioCmd));
  for (size_t i = 0; i < n; i++) {
    const au::Command& c = b.cmds[i];
    TtpAudioCmd& o = out[i];
    switch (c.kind) {
      case au::Command::CUE:
        o.kind = TTP_AUD_CUE;
        o.code = audioCueCode(c.name);
        o.level = c.gain;
        break;
      case au::Command::COUNTDOWN:
        o.kind = TTP_AUD_COUNTDOWN;
        o.code = TTP_CUE_COUNTDOWN;
        if (c.goBeat) o.flags |= TTP_AUD_F_GO;
        break;
      case au::Command::VOICE:
        o.kind = TTP_AUD_VOICE;
        o.code = audioCueCode(c.name);
        o.subject = audioSubject(c.id);
        o.level = c.level;
        if (c.mod) {
          o.flags |= TTP_AUD_F_MOD;
          o.rateMul = c.mod->rateMul;
          o.gainMul = c.mod->gainMul;
          o.lpMul = c.mod->lpMul;
        }
        break;
      case au::Command::VOICE_STOP:
        o.kind = TTP_AUD_VOICE_STOP;
        o.code = audioCueCode(c.name);
        o.subject = audioSubject(c.id);
        break;
      case au::Command::STOP_ALL:
        o.kind = TTP_AUD_STOP_ALL;
        // Every live voice dies on this command, on both sides, so no subject
        // minted before it can be referenced after it: the interning table is
        // free to start over instead of growing for the life of the party.
        b.subjects.clear();
        break;
      case au::Command::STOP_CAR:
        o.kind = TTP_AUD_STOP_CAR;
        o.subject = audioSubject(c.id);
        break;
      case au::Command::MUSIC:
        o.kind = TTP_AUD_MUSIC;
        o.code = audioMusicOp(c.name);
        o.level = c.level;
        if (c.song) o.subject = audioSongIndex(c.song);
        break;
    }
  }
  b.cmds.clear();
  return head;
}

const char* ttp_audio_cue_id(int code) {
  if (code < 1 || code > AUDIO_CUE_COUNT) return nullptr;
  return AUDIO_CUES[code - 1];
}

const char* ttp_audio_song_json(int index) {
  static std::string out;
  const au::Song* s = index < 0 ? nullptr : audioSongAt(index);
  if (!s) return NULL_JSON;
  Value o = Value::Obj();
  o.set("file", Value::Str(s->file));
  o.set("title", Value::Str(s->title));
  o.set("duration", Value::Num((double) s->duration));
  o.set("lufs", Value::Num(s->lufs));
  o.set("gain", Value::Num(s->gain));
  o.set("artist", Value::Str(s->artist));
  o.set("license", Value::Str(s->license));
  o.set("source", Value::Str(s->source));
  out = canonical_stringify(o);
  return out.c_str();
}

// ---------------------------------------------------------------------------
// ABI.
// ---------------------------------------------------------------------------
extern "C" {

int ttp_session_begin(const char* trackId, uint32_t seed, int laps, const char* forceItemOrNull) {
  ttp::clear_error();
  if (!trackId || !*trackId) {
    ttp::set_error("ttp_session_begin: no trackId");
    return 0;
  }
  auto rs = std::make_unique<RuntimeSession>();
  if (!buildTrack(*rs, trackId, laps, seed)) {
    // The two ways this fails read identically from outside, and a shell that
    // is told only "failed" cannot tell a typo from a bad lap count.
    ttp::set_error(std::string("ttp_session_begin: no track \"") + trackId
                   + "\" in this build (catalogue or dev), or laps=" + std::to_string(laps)
                   + " was refused");
    return 0;
  }
  rs->forceItem = forceItemOrNull ? forceItemOrNull : "";
  int h = g_next++;
  rs->handle = h;
  g_sessions[h] = std::move(rs);
  return h;
}

void ttp_add_human(int h, const char* idJson, const char* statsJsonOrNull) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started || rs->built) return;
  PlayerDesc p;
  p.id = parse_scalar_id(idJson);
  if (statsJsonOrNull) { p.hasStats = true; p.stats = parseStats(statsJsonOrNull); }
  rs->humans.push_back(p);
}

void ttp_add_bot(int h, const char* idJson, double caution, double laneBias,
                 uint32_t aiSeed, const char* statsJsonOrNull) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started || rs->built) return;
  BotEntry b;
  b.id = parse_scalar_id(idJson);
  b.caution = caution;
  b.laneBias = laneBias;
  b.aiSeed = aiSeed;
  if (statsJsonOrNull) { b.hasStats = true; b.stats = parseStats(statsJsonOrNull); }
  rs->bots.push_back(std::move(b));
}

// Build every bot's controller and, with them, the racing line they share. Both
// session modes need exactly this; written out twice, a persona knob could be
// dropped from one path with the other still covering it.
//
// The racing line is primed HERE rather than left to build on first use, because
// first use is the first frame a bot drives — the GO! beat, the exact frame the
// player first touches the throttle. Solving it costs 4.3-5.5 ms against a
// 0.013 ms steady frame, so it read as a stutter on the start line. It is pure
// precomputation over a centerline that cannot change, so every trace hashes
// identically either way.
static void buildBots(RuntimeSession& rs) {
  for (auto& b : rs.bots)
    b.ai = std::make_unique<AiController>(b.caution, LOOKAHEAD, STEER_GAIN, b.laneBias, b.aiSeed);
  if (!rs.bots.empty()) rs.eng->racingLine();
}

// Construct the RaceSession + bot controllers WITHOUT firing the countdown.
// Called from ttp_session_start, and LAZILY from any query on a begun-but-not-
// started handle: the JS RaceSession builds its Game in the constructor, so
// the display reads grid-pose snapshots BEFORE startCountdown — the ABI must
// answer those (main.js launchRace paints the grid, then starts the count).
static void buildSession(RuntimeSession* rs) {
  if (rs->built || rs->bare) return;
  rs->built = true;

  // Grid order: humans first, then bots, both in add order.
  std::vector<PlayerDesc> players = rs->humans;
  for (auto& b : rs->bots) players.push_back(PlayerDesc{b.id, b.hasStats, b.stats});

  RuntimeSession* self = rs;
  auto onEvent = [self](const Event& e) {
      self->outQueue.push_back(e.toValue());
      audio_tap_event(self->handle, e);
    };
  auto onTick = [self](int n) {
      Value c = Value::Obj();
      c.set("type", Value::Str("_countdown"));
      c.set("n", Value::Num((double)n));
      self->outQueue.push_back(std::move(c));
      audio_tap_tick(self->handle, n);
      if (n == 0) {  // GO beat: racing flips right after this tick (RaceSession.js)
        Value s = Value::Obj();
        s.set("type", Value::Str("_raceStart"));
        self->outQueue.push_back(std::move(s));
      }
    };
    auto onEnd = [self](const Value& r) {
      Value e = Value::Obj();
      e.set("type", Value::Str("_raceEnd"));
      e.set("results", r);  // the getResults() object the adapter hands to onRaceEnd
      self->outQueue.push_back(std::move(e));
    };
  rs->session = std::make_unique<RaceSession>(players, rs->track, onEvent, onEnd, onTick,
                                              rs->forceItem);
  rs->eng = &rs->session->engine();

  buildBots(*rs);  // the field (and its cars) exist now
}

void ttp_session_start(int h, int countdownSeconds) {
  RuntimeSession* rs = get(h);
  if (!rs || rs->started) return;

  if (countdownSeconds < 0) {
    // Bare-Game mode (conformance replay): racing from frame 0, no countdown/
    // session beats. Incompatible with a lazily built session.
    if (rs->built) return;
    rs->started = true;
    rs->bare = true;
    rs->racingBare = true;
    std::vector<PlayerDesc> players = rs->humans;
    for (auto& b : rs->bots) players.push_back(PlayerDesc{b.id, b.hasStats, b.stats});
    RuntimeSession* self = rs;
    auto onEvent = [self](const Event& e) {
      self->outQueue.push_back(e.toValue());
      audio_tap_event(self->handle, e);
    };
    rs->game = std::make_unique<Game>(players, rs->track, onEvent, rs->forceItem);
    rs->eng = rs->game.get();
    buildBots(*rs);
    return;
  }

  buildSession(rs);
  rs->started = true;
  rs->session->startCountdown(countdownSeconds);
}

void ttp_update(int h, double dtMs) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->started) return;
  if (rs->bare) {
    if (rs->pausedBare) return;
    if (rs->racingBare) {
      rs->driveBots();
      rs->eng->update(dtMs);
    }
  } else {
    if (rs->session->paused()) return;
    if (rs->session->racing()) rs->driveBots();  // drive-then-update, only while racing
    rs->session->update(dtMs);
  }
}

void ttp_process_input(int h, const char* idJson, int mask, double s, double b, double u) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return;
  Input in;
  if (mask & 1) { in.hasS = true; in.s = s; }
  if (mask & 2) { in.hasB = true; in.b = b; }
  if (mask & 4) { in.hasU = true; in.u = u; }
  rs->eng->processInput(parse_scalar_id(idJson), in);
}

const char* ttp_snapshot_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  canonical_stringify_into(rs->eng->getSnapshot(), rs->scratch);
  return rs->scratch.c_str();
}

const char* ttp_results_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return NULL_JSON;
  if (!rs->eng) buildSession(rs);
  if (!rs->eng) return NULL_JSON;
  canonical_stringify_into(rs->eng->getResults(), rs->scratch);
  return rs->scratch.c_str();
}

const char* ttp_events_json(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (auto& e : rs->outQueue) arr.push(std::move(e));
  rs->outQueue.clear();
  canonical_stringify_into(arr, rs->scratch);
  return rs->scratch.c_str();
}

int ttp_has_car(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  return rs && rs->eng && rs->eng->hasCar(parse_scalar_id(idJson)) ? 1 : 0;
}

int ttp_car_finished(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return -1;
  bool out = false;
  if (!rs->eng->carFinished(parse_scalar_id(idJson), out)) return -1;
  return out ? 1 : 0;
}

const char* ttp_car_ids_json(int h) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng) return EMPTY_ARR;
  Value arr = Value::Arr();
  for (const auto& c : rs->eng->cars()) arr.push(c->id.toValue());
  canonical_stringify_into(arr, rs->scratch);
  return rs->scratch.c_str();
}

int ttp_car_world_pos(int h, const char* idJson, double* out3) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng || !out3) return 0;
  Id id = parse_scalar_id(idJson);
  for (const auto& c : rs->eng->cars()) {
    if (c->id == id) {
      out3[0] = c->pose.pos.x;
      out3[1] = c->pose.pos.y;
      out3[2] = c->pose.pos.z;
      return 1;
    }
  }
  return 0;
}

int ttp_track_point(int h, double s, double lat, double* out3) {
  RuntimeSession* rs = get(h);
  if (rs && !rs->eng) buildSession(rs);
  if (!rs || !rs->eng || !out3) return 0;
  Frame f = rs->eng->centerline()->sampleAt(s);  // fresh frame
  f.pos.addScaledVector(f.lateral, lat);
  out3[0] = f.pos.x;
  out3[1] = f.pos.y;
  out3[2] = f.pos.z;
  return 1;
}

int ttp_force_remove_car(int h, const char* idJson) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return 0;
  Id id = parse_scalar_id(idJson);
  if (rs->session) return rs->session->forceRemoveCar(id) ? 1 : 0;
  return rs->eng->removeCar(id) ? 1 : 0;
}

int ttp_rekey_car(int h, const char* oldJson, const char* newJson) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return 0;
  return rs->eng->rekeyCar(parse_scalar_id(oldJson), parse_scalar_id(newJson)) ? 1 : 0;
}

void ttp_force_finish(int h, const char* idJson, double time) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return;
  rs->eng->forceFinish(parse_scalar_id(idJson), true, time);
}

void ttp_fast_forward(int h) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->eng) return;
  AudioMute silent;
  if (rs->session) {
    RuntimeSession* self = rs;
    rs->session->fastForwardToEnd([self]() { self->driveBots(); });
  } else if (rs->racingBare && !rs->pausedBare) {
    long guard = 0;
    while (!rs->eng->raceOver() && guard++ < 100000) {
      rs->driveBots();
      rs->eng->update(1000.0 / 30.0);
    }
  }
}

void ttp_pause(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (rs->session) rs->session->pause();
  else rs->pausedBare = true;
}

void ttp_resume(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return;
  if (rs->session) rs->session->resume();
  else rs->pausedBare = false;
}

int ttp_racing(int h) {
  RuntimeSession* rs = get(h);
  if (!rs || !rs->started) return 0;
  if (rs->session) return rs->session->racing() ? 1 : 0;
  return rs->racingBare ? 1 : 0;
}

int ttp_paused(int h) {
  RuntimeSession* rs = get(h);
  if (!rs) return 0;
  if (rs->session) return rs->session->paused() ? 1 : 0;
  return rs->pausedBare ? 1 : 0;
}

void ttp_dispose(int h) {
  auto it = g_sessions.find(h);
  if (it == g_sessions.end()) return;
  if (it->second->session) it->second->session->dispose();
  g_sessions.erase(it);
  audio_forget_session(h);  // a disposed race is not one the audio can still read
}

void ttp_set_steer_expo(double v) { setSteerExpo(v); }
double ttp_get_steer_expo(void) { return getSteerExpo(); }


// =============================================================================
// Grand Prix / cup series.
// =============================================================================
namespace {
struct GpHandle {
  // The host's offered draw for this apply_race; CupSeries pulls it through the
  // drawNext callback only if the rules call for a draw.
  std::string pendingDraw;
  bool endless = false;
  std::unique_ptr<CupSeries> series;
  std::string scratch;
};
std::map<int, std::unique_ptr<GpHandle>> g_gps;
int g_nextGp = 1;
static GpHandle* gp(int h) {
  auto it = g_gps.find(h);
  return it == g_gps.end() ? nullptr : it->second.get();
}
static Id gpIdFrom(const Value& v) {
  if (v.type == Value::NUM) return Id::Num(v.num);
  if (v.type == Value::STR) return Id::Str(v.str);
  return Id::None();
}

}  // namespace

int ttp_gp_create(const char* cupJson, int endless) {
  ttp::clear_error();
  bool ok = false;
  Value c = cupJson && *cupJson ? json::parse(cupJson, &ok) : Value::Null();
  if (!ok || c.type != Value::OBJ) {
    ttp::set_error("ttp_gp_create: expected a cup object {id, name, tracks:[…]}, got "
                   + ttp::error_excerpt(cupJson));
    return 0;
  }
  GpCup cup;
  if (const Value* x = c.find("id")) cup.id = x->str;
  if (const Value* x = c.find("name")) cup.name = x->str;
  if (const Value* x = c.find("tracks")) {
    if (x->type != Value::ARR) {
      ttp::set_error("ttp_gp_create: `tracks` must be an array of track ids");
      return 0;
    }
    for (const Value& t : x->arr) cup.tracks.push_back(t.str);
  }
  // Both spellings of "no races" land here: an absent `tracks` and an empty one.
  if (cup.tracks.empty()) {
    ttp::set_error("ttp_gp_create: a cup needs at least one track; `tracks` was "
                   + std::string(c.find("tracks") ? "empty" : "absent"));
    return 0;
  }

  auto gh = std::make_unique<GpHandle>();
  GpHandle* raw = gh.get();
  raw->endless = endless != 0;
  if (raw->endless) {
    gh->series = std::make_unique<CupSeries>(cup, [raw]() { return raw->pendingDraw; });
  } else {
    gh->series = std::make_unique<CupSeries>(cup);
  }
  const int h = g_nextGp++;
  g_gps[h] = std::move(gh);
  return h;
}

void ttp_gp_dispose(int h) { g_gps.erase(h); }

int ttp_gp_endless(int h) { GpHandle* g = gp(h); return (g && g->series->endless()) ? 1 : 0; }
int ttp_gp_race_count(int h) { GpHandle* g = gp(h); return g ? g->series->raceCount() : 0; }
int ttp_gp_race_index(int h) { GpHandle* g = gp(h); return g ? g->series->raceIndex() : 0; }
int ttp_gp_finished(int h) { GpHandle* g = gp(h); return (g && g->series->finished()) ? 1 : 0; }

const char* ttp_gp_current_track(int h) {
  GpHandle* g = gp(h);
  if (!g) return "";
  g->scratch = g->series->currentTrackId();
  return g->scratch.c_str();
}

const char* ttp_gp_next_track(int h) {
  GpHandle* g = gp(h);
  if (!g) return "";
  g->scratch = g->series->nextTrackId();   // "" == JS null
  return g->scratch.c_str();
}

const char* ttp_gp_cup_json(int h) {
  GpHandle* g = gp(h);
  if (!g) return "null";
  const GpCup& c = g->series->cup();
  Value o = Value::Obj();
  o.set("id", Value::Str(c.id));
  o.set("name", Value::Str(c.name));
  Value tr = Value::Arr();
  for (const std::string& t : c.tracks) tr.push(Value::Str(t));
  o.set("tracks", std::move(tr));
  canonical_stringify_into(o, g->scratch);
  return g->scratch.c_str();
}

void ttp_gp_apply_race(int h, const char* resultsJson, const char* fieldJson,
                       const char* drawnTrackIdOrNull) {
  GpHandle* g = gp(h);
  if (!g) return;
  g->pendingDraw = drawnTrackIdOrNull ? drawnTrackIdOrNull : "";

  std::vector<GpResult> results;
  bool ok = false;
  Value r = resultsJson && *resultsJson ? json::parse(resultsJson, &ok) : Value::Null();
  if (ok && r.type == Value::ARR) {
    for (const Value& e : r.arr) {
      GpResult gr{Id::None(), 0, false};
      if (const Value* x = e.find("playerId")) gr.playerId = gpIdFrom(*x);
      if (const Value* x = e.find("rank")) gr.rank = (int)x->num;
      if (const Value* x = e.find("finished")) gr.finished = x->b;
      results.push_back(gr);
    }
  }

  std::vector<GpFieldEntry> field;
  ok = false;
  Value f = fieldJson && *fieldJson ? json::parse(fieldJson, &ok) : Value::Null();
  if (ok && f.type == Value::ARR) {
    for (const Value& e : f.arr) {
      GpFieldEntry fe{Id::None(), "", 0, false};
      if (const Value* x = e.find("peerIndex")) fe.peerIndex = gpIdFrom(*x);
      if (const Value* x = e.find("name")) fe.name = x->str;
      if (const Value* x = e.find("colorIndex")) fe.colorIndex = (int)x->num;
      if (const Value* x = e.find("ai")) fe.ai = x->b;
      field.push_back(fe);
    }
  }
  g->series->applyRace(results, field);
}

void ttp_gp_advance(int h) { GpHandle* g = gp(h); if (g) g->series->advance(); }

const char* ttp_gp_standings_json(int h) {
  GpHandle* g = gp(h);
  if (!g) return "[]";
  Value arr = Value::Arr();
  for (const GpStanding& st : g->series->standings()) {
    Value o = Value::Obj();
    o.set("playerId", st.playerId.toValue());
    // An unseated row's name/colorIndex are JS undefined, i.e. ABSENT keys —
    // Value's default UNDEF is dropped by canonical_stringify, so leaving them
    // unset is exactly what the JS twin serialized.
    if (!st.seatNull) {
      o.set("name", Value::Str(st.name));
      o.set("colorIndex", Value::Num(st.colorIndex));
    }
    o.set("ai", Value::Bool(st.ai));
    o.set("points", Value::Num(st.points));
    o.set("gained", Value::Num(st.gained));
    o.set("lastRank", st.lastRankNull ? Value::Null() : Value::Num(st.lastRank));
    arr.push(std::move(o));
  }
  canonical_stringify_into(arr, g->scratch);
  return g->scratch.c_str();
}

void ttp_gp_rekey(int h, const char* oldIdJson, const char* newIdJson) {
  GpHandle* g = gp(h);
  if (!g) return;
  bool ok1 = false, ok2 = false;
  Value a = json::parse(oldIdJson, &ok1), b = json::parse(newIdJson, &ok2);
  if (!ok1 || !ok2) return;
  g->series->rekey(gpIdFrom(a), gpIdFrom(b));
}

const char* ttp_track_json(const char* trackId, int laps, uint32_t seed) {
  static std::string out;
  if (!trackId) return nullptr;
  const TrackDef* def = find_track_def(trackId);
  if (!def) return nullptr;
  const RaceTrack rt = build_race_track(*def, laps, seed);
  const rtjson::Writer w(rtjson::decimal_number);
  out = w.object(rt);
  return out.c_str();
}

const char* ttp_track_build_json(const char* descriptorJson, int laps, uint32_t seed) {
  static std::string out;
  if (!descriptorJson) return nullptr;
  bool ok = false;
  const Value desc = json::parse(descriptorJson, &ok);
  if (!ok || desc.type != Value::OBJ) return nullptr;

  // The arrays TrackDef points into must outlive build_race_track, so they live
  // here for the length of the call.
  ParsedTrackDef parsed;
  if (!parse_track_def(desc, parsed)) return nullptr;

  const RaceTrack rt = build_race_track(parsed.def, laps, seed);
  const rtjson::Writer w(rtjson::decimal_number);
  out = w.object(rt);
  return out.c_str();
}

// The built track's samples as a Centerline, for the interpolating queries.
static Centerline centerline_of(const RaceTrack& rt) {
  std::vector<Sample> cs;
  cs.reserve(rt.samples.size());
  for (const OutSample& s : rt.samples) {
    Sample c;
    c.pos = s.pos; c.tangent = s.tangent; c.up = s.up; c.lateral = s.lateral;
    c.width = s.width; c.s = s.s;
    cs.push_back(c);
  }
  return Centerline(std::move(cs), rt.length);
}

// Resolve an "id or descriptor" argument into a built track and its Centerline,
// MEMOIZED on the argument string. A leading '{' is the only thing that
// distinguishes the two, and no track id can start with one.
//
// The memo is one entry deep, and it is load-bearing for the three audit entry
// points below rather than a micro-optimization: every one of them is called in
// a loop that asks about the SAME track over and over. The helicoid check in
// tests/track.test.js samples four shipped tracks every frame of a 3000-frame
// race, so rebuilding per call was 15.4 s of an 18.5 s `npm test` — against
// 0.15 s of actual simulation. scripts/track-gen.mjs has the same shape,
// asking one candidate for a sweep and then a frame list in a row. One
// entry is the right depth: the hot pattern is a run of calls about one track,
// and a seed scan walking thousands of DISTINCT descriptors would only thrash a
// bigger cache (the same reasoning as scripts/native-track.mjs's MEMO_MAX).
//
// Safe to share because every caller below is READ-ONLY over both, and
// Centerline's only mutable state is the scratch buffers it overwrites per
// query (centerline.h) — a reused one returns bit-identical frames. None of
// this is on the game's path: the sim builds its own track in ttp_session_begin.
namespace {
struct TrackCache {
  RaceTrack rt;
  std::unique_ptr<Centerline> cl;
};
}  // namespace

static const TrackCache* track_by_id_or_descriptor(const char* arg) {
  if (!arg) return nullptr;
  static std::string key;
  static TrackCache cache;
  static bool valid = false;
  if (valid && key == arg) return &cache;

  // Dropped BEFORE the build, so a refused descriptor cannot leave the previous
  // track answerable under the new key.
  valid = false;
  RaceTrack rt;
  if (arg[0] == '{') {
    bool ok = false;
    const Value desc = json::parse(arg, &ok);
    if (!ok || desc.type != Value::OBJ) return nullptr;
    ParsedTrackDef parsed;
    if (!parse_track_def(desc, parsed)) return nullptr;
    rt = build_race_track(parsed.def, 3, 1u);
  } else {
    const TrackDef* def = find_track_def(arg);
    if (!def) return nullptr;
    rt = build_race_track(*def, 3, 1u);
  }
  cache.rt = std::move(rt);
  cache.cl = std::make_unique<Centerline>(centerline_of(cache.rt));
  key = arg;
  valid = true;
  return &cache;
}

// One interpolated frame, as the shape the tools read.
static Value frameValue(Centerline& cl, double s);

static Value vec3Value(const Vec3& v) {
  Value o = Value::Obj();
  o.set("x", Value::Num(v.x));
  o.set("y", Value::Num(v.y));
  o.set("z", Value::Num(v.z));
  return o;
}

static Value frameValue(Centerline& cl, double s) {
  const Frame f = cl.sampleAt(s);
  Value o = Value::Obj();
  o.set("s", Value::Num(s));
  o.set("pos", vec3Value(f.pos));
  o.set("tangent", vec3Value(f.tangent));
  o.set("up", vec3Value(f.up));
  o.set("lateral", vec3Value(f.lateral));
  o.set("width", Value::Num(f.width));
  return o;
}

const char* ttp_track_supports_json(const char* trackIdOrDescriptor) {
  static std::string out;
  const TrackCache* cached = track_by_id_or_descriptor(trackIdOrDescriptor);
  if (!cached) return nullptr;
  const RaceTrack& rt = cached->rt;

  // The audit treats a bridge pillar and a loop shaft alike; they differ only in
  // where their top sits (a shaft is cut to the deck underside it holds up).
  struct Probe { Post post; const char* kind; };
  std::vector<Probe> probes;
  probes.reserve(rt.pillars.size() + rt.supportPosts.size());
  for (const Pillar& p : rt.pillars)
    probes.push_back({ Post{ p.x, p.z, p.radius, p.baseY, p.topY }, "pillar" });
  for (const SupportPost& p : rt.supportPosts)
    probes.push_back({ Post{ p.x, p.z, p.radius, p.baseY, p.contactPos.y }, "shaft" });

  Value posts = Value::Arr();
  for (const Probe& pr : probes) {
    double worst = 0, at = 0;
    bool any = false;
    for (const OutSample& sm : rt.samples) {
      const PostHit hit = post_at_sample(sm, pr.post);
      if (!hit.valid) continue;
      if (!any || hit.intrusion > worst) { worst = hit.intrusion; at = sm.s; any = true; }
    }
    Value o = Value::Obj();
    o.set("kind", Value::Str(pr.kind));
    o.set("x", Value::Num(pr.post.x));
    o.set("z", Value::Num(pr.post.z));
    o.set("radius", Value::Num(pr.post.radius));
    // No sample ever had a say: the post is nowhere near a corridor. Report it as
    // fully clear rather than as a zero-depth graze.
    o.set("intrusion", Value::Num(any ? worst : -1.0));
    o.set("s", Value::Num(any ? at : 0.0));
    posts.push(std::move(o));
  }

  // Each ghost pole's (s, lat) put back into world space through the builder's
  // own centreline sampler, so the audit can ask whether a real post stands there.
  Centerline& cl = *cached->cl;
  Value autoPoles = Value::Arr();
  for (const AutoPole& ap : rt.autoPoles) {
    const Frame f = cl.sampleAt(ap.s);
    Value o = Value::Obj();
    o.set("s", Value::Num(ap.s));
    o.set("lat", Value::Num(ap.lat));
    o.set("radius", Value::Num(ap.radius));
    o.set("x", Value::Num(f.pos.x + f.lateral.x * ap.lat));
    o.set("z", Value::Num(f.pos.z + f.lateral.z * ap.lat));
    autoPoles.push(std::move(o));
  }

  Value root = Value::Obj();
  root.set("posts", std::move(posts));
  root.set("autoPoles", std::move(autoPoles));
  out = canonical_stringify(root);
  return out.c_str();
}

const char* ttp_track_sweep_json(const char* trackIdOrDescriptor, double step) {
  static std::string out;
  if (!(step > 0)) return nullptr;
  const TrackCache* cached = track_by_id_or_descriptor(trackIdOrDescriptor);
  if (!cached) return nullptr;
  const RaceTrack& rt = cached->rt;

  Centerline& cl = *cached->cl;
  Value arr = Value::Arr();
  // `s <= length` inclusive, matching the JS callers' `for (s = 0; s <= L; s += step)`
  // — the last frame lands on the lap line, which wraps to the first.
  for (double s = 0; s <= rt.length; s += step) arr.push(frameValue(cl, s));
  out = canonical_stringify(arr);
  return out.c_str();
}

const char* ttp_track_frames_json(const char* trackIdOrDescriptor, const char* sListJson) {
  static std::string out;
  if (!sListJson) return nullptr;
  bool ok = false;
  const Value list = json::parse(sListJson, &ok);
  if (!ok || list.type != Value::ARR) return nullptr;
  for (const Value& v : list.arr) if (v.type != Value::NUM) return nullptr;

  const TrackCache* cached = track_by_id_or_descriptor(trackIdOrDescriptor);
  if (!cached) return nullptr;
  Centerline& cl = *cached->cl;
  Value arr = Value::Arr();
  for (const Value& v : list.arr) arr.push(frameValue(cl, v.num));
  out = canonical_stringify(arr);
  return out.c_str();
}

// ---- the top-down schematic + its snapshot codec ----------------------------
// Marshalling only; every rule is in libttp-track/ttp/schematic.h, where
// tracktest/schematic_check.cc gates it against the JS-recorded corpus.
// Fills rather than returns: this block is inside extern "C", where a function
// returning a C++ type earns -Wreturn-type-c-linkage even with internal linkage.
namespace {
void schematicInto(const ttp::schematic::Schematic& s, Value& o) {
  o = Value::Obj();
  o.set("viewBox", Value::Str(s.viewBox));
  o.set("d", Value::Str(s.d));
  if (s.hasStart) {
    Value st = Value::Obj();
    st.set("x", Value::Num(s.start.x));
    st.set("y", Value::Num(s.start.y));
    o.set("start", std::move(st));
  } else {
    o.set("start", Value::Null());
  }
  // Absent, not zeroed, for a sample-less track — see the header.
  if (s.hasProj) {
    Value p = Value::Obj();
    p.set("minX", Value::Num(s.proj.minX));
    p.set("minZ", Value::Num(s.proj.minZ));
    p.set("scale", Value::Num(s.proj.scale));
    p.set("offX", Value::Num(s.proj.offX));
    p.set("offZ", Value::Num(s.proj.offZ));
    o.set("proj", std::move(p));
  }
}
}  // namespace

const char* ttp_track_schematic_json(const char* trackId, int laps, uint32_t seed) {
  static std::string out;
  if (!trackId) return nullptr;
  const TrackDef* def = find_track_def(trackId);
  if (!def) return nullptr;
  const RaceTrack rt = build_race_track(*def, laps, seed);
  Value v;
  schematicInto(ttp::schematic::build(rt), v);
  out = canonical_stringify(v);
  return out.c_str();
}

const char* ttp_schematic_pack(const char* pathD, double eps) {
  static std::string out;
  out = ttp::schematic::pack(pathD ? pathD : "",
                             eps > 0 ? eps : ttp::schematic::EPS);
  return out.c_str();
}

int ttp_schematic_view_size(void) { return ttp::schematic::VIEW; }

const char* ttp_schematic_points_json(const char* pathD) {
  static std::string out;
  Value v = Value::Arr();
  for (const ttp::schematic::Point& p : ttp::schematic::points_of(pathD ? pathD : "")) {
    Value pair = Value::Arr();
    pair.push(Value::Num(p.x));
    pair.push(Value::Num(p.y));
    v.push(std::move(pair));
  }
  out = canonical_stringify(v);
  return out.c_str();
}

const char* ttp_schematic_unpack_json(const char* b64) {
  static std::string out;
  Value v;
  schematicInto(ttp::schematic::unpack(b64 ? b64 : ""), v);
  out = canonical_stringify(v);
  return out.c_str();
}

const char* ttp_item_id(int code) {
  // 1-based so TTP_ITEM_NONE can be 0 without a sentinel that looks like an
  // item; ttp::ITEM_IDS is the sim's own roll table, not a second list.
  if (code < 1 || code > 4) return nullptr;
  return ttp::ITEM_IDS[code - 1];
}

const char* ttp_version(void) {
  static std::string v;
  if (v.empty()) {
    Value o = Value::Obj();
    o.set("contractVersion", Value::Num((double)CONTRACT_VERSION));
    o.set("mathlib", Value::Str(MATHLIB));
    v = canonical_stringify(o);
  }
  return v.c_str();
}

}  // extern "C"
