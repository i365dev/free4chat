package doubao

import (
	"encoding/base64"
	"encoding/binary"
	"testing"
)

func TestSttClientFramesShapeAndSequences(t *testing.T) {
	initial, err := BuildSttInitialRequest("free4chat-agent")
	if err != nil {
		t.Fatalf("initial: %v", err)
	}
	// Header byte 1 = (clientFullRequest<<4)|positiveSequence = 0x11.
	if len(initial) < 8 || initial[1] != (clientFullRequest<<4)|positiveSequence {
		t.Fatalf("initial frame header mismatch: % x", initial[:4])
	}

	audio, err := BuildSttAudioRequest(2, []byte("hello pcm"))
	if err != nil {
		t.Fatalf("audio: %v", err)
	}
	if audio[1] != (clientAudioOnly<<4)|positiveSequence {
		t.Fatalf("audio frame flags mismatch: % x", audio[:4])
	}
	if audio[4] != 0 || audio[5] != 0 || audio[6] != 0 || audio[7] != 2 {
		t.Fatalf("audio sequence must be big-endian 2: % x", audio[4:8])
	}

	final, err := BuildSttAudioRequest(-3, nil)
	if err != nil {
		t.Fatalf("final: %v", err)
	}
	if final[1] != (clientAudioOnly<<4)|negativeWithSeq {
		t.Fatalf("final frame flags mismatch: % x", final[:4])
	}

	// Garbage must fail as a protocol error, never panic.
	if _, err := ParseSttResponse([]byte{0xff, 0xff}); err == nil {
		t.Fatal("garbage frame must fail")
	}
}

func TestParseSttResponseUtterances(t *testing.T) {
	// Craft a full response with a gzipped JSON payload.
	payload := gzipOrFail(t, []byte(`{"result":{"utterances":[{"text":"你好世界","definite":true,"end_time":1200}]}}`))
	frame := append(buildSttHeader(serverFullResponse, 0x1|0x2), 0, 0, 0, 0)
	frame = append(frame, withLength(payload)...)
	frame = append(frame, payload...)
	parsed, err := ParseSttResponse(frame)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if !parsed.IsLastPackage || parsed.Code != 0 || len(parsed.Result) != 1 ||
		parsed.Result[0].Text != "你好世界" || !parsed.Result[0].Definite {
		t.Fatalf("utterance mismatch: %+v", parsed)
	}
}

func TestParseSttResponseError(t *testing.T) {
	payload := gzipOrFail(t, []byte(`{}`))
	frame := append(buildSttHeader(serverErrorResponse, 0), 0, 0, 0, 7)
	frame = append(frame, withLength(payload)...)
	frame = append(frame, payload...)
	parsed, err := ParseSttResponse(frame)
	if err != nil {
		t.Fatalf("parse error response: %v", err)
	}
	if parsed.Code != 7 {
		t.Fatalf("error code mismatch: %+v", parsed)
	}
}

func gzipOrFail(t *testing.T, data []byte) []byte {
	t.Helper()
	compressed, err := gzipBytes(data)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	return compressed
}

func TestTtsStreamScannerSplitsConcatenatedObjects(t *testing.T) {
	scanner := newTtsStreamScanner()
	first := `{"code":0,"data":"` + base64.StdEncoding.EncodeToString([]byte("abc")) + `"}`
	second := `{"code":20000000,"message":"done"}`
	stream := first + second + "\n"

	objects := scanner.push(stream)
	if len(objects) != 2 || objects[0] != first || objects[1] != second {
		t.Fatalf("split mismatch: %v", objects)
	}
}

func TestTtsStreamScannerHandlesSplitAcrossChunks(t *testing.T) {
	scanner := newTtsStreamScanner()
	whole := `{"code":0,"data":"YWJj","x":["}"]}`
	got := scanner.push(whole[:10])
	if len(got) != 0 {
		t.Fatalf("partial chunk must not yield: %v", got)
	}
	got = append(got, scanner.push(whole[10:])...)
	if len(got) != 1 || got[0] != whole {
		t.Fatalf("reassembled object mismatch: %v", got)
	}
}

func TestTtsRequestBodyAndHeaders(t *testing.T) {
	body := buildTtsBody("你好", TTSDefaultVoice, "free4chat-agent")
	req := body["req_params"].(map[string]any)
	if req["text"] != "你好" || req["speaker"] != TTSDefaultVoice {
		t.Fatalf("body mismatch: %v", body)
	}
	audio := req["audio_params"].(map[string]any)
	if audio["format"] != "pcm" || audio["sample_rate"] != TTSSampleRateHz {
		t.Fatalf("audio params mismatch: %v", audio)
	}
	if TTSResourceID != "seed-tts-2.0" {
		t.Fatal("resource id changed unexpectedly")
	}
}

func TestOpusDecoderRoundTrip(t *testing.T) {
	encoder := newTestEncoder(t)
	// A non-zero mono RAMP catches channel-misread garbage (pure silence
	// cannot: zero interleaved garbage is still zero).
	ramp := make([]byte, opusFrameSamples*2)
	for i := 0; i < opusFrameSamples; i++ {
		value := int16((i%32767)*2 - 32767)
		binary.LittleEndian.PutUint16(ramp[i*2:], uint16(value))
	}
	encoded := encoder.encodeFrame(ramp)
	decoder, err := NewOpusDecoder()
	if err != nil {
		t.Fatalf("decoder: %v", err)
	}
	defer decoder.Close()
	pcm, err := decoder.DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	// 20 ms @ 16 kHz = 320 samples = 640 bytes.
	if len(pcm) != 640 {
		t.Fatalf("decoded PCM length = %d, want 640", len(pcm))
	}
	nonZero := 0
	for i := 0; i+1 < len(pcm); i += 2 {
		if int16(binary.LittleEndian.Uint16(pcm[i:])) != 0 {
			nonZero++
		}
	}
	if nonZero < 300 {
		t.Fatalf("decoded ramp is mostly zero (%d/320): channel misread", nonZero)
	}
}

func TestParseUtterancesWrapperArrayShape(t *testing.T) {
	// The real bigmodel response nests utterances inside wrapper objects:
	// result: [{"utterances":[{"text":"你好","definite":true,"end_time":99}]}]
	payload := gzipOrFail(t, []byte(`{"result":[{"utterances":[{"text":"你好","definite":true,"end_time":99}]}],"text":""}`))
	frame := append(buildSttHeader(serverFullResponse, 0x1|0x2), 0, 0, 0, 0)
	frame = append(frame, withLength(payload)...)
	frame = append(frame, payload...)
	parsed, err := ParseSttResponse(frame)
	if err != nil {
		t.Fatalf("parse wrapper array: %v", err)
	}
	if len(parsed.Result) != 1 || parsed.Result[0].Text != "你好" || !parsed.Result[0].Definite {
		t.Fatalf("wrapper-array utterances lost: %+v", parsed.Result)
	}
}
