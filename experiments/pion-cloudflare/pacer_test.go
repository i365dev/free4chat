package main

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

// fakeClock is a fully deterministic wall clock: Sleep records the requested
// duration and advances the current time by exactly that much (an idealized
// sleeper), so pacing assertions never depend on real scheduling.
type fakeClock struct {
	current time.Time
	sleeps  []time.Duration
}

func newFakeClock(start time.Time) *fakeClock {
	return &fakeClock{current: start}
}

func (c *fakeClock) Now() time.Time { return c.current }

func (c *fakeClock) Sleep(d time.Duration) {
	c.sleeps = append(c.sleeps, d)
	c.current = c.current.Add(d)
}

func (c *fakeClock) advance(d time.Duration) {
	c.current = c.current.Add(d)
}

func durationsEqual(got []time.Duration, want ...time.Duration) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestFramePacerFirstFrameImmediateThenSpaced(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	pacer := newFramePacer(clock.Now, clock.Sleep)

	pacer.pace() // first frame of a schedule goes out immediately
	if len(clock.sleeps) != 0 {
		t.Fatalf("first frame must not sleep, got %v", clock.sleeps)
	}

	clock.advance(5 * time.Millisecond)
	pacer.pace() // arrived 15 ms before its slot
	if !durationsEqual(clock.sleeps, 15*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [15ms]", clock.sleeps)
	}
	if !clock.current.Equal(time.Unix(0, 0).Add(20 * time.Millisecond)) {
		t.Fatalf("clock = %v, want 20ms", clock.current)
	}

	clock.advance(0)
	pacer.pace() // next frame is a full interval away again
	if !durationsEqual(clock.sleeps, 15*time.Millisecond, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [15ms 20ms]", clock.sleeps)
	}
}

func TestFramePacerResyncAfterStallInsteadOfBursting(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	pacer := newFramePacer(clock.Now, clock.Sleep)

	pacer.pace()
	// Simulate a long stall (writer starved, GC pause): far behind the
	// schedule, the pacer rebaselines to now instead of emitting catch-up
	// frames back-to-back.
	clock.advance(5 * time.Second)
	pacer.pace()
	if len(clock.sleeps) != 0 {
		t.Fatalf("resync after a long stall must not sleep, got %v", clock.sleeps)
	}
	// The restarted schedule still spaces the NEXT frames.
	clock.advance(0)
	pacer.pace()
	if !durationsEqual(clock.sleeps, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [20ms]", clock.sleeps)
	}
}

func TestFramePacerSlightLatencyRebaselinesWithoutBurst(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	pacer := newFramePacer(clock.Now, clock.Sleep)

	pacer.pace()
	// Arrive one-and-a-half intervals late: inside the resync window, so no
	// sleep and no multi-frame catch-up burst.
	clock.advance(30 * time.Millisecond)
	pacer.pace()
	if len(clock.sleeps) != 0 {
		t.Fatalf("late arrival within resync window must not sleep, got %v", clock.sleeps)
	}
	// The original timeline survives: the NEXT frame fills the skipped slot
	// (only 10 ms away), then cadence returns to a full interval.
	pacer.pace()
	if !durationsEqual(clock.sleeps, 10*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [10ms]", clock.sleeps)
	}
	clock.advance(0)
	pacer.pace()
	if !durationsEqual(clock.sleeps, 10*time.Millisecond, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [10ms 20ms]", clock.sleeps)
	}
}

// MediaSpike-level: WritePCM must pace complete frames through the injected
// clock — first frame immediate, later frames one interval apart.
func TestWritePCMPacesOutboundFramesWithInjectedClock(t *testing.T) {
	spike := newPublishSpike(t)
	clock := newFakeClock(time.Unix(0, 0))
	spike.nowFn = clock.Now
	spike.sleepFn = clock.Sleep

	if err := spike.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Three complete 20 ms frames in one burst → exactly two paced gaps.
	if err := spike.WritePCM(make([]byte, 3*960)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	if !durationsEqual(clock.sleeps, 20*time.Millisecond, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [20ms 20ms]", clock.sleeps)
	}
}

// A concurrent DeactivatePublish during a paced wait must abort the burst
// with the fail-closed error instead of writing stale frames.
func TestWritePCMAbortsWhenDeactivatedDuringPace(t *testing.T) {
	spike := newPublishSpike(t)
	clock := newFakeClock(time.Unix(0, 0))
	spike.nowFn = clock.Now
	spike.sleepFn = func(d time.Duration) {
		clock.Sleep(d)
		spike.DeactivatePublish()
	}
	if err := spike.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	err := spike.WritePCM(make([]byte, 3*960))
	if !errors.Is(err, errPublishNotActive) {
		t.Fatalf("err = %v, want errPublishNotActive", err)
	}
	if len(clock.sleeps) != 1 {
		t.Fatalf("sleeps = %v, want exactly the one gap where deactivation hit", clock.sleeps)
	}
}

// CancelTurn discards partial carry but leaves the publication live.
func TestCancelTurnDiscardsCarryKeepsPublicationActive(t *testing.T) {
	spike := newPublishSpike(t)
	clock := newFakeClock(time.Unix(0, 0))
	spike.nowFn = clock.Now
	spike.sleepFn = clock.Sleep
	if err := spike.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}

	if err := spike.WritePCM(bytes.Repeat([]byte{7}, 500)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	if len(spike.PCMCarry()) == 0 {
		t.Fatal("precondition: sub-frame write must leave carry")
	}

	spike.CancelTurn()
	if len(spike.PCMCarry()) != 0 {
		t.Fatal("CancelTurn must discard the buffered partial frame")
	}

	// Publication stays active: the next utterance writes normally (a single
	// frame never needs to sleep).
	if err := spike.WritePCM(make([]byte, 960)); err != nil {
		t.Fatalf("write after cancel: %v", err)
	}
	if len(spike.PCMCarry()) != 0 {
		t.Fatal("a full frame after cancel must not leave carry")
	}
}

// The JSONL op maps onto CancelTurn with the same OK/shape as its siblings.
func TestHandleCmdCancelTurnOp(t *testing.T) {
	spike := newPublishSpike(t)
	tracer := testTracer(t)
	if r := handleCmd(spike, tracer, cmd{Op: "cancel-turn"}); !r.OK {
		t.Fatalf("cancel-turn before activation must still be ok (nothing to discard): %+v", r)
	}
	if err := spike.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := spike.WritePCM(bytes.Repeat([]byte{3}, 100)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	if r := handleCmd(spike, tracer, cmd{Op: "cancel-turn"}); !r.OK {
		t.Fatalf("cancel-turn: %+v", r)
	}
	if len(spike.PCMCarry()) != 0 {
		t.Fatal("cancel-turn op must discard carry")
	}
}
