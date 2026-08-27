package harness

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

var fakeAgentPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "free4chat-harness-")
	if err != nil {
		panic(err)
	}
	bin := filepath.Join(dir, "fakeagent")
	build := exec.Command("go", "build", "-o", bin, "./testdata/fakeagent")
	if out, err := build.CombinedOutput(); err != nil {
		panic("fakeagent build failed: " + string(out))
	}
	fakeAgentPath = bin
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func scriptLauncher(mode string, extraEnv map[string]string) types.AgentLauncher {
	env := map[string]string{"FAKE_MODE": mode}
	for key, value := range extraEnv {
		env[key] = value
	}
	return types.AgentLauncher{
		ID:          "fake",
		DisplayName: "Fake ACP",
		Command:     fakeAgentPath,
		Args:        []string{},
		Maturity:    types.MaturityPreview,
		Security:    types.SecurityUnverified,
		Environment: env,
	}
}

func turnInput(text string) types.HarnessTurnInput {
	return types.HarnessTurnInput{
		Room: types.RoomTurnContext{Ephemeral: true},
		Events: []types.HarnessEvent{{
			Sender:    "Human",
			Kind:      types.KindHuman,
			Text:      text,
			Addressed: true,
			Sequence:  1,
			CreatedAt: time.Now().UnixMilli(),
		}},
	}
}

func newTestAdapter(t *testing.T, launcher types.AgentLauncher, options AdapterOptions) (*ACPAdapter, string) {
	t.Helper()
	workspace := t.TempDir()
	return NewACPAdapter(launcher, workspace, options), workspace
}

func TestACPNegotiatesOnceAndReusesOneSession(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", nil), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	caps := adapter.Capabilities()
	if caps == nil || !caps.Text || caps.Images || caps.Resume {
		t.Fatalf("capability projection mismatch: %+v", caps)
	}

	result, err := adapter.RunTurn(turnInput("first"))
	if err != nil || result.Text != "reply-1" {
		t.Fatalf("first turn mismatch: %+v %v", result, err)
	}
	result, err = adapter.RunTurn(turnInput("second"))
	if err != nil || result.Text != "reply-2" {
		t.Fatalf("session reuse broken: %+v %v", result, err)
	}
}

func TestACPAutoCancelsPermissionAndNegotiatesImages(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("permission",
		map[string]string{"FAKE_IMAGE_CAP": "1"}), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	if !adapter.Capabilities().Images {
		t.Fatal("image capability was not negotiated")
	}
	result, err := adapter.RunTurn(turnInput("permission-test"))
	if err != nil {
		t.Fatalf("turn failed: %v", err)
	}
	// Fail-closed invariant: the permission request was answered cancelled
	// and the Harness reported the cancelled continuation.
	if result.Text != "permission-cancelled" {
		t.Fatalf("expected cancelled continuation, got %q", result.Text)
	}
}

