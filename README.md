<h1 align="center">LanTransfer</h1>

<p align="center">
  <strong>Encrypted P2P file sharing across any OS — AirDrop for everyone.</strong>
</p>

<p align="center">
  <a href="https://github.com/xj16/lantransfer/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xj16/lantransfer/actions/workflows/ci.yml/badge.svg"></a>
  <a href="web/"><img alt="Live demo" src="https://img.shields.io/badge/demo-open%20two%20tabs-4f8cff"></a>
  <img alt="Coverage" src="https://img.shields.io/badge/shared%20core%20coverage-~87%25-3fb950">
  <img alt="Protocol" src="https://img.shields.io/badge/protocol-v2-blueviolet">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-informational"></a>
</p>

LanTransfer sends files **directly between your devices** over the local network
(or the wider internet via WebRTC) with **no cloud, no accounts, and no upload
to anyone's server**. Every byte is **end-to-end encrypted** on a direct
peer-to-peer channel; a tiny self-hostable relay only helps devices find each
other and never sees a single byte of your data.

Think AirDrop, but it works between Windows, macOS, Linux, Android, iOS, **and
any browser** — and you own the whole stack: an Electron desktop app, a Flutter
mobile app, a browser client, and a Go relay, all speaking one wire protocol.

> **▶ Try it in 30 seconds, no server:** `cd web && npm install && npm run dev`,
> then open the printed URL with **`?demo=1` in two browser tabs** and send a
> file between them. Signaling runs over a `BroadcastChannel` between the tabs,
> so a **real file** flows through the **real ECDH + AES-256-GCM + chunking
> path** with no relay at all. (Enable GitHub Pages and run the *Deploy web demo*
> workflow to host it publicly.)

---

## Features

- **No cloud.** Bytes flow device-to-device over a WebRTC data channel; the
  relay only brokers *public* keys and opaque SDP/ICE.
- **End-to-end encrypted.** AES-256-GCM with a fresh 96-bit nonce per message,
  keyed by an ephemeral ECDH (P-256) → HKDF-SHA-256 handshake.
- **MITM-resistant.** A **Short Authentication String** (4 emoji + 6 digits)
  derived from both public keys lets you confirm out-of-band that no relay
  swapped the keys — the one attack the handshake alone can't stop.
- **Verified cross-platform.** A shared interop test proves a Dart-sealed frame
  decrypts under the TypeScript `open()` (and vice versa) on every CI run — the
  "a phone pairs with a laptop" claim is checked, not just asserted.
- **Fast wire format.** Protocol v2 sends file chunks as compact **binary**
  data-channel frames instead of double-base64 JSON, cutting ~2× inflation and a
  JSON round-trip per chunk on the hot path.
- **Four clients, one protocol.** Electron desktop, Flutter mobile, a browser
  client, and a Go relay — with a single source of truth for crypto + protocol.
- **Self-hostable & free.** The relay is one static Go binary (or a one-command
  `docker compose up`). Run it on a Raspberry Pi, a spare box, or a $5 VPS.
- **Hardened relay.** Per-IP connection caps, per-connection message-rate
  limiting, max message size, room-occupancy caps, and a Prometheus `/metrics`
  endpoint — so a public relay can't be trivially abused.

---

## Architecture

```
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│  Desktop app   │      │   Web client   │      │   Mobile app   │
│ Electron+React │      │  React (tab)   │      │  Flutter+Dart  │
└───────┬────────┘      └───────┬────────┘      └───────┬────────┘
        │        signaling (offer/answer/ICE + public keys)       │
        └───────────────────────► Go relay ◄─────────────────────┘
                          (presence + WebRTC handshake only)
        │                                                         │
        └──────── encrypted WebRTC data channel (direct P2P) ─────┘
                  AES-256-GCM · files never touch the relay
```

**The relay is deliberately dumb.** It tracks who is in a "room" and forwards
the WebRTC handshake between peers. Once the data channel opens, the relay is
out of the loop entirely — chunks travel directly between devices, encrypted
with a key only the two peers possess.

The desktop, web, and mobile clients share **one wire protocol**
([`desktop/src/shared/protocol.ts`](desktop/src/shared/protocol.ts) and its Dart
mirror [`mobile/lib/src/protocol.dart`](mobile/lib/src/protocol.dart)). The web
client goes further and imports the desktop's `crypto.ts` / `peer.ts` /
`protocol.ts` **verbatim** via a build alias, so there is a single source of
truth for the security-critical code.

### The transfer protocol

1. **Pair.** Peers join a room and exchange an SDP offer/answer. The ephemeral
   ECDH public key is piggybacked on the SDP (`a=x-lantransfer-key`).
2. **Key.** Each side runs ECDH → HKDF-SHA-256 → an identical AES-256-GCM
   session key, derived independently, never transmitted.
