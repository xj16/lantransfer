# LanTransfer Web

The browser client — encrypted P2P file sharing straight from a tab — and the
project's **live, server-free demo**.

## Why it exists

WebRTC is browser-native and the shared protocol already reserved a
`Platform='web'` value, so a browser is a first-class LanTransfer client. This
package reuses the desktop's **runtime-agnostic** modules verbatim via the
`@shared` build alias:

- [`crypto.ts`](../desktop/src/shared/crypto.ts) — ECDH → HKDF → AES-256-GCM, SAS
- [`peer.ts`](../desktop/src/shared/peer.ts) — the PeerSession state machine
- [`protocol.ts`](../desktop/src/shared/protocol.ts) — the wire protocol + binary frames
- [`relayClient.ts`](../desktop/src/shared/relayClient.ts) — the reconnecting relay socket

There is no fork of the security-critical code: the browser runs the exact same
bytes as the desktop app.

## Two transports

| Mode            | How to enter            | Signaling                         |
|-----------------|-------------------------|-----------------------------------|
| **Relay**       | default                 | WebSocket to a Go relay           |
| **Demo (loop)** | `?demo=1` in the URL    | `BroadcastChannel` between tabs   |

In demo mode there is **no server at all** — two tabs on the same origin
discover each other over a `BroadcastChannel` and transfer a real file through
the real ECDH + AES-256-GCM + chunking path. That is what makes the portfolio
demo genuinely functional rather than a mockup.

Query parameters: `?demo=1`, `?relay=ws://host:8080/ws`, `?room=lan`, `?name=Me`.

## Develop

```bash
npm install
npm run dev          # open the printed URL with ?demo=1 in two tabs
npm test             # loopback signaling transport tests
npm run build        # standalone static bundle in dist/ (relative asset paths)
```

The build emits relative (`./assets/...`) URLs, so `dist/` is a truly standalone
static site — embeddable under any path, in an iframe, or opened via `file://`.
CI publishes it to GitHub Pages.
