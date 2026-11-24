// The Android music bed loops by CHAINING a second player, never by `isLooping`.
//
// `isLooping` reads as the obvious idiom and it does loop, which is what makes it
// a trap: NuPlayer drains its AudioTrack at the end, seeks and restarts it, and on
// the Google TV Streamer the mix pulls no music for over 100 ms of every wrap.
// Nothing logs it and no suite can hear it, so this pins the shape instead:
// `AudioDevice.queueLoop` carries the measurement.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..',
  'shells/androidtv/app/src/main/kotlin/games/paperballoon/tinytrack/AudioDevice.kt'), 'utf8');
// Comments quote the trap while explaining it; only code counts.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('the music bed never loops through isLooping / setLooping', () => {
  assert.ok(!/\bisLooping\s*=|\bsetLooping\s*\(/.test(code),
    'a MediaPlayer loop leaves a hole at every wrap on the Streamer; chain a copy instead');
});

test('the music bed chains its next copy with setNextMediaPlayer', () => {
  assert.ok(/\.setNextMediaPlayer\(/.test(code), 'no copy is chained behind the playing song');
  assert.ok(/setOnCompletionListener/.test(code),
    'the completion is where the played-out copy is released and the next one queued');
});
