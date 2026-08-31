package free4chat

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestRoomInfoParsesLiveTranscriptStrictly(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		if toolNameOf(body) != "room_info" {
			t.Fatalf("unexpected tool: %q", toolNameOf(body))
		}
		writeJSON(w, callResult(map[string]any{
			"exists": true,
			"liveTranscript": map[string]any{
				"active": true, "producerRuntimeHostId": "host-live-a",
				"startedByHumanParticipantId": "human-1", "epoch": float64(4), "startedAt": float64(9),
			},
			"liveTranscriptSegments": []any{map[string]any{
				"segmentId": "lt_alpha", "epoch": float64(4), "sequence": float64(3),
				"participantId": "human-1", "speaker": "Human", "text": "A decision.", "createdAt": float64(10),
			}},
		}))
	})
	info, err := client.RoomInfo("room")
	if err != nil {
		t.Fatal(err)
	}
	if !info.LiveTranscript.Active || info.LiveTranscript.Epoch != 4 || len(info.LiveTranscriptSegments) != 1 {
		t.Fatalf("live transcript parse mismatch: %#v", info)
	}

	// A malformed active grant and an out-of-order segment list both fail
	// closed instead of being partially trusted by the media/Harness paths.
	if got := parseLiveTranscriptState(map[string]any{"active": true, "epoch": float64(1)}); got.Active {
		t.Fatalf("partial active state must fail closed: %#v", got)
	}
	if got := parseLiveTranscriptSegments([]any{
		map[string]any{"segmentId": "a", "epoch": float64(1), "sequence": float64(2), "participantId": "h", "speaker": "H", "text": "one", "createdAt": float64(1)},
		map[string]any{"segmentId": "b", "epoch": float64(1), "sequence": float64(1), "participantId": "h", "speaker": "H", "text": "two", "createdAt": float64(2)},
	}); got != nil {
		t.Fatalf("out-of-order segments must fail closed: %#v", got)
	}
}

func TestAppendLiveTranscriptUsesNarrowRoomControlWire(t *testing.T) {
	var seenPath string
	var seenHeaders http.Header
	var seenBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenHeaders = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&seenBody); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	handleBytes, _ := json.Marshal(map[string]string{
		"room": "room-live", "participantId": "agent-live", "participantToken": "secret-token",
	})
	handle := base64.RawURLEncoding.EncodeToString(handleBytes)
	client := New(server.URL + "/mcp")
	if err := client.AppendLiveTranscript(handle, 7, "lt_abc", "human-1", "Committed text"); err != nil {
		t.Fatal(err)
	}
	if seenPath != "/api/room/live-transcript/append" ||
		seenHeaders.Get("X-Room-Id") != "room-live" ||
		seenHeaders.Get("X-Room-Participant-Id") != "agent-live" ||
		seenHeaders.Get("X-Room-Participant-Token") != "secret-token" {
		t.Fatalf("wrong direct control wire: path=%q headers=%v", seenPath, seenHeaders)
	}
	if seenBody["speaker"] != nil || seenBody["rawAudio"] != nil || seenBody["text"] != "Committed text" {
		t.Fatalf("unexpected control body: %#v", seenBody)
	}
}

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

	joined, err := client.JoinRoom("test-room", "Pi", []string{"code"}, nil)
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

	sent, err := client.SendText("h", "hi", nil)
	if err != nil || sent.Sequence != 7 {
		t.Fatalf("send mismatch: %+v %v", sent, err)
	}
}

