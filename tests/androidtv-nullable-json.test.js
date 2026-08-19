// Android's `org.json` turns an explicit JSON null into the STRING "null".
//
// `JSONObject.optString(key)` delegates to `JSON.toString(opt(key))`, which is
// `String.valueOf(value)` for anything non-null — and `JSONObject.NULL` is a
// non-null Java object whose toString is "null". So a key the engine spelled as
// JSON null reads back as four characters, and `.ifEmpty { null }` — the obvious
// guard, and the one this shell used — never fires, because "null" is not empty.
//
// NEITHER SIBLING SHELL CAN SHOW YOU THIS. Swift's `as? String` gives nil and JS
// gives null, so a transcription that is faithful line-for-line is still wrong,
// and wrong SILENTLY: `forceItem` became the literal string on every race, so
// every item box in every race rolled an item named "null", whose code is 0. The
// phones' USE buttons lit, the TV's slots stayed empty, and nothing failed.
//
// A runtime check cannot cover this. Whether a phone drives over an item box in
// a scripted race is chance, so the party check's item gate is real but flaky,
// and the OTHER keys here (a shard instance, a cupless catalogue row) need a
// deployment or a config this suite does not have. The property is static, so
// the gate is static: `TtpJson.optStr` exists, and no shell file may read one of
// these keys any other way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const KOTLIN = join(
  __dirname, '../shells/androidtv/app/src/main/kotlin/games/couchpad/tinytrack');
const ABI_SOURCES = ['native/runtime', 'native/libttp-runtime/ttp', 'native/libttp-party/ttp'];

// Tokens.kt reads the STAGED design-tokens.json, which is not an engine payload
// and has no JSON nulls in it. It is the one file here that parses something the
// C++ never wrote, so a key name it happens to share ("name") means nothing.
const NOT_AN_ENGINE_PAYLOAD = new Set(['Tokens.kt']);
const ROOT = join(__dirname, '..');

// Derived, never hand-listed: a re-typed list would drift on the first ABI that
// grows a nullable field, which is exactly the kind of drift this file exists to
// catch. Two spellings produce one — a direct `Value::Null()` and the `valOf`
// writers over the engine's optional types.
function nullableKeys() {
  const keys = new Set();
  for (const dir of ABI_SOURCES) {
    const abs = join(ROOT, dir);
    for (const f of readdirSync(abs).filter((n) => n.endsWith('.cc'))) {
      const src = readFileSync(join(abs, f), 'utf8');
      for (const re of [
        /set\("([A-Za-z]+)",[^;]*Value::Null\(\)/g,
        /set\("([A-Za-z]+)",[^;]*\bNull\(\)/g,
        /set\("([A-Za-z]+)", *valOf\(/g,
      ]) {
        for (const m of src.matchAll(re)) keys.add(m[1]);
      }
    }
  }
  return keys;
}

test('no Kotlin reads a nullable engine key with optString', () => {
  const nullable = nullableKeys();
  assert.ok(nullable.has('forceItem'), 'the derivation itself broke — forceItem is nullable');
  assert.ok(nullable.has('instance'), 'the derivation itself broke — instance is nullable');

  const offences = [];
  for (const name of readdirSync(KOTLIN)
      .filter((n) => n.endsWith('.kt') && !NOT_AN_ENGINE_PAYLOAD.has(n))) {
    const src = readFileSync(join(KOTLIN, name), 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\.optString\("([A-Za-z]+)"/g)) {
        if (nullable.has(m[1])) offences.push(`${name}:${i + 1}  optString("${m[1]}")`);
      }
    });
  }

  assert.deepEqual(offences, [],
    'these keys can be JSON null, and optString would read them as the string "null".\n' +
    'Use TtpJson.optStr:\n  ' + offences.join('\n  '));
});
