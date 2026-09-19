package runtime

import (
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * #409: an EXACT prepared adoption is CLAIMED by its own canonical Task.
 *
 * The browser preparation is armed while waiting for its canonical Task, and
 * the Runtime's execution is serial: a Task can be accepted into the bounded
 * pending queue long before the single serialized drain reaches it. These tests
 * pin that the orphan TTL covers only "the canonical Task never arrives" and
 * can never turn an already-accepted Task into `session_lost`.
 */

// claimFixture is a discovery fixture whose scoped turns can be held open, so a
// long-running predecessor is deterministic rather than timing-dependent.
func (f *discoveryFixture) holdNextScopedTurn() chan struct{} {
	gate := make(chan struct{})
	f.adapter.mu.Lock()
	f.adapter.scopedTurnWait = gate
	f.adapter.mu.Unlock()
	return gate
}

// forceOrphanExpiry moves a prepared adoption past its orphan TTL without
// sleeping, exactly as the old two-minute boundary would.
func forceOrphanExpiry(t *testing.T, rt *ResidentRuntime) {
	t.Helper()
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.pendingAdoption == nil {
		t.Fatal("no prepared adoption to expire")
	}
	rt.pendingAdoption.expiresAt = time.Now().Add(-time.Second).UnixMilli()
}

func adoptionSnapshot(t *testing.T, rt *ResidentRuntime) *pendingSessionAdoption {
	t.Helper()
	snapshot := rt.pendingAdoptionSnapshot()
	if snapshot == nil {
		t.Fatal("expected an armed preparation")
	}
	return snapshot
}

// TestClaimedPreparationSurvivesALongRunningPredecessor is the real product
// scenario: Task A holds the single serialized Harness turn for far longer than
// the orphan TTL, while Task B's canonical trigger is accepted behind it.
func TestClaimedPreparationSurvivesALongRunningPredecessor(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	// Task A is admitted and blocked inside its Harness turn.
	gate := fixture.holdNextScopedTurn()
	done := startTurn(rt, taskRequestEvent(1, "task:req-A", "req-A", "human-1"))
	waitForActiveScope(t, rt, "task:req-A")

	// The Human selects a local session for Task B while A is still running.
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-B"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	if adoptionSnapshot(t, rt).claimed {
		t.Fatal("a preparation must start out unclaimed")
	}

	// Task B's canonical trigger is received and ACCEPTED into the bounded
	// pending queue while A is still blocked.
	rt.acceptEvent(taskRequestEvent(2, "task:req-B", "req-B", "human-1"))

	claim := adoptionSnapshot(t, rt)
	if !claim.claimed {
		t.Fatal("an accepted exact canonical Task must claim its preparation")
	}
	if claim.taskRequestID != "req-B" {
		t.Fatalf("claimed the wrong Task: %+v", claim)
	}
	// Nothing was loaded while A owned the Harness: the drain is serialized and
	// the preparation only records a fact.
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("a claim must never load while another Task is running: %v", adapter.recorded())
	}
	if activeScope(rt) != "task:req-A" {
		t.Fatalf("Task A lost the serialized turn: %q", activeScope(rt))
	}

	// The OLD two-minute orphan boundary passes before A finishes.
	forceOrphanExpiry(t, rt)

	// Task A completes; the same serialized drain now reaches Task B.
	close(gate)
	waitForDone(t, done, "Task A then Task B")

	loads := adapter.loadCalls()
	if len(loads) != 1 || loads[0].scope != "task:req-B" || loads[0].sessionID != "native-pi-1" {
		t.Fatalf("Task B did not load its exact native session: %+v", loads)
	}
	if got := adapter.count("new:task:req-B"); got != 0 {
		t.Fatalf("a claimed Task must never create a scoped session: %v", adapter.recorded())
	}
	if got := adapter.runCount("task:req-B"); got != 1 {
		t.Fatalf("Task B must run exactly once: %d", got)
	}
	if got := adapter.runCount("task:req-A"); got != 1 {
		t.Fatalf("Task A must still have run exactly once: %d", got)
	}
	if rt.preparedAdoptionWasDeclined("req-B") {
		t.Fatal("a claimed preparation must never be recorded as declined")
	}
	if remaining := rt.pendingAdoptionSnapshot(); remaining != nil {
		t.Fatalf("the claim must be consumed by admission: %+v", remaining)
	}
	if !rt.isAdoptedScope("task:req-B") {
		t.Fatal("Task B must stay permanently bound to the selected conversation")
	}
	assertNoSessionIDLeak(t, fixture.adoptionFixture, "native-pi-1")
}

