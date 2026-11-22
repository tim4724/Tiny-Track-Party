'use strict';

// Tiny Track Party's LOCAL host, for dev and the E2E suite. Every deployed host
// is static instead: Apache serving site/ (scripts/build-site.mjs) with
// public/.htaccess, whose routes this mirrors and whose CSP it reads.
// Whatever both must agree on lives in server/site.js. No game logic and no
// WebSocket here either way: realtime multiplayer runs off-box through the
// Party-Server relay (wss://ws.paperballoon.games) plus the optional WebRTC
// fastlane. See public/shared/protocol.js for the relay config.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const site = require('./site.js');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// partyplug (the transport kit) lives OUTSIDE public/ as a clearly-separate
// vendored dependency, served via the remap below. Restricted to .js so
// package artifacts / binaries can't be walked.
const PARTYPLUG_DIR = path.join(__dirname, '..', 'partyplug');
// The Kenney kits the game's models are PICKED FROM, and candidates for more,
// for the asset gallery's kit browser. `npm run fetch:kits` fills this (a
// gitignored cache, never deployed), which is why the route below is allowed
// to 404 — the gallery reads that as "not fetched" and says so.
const KITS_DIR = path.join(__dirname, '..', '.cache', 'kenney-kits');

// The working tree's HEAD, for the version label ('' without git).
function detectLocalSha() {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 })
      .toString().trim();
  } catch (_) { return ''; }
}
const GIT_SHA = String(process.env.GIT_SHA || '').trim() || detectLocalSha();

// Relay override (dev/E2E): RELAY_URL=ws://… points every served page at a
// local relay — injected into each HTML's <meta name="relay-url"> (read by
// shared/protocol.js) and added verbatim to connect-src. Operator-set env
// only; there is no client-side override.
const RELAY_URL_OVERRIDE = String(process.env.RELAY_URL || '').trim();

// The deployed CSP, read from the one place it is written, and the edit
// .htaccess makes for the two pages the galleries frame. RELAY_URL widens
// connect-src to exactly the configured relay, in its http(s) form too for the
// controller's room check: a ws: source doesn't cover http:.
const DEPLOYED_CSP = /^Header always set Content-Security-Policy "([^"]+)"$/m
  .exec(fs.readFileSync(path.join(PUBLIC_DIR, '.htaccess'), 'utf8'))[1];
const CSP = RELAY_URL_OVERRIDE
  ? DEPLOYED_CSP.replace(/connect-src [^;]*/, (src) => src + ' ' + RELAY_URL_OVERRIDE + ' ' + RELAY_URL_OVERRIDE.replace(/^ws/, 'http'))
  : DEPLOYED_CSP;
