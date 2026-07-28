/* ttp_audio.h — the AUDIO half of the runtime C ABI: the display's sound
 * DECISIONS, drained as a list of tagged commands. Sibling of ttp_runtime.h
 * (sim), ttp_party.h (party) and ttp_display.h (renderer), same conventions
 * (ttp_abi.h).
 *
 * WHAT CROSSES, AND WHAT DOES NOT. The rules behind every cue — the audibility
 * curve, the shared curb-scrub throttle, the per-human voice levels, the rocket
 * jet lifecycle, the music pool and its no-repeat shuffle — are
 * libttp-runtime/ttp/audio.{h,cc}, replayed on every leg against
 * tests/fixtures/audio-corpus.jsonl. This header is how a SHELL gets at them:
 * it calls the entry points below, then drains a block of commands and performs
 * them on its own audio device. No car pose, no speed, no distance and no gain
 * INPUT ever crosses — ttp_audio_frame reads the bound session's live Game in
 * C++, exactly as ttp_display_frame does, so the shell's whole per-frame job is
 * one call with a clock.
 *
 * SINGLETON, deliberately, like the display: there is one audio device per
 * process on every platform we ship, and the decisions carry state that
 * OUTLIVES a race (the last song, so a Grand Prix rotates its pool; the roster
 * count behind the join plink, which is a lobby event with no session at all).
 * A handle here would always be 1.
 *
 * WHY A PACKED BLOCK RATHER THAN JSON. This is drained on the frame path — up
 * to a voice command per human car per frame — and every field of a command is
 * a number or a small code, so the JSON drain ttp_room_events_json uses for its
 * bursty, string-shaped room events would put back exactly the per-frame
 * stringify+parse ttp_hud.h was written to remove. Same shape as the HUD block
 * for the same reason: one read, no allocation, no parser, and a layout a
 * Swift/Kotlin shell can map directly.
 *
 * A CUE IS A CODE. Nothing in a command is text: the cue, the voice and the
 * music operation are TTP_CUE_* / TTP_AUD_MUSIC_* integers, and a picked song is
 * an INDEX into the catalogue (ttp_audio_song_json reads one out, once per
 * race). ttp_audio_cue_id is the id behind a code — the same trick, and the same
 * reason, as ttp_item_id: a shell builds its cue table FROM the wasm instead of
 * keeping a mirror that can drift.
 */
#ifndef TTP_AUDIO_H
#define TTP_AUDIO_H

#include <stdint.h>

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- the command vocabulary --------------------------------------------- */

/* TtpAudioCmd.kind. One arm per audio::Command::Kind, in that order. */
#define TTP_AUD_CUE         1 /* one-shot: play `code` at `level`                */
#define TTP_AUD_COUNTDOWN   2 /* the countdown's two beats (TTP_AUD_F_GO picks)  */
#define TTP_AUD_VOICE       3 /* sustained voice `code` on `subject`: start if it
                               * is not running, then set it to `level`          */
#define TTP_AUD_VOICE_STOP  4 /* that voice's falling edge: stop it and free it  */
#define TTP_AUD_STOP_ALL    5 /* kill every live voice (pause, race end, lobby)  */
#define TTP_AUD_STOP_CAR    6 /* kill one subject's voices (forfeit, rekey)      */
#define TTP_AUD_MUSIC       7 /* `code` is a TTP_AUD_MUSIC_* operation           */

/* TtpAudioCmd.code, for TTP_AUD_MUSIC. */
#define TTP_AUD_MUSIC_START  1 /* `subject` is the song, `level` its bed height */
#define TTP_AUD_MUSIC_STOP   2
#define TTP_AUD_MUSIC_PAUSE  3
#define TTP_AUD_MUSIC_RESUME 4

/* TtpAudioCmd.code, for every other kind: the cue's id as a code. The order is
 * the decision layer's own table (one-shots, then the sustained voices), and the
 * value is that index PLUS ONE so 0 can mean "no cue" without a sentinel that
 * looks like one. ttp_audio_cue_id maps a code back to the id a device's cue
 * palette knows it by (public/display/audio/cues.js on the web). */
