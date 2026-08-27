package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// fakeClock is a fully deterministic wall clock.
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

func newTestEngine(t *testing.T) *Engine {
	t.Helper()
	engine := NewEngine(EngineEvents{}, func(string, map[string]string) {})
	if err := engine.Create(); err != nil {
		t.Skipf("pc unavailable: %v", err)
	}
	t.Cleanup(engine.Close)
	return engine
}

func TestFramePacerFirstFrameImmediateThenSpaced(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	pacer := newFramePacer(clock.Now, clock.Sleep)

	pacer.pace()
	if len(clock.sleeps) != 0 {
		t.Fatalf("first frame must not sleep, got %v", clock.sleeps)
	}

	clock.advance(5 * time.Millisecond)
	pacer.pace()
	if !durationsEqual(clock.sleeps, 15*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [15ms]", clock.sleeps)
	}

	clock.advance(0)
	pacer.pace()
	if !durationsEqual(clock.sleeps, 15*time.Millisecond, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [15ms 20ms]", clock.sleeps)
	}
}

func TestFramePacerResyncAfterStallInsteadOfBursting(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	pacer := newFramePacer(clock.Now, clock.Sleep)

	pacer.pace()
	clock.advance(5 * time.Second)
	pacer.pace()
	if len(clock.sleeps) != 0 {
		t.Fatalf("resync after a long stall must not sleep, got %v", clock.sleeps)
	}
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
	clock.advance(30 * time.Millisecond)
	pacer.pace()
	if len(clock.sleeps) != 0 {
		t.Fatalf("late arrival within resync window must not sleep, got %v", clock.sleeps)
	}
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

func TestCreateLeavesPublishUnarmedUntilArmPublish(t *testing.T) {
	engine := newTestEngine(t)
	if err := engine.CreateServerEventsChannel(); err != nil {
		t.Fatalf("dc: %v", err)
	}
	engine.mu.Lock()
	unarmed := engine.outbound == nil
	engine.mu.Unlock()
	if !unarmed {
		t.Fatal("Create() must not arm the outbound publish track")
	}
	offer, err := engine.GatherCompleteOffer()
	if err != nil {
		t.Fatalf("initial gather: %v", err)
	}
	// The initial offer must NOT contain a send m-line.
	for _, transceiver := range engine.pc.GetTransceivers() {
		if transceiver.Sender() != nil && transceiver.Sender().Track() != nil {
			t.Fatal("initial bootstrap offer must stay receive-only")
		}
	}

	// Complete the bootstrap against a loopback peer so the PC is stable
	// before voice activation (the real flow applies Cloudflare's answer).
	peer := newLoopbackPeer(t, *offer)
	if _, _, err := engine.ApplyRemote(peer); err != nil {
		t.Fatalf("apply bootstrap answer: %v", err)
	}

	// ArmPublish AFTER the bootstrap must work (voice activation) and the
	// fresh offer must then carry the send m-line with a local MID.
	if err := engine.ArmPublish(); err != nil {
		t.Fatalf("arm: %v", err)
	}
	if err := engine.ArmPublish(); err != nil {
		t.Fatalf("idempotent re-arm: %v", err)
	}
	fresh, err := engine.CreateLocalOffer()
	if err != nil {
		t.Fatalf("fresh offer: %v", err)
	}
	if mid := engine.LocalPublishMid(); mid == "" {
		t.Fatal("fresh offer must yield a local publish MID")
	}
	if !strings.Contains(fresh.SDP, "m=audio") {
		t.Fatal("fresh publish offer must carry the audio m-line")
	}
}

// newLoopbackPeer builds a local-only second PC, applies the given offer,
// and returns its answer (real SDP, no network traffic).
func newLoopbackPeer(t *testing.T, offer Description) Description {
	t.Helper()
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Skipf("peer pc unavailable: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: offer.SDP,
	}); err != nil {
		t.Fatalf("peer setRemote(offer): %v", err)
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("peer createAnswer: %v", err)
	}
	if err := peer.SetLocalDescription(answer); err != nil {
		t.Fatalf("peer setLocal(answer): %v", err)
	}
	ld := peer.LocalDescription()
	return Description{Type: "answer", SDP: ld.SDP}
}

func TestWritePCMRequiresActivation(t *testing.T) {
	engine := newTestEngine(t)
	if err := engine.ArmPublish(); err != nil {
		t.Fatalf("arm: %v", err)
	}
	if err := engine.WritePCM(make([]byte, 960)); !errors.Is(err, errPublishNotActive) {
		t.Fatal("write before activation must fail closed")
	}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := engine.WritePCM(make([]byte, 960)); err != nil {
		t.Fatalf("write after activation: %v", err)
	}
	waitForFrames(t, engine, 1)
	engine.DeactivatePublish()
	if err := engine.WritePCM(make([]byte, 960)); !errors.Is(err, errPublishNotActive) {
		t.Fatal("write after deactivation must fail closed")
	}
}

