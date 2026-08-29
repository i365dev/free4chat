package voice

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

type blockedTtsProvider struct {
	started chan struct{}
	release chan struct{}
	active  *atomic.Int32
	max     *atomic.Int32
}

func (p *blockedTtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return p, nil
}

func (p *blockedTtsProvider) Synthesize(_ string, emit func(speech.TtsAudioChunk) error) error {
	active := p.active.Add(1)
	for {
		seen := p.max.Load()
		if active <= seen || p.max.CompareAndSwap(seen, active) {
			break
		}
	}
	defer p.active.Add(-1)
	p.started <- struct{}{}
	<-p.release
	return emit(speech.TtsAudioChunk{
		Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: []byte{1},
	})
}

func (*blockedTtsProvider) Close() error { return nil }

func newBlockedSpeaker(gate Gate, provider *blockedTtsProvider, sink *recordingSink) *Speaker {
	return NewSpeaker(Options{
		Provider:   provider,
		CreateSink: func(uint64) (Sink, error) { return sink, nil },
		Gate:       gate,
	})
}

func waitSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal(message)
	}
}

func TestHostVoiceGateSerializesCompleteSpeakerTurns(t *testing.T) {
	gate := NewGate()
	var active, max atomic.Int32
	providerA := &blockedTtsProvider{make(chan struct{}, 1), make(chan struct{}), &active, &max}
	providerB := &blockedTtsProvider{make(chan struct{}, 1), make(chan struct{}), &active, &max}
	speakerA := newBlockedSpeaker(gate, providerA, &recordingSink{})
	speakerB := newBlockedSpeaker(gate, providerB, &recordingSink{})
	t.Cleanup(func() { _ = speakerA.Close(); _ = speakerB.Close() })

	speakerA.Speak("Agent A")
	waitSignal(t, providerA.started, "Agent A never began synthesis")
	speakerB.Speak("Agent B")
	select {
	case <-providerB.started:
		t.Fatal("Agent B began before Agent A released the shared host gate")
	case <-time.After(30 * time.Millisecond):
	}
	close(providerA.release)
	waitSignal(t, providerB.started, "Agent B did not begin after Agent A completed")
	close(providerB.release)
	if got := max.Load(); got != 1 {
		t.Fatalf("shared host gate allowed %d simultaneous voice operations", got)
	}
}

func TestQueuedSpeakerCancellationNeverPublishesAfterGateRelease(t *testing.T) {
	gate := NewGate()
	var active, max atomic.Int32
	providerA := &blockedTtsProvider{make(chan struct{}, 1), make(chan struct{}), &active, &max}
	providerB := &blockedTtsProvider{make(chan struct{}, 1), make(chan struct{}), &active, &max}
	sinkB := &recordingSink{}
	speakerA := newBlockedSpeaker(gate, providerA, &recordingSink{})
	speakerB := newBlockedSpeaker(gate, providerB, sinkB)
	t.Cleanup(func() { _ = speakerA.Close(); _ = speakerB.Close() })

	speakerA.Speak("Agent A")
	waitSignal(t, providerA.started, "Agent A never began synthesis")
	speakerB.Speak("Agent B")
	speakerB.Cancel()
	close(providerA.release)
	select {
	case <-providerB.started:
		t.Fatal("cancelled queued Agent B acquired the host gate")
	case <-time.After(50 * time.Millisecond):
	}
	if got := len(sinkB.order); got != 0 {
		t.Fatalf("cancelled queued Agent B published %d stale audio bytes", got)
	}
}

type immediateTtsProvider struct{ started chan struct{} }

func (p *immediateTtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return p, nil
}

func (p *immediateTtsProvider) Synthesize(_ string, emit func(speech.TtsAudioChunk) error) error {
	p.started <- struct{}{}
	return emit(speech.TtsAudioChunk{
		Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: []byte{1},
	})
}

func (*immediateTtsProvider) Close() error { return nil }

type flushBarrierSink struct {
	*recordingSink
	entered    chan struct{}
	release    chan struct{}
	cancelled  chan struct{}
	cancelOnce sync.Once
}

func (s *flushBarrierSink) EndTurn() error {
	s.entered <- struct{}{}
	select {
	case <-s.release:
	case <-s.cancelled:
		return errStaleTurn
	}
	return s.recordingSink.EndTurn()
}

func (s *flushBarrierSink) CancelTurn() error {
	s.cancelOnce.Do(func() { close(s.cancelled) })
	return s.recordingSink.CancelTurn()
}

func TestHostVoiceGateWaitsForAudibleFlushCompletion(t *testing.T) {
	gate := NewGate()
	providerA := &immediateTtsProvider{started: make(chan struct{}, 1)}
	providerB := &immediateTtsProvider{started: make(chan struct{}, 1)}
	sinkA := &flushBarrierSink{
		recordingSink: &recordingSink{},
		entered:       make(chan struct{}, 1),
		release:       make(chan struct{}),
		cancelled:     make(chan struct{}),
	}
	speakerA := NewSpeaker(Options{
		Provider: providerA,
		CreateSink: func(uint64) (Sink, error) {
			return sinkA, nil
		},
		Gate: gate,
	})
	speakerB := NewSpeaker(Options{
		Provider: providerB,
		CreateSink: func(uint64) (Sink, error) {
			return &recordingSink{}, nil
		},
		Gate: gate,
	})
	t.Cleanup(func() { _ = speakerA.Close(); _ = speakerB.Close() })

	speakerA.Speak("Agent A")
	waitSignal(t, sinkA.entered, "Agent A never reached final flush")
	speakerB.Speak("Agent B")
	select {
	case <-providerB.started:
		t.Fatal("Agent B started while Agent A audio was still flushing")
	case <-time.After(30 * time.Millisecond):
	}
	close(sinkA.release)
	waitSignal(t, providerB.started, "Agent B did not start after Agent A flush completed")
}
