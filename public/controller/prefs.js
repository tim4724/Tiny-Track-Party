// Everything this phone remembers between visits. One file because they share
// one hazard: localStorage THROWS on access in Safari private mode, so every
// read and write is wrapped and every read has a fallback. A preference that
// cannot be stored must cost the convenience and nothing else — never the page.
//
// The launcher's injected identity deliberately does NOT come through here: it
// belongs to the shell, not to the device, and persisting it would leak into the
// name the standalone browser offers (CONTRACT.md §1). See launcher.js.

const NAME_KEY = 'tinytrack_name';
const MODE_KEY = 'tinytrack_mode';     // host's last pick, JSON {mode, trackId?, cupId?, randomRaces?}
const TRACK_KEY = 'tinytrack_track';   // legacy pre-mode key (bare track id) — read-only fallback
const CAR_KEY = 'tinytrack_car';       // last-picked car model index
const HELP_SEEN_KEY = 'tinytrack_seen_help';
const INPUT_KEY = 'tinytrack_input';   // steering input mode: 'tilt' (default) | 'buttons'

const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

export const storedName = () => read(NAME_KEY) || '';
export const saveName = (n) => write(NAME_KEY, n);

export const storedCarIndex = () => {
  const v = parseInt(read(CAR_KEY), 10);
  return Number.isInteger(v) ? v : null;
};
export const saveCarIndex = (i) => write(CAR_KEY, String(i));

export const helpSeen = () => read(HELP_SEEN_KEY) === '1';
export const markHelpSeen = () => write(HELP_SEEN_KEY, '1');

// Steering input mode — anything but the literal 'buttons' is tilt, so a
// corrupted value degrades to the default rather than to a surprise.
export const storedInputMode = () => (read(INPUT_KEY) === 'buttons' ? 'buttons' : 'tilt');
export const saveInputMode = (m) => write(INPUT_KEY, m === 'buttons' ? 'buttons' : 'tilt');

export const saveMode = (m) => write(MODE_KEY, JSON.stringify(m));
export function storedMode() {
  try { const v = JSON.parse(read(MODE_KEY) || 'null'); if (v && v.mode) return v; } catch (_) {}
  // Upgrade path: a phone that last picked before modes existed keeps its favourite track.
  const id = read(TRACK_KEY);
  return id ? { mode: 'track', trackId: id } : null;
}
