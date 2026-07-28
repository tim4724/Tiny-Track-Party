// audio_check — the C++ audio decisions against the JS they were ported from
// (tests/fixtures/audio-corpus.jsonl, recorded by scripts/gen-audio-corpus.mjs
// off public/display/audio/decide.js).
//
// WHAT THIS IS. JS-RECORDED cross-implementation evidence — class 1 in
// tests/fixtures/traces/README.md, the only class that can settle a parity
// question. Every command in it is one the shipping browser game played a sound
// from. Nothing here may be "fixed" by re-recording: a disagreement is a bug in
// libttp-runtime/ttp/audio.cc, never in the corpus.
//
// TWO KINDS OF CASE, and they need different machinery.
//
// 1. SCRIPTED steps (497 over 7 scenarios) are fully self-describing — each line
//    carries its own input — so they replay straight out of the corpus with no
//    sim at all. They are what reaches the knees of the distance curve, the whole
//    event table, the scrub arbitration under contention, the voice start/stop
//    edges, the rocket jet lifecycle and the seeded music shuffle.
//
// 2. TRACE frames (5900 over 5 golden traces) record ONLY the commands. The
//    world they were decided from is not in the corpus, so this check REBUILDS
//    it: each trace is re-raced here through libttp-sim exactly as the generator
//    raced it through the shipped wasm's C ABI (every roster entry added as a
//    HUMAN, the recorded inputs fed back, the same dt stream), and every frame's
//    events and snapshot HASH are checked against the trace before a single
//    audio command is decided. That check is not decoration: a corpus replayed
//    against a world that drifted proves nothing, so the frame is only compared
//    once the sim has re-derived the recorded race bit-for-bit.
//
// Each trace is then decided under several AI/HUMAN splits ('none' / 'first' /
// 'firstTwo'), because the sim does not care which cars are human but the audio
// does: the human cars are the listeners AND the only voiced cars.
//
// Usage: audio_check <audio-corpus.jsonl> <traces-dir>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "corpus_diff.h"
#include "ttp/audio.h"
#include "ttp/canonical.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/race_session.h"
#include "ttp/race_track.h"
#include "ttp/util.h"

using namespace ttp;
using namespace ttp::corpus;
namespace au = ttp::rt::audio;

namespace {

const char* const MATHLIB = "fdlibm-openlibm-0.8.7";

int cases = 0, passed = 0, spew = 0;

void report(const std::string& what, const Diff& d) {
  cases++;
  if (!d.differ) { passed++; return; }
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s\n  path %s\n  expected %s\n  actual   %s\n",
                 what.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
  }
}

// ---------------------------------------------------------------------------
// The command stream, as the corpus spells it.
// ---------------------------------------------------------------------------

Value songValue(const au::Song& s) {
  Value o = Value::Obj();
  o.set("file", Value::Str(s.file));
  o.set("title", Value::Str(s.title));
  o.set("duration", Value::Num((double) s.duration));
  o.set("lufs", Value::Num(s.lufs));
  o.set("gain", Value::Num(s.gain));
  o.set("artist", Value::Str(s.artist));
  o.set("license", Value::Str(s.license));
  o.set("source", Value::Str(s.source));
  return o;
}

Value cmdValue(const au::Command& c) {
  Value o = Value::Obj();
  switch (c.kind) {
    case au::Command::CUE:
      o.set("cue", Value::Str(c.name));
      o.set("gain", Value::Num(c.gain));
      break;
    case au::Command::COUNTDOWN:
      o.set("cue", Value::Str("countdown"));
      o.set("part", Value::Str(c.goBeat ? "go" : "tick"));
      break;
    case au::Command::VOICE: {
      o.set("voice", Value::Str(c.name));
      o.set("id", c.id.toValue());
      o.set("level", Value::Num(c.level));
      if (c.mod) {
        Value m = Value::Obj();
        m.set("rateMul", Value::Num(c.mod->rateMul));
        m.set("gainMul", Value::Num(c.mod->gainMul));
        m.set("lpMul", Value::Num(c.mod->lpMul));
        o.set("mod", std::move(m));
      }
      break;
    }
    case au::Command::VOICE_STOP:
      o.set("voice", Value::Str(c.name));
      o.set("id", c.id.toValue());
      o.set("stop", Value::Bool(true));
      break;
    case au::Command::STOP_ALL:
      o.set("voices", Value::Str("stop-all"));
      break;
    case au::Command::STOP_CAR:
      o.set("voices", Value::Str("stop-car"));
      o.set("id", c.id.toValue());
      break;
    case au::Command::MUSIC:
      o.set("music", Value::Str(c.name));
      if (c.song) {
        o.set("song", songValue(*c.song));
        o.set("level", Value::Num(c.level));
      }
      break;
  }
  return o;
}

