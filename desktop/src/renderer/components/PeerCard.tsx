import React from 'react';
import type { DiscoveredPeer } from '../hooks/useLanTransfer';

const PLATFORM_ICON: Record<string, string> = {
  desktop: '🖥️',
  mobile: '📱',
  web: '🌐',
  relay: '🛰️',
};

interface Props {
  peer: DiscoveredPeer;
  onSend: (peer: DiscoveredPeer) => void;
}

export function PeerCard({ peer, onSend }: Props): React.JSX.Element {
  return (
    <div className="peer-card">
      <div className="peer-icon">{PLATFORM_ICON[peer.platform] ?? '💻'}</div>
      <div className="peer-meta">
        <div className="peer-name">{peer.name}</div>
        <div className="peer-platform">{peer.platform}</div>
      </div>
      <button className="btn-send" onClick={() => onSend(peer)}>
        Send files
      </button>
    </div>
  );
}
