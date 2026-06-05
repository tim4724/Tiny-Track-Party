'use strict';

// Tiny Track Party static host. Like HexStacker, this server runs NO game logic and NO
// WebSocket: it serves static files + a few JSON endpoints. Realtime multiplayer
// runs off-box through the Party-Server relay (wss://ws.couch-games.com) plus the
// optional WebRTC fastlane. The display browser is authoritative; phones are
// thin controllers. See public/shared/protocol.js for the relay config.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// partyplug (transport kit) and vendor (Three.js) live OUTSIDE public/ as
// clearly-separate vendored dependencies, served via the remaps below. Both are
// restricted to .js so package artifacts / binaries can't be walked.
const PARTYPLUG_DIR = path.join(__dirname, '..', 'partyplug');
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const APP_VERSION = require('../package.json').version;
const APP_ENV = String(process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')).toLowerCase();
const GIT_SHA = String(process.env.GIT_SHA || '').trim();
const IS_PROD = APP_ENV === 'production';

function getShortSha(sha) { return sha ? sha.slice(0, 7) : null; }
const VERSION_LABEL = APP_VERSION + (!IS_PROD && getShortSha(GIT_SHA) ? ' (#' + getShortSha(GIT_SHA) + ')' : '');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
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
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  // 3D assets — glTF binary + companions. Without these, GLBs would fall back to
  // octet-stream (works) but .gltf/.wasm must be exact for the loader/streaming.
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function generateQRMatrix(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const size = qr.modules.size;
  const modules = Array.from(qr.modules.data);
  const quiet = 1;
  const padded = size + quiet * 2;
  const paddedModules = new Array(padded * padded).fill(0);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      paddedModules[(row + quiet) * padded + (col + quiet)] = modules[row * size + col];
    }
  }
  return { size: padded, modules: paddedModules };
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

// A bare `/<segment>` (no dot, one segment) is treated as a join code and serves
// the phone controller. Guard it so it's an intentional code, not a catch-all:
// real route prefixes, JSON endpoints, and common crawler/legal paths must NOT
// be mistaken for a room and must 404 instead of spinning up a controller.
const RESERVED_SEGMENTS = new Set([
  'display', 'controller', 'shared', 'assets', 'vendor', 'partyplug', 'gallery',
  'api', 'health', 'privacy', 'about', 'terms', 'robots', 'sitemap', 'favicon'
]);
function isRoomCode(urlPath) {
  const segs = urlPath.split('/').filter(Boolean);
  if (segs.length !== 1) return false;            // exactly one path segment
  const seg = segs[0];
  // Room codes are short and dot-free; reserved words/routes are not codes.
  return /^[A-Za-z0-9_-]{1,24}$/.test(seg) && !RESERVED_SEGMENTS.has(seg.toLowerCase());
}

// Content-Security-Policy. Vendoring Three.js keeps script-src/connect-src at
// 'self'. The ONE relaxation the no-build stack needs: the inline <script
// type="importmap"> is itself a script, so it must carry a per-response nonce.
// STUN (fastlane iceServers) is UDP and not governed by connect-src.
function cspHeader(nonce, frameAncestors) {
  return [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self' wss://ws.couch-games.com https://ws.couch-games.com",
    "img-src 'self' data:",
    "media-src 'self'",
    "object-src 'none'",
    "frame-src 'self'",
    "frame-ancestors " + frameAncestors
  ].join('; ');
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // --- JSON endpoints ---
  if (urlPath === '/api/qr' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const text = url.searchParams.get('text');
    if (!text || text.length > 2048) {
      sendJson(res, 400, { error: !text ? 'Missing text parameter' : 'Text too long' });
      return;
    }
    try { sendJson(res, 200, generateQRMatrix(text)); }
    catch (err) { sendJson(res, 500, { error: 'QR generation failed' }); }
    return;
  }
  if (urlPath === '/health') { sendJson(res, 200, { status: 'ok' }); return; }
  if (urlPath === '/api/version') {
    sendJson(res, 200, { version: APP_VERSION, env: APP_ENV, isProduction: IS_PROD, commit: getShortSha(GIT_SHA) });
    return;
  }
  if (urlPath === '/api/baseurl') {
    sendJson(res, 200, { baseUrl: process.env.BASE_URL || `http://${getLocalIP()}:${PORT}` });
    return;
  }

  // --- route remaps ---
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (isRoomCode(urlPath)) {
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
  } else if (urlPath.startsWith('/vendor/')) {
    // Three.js + addons. Only .js is browser-facing.
    if (!/\.js$/.test(urlPath)) { res.writeHead(404); res.end('Not Found'); return; }
    baseDir = VENDOR_DIR;
    lookupPath = urlPath.slice('/vendor'.length);
  }

  const filePath = path.join(baseDir, lookupPath);
  // Directory-traversal guard. The trailing separator is load-bearing.
  if (!filePath.startsWith(baseDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    if (ext === '.html') {
      const nonce = crypto.randomBytes(16).toString('base64');
      let text = data.toString('utf8');
      text = text.replace(/__APP_VERSION__/g, VERSION_LABEL)
                 .replace(/__APP_V__/g, APP_VERSION)
                 .replace(/__CSP_NONCE__/g, nonce);
      data = Buffer.from(text);
      const iframeable = urlPath === '/display/index.html' || urlPath === '/controller/index.html';
      headers['Content-Security-Policy'] = cspHeader(nonce, iframeable ? "'self'" : "'none'");
    }

    // HTML + JS always no-store (avoid stale-version mismatch). Other static
    // assets (CSS, images, fonts, GLBs) get a 24h cache in prod; bust with
    // ?v=__APP_V__ when they change.
    const noCache = !IS_PROD || ext === '.html' || ext === '.js';
    headers['Cache-Control'] = noCache ? 'no-store' : 'public, max-age=86400';

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
