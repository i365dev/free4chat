package media

// Manual probe: TTS PCM -> Resample24To48 -> Opus encode -> Opus decode ->
// 48k PCM -> compare energy/waveform. Gated by DOUBAO_PROBE.
import (
	"encoding/binary"
	"os"
	"testing"

	"github.com/pion/opus"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
)

func TestEncodeRoundtripProbe(t *testing.T) {
	if os.Getenv("DOUBAO_PROBE") != "1" {
		t.Skip("manual probe")
	}
	session, err := doubao.NewTtsSession(os.Getenv("DOUBAO_API_KEY"), "", "free4chat-agent")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	defer session.Close()
	var pcm []byte
	if err := session.Synthesize("你好，我是编码回环测试。", func(c speech.TtsAudioChunk) error {
		pcm = append(pcm, c.Data...)
		return nil
	}); err != nil {
		t.Fatalf("synthesize: %v", err)
	}

	encoder, err := opus.NewEncoder(opus.WithSampleRate(48000), opus.WithChannels(1))
	if err != nil {
		t.Fatalf("encoder: %v", err)
	}
	decoder, err := opus.NewDecoderWithOutput(48000, 1)
	if err != nil {
		t.Fatalf("decoder: %v", err)
	}

	var roundtrip []byte
	// Feed the EXACT engine framing: 960-byte frames @24k, resample, encode.
	frame24kBytes := 960
	carry := []byte(nil)
	data := append(carry, pcm...)
	frames := len(data) / frame24kBytes
	totalOut := 0
	for f := 0; f < frames; f++ {
		frame := data[f*frame24kBytes : (f+1)*frame24kBytes]
		up := Resample24To48(frame)
		out := make([]byte, 2000)
		n, err := encoder.Encode(up, out)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		decoded := make([]byte, opusFrameSamples*2*2)
		_, _, err = decoder.Decode(out[:n], decoded)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		roundtrip = append(roundtrip, decoded[:opusFrameSamples*2]...)
		totalOut += n
	}
	t.Logf("frames=%d pcmBytes=%d opusBytes=%d rtBytes=%d", frames, len(pcm), totalOut, len(roundtrip))

	// Fidelity: compare the original 24k PCM (decimated 3:1) against the
	// round-tripped 48k PCM (decimated 6:1) — correlation-like energy check.
	var energyIn, energyOut, mismatched int64
	count := 0
	for i := 0; i+5 < len(roundtrip) && i/6*3*2+3 < len(pcm); i += 6 {
		inSample := int16(binary.LittleEndian.Uint16(pcm[i/6*3*2:]))
		outSample := int16(binary.LittleEndian.Uint16(roundtrip[i:]))
		energyIn += int64(inSample) * int64(inSample)
		energyOut += int64(outSample) * int64(outSample)
		if (inSample > 0) != (outSample > 0) {
			mismatched++
		}
		count++
	}
	t.Logf("samples=%d energyIn=%d energyOut=%d signMismatch=%d (%.2f%%)",
		count, energyIn, energyOut, mismatched, float64(mismatched)*100/float64(count))
}
