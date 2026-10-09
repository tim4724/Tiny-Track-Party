// The display's debug-settings panel (faint wrench, bottom-left): an interactive
// editor for this page's query params. Edits reload the page so each param takes
// effect through its normal boot path, EXCEPT the `live:` fields, which drive the
// running scene directly.
//
// Pure configuration — the panel itself is shared/debugPanel.js. It lives apart
// from main.js because it is a fifty-line data blob describing URL hooks that are
// each already documented where they are read; keeping it inline buried the
// bootstrap tail under it.
export function displayDebugFields({ maxPlayers, carNames, trackList, itemIds, biomeNames, scene, sim }) {
  // Capture the engine default ONCE, before any URL ?steerExpo= value is applied
  // (the panel's range field calls live() at init). Used for both the slider's
  // default and the "· default" readout marker — reading it live inside format()
  // would wrongly equal the dragged value.
  const steerDefault = sim.getNativeSteerExpo();
  // The camera and curb knobs: each setter takes -1 as "authored" and answers
  // the authored value, which is the slider's default. At that default the
  // slider sends -1 back, so the engine runs the authored constants exactly
  // rather than a round trip through the slider.
  const knob = (set, step, unit) => {
    const value = set(-1);
    const isDefault = (n) => Math.abs(n - value) < step / 10;
    return { type: 'range', min: unit.min, max: unit.max, step, value,
      live: (n) => set(isDefault(n) ? -1 : n),
      format: (n) => unit.format(n) + (isDefault(n) ? ' · default' : '') };
  };
  const degrees = { min: 4, max: 30, format: (n) => n.toFixed(1) + '°' };
  return [
    { section: 'Test harness' },
    { key: 'scenario', label: 'Scenario', hint: 'no relay, fake players', type: 'select',
      options: ['welcome', 'device-choice', 'lobby-loading', 'lobby-empty', 'lobby', 'track', 'assets', 'countdown', 'racing', 'bench', 'results', 'intermission', 'podium']
        .map((s) => ({ value: s, label: s })) },
    { key: 'players', label: 'Players', hint: 'fake roster size', type: 'int', min: 1, max: maxPlayers },
    { key: 'host', label: 'Host seat', hint: 'blank = no host', type: 'int', min: 0, max: maxPlayers - 1 },
    { key: 'picked', label: 'Picked mode', hint: 'lobby: post-pick chrome over the preview', type: 'select',
      options: [{ value: 'cup', label: 'cup' }, { value: 'track', label: 'exact track' }, { value: 'random', label: 'random' }] },
    { section: 'Solo drive' },
    { key: 'solo', label: 'Solo keyboard', hint: 'pick a car; no phones needed', type: 'select', bare: '0',
      options: carNames.map((name, i) => ({ value: String(i), label: name })) },
    { section: 'Race' },
    { key: 'seed', label: 'Seed', hint: 'scenarios: re-rolls the field, items and wander', type: 'int', min: 0 },
    { key: 'item', label: 'Item roulette', hint: 'every box rolls this', type: 'select',
      options: itemIds.map((id) => ({ value: id, label: id })) },
    { key: 'bots', label: 'Bots', hint: 'cap the CPU fill · live launch', type: 'int', min: 0 },
    { section: 'Driving feel' },
    // Live: re-shapes the tilt→steer curve mid-race (no reload). 1 = linear scaling;
    // higher = gentler near centre, sharper toward full lock. The engine reads it
    // fresh each step, so it affects every car in the running race instantly.
    { key: 'steerExpo', label: 'Steering curve', hint: 'tilt→steer exponent · live', type: 'range',
      min: 0.6, max: 3, step: 0.05, value: steerDefault,
      live: (x) => sim.setNativeSteerExpo(x),
      format: (n) => n.toFixed(2) + (Math.abs(n - 1) < 1e-9 ? ' · linear' : Math.abs(n - steerDefault) < 1e-9 ? ' · default' : '') },
    // Live: scales the whole scene's per-frame dt (sim, props, FX, camera) for slow-mo inspection — no
    // reload. 1 = normal; drag down to watch fast action (e.g. a rocket strike) play out frame by frame.
    { key: 'timescale', label: 'Time scale', hint: 'slow-mo · live', type: 'range',
      min: 0.1, max: 1, step: 0.05, value: 1, live: (n) => scene.setTimeScale(n),
      format: (n) => n.toFixed(2) + '×' + (Math.abs(n - 1) < 1e-9 ? ' · normal' : '') },
    // Live: tilts every chase cam by raising or lowering the eye; the distance
    // behind the car stays put. Degrees below level.
    { key: 'campitch', label: 'Camera angle', hint: 'chase pitch, degrees · live',
      ...knob((n) => scene.display.debugChasePitch(n), 0.5, degrees) },
    // Live: the rig the cam eases to while YOUR car is a monster truck
    // (?item=monster makes every box roll one): its pitch, and how much further
    // back than the race rig it sits.
    { key: 'monsterpitch', label: 'Monster angle', hint: 'chase pitch as a monster truck · live',
      ...knob((n) => scene.display.debugMonsterPitch(n), 0.5, degrees) },
    { key: 'monsterback', label: 'Monster distance', hint: 'extra pullback as a monster truck · live',
      ...knob((n) => scene.display.debugMonsterBack(n), 0.05,
        { min: 0, max: 1.5, format: (n) => '+' + n.toFixed(2) }) },
    // Live: the curb's feel (the WALL_* constants in ttp/game.cc).
    { key: 'curbspeed', label: 'Curb speed', hint: 'scrape cap, share of top speed · live',
      ...knob((n) => sim.debugCurbSpeed(n), 0.01,
        { min: 0.1, max: 1, format: (n) => Math.round(n * 100) + '%' }) },
    { key: 'curbturn', label: 'Curb turn', hint: 'how fast the wall turns the car along it · live',
      ...knob((n) => sim.debugCurbTurn(n), 0.5,
        { min: 0, max: 20, format: (n) => n.toFixed(1) + '/s' + (n === 0 ? ' · hangs' : '') }) },
    { key: 'curbturnmax', label: 'Curb turn max', hint: 'fastest the wall may swing the car · live',
      ...knob((n) => sim.debugCurbTurnMax(n), 0.05,
        { min: 0.25, max: 10, format: (n) => Math.round(n * 180 / Math.PI) + '°/s' }) },
    { key: 'curbimpact', label: 'Curb impact', hint: 'speed lost per radian the wall turns (0 = only the cap bills) · live',
      ...knob((n) => sim.debugCurbImpact(n), 0.1,
        { min: 0, max: 4, format: (n) => n.toFixed(1) }) },
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
