#include "ttp/frame_builder.h"

#include <cmath>
#include <cstring>

#include "ttp/game.h"
#include "ttp/json_parse.h"
#include "ttp/showcase.h"
#include "ttp/util.h"

namespace ttp {
namespace rt {

// Drop every motion cue but keep the pose — what "held" means (ttp_display_hold).
void atRest(TtpCarInput& c) {
    c.spd = c.steer = c.brake = c.spin = c.scrub = 0;
    c.boostMul = 1;
}

std::vector<ScalarId> parseIds(const char* json) {
    std::vector<ScalarId> out;
    if (!json) return out;
    bool ok = false;
    const Value v = ttp::json::parse(json, &ok);
    if (!ok || v.type != Value::ARR) return out;
    for (const Value& e : v.arr) {
        if (e.type == Value::NUM) out.push_back(ScalarId::Num(e.num));
        else if (e.type == Value::STR) out.push_back(ScalarId::Str(e.str));
    }
    return out;
}

// A split-screen cell is not a small screen. It is a CROP of one.
//
// BASE_FOV is authored VERTICAL, which quietly makes the car's on-screen size a
// function of the cell's HEIGHT: a cell half as tall draws the car half as big,
// and a two-player 32:9 strip also opened the lens to 123 degrees and pushed it
// further away still. The chase camera never moved — CHASE_DIST is a fixed 1.35
// world units in every layout — so this is not distance, it is pixels per world
// unit, and the lever for it is the lens.
//
// So lock the pixel scale instead of the angle. Solve each cell's fov so that
//
//     renderedWidth / (2*tan(hFov/2))  ==  referenceWidth / (2*tan(hRef/2))
//
// and a world unit at the car covers the same number of pixels no matter how the
// screen is carved up. Every cell is then a genuine CROP of the single-player
// view: same scale, no distortion, just less of the world. What you give up is
// peripheral view, and that is the unavoidable half of the trade.
//
// FRAME_LOCK is how much of the shrink gets paid back: 0 holds the HORIZONTAL
// fov at the reference, 1 holds the pixel scale outright. Single player is the
// fixed point — its cell is the whole picture, so the vertical fov comes back
// exactly as authored on any display shape.
constexpr float REF_ASPECT = 16.0f / 9.0f;
constexpr float FRAME_LOCK = 1.0f;
float cellFov(float fovV, float aspect, float widthFrac) {
    const float tanH = std::tan(fovV * (float) M_PI / 360.0f) * REF_ASPECT;
    return std::atan(tanH * std::pow(widthFrac, FRAME_LOCK) / aspect)
            * 360.0f / (float) M_PI;
}

TtpFrameInput* buildFrame(DisplayState& d, const Game* eng, float dt,
                          float cellAspect, float widthFrac) {
    // Cars, in ROSTER order: the renderer baked each slot's model and livery at
    // build time, so slot i must keep carrying the car the roster named. Ids,
    // not indices — `cars()` is insertion order and the roster is cell order.
    std::vector<const Car*> cars(d.roster.size(), nullptr);
    if (eng) {
        for (const auto& cp : eng->cars()) {
            for (size_t i = 0; i < d.roster.size(); i++) {
                if (d.roster[i] == cp->id) { cars[i] = cp.get(); break; }
            }
        }
    }

    // Views: one chase camera per cell car, or a single overview when no car
    // owns a cell (the lobby's attract race, the gallery, a track preview).
    //
    // A cell whose car is not in THIS scene's roster gets no camera worth
    // pointing: the spring has never been seeded, so it would sit at the origin
    // and stare at whatever happens to be there. That is reachable whenever the
    // cells are set before the scene that holds those cars has finished
    // building, so fall back to the overview until at least one of them lands.
    bool anyCellCar = false;
    for (const ScalarId& cell : d.cells) {
        for (size_t i = 0; i < d.roster.size() && !anyCellCar; i++) {
            if (d.roster[i] == cell && cars[i]) anyCellCar = true;
        }
    }
    const bool raceCams = anyCellCar;
    uint32_t viewCount = raceCams ? (uint32_t) d.cells.size() : 1;
    // The renderer owns the rect — it letterboxes the grid as ONE piece, so a
    // cell is a tile of the capped picture and not of the raw surface. The caller
    // measured it; deriving it here would be a second implementation that could
    // disagree with the viewport the cell actually lands in.
    const float aspect = raceCams
            ? cellAspect
            : (float) d.width / (float) (d.height ? d.height : 1);

    // The asset gallery's STANDING EXHIBITS (ttp/showcase.h): a rocket and the
    // monster rig, which a race is otherwise the only way to see. Staged only
    // while the field is PARKED — the gallery's Drive toggle hands the scene
    // back to the sim, and an exhibit left standing through that would be the
    // one rocket on screen that no car fired. Needs `eng` for nothing but the
    // lap length an exhibit's `u` is a fraction of.
    const bool staged = d.showcase && d.hold && eng;

    const size_t nBananas = eng ? eng->bananas().size() : 0;  // filtered below
    const size_t nRockets = (eng ? eng->rockets().size() : 0)
            + (staged ? showcase_rockets().size() : 0);
    const size_t nBoxes = eng ? eng->boxes().size() : 0;

    // A cell overlay per cell, but only once the cells are REAL: the no-car
    // fallback above collapses to a single overview camera, and a steer bar
    // hanging in the middle of it would belong to no cell at all.
    const uint32_t hudCount = raceCams ? (uint32_t) d.cells.size() : 0;

    const size_t bytes = sizeof(TtpFrameInput) + cars.size() * sizeof(TtpCarInput)
            + viewCount * sizeof(TtpViewInput) + nBoxes * sizeof(uint32_t)
            + nBananas * sizeof(TtpBananaInput) + nRockets * sizeof(TtpRocketInput)
            + d.bursts.size() * sizeof(TtpBurstInput) + hudCount * sizeof(TtpCellHudInput);
    if (d.frame.size() < bytes) d.frame.resize(bytes);
    auto* head = reinterpret_cast<TtpFrameInput*>(d.frame.data());
    std::memset(head, 0, sizeof(TtpFrameInput));
    head->version = TTP_FRAME_INPUT_VERSION;
    head->dt = dt;
    head->carCount = (uint32_t) cars.size();
    head->viewCount = viewCount;
    head->boxCount = (uint32_t) nBoxes;
    head->burstCount = (uint32_t) d.bursts.size();
    head->hudCount = hudCount;
    head->uiScale = d.uiScale;
    if (d.dividers) head->flags |= TTP_FRAME_DIVIDERS;

    auto* outCars = const_cast<TtpCarInput*>(ttp_frame_cars(head));
    const bool fromHeld = d.hold && d.held.size() == cars.size();
    if (fromHeld) {
        std::memcpy(outCars, d.held.data(), cars.size() * sizeof(TtpCarInput));
    } else {
        for (size_t i = 0; i < cars.size(); i++) {
            TtpCarInput& o = outCars[i];
            std::memset(&o, 0, sizeof(o));
            const Car* c = cars[i];
            if (!c) continue;
            o.pos = { (float) c->pose.pos.x, (float) c->pose.pos.y, (float) c->pose.pos.z };
            o.forward = { (float) c->pose.forward.x, (float) c->pose.forward.y, (float) c->pose.forward.z };
            o.up = { (float) c->pose.up.x, (float) c->pose.up.y, (float) c->pose.up.z };
            o.spd = c->vmax != 0 ? (float) (c->v / c->vmax) : 0;
            // STEER_SIGN, exactly as getSnapshot applies it. `Car::steer` is the
            // raw input; the sim turns the car by STEER_SIGN * steer, so the
            // VISUAL cues (front-wheel yaw, body lean) have to carry the same
            // sign or the car leans out of its own corners. The HUD's steer bar
            // is the one thing that wants the raw value — it mirrors phone tilt,
            // which is why it reads `steerInput` off the snapshot instead.
            o.steer = (float) (ttp::STEER_SIGN * c->steer);
            o.brake = (float) c->brake;
            o.boostMul = (float) c->boostMul;
            o.monster = c->monsterT > 0 ? 1.0f : 0.0f;
            o.spin = (float) c->spin;
            o.scrub = c->onWall ? 1.0f : 0.0f;
        }
        // A hold that OUTLIVED the field it was taken on lands here, because the
        // memcpy above only fires while the sizes still match: a seat expiring
        // mid-pause forfeits its car, which rebuilds the scene with a shorter
        // roster. Re-apply the rest to the live read, or the frozen field would
        // spin its wheels and lay rubber behind the pause overlay.
        if (d.hold) for (size_t i = 0; i < cars.size(); i++) atRest(outCars[i]);
        // Keep this frame's field, so a hold taken mid-race has something to
        // hold — ttp_display_hold zeroes the motion cues on the way in.
        d.held.assign(outCars, outCars + cars.size());
    }

    // The showroom's monster truck. The rig is a TRANSFORM of a car and not a
    // prop — the kit chassis with its cab dropped, seating the car's own body —
    // so the only way to stand one still is to put a parked car in it. Applied
    // to `outCars` and deliberately NOT to `d.held`: the exhibit belongs to the
    // gallery's parked state, not to the field, so lifting the hold drops it
    // without anything having to remember to.
    if (staged) {
        const int slot = showcase_monster_slot((int) cars.size());
        // A slot with no live car behind it was memset above, so its pose is
        // the origin with a zero forward — a rig grafted onto that is a truck
        // standing in the middle of nothing.
        if (slot >= 0 && (fromHeld || cars[(size_t) slot])) {
            outCars[slot].monster = 1.0f;
        }
    }

    auto* outViews = const_cast<TtpViewInput*>(ttp_frame_views(head));
    const float fogNear = !d.fog ? 0
            : raceCams ? d.framing.raceFogNear
            : d.camMode == CAM_BBOX ? d.framing.bbFogNear
            : d.framing.ovFogNear;
    const float fogFar = !d.fog ? 0
            : raceCams ? d.framing.raceFogFar
            : d.camMode == CAM_BBOX ? d.framing.bbFogFar
            : d.framing.ovFogFar;
    if (raceCams) {
        for (size_t i = 0; i < d.cells.size(); i++) {
            ChaseCam& cam = d.chase[d.cells[i].key()];
            const Car* c = nullptr;
            for (size_t j = 0; j < d.roster.size(); j++) {
                if (d.roster[j] == d.cells[i]) { c = cars[j]; break; }
            }
            if (c) cam.update(c->pose, c->vmax != 0 ? (float) (c->v / c->vmax) : 0, dt);
            TtpViewInput& v = outViews[i];
            lookAtWorld(v.world, cam.pos, cam.target, c ? v3(c->pose.up) : V3{ 0, 1, 0 });
            v.fov = cellFov(cam.fov, aspect, widthFrac);
            v.aspect = aspect;
            v.nearZ = CAM_NEAR;
            v.farZ = CAM_FAR;
            v.fogNear = fogNear;
            v.fogFar = fogFar;
        }
    } else {
        const Framing& f = d.framing;
        V3 eye, target = f.center;
        if (d.camMode == CAM_FREE) {
            eye = d.freeEye;
            target = d.freeTarget;
        } else if (d.camMode == CAM_BBOX) {
            d.orbitAngle += BBOX_ORBIT_SPEED * dt;
            eye = { f.center.x + std::cos(d.orbitAngle) * f.bbAx,
                    f.center.y + f.bbHeight,
                    f.center.z + std::sin(d.orbitAngle) * f.bbAz };
        } else if (d.camMode == CAM_ORBIT) {
            d.orbitAngle += LOBBY_ORBIT_SPEED * dt;
            eye = { f.center.x + std::cos(d.orbitAngle) * f.ovRadius,
                    f.center.y + f.ovHeight,
                    f.center.z + std::sin(d.orbitAngle) * f.ovRadius };
        } else {
            eye = f.center + f.ovOffset;  // the fitted whole-track iso view, held still
        }
        TtpViewInput& v = outViews[0];
        lookAtWorld(v.world, eye, target, V3{ 0, 1, 0 });
        v.fov = OVERVIEW_FOV;
        v.aspect = aspect;
        v.nearZ = d.camMode == CAM_FREE ? FREE_NEAR : OV_NEAR;
        v.farZ = OV_FAR;
        v.fogNear = fogNear;
        v.fogFar = fogFar;
    }

    auto* outBoxes = const_cast<uint32_t*>(ttp_frame_box_states(head));
    if (eng) {
        const auto& boxes = eng->boxes();
        for (size_t i = 0; i < boxes.size(); i++) outBoxes[i] = boxes[i].cooldown <= 0 ? 1u : 0u;
    }

    // Bananas are live only once armed — an unarmed one is not on the track yet
    // and drawing it would show the dropper a hazard they haven't dropped.
    auto* outBananas = const_cast<TtpBananaInput*>(ttp_frame_bananas(head));
    uint32_t nb = 0;
    if (eng) {
        const double now = eng->elapsed();
        for (const auto& b : eng->bananas()) {
            if (now < b.liveAt) continue;
            outBananas[nb].s = (float) b.s;
            outBananas[nb].lat = (float) b.lat;
            nb++;
        }
    }
    head->bananaCount = nb;

    auto* outRockets = const_cast<TtpRocketInput*>(ttp_frame_rockets(head));
    uint32_t nr = 0;
    if (eng) {
        // The gallery's standing rockets go FIRST. The renderer's rocket pool
        // is four, so a full sky of live ones would otherwise be able to push
        // an exhibit out of the picture — nothing fires while the field is
        // parked, but the ORDER is what makes that a property rather than a
        // coincidence of the toggle nobody has flipped yet.
        if (staged) {
            for (const ShowcaseRocket& r : showcase_rockets()) {
                outRockets[nr].s = (float) ttp::wrap_s(r.u * eng->length(), eng->length());
                outRockets[nr].lat = r.lat;
                nr++;
            }
        }
        for (const auto& rk : eng->rockets()) {
            outRockets[nr].s = (float) ttp::wrap_s(rk.s, eng->length());
            outRockets[nr].lat = (float) rk.lat;
            nr++;
        }
    }
    head->rocketCount = nr;

    auto* outBursts = const_cast<TtpBurstInput*>(ttp_frame_bursts(head));
    for (size_t i = 0; i < d.bursts.size(); i++) outBursts[i] = d.bursts[i];
    d.bursts.clear();

    // Cell overlays. The steer bar mirrors the PHONE's own bar, so it carries
    // `Car::steer` untouched — the raw tilt — where the car cues twenty lines up
    // carry STEER_SIGN * steer for the opposite reason.
    auto* outHud = const_cast<TtpCellHudInput*>(ttp_frame_hud(head));
    for (uint32_t i = 0; i < hudCount; i++) {
        TtpCellHudInput& o = outHud[i];
        o.car = -1;
        o.steer = 0;
        o.flags = (d.cardMask >> i) & 1u ? 0u : TTP_HUD_STEER_BAR;
        for (size_t j = 0; j < d.roster.size(); j++) {
            if (d.roster[j] != d.cells[i]) continue;
            o.car = (int32_t) j;
            // A held field is at rest, so its bars are centred with it — the
            // pause overlay must not show a car steering it is not doing.
            if (cars[j] && !d.hold) o.steer = (float) cars[j]->steer;
            break;
        }
    }

    d.sceneT += dt;
    head->sceneT = d.sceneT;
    return head;
}

}  // namespace rt
}  // namespace ttp
