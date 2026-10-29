// Three rules every material is held to, each priced on an Android box
// (native/renderer/CLAUDE.md, "Shading, lighting, colour", the deck's taps and
// the fog paragraph; docs/perf/androidtv-frame-map.md has the readings) and
// each invisible to every other check: the renderer has no ctest, and a
// material that breaks one compiles, links and draws the same picture,
// milliseconds slower.
//
//   1. An unlit material writes `baseColor`, never `emissive`. An `emissive`
//      write makes matc compile Filament's addEmissive (an exposure mix and a
//      multiply-add, highp) into every fragment of that material. The
//      exceptions are listed below, each with its reason, and the list is held
//      both ways so a material that stops writing emissive leaves it.
//   2. A texture coordinate handed whole out of a varying is its `.xy`. Any
//      other swizzle (`.xz`, `.zw`) is a DEPENDENT read on PowerVR, which the
//      GPU cannot issue before the shader runs — which is why vroad.mat gives
//      the visibility map a varying of its own rather than packing it as `.zw`
//      of the rubber layer's.
//   3. Every material filters Filament's fog variant out. The fog is ours, per
//      vertex (ttp_fog.inc), and with the variant gone the fork's filamat can
//      prove an unlit material never reads the built-in surface interpolants
//      and leave them out of its vertex outputs; without the filter it keeps
//      emitting them, which on a tile-based GPU is the vertex stage's cost.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'native', 'renderer', 'materials');
const sources = () => fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.mat') || f.endsWith('.inc')).sort();
// The shader code without its comments, so prose about a rule cannot trip it.
const codeOf = (file) => fs.readFileSync(path.join(DIR, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

// The materials that still write `emissive`, and why each may.
const EMISSIVE_WRITERS = new Map([
  ['vglbfade.mat', 'its alpha rides baseColor and its colour must be premultiplied by it'],
  ['vesm.mat', 'a once-per-track bake, never priced against baseColor'],
  ['vvis.mat', 'a once-per-track bake, never priced against baseColor'],
  ['vroadvis.mat', 'a once-per-track bake, never priced against baseColor'],
  ['vpresent.mat', 'off on the box, where the move to baseColor was priced; never re-measured']
]);

test('an unlit material writes baseColor, never emissive', () => {
  const files = sources();
  assert.ok(files.length > 0, 'no materials found — has the directory moved?');
  const offenders = [];
  const stale = [];
  for (const file of files) {
    const writes = /\bmaterial\.emissive\b[^;=]*=/.test(codeOf(file));
    if (writes && !EMISSIVE_WRITERS.has(file)) offenders.push(file);
    if (!writes && EMISSIVE_WRITERS.has(file)) stale.push(file);
  }
  assert.deepEqual(offenders, [],
    'these write `material.emissive`, which compiles addEmissive into every one of '
    + 'their fragments. Write baseColor, or add the material to EMISSIVE_WRITERS '
    + 'with its reason:\n  ' + offenders.join('\n  '));
  assert.deepEqual(stale, [],
    'these no longer write emissive — drop them from EMISSIVE_WRITERS:\n  '
    + stale.join('\n  '));
});

// Rule 3. A material whose fragment reads a position or normal getter (the
// visibility bake's getUserWorldPosition(), say) keeps the interpolants
// whatever the filter says; the pin's filamat commit defines which reads count.
test('every material filters the fog variant out', () => {
  const missing = sources().filter((f) => f.endsWith('.mat'))
    .filter((f) => !/variantFilter\s*:\s*\[[^\]]*\bfog\b[^\]]*\]/.test(codeOf(f)));
  assert.deepEqual(missing, [],
    'these do not filter the fog variant, so the fork\'s filamat keeps emitting '
    + 'the built-in interpolants nothing here reads — add `variantFilter : [ fog ]` '
    + 'to the material block:\n  ' + missing.join('\n  '));
});

test('a texture coordinate handed whole out of a varying is its .xy', () => {
  const offenders = [];
  let seen = 0;
  for (const file of sources()) {
    // A varying swizzle that is a COMPLETE call argument — `f(variable_x.zw)`,
    // `texture(s, variable_x.zw, 0.0)`. An expression over a varying is a
    // computed coordinate, dependent by nature, so it is not this rule's.
    for (const m of codeOf(file).matchAll(/[(,]\s*variable_(\w+)\.([xyzw]{2})\s*[,)]/g)) {
      seen++;
      if (m[2] !== 'xy') offenders.push(`${file}: variable_${m[1]}.${m[2]}`);
    }
  }
  assert.ok(seen > 0, 'no varying is handed whole to a call anywhere — has the syntax moved?');
  assert.deepEqual(offenders, [],
    'a two-component read of a varying handed to a call that is not .xy: a texture '
    + 'tap on it is a dependent read on PowerVR (native/renderer/CLAUDE.md, "Every '
    + 'deck tap reads a BARE .xy varying"). Give the coordinate a varying of its '
    + 'own, with the spare components for the scalars:\n  ' + offenders.join('\n  '));
});
