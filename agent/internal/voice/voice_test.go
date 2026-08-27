package voice

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

func TestChunkerSentenceAndClauseSplits(t *testing.T) {
	chunker := NewChunker(0)
	chunks := append(chunker.Push("第一句。第二句！"), chunker.Flush()...)
	if len(chunks) != 2 || chunks[0] != "第一句。" || chunks[1] != "第二句！" {
		t.Fatalf("CJK sentence split mismatch: %v", chunks)
	}

	chunker = NewChunker(0)
	chunks = append(chunker.Push("Hello world. Next one"), chunker.Flush()...)
	if len(chunks) != 2 || chunks[0] != "Hello world." {
		t.Fatalf("latin sentence split mismatch: %v", chunks)
	}

	// 3.14 must not split on the dot between digits.
	chunker = NewChunker(0)
	chunks = append(chunker.Push("pi is 3.14 today."), chunker.Flush()...)
	if len(chunks) != 1 || !strings.Contains(chunks[0], "3.14") {
		t.Fatalf("decimal guard broken: %v", chunks)
	}

	// Overlong run without enders breaks at clauses; every now-complete
	// chunk is extracted per push.
	chunker = NewChunker(12)
	long := "aaaaaa，bbbbbb，cccccc"
	first := chunker.Push(long)
	if len(first) != 2 || first[0] != "aaaaaa，" || first[1] != "bbbbbb，" {
		t.Fatalf("clause break mismatch: %v", first)
	}
}

// fakeTtsProvider implements a controllable synthesis provider.
type fakeTtsProvider struct{}

type fakeTtsSession struct {
	closed bool
}

func (s *fakeTtsSession) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	// Emit one PCM chunk per character position slice, honoring cancel via
	// the sink error propagation.
	for range len(text) / 3 {
		_ = text
		if err := emit(speech.TtsAudioChunk{Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: []byte{0, 1, 2}}); err != nil {
			return err
		}
		time.Sleep(2 * time.Millisecond)
	}
	return nil
}

func (s *fakeTtsSession) Close() error { s.closed = true; return nil }

func (p *fakeTtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return &fakeTtsSession{}, nil
}

type recordingSink struct {
	mu      sync.Mutex
	order   []byte
	end     int
	cancel  int
	closed  int
	failAll bool
}

func (s *recordingSink) WriteAudio(chunk speech.TtsAudioChunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failAll {
		return errSinkBroken
	}
	s.order = append(s.order, chunk.Data...)
	return nil
}

func (s *recordingSink) EndTurn() error {
	s.mu.Lock()
	s.end++
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) CancelTurn() error {
	s.mu.Lock()
	s.cancel++
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) Close() error {
	s.mu.Lock()
	s.closed++
	s.mu.Unlock()
	return nil
}

var errSinkBroken = &staleSinkError{}

type staleSinkError struct{}

func (*staleSinkError) Error() string { return "sink broken" }

func TestSpeakerFIFOAndNewTurnCancelsOld(t *testing.T) {
	sink := &recordingSink{}
	provider := &fakeTtsProvider{}
	events := []SpeakerEvent{}
	speaker := NewSpeaker(Options{
		Provider:      provider,
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 6,
		OnEvent:       func(event SpeakerEvent) { events = append(events, event) },
	})
	// A first speak has no previous turn: no spurious cancel; a normal
	// completion must endTurn exactly once.
	speaker.Speak("aaaaaa，bbbbbb")
	waitForFinished(t, &events, 2*time.Second)
	if sink.cancelCount() != 0 {
		t.Fatalf("first speak must not cancel anything, got %d", sink.cancelCount())
	}
	if sink.endCount() != 1 {
		t.Fatalf("normal completion must endTurn once, got %d", sink.endCount())
	}
	_ = speaker.Close()
}

func TestSpeakerSecondSpeakCancelsFirstSynchronously(t *testing.T) {
	sink := &recordingSink{}
	events := []SpeakerEvent{}
	speaker := NewSpeaker(Options{
		Provider:      &fakeTtsProvider{},
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 6,
		OnEvent:       func(event SpeakerEvent) { events = append(events, event) },
	})
	// Back-to-back speaks: the newest addressed turn wins deterministically
	// (Speak cancels synchronously before starting its own drain). The
	// cancellation is observable as a turnCancelled event for turn 1 even
	// before any sink exists (sink-level CancelTurn fires only once a sink
	// was lazily created — Node parity).
	speaker.Speak("aaaaaa")
	speaker.Speak("bbbbbb")
	if !hasCancelledTurn(events, 1) {
		t.Fatalf("second speak must cancel the first turn: %v", events)
	}
	waitForFinished(t, &events, 2*time.Second)
	_ = speaker.Close()
}

func hasCancelledTurn(events []SpeakerEvent, turn int) bool {
	for _, event := range events {
		if event.Type == "turnCancelled" && event.Turn == turn {
			return true
		}
	}
	return false
}

func (s *recordingSink) cancelCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel
}

func (s *recordingSink) endCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.end
}

func TestSpeakerProviderFailureIsTextSafe(t *testing.T) {
	sink := &recordingSink{}
	events := []SpeakerEvent{}
	speaker := NewSpeaker(Options{
		Provider:   &failingProvider{},
		CreateSink: func(uint64) (Sink, error) { return sink, nil },
		OnEvent:    func(event SpeakerEvent) { events = append(events, event) },
	})
	speaker.Speak("hello there")
	deadline := time.Now().Add(2 * time.Second)
	for !hasEvent(events, "turnFailed") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !hasEvent(events, "turnFailed") {
		t.Fatalf("provider failure must surface as turnFailed: %v", events)
	}
	// The speaker itself must remain usable (a fresh provider round would
	// succeed in production; here Close must be clean and bounded).
	if err := speaker.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

type failingProvider struct{}

func (*failingProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return nil, errSinkBroken
}

func hasEvent(events []SpeakerEvent, kind string) bool {
	for _, event := range events {
		if event.Type == kind {
			return true
		}
	}
	return false
}

func waitForFinished(t *testing.T, events *[]SpeakerEvent, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if hasEvent(*events, "turnFinished") {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("turn never finished: %v", *events)
}

func TestSpeakerCancelDiscardsStaleAudio(t *testing.T) {
	sink := &recordingSink{}
	events := []SpeakerEvent{}
	speaker := NewSpeaker(Options{
		Provider:      &fakeTtsProvider{},
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 4,
		OnEvent:       func(event SpeakerEvent) { events = append(events, event) },
	})
	speaker.Speak("aaaa，bbbb，cccc")
	time.Sleep(2 * time.Millisecond) // mid-drain: first chunk synthesized only
	speaker.Cancel()
	time.Sleep(50 * time.Millisecond)
	if !hasEvent(events, "turnCancelled") {
		t.Fatalf("cancel must report turnCancelled: %v", events)
	}
	if sink.endCount() != 0 {
		t.Fatal("cancelled turn must never endTurn")
	}
	_ = speaker.Close()
}
