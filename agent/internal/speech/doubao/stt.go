package doubao

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

const (
	sttConnectTimeoutMs = 10_000
	sttCloseTimeoutMs   = 2_000
	sttFinalDrainMs     = 2_000
	sttSendTimeoutMs    = 5_000
	sttMaxPendingEvents = 256
)

// SttError is a classified Doubao ASR failure.
type SttError struct {
	CodeValue string
	Message   string
	Retryable bool
}

func (e *SttError) Error() string { return e.Message }

// Code exposes the typed failure code to the transcriber diagnostics.
func (e *SttError) Code() string { return e.CodeValue }

// SttSession is one per-speaker streaming ASR session. Audio frames arrive
// as 48 kHz Opus payloads (decoded internally) or raw PCM; recognition
// events stream through Events() with the frozen Node partial/committed
// dedup semantics.
type SttSession struct {
	apiKey    string
	endpoint  string
	requestID string
	conn      *websocket.Conn
	decoder   *OpusDecoder
	uid       string
	useRawPCM bool

	mu         sync.Mutex
	sequence   int32 // audio starts at 2
	closed     bool
	closing    bool
	failed     bool
	speechOpen bool
	committed  map[string]bool
	partials   map[string]string
	events     chan speech.SttEvent
	finalOnce  sync.Once
	finalCh    chan struct{}
}

// NewSttSession creates an unconnected session.
func NewSttSession(apiKey, uid string) (*SttSession, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, &SttError{CodeValue: "missing_api_key", Message: "Doubao API key is required"}
	}
	requestID, err := newUUID()
	if err != nil {
		return nil, err
	}
	decoder, err := NewOpusDecoder()
	if err != nil {
		return nil, err
	}
	return &SttSession{
		apiKey:    apiKey,
		endpoint:  STTEndpoint,
		requestID: requestID,
		decoder:   decoder,
		uid:       uid,
		sequence:  2,
		committed: make(map[string]bool),
		partials:  make(map[string]string),
		events:    make(chan speech.SttEvent, sttMaxPendingEvents),
		finalCh:   make(chan struct{}),
	}, nil
}

// Connect opens the WebSocket and sends the initial full request.
func (s *SttSession) Connect(ctx context.Context) error {
	if s.conn != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, sttConnectTimeoutMs*time.Millisecond)
	defer cancel()
	header := make(http.Header)
	for key, value := range SttHeaders(s.apiKey, s.requestID) {
		header.Set(key, value)
	}
	conn, _, err := websocket.Dial(ctx, s.endpoint, &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err != nil {
		return &SttError{CodeValue: "connection_failed", Message: "Doubao connection failed", Retryable: true}
	}
	s.conn = conn
	initial, err := BuildSttInitialRequest(s.uid)
	if err != nil {
		return err
	}
	if err := s.sendBinary(ctx, initial); err != nil {
		_ = conn.Close(websocket.StatusAbnormalClosure, "")
		s.conn = nil
		return err
	}
	return nil
}

func (s *SttSession) sendBinary(ctx context.Context, frame []byte) error {
	ctx, cancel := context.WithTimeout(ctx, sttSendTimeoutMs*time.Millisecond)
	defer cancel()
	if err := s.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		return &SttError{CodeValue: "send_failed", Message: "Doubao audio could not be sent", Retryable: true}
	}
	return nil
}

// PushAudio accepts an Opus payload (the frozen production path) and
// forwards decoded 16 kHz mono PCM to Doubao.
func (s *SttSession) PushAudio(frame speech.AudioFrame) error {
	s.mu.Lock()
	if s.closed || s.closing || s.failed || s.conn == nil {
		s.mu.Unlock()
		return &SttError{CodeValue: "connection_unavailable", Message: "Doubao connection is unavailable", Retryable: true}
	}
	sequence := s.sequence
	s.sequence++
	decoder := s.decoder
	conn := s.conn
	s.mu.Unlock()

	var pcm []byte
	if frame.Codec == "opus" {
		decoded, err := decoder.DecodeFrame(frame.Data)
		if err != nil {
			return &SttError{CodeValue: "decode_failed", Message: "Doubao could not decode the Opus audio frame"}
		}
		pcm = decoded
	} else if frame.Codec == "pcm_s16le" {
		pcm = frame.Data
	} else {
		return &SttError{CodeValue: "unsupported_audio", Message: "Doubao audio codec is unsupported"}
	}

	if len(pcm) == 0 {
		// Never send an empty audio payload: Doubao rejects it and kills
		// the session (provider_error_45000000).
		return nil
	}
	request, err := BuildSttAudioRequest(sequence, pcm)
	if err != nil {
		return err
	}
	_ = conn
	return s.sendBinary(context.Background(), request)
}

// Events exposes the recognition event stream (closed by Close).
func (s *SttSession) Events() <-chan speech.SttEvent { return s.events }

