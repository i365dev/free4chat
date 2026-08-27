package voice

import (
	"sync"
	"unicode"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

// Sink is the outbound audio destination (the shared media bridge in
// production). Awaiting WriteAudio is the pipeline's backpressure boundary;
// EndTurn flushes a normally completed utterance tail; CancelTurn discards
// partial buffered audio so stale PCM can never leak into later turns.
type Sink interface {
	WriteAudio(chunk speech.TtsAudioChunk) error
	EndTurn() error
	CancelTurn() error
	Close() error
}

// SpeakerEvent is one bounded voice lifecycle counter event.
type SpeakerEvent struct {
	Type          string // turnStarted|turnFinished|turnCancelled|turnTruncated|turnFailed
	Turn          int
	Chunks        int
	Frames        int
	DroppedChunks int
	Code          string
}

// Options configures a Speaker.
type Options struct {
	Provider        speech.StreamingTtsProvider
	CreateSink      func() (Sink, error)
	MaxQueuedChunks int
	MaxChunkChars   int
	OnEvent         func(SpeakerEvent)
}

// Speaker is the runtime-owned bridge between response text and the
// outbound audio track. Deterministic guarantees, ported from the frozen
// Node VoiceSpeaker:
//   - ordering: one consumer drains buffered chunks strictly FIFO;
//   - backpressure: every sink write is awaited before more synthesis, and
//     buffered text is bounded (overlong responses are truncated);
//   - stale cancellation: Speak implicitly cancels an unfinished earlier
//     turn (the newest addressed turn wins); Cancel stops current and
//     queued audio immediately.
//
// Spoken text and audio are never persisted or logged.
type Speaker struct {
	provider        speech.StreamingTtsProvider
	createSink      func() (Sink, error)
	maxQueuedChunks int
	maxChunkChars   int
	onEvent         func(SpeakerEvent)

	mu             sync.Mutex
	pending        []string
	epoch          int
	turnCounter    int
	lastStarted    int
	lastStartedSet bool
	stopped        bool
	sink           Sink
	sinkBroken     bool
	draining       bool
	drainDone      chan struct{}
}

// NewSpeaker builds an idle speaker.
func NewSpeaker(options Options) *Speaker {
	maxQueued := options.MaxQueuedChunks
	if maxQueued <= 0 {
		// Long replies (jokes, paragraphs) span many sentence chunks; 64
		// keeps the bound meaningful (≈14k chars) while letting complete
		// replies speak fully instead of truncating mid-answer.
		maxQueued = 64
	}
	onEvent := options.OnEvent
	if onEvent == nil {
		onEvent = func(SpeakerEvent) {}
	}
	return &Speaker{
		provider:        options.Provider,
		createSink:      options.CreateSink,
		maxQueuedChunks: maxQueued,
		maxChunkChars:   options.MaxChunkChars,
		onEvent:         onEvent,
	}
}

// Speak enqueues one complete response as a new voice turn; any unfinished
// earlier turn is cancelled first. No-op after Close.
func (s *Speaker) Speak(text string) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.cancelLocked()
	turn := s.turnCounter + 1
	s.turnCounter = turn
	chunker := NewChunker(s.maxChunkChars)
	chunks := append(chunker.Push(text), chunker.Flush()...)
	filtered := chunks[:0]
	for _, chunk := range chunks {
		// Skip punctuation-only pieces: Doubao TTS rejects them with
		// "No readable text!", which aborts the whole turn and truncates
		// audible speech mid-reply.
		if chunk != "" && containsReadable(chunk) {
			filtered = append(filtered, chunk)
		}
	}
	chunks = filtered
	if len(chunks) == 0 {
		s.mu.Unlock()
		return
	}
	if len(chunks) > s.maxQueuedChunks {
		dropped := len(chunks) - s.maxQueuedChunks
		chunks = chunks[:s.maxQueuedChunks]
		s.onEventUnlocked(SpeakerEvent{Type: "turnTruncated", Turn: turn, DroppedChunks: dropped})
	}
	s.pending = append(s.pending, chunks...)
	s.lastStarted = turn
	s.lastStartedSet = true
	s.onEventUnlocked(SpeakerEvent{Type: "turnStarted", Turn: turn})
	s.mu.Unlock()
	s.startDrain()
}

// Cancel stops current and queued audio immediately, discarding partial
// sink carry via CancelTurn. Safe to call repeatedly.
func (s *Speaker) Cancel() {
	s.mu.Lock()
	s.cancelLocked()
	s.mu.Unlock()
}

