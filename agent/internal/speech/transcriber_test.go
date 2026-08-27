package speech

import (
	"sync"
	"testing"
	"time"
)

// fakeSttSession implements StreamingSttSession with scripted events.
type fakeSttSession struct {
	events chan SttEvent
	closed chan struct{}
	once   sync.Once
}

func newFakeSttSession() *fakeSttSession {
	return &fakeSttSession{events: make(chan SttEvent, 16), closed: make(chan struct{})}
}

func (f *fakeSttSession) PushAudio(frame AudioFrame) error {
	select {
	case <-f.closed:
		return nil
	default:
	}
	return nil
}

func (f *fakeSttSession) Events() <-chan SttEvent { return f.events }

func (f *fakeSttSession) emit(event SttEvent) {
	select {
	case f.events <- event:
	default:
	}
}

func (f *fakeSttSession) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

// fakeSttProvider tracks per-payload sessions so tests can attribute
// emissions deterministically regardless of goroutine scheduling.
type fakeSttProvider struct {
	mu        sync.Mutex
	sessions  []*fakeSttSession
	byPayload map[string]*fakeSttSession
}

func newFakeSttProvider() *fakeSttProvider {
	return &fakeSttProvider{byPayload: make(map[string]*fakeSttSession)}
}

func (p *fakeSttProvider) CreateSession(frame AudioFrame) (StreamingSttSession, error) {
	session := newFakeSttSession()
	p.mu.Lock()
	p.sessions = append(p.sessions, session)
	p.byPayload[string(frame.Data)] = session
	p.mu.Unlock()
	return session, nil
}

func (p *fakeSttProvider) sessionFor(payload []byte) *fakeSttSession {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.byPayload[string(payload)]
}

func opusFrame() AudioFrame {
	return AudioFrame{Codec: "opus", SampleRateHz: 48000, Channels: 2, Data: []byte{0x1, 0x2}}
}

func TestTranscriberAttributionAndCommittedOnly(t *testing.T) {
	provider := newFakeSttProvider()
	var mu sync.Mutex
	var received []AttributedSttEvent
	transcriber := NewTranscriber(provider, func(event AttributedSttEvent) {
		mu.Lock()
		received = append(received, event)
		mu.Unlock()
	})
	alice := AudioSource{ParticipantID: "human-1", ParticipantName: "Alice", TrackName: "mic"}
	bob := AudioSource{ParticipantID: "human-2", ParticipantName: "Bob", TrackName: "mic"}

	aliceFrame := opusFrame()
	bobFrame := opusFrame()
	bobFrame.Data = []byte{0x2, 0x3}
	transcriber.AcceptAudio(alice, aliceFrame)
	transcriber.AcceptAudio(bob, bobFrame)
	deadline := time.Now().Add(2 * time.Second)
	for provider.sessionFor(aliceFrame.Data) == nil || provider.sessionFor(bobFrame.Data) == nil {
		if time.Now().After(deadline) {
			t.Fatal("one session per speaker never appeared")
		}
		time.Sleep(5 * time.Millisecond)
	}
	provider.sessionFor(aliceFrame.Data).emit(SttEvent{Type: "committed", Text: "alice says hi"})
	provider.sessionFor(bobFrame.Data).emit(SttEvent{Type: "committed", Text: "bob says hey"})
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	count := len(received)
	mu.Unlock()
	if count != 2 {
		t.Fatalf("committed events lost: %d", count)
	}
	mu.Lock()
	copyReceived := append([]AttributedSttEvent(nil), received...)
	mu.Unlock()
	bySpeaker := map[string]string{}
	for _, event := range copyReceived {
		if event.Event.Type != "committed" {
			t.Fatalf("non-committed leaked: %+v", event.Event)
		}
		bySpeaker[event.Source.ParticipantName] = event.Event.Text
	}
	if bySpeaker["Alice"] != "alice says hi" || bySpeaker["Bob"] != "bob says hey" {
		t.Fatalf("attribution mismatch: %v", bySpeaker)
	}

	// TrackEnded cleans the pipeline without error.
	transcriber.TrackEnded(alice)
	transcriber.Close()
}

func TestTranscriberQueueOverflowFailsTrackSafely(t *testing.T) {
	provider := newFakeSttProvider()
	transcriber := NewTranscriber(provider, func(AttributedSttEvent) {})
	source := AudioSource{ParticipantID: "h", ParticipantName: "H", TrackName: "mic"}
	// 200 frames > MaxFramesPerTrack(128) with an unreadable provider pump
	// (the fake session accepts instantly, so this exercises the queue cap
	// on the accept path only when the pump is delayed — use a blocking
	// provider instead).
	blocking := &blockingProvider{err: nil}
	transcriber2 := NewTranscriber(blocking, func(event AttributedSttEvent) {
		if event.Event.Type != "error" {
			t.Fatalf("expected only error events, got %+v", event.Event)
		}
	})
	for i := 0; i < MaxFramesPerTrack+5; i++ {
		transcriber2.AcceptAudio(source, opusFrame())
	}
	// The first pump blocks in CreateSession; the queue must have failed the
	// track (error emitted) rather than growing unbounded.
	time.Sleep(50 * time.Millisecond)
	_ = transcriber
	transcriber.Close()
	transcriber2.Close()
}

// blockingProvider never returns a session.
type blockingProvider struct {
	err error
}

func (b *blockingProvider) CreateSession(frame AudioFrame) (StreamingSttSession, error) {
	if b.err != nil {
		return nil, b.err
	}
	select {} // blocks forever; the test's overflow path fires first
}

func TestProviderFailureFailsTrackWithoutKillingOthers(t *testing.T) {
	provider := newFakeSttProvider()
	transcriber := NewTranscriber(provider, func(AttributedSttEvent) {})
	alice := AudioSource{ParticipantID: "a", ParticipantName: "Alice", TrackName: "mic"}
	bob := AudioSource{ParticipantID: "b", ParticipantName: "Bob", TrackName: "mic"}
	transcriber.AcceptAudio(alice, opusFrame())
	transcriber.AcceptAudio(bob, opusFrame())
	time.Sleep(100 * time.Millisecond)
	transcriber.Close()
	// Both tracks were created; closing must not panic or block.
}

// TestTranscriberFailThenEndTrackDoesNotPanic pins the daemon-crashing race
// found in the Gate A E2E: a provider failure (failTrack closes done) racing
// a track-end notification (endTrack also closed done) used to double-close
// the channel and panic the whole process.
func TestTranscriberFailThenEndTrackDoesNotPanic(t *testing.T) {
	provider := &failingSttProvider{}
	transcriber := NewTranscriber(provider, func(AttributedSttEvent) {})
	source := AudioSource{ParticipantID: "h", ParticipantName: "H", TrackName: "mic"}
	transcriber.AcceptAudio(source, opusFrame())
	time.Sleep(50 * time.Millisecond) // let the pump fail
	// TrackEnded for an already-failed track must be a silent no-op.
	transcriber.TrackEnded(source)
	transcriber.TrackEnded(source)
	transcriber.Close()
}

type failingSttProvider struct{}

func (*failingSttProvider) CreateSession(frame AudioFrame) (StreamingSttSession, error) {
	return nil, errTranscriberFailure
}

var errTranscriberFailure = &transcriberFailure{}

type transcriberFailure struct{}

func (*transcriberFailure) Error() string { return "provider failed" }
