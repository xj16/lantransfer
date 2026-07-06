# LanTransfer

**Encrypted P2P file sharing across any OS — AirDrop for everyone.**

LanTransfer sends files **directly between your devices** over the local network
(or the wider internet via WebRTC), with **no cloud, no accounts, and no upload
to anyone's server**. Files are **end-to-end encrypted** on a direct peer-to-peer
channel; a tiny self-hostable relay only helps devices find each other and never
sees a single byte of your data.

Think AirDrop, but it works between Windows, macOS, Linux, Android, and iOS — and
you own the whole stack.

---

## Why

Sharing a file between a laptop and a phone on the same Wi-Fi shouldn't require
uploading it to a third-party cloud, emailing it to yourself, or being locked
into one vendor's ecosystem. LanTransfer keeps the transfer **local and private**:

- **No cloud.** Bytes flow device-to-device over a WebRTC data channel.
- **End-to-end encrypted.** Every message is sealed with AES-256-GCM using a key
  derived from an ephemeral ECDH (P-256) handshake — the relay only ever brokers
  *public* keys and opaque SDP.
- **Cross-platform.** One protocol, three clients: an Electron desktop app, a
  Flutter mobile app, and a Go relay you can run anywhere.
- **Self-hostable & free.** The relay is a single static Go binary. Run it on a
  Raspberry Pi, a spare box, or a $5 VPS. No paid API, ever.

---

## Architecture

```
┌────────────────┐        signaling (offer/answer/ICE)        ┌────────────────┐
│  Desktop app   │  ⇄ ───────────────────────────────────── ⇄ │   Mobile app   │
│ Electron+React │            via the Go relay                 │  Flutter+Dart  │
└───────┬────────┘                    │                        └────────┬───────┘
        │                    ┌────────▼─────────┐                       │
        │                    │   Go relay       │                       │
        │                    │ (presence + WebRTC│                      │
        │                    │  handshake only) │                       │
        │                    └──────────────────┘                       │
        │                                                               │
        └──────────  encrypted WebRTC data channel (direct P2P)  ───────┘
                     AES-256-GCM · files never touch the relay
```

**The relay is deliberately dumb.** It tracks who is in a "room" and forwards the
WebRTC handshake between peers. Once the data channel opens, the relay is out of
the loop entirely — chunks travel directly between devices, encrypted with a key
only the two peers possess.

### The transfer protocol

Both clients share an identical wire protocol
([`desktop/src/shared/protocol.ts`](desktop/src/shared/protocol.ts) and
[`mobile/lib/src/protocol.dart`](mobile/lib/src/protocol.dart)):

1. **Pair.** Peers join a room on the relay and exchange an SDP offer/answer. The
   ephemeral ECDH public key is piggybacked on the SDP (`a=x-lantransfer-key`), so
   no extra out-of-band step is needed.
2. **Key.** Each side runs ECDH → HKDF-SHA-256 → a shared AES-256-GCM session key.
   Identical key, derived independently, never transmitted.
3. **Offer a file.** The sender emits an encrypted `offer-file` (name, size, mime).
4. **Accept.** The receiver confirms; the UI prompts the user.
5. **Stream.** The file is split into 64 KiB chunks, each sealed with a fresh
   96-bit nonce, sent over the data channel with backpressure control.
6. **Verify.** On completion the receiver recomputes SHA-256 and rejects the file
   on any mismatch — protecting against corruption *and* tampering.

---

## Repository layout

| Path        | Stack                              | What it is                                        |
|-------------|------------------------------------|---------------------------------------------------|
| `desktop/`  | Electron · React · TypeScript      | **Flagship** desktop app (Win/macOS/Linux)        |
| `relay/`    | Go · gorilla/websocket             | Self-hostable signaling relay (`go build`)        |
| `mobile/`   | Flutter · Dart                     | Android/iOS client sharing the same protocol      |

Each component has its own README with deeper detail.

---

## Quick start

### 1. Run the relay

```bash
cd relay
go run ./cmd/relay          # listens on :8080, endpoint ws://<host>:8080/ws
# or build a static binary:
go build -o lantransfer-relay ./cmd/relay && ./lantransfer-relay -addr :8080
```

Health check: `curl http://localhost:8080/health` → `{"status":"ok",...}`.

### 2. Run the desktop app

```bash
cd desktop
npm install
npm run dev                 # launches Electron with hot reload
```

Open **Settings** and point **Relay URL** at your relay
(`ws://<relay-host>:8080/ws`). Devices sharing the same relay URL **and room**
discover each other automatically.

Production build (type-checks, runs tests, bundles main + preload + renderer):

```bash
npm run build
```

### 3. Run the mobile app

```bash
cd mobile
flutter pub get
flutter run                 # on a connected device/emulator
```

Enter your relay URL and room on the connect screen, then send/receive files
to/from the desktop app.

---

## Security model

- **Confidentiality & integrity:** AES-256-GCM (authenticated encryption) on every
  data-channel message. Tampered or truncated frames fail to decrypt and are
  dropped; completed transfers are SHA-256-verified end to end.
- **Key agreement:** ephemeral ECDH on the NIST P-256 curve, per pairing session,
  with keys derived via HKDF-SHA-256 bound to a protocol-specific info string.
- **What the relay learns:** presence (who is in a room), display names, and the
  opaque SDP/ICE handshake — including the peers' *public* keys. It **cannot**
  derive the session secret and never receives file bytes.
- **Trust bootstrapping:** for the strongest guarantees, run your own relay on a
  network you control. The relay code is small enough to audit in a sitting.

> LanTransfer is a genuinely working reference implementation of private P2P
> transfer. As with any crypto system, review the code before trusting it with
> high-stakes data.

---

## Tech stack

- **Desktop:** Electron 33, React 18, TypeScript 5, Vite / electron-vite, Vitest.
- **Relay:** Go 1.22, `gorilla/websocket`.
- **Mobile:** Flutter 3, Dart 3, `flutter_webrtc`, `web_socket_channel`,
  `cryptography` (pure-Dart ECDH + AES-GCM), `file_picker`, `path_provider`.
- **CI:** GitHub Actions — type-checks/tests/builds the desktop app, vets/tests/
  builds the Go relay, and analyzes/tests the Flutter client on every push.

## Development & tests

```bash
# Desktop
cd desktop && npm test          # crypto round-trip + full E2E transfer engine test

# Relay
cd relay && go test ./...       # hub routing + room presence tests

# Mobile
cd mobile && flutter test       # SHA-256 vectors, base64url, protocol round-trips
```

The desktop suite includes an **end-to-end test** that wires two `PeerSession`s
through in-memory fake WebRTC connections and transfers a 200 KB payload through
the real encryption + chunking + checksum path — no browser or relay required.

## License

[MIT](LICENSE) © 2026 xj16
