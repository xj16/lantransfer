/**
 * End-to-end encryption for LanTransfer.
 *
 * Pairing establishes a shared secret using an ECDH (P-256) key exchange.
 * Both peers derive an identical AES-256-GCM session key via HKDF-SHA-256.
 * Every ChannelMessage payload is sealed with a fresh 96-bit nonce, so the
 * relay — and anyone on the wire — only ever sees ciphertext.
 *
 * This module targets the WebCrypto SubtleCrypto API, available in both the
 * Electron renderer and the Node main process (globalThis.crypto.subtle),
 * so the exact same code runs on both sides of the app.
 */

const subtle = (): SubtleCrypto => {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (!g.crypto || !g.crypto.subtle) {
    throw new Error('WebCrypto SubtleCrypto is not available in this runtime');
  }
  return g.crypto.subtle;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

const EC_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const HKDF_INFO = enc.encode('lantransfer/v1/session-key');

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/** A raw (SPKI) public key, base64url-encoded for transport in a pairing code. */
export type ExportedPublicKey = string;

/** Generate an ephemeral ECDH key pair for a single pairing session. */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await subtle().generateKey(EC_PARAMS, true, ['deriveKey', 'deriveBits']);
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Export a public key to a base64url string for out-of-band sharing. */
export async function exportPublicKey(key: CryptoKey): Promise<ExportedPublicKey> {
  const spki = await subtle().exportKey('spki', key);
  return toBase64Url(new Uint8Array(spki));
}

/** Import a peer's exported public key. */
export async function importPublicKey(data: ExportedPublicKey): Promise<CryptoKey> {
  const raw = fromBase64Url(data);
  return subtle().importKey('spki', bufferSource(raw), EC_PARAMS, true, []);
}

/**
 * Import a private ECDH key from a JWK. Used by the cross-platform interop test
 * to load pinned key material so desktop and mobile derive the same session key
 * from identical inputs.
 */
export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, EC_PARAMS, true, ['deriveKey', 'deriveBits']);
}

/**
 * Derive the shared AES-256-GCM session key from our private key and the
 * peer's public key. Both sides compute the identical key. HKDF binds the
 * key to a protocol-specific info string to prevent cross-protocol reuse.
 */
export async function deriveSessionKey(
  ownPrivate: CryptoKey,
  peerPublic: CryptoKey,
): Promise<CryptoKey> {
  const sharedBits = await subtle().deriveBits(
    { name: 'ECDH', public: peerPublic },
    ownPrivate,
    256,
  );

  const hkdfKey = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Like {@link deriveSessionKey}, but returns the raw 32-byte HKDF output rather
 * than a non-extractable CryptoKey. Used by the cross-platform interop test to
 * compare the derived key material byte-for-byte against a pinned vector.
 */
export async function deriveSessionKeyRaw(
  ownPrivate: CryptoKey,
  peerPublic: CryptoKey,
): Promise<Uint8Array> {
  const sharedBits = await subtle().deriveBits(
    { name: 'ECDH', public: peerPublic },
    ownPrivate,
    256,
  );
  const hkdfKey = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const out = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    hkdfKey,
    256,
  );
  return new Uint8Array(out);
}

/** A sealed message: 12-byte nonce prepended to the GCM ciphertext, base64url. */
export type SealedMessage = string;

/** Encrypt a UTF-8 string payload with the session key. */
export async function seal(key: CryptoKey, plaintext: string): Promise<SealedMessage> {
  const nonce = new Uint8Array(12);
  (globalThis.crypto as Crypto).getRandomValues(nonce);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), tagLength: 128 },
    key,
    bufferSource(enc.encode(plaintext)),
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(nonce.length + ctBytes.length);
  out.set(nonce, 0);
  out.set(ctBytes, nonce.length);
  return toBase64Url(out);
}

/** Decrypt a sealed message back to its plaintext string. Throws on tamper. */
export async function open(key: CryptoKey, sealed: SealedMessage): Promise<string> {
  const bytes = fromBase64Url(sealed);
  if (bytes.length < 13) throw new Error('Ciphertext too short');
  const nonce = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), tagLength: 128 },
    key,
    bufferSource(ct),
  );
  return dec.decode(pt);
}

