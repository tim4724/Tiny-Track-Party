// The scene-build payload for the renderer: a track ID plus the RESOLVED theme —
// every biome slice the renderer needs, with the JS defaulting rules (ambient
// kind presets, cloud/bird/plane defaults, the per-track ambient patch) already
// folded in, so the C++ side never re-implements them.
//
// An ID, not a track. The geometry is the renderer's own business: it runs the
// native TrackBuilder on this ID and meshes from the result, which is the same
// object the sim races on. What crosses is only what geometry cannot imply — the
// biome palette, which is authored in JS (shared/themes.js) and stays there.
//
// Crossing ONCE PER RACE is the whole budget here: this is a scene build, not a
// frame. Nothing that moves is in it (see render/Display.js).

// Per-model plate height (world Y on the rear face), indexed by CAR_MODELS
// position. Hand-tuned per model so the rear name plate sits on each car's flat
// rear surface; the renderer can't raycast for it the way a scene graph could.
// Order: racer, speedster, racer-low, vintage-racer.
const PLATE_Y = [0.157, 0.245, 0.156, 0.134];

// Ambient-particle presets by kind, and the defaults a theme's cloud/bird/plane
// block is merged over. Authored here because they ARE the payload's defaulting
// rules — a theme that omits a field means "this preset", and the renderer only
// ever sees the resolved number.
const AMB_KINDS = {
  flake:  { size: 0.3,  opacity: 0.85, fall: 1,    wind: 0.7, bob: 0,    band: 1 },
  mote:   { size: 0.13, opacity: 0.5,  fall: 0.05, wind: 0.4, bob: 0.4,  band: 0.5 },
  sand:   { size: 0.17, opacity: 0.4,  fall: 0,    wind: 9,   bob: 0.5,  band: 0.1 },
  pollen: { size: 0.15, opacity: 0.5,  fall: 0.1,  wind: 1.2, bob: 0.6,  band: 0.35 }
};
const DEF_CLOUDS = { count: 8, opacity: 0.8, scale: 1, aspect: 0.42, tint: 0xffffff };
const DEF_BIRDS = { count: 0, tint: 0xffffff, size: 2.4, y: 18, rc: 120, rb: 22,
                    speed: 0.2, flap: 0.8, flapHz: 1.8, dys: 1 };
const DEF_PLANE = { tint: 0xfaf7ec, size: 3.2, y: 22, a0: 1.3, rc: 95, rb: 32,
                    speed: 0.3, bank: 0.4 };

// `theme`: the resolved biome (themeForCup / the ?biome= override).
// `track`:  the catalogue entry (shared/tracks.js TRACK_LIST) — an id and its
//           metadata, never geometry.
// `roster`: [{ id, name, carIndex, color }] in slot order.
export function trackPayload(theme, track, roster) {
  const t = theme || {};
  return JSON.parse(JSON.stringify({
  trackId: track.id,
  // Resolved theme slices the renderer needs (palette truth stays JS-side).
  road: t.road || null,
  sky: t.sky || null,
  fog: t.fog ?? null,
  hills: t.hills || null,
  hillShape: t.hillShape || 'dome',
  // Everything else the biome dresses: ground kind, the light rig, the sky/air/
  // water furniture and the accent colours. Sent resolved (the per-track ambient
  // patch is already folded in) so the C++ side never has to know a theme's
  // defaulting rules.
  ground: t.ground || null,
  key: t.key || null,
  hemi: t.hemi || null,
  clouds: { ...DEF_CLOUDS, ...(t.clouds || {}) },
  fogTune: t.fogTune ?? null,
  water: t.water || null,
  haze: t.haze || null,
  ambient: (() => {
    if (!t.ambient) return null;
    const patch = t.ambientByTrack && t.ambientByTrack[track.id];
    return { ...(AMB_KINDS[t.ambient.kind] || AMB_KINDS.flake), ...t.ambient, ...(patch || {}) };
  })(),
  birds: t.birds ? { ...DEF_BIRDS, ...t.birds } : null,
  kites: t.kites || null,
  paperPlane: t.paperPlane ? { ...DEF_PLANE, ...t.paperPlane } : null,
  balloon: t.balloon || null,
  ice: t.ice || null,
  gate: t.gate ?? null,
  gantry: t.gantry || null,
  boost: t.boost ?? null,
  // Support-structure tint (bridge pillars, corridor poles, loop shafts).
  structure: t.structure ?? null,
  scenery: t.scenery || null,
  landmark: t.landmark || null,
  // buildScenery's stream seeds are NOT here: they hash the built track's
  // length, which is geometry, so the renderer derives them from the track it
  // just built (TtpRenderer::fillGeometry).
  roster: roster.map((r) => ({
    id: r.id, name: r.name, carIndex: r.carIndex, color: r.color,
    plateY: PLATE_Y[r.carIndex % PLATE_Y.length] ?? null,
    model: (window.CAR_MODELS || [])[r.carIndex % (window.CAR_MODELS || [1]).length] || null
  }))
        }));
}
