// glbmesh_check — the GLB mesh reader (ttp/glb_mesh.h) behind the renderer's
// merged draw groups, executed on every leg the way the four-legs rule wants
// header-inline library code to be. No corpus and no oracle: the reader's
// contract is behavioural and this pins its two halves —
//
//   * WHAT IT READS comes back exactly: positions, normals, uvs and indices
//     through tight and INTERLEAVED buffer views, u16 and u32 indices, node
//     names, and the shared-mesh identity two nodes wearing one mesh carry
//     (the per-side wheel pairs are the consumer that needs it).
//   * QUANTIZED ATTRIBUTES (KHR_mesh_quantization: normalized i8 normals in a
//     4-byte stride, normalized u16 uvs) decode as cgltf decodes them.
//   * EVERY KIT MODEL DECODES, when the asset directory is given: one the
//     reader refused would draw unmerged and live-lit, silently.
//   * WHAT IT CANNOT READ refuses the WHOLE model — a sparse accessor, a
//     truncated container, a non-triangle mode. The renderer's fallback is
//     "keep drawing the gltfio originals", so a partial answer would be a
//     silently hole-y model; {} is the only honest failure.
//
// The GLB is synthesized here byte by byte, so the check needs no fixture and
// cannot rot with the asset kit.

#include <dirent.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "ttp/glb_mesh.h"

using ttp::rt::GlbMeshNode;
using ttp::rt::read_glb_meshes;

namespace {

int checked = 0, failed = 0;

void expect(bool ok, const char* what) {
  checked++;
  if (ok) return;
  failed++;
  std::fprintf(stderr, "FAIL %s\n", what);
}

void put32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back((uint8_t) (x & 0xFF));
  v.push_back((uint8_t) ((x >> 8) & 0xFF));
  v.push_back((uint8_t) ((x >> 16) & 0xFF));
  v.push_back((uint8_t) ((x >> 24) & 0xFF));
}

void putF(std::vector<uint8_t>& v, float f) {
  uint32_t x;
  std::memcpy(&x, &f, 4);
  put32(v, x);
}

// One GLB from a JSON string and a BIN payload, 4-byte padding per spec.
std::vector<uint8_t> glb(std::string json, std::vector<uint8_t> bin) {
  while (json.size() % 4) json.push_back(' ');
  while (bin.size() % 4) bin.push_back(0);
  std::vector<uint8_t> out;
  put32(out, 0x46546C67);                    // "glTF"
  put32(out, 2);
  put32(out, (uint32_t) (12 + 8 + json.size() + 8 + bin.size()));
  put32(out, (uint32_t) json.size());
  put32(out, 0x4E4F534A);                    // "JSON"
  out.insert(out.end(), json.begin(), json.end());
  put32(out, (uint32_t) bin.size());
  put32(out, 0x004E4942);                    // "BIN\0"
  out.insert(out.end(), bin.begin(), bin.end());
  return out;
}

std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {});
}

