// blobstore — where a cached blob lives, and which cached blobs should stop
// living, decided once for every shell.
//
// WHAT THIS IS FOR. Some things the engine computes are expensive, derived, and
// worth keeping between RUNS rather than only between builds — the sun bake is
// 520 ms of GPU on the slowest shipping box (see the renderer's bakeShadowMap).
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
    // Which store. Names the cap below and nothing else; an unknown one is not
    // an error, it takes the default.
    std::string store;
    // What identifies the binary that produced (or would produce) these bytes.
    std::string generation;
    // What this build's blobs are OF, in the caller's own vocabulary — the sun
    // bake's is "<track>|<biome>|<showcase>|<backend>", a silhouette's is
    // "<glb fnv>|<backend>". A SET rather than one key, because a store may hold
    // several things a single build wants: the silhouettes are one blob per car
    // MODEL, and a build wants every model in its field.
    std::vector<std::string> keys;
    std::vector<BlobEntry> entries;
};

struct BlobPlan {
    // The one name each key may be read from and written to, parallel to `keys`.
    std::vector<std::string> names;
    // Names to delete, in no order: every other generation's, plus this
    // generation's oldest once the store is over its cap.
    std::vector<std::string> drop;
};

// THE WHOLE POLICY, as one answer. One crossing per build rather than one to
// ask the name and another to ask what to evict — the same reason the net walks
// answer an effect list instead of a dozen getters.
BlobPlan planBlob(const BlobRequest& in);

// How many blobs a store keeps. Public so a test can state the number rather
// than infer it, and so the ONE place it lives is here (root rule 1).
uint32_t blobKeep(const std::string& store);

}  // namespace rt
}  // namespace ttp
