// THE PLATFORM SURFACE IS TWO BODIES, AND THE REST IS SHARED.
//
// `ttp_display.h` is one ABI on every platform, and it is implemented twice
// over: `runtime/ttp_display_core.cc` holds every body that names no platform
// API and is compiled by all of them, while each platform's surface file
// (`ttp_display_web.cc`, `ttp_display_tvos.mm`) holds only the two that
// genuinely cannot be shared — the one that makes a rendering context out of
// whatever that platform calls a window, and the one that tears it down.
//
// WHY THIS IS A GATE AND NOT A CONVENTION. The split is young: the tvOS surface
// file was written BEFORE it landed, so it carried its own copies of the shared
// bodies, and the moment the core moved they drifted. Nothing failed. The
// library linked, the app rendered, and the picture was quietly a generation
// behind the web's — which is the whole class of bug the split exists to make
// impossible, arriving anyway because "do not add a body here that core has"
// was prose in a header and nothing read it.
//
// It is also the rule a NEW shell is most likely to break, and in the most
// expensive direction: an Android surface file that copies a body rather than
// linking the core one gets a working app whose renderer diverges silently from
// the other two. The C++ cannot help — a duplicate symbol would be a link
// error, but these are separate TARGETS, so each platform links exactly one
// surface file and there is nothing for a linker to collide.
//
// WHAT THIS DOES NOT CHECK is the other half of the rule — "if a line names no
// platform API, it is in the wrong file" — which needs a compiler, not a regex.
// What it can say is which BODIES live where, and that is the half that drifted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'native/runtime');

// The surface files, one per platform. A new shell adds its own here — which is
// the point at which someone reads the two rules above.
const SURFACES = ['ttp_display_web.cc', 'ttp_display_tvos.mm', 'ttp_display_android.cc'];

// The only two bodies a surface file may define.
//
// `create` takes the platform's window (a CSS selector, a CAMetalLayer*, an
// ANativeWindow*) and stands a renderer up on it; `destroy` tears that down in
// the order the platform's own teardown needs. Everything else in the ABI is
// arithmetic over `ttp::rt::displayCore()` and belongs to the shared file.
const SURFACE_BODIES = new Set(['ttp_display_create', 'ttp_display_destroy']);

// The shared implementation, compiled by every platform's target. TWO files,
// and the second is not an oversight: `ttp_render_scale.cc` holds the resolution
// ladder's arithmetic, which answers before a display exists and after one is
// destroyed (`ttp_display.h` says so at the declarations), so it has no business
// living beside the bodies that dereference the display singleton.
const SHARED = ['ttp_display_core.cc', 'ttp_render_scale.cc'];
const CORE = SHARED[0];

/** Every `ttp_display_*` the ABI header declares. */
function declared() {
  const src = readFileSync(path.join(RUNTIME, 'ttp_display.h'), 'utf8');
  return new Set([...src.matchAll(/^TTP_ABI\s+[\w*\s]+?\b(ttp_display_\w+)\s*\(/gm)].map((m) => m[1]));
}

/** Every `ttp_display_*` a translation unit DEFINES (a body, not a call). */
function defined(file) {
  const src = readFileSync(path.join(RUNTIME, file), 'utf8');
  // Column 0 only: a definition starts at the left margin in every one of these
  // files, while each call to one is indented inside a body. That is what keeps
  // this from counting `ttp_display_core.cc`'s internal cross-calls as
  // definitions. The `"` in the class is for the `extern "C" double …` form
  // `ttp_render_scale.cc` uses — without it those two bodies read as missing,
  // which is exactly how this test first ran.
  return new Set([...src.matchAll(/^[A-Za-z_][\w*\s:<>&"]*?\b(ttp_display_\w+)\s*\([^;]*$/gm)].map((m) => m[1]));
}

test('the display ABI, the shared bodies and every surface file are all present', () => {
  assert.ok(declared().size > 20, 'ttp_display.h declares almost nothing — has it moved?');
  for (const f of [...SHARED, ...SURFACES]) {
    assert.ok(existsSync(path.join(RUNTIME, f)), `missing display source: ${f}`);
  }
});

test('a platform surface file defines ONLY create and destroy', () => {
  for (const file of SURFACES) {
    const extra = [...defined(file)].filter((n) => !SURFACE_BODIES.has(n)).sort();
    assert.deepEqual(extra, [],
      `${file} defines ABI bodies the shared core already owns: ${extra.join(', ')}.\n`
      + '  A copy here is not a duplicate symbol — each platform links exactly ONE surface\n'
      + '  file, so nothing collides and the copy simply stops tracking the core. That is\n'
      + '  how the tvOS renderer once shipped a generation behind the web with no error\n'
      + '  anywhere. If the body needs a platform API, it belongs behind a seam in the\n'
      + '  core; if it does not, delete it and let the core one link.');
  }
});

test('every surface file defines both of them, and the core defines neither', () => {
  for (const file of SURFACES) {
    const bodies = defined(file);
    for (const name of SURFACE_BODIES) {
      assert.ok(bodies.has(name),
        `${file} does not define ${name} — the shared core cannot, so this platform has no ${name}`);
    }
  }
  const inCore = [...defined(CORE)].filter((n) => SURFACE_BODIES.has(n));
  assert.deepEqual(inCore, [],
    `${CORE} defines ${inCore.join(', ')}, which every surface file also defines — `
    + 'that is a duplicate symbol on every platform');
});

test('the shared bodies plus one surface file cover the whole ABI, with nothing left over', () => {
  const abi = declared();
  const shared = SHARED.flatMap((f) => [...defined(f)]);
  for (const file of SURFACES) {
    const provided = new Set([...shared, ...defined(file)]);
    const missing = [...abi].filter((n) => !provided.has(n)).sort();
    assert.deepEqual(missing, [],
      `${file} + the shared bodies do not implement: ${missing.join(', ')} — declared in `
      + 'ttp_display.h and defined nowhere, which is a link error on this platform only');
    const undeclared = [...provided].filter((n) => !abi.has(n)).sort();
    assert.deepEqual(undeclared, [],
      `defined but not declared in ttp_display.h: ${undeclared.join(', ')} — an entry `
      + 'point no header offers is one no shell can call');
  }
});
