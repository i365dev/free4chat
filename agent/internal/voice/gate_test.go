package voice

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestGateSerializesAndCancelledWaiterNeverAcquires(t *testing.T) {
	gate := NewGate()
	releaseA, err := gate.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer releaseA()

	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	acquiredB := make(chan struct{})
	resultB := make(chan error, 1)
	go func() {
		release, err := gate.Acquire(ctxB)
		if err != nil {
			resultB <- err
			return
		}
		close(acquiredB)
		release()
		resultB <- nil
	}()

	select {
	case <-acquiredB:
		t.Fatal("second host voice execution overlapped the first")
	case <-time.After(30 * time.Millisecond):
	}
	cancelB()
	if err := <-resultB; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled queued voice must not acquire: %v", err)
	}
	releaseA()
	select {
	case <-acquiredB:
		t.Fatal("cancelled queued voice acquired after the gate released")
	case <-time.After(30 * time.Millisecond):
	}
}
