// The screens gallery: one card per scenario, the WEB shot next to whichever TV
// shot of the same screen you asked for.
//
// The other galleries render live — an iframe running the real display page. This
// one cannot, and that is the whole reason it exists: a TV screen only ever exists
// as a photograph of a television, so the comparison has to be still-against-still.
// `/gallery.html` keeps its job (is the web display right?); this one answers a
// different question (has a TV shell drifted from it?).
//
// EITHER COLUMN IS ANY PLATFORM, and that is not just symmetry for its own sake:
// the useful comparison is often TV against TV. Two shells reading one `ttp_ui.h`
// should agree with each other as closely as each agrees with the browser, and a
// difference that shows up on both at once is a model bug rather than a shell bug.
//
// The scenario table is IMPORTED, not restated — public/shared/galleryScenarios.js
// is the same module the capture scripts and the coverage test read. Two
// hand-maintained lists of "what screens exist" is how a gallery ends up silently
// missing a screen somebody added six months ago.
//
// THE STALENESS CHIP IS NOT DECORATION. A gallery of silently out-of-date
// screenshots is worse than no gallery: it reads as evidence while being a
// photograph of a build nobody is running. Each card carries the short SHA it was
// captured at, and says so plainly when that is not the SHA being served.

import { CAPTURED_SCENARIOS, SHOT_PLATFORMS } from '/shared/galleryScenarios.js';

const SHOTS_BASE = '/assets/shots';

// Human names for the ids in SHOT_PLATFORMS. Every read falls back to the raw id,
// so a platform missing from here renders as "androidtv-emu" rather than breaking —
// which is the failure mode you want, but it is still worth a name.
const PLATFORM_LABEL = {
  web: 'Web',
  'tvos-device': 'Apple TV (device)',
  'tvos-sim': 'Apple TV (simulator)',
  'androidtv-device': 'Android TV (device)',
  'androidtv-emu': 'Android TV (emulator)'
};

// The command that fills each column, said in full where a column is empty —
// spelled out rather than derived from the id, because these are hand-authored
// npm script names and string surgery over them would rot without failing.
const CAPTURE_COMMAND = {
  web: 'npm run shots:web',
  'tvos-device': 'npm run shots:tvos',
  'tvos-sim': 'npm run shots:tvos-sim',
  'androidtv-device': 'npm run shots:androidtv',
  'androidtv-emu': 'npm run shots:androidtv-emu'
};
const captureHint = (p) => CAPTURE_COMMAND[p] || `a capture for ${p}`;

const state = {
  left: 'web',
  right: 'tvos-device',
  // A third column, or '' for the two-column default. It is always a whole
  // picture: the compare modes are about the first two.
  third: '',
  mode: 'split'
};

let manifest = { shots: [] };
let servedSha = null;

function shotFor(scenario, platform) {
  return manifest.shots.find((s) => s.scenario === scenario && s.platform === platform) || null;
}

/** A gap the TABLE declares (`tvOnly`: the web has no such screen), as opposed
 *  to a capture nobody has run yet. Only the web's gaps are declared; a TV's
 *  are decided by its harness at capture time and look like any other absence. */
function declaredGap(scenario, platform) {
  return platform === 'web' && !!scenario.tvOnly;
}

