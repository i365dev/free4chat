// Package doubao ports the frozen Node Doubao provider wire behavior
// exactly: binary framed/gzipped WebSocket for streaming ASR (bigmodel) and
// the V3 output-unidirectional HTTP stream for TTS (seed-tts-2.0).
package doubao

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
)

const (
	// STTEndpoint is the streaming ASR WebSocket endpoint (bigmodel).
	STTEndpoint = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
	// STTResourceID is the ASR resource id.
	STTResourceID = "volc.seedasr.sauc.duration"
	// STTPCMRateHz is the PCM sample rate the frozen provider session sends
	// after decoding SFU Opus (16 kHz mono S16LE).
	STTPCMRateHz = 16_000

	// TTSEndpoint is the Speech Synthesis 2.0 V3 output-unidirectional
	// endpoint.
	TTSEndpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
	// TTSResourceID gates synthesis.
	TTSResourceID = "seed-tts-2.0"
	// TTSDefaultVoice is the frozen production speaker.
	TTSDefaultVoice = "zh_female_shuangkuaisisi_uranus_bigtts"
	// TTSSampleRateHz is the requested output format: 24 kHz mono S16LE.
	TTSSampleRateHz = 24_000
	// TTSEndCode is the successful stream termination business code.
	TTSEndCode = 20_000_000
)

const (
	protocolVersion     = 0x1
	headerSizeWords     = 0x1
	clientFullRequest   = 0x1
	clientAudioOnly     = 0x2
	serverFullResponse  = 0x9
	serverErrorResponse = 0xf
	positiveSequence    = 0x1
	negativeWithSeq     = 0x3
	jsonSerialization   = 0x1
	gzipCompression     = 0x1
	maxFramePayloadSize = 8 * 1024 * 1024
)

// SttHeaders builds the ASR WebSocket handshake headers.
func SttHeaders(apiKey, requestID string) map[string]string {
	return map[string]string{
		"X-Api-Key":         apiKey,
		"X-Api-Resource-Id": STTResourceID,
		"X-Api-Request-Id":  requestID,
		"X-Api-Sequence":    "-1",
	}
}

type sttAudioConfig struct {
	Format  string `json:"format"`
	Codec   string `json:"codec"`
	Rate    int    `json:"rate"`
	Bits    int    `json:"bits,omitempty"`
	Channel int    `json:"channel"`
}

type sttRequestPayload struct {
	User struct {
		UID string `json:"uid"`
	} `json:"user"`
	Audio   sttAudioConfig `json:"audio"`
	Request struct {
		ModelName       string `json:"model_name"`
		EnableNonstream bool   `json:"enable_nonstream"`
		EnableITN       bool   `json:"enable_itn"`
		EnablePunc      bool   `json:"enable_punc"`
		EnableDDC       bool   `json:"enable_ddc"`
		ShowUtterances  bool   `json:"show_utterances"`
		ResultType      string `json:"result_type"`
	} `json:"request"`
}

func buildSttHeader(messageType, flags int) []byte {
	return []byte{
		(protocolVersion << 4) | headerSizeWords,
		byte(messageType<<4) | byte(flags),
		(jsonSerialization << 4) | gzipCompression,
		0,
	}
}

