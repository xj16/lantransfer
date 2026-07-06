package signaling

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// Server wraps a Hub and serves the WebSocket signaling endpoint plus a small
// health check. It self-hosts anywhere: a single static binary, no database.
type Server struct {
	hub      *Hub
	upgrader websocket.Upgrader
}

// NewServer builds a signaling server. allowedOrigin, when non-empty, restricts
// the WebSocket Origin header; empty allows any origin (fine for a LAN relay).
func NewServer(allowedOrigin string) *Server {
	return &Server{
		hub: NewHub(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				if allowedOrigin == "" {
					return true
				}
				return r.Header.Get("Origin") == allowedOrigin
			},
		},
	}
}

// Handler returns an http.Handler mounting /ws and /health.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"lantransfer-relay"}`))
	})
	return mux
}

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	var client *Client
	done := make(chan struct{})

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
		close(done)
		if client != nil {
			s.hub.Leave(client)
		}
		_ = conn.Close()
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
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
			client = newClient(m.PeerID, m.Name, m.Platform)
			startWriter(client)
			client.Send(Message{T: TWelcome, PeerID: m.PeerID})

		case TJoin:
			if client == nil {
				continue
			}
			s.hub.Join(client, m.Room)

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

// Hub exposes the underlying hub (used by tests).
func (s *Server) Hub() *Hub { return s.hub }
