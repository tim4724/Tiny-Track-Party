// The ONE list of baked artwork this game ships — the still pictures, as opposed
// to the live screens `galleryScenarios.js` describes.
//
// WHY IT EXISTS. Every other baked family already had a surface that would notice
// it going wrong: the screens have `/gallery-shots.html` and a coverage test, the
// cues have an audition page and a byte gate, the tracks have their own gallery.
// The brand artwork had neither. It is the one family a human is never shown
// except by opening a PNG in a file browser, and the one family with no test —
// which is how a favicon can sit at the wrong size for a month, and how the
// Apple TV shelf shipped upscaled from a quarter-scale render.
//
// So: this table is read by `/gallery-artwork.html` (which draws every entry at
// the size the platform actually draws it) and by `tests/artwork-manifest.test.js`
// (which asserts every entry exists, is the pixel size it claims, and that
// nothing in the brand directories is missing from the table). The gallery is the
// judgement half; the test is the half that cannot be forgotten.
//
// DEPENDENCY-FREE ES MODULE on the same terms as `tracks.js` and
// `galleryScenarios.js`: Node imports it directly and so does the browser, so it
// may not reach for a DOM or a package.
//
// ENTRY SHAPE
//   id       unique, and the test's handle on it
//   file     path under public/assets/, WITHOUT a leading slash. Root-absolute
//            literals 404 under any subpath hosting (tests/asset-urls.test.js),
//            so the page resolves each one through shared/assetUrl.js and the
//            test joins it onto public/assets/.
//   w, h     the pixel size the file must be. The test measures the real PNG/JPEG
//            header rather than trusting this, which is the whole point of it.
//   drawnAt  how WIDE to draw it in the gallery, in CSS px — the size the PLATFORM
//            draws it at, which is the only size worth judging it at. For the
//            favicon that is 32; for the Android TV banner it is its 320dp layout
//            box, not its (now 4x) pixel width.
//   bake     the npm script that regenerates it, said in full. These are
//            hand-authored script names; deriving them would rot without failing.
//   note     what the entry is for, and anything a reviewer should know.

// A family is a section on the page and a directory rule in the test.
export const ARTWORK_FAMILIES = [
  {
    id: 'icon',
    title: 'App icon and favicon',
    blurb: 'One square composition at four sizes, each RENDERED at its own size rather than '
         + 'downscaled from one master — so the grass band’s curve and the car’s edges stay crisp at 32. '
         + 'Square and full-bleed everywhere a platform masks it; rounded only for the favicon, which '
         + 'nothing masks.',
    bake: 'npm run bake:wordmark'
  },
  {
    id: 'launcher',
    title: 'Launcher and splash',
    blurb: 'The tiles and boards a platform draws before a line of app code runs: an Android TV '
         + 'launcher banner, an Android 12 splash icon masked to a circle, a tvOS launch image.',
    bake: 'npm run bake:wordmark'
  },
  {
    id: 'tvicon',
    title: 'tvOS app icon',
    blurb: 'A LAYERED stack, not a picture: tvOS slides the three layers apart as focus moves across '
         + 'the icon, which is the whole reason the platform asks for a stack. Hover a card to see it.',
    bake: 'npm run bake:wordmark'
  },
  {
    id: 'shelf-static',
    title: 'tvOS top shelf — the static slot',
    blurb: 'What the home row shows when no Top Shelf extension is installed. One picture, four sizes, '
         + 'all cut from a single taller capture so every one of them is a downscale.',
    bake: 'npm run bake:shelf'
  },
  {
    id: 'shelf-carousel',
    title: 'tvOS top shelf — the carousel',
    blurb: 'Full-screen 16:9 frames for the Top Shelf extension, one per cup then the situations a cup '
         + 'frame cannot say. tvOS draws these at 2x on a 4K box, which is what the @2x set is for.',
    bake: 'npm run bake:shelf'
  },
  {
    id: 'items',
    title: 'Item chips',
    blurb: 'Hand-authored SVG, not baked — the one family here that is source rather than output. '
         + 'Two CSS custom properties are the recolour seams, with fallbacks a plain <img> renders as-is.',
    bake: 'authored by hand'
  }
];

