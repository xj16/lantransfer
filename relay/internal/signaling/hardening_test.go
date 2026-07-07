package signaling

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRateLimiterTokenBucket(t *testing.T) {
	rl := newRateLimiter(10) // 10 msgs/sec, burst 10
	base := time.Unix(0, 0)
	rl.now = func() time.Time { return base }
	rl.last = base

	// The initial burst of 10 is allowed.
	for i := 0; i < 10; i++ {
		if !rl.allow() {
			t.Fatalf("burst message %d should be allowed", i)
		}
	}
	// The 11th within the same instant is denied.
	if rl.allow() {
		t.Fatal("message beyond the burst should be rate-limited")
	}

	// After 500ms, ~5 tokens have refilled.
	base = base.Add(500 * time.Millisecond)
	allowed := 0
	for i := 0; i < 10; i++ {
		if rl.allow() {
			allowed++
		}
	}
	if allowed < 4 || allowed > 6 {
		t.Fatalf("after 500ms expected ~5 tokens, got %d", allowed)
	}
}

func TestRateLimiterZeroDisables(t *testing.T) {
	rl := newRateLimiter(0)
	for i := 0; i < 1000; i++ {
		if !rl.allow() {
			t.Fatal("a zero rate must disable limiting")
		}
	}
}

func TestJoinEnforcesPerRoomCap(t *testing.T) {
	h := NewHubWithLimits(2)
	a := newClient("a", "A", PlatformDesktop)
	b := newClient("b", "B", PlatformDesktop)
	c := newClient("c", "C", PlatformDesktop)

	if !h.Join(a, "r") {
		t.Fatal("first join should succeed")
	}
	if !h.Join(b, "r") {
		t.Fatal("second join should succeed (at cap)")
	}
	if h.Join(c, "r") {
		t.Fatal("third join should be rejected by the cap")
	}
	if got := h.RoomSize("r"); got != 2 {
		t.Fatalf("room size = %d, want 2", got)
	}

	// The rejected client must have received a room-full error.
	select {
	case m := <-c.Outbound():
		if m.T != TError || m.Code != "room-full" {
			t.Fatalf("rejected client got %+v, want room-full error", m)
		}
	default:
		t.Fatal("rejected client was not sent a room-full error")
	}

	if h.Metrics().RoomsRejected != 1 {
		t.Fatalf("RoomsRejected = %d, want 1", h.Metrics().RoomsRejected)
	}
}

func TestReJoinDoesNotCountAgainstCap(t *testing.T) {
	h := NewHubWithLimits(1)
	a := newClient("a", "A", PlatformDesktop)
	if !h.Join(a, "r") {
		t.Fatal("first join should succeed")
	}
	// Same peer id re-joining the same room is not a new occupant.
	if !h.Join(a, "r") {
		t.Fatal("re-join by the same peer should be allowed at cap")
	}
}

func TestMetricsCountRoutedMessages(t *testing.T) {
	h := NewHub()
	a := newClient("a", "A", PlatformDesktop)
	b := newClient("b", "B", PlatformDesktop)
	h.Join(a, "r")
	h.Join(b, "r")
	drainHardening(a)
	drainHardening(b)

	h.Route(a, Message{T: TOffer, To: "b", SDP: "x"})
	h.Route(a, Message{T: TICE, To: "b"})
	h.Route(a, Message{T: TOffer, To: "ghost"}) // undeliverable, not counted

	m := h.Metrics()
	if m.MessagesRouted != 2 {
		t.Fatalf("MessagesRouted = %d, want 2", m.MessagesRouted)
	}
	if m.Rooms != 1 || m.Peers != 2 {
		t.Fatalf("Rooms=%d Peers=%d, want 1 and 2", m.Rooms, m.Peers)
	}
	if m.JoinsTotal != 2 {
		t.Fatalf("JoinsTotal = %d, want 2", m.JoinsTotal)
	}
}

func TestMetricsEndpointExposition(t *testing.T) {
	s := NewServer("")
	s.hub.Join(newClient("a", "A", PlatformDesktop), "r")

	rec := httptest.NewRecorder()
	s.handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	body := rec.Body.String()
	for _, want := range []string{
		"lantransfer_rooms 1",
		"lantransfer_peers 1",
		"lantransfer_messages_routed_total 0",
		"# TYPE lantransfer_peers gauge",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output missing %q\n%s", want, body)
		}
	}
}

func TestClientIPHonorsForwardedFor(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.RemoteAddr = "203.0.113.5:5555"
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 70.1.2.3")
	if got := clientIP(r); got != "198.51.100.7" {
		t.Fatalf("clientIP with XFF = %q, want 198.51.100.7", got)
	}

	r2 := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r2.RemoteAddr = "203.0.113.5:5555"
	if got := clientIP(r2); got != "203.0.113.5" {
		t.Fatalf("clientIP without XFF = %q, want 203.0.113.5", got)
	}
}

func drainHardening(c *Client) {
	for {
		select {
		case <-c.Outbound():
		default:
			return
		}
	}
}