Value cmdsValue(const std::vector<au::Command>& cmds) {
  Value a = Value::Arr();
  for (const au::Command& c : cmds) a.push(cmdValue(c));
  return a;
}

// ---------------------------------------------------------------------------
// Corpus -> plain data.
// ---------------------------------------------------------------------------

Id idFrom(const Value* v) {
  if (!v) return Id::None();
  if (v->type == Value::STR) return Id::Str(v->str);
  if (v->type == Value::NUM) return Id::Num(v->num);
  return Id::None();
}

double numOr(const Value& o, const char* key, double dflt) {
  const Value* v = o.find(key);
  return (v && v->type == Value::NUM) ? v->num : dflt;
}

bool boolOf(const Value& o, const char* key) {
  const Value* v = o.find(key);
  return v && v->type == Value::BOOL && v->b;
}

au::Point pointOf(const Value& v) {
  au::Point p;
  p.x = numOr(v, "x", 0);
  p.y = numOr(v, "y", 0);
  p.z = numOr(v, "z", 0);
  return p;
}

au::AiIds aiIdsOf(const Value* arr) {
  au::AiIds s;
  if (arr && arr->type == Value::ARR) for (const Value& v : arr->arr) s.add(idFrom(&v));
  return s;
}

// A recorded car for frame(). The scripted cases and the trace snapshots use the
// SAME field names, because both are snapshot cars.
au::Car carOf(const Value& v) {
  au::Car c;
  c.id = idFrom(v.find("id"));
  const Value* pose = v.find("pose");
  const Value* pos = pose ? pose->find("pos") : nullptr;
  if (pos && pos->type == Value::OBJ) { c.hasPos = true; c.pos = pointOf(*pos); }
  c.spd = numOr(v, "spd", 0);
  c.steer = numOr(v, "steer", 0);
  c.brake = numOr(v, "brake", 0);
  c.boostMul = numOr(v, "boostMul", 1);
  c.spin = numOr(v, "spin", 0);
  c.monster = boolOf(v, "monster");
  c.onWall = boolOf(v, "onWall");
  return c;
}

// The sim's own Event, from a recorded one. Only the five fields the decisions
// read are filled — this is not a general Event parser.
ttp::Event eventOf(const Value& v) {
  ttp::Event e;
  if (const Value* t = v.find("type")) if (t->type == Value::STR) e.type = t->str;
  e.id = idFrom(v.find("id"));
  if (const Value* c = v.find("cause")) if (c->type == Value::STR) e.cause = c->str;
  if (const Value* i = v.find("item")) if (i->type == Value::STR) e.item = i->str;
  e.finished = boolOf(v, "finished");
  return e;
}

// ---------------------------------------------------------------------------
// Scripted scenarios.
// ---------------------------------------------------------------------------

// The rng a seedless scenario gets: the generator installed one that THROWS, so
// a port that started drawing randomness where the JS did not would go unnoticed
// without this. `drew` is asserted after every seedless scenario.
struct ScenarioState {
  std::unique_ptr<au::Decider> dec;
  std::string name;
  bool seeded = false;
  bool drew = false;
  std::unique_ptr<Mulberry32> rng;
};

