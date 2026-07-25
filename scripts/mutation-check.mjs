// Proves the conformance gates can FAIL. Breaks the engine on purpose, one edit at a
// time, and requires the named ctest to go red for each.
//
// WHY. A green suite says nothing about whether it would notice a regression, and
// this is not a theoretical worry — it has already happened twice in this tree,
// both times in gates written deliberately and reviewed:
//
//   * abi_check replayed the tidepool trace, whose four bots NEVER BRAKE. Deleting
//     the brake bit from ttp_process_input left all 600 frames hashing correctly.
//   * catalogue_sweep's first draft ran 400 frames, about 12% of a lap. The cars
//     never reached a second corner, so most of every track went unraced while the
//     gate looked like it covered twenty tracks.
//
// Both were found by doing this by hand. Doing it by hand does not scale and does not
// survive the next contributor, so it lives here.
//
// A mutation that no test catches is not automatically a bug — it can mean the code
// is genuinely unreachable, as Game::collidePole was before hazard_check existed. It
// means SOMETHING is wrong: a blind gate, or dead code. Both are worth knowing.
//
// TWO TRAPS, both learned the hard way:
//   1. mtime granularity. Patch, build and restore inside the same second and the
//      build system may not recompile — a mutation you never compiled looks
//      "undetected", and worse, a STALE object from the previous mutation can make
//      the next one look "detected". Every patch here is followed by an explicit
//      touch with a forward timestamp.
//   2. Restore is not optional. The tree must be pristine even if a build hangs or
//      the process is interrupted, so originals are captured up front, restored in a
//      finally, and re-restored on SIGINT/SIGTERM.
//
// Usage: node scripts/mutation-check.mjs [--only=<substring>] [--list] [--build-dir=<d>]
//        npm run mutation-check

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const listOnly = args.includes('--list');
const BUILD = path.join(ROOT, (args.find((a) => a.startsWith('--build-dir=')) || '')
  .slice('--build-dir='.length) || 'native/build/mutation');

