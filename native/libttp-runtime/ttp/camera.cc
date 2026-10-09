#include "ttp/camera.h"

#include <climits>
#include <cmath>
#include <utility>

#include "ttp/game.h"

namespace ttp {
namespace rt {

void ChaseCam::update(const ttp::Pose& pose, float spd, float dt, bool monster, float height,
                      float rise, float back) {
    const V3 p = v3(pose.pos), fwd = v3(pose.forward), up = v3(pose.up);
    const float blendRate = monster ? MONSTER_CAM_UP : MONSTER_CAM_DOWN;
    monsterBlend += ((monster ? 1.0f : 0.0f) - monsterBlend) * (1 - std::exp(-blendRate * dt));
    const V3 want = p + fwd * -(CHASE_DIST + CHASE_DIST_GAIN * spd + monsterBlend * back)
                  + up * (height + monsterBlend * rise);
    const V3 wantTgt = p + fwd * CHASE_LOOK + up * CHASE_TGT_UP;
    // Frame-rate-independent damping → smooth lag/swing behind through turns.
    const float rateSpd = spd < CAM_RATE_SPD_MAX ? spd : CAM_RATE_SPD_MAX;
    const float aPos = 1 - std::exp(-(CAM_POS_RATE + CAM_POS_RATE_SPD * rateSpd * rateSpd) * dt);
    const float aTgt = 1 - std::exp(-CAM_TGT_RATE * dt);
    if (!init) { pos = want; target = wantTgt; init = true; }
    else { pos = lerp(pos, want, aPos); target = lerp(target, wantTgt, aTgt); }
    // Overspeed only, off the already-clamped rateSpd (see FOV_BOOST_GAIN).
    const float over = rateSpd > 1 ? rateSpd - 1 : 0;
    const float fovTarget = BASE_FOV + spd * FOV_GAIN + over * FOV_BOOST_GAIN;
    const float fovRate = fovTarget > fov ? FOV_RISE : FOV_FALL;
    fov += (fovTarget - fov) * (1 - std::exp(-fovRate * dt));
}

namespace {

constexpr float PI = 3.14159265f;

// One step of a critically damped spring of natural frequency `w` toward
// `goal` — the exact solution, so it is stable at any dt.
void spring(float& x, float& v, float goal, float w, float dt) {
    const float e = std::exp(-w * dt), d = x - goal, k = (v + w * d) * dt;
    v = (v - w * k) * e;
    x = goal + (d + k) * e;
}

}  // namespace

float chasePitchDeg(float height, float back) {
    return std::atan((height - CHASE_TGT_UP) / (CHASE_DIST + back + CHASE_LOOK)) * 180.0f / PI;
}

float chaseHeightForPitch(float deg, float back) {
    return CHASE_TGT_UP + std::tan(deg * PI / 180.0f) * (CHASE_DIST + back + CHASE_LOOK);
}

float authoredMonsterPitch() {
    return chasePitchDeg(CHASE_HEIGHT + MONSTER_CAM_RISE, MONSTER_CAM_BACK);
}

void FollowCam::update(const TtpCarInput* cars, const std::vector<bool>& live, V3 trackCentre,
                       const NameTagDeck& deck, const GroundGrid& ground, float dt) {
    const size_t n = live.size();
    int lead = -1;
    for (size_t i = 0; i < n; i++) {
        if (live[i] && (lead < 0 || cars[i].trackS > cars[lead].trackS)) lead = (int) i;
    }
    if (lead < 0) return;  // no field: stay wherever the last one left it
    auto at = [&](size_t i) { return V3{ cars[i].pos.x, cars[i].pos.y, cars[i].pos.z }; };
    const float battleFrom = cars[lead].trackS - FOLLOW_GAP;
    auto inBattle = [&](size_t i) { return live[i] && cars[i].trackS >= battleFrom; };

    V3 centre;
    int count = 0;
    for (size_t i = 0; i < n; i++) {
        if (inBattle(i)) {
            centre = centre + at(i);
            count++;
        }
    }
    centre = centre * (1.0f / (float) count);
    float r = 0;
    for (size_t i = 0; i < n; i++) {
        if (!inBattle(i)) continue;
        const V3 d = at(i) - centre;
        r = std::fmax(r, std::sqrt(dot(d, d)));
    }
    r = std::fmin(FOLLOW_MAX_R, std::fmax(FOLLOW_MIN_R, r + FOLLOW_MARGIN));
    // Back far enough that a sphere of radius r fills the vertical fov.
    const float halfFov = std::tan(FOLLOW_FOV * 0.5f * PI / 180.0f);
    const float wantDist = r / halfFov;

    // Face inward across the battle, swung toward the cars' fronts.
    V3 in = trackCentre - centre;
    in.y = 0;
    const TtpVec3& f = cars[lead].forward;
    const V3 flat = { -f.x, 0, -f.z };
    if (dot(flat, flat) > 0.04f) back = norm(flat);  // else pointing up or down a loop
    const bool hasIn = dot(in, in) > 1.0f;           // not AT the track's centre
    const V3 face = (hasIn ? norm(in) * std::cos(FOLLOW_LEAD) : V3{}) + back * std::sin(FOLLOW_LEAD);
    const float wantYaw = std::atan2(face.x, face.z);

    // The eye a pitch puts us at, from the aim and the eased yaw and distance.
    auto eyeAt = [&](float p) {
        const float out = dist * std::cos(p);
        return V3{ target.x - std::sin(yaw) * out, target.y + dist * std::sin(p),
                   target.z - std::cos(yaw) * out };
    };
    // Does the ground stand between `eye` and `p`, short of the last `farClear`?
    auto groundBlocks = [&](V3 eye, V3 p, float farClear) {
        const V3 d = p - eye;
        const float len = std::sqrt(dot(d, d));
        if (len <= farClear) return false;
        const float tEnd = 1 - farClear / len;
        for (int k = 1; k < FOLLOW_SIGHT_STEPS; k++) {
            const float t = tEnd * (float) k / FOLLOW_SIGHT_STEPS;
            const V3 q = eye + d * t;
            if (q.y < ground.at(q.x, q.z)) return true;
        }
        return false;
    };
    // Does a hill climb too far up the shot from `eye`? Measured on the line to
    // the aim, which is the frame's centre row.
    const float battleGround = ground.at(target.x, target.z);
    auto hillTooHigh = [&](V3 eye) {
        const V3 d = target - eye;
        const float len = std::sqrt(dot(d, d));
        for (int k = 1; k <= FOLLOW_SIGHT_STEPS; k++) {
            const float t = FOLLOW_HILL_REACH * (float) k / FOLLOW_SIGHT_STEPS;
            const V3 q = eye + d * t;
            const float g = ground.at(q.x, q.z);
            if (g < battleGround + FOLLOW_HILL_RISE) continue;  // not a hill
            // How far below the centre row its top shows, in half-frames.
            if ((q.y - g) / (t * len * halfFov) < FOLLOW_HILL_ROW) return true;
        }
        return false;
    };
    // Car i's point `h` up its own up axis.
    auto above = [&](size_t i, float h) {
        const TtpVec3& u = cars[i].up;
        return at(i) + V3{ u.x, u.y, u.z } * h;
    };
    // The pitch with the fewest faults, ranked as camera.h lists them (the fault
    // rank first, then the kerbs); ties go to the earlier in FOLLOW_PITCHES. It
    // says whether the way there crosses a deck, which is what makes it a cut.
    struct Pick { float pitch; bool across; };
    auto clearPitch = [&]() {
        const V3 from = eyeAt(pitch);
        Pick best = { FOLLOW_PITCH, false };
        std::pair<int, int> bestScore = { INT_MAX, INT_MAX };
        for (float p : FOLLOW_PITCHES) {
            const V3 eye = eyeAt(p);
            const V3 up = { 0, FOLLOW_LENS_CLEAR, 0 };
            bool hidden = false;
            for (size_t i = 0; i < n && !hidden; i++) {
                if (!inBattle(i)) continue;
                const V3 aim = above(i, FOLLOW_AIM_UP);
                hidden = deckBlocks(deck, eye, aim, 0, FOLLOW_CAR_CLEAR) || groundBlocks(eye, aim, FOLLOW_CAR_CLEAR);
            }
            const bool across = deckBlocks(deck, from, eye, 0, 0);
            const bool crowded = deckBlocks(deck, eye - up, eye + up, 0, 0)
                    || eye.y < ground.at(eye.x, eye.z) + FOLLOW_LENS_CLEAR || hillTooHigh(eye);
            const int rank = (hidden ? 4 : 0) + (across ? 2 : 0) + (crowded ? 1 : 0);
            if (rank > bestScore.first) continue;  // the kerbs cannot make up for it
            int kerbed = 0;
            for (size_t i = 0; i < n; i++) {
                if (!inBattle(i)) continue;
                for (float h : FOLLOW_KERB_AIMS) kerbed += kerbBlocks(deck, eye, above(i, h));
            }
            const std::pair<int, int> score = { rank, kerbed };
            if (score < bestScore) { best = { p, across }; bestScore = score; }
            if (score == std::pair<int, int>{ 0, 0 }) break;
        }
        return best;
    };

    if (!init) {
        target = centre;
        yaw = wantYaw;
        dist = wantDist;
        pitch = clearPitch().pitch;
        init = true;
    } else if (dt > 0) {
        if (lead < (int) seen.size() && seen[lead]) {
            flow = lerp(flow, (at(lead) - last[lead]) * (1 / dt), 1 - std::exp(-FOLLOW_FLOW_RATE * dt));
        }
        target = target + flow * dt;
        spring(target.x, aimVel.x, centre.x, FOLLOW_AIM_OMEGA, dt);
        spring(target.y, aimVel.y, centre.y, FOLLOW_AIM_OMEGA, dt);
        spring(target.z, aimVel.z, centre.z, FOLLOW_AIM_OMEGA, dt);
        float dy = wantYaw - yaw;
        while (dy > PI) dy -= 2 * PI;
        while (dy < -PI) dy += 2 * PI;
        spring(yaw, yawVel, yaw + dy, FOLLOW_YAW_OMEGA, dt);
        spring(dist, distVel, wantDist, FOLLOW_DIST_OMEGA, dt);
        const Pick want = clearPitch();
        if (want.across) {
            pitch = want.pitch;  // cut, never through
            pitchVel = 0;
        } else {
            spring(pitch, pitchVel, want.pitch, FOLLOW_PITCH_OMEGA, dt);
        }
    }
    last.resize(n);
    seen.assign(live.begin(), live.end());
    for (size_t i = 0; i < n; i++) if (live[i]) last[i] = at(i);

    pos = eyeAt(pitch);
}

void CoverChase::update(const ttp::Pose& pose, float dt) {
    const V3 p = v3(pose.pos), fwd = v3(pose.forward), up = v3(pose.up);
    const V3 want = p + fwd * -COVER_CHASE_DIST + up * COVER_CHASE_HEIGHT;
    const V3 wantTgt = p + up * COVER_CHASE_AIM_UP;
    const float a = 1 - std::exp(-CAM_POS_RATE * dt);
    if (!init) { pos = want; target = wantTgt; init = true; }
    else { pos = lerp(pos, want, a); target = lerp(target, wantTgt, a); }
}

int packFocus(const TtpCarInput* cars, const std::vector<bool>& live) {
    const int n = (int) live.size();
    int lead = -1;
    for (int i = 0; i < n; i++) {
        if (live[i] && (lead < 0 || cars[i].trackS > cars[lead].trackS)) lead = i;
    }
    if (lead < 0) return -1;
    const float battleFrom = cars[lead].trackS - FOLLOW_GAP;
    int best = -1;
    float bestGap = FOLLOW_GAP;
    for (int c = 0; c < n; c++) {
        if (!live[c] || cars[c].trackS >= battleFrom) continue;
        int ahead = -1;
        for (int a = 0; a < n; a++) {
            if (a == c || !live[a] || cars[a].trackS < cars[c].trackS) continue;
            if (ahead < 0 || cars[a].trackS < cars[ahead].trackS) ahead = a;
        }
        if (ahead < 0 || cars[ahead].trackS >= battleFrom) continue;
        const float gap = cars[ahead].trackS - cars[c].trackS;
        if (gap <= bestGap) { best = c; bestGap = gap; }
    }
    return best;
}

void Coverage::step(float dt, const TtpCarInput* cars, const std::vector<bool>& live,
                    const std::vector<bool>& player) {
    // CHASE holds the odd beats.
    static constexpr Shot CYCLE[] = { Shot::LEAD, Shot::CHASE, Shot::PACK, Shot::CHASE };
    static constexpr uint32_t BEATS = sizeof CYCLE / sizeof *CYCLE;
    cut = false;
    const int n = (int) live.size();
    const auto isLive = [&](int i) { return i >= 0 && i < n && live[i]; };
    const auto cutTo = [&](Shot s) { shot = s; held = 0; cut = true; };
    const int pick = featured;
    featured = -1;
    if (isLive(pick)) {
        subject = pick;
        beat |= 1;   // the chase after this battle, so the next battle is still due
        cutTo(Shot::CHASE);
        return;
    }
    bool any = false;
    for (int i = 0; i < n; i++) any = any || live[i];
    // No field (a preview before the demo has cars): only the wide shot has
    // anything to look at.
    if (!any) {
        if (shot != Shot::WIDE) cutTo(Shot::WIDE);
        else held += dt;
        return;
    }
    held += dt;
    const float hold = shot == Shot::CHASE ? COVER_HOLD_CHASE : COVER_HOLD_BATTLE;
    // A shot whose car or fight has left ends at once. PACK's -1 is the whole
    // field, which cannot leave.
    const bool lost = (shot == Shot::CHASE && !isLive(subject))
            || (shot == Shot::PACK && subject >= 0 && !isLive(subject));
    if (shot != Shot::WIDE && held < hold && !lost) return;
    // WIDE gives way to the beat the cycle is on; anything else moves it on.
    if (shot != Shot::WIDE) beat = (beat + 1) % BEATS;
    const Shot next = CYCLE[beat];
    if (next == Shot::CHASE) {
        // The next car in turn: the players' cars when there are any, the
        // whole field when nobody has joined.
        std::vector<int> pool;
        for (int i = 0; i < n; i++) if (live[i] && i < (int) player.size() && player[i]) pool.push_back(i);
        if (pool.empty()) for (int i = 0; i < n; i++) if (live[i]) pool.push_back(i);
        subject = pool[turn++ % pool.size()];
    } else {
        subject = next == Shot::PACK ? packFocus(cars, live) : -1;
    }
    cutTo(next);
}

void Coverage::battleField(const TtpCarInput* cars, std::vector<bool>& live) const {
    if (shot != Shot::PACK || subject < 0) return;
    const float at = cars[subject].trackS;
    for (size_t i = 0; i < live.size(); i++) {
        live[i] = live[i] && std::fabs(cars[i].trackS - at) <= FOLLOW_GAP;
    }
}

}  // namespace rt
}  // namespace ttp
