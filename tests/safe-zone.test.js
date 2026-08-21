'use strict';
// The TV overscan safe zone, and the two things that can quietly break it.
//
// A television may crop the edges of the picture it is handed and cannot be
// asked how much. Every shell therefore reports a per-side inset through
// `ttp_display_safe_insets`, and `ttp_display_cell_rects` insets every cell by
// it on all four edges — so the HUD a shell places is inside the picture the
// viewer can actually see. The fraction is authored ONCE, as `--safe-frac-x/y`
// in theme.css.
//
// TWO GUARDS, because the number has two lives:
//
//   (a) THE C++ FALLBACK. `DisplayState` defaults to 2.5% so a shell that never
//       reports gets the safe layout rather than the clipped one. That default
//       is a second spelling of the token, and this is the tripwire that makes
//       them move together.
//   (b) THE SHELLS' RE-SPELLING. Android's boards used to carry the same margin
//       as literal `96.dp` / `54.dp` — the authored 1920x1080 times the fraction
//       of the day, which is exactly the kind of derived constant that survives
//       a change to its source (and that pair did NOT survive 5% -> 2.5%). The
//       token is the only place it may live.
//
// Source-text guards, deliberately literal: a reformat fails them loudly rather
// than silently matching nothing, which is the right direction for a tripwire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKENS = path.join(ROOT, 'public/shared/design-tokens.json');
const FRAME_BUILDER = path.join(ROOT, 'native/libttp-runtime/ttp/frame_builder.h');
const RENDERER_FRAME = path.join(ROOT, 'native/renderer/src/TtpRendererFrame.cpp');
const KOTLIN = path.join(ROOT, 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack');

const tokens = JSON.parse(fs.readFileSync(TOKENS, 'utf8')).tokens;
const token = (name) => {
  const t = tokens.find((x) => x.name === name);
  assert.ok(t, `design-tokens.json is missing --${name}`);
  return Number.parseFloat(t.resolved);
};

test('the safe inset is authored as a fraction, and a plausible one', () => {
  for (const axis of ['x', 'y']) {
    const v = token(`safe-frac-${axis}`);
    assert.ok(Number.isFinite(v), `--safe-frac-${axis} is not a number`);
    // The ABI clamps at a quarter per side; a value that needs the clamp is a
    // typo (0.5 for "half a percent" would eat half the screen).
    assert.ok(v > 0 && v < 0.25, `--safe-frac-${axis} = ${v} is outside (0, 0.25)`);
  }
});

test('the C++ default matches the authored token', () => {
  const src = fs.readFileSync(FRAME_BUILDER, 'utf8');
  const m = /float safeFracX = ([0-9.]+)f, safeFracY = ([0-9.]+)f;/.exec(src);
  assert.ok(m, 'frame_builder.h no longer declares safeFracX/safeFracY as literals');
  assert.equal(Number(m[1]), token('safe-frac-x'),
    'DisplayState::safeFracX drifted from --safe-frac-x');
  assert.equal(Number(m[2]), token('safe-frac-y'),
    'DisplayState::safeFracY drifted from --safe-frac-y');
});

test('the steer-band token still matches the bar the renderer draws', () => {
  // --steer-band-frac exists so bottom-left chrome (the music credit) can clear
  // the split-screen steer bar. The bar is the RENDERER's, so the token is a
  // COPY of geometry that lives in C++ — recomputed here from that source rather
  // than trusted, which is the same tripwire the C++ default gets above.
  const src = fs.readFileSync(RENDERER_FRAME, 'utf8');
  const num = (re, what) => {
    const m = re.exec(src);
    assert.ok(m, `TtpRendererFrame.cpp no longer spells ${what} the way this test reads it`);
    return Number(m[1]);
  };
  const scale = num(/BAR_SCALE = ([0-9.]+)f/, 'BAR_SCALE');
  const barH = num(/barW = [0-9.]+ \* unit, barH = ([0-9.]+) \* unit/, "the bar's height");
  const clear = num(/clear = ([0-9.]+) \* unit/, "the bar's clearance");
  // `unit` is BAR_SCALE * sqrt(cell.h * surfaceH) / 1080, and the band the bar
  // owns is (clear + barH) * unit measured up from the cell's bottom edge. Every
  // cell of a 2- AND a 4-player split is 540 tall, which is why one number covers
  // both — and why this is the case the token is cut for.
  const H = 1080, cellH = 540;
  const unit = scale * Math.sqrt(cellH * H) / 1080;
  const expected = (clear + barH) * unit / H;
  assert.ok(Math.abs(token('steer-band-frac') - expected) < 5e-4,
    `--steer-band-frac is ${token('steer-band-frac')} but the renderer's bar band is `
    + `${expected.toFixed(4)} of the height — one of the two moved`);
});

test('the Android shell spells the margin nowhere but the token', () => {
  // The authored canvas times the fraction, which is what the literals used to
  // be. Anything
  // matching these is a margin that stopped tracking --safe-frac-*.
  const px = { x: token('safe-frac-x') * 1920, y: token('safe-frac-y') * 1080 };
  const offenders = [];
  for (const f of fs.readdirSync(KOTLIN).filter((f) => f.endsWith('.kt'))) {
    const src = fs.readFileSync(path.join(KOTLIN, f), 'utf8');
    for (const m of src.matchAll(/(?:horizontal|vertical|start|end|top|bottom)\s*=\s*([0-9.]+)\.dp/g)) {
      const v = Number(m[1]);
      if (v === px.x || v === px.y) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these re-spell the overscan margin — use Tokens.safeMarginX/Y instead');
});
