#include "ttp/camera.h"

#include <climits>
#include <cmath>
#include <utility>

#include "ttp/game.h"

namespace ttp {
namespace rt {

void ChaseCam::update(const ttp::Pose& pose, float spd, float dt, bool monster, float height,
                      float rise, float back, bool aim) {
    const V3 p = v3(pose.pos), fwd = v3(pose.forward), up = v3(pose.up);
    const float blendRate = monster ? MONSTER_CAM_UP : MONSTER_CAM_DOWN;
    monsterBlend += ((monster ? 1.0f : 0.0f) - monsterBlend) * (1 - std::exp(-blendRate * dt));
    aimHeldT = aim ? aimHeldT + dt : 0;
    const bool aiming = aimHeldT >= AIM_CAM_DELAY;
    aimT += aiming ? dt / AIM_CAM_IN_S : -dt / AIM_CAM_OUT_S;
    aimT = aimT < 0 ? 0 : aimT > 1 ? 1 : aimT;
    const float aimBlend = aimT * aimT * (3 - 2 * aimT);
    const V3 want = p + fwd * -(CHASE_DIST + CHASE_DIST_GAIN * spd + monsterBlend * back
                                + aimBlend * AIM_CAM_BACK)
                  + up * (height + monsterBlend * rise + aimBlend * AIM_CAM_RISE);
    const V3 wantTgt = p + fwd * (CHASE_LOOK * (1 - aimBlend)) + up * CHASE_TGT_UP;
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

// An angle, the short way round.
float wrapPi(float a) {
    while (a > PI) a -= 2 * PI;
    while (a < -PI) a += 2 * PI;
    return a;
}

float clamp01(float x) { return x < 0 ? 0.0f : x > 1 ? 1.0f : x; }

// Where in a lap a car's unwrapped trackS is.
float lapPos(const LoopShot& l, float trackS) {
    const float s = std::fmod(trackS, l.lap);
    return s < 0 ? s + l.lap : s;
}

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
                       const NameTagDeck& deck, const GroundGrid& ground,
                       const std::vector<LoopShot>& loops, float dt) {
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
    float wantYaw = std::atan2(face.x, face.z);
    float goalDist = wantDist;

    // The looping the battle is on, if any. A battle strung across two stays on the
    // one it is already on, so it does not flip between their ends.
    int atLoop = -1;
    for (size_t i = 0; i < n; i++) {
        if (!inBattle(i)) continue;
        const int l = loopAt(loops, cars[i].trackS);
        if (l >= 0 && (atLoop < 0 || l == loop)) atLoop = l;
    }
    float furthest = -1;   // how far round the looping the battle has got
    for (size_t i = 0; i < n && atLoop >= 0; i++) {
        if (!inBattle(i) || loopAt(loops, cars[i].trackS) != atLoop) continue;
        furthest = std::fmax(furthest, lapPos(loops[atLoop], cars[i].trackS));
    }
    const bool riding = atLoop >= 0 && furthest >= loops[atLoop].start - FOLLOW_LOOP_SETTLE;
    if (atLoop != loop) {
        // The end to film from is chosen once, on arrival, and the parts of one
        // stretch are one swing from one end.
        const bool sameStretch = loop >= 0 && atLoop >= 0 && loops[loop].rideFrom == loops[atLoop].rideFrom;
        loop = atLoop;
        if (loop >= 0 && !sameStretch) {
            entryYaw = init ? yaw : wantYaw;
            entryDist = init ? dist : wantDist;
            const auto swing = [&](const LoopPlace& e) {
                return FOLLOW_LOOP_HIDDEN_COST * e.hidden + std::fabs(wrapPi(entryYaw - e.yaw)) / PI;
            };
            loopEnd = swing(loops[loop].ends[1]) < swing(loops[loop].ends[0]) ? 1 : 0;
        }
    }
    const LoopPlace* place = loop >= 0 ? &loops[loop].ends[loopEnd] : nullptr;
    V3 aimGoal = centre;
    float ridePitch = 0;
    if (place) {
        const LoopShot& l = loops[loop];
        const float way = clamp01((furthest - (l.rideFrom - FOLLOW_LOOP_LEAD)) / (FOLLOW_LOOP_LEAD - FOLLOW_LOOP_SETTLE));
        const float swung = way * way * (3 - 2 * way);
        const float round = 2 * clamp01((furthest - l.rideFrom) / (l.rideTo - l.rideFrom)) - 1;
        float rideYaw = place->yaw;
        float rideDist = place->dist * (1 - FOLLOW_LOOP_PUSH * round);
        if (riding) {
            // The aim follows the battle round the ring and the eye only leans
            // that way, so the view turns after the cars from inside the tube.
            V3 off = centre - place->aim;
            const float far = std::sqrt(dot(off, off));
            if (far > FOLLOW_LOOP_REACH) off = off * (FOLLOW_LOOP_REACH / far);
            const float out = rideDist * std::cos(place->pitch);
            const V3 eye = V3{ place->aim.x - std::sin(place->yaw) * out, place->aim.y + rideDist * std::sin(place->pitch),
                               place->aim.z - std::cos(place->yaw) * out }
                         + V3{ off.x, 0, off.z } * FOLLOW_LOOP_LEAN;   // not up or down: it would dive behind what crosses the ring
            aimGoal = place->aim + off * FOLLOW_LOOP_PAN;
            const V3 sight = aimGoal - eye;
            rideDist = std::sqrt(dot(sight, sight));
            rideYaw = std::atan2(sight.x, sight.z);
            ridePitch = std::asin(-sight.y / rideDist);
        }
        wantYaw = entryYaw + wrapPi(rideYaw - entryYaw) * swung;
        goalDist = entryDist + (rideDist - entryDist) * swung;
    }
    // Riding, the aim is carried at the share of the battle's speed it is pulled toward.
    const float flowShare = riding ? FOLLOW_LOOP_PAN : 1.0f;

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
        target = aimGoal;
        yaw = wantYaw;
        dist = goalDist;
        pitch = riding ? ridePitch : clearPitch().pitch;
        init = true;
    } else if (dt > 0) {
        if (lead < (int) seen.size() && seen[lead]) {
            flow = lerp(flow, (at(lead) - last[lead]) * (flowShare / dt), 1 - std::exp(-FOLLOW_FLOW_RATE * dt));
        }
        target = target + flow * dt;
        spring(target.x, aimVel.x, aimGoal.x, FOLLOW_AIM_OMEGA, dt);
        spring(target.y, aimVel.y, aimGoal.y, FOLLOW_AIM_OMEGA, dt);
        spring(target.z, aimVel.z, aimGoal.z, FOLLOW_AIM_OMEGA, dt);
        spring(yaw, yawVel, yaw + wrapPi(wantYaw - yaw), riding ? FOLLOW_LOOP_YAW_OMEGA : FOLLOW_YAW_OMEGA, dt);
        spring(dist, distVel, goalDist, FOLLOW_DIST_OMEGA, dt);
        // Riding, the pitch is the place's: every pitch but that looks through the
        // deck somewhere round the ring.
        const Pick want = riding ? Pick{ ridePitch, false } : clearPitch();
        if (want.across && !place) {   // a looping's way in is one unbroken swing
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

namespace {

// The looping for the steep stretch of samples first..last.
LoopShot loopShot(const std::vector<OutSample>& samples, size_t first, size_t last, float lap,
                  const NameTagDeck& deck, const GroundGrid& ground) {
    // The ring's axis is the AVERAGE lateral: a drifting ring's swings to either
    // side of it as the car climbs and comes back down.
    V3 axis;
    for (size_t k = first; k <= last; k++) axis = axis + v3(samples[k].lateral);
    axis.y = 0;
    axis = norm(axis);
    const V3 side = { axis.z, 0, -axis.x };
    // Each deck point of the stretch, edge to edge, against one function.
    auto eachEdge = [&](auto&& visit) {
        for (size_t k = first; k <= last; k++) {
            const OutSample& s = samples[k];
            const V3 across = v3(s.lateral) * (float) (s.width * 0.5);
            visit(v3(s.pos) - across);
            visit(v3(s.pos) + across);
        }
    };
    // The middle of the stretch's box, seen along the axis.
    V3 lo = { 1e9f, 1e9f, 1e9f }, hi = { -1e9f, -1e9f, -1e9f };
    eachEdge([&](V3 p) {
        const V3 q = { dot(p, axis), p.y, dot(p, side) };
        lo = { std::fmin(lo.x, q.x), std::fmin(lo.y, q.y), std::fmin(lo.z, q.z) };
        hi = { std::fmax(hi.x, q.x), std::fmax(hi.y, q.y), std::fmax(hi.z, q.z) };
    });
    const V3 target = axis * ((lo.x + hi.x) * 0.5f) + side * ((lo.z + hi.z) * 0.5f)
                    + V3{ 0, (lo.y + hi.y) * 0.5f, 0 };
    const float tanV = std::tan(FOLLOW_FOV * 0.5f * PI / 180.0f), tanH = tanV * FOLLOW_LOOP_ASPECT;

    // How far back facing `look` the stretch fits the lens.
    auto fit = [&](V3 look) {
        const V3 right = norm(V3{ -look.z, 0, look.x });
        const V3 lensUp = { -right.z * look.y, right.z * look.x - right.x * look.z, right.x * look.y };
        float dist = 0;
        eachEdge([&](V3 p) {
            const V3 d = p - target;
            const float toEye = -dot(d, look);   // a point nearer the eye needs more room
            dist = std::fmax(dist, toEye + FOLLOW_LOOP_MARGIN * std::fabs(dot(d, lensUp)) / tanV);
            dist = std::fmax(dist, toEye + FOLLOW_LOOP_MARGIN * std::fabs(dot(d, right)) / tanH);
        });
        return dist;
    };
    // The samples the rig is settled on this place for: the stretch and its way in.
    size_t settled = first;
    while (settled > 0 && samples[settled - 1].s >= samples[first].s - FOLLOW_LOOP_SETTLE) settled--;
    // Can this eye not see the top of the deck at sample k?
    auto blockedAt = [&](V3 eye, size_t k) {
        const V3 p = v3(samples[k].pos), up = v3(samples[k].up), car = p + up * FOLLOW_AIM_UP;
        bool blocked = dot(eye - p, up) < 0 || deckBlocks(deck, eye, car, 0, FOLLOW_CAR_CLEAR);
        for (int j = 1; j < FOLLOW_SIGHT_STEPS && !blocked; j++) {
            const V3 q = lerp(eye, car, (float) j / FOLLOW_SIGHT_STEPS);
            blocked = q.y < ground.at(q.x, q.z);
        }
        return blocked;
    };
    // How many of them this eye cannot see the top of, the stretch's own first: they
    // count in STRETCH_WEIGHTs, the way in in ones.
    constexpr int STRETCH_WEIGHT = 1000;
    auto hidden = [&](V3 eye) {
        int count = 0;
        for (size_t k = settled; k <= last; k++) {
            count += blockedAt(eye, k) ? (k >= first ? STRETCH_WEIGHT : 1) : 0;
        }
        return count;
    };
    LoopShot shot;
    const float from = (float) samples[first].s - FOLLOW_LOOP_LEAD;
    shot.from = from > 0 ? from : 0;
    shot.start = (float) samples[first].s;
    shot.to = (float) samples[last].s + FOLLOW_LOOP_TAIL;
    shot.lap = lap;
    for (int e = 0; e < 2; e++) {
        int fewest = INT_MAX;
        for (float yaw : FOLLOW_LOOP_YAWS) {
            for (float rise : FOLLOW_LOOP_RISES) {
                const V3 flat = axis * ((e == 0 ? 1.0f : -1.0f) * std::cos(yaw)) + side * std::sin(yaw);
                const V3 look = flat * std::cos(rise) + V3{ 0, -std::sin(rise), 0 };
                const float dist = fit(look);
                const V3 eye = target - look * dist;
                const int count = fewest > 0 ? hidden(eye) : INT_MAX;
                if (count >= fewest) continue;
                fewest = count;
                // Aimed a little under the middle, which lifts the ring off the seat cards.
                const V3 aim = target - V3{ 0, FOLLOW_LOOP_LIFT * tanV * dist, 0 };
                const V3 d = aim - eye;
                const float len = std::sqrt(dot(d, d));
                shot.ends[e] = { aim, std::atan2(d.x, d.z), std::asin(-d.y / len), len,
                                 (float) (count / STRETCH_WEIGHT) / (float) (last - first + 1) };
            }
        }
    }
    return shot;
}

}  // namespace

std::vector<LoopShot> loopShots(const std::vector<OutSample>& samples, float lap,
                                const NameTagDeck& deck, const GroundGrid& ground) {
    std::vector<LoopShot> out;
    for (size_t i = 0; i < samples.size(); i++) {
        if (samples[i].up.y >= FOLLOW_LOOP_STEEP) continue;
        const size_t first = i;
        size_t top = i;
        while (i + 1 < samples.size() && samples[i + 1].up.y < FOLLOW_LOOP_STEEP) {
            i++;
            if (samples[i].up.y < samples[top].up.y) top = i;
        }
        if (samples[top].up.y >= 0) continue;
        // A long stretch is several places, each fitted to its own part.
        const size_t count = (size_t) std::ceil((samples[i].s - samples[first].s) / FOLLOW_LOOP_MAX_LEN);
        const size_t span = i - first + 1;
        const size_t base = out.size();
        float worst[2] = { 0, 0 };
        for (size_t w = 0; w < count; w++) {
            out.push_back(loopShot(samples, first + span * w / count, first + span * (w + 1) / count - 1, lap,
                                   deck, ground));
            for (int e = 0; e < 2; e++) worst[e] = std::fmax(worst[e], out.back().ends[e].hidden);
        }
        // One stretch is filmed from one end, so an end answers for all its parts.
        for (size_t w = base; w < out.size(); w++) {
            for (int e = 0; e < 2; e++) out[w].ends[e].hidden = worst[e];
            out[w].rideFrom = (float) samples[first].s;
            out[w].rideTo = (float) samples[i].s;
        }
    }
    return out;
}

int loopAt(const std::vector<LoopShot>& loops, float trackS) {
    for (size_t l = 0; l < loops.size(); l++) {
        const float s = lapPos(loops[l], trackS);
        if (s >= loops[l].from && s < loops[l].to) return (int) l;
    }
    return -1;
}

void Coverage::step(float dt, const TtpCarInput* cars, const std::vector<bool>& live,
                    const std::vector<bool>& player, const std::vector<LoopShot>& loops) {
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
        // Already chasing this car: restart the hold only. A cut would reset
        // the chase spring to zero lag, which shows as the car jumping back.
        if (shot == Shot::CHASE && subject == pick) { held = 0; return; }
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
    // A battle shot does not end on a looping: it waits for the ride to finish.
    if (!lost && (shot == Shot::LEAD || shot == Shot::PACK) && battleOnLoop(cars, live, loops)) return;
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

bool Coverage::battleOnLoop(const TtpCarInput* cars, const std::vector<bool>& live,
                            const std::vector<LoopShot>& loops) const {
    std::vector<bool> filmed = live;
    battleField(cars, filmed);
    int lead = -1;
    for (size_t i = 0; i < filmed.size(); i++) {
        if (filmed[i] && (lead < 0 || cars[i].trackS > cars[lead].trackS)) lead = (int) i;
    }
    if (lead < 0) return false;
    for (size_t i = 0; i < filmed.size(); i++) {
        if (filmed[i] && cars[i].trackS >= cars[lead].trackS - FOLLOW_GAP && loopAt(loops, cars[i].trackS) >= 0) return true;
    }
    return false;
}

}  // namespace rt
}  // namespace ttp