void applyStep(ScenarioState& st, const std::string& kind, const Value* in,
               std::vector<au::Command>& out) {
  Value none = Value::Obj();
  const Value& i = (in && in->type == Value::OBJ) ? *in : none;
  if (kind == "frame") {
    std::vector<au::Car> cars;
    if (const Value* cv = i.find("cars")) for (const Value& c : cv->arr) cars.push_back(carOf(c));
    std::vector<au::Rocket> rockets;
    if (const Value* rv = i.find("rockets")) {
      for (const Value& r : rv->arr) {
        au::Rocket rk;
        rk.id = idFrom(r.find("id"));
        const Value* p = r.find("pos");
        if (p && p->type == Value::OBJ) { rk.hasPos = true; rk.pos = pointOf(*p); }
        rockets.push_back(rk);
      }
    }
    st.dec->frame(cars, rockets, aiIdsOf(i.find("aiIds")), numOr(i, "nowMs", 0), out);
    return;
  }
  if (kind == "event") {
    const Value* ev = i.find("e");
    const Value* ctx = i.find("ctx");
    Value empty = Value::Obj();
    const Value& c = ctx ? *ctx : empty;
    // The listeners' storage must outlive the call, and must not reallocate
    // while the Listeners point into it.
    std::vector<au::Point> store;
    au::Listeners humans;
    if (const Value* hp = c.find("humanPositions")) {
      store.reserve(hp->arr.size());
      for (const Value& p : hp->arr) store.push_back(pointOf(p));
      for (const au::Point& p : store) humans.push_back(&p);
    }
    const Value* pv = c.find("pos");
    au::Point pos;
    const bool hasPos = pv && pv->type == Value::OBJ;
    if (hasPos) pos = pointOf(*pv);
    st.dec->event(eventOf(ev ? *ev : empty), hasPos ? &pos : nullptr, humans,
                  aiIdsOf(c.find("aiIds")), numOr(c, "nowMs", 0), out);
    return;
  }
  if (kind == "countdown") { st.dec->countdown((int) numOr(i, "n", 0), out); return; }
  if (kind == "roster") {
    st.dec->roster((int) numOr(i, "count", 0), boolOf(i, "inLobby"), out);
    return;
  }
  if (kind == "stopVoices") { st.dec->stopVoices(out); return; }
  if (kind == "stopCar") { st.dec->stopCar(idFrom(i.find("id")), out); return; }
  if (kind == "music") {
    const Value* op = i.find("op");
    const std::string o = (op && op->type == Value::STR) ? op->str : "";
    if (o == "start") {
      const Value* b = i.find("biome");
      // A null / absent biome is not a pool name, and takes the fallback — the
      // corpus records both spellings.
      st.dec->startMusic((b && b->type == Value::STR) ? b->str : std::string(), out);
    } else if (o == "stop") st.dec->stopMusic(out);
    else if (o == "pause") st.dec->pauseMusic(out);
    else if (o == "resume") st.dec->resumeMusic(out);
    else { std::fprintf(stderr, "unknown music op '%s'\n", o.c_str()); std::exit(2); }
    return;
  }
  std::fprintf(stderr, "unknown scripted step kind '%s'\n", kind.c_str());
  std::exit(2);
}

// ---------------------------------------------------------------------------
// Trace capture: re-race the golden trace and record everything the decisions
// read. Split-independent by construction — every car's position is captured and
// which of them are listeners is decided later, per split.
// ---------------------------------------------------------------------------

struct CapBeat {
  bool beat = false;
  std::string type;   // beats only: "_countdown" / "_raceStart" / "_raceEnd"
  int n = 0;          // "_countdown"
  ttp::Event ev;      // race events only
  bool hasPos = false;
  au::Point pos;
};

struct CapLive {
  Id id;
  bool hasPos = false;
  au::Point pos;
};

struct CapFrame {
  int frame = 0;
  double nowMs = 0;
  std::vector<au::Car> cars;
  std::vector<au::Rocket> rockets;
  std::vector<CapBeat> beats;
  std::vector<CapLive> livePos;
};

struct Capture {
  std::string file;
  std::vector<Id> rosterIds;
  std::vector<CapFrame> frames;
  bool ok = false;
};

// One queue item as ttp_runtime.cc's outQueue holds it: race events and session
// beats interleaved in FIRING order, which is the order the display hears them.
struct QueueItem {
  bool beat = false;
  std::string type;
  int n = 0;
  ttp::Event ev;
};

au::Point vecPoint(const Vec3& v) { au::Point p; p.x = v.x; p.y = v.y; p.z = v.z; return p; }

