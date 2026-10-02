// camera — the per-player spring chase rig, lifted verbatim out of
// runtime/ttp_display.cc (DELETED — git history has it). The tuning comments here are the reference
// documentation for every constant; they came across untouched.
#pragma once

#include <vector>

#include "ttp/ground_grid.h"
#include "ttp/name_tags.h"
#include "ttp/vecmath.h"
#include "ttp_render.h"

namespace ttp {

struct Pose;  // ttp/game.h — a reference parameter needs no definition here

namespace rt {

// ---------------------------------------------------------------------------
// The per-player spring chase camera — an exact port of ChaseCamera.js, whose
// tuning comments are the reference for every constant here.
//
// Close chase sitting LOW and just behind the car with a fairly tight lens, so
// the camera stays comfortable to drive rather than steeply top-down.
// ---------------------------------------------------------------------------
// DIST SETS THE PARKED SHOT ALONE, because the spring's lag is ~v/rate and so
// is zero at a standstill. A notch here moves the grid and the race together and
// never the gap between them; that gap is CAM_POS_RATE's.
//
// DIST AND LOOK ARE ONE BASELINE: the pitch is
// atan((HEIGHT - TGT_UP) / (LOOK + DIST)), so only the SUM (2.85) steers the
// aim. Move one alone and the picture noses over — a 0.35 cut to DIST by itself
// takes the pitch 10.5 -> 12.0 degrees. HEIGHT is in that numerator but is not
// the lever for it: it is what sees over the car, and trading it away hides the
// road ahead. So a closer camera is DIST down and LOOK up by the same amount.
constexpr float CHASE_DIST = 1.15f, CHASE_HEIGHT = 0.64f, CHASE_LOOK = 1.7f;
constexpr float CHASE_TGT_UP = 0.11f;      // look point barely above the road
// 7 -> 32. This one constant decides both how far back the camera sits while
// racing and how far that is from the parked shot, which never lags at all: the
// eye's lag behind its parked place fell 0.44 -> 0.20u flat out, and that is
// v/rate, so it holds whatever DIST is. It cost the swing — at 30% throttle the
// lag is 0.08 where it was 0.33, leaving the spd² shaping below a trim on a
// large base rather than the main event.
constexpr float CAM_POS_RATE = 32.0f, CAM_TGT_RATE = 13.0f;  // damping (1/s)
// The position spring lags the car by ~velocity/rate, so the faster you go the
// further back the camera sits. The follow rate therefore climbs with spd²:
// fast straights and boosts tighten and stay glued (the car stays big), while
// slow corners keep the base rate and its looser swing-behind.
constexpr float CAM_POS_RATE_SPD = 13.0f;
// How far past flat-out ANY overspeed cue tracks: the rate above and the boost
// lens below. Monster + boost reaches spd 1.875 and neither should follow it out
// there.
constexpr float CAM_RATE_SPD_MAX = 1.6f;
constexpr float BASE_FOV = 55.0f;
// Sense of speed, no shake: the FOV widens with speed. Asymmetric — it kicks
// wide fast (a boost lands as a hit) and eases back slow (running out of boost
// is a taper, not a snap).
//
// TWO GAINS. `spd` is normalised to the car's own vmax, so ordinary driving is
// 0..1 and only a boost or the monster truck passes it: FOV_GAIN rides all of
// `spd` and stays small, since every degree of it is variation in NORMAL
// driving, while FOV_BOOST_GAIN rides the OVERSPEED alone and is zero until
// then. The lens carries the boost by itself because the chase cannot —
// CAM_POS_RATE_SPD makes the follow rate climb faster than the car does, so a
// boost TIGHTENS the spring (lag 0.200 flat out, 0.220 boosting) rather than
// stretching it. 12 puts an item boost at 67 degrees against 59.
constexpr float FOV_GAIN = 4.0f, FOV_RISE = 9.0f, FOV_FALL = 3.0f;
constexpr float FOV_BOOST_GAIN = 12.0f;
constexpr float CHASE_DIST_GAIN = 0.06f;
constexpr float CAM_NEAR = 0.1f, CAM_FAR = 600.0f;

struct ChaseCam {
    V3 pos, target;
    float fov = BASE_FOV;
    bool init = false;  // first update snaps, so it doesn't lag in from the origin

