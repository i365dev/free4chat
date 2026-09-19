package harness

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Cross-session turn execution (#421).
 *
 * These tests drive the REAL ACPAdapter against the scripted fake Harness in
 * its `hold_all` mode, which parks one prompt per native session so several
 * conversations can be in flight at once. That models the provider behavior
 * the #421 probes measured on the pinned bridges, and it is the only way to
 * test per-conversation isolation without a network or a real model.
 *
 * The invariant under test is NOT "many prompts are fine". It is:
 *   - one NATIVE conversation executes at most one turn at a time, always;
 *   - independent conversations are isolated for stream, cancel, and
 *     permission routing.
 */

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", message)
}

// concurrentFakeHarness builds the scripted Harness in hold_all mode and
// returns a launcher plus the release directory a test uses to let one
// specific conversation finish.
func concurrentFakeHarness(t *testing.T, env map[string]string) (types.AgentLauncher, string) {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate harness test source")
	}
	agentDir := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	path := filepath.Join(t.TempDir(), "fakeagent")
	command := exec.Command("go", "build", "-o", path, "./internal/harness/testdata/fakeagent")
	command.Dir = agentDir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build fake ACP Harness: %v\n%s", err, output)
	}
	releaseDir := t.TempDir()
	merged := map[string]string{
		"FAKE_MODE":               "hold_all",
		"FAKE_RELEASE_DIR":        releaseDir,
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}
	for key, value := range env {
		merged[key] = value
	}
	return types.AgentLauncher{
		ID: "fake", DisplayName: "Fake ACP", Command: path,
		Maturity: types.MaturityPreview, Security: types.SecurityUnverified,
		Environment: merged,
	}, releaseDir
}

// release lets exactly one conversation finish.
func release(t *testing.T, releaseDir, sessionID string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(releaseDir, sessionID), []byte("go"), 0o600); err != nil {
		t.Fatalf("release %s: %v", sessionID, err)
	}
}

func promptFor(text string) types.HarnessTurnInput {
	return types.HarnessTurnInput{
		Room:    types.RoomTurnContext{Ephemeral: true},
		Events:  []types.HarnessEvent{{Sender: "Human", Kind: "human", Text: text, Addressed: true, Sequence: 1}},
		Session: &types.HarnessSessionContext{New: true, Bootstrap: true, CurrentRoomSequence: 1},
	}
}

// TestConcurrentTurnsOnIndependentSessionsStartTogether proves the adapter can
// genuinely have two DIFFERENT conversations executing at once, which is the
// capability #421 exists to expose.
func TestConcurrentTurnsOnIndependentSessionsStartTogether(t *testing.T) {
	launcher, releaseDir := concurrentFakeHarness(t, nil)
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{TurnTimeoutMs: 30_000, CancelGraceMs: 200})
	t.Cleanup(func() { _ = adapter.Close() })

	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
	}
	sessionA := adapter.sessions["task:req-A"].sessionID
	sessionB := adapter.sessions["task:req-B"].sessionID
	if sessionA == sessionB {
		t.Fatalf("two logical scopes share one native session: %s", sessionA)
	}

	type outcome struct {
		scope  string
		result types.HarnessTurnResult
		err    error
	}
	outcomes := make(chan outcome, 2)
	for _, scope := range []string{"task:req-A", "task:req-B"} {
		go func(scope string) {
			result, err := adapter.RunTurnFor(scope, promptFor("work for "+scope), adapter.SessionGenerationFor(scope))
			outcomes <- outcome{scope: scope, result: result, err: err}
		}(scope)
	}

	// BOTH conversations must be parked before either is released: that is
	// what "executing at the same time" means.
	waitForCondition(t, 10*time.Second, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return adapter.activeTurns[sessionA] != nil && adapter.activeTurns[sessionB] != nil
	}, "both conversations to execute concurrently")

	release(t, releaseDir, sessionA)
	release(t, releaseDir, sessionB)

	byScope := map[string]outcome{}
	for index := 0; index < 2; index++ {
		select {
		case settled := <-outcomes:
			if settled.err != nil {
				t.Fatalf("concurrent turn %s failed: %v", settled.scope, settled.err)
			}
			byScope[settled.scope] = settled
		case <-time.After(15 * time.Second):
			t.Fatal("a concurrent turn never settled")
		}
	}
	// Each conversation receives its OWN reply, and neither carries the
	// other's session id. That is the stream-routing proof.
	if !strings.Contains(byScope["task:req-A"].result.Text, "released:"+sessionA) {
		t.Fatalf("Task A did not receive its own reply: %q", byScope["task:req-A"].result.Text)
	}
	if !strings.Contains(byScope["task:req-B"].result.Text, "released:"+sessionB) {
		t.Fatalf("Task B did not receive its own reply: %q", byScope["task:req-B"].result.Text)
	}
}

