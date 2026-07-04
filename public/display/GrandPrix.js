// Grand Prix series engine — the pure cup-scoring core behind "pick a Cup" mode.
// A CupSeries walks one cup's tracks in CUPS order, banks points per race
// (POINTS_BY_RANK by finish rank, DNF = 0) and answers the intermission /
// podium standings. Display-side only, but kept dependency-free, clock-free and
// RNG-injected (like engine/Game.js) so node:test drives it directly and the
// portable-purity gate scans it: all identity/meta comes in through applyRace,
// randomness comes in through makeShuffleBag's rng.

// Points by finish rank (1st..4th). The field is always FIELD_SIZE = 4 (humans
// + AI top-up), so this is the whole table; DNF earns nothing regardless of rank.
export const POINTS_BY_RANK = [9, 6, 3, 1];

// Endless track draw with no repeats until every id has been seen: deal from a
// shuffled copy, reshuffle when empty, and never let the first draw of a fresh
// bag repeat the last draw of the old one. rng is injected (page Math.random in
// the display, a seeded LCG in tests) — () => [0,1).
export function makeShuffleBag(ids, rng) {
  const all = [...ids];
  let bag = [];
  let last = null;
  const refill = () => {
    bag = [...all];
    for (let i = bag.length - 1; i > 0; i--) { // Fisher–Yates
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // draw() pops from the END — swap a boundary repeat to the far end of the bag
    if (all.length > 1 && bag[bag.length - 1] === last) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
  };
  return {
    draw() {
      if (!bag.length) refill();
      last = bag.pop();
      return last;
    }
  };
}

// One cup's 4-race series. Participants are keyed by playerId (peerIndex for
// humans, 'ai-N' for bots — stable while the roster holds). Everyone ever seen
// stays on the board: a dropped player keeps their points and simply stops
// gaining; a late joiner scores from the race they first appear in.
export class CupSeries {
  constructor(cup) {
    this.cup = cup;              // a CUPS entry: {id, name, tracks: [4 ids]}
    this.raceIndex = 0;          // 0-based race currently being raced / just raced
    this._lastApplied = -1;      // raceIndex of the last applyRace (for tie-breaks)
    this._done = false;          // final race's results are in → podium time
    this._meta = new Map();      // playerId → {name, colorIndex, ai, points, gained, lastRank, lastRaceIndex}
  }

  get raceCount() { return this.cup.tracks.length; }
  get currentTrackId() { return this.cup.tracks[this.raceIndex]; }
  get nextTrackId() {
    return this.raceIndex + 1 < this.raceCount ? this.cup.tracks[this.raceIndex + 1] : null;
  }
  get finished() { return this._done; }

  // Bank one race. results = Game.getResults().results ({playerId, rank,
  // finished, time}); field = the display's currentField ({peerIndex, name,
  // colorIndex, ai, ...}) — the only side that can name/colour the AI seats.
  applyRace(results, field) {
    const seats = new Map(field.map((p) => [p.peerIndex, p]));
    for (const m of this._meta.values()) m.gained = 0; // absentees show "+0" this round
    for (const res of results) {
      const seat = seats.get(res.playerId) || {};
      let m = this._meta.get(res.playerId);
      if (!m) {
        m = { name: seat.name, colorIndex: seat.colorIndex, ai: !!seat.ai, points: 0, gained: 0, lastRank: null, lastRaceIndex: -1 };
        this._meta.set(res.playerId, m);
      }
      m.gained = res.finished ? (POINTS_BY_RANK[res.rank - 1] || 0) : 0;
      m.points += m.gained;
      m.lastRank = res.rank;
      m.lastRaceIndex = this.raceIndex;
    }
    this._lastApplied = this.raceIndex;
    if (this.raceIndex >= this.raceCount - 1) this._done = true;
  }

  // Move to the next race (the intermission's "Next race ▸"). No-op past the end.
  advance() {
    if (this.raceIndex + 1 < this.raceCount) this.raceIndex++;
  }

  // Cup order: points, then placement in the LATEST race (whoever beat whom just
  // now wins the tie; sitting that race out loses it), then first-seen order —
  // sort() is stable, so double-ties never shuffle between broadcasts.
  standings() {
    const rows = [...this._meta.entries()].map(([playerId, m]) => ({
      playerId, name: m.name, colorIndex: m.colorIndex, ai: m.ai,
      points: m.points, gained: m.gained, lastRank: m.lastRank
    }));
    const latest = (id) => {
      const m = this._meta.get(id);
      return m.lastRaceIndex === this._lastApplied ? m.lastRank : Infinity;
    };
    return rows.sort((a, b) => b.points - a.points || latest(a.playerId) - latest(b.playerId));
  }

  // A reconnect lands the same human on a new peerIndex (see rekeyCarPlayer);
  // carry their banked cup over. Rebuilt in place so first-seen order (the
  // stable tie-break) survives the rename.
  rekey(oldId, newId) {
    if (oldId === newId || !this._meta.has(oldId)) return;
    const moved = new Map();
    for (const [id, m] of this._meta) moved.set(id === oldId ? newId : id, m);
    this._meta = moved;
  }
}
