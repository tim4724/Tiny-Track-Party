#include "ttp/hud.h"

#include <cstring>

#include "ttp/game.h"

namespace ttp {
namespace rt {

int32_t itemCode(const std::string& id) {
    if (id.empty()) return TTP_ITEM_NONE;
    for (int32_t i = 0; i < 4; i++) {
        if (id == ttp::ITEM_IDS[i]) return i + 1;
    }
    return TTP_ITEM_UNKNOWN;
}

TtpHudSlot hudSlot(int32_t place, int32_t lap, int32_t totalLaps,
                   const std::string& item, bool finished,
                   bool hasFinishTime, double finishTime) {
    TtpHudSlot s;
    std::memset(&s, 0, sizeof(s));
    s.place = place;
    s.lap = lap;
    s.totalLaps = totalLaps;
    // The one decision: a finished car's slot reads empty. Not a display trick —
    // the same value goes to the phone as its ITEM, and its USE button must be
    // dark on the victory lap.
    s.item = finished ? TTP_ITEM_NONE : itemCode(item);
    s.flags = TTP_HUD_SLOT_LIVE;
    if (finished) s.flags |= TTP_HUD_SLOT_FINISHED;
    if (hasFinishTime) {
        s.flags |= TTP_HUD_SLOT_TIMED;
        s.finishTime = finishTime;
    }
    return s;
}

const TtpHudBlock* buildHud(DisplayState& d, const Game* eng) {
    const size_t n = d.roster.size();
    const size_t bytes = sizeof(TtpHudBlock) + n * sizeof(TtpHudSlot);
    if (d.hudBlock.size() < bytes) d.hudBlock.resize(bytes);
    auto* head = reinterpret_cast<TtpHudBlock*>(d.hudBlock.data());
    head->version = TTP_HUD_BLOCK_VERSION;
    head->slotCount = (uint32_t) n;
    head->stride = (uint32_t) sizeof(TtpHudSlot);
    head->flags = 0;

    auto* slots = const_cast<TtpHudSlot*>(ttp_hud_slots(head));
    std::memset(slots, 0, n * sizeof(TtpHudSlot));
    if (!eng) return head;
    // Slot identity, exactly as buildFrame resolves it: the roster is the order
    // the shell baked models and liveries in, `cars()` is the sim's insertion
    // order, and the two are matched BY ID. A car the roster does not name is
    // not in this scene and has no HUD to write; a slot no live car claims stays
    // zeroed, which is the shell's cue to leave that cell's chrome alone.
    for (const auto& cp : eng->cars()) {
        for (size_t i = 0; i < n; i++) {
            if (!(d.roster[i] == cp->id)) continue;
            const Car& c = *cp;
            slots[i] = hudSlot((int32_t) c.rank, (int32_t) eng->displayLap(c),
                               (int32_t) eng->totalLaps(), c.item, c.finished,
                               !c.finishTimeNull, c.finishTime);
            break;
        }
    }
    return head;
}

}  // namespace rt
}  // namespace ttp
