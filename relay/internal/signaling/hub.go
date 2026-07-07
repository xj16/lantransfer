package signaling

import (
	"log"
	"sync"
	"sync/atomic"
)

// Client is a single connected peer. The transport (a WebSocket) delivers
// inbound messages to the Hub and exposes an outbound channel the Hub writes to.
type Client struct {
	PeerID   string
	Name     string
	Platform Platform
	Room     string

	// out is buffered; a slow client that fills it is dropped rather than
	// blocking the whole hub.
	out chan Message
}

// Send queues a message to the client, returning false if its buffer is full.
func (c *Client) Send(m Message) bool {
	select {
	case c.out <- m:
		return true
	default:
		return false
	}
}

// Outbound exposes the client's write channel for the transport to drain.
func (c *Client) Outbound() <-chan Message { return c.out }

// Metrics is a point-in-time snapshot of hub activity, exposed at /metrics.
type Metrics struct {
	Rooms          int
	Peers          int
	MessagesRouted uint64
	JoinsTotal     uint64
	RoomsRejected  uint64
}

// Hub tracks rooms and routes signaling messages between peers. It is safe for
// concurrent use: all state mutations go through the mutex.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*Client // room -> peerId -> client

	// maxPeersPerRoom caps how many peers may share a room (0 = unlimited), so
	// a public relay can't be trivially fanned out. Set via NewHubWithLimits.
	maxPeersPerRoom int

	messagesRouted atomic.Uint64
	joinsTotal     atomic.Uint64
	roomsRejected  atomic.Uint64
}

// NewHub creates an empty hub with no per-room cap.
func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[string]*Client)}
}

// NewHubWithLimits creates a hub that rejects joins beyond maxPeersPerRoom
// (0 disables the cap).
func NewHubWithLimits(maxPeersPerRoom int) *Hub {
	return &Hub{
		rooms:           make(map[string]map[string]*Client),
		maxPeersPerRoom: maxPeersPerRoom,
	}
}

// Metrics returns a snapshot of current hub activity.
func (h *Hub) Metrics() Metrics {
	h.mu.RLock()
	rooms := len(h.rooms)
	peers := 0
	for _, m := range h.rooms {
		peers += len(m)
	}
	h.mu.RUnlock()
	return Metrics{
		Rooms:          rooms,
		Peers:          peers,
		MessagesRouted: h.messagesRouted.Load(),
		JoinsTotal:     h.joinsTotal.Load(),
		RoomsRejected:  h.roomsRejected.Load(),
	}
}

// Register a freshly-created client (before it has joined a room).
func newClient(peerID, name string, platform Platform) *Client {
	return &Client{
		PeerID:   peerID,
		Name:     name,
		Platform: platform,
		out:      make(chan Message, 64),
	}
}

// Join adds a client to a room, announces it to existing members, and tells the
// newcomer about everyone already there. It returns false (and sends an error
// to the client) when the room is full under the configured per-room cap.
func (h *Hub) Join(c *Client, room string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	members, ok := h.rooms[room]
	if !ok {
		members = make(map[string]*Client)
		h.rooms[room] = members
	}

	// Enforce the per-room cap (an existing member re-joining doesn't count).
	if h.maxPeersPerRoom > 0 {
		if _, already := members[c.PeerID]; !already && len(members) >= h.maxPeersPerRoom {
			if len(members) == 0 {
				delete(h.rooms, room)
			}
			h.roomsRejected.Add(1)
			c.Send(Message{T: TError, Code: "room-full", Message: "room is full"})
			log.Printf("peer %q rejected from full room %q (cap %d)", c.PeerID, room, h.maxPeersPerRoom)
			return false
		}
	}

	c.Room = room

	// Tell the newcomer about existing peers, and existing peers about them.
	for _, other := range members {
		c.Send(Message{T: TPeerJoined, PeerID: other.PeerID, Name: other.Name, Platform: other.Platform})
		other.Send(Message{T: TPeerJoined, PeerID: c.PeerID, Name: c.Name, Platform: c.Platform})
	}

	members[c.PeerID] = c
	h.joinsTotal.Add(1)
	log.Printf("peer %q (%s) joined room %q — %d present", c.PeerID, c.Platform, room, len(members))
	return true
}

// Leave removes a client and notifies the rest of the room.
func (h *Hub) Leave(c *Client) {
	if c.Room == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	members, ok := h.rooms[c.Room]
	if !ok {
		return
	}
	delete(members, c.PeerID)
	for _, other := range members {
		other.Send(Message{T: TPeerLeft, PeerID: c.PeerID})
	}
	if len(members) == 0 {
		delete(h.rooms, c.Room)
	}
	log.Printf("peer %q left room %q — %d present", c.PeerID, c.Room, len(members))
}

// Route forwards a directed message (offer/answer/ice) to its target peer in
// the sender's room. Undeliverable messages are dropped silently.
func (h *Hub) Route(from *Client, m Message) {
	if m.To == "" {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()

	members, ok := h.rooms[from.Room]
	if !ok {
		return
	}
	target, ok := members[m.To]
	if !ok {
		return
	}
	m.From = from.PeerID
	target.Send(m)
	h.messagesRouted.Add(1)
}

// RoomSize reports how many peers are in a room (used by tests and /health).
func (h *Hub) RoomSize(room string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[room])
}
