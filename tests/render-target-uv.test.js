// Sampling an OFFSCREEN RENDER TARGET goes through `uvToRenderTargetUV`, always.
//
// A render target's texel at uv v = 0 is the first row in memory, and that row
// is the BOTTOM of the picture on OpenGL and the TOP on Metal, Vulkan and
// WebGPU. Filament's `uvToRenderTargetUV` is the one-line correction, and it
// compiles to the identity on OpenGL — which is exactly what makes forgetting it
// so expensive here. The web is the OpenGL leg, the web is where every one of
// these materials was authored and looked at, and the renderer compiles on one
// machine configuration with no ctest anywhere near it. So a missing flip is
// invisible until a second backend exists, and then it is a rendering artefact
// with no stack trace and nothing to bisect.
//
// It cost exactly that. `vlit` and `vground` sampled the baked sun shadow map
// raw, and on tvOS every track carried a large, hard-edged, uniformly darker
// QUADRILATERAL across the ground — the shadow frustum's own footprint, cut
// along the line where the flat ground's MIRRORED depth crosses its real one. It
// looks like a texturing mistake rather than a shadow, which is what made it
// hard to place; `ttp_display_shadows(0)` making it vanish is what placed it.
//
// The rule generalises, so this checks the rule rather than the two files: every
// `texture(...)` call against a sampler that is fed a render target has to be
// wrapped. The list below is the sampler names that ARE render targets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const MATERIALS = path.join(__dirname, '..', 'native', 'renderer', 'materials');

/**
 * Every `sampler2d` the materials declare, classified.
 *
 * INVERTED ON PURPOSE. This was a one-entry allowlist of samplers that ARE
 * render targets, and a review proved what that is worth: a new material
 * sampling a NEW render-target-backed sampler passed all three tests, because
 * the sampler was named nowhere. An allowlist of things to check only ever
 * covers the incident that produced it.
 *
 * So the default is now FAIL. Every sampler has to be classified as one or the
 * other, and an unclassified one stops the suite with a message saying which
 * question to answer. That is the difference between a gate and a memento.
 */
const RENDER_TARGET_SAMPLERS = new Set([
  // The frozen sun map: baked to a depth RT, filtered through two more colour
  // RTs by vesm, then sampled per lit fragment (TtpRenderer::bakeShadowMap).
  'shadowMap',
  // vesm/vblur read the pass before them; vpresent reads the scene target.
  'src', 'scene',
  // The rubber layer: vskid stamps into it, vroad samples it per deck
  // fragment (TtpRenderer::ensureSkidLayer).
  'skidLayer'
]);

/** Samplers fed by an UPLOAD, which have no flip and must not be wrapped. */
const UPLOADED_SAMPLERS = new Set([
  // Ground canvas, car-shadow masks, baked silhouettes: `Texture::setImage`
  // or a GLB's own texture, never a render target.
  'albedo',
  // vglb's base colour: the kit's colormap atlas, decoded from the GLB's own
  // PNG by gltfio's stb provider and bound by AssetLoader. An upload — and
  // vglb goes further and turns Filament's uv flip OFF entirely (flipUV:false),
  // because glTF hands its uv0 over in image orientation already.
  'baseColorMap',
  // vpoint's flake floor: the max-height grid, Texture::setImage in
  // buildScene's ambient block.
  'floorTex'
]);

const materials = () => readdirSync(MATERIALS).filter((f) => /\.(mat|inc)$/.test(f));

/** Strip `//` comments so a sampler named in prose is not read as a call. */
const codeOf = (file) => readFileSync(path.join(MATERIALS, file), 'utf8')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

/**
 * Samplers whose uv is computed IN THE FRAGMENT, from a matrix rather than from
 * a varying — so the flip has nowhere else to live and must be at the sample.
 */
const FRAGMENT_UV_SAMPLERS = new Set(['shadowMap']);

