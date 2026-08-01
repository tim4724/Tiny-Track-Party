// Golden-trace REPLAY CLI, linking
// libttp-sim. Reads a JSONL trace, rebuilds the race (buildRaceTrack twin +
// contract-version/mathlib-stamp checks), and replays the recorded inputs
// (input-replay, ai-live re-run, session driver, dt jitter, schedule ops),
// demanding EXACT per-frame agreement: events, stored snapshots, the FNV-1a of
// the canonical snapshot every frame, plus the session's countdown/racing/raceEnd
// beats. First divergence -> prints frame/path/expected/actual and exits 1.
//
// Corpus reading and the structural first-diff are the shared testsupport/
// corpus_diff.h (one parser and one comparator for every check in this tree). It
// reads in STRICT_NUMBERS mode, so every JSON number token must reformat to
// itself: correctly-rounded strtod is proven per value, not assumed.

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "corpus_diff.h"
#include "generated/track_defs.h"
#include "ttp/ai_driver.h"
#include "ttp/contract.h"
#include "ttp/canonical.h"
#include "ttp/dmath.h"
#include "ttp/centerline.h"
#include "ttp/game.h"
#include "ttp/race_track.h"
#include "ttp/jsonnum.h"
#include "ttp/race_session.h"
#include "ttp/trackbuilder.h"

using namespace ttp;
using namespace ttp::corpus;

static const char* MATHLIB = "fdlibm-openlibm-0.8.7";

// ---------------------------------------------------------------------------
// Trace-value builders (Id / Input / Stats from a corpus Value).
// ---------------------------------------------------------------------------
static Id idFrom(const Value& v) {
  if (v.type == Value::STR) return Id::Str(v.str);
  if (v.type == Value::NUM) return Id::Num(v.num);
  return Id::None();
}
static Input inputFrom(const Value& v) {
  Input in;
  if (const Value* s = v.find("s")) { if (s->type == Value::NUM) { in.hasS = true; in.s = s->num; } }
  if (const Value* b = v.find("b")) {
    if (b->type == Value::NUM) { in.hasB = true; in.b = b->num; }
    else if (b->type == Value::BOOL) { in.hasB = true; in.b = b->b ? 1 : 0; }
  }
  if (const Value* u = v.find("u")) { if (u->type == Value::NUM) { in.hasU = true; in.u = u->num; } }
  return in;
}
static Stats statsFrom(const Value& v) {
  Stats st;
  if (const Value* x = v.find("accel")) st.accel = x->num;
  if (const Value* x = v.find("vmax")) st.vmax = x->num;
  if (const Value* x = v.find("turn")) st.turn = x->num;
  if (const Value* x = v.find("mass")) st.mass = x->num;
  if (const Value* x = v.find("halfLen")) st.halfLen = x->num;
  if (const Value* x = v.find("halfWid")) st.halfWid = x->num;
  return st;
}

// ---------------------------------------------------------------------------
// RECORD MODE support.
// ---------------------------------------------------------------------------
// The parsed header is already a ttp::Value, so record mode re-emits it VERBATIM
// (every field survives, including any this CLI doesn't model) with only `frames`
// restamped.

// The scripted human the recorder drove. A trace header stores a
// human's id but NOT its script, so the script is recovered BY CONVENTION from
// the id: `human-<N>` -> index N-1 -> phase (N-1)*17, matching
// scriptedHuman(index) which names itself `human-${index+1}`. An id that doesn't
// match is a hard error rather than a default, so the recorder can never quietly
// synthesize inputs that differ from what the JS recorder would have produced.
static bool humanPhaseFor(const Id& id, int& phaseOut) {
  const std::string k = id.key();
  const std::string pfx = "human-";
  if (k.compare(0, pfx.size(), pfx) != 0) return false;
  const std::string num = k.substr(pfx.size());
  if (num.empty()) return false;
  int n = 0;
  for (char c : num) { if (c < '0' || c > '9') return false; n = n * 10 + (c - '0'); }
  if (n <= 0) return false;
  phaseOut = (n - 1) * 17;
  return true;
}

