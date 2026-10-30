// flatweld_check — the flat-body weld (ttp/flat_weld.h) behind the car bodies'
// merged draw, executed on every leg. The weld's whole claim is "same picture,
// fewer vertices", and the picture half is three properties, each checked for
// BOTH provoking conventions on a synthetic mesh and on the shipped roster:
//
//   * every triangle survives with its corners in cyclic order (so its
//     winding) and its PROVOKING corner carries its own face normal — a wrong
//     slot lights a face with a neighbour's normal;
//   * no two triangles of the reorderable front range share plane and area,
//     so any vertex-reuse reorder of it changes no depth tie;
//   * every coplanar overlapping pair keeps its source order, with the front
//     range reversed for good measure (the overlays stay behind it, in order).
//
// The first property also runs a CONTROL arm that must fail (the provoking normal
// read from the wrong slot), and the synthetic box states its own overlay
// count rather than deriving it from the predicate under test. The FEWER
// half is held per roster body by a stated ceiling: the face-corner
// assignment is a search, and a corner picked in visiting order lands above
// it.
//
// And the GLB rewrite that routes a flat mesh to the flat material: only
// all-flat meshes move, onto a `#flat` clone, and the geometry reads back
// unchanged.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "ttp/flat_weld.h"
#include "ttp/glb_mesh.h"
#include "ttp/json_parse.h"

using ttp::rt::FlatWeld;
using ttp::rt::GlbMeshNode;
using ttp::rt::GlbMeshPrim;

namespace {

int checked = 0, failed = 0;

void expect(bool ok, const std::string& what) {
  checked++;
  if (ok) return;
  failed++;
  std::fprintf(stderr, "FAIL %s\n", what.c_str());
}

std::string corner(const GlbMeshPrim& p, uint32_t v) {
  std::string k((const char*) &p.pos[v * 3], 12);
  if (!p.uv.empty()) k.append((const char*) &p.uv[v * 2], 8);
  return k;
}

// A triangle as the smallest of its three corner rotations (a rotation keeps
// the winding; the kit has zero-area triangles with a corner twice, so the
// smallest corner alone is not rotation-invariant) plus the normal the given
// slot carries — none for a zero-area triangle, which draws nothing and whose
// corners the weld does not light.
std::string triKey(const GlbMeshPrim& p, size_t t, int normalSlot) {
  std::string c[3];
  for (int k = 0; k < 3; k++) c[k] = corner(p, p.idx[t * 3 + k]);
  std::string key;
  for (int r = 0; r < 3; r++) {
    const std::string rot = c[r] + c[(r + 1) % 3] + c[(r + 2) % 3];
    if (r == 0 || rot < key) key = rot;
  }
  if (ttp::rt::flatweld_detail::tri(p, t).ok) {
    key.append((const char*) &p.normal[p.idx[t * 3 + normalSlot] * 3], 12);
  }
  return key;
}

bool overlaps(const GlbMeshPrim& p, size_t i, size_t j) {
  using ttp::rt::flatweld_detail::tri;
  return ttp::rt::flatweld_detail::coplanar_overlap(tri(p, i), tri(p, j));
}

std::vector<std::string> sortedKeys(const GlbMeshPrim& p, int slot) {
  std::vector<std::string> k;
  for (size_t t = 0; t < p.idx.size() / 3; t++) k.push_back(triKey(p, t, slot));
  std::sort(k.begin(), k.end());
  return k;
}

void checkWeld(const GlbMeshPrim& src, bool last, const std::string& label) {
  const FlatWeld w = ttp::rt::weld_flat_prim(src, last);
  const std::string tag = label + (last ? " (last)" : " (first)");
  const size_t nt = src.idx.size() / 3;
  expect(w.prim.idx.size() == src.idx.size(), tag + ": every triangle kept");
  if (w.prim.idx.size() != src.idx.size()) return;
  expect(w.prim.pos.size() < src.pos.size(), tag + ": fewer vertices");

  // Same triangles, same winding, the provoking corner lit by its own face.
  std::vector<std::string> a;
  for (size_t t = 0; t < nt; t++) a.push_back(triKey(src, t, 0));
  const std::vector<std::string> sa = sortedKeys(src, 0), sb = sortedKeys(w.prim, last ? 2 : 0);
  expect(sa == sb, tag + ": triangles, winding and provoking normals match the source");
  if (sa != sb) return;   // the order check below maps triangles by these keys
  // CONTROL: the slot the other backend would read must NOT match, or the
  // check above could not tell a wrong rotation from a right one.
  expect(sortedKeys(w.prim, last ? 0 : 2) != sa, tag + ": control: the wrong slot is caught");

  // The front range is free to reorder: nothing in it shares plane and area.
  bool freeFront = true;
  for (size_t i = 0; i < w.baseTris && freeFront; i++) {
    for (size_t j = i + 1; j < w.baseTris && freeFront; j++) {
      freeFront = !overlaps(w.prim, i, j);
    }
  }
  expect(freeFront, tag + ": no coplanar overlap inside the reorderable range");

  // A reorder of that range (reversed here) keeps every overlapping pair in order.
  GlbMeshPrim worst = w.prim;
  for (size_t i = 0, j = w.baseTris; i + 1 < j; i++, j--) {
    std::swap_ranges(worst.idx.begin() + i * 3, worst.idx.begin() + i * 3 + 3,
        worst.idx.begin() + (j - 1) * 3);
  }
  std::map<std::string, std::vector<size_t>> at;
  for (size_t t = 0; t < nt; t++) at[triKey(worst, t, last ? 2 : 0)].push_back(t);
  std::map<std::string, size_t> taken;
  std::vector<size_t> posOf(nt);
  for (size_t t = 0; t < nt; t++) posOf[t] = at[a[t]][taken[a[t]]++];
  bool ordered = true;
  for (size_t j = 0; j < nt; j++) {
    for (size_t i = 0; i < j; i++) {
      if (a[i] != a[j] && overlaps(src, i, j) && posOf[i] > posOf[j]) ordered = false;
    }
  }
  expect(ordered, tag + ": coplanar overlapping pairs keep their source order");
}

// A flat-shaded box: 6 faces of 4 corners each (per-face normals), every uv
// the same, then a smaller quad lying ON the top face with its own uv — the
// overlay shape the kit's bodies carry.
GlbMeshPrim boxWithDecal() {
  GlbMeshPrim p;
  const float n[6][3] = { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 } };
  for (int f = 0; f < 6; f++) {
    // Two tangent axes per face, ordered so the quad winds outward.
    float u[3] = { n[f][1], n[f][2], n[f][0] }, v[3];
    v[0] = n[f][1] * u[2] - n[f][2] * u[1];
    v[1] = n[f][2] * u[0] - n[f][0] * u[2];
    v[2] = n[f][0] * u[1] - n[f][1] * u[0];
    const uint32_t b = (uint32_t) p.pos.size() / 3;
    const int su[4] = { -1, 1, 1, -1 }, sv[4] = { -1, -1, 1, 1 };
    for (int c = 0; c < 4; c++) {
      for (int k = 0; k < 3; k++) p.pos.push_back(n[f][k] + su[c] * u[k] + sv[c] * v[k]);
      p.normal.insert(p.normal.end(), n[f], n[f] + 3);
      p.uv.push_back(0); p.uv.push_back(0);
    }
    for (uint32_t i : { 0u, 1u, 2u, 0u, 2u, 3u }) p.idx.push_back(b + i);
  }
  const uint32_t b = (uint32_t) p.pos.size() / 3;
  const float decal[4][3] = { { -0.5f, 1, -0.5f }, { -0.5f, 1, 0.5f }, { 0.5f, 1, 0.5f }, { 0.5f, 1, -0.5f } };
  for (const auto& c : decal) {
    p.pos.insert(p.pos.end(), c, c + 3);
    p.normal.push_back(0); p.normal.push_back(1); p.normal.push_back(0);
    p.uv.push_back(0.5f); p.uv.push_back(0.5f);
  }
  for (uint32_t i : { 0u, 1u, 2u, 0u, 2u, 3u }) p.idx.push_back(b + i);
  return p;
}