/**
 * Seal raw bytes with the session key, returning `nonce(12) || ciphertext(+tag)`
 * as a Uint8Array — no base64 layer. This is the hot path for file chunks sent
 * as binary WebRTC data-channel frames, avoiding the ~2x base64 inflation that
 * the string-based {@link seal} incurs.
 */
export async function sealBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = new Uint8Array(12);
  (globalThis.crypto as Crypto).getRandomValues(nonce);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), tagLength: 128 },
    key,
    bufferSource(plaintext),
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(nonce.length + ctBytes.length);
  out.set(nonce, 0);
  out.set(ctBytes, nonce.length);
  return out;
}

/** Decrypt a `nonce || ciphertext` byte blob produced by {@link sealBytes}. */
export async function openBytes(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 13) throw new Error('Ciphertext too short');
  const nonce = sealed.slice(0, 12);
  const ct = sealed.slice(12);
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), tagLength: 128 },
    key,
    bufferSource(ct),
  );
  return new Uint8Array(pt);
}

/**
 * Derive a Short Authentication String (SAS) from both peers' public keys.
 *
 * This binds the two *public* keys — as actually seen by each peer — into a
 * short, human-comparable fingerprint. If a malicious relay swaps the keys for
 * a man-in-the-middle, each side sees a different peer key and the SAS diverges,
 * so a quick out-of-band comparison ("do these four emoji match?") detects the
 * attack that the ECDH handshake alone cannot.
 *
 * The two public keys are sorted before hashing so both peers derive the
 * identical SAS regardless of who offered. Returns both a 4-emoji code (fast to
 * eyeball) and a 6-digit numeric code (unambiguous to read aloud).
 */
export interface SAS {
  emoji: string[];
  digits: string;
}

// A curated, visually-distinct emoji alphabet (64 entries => 6 bits each).
const SAS_EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵',
  '🐔', '🐧', '🦆', '🦉', '🦄', '🐝', '🐢', '🐙', '🦀', '🐬', '🐳', '🐠',
  '🌵', '🌲', '🍁', '🌸', '🌻', '🍀', '🍄', '🌍', '🌙', '⭐', '⚡', '🔥',
  '❄️', '🌈', '☂️', '⚓', '🎈', '🎁', '🔑', '🔔', '🎸', '🎺', '🥁', '🎨',
  '🍎', '🍊', '🍋', '🍇', '🍓', '🍒', '🍑', '🥝', '🌶️', '🌽', '🍞', '🧀',
  '🚀', '⛵', '🚲', '🎡',
];

export async function deriveSAS(ownPublicB64: string, peerPublicB64: string): Promise<SAS> {
  // Sort so both peers hash the same ordered pair.
  const [a, b] = [ownPublicB64, peerPublicB64].sort();
  const material = enc.encode(`lantransfer/v1/sas\n${a}\n${b}`);
  const digest = new Uint8Array(await subtle().digest('SHA-256', bufferSource(material)));

  // 4 emoji from the first 3 bytes (24 bits => 4 x 6-bit indices).
  const emoji = [
    SAS_EMOJI[digest[0] >> 2],
    SAS_EMOJI[((digest[0] & 0x03) << 4) | (digest[1] >> 4)],
    SAS_EMOJI[((digest[1] & 0x0f) << 2) | (digest[2] >> 6)],
    SAS_EMOJI[digest[2] & 0x3f],
  ];

  // 6 decimal digits from the next 3 bytes.
  const num = ((digest[3] << 16) | (digest[4] << 8) | digest[5]) % 1_000_000;
  const digits = num.toString().padStart(6, '0');

  return { emoji, digits };
}

/** SHA-256 of raw bytes, returned as a lowercase hex string. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest('SHA-256', bufferSource(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize any Uint8Array into a plain ArrayBuffer-backed view for the
 * WebCrypto APIs, which reject SharedArrayBuffer-backed views under the
 * stricter TypeScript 5.7+ typed-array generics.
 */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// ---------------------------------------------------------------------------
// base64url helpers (URL-safe, no padding) — runtime-agnostic
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const norm = b64 + pad;
  if (typeof atob === 'function') {
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(norm, 'base64'));
}
