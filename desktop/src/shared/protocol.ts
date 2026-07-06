/**
 * LanTransfer wire protocol.
 *
 * All peers (desktop, mobile) and the signaling relay speak the same JSON
 * envelope over WebSocket. The relay never sees file bytes — it only brokers
 * the WebRTC handshake (offer/answer/ICE) and presence. Once the data channel
 * is open, encrypted file chunks flow peer-to-peer and never touch the relay.
 */

/** Protocol version. Peers refuse to pair across a major-version mismatch. */
export const PROTOCOL_VERSION = 1;

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