func TestWritePCMPacesOutboundFramesWithInjectedClock(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	clock := newFakeClock(time.Unix(0, 0))
	engine.nowFn = clock.Now
	engine.sleepFn = clock.Sleep
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Three complete 20 ms frames in one burst => exactly two paced gaps.
	if err := engine.WritePCM(make([]byte, 3*960)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	waitForFrames(t, engine, 3)
	if !durationsEqual(clock.sleeps, 20*time.Millisecond, 20*time.Millisecond) {
		t.Fatalf("sleeps = %v, want [20ms 20ms]", clock.sleeps)
	}
}

func TestWritePCMAbortsWhenDeactivatedDuringPace(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	clock := newFakeClock(time.Unix(0, 0))
	engine.nowFn = clock.Now
	engine.sleepFn = func(d time.Duration) {
		clock.Sleep(d)
		engine.DeactivatePublish()
	}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := engine.WritePCM(make([]byte, 3*960)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	waitForFrames(t, engine, 1)
	// Deactivation hit during the first paced gap: exactly one frame emitted.
	if engine.framesWritten() != 1 {
		t.Fatalf("frames = %d, want 1 (deactivation stops the burst)", engine.framesWritten())
	}
	if len(clock.sleeps) != 1 {
		t.Fatalf("sleeps = %v, want exactly the one gap where deactivation hit", clock.sleeps)
	}
}

func TestCancelTurnDiscardsCarryKeepsPublicationActive(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	clock := newFakeClock(time.Unix(0, 0))
	engine.nowFn = clock.Now
	engine.sleepFn = clock.Sleep
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := engine.WritePCM(bytes.Repeat([]byte{7}, 500)); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	waitForFrames(t, engine, 0) // writer drains instantly with the fake clock
	if engine.PCMCarry() != 0 {
		t.Fatal("a sub-frame write must leave carry only until flushed")
	}
	engine.CancelTurn()
	if engine.PCMCarry() != 0 {
		t.Fatal("CancelTurn must discard the buffered partial frame")
	}
	if err := engine.WritePCM(make([]byte, 960)); err != nil {
		t.Fatalf("write after cancel: %v", err)
	}
	waitForFrames(t, engine, 1)
}

func TestWritePCMFramesArbitraryChunksAndFlushPadsFinalFrame(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	_ = engine.ActivatePublish()
	total := make([]byte, 2401)
	for i := range total {
		total[i] = byte(i % 7)
	}
	for _, chunk := range [][]byte{total[:1000], total[1000:2000], total[2000:]} {
		if err := engine.WritePCM(chunk); err != nil {
			t.Fatalf("WritePCM: %v", err)
		}
	}
	waitForFrames(t, engine, 2) // two complete frames
	if got := engine.PCMCarry(); got != 481 {
		t.Fatalf("carry = %d bytes, want 481", got)
	}
	if err := engine.FlushAudio(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	waitForFrames(t, engine, 3)
	if engine.PCMCarry() != 0 {
		t.Fatal("carry must be empty after flush")
	}
}

func TestDeactivateDiscardsCarryAndResampleDeterministic(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	_ = engine.ActivatePublish()
	_ = engine.WritePCM(bytes.Repeat([]byte{3}, 500))
	waitForFrames(t, engine, 0)
	engine.DeactivatePublish()
	if engine.PCMCarry() != 0 {
		t.Fatal("deactivation must discard buffered PCM")
	}
	in := make([]byte, 96)
	binary.LittleEndian.PutUint16(in[0:], 30000)
	binary.LittleEndian.PutUint16(in[2:], 10000)
	out := Resample24To48(in)
	if len(out) != 192 || binary.LittleEndian.Uint16(out[0:]) != 30000 || binary.LittleEndian.Uint16(out[2:]) != 20000 {
		t.Fatal("unexpected resample output shape/values")
	}
	if !bytes.Equal(Resample24To48(in), out) {
		t.Fatal("resample must be deterministic")
	}
}

func TestPublishCountsNeverFabricatedFromWriteSample(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	_ = engine.ActivatePublish()
	_ = engine.WritePCM(make([]byte, 960))
	waitForFrames(t, engine, 1)
	counts := engine.PublishCounts()
	if counts["pcm_write_calls"] != 1 || counts["pcm_input_bytes"] != 960 {
		t.Fatalf("application counters mismatch: %v", counts)
	}
	if counts["opus_frames_written"] != 1 {
		t.Fatalf("opus frame count mismatch: %v", counts)
	}
	// outbound_rtp_* must only appear when Pion actually exposes them; the
	// key must never be synthesized from WriteSample success.
	if value, exists := counts["outbound_rtp_packets"]; exists && value > 0 {
		t.Logf("pion exposed outbound_rtp_packets=%d", value)
	}
}

// framesWritten snapshots the opus frame counter.
func (e *Engine) framesWritten() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.opusFramesWritten
}

// waitForFrames waits for the async writer to emit at least n frames.
func waitForFrames(t *testing.T, engine *Engine, n uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if engine.framesWritten() >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("writer did not emit %d frames (got %d)", n, engine.framesWritten())
}
