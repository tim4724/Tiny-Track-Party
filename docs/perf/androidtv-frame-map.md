# Where an Android TV frame's time goes

A dated measurement record, kept OUT of `shells/androidtv/CLAUDE.md` on purpose:
that file holds rules, and a number in it rots into a phantom regression for
whoever reads it next. What is durable about this session — the method, and the
three traps it walked into — lives there. What is a reading lives here, stamped.

Reproduce with the two commands that took it — the second is not optional, and
the last section says why:

```
node scripts/perf-frame.mjs --players 1,4 --track tidepool --pin 0.5
node scripts/perf-frame.mjs --players 1   --track tidepool --pin 1
```

The tool's header is the argument for every other choice below.

## Provenance

| | |
|---|---|
| Date | 2026-08-21 |
| Box | Google TV Streamer, Android 14 / API 34, PowerVR Rogue GE9215, armeabi-v7a |
| Panel | 1080p60 (quote the panel with any number here — 4K is a different frame) |
| Build | release, `1.0-4f70a4ae-dirty`, i.e. `4f70a4ae` plus this branch's instrumentation |
| Track | tidepool, `bench` scenario (autopiloted player seats at the back of a full grid) |
| Pins | render scale pinned, antialias pass OFF, present rate free (60 Hz panel) |
| Warm | not the first run after an install — that one measures dex/JIT and shader warmup |

## The frame, step by step

`sim` → `renderer` (`cars`…`endFrame`) → `slow` → `other` is one Choreographer
callback, in the order it runs them. Milliseconds, both pins at 960x540.

| Step | 1P p50 | 1P p95 | 4P p50 | 4P p95 | What it is |
|---|---|---|---|---|---|
| `sim` | 0.4 | 0.5 | 0.4 | 0.5 | `ttp_update`: the sim tick, the event drain, the audio decisions |
| `build` | 0.0 | 0.0 | 0.0 | 0.0 | `buildFrame`: the frame input the renderer is handed |
| `cars` | 0.6 | 0.6 | 0.6 | 0.6 | car poses, wheels, streaks, contact-shadow stamps |
| `world` | 0.2 | 0.3 | 0.2 | 0.3 | deck, terrain, dressing, sky, item and effect pools |
| ↳ `decalUp` | 0.2 | 0.2 | 0.2 | 0.3 | the deck decal upload, inside `world` |
| `skids` | 0.3 | 0.4 | 0.3 | 0.4 | the rubber layer: raster, dirty-rect uploads, mips |
| `ambient` | 0.0 | 0.0 | 0.0 | 0.0 | the per-camera particle box |
| `beginFrame` | 0.4 | 0.6 | 0.6 | 1.0 | merged-draw transform mirroring, then `Renderer::beginFrame` |
| `cellSetup` | 0.0 | 0.1 | 0.2 | 0.3 | per cell: camera, fog, billboards, the monster swap |
| `cellRender` | 0.4 | 0.6 | 1.5 | 1.8 | per cell: cull and command GENERATION |
| `present` | 0.2 | 0.3 | 0.1 | 0.2 | the antialias pass (off here) and the cell overlay |
| `endFrame` | 0.1 | 0.1 | 0.1 | 0.1 | the commit |
| `slow` | 0.0 | 0.9 | 0.0 | 0.8 | the ~6 Hz HUD poll, the knob poll, the pacing declaration |
| `other` | 0.0 | 0.1 | 0.0 | 0.0 | the resize latch and the loop itself |
| **renderer** | **2.2** | 2.6 | **3.6** | 4.3 | all of `ttp_display_frame` |
| **callback** | **2.7** | 3.6 | **4.2** | 5.1 | the whole callback; Compose runs AFTER it and is in none of it |

Reproduced to 0.1 ms across four runs. **The main thread is not the problem and
never was**: 4.2 ms of a 16.7 ms budget at four players, and `cellRender` is the
only step that scales with cells.

## The threads, and the one that matters

CPU milliseconds per PRESENTED frame, off `/proc/<pid>/task/*/stat`.

| Thread | 1P | 4P |
|---|---|---|
| `FEngine::loop` — Filament's backend, GL command EXECUTION | 7.1 | **14.5** |
| the app's main thread, total (the callback above plus Compose) | 3.3 | 6.4 |
| `ttp-mix` — the audio mixer | 0.3 | 1.8 |
| `OpenGLTimerQuer` — the instrument's own cost | 0.6 | 0.8 |

The backend thread is 3.5x the main thread at four players and runs concurrently
with it, so it does not add to the table above — it BOUNDS it. Nothing
in-process can see it: not `ttp_display_profile`, not the readout, not `atrace`'s
app markers.

## The cadence and the GPU

| | 1P @ 540 | 4P @ 540 | 1P @ 1080 |
|---|---|---|---|
| presented | 59.4 fps, 0.6 skips/s | 33.1 fps, 26.3 skips/s | 28.4 fps, 29.9 skips/s |
| gpu p50 / p95 | 13.5 / 17.4 (PACED — see below) | 25.8 / 31.2 | 29.8 / 34.0 |

## What each group of the picture costs

MARGINALS — the whole frame minus that group's arm. **They do not sum to the
frame**: the groups occlude each other, so the overlaps are counted in no row.
The older by-SUBTRACTION figures elsewhere are a different quantity; do not
compare them row for row.

| Group | 4P @ 540 (25.8 ms) | 1P @ 1080 (29.8 ms) |
|---|---|---|
| road | 5.2 | **13.3** |
| dressing | 4.5 | 0.1 |
| terrain | 3.2 | 0.6 |
| cars | 1.1 | **-2.3** |
| sky | 0.8 | -0.0 |
| effects | -1.4 | 0.4 |
| floor (every content group off) | 3.2 | 5.0 |

Resolution: the unablated arm was run first AND last, either side of every other
arm, and the two agree to **0.2 ms**. Nothing narrower than that is a result.

Two readings worth stating in words:

- **The cars are a net NEGATIVE at one player**, which is the ranking
  `native/renderer/CLAUDE.md` documents from the web and which had never been
  confirmed on this GPU. They occlude more deck than they cost to draw.
- **Dressing and terrain cost almost nothing at 1 player and several
  milliseconds at 4**, while the 1-player pin has FOUR TIMES the fill. A cost
  that scales with CELLS and ignores pixels is submission, not shading — see
  the next section.

## THE 1-PLAYER 540-LINE COLUMN CANNOT BE PRICED, and this is why there are two

At 1P/540 the box presents on nearly every vsync. The GPU idles, it downclocks
into the gap, and this backend's timer reads the PACED span rather than the
work — so every arm came back at 13.5 ms whatever it dropped, and hiding the
ROAD read 2.9 ms SLOWER than drawing it. That is why the one-player group costs
above are taken at 1080 lines, where the same picture saturates. The step table
and the cadence for 1P stay at 540, because that is the operating point a player
is actually at.

`perf-frame.mjs` names any column this applies to rather than leaving it to be
noticed.
