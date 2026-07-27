'use strict';
// The design tokens as data (public/shared/design-tokens.json), and the two
// things that make that file worth having.
//
// FIDELITY. The JSON is baked from theme.css by scripts/gen-design-tokens.mjs,
// and tests/codegen-freshness.test.js re-runs that generator and byte-compares —
// which catches a STALE bake but not a WRONG one: a parser that silently drops a
// declaration produces a stable, permanently green, permanently incomplete file.
// So the first test re-extracts the :root block with a deliberately dumb regex
// that shares no code with the generator, and demands the same tokens, in the
// same order, with the same authored values. Two implementations, one answer —
// the same trick the corpora use against the C++ twins.
//
// RULES. Once the tokens are data, two design rules that theme.css can only
// state in prose become checkable, and both are rules this project has already
// broken once: the button ledge geometry (--btn-sink MUST stay under
// --btn-drop) and the four-colour chrome veto (yellow/amber and pink are
// liveries, never chrome). That is the part of "tokens as data" that pays off
// today rather than when a TV shell exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public/shared/theme.css'), 'utf8');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/shared/design-tokens.json'), 'utf8'));

// The independent scrape: cut the :root block, strip every comment, take every
// `--name: value;`. No group tracking, no typing, no alias resolution — just the
// declarations, which is the only thing the two implementations must agree on.
function scrapeRoot() {
  const open = CSS.indexOf(':root {');
  const body = CSS.slice(open + ':root {'.length);
  const block = body.slice(0, body.indexOf('\n}')).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)]
    .map((m) => ({ name: m[1].slice(2), value: m[2].replace(/\s+/g, ' ').trim() }));
}

const byName = new Map(DATA.tokens.map((t) => [t.name, t]));

test('the token data is every :root declaration, in order, with the authored value', () => {
  const scraped = scrapeRoot();
  assert.ok(scraped.length > 0, 'the dumb scrape found declarations at all');
  assert.deepEqual(
    DATA.tokens.map((t) => ({ name: t.name, value: t.value })),
    scraped,
    'design-tokens.json disagrees with an independent scrape of theme.css :root — '
    + 'a token was dropped, renamed, reordered or re-valued by the generator',
  );
  assert.equal(DATA.count, scraped.length, 'the declared count is the real count');
});

test('every token is grouped, typed, and resolves to a literal', () => {
  for (const t of DATA.tokens) {
    assert.ok(t.group, `--${t.name} has no group`);
    assert.ok(t.type, `--${t.name} has no type`);
    assert.ok(!/var\(/.test(t.resolved),
      `--${t.name} resolves to ${t.resolved}, which still contains a var() — an alias was not followed`);
    if (t.alias) assert.ok(byName.has(t.alias), `--${t.name} aliases unknown --${t.alias}`);
    if (t.type === 'color') {
      assert.equal(t.rgba.length, 4, `--${t.name} has no rgba`);
      assert.ok(t.rgba.slice(0, 3).every((c) => Number.isInteger(c) && c >= 0 && c <= 255),
        `--${t.name} rgba channels out of range: ${JSON.stringify(t.rgba)}`);
      assert.ok(t.rgba[3] >= 0 && t.rgba[3] <= 1, `--${t.name} alpha out of range`);
    }
    if (t.type === 'shadow') {
      assert.equal(t.shadow.blur, 0,
        `--${t.name} has a blurred shadow — the sticker language is hard, ZERO-blur offsets`);
      assert.ok(t.shadow.rgba, `--${t.name} shadow colour did not resolve`);
    }
  }
  // Every group's token list must be the tokens that actually claim it.
  for (const g of DATA.groups) {
    assert.deepEqual(g.tokens, DATA.tokens.filter((t) => t.group === g.label).map((t) => t.name),
      `group "${g.label}" lists tokens that disagree with the tokens' own group field`);
  }
});

// theme.css states this as a MUST in prose; the data lets it be a test.
test('the button ledge cannot be pressed through itself', () => {
  const drop = byName.get('btn-drop');
  const sink = byName.get('btn-sink');
  assert.ok(drop && sink, 'the ledge tokens exist');
  assert.ok(sink.px < drop.px,
    `--btn-sink (${sink.px}px) must stay under --btn-drop (${drop.px}px): press travel equal to `
    + 'the drop punches the button through its own ledge and flattens it');
});

// CLAUDE.md's hard veto: chrome is red/green/blue/purple ONLY. amber/pink (and
// orange/cyan) exist as car liveries and nowhere else. The role tokens are the
// place that veto gets broken — --accent was amber once.
test('chrome roles resolve to chrome colours only', () => {
  const chrome = new Set(['paper', 'ink', 'red', 'green', 'blue', 'purple']
    .map((n) => byName.get(n).resolved.toLowerCase()));
  const roles = DATA.tokens.filter((t) => /^(semantic roles|connection quality)/.test(t.group || ''));
  assert.ok(roles.length >= 8, 'found the role tokens');
  for (const t of roles) {
    assert.ok(chrome.has(t.resolved.toLowerCase()),
      `--${t.name} resolves to ${t.resolved}, which is not one of the four chrome colours `
      + '(+ paper/ink) — yellow/amber and pink are liveries, never chrome');
  }
});
