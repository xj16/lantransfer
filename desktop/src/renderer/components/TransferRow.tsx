import React from 'react';
import type { TransferInfo } from '../../shared/protocol';

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const STATE_LABEL: Record<TransferInfo['state'], string> = {
  pending: 'Waiting',
  active: 'Transferring',
  completed: 'Done',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

interface Props {
  transfer: TransferInfo;
}

export function TransferRow({ transfer }: Props): React.JSX.Element {
  const pct =
    transfer.size > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.size) * 100)) : 0;
  const arrow = transfer.direction === 'send' ? '↑' : '↓';

  return (
    <div className={`transfer-row state-${transfer.state}`}>
      <div className="transfer-arrow">{arrow}</div>
      <div className="transfer-body">
        <div className="transfer-top">
          <span className="transfer-name">{transfer.name}</span>
          <span className="transfer-size">{humanSize(transfer.size)}</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="transfer-bottom">
          <span className="transfer-peer">
            {transfer.direction === 'send' ? 'to' : 'from'} {transfer.peerName}
          </span>
          <span className="transfer-state">
            {STATE_LABEL[transfer.state]}
            {transfer.state === 'active' ? ` · ${pct}%` : ''}
            {transfer.error ? ` · ${transfer.error}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
