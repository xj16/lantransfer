import { describe, it, expect } from 'vitest';
import { PeerSession, PeerCallbacks, RTCLike, RTCDataChannelLike } from './peer';
import { SignalMessage, TransferInfo } from './protocol';

/**
 * A pair of in-memory fake WebRTC peer connections wired directly to each
 * other through a shared "wire". This exercises the *real* PeerSession logic —
 * SDP-carried key exchange, AES-GCM sealing of every channel message, chunking,
 * and the checksum-verified reassembly — without a browser or a live relay.
 *
 * The offerer creates the data channel; the answerer receives it via
 * `ondatachannel`. We open both endpoints once the answerer has set the remote
 * offer (so its `ondatachannel` handler is wired), which mirrors how a real
 * connection completes negotiation before the channel opens.
 */

class FakeChannel implements RTCDataChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  peer: FakeChannel | null = null;

  send(data: string): void {
    // Deliver asynchronously to mimic the real channel.
    setTimeout(() => this.peer?.onmessage?.({ data }), 0);
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

/** Shared state linking the two fake connections. */
interface Wire {
  offererChannel: FakeChannel | null;
  answererConn: FakeConnection | null;
}

class FakeConnection implements RTCLike {
  onicecandidate: ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: RTCDataChannelLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';

  constructor(
    private readonly wire: Wire,
    private readonly role: 'offerer' | 'answerer',
  ) {}

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  }
  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {
    // When the answerer applies the remote offer, its ondatachannel handler is
    // now wired: deliver the offerer's channel to it and open both ends.
    if (this.role === 'answerer') {
      const offererCh = this.wire.offererChannel;
      if (offererCh && this.ondatachannel) {
        const answererCh = new FakeChannel();
        answererCh.peer = offererCh;
        offererCh.peer = answererCh;
        this.ondatachannel({ channel: answererCh });
        // Open on the next tick so both sessions have registered handlers.
        setTimeout(() => {
          offererCh.open();
          answererCh.open();
        }, 0);
      }
    }
  }
  async addIceCandidate(): Promise<void> {}

  createDataChannel(): RTCDataChannelLike {
    const ch = new FakeChannel();
    this.wire.offererChannel = ch;
    return ch;
  }
  close(): void {}
}

describe('PeerSession end-to-end transfer', () => {
  it('sends a file with encryption and verifies its checksum on receive', async () => {
    const wire: Wire = { offererChannel: null, answererConn: null };
    const connA = new FakeConnection(wire, 'offerer');
    const connB = new FakeConnection(wire, 'answerer');
    wire.answererConn = connB;

    let sessionA!: PeerSession;
    let sessionB!: PeerSession;

    const received: { name: string; bytes: Uint8Array } = { name: '', bytes: new Uint8Array() };
    let completed = false;

    const routeToB = (msg: SignalMessage) => void sessionB.handleSignal(msg);
    const routeToA = (msg: SignalMessage) => void sessionA.handleSignal(msg);

    const cbA: PeerCallbacks = {
      send: routeToB,
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      createConnection: () => connA,
    };

    const cbB: PeerCallbacks = {
      send: routeToA,
      onTransferUpdate: (info: TransferInfo) => {
        if (info.state === 'completed' && info.direction === 'receive') completed = true;
      },
      onIncomingFile: async () => true,
      onFileComplete: (_id, name, bytes) => {
        received.name = name;
        received.bytes = bytes;
      },
      createConnection: () => connB,
    };

    sessionA = new PeerSession('alice', 'bob', 'Bob', cbA);
    sessionB = new PeerSession('bob', 'alice', 'Alice', cbB);

    await sessionA.connect();

    // Wait for the encrypted channel to come up on both ends.
    await waitFor(() => sessionA.isReady && sessionB.isReady, 10000);

    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

    await sessionA.sendFile('report.bin', 'application/octet-stream', payload);

    await waitFor(() => completed, 10000);

    expect(received.name).toBe('report.bin');
    expect(received.bytes.length).toBe(payload.length);
    expect(Array.from(received.bytes.slice(0, 64))).toEqual(Array.from(payload.slice(0, 64)));
    expect(Array.from(received.bytes.slice(-64))).toEqual(Array.from(payload.slice(-64)));
  });
});

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
