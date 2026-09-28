// audio — the display's audio DECISIONS, in C++.
//
// This is public/display/audio/decide.js, ported. Every "should a sound happen,
// which one, and how loud" rule the display owns, as a pure function of PLAIN
// DATA -> a stream of audio COMMANDS. It touches no audio device, no DOM, no
// clock and no global: the clock arrives as `nowMs` on every call and the RNG is
// injected at construction, exactly as it is in the JS.
//
// AUDIO IS TWO HALVES AND ONLY THIS ONE IS HERE. The DEVICE half — the
// AudioContext, the limiter, the baked cue palette, the <audio> element — stays
// per-platform and DECIDES NOTHING (shared-cpp-plan.md: the DSP palette is
// BAKED, not ported, because emscripten's AudioWorklet path needs the COOP/COEP
// isolation this deployment refuses). A shell performs the commands below and
// nothing else.
//
// CONFORMANCE. tests/fixtures/audio-corpus.jsonl — 5900 trace frames over five
// golden traces plus 497 scripted steps — was recorded off the live decide.js in
// P5, which makes it JS-RECORDED cross-implementation evidence: class 1 in
// tests/fixtures/traces/README.md, the only class that can settle a parity
// question. runtimetest/audio_check.cc replays every line of it through this
// header on all four legs. A disagreement is a bug HERE, never in the corpus.
//
// FLOATING POINT. Everything is double, matching JS Number, and every operation
// order is the JS's. Two rules are load-bearing enough that the corpus was
// re-recorded to make them portable (commit 9c635c2):
//   - Distance is std::sqrt(dx*dx + dy*dy + dz*dz), IN THAT ORDER, and NEVER
//     std::hypot. sqrt is the one transcendental IEEE-754 requires correctly
//     rounded, so it is bit-identical everywhere; hypot is not, and fdlibm's is
//     2-argument so composing it is a different rounding again. One ULP on `d`
//     flips `d <= AUD_NEAR` and changes the command outright.
//   - The music trims are AUTHORED LITERALS, not `pow(10, x)`. Deriving them
//     would hand the port two songs (lufs -15.7 and -15.3) it could never match.
// Math.max/Math.min go through js_max/js_min (fp-profile §3.4); the sum must not
// contract into an FMA, which is what ttp_strict_fp's -ffp-contract=off is for.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "ttp/game.h"        // ttp::Id, ttp::Event — the sim's own identity and event
#include "ttp/scalar_id.h"

