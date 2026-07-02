'use strict';
// Portable-purity gate: the sim engine (public/display/engine/*) and the kit's
// RoomFlow are CLOCK-FREE and host-agnostic — no wall clock, no global RNG, no
// DOM, no timers. They must load and behave identically in the browser and the
// Node tests, and stay deterministic (seeded PRNG streams; all timing injected
// as dt/nowMs by the host). Nothing else fails fast on a stray Date.now() in
// these files — a race would just quietly stop being reproducible — so this
// scan is the enforcement the modules' comments promise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE_DIR = path.join(__dirname, '../public/display/engine');
const FILES = [
  ...fs.readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(ENGINE_DIR, f)),
  path.join(__dirname, '../partyplug/RoomFlow.js')
];

// API-shaped patterns (call sites / property reads, not bare words). Scanned on
// comment-stripped source, so neither prose in comments nor these belt-and-braces
// shapes can false-positive on documentation.
const BANNED = [
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date', /\bnew\s+Date\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['performance.*', /\bperformance\s*\./],
  ['window.*', /\bwindow\s*\./],
  ['document.*', /\bdocument\s*\./],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['setInterval', /\bsetInterval\s*\(/],
  ['requestAnimationFrame', /\brequestAnimationFrame\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['fetch(', /\bfetch\s*\(/]
];

// Blank out comments but keep every newline, so violation line numbers stay true.
// Tiny scanner instead of a regex: string literals may contain `//` (URLs) and
// comment markers may sit inside template strings.
function stripComments(src) {
  let out = '';
  let mode = null; // null | '"' | "'" | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = '//'; out += '  '; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; out += '  '; i++; continue; }
      if (c === '"' || c === "'" || c === '`') mode = c;
      out += c;
    } else if (mode === '//') {
      if (c === '\n') { mode = null; out += c; } else out += ' ';
    } else if (mode === '/*') {
      if (c === '*' && n === '/') { mode = null; out += '  '; i++; }
      else out += c === '\n' ? c : ' ';
    } else { // inside a string
      if (c === '\\') { out += c + (n || ''); i++; continue; }
      if (c === mode) mode = null;
      out += c;
    }
  }
  return out;
}

test('engine modules and RoomFlow stay clock-free and host-agnostic', () => {
  assert.ok(FILES.length >= 3, `expected engine files + RoomFlow, found ${FILES.length} (moved?)`);
  const violations = [];
  for (const file of FILES) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of BANNED) {
        if (re.test(line)) violations.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1} uses ${name}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'purity violations (inject time/RNG from the host instead):\n  ' + violations.join('\n  '));
});
