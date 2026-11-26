// TEMPORARY, with display/stripTuner.js: the five cups' road strips side by
// side, each a framed display of the strip oval with its own controls under
// it. The page's hash carries every changed value, the car's mode and which
// cups are hidden, so a reload keeps the session.
import { BIOMES, stripControls, stripQuery } from '/display/stripTuner.js';

const saved = new URLSearchParams(location.hash.slice(1));
let car = saved.get('car') || 'strip';
const hidden = new Set((saved.get('hide') || '').split(',').filter(Boolean));
const frames = [];   // [biome, iframe]

// A cup's changed values: its display's URL once it has loaded, the hash's until then.
const query = (biome, frame) => (frame.src ? stripQuery(frame.contentWindow) : saved.get(biome) || '');

const save = () => {
  const h = new URLSearchParams();
  if (car !== 'strip') h.set('car', car);
  if (hidden.size) h.set('hide', [...hidden].join(','));
  for (const [biome, frame] of frames) {
    const q = query(biome, frame);
    if (q) h.set(biome, q);
  }
  history.replaceState(null, '', '#' + h);
};

const cells = document.getElementById('cells');
const show = document.getElementById('show');
for (const [biome, label] of BIOMES) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const title = document.createElement('h2');
  title.textContent = label;
  const frame = document.createElement('iframe');
  const controls = document.createElement('div');
  controls.className = 'controls';
  // Every load of the frame (the first, and a reset's) gets fresh controls.
  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    controls.replaceChildren(stripControls(win, () => win.__scene, save));
    save();
    // A framed preview holds its first frame for the gallery's sake
    // (TestHarness holdFrame): set it running, and drop the corner buttons,
    // which are sized for a television.
    const wait = setInterval(() => {
      if (!win.__preview) return;
      clearInterval(wait);
      win.__preview.play();
      win.document.getElementById('corner-btns').style.display = 'none';
    }, 200);
  });
  // A hidden cup takes no room and loads nothing until it is first shown; the
  // others grow into its place.
  const toggle = document.createElement('button');
  toggle.textContent = label;
  const lay = () => {
    const on = !hidden.has(biome);
    toggle.classList.toggle('on', on);
    cell.hidden = !on;
    if (on && !frame.src) {
      const q = new URLSearchParams({ test: '1', scenario: 'racing', track: 'strip', biome, players: '1', alone: '1',
        seed: '1', showcase: car, laps: '999', hud: '0' });
      frame.src = '/?' + q + (saved.get(biome) ? '&' + saved.get(biome) : '');
    }
  };
  toggle.addEventListener('click', () => {
    if (!hidden.delete(biome)) hidden.add(biome);
    lay();
    frame.contentWindow.__showcase?.(car);   // the mode may have changed while it was hidden
    save();
  });
  show.append(toggle);
  frames.push([biome, frame]);
  cell.append(title, frame, controls);
  cells.append(cell);
  lay();
}

// Where the car drives: the strip showcase's three modes, switched live.
const carButtons = [...document.querySelectorAll('[data-car]')];
const showCar = () => carButtons.forEach((b) => b.classList.toggle('on', b.dataset.car === car));
for (const b of carButtons) {
  b.addEventListener('click', () => {
    car = b.dataset.car;
    showCar();
    for (const [, frame] of frames) frame.contentWindow.__showcase?.(car);
    save();
  });
}
showCar();

document.getElementById('copy').addEventListener('click', () => {
  const text = frames.map(([biome, frame]) => [biome, query(biome, frame)])
    .filter(([, q]) => q).map(([biome, q]) => `${biome}: ${q}`).join('\n');
  navigator.clipboard.writeText(text || 'nothing changed');
});
