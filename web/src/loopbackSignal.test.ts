import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LoopbackSignal } from './loopbackSignal';
import type { SignalMessage } from '@shared/protocol';

/**
 * A minimal in-process BroadcastChannel polyfill so the loopback signaling
 * transport can be exercised in Node. All channels sharing a name see each
 * other's posts (except the sender), mirroring the browser semantics the demo
 * relies on to pair two tabs without a server.
 */
class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(public name: string) {
    const set = FakeBroadcastChannel.registry.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.registry.set(name, set);
  }

  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.registry.get(this.name);
    if (!peers) return;
    for (const p of peers) {
      if (p === this) continue;
      // Deliver asynchronously like the real thing.
      setTimeout(() => p.onmessage?.({ data }), 0);
    }
  }

  close(): void {
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LoopbackSignal', () => {
  beforeEach(() => {
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    FakeBroadcastChannel.registry.clear();
  });

  afterEach(() => {
    FakeBroadcastChannel.registry.clear();
  });

  it('surfaces a peer-joined when a second tab announces itself', async () => {
    const alice = new LoopbackSignal({ peerId: 'alice', name: 'Alice', platform: 'web', room: 'r' });
    const bob = new LoopbackSignal({ peerId: 'bob', name: 'Bob', platform: 'web', room: 'r' });

    const aliceSaw: SignalMessage[] = [];
    const bobSaw: SignalMessage[] = [];
    alice.on((m) => aliceSaw.push(m));
    bob.on((m) => bobSaw.push(m));

    alice.connect();
    bob.connect();
    await wait(30);

    // Each side learns about the other exactly once (deduped).
    const aliceJoins = aliceSaw.filter((m) => m.t === 'peer-joined');
    const bobJoins = bobSaw.filter((m) => m.t === 'peer-joined');
    expect(aliceJoins.map((m) => (m as { peerId: string }).peerId)).toContain('bob');
    expect(bobJoins.map((m) => (m as { peerId: string }).peerId)).toContain('alice');
    expect(aliceJoins.filter((m) => (m as { peerId: string }).peerId === 'bob')).toHaveLength(1);

    alice.close();
    bob.close();
  });

  it('routes a directed offer only to its addressed peer', async () => {
    const alice = new LoopbackSignal({ peerId: 'alice', name: 'Alice', platform: 'web', room: 'r' });
    const bob = new LoopbackSignal({ peerId: 'bob', name: 'Bob', platform: 'web', room: 'r' });
    const carol = new LoopbackSignal({ peerId: 'carol', name: 'Carol', platform: 'web', room: 'r' });

    const bobSaw: SignalMessage[] = [];
    const carolSaw: SignalMessage[] = [];
    bob.on((m) => bobSaw.push(m));
    carol.on((m) => carolSaw.push(m));

    alice.connect();
    bob.connect();
    carol.connect();
    await wait(20);

    alice.send({ t: 'offer', to: 'bob', from: 'alice', sdp: 'the-sdp' });
    await wait(20);

    expect(bobSaw.some((m) => m.t === 'offer' && m.sdp === 'the-sdp')).toBe(true);
    // Carol must NOT receive an offer addressed to Bob.
    expect(carolSaw.some((m) => m.t === 'offer')).toBe(false);

    alice.close();
    bob.close();
    carol.close();
  });

  it('isolates rooms: a different room never sees the traffic', async () => {
    const a = new LoopbackSignal({ peerId: 'a', name: 'A', platform: 'web', room: 'room1' });
    const b = new LoopbackSignal({ peerId: 'b', name: 'B', platform: 'web', room: 'room2' });
    const bSaw: SignalMessage[] = [];
    b.on((m) => bSaw.push(m));

    a.connect();
    b.connect();
    await wait(20);

    expect(bSaw.filter((m) => m.t === 'peer-joined')).toHaveLength(0);

    a.close();
    b.close();
  });
});
