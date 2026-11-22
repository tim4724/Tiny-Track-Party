// What this phone saw of its own cup: how it steered, how its link to the TV
// behaved, and who finished where. Kept in memory only, and it leaves the phone
// in exactly one way: attached to the feedback the player chooses to send
// (feedback.js), and only while their "Include race stats" switch is on.
//
// Nothing here names anyone: no player names, no room code, no addresses. The
// privacy policy on paperballoon.games names these kinds of data; a new kind
// belongs there too.

// One-way delay buckets in ms: under 10, 10-20, ... , 250 and over. Fixed, so
// submissions add up on the server and percentiles can be read off the sums.
const EDGES = [10, 20, 35, 50, 75, 100, 150, 250];
const buckets = () => EDGES.map(() => 0).concat(0);

// The feedback service takes no free text inside a game's data block, only
// short plain tokens, so a name from the catalogue is cut down to one.
export const token = (s) => String(s).replace(/[^A-Za-z0-9 :._#()+-]/g, '').slice(0, 40);

// The direct link's story spans the session (it opens once, at join); the rest
// is per cup and starts over in the lobby.
const lane = { joinedAt: 0, firstOpenMs: null, everOpen: false, noWebrtc: false, path: null, up: false };
let cup = freshCup();
let hiddenAt = 0;
let modeNow = () => 'tilt';   // set by initRaceStats

function freshCup() {
  return {
    direct: buckets(), relay: buckets(),
    noSignalS: 0, reconnects: 0, backgroundS: 0, drops: 0,
    tiltS: 0, buttonsS: 0, directS: 0,
    races: []   // [{ index, track, order }]
  };
}

// `isDriving`, `inputMode` and `fastlaneUp` are read once a second, which is all
// the resolution a share of driving time needs.
export function initRaceStats({ isDriving, inputMode, fastlaneUp }) {
  modeNow = inputMode;
  setInterval(() => {
    if (!isDriving()) return;
    if (inputMode() === 'buttons') cup.buttonsS++; else cup.tiltS++;
    if (fastlaneUp()) cup.directS++;
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt) cup.backgroundS += Math.round((Date.now() - hiddenAt) / 1000);
    hiddenAt = 0;
  });
}

export function resetRaceStats() { cup = freshCup(); }

export function noteJoined() { if (!lane.joinedAt) lane.joinedAt = Date.now(); }

// Every reading the latency chip shows. The relay reports once a second, so a
// "no signal" reading (halfMs < 0) is one second without an answer.
export function noteRtt(halfMs, viaFastlane) {
  if (halfMs < 0) { cup.noSignalS++; return; }
  let i = 0;
  while (i < EDGES.length && halfMs >= EDGES[i]) i++;
  (viaFastlane ? cup.direct : cup.relay)[i]++;
}

export function noteLink(state, info) {
  if (state === 'reconnecting' && info && info.attempt === 1) cup.reconnects++;
}

// Net.js's account of the direct link: 'none' (no WebRTC here), 'open',
// 'closed', and 'path' with 'lan' or 'nat' once the route is known.
export function noteFastlane(event, path) {
  if (event === 'none') lane.noWebrtc = true;
  else if (event === 'path') lane.path = path;
  else if (event === 'open') {
    lane.up = true;
    if (!lane.everOpen) {
      lane.everOpen = true;
      if (lane.joinedAt) lane.firstOpenMs = Date.now() - lane.joinedAt;
    }
  } else if (event === 'closed') {
    // A failed attempt closes too; only a channel that was up counts as a drop.
    if (lane.up) cup.drops++;
    lane.up = false;
  }
}

// One finished race off its landed board. `order` is the finishing order as
// 'bot', 'human:<Car>' or 'you:<Car>': which car did how well, never who drove.
// `t` is the winner's time in tenths of a second. Track, order and that time
// together are the race's fingerprint: every phone on the couch reports the same
// one, so the server can count a race once without any id for the room.
export function noteRace(board, { meId, trackId, carOf }) {
  const index = board.series ? board.series.raceIndex : 0;
  if (cup.races.some((r) => r.index === index)) return;
  const rows = (board.order || []).filter((o) => !o.joining);
  // The board may be sorted by the cup; racePlace is the finish. A DNF has none.
  const place = (o) => (o.finished && o.racePlace ? o.racePlace : 99);
  const order = rows.slice().sort((a, b) => place(a) - place(b)).map((o) => (
    o.ai ? 'bot' : (o.playerId === meId ? 'you:' : 'human:') + token(carOf(o.playerId) || 'unknown')
  ));
  // `totals` is the board's own standing, bot or human with their points, in the
  // order the board lists them. Never sent; it only feeds sessionId below.
  const totals = rows.map((o) => `${o.ai ? 'b' : 'h'}${o.points || 0}`).join(',');
  const race = { index, track: trackId || 'unknown', order, totals };
  const winner = rows.find((o) => o.finished && o.racePlace === 1);
  if (winner && winner.time > 0) race.t = Math.round(winner.time * 10);
  cup.races.push(race);
}

// The envelope's `session`: one value every phone on this couch arrives at on its
// own, so the service can tell that their reports belong together. It is a hash
// of the cup's LAST board: that race's track, winner's time and finishing order,
// and the points every car ends the cup on. None of it is in any log or opens a
// room. The last board, because the question appears on it: every phone that is
// asked has it, where a late joiner lacks the first race and a phone that slept
// through a board lacks the full set.
// Not a secret, so a plain 53-bit string hash (cyrb53) does; null until a timed
// race is in.
export function sessionId() {
  const last = cup.races[cup.races.length - 1];
  if (!last || !last.t) return null;
  const text = `${last.track}|${last.t}|${last.order.join(',').replace(/you:/g, 'human:')}|${last.totals}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}

// The stats block of a feedback submission.
export function raceStats(device) {
  const driven = cup.tiltS + cup.buttonsS;
  const fastlane = {
    result: lane.everOpen ? 'open' : lane.noWebrtc ? 'no-webrtc' : 'failed',
    drops: cup.drops,
    share: driven ? Math.round(cup.directS / driven * 100) / 100 : 0
  };
  if (lane.everOpen) {
    if (lane.firstOpenMs != null) fastlane.firstOpenMs = lane.firstOpenMs;
    if (lane.path) fastlane.path = lane.path;
  }
  return {
    steering: { tilt: driven ? Math.round(cup.tiltS / driven * 100) / 100 : (modeNow() === 'buttons' ? 0 : 1) },
    link: {
      direct: cup.direct, relay: cup.relay,
      noSignalS: cup.noSignalS, reconnects: cup.reconnects, backgroundS: cup.backgroundS
    },
    fastlane,
    races: cup.races.map(({ track, order, t }) => (t ? { track, order, t } : { track, order })),
    device
  };
}