func gzipBytes(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func withLength(payload []byte) []byte {
	out := make([]byte, 4)
	out[0] = byte(len(payload) >> 24)
	out[1] = byte(len(payload) >> 16)
	out[2] = byte(len(payload) >> 8)
	out[3] = byte(len(payload))
	return out
}

func sequenceBytes(sequence int32) []byte {
	out := make([]byte, 4)
	out[0] = byte(uint32(sequence) >> 24)
	out[1] = byte(uint32(sequence) >> 16)
	out[2] = byte(uint32(sequence) >> 8)
	out[3] = byte(uint32(sequence))
	return out
}

// BuildSttInitialRequest builds the gzipped full request (sequence 1).
// Codec mirrors the frozen behavior: the session always sends decoded raw
// PCM (16 kHz mono S16LE), so the request declares codec "raw".
func BuildSttInitialRequest(uid string) ([]byte, error) {
	payload := sttRequestPayload{}
	payload.User.UID = uid
	payload.Audio = sttAudioConfig{
		Format:  "pcm",
		Codec:   "raw",
		Rate:    STTPCMRateHz,
		Bits:    16,
		Channel: 1,
	}
	payload.Request.ModelName = "bigmodel"
	payload.Request.EnableNonstream = true
	payload.Request.EnableITN = true
	payload.Request.EnablePunc = true
	payload.Request.EnableDDC = false
	payload.Request.ShowUtterances = true
	payload.Request.ResultType = "full"
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	compressed, err := gzipBytes(body)
	if err != nil {
		return nil, err
	}
	return concatFrames(
		buildSttHeader(clientFullRequest, positiveSequence),
		sequenceBytes(1),
		withLength(compressed),
		compressed,
	), nil
}

// BuildSttAudioRequest builds one audio-only request frame. A negative
// sequence marks the final empty packet.
func BuildSttAudioRequest(sequenceNumber int32, data []byte) ([]byte, error) {
	compressed, err := gzipBytes(data)
	if err != nil {
		return nil, err
	}
	flags := positiveSequence
	if sequenceNumber < 0 {
		flags = negativeWithSeq
	}
	return concatFrames(
		buildSttHeader(clientAudioOnly, flags),
		sequenceBytes(sequenceNumber),
		withLength(compressed),
		compressed,
	), nil
}

func concatFrames(parts ...[]byte) []byte {
	var total int
	for _, part := range parts {
		total += len(part)
	}
	out := make([]byte, 0, total)
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

// SttResponse is one parsed server frame.
type SttResponse struct {
	Code            int            `json:"code"`
	IsLastPackage   bool           `json:"isLastPackage"`
	PayloadSequence *int           `json:"payloadSequence,omitempty"`
	Result          []SttUtterance `json:"result"`
	// Message is the bounded server payload message (diagnosis only).
	Message string `json:"message,omitempty"`
}

// SttUtterance is one recognized utterance.
type SttUtterance struct {
	Text      string   `json:"text"`
	Definite  bool     `json:"definite"`
	StartTime *float64 `json:"start_time,omitempty"`
	EndTime   *float64 `json:"end_time,omitempty"`
}

// ParseSttResponse decodes one binary server frame.
func ParseSttResponse(message []byte) (*SttResponse, error) {
	if len(message) < 4 {
		return nil, errors.New("invalid Doubao speech protocol frame")
	}
	headerSize := int(message[0] & 0x0f)
	if headerSize < 1 || len(message) < headerSize*4 {
		return nil, errors.New("invalid Doubao speech protocol frame")
	}
	messageType := int((message[1] >> 4) & 0x0f)
	flags := int(message[1] & 0x0f)
	serialization := int((message[2] >> 4) & 0x0f)
	compression := int(message[2] & 0x0f)
	offset := headerSize * 4

	var payloadSequence *int
	if flags&0x1 != 0 {
		seq, err := readInt32(message, offset)
		if err != nil {
			return nil, err
		}
		offset += 4
		value := int(seq)
		payloadSequence = &value
	}
	isLast := flags&0x2 != 0
	if flags&0x4 != 0 {
		if _, err := readInt32(message, offset); err != nil {
			return nil, err
		}
		offset += 4
	}

	code := 0
	switch messageType {
	case serverFullResponse:
		payloadSize, err := readUint32(message, offset)
		if err != nil || payloadSize > maxFramePayloadSize || offset+4+int(payloadSize) > len(message) {
			return nil, errors.New("invalid Doubao speech protocol frame")
		}
		offset += 4
	case serverErrorResponse:
		errorCode, err := readInt32(message, offset)
		if err != nil {
			return nil, err
		}
		code = int(errorCode)
		payloadSize, err := readUint32(message, offset+4)
		if err != nil || payloadSize > maxFramePayloadSize || offset+8+int(payloadSize) > len(message) {
			return nil, errors.New("invalid Doubao speech protocol frame")
		}
		offset += 8
	default:
		return nil, errors.New("invalid Doubao speech protocol frame")
	}

	body := message[offset:]
	if compression == gzipCompression {
		reader, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, errors.New("invalid Doubao speech protocol frame")
		}
		decoded, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			return nil, errors.New("invalid Doubao speech protocol frame")
		}
		body = decoded
	}

	response := &SttResponse{Code: code, IsLastPackage: isLast, PayloadSequence: payloadSequence}
	if len(body) > 0 && serialization == jsonSerialization {
		var raw struct {
			Result  json.RawMessage `json:"result"`
			Text    string          `json:"text"`
			Message string          `json:"message"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, errors.New("invalid Doubao speech protocol frame")
		}
		if raw.Message != "" && len(raw.Message) > 200 {
			raw.Message = raw.Message[:200]
		}
		response.Message = raw.Message
		// Port of the frozen Node responseUtterances: result may be an array
		// of utterance objects, an array of WRAPPER objects each carrying an
		// utterances array, an object with utterances, an object with a text
		// field, or a top-level text field.
		response.Result = parseUtterances(raw.Result, raw.Text)
	}
	return response, nil
}

// parseUtterances mirrors the frozen Node responseUtterances projection.
func parseUtterances(result json.RawMessage, topLevelText string) []SttUtterance {
	if len(result) == 0 {
		if topLevelText != "" {
			return []SttUtterance{{Text: topLevelText}}
		}
		return nil
	}
	var asArray []json.RawMessage
	if err := json.Unmarshal(result, &asArray); err == nil {
		utterances := make([]SttUtterance, 0, len(asArray))
		for _, item := range asArray {
			var wrapper struct {
				Utterances []SttUtterance `json:"utterances"`
			}
			if err := json.Unmarshal(item, &wrapper); err == nil && len(wrapper.Utterances) > 0 {
				utterances = append(utterances, wrapper.Utterances...)
				continue
			}
			var single SttUtterance
			if err := json.Unmarshal(item, &single); err == nil {
				utterances = append(utterances, single)
			}
		}
		return utterances
	}
	var asObject struct {
		Utterances []SttUtterance `json:"utterances"`
		Text       string         `json:"text"`
	}
	if err := json.Unmarshal(result, &asObject); err == nil {
		if len(asObject.Utterances) > 0 {
			return asObject.Utterances
		}
		if asObject.Text != "" {
			return []SttUtterance{{Text: asObject.Text}}
		}
	}
	return nil
}

func readUint32(data []byte, offset int) (int, error) {
	if offset+4 > len(data) {
		return 0, errors.New("invalid Doubao speech protocol frame")
	}
	return int(uint32(data[offset])<<24 | uint32(data[offset+1])<<16 |
		uint32(data[offset+2])<<8 | uint32(data[offset+3])), nil
}

func readInt32(data []byte, offset int) (int32, error) {
	value, err := readUint32(data, offset)
	if err != nil {
		return 0, err
	}
	return int32(uint32(value)), nil
}