Capture captureTrace(const std::string& dir, const std::string& file) {
  Capture cap;
  cap.file = file;
  const std::string path = dir + "/" + file;
  std::ifstream in(path);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); return cap; }

  std::string headerLine;
  if (!std::getline(in, headerLine)) { std::fprintf(stderr, "%s: empty\n", file.c_str()); return cap; }
  Value header;
  std::string perr;
  if (!read_line(headerLine, header, &perr)) {
    std::fprintf(stderr, "%s: header parse: %s\n", file.c_str(), perr.c_str());
    return cap;
  }
  const Value* math = header.find("math");
  if (!math || math->str != MATHLIB) {
    std::fprintf(stderr, "%s: mathlib stamp '%s' != '%s'\n", file.c_str(),
                 math ? math->str.c_str() : "<none>", MATHLIB);
    return cap;
  }

  const std::string trackId = header.find("trackId")->str;
  const int laps = (int) header.find("laps")->num;
  const uint32_t seed = (uint32_t) header.find("seed")->num;
  const double dt = header.find("dt")->num;
  const bool isSession = header.has("driver") && header.find("driver")->str == "session";
  const int countdown = header.has("countdown") ? (int) header.find("countdown")->num : 3;

  // makeDtStream, as replay_cli and the generator both reproduce it.
  const Value* jj = header.find("dtJitter");
  const bool jitter = jj != nullptr;
  double jAmp = 0, jSpikeScale = 4;
  int jSpikeEvery = 0;
  uint32_t jSeed = 1;
  if (jitter) {
    if (const Value* x = jj->find("amp")) jAmp = x->num;
    if (const Value* x = jj->find("spikeEvery")) jSpikeEvery = (int) x->num;
    if (const Value* x = jj->find("spikeScale")) jSpikeScale = x->num;
    if (const Value* x = jj->find("jseed")) jSeed = (uint32_t) x->num;
  }
  Mulberry32 dtRng(jSeed ? jSeed : 1u);
  auto dtFor = [&](int frame) -> double {
    if (!jitter) return dt;
    double d = dt + (dtRng.next() * 2 - 1) * jAmp;
    if (jSpikeEvery && frame > 0 && frame % jSpikeEvery == 0) d *= jSpikeScale;
    return d;
  };

  std::vector<PlayerDesc> players;
  for (const Value& r : header.find("roster")->arr) {
    PlayerDesc p;
    p.id = idFrom(r.find("id"));
    // The generator adds EVERY roster entry through ttp_add_human — bots
    // included — and drives them from the recorded inputs. The hash check below
    // is what proves that reproduces the recorded race.
    if (const Value* st = r.find("stats")) {
      p.hasStats = true;
      if (const Value* x = st->find("accel")) p.stats.accel = x->num;
      if (const Value* x = st->find("vmax")) p.stats.vmax = x->num;
      if (const Value* x = st->find("turn")) p.stats.turn = x->num;
      if (const Value* x = st->find("mass")) p.stats.mass = x->num;
      if (const Value* x = st->find("halfLen")) p.stats.halfLen = x->num;
      if (const Value* x = st->find("halfWid")) p.stats.halfWid = x->num;
    }
    players.push_back(p);
    cap.rosterIds.push_back(p.id);
  }

  BuiltRaceTrack track;
  std::string terr;
  if (!build_race_track_by_id(trackId, laps, seed, track, terr)) {
    std::fprintf(stderr, "%s: %s\n", file.c_str(), terr.c_str());
    return cap;
  }

  // ONE ordered queue, exactly as runtime/ttp_runtime.cc builds it: race events
  // from onEvent, "_countdown" (+ "_raceStart" on the GO beat) from onTick, and
  // "_raceEnd" from onEnd, all appended in firing order.
  std::vector<QueueItem> queue;
  auto onEvent = [&queue](const ttp::Event& e) {
    QueueItem q; q.ev = e; queue.push_back(std::move(q));
  };
  auto onTick = [&queue](int n) {
    QueueItem q; q.beat = true; q.type = "_countdown"; q.n = n; queue.push_back(std::move(q));
    if (n == 0) { QueueItem s; s.beat = true; s.type = "_raceStart"; queue.push_back(std::move(s)); }
  };
  auto onEnd = [&queue](const Value&) {
    QueueItem q; q.beat = true; q.type = "_raceEnd"; queue.push_back(std::move(q));
  };

  std::unique_ptr<Game> game;
  std::unique_ptr<RaceSession> session;
  Game* eng = nullptr;
  if (isSession) {
    session = std::make_unique<RaceSession>(players, track.game, onEvent, onEnd, onTick);
    eng = &session->engine();
    session->startCountdown(countdown);
  } else {
    game = std::make_unique<Game>(players, track.game, onEvent);
    eng = game.get();
  }

  auto carWorldPos = [&](const Id& id, au::Point& out) -> bool {
    for (const auto& c : eng->cars()) {
      if (c->id == id) { out = vecPoint(c->pose.pos); return true; }
    }
    return false;
  };
  auto trackPoint = [&](double s, double lat) -> au::Point {
    Frame f = eng->centerline()->sampleAt(s);
    f.pos.addScaledVector(f.lateral, lat);
    return vecPoint(f.pos);
  };

  double nowMs = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &perr)) {
      std::fprintf(stderr, "%s: record parse: %s\n", file.c_str(), perr.c_str());
      return cap;
    }
    const int frame = (int) rec.find("frame")->num;

    if (const Value* inputs = rec.find("inputs")) {
      for (const auto& kv : inputs->obj) {
        Id id = Id::None();
        for (const Id& r : cap.rosterIds) if (r.key() == kv.first) { id = r; break; }
        if (id.isNull()) {
          std::fprintf(stderr, "%s frame %d: input for id '%s' not in roster\n",
                       file.c_str(), frame, kv.first.c_str());
          return cap;
        }
        Input msg;
        if (const Value* s = kv.second.find("s")) if (s->type == Value::NUM) { msg.hasS = true; msg.s = s->num; }
        if (const Value* b = kv.second.find("b")) {
          if (b->type == Value::NUM) { msg.hasB = true; msg.b = b->num; }
          else if (b->type == Value::BOOL) { msg.hasB = true; msg.b = b->b ? 1 : 0; }
        }
        if (const Value* u = kv.second.find("u")) if (u->type == Value::NUM) { msg.hasU = true; msg.u = u->num; }
        eng->processInput(id, msg);
      }
    }

    const double dtF = dtFor(frame);
    if (session) session->update(dtF); else eng->update(dtF);
    nowMs += dtF;

    CapFrame cf;
    cf.frame = frame;
    cf.nowMs = nowMs;

    // The race events this frame must be the recorded ones, or the world the
    // audio is decided from is not the recorded world.
    Value events = Value::Arr();
    bool anyEvent = false;
    for (const QueueItem& q : queue) {
      CapBeat b;
      if (q.beat) {
        b.beat = true;
        b.type = q.type;
        b.n = q.n;
        cf.beats.push_back(std::move(b));
        continue;
      }
      anyEvent = true;
      events.push(q.ev.toValue());
      b.ev = q.ev;
      // World points for the positioned events, read while the sim holds the
      // state that produced them (exactly where main.js reads them).
      if (q.ev.type == "rocket_expire") {
        b.hasPos = true;
        b.pos = trackPoint(q.ev.s, q.ev.lat);
      } else if (!q.ev.id.isNull()) {
        b.hasPos = carWorldPos(q.ev.id, b.pos);
      }
      cf.beats.push_back(std::move(b));
    }
    queue.clear();
    {
      Value emptyArr = Value::Arr();
      const Value* recEvents = rec.find("events");
      Diff d = diff_val(recEvents ? *recEvents : emptyArr, events, "events");
      if (d.differ) {
        std::fprintf(stderr, "%s frame %d: events diverged from the trace\n  path %s\n"
                     "  expected %s\n  actual   %s\n", file.c_str(), frame,
                     d.path.c_str(), d.expected.c_str(), d.actual.c_str());
        return cap;
      }
    }

    // Every live car's world point, so each split can pick its own listeners.
    if (anyEvent) {
      for (const auto& c : eng->cars()) {
        CapLive lp;
        lp.id = c->id;
        lp.hasPos = true;
        lp.pos = vecPoint(c->pose.pos);
        cf.livePos.push_back(std::move(lp));
      }
    }

    Value snapshot = eng->getSnapshot();
    const std::string hash = fnv1a_hex(canonical_stringify(snapshot));
    const Value* recHash = rec.find("hash");
    if (!recHash || recHash->str != hash) {
      std::fprintf(stderr, "%s frame %d: snapshot hash %s != recorded %s — the replay is not "
                   "reproducing the golden trace, so nothing decided from it is evidence\n",
                   file.c_str(), frame, hash.c_str(), recHash ? recHash->str.c_str() : "<absent>");
      return cap;
    }

    if (const Value* cars = snapshot.find("cars")) for (const Value& c : cars->arr) cf.cars.push_back(carOf(c));
    if (const Value* rk = snapshot.find("rockets")) {
      for (const Value& r : rk->arr) {
        au::Rocket rocket;
        rocket.id = idFrom(r.find("id"));
        rocket.hasPos = true;
        rocket.pos = trackPoint(numOr(r, "s", 0), numOr(r, "lat", 0));
        cf.rockets.push_back(std::move(rocket));
      }
    }
    cap.frames.push_back(std::move(cf));
  }

  cap.ok = true;
  return cap;
}

