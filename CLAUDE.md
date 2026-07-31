# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This file is deliberately **general**. Detailed rules live in a `CLAUDE.md` next
to the code they govern, and load when you work in that directory — see
[Where the detailed rules live](#where-the-detailed-rules-live). Put a new rule
beside its code, not here; this file only holds what applies everywhere.

Keep all of it durable. A number that will drift, a date, or a test function name
does not belong in any of these files: state the rule, name the gate that
enforces it, and let the code carry the value.

## Commands

```bash
npm run setup                     # Make a FRESH WORKTREE ready: deps + native/build.
                                  # Idempotent, and it reports what is missing.
npm test                          # Lint + unit tests (node:test)
node --test tests/track.test.js   # A single unit test
npm run test:native               # Native conformance: builds, then runs ctest -j
                                  # (plain `ctest --test-dir native/build` also works,
                                  # but is serial and will run stale binaries)
npm run test:native -- -R raceflow    # One ctest by name
npm run test:native -- -R "^record_"  # Re-record roundtrips (byte identity)
node --test tests/wire-*.test.js  # Wire-compat only (C++ host vs the JS phone)
npm run test:e2e                  # Playwright E2E (real pages + hermetic relay stub)
npx playwright test tests/e2e/flow.spec.js   # A single E2E spec
npm run check:artifact            # Is the checked-in wasm current?
npm start / npm run dev           # Serve (with --watch)
native/scripts/build-runtime-web.sh   # Rebuild the engine wasm → public/display/engine/native/
```

`npm run setup` is the only command a fresh worktree needs, and it prints the
current inventory. Prefer it over rediscovering what is missing from a failure.

## What this is

A couch party game: 1–4 phones become tilt controllers for one shared screen.
The display browser is **authoritative** — it runs the race simulation and
broadcasts state to every phone over a WebSocket relay, with steering input on a
WebRTC fastlane. `server/index.js` serves static files and JSON endpoints only:
no game logic, no WebSocket.

## Architecture

**The engine is NATIVE.** The sim, the cup series, the party layer's decisions,
the UI model, the audio decisions, the track builder and the renderer are all
C++ compiled to wasm (`native/`), loaded from `public/display/engine/native/` by
the `Native*.js` adapters. There is **no JS engine and no fallback**. The JS twins
were deleted once each layer was conformance-proven; git history has them.

**Still JS by design** — do not "finish the port" on these:
- the HUD/screens **rendering** (`main.js`, `Stage.js`); their decisions are C++
- the track **descriptors** (`shared/tracks.js`, `shared/devTracks.js`) — authored
  data, codegen'd into the wasm
- the audio **device** half and the DSP palette
- the whole **controller** page — phones stay on the JS controller on all three
  TV platforms, forever
- the transport **I/O** (`partyplug/PartyConnection.js`, `PartyFastlane.js`)

`partyplug/` is a reusable party-game transport kit shared across games, served
under `/partyplug/`. 3D assets are the Kenney Toy Car Kit under
`public/assets/toycar/` — `toycar` names the asset pack, not the game.

Browser code is ES modules. Modules Node imports directly via dynamic `import()`
(`shared/tracks.js`, `shared/devTracks.js`, `shared/protocol.js`,
`engine/contract.js`) must stay dependency-free so they load in both browser and
Node. CSP headers live in `server/index.js` — update them when adding external
resources. There is no nonce and no inline script: every script is a same-origin
file, so `script-src` is `'self' 'wasm-unsafe-eval'`.

## The rules that outrank local detail

These six apply everywhere. Everything else is in a subtree file.

**1. One source per shared number.** A constant two layers must agree on is
declared once and read from there — never re-typed with a "keep in sync" comment.
`public/shared/protocol.js` is that source for the wire, tilt and presence
contracts, and a new shared number is added there first. If you are typing a
constant that also exists in a `.mjs`, a `.h`, or a fixture, read it instead. See
`public/shared/CLAUDE.md`.

**2. C++ decides, the shell performs.** Every layer is split the same way: pure
decision functions in C++ returning plain data or an ordered effect list, and a
shell that performs sockets, timers, DOM and audio devices while deciding
nothing. A shell that has to re-derive a rule from prose is the bug.

**3. Cross-layer reads go through a seam, never through the shell.** If you are
about to pull state out of one wasm layer only to hand it straight to another,
add a seam accessor in C++ instead. See `native/CLAUDE.md`.

**4. The corpora are frozen cross-implementation evidence.** They were recorded
against the JS engine while it existed. **Never re-record them from C++** — that
would only prove C++ matches itself. If a replay disagrees, the committed file is
right and the port is wrong. See `tests/CLAUDE.md`.

**5. Bit-exactness is the contract.** The strict-FP flags (`-ffp-contract=off`,
`-fno-builtin`) are why four platforms agree to the bit. **Never add fast-math**,
and never swap a math call for a faster one that is not bit-identical.

**6. After touching `native/`, rebuild and commit the artifact.**
`public/display/engine/native/ttp_runtime.{mjs,wasm}` and the `*.filamat` blobs
are CHECKED IN and are what the browser actually runs. Run
`native/scripts/build-runtime-web.sh`, then `npm run check:artifact` (one test)
rather than a full `npm test`. Batch the whole `native/` edit before rebuilding —
the stamped hash is over bytes, so comment-only edits count.

## Look and feel

UI is the **"Sticker Bash"** theme: die-cut stickers on the TV glass — flat
colour on warm paper, thick warm-ink outlines (`--ink`, never `#000`), hard
zero-blur offset shadows, slight rotations. Chrome colours are
**red/green/blue/purple ONLY** — yellow/amber and pink are vetoed in chrome
(liveries only; celebration is RED).

Design tokens and reusable bits (`.card .btn .chip .pill .field`, the `.wordmark`
badge, the `.scene` paper stage) live in `public/shared/theme.css`, `<link>`ed by
both display and controller before their page CSS. Build new UI from those
tokens and classes: page CSS owns layout, the theme owns colour/type/surface.

**Never outline or toon-shade anything inside the 3D scene.** Paper backgrounds
belong only on full-screen boards — chrome floats bare over the live 3D view.
Fonts are self-hosted variable woff2 (SIL OFL) so the CSP keeps `font-src 'self'`.

## Where the detailed rules live

| File | Covers |
|---|---|
| `native/CLAUDE.md` | C++ layering, who may link what, ABI conventions, seams, the track builder, the artifact, the build |
| `native/renderer/CLAUDE.md` | Filament, cell framing and lens, decals, the renderer's HUD elements, the frame budget |
| `native/libttp-runtime/CLAUDE.md` | the decision layers: ui model, race orchestration, audio decisions, biome theme, the asset gallery |
| `native/libttp-party/CLAUDE.md` | session policy, the retained room snapshot, liveness and teardown |
| `tests/CLAUDE.md` | conformance: the two fixture classes, frozen corpora, trace blind spots, wire-compat, the suite audits |
| `public/display/CLAUDE.md` | the browser shell: adapters, boot and back-stack, the audio device half, measuring frame cost |
| `public/shared/CLAUDE.md` | the protocol manifest, design tokens as data, the schematic codec |
| `public/assets/audio/CLAUDE.md` | cues are generated, music is acquired; the MP3 and re-encode traps |
| `docs/native-port/shells.md` | the audited ledger of what a new TV platform still owes |

## Dev loop

This tree is worked in **many git worktrees at once**, and `node_modules` +
`native/build` are per-worktree and gitignored, so the cold cost is paid over and
over. `npm run setup` is the one command that fixes that; `native/CLAUDE.md`
covers the caching that keeps rebuilds cheap.

**Measure CPU seconds, not wall-clock.** Concurrent worktrees swing wall-clock by
well over 100%, so a reading taken while another build runs is noise — quote
`user`+`sys`, or the min of three runs. For the same reason nothing here records
expected durations: they rot, and a stale one sends someone chasing a phantom
regression. Time the command yourself and compare against a second run on the
same machine.

## Deploys

Every push builds and deploys a preview to
`https://tinytrack-<branch>.couchpad.games` (`.github/workflows/preview.yml`).

The engine wasm is a committed binary, so two branches that both touch `native/`
will conflict on `ttp_runtime.wasm`. The artifact is wholly derived from
`native/`, so which side you keep is irrelevant: take either, re-run
`native/scripts/build-runtime-web.sh`, commit. Never hand-merge the binary.
