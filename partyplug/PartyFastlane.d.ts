// Type declarations for PartyFastlane (partyplug). Keep in sync with the JS.
// Optional P2P WebRTC DataChannel layer for low-latency input; piggybacks on
// the relay connection for signaling.

export = PartyFastlane;

declare class PartyFastlane {
  constructor(options?: PartyFastlane.Options);

  /** Resend cadence (ms) while the ring holds unacked events. */
  static TICK_MS: number;

  selfIndex: number | null;

  setSelfIndex(idx: number): void;
  /** Handle an inbound signaling envelope; returns true if it was consumed. */
  handleSignal(from: number, data: any): boolean;
  open(peerIdx: number, opts?: any): Promise<void>;
  close(peerIdx: number): void;
  closeAll(): void;
  /**
   * Enqueue an input event to a peer over the data channel: 'p2p' when it
   * entered the send ring, 'dropped' when the channel isn't open (fall back
   * to the relay).
   */
  enqueue(peerIdx: number, ev: any): 'p2p' | 'dropped';
  isOpen(peerIdx: number): boolean;
  getStats(peerIdx: number): any;
  getAllStats(): any;
}

declare namespace PartyFastlane {
  interface IceServer { urls: string | string[]; username?: string; credential?: string }

  interface Options {
    iceServers?: IceServer[];
    selfIndex?: number;
    /** Send a signaling envelope to a peer (typically party.sendTo). */
    sendSignal?: (toIdx: number, data: any) => void;
    onInput?: (fromIdx: number, ev: any) => void;
    onPeerReady?: (peerIdx: number) => void;
    onPeerClosed?: (peerIdx: number) => void;
    onConnectionState?: (peerIdx: number, state: string) => void;
    onRtt?: (peerIdx: number, rttHalfMs: number) => void;
    /** The peer CONFIRMED applying this payload (es = its event seq). */
    onAcked?: (peerIdx: number, ev: any, es: number) => void;
    emitIdleHeartbeat?: boolean;
    /** Cap on the resend ring (1 = latest-only). Default: unbounded. */
    maxRing?: number;
  }
}