/** Why a pane is empty. */
function absence(scenario, platform) {
  if (declaredGap(scenario, platform)) return 'no such screen on Web';
  return `no ${PLATFORM_LABEL[platform] || platform} shot`;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** Two git abbreviations of possibly different lengths, same commit? */
function sameCommit(a, b) {
  const n = Math.min(a.length, b.length);
  return n > 0 && a.slice(0, n) === b.slice(0, n);
}

function metaLine(shot) {
  const line = el('div', 'shot-meta');
  if (!shot) {
    line.appendChild(el('span', null, 'not captured'));
    return line;
  }
  line.appendChild(el('span', null, `${shot.w}x${shot.h}`));
  line.appendChild(el('span', null, `${Math.round(shot.bytes / 1024)} KB`));
  if (shot.deviceName) line.appendChild(el('span', null, shot.deviceName));
  // COMPARED AS A PREFIX, not for equality. Both sides are abbreviations of the
  // same 40-char sha, and neither picked its own length: the server slices 7
  // (`getShortSha`, shared with the version badge) while the capture scripts take
  // whatever `git rev-parse --short` gives, which grew to 8 as this repo did. An
  // `!==` therefore called EVERY card stale, including one captured a second ago —
  // which is the exact failure the chip exists to prevent, wearing its own badge.
  const stale = servedSha && shot.gitSha && !sameCommit(shot.gitSha, servedSha);
  line.appendChild(el('span', stale ? 'stale' : 'fresh', stale ? `stale @ ${shot.gitSha}` : shot.gitSha || ''));
  return line;
}

function makeCard(scenario) {
  const card = el('article', 'card');
  card.appendChild(el('h2', null, scenario.title));

  // The columns, resolved once: '' for the third means two columns.
  const columns = [state.left, state.right, state.third].filter(Boolean)
    .map((platform) => [platform, shotFor(scenario.id, platform)]);
  const [[, a], [, b], third] = columns;
  const row = el('div', 'shot-row');
  if (state.mode === 'split') {
    row.appendChild(pane(scenario, a, state.left));
    row.appendChild(pane(scenario, b, state.right));
  } else {
    row.appendChild(overlaid(scenario, a, b));
  }
  // The third column rides beside whatever the first two made — two panes or
  // one overlay — as one more whole picture.
  if (third) row.appendChild(pane(scenario, third[1], third[0]));
  row.style.setProperty('--panes', row.childElementCount);
  card.appendChild(row);

  const foot = el('div', 'card-foot');
  for (const [platform, shot] of columns) {
    const line = metaLine(shot);
    line.prepend(el('strong', null, PLATFORM_LABEL[platform] || platform));
    foot.appendChild(line);
  }
  card.appendChild(foot);

  return card;
}

/** One image, whole, in its own frame — or a note saying which one is absent. */
function pane(scenario, shot, platform) {
  const box = el('div', 'shot-pane');
  box.appendChild(el('div', 'cap', PLATFORM_LABEL[platform] || platform));
  const frame = el('div', 'shot-frame');
  if (shot) {
    const img = el('img');
    img.src = `${SHOTS_BASE}/${shot.file}`;
    img.alt = `${scenario.title} (${PLATFORM_LABEL[shot.platform] || shot.platform})`;
    img.loading = 'lazy';
    frame.appendChild(img);
  } else {
    // Said per PANE rather than across the pair: "no Apple TV shot" written
    // over a composite left you guessing which half you were looking at.
    frame.appendChild(el('div', 'missing', absence(scenario, platform)));
  }
  box.appendChild(frame);
  return box;
}

/** Swipe / difference / one-only: the two images stacked in ONE frame, which is
 *  what those three modes are for — they answer "has it drifted by a pixel",
 *  and that question needs the images superimposed rather than adjacent. A pane
 *  like the whole-picture ones, captioned with both platforms, so a third
 *  column beside it lines up. */
function overlaid(scenario, a, b) {
  const box = el('div', 'shot-pane');
  box.appendChild(el('div', 'cap',
    `${PLATFORM_LABEL[state.left] || state.left} / ${PLATFORM_LABEL[state.right] || state.right}`));
  const frame = el('div', `shot-frame mode-${state.mode}`);
  box.appendChild(frame);
  for (const [shot, cls] of [[a, 'shot-a'], [b, 'shot-b']]) {
    if (!shot) continue;
    const img = el('img', cls);
    img.src = `${SHOTS_BASE}/${shot.file}`;
    img.alt = `${scenario.title} (${PLATFORM_LABEL[shot.platform] || shot.platform})`;
    img.loading = 'lazy';
    frame.appendChild(img);
  }
  const missing = [[a, state.left], [b, state.right]].filter(([shot]) => !shot).map(([, p]) => p);
  const gaps = missing.map((p) => absence(scenario, p));
  // Nothing at all: say what fills the frame — for the sides a capture CAN
  // fill. A declared gap has no command that would fill it.
  const capturable = missing.filter((p) => !declaredGap(scenario, p));
  if (missing.length === 2 && capturable.length) {
    gaps.push(`run ${capturable.map(captureHint).join(' and ')}`);
  }
  if (gaps.length) frame.appendChild(el('div', 'missing', gaps.join(' · ')));

  // The swipe handle. Pointer-driven rather than a slider control, because the
  // useful gesture is "scrub across the seam and watch the chrome move".
  if (state.mode === 'swipe') {
    frame.style.setProperty('--x', '50%');
    frame.addEventListener('pointermove', (e) => {
      const r = frame.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      frame.style.setProperty('--x', `${pct}%`);
    });
  }
  return box;
}

function render() {
  const host = document.getElementById('rails');
  host.textContent = '';
  // One card per row. There used to be a cards-per-row select here; it set
  // `--cols` on this div, and the only rule that reads a column count is
  // `.scenario-strip { --row-cols }` in gallery.css — a different variable on a
  // different class. It had never done anything.
  const strip = el('div', 'rail');
  for (const scenario of CAPTURED_SCENARIOS) strip.appendChild(makeCard(scenario));
  host.appendChild(strip);

  // Counted for EVERY column, because any one can be a TV. Said only when
  // there is a gap: a complete row should not carry a sentence about absence.
  const captured = new Set(manifest.shots.map((s) => `${s.scenario}:${s.platform}`));
  const gaps = [state.left, state.right, state.third].filter(Boolean)
    .map((p) => [p, CAPTURED_SCENARIOS.filter((s) => !captured.has(`${s.id}:${p}`)).length])
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} missing on ${PLATFORM_LABEL[p] || p}`);
  document.getElementById('legend').textContent =
    `${CAPTURED_SCENARIOS.length} screens · ${manifest.shots.length} shots on file` +
    (gaps.length ? ` · ${gaps.join(' · ')}` : '') +
    ' · frozen captures, not live pages (a TV screen only exists as a photograph)';
}

function fillPlatformSelects() {
  // The third select carries one extra option, the two-column default, and
  // says "Third:" on each platform so the header reads as three columns rather
  // than three unlabelled lists of the same five names.
  const columns = [['left-platform', 'left', ''], ['right-platform', 'right', ''],
                   ['third-platform', 'third', 'Third: ']];
  for (const [id, key, prefix] of columns) {
    const sel = document.getElementById(id);
    const platforms = key === 'third' ? ['', ...SHOT_PLATFORMS] : SHOT_PLATFORMS;
    for (const p of platforms) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p ? prefix + (PLATFORM_LABEL[p] || p) : 'Two columns';
      if (p === state[key]) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { state[key] = sel.value; render(); });
  }
  document.getElementById('compare-mode').addEventListener('change', (e) => {
    state.mode = e.target.value;
    render();
  });
}

async function main() {
  fillPlatformSelects();
  try {
    const res = await fetch(`${SHOTS_BASE}/manifest.json`);
    if (res.ok) manifest = await res.json();
  } catch {
    // An uncaptured tree is a legitimate state, and the page says so per card.
  }
  // Empty in a production image (no SHA to compare against), which just means no
  // staleness chip rather than a broken page.
  servedSha = document.querySelector('meta[name="ttp-git-sha"]')?.content || null;
  render();
}

main();