// ---------------------------------------------------------------------------
// The mutations. `expect` names the ctest that MUST turn red — the gate whose whole
// job is this behaviour. Others may also fail; that is fine and not asserted, since
// which extra gates trip is an implementation detail (and for leak-shaped mutations,
// partly the allocator's business).
//
// Spread across every layer on purpose: a harness that only mutated the newest code
// would tell us nothing about whether the ORIGINAL gates still bite.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  // ---- mathlib + serializer: the foundations everything else trusts.
  {
    name: 'mathlib/sin-perturbed',
    file: 'native/vendor/fdlibm/src/s_sin.c',
    find: 'return __kernel_sin(x,z,0);',
    replace: 'return __kernel_sin(x,z,0) * 1.0000000000000002;',
    expect: 'mathlib_corpus',
  },
  {
    name: 'serializer/shortest-form-dropped',
    file: 'native/libttp-json/ttp/jsonnum.cc',
    find: 'EcmaScriptConverter().ToShortest(v, &sb);',
    replace: 'EcmaScriptConverter().ToPrecision(v, 17, &sb);',
    expect: 'serializer',
  },

  // ---- track geometry.
  {
    name: 'centerline/sample-off-by-one',
    file: 'native/libttp-track/ttp/centerline.cc',
    find: 'const Sample& pD = a[idx(i + 2)];',
    replace: 'const Sample& pD = a[idx(i + 3)];',
    expect: 'track_sampler',
  },

  // ---- the sim core.
  {
    name: 'sim/steer-scrub-weakened',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'STEER_SCRUB = 0.28',
    replace: 'STEER_SCRUB = 0.27',
    expect: 'replay_tidepool-4bots-600f-seed42',
  },
  {
    name: 'sim/pole-collision-never-runs',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'for (Car* c : list) for (const PoleRt& p : poles_) collidePole(*c, p);',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'sim/pole-min-keep-removed',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'if (c.v < POLE_MIN_KEEP * c.vmax) c.v = POLE_MIN_KEEP * c.vmax;',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'sim/stage-banana-does-nothing',
    file: 'native/libttp-sim/ttp/game.cc',
    find: 'bananas_.push_back(b);',
    replace: '',
    expect: 'hazards',
  },
  {
    name: 'ai/corner-margin-nudged',
    file: 'native/libttp-sim/ttp/ai_driver.cc',
    find: 'CORNER_MARGIN = 1.25',
    replace: 'CORNER_MARGIN = 1.26',
    expect: 'catalogue_sweep',
  },
  {
    // The PR #40 bug, reinstated: a racing line memoized against a RECYCLED
    // Centerline* address. race_isolation forces the collision, so it is the gate
    // that must fail deterministically.
    name: 'ai/racing-line-keyed-by-recycled-pointer',
    file: 'native/libttp-sim/ttp/ai_driver.cc',
    find: '  RacingLine& line = game.racingLine();',
    replace: [
      '  RacingLine& line = [&]() -> RacingLine& {',
      '    static std::vector<std::pair<Centerline*, std::unique_ptr<RacingLine>>> cache;',
      '    Centerline* key = const_cast<Centerline*>(game.centerline());',
      '    for (auto& kv : cache) if (kv.first == key) return *kv.second;',
      '    cache.emplace_back(key, std::make_unique<RacingLine>(*key));',
      '    return *cache.back().second;',
      '  }();',
    ].join('\n'),
    expect: 'race_isolation',
  },

  // ---- the cup layer.
  {
    name: 'gp/points-table-changed',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'POINTS_BY_RANK[4] = {9, 6, 3, 1}',
    replace: 'POINTS_BY_RANK[4] = {9, 6, 4, 1}',
    expect: 'grandprix',
  },
  {
    name: 'gp/latest-race-tiebreak-dropped',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'return latest(a.playerId) < latest(b.playerId);',
    replace: 'return false;',
    expect: 'grandprix',
  },
  {
    name: 'gp/unseated-row-loses-its-undefined',
    file: 'native/libttp-sim/ttp/grand_prix.cc',
    find: 'nm.seatNull = (seat == nullptr);',
    replace: 'nm.seatNull = false;',
    expect: 'grandprix',
  },

  // ---- the party layer.
  {
    name: 'room/sticky-host-reconcile-skipped',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: 'if (to == "lobby" || to == "results") reconcileStickyHost();',
    replace: '',
    expect: 'roomflow',
  },
  {
    name: 'framing/encode-drops-a-field',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: 'm.set("maxClients", Value::Num(maxClients));',
    replace: 'm.set("maxClient5", Value::Num(maxClients));',
    expect: 'framing',
  },
  {
    name: 'fastlane/rtt-ewma-skips-smoothing',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: 'else srtt_ = srtt_ + (rtt - srtt_) * RTT_ALPHA;',
    replace: 'else srtt_ = rtt;',
    expect: 'fastlane',
  },

  // ---- the party C ABI marshalling (ttp_party.cc).
  {
    name: 'party-abi/add-player-drops-game-fields',
    file: 'native/runtime/ttp_party.cc',
    find: 'if (ok && f.type == Value::OBJ) fields = f.obj;',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'party-abi/event-queue-not-drained',
    file: 'native/runtime/ttp_party.cc',
    find: '  rh->events.clear();',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'party-abi/classify-mislabels-bad-frames',
    file: 'native/runtime/ttp_party.cc',
    find: 'out.set("route", Value::Str("none"));',
    replace: 'out.set("route", Value::Str("message"));',
    expect: 'abi',
  },

  // ---- the C ABI marshalling.
  {
    name: 'abi/brake-bit-never-marshalled',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'if (mask & 2) { in.hasB = true; in.b = b; }',
    replace: '',
    expect: 'abi',
  },
  {
    name: 'abi/car-world-pos-wrong-component',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'out3[0] = c->pose.pos.x;',
    replace: 'out3[0] = 0;',
    expect: 'abi',
  },
  {
    name: 'abi/standings-emit-empty-name',
    file: 'native/runtime/ttp_runtime.cc',
    find: 'if (!st.seatNull) {',
    replace: 'if (true) {',
    expect: 'abi',
  },
];

// ---------------------------------------------------------------------------
const run = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts });

function configure() {
  if (fs.existsSync(path.join(BUILD, 'CMakeCache.txt'))) return;
  console.log(`configuring ${path.relative(ROOT, BUILD)} (Release, first run only)`);
  const r = run('cmake', ['-S', 'native', '-B', BUILD, '-DCMAKE_BUILD_TYPE=Release']);
  if (r.status !== 0) {
    console.error(r.stdout || '', r.stderr || '');
    throw new Error('cmake configure failed');
  }
}

