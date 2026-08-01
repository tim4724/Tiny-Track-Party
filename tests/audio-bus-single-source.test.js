'use strict';
// The master bus and its volume preference are declared ONCE.
//
// They were not: the limiter's three constants stood in display/Audio.js and two
// audition galleries, and the volume key in those plus gallery-music.js — under
// two different constant names, with "shared with the other galleries" comments
// standing in for an actual shared source.
//
// This is worth a tripwire rather than trusting review, because the failure is
// SILENT: an audition gallery whose bus has drifted from the shipped one still
// plays every cue and still sounds fine. It just answers a question about a mix
// nobody ships, and nothing about the answer says so.
//
// Deliberately literal source-text guards, in the idiom of config-drift.test.js:
// a reformat FAILS loudly rather than silently matching nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUS = 'public/display/audio/bus.js';

// Every browser file that could plausibly re-declare it. Discovered rather than
// listed for the galleries, so a NEW audio gallery is covered on the day it lands.
function audioFiles() {
  const pub = path.join(ROOT, 'public');
  const galleries = fs.readdirSync(pub)
    .filter((f) => f.startsWith('gallery') && f.endsWith('.js'))
    .map((f) => `public/${f}`);
  return [...galleries, 'public/display/Audio.js'];
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the volume storage key is written in exactly one file', () => {
  assert.match(read(BUS), /'tinytrack_sound_volume_v1'/, `${BUS} must hold the key`);
  for (const f of audioFiles()) {
    assert.doesNotMatch(read(f), /tinytrack_sound_volume_v1/,
      `${f} re-types the volume key — import storedVolume/saveVolumePercent from display/audio/bus.js instead`);
  }
});

test('the limiter is configured in exactly one file', () => {
  // The three values that define the soft limiter. Read out of the bus rather
  // than re-typed here, so tuning the limiter never needs a test edit — this
  // asserts UNIQUENESS, and has no opinion about the numbers themselves.
  const bus = read(BUS);
  const spec = ['threshold', 'knee', 'ratio'].map((p) => {
    const m = new RegExp(`comp\\.${p}\\.value = (-?[\\d.]+);`).exec(bus);
    assert.ok(m, `${BUS} no longer sets comp.${p}.value — has the bus been rewritten?`);
    return { p, v: m[1] };
  });
  assert.deepEqual(spec.map((s) => s.p), ['threshold', 'knee', 'ratio']);

  for (const f of audioFiles()) {
    assert.doesNotMatch(read(f), /createDynamicsCompressor/,
      `${f} builds its own limiter — call createMasterBus from display/audio/bus.js instead`);
  }
});

test('every audio surface actually reaches the shared bus', () => {
  // The guards above are absence checks, which a file could satisfy by having no
  // audio at all. This is the presence half: anything that opens an AudioContext
  // has to get its master from the shared module.
  for (const f of audioFiles()) {
    const src = read(f);
    if (!/new AC\(|new AudioContext|webkitAudioContext/.test(src)) continue;
    // includes(), not assert.match — a failed match dumps the whole source file
    // over the one line that says what to do about it.
    assert.ok(src.includes('audio/bus.js'),
      `${f} creates an AudioContext but does not import display/audio/bus.js`);
  }
});