// TestSameNativeSessionNeverRunsTwoTurns proves the hard per-conversation
// invariant, which is enforced by native session identity rather than by the
// scheduler.
func TestSameNativeSessionNeverRunsTwoTurns(t *testing.T) {
	launcher, releaseDir := concurrentFakeHarness(t, nil)
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{TurnTimeoutMs: 30_000, CancelGraceMs: 200})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSessionFor("task:req-A"); err != nil {
		t.Fatalf("EnsureSessionFor: %v", err)
	}
	generation := adapter.SessionGenerationFor("task:req-A")
	sessionID := adapter.sessions["task:req-A"].sessionID

	first := make(chan error, 1)
	go func() {
		_, err := adapter.RunTurnFor("task:req-A", promptFor("first"), generation)
		first <- err
	}()
	waitForCondition(t, 10*time.Second, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return adapter.activeTurns[sessionID] != nil
	}, "the first turn to start")

	// A second turn for the SAME conversation is refused as a deferral, never
	// multiplexed onto the same stream.
	if _, err := adapter.RunTurnFor("task:req-A", promptFor("second"), generation); !errors.Is(err, ErrSessionPromptBusy) {
		t.Fatalf("a second turn on one conversation must be refused as busy, got %v", err)
	}
	if owner, busy := adapter.TurnOwnerFor("task:req-A"); !busy || owner != "task:req-A" {
		t.Fatalf("ownership must name the executing scope, got %q busy=%v", owner, busy)
	}

	release(t, releaseDir, sessionID)
	select {
	case err := <-first:
		if err != nil {
			t.Fatalf("first turn failed: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("first turn never settled")
	}
}

// TestCancelTurnForCancelsOnlyTheNamedConversation is the #421 interrupt
// isolation proof: cancelling one Task must never stop another.
func TestCancelTurnForCancelsOnlyTheNamedConversation(t *testing.T) {
	launcher, releaseDir := concurrentFakeHarness(t, nil)
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{TurnTimeoutMs: 30_000, CancelGraceMs: 200})
	t.Cleanup(func() { _ = adapter.Close() })

	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
	}
	sessionA := adapter.sessions["task:req-A"].sessionID
	sessionB := adapter.sessions["task:req-B"].sessionID

	resultA := make(chan types.HarnessTurnResult, 1)
	resultB := make(chan types.HarnessTurnResult, 1)
	go func() {
		result, _ := adapter.RunTurnFor("task:req-A", promptFor("A"), adapter.SessionGenerationFor("task:req-A"))
		resultA <- result
	}()
	go func() {
		result, _ := adapter.RunTurnFor("task:req-B", promptFor("B"), adapter.SessionGenerationFor("task:req-B"))
		resultB <- result
	}()
	waitForCondition(t, 10*time.Second, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return adapter.activeTurns[sessionA] != nil && adapter.activeTurns[sessionB] != nil
	}, "both conversations to execute concurrently")

	if err := adapter.CancelTurnFor("task:req-A"); err != nil {
		t.Fatalf("CancelTurnFor: %v", err)
	}
	select {
	case result := <-resultA:
		if strings.Contains(result.Text, "released:"+sessionA) {
			t.Fatalf("cancelled conversation still produced its completion: %q", result.Text)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the cancelled conversation never settled")
	}

	// Task B must still be executing, untouched.
	adapter.mu.Lock()
	stillRunning := adapter.activeTurns[sessionB] != nil
	adapter.mu.Unlock()
	if !stillRunning {
		t.Fatal("cancelling Task A also stopped Task B")
	}
	// A cancel for an unknown conversation is a local no-op.
	if err := adapter.CancelTurnFor("task:req-absent"); err != nil {
		t.Fatalf("a cancel for an unknown scope must be a no-op, got %v", err)
	}
	release(t, releaseDir, sessionB)
	select {
	case result := <-resultB:
		if !strings.Contains(result.Text, "released:"+sessionB) {
			t.Fatalf("Task B did not complete normally after A was cancelled: %q", result.Text)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Task B never settled")
	}
}

// TestPermissionRequestsStayWithTheirConversation proves #421 permission
// isolation: an approval for one Task is routed by conversation, and a Task
// whose approval is still pending is not resolved by another Task's decision.
func TestPermissionRequestsStayWithTheirConversation(t *testing.T) {
	launcher, _ := concurrentFakeHarness(t, map[string]string{"FAKE_PERMISSION_ALL": "1"})

	type observation struct {
		scope     string
		sessionID string
	}
	observed := make(chan observation, 4)
	// The responder blocks for conversation A and immediately allows B. That
	// makes "B's approval must not resolve A" observable rather than timing
	// dependent.
	blockA := make(chan struct{})
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
		TurnTimeoutMs: 30_000, CancelGraceMs: 200,
		PermissionResponder: func(ctx context.Context, request ACPPermissionRequest) (ACPPermissionResponse, error) {
			observed <- observation{scope: request.Scope, sessionID: request.SessionID}
			if request.Scope == "task:req-A" {
				select {
				case <-blockA:
				case <-ctx.Done():
					return ACPPermissionResponse{}, ctx.Err()
				}
			}
			return ACPPermissionResponse{OptionID: "allow-once"}, nil
		},
	})
	t.Cleanup(func() { _ = adapter.Close() })

	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
	}
	sessionA := adapter.sessions["task:req-A"].sessionID
	sessionB := adapter.sessions["task:req-B"].sessionID

	resultA := make(chan types.HarnessTurnResult, 1)
	resultB := make(chan types.HarnessTurnResult, 1)
	go func() {
		result, _ := adapter.RunTurnFor("task:req-A", promptFor("permission-test A"), adapter.SessionGenerationFor("task:req-A"))
		resultA <- result
	}()
	go func() {
		result, _ := adapter.RunTurnFor("task:req-B", promptFor("permission-test B"), adapter.SessionGenerationFor("task:req-B"))
		resultB <- result
	}()

	// Each request must arrive tagged with its OWN conversation and scope.
	scopesBySession := map[string]string{}
	for index := 0; index < 2; index++ {
		select {
		case seen := <-observed:
			scopesBySession[seen.sessionID] = seen.scope
		case <-time.After(15 * time.Second):
			t.Fatal("both conversations must raise their own approval request")
		}
	}
	if scopesBySession[sessionA] != "task:req-A" || scopesBySession[sessionB] != "task:req-B" {
		t.Fatalf("approval requests were not bound to their own conversation: %v", scopesBySession)
	}

	// B is approved and settles; A is still waiting for its own decision.
	select {
	case result := <-resultB:
		if !strings.Contains(result.Text, "approved:"+sessionB) {
			t.Fatalf("Task B did not receive its own approval: %q", result.Text)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Task B never settled after its approval")
	}
	adapter.mu.Lock()
	aStillPending := adapter.activeTurns[sessionA] != nil
	pendingPermissions := len(adapter.pendingPermissions)
	adapter.mu.Unlock()
	if !aStillPending {
		t.Fatal("Task B's approval resolved Task A's turnover")
	}
	if pendingPermissions == 0 {
		t.Fatal("Task A's approval was dropped by Task B's decision")
	}

	// Unblocking A settles only A, and with A's own approval.
	close(blockA)
	select {
	case result := <-resultA:
		if !strings.Contains(result.Text, "approved:"+sessionA) {
			t.Fatalf("Task A did not receive its own approval: %q", result.Text)
		}
		if strings.Contains(result.Text, sessionB) {
			t.Fatalf("Task A's reply carried Task B's conversation: %q", result.Text)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Task A never settled after its own approval")
	}
}

// TestDefaultTurnCeilingSupportsMultiHourTasks pins the #421 policy that a
// legitimate Task is no longer cut off by the old two-minute default, and that
// a stuck Harness is still bounded.
func TestDefaultTurnCeilingSupportsMultiHourTasks(t *testing.T) {
	if defaultTurnTimeoutMs < 6*60*60*1_000 {
		t.Fatalf("the default turn ceiling must support multi-hour Tasks, got %dms", defaultTurnTimeoutMs)
	}
	if defaultTurnTimeoutMs <= 120_000 {
		t.Fatalf("the old two-minute product cap must not survive as the default: %dms", defaultTurnTimeoutMs)
	}
	adapter := NewACPAdapter(types.AgentLauncher{ID: "fake", Command: "true"}, t.TempDir(), AdapterOptions{})
	if adapter.options.TurnTimeoutMs != defaultTurnTimeoutMs {
		t.Fatalf("an adapter without explicit options must use the long ceiling, got %d", adapter.options.TurnTimeoutMs)
	}
	// The idle watchdog is OPT-IN: the default must not invent one, because
	// the pinned bridges emit nothing while a tool call runs.
	if adapter.options.TurnIdleTimeoutMs != 0 {
		t.Fatalf("the idle watchdog must be off by default, got %d", adapter.options.TurnIdleTimeoutMs)
	}
}

// TestTurnCeilingStillRecoversAStuckConversation proves the long ceiling did
// not remove bounded recovery: a Harness that accepts a prompt and never
// answers is still recovered.
func TestTurnCeilingStillRecoversAStuckConversation(t *testing.T) {
	launcher, _ := concurrentFakeHarness(t, nil)
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{TurnTimeoutMs: 400, CancelGraceMs: 200})
	t.Cleanup(func() { _ = adapter.Close() })

	if err := adapter.EnsureSessionFor("task:req-A"); err != nil {
		t.Fatalf("EnsureSessionFor: %v", err)
	}
	started := time.Now()
	_, err := adapter.RunTurnFor("task:req-A", promptFor("never answers"), adapter.SessionGenerationFor("task:req-A"))
	var timeout *TurnTimeoutError
	if !errors.As(err, &timeout) {
		t.Fatalf("a stuck conversation must be recovered by the ceiling, got %v", err)
	}
	if timeout.Reason != turnExpiryCeiling {
		t.Fatalf("the recovery reason must name the ceiling, got %q", timeout.Reason)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("ceiling recovery took too long: %s", elapsed)
	}
}

