package voice

import (
	"context"
	"sync"
)

// Gate serializes a complete audible voice operation. It is intentionally
// small: no queue persistence, scheduling, or mixing policy. A cancelled
// waiter must return without later publishing stale audio.
type Gate interface {
	Acquire(context.Context) (release func(), err error)
}

// NewGate returns a FIFO-like host-local semaphore. A single daemon shares
// this instance with each resident Runtime it creates; direct runtimes get an
// independent default gate through NewSpeaker.
func NewGate() Gate {
	gate := &semaphoreGate{token: make(chan struct{}, 1)}
	gate.token <- struct{}{}
	return gate
}

type semaphoreGate struct{ token chan struct{} }

func (g *semaphoreGate) Acquire(ctx context.Context) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-g.token:
	}
	var once sync.Once
	return func() { once.Do(func() { g.token <- struct{}{} }) }, nil
}
