// The C ABI, as Swift sees it.
//
// Every one of these headers is `extern "C"` guarded plain C, so Swift consumes
// them directly — no generated bridge, no marshalling layer, no second
// declaration of anything. That is the asymmetry `docs/native-port/shells.md`
// calls out: Swift gets the header, JS gets `cwrap`, and a JVM shell would get
// neither.
//
// The rule this file exists to keep: NOTHING is declared here. It only includes.
// A signature retyped into Swift (or into this header) is a signature pinned by
// nothing, and it will drift the first time a number moves — which is the exact
// failure `ttp_protocol_manifest_json` exists to prevent for constants.

#import <Foundation/Foundation.h>

// The sim: sessions, cars, input, the race lifecycle.
#import "ttp_runtime.h"
// The party layer: rooms, relay framing, the fastlane codec.
#import "ttp_party.h"
// The session policy over it: the retained room snapshot, seat rules, the
// heartbeat state machine.
#import "ttp_net.h"
// Every 2D screen's decisions, as keys plus data.
#import "ttp_ui.h"
// The race orchestration — ordered effect lists, never a verdict.
#import "ttp_race.h"
// Which cue, at what gain, which song.
#import "ttp_audio.h"
// Biome names and the two colours the renderer does not draw.
#import "ttp_theme.h"
// Why the last call refused. Without this a shell composes its own message at
// each throw site, and every one of those is a guess.
#import "ttp_error.h"
// The GLB container reads: the ghost clone and the texture-URI scan.
#import "ttp_glb.h"
// The surface, the scene, the cameras and the frame.
#import "ttp_display.h"
// ...and this platform's only extra entry point: ttp_display_create typed for a
// CAMetalLayer rather than a CSS selector.
#import "ttp_display_tvos.h"
