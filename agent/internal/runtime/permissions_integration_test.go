package runtime

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

type permissionRequestObservation struct {
	handle  string
	request types.RoomPermissionRequest
}

type permissionResidentClient struct {
	*residentTestClient
	requests chan permissionRequestObservation
	err      error
}

func (c *permissionResidentClient) RequestPermission(
	handle string,
	request types.RoomPermissionRequest,
) error {
	if c.err != nil {
		return c.err
	}
	c.requests <- permissionRequestObservation{handle: handle, request: request}
	return nil
}

func newPermissionResidentClient() *permissionResidentClient {
	return &permissionResidentClient{
		residentTestClient: &residentTestClient{fakeClient: &fakeClient{}},
		requests:           make(chan permissionRequestObservation, 2),
	}
}

func roomPermissionResponseEvent(requestID, agentID, kind, optionID string) types.RoomEvent {
	return types.RoomEvent{
		Sequence: 2,
		Type:     "action",
		Participant: types.ParticipantIdentity{
			ID: "human-1", Name: "Human", Kind: types.KindHuman,
		},
		ActionType: "permission",
		Permission: &types.RoomPermissionEvent{
			RequestID:          requestID,
			Kind:               kind,
			AgentParticipantID: agentID,
			SelectedOptionID:   optionID,
			HumanParticipantID: "human-1",
			HumanName:          "Human",
			CreatedAt:          time.Now().UnixMilli(),
			ExpiresAt:          time.Now().Add(time.Minute).UnixMilli(),
		},
		Addressed: true,
		CreatedAt: time.Now().UnixMilli(),
	}
}