namespace ttp {
namespace rt {
namespace audio {

// ---- spatial audio: world-cue loudness by 3D distance to the nearest human ---
// The split-screen cells ARE the listeners: each shows one human car, so a world
// sound is loud when it happens next to a human and fades with straight-line
// WORLD distance to the nearest one — never gating hard to silence inside the
// scene, so distant action stays present, just quiet. One curve, shared by every
// world cue (curb scrub, grabs, banana, spin, rocket).
inline constexpr double AUD_PEAK = 0.7;   // loudness at point-blank (<= AUD_NEAR) — the ceiling
                                          //   for EVERY world cue (HUD cues bypass it)
inline constexpr double AUD_NEAR = 8;     // within this many world units of a human -> AUD_PEAK
inline constexpr double AUD_FAR = 34;     // by here it has faded to the distance FLOOR
inline constexpr double AUD_FLOOR = 0.18; // quietest a still-in-scene source gets
inline constexpr double AUD_CUT = 64;     // past here: out of the scene -> silent

// A sustained voice below this level is not running at all: it starts when its
// level first rises above the floor and dies when it falls back.
inline constexpr double VOICE_FLOOR = 0.02;
inline constexpr double SCREECH_GAP_MS = 140;  // min spacing so curb contact can't machine-gun
inline constexpr double LAP_GAP_MS = 350;      // min spacing between lap chimes
// A wall-grind only counts as a scrub above this speed — below it the car is
// leaning on the barrier, not scraping along it.
inline constexpr double SCRUB_SPD_MIN = 0.35;

// The monster-truck engine: the same recorded loop, pitch down, a touch louder,
// top end muffled.
struct Mod { double rateMul, gainMul, lpMul; };
inline constexpr Mod MONSTER_ENGINE_MOD = {0.6, 1.45, 0.82};

// ---- plain data in ----------------------------------------------------------

struct Point { double x = 0, y = 0, z = 0; };

// The listeners: one entry per human car, in car order. A NULL entry is a car
// with no live pose and is skipped, exactly as decide.js's `if (!hp) continue`
// skips the `undefined` its `c.pose && c.pose.pos` pushes.
using Listeners = std::vector<const Point*>;

// The AI/human split. decide.js takes a Set of car ids; membership is the only
// thing asked of it, and identity is the sim's own (a number id and a string id
// are different cars, ScalarId's whole job).
struct AiIds {
  std::vector<Id> ids;
  bool has(const Id& id) const {
    for (const Id& x : ids) if (x == id) return true;
    return false;
  }
  void add(const Id& id) { if (!has(id)) ids.push_back(id); }
};

// A car, exactly the fields the decisions read off a snapshot car. `steer` is
// the snapshot's signed value (STEER_SIGN applied); it is squared here, so the
// sign is dead — carried as the snapshot spells it rather than re-derived.
struct Car {
  Id id;
  bool hasPos = false;
  Point pos;                 // pose.pos
  double spd = 0;            // v / vmax
  double steer = 0;
  double brake = 0;
  double boostMul = 1;
  double spin = 0;
  bool monster = false;
  bool onWall = false;
};

// An in-flight rocket. `pos` is the rocket's WORLD point, resolved the same way
// cars are posed, so the jet and its boom are measured in one metric.
struct Rocket {
  Id id;
  bool hasPos = false;
  Point pos;
};

// A song descriptor. The attribution fields (title, artist, license, `source`)
// are what the Licenses board is baked from — the CC-BY attribution for Kevin
// MacLeod's tracks, see public/assets/audio/music/CREDITS.txt. Nothing shows
// them during a race. `duration` is whole seconds, baked so a gallery can show
// a song's length without loading its metadata (the race itself never reads it).
struct Song {
  const char* file;
  const char* title;
  int duration;
  double lufs;   // the file's integrated EBU R128 loudness, measured at wiring time
  double gain;   // the AUTHORED trim to MUSIC_TARGET_LUFS — a literal, never pow()
  const char* artist;
  const char* license;
  const char* source;
};

// ---- the command vocabulary -------------------------------------------------
// One value per command, emitted in the order the shell must perform them. The
// JSON spelling beside each arm is what audio-corpus.jsonl records and what
// Audio.js already performs.
struct Command {
  enum Kind {
    CUE,         // {cue, gain}                 one-shot at linear gain
    COUNTDOWN,   // {cue:"countdown", part}     the countdown's two beats
    VOICE,       // {voice, id, level[, mod]}   start if not running, then set level
    VOICE_STOP,  // {voice, id, stop:true}      stop and free it
    STOP_ALL,    // {voices:"stop-all"}         kill every live voice
    STOP_CAR,    // {voices:"stop-car", id}     kill one car's voices
    MUSIC,       // {music:"start", song, level} | {music:"stop"|"pause"|"resume"}
  };
  Kind kind = CUE;
  const char* name = "";       // cue name / voice name / music op — always a literal
  double gain = 0;             // CUE
  Id id;                       // VOICE, VOICE_STOP, STOP_CAR
  double level = 0;            // VOICE, MUSIC "start"
  const Mod* mod = nullptr;    // VOICE — the monster-truck timbre, or none
  const Song* song = nullptr;  // MUSIC "start"
  bool goBeat = false;         // COUNTDOWN — the GO beat rather than a tick
};

// ---- the distance model (exported: the corpus pins these directly) ----------

// Min straight-line world distance from `p` to any listener (infinity with no
// listeners / no live poses).
double nearestHumanDist(const Point& p, const Listeners& humans);

// Loudness in [0, AUD_PEAK] for a world cue at `p`. A human's own car is at
// distance 0 -> AUD_PEAK, so this needs no human/CPU branch. `p == nullptr`
// (a source already gone) plays at the ceiling rather than dropping the cue.
double audibility(const Point* p, const Listeners& humans);

// Loudness of a rocket IMPACT, kept CONSISTENT with the flight so you never get
// a jet that fades in with no boom, with a payoff floor so an audible jet always
// lands an audible boom. 0 only when the impact is out of every listener's
// earshot. `pos == nullptr` = the target is already gone — just play it.
double rocketImpactLevel(const Point* pos, bool targetIsAi, const Listeners& humans);

// ---- background music -------------------------------------------------------
// Keyed by BIOME name (ttp::rt::Theme's, over the same palette tables — the
// Backyard cup resolves to 'grass'). Each biome holds a POOL of songs that share
// its mood. Unlisted/empty biomes (currently just the cupless 'sunset') fall
// back to the neutral ex-global pool rather than to silence.
struct MusicPool {
  const char* biome;
  const Song* songs;
  int count;
};
extern const MusicPool RACE_MUSIC[];
inline constexpr int RACE_MUSIC_COUNT = 5;
const MusicPool& musicFallback();  // == RACE_MUSIC["snow"]

// The common loudness target every song's `gain` trims its file to. Not read by
// the decisions — it is the authored REASON for each literal, and what
// tests/credits.test.js re-runs the derivation against.
inline constexpr double MUSIC_TARGET_LUFS = -19.2;
// The bed height under the SFX. It rides the master gain, so the volume slider
// scales it too.
inline constexpr double MUSIC_LEVEL = 0.51;

// ---- the decider ------------------------------------------------------------
// Holds the small amount of state these rules need across calls: which sustained
// voices are live, the two one-shot spacing clocks, the last song (so the
// shuffle can avoid repeating it) and the last roster size. Everything else is
// derived from the arguments.
//
// Every entry point APPENDS to `out` rather than returning a fresh vector: a
// frame's event commands and its voice commands concatenate in exactly that
// order, which is the order the shell must perform them, and a reused buffer
// keeps the per-frame path allocation-free.
class Decider {
 public:
  // `rng` is the [0,1) source the music shuffle draws from — and the ONLY
  // randomness in here. Empty means the platform RNG (the shipped path); the
  // conformance corpus injects a seeded mulberry32 so the picks are recordable.
  explicit Decider(std::function<double()> rng = {});

