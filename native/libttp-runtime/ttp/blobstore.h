// blobstore — where a cached blob lives, and which cached blobs should stop
// living, decided once for every shell.
//
// WHAT THIS IS FOR. Some things the engine computes are expensive, derived, and
// worth keeping between RUNS rather than only between builds — the sun bake is
// the one today, and on the slowest shipping box it is a visible slice of a
// lobby's latency (see the renderer's bakeShadowMap).
// Keeping something between runs means a FILE, and a file is the shell's job:
// `ttp_abi.h` puts transport on the host side by design, and wasm has no
// filesystem at all, so there is no version of this where C++ opens the file.
//
// WHAT IS NOT THE SHELL'S JOB is everything else. A shell that stores blobs has
// to answer three questions — what do I call this one, when does it stop being
// valid, and which do I throw away — and every one of those is a rule rather
// than a platform fact. Three shells answering them independently is three
// chances to answer differently, and the answers are not equally visible when
// wrong: a bad eviction wastes disk, but a bad INVALIDATION serves a stale blob
// forever, across restarts, with nothing on screen to say so.
//
// So the split is the tree's usual one. This decides; the shell performs four
// primitives it cannot avoid owning:
//
//   list()   — the names it holds, with when each was last used
//   read()   — bytes by name
//   write()  — bytes by name
//   delete() — by name
//
// GENERATION IS THE INVALIDATION, and it is the caller's to supply because only
// a shell knows what identifies its own binary (Android has the install time,
// tvOS its bundle version, the web its BUILD_STAMP). It is folded into the NAME
// rather than checked separately, which is what makes a stale blob unreachable
// rather than merely rejected: a new generation cannot even name last
// generation's file, and last generation's files come back in `drop` on the
// first plan that sees them.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "generated/track_defs.h"  // TTP_TRACK_COUNT: the cap is sized to it

namespace ttp {
namespace rt {

// One blob the shell currently holds. `usedMs` orders eviction and is the
// shell's clock, never compared against anything but its siblings — an epoch,
// an uptime and a file mtime all sort the same way.
struct BlobEntry {
    std::string name;
    double usedMs = 0;
};

struct BlobRequest {
    // What identifies the binary that produced (or would produce) these bytes.
    std::string generation;
    // What this build's blob is OF, in the caller's own vocabulary — the sun
    // bake's is "<track>|<biome>|<showcase>|<backend>".
    std::string key;
    std::vector<BlobEntry> entries;
};

struct BlobPlan {
    // The one name the key may be read from and written to.
    std::string name;
    // Names to delete, in no order: every other generation's, plus this
    // generation's oldest once the store is over its cap.
    std::vector<std::string> drop;
};

// THE WHOLE POLICY, as one answer. One crossing per build rather than one to
// ask the name and another to ask what to evict — the same reason the net walks
// answer an effect list instead of a dozen getters.
BlobPlan planBlob(const BlobRequest& in);

// How many blobs the store keeps. It is sized to the CATALOGUE, not to a cup:
// Random's no-repeat bag and World Tour visit every track before they revisit
// one, and a session spanning several cups comes back to tracks it left long
// ago, so a cap under the track count evicts each blob just before it is wanted
// and every visit bakes cold. The slack is for the biome and showcase keys the
// galleries add; a cache with no cap is a disk leak.
// Public so a test states the number rather than infers it, and so the ONE
// place it lives is here (root rule 1).
constexpr uint32_t kBlobKeep = TTP_TRACK_COUNT + 4;

}  // namespace rt
}  // namespace ttp
