/**
 * Tiny JSON-file-backed config store for the main process. Avoids a native
 * dependency; the config lives under the OS user-data directory.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../shared/ipc';

function defaults(): AppConfig {
  return {
    relayUrl: 'ws://localhost:8080/ws',
    displayName: os.hostname() || 'My Device',
    downloadDir: app.getPath('downloads'),
    room: 'lan',
  };
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'lantransfer.config.json');
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

export async function saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const next: AppConfig = { ...current, ...patch };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}
