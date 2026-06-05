// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.
import { buildCarPicker } from '../shared/carPicker.js';

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const el = (id) => document.getElementById(id);

// runControllerScenario({ scenario, color, players })
export function runControllerScenario(opts) {
  const COLORS = window.CAR_COLORS || ['#2bb673'];
  const scenario = opts.scenario;
  const color = Math.max(0, Math.min(opts.color || 0, COLORS.length - 1));

  const screens = { name: el('name'), lobby: el('lobby'), game: el('game') };
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

  // Latency chip preview — no relay here, so feed it a static reading. fastlane
  // shows the bolt; quality colour follows the same thresholds as main.js.
  function setLatency(halfMs, fastlane) {
    const chip = el('latency'); if (!chip) return;
    chip.classList.remove('hidden', 'latency--good', 'latency--ok', 'latency--bad');
    chip.classList.toggle('latency--fastlane', !!fastlane);
    chip.querySelector('.latency__text').textContent = halfMs + ' ms';
    chip.classList.add(halfMs < 50 ? 'latency--good' : halfMs < 100 ? 'latency--ok' : 'latency--bad');
  }

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
      renderCarPicker(color); // default pick mirrors the livery slot
      el('start-btn').classList.remove('hidden');
      el('wait-host').classList.add('hidden');
      break;

    case 'lobby-waiting': {
      show('lobby');
      renderCarPicker(color);
      el('start-btn').classList.add('hidden');
      const waitEl = el('wait-host');
      waitEl.classList.remove('hidden');
      // Fabricate a host (someone other than this player) so the preview shows
      // the tinted name treatment, mirroring main.js renderWaitHost.
      const hostColor = (color + 1) % COLORS.length;
      const nameEl = document.createElement('span');
      nameEl.className = 'host-name';
      nameEl.textContent = FAKE_NAMES[hostColor];
      nameEl.style.color = COLORS[hostColor];
      waitEl.textContent = 'Waiting for ';
      waitEl.append(nameEl, ' to start…');
      break;
    }

    case 'countdown': {
      showDriveHud();
      el('go').classList.remove('hidden');
      el('go').textContent = '3';
      setSteer(0);
      setHud(1, 3, 1, false);
      setLatency(24, false);   // pre-fastlane: WS reading, no bolt
      // `timers` lives in the case scope so a re-play cancels the previous
      // sequence instead of racing it.
      const go = el('go');
      const seq = ['3', '2', '1', 'GO!'];
      let timers = [];
      window.__TEST__.replay = function() {
        timers.forEach(clearTimeout); timers = [];
        let i = 0;
        (function tick() {
          go.textContent = seq[i]; i++;
          if (i < seq.length) timers.push(setTimeout(tick, 800));
          else timers.push(setTimeout(() => { go.textContent = '3'; }, 1200));
        })();
      };
      break;
    }

    case 'playing':
      showDriveHud();
      el('go').classList.add('hidden');
      setSteer(0.4); // mid-right tilt, so the steer bar reads off-center
      setHud(2, 3, 2, false);
      setLatency(16, true);    // fastlane up: low RTT + bolt
      break;

    case 'finished':
      showDriveHud();
      el('go').classList.add('hidden');
      setSteer(0);
      setHud(3, 3, 1, true);
      setLatency(19, true);
      break;

    case 'paused':
      showDriveHud();
      el('go').classList.add('hidden');
      setSteer(0.2);
      setHud(2, 3, 2, false);
      setLatency(18, true);
      el('pause-btn').classList.remove('hidden');
      el('pause-btn').disabled = true;     // overlay covers it while paused
      el('pause-overlay').classList.remove('hidden');
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
}
