// hud_check — the C++ HUD block against the JS it was ported from
// (tests/fixtures/ui-corpus.jsonl's `hud` steps, recorded by
// scripts/gen-ui-corpus.mjs off public/display/uiModel.js).
//
// WHAT THIS IS. JS-RECORDED cross-implementation evidence — class 1 in
// tests/fixtures/traces/README.md, the only class that can settle a parity
// question. Every row in it is one the shipping browser game drew a HUD from.
// Nothing here may be "fixed" by re-recording: a disagreement is a bug in
// libttp-runtime/ttp/hud.cc, never in the corpus.
//
// WHAT IT REPLAYS. The corpus records `{rows, pushes}` per `hud` step, where
// rows is `uiModel.hudRows(cars)` — a pure function of the step's own car
// array, threading no scenario state. So the rows replay standalone through
// ttp::rt::hudSlot, which is exactly why that rule is a free function over
// plain values rather than a method on Game: the corpus carries snapshot-level
// values, not a race. (`pushes` is itemPushes, which threads `lastItem` across
// steps and has NOT been ported — it is still uiModel.js's, so this check does
// not claim it.)
//
// WHAT THE COMPARISON PROVES, field by field. The port answers in a packed
// struct, so each recorded row is rebuilt from one TtpHudSlot and diffed as
// JSON against the recorded one:
//   position/lap/totalLaps  the passthrough, as int32
//   item                    the TTP_ITEM_* code decoded back through
//                           ttp::ITEM_IDS — so the round trip, not just the
//                           gate, has to land on the same string JS emitted
//                           (and `null` has to come back from an EMPTY slot,
//                           a FINISHED car, and an absent `item` key alike)
//   finished/finishTime     the two flag bits, including JSON's null
//                           distinction: TIMED off is a recorded `null`, and a
//                           finished car with no time is a real recorded case
//   id                      taken from the INPUT car at the same index. The
//                           port emits no id at all — a slot IS its identity —
//                           so copying it across is the assertion that row i is
//                           car i, which is the whole claim slot indexing makes
//                           (ttp_hud.h, "SLOT IDENTITY").
//
// NOT COVERED HERE, deliberately: ttp::rt::buildHud's block assembly (roster
// slot mapping, the zeroing of unclaimed slots, the header). That needs a live
// Game, which no recorded row is, and it is a behavioural gate of frame_check's
// kind rather than conformance evidence.
//
// Usage: hud_check <ui-corpus.jsonl>

#include <cstdio>
#include <fstream>
#include <string>

#include "corpus_diff.h"
#include "ttp/game.h"   // ITEM_IDS — the sim's own roll table, not a second list
#include "ttp/hud.h"

using namespace ttp;
using namespace ttp::corpus;

