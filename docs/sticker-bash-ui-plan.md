# Sticker Bash — UI reskin implementation plan

Replace the "Sunny Circuit" theme with the decided **Sticker Bash** design language across
display + controller, in **ONE PR** that lands the complete new look. **The 3D canvas,
engine, and networking are never touched** — this is a DOM/CSS reskin riding the existing
token architecture (`public/shared/theme.css` kit).

No feature flag, no dual-theme machinery: edit the theme in place. The branch preview deploy
(`https://tinytrack-<branch>.couch-games.com`) is the review/party-test surface before merge;
the old theme lives on in git history.

Design mockups live in a private artifact (ask Tim if you need to see them); this document
is self-sufficient — every visual decision is specified below.

---

## 1 · The design language (locked — do not re-litigate)

The UI is **die-cut stickers on the TV glass**: flat saturated colour on warm paper, thick
warm-ink outlines, hard *un-blurred* offset shadows, everything slightly rotated as if
slapped on by hand.

### Tokens

| Token | Value | Role |
|---|---|---|
| paper | `#FFF6EB` | full-screen board background (lobby pre-pick, results, phone) |
| ink | `#2A2735` | outlines, text, dark chips — **never pure `#000`** |
| red | `#FF5040` | energy, celebration (cup stickers, podium headers, wordmark accent), BRAKE |
| green | `#22C46E` | go / ready / primary CTA |
| blue | `#339CF2` | info |
| purple | `#A259E6` | items (ITEM button, item accents) |

**Vetoed by Tim — never use in chrome:** yellow/amber and pink. They exist only as in-game
liveries (`CAR_COLORS` in `shared/protocol.js` stays untouched). Celebration is RED.

### Surface rules

- Sticker card: white bg, `3px solid ink` border, radius 12–22px, shadow `Npx Npx 0 rgba(42,39,53,.13–.22)`
  (hard offset, **zero blur**). Small chips 3px/3px, big cards 7px/7px.
- Rotations: ±1–3° on stickers/badges; alternate signs between neighbours. Never rotate text blocks users must read for long (lists).
- Buttons: coloured bg, 3px ink border, white text, pressed = `translateY` onto a ledge
  `box-shadow: 0 6px 0 rgba(42,39,53,.9)` → `0 2px 0` when active (mirror existing `.btn` mechanics).
- Pills/labels: ink bg, white text, 999px radius, 11px 600 letterspaced caps (e.g. "JOIN AT", "LAP 2/3").
- Open/empty slots: `3px dashed rgba(42,39,53,.45–.55)`, muted text `#a49a86`.
- Type: **Fredoka 600–700** for everything display-ish (already self-hosted); Nunito only for rare running text. Chunky sizes; all-caps for sticker labels, sentence case for helper copy.

### The three fit-with-3D rules (why the style works over the renderer)

1. **Outlines belong to the chrome, not the world.** Every outlined element sits on a white
   sticker surface. Never outline, toon-shade, or decal anything inside the 3D scene.
2. **Warm ink, not black** — `#2A2735` matches the tyres/baked shadows in the render.
3. **Paper only on full-screen boards.** The moment the 3D world is visible (track preview,
   race), chrome floats directly on it — no paper panels edge-to-edge with the render.

### Wordmark (locked)

One die-cut badge, NOT a row of pills, NOT plain text:

```html
<div class="wordmark"><span>TINY TRACK</span><span class="l2">PARTY!</span></div>
```
```css
.wordmark { font-family: var(--font-display); font-weight: 700; line-height: .98;
  color: var(--ink); letter-spacing: .01em;
  -webkit-text-stroke: 7px #fff; paint-order: stroke fill;   /* white die-cut edge */
  transform: rotate(-2deg); filter: drop-shadow(3px 3px 0 rgba(42,39,53,.22)); }
.wordmark span { display: block; }
.wordmark .l2 { color: var(--red); font-size: 1.24em; }
```
Graceful degradation: without `paint-order` support it renders as plain ink text — acceptable.
Scale by context (TV lobby ≈ 25/31px, controller name screen ≈ 28/35px).

---

## 2 · Work order (one PR, commit per phase)

Do the phases in order — each leaves the app fully working, so commit at each checkpoint
and verify before moving on. Total diff: `theme.css`, `display.css`, `controller.css`,
both `index.html`s, `lobbySeats.js`, small hooks in `display/Net.js` + `display/main.js`.

### Phase A — tokens + component kit + paper stage (`public/shared/theme.css`)

Rework `theme.css` in place:

1. `:root` tokens: `--brand:#22C46E; --accent:#FF5040; --danger:#FF5040; --ink:#2A2735;
   --surface:#fff; --surface-2:#FBF0DF; --hairline:#2A2735;` plus new
   `--item:#A259E6; --paper:#FFF6EB;`. Note `--accent` changes meaning from amber→red —
   check every consumer (`.btn--accent` currently sets `color: var(--ink)` for contrast on
   amber; with red it must become `color:#fff`). Remove the amber/sunny-only tokens
   (`--sun`, sky/grass gradient values move to the new stage colours below).
