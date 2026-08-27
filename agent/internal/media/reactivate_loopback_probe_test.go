package media

// Manual probe: does RTP actually flow to the peer after a
// deactivate->reactivate publication cycle on the SAME PeerConnection?
// Gated by DOUBAO_PROBE.
import (
	"os"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

func TestReactivateLoopbackProbe(t *testing.T) {
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
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Skipf("peer unavailable: %v", err)
	}
	defer peer.Close()

	var mu sync.Mutex
	round := 1
	round1, round2 := 0, 0
	peer.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		go func() {
			for {
				_, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				mu.Lock()
				if round == 1 {
					round1++
				} else {
					round2++
				}
				mu.Unlock()
			}
		}()
	})
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatalf("peer sr: %v", err)
	}
	answer, _ := peer.CreateAnswer(nil)
	_ = peer.SetLocalDescription(answer)
	if _, _, err := engine.ApplyRemote(Description{Type: "answer", SDP: peer.LocalDescription().SDP}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && (engine.pc.ConnectionState() != webrtc.PeerConnectionStateConnected || peer.ConnectionState() != webrtc.PeerConnectionStateConnected) {
		time.Sleep(100 * time.Millisecond)
	}

	renegotiate := func() {
		t.Helper()
		if _, err := engine.CreateLocalOffer(); err != nil {
			t.Fatalf("offer: %v", err)
		}
		if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: engine.pc.LocalDescription().SDP}); err != nil {
			t.Fatalf("peer sr: %v", err)
		}
		ans, _ := peer.CreateAnswer(nil)
		_ = peer.SetLocalDescription(ans)
		if _, _, err := engine.ApplyRemote(Description{Type: "answer", SDP: peer.LocalDescription().SDP}); err != nil {
			t.Fatalf("apply: %v", err)
		}
	}
	_ = engine.ArmPublish()
	renegotiate()
	_ = engine.ActivatePublish()

	var evMu sync.Mutex
	finished := 0
	speaker := voice.NewSpeaker(voice.Options{
		Provider:   &doubao.TtsProvider{APIKey: os.Getenv("DOUBAO_API_KEY")},
		CreateSink: func() (voice.Sink, error) { return &engineSink{engine: engine}, nil },
		OnEvent: func(e voice.SpeakerEvent) {
			if e.Type == "turnFinished" || e.Type == "turnFailed" {
				evMu.Lock()
				finished++
				evMu.Unlock()
			}
		},
	})

	speakAndWait := func(text string) {
		t.Helper()
		evMu.Lock()
		finished = 0
		evMu.Unlock()
		speaker.Speak(text)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			evMu.Lock()
			done := finished >= 1
			evMu.Unlock()
			if done {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		// The speaker finishing only means the TTS drained into the engine
		// queue; wait for the PACED WRITER to drain everything.
		deadline = time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if engine.queueBytesSnapshot() == 0 && len(engine.queueRingSnapshot()) == 0 {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("writer never drained: frames=%d ring=%d budget=%d",
			engine.framesWritten(), len(engine.queueRingSnapshot()), engine.queueBytesSnapshot())
	}

	speakAndWait("第一轮语音。")
	mu.Lock()
	r1 := round1
	mu.Unlock()
	t.Logf("round1 rtp packets=%d (turn finished)", r1)
	if r1 == 0 {
		t.Fatal("round1: no RTP reached the peer")
	}

	// Revoke -> re-grant on the SAME PC (publication restart path).
	engine.DeactivatePublish()
	mu.Lock()
	round = 2
	mu.Unlock()
	_ = engine.ArmPublish()
	renegotiate()
	_ = engine.ActivatePublish()

	speakAndWait("第二轮语音。")
	mu.Lock()
	r2 := round2
	mu.Unlock()
	t.Logf("round2 rtp packets=%d (turn finished)", r2)
	if r2 == 0 {
		t.Fatal("NO RTP reached the peer after deactivate->reactivate on the same PC")
	}
	_ = speaker.Close()
}
