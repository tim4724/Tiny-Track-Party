'use strict';

// The trailer the welcome board plays: the 4K master (cut.js) re-encoded for the web
// and committed under public/assets/trailer/, so the game's own server serves it.
//
//   npm run trailer        # render + cut → artwork/trailer/trailer.mp4
//   npm run trailer:web    # → public/assets/trailer/trailer.mp4, then commit it
//
// 1080p H.264 + AAC, the one pairing every browser and TV browser plays. faststart puts
// the index up front so playback starts before the download ends, and the server
// answers byte ranges, so seeking works. The size budget is held by
// tests/trailer-web.test.js: a recut is a new copy in git history and in the image's
// assets layer, which every deploy pulls.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MASTER = path.join(ROOT, 'artwork', 'trailer', 'trailer.mp4');
const OUT = path.join(ROOT, 'public', 'assets', 'trailer', 'trailer.mp4');

if (!fs.existsSync(MASTER)) throw new Error(`no master at ${path.relative(ROOT, MASTER)}: run npm run trailer first`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync('ffmpeg', [
  '-loglevel', 'error', '-y', '-i', MASTER,
  '-vf', 'scale=1920:1080:flags=lanczos',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p',
  // The master's colour tags (cut.js), carried over so the web copy is read the same way.
  '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv',
  '-c:a', 'aac', '-b:a', '160k',
  '-movflags', '+faststart', OUT,
], { stdio: 'inherit' });
console.log(`${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);
