package voice

import (
	"context"
	"sync"
	"unicode"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"time"
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
	Provider speech.StreamingTtsProvider
	// CreateSink receives the TURN TOKEN: every sink instance is bound to
	// exactly one turn, so a stale TTS callback that survives its own
	// cancel is rejected at the engine's turn admission.
	CreateSink      func(token uint64) (Sink, error)
	MaxQueuedChunks int
	MaxChunkChars   int
	// Gate spans provider synthesis through final audible flush. A nil gate
	// gives a direct/test Runtime its own gate.
	Gate Gate
	// GateHoldDeadline bounds ONE complete gate-held audible turn
	// (#228 D): acquisition → synthesis → publication writes → flush. When
	// the deadline fires the speaker cancels the current turn (invalidating
	// stale callbacks/audio) so the gate is released and the next turn can
	// proceed. Zero = default (120s).
	GateHoldDeadline time.Duration
	OnEvent          func(SpeakerEvent)
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
	createSink      func(token uint64) (Sink, error)
	maxQueuedChunks int
	maxChunkChars   int
	onEvent         func(SpeakerEvent)
	gate            Gate
	gateHold        time.Duration

	mu             sync.Mutex
	pending        []string
	epoch          int
	turnCounter    int
	lastStarted    int
	lastStartedSet bool
	stopped        bool
	sink           Sink
	sinkTurn       uint64
	sinkBroken     bool
	draining       bool
	drainDone      chan struct{}
	drainCancel    context.CancelFunc
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
	gate := options.Gate
	gateHold := options.GateHoldDeadline
	if gateHold <= 0 {
		gateHold = 120 * time.Second
	}
	if gate == nil {
		gate = NewGate()
	}
	return &Speaker{
		provider:        options.Provider,
		createSink:      options.CreateSink,
		maxQueuedChunks: maxQueued,
		maxChunkChars:   options.MaxChunkChars,
		onEvent:         onEvent,
		gate:            gate,
		gateHold:        gateHold,
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
	cancelAction := s.cancelLocked()
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
	if cancelAction != nil {
		cancelAction() // sink/engine writes run outside the lock
	}
	s.startDrain()
}

// Cancel stops current and queued audio immediately, discarding partial
// sink carry via CancelTurn. Safe to call repeatedly.
func (s *Speaker) Cancel() {
	s.mu.Lock()
	action := s.cancelLocked()
	s.mu.Unlock()
	if action != nil {
		action()
	}
}

// cancelLocked mutates the speaker state under s.mu (caller-held) and
// RETURNS the sink-cancellation action to execute OUTSIDE the lock —
// Speaker.mu is never held across sink/engine writes.
func (s *Speaker) cancelLocked() func() {
	if len(s.pending) == 0 && !s.draining {
		return nil
	}
	s.epoch++
	s.pending = nil
	// The cancelled turn's token must reach the engine even when its sink
	// does not exist yet — and even when a STALE cached sink from an older
	// completed turn is still cached (sinkTurn != token): a delayed TTS
	// callback that passed its epoch check before this cancel and writes
	// after it must be rejected at the engine's turn admission.
	token := uint64(0)
	if s.lastStartedSet {
		token = uint64(s.lastStarted)
	}
	drainCancel := s.drainCancel
	var action func()
	sink := s.sink
	sinkTurn := s.sinkTurn
	if sink != nil && sinkTurn == token {
		bound := sink
		action = func() { _ = bound.CancelTurn() }
	} else if token != 0 {
		// Throwaway turn-bound sink solely to invalidate the token at the
		// engine (sink construction is a cheap local adapter).
		action = func() {
			if created, err := s.createSink(token); err == nil {
				_ = created.CancelTurn()
				_ = created.Close()
			}
		}
	}
	if s.lastStartedSet {
		s.onEventUnlocked(SpeakerEvent{Type: "turnCancelled", Turn: s.lastStarted})
	}
	if drainCancel == nil {
		return action
	}
	return func() {
		drainCancel()
		if action != nil {
			action()
		}
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
	cancel := s.drainCancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
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
	ctx, cancel := context.WithCancel(context.Background())
	s.drainDone = done
	s.drainCancel = cancel
	s.mu.Unlock()
	go func() {
		s.drain(ctx)
		s.mu.Lock()
		s.draining = false
		s.drainDone = nil
		s.drainCancel = nil
		restart := !s.stopped && len(s.pending) > 0
		s.mu.Unlock()
		close(done)
		if restart {
			s.startDrain()
		}
	}()
}

func (s *Speaker) drain(ctx context.Context) {
	release, err := s.gate.Acquire(ctx)
	if err != nil {
		return
	}
	// #228 D: Runtime-owned deadline for one complete gate-held turn
	// (acquisition → synthesis → publication writes → flush). When the
	// deadline fires, Cancel() invalidates the in-flight turn (stale
	// callbacks/audio) and the gate is released immediately so the next
	// turn can acquire it — a hung provider/sink can never monopolize the
	// host. The gate release is once-guarded: the stuck drain's own exit
	// becomes a no-op.
	var releaseOnce sync.Once
	releaseGate := func() { releaseOnce.Do(release) }
	defer releaseGate()
	watchdog := time.AfterFunc(s.gateHold, func() {
		s.Cancel()
		releaseGate()
	})
	defer watchdog.Stop()
	s.mu.Lock()
	epoch := s.epoch
	s.mu.Unlock()

	var session speech.StreamingTtsSession
	chunks := 0
	frames := 0
	failed := false
	code := ""
	turnToken := uint64(0)

	for {
		s.mu.Lock()
		if s.stopped || s.epoch != epoch || len(s.pending) == 0 {
			s.mu.Unlock()
			break
		}
		chunk := s.pending[0]
		s.pending = s.pending[1:]
		turnToken = uint64(s.turnCounter)
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
			sink, sinkErr := s.ensureSink(turnToken)
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

// ensureSink returns the sink bound to exactly ONE turn: a different turn
// gets a fresh sink (the engine's admission keys on the turn token).
func (s *Speaker) ensureSink(turn uint64) (Sink, error) {
	s.mu.Lock()
	if s.sink != nil && !s.sinkBroken && s.sinkTurn == turn {
		sink := s.sink
		s.mu.Unlock()
		return sink, nil
	}
	s.mu.Unlock()
	sink, err := s.createSink(turn)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.sink = sink
	s.sinkTurn = turn
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
