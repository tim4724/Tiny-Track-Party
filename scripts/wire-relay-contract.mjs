// Re-derives tests/wire-compat/relay-contract.json from a Party-Sockets checkout.
//
// WHY THIS EXISTS. tests/wire-compat/relay.js is a MODEL of the production relay,
// and a model nobody can check is fiction. This script reads the real server.ts
// and extracts the handful of facts the model depends on — the limits, the close
// codes, the full error vocabulary, the dispatcher's message types, and the
// half-dozen BEHAVIOURS the wire map cited (a null `to` is an error, indices grow
// past maxClients, peer_joined is suppressed on a replace, ...). The frozen JSON
// is what CI compares against; this script is what tells you the frozen JSON has
// gone stale.
//
// It is deliberately a GENERATOR, not a test: CI has no Party-Sockets checkout,
// so the fact has to be frozen into the tree the same way every other oracle in
// this repo is. Run it whenever Party-Sockets moves, and read the diff.
//
// Usage:
//   node scripts/wire-relay-contract.mjs [--check] [--src=/path/to/Party-Sockets]
//     --check  compare against the frozen file and exit non-zero on drift
//              (writes nothing)
//
// Env: PARTY_SOCKETS overrides the default checkout path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/wire-compat/relay-contract.json');

const args = process.argv.slice(2);
const check = args.includes('--check');
const SRC = (args.find((a) => a.startsWith('--src=')) || '').slice('--src='.length)
  || process.env.PARTY_SOCKETS
  || path.join(process.env.HOME || '', 'Projects/Party-Sockets');

const serverPath = path.join(SRC, 'server.ts');
if (!fs.existsSync(serverPath)) {
  console.error(`Party-Sockets checkout not found at ${SRC}`);
  console.error('Pass --src=<path> or set PARTY_SOCKETS. (CI has none — that is why the');
  console.error('contract is frozen into tests/wire-compat/relay-contract.json.)');
  process.exit(2);
}

const src = fs.readFileSync(serverPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));

const fail = [];
function must(re, what) {
  const m = src.match(re);
  if (!m) { fail.push(`MISSING: ${what}  (pattern ${re})`); return null; }
  return m;
}
function num(re, what) {
  const m = must(re, what);
  if (!m) return null;
  return Function(`"use strict"; return (${m[1]});`)();
}

const limits = {
  maxStateBytes: num(/const MAX_STATE_BYTES = ([^;]+);/, 'MAX_STATE_BYTES'),
  maxUrlBytes: num(/const MAX_URL_BYTES = ([^;]+);/, 'MAX_URL_BYTES'),
  // `idleTimeout` is in SECONDS in Bun's websocket options.
  idleTimeoutMs: num(/idleTimeout: (\d+),/, 'websocket.idleTimeout') * 1000,
  hostGraceMs: num(/const HOST_DISCONNECT_GRACE_MS = ([^;]+);/, 'HOST_DISCONNECT_GRACE_MS'),
};

const closeCodes = {
  replaced: 4000,
  roomClosed: num(/const CLOSE_CODE_ROOM_CLOSED = (\d+);/, 'CLOSE_CODE_ROOM_CLOSED'),
};
if (!/\.close\(4000, "replaced"\)/.test(src)) fail.push('MISSING: the literal close(4000, "replaced")');

// Every error string the relay can put on the wire. This is the set the phone's
// onStatus('error', message) has to survive, and in the Couch Games shell all but
// two of them end the session — so a NEW one appearing here is a product event,
// not a refactor.
const errors = [...new Set([...src.matchAll(/type: "error", message: (?:"([^"]*)"|`([^`]*)`)/g)]
  .map((m) => (m[1] ?? m[2].replace(/\$\{[^}]*\}/g, '*'))))].sort();

// The dispatcher's accepted message types (anything else answers "Unknown message
// type"). This is the client->relay vocabulary a TV shell must not exceed.
const inboundTypes = [...new Set([...src.matchAll(/^\s*case "(\w+)":$/gm)].map((m) => m[1]))].sort();

