// Sound gallery — audition surface for the candidate cue palette in
// /display/audio/cues.js. No relay, no engine: just buttons that play each
// variant the way the race would fire it, plus a star per variant to record
// which candidate wins. Picks live in localStorage; the race wiring reads the
// approved palette from cues.js once the audition round settles it.
import { CUES } from '/display/audio/cues.js';

const VOLUME_KEY = 'tinytrack_sound_volume_v1';
const PICKS_KEY = 'tinytrack_sound_picks_v1';

// ---- audio graph (lazy — browsers need a user gesture before audio runs) ----
let ctx = null, master = null;
function audio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return { ctx, master };
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume();
  // Soft limiter so spamming overlapping cues can't clip the TV speakers.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  master.connect(comp);
  comp.connect(ctx.destination);
  return { ctx, master };
}

function volume() {
  const raw = parseInt(localStorage.getItem(VOLUME_KEY), 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.6;
}

function loadPicks() {
  try { return JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; }
  catch (_) { return {}; }
}
function savePicks(picks) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(picks)); } catch (_) {}
}

// ---- UI ----
const picks = loadPicks();
const grid = document.getElementById('sound-grid');
const running = new Map(); // cueId -> { handle, btn, slider } for continuous cues

function makeVariantRow(cue, variant) {
  const row = document.createElement('div');
  row.className = 'sound-variant';

  const play = document.createElement('button');
  play.className = 'card-btn sound-play';
  play.textContent = '▶ ' + variant.label;

  if (cue.continuous) {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '100'; slider.value = '30';
    slider.className = 'sound-speed';
    slider.title = 'Pack speed';
    play.textContent = '▶ ' + variant.label;
    play.addEventListener('click', () => {
      // One live voice per cue: stop whichever variant is running (resetting
      // ITS button), and only start this one if it wasn't the one playing.
      const cur = running.get(cue.id);
      if (cur) {
        cur.handle.stop();
        running.delete(cue.id);
        cur.btn.textContent = '▶ ' + cur.label;
        cur.btn.classList.remove('playing');
        if (cur.btn === play) return; // toggled itself off
      }
      const { ctx, master } = audio();
      const handle = variant.start(ctx, master);
      handle.set(slider.value / 100);
      running.set(cue.id, { handle, btn: play, label: variant.label });
      play.textContent = '■ ' + variant.label;
      play.classList.add('playing');
    });
    slider.addEventListener('input', () => {
      const cur = running.get(cue.id);
      if (cur) cur.handle.set(slider.value / 100);
    });
    row.appendChild(play);
    row.appendChild(slider);
  } else {
    play.addEventListener('click', () => {
      const { ctx, master } = audio();
      const dur = variant.play(ctx, master) || 0.3;
      play.classList.add('playing');
      setTimeout(() => play.classList.remove('playing'), dur * 1000);
    });
    row.appendChild(play);
  }

  const star = document.createElement('button');
  star.className = 'card-btn sound-star';
  star.title = 'Pick this variant for the race';
  function paintStar() {
    const picked = picks[cue.id] === variant.id;
    star.textContent = picked ? '★' : '☆';
    star.classList.toggle('picked', picked);
    row.classList.toggle('picked', picked);
  }
  star.addEventListener('click', () => {
    if (picks[cue.id] === variant.id) delete picks[cue.id];
    else picks[cue.id] = variant.id;
    savePicks(picks);
    paintAll(cue.id);
  });
  row.appendChild(star);
  row._paint = paintStar;
  paintStar();
  return row;
}

const rowsByCue = new Map(); // cueId -> [row]
function paintAll(cueId) {
  for (const row of rowsByCue.get(cueId) || []) row._paint();
}

for (const cue of CUES) {
  const card = document.createElement('div');
  card.className = 'card sound-card';

  const head = document.createElement('div');
  head.className = 'card-title';
  const title = document.createElement('span');
  title.textContent = cue.label;
  head.appendChild(title);
  card.appendChild(head);

  const desc = document.createElement('p');
  desc.className = 'sound-desc';
  desc.textContent = cue.desc;
  card.appendChild(desc);

  const rows = cue.variants.map((v) => makeVariantRow(cue, v));
  rowsByCue.set(cue.id, rows);
  for (const row of rows) card.appendChild(row);

  grid.appendChild(card);
}

// ---- header controls ----
const vol = document.getElementById('master-volume');
vol.value = String(Math.round(volume() * 100));
vol.addEventListener('input', () => {
  try { localStorage.setItem(VOLUME_KEY, vol.value); } catch (_) {}
  if (master) master.gain.setTargetAtTime(vol.value / 100, ctx.currentTime, 0.02);
});

// Export the starred picks as JSON — the bridge from "auditioned in this
// browser" to "baked into DEFAULT_PICKS for every machine".
const copyBtn = document.getElementById('copy-picks');
copyBtn.addEventListener('click', async () => {
  const json = JSON.stringify(picks);
  let ok = false;
  try { await navigator.clipboard.writeText(json); ok = true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) { /* leave ok=false */ }
  }
  copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => { copyBtn.textContent = 'Copy picks'; }, 1500);
});

document.getElementById('clear-picks').addEventListener('click', () => {
  for (const k of Object.keys(picks)) delete picks[k];
  savePicks(picks);
  for (const id of rowsByCue.keys()) paintAll(id);
});

// Stop any continuous cue when the tab hides — a forgotten putt-putt drone is
// exactly the annoyance this page exists to prevent.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  for (const [id, cur] of running) { cur.handle.stop(); running.delete(id); }
  for (const btn of document.querySelectorAll('.sound-play.playing')) {
    btn.classList.remove('playing');
    btn.textContent = '▶ ' + btn.textContent.slice(2);
  }
});