#define TTP_CUE_PICKUP           1
#define TTP_CUE_ROULETTE         2
#define TTP_CUE_BANANA_DROP      3
#define TTP_CUE_MONSTER_INFLATE  4
#define TTP_CUE_MONSTER_DEFLATE  5
#define TTP_CUE_BANANA_SLIP      6
#define TTP_CUE_ROCKET_HIT       7
#define TTP_CUE_SCREECH          8
#define TTP_CUE_LAP              9
#define TTP_CUE_JOIN            10
#define TTP_CUE_COUNTDOWN       11
#define TTP_CUE_BOOST           12
#define TTP_CUE_CORNER          13
#define TTP_CUE_BRAKE           14
#define TTP_CUE_ENGINE_PUTT     15
#define TTP_CUE_ROCKET_FIRE     16

/* TtpAudioCmd.flags */
#define TTP_AUD_F_GO  1u /* COUNTDOWN: the GO beat rather than a tick           */
#define TTP_AUD_F_MOD 2u /* VOICE: rateMul/gainMul/lpMul carry a timbre         */

/* One command. Fixed size and self-describing: a field an arm does not use is
 * zero, never stale. */
typedef struct TtpAudioCmd {
    int32_t kind;  /* TTP_AUD_*                                                 */
    int32_t code;  /* TTP_CUE_* — or TTP_AUD_MUSIC_* when kind is TTP_AUD_MUSIC */
    /* WHO the command is about, and it is deliberately NOT a car id.
     *
     * A voice is keyed by (cue, subject) and a subject is an opaque token this
     * runtime mints for each distinct sound source it has voiced — a car, an
     * in-flight rocket — valid until the next TTP_AUD_STOP_ALL, which is when
     * every voice dies anyway. The shell needs an identity to key its live-voice
     * map by and to match TTP_AUD_STOP_CAR against; it does not need to know
     * WHICH car, and handing back the sim's own ids would (a) put car identity
     * on a per-frame path for no reason and (b) inherit the id-collision the
     * shared car/rocket id space has: a rocket whose sequence number happened to
     * equal a peer index would have its jet killed by that seat's forfeit.
     * Distinct sources get distinct subjects here, so that cannot happen.
     *
     * Also the song INDEX for TTP_AUD_MUSIC_START (ttp_audio_song_json). 0 when
     * the arm has no subject. */
    int32_t subject;
    uint32_t flags;   /* TTP_AUD_F_*                                            */
    double level;     /* CUE gain / VOICE level / MUSIC_START bed height        */
    /* The voice's timbre, with TTP_AUD_F_MOD: playback rate, gain and low-pass
     * multipliers over the cue's neutral voicing. One user today — the
     * monster-truck engine, the same recorded loop pitched down — carried as
     * NUMBERS rather than as a code so the values stay written down once, in the
     * decision layer that authored them. */
    double rateMul, gainMul, lpMul;
} TtpAudioCmd;

#define TTP_AUDIO_BLOCK_VERSION 1

/* Header, followed CONTIGUOUSLY by cmds[count] — the TtpHudBlock convention,
 * `stride` carried for the same reason: a reader can walk the array without
 * having compiled this struct. */
typedef struct TtpAudioBlock {
    uint32_t version; /* TTP_AUDIO_BLOCK_VERSION       */
    uint32_t count;   /* commands, in performance order */
    uint32_t stride;  /* sizeof(TtpAudioCmd)            */
    uint32_t flags;   /* reserved, 0                    */
} TtpAudioBlock;

static inline const TtpAudioCmd* ttp_audio_cmds(const TtpAudioBlock* b) {
    return (const TtpAudioCmd*) (const void*) (b + 1);
}

/* ---- driving the decisions ---------------------------------------------- */

