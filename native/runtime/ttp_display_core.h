// ttp_display_core.h — INTERNAL header, not an ABI (like ttp_session.h): the
// display singleton that ttp_display_core.cc (the shared extern "C" bodies)
// and each platform's surface file (ttp_display_web.cc, and the tvOS/Android
// siblings) both hold.
//
// The split it exists for: everything about the display that names NO platform
// API — which is every ABI body except creating and destroying the surface —
// compiles ONCE, in ttp_display_core.cc, for every shell. A platform's own
// file derives from DisplayCore (adding its GL context / CAMetalLayer /
// ANativeWindow), fills these fields in ttp_display_create, and parks the
// object here for the core to work on.
#pragma once

#include "ttp/frame_builder.h"

#include <string>

class TtpRenderer;

namespace ttp {
namespace rt {

// The platform half of the display, over the platform-free state the frame
// builder works on. Deriving rather than embedding keeps every field reading
// exactly as it did when the two halves were one file.
struct DisplayCore : DisplayState {
    TtpRenderer* renderer = nullptr;
    bool built = false;

    // One blob walk's state between its crossings (ttp_display.h). It spans
    // `plan` → `offer` → `build` → `keep`, which is one scene build and never
    // outlives it: `plan` resets it, so a shell that skips a step gets a walk
    // that declines to write rather than one that writes the wrong blob.
    struct BlobWalk {
        std::string name;   // what this key reads and writes under
        bool held = false;  // …and whether the store already had it
        bool primed = false;// the engine took the blob the shell offered
    };
    // One per store, indexed as ttp_display_blob_stores lists them.
    BlobWalk blobWalk[2];
};

// The process-wide display slot — the ABI is a deliberate singleton (see
// ttp_display.h). The platform surface file creates and destroys the object;
// the shared core only ever reads the slot.
DisplayCore*& displayCore();

}  // namespace rt
}  // namespace ttp