func (s *Speaker) cancelLocked() {
	if len(s.pending) == 0 && !s.draining {
		return
	}
	s.epoch++
	s.pending = nil
	sink := s.sink
	if sink != nil {
		_ = sink.CancelTurn()
	}
	if s.lastStartedSet {
		s.onEventUnlocked(SpeakerEvent{Type: "turnCancelled", Turn: s.lastStarted})
	}
}

func (s *Speaker) onEventUnlocked(event SpeakerEvent) {
	onEvent := s.onEvent
	// called under mu; fire synchronously like the Node reference
	onEvent(event)
}

// Close cancels speech, waits for the pipeline to unwind, and closes the
// outbound sink. Further Speak calls are ignored.
func (s *Speaker) Close() error {
	s.mu.Lock()
	s.stopped = true
	s.epoch++
	s.pending = nil
	done := s.drainDone
	sink := s.sink
	s.sink = nil
	s.mu.Unlock()
	if done != nil {
		<-done
	}
	if sink != nil {
		return sink.Close()
	}
	return nil
}

func (s *Speaker) startDrain() {
	s.mu.Lock()
	if s.draining {
		s.mu.Unlock()
		return
	}
	s.draining = true
	done := make(chan struct{})
	s.drainDone = done
	s.mu.Unlock()
	go func() {
		s.drain()
		s.mu.Lock()
		s.draining = false
		s.drainDone = nil
		restart := !s.stopped && len(s.pending) > 0
		s.mu.Unlock()
		close(done)
		if restart {
			s.startDrain()
		}
	}()
}

func (s *Speaker) drain() {
	s.mu.Lock()
	epoch := s.epoch
	s.mu.Unlock()

	var session speech.StreamingTtsSession
	chunks := 0
	frames := 0
	failed := false
	code := ""

	for {
		s.mu.Lock()
		if s.stopped || s.epoch != epoch || len(s.pending) == 0 {
			s.mu.Unlock()
			break
		}
		chunk := s.pending[0]
		s.pending = s.pending[1:]
		s.mu.Unlock()

		if session == nil {
			created, err := s.provider.CreateSession()
			if err != nil {
				failed = true
				code = trim160(err.Error())
				break
			}
			session = created
		}
		s.mu.Lock()
		stillCurrent := !s.stopped && s.epoch == epoch
		s.mu.Unlock()
		if !stillCurrent {
			break
		}
		err := session.Synthesize(chunk, func(audio speech.TtsAudioChunk) error {
			s.mu.Lock()
			current := !s.stopped && s.epoch == epoch
			s.mu.Unlock()
			if !current {
				return errStaleTurn
			}
			sink, sinkErr := s.ensureSink()
			if sinkErr != nil {
				return sinkErr
			}
			if writeErr := sink.WriteAudio(audio); writeErr != nil {
				return writeErr
			}
			frames++
			return nil
		})
		if err != nil {
			if err == errStaleTurn {
				break
			}
			s.mu.Lock()
			s.sinkBroken = true
			s.mu.Unlock()
			failed = true
			code = trim160(err.Error())
			break
		}
		chunks++
	}

	s.mu.Lock()
	current := !s.stopped && s.epoch == epoch
	s.mu.Unlock()
	if current && !failed {
		s.mu.Lock()
		sink := s.sink
		started := s.lastStartedSet
		turn := s.lastStarted
		s.mu.Unlock()
		if sink != nil && frames > 0 {
			if err := sink.EndTurn(); err != nil {
				failed = true
				code = trim160(err.Error())
			}
		}
		if !failed && started {
			s.onEvent(SpeakerEvent{Type: "turnFinished", Turn: turn, Chunks: chunks, Frames: frames})
		}
	}
	if failed {
		s.mu.Lock()
		turn := s.lastStarted
		s.mu.Unlock()
		s.onEvent(SpeakerEvent{Type: "turnFailed", Turn: turn, Code: code})
	}
	if session != nil {
		_ = session.Close()
	}
}

var errStaleTurn = &staleTurnError{}

type staleTurnError struct{}

func (*staleTurnError) Error() string { return "stale voice turn" }

func (s *Speaker) ensureSink() (Sink, error) {
	s.mu.Lock()
	if s.sink != nil && !s.sinkBroken {
		sink := s.sink
		s.mu.Unlock()
		return sink, nil
	}
	s.mu.Unlock()
	sink, err := s.createSink()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.sink = sink
	s.sinkBroken = false
	s.mu.Unlock()
	return sink, nil
}

// containsReadable reports whether a chunk has any letter/digit/mark —
// punctuation-only pieces are unreadable to TTS providers.
func containsReadable(text string) bool {
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			return true
		}
	}
	return false
}

func trim160(text string) string {
	if len(text) > 160 {
		return text[:160]
	}
	return text
}