const FRAMEABLE_CSP = CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',       // engine/native/ttp_runtime.mjs (ES module, strict MIME)
  // ttp_runtime.wasm — the engine (sim + party + renderer). The correct MIME is
  // what enables WebAssembly.instantiateStreaming.
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  // 3D assets — glTF binary. The Kenney GLBs are self-contained (no .gltf/.bin
  // companions are served); without this they'd fall back to octet-stream.
  '.glb': 'model/gltf-binary',
  // Audio. The race itself is asset-free Web Audio synthesis, but the sound
  // gallery / SFX-audition surfaces load clips for comparison.
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  // The welcome board's trailer (scripts/trailer/web.js); ranged like the audio.
  '.mp4': 'video/mp4',
  // Compiled Filament materials, shipped beside the engine wasm.
  '.filamat': 'application/octet-stream',
  // License notices, linked from /licenses.html. Without these they'd fall back
  // to octet-stream and DOWNLOAD instead of opening — a license text nobody can
  // read in place is not a notice.
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Brotli for the text-ish types plus the engine wasm, which is the whole cold
// load (3.5 MB raw, ~3x smaller compressed). Compressed once per file content
// and kept; the Buffer.equals check makes the cache safe against on-disk edits
// without a stat, and quality 5 keeps the one-time cost tens of ms rather than
// the seconds quality 11 would take on the wasm. The GLBs and the Filament
// materials are binary but NOT compressed formats (vertex buffers, shader
// blobs): they shrink 4-5x, and every boot fetches dozens of them. Media types
// stay raw — they are already compressed formats, and they're the ones that
// get range requests.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.md', '.glb', '.filamat']);
const brotliCache = new Map(); // filePath -> { src, encoded }
function brotliFor(filePath, data) {
  const hit = brotliCache.get(filePath);
  if (hit && hit.src.equals(data)) return hit.encoded;
  const encoded = zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
    }
  });
  brotliCache.set(filePath, { src: data, encoded });
  return encoded;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // --- JSON endpoints ---
  if (Object.hasOwn(site.JSON_ROUTES, urlPath) && req.method === 'GET') {
    sendJson(res, 200, site.JSON_ROUTES[urlPath]());
    return;
  }
  // Dev only: the LAN address phones can reach, for join links and QR codes.
  // Deployed pages use their own origin (Net.js asks only on localhost).
  if (urlPath === '/api/baseurl') {
    sendJson(res, 200, { baseUrl: process.env.BASE_URL || `http://${getLocalIP()}:${PORT}` });
    return;
  }

  // --- route remaps (public/.htaccess has the same) ---
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (urlPath === '/health') {
    urlPath = '/health.txt';
  } else if (urlPath === '/licenses' || urlPath === '/licenses/') {
    // The footer links /licenses.html, but the bare word is what anyone types.
    // It is a reserved word (server/site.js), so without this it would 404
    // rather than be mistaken for a join code.
    urlPath = '/licenses.html';
  } else if (site.isRoomCode(urlPath)) {
    // Bare join code (e.g. /ABCD) -> phone controller. Reserved/non-code paths
    // fall through to the static handler (and 404 if there's no such file).
    urlPath = '/controller/index.html';
  }

  let baseDir = PUBLIC_DIR;
  let lookupPath = urlPath;
  if (urlPath.startsWith('/partyplug/')) {
    if (!/^\/[\w.-]+\.js$/.test(urlPath.slice('/partyplug'.length))) { res.writeHead(404); res.end('Not Found'); return; }
    baseDir = PARTYPLUG_DIR;
    lookupPath = urlPath.slice('/partyplug'.length);
  } else if (urlPath.startsWith('/kits/')) {
    // The kit cache, for /gallery-assets.html's kit browser: its manifest, one
    // preview render per model, and the models themselves — the browser stages a
    // candidate on the showroom grid by handing the renderer its bytes.
    //
    // Reachable here is not the same as shipped: a kit model ENTERS the game by
    // being copied into public/assets/toycar and recorded in its SOURCES.json.
    // Nothing may load one of these at play time, because this cache exists on
    // one laptop and on no deployed host.
    const rest = urlPath.slice('/kits'.length);
    if (!/^\/(index|shortlist)\.json$/.test(rest)
        && !/^\/[\w-]+\/previews\/[\w.-]+\.png$/.test(rest)
        && !/^\/[\w-]+\/models\/[\w.-]+\.glb$/.test(rest)) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    baseDir = KITS_DIR;
    lookupPath = rest;
  }

  let filePath = path.join(baseDir, lookupPath);
  // Directory-traversal guard. The trailing separator is load-bearing.
  if (!filePath.startsWith(baseDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

  // A kit the game has not shipped from yet keeps its palette in the kit cache
  // (`npm run fetch:kits`), under the name its staged models reference — so the
  // kit browser draws them coloured. Dev only: no deployed host has the cache.
  if (/^\/assets\/toycar\/Textures\/[\w-]+\.png$/.test(urlPath)
      && !fs.existsSync(filePath)) {
    filePath = path.join(KITS_DIR, 'textures', path.basename(urlPath));
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }

    const ext = path.extname(filePath).toLowerCase();
    // The App Clip's app-site-association has no extension; Apple's CDN only
    // accepts it as application/json.
    const contentType = path.basename(filePath) === 'apple-app-site-association'
      ? 'application/json' : MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    if (ext === '.html') {
      data = Buffer.from(site.renderHtml(data.toString('utf8'), { sha: GIT_SHA, relayUrl: RELAY_URL_OVERRIDE }));
      const frameable = urlPath === '/display/index.html' || urlPath === '/controller/index.html';
      headers['Content-Security-Policy'] = frameable ? FRAMEABLE_CSP : CSP;
    }

    // Nothing is stored while developing. The deployed caching, and why code
    // must be no-store rather than no-cache, is in public/.htaccess.
    headers['Cache-Control'] = 'no-store';

    // Byte-range support — media elements need 206 responses to compute a
    // track's duration and to scrub (a streamed Ogg over a plain 200 reports
    // duration = Infinity and can't seek). data is already fully buffered, so
    // a range is just a slice. HTML is templated per-request, so never ranged.
    const total = data.length;
    headers['Accept-Ranges'] = 'bytes';
    const rangeHeader = ext !== '.html' && req.headers.range;
    const m = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : total - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : total - 1;
      start = Math.max(0, start);
      end = Math.min(end, total - 1);
      if (start > end) { // unsatisfiable
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      res.end(data.subarray(start, end + 1));
      return;
    }

    if (COMPRESSIBLE.has(ext)) {
      headers['Vary'] = 'Accept-Encoding';
      if (data.length > 1024 && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
        data = brotliFor(filePath, data);
        headers['Content-Encoding'] = 'br';
      }
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`Tiny Track Party server on http://localhost:${PORT}`);
  console.log(`Local network:        http://${localIP}:${PORT}`);
  console.log(`Display:              http://localhost:${PORT}/`);
  console.log(`(Phones need HTTPS for tilt sensors — front this with a tunnel/cert.)`);
});