func TestACPCancelStopsInFlightPrompt(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("cancel", nil), AdapterOptions{
		TurnTimeoutMs: 5_000,
	})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}

	type outcome struct {
		text string
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := adapter.RunTurn(turnInput("cancel-test"))
		done <- outcome{result.Text, err}
	}()
	time.Sleep(80 * time.Millisecond)
	if err := adapter.CancelTurn(); err != nil {
		t.Fatalf("cancel failed: %v", err)
	}
	select {
	case got := <-done:
		if got.err != nil || got.text != "cancelled" {
			t.Fatalf("cancel flow mismatch: %q %v", got.text, got.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("turn never settled after cancel")
	}
}

func TestACPProcessDeathFailsPromptlyAndRecovers(t *testing.T) {
	workspace := t.TempDir()
	marker := filepath.Join(workspace, "restart-marker")
	adapter := NewACPAdapter(scriptLauncher("restart",
		map[string]string{"FAKE_RESTART_MARKER": marker}), workspace, AdapterOptions{})
	defer adapter.Close()

	failed := make(chan error, 1)
	adapter.OnFailure(func(err error) { failed <- err })

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	result, err := adapter.RunTurn(turnInput("first"))
	if err != nil || result.Text != "reply-1" {
		t.Fatalf("first turn mismatch: %+v %v", result, err)
	}
	select {
	case err := <-failed:
		if !strings.Contains(err.Error(), "ACP process exited") {
			t.Fatalf("failure message mismatch: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("process death did not surface through OnFailure")
	}

	// Next turn respawns a fresh Harness process and succeeds.
	result, err = adapter.RunTurn(turnInput("second"))
	if err != nil || result.Text != "reply-2" {
		t.Fatalf("post-death respawn mismatch: %+v %v", result, err)
	}
}

func TestACPStartupExitFailsEnsureSession(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("exit_startup_kill", nil), AdapterOptions{})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err == nil {
		t.Fatal("dead-at-startup Harness must fail EnsureSession")
	}
}

func TestACPStuckTurnTimesOutCancelsTerminatesAndRecovers(t *testing.T) {
	workspace := t.TempDir()
	stateMarker := filepath.Join(workspace, "stuck-state")
	cancelMarker := filepath.Join(workspace, "cancel-sent")
	launcher := scriptLauncher("timeout_stuck", map[string]string{
		"FAKE_STATE_MARKER":  stateMarker,
		"FAKE_CANCEL_MARKER": cancelMarker,
	})
	adapter := NewACPAdapter(launcher, workspace, AdapterOptions{
		TurnTimeoutMs: 60,
		CancelGraceMs: 40,
	})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	started := time.Now()
	_, err := adapter.RunTurn(turnInput("timeout-test"))
	var timeoutErr *TurnTimeoutError
	if !asTimeoutError(err, &timeoutErr) {
		t.Fatalf("expected TurnTimeoutError, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("recovery took too long: %s", elapsed)
	}
	waitForFile(t, cancelMarker, 2*time.Second, "cancellation reached the stuck agent")

	// Fresh process recovers; the first was terminated via the escalation path.
	recovered, err := adapter.RunTurn(turnInput("recover"))
	if err != nil || recovered.Text != "recovered" {
		t.Fatalf("recovery mismatch: %+v %v", recovered, err)
	}
}

func waitForFile(t *testing.T, path string, timeout time.Duration, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s (%s)", message, path)
}

func asTimeoutError(err error, target **TurnTimeoutError) bool {
	if te, ok := err.(*TurnTimeoutError); ok {
		*target = te
		return true
	}
	return false
}

func TestBuildHarnessEnvironmentIsAllowListed(t *testing.T) {
	codex, _ := GetLauncher("codex")
	environment := BuildHarnessEnvironment(codex, map[string]string{
		"PATH":                  "/safe/bin",
		"HOME":                  "/home/test",
		"OPENAI_API_KEY":        "provider-secret",
		"AWS_SECRET_ACCESS_KEY": "must-not-pass",
		"GH_TOKEN":              "must-not-pass",
		"GITHUB_TOKEN":          "must-not-pass",
		"CODEX_CONFIG":          "/unsafe/config",
		"INITIAL_AGENT_MODE":    "full-access",
	})
	if environment["PATH"] != "/safe/bin" || environment["HOME"] != "/home/test" {
		t.Fatalf("safe keys lost: %v", environment)
	}
	if environment["OPENAI_API_KEY"] != "provider-secret" {
		t.Fatal("provider credentials must survive the filter")
	}
	for _, forbidden := range []string{"AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "GITHUB_TOKEN"} {
		if _, present := environment[forbidden]; present {
			t.Fatalf("%s must not leak into the Harness environment", forbidden)
		}
	}
	if _, present := environment["CODEX_CONFIG"]; present {
		t.Fatal("ambient CODEX_CONFIG must be dropped")
	}
	if environment["INITIAL_AGENT_MODE"] != "read-only" {
		t.Fatalf("trusted launcher override lost: %v", environment["INITIAL_AGENT_MODE"])
	}
}

func TestGetLauncherRegistryContracts(t *testing.T) {
	opencode, err := GetLauncher("opencode")
	if err != nil {
		t.Fatalf("opencode missing: %v", err)
	}
	want := []string{"acp", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false", "--pure"}
	if len(opencode.Args) != len(want) {
		t.Fatalf("opencode args mismatch: %v", opencode.Args)
	}
	for i := range want {
		if opencode.Args[i] != want[i] {
			t.Fatalf("opencode args[%d]: got %s want %s", i, opencode.Args[i], want[i])
		}
	}

	hermes, err := GetLauncher("hermes")
	if err != nil || hermes.Security != types.SecurityTrustedRoom {
		t.Fatalf("hermes security contract broken: %+v %v", hermes.Security, err)
	}
	if !strings.Contains(strings.ToLower(hermes.Notes), "no safe no-tools profile") {
		t.Fatalf("hermes notes must warn about no safe profile: %s", hermes.Notes)
	}

	if _, err := GetLauncher("deepseek-harness"); err == nil ||
		err.Error() != "DeepSeek Harness is preview-only; set FREE4CHAT_DEEPSEEK_REPO or use --agent-command" {
		t.Fatalf("deepseek repo guard mismatch: %v", err)
	}
	t.Setenv("FREE4CHAT_DEEPSEEK_REPO", "/repo/checkout")
	withRepo, err := GetLauncher("deepseek-harness")
	if err != nil || withRepo.Args[0] != "--dir" || withRepo.Args[1] != "/repo/checkout" {
		t.Fatalf("deepseek dir prepending mismatch: %+v %v", withRepo.Args, err)
	}

	if _, err := GetLauncher("nonexistent"); err == nil ||
		err.Error() != "Unknown ACP launcher: nonexistent" {
		t.Fatalf("unknown launcher message mismatch: %v", err)
	}

	if _, err := CustomLauncher("   ", nil); err == nil ||
		err.Error() != "ACP agent command cannot be empty" {
		t.Fatalf("custom launcher empty-command guard mismatch: %v", err)
	}
}

func TestParseAgentCapabilitiesResumeAndClosePresence(t *testing.T) {
	// Resume support = mere presence of the key (Node parity).
	raw := json.RawMessage(`{
	  "promptCapabilities": {"image": true},
	  "sessionCapabilities": {"resume": {}, "close": {}}
	}`)
	caps, err := parseAgentCapabilities(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if !caps.ResumePresent || !caps.ClosePresent || !caps.Images {
		t.Fatalf("presence semantics broken: %+v", caps)
	}
	if _, err := parseAgentCapabilities(nil); err == nil {
		t.Fatal("empty capability document must fail")
	}

	// The fake agent without FAKE_RESUME_CAP must project resume=false.
	noResume, err := parseAgentCapabilities(json.RawMessage(
		`{"promptCapabilities":{},"sessionCapabilities":{"close":{}}}`))
	if err != nil || noResume.ResumePresent {
		t.Fatalf("absent resume key must be false: %+v", noResume)
	}
}

func TestRenderUntrustedRoomTurnInvariants(t *testing.T) {
	input := turnInput("hello")
	rendered := RenderUntrustedRoomTurn(&input)

	if strings.Contains(rendered, "participantHandle") || strings.Contains(rendered, "token") {
		t.Fatal("capability token leaked into prompt rendering")
	}
	lowerRendered := strings.ToLower(rendered)
	for _, fragment := range []string{
		"not a coding, research, or computer-use task",
		"do not call mcp or free4chat tools",
		"do not ask for or invent room identity",
		"respond with a brief conversational reply",
	} {
		if !strings.Contains(lowerRendered, fragment) {
			t.Fatalf("ordinary-mode rule missing (%s):\n%s", fragment, rendered)
		}
	}
	if strings.Contains(rendered, "COLLABORATION WORK TURN") ||
		strings.Contains(rendered, "COLLABORATION FOLLOW-UP TURN") {
		t.Fatal("collab mode rules must not appear in ordinary turns")
	}
}

func TestRenderModeSelectionAndRosterAnnotations(t *testing.T) {
	base := turnInput("")
	input := &base

	selfMarker := "participantId=me-1"
	participants := []types.ParticipantRosterEntry{
		{ID: "me-1", Name: "Pi", Kind: types.KindAgent, Advertised: []string{"code"}},
		{ID: "human-1", Name: "Ada", Kind: types.KindHuman},
		{ID: "peer-9", Name: "Hermes", Kind: types.KindAgent,
			Surface: &types.RoomSurfaceMetadataV1{
				SnapshotID: "123e4567-e89b-12d3-a456-426614174000",
				MimeType:   "image/png", Size: 2048,
				UpdatedAt: 1700000000000,
			}},
	}

	// Ordinary roster annotation only.
	input.Room.Participants = participants
	input.Room.Self = &types.RoomSelfContext{InstanceID: "inst-1", ParticipantID: "me-1", Name: "Pi"}
	ordinary := RenderUntrustedRoomTurn(input)
	if !strings.Contains(ordinary, selfMarker+") (you)") && !strings.Contains(ordinary, "[participantId=me-1] (you)") {
		t.Fatalf("self marker missing:\n%s", ordinary)
	}
	if !strings.Contains(ordinary, "advertised: code") {
		t.Fatal("roster capabilities not rendered")
	}
	if strings.Contains(ordinary, "COLLABORATION FOLLOW-UP TURN") {
		t.Fatal("follow-up rules leaked into plain turns")
	}

	// Work-turn markers.
	work := &types.HarnessTurnInput{
		Room: input.Room,
		Events: []types.HarnessEvent{{
			Sender: "Ada", Kind: types.KindHuman, Addressed: true,
			Collab: &types.CollabEventView{
				WireCollabEvent: types.WireCollabEvent{
					RequestID:           "req-7",
					Kind:                types.CollabRequest,
					FromParticipantID:   "human-1",
					TargetParticipantID: "me-1",
					Summary:             "ship the audit",
					Details:             map[string]string{"scope": "logs"},
					AttachmentIDs:       []string{"att-1", "att-2"},
				},
				FromName: "Ada",
			},
		}},
	}
	workRendered := RenderUntrustedRoomTurn(work)
	if !strings.Contains(workRendered, "COLLABORATION WORK TURN") {
		t.Fatalf("work-turn banner missing:\n%s", workRendered)
	}
	if !strings.Contains(workRendered,
		"[collaboration request id=req-7 from Ada (participantId=human-1)]") {
		t.Fatal("collab description line mismatch")
	}
	if !strings.Contains(workRendered, "details: scope=logs") ||
		!strings.Contains(workRendered, "attachmentIds: att-1, att-2") {
		t.Fatal("structured details/attachments missing")
	}

	// Follow-up markers.
	follow := &types.HarnessTurnInput{
		Room: input.Room,
		Events: []types.HarnessEvent{{
			Sender: "Hermes", Kind: types.KindAgent, Addressed: false,
			Collab: &types.CollabEventView{
				WireCollabEvent: types.WireCollabEvent{
					RequestID:           "req-7",
					Kind:                types.CollabComplete,
					FromParticipantID:   "peer-9",
					TargetParticipantID: "human-1",
					Summary:             "done",
				},
				FromName: "Hermes",
			},
		}},
	}
	followRendered := RenderUntrustedRoomTurn(follow)
	if !strings.Contains(followRendered, "COLLABORATION FOLLOW-UP TURN") ||
		strings.Contains(followRendered, "This is a chat turn") {
		t.Fatal("follow-up/ordinary mode separation broken")
	}

	// Mixed request + results are classified as WORK TURN.
	mixed := &types.HarnessTurnInput{
		Room:   input.Room,
		Events: append([]types.HarnessEvent{}, work.Events...),
	}
	mixed.Events = append(mixed.Events, follow.Events...)
	mixedRendered := RenderUntrustedRoomTurn(mixed)
	if !strings.Contains(mixedRendered, "COLLABORATION WORK TURN") ||
		strings.Contains(mixedRendered, "COLLABORATION FOLLOW-UP TURN") {
		t.Fatal("mixed-turn classification must prefer the work path")
	}

	if !strings.Contains(ordinary, "workspace snapshot: available (updated ") {
		t.Fatal("surface metadata not rendered in roster")
	}
}

func TestPromptBlocksRespectImageCapability(t *testing.T) {
	input := types.HarnessTurnInput{
		Room: types.RoomTurnContext{Ephemeral: true},
		Events: []types.HarnessEvent{{
			Sender: "Human", Kind: types.KindHuman, Text: "see attached", Addressed: true,
			Image: &types.HarnessImage{Data: "AAAA", MimeType: "image/png"},
		}},
	}
	blocks := promptBlocks(input, false)
	if len(blocks) != 1 || blocks[0]["type"] != "text" {
		t.Fatalf("image-capable path polluted without negotiation: %+v", blocks)
	}
	blocks = promptBlocks(input, true)
	if len(blocks) != 2 {
		t.Fatalf("negotiated image capability must attach the image block: %+v", blocks)
	}
	if blocks[1]["type"] != "image" || blocks[1]["data"] != "AAAA" ||
		blocks[1]["mimeType"] != "image/png" {
		t.Fatalf("image block shape mismatch: %+v", blocks[1])
	}
}
