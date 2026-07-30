// The GLB container reads (native/runtime/ttp_glb.h), against the SHIPPED wasm
// and every model the game actually draws.
//
// WHY THIS EXISTS AT ALL. `ghostGlb` and the texture-URI scan were browser JS in
// `render/Display.js` until the tvOS shell landed; they name no platform API, so
// by the placement rule they belonged in C++ where three shells reach one copy.
// What that move costs is the thing this file buys back: the JS was covered by
// nothing but the fact that the game visibly worked, and a C++ rewrite of an
// uncovered function is a rewrite you cannot check.
//
// So the assertions here are about the PROPERTIES the renderer depends on, not
// about matching the retired JS byte for byte. The output is a different
// serializer's JSON — key order and spacing differ, legitimately — and pinning
// bytes would freeze an accident. What must hold is that cgltf still accepts the
// container, that every material became translucent, and that the chunk is
// aligned; those are what break the picture when they are wrong.
//
// The 4-BYTE ALIGNMENT is the one worth stating plainly: a JSON chunk landing
// off a 4-byte boundary makes cgltf reject the WHOLE file, not the one material,
// so the symptom is a car that silently does not render. The kit ships ASCII
// material names, which means a length-measured-in-characters bug would pass
// every model in this tree and fail on the first localized asset — which is
// exactly why the length is asserted here rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOYCAR = join(ROOT, 'public/assets/toycar');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

async function loadRuntime() {
  const mod = await import(
    join(ROOT, 'public/display/engine/native/ttp_runtime.mjs')
  );
  return mod.default();
}

// The two exports under test, wrapped the way a shell wraps them.
function bind(m) {
  const ghost = m.cwrap('ttp_glb_ghost', 'number', ['number', 'number', 'number']);
  const uris = m.cwrap('ttp_glb_image_uris', 'string', ['number', 'number']);
  const withBytes = (bytes, fn) => {
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    try {
      return fn(ptr, bytes.length);
    } finally {
      m._free(ptr);
    }
  };
  return {
    ghost: (bytes) =>
      withBytes(bytes, (ptr, len) => {
        const lenPtr = m._malloc(4);
        try {
          const out = ghost(ptr, len, lenPtr);
          const n = m.HEAPU32[lenPtr >> 2];
          // slice, not subarray: the scratch is C-owned and the next call
          // overwrites it.
          return out ? m.HEAPU8.slice(out, out + n) : null;
        } finally {
          m._free(lenPtr);
        }
      }),
    uris: (bytes) => JSON.parse(withBytes(bytes, (ptr, len) => uris(ptr, len)) || '[]')
  };
}

// The JSON chunk of a GLB, parsed. The reader the test uses on the OUTPUT has to
// be independent of the one the implementation used on the input, or a shared
// misreading of the container would cancel out.
function jsonChunk(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint32(0, true), GLB_MAGIC, 'not a GLB');
  assert.equal(dv.getUint32(16, true), CHUNK_JSON, 'first chunk is not JSON');
  const len = dv.getUint32(12, true);
  return {
    len,
    doc: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))),
    declaredTotal: dv.getUint32(8, true)
  };
}

const MODELS = readdirSync(TOYCAR).filter((f) => f.endsWith('.glb'));

