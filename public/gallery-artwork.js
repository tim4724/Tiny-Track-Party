// The artwork gallery — every baked STILL the game ships, drawn at the size the
// platform that consumes it actually draws it.
//
// The other galleries answer "is the live thing right?" by mounting the real page
// in an iframe. Nothing here is live: these are files, and the only questions
// worth asking about a file are whether it is the right picture, whether it is
// the right SIZE, and whether it still reads at the size it will be seen at. So
// this page draws each entry at its manifest `drawnAt` by default — a favicon at
// 32 CSS px, a launcher tile at 320 — because a favicon judged at 200px has not
// been judged.
//
// THE MANIFEST IS IMPORTED, not restated (`shared/artworkManifest.js`), on the
// same terms as the screens gallery's scenario table: `tests/artwork-manifest.test.js`
// reads the same module, so a picture this page shows and a picture the test
// checks cannot become different pictures.
//
// The carousel set is fetched from `carousel.json` rather than listed, because
// that file is what the tvOS Top Shelf extension itself reads — a second copy of
// the running order here is the thing that would drift.
import {
  ARTWORK, ARTWORK_FAMILIES, CAROUSEL_MANIFEST, CAROUSEL_DIR, CAROUSEL_SIZE, ITEM_DIR
} from '/shared/artworkManifest.js';
// Every path in the manifest is relative to public/assets/ and resolved HERE.
// A root-absolute literal 404s wherever the tree is hosted under a prefix, which
// is what tests/asset-urls.test.js exists to stop — and did stop, on the first
// draft of this page.
import { assetUrl } from '/shared/assetUrl.js';
// The item vocabulary comes from the ENGINE CONTRACT, the same place
// shared/itemIcons.js reads it. A hand-typed list here drifts silently, and did:
// the first draft of this file listed a `shield` the game does not have and
// missed the banana it does.
import { ITEM_IDS } from '/display/engine/contract.js';

const src = (rel) => assetUrl(`/assets/${rel}`);

const state = { darkMat: false, chrome: false };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// The intrinsic size, off the decoded image rather than off the manifest. The
// manifest says what the size SHOULD be; this says what it is, and the card shows
// the disagreement in red. That is the same division of labour the test uses, and
// it is why a wrong-sized bake is visible here without anyone running anything.
function measure(img) {
  return { w: img.naturalWidth, h: img.naturalHeight };
}

// A card WIDE ENOUGH FOR ITS PICTURE. `drawnAt` is the whole point of this page —
// a 320px launcher tile judged in a 260px column is judged clipped — so the card
// takes as many grid columns as its intended size needs, up to three.
const COL = 260;
const GAP = 14;
function span(entry) {
  const want = (entry.drawnAt || 0) + 54;   // the plate's own padding, both sides
  if (!entry.drawnAt) return 1;
  return Math.max(1, Math.min(3, Math.ceil((want - COL) / (COL + GAP)) + 1));
}

// One card. `layers` turns the plate into a tvOS stack: the three .imagestacklayer
// PNGs composited, and separated on hover the way the platform separates them.
function card(entry) {
  const c = el('div', 'card art-card');
  c.dataset.span = `span ${span(entry)}`;
  c.style.gridColumn = c.dataset.span;

  const head = el('div', 'card-title');
  const title = el('span', null, entry.title || entry.id);
  const tag = el('span', 'tag', entry.tag ? ` ${entry.tag}` : '');
  title.appendChild(tag);
  head.appendChild(title);
  const actions = el('div', 'actions');
  const open = el('a', 'open-link', 'open');
  open.href = src(entry.file);
  open.target = '_blank';
  open.rel = 'noopener';
  actions.appendChild(open);
  head.appendChild(actions);
  c.appendChild(head);

  const plate = el('div', 'art-plate');
  const dims = el('div', 'art-dims');

  if (entry.layers) {
    const stack = el('div', 'art-stack');
    for (const [layer, cls] of [['back', 'lyr-back'], ['middle', 'lyr-mid'], ['front', 'lyr-front']]) {
      const l = new Image();
      l.className = cls;
      l.alt = '';
      l.src = src(`brand/${entry.layers}-${layer}.png`);
      stack.appendChild(l);
    }
    stack.style.width = `${entry.drawnAt}px`;
    stack.style.aspectRatio = `${entry.w} / ${entry.h}`;
    bindParallax(stack);
    plate.appendChild(stack);
    dims.textContent = `${entry.w}×${entry.h} · 3 layers · move the pointer over it`;
  } else {
    const img = new Image();
    img.alt = entry.title || entry.id;
    img.loading = 'lazy';
    img.src = src(entry.file);
    img.addEventListener('load', () => {
      const m = measure(img);
      const wrong = (entry.w != null && m.w !== entry.w) || (entry.h != null && m.h !== entry.h);
      dims.textContent = `${m.w}×${m.h}`;
      if (wrong) {
        dims.classList.add('bad');
        dims.textContent += ` — manifest says ${entry.w}×${entry.h}`;
      }
      img.style.width = `${entry.drawnAt}px`;
    });
    img.addEventListener('error', () => {
      dims.classList.add('bad');
      dims.textContent = `missing — run ${entry.bake}`;
    });
    plate.appendChild(img);
    plate._img = img;
    plate._entry = entry;
  }

  c.appendChild(plate);
  c.appendChild(dims);
  if (entry.note) c.appendChild(el('div', 'art-note', entry.note));
  return c;
}

