/**
 * PeerSession — the heart of a LanTransfer connection.
 *
 * Wraps an RTCPeerConnection + a single reliable data channel, layers the
 * end-to-end encryption from ./crypto on top, and drives the chunked file
 * transfer state machine defined by ChannelMessage.
 *
 * It is deliberately transport-agnostic about signaling: the caller supplies
 * a `send` callback (which puts a SignalMessage on whatever wire it uses —
 * the relay WebSocket, in our case) and feeds inbound SignalMessages in via
 * `handleSignal`. That keeps this module unit-testable without a live socket
 * and lets the same code run in the renderer or a headless test.
 */

import {
  ChannelMessage,
  ChunkFrame,
  CHUNK_SIZE,
  decodeChunkFrame,
  encodeChunkFrame,
  newTransferId,
  SignalMessage,
  TransferInfo,
} from './protocol';
import {
  deriveSAS,
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  KeyPair,
  open as openSealed,
  openBytes,
  SAS,
  seal,
  sealBytes,
  sha256Hex,
} from './crypto';

/** Minimal WebRTC surface we depend on, so this typechecks under Node too. */
export interface RTCLike {
  createOffer(): Promise<{ sdp?: string; type: string }>;
  createAnswer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { sdp?: string; type: string }): Promise<void>;
  addIceCandidate(c: RTCIceCandidateInit): Promise<void>;
  createDataChannel(label: string, opts?: unknown): RTCDataChannelLike;
  close(): void;
  onicecandidate: ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null;
  ondatachannel: ((ev: { channel: RTCDataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState?: string;
}

export interface RTCDataChannelLike {
  /** Text control frames and binary chunk frames both go through here. */
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  readyState: string;
  bufferedAmount: number;
  /** Set to 'arraybuffer' so inbound binary frames arrive as ArrayBuffer. */
  binaryType?: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface PeerCallbacks {
  /** Send a signaling message to the peer (via the relay). */
  send(msg: SignalMessage): void;
  /** Called whenever a transfer's state/progress changes. */
  onTransferUpdate(info: TransferInfo): void;
  /** Ask the user whether to accept an incoming file. Return true to accept. */
  onIncomingFile(info: TransferInfo): Promise<boolean>;
  /** Deliver a fully-received file's bytes to the host (to save to disk). */
  onFileComplete(transferId: string, name: string, bytes: Uint8Array): void;
  /** Fired when the encrypted channel is open and ready. */
  onReady?(): void;
  /**
   * Fired once the session key is established and the Short Authentication
   * String is known, so the UI can render the pairing fingerprint for
   * out-of-band comparison (MITM defence).
   */
  onSAS?(sas: SAS): void;
  /** Factory for an RTCPeerConnection (injected for testability). */
  createConnection(): RTCLike;
}

interface OutgoingTransfer {
  info: TransferInfo;
  bytes: Uint8Array;
  nextSeq: number;
  resolveAccept?: () => void;
  rejectAccept?: (e: Error) => void;
}

interface IncomingTransfer {
  info: TransferInfo;
  chunks: Uint8Array[];
  received: number;
}

export class PeerSession {
  private pc: RTCLike | null = null;
  private channel: RTCDataChannelLike | null = null;
  private keyPair: KeyPair | null = null;
  private sessionKey: CryptoKey | null = null;
  private ownPublicKeyB64: string | null = null;
  private peerPublicKeyB64: string | null = null;
  private sas: SAS | null = null;
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly incoming = new Map<string, IncomingTransfer>();

  constructor(
    private readonly selfId: string,
    private readonly peerId: string,
    private readonly peerName: string,
    private readonly cb: PeerCallbacks,
  ) {}

  /** True once the encrypted data channel is open and keyed. */
  get isReady(): boolean {
    return this.channel?.readyState === 'open' && this.sessionKey !== null;
  }

  /**
   * The Short Authentication String for this session, or null before the key
   * is established. Compare it out-of-band with the peer to rule out a relay
   * that swapped the ECDH keys for a man-in-the-middle.
   */
  get shortAuthString(): SAS | null {
    return this.sas;
  }

  /**
   * Initiate a connection (the "impolite"/offering peer). Creates the data
   * channel, generates our ECDH key, and sends an SDP offer carrying our
   * public key in the SDP's session name for out-of-band-free key exchange.
   */
  async connect(): Promise<void> {
    this.keyPair = await generateKeyPair();
    this.pc = this.cb.createConnection();
    this.wireConnection(this.pc);

    const channel = this.pc.createDataChannel('lantransfer', { ordered: true });
    this.setupChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const pub = await exportPublicKey(this.keyPair.publicKey);
    this.ownPublicKeyB64 = pub;
    this.cb.send({
      t: 'offer',
      to: this.peerId,
      from: this.selfId,
      sdp: this.embedKey(offer.sdp ?? '', pub),
    });
  }

  /** Handle an inbound signaling message addressed to us. */
  async handleSignal(msg: SignalMessage): Promise<void> {
    switch (msg.t) {
      case 'offer':
        await this.onOffer(msg);
        break;
      case 'answer':
        await this.onAnswer(msg);
        break;
      case 'ice':
        if (this.pc) await this.pc.addIceCandidate(msg.candidate);
        break;
      default:
        break;
    }
  }

  private async onOffer(msg: Extract<SignalMessage, { t: 'offer' }>): Promise<void> {
    this.keyPair = await generateKeyPair();
    this.pc = this.cb.createConnection();
    this.wireConnection(this.pc);

    const { sdp, key } = this.extractKey(msg.sdp);
    this.peerPublicKeyB64 = key;
    await this.pc.setRemoteDescription({ type: 'offer', sdp });

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const pub = await exportPublicKey(this.keyPair.publicKey);
    this.ownPublicKeyB64 = pub;

    await this.establishKey();

    this.cb.send({
      t: 'answer',
      to: this.peerId,
      from: this.selfId,
      sdp: this.embedKey(answer.sdp ?? '', pub),
    });
  }

  private async onAnswer(msg: Extract<SignalMessage, { t: 'answer' }>): Promise<void> {
    if (!this.pc) return;
    const { sdp, key } = this.extractKey(msg.sdp);
    this.peerPublicKeyB64 = key;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    await this.establishKey();
  }

  private async establishKey(): Promise<void> {
    if (!this.keyPair || !this.peerPublicKeyB64 || !this.ownPublicKeyB64) return;
    const peerPub = await importPublicKey(this.peerPublicKeyB64);
    this.sessionKey = await deriveSessionKey(this.keyPair.privateKey, peerPub);
    // Derive the Short Authentication String from both public keys as each side
    // observed them. A key-swapping relay makes these diverge across peers.
    this.sas = await deriveSAS(this.ownPublicKeyB64, this.peerPublicKeyB64);
    this.cb.onSAS?.(this.sas);
  }

  /**
   * Queue a file for sending. Sends an encrypted offer-file; actual chunks
   * begin once the peer accepts. Returns the transfer id.
   */
  async sendFile(name: string, mime: string, bytes: Uint8Array): Promise<string> {
    const transferId = newTransferId();
    const info: TransferInfo = {
      transferId,
      name,
      size: bytes.length,
      mime,
      direction: 'send',
      state: 'pending',
      transferred: 0,
      peerId: this.peerId,
      peerName: this.peerName,
    };
    this.outgoing.set(transferId, { info, bytes, nextSeq: 0 });
    this.cb.onTransferUpdate(info);
    await this.sendChannel({ t: 'offer-file', transferId, name, size: bytes.length, mime });
    return transferId;
  }

  /** Cancel an in-flight transfer (either direction). */
  async cancel(transferId: string, reason = 'cancelled by user'): Promise<void> {
    await this.sendChannel({ t: 'cancel', transferId, reason });
    this.markState(transferId, 'cancelled');
  }

  /** Tear down the connection and free resources. */
  close(): void {
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
  }

  // -------------------------------------------------------------------------
  // Data channel plumbing
  // -------------------------------------------------------------------------

  private wireConnection(pc: RTCLike): void {
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.cb.send({ t: 'ice', to: this.peerId, from: this.selfId, candidate: ev.candidate });
      }
    };
    pc.ondatachannel = (ev) => this.setupChannel(ev.channel);
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected') {
        for (const id of this.outgoing.keys()) this.markState(id, 'failed');
        for (const id of this.incoming.keys()) this.markState(id, 'failed');
      }
    };
  }

  private setupChannel(channel: RTCDataChannelLike): void {
    this.channel = channel;
    // Ensure inbound binary chunk frames arrive as ArrayBuffer, not Blob.
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this.cb.onReady?.();
    };
    channel.onmessage = (ev) => {
      void this.onChannelData(ev.data);
    };
    channel.onclose = () => {
      for (const id of this.outgoing.keys()) this.markState(id, 'failed');
    };
  }

  /** Send a JSON control message, AES-GCM-sealed as a base64url string. */
  private async sendChannel(msg: ChannelMessage): Promise<void> {
    if (!this.channel || this.channel.readyState !== 'open' || !this.sessionKey) {
      throw new Error('Data channel not ready');
    }
    const sealed = await seal(this.sessionKey, JSON.stringify(msg));
    await this.applyBackpressure();
    this.channel.send(sealed);
  }

  /**
   * Send a file chunk as a compact binary frame: the plaintext frame is AES-GCM
   * sealed to raw bytes and pushed as an ArrayBuffer, skipping the JSON +
   * double-base64 overhead of the v1 string path.
   */
  private async sendChunkFrame(frame: ChunkFrame): Promise<void> {
    if (!this.channel || this.channel.readyState !== 'open' || !this.sessionKey) {
      throw new Error('Data channel not ready');
    }
    const framed = encodeChunkFrame(frame);
    const sealed = await sealBytes(this.sessionKey, framed);
    await this.applyBackpressure();
    // Send a fresh, exactly-sized ArrayBuffer copy of the sealed bytes.
    const buf = new ArrayBuffer(sealed.byteLength);
    new Uint8Array(buf).set(sealed);
    this.channel.send(buf);
  }

  /** Simple backpressure so we never blow the send buffer on big files. */
  private async applyBackpressure(): Promise<void> {
    while (this.channel && this.channel.bufferedAmount > 8 * 1024 * 1024) {
      await delay(20);
    }
  }

  private async onChannelData(data: unknown): Promise<void> {
    if (!this.sessionKey) return;

    // Binary chunk frame (protocol v2).
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const sealed =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
      try {
        const plainFrame = await openBytes(this.sessionKey, sealed);
        const frame = decodeChunkFrame(plainFrame);
        if (frame) await this.onChunkFrame(frame);
      } catch {
        // Undecryptable / tampered frame — drop it.
      }
      return;
    }

    // JSON control message.
    if (typeof data !== 'string') return;
    let msg: ChannelMessage;
    try {
      const plaintext = await openSealed(this.sessionKey, data);
      msg = JSON.parse(plaintext) as ChannelMessage;
    } catch {
      // Undecryptable / tampered frame — drop it.
      return;
    }
    await this.dispatch(msg);
  }

  private async dispatch(msg: ChannelMessage): Promise<void> {
    switch (msg.t) {
      case 'offer-file':
        await this.onOfferFile(msg);
        break;
      case 'accept-file':
        await this.onAcceptFile(msg.transferId);
        break;
      case 'reject-file':
        this.markState(msg.transferId, 'rejected');
        this.outgoing.delete(msg.transferId);
        break;
      case 'complete':
        await this.onComplete(msg);
        break;
      case 'cancel':
        this.markState(msg.transferId, 'cancelled');
        this.outgoing.delete(msg.transferId);
        this.incoming.delete(msg.transferId);
        break;
      default:
        break;
    }
  }

  private async onOfferFile(
    msg: Extract<ChannelMessage, { t: 'offer-file' }>,
  ): Promise<void> {
    const info: TransferInfo = {
      transferId: msg.transferId,
      name: msg.name,
      size: msg.size,
      mime: msg.mime,
      direction: 'receive',
      state: 'pending',
      transferred: 0,
      peerId: this.peerId,
      peerName: this.peerName,
    };
    this.incoming.set(msg.transferId, { info, chunks: [], received: 0 });
    this.cb.onTransferUpdate(info);

    const accepted = await this.cb.onIncomingFile(info);
    if (accepted) {
      info.state = 'active';
      this.cb.onTransferUpdate(info);
      await this.sendChannel({ t: 'accept-file', transferId: msg.transferId });
    } else {
      this.incoming.delete(msg.transferId);
      info.state = 'rejected';
      this.cb.onTransferUpdate(info);
      await this.sendChannel({ t: 'reject-file', transferId: msg.transferId });
    }
  }

  private async onAcceptFile(transferId: string): Promise<void> {
    const out = this.outgoing.get(transferId);
    if (!out) return;
    out.info.state = 'active';
    this.cb.onTransferUpdate(out.info);
    await this.streamChunks(out);
  }

  private async streamChunks(out: OutgoingTransfer): Promise<void> {
    const { bytes } = out;
    let offset = 0;
    let seq = 0;
    while (offset < bytes.length) {
      if (out.info.state === 'cancelled') return;
      const end = Math.min(offset + CHUNK_SIZE, bytes.length);
      const slice = bytes.subarray(offset, end);
      const last = end >= bytes.length;
      await this.sendChunkFrame({
        transferId: out.info.transferId,
        seq,
        last,
        data: slice,
      });
      offset = end;
      seq += 1;
      out.info.transferred = offset;
      this.cb.onTransferUpdate(out.info);
    }
    const digest = await sha256Hex(bytes);
    await this.sendChannel({ t: 'complete', transferId: out.info.transferId, sha256: digest });
    out.info.state = 'completed';
    this.cb.onTransferUpdate(out.info);
    this.outgoing.delete(out.info.transferId);
  }

  private async onChunkFrame(frame: ChunkFrame): Promise<void> {
    const inc = this.incoming.get(frame.transferId);
    if (!inc) return;
    // Copy out of the (possibly reused) receive buffer before retaining it.
    const bytes = frame.data.slice();
    inc.chunks.push(bytes);
    inc.received += bytes.length;
    inc.info.transferred = inc.received;
    this.cb.onTransferUpdate(inc.info);
  }

  private async onComplete(
    msg: Extract<ChannelMessage, { t: 'complete' }>,
  ): Promise<void> {
    const inc = this.incoming.get(msg.transferId);
    if (!inc) return;
    const total = inc.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of inc.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const digest = await sha256Hex(merged);
    if (digest !== msg.sha256) {
      inc.info.state = 'failed';
      inc.info.error = 'checksum mismatch';
      this.cb.onTransferUpdate(inc.info);
      this.incoming.delete(msg.transferId);
      return;
    }
    inc.info.state = 'completed';
    inc.info.transferred = total;
    this.cb.onTransferUpdate(inc.info);
    this.cb.onFileComplete(msg.transferId, inc.info.name, merged);
    this.incoming.delete(msg.transferId);
  }

  private markState(transferId: string, state: TransferInfo['state']): void {
    const out = this.outgoing.get(transferId);
    if (out) {
      out.info.state = state;
      this.cb.onTransferUpdate(out.info);
    }
    const inc = this.incoming.get(transferId);
    if (inc) {
      inc.info.state = state;
      this.cb.onTransferUpdate(inc.info);
    }
  }

  // -------------------------------------------------------------------------
  // Public-key-in-SDP helpers.
  //
  // We piggyback the ECDH public key on the SDP so no extra out-of-band step
  // is required. The key travels through the relay, but that is fine: the
  // relay only learns *public* keys, never the derived session secret.
  // -------------------------------------------------------------------------

  private embedKey(sdp: string, pubKeyB64: string): string {
    return `${sdp}\r\na=x-lantransfer-key:${pubKeyB64}\r\n`;
  }

  private extractKey(sdp: string): { sdp: string; key: string | null } {
    const lines = sdp.split(/\r?\n/);
    let key: string | null = null;
    const kept: string[] = [];
    for (const line of lines) {
      const m = line.match(/^a=x-lantransfer-key:(.+)$/);
      if (m) key = m[1].trim();
      else kept.push(line);
    }
    return { sdp: kept.join('\r\n'), key };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
