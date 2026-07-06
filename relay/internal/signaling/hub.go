package signaling

import (
	"log"
	"sync"
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

// Hub tracks rooms and routes signaling messages between peers. It is safe for
// concurrent use: all state mutations go through the mutex.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*Client // room -> peerId -> client
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[string]*Client)}
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
// newcomer about everyone already there. Returns the joined client.
func (h *Hub) Join(c *Client, room string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	c.Room = room
	members, ok := h.rooms[room]
	if !ok {
		members = make(map[string]*Client)
		h.rooms[room] = members
	}

	// Tell the newcomer about existing peers, and existing peers about them.
	for _, other := range members {
		c.Send(Message{T: TPeerJoined, PeerID: other.PeerID, Name: other.Name, Platform: other.Platform})
		other.Send(Message{T: TPeerJoined, PeerID: c.PeerID, Name: c.Name, Platform: c.Platform})
	}

	members[c.PeerID] = c
	log.Printf("peer %q (%s) joined room %q — %d present", c.PeerID, c.Platform, room, len(members))
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
}

// RoomSize reports how many peers are in a room (used by tests and /health).
func (h *Hub) RoomSize(room string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[room])
}
