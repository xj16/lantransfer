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

| Var                                | Flag                    | Default | Meaning                                          |
|------------------------------------|-------------------------|---------|--------------------------------------------------|
| `LANTRANSFER_ADDR`                 | `-addr`                 | `:8080` | Listen address                                   |
| `LANTRANSFER_ORIGIN`               | `-origin`               | *(any)* | Restrict the WebSocket `Origin` header if set    |
| `LANTRANSFER_MAX_CONNS_PER_IP`     | `-max-conns-per-ip`     | `32`    | Max concurrent connections per client IP (0=off) |
| `LANTRANSFER_MAX_MSGS_PER_SEC`     | `-max-msgs-per-sec`     | `40`    | Per-connection inbound message rate (0=off)      |
| `LANTRANSFER_MAX_PEERS_PER_ROOM`   | `-max-peers-per-room`   | `16`    | Max peers sharing a room (0=off)                 |
| `LANTRANSFER_MAX_MSG_BYTES`        | `-max-msg-bytes`        | `65536` | Max inbound WebSocket frame size (0=library dflt)|

Endpoints:

- `GET /ws` — WebSocket signaling endpoint (clients connect here).
- `GET /health` — liveness probe → `{"status":"ok","service":"lantransfer-relay"}`.
- `GET /metrics` — Prometheus text exposition of `lantransfer_rooms`,
  `lantransfer_peers`, `lantransfer_messages_routed_total`,
  `lantransfer_joins_total`, and `lantransfer_rooms_rejected_total`.

## Hardening

A public relay is a shared, untrusted surface. The defaults above cap
per-IP connections, per-connection message rate (a token bucket sized for a
normal handshake), inbound frame size, and room occupancy, so a single client
can't fan out rooms or flood the hub. When fronted by a TLS proxy that sets
`X-Forwarded-For` (see the repo's `docker compose --profile tls`), the relay
uses the forwarded client IP for its per-IP limits.

## Docker

```bash
docker build -t lantransfer-relay .
docker run -p 8080:8080 lantransfer-relay

# Or, from the repo root, one command (optionally with a TLS front):
docker compose up -d
RELAY_DOMAIN=relay.example.com docker compose --profile tls up -d
```

## How routing works

- A client sends `hello` (with protocol version) then `join` to enter a room.
- The relay announces existing peers to the newcomer and vice versa.
- `offer` / `answer` / `ice` messages carry a `to` peer id and are forwarded
  verbatim to that peer in the same room. Unknown targets are dropped.
- A slow client whose outbound buffer fills is dropped rather than stalling the
  hub — the relay stays responsive under load.
- A join beyond the per-room cap is rejected with a `room-full` error rather
  than admitted.

See [`internal/signaling`](internal/signaling) for the hub, protocol, and the
WebSocket server. Tests: `go test ./...`.
