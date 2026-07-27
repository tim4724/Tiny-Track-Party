// Proves the wire-compat gate can FAIL.
//
// A gate nobody has watched fail is not a gate. tests/wire-compat.test.js and
// tests/wire-fastlane.test.js assert against the SHIPPED wasm, so the only honest
// way to break them is to break the C++ and rebuild — which is what this does:
// patch one line under native/, rebuild ttp_runtime_web, swap the artifact into
// public/display/engine/native/, run the two suites, require the named one to go
// red, then put everything back.
//
// Sibling of scripts/mutation-check.mjs (which does the same for ctest) and of
// scripts/wire-mutate-js.mjs (the same idea for the JS producers, no rebuild). It
// inherits both of mutation-check's hard-won rules:
//   1. mtime granularity — every patch is followed by a forward touch, or ninja
//      may not recompile and an unbuilt mutation looks "undetected".
//   2. restore is not optional — originals are captured up front, restored in a
//      finally, and re-restored on SIGINT/SIGTERM. That includes the CHECKED-IN
//      wasm artifacts, which are the whole point of this suite.
//
// The rebuild is deliberately WITHOUT -DFILAMENT_SDK: sim + party only, which is
// exactly what CI's wasm leg builds and everything these two suites touch. The
// suites are re-run against a baseline build of the same configuration first, so
// a "red" result can never be an artifact of the renderer being absent.
//
// Usage: node scripts/wire-mutate.mjs [--only=<substring>] [--list]
// Env:   EMSDK_DIR (default ~/emsdk)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMSDK_DIR = process.env.EMSDK_DIR || process.env.EMSDK || path.join(process.env.HOME, 'emsdk');
const BUILD = path.join(ROOT, 'native/build/wire-mutation');
const OUTDIR = path.join(ROOT, 'public/display/engine/native');
const SUITES = ['tests/wire-compat.test.js', 'tests/wire-fastlane.test.js'];

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');