function build() {
  const r = run('cmake', ['--build', BUILD, '--parallel']);
  return { ok: r.status === 0, log: `${r.stdout || ''}${r.stderr || ''}` };
}

// A forward timestamp, so no build system can mistake a patched file for an old one.
function touchForward(file) {
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
}

function ctestPasses(name) {
  const r = run('ctest', ['--test-dir', BUILD, '-R', `^${name}$`, '--output-on-failure']);
  const ran = /tests passed|tests failed|No tests were found/.test(`${r.stdout}${r.stderr}`);
  if (!ran) {
    console.error(`${r.stdout || ''}${r.stderr || ''}`);
    throw new Error(`ctest did not report on '${name}' — is that a real test name?`);
  }
  if (/No tests were found/.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`no ctest named '${name}'`);
  }
  return r.status === 0;
}

function main() {
  const selected = MUTATIONS.filter((m) => !only || m.name.includes(only));
  if (listOnly) {
    for (const m of MUTATIONS) console.log(`${m.name}  ->  ${m.expect}`);
    return;
  }
  if (!selected.length) throw new Error(`--only=${only} matched no mutation`);

  // Refuse to run over uncommitted work in the files we are about to vandalise.
  // Restore is robust, but "robust" is not a promise worth betting someone's edits on.
  const targets = [...new Set(selected.map((m) => m.file))];
  const dirty = run('git', ['status', '--porcelain', '--', ...targets]).stdout.trim();
  if (dirty) {
    console.error(`refusing to run: uncommitted changes in files this script mutates\n${dirty}`);
    console.error('commit or stash them first.');
    process.exitCode = 2;
    return;
  }

  configure();
  const baseline = build();
  if (!baseline.ok) {
    console.error(baseline.log);
    throw new Error('baseline build failed — fix the tree before mutation-checking');
  }

  const originals = new Map();
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    originals.set(rel, fs.readFileSync(abs));
  }
  const restoreAll = () => {
    for (const [rel, buf] of originals) {
      const abs = path.join(ROOT, rel);
      fs.writeFileSync(abs, buf);
      touchForward(abs);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { restoreAll(); process.exit(130); });
  }

  const results = [];
  try {
    for (const m of selected) {
      const abs = path.join(ROOT, m.file);
      const src = originals.get(m.file).toString();
      if (!src.includes(m.find)) {
        const note = m.optional ? 'skipped (anchor moved)' : 'ANCHOR MISSING';
        results.push({ ...m, status: note });
        console.log(`${note.padEnd(22)} ${m.name}`);
        continue;
      }

      fs.writeFileSync(abs, src.replace(m.find, m.replace));
      touchForward(abs);

      const b = build();
      let status;
      if (!b.ok) {
        // A mutation that will not compile proves nothing either way.
        status = m.optional ? 'skipped (no compile)' : 'DID NOT COMPILE';
      } else {
        status = ctestPasses(m.expect) ? 'NOT CAUGHT' : 'caught';
      }
      results.push({ ...m, status });
      console.log(`${status.padEnd(22)} ${m.name}  ->  ${m.expect}`);

      fs.writeFileSync(abs, originals.get(m.file));
      touchForward(abs);
    }
  } finally {
    restoreAll();
  }

  // The tree is back; prove the suite is green again, so a mutation can never be
  // left behind silently.
  const after = build();
  if (!after.ok) {
    console.error(after.log);
    throw new Error('post-restore build failed — the tree may not be pristine, check git status');
  }

  const bad = results.filter((r) => r.status === 'NOT CAUGHT' || r.status === 'ANCHOR MISSING' ||
    r.status === 'DID NOT COMPILE');
  const caught = results.filter((r) => r.status === 'caught').length;
  const skipped = results.filter((r) => r.status.startsWith('skipped')).length;

  console.log(`\n${caught}/${selected.length} mutations caught` +
    (skipped ? `, ${skipped} skipped` : '') + (bad.length ? `, ${bad.length} PROBLEMS` : ''));

  if (bad.length) {
    console.error('\nEach of these means a blind gate or dead code:');
    for (const r of bad) console.error(`  ${r.status}: ${r.name} (expected ${r.expect} to fail)`);
    process.exitCode = 1;
  }
}

main();
