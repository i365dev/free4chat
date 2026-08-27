package speech

import (
	"sync"
)

const (
	// MaxFramesPerTrack keeps bounded headroom for provider handshake
	// latency (mirrors the frozen Node bound of 128 RTP frames).
	MaxFramesPerTrack = 128
)

// TrackState is one per-speaker pipeline.
type trackState struct {
	source   AudioSource
	frames   []AudioFrame
	session  StreamingSttSession
	done     chan struct{}
	doneOnce sync.Once
	stopped  bool
	failed   bool
	pumping  bool
}

// closeDone closes the done channel exactly once: both the endTrack and
// failTrack teardown paths race in production (a provider failure can land
// between a track-end notification and the pipeline drain), and a second
// close would panic the whole daemon.
func (s *trackState) closeDone() {
	s.doneOnce.Do(func() { close(s.done) })
}

// Transcriber is the runtime-owned adapter between raw SFU audio and
// provider sessions. Speaker attribution and lifecycle live here; providers
// only see audio frames, never room participants.
type Transcriber struct {
	provider          StreamingSttProvider
	onEvent           AttributedSttHandler
	maxFramesPerTrack int

	mu     sync.Mutex
	tracks map[string]*trackState
	closed bool
}

// NewTranscriber builds an idle transcriber.
func NewTranscriber(provider StreamingSttProvider, onEvent AttributedSttHandler) *Transcriber {
	return &Transcriber{
		provider:          provider,
		onEvent:           onEvent,
		maxFramesPerTrack: MaxFramesPerTrack,
		tracks:            make(map[string]*trackState),
	}
}

func trackKey(source AudioSource) string {
	return source.ParticipantID + ":" + source.TrackName
}

// AcceptAudio hands one SFU audio frame to the right per-speaker pipeline.
// Non-blocking by design: frames queue behind a bounded buffer; the RTP
// callback never awaits network I/O.
func (t *Transcriber) AcceptAudio(source AudioSource, frame AudioFrame) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	key := trackKey(source)
	state := t.tracks[key]
	if state == nil {
		state = &trackState{
			source: AudioSource{
				ParticipantID:   source.ParticipantID,
				ParticipantName: source.ParticipantName,
				TrackName:       source.TrackName,
			},
			done: make(chan struct{}),
		}
		t.tracks[key] = state
	}
	if state.stopped || state.failed {
		t.mu.Unlock()
		return
	}
	if len(state.frames) >= t.maxFramesPerTrack {
		t.mu.Unlock()
		t.failTrack(state, SttError{Code: "audio_queue_overflow", Message: "Speech audio queue is full"})
		return
	}
	copied := frame
	copied.Data = append([]byte(nil), frame.Data...)
	state.frames = append(state.frames, copied)
	shouldPump := !state.pumping
	state.pumping = true
	t.mu.Unlock()

	if shouldPump {
		go t.pump(state)
	}
}

// TrackStarted/TrackEnded mirror the frozen media-event wiring: a fresh
// audioTrackStarted for the same key ends the old pipeline first.
func (t *Transcriber) TrackStarted(source AudioSource) {
	t.endTrack(source.ParticipantID + ":" + source.TrackName)
}

func (t *Transcriber) TrackEnded(source AudioSource) {
	t.endTrack(source.ParticipantID + ":" + source.TrackName)
}

// Close shuts every pipeline down; bounded (provider closes have timeouts).
func (t *Transcriber) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	states := make([]*trackState, 0, len(t.tracks))
	for _, state := range t.tracks {
		states = append(states, state)
	}
	t.tracks = make(map[string]*trackState)
	t.mu.Unlock()
	for _, state := range states {
		t.endTrack(state.source.ParticipantID + ":" + state.source.TrackName)
	}
}

func (t *Transcriber) endTrack(key string) {
	t.mu.Lock()
	state := t.tracks[key]
	if state != nil {
		delete(t.tracks, key)
	}
	t.mu.Unlock()
	if state == nil {
		return
	}
	t.mu.Lock()
	state.stopped = true
	state.frames = nil
	t.mu.Unlock()
	state.closeDone()
	if state.session != nil {
		_ = state.session.Close()
	}
}

func (t *Transcriber) pump(state *trackState) {
	for {
		t.mu.Lock()
		if state.stopped || state.failed {
			t.mu.Unlock()
			return
		}
		if len(state.frames) == 0 {
			state.pumping = false
			t.mu.Unlock()
			return
		}
		frame := state.frames[0]
		state.frames = state.frames[1:]
		session := state.session
		t.mu.Unlock()

		if session == nil {
			// The first frame both configures the session AND is pushed
			// (mirrors the frozen Node transcriber).
			created, err := t.provider.CreateSession(frame)
			if err != nil {
				t.failTrack(state, normalizeError(err))
				return
			}
			t.mu.Lock()
			if state.stopped || state.failed {
				t.mu.Unlock()
				_ = created.Close()
				return
			}
			state.session = created
			t.mu.Unlock()
			go t.forwardEvents(state, created)
			session = created
		}
		if err := session.PushAudio(frame); err != nil {
			t.failTrack(state, normalizeError(err))
			return
		}
	}
}

func (t *Transcriber) forwardEvents(state *trackState, session StreamingSttSession) {
	for event := range session.Events() {
		t.mu.Lock()
		ended := state.stopped
		t.mu.Unlock()
		if ended {
			return
		}
		t.emit(AttributedSttEvent{Source: state.source, Event: event})
	}
}

func (t *Transcriber) failTrack(state *trackState, err SttError) {
	t.mu.Lock()
	if state.failed || state.stopped {
		t.mu.Unlock()
		return
	}
	state.failed = true
	state.frames = nil
	t.mu.Unlock()
	t.emit(AttributedSttEvent{Source: state.source, Event: SttEvent{Type: "error", Error: &err}})
	if state.session != nil {
		_ = state.session.Close()
	}
	state.closeDone()
}

func (t *Transcriber) emit(event AttributedSttEvent) {
	if t.onEvent == nil {
		return
	}
	func() {
		defer func() { _ = recover() }()
		t.onEvent(event)
	}()
}

func normalizeError(err error) SttError {
	// Preserve typed provider codes (send_failed / decode_failed /
	// provider_error_NNNN / ...) so diagnostics and tests can see exactly
	// which stage failed; the code surface is already sanitized.
	if coded, ok := err.(interface{ Code() string }); ok {
		if code := coded.Code(); code != "" {
			message := err.Error()
			if len(message) > 160 {
				message = message[:160]
			}
			return SttError{Code: code, Message: message}
		}
	}
	message := err.Error()
	if len(message) > 160 {
		message = message[:160]
	}
	return SttError{Code: "speech_provider_failed", Message: message}
}
