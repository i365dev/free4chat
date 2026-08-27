package doubao

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

const (
	ttsConnectTimeoutMs = 10_000
	ttsChunkTimeoutMs   = 15_000
)

// TtsSession synthesizes text through the V3 output-unidirectional HTTP
// interface: a chunked stream of JSON objects ({code,message,data}), code 0
// carries one base64 24 kHz mono PCM chunk, 20000000 terminates. The API
// key exists only inside the outgoing header.
type TtsSession struct {
	apiKey string
	voice  string
	uid    string
	client *http.Client

	mu       sync.Mutex
	inflight *context.CancelFunc
}

// NewTtsSession builds a session for the configured voice.
func NewTtsSession(apiKey, voice, uid string) (*TtsSession, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, &SttError{CodeValue: "missing_api_key", Message: "Doubao API key is required"}
	}
	if strings.TrimSpace(voice) == "" {
		voice = TTSDefaultVoice
	}
	if uid == "" {
		uid = "free4chat-agent"
	}
	return &TtsSession{
		apiKey: apiKey,
		voice:  voice,
		uid:    uid,
		client: &http.Client{Timeout: 60 * time.Second},
	}, nil
}

// Synthesize synthesizes one coherent text chunk, emitting every PCM block
// in stream order. Cancellable via Close; a mid-stream error aborts.
func (s *TtsSession) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || !containsReadableText(trimmed) {
		// Doubao rejects punctuation-only text with "No readable text!";
		// a no-op round is the text-safe outcome.
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	if s.inflight != nil {
		(*s.inflight)()
	}
	s.inflight = &cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.inflight = nil
		s.mu.Unlock()
	}()

	requestID, err := newUUID()
	if err != nil {
		return err
	}
	body := buildTtsBody(trimmed, s.voice, s.uid)
	encoded, _ := json.Marshal(body)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, TTSEndpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Api-Key", s.apiKey)
	request.Header.Set("X-Api-Resource-Id", TTSResourceID)
	request.Header.Set("X-Api-Request-Id", requestID)

	connectTimer := time.AfterFunc(ttsConnectTimeoutMs*time.Millisecond, cancel)
	defer connectTimer.Stop()
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return &SttError{CodeValue: "tts_request_aborted", Message: "", Retryable: true}
		}
		return &SttError{CodeValue: "tts_transport_failed", Message: "", Retryable: true}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		detail := ""
		if bodyBytes, readErr := io.ReadAll(io.LimitReader(response.Body, 2048)); readErr == nil {
			detail = classifyTtsError(string(bodyBytes))
		}
		return &SttError{CodeValue: fmt.Sprintf("tts_request_failed_status_%d", response.StatusCode), Message: detail}
	}

	scanner := newTtsStreamScanner()
	buffer := make([]byte, 32*1024)
	sawEnd := false
	for {
		_ = ttsChunkTimeoutMs // idle-gap bound enforced by ctx cancel below
		n, readErr := response.Body.Read(buffer)
		if readErr != nil && readErr != io.EOF {
			if ctx.Err() != nil {
				return &SttError{CodeValue: "tts_request_aborted", Message: "", Retryable: true}
			}
			return &SttError{CodeValue: "tts_chunk_timeout", Message: "", Retryable: true}
		}
		if n > 0 {
			for _, raw := range scanner.push(string(buffer[:n])) {
				outcome, err := s.consume(raw, emit)
				if err != nil {
					return err
				}
				if outcome == "end" {
					sawEnd = true
				}
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	for _, raw := range scanner.flush() {
		outcome, err := s.consume(raw, emit)
		if err != nil {
			return err
		}
		if outcome == "end" {
			sawEnd = true
		}
	}
	if !sawEnd {
		return &SttError{CodeValue: "tts_stream_ended_before_completion", Message: "", Retryable: true}
	}
	return nil
}

func (s *TtsSession) consume(raw string, emit func(speech.TtsAudioChunk) error) (string, error) {
	var object struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &object); err != nil {
		return "", &SttError{CodeValue: "tts_invalid_stream_object", Message: ""}
	}
	if object.Code != 0 && object.Code != TTSEndCode {
		return "", &SttError{CodeValue: fmt.Sprintf("doubao_tts_error_%d", object.Code), Message: object.Message}
	}
	if object.Code == TTSEndCode {
		return "end", nil
	}
	if object.Data != "" {
		decoded, err := base64.StdEncoding.DecodeString(object.Data)
		if err != nil {
			return "", &SttError{CodeValue: "tts_invalid_stream_object", Message: ""}
		}
		if err := emit(speech.TtsAudioChunk{
			Codec:        "pcm_s16le",
			SampleRateHz: TTSSampleRateHz,
			Channels:     1,
			Data:         decoded,
		}); err != nil {
			return "", err
		}
		return "audio", nil
	}
	return "ignore", nil
}

func classifyTtsError(body string) string {
	var object struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(body), &object) == nil && object.Message != "" {
		return object.Message
	}
	if len(body) > 160 {
		return body[:160]
	}
	return body
}

