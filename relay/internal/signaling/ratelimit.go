package signaling

import "time"

// rateLimiter is a small monotonic-clock token bucket used to cap the inbound
// message rate on a single connection. It refills at `ratePerSec` tokens per
// second up to a burst of `ratePerSec` (a one-second burst), which is ample for
// a legitimate WebRTC handshake (a handful of offer/answer/ICE messages) while
// stopping a client from flooding the hub.
//
// A zero (or negative) rate disables limiting entirely.
type rateLimiter struct {
	ratePerSec float64
	burst      float64
	tokens     float64
	last       time.Time
	now        func() time.Time // injectable for tests
}

func newRateLimiter(ratePerSec int) *rateLimiter {
	return &rateLimiter{
		ratePerSec: float64(ratePerSec),
		burst:      float64(ratePerSec),
		tokens:     float64(ratePerSec),
		last:       time.Now(),
		now:        time.Now,
	}
}

// allow reports whether one message may be processed now, consuming a token.
func (r *rateLimiter) allow() bool {
	if r.ratePerSec <= 0 {
		return true
	}
	t := r.now()
	elapsed := t.Sub(r.last).Seconds()
	r.last = t
	r.tokens += elapsed * r.ratePerSec
	if r.tokens > r.burst {
		r.tokens = r.burst
	}
	if r.tokens < 1 {
		return false
	}
	r.tokens--
	return true
}
