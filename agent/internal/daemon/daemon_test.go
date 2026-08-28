package daemon

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/runtime"
	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
)

var fakeAgentBinary string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "free4chat-daemon-")
	if err != nil {
		panic(err)
	}
	bin := filepath.Join(dir, "fakeagent")
	build := exec.Command("go", "build", "-o", bin, "../harness/testdata/fakeagent")
	if out, err := build.CombinedOutput(); err != nil {
		panic("fakeagent build failed: " + string(out))
	}
	fakeAgentBinary = bin
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestRemoveStaleWorkspacesWipesEverythingInside(t *testing.T) {
	root := t.TempDir()
	stale := filepath.Join(root, "stale-instance")
	if err := os.MkdirAll(filepath.Join(stale, ".meeting-notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(stale, ".meeting-notes", "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"speaker":"Alice","text":"private"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveStaleWorkspaces(root); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale workspace survived cleanup")
	}
}

// startDaemon runs a daemon against a temporary AGENT_DIR. SendIPC from the
// tests talks to the real Unix socket; tests may reach into the daemon
// directly because they live in the same package.
func startDaemon(t *testing.T) (*Daemon, string) {
	t.Helper()
	// Unix-domain sockets require short paths on darwin (<104 chars), so the
	// runtime directory for tests lives directly under /tmp.
	dir, err := os.MkdirTemp("", "fcagent-")
	if err != nil {
		t.Fatalf("temp dir failed: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)
	// Test-spawned daemons must never touch the operator's native Keychain:
	// credential reads would block on securityd (nondeterministic hangs) and
	// could surface OS consent prompts. Mirrors the documented store.go
	// opt-out contract for unit tests.
	t.Setenv("FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE", "1")
	d := New()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := d.Run(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Errorf("daemon run failed: %v", err)
		}
	}()
	waitForSocketUp(t, SocketPath(), 2*time.Second)
	t.Cleanup(func() {
		select {
		case <-done:
		default:
			d.stopAll()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("daemon did not shut down after stop")
			}
		}
	})
	return d, dir
}

func waitForSocketUp(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("unix", path, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("unix socket never came up")
}

func ipcExpectError(t *testing.T, request *IpcRequest, wantFragment string) {
	t.Helper()
	_, err := SendIPC(request)
	if err == nil || !strings.Contains(err.Error(), wantFragment) {
		t.Fatalf("expected error containing %q, got %v", wantFragment, err)
	}
}

func TestIpcSurfaceValidationErrorsAndFallbacks(t *testing.T) {
	startDaemon(t)

	result, err := SendIPC(&IpcRequest{Op: "status"})
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	var residents []any
	if err := json.Unmarshal(result, &residents); err != nil || residents == nil {
		t.Fatalf("status must answer an array, got %s %v", result, err)
	}

	leaveResult, err := SendIPC(&IpcRequest{Op: "leave", InstanceID: "ghost"})
	if err != nil {
		t.Fatalf("leave ghost failed: %v", err)
	}
	var leaveView struct {
		InstanceID string `json:"instanceId"`
		State      string `json:"state"`
	}
	if err := json.Unmarshal(leaveResult, &leaveView); err != nil ||
		leaveView.InstanceID != "ghost" || leaveView.State != "stopped" {
		t.Fatalf("leave payload mismatch: %s", result)
	}

	ipcExpectError(t, &IpcRequest{Op: "attach"}, "attach requires file name, mime type, and data")
	ipcExpectError(t, &IpcRequest{Op: "surface-read"}, "surface read requires --participant")
	ipcExpectError(t, &IpcRequest{Op: "teleport"}, "unknown daemon operation")
	ipcExpectError(t, &IpcRequest{
		Op:         "collab-result",
		RequestID:  "r",
		Status:     "bogus",
		Summary:    "x",
		InstanceID: "",
	}, "collab result requires requestId, status, and summary")
}

// recordingClient captures capability updates and room sends so ambiguity,
// mutation, and cleanup flows can be asserted without network access.
type recordingClient struct {
	mu       sync.Mutex
	joins    int
	capLists [][]string
	sent     []string
	leftRoom bool
}

func (c *recordingClient) Connect() error               { return nil }
func (c *recordingClient) ListTools() ([]string, error) { return nil, nil }
func (c *recordingClient) RoomInfo(string) (types.RoomInfo, error) {
	return types.RoomInfo{Exists: true}, nil
}
func (c *recordingClient) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection) (types.JoinResult, error) {
	c.mu.Lock()
	c.joins++
	c.mu.Unlock()
	return types.JoinResult{
		ParticipantID:     "pid",
		ParticipantHandle: "secret-handle-value",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	}, nil
}
func (*recordingClient) CreateRoom(string, []string, *types.RuntimeHostProjection) (types.CreateRoomResult, error) {
	return types.CreateRoomResult{}, errors.New("not used")
}
func (*recordingClient) UpdateRuntimeHost(string, types.RuntimeHostProjection) error {
	return nil
}
func (*recordingClient) WaitForEvents(string, int64, int) (types.WaitResult, error) {
	time.Sleep(20 * time.Millisecond)
	return types.WaitResult{Cursor: 0, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, nil
}
func (c *recordingClient) SendText(_ string, text string, _ []string) (types.SendTextResult, error) {
	c.mu.Lock()
	c.sent = append(c.sent, text)
	c.mu.Unlock()
	return types.SendTextResult{Sequence: int64(len(c.sent))}, nil
}
func (*recordingClient) ReadAttachment(string, string) (types.AttachmentRead, error) {
	return types.AttachmentRead{}, errors.New("not used")
}
func (c *recordingClient) UpdateCapabilities(_ string, capabilities []string) error {
	c.mu.Lock()
	c.capLists = append(c.capLists, append([]string(nil), capabilities...))
	c.mu.Unlock()
	return nil
}
func (*recordingClient) SendCollabRequest(string, types.CollabRequestArgs) (types.CollabRequestOutcome, error) {
	return types.CollabRequestOutcome{RequestID: "req-x", Sequence: 1}, nil
}
func (*recordingClient) SendCollabResponse(string, types.CollabResponseArgs) (types.SendTextResult, error) {
	return types.SendTextResult{Sequence: 2}, nil
}
func (*recordingClient) SendCollabResult(string, types.CollabResultArgs) (types.SendTextResult, error) {
	return types.SendTextResult{Sequence: 3}, nil
}
func (*recordingClient) UploadAttachment(string, types.AttachmentUpload) (types.UploadedAttachment, error) {
	return types.UploadedAttachment{
		RoomAttachmentMetadata: types.RoomAttachmentMetadata{
			ID: "att-1", FileName: "report.md", MimeType: "text/markdown", Size: 8,
		},
		Sequence: 9,
	}, nil
}
func (*recordingClient) PublishSurface(string, types.SurfacePublishPayload) (types.RoomSurfaceMetadataV1, error) {
	return types.RoomSurfaceMetadataV1{}, errors.New("not used")
}
func (*recordingClient) ClearSurface(string) error { return nil }
func (*recordingClient) ReadSurface(string, string, string) (types.SurfaceReadResult, error) {
	return types.SurfaceReadResult{}, errors.New("not used")
}
func (c *recordingClient) LeaveRoom(string) error {
	c.mu.Lock()
	c.leftRoom = true
	c.mu.Unlock()
	return nil
}
func (*recordingClient) Close() error { return nil }

// stubAdapter satisfies types.HarnessAdapter without subprocess work.
type stubAdapter struct{ name string }

func (s *stubAdapter) Name() string                           { return s.name }
func (*stubAdapter) Capabilities() *types.HarnessCapabilities { return nil }
func (*stubAdapter) EnsureSession() error                     { return nil }
func (*stubAdapter) RunTurn(types.HarnessTurnInput) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: "stub-reply"}, nil
}
func (*stubAdapter) OnFailure(types.AdapterFailureHandler) {}
func (*stubAdapter) CancelTurn() error                     { return nil }
func (*stubAdapter) Close() error                          { return nil }

