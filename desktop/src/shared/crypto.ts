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
