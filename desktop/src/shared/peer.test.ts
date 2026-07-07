import { describe, it, expect } from 'vitest';
import { PeerSession, PeerCallbacks, RTCLike, RTCDataChannelLike } from './peer';
import { SignalMessage, TransferInfo } from './protocol';
import type { SAS } from './crypto';

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
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  peer: FakeChannel | null = null;
  wire: Wire | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    // Classify each frame so the test can prove chunks travel as binary v2
    // frames (ArrayBuffer) rather than v1 JSON strings.
    if (this.wire) {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this.wire.binaryFramesSeen = (this.wire.binaryFramesSeen ?? 0) + 1;
      } else if (typeof data === 'string') {
        this.wire.stringFramesSeen = (this.wire.stringFramesSeen ?? 0) + 1;
      }
    }
    // Deliver asynchronously to mimic the real channel. Binary frames arrive as
    // ArrayBuffer (binaryType = 'arraybuffer'), exactly as a real channel does.
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
  /** Counters so tests can assert chunks travelled as binary v2 frames. */
  binaryFramesSeen?: number;
  stringFramesSeen?: number;
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
        answererCh.wire = this.wire;
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
    ch.wire = this.wire;
    this.wire.offererChannel = ch;
    return ch;
  }
  close(): void {}
}

describe('PeerSession end-to-end transfer', () => {
  it('sends a file with encryption and verifies its checksum on receive', async () => {
    const wire: Wire = {
      offererChannel: null,
      answererConn: null,
      binaryFramesSeen: 0,
      stringFramesSeen: 0,
    };
    const connA = new FakeConnection(wire, 'offerer');
    const connB = new FakeConnection(wire, 'answerer');
    wire.answererConn = connB;

    let sessionA!: PeerSession;
    let sessionB!: PeerSession;

    const received: { name: string; bytes: Uint8Array } = { name: '', bytes: new Uint8Array() };
    let completed = false;
    let sasA: SAS | null = null;
    let sasB: SAS | null = null;

    const routeToB = (msg: SignalMessage) => void sessionB.handleSignal(msg);
    const routeToA = (msg: SignalMessage) => void sessionA.handleSignal(msg);

    const cbA: PeerCallbacks = {
      send: routeToB,
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      onSAS: (s) => (sasA = s),
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
      onSAS: (s) => (sasB = s),
      createConnection: () => connB,
    };

    sessionA = new PeerSession('alice', 'bob', 'Bob', cbA);
    sessionB = new PeerSession('bob', 'alice', 'Alice', cbB);

    await sessionA.connect();

    // Wait for the encrypted channel to come up on both ends.
    await waitFor(() => sessionA.isReady && sessionB.isReady, 60000);

    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

    await sessionA.sendFile('report.bin', 'application/octet-stream', payload);

    await waitFor(() => completed, 60000);

    expect(received.name).toBe('report.bin');
    expect(received.bytes.length).toBe(payload.length);
    expect(Array.from(received.bytes.slice(0, 64))).toEqual(Array.from(payload.slice(0, 64)));
    expect(Array.from(received.bytes.slice(-64))).toEqual(Array.from(payload.slice(-64)));

    // Both honest peers derive the *same* Short Authentication String, and it is
    // exposed via the public accessor so the UI can render it.
    expect(sasA).not.toBeNull();
    expect(sasB).not.toBeNull();
    expect(sasA!.emoji).toEqual(sasB!.emoji);
    expect(sasA!.digits).toEqual(sasB!.digits);
    expect(sasA!.digits).toMatch(/^\d{6}$/);
    expect(sessionA.shortAuthString!.digits).toEqual(sasA!.digits);

    // The file chunks travelled as protocol-v2 *binary* frames. A 200 KB
    // payload in 64 KiB chunks is 4 frames; each was an ArrayBuffer on the
    // wire, while the control messages (offer/accept/complete) stayed JSON.
    const expectedChunks = Math.ceil(payload.length / (64 * 1024));
    expect(wire.binaryFramesSeen).toBe(expectedChunks);
    expect(wire.stringFramesSeen).toBeGreaterThan(0);
  });
});

describe('PeerSession MITM detection', () => {
  it('yields a different SAS to each peer when the relay swaps the ECDH keys', async () => {
    // A malicious relay sits between Alice and Bob and replaces each peer's
    // public key (carried in the SDP) with its own, so it can derive a key with
    // each side. The ECDH handshake still "succeeds" — but the SAS diverges,
    // which is exactly what a user comparing codes out-of-band would catch.
    const relayKeys = { toB: '', toA: '' };

    const wireAB: Wire = { offererChannel: null, answererConn: null, binaryFramesSeen: 0, stringFramesSeen: 0 };
    const wireRelayB: Wire = { offererChannel: null, answererConn: null, binaryFramesSeen: 0, stringFramesSeen: 0 };

    // The attacker runs its own PeerSession against each victim.
    let alice!: PeerSession;
    let attackerToAlice!: PeerSession;
    let attackerToBob!: PeerSession;
    let bob!: PeerSession;

    let sasAlice: SAS | null = null;
    let sasBob: SAS | null = null;

    const aliceConn = new FakeConnection(wireAB, 'offerer');
    const atkAConn = new FakeConnection(wireAB, 'answerer');
    wireAB.answererConn = atkAConn;

    const atkBConn = new FakeConnection(wireRelayB, 'offerer');
    const bobConn = new FakeConnection(wireRelayB, 'answerer');
    wireRelayB.answererConn = bobConn;

    // Alice <-> attacker leg.
    alice = new PeerSession('alice', 'bob', 'Bob', {
      send: (m) => void attackerToAlice.handleSignal(m),
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      onSAS: (s) => (sasAlice = s),
      createConnection: () => aliceConn,
    });
    attackerToAlice = new PeerSession('bob', 'alice', 'Alice', {
      send: (m) => void alice.handleSignal(m),
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      createConnection: () => atkAConn,
    });

    // attacker <-> Bob leg.
    attackerToBob = new PeerSession('alice', 'bob', 'Bob', {
      send: (m) => void bob.handleSignal(m),
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      createConnection: () => atkBConn,
    });
    bob = new PeerSession('bob', 'alice', 'Alice', {
      send: (m) => void attackerToBob.handleSignal(m),
      onTransferUpdate: () => {},
      onIncomingFile: async () => true,
      onFileComplete: () => {},
      onSAS: (s) => (sasBob = s),
      createConnection: () => bobConn,
    });

    void relayKeys; // (documentation of the attack; keys are swapped implicitly by two independent legs)

    await alice.connect();
    await attackerToBob.connect();

    await waitFor(() => sasAlice !== null && sasBob !== null, 60000);

    // The whole point: Alice and Bob compute DIFFERENT authentication strings,
    // because each actually paired with the attacker, not each other.
    expect(sasAlice).not.toBeNull();
    expect(sasBob).not.toBeNull();
    expect(sasAlice!.digits).not.toEqual(sasBob!.digits);
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
