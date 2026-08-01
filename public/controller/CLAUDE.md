# public/controller/ — the phone

## The rule that outranks everything here

**Nothing in the controller becomes C++. Ever.** Phones stay on this JS
controller on all three TV platforms, so there is no port coming and no shell to
split a decision layer out for. Root rule 2 ("C++ decides, the shell performs")
is about the DISPLAY's stack — do not read it as an invitation to move this
page's decisions behind a wasm seam. Improving the JS here is the permanent
answer, not a stopgap.

The consequence worth internalising: this page has the least conformance cover in
the tree. There are no frozen corpora for it and no bit-exactness gate. What
holds it is `tests/wire-compat.test.js` (real `partyplug/` + these modules
against a modelled relay), the E2E specs, and the gallery scenarios — so a change
here earns its evidence from the real app, not from a replay.

## What lives where

`main.js` is the SESSION: this phone's view of the room (identity, roster, pick,
which screen we belong on) and the routing that holds it in step with the
display's retained snapshot. Everything self-contained sits beside it —
`launcher.js` (the whole CouchPad shell contract, so the rest reads as a plain
web page), `modals.js` (both popups plus the ordering rules that only make sense
against each other), `driveSurface.js`, `linkStatus.js`, `resultsBoard.js`,
`prefs.js`.

Add a new concern as its own file. The failure mode this split fixed was
nineteen unrelated concerns sharing one module scope, which is a thing that
regrows one convenient module-level `let` at a time.

## Previews render through the live renderer, never a copy of it

`TestHarness.js` drives one screen from fake data for the gallery. It must
synthesize the INPUT a real screen gets and call the same function the live page
calls. It used to hand-roll its own results markup and had already drifted from
the real board in two places.

That trades a loud failure for a quiet one — a renamed payload field answers a
plainer dressing instead of throwing — so every dressing the harness can reach is
pinned by `tests/e2e/gallery-controller-boards.spec.js`.

## The display is authoritative

The phone renders what the snapshot says and sends requests. Every local change
(car pick, ready flag, mode) is OPTIMISTIC and the next `LOBBY_UPDATE` is the
source of truth; nothing here validates a move on the display's behalf. The
phone bundles no game content — tracks, cars and the livery palette all ride the
snapshot, so a phone can never diverge from a differently-versioned display.
