#!/usr/bin/env node
// Generate the Android shell's JNI bridge from the ABI headers themselves.
//
//   node scripts/gen-jni.mjs            # write both files
//   node scripts/gen-jni.mjs --check    # exit 1 if either is stale
//
// WHY THIS IS GENERATED AND THE OTHER TWO SHELLS' BRIDGES ARE NOT. Swift eats a
// C header directly and JS gets cwrap, so on those platforms there IS no bridge
// to write — the tvOS shell binds ~150 ttp_* symbols with no glue at all. Kotlin
// gets neither. Hand-writing 196 JNI stubs would be 196 more of the hand-written
// call sites that docs/native-port/shells.md's last section is entirely about:
// "~245 hand-written call sites that invoke rules the C++ had already got
// right", where all six of the first TV shell's launch bugs lived, every one of
// them silent. A generator does not make that class of bug unlikely, it makes it
// unrepresentable — so the marshalling rules below are stated once, here, rather
// than 196 times by hand.
//
// tests/jni-generated.test.js re-runs this with --check, so a header edit that
// is not regenerated fails the suite rather than the next launch.
//
// REGISTERNATIVES, NOT SYMBOL MANGLING. Every method is registered from an
// explicit table in JNI_OnLoad instead of being exported as
// Java_games_couchpad_tinytrack_Ttp_ttp_1display_1build. Three reasons, in
// order of how much they matter: a name that does not match fails at LOAD, not
// at first call (the ledger's "fails on the first launch instead of silently
// dropping a step at a party"); the mangling of a name that already contains
// underscores is unreadable; and lookup is a table rather than a dlsym.
//
// THE C NAMES ARE KEPT VERBATIM on the Kotlin side, against Kotlin's own naming
// convention. `ttp_display_build` greps to the header, the tvOS Swift call site,
// the web's Stage.js and this bridge in one search. A camelCased twin would
// break that for every symbol in the engine.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, 'native/runtime');
const PACKAGE = 'games.couchpad.tinytrack';

// Every public ABI header. ttp_display.h is here even though it only exists in a
// Filament build: the Kotlin side declares the whole surface, and a shell built
// without a renderer would fail to REGISTER rather than fail mysteriously later.
const HEADERS = [
  'ttp_runtime.h', 'ttp_party.h', 'ttp_net.h', 'ttp_race.h', 'ttp_ui.h',
  'ttp_audio.h', 'ttp_display.h', 'ttp_theme.h', 'ttp_glb.h', 'ttp_error.h',
];

