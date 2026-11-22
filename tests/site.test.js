'use strict';
// The deployed hosts' Apache (public/.htaccess) and the dev server route room
// codes by the same rule, which .htaccess has to spell out as a rewrite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const site = require('../server/site.js');

const HTACCESS = fs.readFileSync(path.join(__dirname, '..', 'public', '.htaccess'), 'utf8');

test('.htaccess routes room codes like server/site.js', () => {
  const m = /^RewriteCond \$1 !\^\(([^)]+)\)\$ \[NC\]\nRewriteRule \^\((\S+)\)\/\?\$ controller\/index\.html \[END\]$/m.exec(HTACCESS);
  assert.ok(m, 'the room-code rewrite in public/.htaccess');
  assert.deepEqual(m[1].split('|').sort(), [...site.RESERVED_SEGMENTS].sort());
  assert.equal('^\\/(' + m[2] + ')\\/?$', site.ROOM_CODE.source);
});
