// glb_mesh — a minimal GLB *mesh* reader: node names and their triangle
// geometry, nothing else. It exists for the renderer's merged draw groups,
// which need each kit mesh's vertices in a buffer of their own (gltfio keeps
// its VertexBuffers private), and it reads the same bytes the shell already
// provided (`TtpRenderer::provideAsset`), so nothing new crosses any boundary.
//
// HEADER-ONLY ON PURPOSE. The renderer and libttp-runtime may not link each
// other (native/CLAUDE.md), so like `boost_shades` in theme.h this is inline in
// a header both sides can include: the renderer consumes it, and a ctest can
// execute it on every leg without a Filament SDK. It leans on ttp::json::Parser,
// which the renderer already links transitively (libttp_track → libttp_json).
//
// STRICT ABOUT WHAT IT ACCEPTS, EMPTY ABOUT EVERYTHING ELSE. The kit's GLBs are
// float POSITION/NORMAL/TEXCOORD_0 with u8/u16/u32 indices in one embedded BIN
// chunk; anything outside that (sparse accessors, external buffers, non-float
// attributes) returns {} for the WHOLE model, and the caller keeps drawing the
// asset the way gltfio loaded it. A partial read that silently dropped one
// primitive would be a hole in a model with nothing to say so.
//
// GLB container layout: see ttp/glb.h. Chunk lengths are 4-byte padded by every
// conforming exporter; a straggler is tolerated by rounding up.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "ttp/json_parse.h"

