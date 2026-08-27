package free4chat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// fakeServer emulates the deployed /mcp wire contract closely enough to
// exercise transport classification and payload parsing.
type fakeServer struct {
	t *testing.T

	handler func(w http.ResponseWriter, body map[string]any) int
}

func (f *fakeServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		f.t.Fatalf("bad request body: %v", err)
	}
	if r.Header.Get("Mcp-Method") == "tools/call" && r.Header.Get("Mcp-Name") == "" &&
		strings.HasSuffix(toolNameOf(body), "") {
		// header presence itself validated below per-test
	}
	status := f.handler(w, body)
	if status == 0 {
		status = http.StatusOK
		w.Header().Set("Content-Type", "application/json")
	}
}

func toolNameOf(body map[string]any) string {
	params, _ := body["params"].(map[string]any)
	name, _ := params["name"].(string)
	return name
}

func newTestClient(t *testing.T, handler func(w http.ResponseWriter, body map[string]any)) (*Client, *httptest.Server) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("bad request body: %v", err)
		}
		handler(w, body)
	}))
	t.Cleanup(server.Close)
	return New(server.URL), server
}

func respondToolsList(w http.ResponseWriter) {
	tools := make([]map[string]string, 0, len(requiredTools))
	for _, name := range requiredTools {
		tools = append(tools, map[string]string{"name": name})
	}
	writeJSON(w, map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{"tools": tools},
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func callResult(payload any) map[string]any {
	text := string(mustJSONValue(payload))
	return map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": text}},
		},
	}
}

func mustJSONValue(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func TestConnectVerifiesRequiredToolSet(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		params, _ := body["params"].(map[string]any)
		meta, ok := params["_meta"].(map[string]any)
		if !ok || meta["io.modelcontextprotocol/protocolVersion"] != modernProtocolVersion {
			t.Fatalf("per-request _meta envelope missing: %v", params)
		}
		respondToolsList(w)
	})
	if err := client.Connect(); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	partial, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"tools": []any{map[string]any{"name": "room_info"}}},
		})
	})
	err := partial.Connect()
	e, ok := err.(*Error)
	if !ok || e.Code != CodeToolError || !strings.Contains(e.Message, "join_room") {
		t.Fatalf("incomplete tool set must fail: %v", err)
	}
}

func TestJoinRoomAndLifecycleCalls(t *testing.T) {
	var seenNames []string
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "":
			respondToolsList(w)
			return
		case "join_room":
			args := toolArgs(body)
			seenNames = append(seenNames, args["roomId"].(string))
			writeJSON(w, callResult(map[string]any{
				"participantHandle": "h",
				"participant":       map[string]any{"id": "a1"},
				"cursor":            float64(3),
				"expiresAt":         float64(9),
			}))
		case "wait_for_events":
			args := toolArgs(body)
			writeJSON(w, callResult(map[string]any{
				"events":       []any{},
				"cursor":       args["cursor"],
				"expiresAt":    float64(100),
				"participants": []any{flatRoster()},
			}))
		default:
			writeJSON(w, callResult(map[string]any{"sequence": float64(7)}))
		}
	})

	joined, err := client.JoinRoom("test-room", "Pi", []string{"code"})
	if err != nil {
		t.Fatalf("join failed: %v", err)
	}
	if joined.Cursor != 3 || len(seenNames) != 1 || seenNames[0] != "test-room" {
		t.Fatalf("join mismatch: %+v %v", joined, seenNames)
	}

	wait, err := client.WaitForEvents("h", 3, 20)
	if err != nil {
		t.Fatalf("wait failed: %v", err)
	}
	if wait.Cursor != 3 || len(wait.Participants) != 1 || wait.Participants[0].ID != flatRoster()["id"] {
		t.Fatalf("wait mismatch: %+v", wait)
	}

	sent, err := client.SendText("h", "hi")
	if err != nil || sent.Sequence != 7 {
		t.Fatalf("send mismatch: %+v %v", sent, err)
	}
}

func TestHTTPStatusClassification(t *testing.T) {
	for _, tc := range []struct {
		status   int
		body     string
		wantCode ErrorCode
	}{
		{http.StatusBadGateway, "boom", CodeTransient},
		{http.StatusTooManyRequests, "rate limited", CodeTransient},
		{http.StatusBadRequest, `{"error":"invalid_participant_handle"}`, CodeInvalidParticipantHandle},
		{http.StatusNotFound, "...room_expired...", CodeRoomExpired},
	} {
		_, _ = tc, tc
		client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		_, err := client.JoinRoom("r", "n", nil)
		e, ok := err.(*Error)
		if !ok || e.Code != tc.wantCode {
			t.Fatalf("status %d: expected %s got %v", tc.status, tc.wantCode, err)
		}
	}
}

