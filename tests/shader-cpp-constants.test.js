// A number written down in BOTH a shader and the renderer's C++ has to agree,
// and nothing else in the build can notice when it stops.
//
// The renderer is the one layer with no ctest and no corpus: it needs the
// Filament SDK, so it compiles on one machine configuration and every other leg
// skips it entirely. Its materials are compiled by matc from GLSL, which can
// include neither a C++ header nor anything generated from one — so where a
// constant genuinely has to exist on both sides, the ONLY thing holding the two
// copies together is a comment pointing each at the other. That is the shape
// this tree has been bitten by before (see the boost shades in CLAUDE.md: the
// renderer kept its own float copy of four coefficients, and the one shade with
// no pad beside it to keep it honest had quietly drifted to a colour that
// matched no biome at all).
//
// So: check the pair by reading both files. A pair here is a LAST RESORT, not a
// pattern to reach for — prefer passing the number in as a material parameter
// (kShadowEsmK does this) so there is only ever one of it. Add an entry only
// when that is impossible, and say in the entry WHY it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'native', 'renderer');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAIRS = [
  {
    what: 'the grade exposure',
    // The scene is authored in display space: the C++ encodes every baked
    // light term, vertex colour and colour parameter, and the one shader-side
    // encode left is the live-lit vertex stage's (ttp_shade.inc). Both carry
    // the exposure, and a split between them tilts what moves against what
    // does not.
    shader: { file: 'materials/ttp_shade.inc', re: /const float TTP_GRADE_EXPOSURE = ([\d.]+);/ },
    cpp: { file: 'src/TtpRendererImpl.h', re: /constexpr float kGradeExposure = ([\d.]+)f;/ }
  }
];

// The puff sprite's SHAPE is vcloud.mat's five discs, and the C++ draws each
// sprite as the support octagon of those discs grown by the shader's soft edge
// (TtpRendererTrack.cpp, puffPoly): outside that hull the alpha is exactly
// zero, so the alpha field is the rectangle's. Move a disc in one file and the
// other either clips the puff or spends fragments on nothing. A pair rather
// than a parameter because the hull is built once at scene build from numbers
// the shader keeps as compile-time literals in its fragment loop.
test('the puff sprite hull is cut from the discs vcloud.mat draws', () => {
  const shader = read('materials/vcloud.mat');
  const cpp = read('src/TtpRendererTrack.cpp');
  const discs = [...shader.matchAll(/ttpDisc\(p, vec2\(([\d.]+), ([\d.]+)\), ([\d.]+)\)/g)]
    .map((m) => m.slice(1, 4).map(Number));
  const soft = /const float SOFT = ([\d.]+);/.exec(shader);
  assert.ok(discs.length > 0 && soft, 'vcloud.mat: the disc calls or SOFT moved');
  const table = /puffPoly[\s\S]*?DISCS\[\d+\] = \{([\s\S]*?)\};/.exec(cpp);
  const cSoft = /puffPoly[\s\S]*?constexpr float SOFT = ([\d.]+)f;/.exec(cpp);
  assert.ok(table && cSoft, 'TtpRendererTrack.cpp: puffPoly\'s DISCS table or SOFT moved');
  const cDiscs = [...table[1].matchAll(/\{\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\}/g)]
    .map((m) => m.slice(1, 4).map(Number));
  assert.deepEqual(cDiscs, discs, 'the C++ disc table disagrees with vcloud.mat');
  assert.equal(Number(cSoft[1]), Number(soft[1]), 'the C++ SOFT disagrees with vcloud.mat');
  // The field the hull's corners are mapped into (uv = corner / field).
  const field = /getUV0\(\) \* vec2\(([\d.]+), ([\d.]+)\)/.exec(shader);
  const cField = /puffPoly[\s\S]*?px \/ ([\d.]+)f, v = py \/ ([\d.]+)f/.exec(cpp);
  assert.ok(field && cField, 'the field size moved in vcloud.mat or puffPoly');
  assert.deepEqual(cField.slice(1, 3).map(Number), field.slice(1, 3).map(Number),
    'the C++ field size disagrees with vcloud.mat');
});

test('a constant spelled in both a shader and the C++ agrees', () => {
  for (const p of PAIRS) {
    const s = p.shader.re.exec(read(p.shader.file));
    const c = p.cpp.re.exec(read(p.cpp.file));
    assert.ok(s, `${p.what}: not found in ${p.shader.file} — did the spelling move?`);
    assert.ok(c, `${p.what}: not found in ${p.cpp.file} — did the spelling move?`);
    assert.equal(Number(s[1]), Number(c[1]),
      `${p.what} disagrees: ${p.shader.file} says ${s[1]}, ${p.cpp.file} says ${c[1]}. `
      + 'The shader half encodes the light of everything that moves; the C++ half '
      + 'encodes everything baked, plus the skybox and fog colours Filament\'s own '
      + 'shaders consume. A split between them tilts one against the other.');
  }
});