func containsReadableText(text string) bool {
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			return true
		}
	}
	return false
}

func buildTtsBody(text, voice, uid string) map[string]any {
	return map[string]any{
		"user": map[string]any{"uid": uid},
		"req_params": map[string]any{
			"text":    text,
			"speaker": voice,
			"audio_params": map[string]any{
				"format":      "pcm",
				"sample_rate": TTSSampleRateHz,
			},
		},
	}
}

// Close aborts any in-flight synthesis.
func (s *TtsSession) Close() error {
	s.mu.Lock()
	cancel := s.inflight
	s.inflight = nil
	s.mu.Unlock()
	if cancel != nil {
		(*cancel)()
	}
	return nil
}

// ttsStreamScanner incrementally extracts complete top-level JSON objects
// from a chunked stream (brace-aware, string-aware, newline-tolerant),
// mirroring the frozen Node createStreamObjectScanner.
type ttsStreamScanner struct {
	buffer      string
	pos         int
	objectStart int
	depth       int
	inString    bool
	escaped     bool
}

func newTtsStreamScanner() *ttsStreamScanner { return &ttsStreamScanner{} }

func (sc *ttsStreamScanner) push(text string) []string {
	if text != "" {
		sc.buffer += text
	}
	return sc.run(false)
}

func (sc *ttsStreamScanner) flush() []string {
	out := sc.run(true)
	sc.buffer = ""
	sc.pos = 0
	return out
}

func (sc *ttsStreamScanner) run(untilEOF bool) []string {
	var objects []string
	for sc.pos < len(sc.buffer) {
		ch := sc.buffer[sc.pos]
		if sc.depth == 0 {
			if ch == '{' {
				sc.depth = 1
				sc.objectStart = sc.pos
				sc.inString = false
				sc.escaped = false
			}
			sc.pos++
			continue
		}
		if sc.inString {
			if sc.escaped {
				sc.escaped = false
			} else if ch == '\\' {
				sc.escaped = true
			} else if ch == '"' {
				sc.inString = false
			}
			sc.pos++
			continue
		}
		switch ch {
		case '"':
			sc.inString = true
		case '{':
			sc.depth++
		case '}':
			sc.depth--
			if sc.depth == 0 && sc.objectStart >= 0 {
				objects = append(objects, sc.buffer[sc.objectStart:sc.pos+1])
				sc.buffer = sc.buffer[sc.pos+1:]
				sc.pos = 0
				sc.objectStart = -1
				continue
			}
		}
		sc.pos++
	}
	if !untilEOF {
		if sc.objectStart > 0 {
			sc.buffer = sc.buffer[sc.objectStart:]
			sc.pos -= sc.objectStart
			sc.objectStart = 0
		} else if sc.objectStart < 0 && sc.depth == 0 {
			sc.buffer = ""
			sc.pos = 0
		}
	}
	return objects
}
