package free4chat

import (
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// asObject asserts a JSON value is a JSON object.
func asObject(value any) (map[string]any, error) {
	if m, ok := value.(map[string]any); ok {
		return m, nil
	}
	return nil, &Error{
		Message: "Free4Chat returned an unexpected payload shape",
		Code:    CodeToolError,
	}
}

// requiredNumber extracts a finite number field or fails the payload.
func requiredNumber(record map[string]any, field string) (int64, error) {
	raw, ok := record[field]
	if !ok {
		return 0, &Error{
			Message: fmt.Sprintf("Free4Chat response is missing %s", field),
			Code:    CodeToolError,
		}
	}
	switch v := raw.(type) {
	case float64:
		if v != v || v > 1e308 || v < -1e308 { // NaN / ±Inf guards
			return 0, &Error{
				Message: fmt.Sprintf("Free4Chat response is missing %s", field),
				Code:    CodeToolError,
			}
		}
		return int64(v), nil
	default:
		return 0, &Error{
			Message: fmt.Sprintf("Free4Chat response is missing %s", field),
			Code:    CodeToolError,
		}
	}
}

// surfaceUUIDPattern validates the snapshot id shape of workspace snapshots.
var surfaceUUIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const maxSurfaceBytes = 768 * 1024

// ParseSurfaceMetadataStrict is the shared STRICT surface-metadata contract:
// direct publish/read responses must satisfy every rule (violations produce
// a typed error) while roster projections use the same parser but OMIT
// malformed entries instead. Returns nil for any violation.
func ParseSurfaceMetadataStrict(raw any) *types.RoomSurfaceMetadataV1 {
	record, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	if kind, _ := record["kind"].(string); kind != "workspace-snapshot" {
		return nil
	}
	snapshotID, _ := record["snapshotId"].(string)
	if !surfaceUUIDPattern.MatchString(snapshotID) {
		return nil
	}
	mimeType, _ := record["mimeType"].(string)
	if mimeType != "image/jpeg" && mimeType != "image/png" && mimeType != "image/webp" {
		return nil
	}
	sizeValue, ok := record["size"].(float64)
	if !ok || sizeValue != float64(int64(sizeValue)) ||
		sizeValue <= 0 || int64(sizeValue) > maxSurfaceBytes {
		return nil
	}
	updatedAt, ok := record["updatedAt"].(float64)
	if !ok || updatedAt <= 0 {
		return nil
	}
	return &types.RoomSurfaceMetadataV1{
		SnapshotID: snapshotID,
		MimeType:   mimeType,
		Size:       int64(sizeValue),
		UpdatedAt:  int64(updatedAt),
	}
}

// NormalizeRosterEntry validates one raw roster participant and projects it
// to the sanitized runtime shape. Returns nil for entries without a usable
// id; malformed surface metadata is omitted rather than rejected.
func NormalizeRosterEntry(raw any) *types.ParticipantRosterEntry {
	record, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	id, _ := record["id"].(string)
	if id == "" {
		return nil
	}
	name, _ := record["name"].(string)
	kind := types.KindHuman
	if k, _ := record["kind"].(string); k == "agent" {
		kind = types.KindAgent
	}

	entry := &types.ParticipantRosterEntry{ID: id, Name: name, Kind: kind}

	// Two server projections exist (#111 review): room_info nests tokens
	// under capabilities.advertised; the compact wait-roster flattens them
	// to a top-level advertised array. Accept both.
	var advertisedRaw any
	if flat, present := record["advertised"]; present {
		advertisedRaw = flat
	} else if caps, ok := record["capabilities"].(map[string]any); ok {
		if nested, ok := caps["advertised"].([]any); ok {
			advertisedRaw = nested
		}
	}
	if tokens, ok := advertisedRaw.([]any); ok && len(tokens) > 0 {
		advertised := make([]string, 0, len(tokens))
		for _, token := range tokens {
			if s, ok := token.(string); ok {
				advertised = append(advertised, s)
			}
		}
		entry.Advertised = advertised
	}

	if surface := ParseSurfaceMetadataStrict(record["surface"]); surface != nil {
		entry.Surface = surface
	}
	// #176 Phase A (canonical Room model): roster entries carry the
	// Room-scoped Runtime Host id only; host readiness travels once per
	// host in the response-level runtimeHosts projection.
	if hostID, ok := record["runtimeHostId"].(string); ok && types.ValidRuntimeHostID(hostID) {
		entry.RuntimeHostID = hostID
	}
	return entry
}

// ParseRuntimeHostStrict parses the #176 Phase A Runtime Host wire
// projection {runtimeHostId, speech:{stt,tts}} FAIL-CLOSED (#178 review
// fix 2): the id must satisfy the shared opaque charset rule
// (/^[A-Za-z0-9._:-]{8,64}$/), the speech object and BOTH booleans are
// required, and any malformed, custom, or stale payload is dropped (nil)
// rather than repaired or partially accepted.
func ParseRuntimeHostStrict(raw any) *types.RuntimeHostProjection {
	record, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	id, _ := record["runtimeHostId"].(string)
	if !types.ValidRuntimeHostID(id) {
		return nil
	}
	speechBlock, ok := record["speech"].(map[string]any)
	if !ok {
		return nil
	}
	stt, hasSTT := speechBlock["stt"].(bool)
	tts, hasTTS := speechBlock["tts"].(bool)
	if !hasSTT || !hasTTS {
		return nil
	}
	return &types.RuntimeHostProjection{
		RuntimeHostID: id,
		Speech:        types.HostSpeechReadiness{STT: stt, TTS: tts},
	}
}

// NormalizeRoster projects a raw participant array, dropping unusable
// entries.
func NormalizeRoster(raw []any) []types.ParticipantRosterEntry {
	entries := make([]types.ParticipantRosterEntry, 0, len(raw))
	for _, item := range raw {
		if entry := NormalizeRosterEntry(item); entry != nil {
			entries = append(entries, *entry)
		}
	}
	return entries
}

// parseRoomEvents coerces a raw events array into typed room events; the
// server payloads are trusted to carry the documented wire shape while
// missing optional fields stay absent.
func parseRoomEvents(raw any) ([]types.RoomEvent, error) {
	list, ok := raw.([]any)
	if !ok {
		return nil, nil
	}
	events := make([]types.RoomEvent, 0, len(list))
	for _, item := range list {
		data, err := json.Marshal(item)
		if err != nil {
			continue
		}
		var event types.RoomEvent
		if err := json.Unmarshal(data, &event); err != nil {
			continue
		}
		events = append(events, event)
	}
	return events, nil
}

// decodeTextPayload decodes a tools/call result: a structured tool error
// becomes a typed failure, otherwise the first text block's embedded JSON
// document is returned.
func decodeTextPayload(rawResult any) (map[string]any, error) {
	result, err := asObject(rawResult)
	if err != nil {
		return nil, err
	}
	isError, _ := result["isError"].(bool)
	if isError {
		content, _ := result["content"].([]any)
		first, _ := content[0].(map[string]any)
		errorString := ""
		if text, ok := first["text"].(string); ok {
			var parsed struct {
				Error string `json:"error"`
			}
			if json.Unmarshal([]byte(text), &parsed) == nil && parsed.Error != "" {
				errorString = parsed.Error
			} else {
				errorString = text
			}
		}
		return nil, &Error{
			Message: errorString,
			Code:    toolErrorCode(errorString),
		}
	}
	content, _ := result["content"].([]any)
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		blockType, _ := block["type"].(string)
		text, _ := block["text"].(string)
		if blockType == "text" && text != "" {
			var decoded map[string]any
			if err := json.Unmarshal([]byte(text), &decoded); err != nil {
				return nil, &Error{
					Message: "Free4Chat returned invalid JSON",
					Code:    CodeToolError,
				}
			}
			return decoded, nil
		}
	}
	return nil, &Error{
		Message: "Free4Chat tool returned no text content",
		Code:    CodeToolError,
	}
}

// validateInvite enforces the public invite descriptor contract.
func validateInvite(invite any) error {
	record, _ := invite.(map[string]any)
	if record == nil {
		return &Error{Message: "Free4Chat returned an invalid room invite", Code: CodeToolError}
	}
	kind, _ := record["kind"].(string)
	version, versionOK := record["version"].(float64)
	roomID, _ := record["roomId"].(string)
	roomURL, _ := record["roomUrl"].(string)
	const prefix = "https://www.free4.chat/room?id="
	if kind != "free4chat.room-invite" ||
		!versionOK || int(version) != 1 ||
		roomID == "" ||
		len(roomURL) < len(prefix) || roomURL[:len(prefix)] != prefix {
		return &Error{Message: "Free4Chat returned an invalid room invite", Code: CodeToolError}
	}
	return nil
}