// TestIdleWatchdogIsOptInAndRearmsByProviderActivity proves the two halves of
// the #421 recovery policy: with the watchdog OFF a silent-but-alive turn is
// never killed, and with it ON real provider notifications keep re-arming it.
func TestIdleWatchdogIsOptInAndRearmsByProviderActivity(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		launcher, releaseDir := concurrentFakeHarness(t, nil)
		adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{TurnTimeoutMs: 30_000, CancelGraceMs: 200})
		t.Cleanup(func() { _ = adapter.Close() })
		if err := adapter.EnsureSessionFor("task:req-A"); err != nil {
			t.Fatalf("EnsureSessionFor: %v", err)
		}
		sessionID := adapter.sessions["task:req-A"].sessionID
		done := make(chan error, 1)
		go func() {
			_, err := adapter.RunTurnFor("task:req-A", promptFor("silent"), adapter.SessionGenerationFor("task:req-A"))
			done <- err
		}()
		waitForCondition(t, 5*time.Second, func() bool {
			adapter.mu.Lock()
			defer adapter.mu.Unlock()
			return adapter.activeTurns[sessionID] != nil
		}, "the silent turn to start")
		// Well past any plausible idle bound: a provider that legitimately
		// thinks silently must NOT be killed.
		time.Sleep(400 * time.Millisecond)
		adapter.mu.Lock()
		stillRunning := adapter.activeTurns[sessionID] != nil
		adapter.mu.Unlock()
		if !stillRunning {
			t.Fatal("a silent turn was expired even though the idle watchdog is off")
		}
		release(t, releaseDir, sessionID)
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("silent turn failed: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("silent turn never settled")
		}
	})

	t.Run("re-armed by provider activity", func(t *testing.T) {
		// The conversation emits a notification every 50ms while the opt-in
		// watchdog would otherwise expire at 300ms.
		launcher, releaseDir := concurrentFakeHarness(t, map[string]string{"FAKE_CHATTER_MS": "50"})
		adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
			TurnTimeoutMs: 30_000, TurnIdleTimeoutMs: 300, CancelGraceMs: 200,
		})
		t.Cleanup(func() { _ = adapter.Close() })
		if err := adapter.EnsureSessionFor("task:req-A"); err != nil {
			t.Fatalf("EnsureSessionFor: %v", err)
		}
		sessionID := adapter.sessions["task:req-A"].sessionID
		done := make(chan error, 1)
		go func() {
			_, err := adapter.RunTurnFor("task:req-A", promptFor("chatty"), adapter.SessionGenerationFor("task:req-A"))
			done <- err
		}()
		waitForCondition(t, 5*time.Second, func() bool {
			adapter.mu.Lock()
			defer adapter.mu.Unlock()
			return adapter.activeTurns[sessionID] != nil
		}, "the chatty turn to start")
		// Four idle windows' worth of wall clock, all covered by activity.
		time.Sleep(1200 * time.Millisecond)
		select {
		case err := <-done:
			t.Fatalf("a live conversation was expired despite continuous activity: %v", err)
		default:
		}
		release(t, releaseDir, sessionID)
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("chatty turn failed: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("chatty turn never settled")
		}
	})

	t.Run("expires a genuinely silent conversation when enabled", func(t *testing.T) {
		launcher, _ := concurrentFakeHarness(t, nil)
		adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
			TurnTimeoutMs: 30_000, TurnIdleTimeoutMs: 300, CancelGraceMs: 200,
		})
		t.Cleanup(func() { _ = adapter.Close() })
		if err := adapter.EnsureSessionFor("task:req-A"); err != nil {
			t.Fatalf("EnsureSessionFor: %v", err)
		}
		_, err := adapter.RunTurnFor("task:req-A", promptFor("silent"), adapter.SessionGenerationFor("task:req-A"))
		var timeout *TurnTimeoutError
		if !errors.As(err, &timeout) || timeout.Reason != turnExpiryIdle {
			t.Fatalf("an enabled idle watchdog must expire a silent conversation, got %v", err)
		}
	})
}