    void update(const ttp::Pose& pose, float spd, float dt);
};

// ---------------------------------------------------------------------------
// The FOLLOW overview (TTP_CAM_FOLLOW): a low camera on the lead battle, for
// trailer shots. Nothing in the game asks for it.
//
// IT LOOKS INWARD. The scenery is dressed along the track, so the busy
// background is the rest of the circuit, and the empty one is whatever lies
// outside it. The camera therefore stands OUTSIDE the battle and faces the
// track's centre across it, swung FOLLOW_LEAD toward the cars' front so the
// field drives at the lens rather than away. Nothing turns it on a clock: as
// the battle goes round the circuit the inward direction turns with it, so the
// camera sweeps because the race does.
//
// THE BATTLE is the leader plus every car within FOLLOW_GAP of it in track
// progress (totalS, laps included), so a lapped car beside the leader is not in
// it and a car a straight behind is. The camera aims at the battle's centre,
// far enough out that the battle fits the lens.
//
// EVERYTHING MOVES ON SPRINGS: the aim, the yaw, the distance and the pitch are
// each a critically damped spring, which gathers speed and sheds it rather
// than starting at full speed the frame its goal moves — the jolt a plain ease
// puts into every new heading. Only a cut (below) jumps.
//
// NO SPEED LAG. A spring on the aim point alone would trail the cars by
// v/omega, a car length per tenth of a second, and the leader would drive out
// of frame. So the aim is carried along at the leader's velocity, SMOOTHED
// (FOLLOW_FLOW_RATE) so its steering wobble does not shake the shot, and the
// spring only pulls it onto the battle's centre: at a steady speed it sits
// exactly there. A change of leader does not jolt it, because the new
// leader's velocity is read off ITS last position, not the old leader's.
//
// KEEPING THE BATTLE IN SIGHT. A bridge between the camera and the cars would
// fill the shot with its underside, so every frame the rig tries its pitches in
// FOLLOW_PITCHES order — its own first, then LOWER, which is what slips under a
// bridge ahead, and only then higher — and eases toward the first one from
// which neither the road deck nor the ground hides any car in the battle,
// whose eye is FOLLOW_LENS_CLEAR off both (a lens that grazes a bridge or a
// slope fills the frame with it), and from which no HILL climbs too far up the
// shot: along the near FOLLOW_HILL_REACH of the line to the battle, ground that
// rises over the ground under the battle must stay below FOLLOW_HILL_ROW of
// the frame's lower half. The ground the road runs across is not a hill, so a
// flat field leading up to the cars never counts. With none clear it stays on
// FOLLOW_PITCH. A KERB is the softer rule, since a low side view across the
// road edge films the cars half behind it: among the clear pitches the first
// from which no kerb hides any FOLLOW_KERB_AIMS point of a battle car wins,
// else the one hiding fewest of them. When the way from where the eye is to where it wants to be
// crosses a deck — above a bridge to under it — easing would fly the lens
// through the road, so it CUTS there instead. Pillars, props and scenery are
// not modelled.
//
// The facing is a YAW, eased the short way round. A leader pointing up a loop
// has no level heading, so the blend keeps the last one it had; a battle at the
// track's very centre has no inward, and drops out of the blend.
// ---------------------------------------------------------------------------
constexpr float FOLLOW_GAP = 4.0f;          // track units behind the leader (~0.3 s flat out)
constexpr float FOLLOW_MARGIN = 0.8f;       // added to the battle's radius: a car is not a point
constexpr float FOLLOW_MIN_R = 1.8f, FOLLOW_MAX_R = 6.0f;   // fitted radius clamp
constexpr float FOLLOW_PITCH = 0.3f;        // rad below level (~17 degrees)
// The pitches tried, in order of preference; the first is FOLLOW_PITCH.
constexpr float FOLLOW_PITCHES[] = { FOLLOW_PITCH, 0.2f, 0.1f, 0.03f, 0.45f, 0.6f, 0.8f };
constexpr float FOLLOW_AIM_UP = 0.25f;      // where on a car the sight line ends: its body, not its wheels
// The points tested against a kerb, in units up the car's up axis: its wheels
// first (the tests read [0] as wheel height), then its body and its roof.
constexpr float FOLLOW_KERB_AIMS[] = { 0.1f, 0.2f, 0.3f };
constexpr float FOLLOW_CAR_CLEAR = 0.6f;    // the deck a car is on never hides it (as for name tags)
constexpr float FOLLOW_LENS_CLEAR = 1.0f;   // how far off any deck, and over the ground, the eye must stay
constexpr float FOLLOW_HILL_REACH = 0.6f;   // the near part of the line where a hill is foreground
constexpr float FOLLOW_HILL_ROW = 0.33f;    // ...whose top must stay this far down the lower half-frame
constexpr float FOLLOW_HILL_RISE = 0.5f;    // ground this far over the battle's own ground is a hill
constexpr int FOLLOW_SIGHT_STEPS = 24;      // samples along a sight line against the ground
constexpr float FOLLOW_LEAD = 0.5f;         // rad from facing inward toward facing the cars' fronts
constexpr float FOLLOW_FOV = 50.0f;
// The springs' natural frequencies (rad/s): a spring settles in about 5/omega.
// The pitch is the quickest — it has a bridge to get under, or a kerb to see
// over, before it passes.
constexpr float FOLLOW_AIM_OMEGA = 3.0f, FOLLOW_YAW_OMEGA = 1.8f, FOLLOW_DIST_OMEGA = 1.5f,
                FOLLOW_PITCH_OMEGA = 5.0f;
constexpr float FOLLOW_FLOW_RATE = 4.0f;    // 1/s, how fast the carried velocity follows the leader's

struct FollowCam {
    V3 pos, target;
    float yaw = 0, dist = 0;  // yaw: the direction the camera FACES, atan2(x, z)
    float pitch = FOLLOW_PITCH;
    // The springs' velocities, and the leader's smoothed velocity the aim rides on.
    V3 aimVel, flow;
    float yawVel = 0, distVel = 0, pitchVel = 0;
    V3 back = { 0, 0, -1 };   // the leader's last LEVEL heading, reversed and flattened
    bool init = false;
    std::vector<V3> last;    // each slot's position last frame (the leader's displacement)...
    std::vector<bool> seen;  // ...valid only where the slot held a car last frame

    // `live[i]` says slot i holds a car this frame; `cars` is the frame's own
    // car input, so a held field is followed where it is DRAWN. `trackCentre`
    // is Framing::center, what the camera looks in toward; `deck` and `ground`
    // are what it keeps the battle out from behind.
    void update(const TtpCarInput* cars, const std::vector<bool>& live, V3 trackCentre,
                const NameTagDeck& deck, const GroundGrid& ground, float dt);
};

}  // namespace rt
}  // namespace ttp
