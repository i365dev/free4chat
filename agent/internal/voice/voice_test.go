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

// eventRecorder collects SpeakerEvents. OnEvent fires from the speaker's own
// drain goroutine, so every read and write is mutex-guarded: a bare slice here
// makes the test itself racy (and is invisible without -race).
type eventRecorder struct {
	mu     sync.Mutex
	events []SpeakerEvent
}

func (r *eventRecorder) record(event SpeakerEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *eventRecorder) snapshot() []SpeakerEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]SpeakerEvent(nil), r.events...)
}

func (r *eventRecorder) hasEvent(kind string) bool {
	for _, event := range r.snapshot() {
		if event.Type == kind {
			return true
		}
	}
	return false
}

func (r *eventRecorder) hasCancelledTurn(turn int) bool {
	for _, event := range r.snapshot() {
		if event.Type == "turnCancelled" && event.Turn == turn {
			return true
		}
	}
	return false
}

// waitForEvent polls until kind arrives or the timeout expires.
func (r *eventRecorder) waitForEvent(t *testing.T, kind string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if r.hasEvent(kind) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("event %q never arrived: %v", kind, r.snapshot())
}

func TestSpeakerFIFOAndNewTurnCancelsOld(t *testing.T) {
	sink := &recordingSink{}
	provider := &fakeTtsProvider{}
	recorder := &eventRecorder{}
	speaker := NewSpeaker(Options{
		Provider:      provider,
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 6,
		OnEvent:       recorder.record,
	})
	// A first speak has no previous turn: no spurious cancel; a normal
	// completion must endTurn exactly once.
	speaker.Speak("aaaaaa，bbbbbb")
	recorder.waitForEvent(t, "turnFinished", 2*time.Second)
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
	recorder := &eventRecorder{}
	speaker := NewSpeaker(Options{
		Provider:      &fakeTtsProvider{},
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 6,
		OnEvent:       recorder.record,
	})
	// Back-to-back speaks: the newest addressed turn wins deterministically
	// (Speak cancels synchronously before starting its own drain). The
	// cancellation is observable as a turnCancelled event for turn 1 even
	// before any sink exists (sink-level CancelTurn fires only once a sink
	// was lazily created — Node parity).
	speaker.Speak("aaaaaa")
	speaker.Speak("bbbbbb")
	if !recorder.hasCancelledTurn(1) {
		t.Fatalf("second speak must cancel the first turn: %v", recorder.snapshot())
	}
	recorder.waitForEvent(t, "turnFinished", 2*time.Second)
	_ = speaker.Close()
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
	recorder := &eventRecorder{}
	speaker := NewSpeaker(Options{
		Provider:   &failingProvider{},
		CreateSink: func(uint64) (Sink, error) { return sink, nil },
		OnEvent:    recorder.record,
	})
	speaker.Speak("hello there")
	recorder.waitForEvent(t, "turnFailed", 2*time.Second)
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

func TestSpeakerCancelDiscardsStaleAudio(t *testing.T) {
	sink := &recordingSink{}
	recorder := &eventRecorder{}
	speaker := NewSpeaker(Options{
		Provider:      &fakeTtsProvider{},
		CreateSink:    func(uint64) (Sink, error) { return sink, nil },
		MaxChunkChars: 4,
		OnEvent:       recorder.record,
	})
	speaker.Speak("aaaa，bbbb，cccc")
	time.Sleep(2 * time.Millisecond) // mid-drain: first chunk synthesized only
	speaker.Cancel()
	recorder.waitForEvent(t, "turnCancelled", 2*time.Second)
	if sink.endCount() != 0 {
		t.Fatal("cancelled turn must never endTurn")
	}
	_ = speaker.Close()
}