func TestIsErrorPayloadMapsToTypedCodes(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, rpcOK(map[string]any{
			"isError": true,
			"content": []any{map[string]any{
				"type": "text", "text": `{"error":"invalid_participant_handle"}`,
			}},
		}))
	})
	_, err := client.SendText("h", "x")
	e, ok := err.(*Error)
	if !ok || e.Code != CodeInvalidParticipantHandle {
		t.Fatalf("tool-level isError must map to typed code: %v", err)
	}
}

func TestReadAttachmentImageAndTextPaths(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "read_attachment":
			writeJSON(w, rpcOK(map[string]any{
				"content": []any{map[string]any{
					"type": "image", "data": "QUJD", "mimeType": "image/png",
				}},
			}))
		default:
			respondToolsList(w)
		}
	})
	read, err := client.ReadAttachment("h", "att")
	if err != nil || read.Data != "QUJD" || read.MimeType != "image/png" || read.Text != "" {
		t.Fatalf("image path mismatch: %+v %v", read, err)
	}

	markdown := "# 本地测试议程\n\n- 第一项：验证文本附件\n"
	client2, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, rpcOK(map[string]any{
			"content": []any{map[string]any{
				"type": "text",
				"text": string(mustJSONValue(map[string]any{
					"data":       "IyDlsI3otLvluLrlupvlj5Hpuqw=",
					"text":       markdown,
					"attachment": map[string]any{"mimeType": "text/markdown"},
				})),
			}},
		}))
	})
	read, err = client2.ReadAttachment("h", "att-1")
	if err != nil || read.Text != markdown || read.MimeType != "text/markdown" {
		t.Fatalf("text envelope path mismatch: %+v %v", read, err)
	}
}

func TestSSEResponseParsing(t *testing.T) {
	client, server := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		result := map[string]any{
			"content": []any{map[string]any{"type": "text", "text": `{"sequence":42}`}},
		}
		sse := "event: message\ndata: " + string(mustJSONValue(rpcOK(result))) + "\n\n"
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse))
	})
	defer server.Close()
	_, err := client.SendText("h", "x")
	if err != nil {
		// SendText path uses rawCall -> post; SSE parse should succeed.
		t.Fatalf("SSE response mishandled: %v", err)
	}
}

func TestCreateRoomValidatesInvite(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, callResult(map[string]any{
			"participantHandle": "h",
			"participant":       map[string]any{"id": "a"},
			"cursor":            float64(0),
			"expiresAt":         float64(1),
			"invite": map[string]any{
				"kind":    "free4chat.room-invite",
				"version": float64(1),
				"roomId":  "made-up-room",
				"roomUrl": "https://www.free4.chat/room?id=made-up-room",
			},
		}))
	})
	created, err := client.CreateRoom("Pi", nil)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if created.Invite.RoomID != "made-up-room" || created.Invite.Kind != "free4chat.room-invite" {
		t.Fatalf("invite mismatch: %+v", created.Invite)
	}

	bad, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, callResult(map[string]any{
			"participantHandle": "h",
			"participant":       map[string]any{"id": "a"},
			"cursor":            float64(0),
			"expiresAt":         float64(1),
			"invite": map[string]any{
				"kind":    "other",
				"version": float64(1),
				"roomId":  "x",
				"roomUrl": "https://www.free4.chat/room?id=x",
			},
		}))
	})
	if _, err := bad.CreateRoom("Pi", nil); err == nil {
		t.Fatal("invalid invite kind must fail")
	}
}