namespace {

int cases = 0, passed = 0, spew = 0;

void report(const std::string& what, const Diff& d) {
  cases++;
  if (!d.differ) {
    passed++;
    return;
  }
  if (spew++ < 20) {
    std::fprintf(stderr, "FAIL %s\n  path %s\n  expected %s\n  actual   %s\n",
                 what.c_str(), d.path.c_str(), d.expected.c_str(), d.actual.c_str());
  }
}

// A recorded car's `item`: absent, null and "" are one thing in JS (`c.item ||
// null`), and all three occur in the corpus.
std::string itemOf(const Value& car) {
  const Value* v = car.find("item");
  if (!v || v->type != Value::STR) return "";
  return v->str;
}

// The held item back out of the packed code, as the recorded row spells it.
// TTP_ITEM_UNKNOWN is unreachable from the corpus (the JS only ever carried the
// four ids, an empty string or nothing); it decodes to a string no recorded row
// can hold rather than to null, so a port that folded it away would fail here
// instead of passing quietly.
Value itemValue(int32_t code) {
  if (code == TTP_ITEM_NONE) return Value::Null();
  if (code >= 1 && code <= 4) return Value::Str(ITEM_IDS[code - 1]);
  return Value::Str("<unknown item code>");
}

// One recorded row, rebuilt from the port's answer.
Value rowOf(const TtpHudSlot& s, const Value& car) {
  Value o = Value::Obj();
  const Value* id = car.find("id");
  o.set("id", id ? *id : Value::Null());
  o.set("position", Value::Num((double) s.place));
  o.set("lap", Value::Num((double) s.lap));
  o.set("totalLaps", Value::Num((double) s.totalLaps));
  o.set("item", itemValue(s.item));
  o.set("finished", Value::Bool((s.flags & TTP_HUD_SLOT_FINISHED) != 0));
  o.set("finishTime", (s.flags & TTP_HUD_SLOT_TIMED) ? Value::Num(s.finishTime)
                                                     : Value::Null());
  return o;
}

// The item vocabulary is TWO lists — the TTP_ITEM_* codes and the sim's roll
// table — and the decode above is only trustworthy while they line up. Pinning
// it costs four comparisons, and without it a renumbered macro would make this
// whole check decode consistently wrong.
void checkItemTable() {
  struct { int32_t code; const char* id; } pairs[] = {
    {TTP_ITEM_BOOST, "boost"}, {TTP_ITEM_BANANA, "banana"},
    {TTP_ITEM_ROCKET, "rocket"}, {TTP_ITEM_MONSTER, "monster"},
  };
  for (const auto& p : pairs) {
    cases++;
    const bool inRange = p.code >= 1 && p.code <= 4;
    if (inRange && std::string(ITEM_IDS[p.code - 1]) == p.id &&
        rt::itemCode(p.id) == p.code) {
      passed++;
    } else if (spew++ < 20) {
      std::fprintf(stderr, "FAIL item table: TTP_ITEM code %d is not '%s'\n",
                   (int) p.code, p.id);
    }
  }
  cases++;
  if (rt::itemCode("") == TTP_ITEM_NONE && rt::itemCode("shield") == TTP_ITEM_UNKNOWN) {
    passed++;
  } else if (spew++ < 20) {
    std::fprintf(stderr, "FAIL item table: '' must be NONE and an unlisted id UNKNOWN\n");
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: hud_check <ui-corpus.jsonl>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  checkItemTable();

  int steps = 0, rows = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    Value root;
    std::string err;
    if (!read_line(line, root, &err)) {
      std::fprintf(stderr, "parse error: %s\n", err.c_str());
      return 2;
    }
    const Value* op = root.find("op");
    if (!op || op->type != Value::STR || op->str != "hud") continue;

    const Value* in_ = root.find("in");
    const Value* out = root.find("out");
    const Value* cars = in_ ? in_->find("cars") : nullptr;
    const Value* want = out ? out->find("rows") : nullptr;
    if (!cars || !want) {
      std::fprintf(stderr, "malformed hud step: no in.cars / out.rows\n");
      return 2;
    }
    steps++;

    Value got = Value::Arr();
    for (const Value& car : cars->arr) {
      // Every recorded car carries these four; a corpus that stopped would be
      // damage, and this says so instead of dereferencing null.
      for (const char* k : {"position", "lap", "totalLaps", "finished"}) {
        if (!car.find(k)) {
          std::fprintf(stderr, "malformed hud step: a car with no '%s'\n", k);
          return 2;
        }
      }
      const Value* ft = car.find("finishTime");
      const bool timed = ft && ft->type == Value::NUM;
      const TtpHudSlot s = rt::hudSlot(
          (int32_t) car.find("position")->num, (int32_t) car.find("lap")->num,
          (int32_t) car.find("totalLaps")->num, itemOf(car),
          car.find("finished")->b, timed, timed ? ft->num : 0.0);
      // Every replayed row is a car that IS in the field: hudRows was only ever
      // called on live snapshot cars, so LIVE is an invariant of the rule, not
      // of the block that packs it.
      if (!(s.flags & TTP_HUD_SLOT_LIVE)) {
        std::fprintf(stderr, "FAIL hudSlot returned a slot without LIVE\n");
        return 1;
      }
      got.push(rowOf(s, car));
      rows++;
    }

    const Value* name = root.find("name");
    const Value* step = root.find("step");
    report("hud " + std::string(name ? name->str : "?") + " step " +
               std::to_string(step ? (long long) step->num : -1),
           diff_val(*want, got, "rows"));
  }

  // The corpus is frozen, so a shape change that silently stopped matching any
  // step would turn this check green while proving nothing.
  if (steps == 0) {
    std::fprintf(stderr, "no hud steps found in the corpus\n");
    return 2;
  }

  std::printf("ui hud corpus: %d/%d cases passed (%d steps, %d rows)\n",
              passed, cases, steps, rows);
  return passed == cases ? 0 : 1;
}
