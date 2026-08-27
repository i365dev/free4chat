package media

// Manual probe: full local pipeline (real Pion engine + loopback peer) with
// real Doubao TTS; the peer decodes the received Opus into a WAV for the
// operator to listen to. Gated by DOUBAO_PROBE.
import (
	"encoding/binary"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/pion/opus"
	"github.com/pion/webrtc/v4"

	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

func TestPipelineWavProbe(t *testing.T) {
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

	// Connected loopback peer that decodes the received Opus stream.
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Skipf("peer unavailable: %v", err)
	}
	defer peer.Close()
	var mu sync.Mutex
	var decodedPCM []byte
	var framesReceived int
	peer.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		decoder, err := opus.NewDecoderWithOutput(48000, 1)
		if err != nil {
			return
		}
		go func() {
			for {
				pkt, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				out := make([]byte, opusFrameSamples*2*2)
				_, _, err = decoder.Decode(pkt.Payload, out)
				if err != nil {
					continue
				}
				mu.Lock()
				decodedPCM = append(decodedPCM, out[:opusFrameSamples*2]...)
				framesReceived++
				mu.Unlock()
			}
		}()
	})
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatalf("peer setRemote: %v", err)
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("peer answer: %v", err)
	}
	if err := peer.SetLocalDescription(answer); err != nil {
		t.Fatalf("peer setLocal: %v", err)
	}
	if _, _, err := engine.ApplyRemote(Description{Type: "answer", SDP: peer.LocalDescription().SDP}); err != nil {
		t.Fatalf("apply answer: %v", err)
	}
	// Wait for the ICE connection.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if engine.pc.ConnectionState() == webrtc.PeerConnectionStateConnected &&
			peer.ConnectionState() == webrtc.PeerConnectionStateConnected {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Logf("engine=%s peer=%s", engine.pc.ConnectionState(), peer.ConnectionState())

	if err := engine.ArmPublish(); err != nil {
		t.Fatalf("arm: %v", err)
	}
	if _, err := engine.CreateLocalOffer(); err != nil {
		t.Fatalf("fresh offer: %v", err)
	}
	// The peer must renegotiate for the new m-line: apply the fresh offer.
	fresh := engine.pc.LocalDescription()
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: fresh.SDP}); err != nil {
		t.Fatalf("peer renegotiate setRemote: %v", err)
	}
	answer2, err := peer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("peer answer2: %v", err)
	}
	if err := peer.SetLocalDescription(answer2); err != nil {
		t.Fatalf("peer setLocal2: %v", err)
	}
	if _, _, err := engine.ApplyRemote(Description{Type: "answer", SDP: peer.LocalDescription().SDP}); err != nil {
		t.Fatalf("apply answer2: %v", err)
	}
	if err := engine.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}

	session, err := doubao.NewTtsSession(os.Getenv("DOUBAO_API_KEY"), "", "free4chat-agent")
	if err != nil {
		t.Fatalf("tts session: %v", err)
	}
	_ = session
	speaker := voice.NewSpeaker(voice.Options{
		Provider:   &doubao.TtsProvider{APIKey: os.Getenv("DOUBAO_API_KEY")},
		CreateSink: func() (voice.Sink, error) { return &engineSink{engine: engine}, nil },
	})
	speaker.Speak("你好，我是完整管线回环测试。这是一段中等长度的语音，用来验证编码和传输质量。")
	deadline2 := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline2) {
		mu.Lock()
		got := framesReceived
		mu.Unlock()
		if got >= 300 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = speaker.Close()

	mu.Lock()
	pcm := append([]byte(nil), decodedPCM...)
	mu.Unlock()
	wav := makeWavHeader48k(len(pcm))
	wav = append(wav, pcm...)
	if err := os.WriteFile("/tmp/e2e-pr2/pipeline-loopback.wav", wav, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("wrote /tmp/e2e-pr2/pipeline-loopback.wav (frames=%d pcmBytes=%d)", framesReceived, len(pcm))
}

func makeWavHeader48k(pcmBytes int) []byte {
	header := make([]byte, 44)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+pcmBytes))
	copy(header[8:], "WAVE")
	copy(header[12:], "fmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], 48000)
	binary.LittleEndian.PutUint32(header[28:], 48000*1*2)
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(pcmBytes))
	return header
}
