/**
 * useLanTransferWeb — the browser client's orchestration hook.
 *
 * It reuses the desktop's runtime-agnostic PeerSession, crypto, and protocol
 * verbatim; only the transport (real relay WebSocket vs. loopback
 * BroadcastChannel) and the host bindings (File API, blob download) are
 * browser-specific. It also tracks live throughput samples so the UI can draw
 * a real MB/s sparkline of the transfer it just computed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PeerSession, PeerCallbacks, RTCLike } from '@shared/peer';
import { RelayClient } from '@shared/relayClient';
import type { SAS } from '@shared/crypto';
import {
  Platform,
  SignalMessage,
  TransferInfo,
  generatePairingCode,
} from '@shared/protocol';
import { LoopbackSignal } from './loopbackSignal';

export interface DiscoveredPeer {
  peerId: string;
  name: string;
  platform: Platform;
}

export interface IncomingPrompt {
  info: TransferInfo;
  resolve: (accept: boolean) => void;
}

/** A single throughput sample: MB/s at a moment during a transfer. */
export interface ThroughputSample {
  t: number;
  mbps: number;
}

export interface TransferView extends TransferInfo {
  samples: ThroughputSample[];
  sas?: SAS;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function createConnection(): RTCLike {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS }) as unknown as RTCLike;
}

interface Transport {
  on(listener: (msg: SignalMessage) => void): () => void;
  connect(): void;
  send(msg: SignalMessage): void;
  close(): void;
}

export interface WebConfig {
  demo: boolean;
  relayUrl: string;
  room: string;
  displayName: string;
}

interface State {
  connected: boolean;
  peers: DiscoveredPeer[];
  transfers: TransferView[];
  incoming: IncomingPrompt | null;
  fingerprints: Record<string, SAS>;
}

function makeSelfId(): string {
  return generatePairingCode() + '-' + Math.random().toString(36).slice(2, 6);
}

export function useLanTransferWeb(config: WebConfig) {
  const [state, setState] = useState<State>({
    connected: false,
    peers: [],
    transfers: [],
    incoming: null,
    fingerprints: {},
  });

  const selfIdRef = useRef<string>(makeSelfId());
  const transportRef = useRef<Transport | null>(null);
  const sessionsRef = useRef<Map<string, PeerSession>>(new Map());
  const rateRef = useRef<Map<string, { lastBytes: number; lastTime: number }>>(new Map());

  const upsertTransfer = useCallback((info: TransferInfo) => {
    setState((s) => {
      const idx = s.transfers.findIndex((t) => t.transferId === info.transferId);
      const transfers = [...s.transfers];

      // Compute an instantaneous throughput sample for active transfers.
      const now = performance.now();
      const prev = rateRef.current.get(info.transferId);
      let samples: ThroughputSample[] = idx >= 0 ? transfers[idx].samples : [];
      if (info.state === 'active' && prev) {
        const dt = (now - prev.lastTime) / 1000;
        const dBytes = info.transferred - prev.lastBytes;
        if (dt > 0.03 && dBytes >= 0) {
          const mbps = dBytes / dt / (1024 * 1024);
          samples = [...samples, { t: now, mbps }].slice(-60);
        }
      }
      if (info.state === 'active') {
        rateRef.current.set(info.transferId, { lastBytes: info.transferred, lastTime: now });
      }

      const view: TransferView = { ...info, samples };
      if (idx >= 0) transfers[idx] = view;
      else transfers.unshift(view);
      return { ...s, transfers };
    });
  }, []);

  const buildCallbacks = useCallback(
    (peerId: string): PeerCallbacks => ({
      send: (msg: SignalMessage) => transportRef.current?.send(msg),
      onTransferUpdate: upsertTransfer,
      onIncomingFile: (info) =>
        new Promise<boolean>((resolve) => {
          setState((s) => ({ ...s, incoming: { info, resolve } }));
        }),
      onFileComplete: (_transferId, name, bytes) => {
        downloadBlob(name, bytes);
      },
      onSAS: (sas) => {
        setState((s) => ({ ...s, fingerprints: { ...s.fingerprints, [peerId]: sas } }));
      },
      createConnection,
    }),
    [upsertTransfer],
  );

  const getOrCreateSession = useCallback(
    (peer: DiscoveredPeer, initiate: boolean): PeerSession => {
      let session = sessionsRef.current.get(peer.peerId);
      if (!session) {
        session = new PeerSession(selfIdRef.current, peer.peerId, peer.name, buildCallbacks(peer.peerId));
        sessionsRef.current.set(peer.peerId, session);
        if (initiate) void session.connect();
      }
      return session;
    },
    [buildCallbacks],
  );

  useEffect(() => {
    const selfId = selfIdRef.current;

    const transport: Transport = config.demo
      ? new LoopbackSignal({ peerId: selfId, name: config.displayName, platform: 'web', room: config.room })
      : new RelayClient({
          url: config.relayUrl,
          peerId: selfId,
          name: config.displayName,
          platform: 'web',
          room: config.room,
        });
    transportRef.current = transport;

    function handleSignal(msg: SignalMessage) {
      switch (msg.t) {
        case 'peer-joined':
          setState((s) => {
            if (s.peers.some((p) => p.peerId === msg.peerId)) return s;
            return {
              ...s,
              peers: [...s.peers, { peerId: msg.peerId, name: msg.name, platform: msg.platform }],
            };
          });
          break;
        case 'peer-left':
          setState((s) => ({ ...s, peers: s.peers.filter((p) => p.peerId !== msg.peerId) }));
          sessionsRef.current.get(msg.peerId)?.close();
          sessionsRef.current.delete(msg.peerId);
          break;
        case 'offer':
        case 'answer':
        case 'ice': {
          const from = msg.from;
          const known = { peerId: from, name: from, platform: 'web' as Platform };
          const session = getOrCreateSession(known, false);
          void session.handleSignal(msg);
          break;
        }
        default:
          break;
      }
    }

    transport.on((msg) => handleSignal(msg));
    transport.connect();
    setState((s) => ({ ...s, connected: true }));

    return () => {
      transport.close();
      for (const sess of sessionsRef.current.values()) sess.close();
      sessionsRef.current.clear();
    };
  }, [config.demo, config.relayUrl, config.room, config.displayName, getOrCreateSession]);

  const sendFileTo = useCallback(
    async (peer: DiscoveredPeer, file: File) => {
      const session = getOrCreateSession(peer, true);
      await waitUntil(() => session.isReady, 10000);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await session.sendFile(file.name, file.type || 'application/octet-stream', bytes);
    },
    [getOrCreateSession],
  );

  const answerIncoming = useCallback((accept: boolean) => {
    setState((s) => {
      s.incoming?.resolve(accept);
      return { ...s, incoming: null };
    });
  }, []);

  const selfId = selfIdRef.current;
  const actions = useMemo(() => ({ sendFileTo, answerIncoming }), [sendFileTo, answerIncoming]);

  return { ...state, selfId, ...actions };
}

function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for channel'));
      setTimeout(tick, 80);
    };
    tick();
  });
}

function downloadBlob(name: string, bytes: Uint8Array): void {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
