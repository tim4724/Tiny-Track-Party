// The display-name cap: the one wire limit that is NOT the relay's.
//
// A name is the only free-text field on the wire. It is authored on the phone
// (the name form, the CouchPad launcher's cpName, a live rename) and
// re-clamped on the display, where a HELLO from any peer is untrusted input.
// Both sides used to state the cap themselves — controller/main.js sliced to 16,
// display/Net.js sliced to 16 again, without the trim — so this module is the
// single source, in the same spirit as protocol.js's shared numbers.
//
// Dependency-free on purpose: it loads in the browser (both pages import it) and
// in Node, so tests/wire-compat.test.js can drive the REAL producer through the
// wire instead of re-typing its arithmetic.
//
// THE SLICE IS BY UTF-16 CODE UNIT, which is JS's default and which cuts a
// trailing emoji in half. That is pinned CURRENT behaviour, not desired
// behaviour: tests/wire-compat.test.js's emoji test drives this function and
// asserts what the half-emoji does to the C++ display (three U+FFFD on the TV).
// Slice by code POINT here instead and that test goes red, because it reads this
// function rather than a copy of the expression.
export const NAME_MAX = 16;

// null/undefined -> ''. Non-strings are stringified first: the display half runs
// on whatever a peer put in the HELLO, which is not guaranteed to be a string.
export function cleanName(n) {
  return (n == null ? '' : String(n)).trim().slice(0, NAME_MAX);
}