// Close finalizes the stream: negative-sequence final packet, bounded drain
// of the last definite result, then socket close. Idempotent.
func (s *SttSession) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closing = true
	conn := s.conn
	sequence := s.sequence
	s.mu.Unlock()

	if conn != nil && !s.failed {
		_ = s.sendBinary(context.Background(), func() []byte {
			frame, _ := BuildSttAudioRequest(-sequence, nil)
			return frame
		}())
		select {
		case <-s.finalCh:
		case <-time.After(sttFinalDrainMs * time.Millisecond):
		}
		closeCtx, cancel := context.WithTimeout(context.Background(), sttCloseTimeoutMs*time.Millisecond)
		_ = closeCtx
		defer cancel()
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}

	s.mu.Lock()
	s.closed = true
	s.closing = false
	s.mu.Unlock()
	s.decoder.Close()
	s.finalOnce.Do(func() { close(s.events) })
	return nil
}

// HandleMessage parses one inbound binary frame and emits recognition
// events. Returns false once the stream is complete.
func (s *SttSession) HandleMessage(data []byte) bool {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return false
	}
	response, err := ParseSttResponse(data)
	if err != nil {
		s.fail(&SttError{CodeValue: "invalid_response", Message: "Doubao returned an invalid response"})
		return false
	}
	if response.Code != 0 {
		s.fail(&SttError{CodeValue: fmt.Sprintf("provider_error_%d", response.Code), Message: "Doubao rejected the speech request"})
		return false
	}
	for _, utterance := range response.Result {
		s.emitUtterance(utterance)
	}
	if response.IsLastPackage {
		s.finalOnce.Do(func() { close(s.finalCh) })
		return false
	}
	return true
}

func (s *SttSession) emitUtterance(utterance SttUtterance) {
	text := strings.TrimSpace(utterance.Text)
	if text == "" {
		return
	}
	var timestampMs *int64
	if utterance.EndTime != nil {
		value := int64(*utterance.EndTime)
		timestampMs = &value
	} else if utterance.StartTime != nil {
		value := int64(*utterance.StartTime)
		timestampMs = &value
	}
	// Dedup key must use the NUMERIC time values, never pointer addresses:
	// the server re-sends the same definite utterance across frames and each
	// re-parse yields fresh pointers.
	startValue, endValue := "?", "?"
	if utterance.StartTime != nil {
		startValue = fmt.Sprintf("%d", int64(*utterance.StartTime))
	}
	if utterance.EndTime != nil {
		endValue = fmt.Sprintf("%d", int64(*utterance.EndTime))
	}
	key := startValue + ":" + endValue
	if utterance.Definite {
		identity := key + ":" + text
		s.mu.Lock()
		if s.committed[identity] {
			s.mu.Unlock()
			return
		}
		s.committed[identity] = true
		delete(s.partials, key)
		speechOpen := s.speechOpen
		s.speechOpen = false
		s.mu.Unlock()
		if !speechOpen {
			s.pushEvent(speech.SttEvent{Type: "speech_started", TimestampMs: timestampMs})
		}
		s.pushEvent(speech.SttEvent{Type: "committed", Text: text, TimestampMs: timestampMs})
		s.pushEvent(speech.SttEvent{Type: "speech_ended", TimestampMs: timestampMs})
		return
	}
	s.mu.Lock()
	if s.partials[key] == text {
		s.mu.Unlock()
		return
	}
	s.partials[key] = text
	speechOpen := s.speechOpen
	s.speechOpen = true
	s.mu.Unlock()
	if !speechOpen {
		s.pushEvent(speech.SttEvent{Type: "speech_started", TimestampMs: timestampMs})
	}
	s.pushEvent(speech.SttEvent{Type: "partial", Text: text, TimestampMs: timestampMs})
}

func (s *SttSession) pushEvent(event speech.SttEvent) {
	select {
	case s.events <- event:
	default:
		// Bounded: drop the oldest event rather than blocking the socket
		// reader (never observed in practice; safety valve only).
		select {
		case <-s.events:
		default:
		}
		select {
		case s.events <- event:
		default:
		}
	}
}

func (s *SttSession) fail(err *SttError) {
	s.mu.Lock()
	if s.failed || s.closed {
		s.mu.Unlock()
		return
	}
	s.failed = true
	s.mu.Unlock()
	s.pushEvent(speech.SttEvent{
		Type:  "error",
		Error: &speech.SttError{Code: err.CodeValue, Message: err.Message, Retryable: err.Retryable},
	})
}

func newUUID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	data[6] = (data[6] & 0x0f) | 0x40
	data[8] = (data[8] & 0x3f) | 0x80
	return hex.EncodeToString(data[0:4]) + "-" + hex.EncodeToString(data[4:6]) +
		"-" + hex.EncodeToString(data[6:8]) + "-" + hex.EncodeToString(data[8:10]) +
		"-" + hex.EncodeToString(data[10:16]), nil
}
