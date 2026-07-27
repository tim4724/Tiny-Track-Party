// Game — the C++ twin of public/display/engine/Game.js. Authoritative ribbon-
// follow car simulation; a bit-exact transliteration under strict FP
// (docs/native-port/fp-profile.md). Reuses libttp-track (Vec3/Centerline/util/
// jsmath) wholesale; transcendentals route through ttp/dmath.h (fdlibm).
//
// Operation order is load-bearing: every Math.round/%/min/max/sign site is
// mapped to the fp-profile helper (js_round/js_min/js_max/js_sign), every ±0 and
// falsy-OR guard is preserved. getSnapshot()/getResults() build the canonical
// Value tree (ttp/canonical.h) with EXACTLY the contract fields.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/centerline.h"
#include "ttp/scalar_id.h"
#include "ttp/util.h"
#include "ttp/vec3.h"

namespace ttp {

// A car id. NONE = null/absent (an ownerless banana, a target-less rocket).
using Id = ScalarId;

struct Stats { double accel = 1, vmax = 1, turn = 1, mass = 1, halfLen = 0.44, halfWid = 0.26; };

// A processInput / AI-drive message. Fields are applied only when present with
// the right type (a partial message is valid; production always sends all three).
struct Input {
  bool hasS = false; double s = 0;
  bool hasB = false; double b = 0;   // number form only (fixtures never send boolean)
  bool hasU = false; double u = 0;
};

struct Pose { Vec3 pos, forward, up; };

struct Car {
  Id id;
  double totalS = 0, lat = 0, v = 0, vlat = 0, heading = 0, steer = 0, brake = 0;
  double spin = 0, spinT = 0, wallRashT = 0;
  std::set<int> oilIn;
  std::map<int, double> oilCd;
  std::set<int> padIn;
  std::set<int> boxIn;
  std::map<int, int> rowIn;
  double boostT = 0, boostMul = 1, monsterT = 0;
  std::string item;          // "" = null slot
  double pickupAge = 999;
  double useSeq = 0;
  bool wantUse = false;
  double tRaw = 0, tCatch = 0;
  double lap = 0;
  bool finished = false;
  bool finishTimeNull = true;
  double finishTime = 0;
  int rank = 1;
  Pose pose;
  double accel = 0, vmax = 0, turn = 0, mass = 1, halfLen = 0.44, halfWid = 0.26;
  bool curbLimSet = false;
  double curbLim = 0;
  bool onWall = false;
};

struct Zone { double s, lat, radius; };  // oil hazard (circle)
struct PadRt { double s, lat; bool strip; double radius, halfLen, halfWidth; };
struct BoxRt { double s, lat, radius, cooldown; int row; };
struct PoleRt { double s, lat, radius; };
struct BananaRt { long id; double s, lat; Id owner; double armAt; bool respawn; double liveAt; bool hit; };
struct RocketRt { long id; double s, lat; Id owner; Id targetId; double life; double v; bool hit; };

struct Event {
  std::string type;
  Id id;
  std::string cause;    // spin
  int rank = 0;         // finish
  double time = 0;      // finish
  int lap = 0;          // lap
  std::string item;     // pickup / item_use
  bool finished = false;// pickup
  double s = 0, lat = 0;// rocket_expire
  Value toValue() const;
};

// Track input to the Game ctor (== the augmented race-track object).
struct GameTrack {
  Centerline* centerline;
  double length;
  int totalLaps;
  double roadWidth;
  uint32_t seed;
  std::vector<Zone> hazards;
  std::vector<PadRt> pads;
  std::vector<BoxRt> boxes;   // .cooldown/.row filled by ctor
  std::vector<PoleRt> poles;
  std::vector<BananaRt> bananas;  // authored (dev tracks); .id/.respawn/.liveAt filled by ctor
};

struct PlayerDesc { Id id; bool hasStats = false; Stats stats; };

class AiController;  // ai_driver.h
class RacingLine;    // ai_driver.h

// Which way a positive steer input turns the car. It lives in the header
// because it is not only physics: the RENDERER has to apply the same sign to
// the front-wheel yaw and the body lean, or the car visibly leans out of the
// corner it is turning into. `Car::steer` stores the raw input, so every
// consumer of it as a DIRECTION multiplies by this (see Game::update and
// getSnapshot's "steer", which is what libttp-runtime's frame builder mirrors).
inline constexpr double STEER_SIGN = -1;

// Live-tunable steering-response exponent — the C++ twin of Game.js
// setSteerExpo/getSteerExpo. Module-global (shared by every Game like the JS
// _steerExpo) and read fresh each physics step. setSteerExpo clamps to [0.5, 3]
// and ignores non-finite input, matching the JS `Number.isFinite` guard.
void setSteerExpo(double v);
double getSteerExpo();

class Game {
 public:
  ~Game();  // out-of-line: racingLine_ points at a type this header only forward-declares

