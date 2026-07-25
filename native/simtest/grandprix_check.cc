// CupSeries conformance check — replays tests/fixtures/grandprix-corpus.jsonl
// (the behavioural oracle from scripts/gen-grandprix-corpus.mjs, recorded against
// the retired public/display/GrandPrix.js) against the C++ CupSeries port.
//
// Line 1 is a header {kind,POINTS_BY_RANK,scripts,bagCases}; each further line is
// either one scripted series {name, config, steps:[{op, ..., digest}]} or one
// {bagCase:{ids,seed,draws,out}} exercising ShuffleBag alone.
//
// For every step it applies the op and demands the port reproduce the full
// public-surface digest (raceIndex/raceCount/currentTrackId/nextTrackId/finished/
// endless/tracks/standings) as canonical JSON. The standings board is the sharp
// end: points, the "+0" for absentees, the latest-race tie-break with its
// Infinity sentinel, stable first-seen order across rekey, and the ABSENT
// name/colorIndex of a row created without a field seat.
//
// The cup layer had no fixture of any kind before this one — it was ported for
// parity and never replayed, so the port's only prior evidence was that the game
// looked right on screen.

#include <cstdio>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

#include "corpus_diff.h"  // read_line + the shared structural diff_val
#include "ttp/canonical.h"
#include "ttp/grand_prix.h"
#include "ttp/util.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

Id idFrom(const Value& v) {
  if (v.type == Value::NUM) return Id::Num(v.num);
  if (v.type == Value::STR) return Id::Str(v.str);
  return Id::None();
}

std::string strOr(const Value* v, const char* dflt) { return v ? v->str : std::string(dflt); }
double numOr(const Value* v, double dflt) { return v ? v->num : dflt; }

// The digest the generator recorded, rebuilt from the port. "" stands for JS null
// in nextTrackId (CupSeries::nextTrackId's documented convention).
Value buildDigest(const CupSeries& s) {
  Value d = Value::Obj();
  d.set("raceIndex", Value::Num((double)s.raceIndex()));
  d.set("raceCount", Value::Num((double)s.raceCount()));
  d.set("currentTrackId", Value::Str(s.currentTrackId()));
  const std::string next = s.nextTrackId();
  d.set("nextTrackId", next.empty() ? Value::Null() : Value::Str(next));
  d.set("finished", Value::Bool(s.finished()));
  d.set("endless", Value::Bool(s.endless()));
  Value tracks = Value::Arr();
  for (const std::string& t : s.cup().tracks) tracks.push(Value::Str(t));
  d.set("tracks", std::move(tracks));

  Value rows = Value::Arr();
  for (const GpStanding& st : s.standings()) {
    Value o = Value::Obj();
    o.set("playerId", st.playerId.toValue());
    // Unseated rows carry JS undefined here, i.e. absent keys (see GpStanding::seatNull).
    if (!st.seatNull) {
      o.set("name", Value::Str(st.name));
      o.set("colorIndex", Value::Num((double)st.colorIndex));
    }
    o.set("ai", Value::Bool(st.ai));
    o.set("points", Value::Num((double)st.points));
    o.set("gained", Value::Num((double)st.gained));
    o.set("lastRank", st.lastRankNull ? Value::Null() : Value::Num((double)st.lastRank));
    rows.push(std::move(o));
  }
  d.set("standings", std::move(rows));
  return d;
}

GpCup cupFrom(const Value& v) {
  GpCup c;
  c.id = strOr(v.find("id"), "");
  c.name = strOr(v.find("name"), "");
  if (const Value* t = v.find("tracks")) for (const Value& e : t->arr) c.tracks.push_back(e.str);
  return c;
}

int spew = 0;

bool reportDiff(const std::string& script, int step, const std::string& op, const Diff& d) {
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s step %d (%s): %s\n  expected %s\n  actual   %s\n",
                 script.c_str(), step, op.c_str(), d.path.c_str(),
                 d.expected.c_str(), d.actual.c_str());
  }
  return false;
}

