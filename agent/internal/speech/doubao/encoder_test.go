package doubao

import (
	"testing"

	"github.com/pion/opus"
)

// testEncoder wraps the pion encoder for silence-frame fixtures.
type testEncoder struct {
	encoder *opus.Encoder
}

func newTestEncoder(t *testing.T) *testEncoder {
	t.Helper()
	encoder, err := opus.NewEncoder(opus.WithSampleRate(48000), opus.WithChannels(1))
	if err != nil {
		t.Skipf("opus encoder unavailable: %v", err)
	}
	return &testEncoder{encoder: encoder}
}

func (e *testEncoder) encodeFrame(pcm []byte) []byte {
	out := make([]byte, 2000)
	n, err := e.encoder.Encode(pcm, out)
	if err != nil {
		return nil
	}
	return out[:n]
}