// ---------------------------------------------------------------------------
// The mutations. `expect` names the test whose title must appear as a FAILURE.
// One per class the brief calls out: a renamed field, a reformatted number, an
// optional flipped to null, a reordered array — plus one that silently
// misroutes, because that is the failure mode a shell port actually produces.
//
// The ROSTER block below covers the same classes on the object the phone actually
// lives off: every field of LOBBY_UPDATE that C++ contributes (RoomFlow's player
// serialization and its state names) plus the escaper that has to keep that
// object parseable. They were all silent until tests/wire-compat.test.js stopped
// deep-equalling a literal it had just written and started driving
// DisplayNet._publishLobby.
//
// The JS half of the same boundary — display/Net.js (which AUTHORS that object),
// shared/names.js and the relay model's own enforcement — needs no rebuild, so it
// lives in the sibling scripts/wire-mutate-js.mjs and runs in seconds.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: 'framing/renamed-field',
    kind: 'change a field name in the C++ encoder',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: '  m.set("to", to);',
    replace: '  m.set("peer", to);',
    expect: 'every C++ outbound encoder produces bytes the relay accepts',
  },
  {
    name: 'serializer/number-formatting',
    kind: "change a number's formatting",
    file: 'native/libttp-json/ttp/jsonnum.cc',
    find: 'EcmaScriptConverter().ToShortest(v, &sb);',
    replace: 'EcmaScriptConverter().ToPrecision(v, 17, &sb);',
    expect: 'numbers cross the boundary in shortest form, both directions',
  },
  {
    name: 'fastlane/ack-t-null',
    kind: 'flip an optional to null',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '  ack.set("t", t ? *t : Value());',
    replace: '  ack.set("t", t ? *t : Value::Null());',
    expect: 'the ack DROPS `t` when the data packet had none',
  },
  {
    name: 'fastlane/ring-order-reversed',
    kind: 'reorder an array',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '  for (const RingEntry& e : ring_) h.push(e.ev);',
    replace: '  for (auto it = ring_.rbegin(); it != ring_.rend(); ++it) h.push(it->ev);',
    // Found the suite's one blind spot on the first run: the display is the
    // RECEIVING side, so nothing exercised the C++ Link as a SENDER and reversing
    // this turned no test red. tests/wire-fastlane.test.js now decodes a
    // C++-authored packet with the real JS receiver, which is what bites here.
    expect: 'a C++-SENT packet decodes in the real JS receiver',
  },
  {
    name: 'framing/misrouted-from',
    kind: 'read the wrong key on the inbound path',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: '    if (const Value* f = field(frame, "from")) in.from = *f;',
    replace: '    if (const Value* f = field(frame, "index")) in.from = *f;',
    expect: 'the kit and C++ classify every prod relay frame identically',
  },

  // ---- the roster the phone reads (LOBBY_UPDATE) ---------------------------
  {
    name: 'roomflow/peerindex-stringified',
    kind: 'retype a roster field the phone matches with ===',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  o.set("peerIndex", peerIndex.toValue());',
    replace: '  o.set("peerIndex", Value::Str(peerIndex.key()));',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/connected-bool-to-num',
    kind: 'retype a boolean to 0/1',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  o.set("connected", Value::Bool(connected));',
    replace: '  o.set("connected", Value::Num(connected ? 1 : 0));',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/roster-fields-dropped',
    kind: 'drop the opaque game fields (name/colorIndex/carIndex/ready)',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  for (const auto& kv : fields) o.set(kv.first, kv.second);',
    replace: '  for (const auto& kv : fields) { (void)kv; }',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/roster-order-reversed',
    kind: 'reorder the roster',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: `Value RoomFlow::listValue() const {
  std::vector<const Player*> arr;
  for (const auto& p : players_) arr.push_back(&p);
  std::stable_sort(arr.begin(), arr.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt < b->joinedAt; });`,
    replace: `Value RoomFlow::listValue() const {
  std::vector<const Player*> arr;
  for (const auto& p : players_) arr.push_back(&p);
  std::stable_sort(arr.begin(), arr.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt > b->joinedAt; });`,
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/state-renamed',
    kind: 'rename a phase string the phone compares against protocol.js',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '    case State::RESULTS: return "results";',
    replace: '    case State::RESULTS: return "result";',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'serializer/tab-unescaped',
    kind: 'emit a raw control byte instead of an escape',
    file: 'native/libttp-json/ttp/canonical.cc',
    find: "      case '\\t': o += \"\\\\t\"; break;",
    replace: "      case '\\t': o += '\\t'; break;",
    // Invalid JSON on the wire: prod answers "Invalid JSON" and the roster stops
    // updating for the whole room. Only reachable through a NAME, which is the one
    // free-text field on the wire.
    expect: 'a control character in a name stays ESCAPED all the way round',
  },
  {
    name: 'fastlane/ack-prune-off-by-one',
    kind: 'move a boundary in the sender-side ring prune',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '    while (keepLen > 0 && ring_[keepLen - 1].es <= pa->num) keepLen--;',
    replace: '    while (keepLen > 0 && ring_[keepLen - 1].es <  pa->num) keepLen--;',
    // The other half of "nothing in the browser runs the C++ Link as a SENDER":
    // the ring-order fix covered sendDataPacket, handleAck was still uncovered, so
    // a fully-acked event resent forever at 20 Hz with the suite green.
    expect: 'a C++ SENDER stops resending what the ack covered',
  },
];

if (listOnly) {
  for (const m of MUTATIONS) console.log(`${m.name.padEnd(34)} ${m.kind}  ->  ${m.expect}`);
  process.exit(0);
}

