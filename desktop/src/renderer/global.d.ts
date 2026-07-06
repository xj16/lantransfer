import type { LanTransferBridge } from '../shared/ipc';

declare global {
  interface Window {
    lantransfer: LanTransferBridge;
  }
}

export {};
