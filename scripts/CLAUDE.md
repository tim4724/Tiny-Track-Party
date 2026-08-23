# scripts/ — the bakes

Everything here that makes a picture obeys one principle: **render the real thing
offline and commit the pixels.** Nothing draws a picture *of* the game. The
wordmark renders through the shipping `theme.css`; the cues render through the
shipping AudioWorklet; the shelf art is a screenshot of the actual renderer; the
schematics are projected by the actual wasm. That is why the outputs can be
trusted, and it is not negotiable — a hand-traced twin of any of them is a second
source that moves when the first one does not.

## Driving a browser: use `lib/capture.mjs`

Anything here that drives a page goes through the seam — a bake, and equally a
measurement tool like `lobby-fit-check.mjs` — and does not stand up its own
server or launch its own Chromium. Two traps live in that plumbing and both are
**invisible when you get them wrong**: the pictures come out looking entirely
plausible, and the measurements come out looking clean.

**The automation trap.** `Stage.js` changes two things when `navigator.webdriver`
is set: it caps the render scale at 0.25, and it skips the sun's shadow bake.
Correct for the E2E suite, which asserts DOM and engine state and never pixels.
Ruinous for a capture. `?dpr=` lifts the render scale; **the shadow skip has no
URL knob**, so the only way back is a page that believes it is an ordinary tab.
`launchBrowser()` does both by default. A caller that genuinely wants the
automation path — a bench measuring what a frame costs — passes
`realUser: false` and says why.

**The port trap.** This tree is worked in many worktrees at once, so a literal
port number is not a race, it is a standing collision: the capture connects to
another worktree's dev server and photographs a different branch — or measures
it. `serveApp()` allocates, and stands the server up for you. Never write a port
literal here, and never make the caller start a server by hand: a script that
does dies in an unhandled rejection when one isn't there.

The seam also owns `waitForScene` (wait, never sleep — a cold Filament shader
compile behind a `setTimeout` yields half-loaded scenes and nobody notices for a
week), `hideChrome` (the steer bar is drawn by C++, so CSS cannot hide it —
`cellCards` is the seam that can), and `encode` (Chromium has the JPEG and WebP
encoders; Node does not, and this repo does not need an image dependency for a
dev-only tool).

## Naming and homes

`bake:*` renders and commits. `shots:*` photographs a platform for the screens
gallery. `gen:*` derives text. Outputs land under `public/assets/<family>/`, and
`artwork/` is for things a human takes away rather than things the game ships.

## What guards each output

Nothing here diffs pixels, on purpose: a pixel gate over a Filament scene under
software GL is a flake factory that says less than it appears to. The gates are
**coverage, size and freshness** instead, and every baked family has one —
`codegen-freshness` for the derived text, `bake-cues` for the cue bytes,
`shots-manifest` for the screens, `artwork-manifest` for the brand stills.
Judging the pictures is what the galleries are for.

Adding a bake means adding it to whichever manifest its family already has. A
bake with no manifest entry is a bake nobody is looking at, which is how a top
shelf sat as a paper drawing and a carousel shipped at half the resolution it
needed.