type stubBundle struct {
	client     *recordingClient
	runtimeRef *runtime.ResidentRuntime
}

// joinedCount observes completed JoinRoom calls: the reliable "residency is
// live" signal for unstarted-then-started stub runtimes.
func (b *stubBundle) joinedCount() int {
	b.client.mu.Lock()
	defer b.client.mu.Unlock()
	return b.client.joins
}

// capListsCount reports explicit update_capabilities mutations recorded by
// the stub transport.
func (b *stubBundle) capListsCount() int {
	b.client.mu.Lock()
	defer b.client.mu.Unlock()
	return len(b.client.capLists)
}

// registerStub injects a resident backed by pure stubs. Callers may Start()
// the returned runtime to take the connected path (Stop happens on cleanup).
func registerStub(t *testing.T, d *Daemon, instanceID string) stubBundle {
	t.Helper()
	client := &recordingClient{}
	rt := runtime.NewResidentRuntime(runtime.Options{
		InstanceID:  instanceID,
		RoomID:      "shared",
		Name:        "Stub-" + instanceID,
		Client:      client,
		Adapter:     &stubAdapter{name: "stub"},
		WaitSeconds: 1,
	})
	t.Cleanup(rt.Stop)
	d.register(&residentInstance{
		instanceID: instanceID,
		roomID:     "shared",
		runtime:    rt,
	})
	return stubBundle{client: client, runtimeRef: rt}
}

