/**
 * LoopbackSignal — a zero-backend signaling transport for the live demo.
 *
 * It speaks the exact same SignalMessage envelope as the real Go relay, but
 * routes messages between browser tabs on the same origin via a
 * BroadcastChannel instead of a WebSocket. This lets the portfolio demo pair
 * two tabs and transfer a real file — through the real ECDH + AES-GCM + chunking
 * path — with no server at all. The moment you point the app at a real relay
 * URL, the identical PeerSession code runs unchanged over the wire.
 *
 * It intentionally mirrors the small surface of RelayClient (`on`, `connect`,
 * `send`, `close`) so the app can swap transports without touching the peer
 * logic.
 */

import type { Platform, SignalMessage } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';

type Listener = (msg: SignalMessage) => void;

interface Envelope {
  from: string;
  msg: SignalMessage;
}

export interface LoopbackOptions {
  peerId: string;
  name: string;
  platform: Platform;
  room: string;
}

export class LoopbackSignal {
  private channel: BroadcastChannel | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly seenPeers = new Set<string>();

  constructor(private readonly opts: LoopbackOptions) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    const channel = new BroadcastChannel(`lantransfer/${this.opts.room}`);
    this.channel = channel;

    channel.onmessage = (ev: MessageEvent<Envelope>) => {
      const { from, msg } = ev.data;
      if (from === this.opts.peerId) return; // ignore our own echoes

      // Presence: when we hear another peer announce itself, surface it as a
      // peer-joined and announce ourselves back so both tabs discover each other.
      if (msg.t === 'hello') {
        if (!this.seenPeers.has(from)) {
          this.seenPeers.add(from);
          this.emit({
            t: 'peer-joined',
            peerId: from,
            name: (msg as Extract<SignalMessage, { t: 'hello' }>).name,
            platform: (msg as Extract<SignalMessage, { t: 'hello' }>).platform,
          });
          // Re-announce so a tab that joined earlier learns about us.
          this.announce();
        }
        return;
      }

      // Directed messages (offer/answer/ice) are addressed to a peer id.
      const to = (msg as { to?: string }).to;
      if (to && to !== this.opts.peerId) return;
      this.emit(msg);
    };

    // Announce our presence; late joiners re-announce on hearing others.
    this.announce();
  }

  send(msg: SignalMessage): void {
    this.channel?.postMessage({ from: this.opts.peerId, msg } satisfies Envelope);
  }

  close(): void {
    if (this.channel) {
      // Best-effort departure notice.
      this.emitLeaveLocally();
      this.channel.close();
      this.channel = null;
    }
  }

  private announce(): void {
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      peerId: this.opts.peerId,
      name: this.opts.name,
      platform: this.opts.platform,
    });
  }

  private emit(msg: SignalMessage): void {
    for (const l of this.listeners) l(msg);
  }

  private emitLeaveLocally(): void {
    // No-op placeholder: BroadcastChannel has no unload guarantee, so peers are
    // pruned when their connection state fails. Kept for interface symmetry.
  }
}