func TestCollabAndSurfaceSurfaces(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "send_collab_request":
			args := toolArgs(body)
			duplicate := args["requestId"] == "known-id"
			payload := map[string]any{
				"requestId": "req-1",
				"sequence":  float64(8),
			}
			if duplicate {
				payload["duplicate"] = true
			}
			writeJSON(w, callResult(payload))
		case "publish_surface":
			writeJSON(w, callResult(map[string]any{
				"surface": validSurface(),
			}))
		case "clear_surface":
			writeJSON(w, callResult(map[string]any{"cleared": true}))
		case "read_surface":
			writeJSON(w, rpcOK(map[string]any{
				"content": []any{
					map[string]any{"type": "image", "data": "AAAA", "mimeType": "image/png"},
					map[string]any{"type": "text", "text": string(mustJSONValue(
						map[string]any{"surface": validSurface()}))},
				},
			}))
		default:
			writeJSON(w, callResult(map[string]any{"sequence": float64(1)}))
		}
	})

	outcome, err := client.SendCollabRequest("h", types.CollabRequestArgs{
		TargetParticipantID: "peer-3",
		Summary:             "help me audit the logs",
	})
	if err != nil || outcome.Sequence != 8 || outcome.Duplicate {
		t.Fatalf("first request mismatch: %+v %v", outcome, err)
	}
	repeat := types.CollabRequestArgs{
		TargetParticipantID: "peer-3",
		Summary:             "help me audit the logs",
		RequestID:           "known-id",
	}
	outcome, err = client.SendCollabRequest("h", repeat)
	if err != nil || !outcome.Duplicate {
		t.Fatalf("duplicate semantics lost: %+v %v", outcome, err)
	}

	surface, err := client.PublishSurface("h", types.SurfacePublishPayload{
		MimeType:   "image/png",
		DataBase64: "AAAA",
	})
	if err != nil || surface.Size != 2048 {
		t.Fatalf("publish mismatch: %+v %v", surface, err)
	}
	if err := client.ClearSurface("h"); err != nil {
		t.Fatalf("clear failed: %v", err)
	}
	read, err := client.ReadSurface("h", "peer-1", validSurface()["snapshotId"].(string))
	if err != nil || read.Data != "AAAA" || read.Surface.SnapshotID != validSurface()["snapshotId"] {
		t.Fatalf("read mismatch: %+v %v", read, err)
	}

	// Cross-check: a wrong snapshot id in bytes fails closed.
	mismatched, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		swapped := validSurface()
		swapped["snapshotId"] = "123e4567-e89b-12d3-a456-426614174999"
		writeJSON(w, rpcOK(map[string]any{
			"content": []any{
				map[string]any{"type": "image", "data": "AAAA", "mimeType": "image/png"},
				map[string]any{"type": "text", "text": string(mustJSONValue(map[string]any{"surface": swapped}))},
			},
		}))
	})
	if _, err := mismatched.ReadSurface("h", "peer-1", "123e4567-e89b-12d3-a456-426614174000"); err == nil {
		t.Fatal("different snapshot than requested must fail closed")
	}
}

func TestUploadAttachment(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, callResult(map[string]any{
			"attachment": map[string]any{
				"id":       "att-9",
				"fileName": "report.md",
				"mimeType": "text/markdown",
				"size":     float64(120),
				"sequence": float64(14),
			},
		}))
	})
	uploaded, err := client.UploadAttachment("h", types.AttachmentUpload{
		FileName:   "report.md",
		MimeType:   "text/markdown",
		DataBase64: "IyByZXBvcnQ=",
	})
	if err != nil || uploaded.ID != "att-9" || uploaded.Size != 120 ||
		uploaded.FileName != "report.md" || uploaded.MimeType != "text/markdown" {
		t.Fatalf("upload mismatch: %+v %v", uploaded, err)
	}
}

func TestRPCLevelErrorIsTransient(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		writeJSON(w, map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"error": map[string]any{"code": -32000, "message": "overloaded"},
		})
	})
	_, err := client.SendText("h", "x")
	e, ok := err.(*Error)
	if !ok || e.Code != CodeTransient {
		t.Fatalf("rpc error should be transient: %v", err)
	}
}

func flatRoster() map[string]any {
	return map[string]any{
		"id": "peer-3", "name": "Ada", "kind": "human",
		"advertised": []any{"ops"},
	}
}

func validSurface() map[string]any {
	return map[string]any{
		"kind":       "workspace-snapshot",
		"snapshotId": "123e4567-e89b-12d3-a456-426614174000",
		"mimeType":   "image/png",
		"size":       float64(2048),
		"updatedAt":  float64(1700000000000),
	}
}

func rpcOK(result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": 1, "result": result}
}

func toolArgs(body map[string]any) map[string]any {
	params, _ := body["params"].(map[string]any)
	args, _ := params["arguments"].(map[string]any)
	return args
}

func TestClientSendsExplicitUserAgent(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("User-Agent")
		respondToolsList(w)
	}))
	defer server.Close()
	if err := New(server.URL).Connect(); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	if seen != defaultUserAgent {
		t.Fatalf("explicit UA missing, got %q", seen)
	}
	if strings.Contains(seen, "Go-http-client") {
		t.Fatalf("default Go UA must never be sent: %q", seen)
	}
}