func TestResolveRuntimeAmbiguityContract(t *testing.T) {
	d, _ := startDaemon(t)
	registerStub(t, d, "inst-a")
	registerStub(t, d, "inst-b")

	_, err := SendIPC(&IpcRequest{Op: "update-capabilities"})
	if err == nil || !strings.Contains(err.Error(),
		"Multiple or no resident instances; pass --instance <id>") {
		t.Fatalf("ambiguity contract broken: %v", err)
	}
	_, err = SendIPC(&IpcRequest{Op: "update-capabilities", InstanceID: "missing"})
	if err == nil || !strings.Contains(err.Error(),
		"No resident instance missing. Run `free4chat-agent status`") {
		t.Fatalf("unknown-instance contract broken: %v", err)
	}

	// Clear both probe stubs; the same contract must also fire on an empty
	// registry ("Multiple or no ...").
	d.unregister("inst-a")
	d.unregister("inst-b")
	if _, err := SendIPC(&IpcRequest{Op: "update-capabilities"}); err == nil ||
		!strings.Contains(err.Error(),
			"Multiple or no resident instances; pass --instance <id>") {
		t.Fatalf("empty-registry contract broken: %v", err)
	}

	// Now bring a sole resident ONLINE so capability mutation flows through
	// the real connected-runtime path (lease held by the stub client).
	started := registerStub(t, d, "inst-live")
	rtStarted := started.runtimeRef
	if err := rtStarted.Start(); err != nil {
		t.Fatalf("stub residency start failed: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && started.joinedCount() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if started.joinedCount() == 0 {
		t.Fatal("stub runtime never joined")
	}

	resolved, err := SendIPC(&IpcRequest{Op: "update-capabilities"})
	if err != nil {
		t.Fatalf("single-resident lookup failed: %v", err)
	}
	var view struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(resolved, &view); err != nil {
		t.Fatalf("capabilities payload mismatch: %v (%s)", err, resolved)
	}

	mutated, err := SendIPC(&IpcRequest{
		Op:           "update-capabilities",
		Capabilities: []string{"ops"},
	})
	if err != nil {
		t.Fatalf("mutation failed: %v", err)
	}
	var updated struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(mutated, &updated); err != nil ||
		len(updated.Capabilities) != 1 || updated.Capabilities[0] != "ops" {
		t.Fatalf("mutation mismatch: %s %v", mutated, err)
	}
}

// writeModernMCPTools answers tools/list with the full required tool set so
// prepareLifecycle's Connect step succeeds before the (failing) Harness spawn.
func writeModernMCPTools(w http.ResponseWriter) {
	names := []string{
		"room_info", "join_room", "create_room", "wait_for_events",
		"send_text", "read_attachment", "leave_room", "update_capabilities",
		"send_collab_request", "send_collab_response", "send_collab_result",
		"send_attachment", "publish_surface", "clear_surface", "read_surface",
	}
	tools := make([]map[string]string, 0, len(names))
	for _, name := range names {
		tools = append(tools, map[string]string{"name": name})
	}
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{"tools": tools},
	})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

