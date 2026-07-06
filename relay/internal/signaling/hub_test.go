package signaling

import "testing"

func TestJoinAnnouncesExistingPeers(t *testing.T) {
	h := NewHub()
	alice := newClient("alice", "Alice", PlatformDesktop)
	bob := newClient("bob", "Bob", PlatformMobile)

	h.Join(alice, "room1")
	if got := h.RoomSize("room1"); got != 1 {
		t.Fatalf("room size after alice = %d, want 1", got)
	}

	h.Join(bob, "room1")
	if got := h.RoomSize("room1"); got != 2 {
		t.Fatalf("room size after bob = %d, want 2", got)
	}

	// Alice should have been told a peer joined (bob).
	select {
	case m := <-alice.Outbound():
		if m.T != TPeerJoined || m.PeerID != "bob" {
			t.Fatalf("alice got %+v, want peer-joined bob", m)
		}
	default:
		t.Fatal("alice did not receive peer-joined for bob")
	}

	// Bob should have been told about the pre-existing peer (alice).
	select {
	case m := <-bob.Outbound():
		if m.T != TPeerJoined || m.PeerID != "alice" {
			t.Fatalf("bob got %+v, want peer-joined alice", m)
		}
	default:
		t.Fatal("bob did not receive peer-joined for alice")
	}
}

func TestRouteDeliversToTarget(t *testing.T) {
	h := NewHub()
	alice := newClient("alice", "Alice", PlatformDesktop)
	bob := newClient("bob", "Bob", PlatformDesktop)
	h.Join(alice, "r")
	h.Join(bob, "r")
	drain(alice)
	drain(bob)

	h.Route(alice, Message{T: TOffer, To: "bob", SDP: "sdp-blob"})

	select {
	case m := <-bob.Outbound():
		if m.T != TOffer || m.SDP != "sdp-blob" || m.From != "alice" {
			t.Fatalf("bob got %+v, want offer from alice", m)
		}
	default:
		t.Fatal("offer was not routed to bob")
	}
}

func TestRouteToUnknownPeerIsDropped(t *testing.T) {
	h := NewHub()
	alice := newClient("alice", "Alice", PlatformDesktop)
	h.Join(alice, "r")
	drain(alice)

	// Should not panic and should not deliver anywhere.
	h.Route(alice, Message{T: TOffer, To: "ghost", SDP: "x"})
}

func TestLeaveNotifiesRoom(t *testing.T) {
	h := NewHub()
	alice := newClient("alice", "Alice", PlatformDesktop)
	bob := newClient("bob", "Bob", PlatformDesktop)
	h.Join(alice, "r")
	h.Join(bob, "r")
	drain(alice)
	drain(bob)

	h.Leave(bob)
	if got := h.RoomSize("r"); got != 1 {
		t.Fatalf("room size after leave = %d, want 1", got)
	}
	select {
	case m := <-alice.Outbound():
		if m.T != TPeerLeft || m.PeerID != "bob" {
			t.Fatalf("alice got %+v, want peer-left bob", m)
		}
	default:
		t.Fatal("alice was not notified of bob leaving")
	}
}

func drain(c *Client) {
	for {
		select {
		case <-c.Outbound():
		default:
			return
		}
	}
}
