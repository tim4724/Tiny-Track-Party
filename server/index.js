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
const site = require('./site.js');

const PORT = parseInt(process.env.PORT, 10) || 4000;
// SERVE_SITE=1 serves site/ instead, the tree scripts/build-site.mjs made and
// the deployed hosts serve: the E2E suite runs against that, so against the
// bundles players get (playwright.config.js builds it first).
const SERVE_SITE = !!process.env.SERVE_SITE;
const PUBLIC_DIR = path.join(__dirname, '..', SERVE_SITE ? 'site' : 'public');
const REVIEW_DIR = path.join(__dirname, '..', 'scratch', 'review');
const REVIEW_NOTE_MAX = 48 * 1024 * 1024;
// partyplug (the transport kit) lives OUTSIDE public/ as a clearly-separate
// vendored dependency, served via the remap below (site/ carries its own
// copy). Restricted to .js so package artifacts / binaries can't be walked.
const PARTYPLUG_DIR = path.join(__dirname, '..', 'partyplug');

// The working tree's HEAD, for the version label ('' without git).
function detectLocalSha() {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 })
      .toString().trim();
  } catch (_) { return ''; }
}
const GIT_SHA = detectLocalSha();

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
  // 3D assets — glTF binary. The GLBs are self-contained (no .gltf/.bin
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

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Local HTTPS: phones only expose tilt sensors in a secure context.
// TLS_KEY / TLS_CERT point at a PEM pair (e.g. a self-signed LAN cert).
const TLS = process.env.TLS_KEY && process.env.TLS_CERT
  ? { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }
  : null;
const SCHEME = TLS ? 'https' : 'http';

