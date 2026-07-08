// Type declarations for PartyConnection (partyplug). Keep in sync with the JS.

export = PartyConnection;

declare class PartyConnection {
  constructor(relayUrl: string, options?: PartyConnection.Options);

  relayUrl: string;
  clientId: string | null;
  reconnectAttempt: number;
  readonly connected: boolean;

  connect(): void;
  /**
   * Create a room (display, slot 0). `url` is an optional controller-URL
   * template ({room}/{instance} placeholders) the relay resolves for clients
   * that hold only the room code. Must be absolute https or the relay rejects
   * the create; omit it on non-https origins.
   */
  create(maxClients: number, url?: string): void;
  /** Join a room by code (controller). */
  join(room: string): void;
  /** Pin auto-reconnect to a relay shard by rebuilding the sharded URL. */
  pinInstance(baseUrl: string, room: string, instance: string): void;
  sendTo(to: number, data: any): void;
  broadcast(data: any): void;
  /** Publish a retained state snapshot (host/slot-0 only). Replayed to clients on (re)join and pushed live to peers. <= 16 KiB serialized. */
  setState(data: any): void;
  /** Tear the room down for everyone (host/slot-0 only). The relay deletes the room and closes every member socket with 4001 (onClose meta.roomClosed). */
  closeRoom(): void;
  reconnectNow(): void;
  resetReconnectCount(): void;
  /** Count the current socket as a failed attempt and run the normal backoff/give-up path — for failures only the caller can detect (e.g. the relay never answered create/join). */
  failAttempt(): void;
  close(): void;

  // Callbacks (assigned as properties).
  onOpen: (() => void) | null;
  onClose: ((attempt: number, maxAttempts: number, meta?: { replaced?: boolean; roomClosed?: boolean }) => void) | null;
  onError: (() => void) | null;
  onMessage: ((from: number, data: any) => void) | null;
  onProtocol: ((type: string, msg: any) => void) | null;
  /** Fires with the host's retained snapshot: replayed right after `joined` on (re)join, and on each host update. */
  onState: ((data: any) => void) | null;
}

declare namespace PartyConnection {
  interface Options {
    /** Per-slot bearer token for reconnect. Auto-generated (session-stable) if omitted; persist + pass one for reconnect across page reloads. */
    clientId?: string;
    maxReconnectAttempts?: number;
  }
}
