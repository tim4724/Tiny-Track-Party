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
  /** Mark everyone present (e.g. at game start). Pass nowMs to also re-stamp every player's last-seen so a pre-start-quiet peer isn't instantly expired during countdown. */
  clearDisconnected(nowMs?: number): void;

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

  // --- liveness (presence-timeout detection; pure, nowMs-injected) ---
  /** Record that we just heard from a peer. Ignores unknown peers. */
  onSeen(peerIndex: number, nowMs: number): void;
  /** True once a peer has been silent longer than the liveness window. Always false when enabledProvider() returns false. */
  isExpired(peerIndex: number, nowMs: number): boolean;
  /** Peers that just crossed the liveness window and are not already disconnected. Empty in lobby / when liveness is disabled. */
  expiredPeers(nowMs: number): number[];
  /** True when every active participant is currently disconnected (false if there is no active order). */
  allParticipantsDisconnected(): boolean;
  /** True when any roster member is not in the active participant order (a late joiner). */
  hasLateJoiners(): boolean;
  /** Deadline-driven late-joiner grace: arms on the first qualifying call, returns true exactly once when graceMs elapses. */
  graceTick(nowMs: number): boolean;

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
    /** Liveness (presence-timeout) tuning. All time is injected as nowMs; RoomFlow reads no clock. */
    liveness?: LivenessOptions;
  }

  interface LivenessOptions {
    /** Silence (ms) after which a peer is considered expired. Default Infinity (never). */
    timeoutMs?: number;
    /** Late-joiner grace window (ms) before returning to lobby when all participants are gone. Default 0. */
    graceMs?: number;
    /** Returns false to suppress all liveness expiry (e.g. AirConsole). Read live, not at construction. */
    enabledProvider?: () => boolean;
  }
}
