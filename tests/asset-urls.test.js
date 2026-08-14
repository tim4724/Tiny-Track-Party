'use strict';
// Asset references must not assume the site is served from a domain root.
//
// A '/assets/…' literal in JS or CSS resolves against the DOCUMENT root, so it
// only works where the game IS the root of its host. That is true of the web
// and of every preview deploy, which is why the class survived this long
// unnoticed: nothing anyone tests by hand ever exercises a subpath. Anything
// that hosts the tree under a prefix (a packaged upload, an embedding webview)
// 404s on every one of them at once — fonts, materials, GLBs, music, car
// thumbs, item icons.
//
// New asset references go through assetUrl() in JS (it resolves against the
// MODULE's location, giving identical URLs on the web) or a file-relative
// url() in CSS. This gate keeps the class dead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

test('shipped JS/CSS builds no root-absolute asset URLs', () => {
  const ROOTS = ['shared', 'display', 'controller'];
  // musicCatalogue.js is exempt whole: its '/assets/…' strings are canonical
  // data mirrored bit-for-bit in the C++ table (audio-abi pins them equal), so
  // they cannot move here alone. Audio.js resolves them at the device edge.
  // assetUrl.js is exempt because its own doc comment quotes the pattern.
  const EXEMPT = new Set(['musicCatalogue.js', 'assetUrl.js']);
  // A quoted literal starting '/assets/' etc., unless it is assetUrl()'s own
  // argument (the sanctioned resolver, so its callers read naturally), plus CSS
  // url(/…). Quote-anchored so prose in comments doesn't trip it.
  const JS_RE = /(?<!assetUrl\()['"`]\/(?:assets|display|controller|shared|partyplug)\//g;
  const CSS_RE = /url\(\s*['"]?\/(?!\/)/g;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|css)$/.test(e.name) || EXEMPT.has(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.match(e.name.endsWith('.css') ? CSS_RE : JS_RE) || []) {
        offenders.push(`${path.relative(PUBLIC, p)}: ${m}`);
      }
    }
  };
  for (const rel of ROOTS) walk(path.join(PUBLIC, rel));
  assert.deepEqual(offenders, [],
    'root-absolute URL literals would 404 under any subpath — route them through shared/assetUrl.js');
});
