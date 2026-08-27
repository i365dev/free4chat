package free4chat

import (
	"encoding/json"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestParseSurfaceMetadataStrict(t *testing.T) {
	valid := map[string]any{
		"kind":       "workspace-snapshot",
		"snapshotId": "123e4567-e89b-12d3-a456-426614174000",
		"mimeType":   "image/png",
		"size":       float64(2048),
		"updatedAt":  float64(1700000000000),
	}
	if got := ParseSurfaceMetadataStrict(valid); got == nil {
		t.Fatalf("valid surface metadata rejected")
	}

	cases := []struct {
		name string
		mut  func(map[string]any)
	}{
		{"wrong kind", func(m map[string]any) { m["kind"] = "other" }},
		{"bad uuid", func(m map[string]any) { m["snapshotId"] = "not-a-uuid" }},
		{"bad mime", func(m map[string]any) { m["mimeType"] = "image/gif" }},
		{"zero size", func(m map[string]any) { m["size"] = float64(0) }},
		{"oversize", func(m map[string]any) { m["size"] = float64(768*1024 + 1) }},
		{"no updatedAt", func(m map[string]any) { m["updatedAt"] = float64(0) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := deepCopyMap(valid)
			tc.mut(record)
			if got := ParseSurfaceMetadataStrict(record); got != nil {
				t.Fatalf("expected nil, got %+v", got)
			}
		})
	}

	if ParseSurfaceMetadataStrict("string") != nil {
		t.Fatal("non-object input must be rejected")
	}
}

func TestNormalizeRosterEntryAcceptsBothProjections(t *testing.T) {
	nested := map[string]any{
		"id":   "agent-1",
		"name": "Pi",
		"kind": "agent",
		"capabilities": map[string]any{
			"advertised": []any{"code", "research"},
		},
	}
	entry := NormalizeRosterEntry(nested)
	if entry == nil || len(entry.Advertised) != 2 || entry.Advertised[0] != "code" {
		t.Fatalf("nested advertised projection failed: %+v", entry)
	}

	flat := map[string]any{
		"id":         "human-1",
		"name":       "Ada",
		"kind":       "human",
		"advertised": []any{},
	}
	entry = NormalizeRosterEntry(flat)
	if entry == nil || entry.Kind != types.KindHuman || entry.Advertised != nil {
		t.Fatalf("flat advertised projection failed: %+v", entry)
	}

	if NormalizeRosterEntry(map[string]any{"name": "ghost"}) != nil {
		t.Fatal("entries without id must be dropped")
	}
	bad := map[string]any{
		"id":      "agent-2",
		"surface": map[string]any{"kind": "bogus"},
	}
	entry = NormalizeRosterEntry(bad)
	if entry == nil || entry.Surface != nil {
		t.Fatal("malformed surface must be omitted, not reject the entry")
	}
}

func TestValidateJoinAndCreatePayloads(t *testing.T) {
	result := map[string]any{
		"participantHandle": "handle-value",
		"participant":       map[string]any{"id": "agent-9"},
		"cursor":            float64(5),
		"expiresAt":         float64(123),
	}
	joined, err := parseJoinLike(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if joined.ParticipantID != "agent-9" || joined.Cursor != 5 {
		t.Fatalf("bad parse: %+v", joined)
	}

	broken := deepCopyMap(result)
	delete(broken, "cursor")
	if _, err := parseJoinLike(broken); err == nil {
		t.Fatal("missing cursor must fail")
	}

	broken = deepCopyMap(result)
	broken["participant"] = map[string]any{}
	if _, err := parseJoinLike(broken); err == nil {
		t.Fatal("missing participant id must fail")
	}
}

func TestDecodeTextPayloadToolErrors(t *testing.T) {
	raw := map[string]any{
		"isError": true,
		"content": []any{map[string]any{
			"type": "text",
			"text": mustJSONString(map[string]string{"error": "invalid_participant_handle"}),
		}},
	}
	_, err := decodeTextPayload(raw)
	e, ok := err.(*Error)
	if !ok || e.Code != CodeInvalidParticipantHandle {
		t.Fatalf("expected typed lifecycle code, got %v", err)
	}

	raw = map[string]any{
		"isError": true,
		"content": []any{map[string]any{"type": "text", "text": `{"error":"room_expired"}`}},
	}
	_, err = decodeTextPayload(raw)
	e, _ = err.(*Error)
	if e == nil || e.Code != CodeRoomExpired {
		t.Fatalf("expected room_expired, got %v", err)
	}

	good := map[string]any{
		"content": []any{map[string]any{
			"type": "text",
			"text": mustJSONString(map[string]any{"sequence": float64(11)}),
		}},
	}
	payload, err := decodeTextPayload(good)
	if err != nil {
		t.Fatalf("good payload rejected: %v", err)
	}
	if payload["sequence"].(float64) != 11 {
		t.Fatalf("payload mismatch: %v", payload)
	}
}

func TestInviteValidation(t *testing.T) {
	good := map[string]any{
		"kind":    "free4chat.room-invite",
		"version": float64(1),
		"roomId":  "fresh-room",
		"roomUrl": "https://www.free4.chat/room?id=fresh-room",
	}
	if err := validateInvite(good); err != nil {
		t.Fatalf("valid invite rejected: %v", err)
	}
	bad := deepCopyMap(good)
	bad["roomUrl"] = "https://evil.example/room"
	if err := validateInvite(bad); err == nil {
		t.Fatal("foreign room URL must be rejected")
	}
}

func TestJSONMarshalsLifecycleCodes(t *testing.T) {
	data, err := json.Marshal(CodeTransient)
	if err != nil || string(data) != `"transient"` {
		t.Fatalf("code marshal mismatch: %s %v", data, err)
	}
}

func mustJSONString(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func deepCopyMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		switch v := value.(type) {
		case map[string]any:
			out[key] = deepCopyMap(v)
		default:
			out[key] = value
		}
	}
	return out
}
