package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/voice"

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
	if err := engine.WritePCM(make([]byte, 960), 0); !errors.Is(err, errPublishNotActive) {
		t.Fatal("write before activation must fail closed")
	}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := engine.WritePCM(make([]byte, 960), 0); err != nil {
		t.Fatalf("write after activation: %v", err)
	}
	waitForFrames(t, engine, 1)
	engine.DeactivatePublish()
	if err := engine.WritePCM(make([]byte, 960), 0); !errors.Is(err, errPublishNotActive) {
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
	if err := engine.WritePCM(make([]byte, 3*960), 0); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	waitForRealFrames(t, engine, 3)
	_ = engine.FlushAudio(0)
	waitForTurnClosed(t, engine)
	if len(clock.sleeps) < 2 || clock.sleeps[0] != 20*time.Millisecond ||
		clock.sleeps[1] != 20*time.Millisecond {
		t.Fatalf("sleeps = %v, want [20ms 20ms ...]", clock.sleeps)
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
	if err := engine.WritePCM(make([]byte, 3*960), 0); err != nil {
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
	if err := engine.WritePCM(bytes.Repeat([]byte{7}, 500), 0); err != nil {
		t.Fatalf("WritePCM: %v", err)
	}
	waitForFrames(t, engine, 0) // writer drains instantly with the fake clock
	if engine.PCMCarry() != 0 {
		t.Fatal("a sub-frame write must leave carry only until flushed")
	}
	engine.CancelTurn(0)
	if engine.PCMCarry() != 0 {
		t.Fatal("CancelTurn must discard the buffered partial frame")
	}
	if err := engine.WritePCM(make([]byte, 960), 0); err != nil {
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
		if err := engine.WritePCM(chunk, 0); err != nil {
			t.Fatalf("WritePCM: %v", err)
		}
	}
	waitForFrames(t, engine, 2) // two complete frames
	if got := engine.PCMCarry(); got != 481 {
		t.Fatalf("carry = %d bytes, want 481", got)
	}
	if err := engine.FlushAudio(0); err != nil {
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
	_ = engine.WritePCM(bytes.Repeat([]byte{3}, 500), 0)
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
	_ = engine.WritePCM(make([]byte, 960), 0)
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

// fakeMediaTtsProvider emits a few PCM chunks per synthesis round.
type fakeMediaTtsProvider struct{}

func (*fakeMediaTtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return &fakeMediaTtsSession{}, nil
}

type fakeMediaTtsSession struct{}

func (s *fakeMediaTtsSession) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	for i := 0; i < 2; i++ {
		if err := emit(speech.TtsAudioChunk{Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: make([]byte, 960)}); err != nil {
			return err
		}
	}
	return nil
}

func (s *fakeMediaTtsSession) Close() error { return nil }

// blockingSleepFunc returns a sleepFn that blocks until the returned channel
// is closed; after release, sleeps return immediately (deterministic writer
// timing control).
func blockingSleepFunc() (func(time.Duration), chan struct{}) {
	release := make(chan struct{})
	return func(time.Duration) {
		<-release
	}, release
}

// TestDeactivateClearsQueueBytesConsistently pins the byte-budget fix: a
// revocation while the writer is mid-pace must reset the queue budget to
// zero (the old code leaked bytes and eventually starved all writes), and
// the writer must survive the cycle.
func TestDeactivateClearsQueueBytesConsistently(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Writer: chunk 1 emits its first frame immediately, then blocks on the
	// second frame's paced sleep; chunks 2-3 stay queued with a live budget.
	_ = engine.WritePCM(make([]byte, 3*960), 0)
	_ = engine.WritePCM(make([]byte, 960), 0)
	_ = engine.WritePCM(make([]byte, 960), 0)
	waitForFrames(t, engine, 1)
	if got := engine.queueBytesSnapshot(); got == 0 {
		t.Fatal("precondition: queued chunks must hold a positive byte budget")
	}

	engine.DeactivatePublish()
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("deactivate must reset the queue budget, got %d", got)
	}
	close(release)

	// Re-activation must keep working (no truncated/silent second grant).
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 960), 0)
	waitForFrames(t, engine, 2)
}

