import React, { useState } from 'react';
import { useLanTransfer } from './hooks/useLanTransfer';
import { PeerCard } from './components/PeerCard';
import { TransferRow } from './components/TransferRow';
import { IncomingDialog } from './components/IncomingDialog';
import { SettingsPanel } from './components/SettingsPanel';

export function App(): React.JSX.Element {
  const {
    connected,
    peers,
    transfers,
    selfId,
    incoming,
    config,
    fingerprints,
    sendFilesTo,
    answerIncoming,
    updateConfig,
  } = useLanTransfer();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>LanTransfer</h1>
            <p className="tagline">Encrypted P2P file sharing across any OS</p>
          </div>
        </div>
        <div className="header-right">
          <span className={`status-dot ${connected ? 'online' : 'offline'}`} />
          <span className="status-label">{connected ? 'Connected' : 'Offline'}</span>
          <button className="btn-icon" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        </div>
      </header>

      <div className="self-banner">
        You are <code>{config?.displayName ?? selfId}</code> on room{' '}
        <code>{config?.room ?? 'lan'}</code>
      </div>

      <main className="app-main">
        <section className="peers-section">
          <h2>Nearby devices</h2>
          {peers.length === 0 ? (
            <div className="empty">
              <p>No devices found yet.</p>
              <p className="empty-hint">
                Open LanTransfer on another device using the same relay and room. All connections
                are end-to-end encrypted and go directly peer-to-peer.
              </p>
            </div>
          ) : (
            <div className="peer-grid">
              {peers.map((p) => (
                <PeerCard
                  key={p.peerId}
                  peer={p}
                  onSend={sendFilesTo}
                  sas={fingerprints[p.peerId]}
                />
              ))}
            </div>
          )}
        </section>

        <section className="transfers-section">
          <h2>Transfers</h2>
          {transfers.length === 0 ? (
            <div className="empty small">
              <p>No transfers yet.</p>
            </div>
          ) : (
            <div className="transfer-list">
              {transfers.map((t) => (
                <TransferRow key={t.transferId} transfer={t} />
              ))}
            </div>
          )}
        </section>
      </main>

      {incoming && <IncomingDialog prompt={incoming} onAnswer={answerIncoming} />}
      {showSettings && config && (
        <SettingsPanel
          config={config}
          onSave={updateConfig}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
