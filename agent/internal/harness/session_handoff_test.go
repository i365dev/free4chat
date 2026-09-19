package harness

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Pi existing-session handoff (#409, V1): the adapter-level ordering proof.
 *
 * A Task scope that adopts an EXISTING native conversation must get that
 * conversation through session/load, and must never be given a session/new
 * conversation of its own — not before the load, and not on any later ensure
 * for the same scope. This is the adapter half of the Runtime invariant in
 * internal/runtime/session_adoption.go.
 */

// countACPMethod counts how many request frames used one ACP method.
func countACPMethod(frames []acpTraceFrame, method string) int {
	total := 0
	for _, frame := range frames {
		if frame.Method == method {
			total++
		}
	}
	return total
}

// firstACPMethodIndex returns the position of the first frame with the method.
func firstACPMethodIndex(frames []acpTraceFrame, method string) int {
	for index, frame := range frames {
		if frame.Method == method {
			return index
		}
	}
	return -1
}

func TestACPScopeLoadReplacesSessionWithoutSessionNew(t *testing.T) {
	tracePath := filepath.Join(t.TempDir(), "acp-trace.log")
	adapter, workspace := newTestAdapter(t, scriptLauncher("session_echo", map[string]string{
		"FAKE_LOAD_CAP": "1",
		"FAKE_TRACE":    tracePath,
	}), AdapterOptions{})
	defer adapter.Close()

	// The resident Room conversation is negotiated first, exactly as
	// prepareLifecycle does before this Runtime joins any Room.
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	if generation := adapter.SessionGeneration(); generation <= 0 {
		t.Fatalf("the Room session was not retained: %d", generation)
	}

	// The adoption: an existing native session is loaded into a Task scope that
	// has never had a session of its own.
	const sessionID = "native-handoff-1"
	if err := adapter.LoadSession("task:req-T", sessionID, workspace); err != nil {
		t.Fatalf("scope load failed: %v", err)
	}
	loadedGeneration := adapter.SessionGenerationFor("task:req-T")
	if loadedGeneration <= 0 {
		t.Fatalf("the loaded scope has no generation: %d", loadedGeneration)
	}

	// A later ensure for the SAME scope must find the loaded conversation and
	// create nothing: this is the call the Runtime's admission boundary makes
	// on every subsequent turn of an adopted Task.
	if err := adapter.EnsureSessionFor("task:req-T"); err != nil {
		t.Fatalf("ensure for the adopted scope failed: %v", err)
	}
	if generation := adapter.SessionGenerationFor("task:req-T"); generation != loadedGeneration {
		t.Fatalf("ensure replaced the adopted conversation: %d -> %d", loadedGeneration, generation)
	}

	frames := readACPTraceFrames(t, tracePath)
	// Exactly one session/new exists — the Room's. The adopted Task scope never
	// asked for a conversation of its own.
	if got := countACPMethod(frames, "session/new"); got != 1 {
		t.Fatalf("the adopted scope issued session/new: %d session/new in %v", got, frames)
	}
	if got := countACPMethod(frames, "session/load"); got != 1 {
		t.Fatalf("expected exactly one session/load, got %d in %v", got, frames)
	}
	if newIndex, loadIndex := firstACPMethodIndex(frames, "session/new"), firstACPMethodIndex(frames, "session/load"); newIndex < 0 || loadIndex < newIndex {
		t.Fatalf("the scope load must follow the resident Room session: %v", frames)
	}
	// Identity is preserved byte-for-byte on the wire.
	wantParams := []map[string]any{{
		"sessionId":  sessionID,
		"cwd":        workspace,
		"mcpServers": []any{},
	}}
	if got := acpTraceParams(t, tracePath, "session/load"); len(got) != 1 {
		t.Fatalf("session/load wire request mismatch: got=%v want=%v", got, wantParams)
	}
	// The decisive continuation proof: the next turn of that scope is addressed
	// to the loaded native conversation, not to any session/new conversation.
	result, err := adapter.RunTurnFor("task:req-T", turnInput("continue"), loadedGeneration)
	if err != nil {
		t.Fatalf("scoped turn failed: %v", err)
	}
	if !strings.Contains(result.Text, "session="+sessionID) {
		t.Fatalf("the scoped turn did not continue the loaded session: %q", result.Text)
	}
	// The Room conversation is untouched by the adoption.
	roomResult, err := adapter.RunTurn(turnInput("room still works"), adapter.SessionGeneration())
	if err != nil {
		t.Fatalf("room turn failed: %v", err)
	}
	if strings.Contains(roomResult.Text, sessionID) {
		t.Fatalf("the adoption rebound the Room conversation: %q", roomResult.Text)
	}
	if got := countACPMethod(readACPTraceFrames(t, tracePath), "session/new"); got != 1 {
		t.Fatalf("turns created an extra session/new: %d", got)
	}
}

/*
 * The prompt half of the same invariant: the first Free4Chat-controlled turn of
 * an ADOPTED existing conversation must receive the Free4Chat bootstrap contract
 * without being told that the conversation itself is new.
 */

// newSessionLine is the fresh-conversation claim that must never appear in an
// adopted-session prompt.
const newSessionLine = "This is a new local Harness session."

// adoptedSessionLine is the truthful wording for the first Free4Chat-controlled
// turn of an existing native conversation.
const adoptedSessionLine = "This is the first Free4Chat-controlled turn in an existing local Harness session."

func TestAdoptedExistingSessionBootstrapPromptIsTruthful(t *testing.T) {
	input := bootstrapPromptInput()
	input.Session = &types.HarnessSessionContext{New: false, Bootstrap: true, CurrentRoomSequence: 7}
	adopted := RenderUntrustedRoomTurn(input)

	// The Free4Chat host/authority/collaboration contract is still taught once.
	if !strings.Contains(adopted, hygieneAnchor) {
		t.Fatalf("the adopted bootstrap prompt is missing the public reply contract:\n%s", adopted)
	}
	for _, marker := range []string{"public reply", "tools", "activity", "concise"} {
		if !strings.Contains(adopted, marker) {
			t.Fatalf("the adopted bootstrap contract lost the %q guarantee:\n%s", marker, adopted)
		}
	}
	// ... and it says what is actually true about the conversation.
	if !strings.Contains(adopted, adoptedSessionLine) {
		t.Fatalf("the adopted bootstrap prompt did not state the existing-session fact:\n%s", adopted)
	}
	if !strings.Contains(adopted, "Current Room sequence: 7.") {
		t.Fatalf("the adopted bootstrap prompt lost the canonical Room sequence:\n%s", adopted)
	}
	if strings.Contains(adopted, newSessionLine) {
		t.Fatalf("an adopted existing conversation was described as new:\n%s", adopted)
	}
	// Pull-only Room history is a Free4Chat fact and still applies.
	if !strings.Contains(adopted, "Earlier bounded Room context may exist") {
		t.Fatalf("the adopted bootstrap prompt lost the bounded Room-context notice:\n%s", adopted)
	}
}

func TestAdoptedFollowUpPromptDoesNotRepeatBootstrap(t *testing.T) {
	input := bootstrapPromptInput()
	input.Session = &types.HarnessSessionContext{New: false, Bootstrap: false, CurrentRoomSequence: 8}
	delta := RenderUntrustedRoomTurn(input)

	if strings.Contains(delta, hygieneAnchor) {
		t.Fatalf("the Free4Chat contract must not repeat on an adopted follow-up:\n%s", delta)
	}
	if strings.Contains(delta, adoptedSessionLine) || strings.Contains(delta, newSessionLine) {
		t.Fatalf("an adopted follow-up must not restate session bootstrap facts:\n%s", delta)
	}
	bootstrapInput := bootstrapPromptInput()
	bootstrapInput.Session = &types.HarnessSessionContext{New: false, Bootstrap: true, CurrentRoomSequence: 7}
	if len(delta) >= len(RenderUntrustedRoomTurn(bootstrapInput)) {
		t.Fatalf("the adopted follow-up (%d bytes) must stay smaller than its bootstrap (%d bytes)",
			len(delta), len(RenderUntrustedRoomTurn(bootstrapInput)))
	}
}

// TestFreshSessionPromptIsUnchanged is the regression fence for the ordinary
// path: a genuinely new conversation still says so, and does not claim to be an
// existing one.
func TestFreshSessionPromptIsUnchanged(t *testing.T) {
	input := bootstrapPromptInput()
	input.Session = &types.HarnessSessionContext{New: true, Bootstrap: false, CurrentRoomSequence: 3}
	fresh := RenderUntrustedRoomTurn(input)

	if !strings.Contains(fresh, newSessionLine) {
		t.Fatalf("a new conversation must still be described as new:\n%s", fresh)
	}
	if strings.Contains(fresh, adoptedSessionLine) {
		t.Fatalf("a new conversation claimed to be an existing adopted one:\n%s", fresh)
	}
	if !strings.Contains(fresh, hygieneAnchor) {
		t.Fatalf("a new conversation lost the Free4Chat bootstrap contract:\n%s", fresh)
	}
}
