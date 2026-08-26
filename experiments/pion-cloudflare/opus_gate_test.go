package main

import (
	"encoding/binary"
	"testing"

	pionopus "github.com/pion/opus"
)

// Dependency gate (#83): proves the pinned pure-Go pion/opus module encodes
// one 20 ms mono 48 kHz S16LE frame under CGO_ENABLED=0.
func TestPionOpusPureGoEncodeCGO0(t *testing.T) {
	enc, err := pionopus.NewEncoder(
		pionopus.WithSampleRate(48000),
		pionopus.WithChannels(1),
	)
	if err != nil {
		t.Fatalf("NewEncoder(48k mono): %v", err)
	}
	pcm := make([]byte, 960*2)
	for s := 0; s < 960; s++ {
		binary.LittleEndian.PutUint16(pcm[s*2:], uint16((s*37)%30000))
	}
	out := make([]byte, 2000)
	n, err := enc.Encode(pcm, out)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if n <= 0 || n > 1500 {
		t.Fatalf("implausible opus packet size %d", n)
	}
	t.Logf("opus packet bytes=%d", n)
}
