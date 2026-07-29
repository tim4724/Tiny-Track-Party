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
// All three are RESTORES now, not overwrites: trackBin.js was the last of them
// still shipping, and it went when the roster stopped crossing as bytes
// (native/libttp-runtime/ttp/roster.h). Nothing in public/ is disturbed by the
// recipe any more.
//
// Those three restore, and they are the whole recipe: `node scripts/gen-theme-
// corpus.mjs --check` then reproduces the committed corpus byte for byte. The
// fourth input, resolveTheme, is INLINED BELOW because no commit can restore it
// — see the comment on it.
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
// Usage: node scripts/gen-theme-corpus.mjs [--check | --stdout]
//   --check  re-derive and require the committed corpus to match, writing nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from './oracle-lib.mjs';
import { THEMES, BIOME_NAMES, themeByName, themeForCup, biomeNameForCup, boostShades }
  from '../public/shared/themes.js';
import { CUPS, TRACK_LIST } from '../public/shared/tracks.js';
import { DEV_TRACKS } from '../public/shared/devTracks.js';
import { resolveModelTint, buildTrackBin } from '../public/shared/trackBin.js';

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

// ---- resolveTheme: INLINED, and it has to be --------------------------------
// buildTrackBin was split into "resolve the theme" + "serialize the resolved
// theme" while this corpus was being recorded, and only the corpus landed. The
// split itself was never committed — the string `resolveTheme` appears in no
// blob in this repository's history except this file — so the recipe at the top
// cannot name a `git show` for it, and for a while it named a nonexistent one.
// An oracle whose restore recipe does not run is not renewable, which is the
// whole point of freezing it with a recipe. So the resolver lives here.
//
// A copy is not evidence, so the two things the header used to merely assert are
// now checked instead:
//
//   1. --check requires the re-derived corpus to equal the committed one byte
//      for byte. That is what makes this copy the same function that recorded
//      the fixture: every field below is projected into the corpus, so a drift
//      anywhere in it moves a byte.
//   2. Every payload is rebuilt out of its own resolved form and pushed back
//      through the SHIPPED buildTrackBin, which must emit identical bytes (see
//      assertLosslessSplit). That is the old "byte-identical over all 132
//      biome x track payloads" claim, executed on every run rather than
//      remembered, with the serializer that actually shipped as the referee.
//
// One field is outside (2)'s reach: water.shoreSeed is derived from trackId, so
// both sides of the round trip derive it identically and a wrong derivation
// would cancel. It is pinned by (1) alone, where the seed is a recorded literal.

// The enum tables and the coercion buildTrackBin serializes through. Kept beside
// the resolver because the round-trip check has to invert exactly these.
const GROUND_KINDS = { lawn: 0, sand: 1, redrock: 2, snow: 3, wood: 4 };
const HILL_SHAPES = { dome: 0, mesa: 1, block: 2, island: 3 };
const AMB_KINDS = { pollen: 1, mote: 2, sand: 3, flake: 4 };
const LM = { gnome: 0, doghouse: 1, picnic: 2, hoodoo: 3, snowman: 4,
             blocks: 5, windmill: 6, lighthouse: 7, sailboat: 8, duck: 9,
             ball: 10, umbrella: 11, sandcastle: 12, cabin: 13, crayons: 14,
             books: 15, train: 16 };
const CLK = { flower: 0, shell: 1, starfish: 2, driftwood: 3, drift: 4,
              scrub: 5, pebbles: 6, brick: 7, marble: 8, domino: 9 };
const num = (v, d) => {
  if (v == null) return d;
  return typeof v === 'string' ? parseInt(v.replace('#', ''), 16) : v;
};

