// Controller Test Harness — drives a single phone screen in isolation for the
// gallery (/gallery-controller.html), with NO relay connection. main.js
// delegates here when the URL carries ?scenario=…; we apply the player's
// livery and lay out the requested screen from fake data.
//
// Pure DOM: the controller has no 3D scene, so nothing async to await.

const FAKE_NAMES = ['Mia', 'Theo', 'Ava', 'Leo', 'Zoe', 'Max', 'Ivy', 'Sam'];
const el = (id) => document.getElementById(id);

// runControllerScenario({ scenario, color, players })
export function runControllerScenario(opts) {
  const COLORS = window.CAR_COLORS || ['#2bb673'];
  const scenario = opts.scenario;
  const color = Math.max(0, Math.min(opts.color || 0, COLORS.length - 1));
  // != null (not ||) so an explicit players=0 clamps to 1 rather than 4.
  const players = Math.max(1, Math.min(opts.players != null ? opts.players : 4, COLORS.length));

  const screens = { name: el('name'), lobby: el('lobby'), game: el('game') };
  const show = (name) => { for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name); };

  // Apply the player's car livery (the --car custom property tints the HUD).
  const myColor = COLORS[color % COLORS.length];
  document.documentElement.style.setProperty('--car', myColor);
  if (el('mycar')) el('mycar').style.background = myColor;

  window.__TEST__ = window.__TEST__ || {};

  // Roster slots: 0..players-1, but guarantee the viewed color is present
  // (it's "me") even when color >= players.
  function buildSlots() {
    const slots = [];
    let fill = players;
    if (color >= players) fill = players - 1;
    for (let i = 0; i < fill; i++) slots.push(i);
    if (color >= players) slots.push(color);
    return slots;
  }

  function renderRoster(hostIdx) {
    const list = el('roster'); list.innerHTML = '';
    for (const s of buildSlots()) {
      const row = document.createElement('div');
      row.className = 'row' + (s === color ? ' row--me' : '');
      const dot = document.createElement('span');
      dot.className = 'row__dot'; dot.style.background = COLORS[s % COLORS.length] || '#888';
      row.appendChild(dot);
      const nm = document.createElement('span');
      nm.textContent = FAKE_NAMES[s] + (s === hostIdx ? ' ★' : '');
      row.appendChild(nm);
      list.appendChild(row);
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
      renderRoster(color); // I am the host
      el('start-btn').classList.remove('hidden');
      el('wait-host').classList.add('hidden');
      break;

    case 'lobby-waiting': {
      // Host is any rostered slot that isn't the viewed player (the one
      // waiting). With a single slot there's no other player, so no ★ — which
      // matches the "waiting for the host" copy below.
      const others = buildSlots().filter((s) => s !== color);
      const hostIdx = others.length ? others[0] : null;
      show('lobby');
      renderRoster(hostIdx);
      el('start-btn').classList.add('hidden');
      el('wait-host').classList.remove('hidden');
      break;
    }

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
