// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.
import { buildCarPicker } from '../shared/carPicker.js';
import { buildTrackPicker } from '../shared/trackPicker.js';
import { applyLatencyChip, renderWaitNote } from './ui.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];

// Illustrative track catalog for the gallery preview. The real schematics are
// computed on the display from track geometry (see display/trackSchematic.js) and
// shipped in WELCOME; the controller has no geometry, so here we hand-author a
// couple of representative map paths just so the picker renders.
const FAKE_TRACKS = [
  { id: 'switchback', name: 'Switchback', svg: {
    viewBox: '0 0 100 100',
    d: 'M30 20 H70 Q80 20 80 30 V70 Q80 80 70 80 H30 Q20 80 20 70 V30 Q20 20 30 20 Z',
    start: { x: 50, y: 20 } } },
  { id: 'crossover', name: 'Crossover', svg: {
    viewBox: '0 0 100 100',
    d: 'M50 18 C72 18 82 33 82 50 C82 67 72 82 50 82 C28 82 18 67 18 50 C18 33 28 18 50 18 Z',
    start: { x: 50, y: 18 } } }
];

const el = (id) => document.getElementById(id);

// runControllerScenario({ scenario, color })
export function runControllerScenario(opts) {
  const COLORS = window.CAR_COLORS || ['#2bb673'];
  const scenario = opts.scenario;
  const color = Math.max(0, Math.min(opts.color || 0, COLORS.length - 1));

  const screens = { name: el('name'), lobby: el('lobby'), game: el('game'), results: el('results') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  // Apply the player's car livery (the --car custom property tints the HUD and
  // the car-picker tiles).
  const myColor = COLORS[color % COLORS.length];
  document.documentElement.style.setProperty('--car', myColor);

  window.__TEST__ = window.__TEST__ || {};

  // Car picker — the real shared layout (hero preview + stats + tap strip). Taps
  // re-render so the gallery shows the selection updating the big preview live.
  function renderCarPicker(selected) {
    buildCarPicker({
      heroEl: el('car-hero'), stripEl: el('carpick'),
      selected, onPick: (i) => renderCarPicker(i)
    });
  }

  // Track picker — mirrors main.js renderTrackPicker. Host taps re-render so the
  // gallery shows the ring + Start gating update live; non-host is read-only.
  function renderTrackPicker(selected, canPick) {
    el('trackpick').classList.remove('hidden');
    buildTrackPicker({
      stripEl: el('track-strip'), catalog: FAKE_TRACKS, selected, canPick,
      onPick: canPick ? (id) => renderTrackPicker(id, canPick) : null
    });
    if (canPick) el('start-btn').disabled = !selected; // greyed until a track is picked
    const note = el('track-note');
    if (!canPick) { note.textContent = 'The host picks the track'; note.classList.remove('hidden'); }
    else if (!selected) { note.textContent = 'Pick a track to start'; note.classList.remove('hidden'); }
    else note.classList.add('hidden');
  }

  // Results board — mirrors main.js renderResults + renderResultFoot. `over=false`
  // is the "you just finished, others still out" state (some rows "Racing…", a
  // waiting footer); `over=true` is the final board (host gets "New game").
  function renderResultsBoard(order, over) {
    show('results');
    const list = el('result-list'); list.innerHTML = '';
    order.forEach((o) => {
      const li = document.createElement('li');
      if (o.me) li.classList.add('is-me');
      if (!o.finished) li.classList.add('is-racing');
      const dot = document.createElement('span'); dot.className = 'res-dot';
      dot.style.background = COLORS[o.colorIndex] || '#888';
      const name = document.createElement('span'); name.className = 'res-name';
      name.textContent = o.name + (o.ai ? ' (CPU)' : o.me ? ' (You)' : '');
      const time = document.createElement('span'); time.className = 'res-time';
      time.textContent = o.finished ? `${o.time.toFixed(1)}s` : (over ? 'DNF' : 'Racing…');
      li.append(dot, name, time);
      list.appendChild(li);
    });
    el('newgame-btn').classList.toggle('hidden', !over);   // host gets "New game" once over
    const wait = el('result-wait');
    wait.classList.toggle('hidden', !!over);
    if (!over) wait.textContent = 'Waiting for the other racers to finish…';
  }

  // Latency chip preview — no relay here, so feed it a static reading.
  const setLatency = (halfMs, fastlane) => applyLatencyChip(el('latency'), halfMs, fastlane);

  const setSteer = (v) => { const f = el('steer-fill'); if (f) f.style.transform = `translateX(${v * 50}%)`; };
  function setHud(lap, total, pos, finished) {
    el('lap').textContent = `Lap ${lap}/${total}`;
    el('pos').textContent = finished ? `Finished P${pos}` : `P${pos}`;
    el('pos').classList.toggle('leader', pos === 1);
  }
  function showDriveHud() {
    show('game');
    el('drive-hud').classList.remove('hidden');
    el('motion-tip').classList.add('hidden');
  }

  switch (scenario) {
    case 'name':
      show('name');
      el('name-input').value = '';
      el('name-status').textContent = '';
      break;

    case 'name-connecting':
      show('name');
      el('name-input').value = FAKE_NAMES[color];
      el('name-input').disabled = true;
      el('name-form').querySelector('button').disabled = true;
      el('name-status').textContent = '';
      break;

    case 'lobby-host':
      show('lobby');
      el('me-name').textContent = FAKE_NAMES[color];
      renderCarPicker(color); // default pick mirrors the livery slot
      renderTrackPicker(null, true); // host can pick; nothing chosen yet (Start greyed)
      el('start-btn').classList.remove('hidden');
      el('wait-host').classList.add('hidden');
      break;

    case 'lobby-waiting': {
      show('lobby');
      el('me-name').textContent = FAKE_NAMES[color];
      renderCarPicker(color);
      renderTrackPicker('crossover', false); // read-only; reflects the host's pick
      el('start-btn').classList.add('hidden');
      const waitEl = el('wait-host');
      waitEl.classList.remove('hidden');
      // Fabricate a host (someone other than this player) so the preview shows
      // the tinted name treatment, mirroring main.js renderWaitHost.
      const hostColor = (color + 1) % COLORS.length;
      renderWaitNote(waitEl, { name: FAKE_NAMES[hostColor], color: COLORS[hostColor] }, ' to start…');
      break;
    }

    case 'countdown':
      // No countdown on the controller — the full HUD is up from the first beat
      // (the 3..2..1..GO lives on the display). Same as 'playing' but pre-fastlane.
      showDriveHud();
      setSteer(0);
      setHud(1, 3, 1, false);
      setLatency(24, false);   // pre-fastlane: WS reading, no bolt
      break;

    case 'playing':
      showDriveHud();
      setSteer(0.4); // mid-right tilt, so the steer bar reads off-center
      setHud(2, 3, 2, false);
      setLatency(16, true);    // fastlane up: low RTT + bolt
      break;

    case 'finished':
      // Your car crossed the line — the phone flips to the results board with your
      // finished row while the rest are still out (not the drive HUD).
      setLatency(19, true);
      renderResultsBoard([
        { name: FAKE_NAMES[color], colorIndex: color, time: 31.2, me: true, finished: true },
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, finished: false },
        { name: 'Bolt', colorIndex: (color + 2) % COLORS.length, ai: true, finished: false },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, finished: false }
      ], false);
      break;

    case 'paused':
      showDriveHud();
      setSteer(0.2);
      setHud(2, 3, 2, false);
      setLatency(18, true);
      el('pause-btn').classList.remove('hidden');
      el('pause-btn').disabled = true;     // overlay covers it while paused
      el('pause-overlay').classList.remove('hidden');
      break;

    case 'results':
      // Final board (race over), viewed as the host so the "New game" button shows.
      setLatency(20, true);
      renderResultsBoard([
        { name: FAKE_NAMES[(color + 1) % FAKE_NAMES.length], colorIndex: (color + 1) % COLORS.length, time: 28.4, finished: true },
        { name: FAKE_NAMES[color],                           colorIndex: color,                       time: 31.2, me: true, finished: true },
        { name: 'Bolt',                                      colorIndex: (color + 2) % COLORS.length, time: 33.9, ai: true, finished: true },
        { name: FAKE_NAMES[(color + 3) % FAKE_NAMES.length], colorIndex: (color + 3) % COLORS.length, time: 36.5, finished: true }
      ], true);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
}
