#include "ttp/glb.h"

#include <cstring>

#include "ttp/canonical.h"
#include "ttp/json_parse.h"

namespace ttp {
namespace rt {
namespace {

constexpr uint32_t kGlbMagic = 0x46546C67u;  // 'glTF'
constexpr uint32_t kChunkJson = 0x4E4F534Au;  // 'JSON'
constexpr size_t kJsonPayloadStart = 20;      // 12-byte header + 8-byte chunk header

uint32_t le32(const uint8_t* p) {
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) |
           ((uint32_t) p[3] << 24);
}

void put_le32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t) (v & 0xFF);
    p[1] = (uint8_t) ((v >> 8) & 0xFF);
    p[2] = (uint8_t) ((v >> 16) & 0xFF);
    p[3] = (uint8_t) ((v >> 24) & 0xFF);
}

}  // namespace

bool json_chunk(const uint8_t* bytes, size_t len, std::string& out) {
    if (!bytes || len < kJsonPayloadStart) return false;
    if (le32(bytes) != kGlbMagic) return false;
    if (le32(bytes + 16) != kChunkJson) return false;
    const uint32_t jsonLen = le32(bytes + 12);
    if (jsonLen > len - kJsonPayloadStart) return false;
    out.assign((const char*) bytes + kJsonPayloadStart, jsonLen);
    return true;
}

std::vector<uint8_t> ghost_glb(const uint8_t* bytes, size_t len) {
    std::string text;
    if (!json_chunk(bytes, len, text)) return {};
    ttp::Value doc;
    if (!ttp::json::Parser(text).parse(doc) || doc.type != ttp::Value::OBJ) return {};

    // The whole edit. `materials` absent is legal glTF (a mesh can rely on the
    // default material), and there is then nothing to make translucent — the
    // clone is still emitted, because the caller asked for bytes it can provide
    // under a ghost name and an opaque ghost beats no asset at all.
    for (auto& kv : doc.obj) {
        if (kv.first != "materials" || kv.second.type != ttp::Value::ARR) continue;
        for (ttp::Value& mat : kv.second.arr) {
            if (mat.type != ttp::Value::OBJ) continue;
            // Read the incoming factor before anything is overwritten: RGB is
            // kept, only alpha moves.
            double rgb[3] = { 1.0, 1.0, 1.0 };
            if (const ttp::Value* pbr = mat.find("pbrMetallicRoughness")) {
                if (const ttp::Value* f = pbr->find("baseColorFactor")) {
                    for (size_t i = 0; i < 3 && i < f->arr.size(); i++) {
                        if (f->arr[i].type == ttp::Value::NUM) rgb[i] = f->arr[i].num;
                    }
                }
            }
            ttp::Value factor = ttp::Value::Arr();
            for (double c : rgb) factor.push(ttp::Value::Num(c));
            factor.push(ttp::Value::Num(0.5));

            // set() appends, so an existing key would be duplicated rather than
            // replaced; strip first and re-add. (canonical_stringify would emit
            // both.)
            ttp::Value pbrOut = ttp::Value::Obj();
            for (auto& mkv : mat.obj) {
                if (mkv.first == "pbrMetallicRoughness" && mkv.second.type == ttp::Value::OBJ) {
                    for (auto& pkv : mkv.second.obj) {
                        if (pkv.first != "baseColorFactor") pbrOut.set(pkv.first, pkv.second);
                    }
                }
            }
            pbrOut.set("baseColorFactor", std::move(factor));

            ttp::Value out = ttp::Value::Obj();
            for (auto& mkv : mat.obj) {
                if (mkv.first == "alphaMode" || mkv.first == "doubleSided" ||
                    mkv.first == "pbrMetallicRoughness") {
                    continue;
                }
                out.set(mkv.first, mkv.second);
            }
            out.set("alphaMode", ttp::Value::Str("BLEND"));
            out.set("doubleSided", ttp::Value::Bool(false));
            out.set("pbrMetallicRoughness", std::move(pbrOut));
            mat = std::move(out);
        }
    }

    // ordered_stringify, not canonical: a glTF document's key order carries no
    // meaning to cgltf, and preserving the source's order keeps a diff of the
    // two chunks readable when one of these ever has to be debugged.
    std::string json = ttp::ordered_stringify(doc);
    // Pad to a 4-byte boundary with spaces, per the GLB spec — measured on the
    // encoded BYTES (see the header).
    while (json.size() % 4) json += ' ';

    const uint32_t srcJsonLen = le32(bytes + 12);
    const uint8_t* rest = bytes + kJsonPayloadStart + srcJsonLen;
    const size_t restLen = len - kJsonPayloadStart - srcJsonLen;

    std::vector<uint8_t> out(kJsonPayloadStart + json.size() + restLen);
    std::memcpy(out.data(), bytes, 12);            // magic, version, (length)
    put_le32(out.data() + 8, (uint32_t) out.size());
    put_le32(out.data() + 12, (uint32_t) json.size());
    put_le32(out.data() + 16, kChunkJson);
    std::memcpy(out.data() + kJsonPayloadStart, json.data(), json.size());
    if (restLen) std::memcpy(out.data() + kJsonPayloadStart + json.size(), rest, restLen);
    return out;
}

std::vector<std::string> glb_image_uris(const uint8_t* bytes, size_t len) {
    std::vector<std::string> uris;
    std::string text;
    if (!json_chunk(bytes, len, text)) return uris;
    ttp::Value doc;
    if (!ttp::json::Parser(text).parse(doc)) return uris;
    const ttp::Value* images = doc.find("images");
    if (!images || images->type != ttp::Value::ARR) return uris;
    for (const ttp::Value& img : images->arr) {
        const ttp::Value* uri = img.type == ttp::Value::OBJ ? img.find("uri") : nullptr;
        if (!uri || uri->type != ttp::Value::STR || uri->str.empty()) continue;
        // A data: URI carries its own bytes; there is nothing for a shell to go
        // and fetch.
        if (uri->str.compare(0, 5, "data:") == 0) continue;
        bool seen = false;
        for (const std::string& u : uris) seen = seen || u == uri->str;
        if (!seen) uris.push_back(uri->str);
    }
    return uris;
}

}  // namespace rt
}  // namespace ttp
