package doubao

// Manual probe: synthesize a short text and write it as a reference WAV
// (24 kHz mono S16LE) for operator listening. Gated by DOUBAO_PROBE.
import (
	"encoding/binary"
	"os"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

func TestDoubaoTtsWavProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	session, err := NewTtsSession(os.Getenv("DOUBAO_API_KEY"), "", "free4chat-agent")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	defer session.Close()
	var pcm []byte
	if err := session.Synthesize("你好，我是语音质量参考测试。今天天气不错，适合出去走走。", func(c speech.TtsAudioChunk) error {
		pcm = append(pcm, c.Data...)
		return nil
	}); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	wav := makeWavHeader(len(pcm))
	wav = append(wav, pcm...)
	if err := os.WriteFile("/tmp/e2e-pr2/tts-reference.wav", wav, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("wrote /tmp/e2e-pr2/tts-reference.wav (%d pcm bytes)", len(pcm))
}

func makeWavHeader(pcmBytes int) []byte {
	header := make([]byte, 44)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+pcmBytes))
	copy(header[8:], "WAVE")
	copy(header[12:], "fmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], 24000)
	binary.LittleEndian.PutUint32(header[28:], 24000*1*2)
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(pcmBytes))
	return header
}
