// Race-music audition surface for the candidate pool (/assets/audio/_music-pool/,
// gitignored — assembled by scripts/build-music-pool.mjs + sourcing rounds).
// Presented like the SFX/engine galleries — license badges, favorites, filter,
// source links — but with a music-appropriate transport: full tracks STREAM
// through a single shared <audio> element (one playing at a time, with a scrub
// bar), NOT Web Audio decodeAudioData — songs are multi-MB and we want seeking
// + cheap playback, not a giant in-memory buffer. The license badges make CC0
// vs CC-BY (vs anything worse) explicit so picks get vetted before anything
// ships. Rows already wired into the game (display/Audio.js RACE_MUSIC — the
// import keeps this page drift-free) carry an "in game" tag and their own
// filter chips. Favorites persist in localStorage; nothing here touches the race.
import { RACE_MUSIC } from '/display/Audio.js';

// The shipped picks, by filename (RACE_MUSIC stores /assets/audio/music/<file>;
// a promoted pool track keeps its name, so the basenames line up).
const PICKED = new Set(Object.values(RACE_MUSIC).flat().map((s) => s.file.split('/').pop()));

const meta = (n, d) => document.querySelector(`meta[name="${n}"]`)?.content || d;
const DIR = meta('audition-dir', '/assets/audio/_music-pool');
const FAV_KEY = meta('audition-fav-key', 'tinytrack_music_pool_v1');
const VOL_KEY = 'tinytrack_sound_volume_v1'; // shared with the other galleries

// ---- one shared <audio> player; one track at a time ----
const player = new Audio();
player.preload = 'none';
function volNorm() {
  const r = parseInt(localStorage.getItem(VOL_KEY), 10);
  return Number.isFinite(r) ? Math.max(0, Math.min(100, r)) / 100 : 0.6;
}
player.volume = volNorm();

let current = null; // { file, row, onStop } — the ONE active track (main or fast)
function stopPlayback() {
  if (!current) return;
  const c = current;
  current = null;
  player.pause();
  c.onStop();
}
function playFile(file, row, onStop) {
  stopPlayback();
  player.src = `${DIR}/${encodeURIComponent(file)}`;
  player.currentTime = 0;
  current = { file, row, onStop };
  player.play().catch(() => { /* autoplay/decoding rejection — leave UI reset */ });
}
player.addEventListener('ended', stopPlayback);

// ---- license classification (badge tiers reused from audition.css) ----
// STK's vocabulary: "CC-BY-SA 3.0", "CC-SA v3.0", "CC BY-SA …", "GPL", plus a
// couple genuinely missing from licenses.txt. Share-alike / GPL = copyleft;
// check that BEFORE plain CC-BY since "CC-BY-SA" contains "cc-by".
function licenseClass(lic) {
  const s = (lic || '').toLowerCase();
  if (/cc-?0|public[ -]?domain/.test(s)) return 'free';
  if (/by-?sa|cc-?sa|share[\s-]?alike|gpl/.test(s)) return 'copyleft';
  if (/cc-?by/.test(s)) return 'attrib';
  return 'unknown';
}
const CLASS_LABEL = { free: 'CC0/PD', attrib: 'CC-BY', copyleft: 'BY-SA/GPL', unknown: '?' };

const fmtTime = (t) => {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// ---- favorites ----
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []); } catch (_) { return new Set(); } }
function saveFavs(s) { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch (_) {} }
const favs = loadFavs();

// ---- build the list ----
const grid = document.getElementById('grid');
const countEl = document.getElementById('count');
const rows = [];

