// Package signaling implements the LanTransfer WebRTC signaling relay.
//
// The relay is deliberately dumb: it tracks which peers are present in a room
// and forwards handshake messages (offer/answer/ICE) between them. It never
// sees file bytes and cannot read the end-to-end-encrypted data channel — only
// the peers hold the derived session key. This mirrors the TypeScript protocol
// in desktop/src/shared/protocol.ts.
package signaling

import "encoding/json"

// ProtocolVersion must match PROTOCOL_VERSION on the clients.
const ProtocolVersion = 1

// Platform identifies the kind of peer that connected.
type Platform string

const (
	PlatformDesktop Platform = "desktop"
	PlatformMobile  Platform = "mobile"
	PlatformWeb     Platform = "web"
	PlatformRelay   Platform = "relay"
)

// Message is the JSON envelope exchanged over the WebSocket. Only the fields
// relevant to a given "t" are populated; the rest stay at their zero value and
// are omitted on the wire.
type Message struct {
	T string `json:"t"`

	// hello
	V        int      `json:"v,omitempty"`
	PeerID   string   `json:"peerId,omitempty"`
	Name     string   `json:"name,omitempty"`
	Platform Platform `json:"platform,omitempty"`

	// welcome / join / peer-joined / peer-left
	Room string `json:"room,omitempty"`

	// offer / answer / ice routing
	To   string `json:"to,omitempty"`
	From string `json:"from,omitempty"`
	SDP  string `json:"sdp,omitempty"`

	// ice candidate (opaque to the relay — passed straight through)
	Candidate json.RawMessage `json:"candidate,omitempty"`

	// error
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// Message type tags.
const (
	THello      = "hello"
	TWelcome    = "welcome"
	TJoin       = "join"
	TPeerJoined = "peer-joined"
	TPeerLeft   = "peer-left"
	TOffer      = "offer"
	TAnswer     = "answer"
	TICE        = "ice"
	TError      = "error"
)
