# LanTransfer Mobile

The **Flutter + Dart** LanTransfer client for Android and iOS. It speaks the exact
same protocol and encryption as the desktop app, so a phone and a laptop transfer
files **directly, end-to-end encrypted**, with the relay only helping them find
each other.

## Run

```bash
flutter pub get
flutter run
```

On the connect screen, enter:

- **Display name** — how you appear to other devices.
- **Relay URL** — your relay, e.g. `ws://192.168.1.10:8080/ws`.
- **Room** — devices sharing the same room see each other.

## Structure

```
lib/
  main.dart                    Flutter UI: connect screen, device list, transfers,
                               incoming-file sheet.
  src/
    protocol.dart              Wire protocol (mirror of the desktop TypeScript).
    crypto.dart                base64url + a dependency-free SHA-256 for integrity.
    platform_crypto.dart       ECDH P-256 + HKDF + AES-256-GCM via `cryptography`,
                               emitting the same SPKI key + nonce||ct format as
                               desktop for true cross-platform interop.
    relay_client.dart          Reconnecting WebSocket signaling client.
    peer_session.dart          flutter_webrtc peer connection + data channel.
    transfer_engine.dart       Chunked, checksum-verified transfer state machine.
    app_controller.dart        ChangeNotifier tying relay + peers to the UI.
```

## Interoperability

The mobile client is byte-compatible with the desktop app:

- Public keys are exchanged as **SPKI-wrapped** uncompressed P-256 points — the
  same encoding `WebCrypto.exportKey('spki')` produces on desktop.
- Sealed messages use the identical **`nonce(12) || ciphertext || tag(16)`**,
  base64url layout.
- Chunking (64 KiB), the `offer/accept/chunk/complete` handshake, and the SHA-256
  completion check all match.

## Test

```bash
flutter test
```

Covers the base64url codec, known SHA-256 vectors (empty, `abc`, a multi-block
message), pairing-code / transfer-id shapes, and `ChannelMessage` JSON round-trips.