async function build() {
  const entries = await fetch(`${DIR}/manifest.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  if (!entries.length) {
    grid.innerHTML = `<p class="note">No <code>manifest.json</code> in <code>${DIR}</code>. ` +
      `Run <code>svn export …/stk-assets/music</code> then <code>node scripts/build-music-manifest.mjs</code>.</p>`;
    return;
  }

  for (const entry of entries) {
    const file = entry.file;
    const lic = entry.license || 'unknown';
    const cls = licenseClass(lic);

    // Baked-in length (manifest `duration`, whole seconds) so the row shows the
    // track length before play — the <audio> preloads 'none', so it can't.
    const durTxt = Number.isFinite(entry.duration) && entry.duration > 0 ? fmtTime(entry.duration) : '0:00';

    const row = document.createElement('div');
    row.className = 'row music';

    // star
    const star = document.createElement('button');
    star.className = 'star';
    const paintStar = () => { star.textContent = favs.has(file) ? '★' : '☆'; row.classList.toggle('fav', favs.has(file)); };
    star.addEventListener('click', () => {
      if (favs.has(file)) favs.delete(file); else favs.add(file);
      saveFavs(favs); paintStar(); applyFilter();
    });
    paintStar();

    // name / composer / source — with an "in game" tag on shipped picks
    const picked = PICKED.has(file);
    if (picked) row.classList.add('picked');
    const nameCell = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = entry.title || file.replace(/\.ogg$/i, '');
    if (picked) {
      const tag = document.createElement('span');
      tag.className = 'ingame-tag';
      tag.textContent = '♫ in game';
      tag.title = 'Wired into a biome pool (display/Audio.js RACE_MUSIC)';
      name.appendChild(tag);
    }
    nameCell.appendChild(name);
    const sub = document.createElement('div');
    sub.className = 'src';
    // Biome-targeted candidates lead with their target (manifest `biome`) —
    // it's also folded into the searchable name, so typing "canyon" groups them.
    const by = (entry.biome ? `→ ${entry.biome} · ` : '') + (entry.composer ? `${entry.composer} · ` : '');
    if (entry.source) {
      sub.innerHTML = `${by}<a href="${entry.source}" target="_blank" rel="noopener">${file} ↗</a>`;
    } else {
      sub.textContent = `${by}${file}`;
    }
    nameCell.appendChild(sub);

    // badge
    const badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = CLASS_LABEL[cls];
    badge.title = lic + (entry.composer ? ' — ' + entry.composer : '');

    // transport: play + optional fast-variant button
    const btns = document.createElement('div');
    btns.className = 'btns';
    const clearUI = () => { play.classList.remove('on'); play.textContent = '▶'; if (fast) { fast.classList.remove('on'); fast.textContent = '⏩'; } seek.value = '0'; time.textContent = `0:00 / ${durTxt}`; };
    const play = mkBtn('▶', 'play / stop full track', () => {
      if (current && current.row === row && current.which === 'main') { stopPlayback(); return; }
      playFile(file, row, clearUI);
      current.which = 'main';
      play.classList.add('on'); play.textContent = '■';
    });
    btns.appendChild(play);
    let fast = null;
    if (entry.fastFile) {
      fast = mkBtn('⏩', 'play last-lap (fast) variant', () => {
        if (current && current.row === row && current.which === 'fast') { stopPlayback(); return; }
        playFile(entry.fastFile, row, clearUI);
        current.which = 'fast';
        fast.classList.add('on'); fast.textContent = '⏹';
      });
      btns.appendChild(fast);
    }

    // scrub + time
    const transport = document.createElement('div');
    transport.className = 'transport';
    const seek = document.createElement('input');
    seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0'; seek.className = 'seek';
    seek.title = 'Seek';
    seek.addEventListener('input', () => {
      if (current && current.row === row && Number.isFinite(player.duration)) {
        player.currentTime = (seek.value / 1000) * player.duration;
      }
    });
    const time = document.createElement('span');
    time.className = 'time'; time.textContent = `0:00 / ${durTxt}`;
    transport.append(seek, time);

    row.append(star, nameCell, badge, btns, transport);
    grid.appendChild(row);
    const dur = Number.isFinite(entry.duration) && entry.duration > 0 ? entry.duration : 0;
    rows.push({ row, file, name: `${entry.title} ${entry.composer} ${entry.biome || ''} ${file}`.toLowerCase(), cls, dur, picked, fav: () => favs.has(file), seek, time });
  }
  applySort();
  applyFilter();
}
function mkBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'play'; b.textContent = label; b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// Drive the active row's scrub bar + time from the shared player.
player.addEventListener('timeupdate', () => {
  if (!current) return;
  const r = rows.find((x) => x.row === current.row);
  if (!r) return;
  const d = player.duration;
  if (Number.isFinite(d) && d > 0) r.seek.value = String(Math.round((player.currentTime / d) * 1000));
  r.time.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(d)}`;
});

// ---- filtering ----
let filterMode = 'all';
const filterText = document.getElementById('filter');
function applyFilter() {
  const q = filterText.value.trim().toLowerCase();
  let shown = 0;
  for (const r of rows) {
    let ok = true;
    if (filterMode === 'fav') ok = r.fav();
    else if (filterMode === 'picked') ok = r.picked;
    else if (filterMode === 'unpicked') ok = !r.picked;
    else if (['free', 'attrib', 'copyleft', 'unknown'].includes(filterMode)) ok = r.cls === filterMode;
    if (ok && q) ok = r.name.includes(q);
    r.row.classList.toggle('hidden', !ok);
    if (ok) shown++;
  }
  countEl.textContent = `${shown} / ${rows.length} shown`;
}
filterText.addEventListener('input', applyFilter);

// ---- sorting ----
// Reorders the grid's DOM rows in place; filter state (the .hidden class) rides
// along untouched. Tracks with no baked duration (0) always sink to the bottom
// regardless of direction, so an unknown length never masquerades as "shortest".
const sortEl = document.getElementById('sort');
function applySort() {
  const mode = sortEl ? sortEl.value : 'default';
  let order = rows;
  if (mode === 'dur-asc' || mode === 'dur-desc') {
    const dir = mode === 'dur-desc' ? -1 : 1;
    order = [...rows].sort((a, b) => {
      if (!a.dur !== !b.dur) return a.dur ? -1 : 1; // 0-duration rows last
      return (a.dur - b.dur) * dir;
    });
  }
  for (const r of order) grid.appendChild(r.row);
}
if (sortEl) sortEl.addEventListener('change', applySort);

for (const chip of document.querySelectorAll('.legend .chip')) {
  chip.addEventListener('click', () => {
    filterMode = chip.dataset.f;
    for (const c of document.querySelectorAll('.legend .chip')) c.classList.toggle('active', c === chip);
    applyFilter();
  });
}

// ---- header controls ----
const vol = document.getElementById('vol');
vol.value = String(Math.round(volNorm() * 100));
vol.addEventListener('input', () => {
  try { localStorage.setItem(VOL_KEY, vol.value); } catch (_) {}
  player.volume = Math.max(0, Math.min(1, +vol.value / 100));
});

document.getElementById('copy-favs').addEventListener('click', async (e) => {
  const list = [...favs].sort().join('\n');
  try { await navigator.clipboard.writeText(list); e.target.textContent = 'Copied ✓'; }
  catch (_) { e.target.textContent = 'Copy failed'; }
  setTimeout(() => { e.target.textContent = 'Copy favorites'; }, 1500);
});

// Stop playback when the tab hides — a forgotten track is exactly the annoyance
// this page exists to prevent.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });

build();