func TestRuntimeProviderCredentialsStayOnPrivateMCPWire(t *testing.T) {
	const claimHash = "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w"
	const providerHandle = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	var captured []map[string]any
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "":
			respondToolsList(w)
		case "join_room":
			captured = append(captured, toolArgs(body))
			writeJSON(w, callResult(map[string]any{
				"participantHandle":     "participant-handle",
				"participant":           map[string]any{"id": "agent"},
				"cursor":                float64(0),
				"expiresAt":             float64(99),
				"runtimeProviderHandle": providerHandle,
			}))
		case "update_runtime_host":
			captured = append(captured, toolArgs(body))
			writeJSON(w, callResult(map[string]any{"ok": true}))
		default:
			writeJSON(w, callResult(map[string]any{}))
		}
	})
	host := types.RuntimeHostProjection{RuntimeHostID: "host-176-provider", Speech: types.HostSpeechReadiness{STT: true}}
	joined, err := client.JoinRoomWithRuntimeProvider("room-176", "Pi", nil, &host, claimHash, "")
	if err != nil {
		t.Fatal(err)
	}
	if joined.RuntimeProviderHandle != providerHandle {
		t.Fatal("provider handle was not parsed privately")
	}
	if err := client.UpdateRuntimeHostWithRuntimeProvider(joined.ParticipantHandle, host, providerHandle); err != nil {
		t.Fatal(err)
	}
	if len(captured) != 2 || captured[0]["providerClaimHash"] != claimHash {
		t.Fatalf("claim hash missing from private join wire: %#v", captured)
	}
	if _, present := captured[0]["runtimeProviderHandle"]; present {
		t.Fatal("claim redemption must not send an existing provider handle")
	}
	if captured[1]["runtimeProviderHandle"] != providerHandle {
		t.Fatal("provider proof missing from update wire")
	}
}

func TestConnectRuntimeProviderUsesPrivateRuntimeControlAndReturnsHandle(t *testing.T) {
	const claimHash = "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w"
	const providerHandle = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	var seenPath string
	var seenHeaders http.Header
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenHeaders = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Fatal(err)
		}
		writeJSON(w, map[string]any{"runtimeProviderHandle": providerHandle})
	}))
	t.Cleanup(server.Close)
	host := types.RuntimeHostProjection{RuntimeHostID: "host-176-provider", Speech: types.HostSpeechReadiness{STT: true}}
	handleBytes, _ := json.Marshal(map[string]string{
		"room": "room-176", "participantId": "agent-176", "participantToken": "private-token",
	})
	participantHandle := base64.RawURLEncoding.EncodeToString(handleBytes)
	client := New(server.URL + "/mcp")
	got, err := client.ConnectRuntimeProvider(participantHandle, host, claimHash)
	if err != nil {
		t.Fatal(err)
	}
	if got != providerHandle {
		t.Fatalf("provider handle mismatch: %q", got)
	}
	if seenPath != "/api/room/runtime-provider/connect" ||
		seenHeaders.Get("X-Room-Id") != "room-176" ||
		seenHeaders.Get("X-Room-Participant-Id") != "agent-176" ||
		seenHeaders.Get("X-Room-Participant-Token") != "private-token" {
		t.Fatalf("wrong private runtime control wire: path=%q headers=%v", seenPath, seenHeaders)
	}
	if seenHeaders.Get("Mcp-Method") != "" || seenHeaders.Get("Mcp-Name") != "" {
		t.Fatalf("provider connection must not use the public MCP tool surface: %v", seenHeaders)
	}
	if captured["providerClaimHash"] != claimHash || captured["runtimeHost"] == nil {
		t.Fatalf("provider control payload mismatch: %#v", captured)
	}
	if _, present := captured["runtimeProviderHandle"]; present {
		t.Fatal("connect must not send an existing provider handle")
	}
}