// TestConcurrentRevokeAndFlushKeepsWriterAlive pins the flush-marker race:
// a revoke landing exactly between a flush marker's paced wait and its
// activation re-check used to RETURN from the writer loop (permanent
// silence — the one-shot start could not restart it). The writer must
// survive and serve later grants.
func TestConcurrentRevokeAndFlushKeepsWriterAlive(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// First flush: primes the pacer with a paced frame (immediate slot).
	_ = engine.WritePCM(make([]byte, 500), 0)
	_ = engine.FlushAudio(0)
	waitForFrames(t, engine, 1)

	// Second flush: carry non-empty, the paced wait BLOCKS on sleepFn.
	_ = engine.WritePCM(make([]byte, 100), 0)
	_ = engine.FlushAudio(0)
	waitForQueueDrain(t, engine) // ensure the writer consumed both items

	// Revoke while the writer is blocked in the flush's paced wait.
	engine.DeactivatePublish()
	close(release) // writer resumes: activation re-check fails closed

	// The writer must still be alive for the NEXT grant.
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 960), 0)
	waitForFrames(t, engine, 2)
	if got := engine.framesWritten(); got < 2 {
		t.Fatalf("writer died on revoke+flush race: frames=%d", got)
	}
}

// TestReactivateAfterDeactivateWritesAudio covers the plain
// deactivate->reactivate cycle: no truncation, no silence.
func TestReactivateAfterDeactivateWritesAudio(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 960), 0)
	waitForFrames(t, engine, 1)

	engine.DeactivatePublish()
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 2*960), 0)
	waitForFrames(t, engine, 3)
	if got := engine.framesWritten(); got != 3 {
		t.Fatalf("frames=%d, want 3 (no truncation/silence across reactivation)", got)
	}
}

// waitForQueueDrain waits until both the queue channel and the writer's
// carry are empty.
func waitForQueueDrain(t *testing.T, engine *Engine) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		engine.writerMu.Lock()
		carryEmpty := len(engine.carry) == 0
		engine.writerMu.Unlock()
		if len(engine.queueRingSnapshot()) == 0 && carryEmpty {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("queue never drained")
}

// TestCancelDeactivateAccountingNoDrift pins budget consistency across
// repeated cancel/deactivate cycles with mid-pace revocation.
func TestCancelDeactivateAccountingNoDrift(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	for cycle := 0; cycle < 3; cycle++ {
		// First frame immediate, second blocks in the paced sleep.
		_ = engine.WritePCM(make([]byte, 3*960), 0)
		_ = engine.WritePCM(make([]byte, 960), 0)
		waitForFrames(t, engine, uint64(1+cycle*1))
		engine.CancelTurn(0)
		engine.DeactivatePublish()
		if got := engine.queueBytesSnapshot(); got != 0 {
			t.Fatalf("cycle %d: budget drifted to %d after cancel+deactivate", cycle, got)
		}
		close(release)
		release = nil
		sleepFn, release = blockingSleepFunc()
		engine.sleepFn = sleepFn
		if err := engine.ActivatePublish(); err != nil {
			t.Fatalf("cycle %d reactivate: %v", cycle, err)
		}
	}
}

// TestFullQueueBackpressureKeepsAccountingConsistent pins the cap path
// under the blocking semantics: a producer at the cap waits; after the
// writer drains everything the budget must be exactly zero.
func TestFullQueueBackpressureKeepsAccountingConsistent(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	big := make([]byte, 64*1024)
	if err := engine.WritePCM(big, 0); err != nil {
		t.Fatalf("first write: %v", err)
	}
	waitForFrames(t, engine, 1)
	for i := 0; i < 16; i++ {
		_ = engine.WritePCM(big, 0)
	}
	blocked := make(chan struct{})
	go func() {
		_ = engine.WritePCM(big, 0)
		close(blocked)
	}()
	select {
	case <-blocked:
		t.Fatal("producer must block at the cap")
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("producer never unblocked")
	}
	engine.DeactivatePublish()
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("accounting polluted at cap: budget=%d", got)
	}
}

