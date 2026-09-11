package free4chat

import (
	"encoding/json"
	"net/http"
	"strings"
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

// #178 review fix 2: ParseRuntimeHostStrict must match the wire contract
// fail-closed — id charset/length, required speech object, required
// booleans. Malformed/custom/stale payloads are dropped, never repaired or
// partially accepted.
func TestParseRuntimeHostStrictFailsClosed(t *testing.T) {
	valid := map[string]any{
		"runtimeHostId": "11111111-2222-3333-4444-555555555555",
		"speech":        map[string]any{"stt": true, "tts": false},
	}
	if host := ParseRuntimeHostStrict(valid); host == nil || !host.Speech.STT || host.Speech.TTS {
		t.Fatalf("valid projection must parse: %+v", host)
	}

	negative := map[string]any{
		"missing speech":       map[string]any{"runtimeHostId": "22222222-3333-4444-5555-666666666666"},
		"speech not an object": map[string]any{"runtimeHostId": "22222222-3333-4444-5555-666666666666", "speech": "yes"},
		"stt missing":          map[string]any{"runtimeHostId": "22222222-3333-4444-5555-666666666666", "speech": map[string]any{"tts": true}},
		"tts not a boolean":    map[string]any{"runtimeHostId": "22222222-3333-4444-5555-666666666666", "speech": map[string]any{"stt": true, "tts": "yes"}},
		"stt nil":              map[string]any{"runtimeHostId": "22222222-3333-4444-5555-666666666666", "speech": map[string]any{"stt": nil, "tts": true}},
		"id with space":        map[string]any{"runtimeHostId": "bad id with spaces", "speech": map[string]any{"stt": true, "tts": true}},
		"id too short":         map[string]any{"runtimeHostId": "short", "speech": map[string]any{"stt": true, "tts": true}},
		"id too long":          map[string]any{"runtimeHostId": strings.Repeat("a", 65), "speech": map[string]any{"stt": true, "tts": true}},
		"id empty":             map[string]any{"runtimeHostId": "", "speech": map[string]any{"stt": true, "tts": true}},
		"id not a string":      map[string]any{"runtimeHostId": 42, "speech": map[string]any{"stt": true, "tts": true}},
		"not an object":        "stale-string-payload",
		"custom junk envelope": map[string]any{"hostId": "22222222-3333-4444-5555-666666666666", "ready": true},
	}
	for name, payload := range negative {
		if host := ParseRuntimeHostStrict(payload); host != nil {
			t.Fatalf("%s: malformed payload must fail closed, got %+v", name, host)
		}
	}
}

func validRoomEventPayload() map[string]any {
	return map[string]any{
		"sequence":  7,
		"type":      "text",
		"text":      "hello room",
		"addressed": true,
		"createdAt": 1700000000000,
		"participant": map[string]any{
			"id":   "human-1",
			"name": "Ada",
			"kind": "human",
		},
	}
}

func TestParseRoomEventsFailsClosedOnMalformedElements(t *testing.T) {
	malformed := map[string]any{
		"object with wrong field type": map[string]any{"sequence": "not-a-number", "type": "text"},
		"null element":                 nil,
		"scalar element":               42,
		"string element":               "not-an-event",
		"participant wrong type":       map[string]any{"sequence": 1, "type": "text", "participant": "human-1"},
	}
	for name, element := range malformed {
		if events, err := parseRoomEvents([]any{element}); err == nil {
			t.Fatalf("%s: malformed element must fail closed, got %d events", name, len(events))
		}
	}
}

func TestParseRoomEventsRejectsPartialSuccess(t *testing.T) {
	// A valid event followed by a malformed one must not yield the valid
	// prefix: the caller pairs this list with a server cursor, so accepting a
	// partial list would advance past the event that was dropped.
	events, err := parseRoomEvents([]any{
		validRoomEventPayload(),
		map[string]any{"sequence": "not-a-number"},
	})
	if err == nil {
		t.Fatalf("partial event list must not succeed, got %d events", len(events))
	}
	if events != nil {
		t.Fatalf("partial parse must not return events, got %+v", events)
	}
	// The mutation is detected before the short-circuit, proving the failure
	// is not merely a later-element accident.
	if _, err := parseRoomEvents([]any{map[string]any{"sequence": "not-a-number"}, validRoomEventPayload()}); err == nil {
		t.Fatal("malformed leading element must fail closed")
	}
}

func TestParseRoomEventsRejectsNonArrayPayload(t *testing.T) {
	for name, raw := range map[string]any{
		"object": map[string]any{"sequence": 1},
		"string": "events",
		"number": 3,
	} {
		if _, err := parseRoomEvents(raw); err == nil {
			t.Fatalf("%s: a present non-array event list must fail closed", name)
		}
	}
	if events, err := parseRoomEvents(nil); err != nil || len(events) != 0 {
		t.Fatalf("an absent event list is still no events: %v %+v", err, events)
	}
}

func TestParseRoomEventsKeepsForwardCompatibleFields(t *testing.T) {
	payload := validRoomEventPayload()
	payload["futureField"] = map[string]any{"nested": []any{1, 2, 3}}
	payload["anotherFutureField"] = "ignored"
	events, err := parseRoomEvents([]any{payload})
	if err != nil {
		t.Fatalf("unknown forward-compatible fields must stay accepted: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	if events[0].Sequence != 7 || events[0].Text != "hello room" || !events[0].Addressed {
		t.Fatalf("known fields must survive: %+v", events[0])
	}
}

// TestWaitForEventsDoesNotAdvanceCursorOnMalformedEvent is the caller-level
// half of the fail-closed contract: a malformed event must leave the caller
// with an error and no cursor to adopt.
func TestWaitForEventsDoesNotAdvanceCursorOnMalformedEvent(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		if toolNameOf(body) != "" && toolNameOf(body) != "wait_for_events" {
			t.Fatalf("unexpected tool: %q", toolNameOf(body))
		}
		if toolNameOf(body) == "" {
			respondToolsList(w)
			return
		}
		writeJSON(w, callResult(map[string]any{
			"events":    []any{map[string]any{"sequence": "not-a-number"}},
			"cursor":    99,
			"expiresAt": 1700000000000,
		}))
	})
	if err := client.Connect(); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	wait, err := client.WaitForEvents("handle", 5, 1)
	if err == nil {
		t.Fatal("malformed event must fail the wait")
	}
	if wait.Cursor != 0 || len(wait.Events) != 0 {
		t.Fatalf("cancelled wait must not surface a cursor or events: %+v", wait)
	}
}