// s uses dmath sin (NOT the platform libm) so recorded input bytes are
// platform-independent, exactly as the JS recorder requires.
static Input scriptedHumanInput(int frame, int phase) {
  Input in;
  in.hasS = true; in.s = dmath::sin((frame + phase) / 40.0) * 0.6;
  in.hasB = true; in.b = ((frame + phase) % 240) < 25 ? 1.0 : 0.0;
  in.hasU = true; in.u = (double)(((int)std::floor(frame / 300.0)) & 255);
  return in;
}

// ---------------------------------------------------------------------------
struct RosterEntry { Id id; std::string kind; double caution = 1; double laneBias = 0; uint32_t aiSeed = 0; bool hasStats = false; Stats stats; };

static void fail(const std::string& file, int frame, const std::string& path,
                 const std::string& expected, const std::string& actual, const std::string& msg) {
  std::fprintf(stderr, "FAIL %s\n  frame %d  path %s\n  expected %s\n  actual   %s\n  %s\n",
               file.c_str(), frame, path.empty() ? "(hash)" : path.c_str(),
               expected.c_str(), actual.c_str(), msg.c_str());
}

// One trace: verify (or re-record). Factored out of main so a single process can
// run SEVERAL traces in sequence — see the sequence gate in main.
static int runTrace(const std::string& file, bool recordMode, const std::string& outPath) {
  std::ifstream in(file);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", file.c_str()); return 2; }

  std::string headerLine;
  if (!std::getline(in, headerLine)) { std::fprintf(stderr, "empty trace\n"); return 2; }
  Value header; std::string perr;
  if (!read_line(headerLine, header, &perr)) { std::fprintf(stderr, "header parse: %s\n", perr.c_str()); return 2; }

  // provenance
  const Value* cv = header.find("contractVersion");
  if (!cv || (int)cv->num != CONTRACT_VERSION) {
    std::fprintf(stderr, "FAIL %s: contractVersion %g != %d\n", file.c_str(), cv ? cv->num : -1.0, CONTRACT_VERSION);
    return 1;
  }
  const Value* math = header.find("math");
  if (!math || math->str != MATHLIB) {
    std::fprintf(stderr, "FAIL %s: mathlib stamp '%s' != '%s' (re-record)\n",
                 file.c_str(), math ? math->str.c_str() : "<none>", MATHLIB);
    return 1;
  }

  int frames = (int)header.find("frames")->num;
  std::string trackId = header.find("trackId")->str;
  int laps = (int)header.find("laps")->num;
  uint32_t seed = (uint32_t)header.find("seed")->num;
  double dt = header.find("dt")->num;
  bool isSession = header.has("driver") && header.find("driver")->str == "session";
  bool aiLive = header.has("aiLive") && header.find("aiLive")->b;
  int countdown = header.has("countdown") ? (int)header.find("countdown")->num : 3;
  int snapshotEvery = header.has("snapshotEvery") ? (int)header.find("snapshotEvery")->num : 60;

  // dt stream (makeDtStream)
  const Value* jj = header.find("dtJitter");
  bool jitter = jj != nullptr;
  double jAmp = 0, jSpikeScale = 4; int jSpikeEvery = 0; uint32_t jSeed = 1;
  if (jitter) {
    if (const Value* x = jj->find("amp")) jAmp = x->num;
    if (const Value* x = jj->find("spikeEvery")) jSpikeEvery = (int)x->num;
    if (const Value* x = jj->find("spikeScale")) jSpikeScale = x->num;
    if (const Value* x = jj->find("jseed")) jSeed = (uint32_t)x->num;
  }
  Mulberry32 dtRng(jSeed ? jSeed : 1u);
  auto dtFor = [&](int frame) -> double {
    if (!jitter) return dt;
    double d = dt + (dtRng.next() * 2 - 1) * jAmp;
    if (jSpikeEvery && frame > 0 && frame % jSpikeEvery == 0) d *= jSpikeScale;
    return d;
  };

  // roster
  std::vector<RosterEntry> roster;
  for (const Value& r : header.find("roster")->arr) {
    RosterEntry e;
    e.id = idFrom(*r.find("id"));
    e.kind = r.find("kind")->str;
    if (const Value* x = r.find("caution")) e.caution = x->num;
    if (const Value* x = r.find("laneBias")) e.laneBias = x->num;
    if (const Value* x = r.find("aiSeed")) e.aiSeed = (uint32_t)x->num;
    if (const Value* x = r.find("stats")) { e.hasStats = true; e.stats = statsFrom(*x); }
    roster.push_back(e);
  }

  BuiltRaceTrack track; std::string terr;
  if (!build_race_track_by_id(trackId, laps, seed, track, terr)) { std::fprintf(stderr, "FAIL %s: %s\n", file.c_str(), terr.c_str()); return 1; }

  // players (roster order) — {id, stats}
  std::vector<PlayerDesc> players;
  for (const RosterEntry& r : roster) players.push_back(PlayerDesc{r.id, r.hasStats, r.stats});

  // callbacks capture
  std::vector<Event> pending;
  std::vector<int> ticks;
  bool haveRaceEnd = false; Value raceEndResults;
  auto onEvent = [&](const Event& e) { pending.push_back(e); };
  auto onTick = [&](int n) { ticks.push_back(n); };
  auto onEnd = [&](const Value& r) { raceEndResults = r; haveRaceEnd = true; };

  std::unique_ptr<Game> game;
  std::unique_ptr<RaceSession> session;
  Game* eng = nullptr;
  if (isSession) {
    session = std::make_unique<RaceSession>(players, track.game, onEvent, onEnd, onTick);
    eng = &session->engine();
  } else {
    game = std::make_unique<Game>(players, track.game, onEvent);
    eng = game.get();
  }

  // applyStage
  if (const Value* stage = header.find("stage")) {
    for (const Value& st : stage->arr) {
      std::string kind = st.find("kind")->str;
      double s = st.find("s")->num, lat = st.has("lat") ? st.find("lat")->num : 0;
      if (kind == "rocket") {
        double v = 0; Id owner = Id::Str("staged");
        if (const Value* o = st.find("opts")) {
          if (const Value* x = o->find("v")) v = x->num;
          if (const Value* x = o->find("owner")) owner = idFrom(*x);
        }
        eng->stageRocket(s, lat, v, owner);
      } else if (kind == "banana") {
        eng->stageBanana(s, lat);
      } else { std::fprintf(stderr, "FAIL %s: unknown stage kind '%s'\n", file.c_str(), kind.c_str()); return 1; }
    }
  }
  if (session) session->startCountdown(countdown);

  // controllers (ai-live)
  struct Ctrl { Id id; std::unique_ptr<AiController> ai; };
  std::vector<Ctrl> controllers;
  std::vector<std::string> botKeys;
  if (aiLive) {
    for (const RosterEntry& r : roster) if (r.kind == "bot") {
      controllers.push_back(Ctrl{r.id, std::make_unique<AiController>(r.caution, LOOKAHEAD, STEER_GAIN, r.laneBias, r.aiSeed)});
    }
  }
  for (const RosterEntry& r : roster) if (r.kind == "bot") botKeys.push_back(r.id.key());

  // idByKey
  std::vector<std::pair<std::string, Id>> idByKey;
  for (const RosterEntry& r : roster) idByKey.emplace_back(r.id.key(), r.id);
  auto lookupId = [&](const std::string& key, Id& out) -> bool {
    for (auto& kv : idByKey) if (kv.first == key) { out = kv.second; return true; }
    return false;
  };

  const Value* schedule = header.find("schedule");

  bool lastRacing = false;

  // =========================================================================
  // RECORD MODE — generate the trace instead of checking one.
  // =========================================================================
  // Mirrors record-trace.mjs's loop exactly: schedule ops, then scripted human
  // inputs, then live bot AI (only while racing), then update, then emit
  // {frame, inputs, events, hash} (+ snapshot on the cadence, + the session
  // beats). Every line is canonical JSON, like the JS recorder's output.
  if (recordMode) {
    // Scripted humans, by id convention (see humanPhaseFor).
    struct HumanDrv { Id id; int phase; };
    std::vector<HumanDrv> humans;
    for (const RosterEntry& r : roster) {
      if (r.kind != "human") continue;
      int phase = 0;
      if (!humanPhaseFor(r.id, phase)) {
        std::fprintf(stderr,
                     "FAIL %s: human id '%s' does not match the scriptedHuman convention "
                     "(human-<N>); refusing to guess its input script\n",
                     file.c_str(), r.id.key().c_str());
        return 1;
      }
      humans.push_back(HumanDrv{r.id, phase});
    }
    // Bots always drive live while recording (that IS how inputs are produced);
    // the aiLive header flag only says whether the VERIFIER re-derives them.
    std::vector<Ctrl> recBots;
    for (const RosterEntry& r : roster) {
      if (r.kind == "bot") {
        recBots.push_back(Ctrl{r.id, std::make_unique<AiController>(r.caution, LOOKAHEAD, STEER_GAIN,
                                                                   r.laneBias, r.aiSeed)});
      }
    }

    std::vector<std::string> outLines;
    int written = 0;
    for (int frame = 0; frame < frames; frame++) {
      // schedule ops run before inputs, with the same rekey bookkeeping the
      // verifier does (controllers follow the car to its new id).
      if (schedule) {
        for (const Value& op : schedule->arr) {
          if ((int)op.find("frame")->num != frame) continue;
          std::string o = op.find("op")->str;
          Id id = idFrom(*op.find("id"));
          if (o == "removeCar") eng->removeCar(id);
          else if (o == "rekeyCar") {
            Id newId = idFrom(*op.find("newId"));
            eng->rekeyCar(id, newId);
            std::string ok = id.key();
            for (auto& c : recBots) if (c.id.key() == ok) c.id = newId;
            for (auto& h : humans) if (h.id.key() == ok) h.id = newId;
          } else if (o == "setCarStats") eng->setCarStats(id, statsFrom(*op.find("stats")));
          else if (o == "giveItem") {
            std::string item = op.find("item")->str;
            bool hasT = false; double t = 0;
            if (const Value* opts = op.find("opts")) if (const Value* x = opts->find("tCatch")) { hasT = true; t = x->num; }
            eng->giveItem(id, item, hasT, t);
          } else if (o == "useItem") eng->useItem(id);
          else if (o == "forceFinish") {
            bool hasT = op.has("time"); double t = hasT ? op.find("time")->num : 0;
            eng->forceFinish(id, hasT, t);
          } else { std::fprintf(stderr, "FAIL %s: unknown schedule op '%s'\n", file.c_str(), o.c_str()); return 1; }
        }
      }

      Value inputsV = Value::Obj();
      for (const HumanDrv& h : humans) {
        Input msg = scriptedHumanInput(frame, h.phase);
        Value m = Value::Obj();
        m.set("s", Value::Num(msg.s));
        m.set("b", Value::Num(msg.b));
        m.set("u", Value::Num(msg.u));
        inputsV.set(h.id.key(), std::move(m));
        if (session) session->processInput(h.id, msg); else eng->processInput(h.id, msg);
      }
      if (!session || session->racing()) {
        for (auto& c : recBots) {
          Input derived;
          // driveBot APPLIES the control and reports it; a finished/poseless car
          // returns false and contributes no input line, like the JS recorder.
          if (eng->driveBot(c.id, *c.ai, &derived)) {
            Value m = Value::Obj();
            m.set("s", Value::Num(derived.s));
            m.set("b", Value::Num(derived.b));
            m.set("u", Value::Num(derived.u));
            inputsV.set(c.id.key(), std::move(m));
          }
        }
      }

      const double dtF = dtFor(frame);
      if (session) session->update(dtF); else eng->update(dtF);

      Value eventsV = Value::Arr();
      for (const Event& e : pending) eventsV.push(e.toValue());
      pending.clear();

      Value snapshot = eng->getSnapshot();
      const std::string snapCanon = canonical_stringify(snapshot);

      Value rec = Value::Obj();
      rec.set("frame", Value::Num(frame));
      rec.set("inputs", inputsV);
      rec.set("events", std::move(eventsV));
      rec.set("hash", Value::Str(fnv1a_hex(snapCanon)));
      if ((snapshotEvery > 0 && frame % snapshotEvery == 0) || frame == frames - 1) {
        rec.set("snapshot", snapshot);
      }
      if (session) {
        if (!ticks.empty()) {
          Value cd = Value::Arr();
          for (int n : ticks) cd.push(Value::Num(n));
          ticks.clear();
          rec.set("countdown", std::move(cd));
        }
        if (session->racing() != lastRacing) {
          lastRacing = session->racing();
          rec.set("racing", Value::Bool(lastRacing));
        }
        if (haveRaceEnd) { rec.set("raceEnd", raceEndResults); }
      }
      outLines.push_back(canonical_stringify(rec));
      written++;
      if (session && haveRaceEnd) { haveRaceEnd = false; break; }  // race over: trace complete
    }

    // Header verbatim, with `frames` restamped to what was actually recorded.
    // NOTE: Value::set APPENDS (canonical_stringify sorts, so insertion order is
    // normally irrelevant) — so an existing key must be dropped first or it is
    // emitted twice.
    Value hdr = header;
    hdr.obj.erase(std::remove_if(hdr.obj.begin(), hdr.obj.end(),
                                 [](const std::pair<std::string, Value>& kv) { return kv.first == "frames"; }),
                  hdr.obj.end());
    hdr.set("frames", Value::Num(written));

    std::string text = canonical_stringify(hdr) + "\n";
    for (const std::string& l : outLines) { text += l; text += "\n"; }

    if (outPath.empty()) {
      std::fwrite(text.data(), 1, text.size(), stdout);
    } else {
      std::ofstream out(outPath, std::ios::binary | std::ios::trunc);
      if (!out) { std::fprintf(stderr, "cannot write %s\n", outPath.c_str()); return 2; }
      out.write(text.data(), (std::streamsize)text.size());
      if (!out) { std::fprintf(stderr, "write failed %s\n", outPath.c_str()); return 2; }
      std::fprintf(stderr, "recorded %d frames -> %s\n", written, outPath.c_str());
    }
    return 0;
  }

  int recCount = 0;

  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value rec;
    if (!read_line(line, rec, &perr)) { std::fprintf(stderr, "FAIL %s: record parse: %s\n", file.c_str(), perr.c_str()); return 1; }
    recCount++;
    int frame = (int)rec.find("frame")->num;

    // schedule ops (before inputs), with id-remap bookkeeping
    if (schedule) {
      for (const Value& op : schedule->arr) {
        if ((int)op.find("frame")->num != frame) continue;
        std::string o = op.find("op")->str;
        Id id = idFrom(*op.find("id"));
        if (o == "removeCar") eng->removeCar(id);
        else if (o == "rekeyCar") {
          Id newId = idFrom(*op.find("newId"));
          eng->rekeyCar(id, newId);
          // remap idByKey / botKeys / controllers, exactly as verify-trace's onRekey:
          // DELETE the old key, SET the new key -> newId (not just rename the key,
          // which would leave the stale Id value and drop the car's later inputs).
          std::string ok = id.key(), nk = newId.key();
          idByKey.erase(std::remove_if(idByKey.begin(), idByKey.end(),
                                       [&](const std::pair<std::string, Id>& kv) { return kv.first == ok; }),
                        idByKey.end());
          idByKey.emplace_back(nk, newId);
          for (auto& bk : botKeys) if (bk == ok) bk = nk;
          for (auto& c : controllers) if (c.id.key() == ok) c.id = newId;
        } else if (o == "setCarStats") { eng->setCarStats(id, statsFrom(*op.find("stats"))); }
        else if (o == "giveItem") {
          std::string item = op.find("item")->str;
          bool hasT = false; double t = 0;
          if (const Value* opts = op.find("opts")) if (const Value* x = opts->find("tCatch")) { hasT = true; t = x->num; }
          eng->giveItem(id, item, hasT, t);
        } else if (o == "useItem") eng->useItem(id);
        else if (o == "forceFinish") {
          bool hasT = op.has("time"); double t = hasT ? op.find("time")->num : 0;
          eng->forceFinish(id, hasT, t);
        } else { std::fprintf(stderr, "FAIL %s: unknown schedule op '%s'\n", file.c_str(), o.c_str()); return 1; }
      }
    }

    // recorded inputs
    const Value* inputs = rec.find("inputs");
    if (inputs) {
      for (const auto& kv : inputs->obj) {
        const std::string& key = kv.first;
        if (aiLive) { bool isBot = false; for (auto& bk : botKeys) if (bk == key) { isBot = true; break; } if (isBot) continue; }
        Id id;
        if (!lookupId(key, id)) {
          fail(file, frame, "inputs." + key, "<roster>", "<absent>", "input for id not in roster (corrupt trace)");
          return 1;
        }
        Input msg = inputFrom(kv.second);
        if (session) session->processInput(id, msg); else eng->processInput(id, msg);
      }
    }

    // ai-live: re-run each bot's controller and compare BEFORE applying
    if (aiLive && (!session || session->racing())) {
      for (auto& c : controllers) {
        Input derived;
        bool applied = eng->driveBot(c.id, *c.ai, &derived);
        // recorded input for this bot
        const Value* recorded = inputs ? inputs->find(c.id.key()) : nullptr;
        if (applied) {
          Value dv = Value::Obj();
          dv.set("s", Value::Num(derived.s));
          dv.set("b", Value::Num(derived.b));
          dv.set("u", Value::Num(derived.u));
          if (!recorded) {
            fail(file, frame, "inputs." + c.id.key(), "<absent>", canonical_stringify(dv), "AI-LIVE: bot drove but trace has no input");
            return 1;
          }
          Diff d = diff_val(*recorded, dv, "inputs." + c.id.key());
          if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "AI-LIVE divergence for bot " + c.id.key()); return 1; }
        }
      }
    }

    double dtF = dtFor(frame);
    if (session) session->update(dtF); else eng->update(dtF);

    // session beats
    if (session) {
      // countdown
      std::vector<int> got = ticks; ticks.clear();
      const Value* recCd = rec.find("countdown");
      if (!got.empty()) {
        Value gv = Value::Arr(); for (int n : got) gv.push(Value::Num(n));
        if (!recCd) { fail(file, frame, "countdown", "<absent>", canonical_stringify(gv), "countdown ticks fired but trace records none"); return 1; }
        Diff d = diff_val(*recCd, gv, "countdown");
        if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "countdown diverged"); return 1; }
      } else if (recCd) {
        fail(file, frame, "countdown", canonical_stringify(*recCd), "<absent>", "trace records countdown ticks that did not fire");
        return 1;
      }
      // racing flip
      const Value* recRacing = rec.find("racing");
      bool nowRacing = session->racing();
      if (nowRacing != lastRacing) {
        bool exp = recRacing && recRacing->b;
        if (!recRacing || exp != nowRacing) {
          fail(file, frame, "racing", recRacing ? (recRacing->b ? "true" : "false") : "<absent>",
               nowRacing ? "true" : "false", "racing flip mismatch");
          return 1;
        }
        lastRacing = nowRacing;
      } else if (recRacing) {
        fail(file, frame, "racing", recRacing->b ? "true" : "false", "<no flip>", "trace records a racing flip that did not happen");
        return 1;
      }
      // raceEnd
      const Value* recEnd = rec.find("raceEnd");
      if (haveRaceEnd) {
        if (!recEnd) { fail(file, frame, "raceEnd", "<absent>", canonical_stringify(raceEndResults), "race ended but trace records no raceEnd"); return 1; }
        Diff d = diff_val(*recEnd, raceEndResults, "raceEnd");
        if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "raceEnd diverged"); return 1; }
        haveRaceEnd = false;
      } else if (recEnd) {
        fail(file, frame, "raceEnd", canonical_stringify(*recEnd), "<absent>", "trace records raceEnd that did not happen");
        return 1;
      }
    }

    // events (every frame)
    Value events = Value::Arr();
    for (const Event& e : pending) events.push(e.toValue());
    pending.clear();
    const Value* recEvents = rec.find("events");
    Value emptyArr = Value::Arr();
    const Value& re = recEvents ? *recEvents : emptyArr;
    { Diff d = diff_val(re, events, "events");
      if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "events diverged"); return 1; } }

    // snapshot
    Value snapshot = eng->getSnapshot();
    if (const Value* recSnap = rec.find("snapshot")) {
      Diff d = diff_val(*recSnap, snapshot, "snapshot");
      if (d.differ) { fail(file, frame, d.path, d.expected, d.actual, "snapshot diverged"); return 1; }
    }

    // hash (every frame)
    std::string hash = fnv1a_hex(canonical_stringify(snapshot));
    const Value* recHash = rec.find("hash");
    if (!recHash || recHash->str != hash) {
      fail(file, frame, "", recHash ? recHash->str : "<absent>", hash,
           "snapshot hash diverged (no full snapshot this frame — next stored snapshot localizes)");
      return 1;
    }
  }

  if (recCount != frames) {
    std::fprintf(stderr, "FAIL %s: header says %d frames, trace carries %d\n", file.c_str(), frames, recCount);
    return 1;
  }
  std::printf("PASS %s (%d frames, exact)\n", file.c_str(), recCount);
  return 0;
}

