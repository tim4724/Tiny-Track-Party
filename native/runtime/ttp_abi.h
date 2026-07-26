// ttp_abi.h — the conventions every Tiny Track Party C ABI follows, and the
// macro that exports it. Shared by ttp_runtime.h (sim) and ttp_party.h (party)
// so the Swift, Kotlin and JS shells have ONE mental model and the export
// mechanism has one definition.
//
// CONVENTIONS
//  - Handles are ints > 0 (0 = failure). An unknown or disposed handle is a safe
//    no-op: queries return 0 / "null" / an empty array.
//  - Identities cross as JSON SCALARS in a C string: the token `3` is the number
//    3, `"abc"` the string abc. Numbers and strings are DISTINCT identities,
//    exactly like JS. "null" / nullptr is absent; so is any malformed text.
//  - Opaque caller data (stats, player fields) crosses as a JSON object, or null
//    for the defaults.
//  - Every const char* return points into a per-handle scratch buffer valid ONLY
//    until the next ttp_* call on that handle — copy it out at once (JS
//    UTF8ToString does). The version getters use their own static buffers.
//  - Returned JSON is CANONICAL: recursively sorted keys, ECMA-262 shortest-form
//    numbers — byte-identical to the trace serializer, so fnv1a of a returned
//    snapshot matches a recorded frame hash.
//  - Events are not callbacks: they queue and drain as a JSON array in exact
//    emission order. Drain after EVERY mutating call — intra-op order is
//    load-bearing.
#ifndef TTP_ABI_H
#define TTP_ABI_H

// Every entry point is tagged TTP_ABI. Under emscripten that is
// EMSCRIPTEN_KEEPALIVE, which exports the symbol from the wasm module; the
// declaration IS the export list, so there is no second list to forget. (It used
// to be ~100 names on one -sEXPORTED_FUNCTIONS line in native/CMakeLists.txt,
// where a missed name failed only in the browser, at the cwrap call.) On the
// native/tvOS/Android legs it expands to nothing.
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define TTP_ABI EMSCRIPTEN_KEEPALIVE
#else
#define TTP_ABI
#endif

#endif  // TTP_ABI_H
