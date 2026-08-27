package runtime

import (
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// orderedTimeline records the exact sequence of text-send vs voice-sink
// events across goroutines (mutex-guarded).
type orderedTimeline struct {
	mu     sync.Mutex
	events []string
}

func (o *orderedTimeline) record(event string) {
	o.mu.Lock()
	o.events = append(o.events, event)
	o.mu.Unlock()
}

func (o *orderedTimeline) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.events...)
}

func (o *orderedTimeline) contains(needle string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, event := range o.events {
		if event == needle {
			return true
		}
	}
	return false
}

// timelineSink implements voice.Sink recording ordered writes.
type timelineSink struct {
	timeline *orderedTimeline
}

func (s *timelineSink) WriteAudio(chunk speech.TtsAudioChunk) error {
	s.timeline.record("voice-write")
	return nil
}
func (s *timelineSink) EndTurn() error {
	s.timeline.record("voice-end")
	return nil
}
func (s *timelineSink) CancelTurn() error {
	s.timeline.record("voice-cancel")
	return nil
}
func (s *timelineSink) Close() error { return nil }

type timelineTtsProvider struct{}

func (*timelineTtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return &timelineTtsSession{}, nil
}

type timelineTtsSession struct{}

func (s *timelineTtsSession) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	// Slow enough to observe ordering, fast enough for the test budget.
	for i := 0; i < 3; i++ {
		if err := emit(speech.TtsAudioChunk{Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: make([]byte, 32)}); err != nil {
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}

func (s *timelineTtsSession) Close() error { return nil }

// fakeVoiceSource injects a real Speaker behind the runtime voice boundary.
type fakeVoiceSource struct {
	speaker *voice.Speaker
}

func (f *fakeVoiceSource) CurrentVoiceOutput() *voice.Speaker { return f.speaker }

func TestVoiceDispatchOrderTextPersistedBeforeSpeak(t *testing.T) {
	timeline := &orderedTimeline{}
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	// Record text sends on the shared timeline.
	client.sendHook = func(text string) { timeline.record("text-sent:" + text) }

	speaker := voice.NewSpeaker(voice.Options{
		Provider: &timelineTtsProvider{},
		CreateSink: func() (voice.Sink, error) {
			return &timelineSink{timeline: timeline}, nil
		},
	})
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-voice-order", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	rt.voiceSrc = &fakeVoiceSource{speaker: speaker}

	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return timeline.contains("voice-write") }, "voice write")
	rt.Stop()
	_ = speaker.Close()

	events := timeline.snapshot()
	sentAt, wroteAt := -1, -1
	for index, event := range events {
		if event == "text-sent:reply-1" && sentAt == -1 {
			sentAt = index
		}
		if event == "voice-write" && wroteAt == -1 {
			wroteAt = index
		}
	}
	if sentAt == -1 || wroteAt == -1 {
		t.Fatalf("both events must occur: %v", events)
	}
	if sentAt >= wroteAt {
		t.Fatalf("text must be persisted BEFORE any voice write: %v", events)
	}
}

func TestNewAddressedTurnCancelsStaleVoiceBeforeHarnessTurn(t *testing.T) {
	timeline := &orderedTimeline{}
	client := &fakeClient{}
	// Two addressed events in separate waits, the second GATED until the
	// first turn's voice drain has created its sink: the second turn must
	// cancel stale speech at the sink level BEFORE its own text reply.
	secondGate := make(chan struct{})
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
		{events: []types.RoomEvent{roomEvent(2, true)}, gate: secondGate},
	}
	client.sendHook = func(text string) { timeline.record("text-sent:" + text) }
	speaker := voice.NewSpeaker(voice.Options{
		Provider: &timelineTtsProvider{},
		CreateSink: func() (voice.Sink, error) {
			return &timelineSink{timeline: timeline}, nil
		},
	})
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-voice-cancel", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	rt.voiceSrc = &fakeVoiceSource{speaker: speaker}

	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return timeline.contains("voice-write") }, "first turn speaking")
	close(secondGate)
	waitFor(t, 2*time.Second, func() bool { return timeline.contains("text-sent:reply-2") }, "two replies")
	rt.Stop()
	_ = speaker.Close()

	if !timeline.contains("voice-cancel") {
		t.Fatalf("a new addressed turn must cancel stale voice: %v", timeline.snapshot())
	}
	events := timeline.snapshot()
	cancelAt, secondTextAt := -1, -1
	for index, event := range events {
		if event == "voice-cancel" && cancelAt == -1 {
			cancelAt = index
		}
		if event == "text-sent:reply-2" && secondTextAt == -1 {
			secondTextAt = index
		}
	}
	if cancelAt == -1 || secondTextAt == -1 || cancelAt >= secondTextAt {
		t.Fatalf("stale voice must be cancelled BEFORE the new turn's text reply: %v", events)
	}
}
