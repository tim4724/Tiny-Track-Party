// Generates tests/fixtures/schematic-corpus.jsonl — the oracle for the C++ twin
// of public/display/trackSchematic.js (the top-down track map and its snapshot
// codec).
//
// WHAT MAKES THIS CROSS-IMPLEMENTATION EVIDENCE, which is the only kind that
// settles a port: the per-track schematics come from public/shared/
// trackSchematics.js, which is COMMITTED, was BAKED by the JS trackSchematic(),
// and is already held to the live geometry by tests/track.test.js
// ("TRACK_SCHEMATICS is in sync with the track geometry"). So the C++ side of
// this gate rebuilds each track through its own TrackBuilder and has to
// reproduce bytes the JS wrote — it is not C++ agreeing with C++. The packed
// form is recorded here the same way, straight off packSchematic.
//
// The codec cases below carry their OWN paths (no track, no geometry) and cover
// what a catalogue cannot reach: an empty path, a two-point path RDP must not
// touch, collinear filler it must collapse, a hairpin it must keep, coordinates
// at both ends of the byte range, and a non-default eps.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-schematic-corpus.mjs [--check | --stdout]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from './oracle-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/schematic-corpus.jsonl');

const { TRACK_LIST } = await import('../public/shared/tracks.js');
const { TRACK_SCHEMATICS } = await import('../public/shared/trackSchematics.js');
const { trackSchematic, packSchematic, unpackSchematic, SCHEMATIC_EPS } =
  await import('../public/display/trackSchematic.js');

// Synthetic paths, in the same spelling trackSchematic emits, so the codec is
// exercised on shapes the 20 shipped tracks do not contain.
const path0 = (pts) => {
  let d = '';
  for (let i = 0; i < pts.length; i++) d += (i === 0 ? 'M' : ' L') + pts[i][0] + ' ' + pts[i][1];
  return d + ' Z';
};

const CODEC_CASES = [
  { name: 'empty', d: '', eps: 0 },
  { name: 'single', d: path0([[10, 20]]), eps: 0 },
  { name: 'pair', d: path0([[10, 20], [200, 30]]), eps: 0 },
  // A perfectly straight run: RDP must collapse it to its two ends.
  { name: 'straight', d: path0(Array.from({ length: 40 }, (_, i) => [30 + i * 5, 128])), eps: 0 },
  // A hairpin: the apex is the whole shape and must survive.
  { name: 'hairpin', d: path0([[30, 30], [60, 30], [90, 30], [120, 30], [121, 60],
                               [120, 90], [90, 90], [60, 90], [30, 90]]), eps: 0 },
  // Sub-integer wobble under the tolerance — dropped — and one point above it.
  { name: 'wobble', d: path0([[30, 30], [50, 30.2], [70, 29.8], [90, 30.3], [110, 34], [130, 30]]), eps: 0 },
  // The byte range's ends, and the rounding at the half.
  { name: 'edges', d: path0([[0, 0], [255, 0], [255, 255], [0, 255], [127.5, 128.5], [0.4, 254.6]]), eps: 0 },
  // A tighter tolerance keeps more of the same curve.
  { name: 'fine-eps', d: path0([[30, 30], [50, 30.2], [70, 29.8], [90, 30.3], [110, 34], [130, 30]]), eps: 0.05 },
  // ...and a loose one keeps almost none of it.
  { name: 'coarse-eps', d: path0(Array.from({ length: 30 },
      (_, i) => [30 + i * 6, 128 + Math.round(Math.sin(i) * 100) / 10])), eps: 8 }
];

export function buildCorpus() {
  const lines = [];
  lines.push(canonicalStringify({
    kind: 'schematic', tracks: TRACK_LIST.length, codec: CODEC_CASES.length,
    view: 256, pad: 30, eps: SCHEMATIC_EPS
  }));

  // One line per shipped track: the baked schematic (the JS oracle) and the
  // packed bytes the room snapshot carries.
  for (const t of TRACK_LIST) {
    const s = TRACK_SCHEMATICS[t.id];
    lines.push(canonicalStringify({
      case: 'track', id: t.id, schematic: s,
      packed: packSchematic(s), unpacked: unpackSchematic(packSchematic(s))
    }));
  }

  // Codec-only cases, carrying their own path.
  for (const c of CODEC_CASES) {
    const packed = packSchematic({ d: c.d }, c.eps || SCHEMATIC_EPS);
    lines.push(canonicalStringify({
      case: 'codec', name: c.name, d: c.d, eps: c.eps || 0,
      packed, unpacked: unpackSchematic(packed)
    }));
  }

  return { text: lines.join('\n') + '\n', tracks: TRACK_LIST.length, codec: CODEC_CASES.length };
}

// A belt-and-braces guard on the claim this corpus rests on: the committed
// schematics ARE what the live trackSchematic() produces. tests/track.test.js
// asserts the same thing against freshly built geometry; this is the cheap
// version, run whenever the corpus is regenerated.
export async function verifyBakedSchematics() {
  const { init, buildTrack } = await import('./native-track.mjs');
  await init();
  for (const t of TRACK_LIST) {
    const fresh = canonicalStringify(trackSchematic(buildTrack(t)));
    if (fresh !== canonicalStringify(TRACK_SCHEMATICS[t.id])) {
      throw new Error(`shared/trackSchematics.js is stale for "${t.id}" — `
        + 'run: node scripts/gen-track-schematics.js');
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await verifyBakedSchematics();
  const { text, tracks, codec } = buildCorpus();
  // No process.exit after a pipe write: it is asynchronous, and exiting before
  // it drains truncates the output — which reads as a stale corpus rather than
  // as the bug it is.
  if (process.argv.includes('--stdout')) {
    process.stdout.write(text);
  } else if (process.argv.includes('--check')) {
    if (fs.readFileSync(OUT, 'utf8') !== text) {
      console.error('schematic-corpus.jsonl is stale');
      process.exitCode = 1;
    } else {
      console.log('schematic-corpus.jsonl is current');
    }
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${OUT}: ${tracks} tracks + ${codec} codec cases`);
  }
}
