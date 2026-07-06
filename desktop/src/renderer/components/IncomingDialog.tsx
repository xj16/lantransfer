import React from 'react';
import type { IncomingPrompt } from '../hooks/useLanTransfer';

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  prompt: IncomingPrompt;
  onAnswer: (accept: boolean) => void;
}

export function IncomingDialog({ prompt, onAnswer }: Props): React.JSX.Element {
  const { info } = prompt;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Incoming file</h2>
        <p className="modal-file">
          <strong>{info.name}</strong> ({humanSize(info.size)})
        </p>
        <p className="modal-from">from {info.peerName}</p>
        <div className="modal-actions">
          <button className="btn-reject" onClick={() => onAnswer(false)}>
            Decline
          </button>
          <button className="btn-accept" onClick={() => onAnswer(true)}>
            Accept &amp; save
          </button>
        </div>
      </div>
    </div>
  );
}
