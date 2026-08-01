// Which variant of each cue plays: the sound gallery's starred choices, read by
// the race. One key, declared once — it was written out in display/Audio.js and
// gallery-sounds.js with the same parse-or-empty dance around it.
//
// It does NOT live in cues.js, and that is deliberate: `resolveVariant(cueId,
// picks)` takes the picks as an ARGUMENT so the cue palette stays free of
// browser storage — the baker imports it under Node and must resolve against
// DEFAULT_PICKS only. This module is the browser's half of that split.
//
// An absent or unparseable value means "no overrides", never an error: a stale
// or hand-mangled pick costs the starred choice, not the sound.

const PICKS_KEY = 'tinytrack_sound_picks_v1';

// { [cueId]: variantId } — the overrides only. Everything unnamed falls through
// to DEFAULT_PICKS inside resolveVariant.
export function storedPicks() {
  try { return JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; }
  catch (_) { return {}; }
}

export function savePicks(picks) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(picks)); } catch (_) { /* private mode */ }
}
