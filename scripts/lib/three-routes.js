'use strict';
// Serve three.js to a Playwright page from node_modules, under the /vendor/three/
// paths the artwork capture scripts import.
//
// The GAME has no three.js — it renders with Filament in wasm — but one offline
// tool still wants a throwaway 3D scene in a browser: capture-car-thumbs.js,
// whose outputs are checked in. three is a devDependency for exactly that, so
// rather than shipping it on the server we intercept the two paths and answer
// them from node_modules.
//
// The pages these tools drive are same-origin on the dev server, whose CSP is
// script-src 'self' — a routed /vendor/… URL is 'self', so it loads, where an
// injected inline script or a CDN would not. Addon modules import three by BARE
// specifier ('three'), which needs an importmap the page no longer has, so the
// specifier is rewritten to the routed URL on the way through.
const fs = require('fs');
const path = require('path');

const THREE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'three');
const MODULE_URL = '/vendor/three/three.module.js';

function fileFor(urlPath) {
  if (urlPath.startsWith('/vendor/three/addons/')) {
    return path.join(THREE_DIR, 'examples', 'jsm', urlPath.slice('/vendor/three/addons/'.length));
  }
  return path.join(THREE_DIR, 'build', urlPath.slice('/vendor/three/'.length));
}

async function installThreeRoutes(page) {
  if (!fs.existsSync(THREE_DIR)) {
    throw new Error('three is not installed — run `npm install` (it is a devDependency, '
      + 'used only by capture-car-thumbs.js through these routes)');
  }
  await page.route('**/vendor/three/**', async (route) => {
    const file = fileFor(new URL(route.request().url()).pathname);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not Found' });
    const body = fs.readFileSync(file, 'utf8')
      .replace(/from\s+['"]three['"]/g, `from '${MODULE_URL}'`);
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
}

module.exports = { installThreeRoutes };
