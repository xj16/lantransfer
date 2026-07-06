/**
 * useLanTransfer — the renderer-side orchestration hook.
 *
 * Connects to the relay, tracks discovered peers in the room, spins up a
 * PeerSession per peer on demand, and surfaces transfers + actions to the UI.
 * This is where the shared transport/crypto modules meet React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PeerSession, PeerCallbacks, RTCLike } from '../../shared/peer';
import { RelayClient } from '../../shared/relayClient';
import {
  Platform,
  SignalMessage,
  TransferInfo,
  generatePairingCode,
} from '../../shared/protocol';
import type { AppConfig } from '../../shared/ipc';

export interface DiscoveredPeer {
  peerId: string;
  name: string;
  platform: Platform;
}

export interface IncomingPrompt {
  info: TransferInfo;
  resolve: (accept: boolean) => void;
}

interface State {
  connected: boolean;
  peers: DiscoveredPeer[];
  transfers: TransferInfo[];
  selfId: string;
  incoming: IncomingPrompt | null;
  config: AppConfig | null;
}

function makeSelfId(): string {
  return generatePairingCode() + '-' + Math.random().toString(36).slice(2, 6);
}

/** Standard STUN so peers on different subnets can still form a direct path. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function createConnection(): RTCLike {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS }) as unknown as RTCLike;
}

export function useLanTransfer() {
  const [state, setState] = useState<State>({
    connected: false,
    peers: [],
    transfers: [],
    selfId: makeSelfId(),
    incoming: null,
    config: null,
  });

  const relayRef = useRef<RelayClient | null>(null);
  const sessionsRef = useRef<Map<string, PeerSession>>(new Map());
  const configRef = useRef<AppConfig | null>(null);

  const upsertTransfer = useCallback((info: TransferInfo) => {
    setState((s) => {
      const idx = s.transfers.findIndex((t) => t.transferId === info.transferId);
      const transfers = [...s.transfers];
      if (idx >= 0) transfers[idx] = { ...info };
      else transfers.unshift({ ...info });
      return { ...s, transfers };
    });
  }, []);

  const buildCallbacks = useCallback(
    (): PeerCallbacks => ({
      send: (msg: SignalMessage) => relayRef.current?.send(msg),
      onTransferUpdate: upsertTransfer,
      onIncomingFile: (info) =>
        new Promise<boolean>((resolve) => {
          setState((s) => ({ ...s, incoming: { info, resolve } }));
        }),
      onFileComplete: (_transferId, name, bytes) => {
        const dataBase64 = uint8ToBase64(bytes);
        void window.lantransfer.saveFile({ name, dataBase64 });
      },
      createConnection,
    }),
    [upsertTransfer],
  );

  const getOrCreateSession = useCallback(
    (peer: DiscoveredPeer, initiate: boolean): PeerSession => {
      let session = sessionsRef.current.get(peer.peerId);
      if (!session) {
        session = new PeerSession(state.selfId, peer.peerId, peer.name, buildCallbacks());
        sessionsRef.current.set(peer.peerId, session);
        if (initiate) void session.connect();
      }
      return session;
    },
    [state.selfId, buildCallbacks],
  );

  // Load config, then connect to the relay.
  useEffect(() => {
    let disposed = false;
    async function boot() {
      const config = await window.lantransfer.getConfig();
      if (disposed) return;
      configRef.current = config;
      setState((s) => ({ ...s, config }));

      const relay = new RelayClient({
        url: config.relayUrl,
        peerId: state.selfId,
        name: config.displayName,
        platform: 'desktop',
        room: config.room,
      });
      relayRef.current = relay;

      relay.on((msg) => void handleSignal(msg));
      relay.connect();
      setState((s) => ({ ...s, connected: true }));
    }

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
          const known = { peerId: from, name: from, platform: 'desktop' as Platform };
          const session = getOrCreateSession(known, false);
          void session.handleSignal(msg);
          break;
        }
        default:
          break;
      }
    }

    void boot();
    return () => {
      disposed = true;
      relayRef.current?.close();
      for (const s of sessionsRef.current.values()) s.close();
      sessionsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendFilesTo = useCallback(
    async (peer: DiscoveredPeer) => {
      const picked = await window.lantransfer.pickFiles();
      if (picked.length === 0) return;
      const session = getOrCreateSession(peer, true);
      // Give the channel a moment to open if we just initiated.
      await waitUntil(() => session.isReady, 8000);
      for (const f of picked) {
        const base64 = await window.lantransfer.readFile(f.path);
        const bytes = base64ToUint8(base64);
        await session.sendFile(f.name, f.mime, bytes);
      }
    },
    [getOrCreateSession],
  );

  const answerIncoming = useCallback((accept: boolean) => {
    setState((s) => {
      s.incoming?.resolve(accept);
      return { ...s, incoming: null };
    });
  }, []);

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const next = await window.lantransfer.setConfig(patch);
    configRef.current = next;
    setState((s) => ({ ...s, config: next }));
  }, []);

  const actions = useMemo(
    () => ({ sendFilesTo, answerIncoming, updateConfig }),
    [sendFilesTo, answerIncoming, updateConfig],
  );

  return { ...state, ...actions };
}

// --- helpers ---------------------------------------------------------------

function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
