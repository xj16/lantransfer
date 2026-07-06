/**
 * RelayClient — a thin, reconnecting WebSocket client that speaks the
 * LanTransfer signaling protocol against a (self-hostable) Go relay.
 *
 * The relay only brokers presence + the WebRTC handshake. No file bytes flow
 * through it. This client is intentionally UI-agnostic; the renderer subscribes
 * to typed events and drives PeerSessions in response.
 */

import { PROTOCOL_VERSION, Platform, SignalMessage } from './protocol';

export interface RelayClientOptions {
  url: string;
  peerId: string;
  name: string;
  platform: Platform;
  room: string;
  /** Injected WebSocket constructor (browser has one globally; tests inject a fake). */
  WebSocketImpl?: typeof WebSocket;
}

type Listener = (msg: SignalMessage) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private closedByUser = false;
  private reconnectDelay = 500;

  constructor(private readonly opts: RelayClientOptions) {}

  /** Subscribe to inbound signaling messages. Returns an unsubscribe fn. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Open the connection (idempotent). */
  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  /** Send a signaling message to the relay. */
  send(msg: SignalMessage): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Close permanently (no reconnect). */
  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    const Impl = this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    const ws = new Impl(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        peerId: this.opts.peerId,
        name: this.opts.name,
        platform: this.opts.platform,
      });
      this.send({ t: 'join', room: this.opts.room });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SignalMessage;
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    };

    ws.onclose = () => {
      if (this.closedByUser) return;
      // Exponential backoff up to ~8s.
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      setTimeout(() => {
        if (!this.closedByUser) this.openSocket();
      }, delay);
    };

    ws.onerror = () => {
      // Let onclose handle the reconnect.
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }
}