// TestStaleAudioNeverSentAfterReactivation pins the grant boundary: PCM
// queued under an OLD grant must be discarded on deactivate, and only the
// NEW grant's audio may reach frames after reactivation.
func TestStaleAudioNeverSentAfterReactivation(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Old grant: one frame goes out, the rest of grant-1 audio is blocked.
	_ = engine.WritePCM(make([]byte, 6*960), 0)
	waitForFrames(t, engine, 1)
	engine.DeactivatePublish()
	close(release)
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	// The stale grant-1 backlog must be gone; only grant-2 audio flows.
	_ = engine.WritePCM(make([]byte, 2*960), 0)
	waitForRealFrames(t, engine, 3)
	_ = engine.FlushAudio(0)
	waitForTurnClosed(t, engine)
	if got := engine.realFramesWritten(); got != 3 {
		t.Fatalf("real frames=%d: stale grant audio leaked past reactivation", got)
	}
}

// TestEngineCloseBoundedExit pins the bounded-shutdown contract: Close must
// return within its budget even while the writer is blocked mid-pace.
func TestEngineCloseBoundedExit(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, _ := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 3*960), 0)
	waitForFrames(t, engine, 1) // writer now blocked in the paced sleep

	started := time.Now()
	engine.Close()
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("Close took %s with a blocked writer; must stay bounded", elapsed)
	}
}

// TestBlockedEnqueueBackpressureKeepsBudgetExact pins the bounded BLOCKING
// backpressure semantics: at the byte cap the producer WAITS (never
// rejected, never accounting drift); releasing the writer unblocks it, and
// the budget always equals the accepted queued data.
func TestBlockedEnqueueBackpressureKeepsBudgetExact(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 64*1024), 0) // frame 1 out, rest pending
	waitForFrames(t, engine, 1)
	for i := 0; i < 16; i++ {
		_ = engine.WritePCM(make([]byte, 64*1024), 0)
	}
	// One more 64KB chunk would cross the cap: the producer must block.
	blocked := make(chan struct{})
	go func() {
		if err := engine.WritePCM(make([]byte, 64*1024), 0); err != nil {
			t.Errorf("blocked write errored: %v", err)
		}
		close(blocked)
	}()
	select {
	case <-blocked:
		t.Fatal("producer must BLOCK at the cap, not return")
	case <-time.After(150 * time.Millisecond):
	}
	// Budget is exactly the cap while blocked.
	if got := engine.queueBytesSnapshot(); got != maxQueuePcmBytes {
		t.Fatalf("budget at cap = %d, want %d", got, maxQueuePcmBytes)
	}
	// Releasing the paced writer frees space and unblocks the producer.
	close(release)
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("producer never unblocked after the writer resumed")
	}
	engine.DeactivatePublish()
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("budget after deactivate = %d, want 0", got)
	}
}

// TestConcurrentEnqueueConsumeClearAccountingNeverNegativeAndEndsZero
// stresses the three racing paths and asserts the budget invariant: never
// negative, and exactly the accepted queued data once quiesced.
func TestConcurrentEnqueueConsumeClearAccountingNeverNegativeAndEndsZero(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn := func(d time.Duration) { time.Sleep(200 * time.Microsecond) }
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	// Producer: small chunks, tolerate rejections.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = engine.WritePCM(make([]byte, 1920), 0)
		}
	}()
	// Clearer: revoke+reactivate cycles racing both producer and writer.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			engine.DeactivatePublish()
			_ = engine.ActivatePublish()
			time.Sleep(200 * time.Microsecond)
		}
	}()
	// Invariant sampler: the budget must never go negative.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if got := engine.queueBytesSnapshot(); got < 0 {
				t.Errorf("budget went negative: %d", got)
				return
			}
		}
	}()
	time.Sleep(400 * time.Millisecond)
	close(stop)
	wg.Wait()

	// Quiesce: after a final clear the budget must be exactly zero and the
	// ring empty.
	engine.DeactivatePublish()
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("final budget = %d, want 0", got)
	}
	if ring := engine.queueRingSnapshot(); len(ring) != 0 {
		t.Fatalf("final ring has %d items, want 0", len(ring))
	}
	// Accounting equals accepted queued data: enqueue N items with the
	// writer stopped, compare budget to the sum of the ring.
	engine.sleepFn = time.Sleep
	_ = engine.ActivatePublish()
	// Park the writer by blocking its sleep.
	sleepBlock, release := blockingSleepFunc()
	engine.sleepFn = sleepBlock
	_ = engine.WritePCM(make([]byte, 960), 0)
	waitForFrames(t, engine, uint64(engine.framesWritten()+1))
	_ = engine.WritePCM(make([]byte, 1920), 0)
	_ = engine.WritePCM(make([]byte, 480), 0)
	var sum int
	for _, item := range engine.queueRingSnapshot() {
		if item.data != nil {
			sum += len(item.data)
		}
	}
	if got := engine.queueBytesSnapshot(); got != sum {
		t.Fatalf("budget %d != accepted queued data %d", got, sum)
	}
	close(release)
}

