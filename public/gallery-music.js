// Music gallery: pick each track's song while watching that track's race.
//
// The race is the real display page (/?scenario=racing, the endless bench race
// every live gallery card runs) in one frame, driven through its
// window.__preview hook: a song started here deals the race again from the
// grid, so the two begin together as they do on GO. With game sound on, the
// frame plays the race's own sound (?sfx=1: engines, cues, no music of its
// own) and the song sits at the game's music level under it, as in a race.
//
// What a track is offered: the song it races to in the game (TRACK_MUSIC, one
// per track), the DRAFT's pick and options (/gallery-music-draft.json, absent is
// fine), and every other song, shipped or candidate. The game's songs are read
// live from its catalogue, so the page cannot claim the game plays something it
// does not. Picks go to the local dev server (/api/review-music,
// scratch/review/music-picks.json); nothing here changes what the game plays —
// the game was moved onto the picks by hand, and the page says where the two
// still differ.
import * as Gallery from './gallery-common.js';
import { CUPS, TRACK_LIST } from '/shared/tracks.js';
import { loadBiomes, cssHex } from '/shared/biomes.js';
// Straight from the catalogue's own file: this page is a dev surface.
import { TRACK_MUSIC, MUSIC_LEVEL } from '/display/audio/musicCatalogue.js';
import { storedVolume, saveVolumePercent } from '/display/audio/bus.js';

const MUSIC_DIR = '/assets/audio/music/';
const biomes = await loadBiomes();
const trackById = new Map(TRACK_LIST.map((t) => [t.id, t]));
const el = (id) => document.getElementById(id);
const fmtTime = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

// This page's own memory: the track on stage, the camera, game sound, the open list.
const STATE_KEY = 'tinytrack_gallery_music_v2';
const state = (() => {
  const d = { track: '', cam: 'chase', sfx: true, more: false, raceLen: {} };
  try { return { ...d, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch (_) { return d; }
})();
const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) { /* private mode */ } };

