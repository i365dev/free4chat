package main

import "encoding/binary"

// Resample24To48 upsamples S16LE 24 kHz mono to 48 kHz mono by deterministic
// linear interpolation between adjacent input samples (output[i] maps to
// input position i/2; even indices replicate exactly).
func Resample24To48(in []byte) []byte {
	samples := len(in) / 2
	if samples == 0 {
		return nil
	}
	out := make([]byte, samples*2*2)
	for i := 0; i < samples*2; i++ {
		pos := i / 2
		var v int16
		if i%2 == 0 || pos+1 >= samples {
			v = int16(binary.LittleEndian.Uint16(in[pos*2:]))
		} else {
			a := int32(int16(binary.LittleEndian.Uint16(in[pos*2:])))
			b := int32(int16(binary.LittleEndian.Uint16(in[pos*2+2:])))
			v = int16((a + b) / 2)
		}
		binary.LittleEndian.PutUint16(out[i*2:], uint16(v))
	}
	return out
}
