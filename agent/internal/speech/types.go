// Package speech owns local speech configuration and provider boundaries:
// streaming STT (Meeting Notes ingress) and streaming TTS (outbound Voice
// Reply). Ported from the frozen Node reference's speech module — behavior
// and security invariants preserved, TypeScript shape not.
package speech

// AudioFrame is one decoded-or-encoded audio frame crossing a provider
// boundary. Room or participant capabilities never ride here.
type AudioFrame struct {
	Codec        string // "opus" | "pcm_s16le"
	SampleRateHz int
	Channels     int
	Data         []byte
}

// SttError is a sanitized provider failure.
type SttError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable,omitempty"`
}

// SttEvent is one streaming recognition event.
type SttEvent struct {
	Type        string    `json:"type"` // speech_started|partial|committed|speech_ended|error
	Text        string    `json:"text,omitempty"`
	TimestampMs *int64    `json:"timestampMs,omitempty"`
	Error       *SttError `json:"error,omitempty"`
}

// StreamingSttSession receives audio frames and emits recognition events.
type StreamingSttSession interface {
	PushAudio(frame AudioFrame) error
	Events() <-chan SttEvent
	Close() error
}

// StreamingSttProvider creates per-speaker recognition sessions.
type StreamingSttProvider interface {
	CreateSession(audio AudioFrame) (StreamingSttSession, error)
}

// SttSessionOptions is derived from the first audio frame exactly like the
// frozen Node transcriber (codec/rate/channels), provider-defined.
type SttSessionOptions struct {
	Codec        string // "opus" | "raw"
	SampleRateHz int
	Channels     int
}

// TtsAudioChunk is one synthesized PCM block in stream order.
type TtsAudioChunk struct {
	Codec        string // always "pcm_s16le"
	SampleRateHz int
	Channels     int
	Data         []byte
}

// StreamingTtsSession serves sequential synthesis rounds.
type StreamingTtsSession interface {
	// Synthesize yields PCM chunks for one coherent text chunk; the caller
	// must fully drain or Close before the next round.
	Synthesize(text string, emit func(TtsAudioChunk) error) error
	Close() error
}

// StreamingTtsProvider creates synthesis sessions.
type StreamingTtsProvider interface {
	CreateSession() (StreamingTtsSession, error)
}

// AudioSource attributes one audio stream to a room participant.
type AudioSource struct {
	ParticipantID   string
	ParticipantName string
	TrackName       string
}

// AttributedSttEvent binds one recognition event to its speaker.
type AttributedSttEvent struct {
	Source AudioSource
	Event  SttEvent
}

// AttributedSttHandler receives attributed events; implementations must not
// block or fail the audio pipeline.
type AttributedSttHandler func(AttributedSttEvent)
