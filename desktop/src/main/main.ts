/**
 * Electron main process.
 *
 * Owns the BrowserWindow and the privileged operations the sandboxed renderer
 * cannot do directly: native file pickers, reading/writing files on disk, and
 * persisting config. All file bytes cross the IPC boundary as base64 strings.
 *
 * The renderer holds the WebRTC + crypto logic (it has WebCrypto + RTCPeer-
 * Connection natively), so main stays small and security-focused.
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import { IPC, PickedFile, SaveFileRequest } from '../shared/ipc';
import { loadConfig, saveConfig } from './config';

const isDev = !app.isPackaged;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'LanTransfer',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.pickFiles, async (): Promise<PickedFile[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    const files: PickedFile[] = [];
    for (const p of result.filePaths) {
      const stat = await fs.stat(p);
      files.push({
        path: p,
        name: path.basename(p),
        size: stat.size,
        mime: mimeLookup(p) || 'application/octet-stream',
      });
    }
    return files;
  });

  ipcMain.handle(IPC.readFile, async (_e, p: string): Promise<string> => {
    const buf = await fs.readFile(p);
    return buf.toString('base64');
  });

  ipcMain.handle(IPC.saveFile, async (_e, req: SaveFileRequest) => {
    const cfg = await loadConfig();
    const defaultPath = path.join(cfg.downloadDir, req.name);
    const result = await dialog.showSaveDialog({ defaultPath });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.writeFile(result.filePath, Buffer.from(req.dataBase64, 'base64'));
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle(IPC.getConfig, () => loadConfig());
  ipcMain.handle(IPC.setConfig, (_e, patch) => saveConfig(patch));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