func TestRoomPermissionMappingUsesFreshIdsAndRejectsStaleOrInvalidResponses(t *testing.T) {
	client := newPermissionResidentClient()
	rt := NewResidentRuntime(Options{
		RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"},
	})
	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.participantID = "agent-1"
	rt.mu.Unlock()

	request := harness.ACPPermissionRequest{
		RequestID: "78",
		SessionID: "session-local-only",
		Scope:     "room",
		ToolCall: harness.ACPToolCall{
			Title:    "Run command",
			Kind:     "execute",
			RawInput: []byte(`{"command":"do-not-project"}`),
		},
		Options: []harness.ACPPermissionOption{
			{OptionID: "allow-once", Name: "Allow once", Kind: "allow_once"},
			{OptionID: "reject-once", Name: "Reject", Kind: "reject_once"},
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan harness.ACPPermissionResponse, 1)
	errResult := make(chan error, 1)
	go func() {
		response, err := rt.respondToPermission(ctx, request)
		result <- response
		errResult <- err
	}()

	var first permissionRequestObservation
	select {
	case first = <-client.requests:
	case <-time.After(time.Second):
		t.Fatal("Room permission request was not sent")
	}
	if first.request.RequestID == request.RequestID || first.request.RequestID == "78" {
		t.Fatalf("ACP JSON-RPC id was reused as Room correlation id: %q", first.request.RequestID)
	}
	if first.request.TaskRequestID != "" {
		t.Fatalf("Room-scoped permission unexpectedly carried Task correlation: %q", first.request.TaskRequestID)
	}
	if !looksLikeUUID(first.request.RequestID) {
		t.Fatalf("Room correlation id is not a UUID: %q", first.request.RequestID)
	}
	if first.request.ToolCall.Title != "Run command" || first.request.ToolCall.Kind != "execute" ||
		len(first.request.Options) != 2 || first.request.Options[0].OptionID != "allow-once" ||
		first.request.ToolCall.Details["command"] != "do-not-project" {
		t.Fatalf("unsafe or incomplete Room projection: %+v", first.request)
	}
	if first.request.ToolCall.Summary != "" {
		t.Fatalf("unexpected native summary in projection: %q", first.request.ToolCall.Summary)
	}

	// A delayed response from an earlier Room request cannot resolve this one.
	stale := roomPermissionResponseEvent("old-room-request", "agent-1", "resolved", "allow-once")
	if !rt.handleRoomPermissionEvent(stale) {
		t.Fatal("permission event was not consumed")
	}
	select {
	case <-result:
		t.Fatal("stale permission event resolved the current responder")
	case <-time.After(30 * time.Millisecond):
	}

	// The Room should already validate this, but the Runtime keeps the final
	// exact native offered-option check from #290.
	invalid := roomPermissionResponseEvent(first.request.RequestID, "agent-1", "resolved", "not-offered")
	rt.handleRoomPermissionEvent(invalid)
	if response := <-result; response.OptionID != "" {
		t.Fatalf("invalid Room option reached ACP: %+v", response)
	}
	if err := <-errResult; err == nil {
		t.Fatal("invalid Room option did not fail closed")
	}
	if got := len(rt.pendingPermissions); got != 0 {
		t.Fatalf("permission mapping leaked after invalid response: %d", got)
	}

	// A second native request that reuses ACP id 78 receives a different Room
	// id, proving correlation is per lifecycle rather than per JSON-RPC id.
	secondResult := make(chan harness.ACPPermissionResponse, 1)
	secondErr := make(chan error, 1)
	go func() {
		response, err := rt.respondToPermission(context.Background(), request)
		secondResult <- response
		secondErr <- err
	}()
	var second permissionRequestObservation
	select {
	case second = <-client.requests:
	case <-time.After(time.Second):
		t.Fatal("second Room permission request was not sent")
	}
	if second.request.RequestID == first.request.RequestID || second.request.RequestID == "78" {
		t.Fatalf("Room correlation id was reused: first=%q second=%q", first.request.RequestID, second.request.RequestID)
	}
	rt.handleRoomPermissionEvent(roomPermissionResponseEvent(second.request.RequestID, "agent-1", "resolved", "allow-once"))
	if response := <-secondResult; response.OptionID != "allow-once" {
		t.Fatalf("exact native option was not returned: %+v", response)
	}
	if err := <-secondErr; err != nil {
		t.Fatalf("valid Room response failed: %v", err)
	}
}

func TestRoomPermissionMappingCarriesCanonicalTaskCorrelation(t *testing.T) {
	client := newPermissionResidentClient()
	rt := NewResidentRuntime(Options{
		RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"},
	})
	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.participantID = "agent-1"
	rt.mu.Unlock()

	result := make(chan harness.ACPPermissionResponse, 1)
	errResult := make(chan error, 1)
	go func() {
		response, err := rt.respondToPermission(context.Background(), harness.ACPPermissionRequest{
			RequestID: "78",
			SessionID: "session-local-only",
			Scope:     "task:task-T",
			ToolCall:  harness.ACPToolCall{Title: "Needs approval"},
			Options:   []harness.ACPPermissionOption{{OptionID: "allow", Name: "Allow"}},
		})
		result <- response
		errResult <- err
	}()

	var observed permissionRequestObservation
	select {
	case observed = <-client.requests:
	case <-time.After(time.Second):
		t.Fatal("Task permission request was not registered")
	}
	if observed.request.TaskRequestID != "task-T" {
		t.Fatalf("canonical Task correlation was not projected: %+v", observed.request)
	}
	rt.handleRoomPermissionEvent(
		roomPermissionResponseEvent(observed.request.RequestID, "agent-1", "resolved", "allow"),
	)
	if response := <-result; response.OptionID != "allow" {
		t.Fatalf("Task permission response did not resolve: %+v", response)
	}
	if err := <-errResult; err != nil {
		t.Fatalf("Task permission response failed: %v", err)
	}
}

func TestRoomPermissionMappingRejectsUnscopedTaskCorrelation(t *testing.T) {
	client := newPermissionResidentClient()
	rt := NewResidentRuntime(Options{
		RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"},
	})
	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.participantID = "agent-1"
	rt.mu.Unlock()

	_, err := rt.respondToPermission(context.Background(), harness.ACPPermissionRequest{
		RequestID: "78",
		SessionID: "session-local-only",
		Scope:     "task:bad scope",
		ToolCall:  harness.ACPToolCall{Title: "Needs approval"},
		Options:   []harness.ACPPermissionOption{{OptionID: "allow", Name: "Allow"}},
	})
	if err == nil {
		t.Fatal("malformed Task scope did not fail closed")
	}
	select {
	case request := <-client.requests:
		t.Fatalf("malformed Task scope reached Room: %+v", request)
	default:
	}
}

func TestResidentACPPermissionContinuesSameTurnThroughRoomEventStream(t *testing.T) {
	launcher := buildPermissionFakeLauncher(t)
	stream := newResidentTestStream()
	client := newPermissionResidentClient()
	client.streams = make(chan *residentTestStream, 1)
	client.streams <- stream
	adapter := harness.NewACPAdapter(launcher, t.TempDir(), harness.AdapterOptions{
		TurnTimeoutMs: 5_000, CancelGraceMs: 100,
	})
	sent := make(chan string, 1)
	client.fakeClient.sendHook = func(text string) { sent <- text }
	rt := NewResidentRuntime(Options{
		InstanceID: "permission-integration",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Stop)
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident permission event stream")

	trigger := roomEvent(1, true)
	trigger.Text = "permission-test"
	stream.results <- types.WaitResult{
		Events:    []types.RoomEvent{trigger},
		Cursor:    1,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	var request permissionRequestObservation
	select {
	case request = <-client.requests:
	case <-time.After(2 * time.Second):
		t.Fatal("ACP permission did not reach the Room")
	}
	if request.request.ExpiresInMs <= 0 || request.request.ExpiresInMs >= 5_000 {
		t.Fatalf("Room request was not bounded below the ACP turn timeout: %d", request.request.ExpiresInMs)
	}
	if request.request.ToolCall.Title != "delayed harmless operation" ||
		request.request.ToolCall.Summary != "Create a temporary marker file" ||
		request.request.ToolCall.Details["command"] != "touch temporary-marker" ||
		request.request.ToolCall.Details["cwd"] != "/workspace" {
		t.Fatalf("Room permission omitted the requested action presentation: %+v", request.request.ToolCall)
	}
	if request.request.RequestID == "78" {
		t.Fatal("ACP JSON-RPC id was exposed as the Room correlation id")
	}
	wire, err := json.Marshal(request.request)
	if err != nil {
		t.Fatalf("marshal Room permission request: %v", err)
	}
	for _, forbidden := range []string{
		"sessionId", "session-local", "toolCallId", "tool-delayed", "rawInput", "credential", "secret-token",
	} {
		if strings.Contains(string(wire), forbidden) {
			t.Fatalf("Room permission wire exposed %q: %s", forbidden, wire)
		}
	}

	stream.results <- types.WaitResult{
		Events: []types.RoomEvent{
			roomPermissionResponseEvent(request.request.RequestID, "agent-1", "resolved", "allow-once"),
		},
		Cursor:    2,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	select {
	case text := <-sent:
		if text != "permission-approved" {
			t.Fatalf("same ACP turn returned unexpected text: %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("same ACP turn did not complete")
	}
	waitForResidentTurnToSettle(t, rt)
	if adapter.PendingPermissionCount() != 0 {
		t.Fatal("ACP permission remained pending after Room resolution")
	}
	client.fakeClient.mu.Lock()
	waits := client.fakeClient.waits
	client.fakeClient.mu.Unlock()
	if waits != 0 {
		t.Fatalf("permission response used legacy agent-wait transport: %d waits", waits)
	}
}

func TestRoomPermissionProjectionRejectsBlindGenericExecute(t *testing.T) {
	_, _, err := projectRoomPermission(harness.ACPPermissionRequest{
		RequestID: "78",
		ToolCall: harness.ACPToolCall{
			Title:    "Run command",
			Kind:     "execute",
			RawInput: []byte(`{"env":{"TOKEN":"secret-token"},"cwd":"/workspace"}`),
		},
		Options: []harness.ACPPermissionOption{{OptionID: "allow", Name: "Allow"}},
	})
	if err == nil {
		t.Fatal("generic execute permission without a safe action presentation was allowed")
	}
}

func TestResidentHumanlessPermissionExpiryFailsClosed(t *testing.T) {
	launcher := buildPermissionFakeLauncher(t)
	stream := newResidentTestStream()
	client := newPermissionResidentClient()
	client.streams = make(chan *residentTestStream, 1)
	client.streams <- stream
	adapter := harness.NewACPAdapter(launcher, t.TempDir(), harness.AdapterOptions{
		TurnTimeoutMs: 5_000, CancelGraceMs: 100,
	})
	sent := make(chan string, 1)
	client.fakeClient.sendHook = func(text string) { sent <- text }
	rt := NewResidentRuntime(Options{
		InstanceID: "permission-headless",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Stop)
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident headless permission event stream")

	trigger := roomEvent(1, true)
	trigger.Text = "permission-test"
	stream.results <- types.WaitResult{
		Events:    []types.RoomEvent{trigger},
		Cursor:    1,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	var request permissionRequestObservation
	select {
	case request = <-client.requests:
	case <-time.After(2 * time.Second):
		t.Fatal("ACP permission did not reach the Room")
	}

	// The Room alarm supplies this event when no Human is available. The
	// responder must cancel the native request instead of broadening policy.
	stream.results <- types.WaitResult{
		Events: []types.RoomEvent{
			roomPermissionResponseEvent(request.request.RequestID, "agent-1", "expired", ""),
		},
		Cursor:    2,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	select {
	case text := <-sent:
		if text != "permission-cancelled" {
			t.Fatalf("expired permission returned unexpected text: %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expired permission did not fail closed")
	}
	waitForResidentTurnToSettle(t, rt)
	if adapter.PendingPermissionCount() != 0 {
		t.Fatal("ACP permission remained pending after expiry")
	}
	rt.permissionMu.Lock()
	defer rt.permissionMu.Unlock()
	if len(rt.pendingPermissions) != 0 {
		t.Fatalf("expired permission mapping leaked: %d", len(rt.pendingPermissions))
	}
}

func TestResidentPermissionCancellationClearsLocalMapping(t *testing.T) {
	client := newPermissionResidentClient()
	rt := NewResidentRuntime(Options{
		RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"},
	})
	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.participantID = "agent-1"
	rt.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := rt.respondToPermission(ctx, harness.ACPPermissionRequest{
			RequestID: "78",
			Scope:     "room",
			ToolCall:  harness.ACPToolCall{Title: "Needs approval"},
			Options:   []harness.ACPPermissionOption{{OptionID: "allow", Name: "Allow"}},
		})
		result <- err
	}()
	select {
	case <-client.requests:
	case <-time.After(time.Second):
		t.Fatal("permission request was not registered")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled permission did not fail closed")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled permission responder remained blocked")
	}
	if len(rt.pendingPermissions) != 0 {
		t.Fatalf("cancelled permission mapping leaked: %d", len(rt.pendingPermissions))
	}
}

func TestResidentPermissionStreamFailureClearsLocalMapping(t *testing.T) {
	client := newPermissionResidentClient()
	stream := newResidentTestStream()
	rt := NewResidentRuntime(Options{
		RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"},
	})
	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.participantID = "agent-1"
	rt.mu.Unlock()
	rt.residentMu.Lock()
	rt.resident = stream
	rt.residentMu.Unlock()

	result := make(chan error, 1)
	go func() {
		_, err := rt.respondToPermission(context.Background(), harness.ACPPermissionRequest{
			RequestID: "78",
			Scope:     "room",
			ToolCall:  harness.ACPToolCall{Title: "Needs approval"},
			Options:   []harness.ACPPermissionOption{{OptionID: "allow", Name: "Allow"}},
		})
		result <- err
	}()
	select {
	case <-client.requests:
	case <-time.After(time.Second):
		t.Fatal("permission request was not registered")
	}

	// A closed resident stream represents the same fail-closed boundary as a
	// Room expiry/leave while the ACP turn is waiting for Human approval.
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("resident stream failure did not cancel permission")
		}
	case <-time.After(time.Second):
		t.Fatal("permission responder remained blocked after stream failure")
	}
	rt.permissionMu.Lock()
	defer rt.permissionMu.Unlock()
	if len(rt.pendingPermissions) != 0 {
		t.Fatalf("stream failure leaked permission mapping: %d", len(rt.pendingPermissions))
	}
}

func looksLikeUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil && len(decoded) == 16 && decoded[6]>>4 == 4 && decoded[8]&0xc0 == 0x80
}

func waitForResidentTurnToSettle(t *testing.T, rt *ResidentRuntime) {
	t.Helper()
	waitFor(t, time.Second, func() bool {
		rt.mu.Lock()
		running := rt.turnRunning
		rt.mu.Unlock()
		return !running
	}, "resident ACP turn to settle")
}

func buildPermissionFakeLauncher(t *testing.T) types.AgentLauncher {
	t.Helper()
	_, source, _, ok := stdruntime.Caller(0)
	if !ok {
		t.Fatal("could not locate runtime test source")
	}
	agentDir := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	path := filepath.Join(t.TempDir(), "fakeagent")
	command := exec.Command("go", "build", "-o", path, "./internal/harness/testdata/fakeagent")
	command.Dir = agentDir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build fake ACP Harness: %v\n%s", err, output)
	}
	return types.AgentLauncher{
		ID: "fake", DisplayName: "Fake ACP", Command: path,
		Maturity: types.MaturityPreview, Security: types.SecurityUnverified,
		Environment: map[string]string{"FAKE_MODE": "permission_wait"},
	}
}
