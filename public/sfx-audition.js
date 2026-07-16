// SFX audition surface — loads SuperTuxKart's sound-effect clips (svn-exported
// to /assets/audio/_stk-audition/, gitignored) and lets you A/B them the way a
// racing game would: one-shot, flat loop, or "drive" (looped + pitch-shifted by
// a faux-gear sawtooth — the STK / Mario Kart engine trick). Per-clip license is
// shown from the folder's licenses.txt so picks can be vetted before anything
// ships. Favorites persist in localStorage; nothing here touches the race.
// Per-page config (meta tags); falls back to the STK set so the page works bare.
const meta = (n, d) => document.querySelector(`meta[name="${n}"]`)?.content || d;
const DIR = meta('audition-dir', '/assets/audio/_stk-audition');
const FAV_KEY = meta('audition-fav-key', 'tinytrack_stk_audition_v1');
const VOL_KEY = 'tinytrack_sound_volume_v1'; // shared with the synth gallery

// ---- audio graph (lazy — browsers need a gesture before audio runs) ----
let ctx = null, master = null;
function audio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volNorm();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 24; comp.ratio.value = 6;
  master.connect(comp); comp.connect(ctx.destination);
}
function volNorm() {
  const r = parseInt(localStorage.getItem(VOL_KEY), 10);
  return Number.isFinite(r) ? Math.max(0, Math.min(100, r)) / 100 : 0.6;
}

// decode-once cache (stores the promise so concurrent requests share it)
const bufCache = new Map();
function getBuf(file) {
  if (!bufCache.has(file)) {
    bufCache.set(file, fetch(`${DIR}/${file}`)
      .then((r) => r.arrayBuffer())
      .then((a) => ctx.decodeAudioData(a)));
  }
  return bufCache.get(file);
}

// ---- license parsing (Debian copyright-format stanzas in licenses.txt) ----
function parseLicenses(text) {
  const map = {};
  for (const stanza of text.split(/\n\s*\n/)) {
    let files = [], license = '', mode = null;
    for (const raw of stanza.split('\n')) {
      const m = raw.match(/^(Files?|License|Copyright|Comment|Source|Upstream-[\w-]+|Format):\s*(.*)$/);
      if (m) {
        const key = m[1].toLowerCase();
        if (key === 'files' || key === 'file') { mode = 'files'; if (m[2].trim()) files.push(m[2].trim()); }
        else if (key === 'license') { mode = 'license'; license = m[2].trim(); }
        else mode = null;
      } else if (raw.trim() && mode === 'files') {
        files.push(raw.trim());
      }
    }
    for (const f of files) if (f.endsWith('.ogg')) map[f] = license || 'unknown';
  }
  return map;
}
// Most-permissive option wins: a clip dual-licensed "CC-BY-SA, CC-BY" is usable
// under plain CC-BY, so it counts as attribution, not copyleft.
function licenseClass(lic) {
  const s = (lic || '').toLowerCase();
  if (/cc-?0|public[ -]?domain/.test(s)) return 'free';
  const stripped = s.replace(/cc-?by-?sa/g, '');
  if (/cc-?by/.test(stripped)) return 'attrib';
  if (/cc-?by-?sa|gpl/.test(s)) return 'copyleft';
  return 'unknown';
}
const CLASS_LABEL = { free: 'CC0/PD', attrib: 'CC-BY', copyleft: 'BY-SA/GPL', unknown: '?' };

// ---- one continuous voice at a time (loop or drive); one-shots overlap ----
const GEARS = 5, RATE_LO = 0.7, RATE_HI = 1.7; // starting values — tune by ear
const speedEl = document.getElementById('speed');
const gearsEl = document.getElementById('gears');
// Faux gears: within each gear the rate ramps LO→HI then snaps back (sawtooth),
// with a slight floor climb across gears so higher gears sit higher overall.
function driveRate() {
  const s = +speedEl.value / 100;
  if (!gearsEl.checked) return RATE_LO + (RATE_HI - RATE_LO) * s;
  const x = s * GEARS, g = Math.min(GEARS - 1, Math.floor(x)), frac = x - g;
  return Math.min(RATE_HI + 0.4, RATE_LO + (RATE_HI - RATE_LO) * (0.10 * g + frac));
}

let voice = null;     // { file, mode, src, clearUI, getRate } — the ONE live sound
let startToken = 0;
function stopVoice() {
  if (!voice) return;
  const v = voice;
  voice = null;                       // clear first so a stop()-fired onended no-ops
  try { v.src.onended = null; v.src.stop(); } catch (_) {}
  v.clearUI();
}
async function startContinuous(file, mode, getRate, clearUI) {
  audio();
  stopVoice();
  const token = ++startToken;
  const buf = await getBuf(file);
  if (token !== startToken) return; // superseded while decoding
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  src.playbackRate.value = getRate();
  src.connect(master);
  src.start();
  voice = { file, mode, src, clearUI, getRate };
}
function refreshVoice() {
  if (voice) voice.src.playbackRate.setTargetAtTime(voice.getRate(), ctx.currentTime, 0.04);
}
// One-shot, but it lives in the same single-voice slot: starting it stops any
// loop/drive/other one-shot, and clicking ▶ again (now ■) stops it.
async function startOnce(file, btn) {
  audio();
  if (voice && voice.mode === 'once' && voice.file === file) { stopVoice(); return; }
  stopVoice();
  const token = ++startToken;
  const buf = await getBuf(file);
  if (token !== startToken) return; // superseded while decoding
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  const clearUI = () => { btn.classList.remove('on'); btn.textContent = '▶'; };
  src.onended = () => { if (voice && voice.src === src) voice = null; clearUI(); };
  src.start();
  btn.classList.add('on'); btn.textContent = '■';
  voice = { file, mode: 'once', src, clearUI };
}

