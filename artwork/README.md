# artwork

![4-player split-screen](splitscreen-4p.png)

Generated hero shots. Regenerate with the capture script — don't edit pixels.

```bash
npm run artwork          # → splitscreen-4p.png (1920x1080, 2x2 split-screen)
```

Boots the server, drives the display's test harness in headless Chromium at 16:9,
and screenshots a four-player race — one car model per cell.

Needs Playwright's Chromium (`npx playwright install chromium` if missing).

Options: `--out --width --height --players --track --scenario --wait --port --headed`

```bash
node scripts/capture-artwork.js --track grand --width 2560 --height 1440
```