// One quantized triangle: float positions, i8 normals (stride 4), u16 uvs.
void checkQuantized() {
  std::vector<uint8_t> bin;
  const float pos[9] = { 0, 0, 0, 1, 0, 0, 0, 1, 0 };
  for (float f : pos) putF(bin, f);                          // 0..36
  for (int n : { 0, 0, 127, -127, 0, 0, 0, 64, -1 }) {      // 36..48, padded per vertex
    bin.push_back((uint8_t) (int8_t) n);
    if (bin.size() % 4 == 3) bin.push_back(0);
  }
  for (int u : { 0, 65535, 32768, 0, 65535, 65535 }) {      // 48..60
    bin.push_back((uint8_t) (u & 0xFF));
    bin.push_back((uint8_t) (u >> 8));
  }
  for (int i : { 0, 1, 2 }) { bin.push_back((uint8_t) i); bin.push_back(0); }  // 60..66
  const char* json =
      "{\"asset\":{\"version\":\"2.0\"},"
      "\"extensionsUsed\":[\"KHR_mesh_quantization\"],"
      "\"buffers\":[{\"byteLength\":68}],"
      "\"bufferViews\":["
      "{\"buffer\":0,\"byteOffset\":0,\"byteLength\":36},"
      "{\"buffer\":0,\"byteOffset\":36,\"byteLength\":12,\"byteStride\":4},"
      "{\"buffer\":0,\"byteOffset\":48,\"byteLength\":12},"
      "{\"buffer\":0,\"byteOffset\":60,\"byteLength\":6}],"
      "\"accessors\":["
      "{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
      "{\"bufferView\":1,\"componentType\":5120,\"normalized\":true,\"count\":3,\"type\":\"VEC3\"},"
      "{\"bufferView\":2,\"componentType\":5123,\"normalized\":true,\"count\":3,\"type\":\"VEC2\"},"
      "{\"bufferView\":3,\"componentType\":5123,\"count\":3,\"type\":\"SCALAR\"}],"
      "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1,\"TEXCOORD_0\":2},\"indices\":3}]}],"
      "\"nodes\":[{\"name\":\"q\",\"mesh\":0}]}";
  const std::vector<uint8_t> bytes = glb(json, bin);
  const std::vector<GlbMeshNode> nodes = read_glb_meshes(bytes.data(), bytes.size());
  expect(nodes.size() == 1 && nodes[0].prims.size() == 1, "a quantized model decodes");
  if (nodes.size() != 1 || nodes[0].prims.size() != 1) return;
  const auto& p = nodes[0].prims[0];
  expect(p.normal.size() == 9 && p.uv.size() == 6, "quantized sizes");
  if (p.normal.size() != 9 || p.uv.size() != 6) return;
  expect(p.normal[2] == 1.0f && p.normal[3] == -1.0f && p.normal[7] == 64.0f / 127.0f
          && p.normal[8] == -1.0f / 127.0f, "i8 normals read through the 4-byte stride, /127");
  expect(p.uv[0] == 0.0f && p.uv[1] == 1.0f && p.uv[2] == 32768.0f / 65535.0f,
      "u16 uvs, /65535");
}

}  // namespace

