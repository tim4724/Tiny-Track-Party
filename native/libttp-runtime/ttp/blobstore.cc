#include "ttp/blobstore.h"

#include <algorithm>

namespace ttp {
namespace rt {

namespace {

// The separator between a generation and a key inside a name. Two underscores
// because a single one survives sanitisation below and could therefore appear
// inside either half; this pair cannot, so the split is unambiguous even though
// nothing here ever needs to split it.
constexpr const char* kSep = "__";

// FNV-1a over the RAW key, so two keys that sanitise to the same characters
// still get different names. Sanitisation is lossy by construction — it has to
// be, because a key is the caller's vocabulary and a filename is the platform's
// — and a silent collision between two tracks would serve one's blob for the
// other, which is exactly the class of bug the generation rule exists to stop.
std::string hash8(const std::string& s) {
    uint32_t h = 2166136261u;
    for (const unsigned char c : s) {
        h ^= c;
        h *= 16777619u;
    }
    static const char* kHex = "0123456789abcdef";
    std::string out(8, '0');
    for (int i = 7; i >= 0; i--) {
        out[i] = kHex[h & 0xfu];
        h >>= 4;
    }
    return out;
}

// What every filesystem this runs on agrees is a filename. Deliberately narrow:
// the caller's key is free text (a dev track's id reaches this), and the cost of
// being conservative is a hash suffix that is already there.
std::string safe(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9') || c == '.' || c == '-';
        out.push_back(ok ? c : '_');
    }
    return out;
}

}  // namespace

uint32_t blobKeep(const std::string& store) {
    // The sun bake is ~2.3 MB a blob (a 1024² R16F ESM, a 512² R8 visibility map
    // and the road's baked vertex light), so eight is ~18 MB — enough to hold a
    // cup's four circuits plus the lobby browsing around them, against a
    // catalogue whose full set would be ~46 MB.
    if (store == "bake") return 8;
    // An unknown store still gets a bound. A cache with no cap is a disk leak,
    // and answering 0 here would instead delete everything a new caller wrote.
    return 8;
}

BlobPlan planBlob(const BlobRequest& in) {
    BlobPlan plan;
    const std::string gen = safe(in.generation);
    plan.name = gen + kSep + safe(in.key) + "-" + hash8(in.key) + ".blob";

    // OTHER GENERATIONS GO FIRST, and they go whatever the cap says: they are
    // not old, they are unreadable — produced by a binary that is no longer
    // installed, and therefore not trustworthy about anything this one will
    // render. Kept separate from the cap sweep below so a store that is under
    // its cap still sheds them.
    const std::string prefix = gen + kSep;
    std::vector<const BlobEntry*> mine;
    for (const BlobEntry& e : in.entries) {
        if (e.name.rfind(prefix, 0) == 0) {
            mine.push_back(&e);
        } else {
            plan.drop.push_back(e.name);
        }
    }

    // Then the cap, oldest-USED first. The entry this plan is about is exempt:
    // it is about to be read or written, so evicting it would be a cache that
    // deletes precisely what was asked for whenever the store is full.
    const uint32_t keep = blobKeep(in.store);
    if (mine.size() > keep) {
        std::sort(mine.begin(), mine.end(),
                [](const BlobEntry* a, const BlobEntry* b) { return a->usedMs < b->usedMs; });
        size_t over = mine.size() - keep;
        for (const BlobEntry* e : mine) {
            if (over == 0) break;
            if (e->name == plan.name) continue;
            plan.drop.push_back(e->name);
            over--;
        }
    }
    return plan;
}

}  // namespace rt
}  // namespace ttp
