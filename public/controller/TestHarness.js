// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.
import { carThumbNode } from '../shared/carThumbs.js';

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

  // Car picker (mirrors main.js): every model as a real pre-baked render, with
  // `selected` highlighted. Car is independent of colour, so no roster; the
  // livery shows as the selection ring. Spin mode (?carview=spin) rotates the
  // selected car.
  const MODELS = window.CAR_MODELS || [];
  const NAMES = window.CAR_NAMES || [];
  function renderCarPicker(selected) {
    const pick = el('carpick'); if (!pick) return; pick.innerHTML = '';
    const count = MODELS.length || 4;
    for (let i = 0; i < count; i++) {
      const mine = i === selected;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'car-opt' + (mine ? ' car-opt--mine' : '');
      const name = document.createElement('span');
      name.className = 'car-opt__name';
      name.textContent = NAMES[i] || ('Car ' + (i + 1));
      btn.appendChild(carThumbNode(MODELS[i], { spin: mine }));
      btn.appendChild(name);
      pick.appendChild(btn);
    }
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

    case 'lobby-waiting':
      show('lobby');
      renderCarPicker(color);
      el('start-btn').classList.add('hidden');
      el('wait-host').classList.remove('hidden');
      break;

    case 'countdown': {
      showDriveHud();
      el('go').classList.remove('hidden');
      el('go').textContent = '3';
      setSteer(0);
      setHud(1, 3, 1, false);
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
      break;

    case 'finished':
      showDriveHud();
      el('go').classList.add('hidden');
      setSteer(0);
      setHud(3, 3, 1, true);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
}