// The behaviours tests/wire-compat/relay.js models, each pinned to the source
// construct it came from. If one of these stops matching, the model is describing
// a relay that no longer exists.
const BEHAVIOURS = [
  {
    id: 'null-to-is-an-error',
    why: 'A present-but-null `to` fails Number.isSafeInteger and answers "Target peer not found"; the E2E stub broadcasts it instead.',
    pattern: /if \(msg\.to !== undefined\) \{\s*\n\s*if \(!Number\.isSafeInteger\(msg\.to\) \|\| msg\.to < 0\)/,
  },
  {
    id: 'index-grows-past-maxclients',
    why: 'New joiners push to members.length, so indices grow monotonically and may exceed maxClients after churn.',
    pattern: /const index = room\.members\.length;/,
  },
  {
    id: 'cap-counts-live-clients',
    why: 'A disconnect frees the cap, so a returning owner can be answered "Room is full".',
    pattern: /if \(room\.active >= room\.maxClients\) \{\s*\n\s*return send\(ws, \{ type: "error", message: "Room is full" \}\);/,
  },
  {
    id: 'peer-joined-suppressed-on-replace',
    why: 'peer_joined fires only when the slot was not already active, so a display replacing its own live socket is invisible to phones.',
    pattern: /if \(!wasActive\) broadcast\(msg\.room, \{ type: "peer_joined", index: existingIndex \}, ws\);/,
  },
  {
    id: 'hostless-grace-closes-the-room',
    why: 'Slot 0 vanishing arms a timer that tears the whole room down and 4001s everyone.',
    pattern: /if \(index === 0\) startHostGrace\(roomCode, room\);/,
  },
  {
    id: 'created-carries-instance-and-region',
    why: 'party.pinInstance -> ttp_framing_pin_url and the display join URL\'s #instance fragment only run when these are non-empty.',
    pattern: /send\(ws, \{ type: "created", room: code, instance: INSTANCE_ID, region: REGION, index: 0, url: room\.url \}\);/,
  },
  {
    id: 'state-null-is-retained-not-rejected',
    why: 'setState(undefined) is refused, but an explicit null is RETAINED and replayed as a cleared-state signal.',
    pattern: /if \(msg\.data === undefined\) \{\s*\n\s*return send\(ws, \{ type: "error", message: "State data is required" \}\);/,
  },
  {
    id: 'state-cap-measures-utf8-bytes',
    why: 'The 16 KiB cap is UTF-8 bytes, not UTF-16 units, which is what makes the C++ round trip length-sensitive.',
    pattern: /Buffer\.byteLength\(JSON\.stringify\(msg\.data\)\) > MAX_STATE_BYTES/,
  },
  {
    id: 'retained-state-replayed-after-joined',
    why: 'Every (re)joiner gets the host snapshot right after `joined`, which is how a phone recovers without a per-phone WELCOME.',
    pattern: /sendRetainedState\(ws, room\);/,
  },
  {
    id: 'invalid-json-answers-an-error',
    why: 'A single malformed frame is a session-ending event in prod and a no-op in the E2E stub.',
    pattern: /return send\(ws, \{ type: "error", message: "Invalid JSON" \}\);/,
  },
];

const behaviours = [];
for (const b of BEHAVIOURS) {
  if (!b.pattern.test(src)) fail.push(`BEHAVIOUR GONE: ${b.id} — ${b.why}`);
  behaviours.push({ id: b.id, why: b.why });
}

if (fail.length) {
  console.error(`Party-Sockets ${pkg.version} no longer matches what the model assumes:\n`);
  for (const f of fail) console.error('  ' + f);
  console.error('\nFix tests/wire-compat/relay.js FIRST, then re-run this generator.');
  process.exit(1);
}

const contract = {
  _: 'FROZEN. Derived from Party-Sockets by scripts/wire-relay-contract.mjs; do not hand-edit.',
  source: { package: pkg.name, version: pkg.version, file: 'server.ts' },
  limits,
  closeCodes,
  errors,
  inboundTypes,
  behaviours,
};

const text = JSON.stringify(contract, null, 2) + '\n';
if (check) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (have !== text) {
    console.error('relay-contract.json is STALE. Re-run without --check and read the diff.');
    process.exit(1);
  }
  console.log(`relay-contract.json is current against Party-Sockets ${pkg.version}`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} from Party-Sockets ${pkg.version}`);
  console.log(`  ${errors.length} error strings, ${inboundTypes.length} inbound types, ${behaviours.length} behaviours`);
}