speedEl.addEventListener('input', () => { if (voice && voice.mode === 'drive') refreshVoice(); });
gearsEl.addEventListener('change', () => { if (voice && voice.mode === 'drive') refreshVoice(); });

// ---- favorites ----
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []); } catch (_) { return new Set(); } }
function saveFavs(s) { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch (_) {} }
const favs = loadFavs();

// ---- build the list ----
const VEHICLE = /engine|car|motor|machine|horn|nitro|skid|tractor|airplane|spaceship|wee|revup|accel/i;
const grid = document.getElementById('grid');
const countEl = document.getElementById('count');
const rows = [];

async function build() {
  // Prefer a rich manifest.json ([{file, license, author, source}]); fall back
  // to files.json + a Debian-format licenses.txt (the STK folder's layout).
  let entries = await fetch(`${DIR}/manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!Array.isArray(entries)) {
    const [files, licText] = await Promise.all([
      fetch(`${DIR}/files.json`).then((r) => r.json()),
      fetch(`${DIR}/licenses.txt`).then((r) => r.text()).catch(() => ''),
    ]);
    const licenses = parseLicenses(licText);
    entries = files.map((file) => ({ file, license: licenses[file] || 'unknown' }));
  }

  for (const entry of entries) {
    const file = entry.file;
    const lic = entry.license || 'unknown';
    const cls = licenseClass(lic);

    const row = document.createElement('div');
    row.className = 'row';

    const star = document.createElement('button');
    star.className = 'star';
    const paintStar = () => { star.textContent = favs.has(file) ? '★' : '☆'; row.classList.toggle('fav', favs.has(file)); };
    star.addEventListener('click', () => {
      if (favs.has(file)) favs.delete(file); else favs.add(file);
      saveFavs(favs); paintStar(); applyFilter();
    });
    paintStar();

    const nameCell = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = file.replace(/\.(ogg|wav|flac|mp3)$/i, '');
    nameCell.appendChild(name);
    if (entry.source) {
      const src = document.createElement('div');
      src.className = 'src';
      const a = document.createElement('a');
      a.href = entry.source; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (entry.author ? entry.author + ' · ' : '') + 'source ↗';
      src.appendChild(a);
      nameCell.appendChild(src);
    }

    const badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = CLASS_LABEL[cls];
    badge.title = lic + (entry.author ? ' — ' + entry.author : '');

    const btns = document.createElement('div');
    btns.className = 'btns';
    const once = mkBtn('▶', 'play / stop', () => startOnce(file, once));
    const loop = mkBtn('🔁', 'loop (flat pitch)', () => {
      if (voice && voice.file === file && voice.mode === 'loop') { stopVoice(); return; }
      startContinuous(file, 'loop', () => +pitch.value / 100, () => loop.classList.remove('on'));
      loop.classList.add('on');
    });
    const drive = mkBtn('🚗', 'drive (loop + faux-gear pitch from Drive speed)', () => {
      if (voice && voice.file === file && voice.mode === 'drive') { stopVoice(); return; }
      startContinuous(file, 'drive', driveRate, () => drive.classList.remove('on'));
      drive.classList.add('on');
    });
    btns.append(once, loop, drive);

    const pitchCell = document.createElement('div');
    pitchCell.className = 'pitch';
    const pitch = document.createElement('input');
    pitch.type = 'range'; pitch.min = '40'; pitch.max = '250'; pitch.value = '100';
    pitch.title = 'Loop pitch (playback rate %)';
    pitch.addEventListener('input', () => { if (voice && voice.file === file && voice.mode === 'loop') refreshVoice(); });
    const pl = document.createElement('span'); pl.textContent = '×';
    pitchCell.append(pl, pitch);

    row.append(star, nameCell, badge, btns, pitchCell);
    grid.appendChild(row);
    rows.push({ row, file, name: file, cls, vehicle: VEHICLE.test(file) });
  }
  applyFilter();
}
function mkBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'play'; b.textContent = label; b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// ---- filtering ----
let filterMode = 'all';
const filterText = document.getElementById('filter');
function applyFilter() {
  const q = filterText.value.trim().toLowerCase();
  let shown = 0;
  for (const r of rows) {
    let ok = true;
    if (filterMode === 'vehicle') ok = r.vehicle;
    else if (filterMode === 'fav') ok = favs.has(r.file);
    else if (['free', 'attrib', 'copyleft'].includes(filterMode)) ok = r.cls === filterMode;
    if (ok && q) ok = r.name.toLowerCase().includes(q);
    r.row.classList.toggle('hidden', !ok);
    if (ok) shown++;
  }
  countEl.textContent = `${shown} / ${rows.length} shown`;
}
filterText.addEventListener('input', applyFilter);
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
  if (master) master.gain.setTargetAtTime(+vol.value / 100, ctx.currentTime, 0.02);
});

document.getElementById('copy-favs').addEventListener('click', async (e) => {
  const list = [...favs].sort().join('\n');
  try { await navigator.clipboard.writeText(list); e.target.textContent = 'Copied ✓'; }
  catch (_) { e.target.textContent = 'Copy failed'; }
  setTimeout(() => { e.target.textContent = 'Copy favorites'; }, 1500);
});

// Stop a lingering loop when the tab hides.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoice(); });

build();
