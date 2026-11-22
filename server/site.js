'use strict';

// What the hosts serve beyond public/'s files as they are: the HTML templates'
// substitutions, the JSON routes and which paths are room codes.
// server/index.js (local dev, E2E) answers them per request;
// scripts/build-site.mjs bakes them into site/, which every deployed host
// serves through Apache with public/.htaccess. That file mirrors the room-code
// rule below (tests/site.test.js holds the two together).

const fs = require('fs');
const path = require('path');

const APP_VERSION = require('../package.json').version;
const TRAILER_SHOTS = require('../scripts/trailer/shots.js');

// sha: the commit being served, '' when unknown. relayUrl: the dev/E2E relay
// override (see public/shared/protocol.js), '' on every deploy.
function renderHtml(text, { sha, relayUrl }) {
  const short = sha ? sha.slice(0, 7) : '';
  const label = APP_VERSION + (short ? ' (#' + short + ')' : '');
  return text.replace(/__APP_VERSION__/g, label)
    // The welcome board's build badge; `.version-badge:empty` hides it.
    .replace(/__VERSION_BADGE__/g, label)
    .replace(/__APP_V__/g, APP_VERSION)
    // /gallery-shots.html compares it with the SHA each frozen screenshot was
    // taken at: a gallery of silently stale captures reads as evidence while
    // being a photograph of a build nobody is running.
    .replace(/__GIT_SHA__/g, short)
    .replace(/__RELAY_URL__/g, relayUrl);
}

// Deployed as api/<name>.json, which .htaccess serves at /api/<name>.
const JSON_ROUTES = {
  // The kit's GLBs, so the asset gallery (/gallery-assets.html) can show what
  // sits in the folder that nothing draws, instead of trusting a checked-in list.
  '/api/assets': () => ({
    assets: fs.readdirSync(path.join(__dirname, '..', 'public', 'assets', 'toycar'))
      .filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)).sort()
  }),
  // The trailer's committed shot list, so /trailer.html can start from the
  // checked-in cut instead of the browser's localStorage.
  '/api/trailer-shots': () => ({ shots: TRAILER_SHOTS })
};

// A bare `/<segment>` (no dot, one segment) is a join code and serves the phone
// controller. Route prefixes and the usual crawler/legal words are not codes,
// so they 404 instead of opening a controller for a room that cannot exist.
const RESERVED_SEGMENTS = [
  'display', 'controller', 'shared', 'bundle', 'assets', 'partyplug', 'gallery',
  'trailer', 'kits',
  'api', 'health', 'privacy', 'about', 'terms', 'robots', 'sitemap', 'favicon',
  'licenses', 'licences', 'credits', 'imprint', 'legal'
];
const ROOM_CODE = /^\/([A-Za-z0-9_-]{1,24})\/?$/;
function isRoomCode(urlPath) {
  const m = ROOM_CODE.exec(urlPath);
  return !!m && !RESERVED_SEGMENTS.includes(m[1].toLowerCase());
}

module.exports = { renderHtml, JSON_ROUTES, RESERVED_SEGMENTS, ROOM_CODE, isRoomCode };