/* The session the audio listens to (0 = none). Two things follow from it: the
 * cars ttp_audio_frame voices, and the RACE EVENTS that make a sound — a
 * pickup, a banana, a spin, a lap chime, a countdown beat — which are decided
 * HERE as the sim fires them, not shipped out and handed back.
 *
 * That is why it is a bind and not an argument: a shell drives more than one
 * session (the lobby's attract demo races a full field behind the menu), and
 * only ONE of them is the race the room can hear. An unbound session is silent,
 * which is what makes the attract demo silent for free.
 *
 * Binding drops any events the previous session had queued: they belong to a
 * race that is over. */
TTP_ABI void ttp_audio_bind(int session);

/* One frame of the continuous mix: the shared curb-scrub throttle and every
 * sustained voice (boost wind, tire squeal, brake skid, engine, a jet per
 * in-flight rocket), read off the bound session's live Game.
 *
 * nowMs is the shell's monotonic clock and is the ONLY thing this layer is told
 * about time — the one-shot spacing gates (a curb scrub cannot machine-gun, lap
 * chimes cannot bunch when eight cars cross together) are the whole of what it
 * is for. It also dates the queued race events flushed by this call, so a beat
 * that fired inside the last ttp_update is decided with the clock of the frame
 * that observed it. */
TTP_ABI void ttp_audio_frame(double nowMs);

/* The lobby roster changed. A bigger count means someone joined (renames and car
 * picks keep it), which is the join plink; inLobby != 0 gates it, because a
 * mid-race arrival is a reconnect and not a new guest. */
TTP_ABI void ttp_audio_roster(int count, int inLobby);

/* Kill every live voice — the pause overlay, the finish, a return to the lobby.
 * Without it a frozen frame holds its wind and squeal forever, since nothing is
 * updating their levels any more. */
TTP_ABI void ttp_audio_stop_voices(void);

/* One car left the race (a forfeit) or changed id (a cross-device rejoin), so
 * no frame will ever feed it a zero level: kill its voices now. idJson is the
 * car's id as a JSON scalar, the same identity ttp_process_input takes. */
TTP_ABI void ttp_audio_stop_car(const char* idJson);

/* The background song. op is a TTP_AUD_MUSIC_* value; biomeOrNull is read only
 * by TTP_AUD_MUSIC_START, which picks from that biome's pool — at random, but
 * never the song that just played when the pool has an alternative, so a cup
 * spent in one biome rotates it. An unknown or null biome takes the fallback
 * pool rather than silence. */
TTP_ABI void ttp_audio_music(int op, const char* biomeOrNull);

/* ---- the drain ----------------------------------------------------------- */

/* Every command decided since the last drain, in the order the shell must
 * perform them, and EMPTY the queue. Never null: with nothing to say it answers
 * a zero-count block, so the shell's loop is the same shape either way.
 *
 * The block is this runtime's own scratch, valid until the next ttp_audio_*
 * call: read it now, don't keep it and don't free it (the ttp_display_hud
 * convention).
 *
 * Draining also flushes any race events still queued behind the bound session,
 * so a shell that only ever calls this still hears them in fire order. */
TTP_ABI const TtpAudioBlock* ttp_audio_drain(void);

/* ---- the two lookups a shell needs once ---------------------------------- */

/* The cue id behind a TTP_CUE_* code — "engine_putt", "banana_slip" — or NULL
 * for a code this build has no cue for. Static storage, like ttp_item_id: the
 * pointer is the decision layer's own literal and outlives every call.
 *
 * A shell walks 1, 2, 3, … until NULL at boot and builds its own table from the
 * answers, which is why there is no list of these names to keep in step
 * anywhere else. */
TTP_ABI const char* ttp_audio_cue_id(int code);

/* The song a TTP_AUD_MUSIC_START command picked, by its `subject` index:
 *   {"file","title","duration","lufs","gain","artist","license","source"}
 * — the path to stream and the credit-chip fields (which is also how the CC-BY
 * attribution is satisfied). "null" for an index outside the catalogue.
 *
 * JSON, and a separate call, because this is the one thing in the audio path
 * that IS text and it happens once per race — off the frame path entirely.
 * Indices are stable for a build: pools in table order, songs in pool order. */
TTP_ABI const char* ttp_audio_song_json(int index);

#ifdef __cplusplus
}
#endif

#endif /* TTP_AUDIO_H */
