import { describe, it, expect } from 'vitest';
import {
  BINARY_FRAME_MAGIC,
  decodeChunkFrame,
  encodeChunkFrame,
  newTransferId,
  PROTOCOL_VERSION,
} from './protocol';

describe('protocol version', () => {
  it('is v2 (binary chunk frames)', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe('binary chunk frame codec', () => {
  it('round-trips a chunk frame through encode/decode', () => {
    const transferId = newTransferId();
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;

    const encoded = encodeChunkFrame({ transferId, seq: 42, last: true, data });
    expect(encoded[0]).toBe(BINARY_FRAME_MAGIC);

    const decoded = decodeChunkFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.transferId).toBe(transferId);
    expect(decoded!.seq).toBe(42);
    expect(decoded!.last).toBe(true);
    expect(Array.from(decoded!.data)).toEqual(Array.from(data));
  });

  it('preserves a large 32-bit sequence number', () => {
    const transferId = newTransferId();
    const encoded = encodeChunkFrame({
      transferId,
      seq: 0xdead_beef,
      last: false,
      data: new Uint8Array(0),
    });
    const decoded = decodeChunkFrame(encoded)!;
    expect(decoded.seq).toBe(0xdead_beef);
    expect(decoded.last).toBe(false);
  });

  it('rejects a buffer that lacks the magic byte', () => {
    const notAFrame = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(decodeChunkFrame(notAFrame)).toBeNull();
  });

  it('adds only a fixed 22-byte header of overhead', () => {
    const transferId = newTransferId();
    const data = new Uint8Array(64 * 1024);
    const encoded = encodeChunkFrame({ transferId, seq: 0, last: false, data });
    // A 64 KiB chunk becomes 64 KiB + 22 bytes — vs the v1 path which base64'd
    // the chunk (~1.33x), JSON-wrapped it, then base64'd the sealed result again.
    expect(encoded.length).toBe(data.length + 22);
  });
});