// The split's AI set: 'none' = everyone is a CPU racer, 'first' = roster[0] is
// the human, 'firstTwo' = roster[0..1] are.
au::AiIds splitAi(const std::vector<Id>& roster, const std::string& split) {
  const size_t humans = split == "none" ? 0 : split == "first" ? 1 : 2;
  au::AiIds s;
  for (size_t i = 0; i < roster.size(); i++) if (i >= humans) s.add(roster[i]);
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: audio_check <audio-corpus.jsonl> <traces-dir>\n");
    return 2;
  }
  const std::string corpusPath = argv[1], traceDir = argv[2];
  std::ifstream in(corpusPath);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", corpusPath.c_str()); return 2; }

  std::string line;
  if (!std::getline(in, line)) { std::fprintf(stderr, "empty corpus\n"); return 2; }
  Value header;
  std::string perr;
  if (!read_line(line, header, &perr)) {
    std::fprintf(stderr, "header parse: %s\n", perr.c_str());
    return 2;
  }
  {
    const Value* kind = header.find("kind");
    const Value* math = header.find("math");
    if (!kind || kind->str != "audio" || !math || math->str != MATHLIB) {
      std::fprintf(stderr, "not an audio corpus, or the mathlib stamp moved\n");
      return 2;
    }
  }
  const int wantTraceFrames = (int) header.find("traceFrames")->num;
  const int wantScripted = (int) header.find("scriptedSteps")->num;
  const int wantScenarios = (int) header.find("scenarios")->num;

  // Trace state: the corpus emits every split of a file consecutively, so one
  // capture serves them all and a fresh Decider starts at each split boundary.
  Capture cap;
  std::string curSplit;
  std::unique_ptr<au::Decider> traceDec;
  au::AiIds traceAi;
  bool ended = false;
  size_t frameIdx = 0;

  ScenarioState scn;
  int traceFrames = 0, scriptedSteps = 0, scenarios = 0;
  std::vector<au::Command> out;

  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &perr)) {
      std::fprintf(stderr, "parse error: %s\n", perr.c_str());
      return 2;
    }
    const Value* kind = rec.find("case");
    if (!kind || kind->type != Value::STR) { std::fprintf(stderr, "line with no case\n"); return 2; }

    if (kind->str == "trace") {
      const std::string file = rec.find("file")->str;
      const std::string split = rec.find("split")->str;
      if (file != cap.file) {
        cap = captureTrace(traceDir, file);
        if (!cap.ok) return 1;
        curSplit.clear();
      }
      if (split != curSplit) {
        curSplit = split;
        // Trace cases must not draw randomness — the generator installed an rng
        // that THROWS, and a port that started shuffling music from a race event
        // would otherwise diverge silently on some later, unrecorded input.
        traceDec = std::make_unique<au::Decider>([]() -> double {
          std::fprintf(stderr, "FAIL: a trace case drew randomness the JS oracle never would\n");
          std::exit(1);
        });
        traceAi = splitAi(cap.rosterIds, split);
        ended = false;
        frameIdx = 0;
      }
      if (frameIdx >= cap.frames.size()) {
        std::fprintf(stderr, "%s/%s: corpus has more frames than the trace\n",
                     file.c_str(), split.c_str());
        return 2;
      }
      const CapFrame& f = cap.frames[frameIdx++];
      if (f.frame != (int) rec.find("frame")->num) {
        std::fprintf(stderr, "%s/%s: frame %d out of step with the trace's %d\n",
                     file.c_str(), split.c_str(), (int) rec.find("frame")->num, f.frame);
        return 2;
      }

      out.clear();
      for (const CapBeat& b : f.beats) {
        if (b.beat) {
          // The countdown chimes; the GO beat starts the race song, which is not
          // recorded here (a trace header carries no biome — the shuffle is swept
          // in the scripted cases instead); the end beat is where endRace kills
          // the voices and the music.
          if (b.type == "_countdown") traceDec->countdown(b.n, out);
          else if (b.type == "_raceEnd") {
            ended = true;
            traceDec->stopVoices(out);
            traceDec->stopMusic(out);
          }
          continue;
        }
        au::Listeners humans;
        for (const CapLive& lp : f.livePos) {
          if (!traceAi.has(lp.id) && lp.hasPos) humans.push_back(&lp.pos);
        }
        traceDec->event(b.ev, b.hasPos ? &b.pos : nullptr, humans, traceAi, f.nowMs, out);
      }
      // raceEnded freezes the scene, so the per-frame drive stops with it.
      if (!ended) traceDec->frame(f.cars, f.rockets, traceAi, f.nowMs, out);

      report("trace " + file + " " + split + " frame " + std::to_string(f.frame),
             diff_val(*rec.find("cmds"), cmdsValue(out), "cmds"));
      traceFrames++;
      continue;
    }

    if (kind->str == "scenario") {
      const Value* seed = rec.find("seed");
      scn.name = rec.find("name")->str;
      scn.seeded = seed && seed->type == Value::NUM;
      scn.drew = false;
      scn.dec.reset();  // before the rng it borrows, not after
      if (scn.seeded) {
        scn.rng = std::make_unique<Mulberry32>((uint32_t) seed->num);
        Mulberry32* r = scn.rng.get();
        scn.dec = std::make_unique<au::Decider>([r]() { return r->next(); });
      } else {
        bool* drew = &scn.drew;
        scn.dec = std::make_unique<au::Decider>([drew]() { *drew = true; return 0.0; });
      }
      scenarios++;
      continue;
    }

    if (kind->str == "scripted") {
      if (!scn.dec) { std::fprintf(stderr, "a scripted step before its scenario\n"); return 2; }
      out.clear();
      applyStep(scn, rec.find("kind")->str, rec.find("in"), out);
      report("scripted " + scn.name + " step " + std::to_string((long long) rec.find("step")->num),
             diff_val(*rec.find("cmds"), cmdsValue(out), "cmds"));
      scriptedSteps++;
      // A seedless scenario must not draw randomness: the generator's rng threw.
      if (!scn.seeded && scn.drew) {
        std::fprintf(stderr, "FAIL scenario %s drew randomness the JS oracle never would\n",
                     scn.name.c_str());
        return 1;
      }
      continue;
    }

    std::fprintf(stderr, "unknown corpus case '%s'\n", kind->str.c_str());
    return 2;
  }

  // The corpus is FROZEN, so a shape change that silently stopped matching any
  // case would turn this check green while proving nothing.
  if (traceFrames != wantTraceFrames || scriptedSteps != wantScripted || scenarios != wantScenarios) {
    std::fprintf(stderr, "corpus header says %d trace frames / %d scripted steps / %d scenarios; "
                 "replayed %d / %d / %d\n", wantTraceFrames, wantScripted, wantScenarios,
                 traceFrames, scriptedSteps, scenarios);
    return 2;
  }

  std::printf("audio corpus: %d/%d cases passed (%d trace frames, %d scripted steps over %d scenarios)\n",
              passed, cases, traceFrames, scriptedSteps, scenarios);
  return passed == cases ? 0 : 1;
}
