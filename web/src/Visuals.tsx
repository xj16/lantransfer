import React from 'react';
import type { SAS } from '@shared/crypto';
import type { ThroughputSample, TransferView } from './useLanTransferWeb';

/** Dependency-free inline-SVG sparkline of the live MB/s samples. */
export function Sparkline({ samples }: { samples: ThroughputSample[] }): React.JSX.Element {
  const w = 160;
  const h = 36;
  if (samples.length < 2) {
    return (
      <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <line x1="0" y1={h - 1} x2={w} y2={h - 1} stroke="var(--line)" strokeWidth="1" />
      </svg>
    );
  }
  const max = Math.max(...samples.map((s) => s.mbps), 0.001);
  const pts = samples.map((s, i) => {
    const x = (i / (samples.length - 1)) * w;
    const y = h - (s.mbps / max) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${pts.join(' ')} ${w},${h}`;
  const last = samples[samples.length - 1].mbps;
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${last.toFixed(1)} megabytes per second`}>
      <polygon points={area} fill="var(--accent-a)" />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

/** The animated packet-flow lane between two device cards. */
export function PacketLane({ progress, active }: { progress: number; active: boolean }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, progress));
  return (
    <div className={`lane ${active ? 'lane-active' : ''}`}>
      <div className="lane-track">
        <div className="lane-fill" style={{ width: `${pct}%` }} />
        {active &&
          [0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="packet" style={{ animationDelay: `${i * 0.28}s` }} />
          ))}
      </div>
    </div>
  );
}

/** Encryption shield that flips to "verified" once the SAS is known. */
export function EncryptionShield({ sas }: { sas?: SAS }): React.JSX.Element {
  return (
    <div className={`shield ${sas ? 'shield-verified' : 'shield-pending'}`}>
      <span className="shield-icon">{sas ? '🛡️' : '🔒'}</span>
      <div className="shield-text">
        <div className="shield-title">
          {sas ? 'End-to-end encrypted · verify code' : 'Establishing encrypted channel…'}
        </div>
        {sas && (
          <div className="shield-sas">
            <span className="shield-emoji">{sas.emoji.join(' ')}</span>
            <span className="shield-digits">{sas.digits}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const STATE_LABEL: Record<TransferView['state'], string> = {
  pending: 'Waiting',
  active: 'Transferring',
  completed: 'Verified ✓',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** A rich transfer card with packet lane, sparkline and a checksum checkmark. */
export function TransferCard({ transfer }: { transfer: TransferView }): React.JSX.Element {
  const pct = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : 0;
  const active = transfer.state === 'active';
  const peakMbps = transfer.samples.length ? Math.max(...transfer.samples.map((s) => s.mbps)) : 0;

  return (
    <div className={`transfer-card state-${transfer.state}`}>
      <div className="transfer-head">
        <span className="transfer-dir">{transfer.direction === 'send' ? '↑' : '↓'}</span>
        <span className="transfer-name" title={transfer.name}>
          {transfer.name}
        </span>
        <span className="transfer-size">{humanSize(transfer.size)}</span>
      </div>

      <PacketLane progress={pct} active={active} />

      <div className="transfer-foot">
        <span className="transfer-state">
          {STATE_LABEL[transfer.state]}
          {active ? ` · ${pct.toFixed(0)}%` : ''}
          {transfer.error ? ` · ${transfer.error}` : ''}
        </span>
        {(active || transfer.state === 'completed') && transfer.samples.length > 1 && (
          <span className="transfer-rate">
            <Sparkline samples={transfer.samples} />
            <span className="rate-peak">{peakMbps.toFixed(1)} MB/s peak</span>
          </span>
        )}
      </div>
    </div>
  );
}
