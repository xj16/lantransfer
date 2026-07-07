import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  deriveSessionKeyRaw,
  importPrivateKeyJwk,
  importPublicKey,
  open,
  fromBase64Url,
  toBase64Url,
} from './crypto';

/**
 * Cross-platform crypto interop.
 *
 * These vectors are shared verbatim with the Flutter client's Dart interop test
 * (mobile/test/interop_test.dart). Both suites load the SAME file and must
 * agree byte-for-byte, so a divergence in the SPKI prefix, HKDF salt/info, or
 * the nonce||ciphertext frame layout fails CI on both platforms. This turns the
 * "a phone pairs with a laptop" claim from an assertion into a verified fact.
 */

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, '../../../shared/interop/interop-vectors.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as {
  hkdfInfo: string;
  peerA: { privateJwk: JsonWebKey; spkiB64Url: string };
  peerB: { privateJwk: JsonWebKey; spkiB64Url: string };
  sessionKeyB64Url: string;
  sealedFrameB64Url: string;
  expectedPlaintext: string;
};

/**
 * The exact 26-byte SPKI/DER prefix WebCrypto emits for an uncompressed P-256
 * public key. The Dart client hand-rolls this in platform_crypto.dart; both
 * platforms MUST agree or their exchanged public keys are mutually unreadable.
 */
const SPKI_P256_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

describe('cross-platform interop', () => {
  it("WebCrypto's SPKI export uses the exact prefix the Dart client hand-rolls", () => {
    const spki = fromBase64Url(vectors.peerA.spkiB64Url);
    expect(spki.length).toBe(91); // 26 prefix + 1 (0x04) + 64 (X||Y)
    expect(Array.from(spki.slice(0, 26))).toEqual(SPKI_P256_PREFIX);
    expect(spki[26]).toBe(0x04); // uncompressed-point marker
  });

  it('derives the pinned session key from A -> B (independent of who offered)', async () => {
    const aPriv = await importPrivateKeyJwk(vectors.peerA.privateJwk);
    const bPub = await importPublicKey(vectors.peerB.spkiB64Url);
    const raw = await deriveSessionKeyRaw(aPriv, bPub);
    expect(toBase64Url(raw)).toBe(vectors.sessionKeyB64Url);
  });

  it('derives the identical session key from B -> A (mirror direction)', async () => {
    const bPriv = await importPrivateKeyJwk(vectors.peerB.privateJwk);
    const aPub = await importPublicKey(vectors.peerA.spkiB64Url);
    const raw = await deriveSessionKeyRaw(bPriv, aPub);
    expect(toBase64Url(raw)).toBe(vectors.sessionKeyB64Url);
  });

  it('opens the pinned sealed frame to the exact expected plaintext', async () => {
    // Re-import the session key as a non-extractable AES-GCM key for open().
    const raw = fromBase64Url(vectors.sessionKeyB64Url);
    const keyBuf = new ArrayBuffer(raw.byteLength);
    new Uint8Array(keyBuf).set(raw);
    const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const opened = await open(key, vectors.sealedFrameB64Url);
    expect(opened).toBe(vectors.expectedPlaintext);
  });
});
