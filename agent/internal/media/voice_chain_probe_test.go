package media

import (
	"os"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// TestVoiceChainProbe drives the engine-side voice chain locally: real Pion
// engine (real wall-clock pacing) + real Doubao TTS. Gated by DOUBAO_PROBE;
// never runs in CI. It isolates the engine pacing path from the bridge's
// pending-PCM/confirmation path.
func TestVoiceChainProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	engine := NewEngine(EngineEvents{}, func(string, map[string]string) {})
	if err := engine.Create(); err != nil {
		t.Skipf("engine unavailable: %v", err)
	}
	defer engine.Close()
	if err := engine.CreateServerEventsChannel(); err != nil {
		t.Fatalf("dc: %v", err)
	}
	offer, err := engine.GatherCompleteOffer()
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	peer := newLoopbackPeer(t, *offer)
	if _, _, err := engine.ApplyRemote(peer); err != nil {
		t.Fatalf("apply bootstrap: %v", err)
	}
	if err := engine.ArmPublish(); err != nil {
		t.Fatalf("arm: %v", err)
	}
	if _, err := engine.CreateLocalOffer(); err != nil {
		t.Fatalf("fresh offer: %v", err)
	}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}

	events := []voice.SpeakerEvent{}
	speaker := voice.NewSpeaker(voice.Options{
		Provider: &doubao.TtsProvider{APIKey: os.Getenv("DOUBAO_API_KEY")},
		CreateSink: func(uint64) (voice.Sink, error) {
			return &engineSink{engine: engine}, nil
		},
		MaxChunkChars: 220,
		OnEvent:       func(e voice.SpeakerEvent) { events = append(events, e) },
	})
	speaker.Speak("你好，我是语音链路测试。这是一段用于验证完整音频路径的文本。")
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		done := false
		for _, e := range events {
			if e.Type == "turnFinished" || e.Type == "turnFailed" {
				done = true
			}
		}
		if done {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	stats := engine.PublishCounts()
	t.Logf("events=%+v pcmInputBytes=%d opusFrames=%d", events,
		stats["pcm_input_bytes"], stats["opus_frames_written"])
	_ = speaker.Close()
}

// engineSink adapts the raw engine to the speaker sink (no bridge priming).
type engineSink struct{ engine *Engine }

func (s *engineSink) WriteAudio(c speech.TtsAudioChunk) error {
	return s.engine.WritePCM(c.Data, 0)
}
func (s *engineSink) EndTurn() error    { return s.engine.FlushAudio(0) }
func (s *engineSink) CancelTurn() error { s.engine.CancelTurn(0); return nil }
func (s *engineSink) Close() error      { return nil }
