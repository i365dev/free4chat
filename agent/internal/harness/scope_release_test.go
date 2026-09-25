package harness

import (
	"reflect"
	"strconv"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Per-scope conversation release (#473).
 *
 * The Runtime gives one terminal Task scope back when a new Task needs the
 * slot. These tests pin the adapter half of that contract:
 *
 *   - releasing a scope really frees its slot in the bounded scoped-session
 *     table;
 *   - a DURABLE conversation keeps its exact native identity and is
 *     materialized again with session/load, never session/new;
 *   - a conversation that cannot be materialized is reported as dropped, so
 *     the Runtime can keep the Task truthful instead of substituting one;
 *   - the Room compatibility conversation is never releasable.
 */

func scopedSessionID(t *testing.T, adapter *ACPAdapter, scope string) string {
	t.Helper()
	for _, diagnostic := range adapter.SessionDiagnostics() {
		if diagnostic.Scope == scope {
			return diagnostic.SessionID
		}
	}
	return ""
}

func TestACPReleaseSessionForFreesCapacityAndRematerializesExactly(t *testing.T) {
	tracePath := t.TempDir() + "/release-trace.log"
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_TRACE":              tracePath,
		"FAKE_LOAD_CAP":           "1",
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}
	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		if err := adapter.EnsureSessionFor("task:" + strconv.Itoa(index+1)); err != nil {
			t.Fatalf("ensure scoped session %d failed: %v", index+1, err)
		}
	}
	// Seed one conversation with a successful prompt: only then may its native
	// identity be retained across a release.
	generation := adapter.SessionGenerationFor("task:1")
	if _, err := adapter.RunTurnFor("task:1", turnInput("seed task:1"), generation); err != nil {
		t.Fatalf("seed scoped turn failed: %v", err)
	}
	seedSessionID := scopedSessionID(t, adapter, "task:1")
	if seedSessionID == "" {
		t.Fatal("the seeded scoped conversation has no native identity")
	}
	if err := adapter.EnsureSessionFor("task:overflow"); err == nil {
		t.Fatal("scope above the bound was accepted before any release")
	}

	retained, err := adapter.ReleaseSessionFor("task:1", true)
	if err != nil || !retained {
		t.Fatalf("a durable conversation must be retained: retained=%v err=%v", retained, err)
	}
	adapter.mu.Lock()
	held := adapter.retainedSessions["task:1"].sessionID
	adapter.mu.Unlock()
	if held != seedSessionID {
		t.Fatalf("the retained identity is not the released conversation: %q", held)
	}
	if got := scopedSessionID(t, adapter, "task:1"); got != "" {
		t.Fatalf("the released scope is still materialized: %q", got)
	}

	// The freed slot is real: the previously refused scope is admitted now.
	if err := adapter.EnsureSessionFor("task:overflow"); err != nil {
		t.Fatalf("release did not free the scoped capacity: %v", err)
	}

	// Free that slot again and materialize the released conversation. It must
	// be the SAME native session, loaded, with a new generation.
	if _, err := adapter.ReleaseSessionFor("task:overflow", true); err != nil {
		t.Fatalf("release overflow failed: %v", err)
	}
	if err := adapter.EnsureSessionFor("task:1"); err != nil {
		t.Fatalf("re-materialize released scope failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, "task:1"); got != seedSessionID {
		t.Fatalf("released conversation was replaced: got=%q want=%q", got, seedSessionID)
	}
	if got := adapter.SessionGenerationFor("task:1"); got <= generation {
		t.Fatalf("re-materialization did not advance the scoped generation: %d -> %d", generation, got)
	}

	frames := readACPTraceFrames(t, tracePath)
	if got := countACPMethod(frames, "session/load"); got != 1 {
		t.Fatalf("expected exactly one exact session/load, got %d", got)
	}
	// One Room handshake plus the scoped session/new calls; the released
	// conversation must not have added another one.
	if got := countACPMethod(frames, "session/new"); got != 1+types.MaxLogicalTaskScopes+1 {
		t.Fatalf("release changed the session/new count: %d", got)
	}
}

func TestACPReleaseSessionForReportsAConversationThatCannotBeMaterialized(t *testing.T) {
	tracePath := t.TempDir() + "/release-drop-trace.log"
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_TRACE":              tracePath,
		"FAKE_LOAD_CAP":           "1",
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}
	if err := adapter.EnsureSessionFor("task:untouched"); err != nil {
		t.Fatalf("ensure scoped session failed: %v", err)
	}
	before := scopedSessionID(t, adapter, "task:untouched")
	if before == "" {
		t.Fatal("scoped conversation has no native identity")
	}

	// A conversation that never settled a prompt may exist only in provider
	// memory, so it must be reported as dropped rather than retained.
	retained, err := adapter.ReleaseSessionFor("task:untouched", true)
	if err != nil || retained {
		t.Fatalf("an unprompted conversation must be dropped: retained=%v err=%v", retained, err)
	}
	adapter.mu.Lock()
	_, stillRetained := adapter.retainedSessions["task:untouched"]
	adapter.mu.Unlock()
	if stillRetained {
		t.Fatal("an unprompted conversation was retained")
	}

	// A later ensure is an honest new conversation, not the dropped one.
	if err := adapter.EnsureSessionFor("task:untouched"); err != nil {
		t.Fatalf("ensure after drop failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, "task:untouched"); got == before {
		t.Fatalf("a dropped conversation was silently reused: %q", got)
	}
	frames := readACPTraceFrames(t, tracePath)
	if got := countACPMethod(frames, "session/load"); got != 0 {
		t.Fatalf("a dropped conversation reached session/load %d times", got)
	}
	if got := countACPMethod(frames, "session/new"); got != 1+2 {
		t.Fatalf("expected two scoped session/new calls, got %d", got)
	}
}

func TestACPReleaseSessionForRejectsTheRoomConversation(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", nil), AdapterOptions{})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}
	if _, err := adapter.ReleaseSessionFor("room", true); err == nil {
		t.Fatal("the Room compatibility conversation must never be releasable")
	}
	if _, err := adapter.ReleaseSessionFor("   ", true); err == nil {
		t.Fatal("an empty scope must be rejected")
	}
	if retained, err := adapter.ReleaseSessionFor("task:never-materialized", true); err != nil || retained {
		t.Fatalf("an unmaterialized scope must release as a no-op: retained=%v err=%v", retained, err)
	}
	if got := adapter.SessionDiagnostics(); len(got) != 1 || got[0].Scope != "room" {
		t.Fatalf("a no-op release changed adapter state: %+v", got)
	}
}

func TestIsolatedACPAdapterReleasesOnTheOwningLane(t *testing.T) {
	lanes := make([]*fakeIsolatedLane, isolatedACPLaneCount)
	adapter, err := newIsolatedACPAdapter(func(index int) isolatedLaneAdapter {
		lanes[index] = &fakeIsolatedLane{index: index}
		return lanes[index]
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"task:A", "task:B"} {
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatal(err)
		}
	}
	lane := adapter.scopeLane["task:A"]

	// A scope that never reached a lane has nothing to give back, and the
	// release must not create one.
	if retained, err := adapter.ReleaseSessionFor("task:never", true); err != nil || retained {
		t.Fatalf("unmaterialized scope release: retained=%v err=%v", retained, err)
	}
	if _, created := adapter.scopeLane["task:never"]; created {
		t.Fatal("release created a provider lane for an unknown scope")
	}

	// A dropped conversation also drops its stale native-session pins, so the
	// Human can continue that exact native session in a new Task.
	adapter.mu.Lock()
	adapter.sessionScope["native-1"] = "task:A"
	adapter.sessionLane["native-1"] = lane
	adapter.mu.Unlock()
	lanes[lane].retainOnRel = false
	if retained, err := adapter.ReleaseSessionFor("task:A", false); err != nil || retained {
		t.Fatalf("lane release: retained=%v err=%v", retained, err)
	}
	if got := lanes[lane].released; !reflect.DeepEqual(got, []string{"task:A"}) {
		t.Fatalf("release did not reach the owning lane: %v", got)
	}
	if _, pinned := adapter.scopeLane["task:A"]; pinned {
		t.Fatal("a dropped conversation kept its lane pin, which would grow once per released Task")
	}
	adapter.mu.Lock()
	_, stillPinned := adapter.sessionScope["native-1"]
	adapter.mu.Unlock()
	if stillPinned {
		t.Fatal("a dropped conversation left a stale native-session pin")
	}
	// A fresh conversation for that scope picks a lane again instead of being
	// pinned forever to the lane that used to hold the dropped identity.
	if err := adapter.EnsureSessionFor("task:A"); err != nil {
		t.Fatal(err)
	}
	if _, repinned := adapter.scopeLane["task:A"]; !repinned {
		t.Fatal("a fresh conversation did not get a lane")
	}

	// A retained conversation keeps its pins: a later re-materialization must
	// reach the same lane.
	adapter.mu.Lock()
	adapter.sessionScope["native-2"] = "task:B"
	adapter.sessionLane["native-2"] = adapter.scopeLane["task:B"]
	adapter.mu.Unlock()
	lanes[adapter.scopeLane["task:B"]].retainOnRel = true
	if retained, err := adapter.ReleaseSessionFor("task:B", true); err != nil || !retained {
		t.Fatalf("retained lane release: retained=%v err=%v", retained, err)
	}
	adapter.mu.Lock()
	_, keptPin := adapter.sessionScope["native-2"]
	_, keptLanePin := adapter.scopeLane["task:B"]
	adapter.mu.Unlock()
	if !keptPin || !keptLanePin {
		t.Fatal("a retained conversation lost its lane or native-session pin")
	}
}

// TestACPRetainedIdentityWindowIsBoundedAcrossRollingReleases is the rolling
// >8 regression on the REAL adapter (#473 blocker 2): a long-lived resident
// gives conversations back over and over, and the retained-identity table must
// stay bounded instead of becoming the next unbounded scope state.
func TestACPRetainedIdentityWindowIsBoundedAcrossRollingReleases(t *testing.T) {
	tracePath := t.TempDir() + "/rolling-release-trace.log"
	var diagnostics []string
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_TRACE":              tracePath,
		"FAKE_LOAD_CAP":           "1",
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}), AdapterOptions{DiagnosticSink: func(event string, _ map[string]string) {
		diagnostics = append(diagnostics, event)
	}})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}

	// One rolling release per round: create, complete, give back.
	released := types.MaxRetainedNativeSessions + 4
	sessionIDs := make([]string, 0, released)
	for index := 0; index < released; index++ {
		scope := "task:rolling-" + strconv.Itoa(index)
		if err := adapter.EnsureSessionFor(scope); err != nil {
			t.Fatalf("ensure scoped session %d failed: %v", index, err)
		}
		generation := adapter.SessionGenerationFor(scope)
		if _, err := adapter.RunTurnFor(scope, turnInput("round "+strconv.Itoa(index)), generation); err != nil {
			t.Fatalf("scoped turn %d failed: %v", index, err)
		}
		sessionIDs = append(sessionIDs, scopedSessionID(t, adapter, scope))
		retained, err := adapter.ReleaseSessionFor(scope, true)
		if err != nil || !retained {
			t.Fatalf("release %d: retained=%v err=%v", index, retained, err)
		}
		adapter.mu.Lock()
		held := adapter.retainedTaskSessionCountLocked()
		adapter.mu.Unlock()
		if held > types.MaxRetainedNativeSessions {
			t.Fatalf("retained identity table grew past its bound at release %d: %d", index, held)
		}
	}

	adapter.mu.Lock()
	held := adapter.retainedTaskSessionCountLocked()
	_, oldestHeld := adapter.retainedSessions["task:rolling-0"]
	adapter.mu.Unlock()
	if held != types.MaxRetainedNativeSessions {
		t.Fatalf("retained identity table did not settle at its bound: %d", held)
	}
	if oldestHeld {
		t.Fatal("the oldest retained identity survived the bound")
	}
	evicted := 0
	for _, event := range diagnostics {
		if event == "SESSION_RETAIN_EVICT" {
			evicted++
		}
	}
	if evicted == 0 {
		t.Fatal("evicting a retained identity was not reported")
	}

	// An evicted conversation must be honest: a later ensure creates a genuinely
	// new session and never claims to continue the one that was dropped.
	if err := adapter.EnsureSessionFor("task:rolling-0"); err != nil {
		t.Fatalf("ensure after eviction failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, "task:rolling-0"); got == sessionIDs[0] {
		t.Fatalf("an evicted conversation was resurrected: %q", got)
	}

	// A conversation still inside the window keeps its EXACT identity.
	newest := "task:rolling-" + strconv.Itoa(released-1)
	if err := adapter.EnsureSessionFor(newest); err != nil {
		t.Fatalf("re-materialize retained scope failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, newest); got != sessionIDs[released-1] {
		t.Fatalf("a retained conversation lost its exact identity: got=%q want=%q", got, sessionIDs[released-1])
	}
	frames := readACPTraceFrames(t, tracePath)
	if got := countACPMethod(frames, "session/load"); got != 1 {
		t.Fatalf("retained window did not use exactly one exact session/load: %d", got)
	}
}

// TestACPReleaseWithoutKeepingIdentityForgetsTheConversation pins the forget
// side of the seam: when the Runtime's own released-scope window moves on, the
// adapter must drop the identity so a later instruction cannot silently resume
// a conversation nobody accounts for.
func TestACPReleaseWithoutKeepingIdentityForgetsTheConversation(t *testing.T) {
	tracePath := t.TempDir() + "/forget-release-trace.log"
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_TRACE":              tracePath,
		"FAKE_LOAD_CAP":           "1",
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}
	if err := adapter.EnsureSessionFor("task:forgotten"); err != nil {
		t.Fatalf("ensure scoped session failed: %v", err)
	}
	generation := adapter.SessionGenerationFor("task:forgotten")
	if _, err := adapter.RunTurnFor("task:forgotten", turnInput("seed"), generation); err != nil {
		t.Fatalf("scoped turn failed: %v", err)
	}
	original := scopedSessionID(t, adapter, "task:forgotten")
	if retained, err := adapter.ReleaseSessionFor("task:forgotten", true); err != nil || !retained {
		t.Fatalf("release with retention: retained=%v err=%v", retained, err)
	}
	if retained, err := adapter.ReleaseSessionFor("task:forgotten", false); err != nil || retained {
		t.Fatalf("forgetting release: retained=%v err=%v", retained, err)
	}
	adapter.mu.Lock()
	_, stillHeld := adapter.retainedSessions["task:forgotten"]
	adapter.mu.Unlock()
	if stillHeld {
		t.Fatal("a forgotten conversation kept its native identity")
	}

	if err := adapter.EnsureSessionFor("task:forgotten"); err != nil {
		t.Fatalf("ensure after forget failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, "task:forgotten"); got == original {
		t.Fatalf("a forgotten conversation was resurrected: %q", got)
	}
	frames := readACPTraceFrames(t, tracePath)
	if got := countACPMethod(frames, "session/load"); got != 0 {
		t.Fatalf("a forgotten conversation reached session/load %d times", got)
	}
}

// TestACPReleaseDoesNotClaimAnExactnessTheProviderCannotDeliver pins the seam's
// promise: retention is only reported when the native identity can actually be
// materialized again.
func TestACPReleaseDoesNotClaimAnExactnessTheProviderCannotDeliver(t *testing.T) {
	adapter, _ := newTestAdapter(t, scriptLauncher("normal", map[string]string{
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}), AdapterOptions{})
	defer adapter.Close()

	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure Room session failed: %v", err)
	}
	if err := adapter.EnsureSessionFor("task:no-load"); err != nil {
		t.Fatalf("ensure scoped session failed: %v", err)
	}
	generation := adapter.SessionGenerationFor("task:no-load")
	if _, err := adapter.RunTurnFor("task:no-load", turnInput("seed"), generation); err != nil {
		t.Fatalf("scoped turn failed: %v", err)
	}
	if retained, err := adapter.ReleaseSessionFor("task:no-load", true); err != nil || retained {
		t.Fatalf("a provider without session/load must report retained=false: retained=%v err=%v", retained, err)
	}
	if err := adapter.EnsureSessionFor("task:no-load"); err != nil {
		t.Fatalf("ensure after release failed: %v", err)
	}
	if got := scopedSessionID(t, adapter, "task:no-load"); got == "" {
		t.Fatal("the released scope did not get a usable conversation back")
	}
}

