/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Keeping the channel names and payload types in one place lets both sides
 * import the same definitions and stay in sync.
 */

export const IPC = {
  /** Renderer -> main: open a native file picker, returns chosen file(s). */
  pickFiles: 'lt:pick-files',
  /** Renderer -> main: persist received bytes to disk via a save dialog. */
  saveFile: 'lt:save-file',
  /** Renderer -> main: read app config (relay URL, display name). */
  getConfig: 'lt:get-config',
  /** Renderer -> main: update and persist app config. */
  setConfig: 'lt:set-config',
  /** Renderer -> main: read a picked file's bytes from disk. */
  readFile: 'lt:read-file',
} as const;

export interface PickedFile {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export interface AppConfig {
  relayUrl: string;
  displayName: string;
  downloadDir: string;
  room: string;
}

export interface SaveFileRequest {
  name: string;
  /** File contents as a base64 string (structured-clone-safe over IPC). */
  dataBase64: string;
}

/** The API surface exposed to the renderer on window.lantransfer. */
export interface LanTransferBridge {
  pickFiles(): Promise<PickedFile[]>;
  readFile(path: string): Promise<string>; // returns base64
  saveFile(req: SaveFileRequest): Promise<{ saved: boolean; path?: string }>;
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  platform: string;
}