// TestUnclaimedPreparationStillExpires is the other half of the contract: a
// preparation whose canonical Task NEVER arrives must still be swept, must
// never be silently usable later, and must never be consumable by another Task.
func TestUnclaimedPreparationStillExpires(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-X"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	if adoptionSnapshot(t, rt).claimed {
		t.Fatal("nothing may claim a preparation before its Task is accepted")
	}
	forceOrphanExpiry(t, rt)

	// An unrelated Task cannot consume it, and the orphan is swept on the next
	// admission boundary.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-Y", "req-Y", "human-1")), "unrelated Task turn")
	if got := adapter.count("load:task:req-Y"); got != 0 {
		t.Fatalf("an unrelated Task must never adopt the preparation: %v", adapter.recorded())
	}
	if got := adapter.count("new:task:req-Y"); got != 1 {
		t.Fatalf("an unrelated Task must keep its fresh session: %v", adapter.recorded())
	}
	if rt.pendingAdoptionSnapshot() != nil {
		t.Fatal("the orphaned preparation must be swept")
	}
	if !rt.preparedAdoptionWasDeclined("req-X") {
		t.Fatal("the orphaned preparation must be recorded so its own Task fails closed")
	}

	// Its own Task therefore fails closed rather than silently starting fresh.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-X", "req-X", "human-1")), "late Task turn")
	if got := adapter.count("new:task:req-X") + adapter.count("load:task:req-X"); got != 0 {
		t.Fatalf("an orphaned Task must neither load nor create a session: %v", adapter.recorded())
	}
	if !rt.isAdoptedScope("task:req-X") {
		t.Fatal("an orphaned Task must stay permanently bound to its lost conversation")
	}
}

// TestRefusedCanonicalTaskDoesNotClaimThePreparation fences the admission
// condition: a Task trigger the bounded queue REFUSES must not make the
// preparation immortal.
func TestRefusedCanonicalTaskDoesNotClaimThePreparation(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-X"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}

	// Fill this scope's bounded pending queue so the canonical trigger cannot
	// be accepted. These fillers are ordinary addressed Room text: they carry
	// no collaboration request, so they can never claim anything.
	for index := 0; index < MaxPendingTurns; index++ {
		filler := scopedEvent(int64(index+1), "task:req-X", "filler")
		filler.Type = "text"
		rt.acceptEvent(filler)
	}
	rt.mu.Lock()
	queued := len(*rt.sessionRefLocked("task:req-X").pendingAddressed)
	rt.mu.Unlock()
	if queued != MaxPendingTurns {
		t.Fatalf("the bounded queue was not filled: %d", queued)
	}

	// The EXACT canonical Human-owned Task arrives — and is refused.
	rt.acceptEvent(taskRequestEvent(int64(MaxPendingTurns+1), "task:req-X", "req-X", "human-1"))

	claim := adoptionSnapshot(t, rt)
	if claim.claimed {
		t.Fatal("a Task the queue refused must not claim the preparation")
	}
	// Its orphan TTL therefore remains authoritative.
	forceOrphanExpiry(t, rt)
	rt.mu.Lock()
	swept := rt.expirePreparedAdoptionLocked(time.Now().UnixMilli())
	rt.mu.Unlock()
	if swept != nil {
		t.Fatalf("a refused Task must not make the preparation immortal: %+v", swept)
	}
	if !rt.preparedAdoptionWasDeclined("req-X") {
		t.Fatal("the refused preparation must be recorded as declined")
	}
	if got := adapter.count("load:"); got != 0 {
		t.Fatalf("nothing may load for a refused Task: %v", adapter.recorded())
	}
}

// TestPreparationIsNotClaimedByAnUnrelatedOrForgedEvent fences every part of
// the claim proof: only the EXACT canonical Human-owned Task of the SAME
// requestId, from the SAME Human, after the arm fence, may claim.
func TestPreparationIsNotClaimedByAnUnrelatedOrForgedEvent(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		event func() types.RoomEvent
	}{
		{
			name: "another Task id",
			event: func() types.RoomEvent {
				return taskRequestEvent(1, "task:req-OTHER", "req-OTHER", "human-1")
			},
		},
		{
			name: "another Human's Task with the same scope",
			event: func() types.RoomEvent {
				return taskRequestEvent(1, "task:req-X", "req-X", "human-2")
			},
		},
		{
			name: "an Agent-originated request",
			event: func() types.RoomEvent {
				event := taskRequestEvent(1, "task:req-X", "req-X", "human-1")
				event.Participant = types.ParticipantIdentity{ID: "agent", Name: "Agent", Kind: types.KindAgent}
				return event
			},
		},
		{
			name: "an unaddressed event",
			event: func() types.RoomEvent {
				event := taskRequestEvent(1, "task:req-X", "req-X", "human-1")
				event.Addressed = false
				return event
			},
		},
		{
			name: "a non-request collaboration kind",
			event: func() types.RoomEvent {
				event := taskRequestEvent(1, "task:req-X", "req-X", "human-1")
				event.Collab.Kind = types.CollabAccepted
				return event
			},
		},
		{
			name: "a request addressed to another Agent",
			event: func() types.RoomEvent {
				event := taskRequestEvent(1, "task:req-X", "req-X", "human-1")
				event.Collab.TargetParticipantID = "agent-2"
				return event
			},
		},
		{
			name: "a trigger at or before the arm fence",
			event: func() types.RoomEvent {
				return taskRequestEvent(1, "task:req-X", "req-X", "human-1")
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newDiscoveryFixture(t, "")
			rt := fixture.rt
			setRoster(rt, "human-1", "human-2")

			// The fence for the last case is captured AFTER the trigger exists,
			// so its sequence can never be strictly greater.
			if testCase.name == "a trigger at or before the arm fence" {
				rt.acceptEvent(taskRequestEvent(1, "task:req-X", "req-X", "human-1"))
			}
			if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-X"); err != nil {
				t.Fatalf("arm prepared adoption: %v", err)
			}
			rt.acceptEvent(testCase.event())

			if adoptionSnapshot(t, rt).claimed {
				t.Fatal("an event that is not the exact canonical Human-owned Task must not claim")
			}
		})
	}
}