  // The AI's precomputed racing line for THIS race's centerline, built on first
  // use and shared by every bot in the race.
  //
  // Owned by the Game on purpose. It used to live in a function-static cache in
  // ai_driver.cc keyed by `Centerline*` — "a WeakMap analogue", except a WeakMap
  // keys on object identity for as long as the object lives, while a raw address
  // gets RECYCLED. Build one race, destroy it, build another, and the new
  // Centerline could land on the freed one's address: the bots then drove the
  // PREVIOUS track's racing line on the current track. Only reachable when a
  // process runs several races (a cup series, or probe_cli's catalogue sweep), so
  // every single-race golden trace was blind to it.
  RacingLine& racingLine();

  Game(const std::vector<PlayerDesc>& players, const GameTrack& track,
       std::function<void(const Event&)> onEvent = nullptr,
       std::string forceItem = "");

  void processInput(const Id& id, const Input& msg);
  bool removeCar(const Id& id);
  bool setCarStats(const Id& id, const Stats& stats);
  bool rekeyCar(const Id& oldId, const Id& newId);

  // boundary queries
  bool hasCar(const Id& id) const { return find(id) != nullptr; }
  bool carFinished(const Id& id, bool& out) const;  // false if unknown car
  Car* nextCarAhead(const Car& c);

  // driveBot: run one AI controller for its car and apply the result. Writes the
  // derived input to *out when given (ai-live compare). Returns false for an
  // unknown/finished/poseless car (no input applied).
  bool driveBot(const Id& id, AiController& ai, Input* out);

  // staging hooks
  bool giveItem(const Id& id, const std::string& item, bool hasTCatch, double tCatch);
  bool useItem(const Id& id);
  bool forceFinish(const Id& id, bool hasTime, double time);
  long stageBanana(double s, double lat);
  long stageRocket(double s, double lat, double v, Id owner);

  void update(double dtMs);

  Value getSnapshot();
  Value getResults();
  bool raceOver() const { return (long)finishedOrder_.size() >= (long)cars_.size(); }

  double length() const { return length_; }
  double maxLat() const { return maxLat_; }
  double elapsed() const { return elapsed_; }
  Centerline* centerline() const { return centerline_; }
  const std::vector<Zone>& hazards() const { return hazards_; }
  const std::vector<PoleRt>& poles() const { return poles_; }
  const std::vector<BananaRt>& bananas() const { return bananas_; }
  // Read-only, for the renderer (libttp-runtime builds its frame off these
  // rather than off a serialized snapshot). getSnapshot() derives the same two:
  // a box is available when its cooldown has run out, a rocket's `s` wraps.
  const std::vector<BoxRt>& boxes() const { return boxes_; }
  const std::vector<RocketRt>& rockets() const { return rockets_; }
  // cars in insertion order (Map iteration order).
  const std::vector<std::unique_ptr<Car>>& cars() const { return cars_; }

 private:
  Car* find(const Id& id) const;
  void emit(const Event& e) { if (onEvent_) onEvent_(e); }

  // internal steps
  void computeCatchUp(double dt);
  void tickProps(double dt);
  void stepRockets(double dt);
  void resolveCollisions(double dt);
  void recomputePoses();
  void rank();

  double curbLimit(double width) const;
  double colYaw(const Car& c) const;
  struct FP { double along, side, restSide; };
  FP footprint(const Car& c) const;
  double footprintMul(const Car& c) const;
  void clampCurb(Car& c, double dt);
  bool enterZonesOil(Car& c);
  bool enterZonesPads(Car& c);
  bool inStrip(const Car& c, const PadRt& z) const;
  bool inZone(const Car& c, double zs, double zlat, double radius) const;
  void applyPad(Car& c);
  void enterBox(Car& c);
  double placeT(const Car& c) const;
  std::string roll(double t);
  void useItemImpl(Car& c);
  bool enterBanana(Car& c);
  void collidePole(Car& c, const PoleRt& p);
  void collidePair(Car& a, Car& b);
  struct Hit { bool hit; double nS, nL, pen; };
  Hit satRects(const Car& a, const Car& b, double ds, double dl) const;
  void applyImpulse(Car& c, double dS, double dL);
  void spinOut(Car& c, const std::string& cause);

  Centerline* centerline_;
  double length_;
  int totalLaps_;
  double maxLat_;
  std::function<void(const Event&)> onEvent_;
  std::string forceItem_;
  double elapsed_ = 0;
  std::vector<Id> finishedOrder_;
  std::vector<std::unique_ptr<Car>> cars_;
  std::vector<Zone> hazards_;
  std::vector<PadRt> pads_;
  std::vector<BoxRt> boxes_;
  std::vector<PoleRt> poles_;
  std::vector<BananaRt> bananas_;
  long bananaSeq_ = 0;
  std::vector<RocketRt> rockets_;
  long rocketSeq_ = 0;
  Mulberry32 rng_{1};
  std::unique_ptr<RacingLine> racingLine_;
};

}  // namespace ttp
