import { describe, it, expect } from 'vitest';
import {
  deriveSAS,
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  openBytes,
  seal,
  sealBytes,
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

describe('sealBytes / openBytes (binary hot path)', () => {
  it('round-trips raw bytes without a base64 layer', async () => {
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

    const payload = new Uint8Array(65_536);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff;

    const sealed = await sealBytes(aliceKey, payload);
    // 12-byte nonce + ciphertext + 16-byte GCM tag: no base64 inflation.
    expect(sealed.length).toBe(payload.length + 12 + 16);

    const opened = await openBytes(bobKey, sealed);
    expect(Array.from(opened)).toEqual(Array.from(payload));
  });

  it('rejects a tampered binary frame', async () => {
    const alice = await generateKeyPair();
    const key = await deriveSessionKey(
      alice.privateKey,
      await importPublicKey(await exportPublicKey(alice.publicKey)),
    );
    const sealed = await sealBytes(key, new Uint8Array([1, 2, 3, 4]));
    sealed[sealed.length - 1] ^= 0xff;
    await expect(openBytes(key, sealed)).rejects.toThrow();
  });
});

describe('deriveSAS (Short Authentication String)', () => {
  it('is symmetric: both peers derive the same SAS regardless of order', async () => {
    const alicePub = await exportPublicKey((await generateKeyPair()).publicKey);
    const bobPub = await exportPublicKey((await generateKeyPair()).publicKey);

    const fromAlice = await deriveSAS(alicePub, bobPub);
    const fromBob = await deriveSAS(bobPub, alicePub);

    expect(fromAlice.emoji).toEqual(fromBob.emoji);
    expect(fromAlice.digits).toEqual(fromBob.digits);
    expect(fromAlice.emoji).toHaveLength(4);
    expect(fromAlice.digits).toMatch(/^\d{6}$/);
  });

  it('diverges when a key is swapped (the MITM signal)', async () => {
    const alicePub = await exportPublicKey((await generateKeyPair()).publicKey);
    const bobPub = await exportPublicKey((await generateKeyPair()).publicKey);
    const evePub = await exportPublicKey((await generateKeyPair()).publicKey);

    const honest = await deriveSAS(alicePub, bobPub);
    const mitm = await deriveSAS(alicePub, evePub);

    expect(mitm.digits).not.toEqual(honest.digits);
  });
});
