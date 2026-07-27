// Generates public/shared/design-tokens.json — the Sticker Bash design tokens as
// machine-readable DATA, extracted from the ONE place they are authored:
// public/shared/theme.css's `:root` block.
//
// WHY THIS DIRECTION. architecture.md's mitigation for three implementations of
// the sticker look is "ship the design tokens as DATA so all three consume the
// same table the CSS does". The obvious reading is a JSON source with the CSS
// generated from it. That was deliberately inverted, for four reasons:
//
//   1. theme.css is not a token dump. Most declarations carry an inline
//      rationale, and three block comments state RULES rather than values
//      ("offset ~ 2x the border width, alpha always 0.18"; "--btn-sink MUST stay
//      under --btn-drop"). JSON has no comments, so generating the CSS either
//      loses that prose or smuggles it into note keys plus a formatter that has
//      to reproduce column alignment. Cost, no benefit.
//   2. It would make the file every UI change touches build OUTPUT, whose
//      failure mode for a hand edit is a confusing test failure. The brief's
//      constraint was "without making the web worse".
//   3. It proves "no rendered colour changed" for free: theme.css is byte
//      identical, so nothing CAN have moved. The other direction leaves a diff
//      you have to trust.
//   4. It is the direction this repo already runs everywhere — tracks.js ->
//      track_defs.h, protocol.js -> protocol-corpus, PartyConnection.js ->
//      framing-corpus. Author in the readable place, bake to the machine place,
//      drift-test the bake. Same test file, even (codegen-freshness.test.js).
//
// The second consumer (tvOS / Android TV) also gets strictly MORE this way than
// a CSS mirror would give it: aliases are followed to literals and every value
// is typed, because `3px 3px 0 var(--shadow-ink)` is a CSS expression no SwiftUI
// or Compose shadow can consume as a string.
//
// Flipping the direction later costs nothing: the JSON shape does not change,
// only who writes it.
//
// Deterministic: re-runs are byte-identical.
// Usage: node scripts/gen-design-tokens.mjs [--stdout]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public/shared/theme.css');
const OUT = path.join(ROOT, 'public/shared/design-tokens.json');
const SRC_REL = 'public/shared/theme.css';

// ---- 1. carve out the :root block -------------------------------------------
// It is the only `:root {` in the file and contains no nested braces, so the
// block is everything up to the first line that is just `}`.
function rootBlock(css) {
  const open = css.indexOf(':root {');
  if (open < 0) throw new Error(`${SRC_REL}: no ':root {' block`);
  const body = css.slice(open + ':root {'.length);
  const close = body.indexOf('\n}');
  if (close < 0) throw new Error(`${SRC_REL}: ':root {' is never closed`);
  return body.slice(0, close);
}

// ---- 2. walk it, keeping the prose ------------------------------------------
// A GROUP header is a block comment whose first line reads `-- label ------`
// (dash-dash-SPACE, and a run of trailing dashes). Anything else in a comment is
// documentation for the declaration that follows it — including
// `/* --ink above is headings ... */`, which is why the rule needs the space and
// the trailing dashes rather than just a leading `--`.
const isGroupHeader = (first) => /^--\s/.test(first) && /-{3,}\s*$/.test(first);
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function parse(block) {
  const groups = [];
  const tokens = [];
  let group = null;
  let pendingDoc = null;

  // Split into comments and everything else, preserving order. `gap` is the text
  // since the last declaration ended, which is how a TRAILING comment (same
  // source line as the declaration it annotates) is told from a DOC comment
  // (its own line, describing what comes next).
  const parts = block.split(/(\/\*[\s\S]*?\*\/)/);
  let gap = '';
  for (const part of parts) {
    if (part.startsWith('/*')) {
      const inner = part.slice(2, -2);
      const lines = inner.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && isGroupHeader(lines[0])) {
        const label = squash(lines[0].replace(/^--\s*/, '').replace(/\s*-{3,}\s*$/, ''));
        const note = squash(lines.slice(1).join(' '));
        group = { label, note, tokens: [] };
        groups.push(group);
        pendingDoc = null;
      } else {
        const text = squash(lines.join(' '));
        const last = tokens[tokens.length - 1];
        if (last && !last.note && !gap.includes('\n')) last.note = text;
        else pendingDoc = pendingDoc ? `${pendingDoc} ${text}` : text;
      }
      gap += part;
      continue;
    }
    let matched = false;
    for (const m of part.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      matched = true;
      gap = part.slice(m.index + m[0].length);  // text after the last declaration seen
      const t = {
        name: m[1].slice(2),
        var: m[1],
        group: group ? group.label : null,
        value: squash(m[2]),
      };
      if (pendingDoc) { t.doc = pendingDoc; pendingDoc = null; }
      tokens.push(t);
      if (group) group.tokens.push(t.name);
    }
    if (!matched) gap += part;
  }
  return { groups, tokens };
}