test('ttp_glb_ghost: every kit model survives the transform', async () => {
  const m = await loadRuntime();
  const { ghost } = bind(m);
  assert.ok(MODELS.length >= 17, `expected the whole kit, saw ${MODELS.length}`);

  for (const name of MODELS) {
    const src = new Uint8Array(readFileSync(join(TOYCAR, name)));
    const out = ghost(src);
    assert.ok(out, `${name}: no ghost produced`);

    const { len, doc, declaredTotal } = jsonChunk(out);

    // The header must describe the buffer that was actually returned, or a
    // loader reads past the end of one chunk and into the next.
    assert.equal(declaredTotal, out.length, `${name}: header length disagrees with the buffer`);
    // The alignment rule. Both the chunk and the whole container.
    assert.equal(len % 4, 0, `${name}: JSON chunk is not 4-byte aligned`);
    assert.equal(out.length % 4, 0, `${name}: container is not 4-byte aligned`);

    // The transform itself, on every material.
    const mats = doc.materials || [];
    assert.ok(mats.length > 0, `${name}: expected materials to make translucent`);
    for (const mat of mats) {
      assert.equal(mat.alphaMode, 'BLEND', `${name}: alphaMode`);
      assert.equal(mat.doubleSided, false, `${name}: doubleSided`);
      const f = mat.pbrMetallicRoughness?.baseColorFactor;
      assert.ok(Array.isArray(f) && f.length === 4, `${name}: baseColorFactor`);
      assert.equal(f[3], 0.5, `${name}: alpha`);
    }

    // The BIN chunk is untouched — the ghost is a material edit, and re-encoding
    // geometry would be a silent way to lose it.
    const srcJsonLen = new DataView(src.buffer, src.byteOffset).getUint32(12, true);
    assert.deepEqual(
      out.subarray(20 + len),
      src.subarray(20 + srcJsonLen),
      `${name}: the binary chunk was rewritten`
    );
  }
});

test('ttp_glb_ghost: RGB survives, only alpha moves', async () => {
  const m = await loadRuntime();
  const { ghost } = bind(m);
  for (const name of MODELS) {
    const src = new Uint8Array(readFileSync(join(TOYCAR, name)));
    const before = jsonChunk(src).doc.materials || [];
    const after = jsonChunk(ghost(src)).doc.materials || [];
    assert.equal(after.length, before.length, `${name}: material count changed`);
    before.forEach((mat, i) => {
      const src3 = (mat.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1]).slice(0, 3);
      const out3 = after[i].pbrMetallicRoughness.baseColorFactor.slice(0, 3);
      assert.deepEqual(out3, src3, `${name}: material ${i} changed colour`);
    });
  }
});

test('ttp_glb_ghost: a non-GLB answers empty rather than producing garbage', async () => {
  const m = await loadRuntime();
  const { ghost } = bind(m);
  // A shell provides nothing when this happens, and the renderer falls back the
  // same way it does for a missing asset. Producing a malformed container
  // instead would be strictly worse: cgltf would take it and fail later.
  assert.equal(ghost(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(ghost(new Uint8Array(0)), null);
  assert.equal(ghost(new TextEncoder().encode('{"materials":[]}')), null);
});

test('ttp_glb_image_uris: the scenery models name the textures the shell must provide', async () => {
  const m = await loadRuntime();
  const { uris } = bind(m);

  // The two the kit actually references. `display-abi.test.js` pins the
  // directory's contents; this pins what the containers ASK for, which is the
  // half a shell has to satisfy before gltfio runs.
  const seen = new Set();
  for (const name of MODELS) {
    const list = uris(new Uint8Array(readFileSync(join(TOYCAR, name))));
    assert.ok(Array.isArray(list), `${name}: not an array`);
    for (const u of list) {
      assert.equal(typeof u, 'string');
      assert.ok(!u.startsWith('data:'), `${name}: a data URI needs no provisioning`);
      seen.add(u);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ['Textures/colormap.png', 'Textures/holiday-colormap.png'],
    'the kit references a texture nothing stages'
  );

  // The names are RELATIVE and authored, because that exact string is the key
  // the renderer looks bytes up by (registerAssetUris). A reader that resolved
  // them would break every shell's provisioning.
  for (const u of seen) assert.ok(!u.startsWith('/') && !u.includes('://'), u);
});

test('ttp_glb_image_uris: unparseable input is an empty list, not a throw', async () => {
  const m = await loadRuntime();
  const { uris } = bind(m);
  assert.deepEqual(uris(new Uint8Array([0, 0, 0, 0])), []);
  assert.deepEqual(uris(new Uint8Array(0)), []);
});