const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;
if (!selected.length) {
  console.error(`no mutation matches --only=${only}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Restore machinery. Captured BEFORE anything is touched.
// ---------------------------------------------------------------------------
const originals = new Map();     // abs path -> Buffer
function capture(p) {
  if (!originals.has(p)) originals.set(p, fs.readFileSync(p));
}
function restoreAll() {
  for (const [p, buf] of originals) {
    try { fs.writeFileSync(p, buf); } catch (e) { console.error(`RESTORE FAILED ${p}: ${e.message}`); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}

const ARTIFACTS = ['ttp_runtime.mjs', 'ttp_runtime.wasm'].map((f) => path.join(OUTDIR, f));
for (const a of ARTIFACTS) capture(a);
for (const m of selected) capture(path.join(ROOT, m.file));

// ---------------------------------------------------------------------------
function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-lc', cmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

const EMENV = `source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null 2>&1`;

function buildWasm() {
  const configure = `${EMENV} && emcmake cmake -S "${ROOT}/native" -B "${BUILD}" -G Ninja -DCMAKE_BUILD_TYPE=Release`;
  const build = `${EMENV} && cmake --build "${BUILD}" --target ttp_runtime_web --parallel`;
  let r = sh(configure);
  if (r.status !== 0) return { ok: false, log: r.stdout + r.stderr };
  r = sh(build);
  if (r.status !== 0) return { ok: false, log: r.stdout + r.stderr };
  return { ok: true, log: '' };
}

function installBuiltArtifacts() {
  for (const f of ['ttp_runtime.mjs', 'ttp_runtime.wasm']) {
    fs.copyFileSync(path.join(BUILD, f), path.join(OUTDIR, f));
  }
}

// Run both suites and return the set of FAILING test titles.
function runSuites() {
  const r = sh(`node --test --test-reporter=tap ${SUITES.join(' ')}`);
  const failures = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^not ok \d+ - (.*)$/);
    if (m) failures.push(m[1]);
  }
  return { ok: r.status === 0, failures, log: r.stdout + r.stderr };
}

function touchForward(p) {
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(p, t, t);
}

// ---------------------------------------------------------------------------
let exitCode = 0;
try {
  console.log('==> baseline: building ttp_runtime_web WITHOUT the Filament SDK (CI\'s wasm configuration)');
  const b = buildWasm();
  if (!b.ok) {
    console.error(b.log.split('\n').slice(-40).join('\n'));
    throw new Error('baseline build failed');
  }
  installBuiltArtifacts();
  const base = runSuites();
  if (!base.ok) {
    console.error(base.log.split('\n').slice(-60).join('\n'));
    throw new Error(`baseline suites are RED before any mutation (${base.failures.length} failures) — fix that first`);
  }
  console.log('    baseline green\n');

  const results = [];
  for (const m of selected) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs).toString('utf8');
    if (!src.includes(m.find)) throw new Error(`${m.name}: anchor not found in ${m.file}\n  ${m.find}`);
    fs.writeFileSync(abs, src.replace(m.find, m.replace));
    touchForward(abs);

    process.stdout.write(`==> ${m.name.padEnd(34)} (${m.kind}) ... `);
    const built = buildWasm();
    let verdict;
    if (!built.ok) {
      verdict = { caught: false, why: 'BUILD FAILED', failures: [] };
      console.log('BUILD FAILED');
      console.error(built.log.split('\n').slice(-25).join('\n'));
    } else {
      installBuiltArtifacts();
      const run = runSuites();
      const hit = run.failures.find((f) => f.includes(m.expect));
      verdict = { caught: !!hit, failures: run.failures };
      console.log(hit ? `CAUGHT by "${hit}"` : `NOT CAUGHT (failures: ${run.failures.length})`);
      if (!hit) exitCode = 1;
      for (const f of run.failures) console.log(`      red: ${f}`);
    }
    results.push({ ...m, ...verdict });

    // Put the source back before the next mutation so they never compound.
    fs.writeFileSync(abs, src);
    touchForward(abs);
  }

  console.log('\n---- summary ----');
  for (const r of results) {
    console.log(`${r.caught ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.failures.length} test(s) red`);
  }
  console.log(exitCode === 0
    ? `\nAll ${results.length} mutations were caught. The gate bites.`
    : '\nAt least one mutation went UNDETECTED — a blind spot in the wire suite, or dead code.');
} catch (e) {
  console.error('\n' + e.message);
  exitCode = 2;
} finally {
  restoreAll();
  console.log('\n(sources and public/display/engine/native artifacts restored)');
}
process.exit(exitCode);