bool runScript(const Value& root) {
  const std::string name = strOr(root.find("name"), "?");
  const Value* config = root.find("config");
  if (!config) { std::fprintf(stderr, "FAIL %s: no config\n", name.c_str()); return false; }

  const GpCup cup = cupFrom(*config->find("cup"));

  // Endless scripts draw from a seeded mulberry32 bag, exactly as the generator
  // injected one; a non-endless series gets no drawNext at all (endless() is
  // literally "was a draw function supplied").
  std::function<std::string()> drawNext;
  ShuffleBag bag({}, nullptr);
  Mulberry32 rng(1u);
  if (const Value* seed = config->find("bagSeed")) {
    std::vector<std::string> ids;
    if (const Value* b = config->find("bagIds")) {
      for (const Value& e : b->arr) ids.push_back(e.str);
    } else {
      ids = cup.tracks;
    }
    rng = Mulberry32((uint32_t)seed->num);
    bag = ShuffleBag(ids, [&rng]() { return rng.next(); });
    drawNext = [&bag]() { return bag.draw(); };
  }

  CupSeries series(cup, drawNext);

  const Value* steps = root.find("steps");
  if (!steps) { std::fprintf(stderr, "FAIL %s: no steps\n", name.c_str()); return false; }

  int i = 0;
  for (const Value& step : steps->arr) {
    const std::string op = strOr(step.find("op"), "?");
    if (op == "applyRace") {
      std::vector<GpResult> results;
      if (const Value* rs = step.find("results")) {
        for (const Value& r : rs->arr) {
          GpResult g;
          g.playerId = idFrom(*r.find("playerId"));
          g.rank = (int)numOr(r.find("rank"), 0);
          const Value* f = r.find("finished");
          g.finished = f && f->b;
          results.push_back(g);
        }
      }
      std::vector<GpFieldEntry> field;
      if (const Value* fs = step.find("field")) {
        for (const Value& f : fs->arr) {
          GpFieldEntry e;
          e.peerIndex = idFrom(*f.find("peerIndex"));
          e.name = strOr(f.find("name"), "");
          e.colorIndex = (int)numOr(f.find("colorIndex"), 0);
          const Value* ai = f.find("ai");
          e.ai = ai && ai->b;
          field.push_back(e);
        }
      }
      series.applyRace(results, field);
    } else if (op == "advance") {
      series.advance();
    } else if (op == "rekey") {
      series.rekey(idFrom(*step.find("oldId")), idFrom(*step.find("newId")));
    } else {
      std::fprintf(stderr, "FAIL %s step %d: unknown op '%s'\n", name.c_str(), i, op.c_str());
      return false;
    }

    const Value got = buildDigest(series);
    const Diff d = diff_val(*step.find("digest"), got, "digest");
    if (d.differ) return reportDiff(name, i, op, d);
    i++;
  }
  return true;
}

bool runBagCase(const Value& c) {
  std::vector<std::string> ids;
  if (const Value* v = c.find("ids")) for (const Value& e : v->arr) ids.push_back(e.str);
  Mulberry32 rng((uint32_t)numOr(c.find("seed"), 1));
  ShuffleBag bag(ids, [&rng]() { return rng.next(); });

  Value got = Value::Arr();
  const int draws = (int)numOr(c.find("draws"), 0);
  for (int i = 0; i < draws; i++) got.push(Value::Str(bag.draw()));

  const Diff d = diff_val(*c.find("out"), got, "bagCase.out");
  if (d.differ) {
    if (spew++ < 20) {
      std::fprintf(stderr, "FAIL bagCase(seed %d): %s\n  expected %s\n  actual   %s\n",
                   (int)numOr(c.find("seed"), 0), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
    }
    return false;
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: grandprix_check <grandprix-corpus.jsonl>\n"); return 2; }
  std::ifstream in(argv[1]);
  if (!in) { std::fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }

  std::string headerLine;
  if (!std::getline(in, headerLine)) { std::fprintf(stderr, "empty corpus\n"); return 2; }
  Value header;
  std::string err;
  if (!read_line(headerLine, header, &err)) {
    std::fprintf(stderr, "header parse error: %s\n", err.c_str());
    return 2;
  }
  // The points table is part of the contract, not an implementation detail.
  if (const Value* pts = header.find("POINTS_BY_RANK")) {
    for (size_t i = 0; i < pts->arr.size() && i < 4; i++) {
      if ((int)pts->arr[i].num != POINTS_BY_RANK[i]) {
        std::fprintf(stderr, "FAIL POINTS_BY_RANK[%zu]: expected %d, actual %d\n",
                     i, (int)pts->arr[i].num, POINTS_BY_RANK[i]);
        return 1;
      }
    }
  }

  int scripts = 0, scriptsPassed = 0, bags = 0, bagsPassed = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    if (!read_line(line, root, &err)) {
      std::fprintf(stderr, "parse error: %s\n", err.c_str());
      return 2;
    }
    if (const Value* bc = root.find("bagCase")) {
      bags++;
      if (runBagCase(*bc)) bagsPassed++;
    } else {
      scripts++;
      if (runScript(root)) scriptsPassed++;
    }
  }

  const bool ok = scripts == scriptsPassed && bags == bagsPassed;
  std::printf("grandprix: %d/%d scripts, %d/%d bag cases%s\n",
              scriptsPassed, scripts, bagsPassed, bags, ok ? "" : "  <-- FAILURES");
  if (scripts == 0) { std::fprintf(stderr, "no scripts in corpus\n"); return 2; }
  return ok ? 0 : 1;
}
