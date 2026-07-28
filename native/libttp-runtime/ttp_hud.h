/*
 * ttp_hud.h — the per-player RACE HUD, as a packed block the shell reads back.
 *
 * WHAT THIS REPLACES. The HUD's values used to come out of the sim as
 * `ttp_snapshot_json` — the whole race state, serialized, parsed, and thrown
 * away for six integers per car. That readback is the last per-frame string on
 * the web shell's critical path, and on tvOS/Android it would be a per-frame
 * JSON parse in a language that has no reason to own one. This is the same six
 * values as a struct: one call, no allocation, no parse.
 *
 * WHAT IT IS NOT. Not a HUD description — there is no text in it, no colour, no
 * layout and no English. C++ emits the semantic values and a stable item CODE;
 * the ordinal suffix, "Lap 2/3", the item's icon and the FINISHED card are the
 * shell's, next to the elements they fill (docs/native-port/shared-cpp-plan.md's
 * strings decision). Nor is it a frame: the whole HUD is a ~6 Hz poll since the
 * steer bar moved into the renderer, so this is READ when the shell wants it,
 * not pushed every frame.
 *
 * SLOT IDENTITY, and why there is no car id in here. Entries are indexed by the
 * renderer's ROSTER SLOT — the order the shell handed ttp_display_build, which
 * is where a car's model and livery were baked. So slot i is the car the shell
 * itself named i, and the shell maps back through the list it authored. That is
 * the same identity ttp_display_burst and TtpCellHudInput already use, and it is
 * the answer to the objection that killed the earlier packed-readback proposal:
 * nothing here assumes the live field is dense, contiguous or ordered like the
 * sim's. A slot whose car is not in the bound session (a forfeit, a scene built
 * for a different field) simply comes back without TTP_HUD_SLOT_LIVE.
 *
 * C-shaped and plain data, like ttp_render.h, because the tvOS and Android
 * shells read the same struct. It is a READBACK, though, not renderer input,
 * which is why it is its own header.
 */
#ifndef TTP_HUD_H
#define TTP_HUD_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The item vocabulary a box can yield, as a code rather than a string.
 *
 * The order is ttp::ITEM_IDS (libttp-sim/ttp/game.h) — the sim's own roll
 * table — and the value is that index PLUS ONE, so 0 can mean "empty slot"
 * without a sentinel that looks like an item. The web shell's mirror is
 * ITEM_IDS in public/display/engine/contract.js, which is what an ITEM message
 * still puts on the wire for the phone; ttp_item_id (ttp_runtime.h) reads this
 * table back out so the two lists are pinned to each other by a test rather
 * than by a comment. */
#define TTP_ITEM_NONE     0
#define TTP_ITEM_BOOST    1
#define TTP_ITEM_BANANA   2
#define TTP_ITEM_ROCKET   3
#define TTP_ITEM_MONSTER  4
/* A held item outside that table. Unreachable from the shipping game — the roll
 * only ever yields the four, and the ?item= debug override is validated against
 * the same list before it reaches the sim — but a code is still emitted rather
 * than silently folding to NONE, because "the slot is empty" and "the slot holds
 * something this build has no name for" are different facts. A shell draws it as
 * empty; it must not report it to a phone as empty. */
#define TTP_ITEM_UNKNOWN (-1)

/* TtpHudSlot.flags */
#define TTP_HUD_SLOT_LIVE     1u /* a car of the bound session occupies this slot */
#define TTP_HUD_SLOT_FINISHED 2u /* crossed the line — the cell shows its card */
#define TTP_HUD_SLOT_TIMED    4u /* finishTime is a number; without it, it is null */

/* One roster slot's HUD values. Every field is meaningless without
 * TTP_HUD_SLOT_LIVE — a dead slot is zeroed, not stale. */
typedef struct TtpHudSlot {
    int32_t place;      /* 1-based finishing order right now (snapshot `position`) */
    int32_t lap;        /* the lap number to SHOW, 1..totalLaps (snapshot `lap`) */
    int32_t totalLaps;
    /* The held item as a TTP_ITEM_* code. TTP_ITEM_NONE while the slot is empty
     * AND once the car has finished: a finished car is on a victory lap with no
     * usable slot, so its item reads empty however full the engine says it is.
     * That gate is the ONE decision in this block, and it is the one
     * public/display/uiModel.js hudRows makes. */
    int32_t item;
    uint32_t flags;     /* TTP_HUD_SLOT_* */
    uint32_t reserved;  /* 0 — keeps finishTime 8-aligned on every ABI */
    double finishTime;  /* seconds, with TTP_HUD_SLOT_TIMED; else 0 */
} TtpHudSlot;

#define TTP_HUD_BLOCK_VERSION 1

/* Header, followed CONTIGUOUSLY by slots[slotCount] — the same layout
 * convention as TtpFrameInput, for the same reason: one buffer, one read, and a
 * shape a Swift/Kotlin shell can map without a parser. */
typedef struct TtpHudBlock {
    uint32_t version;   /* TTP_HUD_BLOCK_VERSION */
    uint32_t slotCount; /* roster slots, in ttp_display_build order */
    /* sizeof(TtpHudSlot). Carried so a reader can stride the array without
     * having compiled this struct — the block outlives the header it shipped
     * with the moment a shell caches a decoder. */
    uint32_t stride;
    uint32_t flags;     /* reserved, 0 */
} TtpHudBlock;

static inline const TtpHudSlot* ttp_hud_slots(const TtpHudBlock* b) {
    return (const TtpHudSlot*) (const void*) (b + 1);
}

#ifdef __cplusplus
}
#endif

#endif /* TTP_HUD_H */