// TestClaimedPreparationWithoutAFenceOwnerStillBinds fences the fail-closed
// direction: once claimed, a prepared Task binds its conversation even when the
// serialized boundary can no longer re-derive ownership.
func TestClaimedPreparationWithoutAFenceOwnerStillBinds(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-B"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	rt.acceptEvent(taskRequestEvent(1, "task:req-B", "req-B", "human-1"))
	if !adoptionSnapshot(t, rt).claimed {
		t.Fatal("expected the canonical Task to claim the preparation")
	}

	// The frozen context is gone by the time the drain reaches the Task. A
	// claimed preparation must still load rather than silently starting a new
	// conversation the Human did not ask for.
	rt.mu.Lock()
	ref := rt.sessionRefLocked("task:req-B")
	*ref.pendingContexts = nil
	rt.mu.Unlock()

	if err := rt.admitHarnessSession("task:req-B", 1); err != nil {
		t.Fatalf("a claimed preparation must bind regardless of frozen context: %v", err)
	}
	loads := adapter.loadCalls()
	if len(loads) != 1 || loads[0].scope != "task:req-B" || loads[0].sessionID != "native-pi-1" {
		t.Fatalf("a claimed Task must load its exact conversation: %+v", loads)
	}
	if got := adapter.count("new:task:req-B"); got != 0 {
		t.Fatalf("a claimed Task must never create a scoped session: %v", adapter.recorded())
	}

	// A second admission for the same scope never loads twice.
	if err := rt.admitHarnessSession("task:req-B", 1); err != nil {
		t.Fatalf("re-admission must reuse the retained session: %v", err)
	}
	if got := len(adapter.loadCalls()); got != 1 {
		t.Fatalf("a claimed Task must load exactly once, got %d", got)
	}
}

// TestClaimIsNotConfusedWithTheCLIPath fences the representation: the CLI
// handoff's unbounded "next eligible Task" adoption is never claimed, and a
// claimed browser preparation is never treated as an unbounded CLI adoption.
func TestClaimIsNotConfusedWithTheCLIPath(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt := fixture.rt
	setRoster(rt, "human-1")

	// CLI path: sequence-fenced, no exact id, unbounded by design.
	if err := rt.ArmSessionAdoption("native-pi-1", "", "human-1"); err != nil {
		t.Fatalf("arm CLI adoption: %v", err)
	}
	rt.acceptEvent(taskRequestEvent(1, "task:req-A", "req-A", "human-1"))
	cli := adoptionSnapshot(t, rt)
	if cli.claimed {
		t.Fatal("the CLI adoption must never be claimed by an exact-Task rule")
	}
	if cli.taskRequestID != "" || cli.expiresAt != 0 {
		t.Fatalf("the CLI adoption must stay unbounded and unpinned: %+v", cli)
	}

	// Browser path: exact, orphan-bounded, and claimed by its own Task.
	rt.ClearSessionAdoption()
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "", "human-1", "req-B"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	prepared := adoptionSnapshot(t, rt)
	if prepared.taskRequestID != "req-B" || prepared.expiresAt == 0 {
		t.Fatalf("a prepared adoption must be exact and orphan-bounded: %+v", prepared)
	}
	rt.acceptEvent(taskRequestEvent(2, "task:req-B", "req-B", "human-1"))
	claimed := adoptionSnapshot(t, rt)
	if !claimed.claimed {
		t.Fatal("the prepared adoption must be claimed by its exact Task")
	}
	if err := rt.ClearSessionAdoption(); err != nil {
		t.Fatalf("a claimed adoption must still be releasable: %v", err)
	}
	if rt.pendingAdoptionSnapshot() != nil {
		t.Fatal("clear must release a claimed adoption")
	}
}

// TestClaimDoesNotAffectOrdinaryTasks is the regression fence: a Runtime with
// no preparation behaves exactly as before.
func TestClaimDoesNotAffectOrdinaryTasks(t *testing.T) {
	fixture := newDiscoveryFixture(t, "")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	for index, scope := range []string{"task:req-1", "task:req-2"} {
		waitForDone(t, startTurn(rt, taskRequestEvent(int64(index+1), scope, scope[5:], "human-1")), scope)
		if got := adapter.count("new:" + scope); got != 1 {
			t.Fatalf("an ordinary Task must keep its fresh session: %v", adapter.recorded())
		}
		if got := adapter.count("load:" + scope); got != 0 {
			t.Fatalf("an ordinary Task must never load: %v", adapter.recorded())
		}
	}
	if rt.pendingAdoptionSnapshot() != nil {
		t.Fatal("no preparation may be created by ordinary Tasks")
	}
}
