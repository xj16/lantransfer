import React from 'react';
import type { DiscoveredPeer } from '../hooks/useLanTransfer';
import type { SAS } from '../../shared/crypto';

const PLATFORM_ICON: Record<string, string> = {
  desktop: '🖥️',
  mobile: '📱',
  web: '🌐',
  relay: '🛰️',
};

interface Props {
  peer: DiscoveredPeer;
  onSend: (peer: DiscoveredPeer) => void;
  /** Verification fingerprint, present once the encrypted channel is keyed. */
  sas?: SAS;
}

export function PeerCard({ peer, onSend, sas }: Props): React.JSX.Element {
  return (
    <div className="peer-card">
      <div className="peer-icon">{PLATFORM_ICON[peer.platform] ?? '💻'}</div>
      <div className="peer-meta">
        <div className="peer-name">{peer.name}</div>
        <div className="peer-platform">{peer.platform}</div>
        {sas && (
          <div
            className="peer-sas"
            title="Compare this code with the other device to rule out a man-in-the-middle"
          >
            <span className="peer-sas-shield">🛡️</span>
            <span className="peer-sas-emoji">{sas.emoji.join(' ')}</span>
            <span className="peer-sas-digits">{sas.digits}</span>
          </div>
        )}
      </div>
      <button className="btn-send" onClick={() => onSend(peer)}>
        Send files
      </button>
    </div>
  );
}
