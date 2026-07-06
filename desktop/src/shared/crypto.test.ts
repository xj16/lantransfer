import { describe, it, expect } from 'vitest';
import {
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  seal,
  sha256Hex,
  toBase64Url,
  fromBase64Url,
} from './crypto';

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63, 64]);
    const s = toBase64Url(bytes);
    expect(s).not.toMatch(/[+/=]/); // url-safe, unpadded
    expect(Array.from(fromBase64Url(s))).toEqual(Array.from(bytes));
  });
});

describe('sha256Hex', () => {
  it('matches a known vector for the empty input', async () => {
    const digest = await sha256Hex(new Uint8Array(0));
    expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('ECDH + AES-GCM end-to-end', () => {
  it('two peers derive the same key and can exchange sealed messages', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    // Exchange public keys (as they would travel through the relay).
    const alicePubB64 = await exportPublicKey(alice.publicKey);
    const bobPubB64 = await exportPublicKey(bob.publicKey);

    const aliceKey = await deriveSessionKey(alice.privateKey, await importPublicKey(bobPubB64));
    const bobKey = await deriveSessionKey(bob.privateKey, await importPublicKey(alicePubB64));

    const plaintext = JSON.stringify({ t: 'offer-file', name: 'secret.pdf', size: 1234 });
    const sealed = await seal(aliceKey, plaintext);

    // The sealed blob must not leak the plaintext.
    expect(sealed).not.toContain('secret.pdf');

    // Bob, holding the mirror-image derived key, can open it.
    const opened = await open(bobKey, sealed);
    expect(opened).toBe(plaintext);
  });

  it('rejects a tampered ciphertext', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const aliceKey = await deriveSessionKey(
      alice.privateKey,
      await importPublicKey(await exportPublicKey(bob.publicKey)),
    );
    const bobKey = await deriveSessionKey(
      bob.privateKey,
      await importPublicKey(await exportPublicKey(alice.publicKey)),
    );

    const sealed = await seal(aliceKey, 'hello world');
    // Flip a byte in the middle of the ciphertext.
    const bytes = fromBase64Url(sealed);
    bytes[bytes.length - 3] ^= 0xff;
    const tampered = toBase64Url(bytes);

    await expect(open(bobKey, tampered)).rejects.toThrow();
  });

  it('a wrong key cannot open the message', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const eve = await generateKeyPair();

    const aliceKey = await deriveSessionKey(
      alice.privateKey,
      await importPublicKey(await exportPublicKey(bob.publicKey)),
    );
    // Eve derives against Alice's public key but with her own private key.
    const eveKey = await deriveSessionKey(
      eve.privateKey,
      await importPublicKey(await exportPublicKey(alice.publicKey)),
    );

    const sealed = await seal(aliceKey, 'top secret');
    await expect(open(eveKey, sealed)).rejects.toThrow();
  });
});