  // ---- per-frame drive ----
  // `cars` iteration order is the emission order. `nowMs` is the monotonic
  // clock, for the one-shot spacing gates.
  void frame(const std::vector<Car>& cars, const std::vector<Rocket>& rockets,
             const AiIds& aiIds, double nowMs, std::vector<Command>& out);

  // ---- race events ----
  // `pos` is the event's source world point, or null: the car's own point for a
  // car event (null = that car is already gone), the rocket's track point for
  // 'rocket_expire'. `humans` is every human car's world point (the listeners).
  void event(const ttp::Event& e, const Point* pos, const Listeners& humans,
             const AiIds& aiIds, double nowMs, std::vector<Command>& out);

  // RaceSession's 1 Hz countdown: n > 0 ticks, n == 0 is the GO beat, n < 0 is
  // the banner-clearing beat and makes no sound.
  void countdown(int n, std::vector<Command>& out);

  // A bigger roster means someone joined (renames and car picks keep the count).
  // Lobby only; mid-race arrivals are reconnects.
  void roster(int count, bool inLobby, std::vector<Command>& out);

  // ---- voice lifecycle ----
  // Kill all live voices — pause, race end, return to lobby. Without this a
  // frozen frame would hold its sounds forever (frame() stops updating levels).
  void stopVoices(std::vector<Command>& out);
  // One car left the race (forfeit) or changed id (cross-device rejoin) —
  // frame() will never feed that id a zero level, so kill its voices here.
  void stopCar(const Id& id, std::vector<Command>& out);

  // ---- music ----
  // Ambient, not a cue: the race song plays globally for the whole race (it does
  // NOT follow the visible-events rule the SFX do). Picks from the biome's pool
  // — random, but never the song that just played (across races AND biomes) when
  // there is an alternative, so a 4-race GP through one biome rotates its pool.
  // An empty/unknown biome takes the fallback pool.
  void startMusic(const std::string& biome, std::vector<Command>& out);
  void stopMusic(std::vector<Command>& out);
  void pauseMusic(std::vector<Command>& out);
  void resumeMusic(std::vector<Command>& out);

 private:
  void voice(std::vector<Command>& out, const char* cue, const Id& id, double level,
             const Mod* mod);
  void screech(std::vector<Command>& out, double intensity, double dist, double nowMs);
  void lap(std::vector<Command>& out, double nowMs);

  std::function<double()> rng_;
  std::vector<std::string> voices_;   // 'cue:id' of every voice believed to be running
  std::vector<Id> rockets_;           // rocket ids that had a jet voice last frame
  std::vector<Id> seen_;              // scratch: this frame's rocket ids
  Listeners humans_;                  // scratch: the listeners, rebuilt per frame
  double lastScreech_;
  double lastLap_;
  std::string musicFile_;             // last picked song's file ("" = none yet)
  int rosterCount_ = 0;
};

// The C++ `Math.random`: the source Decider draws from when none is injected.
// The shipped path's RNG, and never on a byte path — the corpus injects instead.
double platform_random();

}  // namespace audio
}  // namespace rt
}  // namespace ttp