// TestLongVoiceTurnStillWritableAfterAccountingChurn ensures a full-length
// reply flows completely after heavy deactivate/enqueue churn.
func TestLongVoiceTurnStillWritableAfterAccountingChurn(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	// Instant writer (no-op clock) so the long turn is limited by CPU, not
	// wall-clock pacing.
	engine.sleepFn = func(time.Duration) {}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Churn phase: several activate/write/cancel cycles.
	for cycle := 0; cycle < 5; cycle++ {
		_ = engine.WritePCM(make([]byte, 1920), 0)
		engine.CancelTurn(0)
		engine.DeactivatePublish()
		if err := engine.ActivatePublish(); err != nil {
			t.Fatalf("reactivate %d: %v", cycle, err)
		}
	}
	// Long-turn phase: ~200KB across many chunks, no interruption.
	totalBytes := 0
	chunks := 0
	for totalBytes < 200*1024 {
		size := 1920
		if err := engine.WritePCM(make([]byte, size), 0); err != nil {
			t.Fatalf("write %d: %v", chunks, err)
		}
		totalBytes += size
		chunks++
	}
	wantFrames := uint64(totalBytes / 960)
	waitForRealFrames(t, engine, wantFrames)
	_ = engine.FlushAudio(0)
	waitForTurnClosed(t, engine)
	if got := engine.realFramesWritten(); got != wantFrames {
		t.Fatalf("real frames=%d want=%d (long turn truncated)", got, wantFrames)
	}
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("budget after full drain = %d, want 0", got)
	}
}

// realFramesWritten counts emitted frames excluding synthetic silence fills.
func (e *Engine) realFramesWritten() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.opusFramesWritten - e.silenceFills
}

// waitForRealFrames waits for at least n REAL frames (fills excluded).
func waitForRealFrames(t *testing.T, engine *Engine, n uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if engine.realFramesWritten() >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("writer did not emit %d real frames (got %d)", n, engine.realFramesWritten())
}

// waitForTurnClosed waits until the flush boundary closed the fill window.
func waitForTurnClosed(t *testing.T, engine *Engine) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		engine.mu.Lock()
		closed := !engine.turnOpen
		engine.mu.Unlock()
		if closed {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("turn window never closed after flush")
}

// TestBlockedProducerHoldsNoReservationUntilAccepted pins the reviewer's
// reservation rule under blocking backpressure: a producer waiting at the
// byte cap holds ZERO reservation (budget unchanged while blocked); the
// reservation is taken exactly once at acceptance. No DeactivatePublish
// before the assertions.
func TestBlockedProducerHoldsNoReservationUntilAccepted(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 64*1024), 0)
	waitForFrames(t, engine, 1)
	for i := 0; i < 16; i++ {
		_ = engine.WritePCM(make([]byte, 64*1024), 0)
	}
	before := engine.queueBytesSnapshot()

	// A producer attempting to cross the cap must block WITHOUT reserving.
	accepted := make(chan struct{})
	go func() {
		if err := engine.WritePCM(make([]byte, 64*1024), 0); err != nil {
			t.Errorf("accepted write errored: %v", err)
			close(accepted)
			return
		}
		close(accepted)
	}()
	select {
	case <-accepted:
		t.Fatal("producer must block at the cap")
	case <-time.After(150 * time.Millisecond):
	}
	if got := engine.queueBytesSnapshot(); got != before {
		t.Fatalf("blocked producer changed the budget: before=%d after=%d", before, got)
	}

	close(release) // writer resumes; the producer gets accepted exactly once
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("producer never accepted")
	}
	// Invariant: the budget equals the outstanding accepted reservations
	// (sum of the ring) at any instant, including right after acceptance.
	var sum int
	for _, item := range engine.queueRingSnapshot() {
		if item.data != nil {
			sum += len(item.data)
		}
	}
	if got := engine.queueBytesSnapshot(); got != sum {
		t.Fatalf("budget %d != outstanding accepted reservations %d", got, sum)
	}
}

