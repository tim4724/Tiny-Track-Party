// 16-bit PCM WAV, from float channels: the one container ffmpeg reads with no
// question asked. Shared by the cue bake (scripts/bake-cues.mjs) and the trailer's
// sound render (scripts/trailer/render.js), so both quantize and frame the same way.

// base64 → Float32Array (copied into a fresh, aligned ArrayBuffer).
export function toFloats(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(bytes.length);
  Buffer.from(ab).set(bytes);
  return new Float32Array(ab);
}

export function interleave(channels) {
  const n = channels[0].length, c = channels.length;
  if (c === 1) return channels[0];
  const out = new Float32Array(n * c);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) out[i * c + k] = channels[k][i];
  return out;
}

export function quantize(floats) {
  const out = new Int16Array(floats.length);
  let clipped = 0;
  for (let i = 0; i < floats.length; i++) {
    let v = Math.round(floats[i] * 32767);
    if (v > 32767) { v = 32767; clipped++; } else if (v < -32768) { v = -32768; clipped++; }
    out[i] = v;
  }
  return { pcm: out, clipped };
}

export function wav(pcm, channels, sampleRate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);                              // PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * 2, 28);       // byte rate
  head.writeUInt16LE(channels * 2, 32);                    // block align
  head.writeUInt16LE(16, 34);                              // bits
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return { file: Buffer.concat([head, data]), pcmBytes: data };
}
