package main

import (
	"bytes"
	"encoding/binary"
	"testing"

	pionopus "github.com/pion/opus"
)

func newPublishSpike(t *testing.T) *MediaSpike {
	spike, err := NewMediaSpike(testTracer(t), func(map[string]any) {})
	if err != nil {
		t.Skipf("engine unavailable: %v", err)
	}
	if err := spike.Create(); err != nil {
		t.Skipf("pc unavailable: %v", err)
	}
	t.Cleanup(spike.Close)
	return spike
}

func TestWritePCMRequiresActivation(t *testing.T) {
	spike := newPublishSpike(t)
	if err := spike.WritePCM(make([]byte, 960)); err == nil {
		t.Fatal("write before activation must fail closed")
	}
	if err := spike.ActivatePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if err := spike.WritePCM(make([]byte, 960)); err != nil {
		t.Fatalf("write after activation failed: %v", err)
	}
	spike.DeactivatePublish()
	if err := spike.WritePCM(make([]byte, 960)); err == nil {
		t.Fatal("write after deactivation must fail closed")
	}
}

func TestWritePCMFramesArbitraryChunksAndFlushPadsFinalFrame(t *testing.T) {
	spike := newPublishSpike(t)
	_ = spike.ActivatePublish()
	// 2.5 frames across three odd-sized chunks incl. a 1-byte split.
	total := make([]byte, 2401)
	for i := range total {
		total[i] = byte(i % 7)
	}
	for _, chunk := range [][]byte{total[:1000], total[1000:2000], total[2000:]} {
		if err := spike.WritePCM(chunk); err != nil {
			t.Fatalf("WritePCM: %v", err)
		}
	}
	if got := len(spike.PCMCarry()); got != 481 { // 2401 - 2*960
		t.Fatalf("carry = %d bytes, want 481", got)
	}
	if err := spike.FlushAudio(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if len(spike.PCMCarry()) != 0 {
		t.Fatal("carry must be empty after flush")
	}
}

func TestDeactivateDiscardsCarryAndResampleDeterministic(t *testing.T) {
	spike := newPublishSpike(t)
	_ = spike.ActivatePublish()
	_ = spike.WritePCM(bytes.Repeat([]byte{3}, 500))
	spike.DeactivatePublish()
	if len(spike.PCMCarry()) != 0 {
		t.Fatal("deactivation must discard buffered PCM")
	}
	in := make([]byte, 96)
	binary.LittleEndian.PutUint16(in[0:], 30000)
	binary.LittleEndian.PutUint16(in[2:], 10000)
	out := Resample24To48(in)
	if len(out) != 192 || binary.LittleEndian.Uint16(out[0:]) != 30000 || binary.LittleEndian.Uint16(out[2:]) != 20000 {
		t.Fatal("unexpected resample output shape/values")
	}
	if !bytes.Equal(Resample24To48(in), out) {
		t.Fatal("resample must be deterministic")
	}
	var _ pionopus.Encoder // pin reference to the pure-Go encoder package
}