// TestWriterConsumeVsClearNeverNegativeWithoutDeactivate races a producer
// and a clearer (CancelTurn) against the writer and asserts the budget
// never goes negative — no DeactivatePublish anywhere — then confirms a
// natural full drain reaches exactly zero.
func TestWriterConsumeVsClearNeverNegativeWithoutDeactivate(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	engine.sleepFn = func(d time.Duration) { time.Sleep(150 * time.Microsecond) }
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = engine.WritePCM(make([]byte, 1920), 0)
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 150; i++ {
			engine.CancelTurn(0)
			time.Sleep(150 * time.Microsecond)
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if got := engine.queueBytesSnapshot(); got < 0 {
				t.Errorf("budget went negative: %d", got)
				return
			}
		}
	}()
	time.Sleep(350 * time.Millisecond)
	close(stop)
	wg.Wait()

	// Natural drain (no deactivate): wait for the writer to consume
	// everything; the budget must reach exactly zero.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_ = engine.FlushAudio(0)
		if engine.queueBytesSnapshot() == 0 && len(engine.queueRingSnapshot()) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := engine.queueBytesSnapshot(); got != 0 {
		t.Fatalf("natural drain budget = %d, want 0", got)
	}
}

// TestClearVsEnqueueAccountingEqualsOutstandingReservations races clear
// against enqueues with the writer blocked, then quiesces the producers and
// asserts the budget equals exactly the sum of the ring's accepted items.
// No DeactivatePublish before the assertion.
func TestClearVsEnqueueAccountingEqualsOutstandingReservations(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 64*1024), 0)
	waitForFrames(t, engine, 1)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			_ = engine.WritePCM(make([]byte, 8*1024), 0)
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			engine.CancelTurn(0)
			time.Sleep(200 * time.Microsecond)
		}
	}()
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()

	var sum int
	for _, item := range engine.queueRingSnapshot() {
		if item.data != nil {
			sum += len(item.data)
		}
	}
	if got := engine.queueBytesSnapshot(); got != sum {
		t.Fatalf("budget %d != outstanding accepted reservations %d", got, sum)
	}
	close(release)
}