std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {});
}

// The material name each primitive of each mesh points at, in file order.
std::vector<std::vector<std::string>> primMaterials(const std::vector<uint8_t>& glb) {
  std::vector<std::vector<std::string>> out;
  std::string text;
  ttp::Value doc;
  if (!ttp::rt::glb_json_chunk(glb.data(), glb.size(), text)
      || !ttp::json::Parser(text).parse(doc)) return out;
  const ttp::Value* meshes = doc.find("meshes");
  const ttp::Value* mats = doc.find("materials");
  if (!meshes || !mats) return out;
  for (const ttp::Value& m : meshes->arr) {
    out.emplace_back();
    const ttp::Value* prims = m.find("primitives");
    for (const ttp::Value& p : prims ? prims->arr : std::vector<ttp::Value>{}) {
      const ttp::Value* mi = p.find("material");
      const ttp::Value* name = mi ? mats->arr[(size_t) mi->num].find("name") : nullptr;
      out.back().push_back(name ? name->str : std::string());
    }
  }
  return out;
}

bool sameMeshes(const std::vector<GlbMeshNode>& a, const std::vector<GlbMeshNode>& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); i++) {
    if (a[i].name != b[i].name || a[i].mesh != b[i].mesh || a[i].prims.size() != b[i].prims.size()) {
      return false;
    }
    for (size_t p = 0; p < a[i].prims.size(); p++) {
      const GlbMeshPrim &x = a[i].prims[p], &y = b[i].prims[p];
      if (x.pos != y.pos || x.normal != y.normal || x.uv != y.uv || x.idx != y.idx) return false;
    }
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  // The synthetic box: 12 face triangles + a 2-triangle decal on the top face,
  // axis-aligned and then turned off every axis (so the decal's plane carries
  // float rounding). Its overlay count is stated, not derived.
  GlbMeshPrim turned = boxWithDecal();
  const float c1 = std::cos(0.7f), s1 = std::sin(0.7f), c2 = std::cos(0.3f), s2 = std::sin(0.3f);
  for (std::vector<float>* v : { &turned.pos, &turned.normal }) {
    for (size_t i = 0; i < v->size(); i += 3) {
      float x = (*v)[i], y = (*v)[i + 1], z = (*v)[i + 2];
      const float x1 = c1 * x - s1 * z, z1 = s1 * x + c1 * z;   // about y
      const float y2 = c2 * y - s2 * z1, z2 = s2 * y + c2 * z1;  // about x
      (*v)[i] = x1; (*v)[i + 1] = y2; (*v)[i + 2] = z2;
    }
  }
  for (const auto& [box, name] : { std::pair{ boxWithDecal(), "box" }, std::pair{ turned, "turned box" } }) {
    expect(ttp::rt::prim_all_flat(box), std::string(name) + " is all-flat");
    for (bool last : { false, true }) {
      checkWeld(box, last, name);
      const FlatWeld w = ttp::rt::weld_flat_prim(box, last);
      expect(w.baseTris == 12, std::string(name) + ": the decal's two triangles are the overlays"
          + (last ? " (last)" : " (first)"));
    }
  }
  const GlbMeshPrim box = boxWithDecal();
  GlbMeshPrim smooth = box;
  smooth.normal[0] = 0.5f;
  expect(!ttp::rt::prim_all_flat(smooth), "one bent corner normal makes it not flat");
  expect(ttp::rt::weld_flat_prim(smooth, true).prim.idx.empty(), "a not-flat prim is not welded");

  // The shipped roster, when the asset directory is given. Each flat body's
  // welded vertex count, at most — re-stated on purpose when the assignment
  // or the model changes.
  if (argc > 1) {
    const std::map<std::string, size_t> weldedAtMost = {
        { "vehicle-gt", 480 }, { "vehicle-jeep", 305 }, { "vehicle-lemans", 468 },
        { "vehicle-stock", 662 } };
    int flatBodies = 0;
    for (const auto& [name, atMost] : weldedAtMost) {
      const char* car = name.c_str();
      const std::vector<uint8_t> bytes = readFile(std::string(argv[1]) + "/" + car + ".glb");
      const std::vector<GlbMeshNode> nodes = ttp::rt::read_glb_meshes(bytes.data(), bytes.size());
      expect(!nodes.empty(), std::string(car) + ": decodes");
      const std::vector<char> flatMesh = ttp::rt::flat_meshes(nodes);
      for (const GlbMeshNode& n : nodes) {
        for (const GlbMeshPrim& p : n.prims) {
          if (n.mesh < 0 || (size_t) n.mesh >= flatMesh.size() || !flatMesh[n.mesh]) continue;
          for (bool last : { false, true }) checkWeld(p, last, std::string(car) + "/" + n.name);
          const FlatWeld w = ttp::rt::weld_flat_prim(p, false);
          std::printf("%s/%s: %zu -> %zu vertices, %zu of %zu triangles overlays\n", car,
              n.name.c_str(), p.pos.size() / 3, w.prim.pos.size() / 3,
              p.idx.size() / 3 - w.baseTris, p.idx.size() / 3);
          expect(w.prim.pos.size() / 3 <= atMost, std::string(car) + ": welded to at most "
              + std::to_string(atMost) + " vertices");
          flatBodies++;
        }
      }
      // The rewrite moves exactly the all-flat meshes onto a #flat clone.
      const std::vector<uint8_t> flat = ttp::rt::flat_material_glb(bytes.data(), bytes.size(), nodes);
      const bool anyFlat = std::find(flatMesh.begin(), flatMesh.end(), 1) != flatMesh.end();
      expect(flat.empty() == !anyFlat, std::string(car) + ": rewritten iff a mesh is all-flat");
      if (flat.empty()) continue;
      expect(sameMeshes(nodes, ttp::rt::read_glb_meshes(flat.data(), flat.size())),
          std::string(car) + ": the rewrite leaves the geometry as it was");
      const auto before = primMaterials(bytes), after = primMaterials(flat);
      bool routed = before.size() == after.size();
      for (size_t m = 0; routed && m < after.size(); m++) {
        for (size_t p = 0; routed && p < after[m].size(); p++) {
          const bool isFlat = m < flatMesh.size() && flatMesh[m];
          routed = after[m][p] == before[m][p] + (isFlat ? ttp::rt::kFlatMaterialSuffix : "");
        }
      }
      expect(routed, std::string(car) + ": flat meshes on the #flat clone, the rest unchanged");
    }
    expect(flatBodies > 0, "at least one roster body is all-flat (else the weld is dead code)");
  }

  std::printf("flatweld: %d checks, %d failed\n", checked, failed);
  return failed ? 1 : 0;
}
