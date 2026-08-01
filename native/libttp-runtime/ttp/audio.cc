// audio.cc — see audio.h. Transliterated line for line from the JS decision
// layer that tests/fixtures/audio-corpus.jsonl was recorded off. That oracle was
// deleted with the engine, so the corpus is now the only surviving statement of
// what these rules were — it can never be re-recorded (root rule 4).
//
// The TUNING rationale did not come with it. Why AUD_PEAK is 0.7, why a CPU car
// is never voiced, why the roulette's reveal pop is the "item ready" beat — all
// of that lived in the JS comments, so it is now reachable only through
// `git log --diff-filter=D -- public/display/audio/decide.js` (or
// `npm run revive:js-oracle`). Read it there before retuning anything; what IS
// repeated here is only what a port can get wrong.

#include "ttp/audio.h"

#include <cmath>
#include <limits>
#include <random>

#include "ttp/jsmath.h"

namespace ttp {
namespace rt {
namespace audio {

namespace {

// clamp01 = (x) => Math.max(0, Math.min(1, x)). js_max/js_min rather than std::
// — the ±0 ordering differs, and a -0 level would be a different double reaching
// the VOICE_FLOOR comparison (fp-profile §3.4).
inline double clamp01(double x) { return js_max(0.0, js_min(1.0, x)); }

// JS number truthiness (`c.spin ? … : …`): false for ±0 AND NaN. `x != 0` alone
// would send a NaN down the opposite branch from the JS.
inline bool truthy(double x) { return x != 0.0 && !std::isnan(x); }

const char* const MACLEOD_ARTIST = "Kevin MacLeod";
const char* const MACLEOD_LICENSE = "CC-BY 4.0";
const char* const MACLEOD_SOURCE = "https://incompetech.com/music/royalty-free/music.html";

// `gain` is an AUTHORED LITERAL, not 10 ** ((MUSIC_TARGET_LUFS - lufs) / 20)
// evaluated here, and that is the same decision the JS made for the same reason:
// pow is implementation-approximated (fp-profile §2), and measured against the
// vendored fdlibm this port links, ttp_fd_pow(10, x) disagrees with V8's
// `10 ** x` on 2 of the 23 distinct trims below (lufs -15.7 and -15.3). A
// decimal literal has no such problem — JS and C++ both parse it correctly
// rounded, so both get the identical double. `lufs` stays beside each one as the
// authored measurement; tests/credits.test.js re-runs the derivation over the JS
// table to a few-ULP tolerance.
#define SONG(file, title, dur, lufs, gain) \
  { "/assets/audio/music/" file, title, dur, lufs, gain, \
    MACLEOD_ARTIST, MACLEOD_LICENSE, MACLEOD_SOURCE }

const Song BEACH[] = {
  SONG("beachfront_celebration.mp3", "Beachfront Celebration", 187, -9.2, 0.31622776601683794),
  SONG("island_meet_and_greet.mp3", "Island Meet and Greet", 217, -13.6, 0.5248074602497727),
  SONG("paradise_found.mp3", "Paradise Found", 187, -11.5, 0.4120975190973303),
  SONG("tiki_bar_mixer.mp3", "Tiki Bar Mixer", 212, -15.3, 0.6382634861905488),
  SONG("arroz_con_pollo.mp3", "Arroz Con Pollo", 162, -13.2, 0.5011872336272722),
};
const Song PLAYROOM[] = {
  SONG("itty_bitty_8_bit.mp3", "Itty Bitty 8 Bit", 194, -11.9, 0.4315190768277653),
  SONG("bit_shift.mp3", "Bit Shift", 192, -13.3, 0.5069907082747045),
  SONG("chipper_doodle_v2.mp3", "Chipper Doodle v2", 172, -12.2, 0.44668359215096315),
  SONG("voice_over_under.mp3", "Voice Over Under", 197, -15.4, 0.6456542290346556),
  SONG("delightful_d.mp3", "Delightful D", 184, -10.3, 0.35892193464500527),
};
const Song SNOW[] = {
  SONG("wallpaper.mp3", "Wallpaper", 220, -11.2, 0.3981071705534972),
  SONG("new_friendly.mp3", "New Friendly", 169, -15.7, 0.6683439175686147),
  SONG("glitter_blast.mp3", "Glitter Blast", 178, -15.1, 0.6237348354824193),
  SONG("cloud_dancer.mp3", "Cloud Dancer", 220, -13.6, 0.5248074602497727),
  SONG("digital_lemonade.mp3", "Digital Lemonade", 180, -14.0, 0.5495408738576246),
};
const Song GRASS[] = {
  SONG("happy_bee.mp3", "Happy Bee", 302, -9.1, 0.3126079367123955),
  SONG("hyperfun.mp3", "Hyperfun", 233, -19.1, 0.9885530946569391),
  SONG("feelin_good.mp3", "Feelin Good", 225, -18.0, 0.8709635899560807),
  SONG("vivacity.mp3", "Vivacity", 232, -12.8, 0.4786300923226384),
  SONG("happy_happy_game_show.mp3", "Happy Happy Game Show", 158, -9.7, 0.33496543915782767),
};
const Song CANYON[] = {
  SONG("still_pickin.mp3", "Still Pickin", 298, -13.9, 0.5432503314924333),
  SONG("desert_of_lost_souls.mp3", "Desert of Lost Souls", 181, -16.7, 0.7498942093324559),
  SONG("surf_shimmy.mp3", "Surf Shimmy", 123, -13.4, 0.5128613839913649),
  SONG("bama_country.mp3", "Bama Country", 212, -18.2, 0.8912509381337456),
};

#undef SONG

}  // namespace

// Declaration order is the JS object's, which is what the ?biome= list and the
// music gallery walk. It is NOT a lookup order: the decisions match by name.
const MusicPool RACE_MUSIC[] = {
  {"beach", BEACH, 5},
  {"playroom", PLAYROOM, 5},
  {"snow", SNOW, 5},
  {"grass", GRASS, 5},
  {"canyon", CANYON, 4},
};

// RACE_MUSIC is `extern` in the header, so RACE_MUSIC_COUNT cannot be derived
// there and is hand-maintained beside it. This is what keeps the two honest: a
// sixth pool added above without bumping the constant would not be a compile
// error, it would be a biome startMusic's lookup never reaches and silently
// answers with the snow fallback — and the corpus knows only the five shipped
// biomes, so no gate would say a word.
static_assert(sizeof(RACE_MUSIC) / sizeof(RACE_MUSIC[0]) == RACE_MUSIC_COUNT,
              "RACE_MUSIC_COUNT must match the pool table above");

const MusicPool& musicFallback() { return RACE_MUSIC[2]; }  // MUSIC_FALLBACK = RACE_MUSIC.snow

// ---------------------------------------------------------------------------
// the distance model
// ---------------------------------------------------------------------------

double nearestHumanDist(const Point& p, const Listeners& humans) {
  double best = std::numeric_limits<double>::infinity();
  for (const Point* hp : humans) {
    if (!hp) continue;
    const double dx = hp->x - p.x, dy = hp->y - p.y, dz = hp->z - p.z;
    // std::sqrt of the sum of squares, in this order, and NEVER std::hypot —
    // see audio.h. The three squares and two adds are exact IEEE ops in one
    // fixed order and must not contract into an FMA.
    const double d = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (d < best) best = d;
  }
  return best;
}

double audibility(const Point* p, const Listeners& humans) {
  if (!p) return AUD_PEAK;
  const double d = nearestHumanDist(*p, humans);
  if (d <= AUD_NEAR) return AUD_PEAK;
  if (d >= AUD_CUT) return 0;
  if (d <= AUD_FAR) return AUD_PEAK - (AUD_PEAK - AUD_FLOOR) * (d - AUD_NEAR) / (AUD_FAR - AUD_NEAR);
  return AUD_FLOOR * (1 - (d - AUD_FAR) / (AUD_CUT - AUD_FAR));
}

double rocketImpactLevel(const Point* pos, bool targetIsAi, const Listeners& humans) {
  if (!pos) return 1;
  if (!targetIsAi) return 1;  // a human got hit -> full
  const double a = audibility(pos, humans);
  return a > 0 ? js_max(0.45, a) : 0;
}

// ---------------------------------------------------------------------------
// the platform RNG
// ---------------------------------------------------------------------------

// The shipped path's `Math.random`. Never on a byte path: the only consumer is
// the music shuffle, and every recorded pick comes from an injected stream.
double platform_random() {
  static std::mt19937_64 gen(std::random_device{}());
  static std::uniform_real_distribution<double> dist(0.0, 1.0);
  return dist(gen);
}

// ---------------------------------------------------------------------------
// the decider
// ---------------------------------------------------------------------------

Decider::Decider(std::function<double()> rng)
    : rng_(rng ? std::move(rng) : std::function<double()>(&platform_random)),
      lastScreech_(-std::numeric_limits<double>::infinity()),
      lastLap_(-std::numeric_limits<double>::infinity()) {}

// ---- sustained voices ----
// A voice starts when its level rises above VOICE_FLOOR and dies when it falls
// back. `stop` is emitted on the falling edge only: a level command implicitly
// starts a voice that is not running, so a shell that dropped one (audio still
// locked when it was first asked for) picks it back up on the next frame.
void Decider::voice(std::vector<Command>& out, const char* cue, const Id& id,
                    double level, const Mod* mod) {
  const std::string key = std::string(cue) + ":" + id.key();
  if (level <= VOICE_FLOOR) {
    for (size_t i = 0; i < voices_.size(); i++) {
      if (voices_[i] != key) continue;
      voices_.erase(voices_.begin() + (ptrdiff_t) i);
      Command c;
      c.kind = Command::VOICE_STOP;
      c.name = cue;
      c.id = id;
      out.push_back(std::move(c));
      return;
    }
    return;
  }
  bool present = false;
  for (const std::string& k : voices_) if (k == key) { present = true; break; }
  if (!present) voices_.push_back(key);
  Command c;
  c.kind = Command::VOICE;
  c.name = cue;
  c.id = id;
  c.level = level;
  c.mod = mod;
  out.push_back(std::move(c));
}

void Decider::frame(const std::vector<Car>& cars, const std::vector<Rocket>& rockets,
                    const AiIds& aiIds, double nowMs, std::vector<Command>& out) {
  // The listeners: every human car's world point, in car order.
  humans_.clear();
  for (const Car& c : cars) if (!aiIds.has(c.id)) humans_.push_back(c.hasPos ? &c.pos : nullptr);

  // Curb scrub — loudness by distance to the nearest human. Unlike the one-shot
  // cues this is a continuous grind on a single shared throttle, so only
  // in-scene scrubs (>= the FLOOR) compete and the loudest wins the window — a
  // distant AI wall-grind can't claim it.
  bool haveScrub = false;
  double scrubSpd = 0, scrubG = 0;
  for (const Car& c : cars) {
    if (c.onWall && c.spd > SCRUB_SPD_MIN) {
      const double g = audibility(c.hasPos ? &c.pos : nullptr, humans_);
      if (g >= AUD_FLOOR && (!haveScrub || g > scrubG)) { haveScrub = true; scrubSpd = c.spd; scrubG = g; }
    }
    // State-driven voices per HUMAN car — each level follows the physics this
    // frame. CPU cars stay silent here: they corner and brake constantly, and a
    // 7-car chorus would be noise.
    if (aiIds.has(c.id)) continue;
    // boostMul 1.0 -> silent; the pad/item peak (~1.6) -> full level.
    voice(out, "boost", c.id, clamp01((c.boostMul - 1) / 0.6), nullptr);
    // Tire squeal from hard steering at speed, squared so gentle corrections
    // stay silent; a spinning car's wheels aren't gripping, so no squeal.
    const double fastGate = clamp01((c.spd - 0.45) / 0.3);
    voice(out, "corner", c.id, truthy(c.spin) ? 0 : c.steer * c.steer * fastGate, nullptr);
    voice(out, "brake", c.id, c.brake * clamp01((c.spd - 0.2) / 0.4), nullptr);
    // Engine voice — pitch + level rise with speed (recorded loop, RPM=rate).
    // While a monster truck, the same loop deepens into a big-truck growl.
    voice(out, "engine_putt", c.id, clamp01(c.spd / 1.2),
          c.monster ? &MONSTER_ENGINE_MOD : nullptr);
  }
  // the nearest scrub owns the shared throttle
  if (haveScrub) screech(out, scrubSpd, scrubG, nowMs);

  // Rocket flight: a sustained jet per in-flight rocket, held the whole air
  // time, its level set by the SAME audibility curve as every other world cue.
  // Voices stop when a rocket leaves the snapshot (hit/expired) or drifts out of
  // every human's earshot.
  seen_.clear();
  for (const Rocket& r : rockets) {
    bool dup = false;
    for (const Id& s : seen_) if (s == r.id) { dup = true; break; }
    if (!dup) seen_.push_back(r.id);
    voice(out, "rocket_fire", r.id, clamp01(audibility(r.hasPos ? &r.pos : nullptr, humans_)), nullptr);
  }
  for (const Id& id : rockets_) {
    bool live = false;
    for (const Id& s : seen_) if (s == id) { live = true; break; }
    if (!live) voice(out, "rocket_fire", id, 0, nullptr);
  }
  rockets_ = seen_;
  humans_.clear();  // it points into the caller's `cars`; never hold that past the call
}

// intensity = how hard the scrub (from speed); dist = the shared throttle's
// spatial attenuation in [0,1].
void Decider::screech(std::vector<Command>& out, double intensity, double dist, double nowMs) {
  if (nowMs - lastScreech_ < SCREECH_GAP_MS) return;
  lastScreech_ = nowMs;
  Command c;
  c.kind = Command::CUE;
  c.name = "screech";
  c.gain = js_max(0.3, js_min(1.0, intensity)) * dist;
  out.push_back(std::move(c));
}

void Decider::lap(std::vector<Command>& out, double nowMs) {
  if (nowMs - lastLap_ < LAP_GAP_MS) return;
  lastLap_ = nowMs;
  Command c;
  c.kind = Command::CUE;
  c.name = "lap";
  c.gain = 1;
  out.push_back(std::move(c));
}

namespace {
Command cue(const char* name, double gain) {
  Command c;
  c.kind = Command::CUE;
  c.name = name;
  c.gain = gain;
  return c;
}
}  // namespace

void Decider::event(const ttp::Event& e, const Point* pos, const Listeners& humans,
                    const AiIds& aiIds, double nowMs, std::vector<Command>& out) {
  const bool hasId = !e.id.isNull();
  const bool isAi = hasId && aiIds.has(e.id);
  const bool isHuman = !isAi;
  // AUD_PEAK for the player's own car / idless cues, distance-scaled for CPUs.
  const double g = !hasId ? AUD_PEAK : audibility(pos, humans);

  if (e.type == "pickup") {
    // A finished car has no HUD item slot to narrate, so its victory-lap grabs
    // play just the world pop (like a CPU grab) — never the player roulette.
    if (isHuman && !e.finished) {
      out.push_back(cue("pickup", 1));
      out.push_back(cue("roulette", 1));
    } else if (g > 0) {
      out.push_back(cue("pickup", g));  // any other grab: world pop, by distance
    }
    return;
  }
  // (boost item-use and pad crossings make no one-shot sound — the boost WIND in
  // frame() tracks the resulting speed state instead.)
  if (e.type == "item_use") {
    // the rocket's launch+flight is a SUSTAINED voice driven per-frame in
    // frame(), not a one-shot here; boost item-use stays silent.
    if (g > 0 && e.item == "banana") out.push_back(cue("banana_drop", g));
    else if (g > 0 && e.item == "monster") out.push_back(cue("monster_inflate", g));
    return;
  }
  // The monster transform lapsing back to a car: the deflate sputter.
  if (e.type == "monster_end") {
    if (g > 0) out.push_back(cue("monster_deflate", g));
    return;
  }
  if (e.type == "spin") {
    // rocket -> boom (its own distance metric, kept in step with the flight);
    // oil/banana -> comedy slip (oil shares the comedy cue).
    if (e.cause == "rocket") {
      const double lvl = rocketImpactLevel(pos, isAi, humans);
      if (lvl > 0) out.push_back(cue("rocket_hit", clamp01(lvl)));
    } else if (g > 0) {
      out.push_back(cue("banana_slip", g));
    }
    return;
  }
  // The chequered-flag crossing chimes like any other lap; the results overlay
  // carries the celebration.
  if (e.type == "lap" || e.type == "finish") {
    if (isHuman) lap(out, nowMs);
    return;
  }
  // A rocket self-destructing at the end of its flight (a whiff): detonate at
  // its track point, scaled by distance to the nearest human.
  if (e.type == "rocket_expire") {
    const double lvl = audibility(pos, humans);
    if (lvl > 0) out.push_back(cue("rocket_hit", clamp01(lvl)));
    return;
  }
  // Anything else: no sound. (The JS switch has no default; an unknown type
  // falls through it and returns an empty array.)
}

void Decider::countdown(int n, std::vector<Command>& out) {
  if (n < 0) return;
  Command c;
  c.kind = Command::COUNTDOWN;
  c.name = "countdown";
  c.goBeat = !(n > 0);
  out.push_back(std::move(c));
}

void Decider::roster(int count, bool inLobby, std::vector<Command>& out) {
  const bool grew = count > rosterCount_;
  rosterCount_ = count;
  if (grew && inLobby) out.push_back(cue("join", 1));
}

void Decider::stopVoices(std::vector<Command>& out) {
  voices_.clear();
  rockets_.clear();
  Command c;
  c.kind = Command::STOP_ALL;
  c.name = "stop-all";
  out.push_back(std::move(c));
}

void Decider::stopCar(const Id& id, std::vector<Command>& out) {
  // JS: `key.endsWith(':' + id)`. Reproduced as a suffix test, not as an id
  // field on the voice, because that IS the rule the corpus recorded.
  const std::string suffix = ":" + id.key();
  for (size_t i = voices_.size(); i > 0; i--) {
    const std::string& k = voices_[i - 1];
    if (k.size() >= suffix.size() && k.compare(k.size() - suffix.size(), suffix.size(), suffix) == 0)
      voices_.erase(voices_.begin() + (ptrdiff_t)(i - 1));
  }
  Command c;
  c.kind = Command::STOP_CAR;
  c.name = "stop-car";
  c.id = id;
  out.push_back(std::move(c));
}

void Decider::startMusic(const std::string& biome, std::vector<Command>& out) {
  const MusicPool* pool = &musicFallback();
  for (int i = 0; i < RACE_MUSIC_COUNT; i++) {
    if (biome == RACE_MUSIC[i].biome && RACE_MUSIC[i].count) { pool = &RACE_MUSIC[i]; break; }
  }
  // The no-repeat filter, in pool order — but only when the pool has an
  // alternative, so a one-song pool still plays.
  std::vector<const Song*> fresh;
  if (pool->count > 1) {
    for (int i = 0; i < pool->count; i++) {
      if (musicFile_ != pool->songs[i].file) fresh.push_back(&pool->songs[i]);
    }
  } else {
    for (int i = 0; i < pool->count; i++) fresh.push_back(&pool->songs[i]);
  }
  // Unreachable: a pool's files are distinct, so a >1 pool always keeps one.
  // Here so a mis-authored pool degrades to a repeated song rather than to UB
  // (the JS would index `undefined` and throw).
  if (fresh.empty()) for (int i = 0; i < pool->count; i++) fresh.push_back(&pool->songs[i]);
  // `(rng() * fresh.length) | 0` — ToInt32 of a value in [0, length), which is
  // truncation toward zero (fp-profile §3.3; the operand can never reach the
  // 2^31 wrap).
  const int32_t idx = (int32_t)(rng_() * (double) fresh.size());
  const Song* pick = fresh[(size_t) idx];
  nowPlaying_ = pick;
  musicFile_ = pick->file;
  Command c;
  c.kind = Command::MUSIC;
  c.name = "start";
  c.song = pick;
  // `pick.gain || 1` — JS falsy-OR on a number, so a 0 (or absent) trim plays
  // at the bed height rather than silently (fp-profile §3.5b).
  c.level = MUSIC_LEVEL * (pick->gain != 0 ? pick->gain : 1);
  out.push_back(std::move(c));
}

void Decider::stopMusic(std::vector<Command>& out) {
  Command c; c.kind = Command::MUSIC; c.name = "stop"; out.push_back(std::move(c));
}
void Decider::pauseMusic(std::vector<Command>& out) {
  Command c; c.kind = Command::MUSIC; c.name = "pause"; out.push_back(std::move(c));
}
void Decider::resumeMusic(std::vector<Command>& out) {
  Command c; c.kind = Command::MUSIC; c.name = "resume"; out.push_back(std::move(c));
}

}  // namespace audio
}  // namespace rt
}  // namespace ttp
