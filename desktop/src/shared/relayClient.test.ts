import { describe, it, expect, vi } from 'vitest';
import { RelayClient } from './relayClient';
import type { SignalMessage } from './protocol';
import { PROTOCOL_VERSION } from './protocol';

/**
 * A fake WebSocket that lets us drive open/message/close deterministically and
 * capture what the client sends. The RelayClient accepts an injected WebSocket
 * constructor precisely so this needs no real socket.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  deliver(msg: SignalMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function newClient() {
  FakeWebSocket.instances = [];
  const client = new RelayClient({
    url: 'ws://relay.test/ws',
    peerId: 'peer-1',
    name: 'Tester',
    platform: 'desktop',
    room: 'r',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  return client;
}

describe('RelayClient', () => {
  it('sends hello (with protocol version) then join on open', () => {
    const client = newClient();
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    const sent = ws.sent.map((s) => JSON.parse(s) as SignalMessage);
    expect(sent[0]).toMatchObject({ t: 'hello', v: PROTOCOL_VERSION, peerId: 'peer-1' });
    expect(sent[1]).toMatchObject({ t: 'join', room: 'r' });

    client.close();
  });

  it('delivers parsed inbound messages to subscribers and ignores malformed JSON', () => {
    const client = newClient();
    const seen: SignalMessage[] = [];
    client.on((m) => seen.push(m));
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    ws.deliver({ t: 'peer-joined', peerId: 'bob', name: 'Bob', platform: 'mobile' });
    ws.onmessage?.({ data: '{not valid json' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ t: 'peer-joined', peerId: 'bob' });

    client.close();
  });

  it('does not send when the socket is not open', () => {
    const client = newClient();
    client.connect();
    const ws = FakeWebSocket.instances[0];
    // Still CONNECTING — send should be a no-op.
    client.send({ t: 'ice', to: 'x', from: 'peer-1', candidate: {} });
    expect(ws.sent).toHaveLength(0);
    client.close();
  });

  it('reconnects with backoff after an unexpected close', () => {
    vi.useFakeTimers();
    const client = newClient();
    client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.simulateOpen();

    // Simulate the relay dropping the connection.
    ws1.readyState = 3;
    ws1.onclose?.();

    // A reconnect is scheduled ~500ms later.
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    client.close();
    vi.useRealTimers();
  });

  it('stops reconnecting once closed by the user', () => {
    vi.useFakeTimers();
    const client = newClient();
    client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.simulateOpen();

    client.close(); // user-initiated
    vi.advanceTimersByTime(5000);

    // No new socket beyond the first was created.
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });
});
