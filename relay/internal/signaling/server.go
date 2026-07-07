package signaling

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Config tunes the relay's hardening knobs. The zero value is safe and permissive
// (fine for a trusted LAN); tighten it when exposing the relay to the internet.
type Config struct {
	// AllowedOrigin, when non-empty, restricts the WebSocket Origin header.
	AllowedOrigin string
	// MaxMessageBytes caps a single inbound WebSocket frame (0 = library default).
	MaxMessageBytes int64
	// MaxConnsPerIP caps concurrent connections from one client IP (0 = unlimited).
	MaxConnsPerIP int
	// MaxMsgsPerSecPerConn rate-limits inbound messages per connection via a
	// token bucket (0 = unlimited).
	MaxMsgsPerSecPerConn int
	// MaxPeersPerRoom caps peers sharing a room (0 = unlimited).
	MaxPeersPerRoom int
}

// DefaultConfig returns sensible limits for a public-facing relay.
func DefaultConfig() Config {
	return Config{
		MaxMessageBytes:      64 * 1024, // SDP/ICE are small; 64 KiB is plenty
		MaxConnsPerIP:        32,
		MaxMsgsPerSecPerConn: 40,
		MaxPeersPerRoom:      16,
	}
}

// Server wraps a Hub and serves the WebSocket signaling endpoint plus health
// and metrics. It self-hosts anywhere: a single static binary, no database.
type Server struct {
	hub      *Hub
	cfg      Config
	upgrader websocket.Upgrader

	mu       sync.Mutex
	connsPer map[string]int // client IP -> active connection count
}

// NewServer builds a signaling server. allowedOrigin, when non-empty, restricts
// the WebSocket Origin header; empty allows any origin (fine for a LAN relay).
// It uses DefaultConfig() hardening limits.
func NewServer(allowedOrigin string) *Server {
	cfg := DefaultConfig()
	cfg.AllowedOrigin = allowedOrigin
	return NewServerWithConfig(cfg)
}

// NewServerWithConfig builds a signaling server with explicit hardening limits.
func NewServerWithConfig(cfg Config) *Server {
	return &Server{
		hub:      NewHubWithLimits(cfg.MaxPeersPerRoom),
		cfg:      cfg,
		connsPer: make(map[string]int),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				if cfg.AllowedOrigin == "" {
					return true
				}
				return r.Header.Get("Origin") == cfg.AllowedOrigin
			},
		},
	}
}

// Handler returns an http.Handler mounting /ws, /health, and /metrics.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"lantransfer-relay"}`))
	})
	mux.HandleFunc("/metrics", s.handleMetrics)
	return mux
}

// handleMetrics exposes hub activity in Prometheus text exposition format, so a
// public relay is observable (rooms, peers, messages routed) with no dependency.
func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	m := s.hub.Metrics()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "# HELP lantransfer_rooms Current number of active rooms.\n")
	fmt.Fprintf(w, "# TYPE lantransfer_rooms gauge\nlantransfer_rooms %d\n", m.Rooms)
	fmt.Fprintf(w, "# HELP lantransfer_peers Current number of connected peers.\n")
	fmt.Fprintf(w, "# TYPE lantransfer_peers gauge\nlantransfer_peers %d\n", m.Peers)
	fmt.Fprintf(w, "# HELP lantransfer_messages_routed_total Signaling messages routed between peers.\n")
	fmt.Fprintf(w, "# TYPE lantransfer_messages_routed_total counter\nlantransfer_messages_routed_total %d\n", m.MessagesRouted)
	fmt.Fprintf(w, "# HELP lantransfer_joins_total Total successful room joins.\n")
	fmt.Fprintf(w, "# TYPE lantransfer_joins_total counter\nlantransfer_joins_total %d\n", m.JoinsTotal)
	fmt.Fprintf(w, "# HELP lantransfer_rooms_rejected_total Joins rejected because a room was full.\n")
	fmt.Fprintf(w, "# TYPE lantransfer_rooms_rejected_total counter\nlantransfer_rooms_rejected_total %d\n", m.RoomsRejected)
}

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)

	// Per-IP connection cap, checked before the (relatively expensive) upgrade.
	if !s.acquireConn(ip) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	releaseOnce := sync.Once{}
	release := func() { releaseOnce.Do(func() { s.releaseConn(ip) }) }
	defer release()

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	if s.cfg.MaxMessageBytes > 0 {
		conn.SetReadLimit(s.cfg.MaxMessageBytes)
	}

	var client *Client
	done := make(chan struct{})
	var closed atomic.Bool

	// Writer goroutine: drains the client's outbound channel + sends pings.
	startWriter := func(c *Client) {
		go func() {
			ticker := time.NewTicker(pingPeriod)
			defer ticker.Stop()
			for {
				select {
				case msg, ok := <-c.Outbound():
					_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
					if !ok {
						_ = conn.WriteMessage(websocket.CloseMessage, nil)
						return
					}
					if err := conn.WriteJSON(msg); err != nil {
						return
					}
				case <-ticker.C:
					_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
					if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
						return
					}
				case <-done:
					return
				}
			}
		}()
	}

	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	defer func() {
		if closed.CompareAndSwap(false, true) {
			close(done)
		}
		if client != nil {
			s.hub.Leave(client)
		}
		_ = conn.Close()
	}()

	limiter := newRateLimiter(s.cfg.MaxMsgsPerSecPerConn)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}

		// Per-connection message-rate limit: drop the connection on abuse rather
		// than letting one client flood the hub.
		if !limiter.allow() {
			_ = conn.WriteJSON(Message{T: TError, Code: "rate-limited", Message: "message rate exceeded"})
			return
		}

		var m Message
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}

		switch m.T {
		case THello:
			if m.V != ProtocolVersion {
				_ = conn.WriteJSON(Message{T: TError, Code: "version", Message: "protocol version mismatch"})
				return
			}
			if client != nil {
				continue // ignore a duplicate hello
			}
			client = newClient(m.PeerID, m.Name, m.Platform)
			startWriter(client)
			client.Send(Message{T: TWelcome, PeerID: m.PeerID})

		case TJoin:
			if client == nil {
				continue
			}
			if !s.hub.Join(client, m.Room) {
				return // room full — the hub already told the client
			}

		case TOffer, TAnswer, TICE:
			if client == nil {
				continue
			}
			s.hub.Route(client, m)

		default:
			// Unknown message types are ignored so the relay stays
			// forward-compatible with newer client features.
		}
	}
}

func (s *Server) acquireConn(ip string) bool {
	if s.cfg.MaxConnsPerIP <= 0 {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connsPer[ip] >= s.cfg.MaxConnsPerIP {
		return false
	}
	s.connsPer[ip]++
	return true
}

func (s *Server) releaseConn(ip string) {
	if s.cfg.MaxConnsPerIP <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connsPer[ip] > 0 {
		s.connsPer[ip]--
	}
	if s.connsPer[ip] == 0 {
		delete(s.connsPer, ip)
	}
}

// clientIP extracts the best-effort client IP, honoring a single X-Forwarded-For
// hop (set by a trusted TLS front like Caddy) and falling back to RemoteAddr.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first entry (the original client).
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return trimSpace(xff[:i])
			}
		}
		return trimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && s[start] == ' ' {
		start++
	}
	for end > start && s[end-1] == ' ' {
		end--
	}
	return s[start:end]
}

// Hub exposes the underlying hub (used by tests).
func (s *Server) Hub() *Hub { return s.hub }