// ---- the songs, by file (relative to MUSIC_DIR, the draft's own key) ----
const songs = new Map();
const keyOf = (s) => s.file.slice(MUSIC_DIR.length);
// The song each track races to in the game.
const gameSong = (trackId) => keyOf(TRACK_MUSIC[trackId]);
for (const [track, s] of Object.entries(TRACK_MUSIC)) {
  const key = keyOf(s);
  if (!songs.has(key)) {
    songs.set(key, { key, url: s.file, title: s.title, artist: s.artist, license: s.license, dur: s.duration,
                     gain: s.gain, link: s.source, tracks: [], shipped: true });
  }
  songs.get(key).tracks.push(track);
}
// The draft, when it is there: per track { song, why, options }, and the
// candidate files it auditions.
const draft = await fetch('/gallery-music-draft.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const draftFor = new Map(((draft && draft.tracks) || []).map((t) => [t.track, t]));
for (const c of (draft && draft.candidates) || []) {
  if (!c || !c.file || songs.has(c.file)) continue;
  // A candidate that has since shipped IS the shipped song, under either name.
  const shipped = songs.get(c.file.replace(/^candidates\//, ''));
  if (shipped) { songs.set(c.file, shipped); continue; }
  songs.set(c.file, { key: c.file, url: MUSIC_DIR + c.file, title: c.title || c.file, artist: c.artist,
                      license: c.license, dur: c.dur, gain: c.gain || 1, link: c.page || c.url,
                      feel: c.feel, for: c.for || [], candidate: true });
}
// A file the draft names that neither the catalogue nor its candidates list.
function songOf(key) {
  if (!songs.has(key)) songs.set(key, { key, url: MUSIC_DIR + key, title: key, gain: 1, unknown: true });
  return songs.get(key);
}
// Whether a file is on the server: the candidates are local, gitignored
// downloads, so one may simply not be here.
const missing = new Set();
const checked = new Map();
function checkFile(s) {
  if (s.shipped) return Promise.resolve(true);
  if (!checked.has(s.key)) {
    checked.set(s.key, fetch(s.url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false).then((ok) => {
      if (!ok) { missing.add(s.key); paintSongs(); }
      return ok;
    }));
  }
  return checked.get(s.key);
}

// ---- picks (the local dev server's scratch/review/music-picks.json) ----
let picks = {};
let canSave = true;
const status = (text, error) => {
  el('mu-status').textContent = text || '';
  el('mu-status').classList.toggle('is-error', !!error);
};
try {
  const r = await fetch('/api/review-music');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  picks = j;
} catch (e) {
  canSave = false;
}
async function savePick(body) {
  const track = state.track;
  try {
    const r = await fetch('/api/review-music', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify({ track, ...body }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    if (j.pick) picks[track] = j.pick; else delete picks[track];
    status(`Saved to ${j.file}`);
  } catch (e) {
    status(`Not saved: ${(e && e.message) || e}`, true);
  }
  paintCups();
  paintHead();
  paintSongs();
}

// ---- playback: one <audio>, at the song's loudness trim like a race ----
const player = new Audio();
player.preload = 'none';
let playGain = 1;
// Under the race's own sound the song is at the level a race plays it.
const applyVolume = () => { player.volume = Math.min(1, storedVolume() * playGain * (state.sfx ? MUSIC_LEVEL : 1)); };
applyVolume();
let current = null;   // the playing song's key
let paused = false;   // the song AND the race, held together
let syncing = false;  // a song is loading: the race leaves the grid when it starts

function playSong(key) {
  if (current === key) { if (paused) togglePause(); else stopSong(); return; }
  const s = songOf(key);
  current = key;
  paused = false;
  syncing = true;
  player.src = s.url;
  playGain = s.gain || 1;
  applyVolume();
  if (race) race.pause();
  syncGameSound();
  player.play().catch((e) => { if (e && e.name !== 'AbortError') status(`Cannot play ${s.title}: ${e.message}`, true); });
  paintTransport();
}
player.addEventListener('playing', () => {
  if (!syncing) return;
  syncing = false;
  restartRace();
  syncGameSound();
});
// The song stops; the race runs on.
function stopSong() {
  current = null;
  player.pause();
  player.removeAttribute('src');
  player.load();
  releaseRace();
  paintTransport();
}
// Whatever held the race for the song lets it go.
function releaseRace() {
  syncing = false;
  paused = false;
  if (race) race.play();
  clock.resume();
  syncGameSound();
}
function togglePause() {
  paused = !paused;
  if (paused) {
    player.pause();
    if (race) race.pause();
    clock.pause();
  } else {
    if (current) player.play().catch(() => {});
    if (race && !syncing) race.play();
    clock.resume();
  }
  syncGameSound();
  paintTransport();
}
function restartBoth() {
  paused = false;
  if (!syncing) restartRace();
  if (current) { player.currentTime = 0; player.play().catch(() => {}); }
  syncGameSound();
  paintTransport();
}
player.addEventListener('ended', () => { current = null; paintTransport(); });
player.addEventListener('error', () => {
  if (!current || !player.getAttribute('src')) return;
  missing.add(current);
  status(`${songOf(current).title}: the file did not load`, true);
  current = null;
  releaseRace();
  paintTransport();
  paintSongs();
});
player.addEventListener('timeupdate', () => {
  if (!current) return;
  el('mu-time').textContent = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
  if (Number.isFinite(player.duration) && player.duration > 0) {
    el('mu-seek').value = String(Math.round((player.currentTime / player.duration) * 1000));
  }
});
el('mu-seek').addEventListener('input', () => {
  if (current && Number.isFinite(player.duration)) player.currentTime = (el('mu-seek').value / 1000) * player.duration;
});

// ---- the race (the framed display page's window.__preview) ----
const frame = el('mu-frame');
let race = null;   // the hook, once the frame's race is up
let loads = 0;
// The race's clock since the grid, on this page's clock: a framed preview
// does not publish its own, and paused time is not race time.
const clock = {
  base: 0, since: null,
  reset() { this.base = 0; this.since = performance.now(); },
  pause() { if (this.since != null) { this.base += performance.now() - this.since; this.since = null; } },
  resume() { if (this.since == null) this.since = performance.now(); },
  seconds() { return (this.base + (this.since != null ? performance.now() - this.since : 0)) / 1000; }
};
let deal = 0;

function loadRace() {
  race = null;
  const gen = ++loads;
  const q = new URLSearchParams({ scenario: 'racing', track: state.track, players: '1', hud: '0', sfx: '1' });
  if (state.cam === 'follow') q.set('cam', 'follow');
  frame.src = '/?' + q;
  el('mu-lap').textContent = 'Building the race…';
  const tick = () => {
    if (gen !== loads) return;
    const hook = hookOf();
    if (!hook) { setTimeout(tick, 120); return; }
    race = hook;
    hideFrameChrome();
    deal = race.deal();
    clock.reset();
    // A song playing while the race was building starts over with it; one
    // still loading starts the race itself ('playing').
    if (paused || syncing) { clock.pause(); return; }
    if (current) { player.currentTime = 0; player.play().catch(() => {}); }
    race.play();
    syncGameSound();
  };
  tick();
}
// Only the frame's CURRENT page: right after a reload it still holds the last
// one, hook and all, until the new document commits.
function hookOf() {
  try {
    const w = frame.contentWindow;
    return w && w.location.href === frame.src ? w.__preview : null;
  } catch (_) { return null; }
}
function restartRace() {
  if (!race) return;   // still building: it starts from the grid anyway
  race.restart();
  deal = race.deal();
  race.play();
  clock.reset();
}
// The display's own corner buttons (mute, fullscreen) do nothing for a race
// nobody joined.
function hideFrameChrome() {
  try { frame.contentDocument.getElementById('corner-btns')?.style.setProperty('display', 'none'); } catch (_) { /* not loaded */ }
}
frame.addEventListener('load', hideFrameChrome);

// THE RACE'S OWN SOUND: the frame's audio device (window.__audio), heard while
// game sound is on and the race runs, at the shared volume (its bus reads the
// stored level once, so a change is pushed). Off or paused, the bus goes to
// zero and the context is suspended, so a held race holds no drone and a cue
// cut off by a pause finishes after it. The context is created and resumed
// from this page's gestures (the frame takes none): a browser lets a frame
// start sound once the page around it has been clicked.
function syncGameSound() {
  const a = hookOf() && frame.contentWindow.__audio;
  if (!a) return;
  const on = state.sfx && !paused && !syncing;
  if (on) a.resume();
  if (a.master) a.master.gain.value = on ? storedVolume() : 0;
  if (!on && a.ctx && a.ctx.state === 'running') a.ctx.suspend();
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => syncGameSound(), true);

// Lap and place of your car, and how long the race here takes (its winner's
// time, once one has been seen), a few times a second.
setInterval(() => {
  if (!race) return;
  let snap;
  try { snap = frame.contentWindow.__engine.getSnapshot(); } catch (_) { return; }
  if (race.deal() !== deal) { deal = race.deal(); clock.reset(); if (paused) clock.pause(); }
  const me = snap.cars.find((c) => typeof c.id === 'number');
  const won = snap.cars.map((c) => c.finishTime).filter((t) => t != null);
  if (won.length && !state.raceLen[state.track]) {
    state.raceLen[state.track] = Math.min(...won);
    save();
    paintHead();
  }
  const where = me ? (me.finished ? ' · finished' : ` · lap ${me.lap}/${me.totalLaps} · P${me.position}`) : '';
  el('mu-lap').textContent = `Race ${fmtTime(clock.seconds())}${where}`;
}, 250);

// ---- painting ----
const cupOf = (trackId) => CUPS.find((c) => c.tracks.includes(trackId));

function paintCups() {
  const box = el('mu-cups');
  box.replaceChildren();
  for (const cup of CUPS) {
    const col = document.createElement('div');
    col.className = 'mu-cup';
    const h = document.createElement('h2');
    const dot = document.createElement('span');
    dot.className = 'biome-dot';
    dot.style.background = cssHex(biomes.hill(biomes.forCup(cup.id), 0));
    h.append(dot, cup.name);
    col.appendChild(h);
    for (const id of cup.tracks) {
      const b = document.createElement('button');
      b.className = 'mu-track' + (id === state.track ? ' is-on' : '');
      b.dataset.track = id;
      const name = document.createElement('b');
      name.textContent = trackById.get(id).name;
      const sub = document.createElement('span');
      const pick = picks[id] && picks[id].song;
      if (pick) { sub.textContent = `✓ ${songOf(pick).title}`; sub.className = 'is-picked'; }
      else sub.textContent = songOf(gameSong(id)).title;
      b.append(name, sub);
      b.addEventListener('click', () => pickTrack(id, true));
      col.appendChild(b);
    }
    box.appendChild(col);
  }
}

function paintHead() {
  const t = trackById.get(state.track);
  const cup = cupOf(state.track);
  el('mu-title').textContent = `${t.name} · ${cup.name}`;
  const len = state.raceLen[state.track];
  el('mu-today').textContent = `In the game: ${songOf(gameSong(state.track)).title}, this track's own song.`
    + (len ? ` A race here: the winner is home at ${fmtTime(len)}.` : '');
  const pick = picks[state.track];
  const p = el('mu-pick');
  p.replaceChildren();
  if (pick && pick.song) {
    const b = document.createElement('b');
    b.textContent = songOf(pick.song).title;
    p.append('Picked: ', b, ` (${new Date(pick.at).toLocaleString()})`,
             songOf(pick.song).key === gameSong(state.track) ? ', and the game plays it.' : ', not in the game yet.');
  } else {
    p.textContent = canSave ? 'No pick saved for this track yet.' : 'Picks save only on a local dev server; this one cannot.';
  }
  el('mu-clear').disabled = !(pick && pick.song);
}

// One song row: play, what it is, and the pick.
function songRow(key, tags) {
  const s = songOf(key);
  if (s.candidate || s.unknown) checkFile(s);
  const gone = missing.has(key);
  const row = document.createElement('div');
  row.className = 'mu-song' + (gone ? ' is-missing' : '');
  row.dataset.song = key;
  const pickedKey = picks[state.track] && picks[state.track].song;
  const picked = !!pickedKey && songOf(pickedKey).key === s.key;
  if (picked) row.classList.add('is-picked');

  const play = document.createElement('button');
  play.className = 'play';
  play.textContent = '▶';
  play.title = 'Play from the start, with the race from the grid';
  play.disabled = gone;
  play.addEventListener('click', () => playSong(key));

  const mid = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = s.title;
  title.title = [s.title, s.artist, s.license].filter(Boolean).join(' · ');
  const sub = document.createElement('div');
  sub.className = 'sub';
  const tag = (cls, text) => {
    const t = document.createElement('span');
    t.className = `tag tag--${cls}`;
    t.textContent = text;
    sub.appendChild(t);
  };
  if (gone) tag('missing', 'missing');
  for (const [cls, text] of tags) tag(cls, text);
  if (s.shipped) tag('shipped', `shipped · ${s.tracks.map((id) => (trackById.get(id) || { name: id }).name).join(', ')}`);
  else if (s.candidate) tag('cand', 'candidate');
  else tag('missing', 'not in the catalogue');
  if (s.dur) sub.append(fmtTime(s.dur));
  if (s.link) {
    const a = document.createElement('a');
    a.href = s.link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = ' ↗';
    a.title = 'Where it comes from';
    sub.append(a);
  }
  mid.append(title, sub);
  const said = [s.feel, s.candidate && s.for.length
    ? `suggested for ${s.for.map((id) => (trackById.get(id) || { name: id }).name).join(', ')}` : null].filter(Boolean);
  if (said.length) {
    const feel = document.createElement('div');
    feel.className = 'feel';
    feel.textContent = said.join(' · ');
    mid.appendChild(feel);
  }

  const use = document.createElement('button');
  use.className = 'ctrl use' + (picked ? ' is-on' : '');
  use.textContent = picked ? 'Picked ✓' : 'Use for this track';
  use.disabled = !canSave;
  use.addEventListener('click', () => { if (!picked) savePick({ song: key, note: el('mu-note').value }); });

  row.append(play, mid, use);
  return row;
}

function paintSongs() {
  const body = el('mu-songs');
  const scroll = body.scrollTop;
  body.replaceChildren();
  const d = draftFor.get(state.track);
  const shown = new Set();
  const section = (title, keys, tags, before) => {
    const h = document.createElement('h3');
    h.textContent = title;
    body.appendChild(h);
    for (const p of before || []) body.appendChild(p);
    for (const k of keys) { body.appendChild(songRow(k, tags)); shown.add(k); }
  };
  const para = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; };

  section('In the game', [gameSong(state.track)], [],
          [para('mu-aside', 'Every race on this track plays this song: the picks made here, moved into the game.')]);
  if (d && d.song) {
    section('Draft pick', [d.song], [['draft', 'draft pick']], d.why ? [para('mu-why', d.why)] : []);
    const opts = (d.options || []).filter((k) => k !== d.song);
    if (opts.length) section('Draft options', opts, [['draft', 'option']]);
  } else if (draft) {
    body.appendChild(para('mu-aside', 'The draft has no pick for this track.'));
  }

  // Everything else, a click away.
  const more = document.createElement('details');
  more.open = state.more;
  more.addEventListener('toggle', () => { state.more = more.open; save(); });
  const sum = document.createElement('summary');
  more.appendChild(sum);
  const group = (title, keys) => {
    if (!keys.length) return 0;
    const h = document.createElement('h4');
    h.textContent = title;
    more.appendChild(h);
    for (const k of keys) more.appendChild(songRow(k, []));
    return keys.length;
  };
  let n = 0;
  n += group('Candidates', [...songs.values()].filter((s) => s.candidate && !shown.has(s.key)).map((s) => s.key));
  for (const c of CUPS) n += group(`Shipped for ${c.name}`, c.tracks.map(gameSong).filter((k) => !shown.has(k)));
  sum.textContent = `Every other song (${n})`;
  body.appendChild(more);
  if (draft && draft.note) body.appendChild(para('mu-aside', `About the draft: ${draft.note}`));
  body.scrollTop = scroll;
  paintTransport();
}

function paintTransport() {
  const s = current && songOf(current);
  const now = el('mu-now');
  now.textContent = s ? s.title : 'No song: ▶ one beside the race';
  now.classList.toggle('is-idle', !s);
  el('mu-seek').disabled = !s;
  if (!s) { el('mu-seek').value = '0'; el('mu-time').textContent = '0:00'; }
  el('mu-pause').textContent = paused ? 'Resume' : 'Pause';
  for (const b of document.querySelectorAll('.mu-song')) {
    const on = b.dataset.song === current && !paused;
    const play = b.querySelector('.play');
    play.classList.toggle('on', on);
    play.textContent = on ? '■' : '▶';
  }
}

// ---- picking a track ----
// `auto`: start the track's chosen song (the saved pick, else the draft's) with
// its race from the grid. Only on the viewer's own pick: a song at page load is
// sound before any gesture, which the browser refuses.
function pickTrack(id, auto = false) {
  if (!trackById.has(id) || (id === state.track && frame.src)) return;
  if (current) stopSong();
  paused = false;
  state.track = id;
  save();
  history.replaceState(null, '', '#' + new URLSearchParams({ track: id }));
  el('mu-note').value = (picks[id] && picks[id].note) || '';
  status(canSave ? '' : 'Picks save only on a local dev server.', !canSave);
  paintCups();
  paintHead();
  paintSongs();
  loadRace();
  const chosen = (picks[id] && picks[id].song) || (draftFor.get(id) || {}).song;
  if (auto && chosen && songs.has(chosen) && !missing.has(chosen)) playSong(chosen);
}
function paintSfx() {
  const b = el('mu-sfx');
  b.classList.toggle('is-on', state.sfx);
  b.textContent = state.sfx ? 'Game sound: on' : 'Game sound: off';
}
el('mu-sfx').addEventListener('click', () => {
  state.sfx = !state.sfx;
  save();
  paintSfx();
  applyVolume();
  syncGameSound();
});
function paintCams() {
  for (const b of document.querySelectorAll('#mu-cams [data-cam]')) b.classList.toggle('is-on', b.dataset.cam === state.cam);
}
for (const b of document.querySelectorAll('#mu-cams [data-cam]')) {
  b.addEventListener('click', () => {
    if (b.dataset.cam === state.cam) return;
    state.cam = b.dataset.cam;
    save();
    paintCams();
    loadRace();   // from the grid, and a playing song starts over with it
  });
}

el('mu-pause').addEventListener('click', togglePause);
el('mu-restart').addEventListener('click', restartBoth);
el('mu-save-note').addEventListener('click', () => savePick({ note: el('mu-note').value }));
el('mu-clear').addEventListener('click', () => savePick({ song: null, note: el('mu-note').value }));

// ---- volume (the one preference, from display/audio/bus.js) ----
const vol = el('vol');
vol.value = String(Math.round(storedVolume() * 100));
vol.addEventListener('input', () => {
  saveVolumePercent(vol.value);
  applyVolume();
  syncGameSound();
});

// Space pauses both, R restarts both, [ and ] step through the tracks.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === 'r' || e.key === 'R') restartBoth();
  else if (e.key === '[' || e.key === ']') {
    const ids = CUPS.flatMap((c) => c.tracks);
    const i = ids.indexOf(state.track) + (e.key === ']' ? 1 : -1);
    pickTrack(ids[(i + ids.length) % ids.length], true);
  }
});
// A forgotten song or engine behind a hidden tab is exactly what this page
// shouldn't do (a hidden frame stops drawing, and its voices would hold).
document.addEventListener('visibilitychange', () => { if (document.hidden && !paused) togglePause(); });

Gallery.initMobileOptionsToggle();
paintCams();
paintSfx();
const linked = new URLSearchParams(location.hash.slice(1)).get('track');
pickTrack([linked, state.track, draft && draft.tracks && draft.tracks[0] && draft.tracks[0].track, CUPS[0].tracks[0]]
  .find((id) => trackById.has(id)));