int main(int argc, char** argv) {
  // usage:
  //   replay_cli <trace.jsonl> [<trace2.jsonl> ...]   verify each, IN ONE PROCESS
  //   replay_cli --record <trace-or-header.json[l]> [--out=<file>]
  //                                                  RE-RECORD from that file's
  //                                                  header; writes to --out or
  //                                                  stdout. Re-recording a
  //                                                  committed fixture must be
  //                                                  byte-identical to it — that
  //                                                  equality is what lets
  //                                                  --record re-emit a
  //                                                  JS-recorded trace exactly.
  //
  // Several traces in one process is not a convenience: it is the CROSS-RACE
  // ISOLATION gate. Each replay is byte-exact on its own, so any state that
  // survives a Game and leaks into the next race makes a later trace diverge. A
  // process-global racing-line cache keyed by a recycled Centerline* did exactly
  // that (bots drove the previous track's line), and every one-race-per-process
  // fixture was blind to it.
  bool recordMode = false;
  std::vector<std::string> files;
  std::string outPath;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--record") recordMode = true;
    else if (a.compare(0, 6, "--out=") == 0) outPath = a.substr(6);
    else if (a.compare(0, 2, "--") == 0) { std::fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
    else files.push_back(a);
  }
  if (files.empty()) {
    std::fprintf(stderr, "usage: replay_cli <trace.jsonl> [<trace2.jsonl> ...] | replay_cli --record <trace-or-header> [--out=f]\n");
    return 2;
  }
  if (recordMode && files.size() != 1) {
    std::fprintf(stderr, "--record takes exactly one file\n");
    return 2;
  }
  for (const std::string& f : files) {
    const int rc = runTrace(f, recordMode, outPath);
    if (rc != 0) return rc;
  }
  return 0;
}