// THE PARALLAX, driven by the POINTER rather than by a fixed hover offset.
//
// tvOS does not nudge an icon to a corner when it gains focus: it tracks the
// remote's touch surface, and the layers slide against each other in whatever
// direction the thumb moves. A one-way hover transform reads as the picture
// coming apart, because nothing about it says the movement is a response.
//
// Two rules make it look like a stack and not three drifting pictures. The stack
// CLIPS, and every layer is scaled up by the same margin it is allowed to travel
// within — without that, sliding a full-bleed layer exposes the paper behind it at
// one edge, which is exactly the "weird" of the first version. And the shift is
// graduated by depth, so the car moves most and the paper barely at all.
const TRAVEL = [0.4, 1.4, 3.2];   // per cent of the stack, back to front
function bindParallax(stack) {
  const layers = [...stack.querySelectorAll('img')];
  const set = (nx, ny) => {
    layers.forEach((l, i) => {
      const t = TRAVEL[i] || 0;
      l.style.transform = `scale(1.075) translate(${(nx * t).toFixed(2)}%, ${(ny * t).toFixed(2)}%)`;
    });
  };
  set(0, 0);
  stack.addEventListener('pointermove', (e) => {
    const r = stack.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
  });
  stack.addEventListener('pointerleave', () => set(0, 0));
}

// The tvOS actions-carousel chrome, approximated: the title block bottom-left and
// the two buttons under it. It is here for one reason — the frames are chosen for
// what is in the middle of them, and the system draws over the bottom-left corner.
function chromeOverlay(item) {
  const wrap = el('div', 'art-chrome');
  wrap.innerHTML = '<div class="ch-grad"></div>'
    + `<div class="ch-txt"><div class="ch-ctx"></div><div class="ch-ttl"></div></div>`
    + '<div class="ch-btns"><span>Play</span><span>More Info</span></div>';
  wrap.querySelector('.ch-ctx').textContent = item.context;
  wrap.querySelector('.ch-ttl').textContent = item.title;
  return wrap;
}

function familySection(fam, entries) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h2', 'rail-title', fam.title));
  const blurb = el('p', 'fam-blurb');
  blurb.appendChild(document.createTextNode(`${fam.blurb} `));
  blurb.appendChild(el('span', 'bake', fam.bake));
  frag.appendChild(blurb);
  const grid = el('div', 'art-grid');
  for (const e of entries) grid.appendChild(card(e));
  frag.appendChild(grid);
  return frag;
}

async function carouselEntries() {
  try {
    const res = await fetch(src(CAROUSEL_MANIFEST));
    if (!res.ok) return [];
    const { items } = await res.json();
    return items.map((it) => ({
      id: it.id,
      title: it.title,
      tag: it.context,
      file: `${CAROUSEL_DIR}/${it.id}@2x.jpg`,
      w: CAROUSEL_SIZE.w * CAROUSEL_SIZE.scale,
      h: CAROUSEL_SIZE.h * CAROUSEL_SIZE.scale,
      drawnAt: 420,
      bake: 'npm run bake:shelf',
      carousel: it,
      note: null
    }));
  } catch {
    return [];
  }
}

function render(families) {
  const main = document.getElementById('families');
  main.textContent = '';
  for (const { fam, entries } of families) {
    if (!entries.length) continue;
    main.appendChild(familySection(fam, entries));
  }
  document.body.classList.toggle('dark-mat', state.darkMat);
  document.body.classList.toggle('show-chrome', state.chrome);
}

async function main() {
  const carousel = await carouselEntries();
  const byFamily = ARTWORK_FAMILIES.map((fam) => ({
    fam,
    entries: fam.id === 'shelf-carousel' ? carousel : ARTWORK.filter((e) => e.family === fam.id)
  }));

  // The item chips are SVG source rather than a bake, so they are built from the
  // directory listing the server already answers with, not from a second list.
  const items = byFamily.find((f) => f.fam.id === 'items');
  if (items) {
    items.entries = ITEM_IDS.map((id) => ({
      id, title: id, file: `${ITEM_DIR}/${id}.svg`, w: null, h: null, drawnAt: 96,
      bake: 'authored by hand',
      note: null
    }));
  }

  render(byFamily);

  // The carousel chrome overlay is mounted after render so it can sit inside the
  // plates that already exist.
  for (const c of document.querySelectorAll('.art-card')) {
    const plate = c.querySelector('.art-plate');
    if (!plate || !plate._entry || !plate._entry.carousel) continue;
    plate.style.position = 'relative';
    plate.appendChild(chromeOverlay(plate._entry.carousel));
  }

  document.getElementById('mat-dark').addEventListener('change', (e) => {
    state.darkMat = e.target.checked;
    document.body.classList.toggle('dark-mat', state.darkMat);
  });
  document.getElementById('tv-chrome').addEventListener('change', (e) => {
    state.chrome = e.target.checked;
    document.body.classList.toggle('show-chrome', state.chrome);
  });
}

main();