function resolveTheme(td) {
  const rd = td.road || {};
  const sky = td.sky || {};
  const sc = td.scenery || {};
  const gy = td.gantry || {};
  const cl = td.clouds || {};
  const hz = td.haze || {};
  const bi = td.birds || {};
  const ki = td.kites || {};
  const am = td.ambient, pp = td.paperPlane, ba = td.balloon, ic = td.ice, wa = td.water;
  const models = [...new Set([...(sc.trees || []).map((e) => e.model),
                              ...(sc.bush ? [sc.bush.model] : [])])];
  // A palette with an unported clutter kind sends NONE, not a filtered list: the
  // C++ replays the same rand stream, so a silently skipped kind diverges it.
  const clRaw = (sc.clutter && sc.clutter.kinds) || [];
  const clutter = clRaw.every((k) => CLK[k.kind] != null)
    ? clRaw.map((k) => ({ kind: CLK[k.kind], w: k.w, tints: (k.tints || []).map((t) => num(t, 0xffffff)) }))
    : [];
  // shorelineFn's per-track seed: FNV-1a over the track id.
  let shoreSeed = 0;
  if (wa) {
    let s = 2166136261 >>> 0;
    for (const ch of String(td.trackId ?? '')) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
    shoreSeed = s;
  }
  const rockS = sc.rockS || [0.3, 0.45];
  return {
    road: {
      asphalt: num(rd.asphalt, 0x5a6078), line: num(rd.line, 0xc4c4d9),
      dash: num(rd.dash ?? rd.line, 0xc4c4d9),
      kerbA: num(rd.kerb ? rd.kerb[0] : null, 0xfa6b41),
      kerbB: num(rd.kerb ? rd.kerb[1] : null, 0xf8f8fb),
      skirt: num(rd.skirt ?? rd.asphalt, 0x5a6078),
      shoulder: num(rd.shoulder ?? rd.asphalt, 0x5a6078),
      kerbW: rd.kerbW ?? 0.22, kerbH: rd.kerbH ?? 0.20,
      edgeLines: rd.edgeLines !== false,
    },
    sky: [num(sky.zenith, 0x59a7e8), num(sky.horizon, 0x8ecae6), num(sky.below, 0xc8e9f2)],
    fog: num(td.fog, 0x8ecae6),
    hillShape: HILL_SHAPES[td.hillShape] ?? 0,
    hills: (td.hills || [0x8cc578, 0x7cb86a, 0x9bce86]).map((h) => num(h, 0x8cc578)),
    scenery: {
      density: sc.density ?? 0,
      mixTree: (sc.mix && sc.mix.tree) ?? 0,
      mixBush: (sc.mix && sc.mix.bush) ?? 0,
      models,
      trees: (sc.trees || []).map((e) => ({ model: e.model, w: e.w, s0: e.s[0], s1: e.s[1] })),
      bush: sc.bush ? { model: sc.bush.model, s0: sc.bush.s[0], s1: sc.bush.s[1], sink: sc.bush.sink || 0 } : null,
      // Every authored rock colour, not a fixed three: the scatter picks by
      // index over the FULL list, so truncating also skews every other share.
      rocks: (sc.rocks || [0xaaaaaa, 0xb4a898, 0x9aa2a4]).map((r) => num(r, 0xaaaaaa)),
      rockS: [rockS[0], rockS[1]],
      clutterDensity: (sc.clutter && sc.clutter.density) || 0,
      clutter,
    },
    // Source order, not id order: several landmark kinds share one rand stream.
    landmarks: [].concat(td.landmark || []).map((k) => LM[k]).filter((k) => k != null),
    structure: num(td.structure, 0x9aa1b4),
    groundKind: GROUND_KINDS[(td.ground && td.ground.kind) || 'lawn'] ?? 0,
    fogTune: td.fogTune ?? 1,
    key: { color: num(td.key && td.key.color, 0xfff1d0), intensity: (td.key && td.key.intensity) ?? 1.4 },
    hemi: { sky: num(td.hemi && td.hemi.sky, 0xffffff), ground: num(td.hemi && td.hemi.ground, 0x9aa68f),
            intensity: (td.hemi && td.hemi.intensity) ?? 2.2 },
    clouds: { count: cl.count ?? 8, opacity: cl.opacity ?? 0.8, scale: cl.scale ?? 1,
              aspect: cl.aspect ?? 0.42, tint: num(cl.tint, 0xffffff) },
    gate: num(td.gate, 0xffffff),
    // FinishGate's DEFAULT_GANTRY is { pylon: RED, finial: PAPER }; `rings` is
    // OPTIONAL (its presence switches the pylon to lighthouse bands), so it
    // carries a flag rather than a default.
    gantry: { pylon: num(gy.pylon, 0xff5040), finial: num(gy.finial, 0xfff6eb),
              hasRings: gy.rings != null, rings: num(gy.rings, 0xff5040) },
    boost: num(td.boost, 0x22c9b6),
    water: wa ? { foam: num(wa.foam, 0xffffff), shallow: num(wa.shallow, 0x62d3c8),
                  deep: num(wa.deep, 0x2596c8), wet: num(wa.wet, 0x7d5f34), shoreSeed } : null,
    haze: { count: hz.count ?? 0, opacity: hz.opacity ?? 0.16, tint: num(hz.tint, 0xffffff), scale: hz.scale ?? 1 },
    ambient: {
      kind: am ? (AMB_KINDS[am.kind] ?? 0) : 0, count: am ? (am.count ?? 650) : 0,
      size: (am && am.size) ?? 0.3, opacity: (am && am.opacity) ?? 0.85,
      tint: num(am && am.tint, 0xffffff),
      fall: (am && am.fall) ?? 1, wind: (am && am.wind) ?? 0.7,
      bob: (am && am.bob) ?? 0, band: (am && am.band) ?? 1,
    },
    birds: { count: bi.count ?? 0, tint: num(bi.tint, 0xffffff), size: bi.size ?? 2.4, y: bi.y ?? 18,
             rc: bi.rc ?? 120, rb: bi.rb ?? 22, speed: bi.speed ?? 0.2, flap: bi.flap ?? 0.8,
             flapHz: bi.flapHz ?? 1.8, dys: bi.dys ?? 1 },
    kites: { count: ki.count ?? 0, size: ki.size ?? 2.8, y: ki.y ?? 13,
             tints: (ki.tints || []).map((t) => num(t, 0xffffff)) },
    plane: pp ? { tint: num(pp.tint, 0xfaf7ec), size: pp.size ?? 3.2, y: pp.y ?? 22, a0: pp.a0 ?? 1.3,
                  rc: pp.rc ?? 95, rb: pp.rb ?? 32, speed: pp.speed ?? 0.3, bank: pp.bank ?? 0.4 } : null,
    balloon: { panels: ((ba && ba.panels) || []).map((p) => num(p, 0xffffff)),
               y: (ba && ba.y) ?? 44, size: (ba && ba.size) ?? 6 },
    ice: ic ? { sheet: num(ic.sheet, 0xa9d7ee), frost: num(ic.frost, 0xf0f8fd) } : null,
  };
}

