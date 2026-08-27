package doubao

import (
	"encoding/binary"
	"errors"

	"github.com/pion/opus"
)

const (
	opusDecodeRateHz = 48_000
	// The SFU human-mic stream is MONO (Node configured streamCount 1 with
	// a 2-channel output upmix). Decoding with a 2-channel output config
	// misreads mono packets as interleaved garbage — Doubao then rejects the
	// audio with 45000000. Decode mono and only downmix if a packet
	// genuinely decodes stereo.
	opusDecodeChannels = 1
	opusFrameSamples   = 960 // 20 ms @ 48 kHz
	opusMaxFrameBytes  = 960 * 2 * 2 * 2
)

// OpusDecoder decodes SFU Opus payloads (48 kHz) into 16 kHz mono S16LE PCM
// for the ASR session, mirroring the frozen Node opus-decoder path: decode
// 48 kHz, mix channels, resample 48k -> 16k (3:1 averaging).
type OpusDecoder struct {
	decoder opus.Decoder
	opened  bool
}

// NewOpusDecoder builds the shared per-session decoder.
func NewOpusDecoder() (*OpusDecoder, error) {
	decoder, err := opus.NewDecoderWithOutput(opusDecodeRateHz, opusDecodeChannels)
	if err != nil {
		return nil, err
	}
	return &OpusDecoder{decoder: decoder, opened: true}, nil
}

// DecodeFrame decodes one Opus packet (20 ms @ 48 kHz mono) and returns
// 16 kHz mono S16LE PCM (3:1 averaging decimation).
func (d *OpusDecoder) DecodeFrame(payload []byte) ([]byte, error) {
	if !d.opened {
		return nil, errors.New("doubao opus decoder is unavailable")
	}
	out := make([]byte, opusMaxFrameBytes)
	_, isStereo, err := d.decoder.Decode(payload, out)
	if err != nil {
		// DTX/comfort-noise packets can fail a strict decode. The frozen
		// Node path (opus-decoder) covers them with PLC comfort noise, so
		// substitute one silence frame instead of failing the session —
		// failing here cascades into provider errors and kills the whole
		// participant's transcription.
		return make([]byte, opusFrameSamples/3*2), nil
	}
	channels := 1
	frameSamples := opusFrameSamples
	if isStereo {
		channels = 2
		frameSamples = len(out) / 2 / 2
	}
	// DTX / comfort-noise packets decode to ZERO samples: sending an empty
	// audio frame makes Doubao reject the stream with 45000000. Fill one
	// 20ms silence frame instead (PLC-equivalent; never an empty payload).
	pcm := make([]byte, 0, (frameSamples/3+1)*2)
	if frameSamples == 0 || len(out) == 0 {
		return make([]byte, opusFrameSamples/3*2), nil
	}
	for i := 0; i+3 <= frameSamples; i += 3 {
		var sum int32
		for j := 0; j < 3; j++ {
			acc := int32(0)
			for ch := 0; ch < channels; ch++ {
				index := (i+j)*channels + ch
				if index*2+1 >= len(out) {
					break
				}
				acc += int32(int16(binary.LittleEndian.Uint16(out[index*2:])))
			}
			sum += acc / int32(channels)
		}
		sample := sum / 3
		pcm = append(pcm, byte(uint16(sample)), byte(uint16(sample)>>8))
	}
	return pcm, nil
}

// Close releases the underlying decoder (idempotent).
func (d *OpusDecoder) Close() {
	d.opened = false
	d.decoder = opus.Decoder{}
}