export const ARTWORK = [
  // ---- the square icon -----------------------------------------------------
  { id: 'icon-1024', family: 'icon', file: 'brand/icon-1024.png', w: 1024, h: 1024,
    drawnAt: 220, bake: 'npm run bake:wordmark',
    note: 'The App Store master. Never shipped in an app bundle — the biggest slot either TV launcher '
        + 'draws is a few hundred px, so this in an APK would be four times the bytes for nothing.' },
  { id: 'icon-512', family: 'icon', file: 'brand/icon.png', w: 512, h: 512,
    drawnAt: 180, bake: 'npm run bake:wordmark',
    note: 'What Play wants, and what the Android staging reads.' },
  { id: 'icon-180', family: 'icon', file: 'icon/apple-touch-icon.png', w: 180, h: 180,
    drawnAt: 180, bake: 'npm run bake:wordmark',
    note: 'The iOS home-screen icon for the controller page. Drawn 1:1 here.' },
  { id: 'icon-32', family: 'icon', file: 'icon/favicon-32.png', w: 32, h: 32,
    drawnAt: 32, bake: 'npm run bake:wordmark',
    note: 'THE HARD CASE: at 32px the only question is whether the shape still reads as a car. '
        + 'The ONE rounded output of this bake, and transparent outside the corner — a browser tab '
        + 'masks nothing, so unlike every platform icon here its shape has to be in the file.' },

  // ---- launcher and splash -------------------------------------------------
  { id: 'banner', family: 'launcher', file: 'brand/banner.png', w: 1280, h: 720,
    drawnAt: 320, bake: 'npm run bake:wordmark',
    note: 'The Android TV launcher tile. Laid out at 320x180 DP and baked at 4x: it is staged into '
        + 'drawable-nodpi, so the platform never scales it for density and the LAUNCHER resamples it '
        + 'to a box around 640x360 on a 1080p TV. A 1x bitmap arrived there upscaled. Full bleed — '
        + 'the launcher draws its own card behind it.' },
  { id: 'splash-icon', family: 'launcher', file: 'brand/splash-icon.png', w: 512, h: 512,
    drawnAt: 200, bake: 'npm run bake:wordmark',
    note: 'The Android 12 splash. That splash masks to a CIRCLE, so the mark is laid out to fit the '
        + 'inscribed circle — a wide two-line mark dropped in loses its ends. Transparent.' },
  { id: 'launch-tv', family: 'launcher', file: 'brand/launch-tv.png', w: 1920, h: 1080,
    drawnAt: 420, bake: 'npm run bake:wordmark',
    note: 'The tvOS launch image, composited before any app code runs. Deliberately the same picture '
        + 'as the Android splash, so a player switching boxes sees one app.' },
  { id: 'wordmark', family: 'launcher', file: 'brand/wordmark.png', w: null, h: null,
    drawnAt: 420, bake: 'npm run bake:wordmark',
    note: 'The mark alone, transparent and cropped to the ink — callers composite it over their own '
        + 'background. Baked at font-size 130 and supersampled 4x, because the die-cut white edge is '
        + 'a FIXED 7px stroke: baking it bigger would thin the cut.' },

  // ---- the tvOS layered icon ----------------------------------------------
  { id: 'tvicon-400', family: 'tvicon', file: 'brand/tv/icon-front.png', w: 400, h: 240,
    drawnAt: 400, bake: 'npm run bake:wordmark', layers: 'tv/icon',
    note: 'The home-screen stack at 1x. No wordmark by design — type in an app icon is on Apple’s own '
        + 'vetoed list. Nothing clips: the roof sits at 5.8% of the height.' },
  { id: 'tvicon-store', family: 'tvicon', file: 'brand/tv/icon-store-front.png', w: 1280, h: 768,
    drawnAt: 420, bake: 'npm run bake:wordmark', layers: 'tv/icon-store',
    note: 'The App Store stack, 1x only.' },

  // ---- the static top shelf ------------------------------------------------
  { id: 'topshelf', family: 'shelf-static', file: 'brand/tv/topshelf.jpg', w: 1920, h: 720,
    drawnAt: 640, bake: 'npm run bake:shelf',
    note: 'Gameplay, not a drawing: this is the one slot where a player sees what the game looks like '
        + 'before opening it.' },
  { id: 'topshelf-2x', family: 'shelf-static', file: 'brand/tv/topshelf@2x.jpg', w: 3840, h: 1440,
    drawnAt: 640, bake: 'npm run bake:shelf', note: 'The 4K variant of the same crop.' },
  { id: 'topshelf-wide', family: 'shelf-static', file: 'brand/tv/topshelf-wide.jpg', w: 2320, h: 720,
    drawnAt: 640, bake: 'npm run bake:shelf',
    note: 'A SHORTER window of the same capture — full width, fewer rows — not a stretch of the 16:9 one.' },
  { id: 'topshelf-wide-2x', family: 'shelf-static', file: 'brand/tv/topshelf-wide@2x.jpg',
    w: 4640, h: 1440, drawnAt: 640, bake: 'npm run bake:shelf', note: 'And its 4K variant.' }
];

// THE CAROUSEL'S SIZE, declared once. tvOS lays the Top Shelf carousel out in
// 1920x1080 POINTS and an Apple TV 4K draws it at 2x — a platform number, not one
// of ours — and it was being re-typed in the bake, the gate and the gallery. Rule
// 1: a constant two layers must agree on is declared once and read from there.
export const CAROUSEL_SIZE = { w: 1920, h: 1080, scale: 2 };

// The carousel set is generated from its own manifest rather than restated here:
// `public/assets/brand/tv/shelf/carousel.json` is what the tvOS extension reads,
// and a second copy of the running order is exactly the thing that drifts. The
// gallery fetches it; the test reads it off disk.
export const CAROUSEL_MANIFEST = 'brand/tv/shelf/carousel.json';
export const CAROUSEL_DIR = 'brand/tv/shelf';

// Likewise the item chips: `ITEM_IDS` in the engine contract is the list, and the
// files are named from it.
export const ITEM_DIR = 'items';

// Directories the test sweeps for orphans — a file here that no entry names is a
// bake nobody is looking at. `skip` is for outputs with a home of their own:
// `car-hero.png` is an INPUT to the wordmark bake, not one of its products.
export const ARTWORK_SWEEP = [
  { dir: 'public/assets/brand', skip: ['car-hero.png'] },
  { dir: 'public/assets/icon', skip: [] },
  { dir: 'public/assets/brand/tv', skip: [] },
  // The shelf directory has to be swept like the rest. The bake writes a file per
  // frame and never deletes, so a frame renamed or dropped from its FRAMES table
  // leaves the old jpg behind — and reconciling only against carousel.json would
  // never see it, which made the orphan test's own title untrue.
  { dir: 'public/assets/brand/tv/shelf', skip: [] }
];
