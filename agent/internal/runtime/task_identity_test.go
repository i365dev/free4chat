package runtime

import (
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task identity retention (#473).
 *
 * Reclamation must never silently rewrite what a Task means: its selected
 * project, the Human's native session controls, and an adopted native
 * conversation all survive the release of its conversation. They are bounded by
 * the ROOM's retained Task set rather than by a timer or a lifetime map: a Task
 * text is delivered only while its canonical request is still retained, so an
 * identity record is pruned exactly when the Room can no longer trigger that
 * Task.
 */

// releaseScopeForPruneTest removes one scope's conversation state exactly as a
// reclaim does, without needing capacity pressure.
func releaseScopeForPruneTest(rt *ResidentRuntime, scope string) {
	rt.mu.Lock()
	delete(rt.scopedSessions, scope)
	kept := rt.scopeOrder[:0]
	for _, ordered := range rt.scopeOrder {
		if ordered != scope {
			kept = append(kept, ordered)
		}
	}
	rt.scopeOrder = kept
	rt.mu.Unlock()
}

// armProjectTask pins one new Task to an exact project with native controls.
func armProjectTask(t *testing.T, rt *ResidentRuntime, project, requestID string) {
	t.Helper()
	if err := rt.ArmPreparedProjectTaskWithControls(project, "human-1", requestID, "workspace", map[string]string{"model": "gpt-b"}); err != nil {
		t.Fatalf("arm project Task %s: %v", requestID, err)
	}
}

func TestTaskIdentitySurvivesReclamationAndIsStillHonored(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	adapter.fakeAdapter.releaseRetains = true
	project := t.TempDir()
	scope := taskScopeFor("req-project")

	armProjectTask(t, rt, project, "req-project")
	waitForDone(t, startTurn(rt, taskRequestEvent(1, scope, "req-project", "human-1")), "project Task turn")
	if got, ok := rt.taskProjectCwdLocked(scope); !ok || got != project {
		t.Fatalf("the project identity was not recorded: %q/%v", got, ok)
	}

	// Untouched scopes fill the live bound, so the next admission has to give
	// the project Task's slot back.
	for index := 0; index < types.MaxLogicalTaskScopes-1; index++ {
		rt.acceptEvent(scopedEvent(int64(10+index), taskScopeFor("req-open-"+itoa(int64(index))), "open "+itoa(int64(index))))
	}
	rt.drainTurns()
	waitForDone(t, startTurn(rt, taskRequestEvent(200, taskScopeFor("req-after"), "req-after", "human-1")), "Task that takes the slot")
	if !releasedScope(adapter.fakeAdapter, scope) {
		t.Fatalf("the project Task scope was never reclaimed: %v", adapter.fakeAdapter.releasedSnapshot())
	}

	// Reclamation released the CONVERSATION, never the Task's identity.
	if got, ok := rt.taskProjectCwdLocked(scope); !ok || got != project {
		t.Fatalf("reclamation dropped the project identity: %q/%v", got, ok)
	}
	if mode, config := rt.taskSessionControlsLocked(scope); mode != "workspace" || config["model"] != "gpt-b" {
		t.Fatalf("reclamation dropped the native controls: %q/%v", mode, config)
	}

	// The continued instruction still runs in THAT project with the SAME
	// controls: a conversation may never quietly move to the default workspace
	// or be described as provider-default.
	projectEnsures := adapter.count("newcwd:" + scope)
	waitForDone(t, startTurn(rt, scopedEvent(400, scope, "follow-up in the project")), "resumed project turn")
	if got := adapter.count("newcwd:" + scope); got != projectEnsures+1 {
		t.Fatalf("the resumed Task did not use its project: %v", adapter.recorded())
	}
	if err := rt.applyTaskSessionControls(scope); err != nil {
		t.Fatalf("the Human's native controls no longer apply to the resumed Task: %v", err)
	}
	if mode, config := rt.taskSessionControlsLocked(scope); mode != "workspace" || config["model"] != "gpt-b" {
		t.Fatalf("the resumed Task lost its native controls: %q/%v", mode, config)
	}
}

// TestDroppedConversationStillHonorsTheTaskIdentity is the other half of the
// same contract: when the provider could not keep the conversation, the next
// instruction is a genuinely new session, but it may NOT silently lose the
// Task's project or the Human's native controls.
func TestDroppedConversationStillHonorsTheTaskIdentity(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	// This provider cannot keep the conversation across the release.
	adapter.fakeAdapter.releaseRetains = false
	project := t.TempDir()
	scope := taskScopeFor("req-project")

	armProjectTask(t, rt, project, "req-project")
	waitForDone(t, startTurn(rt, taskRequestEvent(1, scope, "req-project", "human-1")), "project Task turn")

	for index := 0; index < types.MaxLogicalTaskScopes-1; index++ {
		rt.acceptEvent(scopedEvent(int64(10+index), taskScopeFor("req-open-"+itoa(int64(index))), "open "+itoa(int64(index))))
	}
	rt.drainTurns()
	waitForDone(t, startTurn(rt, taskRequestEvent(200, taskScopeFor("req-after"), "req-after", "human-1")), "Task that takes the slot")
	if !releasedScope(adapter.fakeAdapter, scope) {
		t.Fatalf("the project Task scope was never reclaimed: %v", adapter.fakeAdapter.releasedSnapshot())
	}

	projectEnsures := adapter.count("newcwd:" + scope)
	waitForDone(t, startTurn(rt, scopedEvent(400, scope, "follow-up in the project")), "fresh project turn")
	if got := adapter.count("newcwd:" + scope); got != projectEnsures+1 {
		t.Fatalf("the fresh conversation did not use the Task's project: %v", adapter.recorded())
	}
	if got := adapter.count("mode:" + scope + ":workspace"); got == 0 {
		t.Fatalf("the fresh conversation silently fell back to provider defaults: %v", adapter.recorded())
	}
	if joined := strings.Join(adapter.recorded(), "\n"); !strings.Contains(joined, "config:"+scope+":model:gpt-b") {
		t.Fatalf("the fresh conversation lost the Human's config selection: %v", adapter.recorded())
	}
}

func TestTaskIdentityIsPrunedExactlyAtTheRoomRetentionFloor(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	adapter.fakeAdapter.releaseRetains = true
	project := t.TempDir()
	aged := taskScopeFor("req-aged")
	live := taskScopeFor("req-live")

	armProjectTask(t, rt, project, "req-aged")
	waitForDone(t, startTurn(rt, taskRequestEvent(1, aged, "req-aged", "human-1")), "aged Task turn")
	armProjectTask(t, rt, project, "req-live")
	waitForDone(t, startTurn(rt, taskRequestEvent(2, live, "req-live", "human-1")), "live Task turn")

	// The aged Task was reclaimed, so it is no longer live.
	releaseScopeForPruneTest(rt, aged)

	// The Room has moved past the aged Task's canonical request, but not past
	// the live one's.
	if pruned := rt.pruneTaskIdentitiesBelow(2); pruned != 1 {
		t.Fatalf("expected exactly the aged identity to be pruned: %d", pruned)
	}
	if _, ok := rt.taskProjectCwdLocked(aged); ok {
		t.Fatal("an identity the Room can no longer trigger was kept")
	}
	if _, ok := rt.taskProjectCwdLocked(live); !ok {
		t.Fatal("a live Task lost its identity")
	}

	// A LIVE scope keeps its identity even once its own request has aged out:
	// the Task is still being worked on locally.
	if pruned := rt.pruneTaskIdentitiesBelow(3); pruned != 0 {
		t.Fatalf("a live Task's identity was pruned: %d", pruned)
	}
	if _, ok := rt.taskProjectCwdLocked(live); !ok {
		t.Fatal("a live Task lost its identity at the retention floor")
	}

	// Once that Task is no longer live, the same floor prunes it too.
	releaseScopeForPruneTest(rt, live)
	if pruned := rt.pruneTaskIdentitiesBelow(3); pruned != 1 {
		t.Fatalf("a released Task's identity was not pruned at the floor: %d", pruned)
	}
	if _, ok := rt.taskProjectCwdLocked(live); ok {
		t.Fatal("identity memory survived the Room's retained window")
	}
}

func TestTaskIdentitySweepUsesTheRoomRetainedWindow(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter, client := fixture.rt, fixture.adapter, fixture.client
	setRoster(rt, "human-1")
	adapter.fakeAdapter.releaseRetains = true
	project := t.TempDir()

	// One pinned Task per request, enough to cross the sweep threshold.
	requests := maxTaskIdentitiesBeforeSweep + 2
	for index := 0; index < requests; index++ {
		requestID := "req-identity-" + itoa(int64(index))
		sequence := int64(100 + index)
		armProjectTask(t, rt, project, requestID)
		rt.acceptEvent(taskRequestEvent(sequence, taskScopeFor(requestID), requestID, "human-1"))
		rt.drainTurns()
	}
	if got := rt.taskIdentityCount(); got != requests {
		t.Fatalf("expected one identity per Task: %d", got)
	}
	client.mu.Lock()
	client.contextResult = types.RoomContextReadResult{Room: types.RoomContextWindow{
		// Everything up to the last two requests has left the Room window.
		OldestSequence: int64(100 + requests - 2),
	}}
	client.contextCalls = 0
	client.mu.Unlock()

	// The next admission at the bound runs the bounded retention sweep.
	overflow := taskScopeFor("req-identity-overflow")
	rt.acceptEvent(taskRequestEvent(int64(100+requests+10), overflow, "req-identity-overflow", "human-1"))
	rt.drainTurns()

	// Only live scopes (and Tasks the Room can still trigger) may remain: every
	// identity whose conversation was released and whose canonical request left
	// the Room window is gone.
	if _, ok := rt.taskProjectCwdLocked(taskScopeFor("req-identity-0")); ok {
		t.Fatal("an identity the Room can no longer trigger survived the sweep")
	}
	client.mu.Lock()
	calls := client.contextCalls
	options := append([]types.RoomContextReadOptions(nil), client.contextOptions...)
	client.mu.Unlock()
	if calls == 0 {
		t.Fatal("the identity sweep never asked the Room for its retained window")
	}
	for _, option := range options {
		if option.Limit > 1 {
			t.Fatalf("the identity sweep used an unbounded Room read: %+v", option)
		}
	}
	// The newest Tasks are still remembered: pruning is by the Room's window and
	// by liveness, never by arrival order at the resident.
	for _, index := range []int{requests - 1, requests - 2} {
		newest := taskScopeFor("req-identity-" + itoa(int64(index)))
		if _, ok := rt.taskProjectCwdLocked(newest); !ok {
			t.Fatalf("the sweep pruned a Task the Room can still trigger: %s", newest)
		}
	}
	// Identity memory is now bounded by the LIVE window instead of growing with
	// every Task this resident ever pinned.
	rt.mu.Lock()
	live := len(rt.scopeOrder)
	rt.mu.Unlock()
	if got := rt.taskIdentityCount(); got > live {
		t.Fatalf("identity memory exceeded the live window: %d vs %d", got, live)
	}
}