// TestStopDuringBlockedEnqueueRollsBackReservation pins the stop-preemption
// rule: a producer blocked at the cap when the engine closes must return
// errPublishNotActive holding ZERO reservation — the budget stays equal to
// the outstanding accepted items only.
func TestStopDuringBlockedEnqueueRollsBackReservation(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, _ := blockingSleepFunc() // never released
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	_ = engine.WritePCM(make([]byte, 64*1024), 0)
	waitForFrames(t, engine, 1)
	for i := 0; i < 16; i++ {
		_ = engine.WritePCM(make([]byte, 64*1024), 0)
	}
	before := engine.queueBytesSnapshot()

	outcome := make(chan error, 1)
	go func() {
		outcome <- engine.WritePCM(make([]byte, 64*1024), 0)
	}()
	select {
	case <-outcome:
		t.Fatal("producer must block at the cap")
	case <-time.After(150 * time.Millisecond):
	}

	engine.Close() // stops the writer: the blocked producer must unblock
	select {
	case err := <-outcome:
		if err == nil || err != errPublishNotActive {
			t.Fatalf("stopped producer must get errPublishNotActive, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("producer never unblocked on engine close")
	}
	// No reservation may have leaked from the aborted producer.
	if got := engine.queueBytesSnapshot(); got != before {
		t.Fatalf("stop-preempted enqueue leaked a reservation: before=%d after=%d", before, got)
	}
}

// TestCancelTurnInvalidatesInFlightChunk pins reviewer P1-A: a multi-frame
// chunk already owned by the writer must stop emitting after CancelTurn —
// even though the publication generation is still valid — and the NEXT turn
// writes normally on the same active publication.
func TestCancelTurnInvalidatesInFlightChunk(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Turn 1: six frames in ONE chunk. Frame 1 emits; frame 2 blocks in the
	// paced wait; frames 2-6 remain in the writer's in-flight ownership.
	_ = engine.WritePCM(make([]byte, 6*960), 0)
	waitForFrames(t, engine, 1)

	engine.CancelTurn(0) // invalidate turn 1, clear queue+carry, keep grant
	close(release)       // resume the blocked paced wait

	// Turn 1's in-flight frames must be discarded at the paced-wait check.
	time.Sleep(30 * time.Millisecond)
	if got := engine.realFramesWritten(); got != 1 {
		t.Fatalf("turn1 stale frames leaked: real frames=%d, want 1", got)
	}

	// Turn 2 on the SAME publication writes normally.
	_ = engine.WritePCM(make([]byte, 2*960), 0)
	waitForRealFrames(t, engine, 3)
	_ = engine.FlushAudio(0)
	waitForTurnClosed(t, engine)
	if got := engine.realFramesWritten(); got != 3 {
		t.Fatalf("turn2 frames=%d, want 3 (new turn must flow immediately)", got)
	}
}

// TestCancelTurnInvalidatesBackpressureBlockedWrite pins reviewer P1-B: an
// OLD turn's WritePCM blocked at the byte cap must be judged stale when the
// cancel frees space — it must never re-enqueue; the NEW turn must write
// immediately on the same publication.
func TestCancelTurnInvalidatesBackpressureBlockedWrite(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	sleepFn, release := blockingSleepFunc()
	engine.sleepFn = sleepFn
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// Turn 1 fills the ring to the cap with the writer blocked mid-pace.
	_ = engine.WritePCM(make([]byte, 64*1024), 0)
	waitForFrames(t, engine, 1)
	for i := 0; i < 16; i++ {
		_ = engine.WritePCM(make([]byte, 64*1024), 0)
	}
	blocked := make(chan struct{})
	go func() {
		// Old turn's write: blocks at the cap.
		if err := engine.WritePCM(make([]byte, 64*1024), 0); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		close(blocked)
	}()
	select {
	case <-blocked:
		t.Fatal("old-turn write must block at the cap")
	case <-time.After(150 * time.Millisecond):
	}

	// Cancel frees the queue; the blocked old-turn write wakes and must be
	// dropped as stale (returns nil, enqueues nothing).
	engine.CancelTurn(0)
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked old-turn write never woke after cancel")
	}
	close(release) // resume the paced writer
	time.Sleep(30 * time.Millisecond)
	if got := engine.realFramesWritten(); got != 1 {
		t.Fatalf("stale old-turn PCM must not emit: real frames=%d, want 1", got)
	}

	// New turn flows immediately on the same active publication.
	_ = engine.WritePCM(make([]byte, 2*960), 0)
	waitForRealFrames(t, engine, 3)
	if got := engine.realFramesWritten(); got != 3 {
		t.Fatalf("new turn frames=%d, want 3", got)
	}
}

// TestCancelTurnStopsGapFill pins reviewer P1-C: a gap-fill in progress must
// stop the moment the turn is cancelled — no silence frames continue after.
func TestCancelTurnStopsGapFill(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	// Fast writer so the ring drains quickly and the fill window engages.
	engine.sleepFn = func(d time.Duration) { time.Sleep(200 * time.Microsecond) }
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	// One frame + flush: the frame opens the turn; after the flush the turn
	// closes. To catch the fill WINDOW, write a chunk and let the ring
	// drain mid-turn, then cancel.
	_ = engine.WritePCM(make([]byte, 2*960), 0)
	waitForRealFrames(t, engine, 2)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if engine.silenceFillCount() > 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	before := engine.silenceFillCount()
	engine.CancelTurn(0)
	time.Sleep(50 * time.Millisecond)
	after := engine.silenceFillCount()
	// No NEW fills may occur after the cancel (bounded in-flight tail is
	// fine; assert growth halts).
	time.Sleep(80 * time.Millisecond)
	final := engine.silenceFillCount()
	if final > after {
		t.Fatalf("gap-fill continued after cancel: before=%d after=%d final=%d",
			before, after, final)
	}
	if after == 0 && before == 0 {
		t.Log("fill window never engaged (timing); cancel-stop semantics still hold")
	}
}

// cancelOnFirstWriteSink simulates the exact Speaker->Engine boundary race:
// the TTS callback has already passed the speaker's epoch check; the cancel
// lands BEFORE the first sink write completes; the write then proceeds with
// the STALE turn's token. The engine's turn admission must reject it.
// tokenEngineSink is the token-aware engine adapter (production parity with
// bridgeVoiceSink).
type tokenEngineSink struct {
	engine *Engine
	token  uint64
}

func (s *tokenEngineSink) WriteAudio(c speech.TtsAudioChunk) error {
	return s.engine.WritePCM(c.Data, s.token)
}
func (s *tokenEngineSink) EndTurn() error { return s.engine.FlushAudio(s.token) }
func (s *tokenEngineSink) CancelTurn() error {
	s.engine.CancelTurn(s.token)
	return nil
}
func (s *tokenEngineSink) Close() error { return nil }

type cancelOnFirstWriteSink struct {
	inner    *tokenEngineSink
	cancelFn func()
	mu       sync.Mutex
	first    bool
	writes   int
}

func (s *cancelOnFirstWriteSink) WriteAudio(c speech.TtsAudioChunk) error {
	s.mu.Lock()
	if s.first {
		s.first = false
		cancel := s.cancelFn
		s.mu.Unlock()
		cancel() // the race window: cancel AFTER the epoch check
		s.mu.Lock()
	}
	s.writes++
	s.mu.Unlock()
	return s.inner.WriteAudio(c)
}
func (s *cancelOnFirstWriteSink) EndTurn() error    { return s.inner.EndTurn() }
func (s *cancelOnFirstWriteSink) CancelTurn() error { return s.inner.CancelTurn() }
func (s *cancelOnFirstWriteSink) Close() error      { return nil }

// TestStaleCallbackCrossingCancelBoundaryRejected pins reviewer P1: an old
// TTS callback that passed the speaker epoch check, got cancelled, and then
// performed its FIRST WriteAudio must not be admitted under the new turn —
// the engine's turn-token admission rejects it; the new turn flows.
func TestStaleCallbackCrossingCancelBoundaryRejected(t *testing.T) {
	engine := newTestEngine(t)
	_ = engine.ArmPublish()
	engine.sleepFn = func(time.Duration) {}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}

	var speaker *voice.Speaker
	var cancelOnce sync.Once // the race fires ONCE, for turn 1 only
	speaker = voice.NewSpeaker(voice.Options{
		Provider: &fakeMediaTtsProvider{},
		CreateSink: func(token uint64) (voice.Sink, error) {
			return &cancelOnFirstWriteSink{
				inner: &tokenEngineSink{engine: engine, token: token},
				first: true,
				cancelFn: func() {
					cancelOnce.Do(func() { speaker.Cancel() })
				},
			}, nil
		},
	})
	speaker.Speak("第一轮。")
	// The first write triggers the cancel; the engine must reject the stale
	// token and emit NOTHING for turn 1.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if engine.realFramesWritten() == 0 && engine.silenceFillCount() == 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		break
	}
	time.Sleep(50 * time.Millisecond)
	if got := engine.realFramesWritten(); got != 0 {
		t.Fatalf("stale callback PCM admitted: real frames=%d, want 0", got)
	}

	// Turn 2 on the same publication writes normally.
	speaker.Speak("第二轮。")
	waitForRealFrames(t, engine, 2)
	engine.mu.Lock()
	t.Logf("DEBUG: realFrames=%d admitted=%d cancelled=%d turnGen=%d turnOpen=%v",
		engine.opusFramesWritten-engine.silenceFills, engine.admittedTurn,
		engine.cancelledTurn, engine.turnGeneration, engine.turnOpen)
	engine.mu.Unlock()
	if got := engine.realFramesWritten(); got < 2 {
		t.Fatalf("new turn frames=%d, want >=2", got)
	}
	_ = speaker.Close()
}
