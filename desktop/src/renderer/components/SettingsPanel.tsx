import React, { useState } from 'react';
import type { AppConfig } from '../../shared/ipc';

interface Props {
  config: AppConfig;
  onSave: (patch: Partial<AppConfig>) => void;
  onClose: () => void;
}

export function SettingsPanel({ config, onSave, onClose }: Props): React.JSX.Element {
  const [relayUrl, setRelayUrl] = useState(config.relayUrl);
  const [displayName, setDisplayName] = useState(config.displayName);
  const [room, setRoom] = useState(config.room);

  return (
    <div className="modal-backdrop">
      <div className="modal settings">
        <h2>Settings</h2>

        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>

        <label className="field">
          <span>Relay URL</span>
          <input
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
            placeholder="ws://localhost:8080/ws"
          />
        </label>

        <label className="field">
          <span>Room</span>
          <input value={room} onChange={(e) => setRoom(e.target.value)} />
        </label>

        <p className="hint">
          Devices sharing the same relay URL and room can see each other. Run your own relay from
          the <code>/relay</code> folder — files never pass through it.
        </p>

        <div className="modal-actions">
          <button className="btn-reject" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-accept"
            onClick={() => {
              onSave({ relayUrl, displayName, room });
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
