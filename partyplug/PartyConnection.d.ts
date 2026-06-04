// Type declarations for PartyConnection (partyplug). Keep in sync with the JS.

export = PartyConnection;

declare class PartyConnection {
  constructor(relayUrl: string, options?: PartyConnection.Options);

  relayUrl: string;
  clientId: string | null;
  reconnectAttempt: number;
  readonly connected: boolean;

  connect(): void;
  /** Create a room (display, slot 0). */
  create(maxClients: number): void;
  /** Join a room by code (controller). */
  join(room: string): void;
  /** Pin auto-reconnect to a relay shard by rebuilding the sharded URL. */
  pinInstance(baseUrl: string, room: string, instance: string): void;
  sendTo(to: number, data: any): void;
  broadcast(data: any): void;
  reconnectNow(): void;
  resetReconnectCount(): void;
  close(): void;

  // Callbacks (assigned as properties).
  onOpen: (() => void) | null;
  onClose: ((attempt: number, maxAttempts: number, meta?: { replaced?: boolean }) => void) | null;
  onError: (() => void) | null;
  onMessage: ((from: number, data: any) => void) | null;
  onProtocol: ((type: string, msg: any) => void) | null;
}

declare namespace PartyConnection {
  interface Options {
    /** Per-slot bearer token for reconnect. Auto-generated (session-stable) if omitted; persist + pass one for reconnect across page reloads. */
    clientId?: string;
    maxReconnectAttempts?: number;
  }
}