// #165: explicit targets ride the existing send_text tool arguments only
// when present; the ordinary unaddressed payload must stay byte-compatible.
func TestSendTextCarriesExplicitTargets(t *testing.T) {
	var seenArgs []map[string]any
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "":
			respondToolsList(w)
			return
		case "send_text":
			seenArgs = append(seenArgs, toolArgs(body))
			writeJSON(w, callResult(map[string]any{"sequence": float64(1)}))
		default:
			writeJSON(w, callResult(map[string]any{"sequence": float64(1)}))
		}
	})

	for _, tc := range []struct {
		text    string
		targets []string
		want    any
	}{
		{text: "plain", targets: nil, want: nil},
		{text: "one", targets: []string{"agent-b"}, want: []any{"agent-b"}},
		{text: "many", targets: []string{"agent-b", "agent-c", "agent-d"}, want: []any{"agent-b", "agent-c", "agent-d"}},
	} {
		if _, err := client.SendText("h", tc.text, tc.targets); err != nil {
			t.Fatalf("send %q failed: %v", tc.text, err)
		}
	}
	if len(seenArgs) != 3 {
		t.Fatalf("expected 3 send_text calls, saw %d", len(seenArgs))
	}
	if seenArgs[0]["targetParticipantIds"] != nil {
		t.Fatalf("plain send must omit targets, saw %v", seenArgs[0]["targetParticipantIds"])
	}
	for i, want := range []int{1, 3} {
		got, _ := seenArgs[i+1]["targetParticipantIds"].([]any)
		if len(got) != want {
			t.Fatalf("targeted send %d target count mismatch: %v", i+1, got)
		}
	}
	if seenArgs[1]["targetParticipantIds"].([]any)[0] != "agent-b" {
		t.Fatalf("single target mismatch: %v", seenArgs[1]["targetParticipantIds"])
	}
	if seenArgs[2]["targetParticipantIds"].([]any)[2] != "agent-d" {
		t.Fatalf("multi target mismatch: %v", seenArgs[2]["targetParticipantIds"])
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
		_, err := client.JoinRoom("r", "n", nil, nil)
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
	_, err := client.SendText("h", "x", nil)
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
	_, err := client.SendText("h", "x", nil)
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
	_, err := client.SendText("h", "x", nil)
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

// #176 Phase A (as corrected by #178 review fix 3): the Runtime Host
// projection rides join_room arguments only when present; create_room NEVER
// accepts one (the roomId does not exist at call time); update_runtime_host
// re-projects it. Legacy callers keep byte-identical payloads.
func TestJoinCarriesRuntimeHostProjectionCreateRoomNeverDoes(t *testing.T) {
	var seenBodies []map[string]any
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "":
			respondToolsList(w)
			return
		case "join_room", "create_room", "update_runtime_host":
			seenBodies = append(seenBodies, body)
			if toolNameOf(body) == "create_room" {
				writeJSON(w, callResult(map[string]any{
					"participantHandle": "h",
					"participant":       map[string]any{"id": "a1"},
					"cursor":            float64(1),
					"expiresAt":         float64(9),
					"invite": map[string]any{
						"kind": "free4chat.room-invite", "version": float64(1),
						"roomId": "r1", "roomUrl": "https://www.free4.chat/room?id=r1",
					},
				}))
				return
			}
			if toolNameOf(body) == "join_room" {
				writeJSON(w, callResult(map[string]any{
					"participantHandle": "h",
					"participant":       map[string]any{"id": "a1"},
					"cursor":            float64(1),
					"expiresAt":         float64(9),
				}))
				return
			}
			writeJSON(w, callResult(map[string]any{"ok": true}))
			return
		default:
			writeJSON(w, callResult(map[string]any{"sequence": float64(1)}))
		}
	})

	host := types.RuntimeHostProjection{
		RuntimeHostID: "11111111-2222-3333-4444-555555555555",
		Speech:        types.HostSpeechReadiness{STT: true, TTS: false},
	}

	// Legacy join: no runtimeHost key at all.
	if _, err := client.JoinRoom("room", "Pi", nil, nil); err != nil {
		t.Fatalf("legacy join failed: %v", err)
	}
	// Hosted join: projection rides the arguments.
	if _, err := client.JoinRoom("room", "Pi", nil, &host); err != nil {
		t.Fatalf("hosted join failed: %v", err)
	}
	// Create NEVER carries runtimeHost: the roomId does not exist yet.
	if _, err := client.CreateRoom("Pi", nil); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	// Hot-reload projection push.
	if err := client.UpdateRuntimeHost("h", host); err != nil {
		t.Fatalf("update_runtime_host failed: %v", err)
	}

	if len(seenBodies) != 4 {
		t.Fatalf("expected 4 captured tool calls, saw %d", len(seenBodies))
	}
	if _, present := toolArgs(seenBodies[0])["runtimeHost"]; present {
		t.Fatalf("legacy join must omit runtimeHost")
	}
	// create_room must NEVER carry runtimeHost (#178 review fix 3): the
	// Room-scoped id cannot exist before the server-generated roomId.
	if _, present := toolArgs(seenBodies[2])["runtimeHost"]; present {
		t.Fatalf("create_room must never carry runtimeHost")
	}
	// Captured order: [0] legacy join, [1] hosted join, [2] create_room,
	// [3] update_runtime_host.
	for i, name := range map[int]string{1: "join_room", 3: "update_runtime_host"} {
		_ = name
		got := toolArgs(seenBodies[i])["runtimeHost"].(map[string]any)
		if got["runtimeHostId"] != host.RuntimeHostID {
			t.Fatalf("runtimeHostId mismatch at capture %d: %v", i, got)
		}
		speech := got["speech"].(map[string]any)
		if speech["stt"] != true || speech["tts"] != false {
			t.Fatalf("speech mismatch: %v", speech)
		}
	}
}

