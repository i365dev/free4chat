package doubao

import (
	"context"

	"github.com/coder/websocket"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

// Run drives the WebSocket read loop: inbound binary frames are parsed and
// dispatched as recognition events until the stream ends or ctx cancels.
// The final frame closes the event channel through Close's finalOnce; Run
// returns without closing the socket itself.
func (s *SttSession) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		if !s.HandleMessage(data) {
			return
		}
	}
}

// SttProvider adapts the Doubao ASR session to the speech boundary.
type SttProvider struct {
	APIKey string
}

// CreateSession opens and connects one per-speaker session.
func (p *SttProvider) CreateSession(audio speech.AudioFrame) (speech.StreamingSttSession, error) {
	session, err := NewSttSession(p.APIKey, "free4chat-agent")
	if err != nil {
		return nil, err
	}
	if err := session.Connect(context.Background()); err != nil {
		return nil, err
	}
	go session.Run(context.Background())
	return session, nil
}

// TtsProvider adapts the Doubao TTS session to the speech boundary.
type TtsProvider struct {
	APIKey string
	Voice  string
}

// CreateSession builds one synthesis session.
func (p *TtsProvider) CreateSession() (speech.StreamingTtsSession, error) {
	return NewTtsSession(p.APIKey, p.Voice, "free4chat-agent")
}

var _ = websocket.StatusNormalClosure
