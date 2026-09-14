#include "ttp/name_tags.h"

#include <algorithm>
#include <cmath>

#include "ttp/vecmath.h"

namespace ttp {
namespace rt {

std::vector<NameTag> nameTags(const TtpFrameInput& f, const float* pictures) {
    std::vector<NameTag> out;
    if ((f.flags & TTP_FRAME_OVERVIEW) || f.viewCount < 2 || !pictures) return out;
    const TtpCarInput* cars = ttp_frame_cars(&f);
    const TtpViewInput* views = ttp_frame_views(&f);
    std::vector<std::pair<float, NameTag>> cell;  // (eye distance, tag)
    for (uint32_t i = 0; i < f.viewCount; i++) {
        const TtpViewInput& v = views[i];
        const float* w = v.world;
        // world is rigid (lookAtWorld), so its inverse is the transposed basis.
        const V3 right{ w[0], w[1], w[2] }, up{ w[4], w[5], w[6] }, back{ w[8], w[9], w[10] };
        const V3 eye{ w[12], w[13], w[14] };
        const float ty = std::tan(v.fov * 0.5f * (float) M_PI / 180.0f);
        const float tx = ty * v.aspect;
        const float* r = pictures + 4 * i;
        cell.clear();
        for (uint32_t j = 0; j < f.viewCount; j++) {
            const int32_t slot = views[j].car;
            if (j == i || slot < 0 || (uint32_t) slot >= f.carCount || slot == v.car) continue;
            const TtpCarInput& c = cars[slot];
            const V3 anchor = V3{ c.pos.x, c.pos.y, c.pos.z }
                    + V3{ c.up.x, c.up.y, c.up.z } * NAME_TAG_LIFT;
            const V3 d = anchor - eye;
            const float depth = -dot(d, back);
            if (depth <= v.nearZ) continue;
            const float nx = dot(d, right) / (depth * tx);
            const float ny = dot(d, up) / (depth * ty);
            if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
            const float dist = std::sqrt(dot(d, d));
            if (dist >= NAME_TAG_FAR) continue;
            const float fade = (NAME_TAG_FAR - dist) / (NAME_TAG_FAR - NAME_TAG_FADE);
            NameTag t;
            t.cell = (int32_t) i;
            t.target = (int32_t) j;
            t.x = r[0] + (nx + 1) * 0.5f * r[2];
            t.y = r[1] + (1 - ny) * 0.5f * r[3];
            const float k = std::max(0.0f, dist - NAME_TAG_NEAR) / (NAME_TAG_FAR - NAME_TAG_NEAR);
            t.scale = 1 - (1 - NAME_TAG_FAR_SCALE) * k;
            t.alpha = std::min(1.0f, fade);
            cell.push_back({ dist, t });
        }
        std::stable_sort(cell.begin(), cell.end(),
                         [](const auto& a, const auto& b) { return a.first > b.first; });
        for (const auto& e : cell) out.push_back(e.second);
    }
    return out;
}

}  // namespace rt
}  // namespace ttp
