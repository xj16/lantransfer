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
	"syscall"
	"time"

	"github.com/xj16/lantransfer/relay/internal/signaling"
)

func main() {
	addr := flag.String("addr", envOr("LANTRANSFER_ADDR", ":8080"), "listen address")
	origin := flag.String("origin", os.Getenv("LANTRANSFER_ORIGIN"), "allowed WebSocket Origin (empty = any)")
	flag.Parse()

	srv := signaling.NewServer(*origin)
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
