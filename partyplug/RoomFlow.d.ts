// Type declarations for RoomFlow (partyplug). Hand-written; keep in sync with
// RoomFlow.js. The module exports the class via `module.exports = RoomFlow`.

export = RoomFlow;

declare class RoomFlow {
  constructor(opts?: RoomFlow.Options);

  /** Canonical room states. */
  static STATES: {
    LOBBY: 'lobby';
    COUNTDOWN: 'countdown';
    PLAYING: 'playing';
    RESULTS: 'results';
  };

  /**
   * Lowest free dense slot in [0, max) given the slot values already in use.
   * Pure and sparse-safe: pass slot values, never peerIndices. Returns -1 when
   * full.
   */
  static lowestFreeSlot(used: Iterable<number> | Set<number>, max: number): number;

  /** Current room state. */
  state: RoomFlow.RoomState;
  /** Roster, keyed by peerIndex. The live records are mutated by the game. */
  players: Map<number, RoomFlow.PlayerRecord>;
  /** Raw sticky-host slot. Read `host` for the effective host. */
  hostPeerIndex: number | null;

  /** Effective host (master -> sticky -> oldest-eligible), or null. */
  readonly host: number | null;
  /** Total players in the roster (incl. disconnected). */
  readonly size: number;
  /** Connected (present) player count. */
  readonly connectedCount: number;

  // --- roster ---
  /** Add a player, or reconnect/refresh an existing one. `fields` is opaque game data merged onto the record. */
  addPlayer(peerIndex: number, fields?: Record<string, any>): RoomFlow.PlayerRecord;
  removePlayer(peerIndex: number): void;
  /** Cross-device claim only: move a record from oldId to newId (a different client took over a dropped slot, getting a new peerIndex). Same-client reconnects keep their index and don't need this. */
  rekey(oldId: number, newId: number): boolean;
  markDisconnected(peerIndex: number): void;
  markReconnected(peerIndex: number): void;
  /** Mark everyone present (e.g. at game start). */
  clearDisconnected(): void;

  // --- lifecycle ---
  /** Validated state transition; the primary API. Returns false on an invalid transition. */
  transitionTo(state: RoomFlow.RoomState): boolean;
  /** Readable sugar for `transitionTo('results')`. Results data is the game's own. */
  endGame(): boolean;
  returnToLobby(): boolean;
  /** Sync the participant order used for host eligibility with a game-owned list. */
  setActiveOrder(peerIndices: number[]): void;
  /**
   * Clear roster/host/order/presence and return to lobby. Clears `players` in
   * place (aliases stay valid). Emits `rosterchange` (+ `statechange` if leaving
   * a non-lobby state, + `hostchange` if a host was set) so event-driven
   * consumers re-render.
   */
  reset(): void;

  // --- reads ---
  isHost(peerIndex: number): boolean;
  list(): RoomFlow.PlayerRecord[];
  get(peerIndex: number): RoomFlow.PlayerRecord | null;
  has(peerIndex: number): boolean;
  isDisconnected(peerIndex: number): boolean;

  // --- events ---
  /** Subscribe; returns an unsubscribe function. Use '*' to receive every event as (type, detail). */
  on(type: RoomFlow.EventName | '*', handler: (detail: any, ...rest: any[]) => void): () => void;
  off(type: string, handler: (...args: any[]) => void): void;
}

declare namespace RoomFlow {
  type RoomState = 'lobby' | 'countdown' | 'playing' | 'results';

  type EventName =
    | 'statechange'
    | 'playerjoin'
    | 'playerleave'
    | 'playerupdate'
    | 'rosterchange'
    | 'hostchange';

  interface PlayerRecord {
    peerIndex: number;
    joinedAt: number;
    connected: boolean;
    /** Game-owned fields (name, color slot, score, ...). RoomFlow never reads these. */
    [field: string]: any;
  }

  interface Options {
    /** Returns the transport-designated master peerIndex (e.g. AirConsole), or null. */
    masterProvider?: () => number | null | undefined;
  }
}