// Proof (2): resolveTheme loses and changes nothing the shipped serializer reads.
// Rebuild a payload out of the RESOLVED form only, and require buildTrackBin to
// emit the same bytes for it as for the payload it came from. A dropped field, a
// wrong default or a mis-inverted enum all move a byte. The parts resolveTheme is
// not responsible for (the roster, the track id behind the shoreline seed, the
// model tints) are passed through untouched — they are not what is being proven.
function payloadFromResolved(R, td) {
  const inv = (m, v) => {
    const k = Object.keys(m).find((n) => m[n] === v);
    if (k == null) throw new Error(`no ${JSON.stringify(m)} name for ${v}`);
    return k;
  };
  if (R.ambient.kind === 0 && R.ambient.count !== 0) {
    throw new Error('ambient: unnamed kind with a live count is not representable');
  }
  return {
    trackId: td.trackId,
    road: { asphalt: R.road.asphalt, line: R.road.line, dash: R.road.dash,
            kerb: [R.road.kerbA, R.road.kerbB], skirt: R.road.skirt, shoulder: R.road.shoulder,
            kerbW: R.road.kerbW, kerbH: R.road.kerbH, edgeLines: R.road.edgeLines },
    sky: { zenith: R.sky[0], horizon: R.sky[1], below: R.sky[2] },
    fog: R.fog,
    hills: R.hills,
    hillShape: inv(HILL_SHAPES, R.hillShape),
    ground: { kind: inv(GROUND_KINDS, R.groundKind) },
    key: { color: R.key.color, intensity: R.key.intensity },
    hemi: { sky: R.hemi.sky, ground: R.hemi.ground, intensity: R.hemi.intensity },
    clouds: { ...R.clouds },
    fogTune: R.fogTune,
    water: R.water ? { foam: R.water.foam, shallow: R.water.shallow,
                       deep: R.water.deep, wet: R.water.wet } : null,
    haze: { ...R.haze },
    ambient: R.ambient.kind === 0 ? null
      : { kind: inv(AMB_KINDS, R.ambient.kind), count: R.ambient.count, size: R.ambient.size,
          opacity: R.ambient.opacity, tint: R.ambient.tint, fall: R.ambient.fall,
          wind: R.ambient.wind, bob: R.ambient.bob, band: R.ambient.band },
    birds: { ...R.birds },
    kites: { ...R.kites },
    paperPlane: R.plane ? { ...R.plane } : null,
    balloon: { ...R.balloon },
    ice: R.ice ? { ...R.ice } : null,
    gate: R.gate,
    gantry: { pylon: R.gantry.pylon, finial: R.gantry.finial,
              ...(R.gantry.hasRings ? { rings: R.gantry.rings } : {}) },
    boost: R.boost,
    structure: R.structure,
    scenery: {
      density: R.scenery.density,
      mix: { tree: R.scenery.mixTree, bush: R.scenery.mixBush },
      trees: R.scenery.trees.map((t) => ({ model: t.model, w: t.w, s: [t.s0, t.s1] })),
      bush: R.scenery.bush
        ? { model: R.scenery.bush.model, s: [R.scenery.bush.s0, R.scenery.bush.s1], sink: R.scenery.bush.sink }
        : null,
      rocks: R.scenery.rocks,
      rockS: R.scenery.rockS,
      clutter: { density: R.scenery.clutterDensity,
                 kinds: R.scenery.clutter.map((k) => ({ kind: inv(CLK, k.kind), w: k.w, tints: k.tints })) },
    },
    landmark: R.landmarks.map((k) => inv(LM, k)),
    roster: td.roster,
    modelTints: td.modelTints,
  };
}