// TestACPReleaseReportsAReapedIdentityTruthfully pins the idle-rematerialization
// case: after a provider process reap the negotiated capabilities are gone, so
// the release must decide from what the identity was retained WITH. An identity
// the Harness can load again is exact continuation; one it cannot is dropped so
// the Runtime never believes in a conversation that cannot come back.
func TestACPReleaseReportsAReapedIdentityTruthfully(t *testing.T) {
	for _, loadable := range []bool{true, false} {
		env := map[string]string{"FAKE_UNIQUE_SESSION_IDS": "1"}
		if loadable {
			env["FAKE_LOAD_CAP"] = "1"
		}
		adapter, _ := newTestAdapter(t, scriptLauncher("normal", env), AdapterOptions{})
		if err := adapter.EnsureSession(); err != nil {
			t.Fatalf("ensure Room session failed: %v", err)
		}
		if err := adapter.EnsureSessionFor("task:reaped"); err != nil {
			t.Fatalf("ensure scoped session failed: %v", err)
		}
		generation := adapter.SessionGenerationFor("task:reaped")
		if _, err := adapter.RunTurnFor("task:reaped", turnInput("seed"), generation); err != nil {
			t.Fatalf("scoped turn failed: %v", err)
		}
		original := scopedSessionID(t, adapter, "task:reaped")
		if err := adapter.ReapIdle(); err != nil {
			t.Fatalf("idle reap failed: %v", err)
		}
		adapter.mu.Lock()
		_, held := adapter.retainedSessions["task:reaped"]
		adapter.mu.Unlock()
		if !held {
			t.Fatal("the idle reap did not retain the scoped identity")
		}

		retained, err := adapter.ReleaseSessionFor("task:reaped", true)
		if err != nil {
			t.Fatalf("release of a reaped identity failed: %v", err)
		}
		if retained != loadable {
			t.Fatalf("reaped identity reported retained=%v, want %v", retained, loadable)
		}
		if !retained {
			adapter.mu.Lock()
			_, stillHeld := adapter.retainedSessions["task:reaped"]
			adapter.mu.Unlock()
			if stillHeld {
				t.Fatal("an unusable reaped identity was kept")
			}
		}
		// Either way a later ensure leaves the scope usable.
		if err := adapter.EnsureSessionFor("task:reaped"); err != nil {
			t.Fatalf("ensure after release failed: %v", err)
		}
		got := scopedSessionID(t, adapter, "task:reaped")
		if got == "" {
			t.Fatal("the scope has no conversation after the release")
		}
		if loadable && got != original {
			t.Fatalf("a loadable reaped identity was not materialized exactly: got=%q want=%q", got, original)
		}
		_ = adapter.Close()
	}
}
