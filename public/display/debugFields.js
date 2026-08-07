// The display's debug-settings panel (faint wrench, bottom-left): an interactive
// editor for this page's query params. Edits reload the page so each param takes
// effect through its normal boot path, EXCEPT the `live:` fields, which drive the
// running scene directly.
//
// Pure configuration — the panel itself is shared/debugPanel.js. It lives apart
// from main.js because it is a fifty-line data blob describing URL hooks that are
// each already documented where they are read; keeping it inline buried the
// bootstrap tail under it.
export function displayDebugFields({ maxPlayers, carNames, trackList, biomeNames, scene, sim }) {
  // Capture the engine default ONCE, before any URL ?steerExpo= value is applied
  // (the panel's range field calls live() at init). Used for both the slider's
  // default and the "· default" readout marker — reading it live inside format()
  // would wrongly equal the dragged value.
  const steerDefault = sim.getNativeSteerExpo();
  return [
    { section: 'Test harness' },
    { key: 'scenario', label: 'Scenario', hint: 'no relay, fake players', type: 'select',
      options: ['welcome', 'device-choice', 'lobby-loading', 'lobby-empty', 'lobby', 'track', 'assets', 'countdown', 'racing', 'results', 'intermission', 'podium']
        .map((s) => ({ value: s, label: s })) },
    { key: 'players', label: 'Players', hint: 'fake roster size', type: 'int', min: 1, max: maxPlayers },
    { key: 'host', label: 'Host seat', hint: 'blank = no host', type: 'int', min: 0, max: maxPlayers - 1 },
    { key: 'picked', label: 'Picked mode', hint: 'lobby: post-pick chrome over the preview', type: 'select',
      options: [{ value: 'cup', label: 'cup' }, { value: 'track', label: 'exact track' }, { value: 'random', label: 'random' }] },
    { section: 'Solo drive' },
    { key: 'solo', label: 'Solo keyboard', hint: 'pick a car; no phones needed', type: 'select', bare: '0',
      options: carNames.map((name, i) => ({ value: String(i), label: name })) },
    { section: 'Driving feel' },
    // Live: re-shapes the tilt→steer curve mid-race (no reload). 1 = linear scaling;
    // higher = gentler near centre, sharper toward full lock. The engine reads it
    // fresh each step, so it affects every car in the running race instantly.
    { key: 'steerExpo', label: 'Steering curve', hint: 'tilt→steer exponent · live', type: 'range',
      min: 0.6, max: 3, step: 0.05, value: steerDefault,
      live: (x) => sim.setNativeSteerExpo(x),
      format: (n) => n.toFixed(2) + (Math.abs(n - 1) < 1e-9 ? ' · linear' : Math.abs(n - steerDefault) < 1e-9 ? ' · default' : '') },
    // Live: scales the whole scene's per-frame dt (sim, props, FX, camera) — no reload. Drag DOWN to
    // watch fast action (a rocket strike) play out frame by frame; drag UP to sit through a race at
    // speed while testing pacing. The top stops at 2 because BOTH the frame loop and Game::update clamp
    // a step to 50 ms: at 60 Hz, 3× already lands exactly on that clamp, so a slider that went higher
    // would keep moving while the race stopped getting any faster. Above 1 the sim takes bigger
    // integration steps, so it is a pacing tool, not a handling one.
    { key: 'timescale', label: 'Time scale', hint: 'slow-mo ⇄ fast-forward · live', type: 'range',
      min: 0.1, max: 2, step: 0.05, value: 1, live: (n) => scene.setTimeScale(n),
      format: (n) => n.toFixed(2) + '×' + (Math.abs(n - 1) < 1e-9 ? ' · normal' : '') },
    { section: 'Track' },
    { key: 'track', label: 'Preselect', type: 'select',
      options: trackList.map((t) => ({ value: t.id, label: t.name })) },
    { section: 'Rendering' },
    { key: 'biome', label: 'Biome', hint: 'override the cup look (blank = cup decides)', type: 'select',
      options: biomeNames.map((b) => ({ value: b, label: b })) },
    { key: 'dividers', label: 'Cell dividers', hint: 'ink lines between cells · default on', type: 'select',
      options: [{ value: '0', label: 'off' }] },
  ];
}