// ---- 3. type and resolve -----------------------------------------------------
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const RGB = /^rgba?\(([^)]*)\)$/;
const ALIAS = /^var\((--[a-zA-Z0-9-]+)\)$/;
const LENGTH = /^(-?\d*\.?\d+)px$/;
const SHADOW = /^(-?\d*\.?\d+)px\s+(-?\d*\.?\d+)px\s+(-?\d*\.?\d+)(?:px)?\s+(.+)$/;

function hexRgba(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  const a = h.length === 8 ? Number((n(6) / 255).toFixed(4)) : 1;
  return [n(0), n(2), n(4), a];
}
function fnRgba(css) {
  const raw = RGB.exec(css)[1].split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  const c = raw.slice(0, 3).map(Number);
  return [c[0], c[1], c[2], raw.length > 3 ? Number(raw[3]) : 1];
}
const rgbaOf = (v) => (HEX.test(v) ? hexRgba(v) : RGB.test(v) ? fnRgba(v) : null);

// Follow var() aliases to the literal they end at. Cycles and dangling
// references throw: a token that resolves to nothing is a broken stylesheet, and
// this is the only place that would notice.
function resolve(value, byName, owner, seen = []) {
  const a = ALIAS.exec(value);
  if (!a) return value;
  const name = a[1].slice(2);
  if (seen.includes(name)) throw new Error(`${SRC_REL}: --${owner} alias cycle: ${[...seen, name].join(' -> ')}`);
  const next = byName.get(name);
  if (!next) throw new Error(`${SRC_REL}: --${owner} references undefined var(--${name})`);
  return resolve(next.value, byName, owner, [...seen, name]);
}

function classify(t, byName) {
  // `resolved` means FULLY resolved everywhere: whole-value aliases are followed
  // to their literal, and a shadow's embedded var() is substituted in place (so
  // the string stays valid CSS and keeps the authored `0` rather than `0px`).
  // Nothing downstream ever has to know what a var() is.
  const resolved = resolve(t.value, byName, t.name)
    .replace(/var\((--[a-zA-Z0-9-]+)\)/g, (_, v) => resolve(`var(${v})`, byName, t.name));
  if (ALIAS.test(t.value)) t.alias = ALIAS.exec(t.value)[1].slice(2);
  t.resolved = resolved;

  const rgba = rgbaOf(resolved);
  if (rgba) { t.type = 'color'; t.rgba = rgba; return; }

  const len = LENGTH.exec(resolved);
  if (len) { t.type = 'length'; t.px = Number(len[1]); return; }

  const sh = SHADOW.exec(resolved);
  if (sh) {
    t.type = 'shadow';
    t.shadow = {
      x: Number(sh[1]), y: Number(sh[2]), blur: Number(sh[3]),
      color: sh[4], rgba: rgbaOf(sh[4]),
    };
    return;
  }

  if (/^['"]/.test(resolved)) {
    t.type = 'font-stack';
    t.stack = resolved.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    return;
  }
  t.type = 'raw';
}

// ---- 4. emit -----------------------------------------------------------------
const css = fs.readFileSync(SRC, 'utf8');
const { groups, tokens } = parse(rootBlock(css));
const byName = new Map(tokens.map((t) => [t.name, t]));
for (const t of tokens) classify(t, byName);

// One fixed key order for every token, so the file reads the same way top to
// bottom and a diff only ever shows a real change.
const ordered = (t) => ({
  name: t.name,
  var: t.var,
  group: t.group,
  type: t.type,
  value: t.value,          // exactly as authored, aliases and all
  resolved: t.resolved,    // aliases followed to the literal
  alias: t.alias,
  rgba: t.rgba,
  px: t.px,
  stack: t.stack,
  shadow: t.shadow,
  doc: t.doc,              // the block comment above the declaration
  note: t.note,            // the trailing comment on it
});

const doc = {
  // Named first so anyone opening the file learns where to edit instead.
  generated: `derived from ${SRC_REL} by scripts/gen-design-tokens.mjs — edit the CSS, not this`,
  source: SRC_REL,
  count: tokens.length,
  groups: groups.map((g) => ({ label: g.label, note: g.note || undefined, tokens: g.tokens })),
  tokens: tokens.map(ordered),
};

const text = JSON.stringify(doc, null, 2) + '\n';
if (process.argv.includes('--stdout')) { process.stdout.write(text); process.exit(0); }
fs.writeFileSync(OUT, text);
console.log(`wrote ${OUT}: ${tokens.length} tokens in ${groups.length} groups`);
