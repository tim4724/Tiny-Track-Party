// The scene-build payload for the native renderer: the built track plus the
// RESOLVED theme — every biome slice the renderer needs, with the JS defaulting
// rules (ambient kind presets, cloud/bird/plane defaults, the per-track ambient
// patch) already folded in, so the C++ side never re-implements them.
//
// Shared by the compare gallery's fixture and the display's own ?renderer=
// filament path, so both feed the renderer from one source of truth.
import { PLATE_Y } from './textures.js';
import { AMB_KINDS, DEF_BIRDS, DEF_CLOUDS, DEF_PLANE } from './environment.js';

// `roster`: [{ id, name, carIndex, color }] in cell order. The JSON round-trip
// drops the centerline's methods, which is deliberate — plain data crosses.
export function trackPayload(scene, track, roster) {
  return JSON.parse(JSON.stringify({
  trackId: track.trackId, cup: track.cup, seed: track.seed,
  // Resolved theme slices the second renderer needs (palette truth stays JS-side).
  road: (scene._theme && scene._theme.road) || null,
  sky: (scene._theme && scene._theme.sky) || null,
  fog: (scene._theme && scene._theme.fog) ?? null,
  hills: (scene._theme && scene._theme.hills) || null,
  hillShape: (scene._theme && scene._theme.hillShape) || 'dome',
  // Everything else the biome dresses: ground kind, the light rig, the
  // sky/air/water furniture and the accent colours. Sent resolved (the
  // per-track ambient patch is already folded in) so the C++ side never
  // has to know a theme's defaulting rules.
  ground: (scene._theme && scene._theme.ground) || null,
  key: (scene._theme && scene._theme.key) || null,
  hemi: (scene._theme && scene._theme.hemi) || null,
  clouds: { ...DEF_CLOUDS, ...((scene._theme && scene._theme.clouds) || {}) },
  fogTune: (scene._theme && scene._theme.fogTune) ?? null,
  water: (scene._theme && scene._theme.water) || null,
  haze: (scene._theme && scene._theme.haze) || null,
  ambient: (() => {
    const t = scene._theme;
    if (!t || !t.ambient) return null;
    const patch = t.ambientByTrack && t.ambientByTrack[track.trackId];
    return { ...(AMB_KINDS[t.ambient.kind] || AMB_KINDS.flake),
     ...t.ambient, ...(patch || {}) };
  })(),
  birds: (scene._theme && scene._theme.birds)
    ? { ...DEF_BIRDS, ...scene._theme.birds } : null,
  kites: (scene._theme && scene._theme.kites) || null,
  paperPlane: (scene._theme && scene._theme.paperPlane)
    ? { ...DEF_PLANE, ...scene._theme.paperPlane } : null,
  balloon: (scene._theme && scene._theme.balloon) || null,
  ice: (scene._theme && scene._theme.ice) || null,
  gate: (scene._theme && scene._theme.gate) ?? null,
  gantry: (scene._theme && scene._theme.gantry) || null,
  boost: (scene._theme && scene._theme.boost) ?? null,
  // Support-structure tint (bridge pillars, corridor poles, loop shafts).
  structure: (scene._theme && scene._theme.structure) ?? null,
  scenery: (scene._theme && scene._theme.scenery) || null,
  // buildScenery's two stream seeds, computed HERE where the exact
  // idStr inputs live — the C++ scatter replays the identical streams.
  landmark: (scene._theme && scene._theme.landmark) || null,
  scenerySeeds: (() => {
    const idStr = String(track.id || track.name || '') + Math.round(track.centerline.length * 100);
    let s1 = 2166136261, s2 = 5381, s3 = 51966; // scatter, clutter, landmarks
    for (let i = 0; i < idStr.length; i++) {
      s1 = ((s1 ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
      s2 = ((s2 ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
      s3 = ((s3 ^ idStr.charCodeAt(i)) * 16777619) >>> 0;
    }
    return [s1, s2, s3];
  })(),
  roster: roster.map((r) => ({
    id: r.id, name: r.name, carIndex: r.carIndex, color: r.color,
    // Hand-tuned rear-panel height for this model (SceneRenderer applies
    // the same override); the native renderer can't raycast the proto.
    plateY: PLATE_Y[r.carIndex % PLATE_Y.length] ?? null,
    model: (window.CAR_MODELS || [])[r.carIndex % (window.CAR_MODELS || [1]).length] || null
  })),
  track
        }));
}