3. **Verify (optional but recommended).** Both peers compute the same Short
   Authentication String from the two public keys. Comparing it out-of-band
   rules out a key-swapping relay.
4. **Offer & accept.** The sender emits an encrypted `offer-file`; the receiver
   confirms and the UI prompts the user.
5. **Stream.** The file is split into 64 KiB chunks, each sealed with a fresh
   nonce and sent as a **binary** data-channel frame (protocol v2) with
   backpressure control.
6. **Verify integrity.** On completion the receiver recomputes SHA-256 and
   rejects the file on any mismatch — protecting against corruption *and*
   tampering.

---

## Repository layout

| Path        | Stack                              | What it is                                        |
|-------------|------------------------------------|---------------------------------------------------|
| `desktop/`  | Electron · React · TypeScript      | **Flagship** desktop app (Win/macOS/Linux)        |
| `web/`      | React · TypeScript · Vite          | Browser client + the standalone live demo         |
| `relay/`    | Go · gorilla/websocket             | Self-hostable, hardened signaling relay           |
| `mobile/`   | Flutter · Dart                     | Android/iOS client sharing the same protocol      |
| `shared/`   | JSON vectors                       | Cross-platform crypto interop fixtures            |

---

## Quick start

### Try the demo (no server needed)

```bash
cd web
npm install
npm run dev        # then open the printed URL with ?demo=1 in two tabs
```

To host it publicly: enable **Settings → Pages → GitHub Actions**, then run the
**Deploy web demo to Pages** workflow — it publishes the standalone bundle.

### Run the relay

```bash
# One command with Docker (LAN):
docker compose up -d          # ws://localhost:8080/ws

# …or from source:
cd relay
go run ./cmd/relay            # listens on :8080

# Public wss:// with automatic HTTPS (needs a domain pointed at the host):
RELAY_DOMAIN=relay.example.com docker compose --profile tls up -d
```

Health: `curl http://localhost:8080/health` · Metrics: `curl http://localhost:8080/metrics`.

### Run the desktop app

```bash
cd desktop
npm install
npm run dev                   # launches Electron with hot reload
```

Open **Settings**, point **Relay URL** at your relay (`ws://<host>:8080/ws`).
Devices sharing the same relay URL **and** room discover each other
automatically.

### Run the mobile app

```bash
cd mobile
flutter pub get
flutter run
```

---

## Security model

- **Confidentiality & integrity:** AES-256-GCM (authenticated encryption) on
  every data-channel message. Tampered or truncated frames fail to decrypt and
  are dropped; completed transfers are SHA-256-verified end to end.
- **Key agreement:** ephemeral ECDH on NIST P-256 per pairing session, derived
  via HKDF-SHA-256 bound to a protocol-specific info string.
- **Active attacker (a malicious/compromised relay):** because the ECDH public
  keys ride through the relay inside the SDP, a hostile relay could in principle
  swap both keys to sit in the middle. LanTransfer defends against this with a
  **Short Authentication String** — a 4-emoji + 6-digit fingerprint derived from
  both public keys, which **diverges** across the two peers if the keys were
  swapped. Compare it out-of-band (say it aloud, glance at both screens) to get
  a real, demonstrable guarantee. Best of all: **run your own relay.**
- **What the relay learns:** presence, display names, and the opaque SDP/ICE
  handshake — including the peers' *public* keys. It **cannot** derive the
  session secret and never receives file bytes.

> LanTransfer is a genuinely working reference implementation of private P2P
> transfer. As with any crypto system, review the code before trusting it with
> high-stakes data.

---

## Tech stack

- **Desktop:** Electron 33, React 18, TypeScript 5, electron-vite, Vitest (+ v8 coverage).
- **Web:** React 18, TypeScript 5, Vite — reuses the desktop shared core verbatim.
- **Relay:** Go 1.22, `gorilla/websocket`; Docker + Caddy for one-command TLS.
- **Mobile:** Flutter 3, Dart 3, `flutter_webrtc`, `cryptography` (pure-Dart ECDH + AES-GCM).
- **CI:** GitHub Actions type-checks/tests/builds all four components on every
  push, runs the cross-platform interop test, and publishes the static demo to
  Pages.

## Development & tests

```bash
cd desktop && npm run test:coverage   # crypto, protocol, relay client, E2E transfer, interop, SAS/MITM
cd web     && npm test                # loopback signaling transport
cd relay   && go test ./...           # hub routing, rate limiter, room caps, /metrics
cd mobile  && flutter test            # SHA-256 vectors, protocol, SAS, binary frames, interop
```

The desktop suite includes an **end-to-end test** that wires two `PeerSession`s
through in-memory fake WebRTC connections and transfers a 200 KB payload through
the real encryption + binary-framing + checksum path — and asserts the SAS
matches, that chunks travelled as binary v2 frames, and that a simulated
key-swapping relay makes the SAS diverge.

## License

[MIT](LICENSE) © 2026 xj16
