# native/libttp-party/ — room state, framing, session policy

The party layer's **decisions**. The transport itself never crosses into C++ —
sockets and `RTCPeerConnection` stay in `partyplug/`.

## The session policy

`ttp/session.{h,cc}` behind `runtime/ttp_net.h` is the ROOM half of what the
display's net module used to do inline: the retained room snapshot and its players
projection, the URLs a room's identity is spelled into, the seat cap, what a close
and an intentional LEAVE mean in each phase, the SET_CAR/SET_READY guards, the
phase-flip effects and host-promotion ready-clear, the self-heartbeat machine, the
cross-device claim, and post-reload reconciliation against the relay's peer list.

**It holds no room handle and mutates nothing** — every function is pure over
plain data, which is what lets the corpus replay with no room machine at all.

Returns are plain `Value` trees and their key order means nothing: the snapshot's
only caller frames it, and the frame encoder canonicalizes, so the composed order
has never reached a phone. One piece of configured state (the chooser payload) is
set once and stays opaque to the model, bar the rule that tracks ride the LOBBY
snapshot only.

**Deliberately did not cross:** the transport and its timers, the QR bitmap (the
URL composition is shared, the bitmap is three platform one-liners), the reconnect
card's DOM, and identity generation (no rules, just entropy). The random
pick's shuffle bag lives behind the room handle in the walk layer now — the
shell seeds it once with page entropy and the select-mode walk draws
internally. The mode pick's RULES crossed into that same walk layer
(`runtime/ttp_net.cc`): they read the configured chooser as their catalogue,
which this layer keeps opaque.

**The sequencing of these rules is C++ too** — the walk entry points in
`runtime/ttp_net.h` drive the live RoomFlow and answer effect lists — but it
lives in the ABI shim, not here: this library stays pure over plain data, which
is what keeps the frozen corpus replayable with no room machine at all.

**A rejoinToken is an integer or it is nothing.** `norm_index` accepts a JSON
number that is finite, integral and non-negative, and refuses every other shape,
so absent and null are the same answer and a client that sends the seat as a
string silently fails to claim. Untrusted phone input is type-checked here, never
coerced. This layer used to reproduce JS `Number(value)` instead, under which a
null read as 0 and every ordinary HELLO was a claim on seat 0; the corpus pins
the current answers.

## Liveness and disconnects

The relay fires `peer_left` only on a real socket close, so the display also runs
its own liveness: phones ping, and a seat silent past the timeout is dropped
mid-game by the same path, with any traffic restoring it. Both windows live in the
protocol manifest, because "silent past N seconds" is only true against a matching
ping rate.

The self-heartbeat uses an **in-flight flag, never an echo age**, so a throttled
background tab cannot misread its own starvation as a dead link. The shell owns
only the interval and the calls the tick asks for.

**The abandoned-room policy** rides that same tick and has TWO arms on ONE grace
deadline, both firing once. Mid-race: every participant gone while someone waits.
On the RESULTS board: **no connected peer at all** — the same "the room is empty"
the cup chain's advance already uses. The results arm replaced a wall-clock
failsafe the three shells armed off the end of a race, which fired on a timer and
so yanked a party that was still talking off its own podium; it fires on the
condition that timer was always a proxy for. **A podium with anybody still in the
room waits for a human**, however long it sits there.

The mid-race arm's participant set is derived from the LIVE RACE through the
session seam — every seat holding a car, plus every dropped seat — so a shell
passes a session handle and **no car id is ever serialized out and handed back.**

What falls outside that set is exactly a connected, car-less seat, and one
definition stands behind the policy, the standings' joining rows and the display's
silent auto-pause.

**Syncing it is load-bearing:** the kit's own countdown snapshot would count a
DROPPED late joiner as someone waiting and yank a blipped party's race back to the
lobby. That unfiltered kit semantics is pinned by the frozen corpus — adding a
connected filter turns `roomflow` red. **Fix the SET, never the C++.**

## Room teardown

When the room dies — host close, or the relay's hostless grace after the display
vanishes — every member socket closes with 4001, which is **TERMINAL**: no
auto-reconnect, and controllers bail to a party-over overlay.

**The display tab exiting IS the party ending.** `pagehide` shuts the room down,
including on a reload, which therefore boots into a fresh room. The sessionStorage
rejoin remains as CRASH recovery only: no pagehide means the room survives and the
reloaded display regathers the party.

## protocol.h

Carries the shared manifest, codegen-checked against `public/shared/protocol.js`
by the protocol corpus and its ctest, which also asserts the sim's steer expo
equals the manifest's. `ttp_protocol_manifest_json()` re-exports the whole thing
for shells that can read neither source — see `public/shared/CLAUDE.md` for the
rule itself.
