// ttp_glb.cc — the marshalling for ttp_glb.h. Thin: both answers are one call
// into libttp-runtime's ttp/glb.h, held in scratch for the caller to read.

#include "ttp_glb.h"

#include <string>
#include <vector>

#include "ttp/canonical.h"
#include "ttp/glb.h"

namespace {

// Two buffers, not one: a shell derives a ghost and asks for its URIs in the
// same breath, and the ABI's "valid until the next call" rule is per-function
// (ttp_abi.h) precisely so those two do not have to be ordered against each
// other.
std::vector<uint8_t>& ghostScratch() {
    static std::vector<uint8_t> b;
    return b;
}

std::string& uriScratch() {
    static std::string s;
    return s;
}

}  // namespace

extern "C" {

const uint8_t* ttp_glb_ghost(const uint8_t* bytes, uint32_t len, uint32_t* outLen) {
    ghostScratch() = ttp::rt::ghost_glb(bytes, len);
    if (outLen) *outLen = (uint32_t) ghostScratch().size();
    return ghostScratch().empty() ? nullptr : ghostScratch().data();
}

const char* ttp_glb_image_uris(const uint8_t* bytes, uint32_t len) {
    ttp::Value a = ttp::Value::Arr();
    for (const std::string& u : ttp::rt::glb_image_uris(bytes, len)) a.push(ttp::Value::Str(u));
    // ordered, not canonical: the array's order is the container's own image
    // order, which a sort would throw away for nothing.
    ttp::ordered_stringify_into(a, uriScratch());
    return uriScratch().c_str();
}

}  // extern "C"
