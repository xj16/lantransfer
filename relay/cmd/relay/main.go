// Command relay runs the LanTransfer signaling relay.
//
// It brokers the WebRTC handshake between peers so they can establish a direct,
// end-to-end-encrypted data channel. File bytes never traverse this server — it
// only sees presence and opaque SDP/ICE. Self-host it on any machine reachable
// by your devices (a LAN box, a small VPS); no cloud service required.
//
// Usage:
//
//	relay -addr :8080
//	LANTRANSFER_ADDR=:9000 relay
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/xj16/lantransfer/relay/internal/signaling"
)

func main() {
	addr := flag.String("addr", envOr("LANTRANSFER_ADDR", ":8080"), "listen address")
	origin := flag.String("origin", os.Getenv("LANTRANSFER_ORIGIN"), "allowed WebSocket Origin (empty = any)")
	maxConns := flag.Int("max-conns-per-ip", envInt("LANTRANSFER_MAX_CONNS_PER_IP", 32), "max concurrent connections per client IP (0 = unlimited)")
	maxRate := flag.Int("max-msgs-per-sec", envInt("LANTRANSFER_MAX_MSGS_PER_SEC", 40), "max inbound messages/sec per connection (0 = unlimited)")
	maxRoom := flag.Int("max-peers-per-room", envInt("LANTRANSFER_MAX_PEERS_PER_ROOM", 16), "max peers per room (0 = unlimited)")
	maxMsgBytes := flag.Int("max-msg-bytes", envInt("LANTRANSFER_MAX_MSG_BYTES", 64*1024), "max inbound message size in bytes (0 = library default)")
	flag.Parse()

	cfg := signaling.Config{
		AllowedOrigin:        *origin,
		MaxMessageBytes:      int64(*maxMsgBytes),
		MaxConnsPerIP:        *maxConns,
		MaxMsgsPerSecPerConn: *maxRate,
		MaxPeersPerRoom:      *maxRoom,
	}
	srv := signaling.NewServerWithConfig(cfg)
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("LanTransfer relay listening on %s (ws://…/ws)", *addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown on SIGINT/SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down…")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