2. Reskin the kit: `.card` (3px ink border, hard 7px shadow), `.btn` (ink border, hard ledge,
   Fredoka 700), `.icon-btn`, `.chip`, `.pill` (ink bg/white text version), `.field`, `.dot`.
3. Replace the `.scene` diorama: paper bg, flat grass band (`#A9DF83`, rounded top),
   2 sticker clouds (white, 3px ink outline — pure CSS: pill body + two
   `clip-path: inset(0 0 40% 0)` outlined circles), 3–6 confetti rects (9×15px, radius 3,
   rotated, colours red/green/blue/purple). **No sun** (it was yellow). Keep the `.scene__*`
   child structure/classnames; restyle them.

Checkpoint: every display/controller screen renders in rough sticker style via the kit;
nothing overlaps or breaks (`?scenario=welcome|lobby|racing`, `gallery-controller.html`).

### Phase B — TV lobby: left-rail ticket layout

Files: `public/display/display.css`, `public/display/index.html`,
`public/display/lobbySeats.js`, small hooks in `public/display/main.js` / `display/Net.js`.

Layout (both lobby states — chrome positions NEVER move between them):

- **Wordmark** top-left (~34,20), replacing the current `h1` ("Tiny Track <span>Party</span>").
- **Join ticket** on the left rail (~x:30 y:96, width ~192px scaled to viewport): ONE sticker
  card containing, stacked: QR canvas (`#qr`, ~158px), join URL (`#joinurl`, one line,
  ~12.5px 600), room-code tiles — the 4 code chars as coloured letter tiles
  (red/blue/green/purple, 26×29px, 3px ink border, alternating ±2° rotation).
  `renderJoinUrl` (`display/Net.js:722`) already splits URL vs code — extend it (or wrap it)
  to emit the tile row instead of the inline highlighted code. Keep the whole ticket
  clickable-to-copy (today's `#joinbox` behaviour) and keep `aria-label`.
- **Cup slot** right rail (~right:34 y:100–210): pre-pick = dashed slot with
  "<host name> picks the cup on their phone…"; post-pick = red cup sticker (cup name, white
  text, −2° rotation) + white "N races" pill + 4 difficulty pips (existing tendency data;
  filled pips red). Wire to the same state that currently drives the track-pick UI.
- **Centre**: pre-pick = red tagline sticker "GRAB YOUR PHONES!" + sub "race starts when
  everyone's ready" (−3°, ~26px). Once the host picks (the `#scene` preview reveals), hide
  the tagline — the island preview owns the centre. The existing `.is-dim` crossfade already
  handles the backdrop swap.
- **Seat dock** bottom-centre: keep `renderSeats()` DOM (car thumb, name, ready check, host
  star, connected-dim) but restyle as a horizontal dock of sticker chips: white pill, 3px ink
  border, livery dot, mini car thumb (~44px), green ✓ ready badge (2.5px ink border), gold ★
  with ink stroke for host. Open seats: dashed pill, "Open". MAX_PLAYERS is 4 — the dock
  never wraps. Update the static open-seat placeholders in `display/index.html` to match
  (they must stay in sync with `lobbySeats.js`, see comment at top of that file).
- Keep: `#device-choice` (restyled by kit), `#count` headline (place above the dock),
  `.version-badge`, sound hint, toast.

Checkpoint: `?scenario=lobby` (pre-pick paper stage) and `?scenario=track` (chrome over live
preview; confirm the ticket/cup/dock do not move between the two). Check 1-, 2-, 4-player
rosters via the gallery player-count control, long names, and a narrow-ish window.

### Phase C — controller screens

Files: `public/controller/controller.css`, `public/controller/index.html` (wordmark markup on
the name screen only).

- **Name screen**: wordmark badge replaces the `h1`; input = sticker field; "Join race" =
  green sticker button.
- **Lobby**: `#me-name` as livery-tinted name sticker (coloured bg, white text, −2°);
  `.car-card` hero = sticker card (stat bars: 10px tracks, 2.5px ink border, fill in the
  player's livery colour); `#carpick` tiles = sticker tiles, active = pale blue `#E7F2FF` bg +
  hard shadow; `#trackpick` mode chips = white sticker chips, active = green; `#ready-btn` =
  big green sticker button ("I'M READY!" / host "START RACE").
- **Drive**: `#hud-name` name sticker + latency chip as white sticker pill; steer strip =
  30px white pill, 3px ink border, centre tick, fill in livery colour; `#action-btn` (ITEM) =
  **purple** `#A259E6` sticker button (it is amber today — this is a deliberate change);
  `#brake-btn` = red. Both keep the hard ledge press. Drive background: paper tinted toward
  the player's livery (e.g. `color-mix(in srgb, var(--car) 12%, #FFF6EB)`).
- **Results / overlays**: results list rows as sticker rows; pause/help/motion/conn overlays
  inherit the kit — verify the help popup's mini demo phone (ITEM chip must go purple too:
  `.help-chip--item`, `.mini-btn--item`).
- Metas: `theme-color` `#a8e2ff` → `#FFF6EB` (paper). `cg-accent-color` stays livery-driven
  (main.js retints it).

Checkpoint: `gallery-controller.html` scenarios + a real phone joined to a locally served
room (`PORT=<free> node server/index.js`).

### Phase D — race chrome (display)

File: `public/display/display.css` (the HUD is already DOM; hooks exist), plus one
debug-panel entry in `display/main.js`.

The split-screen HUD elements are DOM overlays created in `SceneRenderer.js` (~line 1430):
`.cell-label` (name + `.cell-label__item` item slot), `.cell-rank` (`__place`/`__lap`),
`.cell-steer` (`__fill`), `.cell-finish`. Each carries `--c` (livery colour). Restyle:

- `.cell-label__name` → white sticker tag, name text in `var(--c)`, −2° rotation.
- `.cell-label__item` → 44px sticker slot: dashed ink when `.is-empty`, solid white sticker
  with hard shadow when holding an item.
- `.cell-rank` → white sticker badge for the ordinal ("2nd", ~25px Fredoka 700) over an ink
  pill "LAP 2/3" (+1.5° rotation, top-right of cell).
- `.cell-steer` → 150×20px white pill, 3px ink border; `__fill` in `var(--c)`.
- `.cell-finish` → sticker card (badge/place/time).
- **Cell dividers**: chunky ink lines (4px, `rgba(42,39,53,.88)`) between cells. Default ON,
  with a debug-panel toggle (`initDebugPanel` in `main.js` — add a boolean like the existing
  entries) so it can be A/B'd at a party. (Open decision #1 below.)
- `#countdown` numerals: sticker treatment — ink text with white die-cut stroke (same
  technique as the wordmark), keep the existing `is-go` animation.
- `#pause-overlay` `.pause-card`, `#results` (list rows, `.results-podium` cup podium: livery-
  coloured blocks with 3px ink borders + rank numerals, red "…CHAMPS!" header sticker,
  `.results-sub`, `.results-next`), music credit chip, pause icon-btn — all via kit + small rules.
- Confetti: static CSS confetti on results/podium boards only (see open decision #2).

Checkpoint: `?scenario=racing|countdown|results|intermission|podium`; run one full race with
AI (`?scenario=racing`) and eyeball label/rank/steer positioning at 1/2/4 players (the
elements are positioned per-frame by `_loop` in px — only their inner size changes, but
confirm nothing overflows its cell at 4-up).

### Phase E — motion pass + docs

- Slap-in animation for stickers on screen transitions: scale 1.15→0.96→1 with slight rotate
  overshoot, ~240ms, `cubic-bezier(.2,1.5,.35,1)`; apply on lobby entry, results reveal, cup
  sticker fill-in, countdown digits. All inside `@media (prefers-reduced-motion: no-preference)`.
- Update the theme line in `CLAUDE.md` (and README if it mentions Sunny Circuit): the theme
  is now "Sticker Bash"; same token/kit architecture rules apply.

---

## 3 · Testing & verification

- `npm test` after each phase (engine/track/partyplug tests — should be untouched; a failure
  means you leaked into game logic).
- `npm run test:e2e` — run **unsandboxed** (Chromium dies under the Bash sandbox). The suite
  asserts flows, not pixels, but Phase B changes lobby DOM (`#joinurl` code markup, seat
  placeholders) — grep `tests/e2e/` for selectors you touch (`joinurl`, `seat`, `players`,
  `ready`) and update.
- Visual checks: serve on a **unique free port** (other agents deploy concurrently), use the
  gallery pages and display `?scenario=…`. For clean screenshots of the world, DOM overlays
  can be hidden via JS; `.is-dim` on `#scene` (opacity 0) is the classic trap — check it
  before debugging "blank" renders.
- Keep dev servers running when you finish a session (Tim tests manually afterwards) and
  report the port.
- Before merge: push and party-test on the branch preview
  (`https://tinytrack-<branch>.couch-games.com`) — TV + at least one real phone.

## 4 · Open decisions (implement the default, keep the toggle cheap)

1. **Split-screen dividers** — default: chunky ink lines ON, with a debug-panel toggle.
2. **Confetti dosage** — default: lobby paper stage + results/podium boards only. Never in-race.

## 5 · Out of scope

- No engine/canvas/renderer logic changes; no protocol/relay changes; no gameplay tuning.
- No changes to `CAR_COLORS`/liveries (yellow & pink stay available as liveries).
- No new fonts, no external resources (CSP stays `'self'`; fonts already self-hosted).
- No theme flag / dual-theme support — the old Sunny Circuit look is replaced outright
  (recoverable from git history).