test('every material sampling a render target flips, somewhere', () => {
  // THERE ARE TWO LEGAL PLACES and the rule is that the flip happens exactly
  // ONCE on the path from a logical uv to the sample:
  //
  //   IN THE VERTEX STAGE — `material.uv = uvToRenderTargetUV(...)` writes an
  //   already-flipped varying and the fragment samples it raw. That is what the
  //   fullscreen passes do (vesm, vblur, vpresent), and wrapping again in the
  //   fragment would flip it back.
  //
  //   AT THE SAMPLE — for a uv the fragment computes itself, which is the
  //   shadow receivers: `shadowFromWorld * worldPos` has no vertex stage to
  //   flip in.
  //
  // So this asks the weaker question of every material (is the flip present at
  // all) and the strict one only where the fragment owns the uv.
  const offenders = [];
  for (const file of materials()) {
    const src = codeOf(file);
    const samples = [...RENDER_TARGET_SAMPLERS].filter(
      (n) => new RegExp(`texture\\w*\\(\\s*(materialParams_)?${n}\\b`).test(src));
    if (!samples.length) continue;
    if (!/uvToRenderTargetUV/.test(src)) {
      offenders.push(`${file}: samples ${samples.join(', ')} and never flips`);
    }
  }
  assert.deepEqual(offenders, [],
    'a render target sampled with no flip anywhere. It is a no-op on OpenGL and '
    + 'mirrors the texture on Metal/Vulkan/WebGPU:\n  ' + offenders.join('\n  '));
});

test('a fragment-computed uv flips AT the sample', () => {
  // The stricter half, for the case that actually broke: `shadowFromWorld`
  // produces a GL-style uv inside the fragment, so a raw sample there reads the
  // map mirrored on every backend but OpenGL.
  const offenders = [];
  for (const file of materials()) {
    const src = codeOf(file);
    for (const name of FRAGMENT_UV_SAMPLERS) {
      for (const m of src.matchAll(
        new RegExp(`texture\\w*\\(\\s*(?:materialParams_)?${name}\\s*,\\s*([^,)]+)`, 'g'))) {
        if (!/uvToRenderTargetUV/.test(m[1])) {
          offenders.push(`${file}: texture(${name}, ${m[1].trim()})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these compute their own uv and sample a render target unflipped:\n  '
    + offenders.join('\n  '));
});

test('every sampler is classified, so a new one cannot slip through', () => {
  // The check the previous shape did not have. An unclassified sampler is not
  // "probably fine" — it is a question nobody has answered, and the answer
  // decides whether its material needs the flip.
  const declared = new Set();
  for (const file of materials()) {
    for (const m of codeOf(file).matchAll(/type\s*:\s*sampler2d\s*,\s*name\s*:\s*(\w+)/g)) {
      declared.add(m[1]);
    }
  }
  assert.ok(declared.size > 0, 'no samplers found — has the .mat syntax moved?');
  const unclassified = [...declared].filter(
    (n) => !RENDER_TARGET_SAMPLERS.has(n) && !UPLOADED_SAMPLERS.has(n));
  assert.deepEqual(unclassified, [],
    'these samplers are in neither set. Decide for each: is its texture an '
    + 'offscreen RenderTarget (add to RENDER_TARGET_SAMPLERS, and its samples '
    + 'must go through uvToRenderTargetUV) or an upload (add to '
    + 'UPLOADED_SAMPLERS)?');
});

test('the sun map is sampled in exactly one place', () => {
  // The check above passes vacuously if the samplers get renamed, and this is
  // the one thing a source check cannot notice on its own.
  //
  // It used to name TWO files, because vground.mat carried its own transcription
  // of the read-out and the uvToRenderTargetUV fix had to be applied to both.
  // That copy is gone: every receiver now includes ttp_shade.inc, so there is
  // ONE sample site to get right. A second name appearing here is a second copy
  // appearing — treat it as the finding, not as a list to extend.
  const users = materials().filter((f) => /materialParams_shadowMap/.test(codeOf(f)));
  assert.deepEqual(users.sort(), ['ttp_shade.inc'],
    'the sun map is sampled outside ttp_shade.inc — that is a second copy of the '
    + 'ESM read-out, which is what the shared include exists to prevent');
});

test('the bake\'s own passes wrap too, in their VERTEX stage', () => {
  // vesm reads the depth map and then its own output. It got this right from the
  // start (`uvToRenderTargetUV` in materialVertex), which is why the ESM layout
  // is consistent on both backends and only the RECEIVER was mirrored — worth
  // pinning, because the two halves have to agree and only one of them was wrong.
  assert.match(codeOf('vesm.mat'), /uvToRenderTargetUV/,
    'the blur passes must sample the source at the target texel they are writing');
});
