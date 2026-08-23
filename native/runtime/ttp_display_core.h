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

    // A blob walk's state between its crossings (ttp_display.h), in two halves
    // with two different lifetimes — which is the whole lesson of the version
    // that had one.
    //
    // PLANNED spans `plan` → `offer` → `build` and never outlives it: `plan`
    // resets it, so a shell that skips a step gets a walk that declines rather
    // than one that writes the wrong blob.
    //
    // OUTBOUND OUTLIVES ITS BUILD, and it has to. On GL a build cannot finish
    // its own readbacks, so the bytes land a frame or more later — after the
    // next `plan` may already have run. When the two were one, the only blob the
    // web ever managed to write was one whose track had been built twice in a
    // row; a Grand Prix's second, third and fourth circuits were never stored at
    // all, in any session.
    struct BlobPlanned {
        std::string key;    // the renderer's own name for the thing
        std::string name;   // …and the file it reads and writes under
        bool held = false;  // whether the store already had it
        bool primed = false;// the engine took the blob the shell offered
    };
    // One blob on its way to the store. Recorded when the build STAGES it, not
    // when the pixels land: the renderer knows only the key, the filename is the
    // plan's, and a second build with no frame between would otherwise clear the
    // pairing while the read was still in flight and strand the bytes.
    struct BlobOutbound {
        std::string key;
        std::string name;
        std::vector<uint8_t> bytes;   // empty until the reads land
    };
    struct BlobWalk {
        std::vector<BlobPlanned> planned;
        // `keep` names the ones that have bytes, `export` hands the same buffer
        // straight back, and `wrote` drops the entry.
        std::vector<BlobOutbound> outbound;
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