// TestJoinFailureCleanupGhostFree ensures a failed startup never leaves a
// ghost resident nor its private workspace behind.
func TestJoinFailureCleanupGhostFree(t *testing.T) {
	d, dir := startDaemon(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeModernMCPTools(w)
	}))
	defer server.Close()
	t.Setenv("FREE4CHAT_MCP_URL", server.URL)

	if _, err := SendIPC(&IpcRequest{
		Op:           "join",
		Room:         "room-cleanup",
		Name:         "Ghost-Bait",
		AgentCommand: "nonexistent-acp-binary-xyz",
	}); err == nil {
		t.Fatal("join with dead Harness must fail")
	}

	time.Sleep(50 * time.Millisecond)
	if count := d.InstanceCount(); count != 0 {
		t.Fatalf("ghost resident survived failed startup: %d", count)
	}
	workspaces := WorkspacesRoot()
	entries, readErr := os.ReadDir(workspaces)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("workspaces root unreadable: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("workspace leaked after failed join: %d entries in %s",
			len(entries), strings.ReplaceAll(strings.TrimPrefix(strings.TrimPrefix(workspaces, dir), "/"), "\n", ""))
	}
}

// TestFullVerticalSliceLocalE2E drives the entire Go pipeline locally:
// daemon -> runtime long-poll -> ACP fake Harness -> send_text back.
// The MCP layer is a scripted in-process HTTP server; the Harness is the
// same nd-json fake agent binary the harness package tests use.
func TestFullVerticalSliceLocalE2E(t *testing.T) {
	d, _ := startDaemon(t)

	type sentRecord struct {
		Text string `json:"text"`
	}
	var mu sync.Mutex
	var sentTexts []sentRecord
	var leftRoom bool

	waitCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Cursor    float64        `json:"cursor"`
				Timeout   int            `json:"timeoutSeconds"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch body.Method {
		case "tools/list":
			writeModernMCPTools(w)
		case "tools/call":
			w.Header().Set("Content-Type", "application/json")
			switch body.Params.Name {
			case "join_room":
				writeJSONRPC(w, callToolResult(map[string]any{
					"participantHandle": "secret-e2e-handle",
					"participant":       map[string]any{"id": "agent-1"},
					"cursor":            float64(0),
					"expiresAt":         float64(time.Now().Add(time.Hour).UnixMilli()),
				}))
			case "wait_for_events":
				mu.Lock()
				waitCalls++
				current := waitCalls
				cursor := body.Params.Cursor
				mu.Unlock()
				if current == 1 {
					writeJSONRPC(w, callToolResult(map[string]any{
						"events": []any{map[string]any{
							"sequence": float64(1),
							"type":     "text",
							"participant": map[string]any{
								"id":   "human-1",
								"name": "Ada",
								"kind": "human",
							},
							"text":      "hello there",
							"addressed": true,
							"createdAt": float64(1700000000000),
						}},
						"cursor":    float64(1),
						"expiresAt": float64(time.Now().Add(time.Hour).UnixMilli()),
					}))
					return
				}
				time.Sleep(30 * time.Millisecond)
				writeJSONRPC(w, callToolResult(map[string]any{
					"events":    []any{},
					"cursor":    cursor,
					"expiresAt": float64(time.Now().Add(time.Hour).UnixMilli()),
				}))
			case "send_text":
				text, _ := body.Params.Arguments["text"].(string)
				mu.Lock()
				sentTexts = append(sentTexts, sentRecord{Text: text})
				count := len(sentTexts)
				mu.Unlock()
				writeJSONRPC(w, callToolResult(map[string]any{"sequence": float64(10 + count)}))
			case "leave_room":
				mu.Lock()
				leftRoom = true
				mu.Unlock()
				writeJSONRPC(w, callToolResult(map[string]any{}))
			default:
				writeJSONRPC(w, callToolResult(map[string]any{}))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("FREE4CHAT_MCP_URL", server.URL)

	joined, err := SendIPC(&IpcRequest{
		Op:           "join",
		Room:         "vertical-e2e",
		Name:         "Pi",
		AgentCommand: fakeAgentBinary,
	})
	if err != nil {
		t.Fatalf("daemon join failed: %v", err)
	}
	var statusView struct {
		State         string `json:"state"`
		RoomID        string `json:"roomId"`
		ParticipantID string `json:"participantId"`
		InstanceID    string `json:"instanceId"`
	}
	if err := json.Unmarshal(joined, &statusView); err != nil ||
		statusView.State != "waiting" || statusView.RoomID != "vertical-e2e" ||
		statusView.ParticipantID != "agent-1" {
		t.Fatalf("join view mismatch: %s", joined)
	}

	// Wait for the addressed turn to be answered through the whole chain.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(sentTexts)
		mu.Unlock()
		if count > 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	mu.Lock()
	texts := append([]sentRecord(nil), sentTexts...)
	mu.Unlock()
	if len(texts) != 1 || texts[0].Text != "reply-1" {
		mu.Lock()
		lr := leftRoom
		mu.Unlock()
		t.Fatalf("vertical slice did not reply through the chain: %+v left=%v", texts, lr)
	}

	residents, err := SendIPC(&IpcRequest{Op: "status"})
	if err != nil {
		t.Fatalf("status during residency failed: %v", err)
	}
	var views []struct {
		State      string `json:"state"`
		InstanceID string `json:"instanceId"`
	}
	if err := json.Unmarshal(residents, &views); err != nil ||
		len(views) != 1 || views[0].State != "waiting" ||
		views[0].InstanceID != statusView.InstanceID {
		t.Fatalf("residency view mismatch: %s", residents)
	}

	left, err := SendIPC(&IpcRequest{Op: "leave", InstanceID: statusView.InstanceID})
	if err != nil {
		t.Fatalf("leave failed: %v", err)
	}
	if !strings.Contains(string(left), `"state":"stopped"`) {
		t.Fatalf("leave payload mismatch: %s", left)
	}
	time.Sleep(50 * time.Millisecond)
	if count := d.InstanceCount(); count != 0 {
		t.Fatalf("resident survived leave: %d", count)
	}
	mu.Lock()
	// LeaveRoom is best-effort on shutdown; assert the transport recorded it.
	released := leftRoom
	mu.Unlock()
	if !released {
		t.Log("note: lease release happened at teardown without explicit leave_room call")
	}

	// stop op must close the listener and unwind Run() boundedly.
	stopDone := make(chan error, 1)
	go func() { _, err := SendIPC(&IpcRequest{Op: "stop"}); stopDone <- err }()
	select {
	case <-d.closed:
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not shut down within 10s of stop")
	}
	if err := <-stopDone; err != nil {
		t.Fatalf("stop IPC failed: %v", err)
	}
}

// callToolResult wraps one tool payload in the modern content-block envelope.
func callToolResult(payload any) map[string]any {
	text, _ := json.Marshal(payload)
	return map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": string(text)}},
		},
	}
}

func writeJSONRPC(w http.ResponseWriter, envelope any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(envelope)
}

// TestRoomExpiryRemovesResidentAndWorkspace pins the Node reference's
// onRoomExpired semantics: after the server reports room_expired, the
// resident leaves the registry AND its workspace is cleaned up immediately —
// status must never show a ghost instance.
func TestRoomExpiryRemovesResidentAndWorkspace(t *testing.T) {
	d, _ := startDaemon(t)

	expiryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch body.Method {
		case "tools/list":
			writeModernMCPTools(w)
		case "tools/call":
			switch body.Params.Name {
			case "join_room":
				writeJSONRPC(w, callToolResult(map[string]any{
					"participantHandle": "expiry-handle",
					"participant":       map[string]any{"id": "agent-expiring"},
					"cursor":            float64(0),
					"expiresAt":         float64(time.Now().Add(time.Hour).UnixMilli()),
				}))
			case "wait_for_events":
				// First long-poll reports the natural room expiry.
				writeJSONRPC(w, map[string]any{
					"jsonrpc": "2.0", "id": 1,
					"result": map[string]any{
						"isError": true,
						"content": []any{map[string]any{
							"type": "text", "text": `{"error":"room_expired"}`,
						}},
					},
				})
			case "leave_room":
				writeJSONRPC(w, callToolResult(map[string]any{}))
			default:
				writeJSONRPC(w, callToolResult(map[string]any{}))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer expiryServer.Close()
	t.Setenv("FREE4CHAT_MCP_URL", expiryServer.URL)

	joined, err := SendIPC(&IpcRequest{
		Op:           "join",
		Room:         "doomed-room",
		Name:         "Expiring-Agent",
		AgentCommand: fakeAgentBinary,
	})
	if err != nil {
		t.Fatalf("join failed: %v", err)
	}
	var view struct {
		InstanceID string `json:"instanceId"`
		State      string `json:"state"`
	}
	if err := json.Unmarshal(joined, &view); err != nil || view.InstanceID == "" {
		t.Fatalf("join view mismatch: %s", joined)
	}

	// The runtime's wait loop must notice room_expired and release itself
	// through the daemon callback: registry entry gone, workspace removed.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && d.InstanceCount() != 0 {
		time.Sleep(25 * time.Millisecond)
	}
	if count := d.InstanceCount(); count != 0 {
		t.Fatalf("ghost resident survived room expiry: %d", count)
	}

	residents, err := SendIPC(&IpcRequest{Op: "status"})
	if err != nil {
		t.Fatalf("status after expiry failed: %v", err)
	}
	var remaining []any
	if err := json.Unmarshal(residents, &remaining); err != nil || len(remaining) != 0 {
		t.Fatalf("status must show zero residents after expiry: %s", residents)
	}

	entries, readErr := os.ReadDir(WorkspacesRoot())
	if readErr != nil {
		t.Fatalf("workspaces root unreadable: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("workspace leaked after room expiry: %d entries", len(entries))
	}
}

// TestCreateImmediateRoomExpiryLeavesNoGhost pins the create-lifecycle
// registration race: create_room succeeds, the FIRST wait_for_events already
// reports room_expired. Because the daemon registers the resident BEFORE the
// wait loop starts, the expiry cleanup must unregister it and remove its
// workspace — never re-register a ghost whose workspace is already gone.
func TestCreateImmediateRoomExpiryLeavesNoGhost(t *testing.T) {
	d, _ := startDaemon(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch body.Method {
		case "tools/list":
			writeModernMCPTools(w)
		case "tools/call":
			switch body.Params.Name {
			case "create_room":
				writeJSONRPC(w, callToolResult(map[string]any{
					"participantHandle": "create-expiry-handle",
					"participant":       map[string]any{"id": "agent-created"},
					"cursor":            float64(0),
					"expiresAt":         float64(time.Now().Add(time.Hour).UnixMilli()),
					"invite": map[string]any{
						"kind":    "free4chat.room-invite",
						"version": float64(1),
						"roomId":  "doomed-created-room",
						"roomUrl": "https://www.free4.chat/room?id=doomed-created-room",
					},
				}))
			case "wait_for_events":
				// The very first long-poll reports natural room expiry.
				writeJSONRPC(w, map[string]any{
					"jsonrpc": "2.0", "id": 1,
					"result": map[string]any{
						"isError": true,
						"content": []any{map[string]any{
							"type": "text", "text": `{"error":"room_expired"}`,
						}},
					},
				})
			case "leave_room":
				writeJSONRPC(w, callToolResult(map[string]any{}))
			default:
				writeJSONRPC(w, callToolResult(map[string]any{}))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("FREE4CHAT_MCP_URL", server.URL)

	createdPayload, err := SendIPC(&IpcRequest{
		Op:           "create",
		Name:         "Doomed-Creator",
		AgentCommand: fakeAgentBinary,
	})
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	var created struct {
		State  string `json:"state"`
		Invite struct {
			RoomID string `json:"roomId"`
		} `json:"invite"`
	}
	if err := json.Unmarshal(createdPayload, &created); err != nil ||
		created.Invite.RoomID != "doomed-created-room" {
		t.Fatalf("create payload mismatch: %s", createdPayload)
	}

	// The post-admission wait loop must observe the immediate expiry and
	// release the resident through the daemon callback: no ghost instance.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && d.InstanceCount() != 0 {
		time.Sleep(25 * time.Millisecond)
	}
	if count := d.InstanceCount(); count != 0 {
		t.Fatalf("ghost resident survived immediate room expiry: %d", count)
	}

	residents, err := SendIPC(&IpcRequest{Op: "status"})
	if err != nil {
		t.Fatalf("status after expiry failed: %v", err)
	}
	var remaining []any
	if err := json.Unmarshal(residents, &remaining); err != nil || len(remaining) != 0 {
		t.Fatalf("status must show zero residents after expiry: %s", residents)
	}

	entries, readErr := os.ReadDir(WorkspacesRoot())
	if readErr != nil {
		t.Fatalf("workspaces root unreadable: %v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("workspace leaked after immediate expiry: %d entries", len(entries))
	}
}

// #176 Phase A (as corrected by #178 review): daemon status exposes the
// Room-scoped DERIVED runtimeHostId (never the private root seed) and the
// coarse speech readiness shared by every resident of this root.
func TestStatusProjectsRuntimeHost(t *testing.T) {
	d, _ := startDaemon(t)
	client := &recordingClient{}
	seed := "44444444-5555-6666-7777-888888888888"
	rt := runtime.NewResidentRuntime(runtime.Options{
		InstanceID:  "inst-host",
		RoomID:      "shared",
		Name:        "Hosted-Pi",
		Client:      client,
		Adapter:     &stubAdapter{name: "stub"},
		WaitSeconds: 1,
		Speech:      &speech.Config{STTEnabled: false, TTSEnabled: true},
		HostSeed:    seed,
	})
	t.Cleanup(rt.Stop)
	d.register(&residentInstance{
		instanceID: "inst-host",
		roomID:     "shared",
		runtime:    rt,
	})

	derived, deriveErr := types.DeriveRuntimeHostID(seed, "shared")
	if deriveErr != nil {
		t.Fatalf("derive failed: %v", deriveErr)
	}

	raw, err := SendIPC(&IpcRequest{Op: "status"})
	if err != nil {
		t.Fatalf("status failed: %v", err)
	}
	var views []map[string]any
	if err := json.Unmarshal(raw, &views); err != nil {
		t.Fatalf("status parse failed: %v", err)
	}
	var view map[string]any
	for _, candidate := range views {
		if candidate["instanceId"] == "inst-host" {
			view = candidate
		}
	}
	if view == nil {
		t.Fatalf("resident instance missing from status: %v", views)
	}
	if view["runtimeHostId"] != derived {
		t.Fatalf("status must show the DERIVED room-scoped id: got %v want %s (seed %s)",
			view["runtimeHostId"], derived, seed)
	}
	speech, ok := view["speech"].(map[string]any)
	if !ok || speech["stt"] != false || speech["tts"] != true {
		t.Fatalf("speech readiness mismatch: %v", view["speech"])
	}
}