// ---------------------------------------------------------------------------
// The marshalling rules. Ten exports are not (scalars | strings); each one is
// named here with the reason, because a silent default for any of them is a
// wrong answer rather than a compile error.
// ---------------------------------------------------------------------------
const OVERRIDES = {
  // NOT BOUND AT ALL. Its surface is `const void*` — a CSS selector on web, a
  // CAMetalLayer* on tvOS, an ANativeWindow* here — and Kotlin cannot
  // manufacture any of those. The only road to it on this platform is
  // `ANativeWindow_fromSurface`, which needs a JNIEnv and a jobject, so the
  // entry point IS a JNI function and lives hand-written in
  // `runtime/ttp_display_android.cc` beside the body it calls.
  //
  // Skipping it is the honest answer rather than an omission: a generated
  // binding taking a ByteArray would compile, would be callable, and would hand
  // the renderer a pointer to a Kotlin byte buffer. It stayed harmless only
  // while the parameter was `const char*` and nobody called it.
  ttp_display_create: { kind: 'skip' },
  // A caller-owned out-array. JNI cannot alias a jdoubleArray, so the shim
  // writes into a stack triple and copies back only on success — a failed call
  // must leave the caller's array untouched, which is what the int return means.
  ttp_car_world_pos: { kind: 'outN', n: 3 },
  ttp_track_point: { kind: 'outN', n: 3 },
  // Two answers that are ONE decision — the buffer scale and the present
  // divisor — so the ABI hands them back together rather than as two exports a
  // shell could half-call. Same aliasing rule as the triples above.
  ttp_display_step: { kind: 'outN', n: 2 },
  // (bytes, len) collapses to one ByteArray: the length is the array's own.
  // Passing them separately would let them disagree, which is a buffer overrun
  // spelled as two arguments.
  ttp_display_asset: { kind: 'namedBytes' },
  ttp_glb_image_uris: { kind: 'bytesIn' },
  // ...and this one also hands back a length through an out-param, which the
  // Kotlin side never sees: it gets a right-sized ByteArray or null.
  ttp_glb_ghost: { kind: 'bytesInBytesOut' },
  // A caller-owned float array, 4 floats per cell. Same aliasing rule as out3,
  // and the int return is a COUNT here (ttp_display.h), neither predicate nor
  // outcome, so nothing may test it for truthiness.
  ttp_display_cell_rects: { kind: 'floatOut' },
  // Self-describing packed blocks: version + count + STRIDE, designed so a
  // reader can decode without having compiled the struct (ttp_hud.h). A direct
  // ByteBuffer is therefore the intended read and costs no copy. Scratch
  // lifetime: valid until the next call, exactly like a returned const char*.
  ttp_display_hud: { kind: 'block', bytes: 'ttpHudBlockBytes(p)' },
  ttp_audio_drain: { kind: 'block', bytes: 'ttpAudioBlockBytes(p)' },
  // The renderer's own profile array, whose length is the comma count in
  // ttp_display_profile_names(). Capped rather than trusted: a wrong length here
  // is an out-of-bounds read of the renderer's scratch.
  ttp_display_profile: { kind: 'block', bytes: 'ttpProfileBytes()' },
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
function declarations() {
  const out = [];
  for (const h of HEADERS) {
    let text;
    try { text = readFileSync(join(RUNTIME, h), 'utf8'); } catch { continue; }
    // Strip comments first: a `/* ... TTP_ABI ... */` note would otherwise parse
    // as a declaration, and there are several in these headers.
    text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const m of text.matchAll(/TTP_ABI\s+([^;]+?)\s*\(([^)]*)\)\s*;/g)) {
      const head = m[1].replace(/\s+/g, ' ').trim();
      const mm = head.match(/^(.*?)\s*\**\s*([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!mm) throw new Error(`cannot parse return/name from: ${head}`);
      const name = mm[2];
      const ret = head.slice(0, head.length - name.length).trim();
      const params = m[2].trim() === 'void' || m[2].trim() === ''
        ? []
        : m[2].split(',').map((p) => {
            const s = p.replace(/\s+/g, ' ').trim();
            const pm = s.match(/^(.*?)\s*\**\s*([A-Za-z_][A-Za-z0-9_]*)$/);
            if (!pm) throw new Error(`cannot parse param: ${s} (in ${name})`);
            const pname = pm[2];
            return { type: s.slice(0, s.length - pname.length).trim(), name: pname };
          });
      out.push({ header: h, ret, name, params });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Type mapping for the mechanical majority
// ---------------------------------------------------------------------------
const SCALAR = {
  int: { jni: 'jint', kt: 'Int', sig: 'I', cast: '(int)' },
  uint32_t: { jni: 'jint', kt: 'Int', sig: 'I', cast: '(uint32_t)' },
  'unsigned int': { jni: 'jint', kt: 'Int', sig: 'I', cast: '(unsigned int)' },
  double: { jni: 'jdouble', kt: 'Double', sig: 'D', cast: '(double)' },
};
const isStr = (t) => /^const char\s*\*$/.test(t.replace(/\s+/g, ' '));

function shape(fn) {
  const o = OVERRIDES[fn.name];
  if (o) return o.kind;
  for (const p of fn.params) {
    if (!isStr(p.type) && !SCALAR[p.type]) {
      throw new Error(`${fn.name}: unhandled param type "${p.type}" — add an OVERRIDES entry`);
    }
  }
  if (!isStr(fn.ret) && fn.ret !== 'void' && !SCALAR[fn.ret]) {
    throw new Error(`${fn.name}: unhandled return type "${fn.ret}" — add an OVERRIDES entry`);
  }
  return 'plain';
}

// ---------------------------------------------------------------------------
// Emit: the C shim
// ---------------------------------------------------------------------------
function emitC(fns) {
  const L = [];
  L.push(`// GENERATED by scripts/gen-jni.mjs — do not edit.`);
  L.push(`//`);
  L.push(`// The JNI half of the Android shell's bridge. Its Kotlin twin is`);
  L.push(`// shells/androidtv/app/src/main/kotlin/${PACKAGE.replace(/\./g, '/')}/Ttp.kt,`);
  L.push(`// emitted from the same parse in the same run, so the two cannot disagree`);
  L.push(`// about a signature. The rules both obey are documented in the generator.`);
  L.push(`//`);
  L.push(`// STRINGS CROSS AS byte[], NEVER AS jstring. NewStringUTF and`);
  L.push(`// GetStringUTFChars speak MODIFIED UTF-8, in which a non-BMP character is a`);
  L.push(`// surrogate pair of three-byte sequences and U+0000 is two bytes — neither`);
  L.push(`// is UTF-8, and both would corrupt a payload silently. The controller's name`);
  L.push(`// field is free text off a phone and reaches every one of these, and`);
  L.push(`// tests/fixtures/json-escape-corpus.jsonl exists because that boundary had`);
  L.push(`// no coverage once already.`);
  L.push(``);
  L.push(`#include <jni.h>`);
  L.push(`#include <string.h>`);
  L.push(`#include <vector>`);
  L.push(``);
  for (const h of HEADERS) L.push(`#include "${h}"`);
  L.push(`#include "ttp_hud.h"`);
  L.push(``);
  L.push(`namespace {`);
  L.push(``);
  L.push(`// A ceiling on the comma count, so a corrupt names string cannot make`);
  L.push(`// ttpProfileBytes() advertise an unbounded buffer.`);
  L.push(`constexpr int TTP_PROFILE_MAX = 64;`);
  L.push(``);
  L.push(`// A jbyteArray as a NUL-terminated C string. Null in, null out: every ABI`);
  L.push(`// here spells "absent" as a null pointer, and an OrNull parameter must be`);
  L.push(`// able to receive one.`);
  L.push(`struct CStr {`);
  L.push(`    std::vector<char> buf;`);
  L.push(`    bool null = true;`);
  L.push(`    CStr(JNIEnv* env, jbyteArray a) {`);
  L.push(`        if (!a) return;`);
  L.push(`        null = false;`);
  L.push(`        const jsize n = env->GetArrayLength(a);`);
  L.push(`        buf.resize((size_t) n + 1);`);
  L.push(`        if (n) env->GetByteArrayRegion(a, 0, n, (jbyte*) buf.data());`);
  L.push(`        buf[(size_t) n] = 0;`);
  L.push(`    }`);
  L.push(`    const char* get() const { return null ? nullptr : buf.data(); }`);
  L.push(`};`);
  L.push(``);
  L.push(`// A returned scratch const char* as a fresh byte[]. Copies at the call site,`);
  L.push(`// which is the whole point: the pointer is only valid until the next ttp_*`);
  L.push(`// call on that handle, and a Kotlin caller has no way to honour that.`);
  L.push(`jbyteArray toBytes(JNIEnv* env, const char* s) {`);
  L.push(`    if (!s) return nullptr;`);
  L.push(`    const size_t n = strlen(s);`);
  L.push(`    jbyteArray a = env->NewByteArray((jsize) n);`);
  L.push(`    if (a && n) env->SetByteArrayRegion(a, 0, (jsize) n, (const jbyte*) s);`);
  L.push(`    return a;`);
  L.push(`}`);
  L.push(``);
  L.push(`jbyteArray toBytes(JNIEnv* env, const uint8_t* p, uint32_t n) {`);
  L.push(`    if (!p) return nullptr;`);
  L.push(`    jbyteArray a = env->NewByteArray((jsize) n);`);
  L.push(`    if (a && n) env->SetByteArrayRegion(a, 0, (jsize) n, (const jbyte*) p);`);
  L.push(`    return a;`);
  L.push(`}`);
  L.push(``);
  L.push(`// The profile array's length is NOT a constant the ABI states: it is the`);
  L.push(`// comma count of ttp_display_profile_names() plus one. Capacity is the only`);
  L.push(`// bound a Kotlin reader has, so a fixed cap here would advertise bytes past`);
  L.push(`// the end of the renderer's array — readable, wrong, and silent.`);
  L.push(`size_t ttpProfileBytes() {`);
  L.push(`    const char* names = ttp_display_profile_names();`);
  L.push(`    if (!names || !*names) return 0;`);
  L.push(`    size_t n = 1;`);
  L.push(`    for (const char* p = names; *p; ++p) if (*p == ',') n++;`);
  L.push(`    if (n > (size_t) TTP_PROFILE_MAX) n = (size_t) TTP_PROFILE_MAX;`);
  L.push(`    return n * sizeof(double);`);
  L.push(`}`);
  L.push(``);
  L.push(`size_t ttpHudBlockBytes(const TtpHudBlock* b) {`);
  L.push(`    return b ? sizeof(TtpHudBlock) + (size_t) b->slotCount * b->stride : 0;`);
  L.push(`}`);
  L.push(`size_t ttpAudioBlockBytes(const TtpAudioBlock* b) {`);
  L.push(`    return b ? sizeof(TtpAudioBlock) + (size_t) b->count * b->stride : 0;`);
  L.push(`}`);
  L.push(``);

  for (const fn of fns) {
    const kind = shape(fn);
    if (kind === 'skip') continue;
    const o = OVERRIDES[fn.name] || {};
    const args = [];
    const pre = [];
    const post = [];
    let call, retC, sig;

    if (kind === 'plain') {
      const ps = fn.params.map((p, i) => {
        if (isStr(p.type)) {
          args.push(`jbyteArray a${i}`);
          pre.push(`    CStr s${i}(env, a${i});`);
          return `s${i}.get()`;
        }
        args.push(`${SCALAR[p.type].jni} a${i}`);
        return `${SCALAR[p.type].cast} a${i}`;
      });
      call = `${fn.name}(${ps.join(', ')})`;
      sig = `(${fn.params.map((p) => (isStr(p.type) ? '[B' : SCALAR[p.type].sig)).join('')})`;
      if (isStr(fn.ret)) { retC = 'jbyteArray'; sig += '[B'; call = `toBytes(env, ${call})`; }
      else if (fn.ret === 'void') { retC = 'void'; sig += 'V'; }
      else { retC = SCALAR[fn.ret].jni; sig += SCALAR[fn.ret].sig; call = `(${SCALAR[fn.ret].jni}) ${call}`; }
    } else if (kind === 'outN') {
      // (…leading args…, double* outN) — the out array is always LAST.
      const lead = fn.params.slice(0, -1);
      const ps = lead.map((p, i) => {
        if (isStr(p.type)) { args.push(`jbyteArray a${i}`); pre.push(`    CStr s${i}(env, a${i});`); return `s${i}.get()`; }
        args.push(`${SCALAR[p.type].jni} a${i}`); return `${SCALAR[p.type].cast} a${i}`;
      });
      args.push('jdoubleArray outArr');
      pre.push(`    double outv[${o.n}] = { 0 };`);
      call = `${fn.name}(${[...ps, 'outv'].join(', ')})`;
      pre.push(`    const jint rc = (jint) ${call};`);
      // Copied back only on success: a refusal must leave the caller's array as
      // it was, which is what lets a caller keep a last-known-good position.
      post.push(`    if (rc && outArr && env->GetArrayLength(outArr) >= ${o.n}) env->SetDoubleArrayRegion(outArr, 0, ${o.n}, outv);`);
      post.push(`    return rc;`);
      call = null;
      retC = 'jint';
      sig = `(${lead.map((p) => (isStr(p.type) ? '[B' : SCALAR[p.type].sig)).join('')}[D)I`;
    } else if (kind === 'floatOut') {
      args.push('jfloatArray outArr', 'jint maxCells');
      pre.push(`    if (!outArr) return 0;`);
      pre.push(`    const jint cap = env->GetArrayLength(outArr) / 4;`);
      pre.push(`    const jint want = maxCells < cap ? maxCells : cap;`);
      pre.push(`    std::vector<float> tmp((size_t) (want > 0 ? want : 0) * 4, 0.0f);`);
      pre.push(`    const jint n = (jint) ${fn.name}(tmp.data(), (int) want);`);
      post.push(`    if (n > 0) env->SetFloatArrayRegion(outArr, 0, n * 4, tmp.data());`);
      post.push(`    return n;`);
      retC = 'jint';
      sig = '([FI)I';
    } else if (kind === 'namedBytes') {
      args.push('jbyteArray a0', 'jbyteArray bytes');
      pre.push(`    CStr s0(env, a0);`);
      pre.push(`    const jsize n = bytes ? env->GetArrayLength(bytes) : 0;`);
      pre.push(`    std::vector<uint8_t> b((size_t) n);`);
      pre.push(`    if (n) env->GetByteArrayRegion(bytes, 0, n, (jbyte*) b.data());`);
      call = `(jint) ${fn.name}(s0.get(), b.data(), (uint32_t) n)`;
      retC = 'jint';
      sig = '([B[B)I';
    } else if (kind === 'bytesIn') {
      args.push('jbyteArray bytes');
      pre.push(`    const jsize n = bytes ? env->GetArrayLength(bytes) : 0;`);
      pre.push(`    std::vector<uint8_t> b((size_t) n);`);
      pre.push(`    if (n) env->GetByteArrayRegion(bytes, 0, n, (jbyte*) b.data());`);
      call = `toBytes(env, ${fn.name}(b.data(), (uint32_t) n))`;
      retC = 'jbyteArray';
      sig = '([B)[B';
    } else if (kind === 'bytesInBytesOut') {
      args.push('jbyteArray bytes');
      pre.push(`    const jsize n = bytes ? env->GetArrayLength(bytes) : 0;`);
      pre.push(`    std::vector<uint8_t> b((size_t) n);`);
      pre.push(`    if (n) env->GetByteArrayRegion(bytes, 0, n, (jbyte*) b.data());`);
      pre.push(`    uint32_t outLen = 0;`);
      pre.push(`    const uint8_t* p = ${fn.name}(b.data(), (uint32_t) n, &outLen);`);
      call = `toBytes(env, p, outLen)`;
      retC = 'jbyteArray';
      sig = '([B)[B';
    } else if (kind === 'block') {
      pre.push(`    const auto* p = ${fn.name}();`);
      pre.push(`    if (!p) return nullptr;`);
      call = `env->NewDirectByteBuffer((void*) p, (jlong) (${o.bytes}))`;
      retC = 'jobject';
      sig = '()Ljava/nio/ByteBuffer;';
    }

    L.push(`${retC} n_${fn.name}(JNIEnv* env, jclass${args.length ? ', ' + args.join(', ') : ''}) {`);
    if (!args.some((a) => /jbyteArray|jdoubleArray|jfloatArray/.test(a)) && kind === 'plain') {
      L.push(`    (void) env;`);
    }
    for (const p of pre) L.push(p);
    if (call !== null && call !== undefined) L.push(`    ${retC === 'void' ? '' : 'return '}${call};`);
    for (const p of post) L.push(p);
    L.push(`}`);
    L.push(``);
    fn._sig = sig;
  }

  L.push(`const JNINativeMethod kMethods[] = {`);
  for (const fn of fns) {
    if (shape(fn) === 'skip') continue;
    L.push(`    { "${fn.name}", "${fn._sig}", (void*) n_${fn.name} },`);
  }
  L.push(`};`);
  L.push(``);
  L.push(`}  // namespace`);
  L.push(``);
  L.push(`// Registered in one table at load. A name or signature that does not match`);
  L.push(`// the Kotlin object fails HERE — before an Activity exists, with the`);
  L.push(`// offending method named by the VM — rather than as an UnsatisfiedLinkError`);
  L.push(`// at whatever moment of a party first reaches it.`);
  L.push(`extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {`);
  L.push(`    JNIEnv* env = nullptr;`);
  L.push(`    if (vm->GetEnv((void**) &env, JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;`);
  L.push(`    jclass cls = env->FindClass("${PACKAGE.replace(/\./g, '/')}/Ttp");`);
  L.push(`    if (!cls) return JNI_ERR;`);
  L.push(`    const int n = (int) (sizeof(kMethods) / sizeof(kMethods[0]));`);
  L.push(`    if (env->RegisterNatives(cls, kMethods, n) != JNI_OK) return JNI_ERR;`);
  L.push(`    return JNI_VERSION_1_6;`);
  L.push(`}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Emit: the Kotlin object
// ---------------------------------------------------------------------------
function emitKt(fns) {
  const L = [];
  L.push(`// GENERATED by scripts/gen-jni.mjs — do not edit.`);
  L.push(`//`);
  L.push(`// The Kotlin half of the bridge; native/runtime/ttp_jni.cc is the other,`);
  L.push(`// emitted from the same parse in the same run.`);
  L.push(`//`);
  L.push(`// EVERY STRING IS A ByteArray, decoded UTF-8 by TtpJson — never a String`);
  L.push(`// across the boundary. See the C file's header for why jstring is wrong.`);
  L.push(`//`);
  L.push(`// The C spellings are kept against Kotlin convention so that one grep for`);
  L.push(`// ttp_display_build finds the header, the tvOS Swift call site, the web's`);
  L.push(`// Stage.js and this declaration together.`);
  L.push(`package ${PACKAGE}`);
  L.push(``);
  L.push(`import java.nio.ByteBuffer`);
  L.push(``);
  L.push(`@Suppress("FunctionName", "unused")`);
  L.push(`object Ttp {`);
  const bound = fns.filter((f) => shape(f) !== 'skip').length;
  L.push(`    /** Registers all ${bound} natives via JNI_OnLoad; a mismatch fails here. */`);
  L.push(`    fun load() { System.loadLibrary("ttp_runtime_android") }`);
  L.push(``);
  for (const fn of fns) {
    const kind = shape(fn);
    if (kind === 'skip') {
      L.push(`    // ${fn.name}: not bound — see OVERRIDES in scripts/gen-jni.mjs.`);
      continue;
    }
    let ps, ret;
    if (kind === 'plain') {
      ps = fn.params.map((p) => `${p.name}: ${isStr(p.type) ? 'ByteArray?' : SCALAR[p.type].kt}`);
      ret = isStr(fn.ret) ? 'ByteArray?' : fn.ret === 'void' ? 'Unit' : SCALAR[fn.ret].kt;
    } else if (kind === 'outN') {
      const lead = fn.params.slice(0, -1);
      ps = [...lead.map((p) => `${p.name}: ${isStr(p.type) ? 'ByteArray?' : SCALAR[p.type].kt}`),
            `${fn.params[fn.params.length - 1].name}: DoubleArray`];
      ret = 'Int';
    } else if (kind === 'floatOut') { ps = ['out: FloatArray', 'maxCells: Int']; ret = 'Int'; }
    else if (kind === 'namedBytes') { ps = ['name: ByteArray?', 'bytes: ByteArray?']; ret = 'Int'; }
    else if (kind === 'bytesIn' || kind === 'bytesInBytesOut') { ps = ['bytes: ByteArray?']; ret = 'ByteArray?'; }
    else if (kind === 'block') { ps = []; ret = 'ByteBuffer?'; }
    L.push(`    external fun ${fn.name}(${ps.join(', ')})${ret === 'Unit' ? '' : ': ' + ret}`);
  }
  L.push(`}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
const fns = declarations();
const cPath = join(RUNTIME, 'ttp_jni.cc');
const ktPath = join(ROOT, 'shells/androidtv/app/src/main/kotlin',
  PACKAGE.replace(/\./g, '/'), 'Ttp.kt');
const cText = emitC(fns);
const ktText = emitKt(fns);

if (process.argv.includes('--check')) {
  let stale = [];
  for (const [p, want] of [[cPath, cText], [ktPath, ktText]]) {
    let have = null;
    try { have = readFileSync(p, 'utf8'); } catch { /* missing counts as stale */ }
    if (have !== want) stale.push(p);
  }
  if (stale.length) {
    console.error(`stale (run node scripts/gen-jni.mjs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`gen-jni: ${fns.length} exports, both files current`);
} else {
  for (const [p, text] of [[cPath, cText], [ktPath, ktText]]) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  console.log(`gen-jni: ${fns.length} exports -> ${cPath}, ${ktPath}`);
}
