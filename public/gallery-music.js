// Music gallery — the SHIPPED soundtrack, cup by cup. Everything renders from
// live game data (CUPS for the cup list/names, biomeNameForCup + THEMES for the
// biome identity/swatch, RACE_MUSIC for the songs), so the page is drift-free
// by construction: wiring a new pick into display/Audio.js is what updates it.
// Playback mirrors the audition galleries: one shared streaming <audio>.
import { CUPS } from '/shared/tracks.js';
import { biomeNameForCup, THEMES } from '/shared/themes.js';
import { RACE_MUSIC, MUSIC_FALLBACK } from '/display/Audio.js';

const VOL_KEY = 'tinytrack_sound_volume_v1'; // shared with the other galleries

const player = new Audio();
player.preload = 'none';
function volNorm() {
  const r = parseInt(localStorage.getItem(VOL_KEY), 10);
  return Number.isFinite(r) ? Math.max(0, Math.min(100, r)) / 100 : 0.6;
}
// The playing song's loudness trim (song.gain — the race applies the same one),
// so browsing the pools here previews them at matched perceived level.
let playGain = 1;
const applyVolume = () => { player.volume = Math.min(1, volNorm() * playGain); };
applyVolume();

const fmtTime = (t) => Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00';

let current = null; // { btn, time, seek, durTxt } — the one playing row's UI
function stopPlayback() {
  if (!current) return;
  const c = current;
  current = null;
  player.pause();
  c.btn.classList.remove('on'); c.btn.textContent = '▶';
  c.time.textContent = c.durTxt; // back to the static song length
  c.seek.value = '0';
}
player.addEventListener('ended', stopPlayback);
player.addEventListener('timeupdate', () => {
  if (!current) return;
  current.time.textContent = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
  if (Number.isFinite(player.duration) && player.duration > 0) {
    current.seek.value = String(Math.round((player.currentTime / player.duration) * 1000));
  }
});

const hex = (c) => '#' + c.toString(16).padStart(6, '0');

function songRow(song, { fallback = false } = {}) {
  const row = document.createElement('div');
  row.className = 'music-row' + (fallback ? ' fallback' : '');

  const btn = document.createElement('button');
  btn.className = 'play'; btn.textContent = '▶';
  btn.title = fallback ? 'Play the fallback track' : 'Play this pick';

  const nameCell = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = song.title + (fallback ? ' — fallback (no pick for this biome yet)' : '');
  const sub = document.createElement('div');
  sub.className = 'sub';
  const file = song.file.split('/').pop();
  sub.innerHTML = `${song.artist} · <a href="${song.source}" target="_blank" rel="noopener">${file} ↗</a>`;
  nameCell.append(title, sub);

  // Fast seek: drag to jump anywhere in the song (only live while this row
  // plays — the <audio> streams via Range requests, so seeks land instantly).
  const seek = document.createElement('input');
  seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0';
  seek.className = 'seek'; seek.title = 'Seek';
  seek.addEventListener('input', () => {
    if (current && current.seek === seek && Number.isFinite(player.duration)) {
      player.currentTime = (seek.value / 1000) * player.duration;
    }
  });

  // Song length up front (baked `duration`); becomes elapsed/total while playing.
  const durTxt = fmtTime(song.duration);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = durTxt;

  const lic = document.createElement('span');
  lic.className = 'lic';
  lic.textContent = song.license;
  lic.title = fallback ? 'Falls back to another biome’s song rather than silence' : 'Shipping this pick requires the credit line (music/CREDITS.txt)';

  btn.addEventListener('click', () => {
    if (current && current.btn === btn) { stopPlayback(); return; }
    stopPlayback();
    player.src = song.file;
    playGain = song.gain || 1;
    applyVolume();
    player.currentTime = 0;
    current = { btn, time, seek, durTxt };
    btn.classList.add('on'); btn.textContent = '■';
    player.play().catch(() => stopPlayback());
  });

  row.append(btn, nameCell, seek, time, lic);
  return row;
}

const cupsEl = document.getElementById('music-cups');
for (const cup of CUPS) {
  const biome = biomeNameForCup(cup.id);
  const pool = RACE_MUSIC[biome] || [];

  const section = document.createElement('div');
  section.className = 'music-cup';

  const head = document.createElement('div');
  head.className = 'rail-title';
  const dot = document.createElement('span');
  dot.className = 'biome-dot';
  dot.style.background = hex(THEMES[biome].hills[0]);
  head.append(dot, document.createTextNode(`${cup.name} · ${biome} biome`));
  section.appendChild(head);

  if (pool.length > 1) {
    const note = document.createElement('div');
    note.className = 'rail-note';
    note.textContent = `${pool.length} songs — each race picks one at random, never repeating the last.`;
    section.appendChild(note);
  }

  if (pool.length) {
    for (const song of pool) section.appendChild(songRow(song));
  } else {
    // No pick wired for this biome — show what a race actually does: fall back.
    for (const song of MUSIC_FALLBACK) section.appendChild(songRow(song, { fallback: true }));
  }
  cupsEl.appendChild(section);
}

// ---- volume (shared key, like the other galleries) ----
const vol = document.getElementById('vol');
vol.value = String(Math.round(volNorm() * 100));
vol.addEventListener('input', () => {
  try { localStorage.setItem(VOL_KEY, vol.value); } catch (_) {}
  applyVolume();
});

// A forgotten background track is exactly what this page shouldn't do.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