// TestConcurrentTurnsKeepDistinctPermissionSets proves the adapter no longer
// keeps ONE global prompt fence: both conversations can be executing while
// holding their own approvals.
func TestConcurrentTurnsKeepDistinctPermissionSets(t *testing.T) {
	launcher, _ := concurrentFakeHarness(t, map[string]string{"FAKE_PERMISSION_ALL": "1"})
	gate := make(chan struct{})
	adapter := NewACPAdapter(launcher, t.TempDir(), AdapterOptions{
		TurnTimeoutMs: 30_000, CancelGraceMs: 200,
		PermissionResponder: func(ctx context.Context, request ACPPermissionRequest) (ACPPermissionResponse, error) {
			select {
			case <-gate:
			case <-ctx.Done():
				return ACPPermissionResponse{}, ctx.Err()
			}
			return ACPPermissionResponse{OptionID: "allow-once"}, nil
		},
	})
	t.Cleanup(func() { _ = adapter.Close() })
	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
	}
	done := make(chan struct{}, 2)
	for _, scope := range []string{"task:req-A", "task:req-B"} {
		go func(scope string) {
			_, _ = adapter.RunTurnFor(scope, promptFor("permission-test"), adapter.SessionGenerationFor(scope))
			done <- struct{}{}
		}(scope)
	}
	waitForCondition(t, 10*time.Second, func() bool {
		adapter.mu.Lock()
		defer adapter.mu.Unlock()
		return len(adapter.pendingPermissions) == 2
	}, "both conversations to hold their own approval")
	close(gate)
	for index := 0; index < 2; index++ {
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Fatal("a concurrent approved turn never settled")
		}
	}
	if count := adapter.PendingPermissionCount(); count != 0 {
		t.Fatalf("settled turns left approvals behind: %d", count)
	}
}
