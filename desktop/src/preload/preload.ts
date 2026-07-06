/**
 * Preload script. Runs in an isolated context with access to Node + the
 * ipcRenderer, and exposes a *minimal, typed* API to the renderer via the
 * contextBridge. The renderer never gets Node or ipcRenderer directly.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  AppConfig,
  IPC,
  LanTransferBridge,
  PickedFile,
  SaveFileRequest,
} from '../shared/ipc';

const bridge: LanTransferBridge = {
  pickFiles: (): Promise<PickedFile[]> => ipcRenderer.invoke(IPC.pickFiles),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke(IPC.readFile, p),
  saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(IPC.saveFile, req),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.setConfig, patch),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('lantransfer', bridge);
