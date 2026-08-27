package doubao

// Manual Doubao ASR probe — runs ONLY when DOUBAO_PROBE=1 is set; never in
// CI (external network + credential). Prints every response frame verbatim.
import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"

	"github.com/coder/websocket"
)

func TestDoubaoProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	apiKey := os.Getenv("DOUBAO_API_KEY")
	if apiKey == "" {
		t.Fatal("DOUBAO_API_KEY unset")
	}
	header := make(http.Header)
	for key, value := range SttHeaders(apiKey, "probe-request-id") {
		header.Set(key, value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, STTEndpoint, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	initial, _ := BuildSttInitialRequest("free4chat-agent")
	if err := conn.Write(ctx, websocket.MessageBinary, initial); err != nil {
		t.Fatalf("write initial: %v", err)
	}
	// 12 seconds of a 440 Hz sine through the REAL pipeline (Opus encode at
	// 48 kHz mono -> session decoder -> 16 kHz PCM -> Doubao).
	encoder := newTestEncoder(t)
	decoder, _ := NewOpusDecoder()
	defer decoder.Close()
	seq := int32(2)
	for elapsed := 0; elapsed < 12000; elapsed += 20 {
		samples := make([]byte, opusFrameSamples*2)
		for i := 0; i < opusFrameSamples; i++ {
			phase := float64(elapsed+i) / 48000 * 440 * 2 * 3.14159
			value := int16(12000 * sinApprox(phase))
			binary.LittleEndian.PutUint16(samples[i*2:], uint16(value))
		}
		encoded := encoder.encodeFrame(samples)
		pcm, err := decoder.DecodeFrame(encoded)
		if err != nil || len(pcm) == 0 {
			fmt.Printf("DECODE ISSUE at %dms: err=%v len=%d\n", elapsed, err, len(pcm))
			continue
		}
		frame, _ := BuildSttAudioRequest(seq, pcm)
		seq++
		if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
			t.Fatalf("write audio %d: %v", seq, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Final negative-sequence packet.
	final, _ := BuildSttAudioRequest(-seq, nil)
	_ = conn.Write(ctx, websocket.MessageBinary, final)

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		response, err := ParseSttResponse(data)
		if err != nil {
			fmt.Printf("PARSE ERR: %v (raw % x)\n", err, data[:minInt(len(data), 32)])
			continue
		}
		raw, _ := json.Marshal(response)
		fmt.Printf("FRAME: %s\n", raw)
		if response.IsLastPackage {
			break
		}
	}
}

func sinApprox(x float64) float64 {
	// Taylor series, good enough for a diagnostic tone.
	x -= float64(int(x/(2*3.14159))) * 2 * 3.14159
	return x - x*x*x/6 + x*x*x*x*x/120 - x*x*x*x*x*x*x/5040
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// TestDoubaoTtsProbe synthesizes a fixed long text and prints the total PCM
// bytes received (gated by DOUBAO_PROBE, never in CI).
func TestDoubaoTtsProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	apiKey := os.Getenv("DOUBAO_API_KEY")
	if apiKey == "" {
		t.Fatal("DOUBAO_API_KEY unset")
	}
	session, err := NewTtsSession(apiKey, "", "free4chat-agent")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	defer session.Close()
	const text = "厨师小王去相亲，女孩问：你平时最大的优点是什么？小王自信地说：我特别会照顾人，尤其擅长做饭。女孩眼睛一亮：那你最拿手的菜是什么？"
	total := 0
	chunks := 0
	start := time.Now()
	if err := session.Synthesize(text, func(chunk speech.TtsAudioChunk) error {
		total += len(chunk.Data)
		chunks++
		return nil
	}); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	fmt.Printf("TTS PROBE: text=%d chars, pcm=%d bytes (%.2fs @24k), chunks=%d, elapsed=%s\n",
		len([]rune(text)), total, float64(total)/24000/2, chunks, time.Since(start))
}
