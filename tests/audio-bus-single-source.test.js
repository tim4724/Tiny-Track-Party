'use strict';
// The master bus and the two audio preferences behind it are declared ONCE.
//
// They were not: the limiter's three constants stood in display/Audio.js and two
// audition galleries, the volume key in those plus gallery-music.js — under two
// different constant names, with "shared with the other galleries" comments
// standing in for an actual shared source — and the variant-picks key in
// Audio.js and gallery-sounds.js with the same parse-or-empty dance around it.
//
// This is worth a tripwire rather than trusting review, because the failure is
// SILENT: an audition gallery whose bus has drifted from the shipped one still
// plays every cue and still sounds fine. It just answers a question about a mix
// nobody ships, and nothing about the answer says so.
//
// AND THE TWO TV SHELLS RE-TYPE THE SAME NUMBERS, in Kotlin and in Swift, with
// nothing in the tree that could see all three. They cannot IMPORT bus.js — one
// renders its own mix in a Kotlin DSP loop, the other configures an Apple AU —
// so this is the case rule 1 answers with a gate rather than with a read, the
// same shape `tests/shader-cpp-constants.test.js` uses for the shader constants.
// The mix contract is six numbers: the limiter's five, and the gain ahead of it
// — which is a slider's DEFAULT on the web and a fixed constant on a television,
// where the volume control is the TV's. What is pinned is that they start from
// the same place, so the limiter is fed the level it was tuned against. Tuning any of them is one edit in `bus.js` plus whatever this
// test then names.
//
// Deliberately literal source-text guards, in the idiom of config-drift.test.js:
// a reformat FAILS loudly rather than silently matching nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUS = 'public/display/audio/bus.js';
const PICKS = 'public/display/audio/picks.js';

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

test('the variant-picks key is written in exactly one file', () => {
  assert.match(read(PICKS), /'tinytrack_sound_picks_v1'/, `${PICKS} must hold the key`);
  for (const f of audioFiles()) {
    assert.doesNotMatch(read(f), /tinytrack_sound_picks_v1/,
      `${f} re-types the picks key — import storedPicks/savePicks from display/audio/picks.js instead`);
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

// The mix contract, as the two TV shells spell it. Each entry names the file and
// a regex whose first group is the value; the EXPECTED value is read out of
// bus.js, never typed here, so tuning the limiter never needs a test edit.
const SHELL_MIX = [
  {
    file: 'shells/tvos/TinyTrackParty/Audio/AudioDevice.swift',
    // The Apple AU takes threshold and headroom; `ratio` has no control there
    // (the file says so where it maps them), so only what it CAN set is pinned.
    values: {
      gain: /masterVolume: Float = ([\d.]+)/,
      threshold: /kDynamicsProcessorParam_Threshold, (-?[\d.]+)\)/,
      knee: /kDynamicsProcessorParam_HeadRoom, (-?[\d.]+)\)/,
      attack: /kDynamicsProcessorParam_AttackTime, ([\d.]+)\)/,
      release: /kDynamicsProcessorParam_ReleaseTime, ([\d.]+)\)/,
    },
  },
  {
    file: 'shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack/AudioMixer.kt',
    values: {
      gain: /const val MASTER = ([\d.]+)f/,
      threshold: /const val COMP_THRESHOLD = (-?[\d.]+)/,
      knee: /const val COMP_KNEE = ([\d.]+)/,
      ratio: /const val COMP_RATIO = ([\d.]+)/,
      attack: /const val COMP_ATTACK = ([\d.]+)/,
      release: /const val COMP_RELEASE = ([\d.]+)/,
    },
  },
];

/**
 * The mix contract as `bus.js` authors it.
 *
 * Two of the six are WebAudio's own defaults and so are not spelled in the file
 * at all — `DynamicsCompressorNode` ships attack 0.003 and release 0.25, and the
 * bus deliberately leaves them alone. A shell rendering its own compressor has
 * to state them, so they are named here WITH their source rather than left as
 * the one pair nothing watches.
 */
function busContract() {
  const bus = read(BUS);
  const at = (re, what) => {
    const m = re.exec(bus);
    assert.ok(m, `${BUS} no longer sets ${what} — has the bus been rewritten?`);
    return Number(m[1]);
  };
  return {
    gain: at(/const DEFAULT_VOLUME = ([\d.]+);/, 'the default volume'),
    threshold: at(/comp\.threshold\.value = (-?[\d.]+);/, 'comp.threshold.value'),
    knee: at(/comp\.knee\.value = ([\d.]+);/, 'comp.knee.value'),
    ratio: at(/comp\.ratio\.value = ([\d.]+);/, 'comp.ratio.value'),
    // WebAudio's defaults, left unset by the bus on purpose.
    attack: 0.003,
    release: 0.25,
  };
}

for (const shell of SHELL_MIX) {
  test(`${shell.file.split('/')[1]}'s mix is the bus's, number for number`, () => {
    const full = path.join(ROOT, shell.file);
    if (!fs.existsSync(full)) return;   // a checkout without this shell
    const src = fs.readFileSync(full, 'utf8');
    const want = busContract();
    for (const [name, re] of Object.entries(shell.values)) {
      const m = re.exec(src);
      assert.ok(m, `${shell.file}: could not read its ${name} — the anchor has moved`);
      assert.equal(Number(m[1]), want[name],
        `${shell.file}'s ${name} is ${m[1]} but ${BUS} says ${want[name]} — `
        + 'the mix contract is one set of numbers, and a shell that has drifted '
        + 'plays a mix nobody shipped');
    }
  });
}

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
