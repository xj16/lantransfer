import React, { useMemo, useRef, useState } from 'react';
import { useLanTransferWeb, WebConfig, DiscoveredPeer } from './useLanTransferWeb';
import { EncryptionShield, TransferCard } from './Visuals';

const PLATFORM_ICON: Record<string, string> = {
  desktop: '🖥️',
  mobile: '📱',
  web: '🌐',
  relay: '🛰️',
};

function readConfig(): WebConfig {
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1' || params.has('demo');
  return {
    demo,
    relayUrl: params.get('relay') || 'ws://localhost:8080/ws',
    room: params.get('room') || (demo ? 'demo-room' : 'lan'),
    displayName:
      params.get('name') ||
      (demo ? `Tab ${Math.floor(Math.random() * 900 + 100)}` : 'Browser'),
  };
}

export function App(): React.JSX.Element {
  const config = useMemo(readConfig, []);
  const { connected, peers, transfers, incoming, fingerprints, selfId, sendFileTo, answerIncoming } =
    useLanTransferWeb(config);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingPeer, setPendingPeer] = useState<DiscoveredPeer | null>(null);

  const pickAndSend = (peer: DiscoveredPeer) => {
    setPendingPeer(peer);
    fileInputRef.current?.click();
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && pendingPeer) void sendFileTo(pendingPeer, file);
  };

  const sendSample = (peer: DiscoveredPeer) => {
    // A ~1.5 MB deterministic sample so the demo shows a real chunked transfer.
    const bytes = new Uint8Array(1_500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) & 0xff;
    const file = new File([bytes], 'sample-1.5MB.bin', { type: 'application/octet-stream' });
    void sendFileTo(peer, file);
  };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-brand">
          <span className="hero-logo">⇄</span>
          <div>
            <h1>LanTransfer</h1>
            <p className="hero-tag">Encrypted P2P file sharing, straight from a browser tab.</p>
          </div>
        </div>
        <div className="hero-status">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {config.demo ? 'Demo (no server)' : connected ? 'Connected' : 'Offline'}
        </div>
      </header>

      <p className="hero-sub">
        Files flow <strong>device-to-device</strong> over an end-to-end-encrypted WebRTC data
        channel — AES-256-GCM with an ephemeral ECDH handshake. No cloud, no upload, no account.
      </p>

      {config.demo && peers.length === 0 && (
        <div className="demo-cta">
          <div className="demo-cta-title">👋 This is a live, server-free demo</div>
          <p>
            Signaling runs over a <code>BroadcastChannel</code> between tabs on this origin, so two
            tabs pair and transfer a <strong>real file through the real crypto</strong> — no relay
            needed.
          </p>
          <button
            className="btn-primary"
            onClick={() => window.open(location.href, '_blank', 'noopener')}
          >
            Open a second tab ↗
          </button>
          <span className="demo-hint">…then send a file between them.</span>
        </div>
      )}

      <main className="grid">
        <section className="panel">
          <h2>Devices in room “{config.room}”</h2>
          {peers.length === 0 ? (
            <div className="empty">
              <p>Waiting for another device…</p>
              <p className="empty-hint">
                {config.demo
                  ? 'Open a second tab (button above) to see it appear here.'
                  : 'Open LanTransfer on another device using the same relay + room.'}
              </p>
            </div>
          ) : (
            <div className="device-list">
              {peers.map((p) => {
                const sas = fingerprints[p.peerId];
                return (
                  <div className="device" key={p.peerId}>
                    <div className="device-top">
                      <span className="device-icon">{PLATFORM_ICON[p.platform] ?? '💻'}</span>
                      <div className="device-meta">
                        <div className="device-name">{p.name}</div>
                        <div className="device-platform">{p.platform}</div>
                      </div>
                    </div>
                    <EncryptionShield sas={sas} />
                    <div className="device-actions">
                      <button className="btn-primary" onClick={() => pickAndSend(p)}>
                        Send a file…
                      </button>
                      <button className="btn-ghost" onClick={() => sendSample(p)}>
                        Send 1.5 MB sample
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="self-tag">
            You are <code>{config.displayName}</code> · <code>{selfId}</code>
          </div>
        </section>

        <section className="panel">
          <h2>Transfers</h2>
          {transfers.length === 0 ? (
            <div className="empty small">
              <p>Nothing yet — send a file to see the encrypted stream light up.</p>
            </div>
          ) : (
            <div className="transfer-list">
              {transfers.map((t) => (
                <TransferCard key={t.transferId} transfer={t} />
              ))}
            </div>
          )}
        </section>
      </main>

      <input ref={fileInputRef} type="file" hidden onChange={onFilePicked} />

      {incoming && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Incoming file</h3>
            <p>
              <strong>{incoming.info.peerName}</strong> wants to send{' '}
              <code>{incoming.info.name}</code> ({(incoming.info.size / 1024).toFixed(0)} KB).
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => answerIncoming(false)}>
                Decline
              </button>
              <button className="btn-primary" onClick={() => answerIncoming(true)}>
                Accept & save
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="foot">
        Same protocol as the Electron desktop app and the Flutter mobile client · files never touch
        a server ·{' '}
        <a href="https://github.com/xj16/lantransfer" target="_blank" rel="noreferrer">
          source on GitHub
        </a>
      </footer>
    </div>
  );
}
