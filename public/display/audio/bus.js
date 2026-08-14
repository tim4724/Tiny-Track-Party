// The master audio bus, and the one volume preference behind it.
//
// This is the SHIPPING mix path: master gain → soft limiter → destination. It
// lives here rather than inside Audio.js because the sound gallery builds it
// too: /gallery-sounds auditions cues at the level a race plays them, and the
// limiter is the part of the mix that cannot be judged in isolation — it acts on
// the SUM of everything, so an audition through a different bus is an audition
// of a different mix. It used to be a hand-copied set of three numbers with
// "the shipping master bus, verbatim" written above it. Now it is the same code.
//
// The volume preference sits here for the same reason: the display and both
// audio galleries read one localStorage key, and it was written out four times
// under two different names.

// One key, one default. A phone/TV in private mode throws on access, so every
// read falls back rather than propagating — losing the preference is the whole
// cost.
const VOLUME_KEY = 'tinytrack_sound_volume_v1';
const DEFAULT_VOLUME = 0.6;
// The display's mute switch (the TV's corner button / the host phone's Sound
// setting). Stored beside the volume so it survives a reload, but applied by
// RaceAudio rather than createMasterBus: the audition galleries build this bus
// too, and a muted TV must not silently mute an audition.
const MUTED_KEY = 'tinytrack_sound_muted_v1';

// Stored volume as a 0..1 gain. The slider stores 0..100 because that is what an
// <input type=range> carries; clamped on the way out so a hand-edited value
// cannot blow the bus.
export function storedVolume() {
  try {
    const raw = parseInt(localStorage.getItem(VOLUME_KEY), 10);
    return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : DEFAULT_VOLUME;
  } catch (_) { return DEFAULT_VOLUME; }
}

// Persist the slider's own 0..100 value. Takes what the input carries so no
// caller has to remember which end of the conversion it is on.
export function saveVolumePercent(pct) {
  try { localStorage.setItem(VOLUME_KEY, String(pct)); } catch (_) { /* private mode */ }
}

// The stored mute flag. Same private-mode fallback as the volume: losing the
// preference is the whole cost, and the default is sound ON.
export function storedMuted() {
  try { return localStorage.getItem(MUTED_KEY) === '1'; } catch (_) { return false; }
}

export function saveMuted(on) {
  try { localStorage.setItem(MUTED_KEY, on ? '1' : '0'); } catch (_) { /* private mode */ }
}

// Build the bus on `ctx` and return its master gain — connect sources to that.
// Seeded from the stored volume, so a page that never touches a slider still
// honours the preference.
export function createMasterBus(ctx) {
  const master = ctx.createGain();
  master.gain.value = storedVolume();
  // Soft limiter: overlapping cues (8 cars' worth) must not clip TV speakers.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  master.connect(comp);
  comp.connect(ctx.destination);
  return master;
}