function assertLosslessSplit(R, td, where) {
  const a = buildTrackBin(td);
  const b = buildTrackBin(payloadFromResolved(R, td));
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw new Error(`resolveTheme is not a lossless split of buildTrackBin at ${where}`);
  }
}

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
    const resolved = resolveTheme(payload);
    assertLosslessSplit(resolved, payload, `${name} x ${id}`);
    lines.push(canonicalStringify({ case: 'theme', biome: name, track: id, resolved: project(resolved) }));
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
// Three modes, ONE of which runs — the braces matter. `process.exit()` right
// after a write to a PIPE truncates it silently at the 64 KiB buffer (this
// corpus is 264 KB), so --stdout must fall out of the chain rather than exit,
// which in turn means the default write has to be an `else` and not trailing
// statements. Proof (1) below is the middle arm: the corpus is frozen evidence,
// so re-deriving it is a CHECK by default of intent — --check re-runs the whole
// recording and requires the committed bytes back, which is what makes the
// inlined resolver above the same function that recorded them.
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else if (process.argv.includes('--check')) {
  const have = fs.readFileSync(OUT, 'utf8');
  if (have !== text) {
    console.error(`${OUT}: re-derived corpus differs from the committed one`);
    process.exit(1);
  }
  console.log(`${OUT}: reproduced byte-identically (${cases} resolved palettes, `
    + `${cases} lossless-split checks against the shipped buildTrackBin)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${BIOME_NAMES.length} biomes x ${tracks.length} tracks = ${cases} resolved palettes`);
}
