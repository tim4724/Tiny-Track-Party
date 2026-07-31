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

Returns come out in the model's key order, because the snapshot IS the wire. One
piece of configured state (the chooser payload) is set once and stays opaque to
the model, bar the rule that tracks ride the LOBBY snapshot only.

**Deliberately did not cross:** the transport and its timers, the QR bitmap (the
URL composition is shared, the bitmap is three platform one-liners), the reconnect
card's DOM, identity generation (no rules, just entropy), and the random pick's
shuffle bag (page RNG — the select-mode walk answers `needDraw` and the shell
draws). The mode pick's RULES did cross, but into the walk layer above this one
(`runtime/ttp_net.cc`): they read the configured chooser as their catalogue,
which this layer keeps opaque.

**The sequencing of these rules is C++ too** — the walk entry points in
`runtime/ttp_net.h` drive the live RoomFlow and answer effect lists — but it
lives in the ABI shim, not here: this library stays pure over plain data, which
is what keeps the frozen corpus replayable with no room machine at all.

**`norm_index` carries a frozen, security-adjacent quirk.** It is JS
`Number(value)`, so a HELLO with an explicit null rejoin token claims seat 0 while
one with no token claims nothing. It is harmless only because seat 0 is the
display's own slot and never appears on the roster. **Do not tidy it** — the corpus
pins both answers, and the ABI takes the whole HELLO rather than the token so
absent and null stay distinguishable.

## Liveness and disconnects

The relay fires `peer_left` only on a real socket close, so the display also runs
its own liveness: phones ping, and a seat silent past the timeout is dropped
mid-game by the same path, with any traffic restoring it. Both windows live in the
protocol manifest, because "silent past N seconds" is only true against a matching
ping rate.

The self-heartbeat uses an **in-flight flag, never an echo age**, so a throttled
background tab cannot misread its own starvation as a dead link. The shell owns
only the interval and the calls the tick asks for.

**The abandoned-race policy** rides that same tick: every participant gone while
someone waits arms a grace timer that fires once. Its participant set is derived
from the LIVE RACE through the session seam — every seat holding a car, plus every
dropped seat — so a shell passes a session handle and **no car id is ever
serialized out and handed back.**

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
