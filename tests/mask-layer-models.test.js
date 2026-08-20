// The car silhouette store holds one layer per car MODEL, and the renderer has
// to declare that count as a C++ constant (it sizes a texture array built
// before any roster exists). protocol.js's CAR_MODELS is the source for it.
//
// WHY IT IS WORTH A GATE. The failure is silent in the direction that matters.
// Add a fifth model without raising kMaskLayerModels and claimMaskLayer runs
// out of layers for it, so that car quietly falls back to the GENERIC OVAL —
// a plausible-looking shadow that no screenshot gate can tell from a real
// silhouette, and one only a player two units from their own car would ever
// notice. Nothing else in the tree would catch the drift: the renderer
// compiles on one machine configuration and no ctest goes near the roster.
//
// Lower it and the layers exist but the models do not, which costs 512 KB a
// layer for nothing — worth catching too, so this checks equality.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('kMaskLayerModels matches CAR_MODELS', async () => {
  const hdr = readFileSync(
    path.join(ROOT, 'native/renderer/src/TtpRenderer.h'), 'utf8');
  const m = hdr.match(/static constexpr int kMaskLayerModels\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'TtpRenderer.h declares no kMaskLayerModels');

  const { CAR_MODELS } = await import(
    path.join(ROOT, 'public/shared/protocol.js'));
  assert.ok(Array.isArray(CAR_MODELS) && CAR_MODELS.length > 0,
    'protocol.js exports no CAR_MODELS');

  assert.equal(Number(m[1]), CAR_MODELS.length,
    `kMaskLayerModels is ${m[1]} but CAR_MODELS holds ${CAR_MODELS.length}` +
    ' — a model without a layer falls back to the generic oval');
});
