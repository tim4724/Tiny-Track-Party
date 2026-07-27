// Generates tests/fixtures/theme-corpus.jsonl — the oracle for the C++ biome
// tables (native/libttp-runtime/ttp/theme.{h,cc}).
//
// FROZEN, like gen-roomflow-corpus.mjs and gen-grandprix-corpus.mjs: this ran
// once against the live JS palette and then that palette was deleted. It cannot
// run again as it stands. To re-derive the oracle, restore its inputs first:
//
//   git show 758a0d5:public/shared/themes.js            > public/shared/themes.js
//   git show 758a0d5:public/display/render/trackPayload.js \
//                                    > public/display/render/trackPayload.js
//   git show 758a0d5:public/shared/trackBin.js          > public/shared/trackBin.js
//
// (and then take resolveTheme from the commit that introduced it — the refactor
// that split it out of buildTrackBin is proven byte-identical over all 132
// biome x track payloads, so either spelling records the same numbers).
//
// WHAT IT RECORDS. Everything the renderer reads out of a biome, at the point
// where every defaulting rule has been applied — themes.js's authored table,
// trackPayload.js's AMB_KINDS / DEF_CLOUDS / DEF_BIRDS / DEF_PLANE presets and
// per-track ambient patch, and trackBin.js's "field absent -> the verbatim
// pre-theming literal" fallbacks. Recorded for EVERY biome x EVERY track, so
// the per-track ambient patch (the snow cup's four different winter days) and
// the per-track shoreline seed are both pinned, not just sampled.
//
// Plus the three resolution rules the C++ has to reproduce exactly:
//   - the biome NAME list, in order (user-visible in the ?biome= dropdown)
//   - cup id -> biome, and track id -> biome, including the grass fallbacks
//   - boostShades(): all six derived shades per biome. `icon` is the HUD chip
//     stroke the DOM still draws, so a drift there is a visible regression on a
//     surface no pixel test covers.
//
// FLOATS ARE RECORDED AS f32. track.bin has always carried these as f32, so the
// renderer has only ever seen the single-rounded value; Math.fround here records
// exactly that, and the C++ side holds them in `float` for the same reason. A
// double would pin a precision the shipped renderer never had.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-theme-corpus.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from './oracle-lib.mjs';
import { THEMES, BIOME_NAMES, themeByName, themeForCup, biomeNameForCup, boostShades }
  from '../public/shared/themes.js';
import { CUPS, TRACK_LIST } from '../public/shared/tracks.js';
import { DEV_TRACKS } from '../public/shared/devTracks.js';
import { resolveTheme, resolveModelTint } from '../public/shared/trackBin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/theme-corpus.jsonl');

// trackPayload.js reads window.CAR_MODELS for the roster's model names. The
// roster is not part of the theme, so an empty one keeps this a pure palette
// recording — but the module still has to load.
globalThis.window = globalThis.window || {};
globalThis.window.CAR_MODELS = globalThis.window.CAR_MODELS || [];
const { trackPayload } = await import('../public/display/render/trackPayload.js');

// The single-rounded value the renderer actually sees (track.bin is f32).
const F = Math.fround;

const glbBytes = (model) => {
  const f = path.join(ROOT, 'public/assets/toycar', `${model}.glb`);
  return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
};

