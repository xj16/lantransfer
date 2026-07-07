/**
 * LanTransfer wire protocol.
 *
 * All peers (desktop, mobile) and the signaling relay speak the same JSON
 * envelope over WebSocket. The relay never sees file bytes — it only brokers
 * the WebRTC handshake (offer/answer/ICE) and presence. Once the data channel
 * is open, encrypted file chunks flow peer-to-peer and never touch the relay.
 */

/**
 * Protocol version. Peers refuse to pair across a major-version mismatch.
 *
 * v2 introduces binary data-channel chunk frames (see {@link encodeChunkFrame})
 * that replace the v1 double-base64 JSON `chunk` message on the throughput hot
 * path. Control messages (offer/accept/complete/cancel) remain JSON. The relay
 * is version-agnostic — it never inspects channel payloads — but the signaling
 * `hello.v` still gates client/relay compatibility.
 */
export const PROTOCOL_VERSION = 2;

/** A short, human-shareable pairing code (e.g. "amber-otter-42"). */
export type PairingCode = string;

/** Signaling messages exchanged with the relay. */
export type SignalMessage =
  | { t: 'hello'; v: number; peerId: string; name: string; platform: Platform }
  | { t: 'welcome'; peerId: string; room: string }
  | { t: 'join'; room: string }
  | { t: 'peer-joined'; peerId: string; name: string; platform: Platform }
  | { t: 'peer-left'; peerId: string }
  | { t: 'offer'; to: string; from: string; sdp: string }
  | { t: 'answer'; to: string; from: string; sdp: string }
  | { t: 'ice'; to: string; from: string; candidate: RTCIceCandidateInit }
  | { t: 'error'; code: string; message: string };

export type Platform = 'desktop' | 'mobile' | 'web' | 'relay';

/**
 * Application-level messages sent *inside* the encrypted WebRTC data channel.
 * These are serialized, then sealed with the session key before hitting the
 * wire, so the relay and any on-path observer only ever see ciphertext.
 */
export type ChannelMessage =
  | { t: 'offer-file'; transferId: string; name: string; size: number; mime: string }
  | { t: 'accept-file'; transferId: string }
  | { t: 'reject-file'; transferId: string }
  | { t: 'chunk'; transferId: string; seq: number; last: boolean; data: string }
  | { t: 'ack'; transferId: string; seq: number }
  | { t: 'complete'; transferId: string; sha256: string }
  | { t: 'cancel'; transferId: string; reason: string };

/** Preferred size (in bytes) of a plaintext file chunk before encryption. */
export const CHUNK_SIZE = 64 * 1024;

// ---------------------------------------------------------------------------
// Binary chunk frames (protocol v2).
//
// File chunks travel as raw binary WebRTC data-channel frames instead of
// base64-in-JSON strings. The plaintext frame layout, sealed with AES-GCM as a
// whole, is:
//
//   [0]      magic byte 0x5A ('Z')  — distinguishes a binary frame from a
//            (legacy) JSON string, so a receiver can branch without ambiguity
//   [1]      flags: bit0 = last chunk
//   [2..5]   seq            (uint32, big-endian)
//   [6..21]  transferId     (16 raw bytes; the id is a 32-hex-char string)
//   [22..]   raw chunk bytes
//
// This removes ~2x base64 inflation and a JSON encode/decode per chunk.
// ---------------------------------------------------------------------------

/** Magic byte marking a decrypted binary chunk frame. */
export const BINARY_FRAME_MAGIC = 0x5a;
const FRAME_HEADER_LEN = 22;

export interface ChunkFrame {
  transferId: string;
  seq: number;
  last: boolean;
  data: Uint8Array;
}

/** Encode a chunk into the compact binary frame (plaintext, pre-encryption). */
export function encodeChunkFrame(frame: ChunkFrame): Uint8Array {
  const idBytes = hexToBytes(frame.transferId, 16);
  const out = new Uint8Array(FRAME_HEADER_LEN + frame.data.length);
  out[0] = BINARY_FRAME_MAGIC;
  out[1] = frame.last ? 0x01 : 0x00;
  out[2] = (frame.seq >>> 24) & 0xff;
  out[3] = (frame.seq >>> 16) & 0xff;
  out[4] = (frame.seq >>> 8) & 0xff;
  out[5] = frame.seq & 0xff;
  out.set(idBytes, 6);
  out.set(frame.data, FRAME_HEADER_LEN);
  return out;
}

/** Decode a binary chunk frame. Returns null if the magic byte doesn't match. */
export function decodeChunkFrame(bytes: Uint8Array): ChunkFrame | null {
  if (bytes.length < FRAME_HEADER_LEN || bytes[0] !== BINARY_FRAME_MAGIC) return null;
  const last = (bytes[1] & 0x01) === 0x01;
  const seq = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
  const transferId = bytesToHex(bytes.subarray(6, 22));
  const data = bytes.subarray(FRAME_HEADER_LEN);
  return { transferId, seq, last, data };
}

function hexToBytes(hex: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Metadata describing a transfer, tracked on both ends. */
export interface TransferInfo {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  direction: 'send' | 'receive';
  state: TransferState;
  transferred: number;
  peerId: string;
  peerName: string;
  error?: string;
}

export type TransferState =
  | 'pending'
  | 'active'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';

/** Generate a random transfer id. Crypto-random when available. */
export function newTransferId(): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cross-runtime random bytes. Uses the WebCrypto API present in both the
 * browser/renderer and modern Node (globalThis.crypto).
 */
export function getRandomValues<T extends ArrayBufferView>(arr: T): T {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    return g.crypto.getRandomValues(arr as unknown as Uint8Array) as unknown as T;
  }
  throw new Error('No secure random source available');
}

const ADJECTIVES = [
  'amber', 'brave', 'calm', 'dawn', 'eager', 'frost', 'gold', 'holly',
  'ivory', 'jade', 'keen', 'lunar', 'mint', 'noble', 'onyx', 'plum',
];
const NOUNS = [
  'otter', 'falcon', 'maple', 'harbor', 'comet', 'willow', 'ember', 'quartz',
  'raven', 'sparrow', 'thistle', 'walrus', 'yak', 'zephyr', 'badger', 'crane',
];

/** Build a friendly three-part pairing code like "amber-otter-42". */
export function generatePairingCode(): PairingCode {
  const bytes = new Uint8Array(3);
  getRandomValues(bytes);
  const adj = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  const num = bytes[2] % 100;
  return `${adj}-${noun}-${num}`;
}