int main(int argc, char** argv) {
  checkQuantized();
  // BIN: one triangle, POSITION and NORMAL INTERLEAVED (stride 24) at offset 0,
  // then UV tight at 72, then u16 indices at 96, then u32 indices at 104.
  std::vector<uint8_t> bin;
  const float pos[9] = { 0, 0, 0, 1, 0, 0, 0, 1, 0 };
  const float nrm[9] = { 0, 0, 1, 0, 0, 1, 0, 0, 1 };
  for (int i = 0; i < 3; i++) {
    for (int k = 0; k < 3; k++) putF(bin, pos[i * 3 + k]);
    for (int k = 0; k < 3; k++) putF(bin, nrm[i * 3 + k]);
  }
  const float uv[6] = { 0, 0, 0.5f, 0, 0.25f, 1 };
  for (float f : uv) putF(bin, f);
  bin.push_back(0); bin.push_back(0);        // u16 indices 0,1,2
  bin.push_back(1); bin.push_back(0);
  bin.push_back(2); bin.push_back(0);
  bin.push_back(0); bin.push_back(0);        // pad to 4
  put32(bin, 2); put32(bin, 1); put32(bin, 0);  // u32 indices 2,1,0

  const char* json =
      "{\"asset\":{\"version\":\"2.0\"},"
      "\"buffers\":[{\"byteLength\":116}],"
      "\"bufferViews\":["
      "{\"buffer\":0,\"byteOffset\":0,\"byteLength\":72,\"byteStride\":24},"
      "{\"buffer\":0,\"byteOffset\":72,\"byteLength\":24},"
      "{\"buffer\":0,\"byteOffset\":96,\"byteLength\":6},"
      "{\"buffer\":0,\"byteOffset\":104,\"byteLength\":12}],"
      "\"accessors\":["
      "{\"bufferView\":0,\"byteOffset\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
      "{\"bufferView\":0,\"byteOffset\":12,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
      "{\"bufferView\":1,\"componentType\":5126,\"count\":3,\"type\":\"VEC2\"},"
      "{\"bufferView\":2,\"componentType\":5123,\"count\":3,\"type\":\"SCALAR\"},"
      "{\"bufferView\":3,\"componentType\":5125,\"count\":3,\"type\":\"SCALAR\"}],"
      "\"meshes\":["
      "{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1,\"TEXCOORD_0\":2},\"indices\":3}]},"
      "{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1},\"indices\":4}]}],"
      "\"nodes\":["
      "{\"name\":\"wheel-l\",\"mesh\":0},"
      "{\"name\":\"body\",\"mesh\":1},"
      "{\"name\":\"wheel-l2\",\"mesh\":0},"
      "{\"name\":\"empty\"}]}";

  const std::vector<uint8_t> bytes = glb(json, bin);
  const std::vector<GlbMeshNode> nodes = read_glb_meshes(bytes.data(), bytes.size());

  expect(nodes.size() == 3, "three mesh-carrying nodes (the empty one dropped)");
  if (nodes.size() == 3) {
    expect(nodes[0].name == "wheel-l" && nodes[1].name == "body"
            && nodes[2].name == "wheel-l2", "node names in file order");
    expect(nodes[0].mesh == nodes[2].mesh && nodes[0].mesh != nodes[1].mesh,
        "shared-mesh identity survives (the wheel-pair grouping key)");
    expect(nodes[0].prims.size() == 1 && nodes[1].prims.size() == 1,
        "one primitive each");
    const auto& p0 = nodes[0].prims[0];
    expect(p0.pos.size() == 9 && p0.normal.size() == 9 && p0.uv.size() == 6
            && p0.idx.size() == 3, "prim 0 sizes");
    bool posOk = true, nrmOk = true;
    for (int i = 0; i < 9; i++) {
      posOk = posOk && p0.pos[i] == pos[i];
      nrmOk = nrmOk && p0.normal[i] == nrm[i];
    }
    expect(posOk, "interleaved positions read through the stride");
    expect(nrmOk, "interleaved normals read through the stride");
    expect(p0.uv[2] == 0.5f && p0.uv[5] == 1.0f, "uvs");
    expect(p0.idx[0] == 0 && p0.idx[1] == 1 && p0.idx[2] == 2, "u16 indices");
    const auto& p1 = nodes[1].prims[0];
    expect(p1.uv.empty(), "a prim without TEXCOORD_0 answers no uvs");
    expect(p1.idx.size() == 3 && p1.idx[0] == 2 && p1.idx[2] == 0, "u32 indices");
  }

  // Refusals: each must empty the WHOLE answer.
  std::string sparse(json);
  const size_t at = sparse.find("\"type\":\"SCALAR\"}");
  sparse.insert(at, "\"sparse\":{},");
  const auto sparseBytes = glb(sparse, bin);
  expect(read_glb_meshes(sparseBytes.data(), sparseBytes.size()).empty(),
      "a sparse accessor refuses the whole model");

  expect(read_glb_meshes(bytes.data(), bytes.size() / 2).empty(),
      "a truncated container refuses");

  std::string lines(json);
  const size_t prim = lines.find("\"indices\":3}");
  lines.insert(prim, "\"mode\":1,");
  const auto lineBytes = glb(lines, bin);
  expect(read_glb_meshes(lineBytes.data(), lineBytes.size()).empty(),
      "a non-triangle primitive refuses the whole model");

  // Every shipped kit model, when the asset directory is given.
  int models = 0;
  if (argc > 1) {
    if (DIR* d = opendir(argv[1])) {
      while (const dirent* e = readdir(d)) {
        const std::string name = e->d_name;
        if (name.size() < 5 || name.compare(name.size() - 4, 4, ".glb") != 0) continue;
        const std::vector<uint8_t> model = readFile(std::string(argv[1]) + "/" + name);
        expect(!read_glb_meshes(model.data(), model.size()).empty(),
            (name + ": the reader refuses it, so it would draw unmerged").c_str());
        models++;
      }
      closedir(d);
    }
    expect(models > 0, "kit models found under the asset directory");
  }

  std::fprintf(stderr, "glbmesh_check: %d checks, %d failed, %d kit models\n", checked, failed,
      models);
  return failed ? 1 : 0;
}