// Explicit per-field projection rather than a blanket fround: which fields are
// u32 and which are f32 IS the contract, and a blanket rule would quietly
// launder an integer field into a float one.
function project(R) {
  const clutter = R.scenery.clutter.map((k) => ({ kind: k.kind, w: F(k.w), tints: k.tints }));
  return {
    road: {
      asphalt: R.road.asphalt, line: R.road.line, dash: R.road.dash,
      kerbA: R.road.kerbA, kerbB: R.road.kerbB, skirt: R.road.skirt,
      shoulder: R.road.shoulder,
      kerbW: F(R.road.kerbW), kerbH: F(R.road.kerbH), edgeLines: R.road.edgeLines,
    },
    sky: R.sky,
    fog: R.fog,
    hillShape: R.hillShape,
    hills: R.hills,
    scenery: {
      density: F(R.scenery.density),
      mixTree: F(R.scenery.mixTree),
      mixBush: F(R.scenery.mixBush),
      models: R.scenery.models,
      trees: R.scenery.trees.map((t) => ({ model: t.model, w: F(t.w), s0: F(t.s0), s1: F(t.s1) })),
      bush: R.scenery.bush ? { model: R.scenery.bush.model, s0: F(R.scenery.bush.s0),
                               s1: F(R.scenery.bush.s1), sink: F(R.scenery.bush.sink) } : null,
      rocks: R.scenery.rocks,
      rockS: [F(R.scenery.rockS[0]), F(R.scenery.rockS[1])],
      clutterDensity: F(R.scenery.clutterDensity),
      clutter,
    },
    landmarks: R.landmarks,
    structure: R.structure,
    groundKind: R.groundKind,
    fogTune: F(R.fogTune),
    key: { color: R.key.color, intensity: F(R.key.intensity) },
    hemi: { sky: R.hemi.sky, ground: R.hemi.ground, intensity: F(R.hemi.intensity) },
    clouds: { count: R.clouds.count, opacity: F(R.clouds.opacity), scale: F(R.clouds.scale),
              aspect: F(R.clouds.aspect), tint: R.clouds.tint },
    gate: R.gate,
    gantry: R.gantry,
    boost: R.boost,
    water: R.water,
    haze: { count: R.haze.count, opacity: F(R.haze.opacity), tint: R.haze.tint,
            scale: F(R.haze.scale) },
    ambient: { kind: R.ambient.kind, count: R.ambient.count, size: F(R.ambient.size),
               opacity: F(R.ambient.opacity), tint: R.ambient.tint, fall: F(R.ambient.fall),
               wind: F(R.ambient.wind), bob: F(R.ambient.bob), band: F(R.ambient.band) },
    birds: { count: R.birds.count, tint: R.birds.tint, size: F(R.birds.size), y: F(R.birds.y),
             rc: F(R.birds.rc), rb: F(R.birds.rb), speed: F(R.birds.speed), flap: F(R.birds.flap),
             flapHz: F(R.birds.flapHz), dys: F(R.birds.dys) },
    kites: { count: R.kites.count, size: F(R.kites.size), y: F(R.kites.y), tints: R.kites.tints },
    plane: R.plane ? { tint: R.plane.tint, size: F(R.plane.size), y: F(R.plane.y),
                       a0: F(R.plane.a0), rc: F(R.plane.rc), rb: F(R.plane.rb),
                       speed: F(R.plane.speed), bank: F(R.plane.bank) } : null,
    balloon: { panels: R.balloon.panels, y: F(R.balloon.y), size: F(R.balloon.size) },
    ice: R.ice,
  };
}

const lines = [];
const tracks = [...TRACK_LIST.map((t) => t.id), ...Object.keys(DEV_TRACKS)];
lines.push(canonicalStringify({
  kind: 'theme', biomes: BIOME_NAMES.length, tracks: tracks.length,
}));

// ---- resolution rules -------------------------------------------------------
lines.push(canonicalStringify({ case: 'biomes', names: BIOME_NAMES }));

// Every cup id, plus the two shapes that must fall back to grass: a cup with no
// biome mapping and no cup at all (a dev track carries none).
for (const cup of [...CUPS.map((c) => c.id), 'no-such-cup', null]) {
  lines.push(canonicalStringify({ case: 'cup', cup, biome: biomeNameForCup(cup) }));
  // themeForCup and biomeNameForCup must agree on the same fallback.
  const byName = themeByName(biomeNameForCup(cup));
  if (byName !== themeForCup(cup)) throw new Error(`themeForCup/biomeNameForCup disagree on ${cup}`);
}
for (const id of tracks) {
  const entry = TRACK_LIST.find((t) => t.id === id);
  lines.push(canonicalStringify({ case: 'track', track: id, biome: biomeNameForCup(entry && entry.cup) }));
}

// ---- boost accent -----------------------------------------------------------
// All six shades, not just the one the HUD draws: they are one recipe, and a
// drift in any of them moves the pad, the strip, the aura or the streaks.
for (const name of BIOME_NAMES) {
  lines.push(canonicalStringify({ case: 'boost', biome: name, shades: boostShades(THEMES[name].boost) }));
}

// ---- the resolved palette, per biome x track --------------------------------
let cases = 0;
for (const name of BIOME_NAMES) {
  const theme = themeByName(name);
  for (const id of tracks) {
    const entry = TRACK_LIST.find((t) => t.id === id) || { id };
    const payload = trackPayload(theme, entry, []);
    lines.push(canonicalStringify({ case: 'theme', biome: name, track: id, resolved: project(resolveTheme(payload)) }));
    cases++;
  }
}

// ---- scenery model recolours ------------------------------------------------
// resolveModelTint reads the SHIPPED GLB's authored material colours and maps
// them through the biome's tint table, so this pins both halves: the table, and
// the linear-baseColorFactor -> sRGB-hex key derivation that looks it up.
for (const name of BIOME_NAMES) {
  const theme = themeByName(name);
  const sc = theme.scenery || {};
  const models = [...new Set([...(sc.trees || []).map((e) => e.model),
                              ...(sc.bush ? [sc.bush.model] : [])])];
  for (const model of models) {
    const pairs = resolveModelTint(theme, model, glbBytes(model));
    lines.push(canonicalStringify({ case: 'tints', biome: name, model, pairs }));
  }
}

const text = lines.join('\n') + '\n';
if (process.argv.includes('--stdout')) { process.stdout.write(text); process.exit(0); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`${OUT}: ${BIOME_NAMES.length} biomes x ${tracks.length} tracks = ${cases} resolved palettes`);