namespace ttp {
namespace rt {

struct GlbMeshPrim {
    std::vector<float> pos;       // 3 floats per vertex
    std::vector<float> normal;    // 3 per vertex; empty when the file has none
    std::vector<float> uv;        // 2 per vertex; empty when the file has none
    std::vector<uint32_t> idx;    // triangles
};

struct GlbMeshNode {
    std::string name;             // the glTF node's own name ("" when unnamed)
    int mesh = -1;                // the glTF mesh index — nodes SHARING one
                                  // (the per-side wheel pairs) carry the same
                                  // value, which is what lets a consumer put
                                  // them in one instanced group
    std::vector<GlbMeshPrim> prims;
};

namespace glbmesh_detail {

inline uint32_t le32(const uint8_t* p) {
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8)
            | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

// One accessor's raw element pointer walk: base + per-element stride, bounds
// checked against the BIN chunk once up front.
struct AccessorView {
    const uint8_t* base = nullptr;
    size_t stride = 0;
    size_t count = 0;
    uint32_t componentType = 0;   // 5121 u8, 5123 u16, 5125 u32, 5126 float
    int components = 0;           // SCALAR 1, VEC2 2, VEC3 3
};

inline int componentCount(const std::string& type) {
    if (type == "SCALAR") return 1;
    if (type == "VEC2") return 2;
    if (type == "VEC3") return 3;
    return 0;
}

inline size_t componentBytes(uint32_t componentType) {
    switch (componentType) {
        case 5121: return 1;   // UNSIGNED_BYTE
        case 5123: return 2;   // UNSIGNED_SHORT
        case 5125: return 4;   // UNSIGNED_INT
        case 5126: return 4;   // FLOAT
        default: return 0;
    }
}

inline bool accessorView(const Value& doc, size_t index,
        const uint8_t* bin, size_t binLen, AccessorView& out) {
    const Value* accessors = doc.find("accessors");
    const Value* views = doc.find("bufferViews");
    if (!accessors || accessors->type != Value::ARR || index >= accessors->arr.size()
            || !views || views->type != Value::ARR) {
        return false;
    }
    const Value& a = accessors->arr[index];
    if (a.type != Value::OBJ || a.has("sparse")) return false;
    const Value* bv = a.find("bufferView");
    const Value* ct = a.find("componentType");
    const Value* cnt = a.find("count");
    const Value* ty = a.find("type");
    if (!bv || !ct || !cnt || !ty || ty->type != Value::STR) return false;
    const size_t vi = (size_t) bv->num;
    if (vi >= views->arr.size()) return false;
    const Value& v = views->arr[vi];
    if (v.type != Value::OBJ) return false;
    const Value* buf = v.find("buffer");
    if (buf && buf->num != 0) return false;   // only the embedded BIN chunk
    out.componentType = (uint32_t) ct->num;
    out.components = componentCount(ty->str);
    out.count = (size_t) cnt->num;
    const size_t cb = componentBytes(out.componentType);
    if (!cb || !out.components || !out.count) return false;
    const size_t element = cb * (size_t) out.components;
    const Value* strideV = v.find("byteStride");
    out.stride = strideV ? (size_t) strideV->num : element;
    if (out.stride < element) return false;
    const Value* vOff = v.find("byteOffset");
    const Value* aOff = a.find("byteOffset");
    const size_t off = (vOff ? (size_t) vOff->num : 0) + (aOff ? (size_t) aOff->num : 0);
    const Value* vLen = v.find("byteLength");
    if (!vLen) return false;
    // The last element needs `element` bytes; earlier ones a full stride each.
    const size_t need = off + (out.count - 1) * out.stride + element;
    if (need > binLen || need > (vOff ? (size_t) vOff->num : 0) + (size_t) vLen->num) {
        return false;
    }
    out.base = bin + off;
    return true;
}

inline bool readFloats(const Value& doc, size_t accessor, int wantComponents,
        const uint8_t* bin, size_t binLen, std::vector<float>& out) {
    AccessorView v;
    if (!accessorView(doc, accessor, bin, binLen, v)) return false;
    if (v.componentType != 5126 || v.components != wantComponents) return false;
    out.resize(v.count * (size_t) wantComponents);
    for (size_t i = 0; i < v.count; i++) {
        std::memcpy(&out[i * wantComponents], v.base + i * v.stride,
                sizeof(float) * (size_t) wantComponents);
    }
    return true;
}

inline bool readIndices(const Value& doc, size_t accessor,
        const uint8_t* bin, size_t binLen, std::vector<uint32_t>& out) {
    AccessorView v;
    if (!accessorView(doc, accessor, bin, binLen, v)) return false;
    if (v.components != 1) return false;
    out.resize(v.count);
    for (size_t i = 0; i < v.count; i++) {
        const uint8_t* p = v.base + i * v.stride;
        switch (v.componentType) {
            case 5121: out[i] = *p; break;
            case 5123: out[i] = (uint32_t) p[0] | ((uint32_t) p[1] << 8); break;
            case 5125: out[i] = le32(p); break;
            default: return false;
        }
    }
    return true;
}

}  // namespace glbmesh_detail

// Every glTF node that carries a mesh, with its triangles decoded. {} when the
// bytes are not a GLB this reader fully understands — never a partial answer.
inline std::vector<GlbMeshNode> read_glb_meshes(const uint8_t* bytes, size_t len) {
    using namespace glbmesh_detail;
    constexpr uint32_t kMagic = 0x46546C67;      // "glTF"
    constexpr uint32_t kJson = 0x4E4F534A;       // "JSON"
    constexpr uint32_t kBin = 0x004E4942;        // "BIN\0"
    if (!bytes || len < 20 || le32(bytes) != kMagic) return {};
    // Chunk walk: JSON first (mandatory), then the BIN chunk if any.
    std::string json;
    const uint8_t* bin = nullptr;
    size_t binLen = 0;
    size_t off = 12;
    while (off + 8 <= len) {
        const size_t clen = le32(bytes + off);
        const uint32_t ctype = le32(bytes + off + 4);
        if (off + 8 + clen > len) return {};
        if (ctype == kJson && json.empty()) {
            json.assign((const char*) bytes + off + 8, clen);
        } else if (ctype == kBin && !bin) {
            bin = bytes + off + 8;
            binLen = clen;
        }
        off += 8 + ((clen + 3) & ~(size_t) 3);
    }
    if (json.empty() || !bin) return {};

    Value doc;
    if (!json::Parser(json).parse(doc) || doc.type != Value::OBJ) return {};
    const Value* meshes = doc.find("meshes");
    const Value* nodes = doc.find("nodes");
    if (!meshes || meshes->type != Value::ARR || !nodes || nodes->type != Value::ARR) {
        return {};
    }

    // Meshes first, so two nodes sharing one (the wheel pairs) decode it once.
    std::vector<std::vector<GlbMeshPrim>> decoded(meshes->arr.size());
    for (size_t m = 0; m < meshes->arr.size(); m++) {
        const Value& mesh = meshes->arr[m];
        if (mesh.type != Value::OBJ) return {};
        const Value* prims = mesh.find("primitives");
        if (!prims || prims->type != Value::ARR) return {};
        for (const Value& p : prims->arr) {
            if (p.type != Value::OBJ) return {};
            // mode absent means TRIANGLES (4); anything else is not this kit.
            const Value* mode = p.find("mode");
            if (mode && mode->num != 4) return {};
            const Value* attrs = p.find("attributes");
            const Value* idx = p.find("indices");
            if (!attrs || attrs->type != Value::OBJ || !idx) return {};
            GlbMeshPrim out;
            const Value* posA = attrs->find("POSITION");
            if (!posA || !readFloats(doc, (size_t) posA->num, 3, bin, binLen, out.pos)) {
                return {};
            }
            if (const Value* na = attrs->find("NORMAL")) {
                if (!readFloats(doc, (size_t) na->num, 3, bin, binLen, out.normal)) {
                    return {};
                }
            }
            if (const Value* ua = attrs->find("TEXCOORD_0")) {
                if (!readFloats(doc, (size_t) ua->num, 2, bin, binLen, out.uv)) {
                    return {};
                }
            }
            if (!readIndices(doc, (size_t) idx->num, bin, binLen, out.idx)
                    || out.idx.size() % 3) {
                return {};
            }
            decoded[m].push_back(std::move(out));
        }
    }

    std::vector<GlbMeshNode> out;
    for (const Value& n : nodes->arr) {
        if (n.type != Value::OBJ) continue;
        const Value* mesh = n.find("mesh");
        if (!mesh) continue;
        const size_t mi = (size_t) mesh->num;
        if (mi >= decoded.size()) return {};
        GlbMeshNode node;
        if (const Value* nm = n.find("name")) {
            if (nm->type == Value::STR) node.name = nm->str;
        }
        node.mesh = (int) mi;
        node.prims = decoded[mi];
        out.push_back(std::move(node));
    }
    return out;
}

}  // namespace rt
}  // namespace ttp
