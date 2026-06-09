// DEBUG-ONLY single-player keyboard mode (?solo=1).
//
// Lets you drive one car on the main display with the keyboard, no phones and no
// relay. It deliberately reuses the *entire* real race path: a synthetic local
// player is seated in net.flow (so the lobby roster, buildField, host-start,
// results and fast-forward all treat it as a connected human), and the keyboard
// is fed into the same engine.processInput seam a phone's CONTROL uses.
//
// The only trick is the transport: there are no phones to talk to, so net.party
// is swapped for a no-op stub. Every existing net call (_broadcastLobby /
// broadcast / sendTo) then runs unchanged against a null wire — no special-casing
// leaks into DisplayNet or the race lifecycle. Nothing here loads unless ?solo=1.
//
// Controls: WASD / arrow keys steer + brake (S / ↓), Q or Space use item,
// Enter start / next race, R abort back to the lobby. The car auto-accelerates
// (there is no throttle input — matching the phones), so W / ↑ is a no-op.

const { ROOM_STATE } = window;

// Engine/render id for the local car. Phones are integers 1..MAX_PLAYERS and the
// display is 0; AI fillers use 'ai-N' strings — so 1 is a natural human slot that
// never collides with the bots buildField() adds around it.
const SOLO_ID = 1;

// A transport that goes nowhere. DisplayNet only ever calls these on the party in
// offline play (_broadcastLobby uses sendTo; the broadcast/sendTo wrappers guard
// on a truthy party). Stubbing them lets the real code run with no relay.
const NULL_PARTY = {
  sendTo() {}, broadcast() {}, connect() {}, join() {}, create() {},
  pinInstance() {}, resetReconnectCount() {}, closeAll() {}, close() {},
};

// Keys we own — preventDefault stops arrows/Space from scrolling the page.
const STEER_L = new Set(['ArrowLeft', 'KeyA']);
const STEER_R = new Set(['ArrowRight', 'KeyD']);
const BRAKE = new Set(['ArrowDown', 'KeyS']);
const ITEM = new Set(['KeyQ', 'Space']);
const SWALLOW = new Set([
  ...STEER_L, ...STEER_R, ...BRAKE, ...ITEM,
  'ArrowUp', 'KeyW', 'Enter',
]);

export class DebugSolo {
  constructor(opts) {
    this.net = opts.net;
    this.scenePromise = opts.scenePromise;
    this.startRace = opts.startRace;
    this.returnToLobby = opts.returnToLobby;
    this.selectTrack = opts.selectTrack;
    this.defaultTrackId = opts.defaultTrackId;
    this.carIndex = opts.carIndex || 0;

    this.held = new Set();      // currently-pressed key codes
    this.useSeq = 0;            // wrapping ACTION counter, bumped once per item press
    this._restartT = null;
    this._lobbyAt = null;       // performance.now() of the last return-to-lobby (fade gate)
  }

  start() {
    // No phones → a null wire. Must be set BEFORE seating the player: addPlayer
    // fires rosterchange → DisplayNet._broadcastLobby(), which calls party.sendTo.
    this.net.party = NULL_PARTY;

    // Seat the one local human as host, exactly like a phone that just joined.
    this.net.flow.addPlayer(SOLO_ID, { name: 'You', colorIndex: 0, carIndex: this.carIndex });

    // startRace() needs a track picked (and it drives the 3D preview).
    this.selectTrack(this.defaultTrackId);

    this._bindKeys();
    this._buildHint();

    // Drop straight into a race once the GLBs/track are ready.
    this.scenePromise.then(() => this._beginRace());
  }

  // Called from the render loop (main.js onFrame), right where driveBots() feeds
  // the AI — applies this frame's keyboard state to the local car.
  drive(session) {
    if (!session || !session.engine.cars.has(SOLO_ID)) return;
    session.processInput(SOLO_ID, this._input());
  }

  _input() {
    const down = (set) => { for (const c of set) if (this.held.has(c)) return true; return false; };
    let s = 0;
    if (down(STEER_L)) s -= 1;
    if (down(STEER_R)) s += 1;
    return { s, b: down(BRAKE) ? 1 : 0, u: this.useSeq };
  }

  _bindKeys() {
    this._onKeyDown = (e) => {
      const c = e.code;
      if (SWALLOW.has(c)) e.preventDefault();
      if (e.repeat) return;                 // ignore key-repeat for the one-shot keys
      if (c === 'Enter') return this._onStart();
      if (c === 'KeyR') return this._toLobby();
      if (ITEM.has(c)) { this.useSeq = (this.useSeq + 1) & 255; return; }
      this.held.add(c);
    };
    this._onKeyUp = (e) => this.held.delete(e.code);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // A blur (alt-tab) drops every held key so the car doesn't steer into the
    // wall while the page is unfocused.
    window.addEventListener('blur', () => this.held.clear());
  }

  // Enter: start a race from the lobby, or roll a fresh one from the results
  // board (return to the lobby first, then race once the fade settles).
  _onStart() {
    const st = this.net.roomState;
    if (st === ROOM_STATE.LOBBY) this._beginRace();
    else if (st === ROOM_STATE.RESULTS) { this._toLobby(); this._beginRace(); }
  }

  // Abort back to the lobby. returnToLobby() crossfades and clears the grid
  // ~0.45s later; stamp when we asked so _beginRace waits that fade out instead
  // of letting its trailing car-sweep wipe a freshly-started race.
  _toLobby() {
    this._lobbyAt = performance.now();
    this.returnToLobby();
  }

  // Start a race once any in-flight lobby crossfade has settled.
  _beginRace() {
    const FADE_SETTLE = 560;
    const since = this._lobbyAt == null ? Infinity : performance.now() - this._lobbyAt;
    clearTimeout(this._restartT);
    this._restartT = setTimeout(() => this.startRace(), Math.max(0, FADE_SETTLE - since));
  }

  _buildHint() {
    const hint = document.createElement('div');
    // Inline style via the CSSOM (not a markup style attribute), so the page CSP
    // doesn't need an exception for a debug-only overlay.
    hint.style.cssText =
      'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9999;' +
      'pointer-events:none;font:600 12px/1.4 Nunito,system-ui,sans-serif;color:#fff;' +
      'background:rgba(11,15,23,.55);padding:6px 12px;border-radius:999px;' +
      'letter-spacing:.02em;white-space:nowrap;backdrop-filter:blur(2px)';
    hint.textContent = 'SOLO DEBUG — WASD / arrows drive · S brake · Q / Space item · Enter race · R reset';
    document.body.appendChild(hint);
  }
}