const server = (TLS ? require('https').createServer.bind(null, TLS) : http.createServer)((req, res) => {
  let urlPath = req.url.split('?')[0];

  // --- JSON endpoints ---
  if (Object.hasOwn(site.JSON_ROUTES, urlPath) && req.method === 'GET') {
    sendJson(res, 200, site.JSON_ROUTES[urlPath]());
    return;
  }
  // Dev only: the LAN address phones can reach, for join links and QR codes.
  // Deployed pages use their own origin (Net.js asks only on localhost).
  if (urlPath === '/api/baseurl') {
    sendJson(res, 200, { baseUrl: process.env.BASE_URL || `${SCHEME}://${getLocalIP()}:${PORT}` });
    return;
  }

  // REVIEW, for /gallery-landmarks.html: notes taken on the stage, and a round
  // of items set up to be judged there with the verdicts given on it; and for
  // /gallery-music.html, the song picked for each track. It reads
  // and writes the checkout's scratch/review/ (gitignored), so it exists only on
  // this local host (no deployed host has it) and answers only this machine.
  if (urlPath.startsWith('/api/review-')) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'review is kept on a local dev server only' });
      return;
    }
    const readJson = (max, use) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        try { use(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { sendJson(res, 400, { error: String((e && e.message) || e) }); }
      });
    };
    // A NOTE: a picture of the stage, what the viewer wrote on it and where in
    // the lap it was taken, for whoever works the note off.
    if (urlPath === '/api/review-note' && req.method === 'POST') {
      readJson(REVIEW_NOTE_MAX, ({ meta, note, pins, png, marked }) => {
        const track = String((meta && meta.track) || 'track').replace(/[^a-z0-9-]/gi, '');
        const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${track}`;
        const image = (url, type) => Buffer.from(String(url).replace(new RegExp(`^data:image/${type};base64,`), ''), 'base64');
        fs.mkdirSync(REVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(REVIEW_DIR, `${id}.png`), image(png, 'png'));
        if (marked) fs.writeFileSync(path.join(REVIEW_DIR, `${id}-pins.jpg`), image(marked, 'jpeg'));
        fs.writeFileSync(path.join(REVIEW_DIR, `${id}.json`), JSON.stringify({ id, note, pins, meta }, null, 2) + '\n');
        sendJson(res, 200, { id, dir: path.relative(path.join(__dirname, '..'), REVIEW_DIR) });
      });
      return;
    }
    // A ROUND: round.json, written by whoever sets the round up (its shape is
    // scripts/review-round.example.json), answered with the verdicts given on
    // it so far. No round file is a 404, and the gallery shows no panel.
    const roundFile = path.join(REVIEW_DIR, 'round.json');
    const readRound = () => (fs.existsSync(roundFile) ? JSON.parse(fs.readFileSync(roundFile, 'utf8')) : null);
    const verdictsFile = (round) => path.join(REVIEW_DIR, `verdicts-${String(round).replace(/[^\w-]/g, '')}.json`);
    const readVerdicts = (round) => (fs.existsSync(verdictsFile(round)) ? JSON.parse(fs.readFileSync(verdictsFile(round), 'utf8')) : {});
    if (urlPath === '/api/review-round' && req.method === 'GET') {
      try {
        const round = readRound();
        if (!round) sendJson(res, 404, { error: 'no review round in scratch/review/' });
        else sendJson(res, 200, { ...round, verdicts: readVerdicts(round.round) });
      } catch (e) {
        sendJson(res, 500, { error: `scratch/review: ${(e && e.message) || e}` });
      }
      return;
    }
    // A VERDICT on one item of the current round: that item's one entry in
    // verdicts-<round>.json, { decision, note, answers, at, title }, a later
    // verdict replacing it. `answers` follow the item's `ask` in order; an
    // item that only asks (an idea, a question) may be answered with no
    // decision.
    if (urlPath === '/api/review-verdict' && req.method === 'POST') {
      readJson(64 * 1024, ({ round, id, decision, note, answers }) => {
        const current = readRound();
        const item = current && current.round === round && (current.items || []).find((it) => it.id === id);
        if (!item) { sendJson(res, 400, { error: `'${id}' is not an item of the current round` }); return; }
        if (decision != null && !['keep', 'rework', 'drop'].includes(decision)) { sendJson(res, 400, { error: 'a decision is keep, rework or drop' }); return; }
        const said = Array.isArray(answers) ? answers.map((a) => String(a || '').trim()) : [];
        if (decision == null && !said.some(Boolean) && !String(note || '').trim()) { sendJson(res, 400, { error: 'nothing to save' }); return; }
        const verdicts = readVerdicts(round);
        verdicts[id] = { decision: decision || null, note: String(note || '').trim(), answers: said,
                         at: new Date().toISOString(), title: item.title || id };
        fs.writeFileSync(verdictsFile(round), JSON.stringify(verdicts, null, 2) + '\n');
        sendJson(res, 200, { verdict: verdicts[id], file: path.relative(path.join(__dirname, '..'), verdictsFile(round)) });
      });
      return;
    }
    // MUSIC PICKS, for /gallery-music.html: the song chosen for each track and
    // a note on it, in music-picks.json as { <track>: { song, at, note } }. A
    // post names one track and touches only that entry: `song` a file under
    // /assets/audio/music/ (null clears it, absent keeps it), `note` likewise.
    const picksFile = path.join(REVIEW_DIR, 'music-picks.json');
    const readPicks = () => (fs.existsSync(picksFile) ? JSON.parse(fs.readFileSync(picksFile, 'utf8')) : {});
    if (urlPath === '/api/review-music' && req.method === 'GET') {
      try {
        sendJson(res, 200, readPicks());
      } catch (e) {
        sendJson(res, 500, { error: `scratch/review: ${(e && e.message) || e}` });
      }
      return;
    }
    if (urlPath === '/api/review-music' && req.method === 'POST') {
      readJson(64 * 1024, ({ track, song, note, rain }) => {
        if (!/^[a-z0-9-]{1,40}$/.test(String(track))) { sendJson(res, 400, { error: 'a track is a catalogue track id' }); return; }
        if (song != null && !/^(candidates\/)?[\w-]+(\.[\w-]+)*\.mp3$/.test(String(song))) {
          sendJson(res, 400, { error: 'a song is a file under /assets/audio/music/' });
          return;
        }
        const picks = readPicks();
        const was = picks[track] || {};
        const entry = { song: song === undefined ? (was.song || null) : song, at: new Date().toISOString() };
        const said = String(note === undefined ? (was.note || '') : (note || '')).trim().slice(0, 4000);
        if (said) entry.note = said;
        // The rain knob's level, as a share of the game's (a rain track only).
        const wet = rain === undefined ? was.rain : rain;
        if (Number.isFinite(wet) && wet >= 0 && wet <= 2) entry.rain = Math.round(wet * 100) / 100;
        if (entry.song || entry.note || entry.rain != null) picks[track] = entry;
        else delete picks[track];
        fs.mkdirSync(REVIEW_DIR, { recursive: true });
        fs.writeFileSync(picksFile, JSON.stringify(picks, null, 2) + '\n');
        sendJson(res, 200, { pick: picks[track] || null, file: path.relative(path.join(__dirname, '..'), picksFile) });
      });
      return;
    }
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
  if (!SERVE_SITE && urlPath.startsWith('/partyplug/')) {
    if (!/^\/[\w.-]+\.js$/.test(urlPath.slice('/partyplug'.length))) { res.writeHead(404); res.end('Not Found'); return; }
    baseDir = PARTYPLUG_DIR;
    lookupPath = urlPath.slice('/partyplug'.length);
  }

  const filePath = path.join(baseDir, lookupPath);
  // Directory-traversal guard. The trailing separator is load-bearing.
  if (!filePath.startsWith(baseDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

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

    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`Tiny Track Party server on ${SCHEME}://localhost:${PORT}`);
  console.log(`Local network:        ${SCHEME}://${localIP}:${PORT}`);
  console.log(`Display:              ${SCHEME}://localhost:${PORT}/`);
  if (!TLS) console.log(`(Phones need HTTPS for tilt sensors — set TLS_KEY / TLS_CERT or front this with a tunnel.)`);
});
