# LanTransfer Relay

A tiny, self-hostable WebRTC **signaling** relay written in Go. It brokers the
peer handshake (offer/answer/ICE) and room presence so LanTransfer clients can
open a **direct, end-to-end-encrypted** data channel. **File bytes never pass
through this server** — it only sees presence and opaque SDP/ICE.

## Run

```bash
# From source
go run ./cmd/relay -addr :8080

# Or build a single static binary and run it anywhere
go build -o lantransfer-relay ./cmd/relay
./lantransfer-relay -addr :8080
```

Environment variables (flags take precedence):

| Var                   | Default | Meaning                                          |
|-----------------------|---------|--------------------------------------------------|
| `LANTRANSFER_ADDR`    | `:8080` | Listen address                                   |
| `LANTRANSFER_ORIGIN`  | *(any)* | Restrict the WebSocket `Origin` header if set    |

Endpoints:

- `GET /ws` — WebSocket signaling endpoint (clients connect here).
- `GET /health` — liveness probe → `{"status":"ok","service":"lantransfer-relay"}`.

## Docker

```bash
docker build -t lantransfer-relay .
docker run -p 8080:8080 lantransfer-relay
```

## How routing works

- A client sends `hello` (with protocol version) then `join` to enter a room.
- The relay announces existing peers to the newcomer and vice versa.
- `offer` / `answer` / `ice` messages carry a `to` peer id and are forwarded
  verbatim to that peer in the same room. Unknown targets are dropped.
- A slow client whose outbound buffer fills is dropped rather than stalling the
  hub — the relay stays responsive under load.

See [`internal/signaling`](internal/signaling) for the hub, protocol, and the
WebSocket server. Tests: `go test ./...`.
