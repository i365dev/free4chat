// Package runtime implements the resident room runtime: the long-poll wait
// loop, lease-expiry rejoin, room expiry cleanup, bounded event processing,
// addressed-turn dispatch, and attachment enrichment. It owns the
// participant capability handle; that value never reaches a Harness turn,
// status payload, or log line.
package runtime

import (
	"time"
)

// WaitSeconds is the long-poll window used for every wait_for_events call
// (it also serves as the lease heartbeat).
const WaitSeconds = 20

// MaxPendingTurns bounds how many addressed events may queue while a turn
// is running.
const MaxPendingTurns = 8

// RetryDelay computes the reconnect back-off: 1s doubling capped at 10s,
// matching the Node reference exactly (attempt 0 -> 1s).
func RetryDelay(attempt int) time.Duration {
	delay := time.Second
	for i := 0; i < attempt && delay < 10*time.Second; i++ {
		delay *= 2
	}
	if delay > 10*time.Second {
		delay = 10 * time.Second
	}
	return delay
}

// LogFunc receives structured lifecycle events. Implementations must never
// be handed capability values.
type LogFunc func(event string, details map[string]string)

// DefaultLog writes to stderr in the Node reference's shape.
func DefaultLog(event string, details map[string]string) {
	if len(details) == 0 {
		logStderr.Printf("[free4chat-agent] %s", event)
		return
	}
	logStderr.Printf("[free4chat-agent] %s %v", event, details)
}