// #178 review fix 1: wait_for_events responses carry runtimeHosts as a
// map of COMPLETE RuntimeHostProjection values — the real server shape.
// The client must parse each value directly (never re-wrap it as speech)
// and keep only entries whose embedded id matches the map key.
func TestWaitForEventsParsesRuntimeHostsServerShape(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		switch toolNameOf(body) {
		case "":
			respondToolsList(w)
			return
		case "wait_for_events":
			writeJSON(w, callResult(map[string]any{
				"events":    []any{},
				"cursor":    float64(3),
				"expiresAt": float64(100),
				"participants": []any{
					map[string]any{
						"id": "agent-a", "name": "Agent A", "kind": "agent",
						"runtimeHostId": "11111111-2222-3333-4444-555555555555",
					},
				},
				"runtimeHosts": map[string]any{
					// Real server shape: value IS the full projection.
					"11111111-2222-3333-4444-555555555555": map[string]any{
						"runtimeHostId": "11111111-2222-3333-4444-555555555555",
						"speech":        map[string]any{"stt": true, "tts": false},
					},
					// Embedded id must match the map key, else drop.
					"99999999-8888-7777-6666-555555555555": map[string]any{
						"runtimeHostId": "12121212-3434-5656-7878-909090909090",
						"speech":        map[string]any{"stt": false, "tts": true},
					},
					// Malformed entry must fail closed.
					"33333333-4444-5555-6666-777777777777": map[string]any{
						"runtimeHostId": "33333333-4444-5555-6666-777777777777",
					},
				},
			}))
		default:
			writeJSON(w, callResult(map[string]any{"sequence": float64(1)}))
		}
	})

	wait, err := client.WaitForEvents("h", 0, 1)
	if err != nil {
		t.Fatalf("wait failed: %v", err)
	}
	if len(wait.RuntimeHosts) != 1 {
		t.Fatalf("exactly the one valid host must parse, got %+v", wait.RuntimeHosts)
	}
	host, ok := wait.RuntimeHosts["11111111-2222-3333-4444-555555555555"]
	if !ok || !host.Speech.STT || host.Speech.TTS {
		t.Fatalf("host readiness mismatch: %+v", host)
	}
	if roster := wait.Participants; len(roster) != 1 || roster[0].RuntimeHostID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("roster runtimeHostId mismatch: %+v", roster)
	}
}
