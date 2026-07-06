# LanTransfer Desktop

The flagship LanTransfer client — an **Electron + React + TypeScript** desktop app
for Windows, macOS, and Linux. Discover nearby devices, send files with a click,
and receive them into your Downloads folder, all **end-to-end encrypted** and
**directly peer-to-peer**.

## Develop

```bash
npm install
npm run dev        # electron-vite dev server with hot reload
```

Point the relay URL (Settings ⚙) at your running relay, e.g. `ws://localhost:8080/ws`.

## Build & verify

```bash
npm run typecheck  # strict TypeScript, no emit
npm test           # Vitest: crypto + end-to-end transfer engine
npm run build      # type-check + bundle main, preload, and renderer
```

## How it's structured

```
src/
  main/        Electron main process — window, native file dialogs, config,
               disk I/O. The only place with Node/filesystem access.
  preload/     contextBridge — exposes a minimal, typed API to the renderer.
  renderer/    React UI + the WebRTC/crypto orchestration hook.
  shared/      Protocol, crypto, PeerSession, and relay client — pure, portable
               TypeScript reused across processes and covered by unit tests.
```

### Security-relevant design

- `contextIsolation: true`, `nodeIntegration: false` — the renderer has **no**
  direct Node access; it talks to main only through the typed preload bridge.
- A strict Content-Security-Policy in `index.html` limits what the renderer can
  load and connect to.
- All crypto (ECDH P-256 → HKDF → AES-256-GCM) runs via the platform WebCrypto
  API in [`src/shared/crypto.ts`](src/shared/crypto.ts); the transfer state
  machine lives in [`src/shared/peer.ts`](src/shared/peer.ts).

## Tests

- `src/shared/crypto.test.ts` — base64url round-trips, a known SHA-256 vector,
  a full ECDH+AES-GCM handshake between two peers, tamper rejection, and
  wrong-key rejection.
- `src/shared/peer.test.ts` — spins up two `PeerSession`s over in-memory fake
  WebRTC connections and transfers a 200 KB payload through the real encryption,
  chunking, and checksum-verification path.
