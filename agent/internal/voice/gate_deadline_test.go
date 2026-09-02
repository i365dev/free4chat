package voice

import (
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

// #228 D: a provider/sink that never completes must not monopolize the
// shared host voice gate. The Runtime-owned turn deadline cancels the
// stuck turn so the gate is released and later turns can acquire it.
func TestGateDeadlineReleasesHungTurn(t *testing.T) {
	block := make(chan struct{})
	hung := &hungSession{block: block}
	provider := &scriptedProvider{sessions: []speech.StreamingTtsSession{hung, &fakeTtsSession{}}}

	var mu sync.Mutex
	turnFinished := 0

	gate := NewGate()
	speaker := NewSpeaker(Options{
		Provider:         provider,
		CreateSink:       func(uint64) (Sink, error) { return &recordingSink{}, nil },
		MaxChunkChars:    200,
		Gate:             gate,
		GateHoldDeadline: 60 * time.Millisecond,
		OnEvent: func(event SpeakerEvent) {
			if event.Type == "turnFinished" {
				mu.Lock()
				turnFinished++
				mu.Unlock()
			}
		},
	})

	// Turn 1: synthesis hangs; the deadline must cancel it and release the
	// gate even though the provider never returned.
	speaker.Speak("hung turn")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && speaker.draining {
		time.Sleep(5 * time.Millisecond)
	}
	if speaker.draining {
		t.Fatal("gate-held turn was not cancelled by the deadline")
	}

	// Turn 2: the gate must be acquirable and a healthy turn must complete.
	speaker.Speak("healthy turn")
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		finished := turnFinished
		mu.Unlock()
		if finished > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if turnFinished == 0 {
		t.Fatal("healthy turn after deadline release never finished")
	}
}

type hungSession struct {
	block chan struct{}
}

func (s *hungSession) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	// Simulates a provider whose network bounds eventually return, long
	// AFTER the runtime's turn deadline has already fired.
	select {
	case <-s.block:
	case <-time.After(400 * time.Millisecond):
	}
	return nil
}

func (s *hungSession) Close() error {
	select {
	case <-s.block:
	default:
		close(s.block)
	}
	return nil
}

type scriptedProvider struct {
	mu       sync.Mutex
	sessions []speech.StreamingTtsSession
}

func (p *scriptedProvider) CreateSession() (speech.StreamingTtsSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.sessions) == 0 {
		return &fakeTtsSession{}, nil
	}
	session := p.sessions[0]
	p.sessions = p.sessions[1:]
	return session, nil
}
