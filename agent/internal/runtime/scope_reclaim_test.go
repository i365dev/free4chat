package runtime

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Terminal Task scope reclamation (#473).
 *
 * MaxLogicalTaskScopes is a safety bound, not a Task lifecycle policy. These
 * tests pin the reclamation contract:
 *
 *   - enough Tasks can complete to reach the historical bound;
 *   - a terminal, idle scope is given back exactly when a new Task needs the
 *     slot, and a subsequent independent Task is admitted and executes;
 *   - an active or queued Task scope is NEVER reclaimed, and a resident with
 *     nothing reclaimable keeps its existing fail-closed rejection;
 *   - a reclaimed Task's continued instruction materializes its exact
 *     conversation again when the provider kept the native identity, and is
 *     never answered from another Task's conversation;
 *   - an adopted Task (the Pi exact-continuation contract) is given back last,
 *     keeps its binding when the identity survives, and fails closed instead of
 *     silently starting a fresh conversation when it does not.
 */

// reclaimFixture is one resident with a scriptable scoped Harness double plus
// the exact Task request helper the Room uses.
type reclaimFixture struct {
	rt      *ResidentRuntime
	adapter *fakeAdapter
	client  *executionClient
}

func newReclaimFixture(t *testing.T, adapter *fakeAdapter) *reclaimFixture {
	t.Helper()
	client := newExecutionClient()
	rt := NewResidentRuntime(Options{
		InstanceID: "scope-reclaim",
		RoomID:     "room-scope-reclaim",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)
	return &reclaimFixture{rt: rt, adapter: adapter, client: client}
}

// runHumanTask admits and completes one canonical Human Task: the Room trigger
// is accepted, the Harness turn succeeds, and the Runtime publishes the
// canonical terminal result the Room projects as Completed.
func (f *reclaimFixture) runHumanTask(t *testing.T, sequence int64, requestID string) {
	t.Helper()
	f.rt.acceptEvent(taskRequestEvent(sequence, taskScopeForRequestID(requestID), requestID, "human-1"))
	f.rt.drainTurns()
}

// releasedConversationCount reports how many released Task conversations the
// Runtime still remembers exactly.
func (f *reclaimFixture) releasedConversationCount() int {
	f.rt.mu.Lock()
	defer f.rt.mu.Unlock()
	return len(f.rt.releasedTaskOrder)
}

// remembersReleasedConversation reports whether the Runtime still remembers one
// released Task conversation exactly.
func (f *reclaimFixture) remembersReleasedConversation(scope string) bool {
	f.rt.mu.Lock()
	defer f.rt.mu.Unlock()
	_, ok := f.rt.releasedTaskScopes[scope]
	return ok
}

func (f *reclaimFixture) scopeCount() int {
	f.rt.mu.Lock()
	defer f.rt.mu.Unlock()
	return len(f.rt.scopeOrder)
}

func (f *reclaimFixture) scopeExists(scope string) bool {
	f.rt.mu.Lock()
	defer f.rt.mu.Unlock()
	return f.rt.scopedSessions[scope] != nil
}

func (f *reclaimFixture) terminalScopes() []string {
	f.rt.mu.Lock()
	defer f.rt.mu.Unlock()
	var out []string
	for _, scope := range f.rt.scopeOrder {
		if state := f.rt.scopedSessions[scope]; state != nil && state.terminal {
			out = append(out, scope)
		}
	}
	return out
}

// capacityResultSummaries lists every canonical failure the Runtime published
// for a refused admission, so a test can prove the historical rejection did or
// did not happen.
func (f *reclaimFixture) capacityResultSummaries() []string {
	f.client.mu.Lock()
	defer f.client.mu.Unlock()
	var out []string
	for _, result := range f.client.collabResults {
		if result.Status != "failed" {
			continue
		}
		out = append(out, result.Summary)
	}
	return out
}

func (f *reclaimFixture) completedTaskCount() int {
	f.client.mu.Lock()
	defer f.client.mu.Unlock()
	count := 0
	for _, result := range f.client.collabResults {
		if result.Status == "completed" {
			count++
		}
	}
	return count
}

func taskScopeFor(requestID string) string { return "task:" + requestID }

// TestTerminalTaskScopesAreReclaimedSoNewTasksKeepBeingAdmitted is the core
// regression: the historical bound is reachable AND reusable.
func TestTerminalTaskScopesAreReclaimedSoNewTasksKeepBeingAdmitted(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	if got := fixture.scopeCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("resident did not reach the historical scope bound: %d", got)
	}
	if got := fixture.terminalScopes(); len(got) != types.MaxLogicalTaskScopes {
		t.Fatalf("completed Tasks were not recorded terminal: %v", got)
	}
	if got := fixture.completedTaskCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("completed Task results were not published: %d", got)
	}
	if got := adapter.releasedSnapshot(); len(got) != 0 {
		t.Fatalf("scope was reclaimed without capacity pressure: %v", got)
	}

	// The next independent Task must be admitted, not refused: the oldest
	// terminal scope's slot is given back.
	fixture.runHumanTask(t, 100, "req-overflow")

	if got := fixture.capacityResultSummaries(); len(got) != 0 {
		t.Fatalf("a new Task was still refused at the historical bound: %v", got)
	}
	if got := fixture.scopeCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("reclaimed slot was not reused exactly: %d", got)
	}
	if fixture.scopeExists(taskScopeFor("req-1")) {
		t.Fatal("the oldest terminal Task scope was not reclaimed")
	}
	if !fixture.scopeExists(taskScopeFor("req-overflow")) {
		t.Fatal("the new Task scope was not admitted")
	}
	if got := adapter.releasedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-1")}) {
		t.Fatalf("the wrong scope was given back: %v", got)
	}
	if got := adapter.retainedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-1")}) {
		t.Fatalf("the released conversation identity was not retained: %v", got)
	}
	runs, _ := adapter.scopedRunSnapshot()
	if len(runs) != types.MaxLogicalTaskScopes+1 || runs[len(runs)-1] != taskScopeFor("req-overflow") {
		t.Fatalf("the admitted Task did not execute: %v", runs)
	}
	if got := fixture.completedTaskCount(); got != types.MaxLogicalTaskScopes+1 {
		t.Fatalf("the admitted Task did not settle truthfully: %d", got)
	}
	// Existing scopes keep their own conversations at the bound.
	if !fixture.scopeExists(taskScopeFor("req-2")) || !fixture.scopeExists(taskScopeFor("req-8")) {
		t.Fatal("reclamation removed more than the one scope it needed")
	}
}

// TestReclaimedTaskScopeNeverStealsAnotherTasksConversation proves the
// continuation identity of a reclaimed Task after the slot was given back.
func TestReclaimedTaskScopeNeverStealsAnotherTasksConversation(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	fixture.runHumanTask(t, 100, "req-overflow")
	if got := adapter.releasedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-1")}) {
		t.Fatalf("reclamation precondition failed: %v", got)
	}

	// A later instruction for the reclaimed Task must continue EXACTLY its own
	// conversation, never another Task's and never a silent new one.
	followUp := scopedEvent(200, taskScopeFor("req-1"), "follow-up for req-1")
	rt.acceptEvent(followUp)
	rt.drainTurns()

	if got := adapter.materializedSnapshot(); len(got) != 1 || got[0] != taskScopeFor("req-1") {
		t.Fatalf("the reclaimed conversation was not materialized exactly: %v", got)
	}
	_, details := adapter.scopedRunSnapshot()
	turns := details[taskScopeFor("req-1")]
	if len(turns) != 2 {
		t.Fatalf("the continued instruction did not run on its own scope: %v", turns)
	}
	if turns[1] != "follow-up for req-1" {
		t.Fatalf("the continued turn carried foreign context: %q", turns[1])
	}
	// The Room-visible Task correlation is unchanged: the reply still belongs
	// to the same Task request.
	sentTaskIDs := fixture.client.snapshotSentTaskRequestIDs()
	if len(sentTaskIDs) != types.MaxLogicalTaskScopes+2 || sentTaskIDs[len(sentTaskIDs)-1] != "req-1" {
		t.Fatalf("the continued Task lost its Room correlation: %v", sentTaskIDs)
	}
}

// TestReclaimedScopeWithoutRetentionIsReportedNotSwapped pins the provider
// path where the exact native conversation cannot survive the release: the
// continuation is a genuinely new session that the Harness is told is new, and
// never a silent reuse of the released conversation.
func TestReclaimedScopeWithoutRetentionIsReportedNotSwapped(t *testing.T) {
	adapter := &fakeAdapter{name: "codex"}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	fixture.runHumanTask(t, 100, "req-overflow")

	if got := adapter.retainedSnapshot(); len(got) != 0 {
		t.Fatalf("a dropped conversation was reported retained: %v", got)
	}
	// The Human is told the retained conversation is gone rather than silently
	// receiving replies from a conversation without memory.
	waitForExecution(t, fixture.client, "req-1", "dropped conversation availability", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})
	rt.acceptEvent(scopedEvent(200, taskScopeFor("req-1"), "follow-up for req-1"))
	rt.drainTurns()
	if got := adapter.materializedSnapshot(); len(got) != 0 {
		t.Fatalf("a dropped conversation was materialized again: %v", got)
	}
	news := adapter.scopedSessionNewSnapshot(taskScopeFor("req-1"))
	if len(news) != 2 || news[0] != true || news[1] != true {
		t.Fatalf("the replacement conversation was not reported as a new session: %v", news)
	}
}

// TestActiveAndQueuedTaskScopesAreNeverReclaimed is the safety fence: only a
// finished AND idle Task may lose its slot.
func TestActiveAndQueuedTaskScopesAreNeverReclaimed(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}

	// task:req-1 becomes ACTIVE and task:req-3 becomes QUEUED behind it on the
	// fail-safe serial lane.
	gate := make(chan struct{})
	var releaseGate sync.Once
	openGate := func() { releaseGate.Do(func() { close(gate) }) }
	defer openGate()
	adapter.mu.Lock()
	adapter.scopedTurnWait = gate
	adapter.mu.Unlock()
	rt.acceptEvent(scopedEvent(200, taskScopeFor("req-1"), "long turn on req-1"))
	rt.launchTurns()
	waitFor(t, 5*time.Second, func() bool { return rt.scopeRunning(taskScopeFor("req-1")) }, "req-1 turn to start")
	rt.acceptEvent(scopedEvent(201, taskScopeFor("req-3"), "queued turn on req-3"))
	rt.launchTurns()
	if got := rt.pendingAddressedSnapshotFor(taskScopeFor("req-3")); !reflect.DeepEqual(got, []int64{201}) {
		t.Fatalf("req-3 was not queued behind the active turn: %v", got)
	}

	// Capacity pressure may only take the oldest terminal AND idle scope.
	rt.acceptEvent(taskRequestEvent(300, taskScopeFor("req-overflow"), "req-overflow", "human-1"))
	if got := adapter.releasedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-2")}) {
		t.Fatalf("an active or queued Task scope was reclaimed: %v", got)
	}
	if !fixture.scopeExists(taskScopeFor("req-1")) || !rt.scopeRunning(taskScopeFor("req-1")) {
		t.Fatal("the active Task scope was reclaimed")
	}
	if !fixture.scopeExists(taskScopeFor("req-3")) {
		t.Fatal("the queued Task scope was reclaimed")
	}
	if got := rt.pendingAddressedSnapshotFor(taskScopeFor("req-3")); !reflect.DeepEqual(got, []int64{201}) {
		t.Fatalf("a reclaimed neighbor dropped accepted work: %v", got)
	}
	openGate()
	waitFor(t, 5*time.Second, func() bool { return !rt.scopeRunning(taskScopeFor("req-1")) }, "req-1 turn to settle")
	rt.drainTurns()
	_, details := adapter.scopedRunSnapshot()
	if got := details[taskScopeFor("req-3")]; !reflect.DeepEqual(got, []string{"instruction for req-3", "queued turn on req-3"}) {
		t.Fatalf("queued work was lost or reordered: %v", got)
	}
}

// TestResidentWithNothingReclaimableKeepsFailingClosed pins the unchanged
// behavior for scopes with no terminal lifecycle: an ordinary non-terminated
// scope is never given back, and the Room still receives the canonical
// capacity failure.
func TestResidentWithNothingReclaimableKeepsFailingClosed(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		rt.acceptEvent(scopedEvent(int64(index+1), taskScopeFor("req-"+itoa(int64(index+1))), "scope-"+itoa(int64(index+1))))
	}
	rt.drainTurns()
	if got := fixture.terminalScopes(); len(got) != 0 {
		t.Fatalf("a non-collaboration scope was treated as terminal: %v", got)
	}

	overflow := taskRequestEvent(100, taskScopeFor("req-overflow"), "req-overflow", "human-1")
	rt.acceptEvent(overflow)
	if got := adapter.releasedSnapshot(); len(got) != 0 {
		t.Fatalf("an unterminated Task scope was reclaimed: %v", got)
	}
	if got := fixture.scopeCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("capacity rejection changed scope state: %d", got)
	}
	results := fixture.client.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-overflow" ||
		results[0].Status != "failed" || results[0].Summary != "Agent cannot start another task right now." {
		t.Fatalf("capacity rejection lost its canonical result: %#v", results)
	}
}

// TestAdoptedTaskScopeIsReclaimedLastAndItsBindingStaysExact pins the #409
// contract under reclamation: an adopted Task is given back only after every
// ordinary terminal scope, keeps its EXACT native conversation when the
// adapter still has it, and fails closed when it does not.
func TestAdoptedTaskScopeIsReclaimedLastAndItsBindingStaysExact(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	adapter.fakeAdapter.releaseRetains = true

	// One ordinary Task completes first, then the Human continues a native Pi
	// conversation as a second Task.
	waitForDone(t, startTurn(rt, taskRequestEvent(1, taskScopeFor("req-plain"), "req-plain", "human-1")), "ordinary Task turn")
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-adopted"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	waitForDone(t, startTurn(rt, taskRequestEvent(2, taskScopeFor("req-adopted"), "req-adopted", "human-1")), "adopted Task turn")
	if got := adapter.loadCalls(); len(got) != 1 || got[0].sessionID != "native-pi-1" {
		t.Fatalf("the adopted Task did not load its native session: %+v", got)
	}
	if got := adapter.fakeAdapter.releasedSnapshot(); len(got) != 0 {
		t.Fatalf("a terminal Task was reclaimed without capacity pressure: %v", got)
	}

	// Untouched scopes fill the rest of the bound.
	for index := 0; index < types.MaxLogicalTaskScopes-2; index++ {
		rt.acceptEvent(scopedEvent(int64(10+index), taskScopeFor("req-open-"+itoa(int64(index))), "open scope "+itoa(int64(index))))
	}
	rt.drainTurns()

	// Capacity pressure must give back the ordinary terminal scope, never the
	// adopted one, even though the adopted Task is older by admission order.
	rt.acceptEvent(taskRequestEvent(100, taskScopeFor("req-overflow"), "req-overflow", "human-1"))
	rt.drainTurns()
	if got := adapter.fakeAdapter.releasedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-plain")}) {
		t.Fatalf("the adopted Task scope was not given back last: %v", got)
	}
	if !rt.isAdoptedScope(taskScopeFor("req-adopted")) {
		t.Fatal("reclamation dropped the adopted binding of a live scope")
	}

	// The ordinary terminal scope admitted above is the only plain candidate
	// left, so it is given back first; that leaves the adopted Task as the only
	// terminal scope, and the admission after it must take the adopted slot.
	// Its native conversation identity is retained, never substituted.
	rt.acceptEvent(scopedEvent(200, taskScopeFor("req-open-late"), "open late"))
	rt.drainTurns()
	rt.acceptEvent(taskRequestEvent(300, taskScopeFor("req-after"), "req-after", "human-1"))
	rt.drainTurns()
	if !releasedScope(adapter.fakeAdapter, taskScopeFor("req-adopted")) {
		t.Fatalf("the adopted Task scope was never reclaimed: %v", adapter.fakeAdapter.releasedSnapshot())
	}
	if !adapter.fakeAdapter.hasRetainedScope(taskScopeFor("req-adopted")) {
		t.Fatalf("the adopted native identity was not retained: %v", adapter.fakeAdapter.retainedSnapshot())
	}
	if !rt.isAdoptedScope(taskScopeFor("req-adopted")) {
		t.Fatal("the reclaimed adopted Task lost its permanent binding")
	}

	// A later instruction for that Task continues the SAME native conversation.
	waitForDone(t, startTurn(rt, scopedEvent(400, taskScopeFor("req-adopted"), "continue the native session")), "continued adopted turn")
	if got := adapter.fakeAdapter.materializedSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-adopted")}) {
		t.Fatalf("the reclaimed adopted Task did not re-materialize its conversation: %v", got)
	}
	if got := adapter.count("new:" + taskScopeFor("req-adopted")); got != 0 {
		t.Fatalf("a reclaimed adopted Task created a fresh conversation: %v", adapter.recorded())
	}
	// The resumed turn continues the SAME conversation, so the Harness is
	// neither told it is new nor sent the host bootstrap a second time.
	context := adapter.latestSessionContext(taskScopeFor("req-adopted"))
	if context == nil || context.New || context.Bootstrap {
		t.Fatalf("a resumed adopted Task was described as a new/bootstrap session: %+v", context)
	}
	var adopted []string
	for _, event := range adapter.recorded() {
		if strings.HasSuffix(event, ":"+taskScopeFor("req-adopted")) {
			adopted = append(adopted, event)
		}
	}
	want := []string{
		"load:" + taskScopeFor("req-adopted"),
		"run:" + taskScopeFor("req-adopted"),
		"materialize:" + taskScopeFor("req-adopted"),
		"run:" + taskScopeFor("req-adopted"),
	}
	if !reflect.DeepEqual(adopted, want) {
		t.Fatalf("the adopted Task's conversation history is not exact: got=%v want=%v", adopted, want)
	}
}

// releasedScope reports whether one scope's conversation was already given
// back by the Runtime under test.
func releasedScope(adapter *fakeAdapter, scope string) bool {
	for _, released := range adapter.releasedSnapshot() {
		if released == scope {
			return true
		}
	}
	return false
}

// TestReclaimedAdoptedTaskFailsClosedWhenItsConversationIsGone pins the other
// half of the #409 contract: a released adopted binding that could not keep its
// native identity must never be answered by a substitute conversation.
func TestReclaimedAdoptedTaskFailsClosedWhenItsConversationIsGone(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	// This provider cannot materialize the native session again.
	adapter.fakeAdapter.releaseRetains = false

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-adopted"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	waitForDone(t, startTurn(rt, taskRequestEvent(1, taskScopeFor("req-adopted"), "req-adopted", "human-1")), "adopted Task turn")
	for index := 0; index < types.MaxLogicalTaskScopes-1; index++ {
		rt.acceptEvent(scopedEvent(int64(10+index), taskScopeFor("req-open-"+itoa(int64(index))), "open scope "+itoa(int64(index))))
	}
	rt.drainTurns()
	// The adopted Task is the only terminal scope, so this admission has to
	// give its slot back — and its conversation cannot survive the release.
	waitForDone(t, startTurn(rt, taskRequestEvent(200, taskScopeFor("req-after"), "req-after", "human-1")), "Task that takes the adopted slot")
	if !releasedScope(adapter.fakeAdapter, taskScopeFor("req-adopted")) {
		t.Fatalf("the adopted Task scope was never reclaimed: %v", adapter.fakeAdapter.releasedSnapshot())
	}
	if got := adapter.fakeAdapter.retainedSnapshot(); len(got) != 0 {
		t.Fatalf("a dropped native identity was reported retained: %v", got)
	}
	// The truthful lost-session availability is published asynchronously.
	waitForExecution(t, fixture.client, "req-adopted", "lost adopted conversation availability", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})

	// The next instruction IS admitted (it gives back the plain terminal scope)
	// and then fails closed at the adopted-session boundary: no session/new, no
	// materialization, and no substitute turn.
	waitForDone(t, startTurn(rt, scopedEvent(500, taskScopeFor("req-adopted"), "continue the native session")), "continued adopted turn")
	if !releasedScope(adapter.fakeAdapter, taskScopeFor("req-after")) {
		t.Fatalf("the continued Task was refused instead of admitted: %v", adapter.fakeAdapter.releasedSnapshot())
	}
	if got := adapter.count("new:" + taskScopeFor("req-adopted")); got != 0 {
		t.Fatalf("a released adopted Task started a fresh conversation: %v", adapter.recorded())
	}
	if got := adapter.count("materialize:" + taskScopeFor("req-adopted")); got != 0 {
		t.Fatalf("a released adopted Task pretended to re-materialize: %v", adapter.recorded())
	}
	if got := adapter.runCount(taskScopeFor("req-adopted")); got != 1 {
		t.Fatalf("a released adopted Task executed a substitute turn: %v", adapter.recorded())
	}
	if got := rt.Status().LastError; got != errAdoptedSessionUnavailable.Error() {
		t.Fatalf("the released adopted Task did not fail closed truthfully: %q", got)
	}
}

// TestReclaimIsSkippedWhenTheConversationIsBusy proves the adapter's refusal is
// honored: a scope whose conversation is executing elsewhere is not released,
// and the next candidate is used instead.
func TestReclaimIsSkippedWhenTheConversationIsBusy(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	adapter.mu.Lock()
	adapter.releaseErr = errors.New("ACP prompt is already running for this session")
	adapter.mu.Unlock()

	rt.acceptEvent(taskRequestEvent(100, taskScopeFor("req-overflow"), "req-overflow", "human-1"))
	if got := fixture.capacityResultSummaries(); len(got) != 1 {
		t.Fatalf("a busy conversation was treated as reclaimable: %v", got)
	}
	if fixture.scopeExists(taskScopeFor("req-overflow")) {
		t.Fatal("a refused admission still created scope state")
	}
	if got := fixture.scopeCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("a refused reclaim changed scope state: %d", got)
	}
}

// TestTerminalLifecycleMustMatchTheRoutedTaskScope is the defensive fence: only
// the scope's OWN canonical terminal envelope may make it reclaimable.
func TestTerminalLifecycleMustMatchTheRoutedTaskScope(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	// A terminal envelope routed to task:req-a but correlated to another Task
	// proves nothing about task:req-a.
	mismatched := scopedEvent(1, taskScopeFor("req-a"), "")
	mismatched.Addressed = false
	mismatched.Type = "action"
	mismatched.Participant = types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman}
	mismatched.Collab = &types.WireCollabEvent{
		RequestID: "req-b",
		Kind:      types.CollabComplete,
	}
	rt.acceptEvent(mismatched)
	if got := fixture.terminalScopes(); len(got) != 0 {
		t.Fatalf("a mismatched lifecycle envelope marked a scope terminal: %v", got)
	}

	// The scope's own terminal envelope does.
	matched := scopedEvent(2, taskScopeFor("req-a"), "")
	matched.Addressed = false
	matched.Type = "action"
	matched.Participant = types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman}
	matched.Collab = &types.WireCollabEvent{
		RequestID: "req-a",
		Kind:      types.CollabDeclined,
	}
	rt.acceptEvent(matched)
	if got := fixture.terminalScopes(); !reflect.DeepEqual(got, []string{taskScopeFor("req-a")}) {
		t.Fatalf("the scope's own terminal envelope was ignored: %v", got)
	}
}

// TestTheScopeBoundIsARollingWindowNotALifetimeLimit is the issue's headline
// symptom: a long-lived resident must keep admitting new Tasks forever instead
// of stopping after eight of them.
func TestTheScopeBoundIsARollingWindowNotALifetimeLimit(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)

	const tasks = 3 * types.MaxLogicalTaskScopes
	for index := 0; index < tasks; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
		if got := fixture.scopeCount(); got > types.MaxLogicalTaskScopes {
			t.Fatalf("resident exceeded its logical scope bound after %d Tasks: %d", index+1, got)
		}
	}
	if got := fixture.completedTaskCount(); got != tasks {
		t.Fatalf("not every Task settled: %d of %d", got, tasks)
	}
	if got := fixture.capacityResultSummaries(); len(got) != 0 {
		t.Fatalf("a Task was refused inside the rolling window: %v", got)
	}
	if got := fixture.scopeCount(); got != types.MaxLogicalTaskScopes {
		t.Fatalf("rolling window did not refill: %d", got)
	}
	// The oldest Tasks were given back, the newest are still retained.
	if fixture.scopeExists(taskScopeFor("req-1")) || fixture.scopeExists(taskScopeFor("req-8")) {
		t.Fatal("the rolling window did not give back its oldest terminal scopes")
	}
	if !fixture.scopeExists(taskScopeFor("req-" + itoa(int64(tasks)))) {
		t.Fatal("the newest Task was not retained")
	}
	// BOTH sides of the retained state are bounded: the Runtime remembers one
	// released window, and every conversation that left that window was given
	// back to the adapter instead of accumulating there (#473 blocker 2).
	if got := len(adapter.retainedSnapshot()); got != types.MaxReleasedTaskScopes {
		t.Fatalf("retained conversation identities are not bounded: %d", got)
	}
	if got := fixture.releasedConversationCount(); got != types.MaxReleasedTaskScopes {
		t.Fatalf("the released-scope ledger is not bounded: %d", got)
	}
	released := tasks - types.MaxLogicalTaskScopes
	if got := len(adapter.forgottenSnapshot()); got != released-types.MaxReleasedTaskScopes {
		t.Fatalf("conversations that left the window were not forgotten: %v", adapter.forgottenSnapshot())
	}
	if got := adapter.forgottenSnapshot()[0]; got != taskScopeFor("req-1") {
		t.Fatalf("the oldest released conversation was not forgotten first: %v", adapter.forgottenSnapshot())
	}
	if adapter.hasRetainedScope(taskScopeFor("req-1")) {
		t.Fatal("a forgotten conversation still holds a native identity")
	}
}

// TestRetainedTaskFollowUpNeverTriggersReclamation proves reclamation is lazy:
// pressure comes only from a genuinely NEW Task, so an instruction for a Task
// the resident still retains always continues its own conversation.
func TestRetainedTaskFollowUpNeverTriggersReclamation(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	// A follow-up for the OLDEST retained Task at the bound must not give any
	// scope back: its scope already exists, so no admission is needed.
	rt.acceptEvent(scopedEvent(200, taskScopeFor("req-1"), "follow-up for req-1"))
	rt.drainTurns()
	if got := adapter.releasedSnapshot(); len(got) != 0 {
		t.Fatalf("a retained Task's own follow-up triggered reclamation: %v", got)
	}
	if got := adapter.materializedSnapshot(); len(got) != 0 {
		t.Fatalf("a retained Task re-materialized unnecessarily: %v", got)
	}
	_, details := adapter.scopedRunSnapshot()
	if got := details[taskScopeFor("req-1")]; !reflect.DeepEqual(got, []string{"instruction for req-1", "follow-up for req-1"}) {
		t.Fatalf("the retained Task lost its continuation: %v", got)
	}
}

// TestReclaimedTaskResumesItsConversationWithoutClaimingNew is the #473 review
// blocker: a reclaimed Task whose exact conversation the adapter kept must
// resume THAT conversation. The Runtime keeps the conversation's delivery
// knowledge and session markers across the release, so the resumed turn is not
// reported as a new session and no already-consumed context is replayed.
func TestReclaimedTaskResumesItsConversationWithoutClaimingNew(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt
	scope := taskScopeFor("req-1")

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	// Checkpoints this conversation already consumed must survive the release.
	rt.mu.Lock()
	state := rt.scopedSessions[scope]
	state.meetingDeliveredThrough = 5
	state.meetingDeliveryFloor = 3
	state.liveTranscriptDeliveredThrough = 9
	state.liveTranscriptDeliveryFloor = 7
	delivered := state.deliveredThrough
	rt.mu.Unlock()
	meeting, live := rt.transcriptDeliveryMarkersFor(scope)

	// Capacity pressure gives this Task's slot back, and the adapter keeps its
	// exact conversation.
	fixture.runHumanTask(t, 100, "req-overflow")
	if !adapter.hasRetainedScope(scope) {
		t.Fatalf("the released conversation was not retained: %v", adapter.releasedSnapshot())
	}
	if got := fixture.releasedConversationCount(); got != 1 {
		t.Fatalf("the released conversation was not remembered: %d", got)
	}

	// A context-only Room event plus the Human's follow-up: the resumed turn
	// must carry what this conversation had not consumed yet, and must not be
	// presented as a new session.
	quiet := scopedEvent(150, scope, "context only")
	quiet.Addressed = false
	rt.acceptEvent(quiet)
	rt.acceptEvent(scopedEvent(200, scope, "follow-up for req-1"))
	rt.drainTurns()

	if got := adapter.scopedSessionNewSnapshot(scope); !reflect.DeepEqual(got, []bool{true, false}) {
		t.Fatalf("the resumed conversation was reported as a new session: %v", got)
	}
	if got := adapter.materializedSnapshot(); !reflect.DeepEqual(got, []string{scope}) {
		t.Fatalf("the released conversation was not materialized exactly: %v", got)
	}
	_, details := adapter.scopedRunSnapshot()
	turns := details[scope]
	if len(turns) != 2 || turns[1] != "context only,follow-up for req-1" {
		t.Fatalf("the resumed turn lost the conversation's delivery knowledge: %v", turns)
	}
	rt.mu.Lock()
	resumed := rt.scopedSessions[scope]
	restoredMeeting, restoredLive := resumed.meetingDeliveredThrough, resumed.liveTranscriptDeliveredThrough
	restoredDelivered := resumed.deliveredThrough
	rt.mu.Unlock()
	if restoredMeeting != 5 || restoredLive != 9 || resumed.liveTranscriptDeliveryFloor != 7 {
		t.Fatalf("already-consumed transcript checkpoints restarted: %d/%d", restoredMeeting, restoredLive)
	}
	if restoredDelivered < delivered {
		t.Fatalf("the resumed conversation lost its delivery cursor: %d -> %d", delivered, restoredDelivered)
	}
	if gotMeeting, gotLive := rt.transcriptDeliveryMarkersFor(scope); gotMeeting != meeting || gotLive != live {
		t.Fatalf("transcript markers regressed: %d/%d want %d/%d", gotMeeting, gotLive, meeting, live)
	}
	if fixture.remembersReleasedConversation(scope) {
		t.Fatal("a resumed conversation stayed in the released ledger")
	}
}

// TestReleasedScopeWindowForgetsTheOldestConversation proves the ledger is a
// bounded window with honest edges: the oldest released conversation is
// forgotten (identity included), so a later instruction for it is a new
// session, while a conversation still inside the window resumes exactly.
func TestReleasedScopeWindowForgetsTheOldestConversation(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", releaseRetains: true}
	fixture := newReclaimFixture(t, adapter)
	rt := fixture.rt

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		fixture.runHumanTask(t, int64(index+1), "req-"+itoa(int64(index+1)))
	}
	// One release past the window: req-1 leaves it.
	for index := 0; index <= types.MaxReleasedTaskScopes; index++ {
		fixture.runHumanTask(t, int64(100+index), "req-next-"+itoa(int64(index)))
	}
	if got := fixture.releasedConversationCount(); got != types.MaxReleasedTaskScopes {
		t.Fatalf("released-scope window is not bounded: %d", got)
	}
	if got := adapter.forgottenSnapshot(); !reflect.DeepEqual(got, []string{taskScopeFor("req-1")}) {
		t.Fatalf("the oldest released conversation was not forgotten: %v", got)
	}
	if adapter.hasRetainedScope(taskScopeFor("req-1")) {
		t.Fatal("a forgotten conversation kept its native identity")
	}

	// The forgotten Task's next instruction is an honest new session, and the
	// truthful availability was published for it.
	waitForExecution(t, fixture.client, "req-1", "forgotten conversation availability", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})
	rt.acceptEvent(scopedEvent(400, taskScopeFor("req-1"), "follow-up for req-1"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot(taskScopeFor("req-1")); !reflect.DeepEqual(got, []bool{true, true}) {
		t.Fatalf("a forgotten conversation was resurrected silently: %v", got)
	}
	if got := adapter.materializedSnapshot(); len(got) != 0 {
		t.Fatalf("a forgotten conversation was re-materialized: %v", got)
	}

	// A conversation still inside the window resumes exactly. The newest
	// released Task is used on purpose: admitting any follow-up at the bound
	// releases one more scope, which pushes the OLDEST window entry out.
	// req-next-0 is the newest released conversation: it was given back by the
	// admission that pushed this Task batch to the bound.
	inWindow := taskScopeFor("req-next-0")
	if !fixture.remembersReleasedConversation(inWindow) {
		t.Fatalf("the newest released conversation left the window early: %v", adapter.forgottenSnapshot())
	}
	rt.acceptEvent(scopedEvent(500, inWindow, "follow-up inside the window"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot(inWindow); !reflect.DeepEqual(got, []bool{true, false}) {
		t.Fatalf("an in-window conversation was not resumed: %v", got)
	}
	if got := adapter.materializedSnapshot(); !reflect.DeepEqual(got, []string{inWindow}) {
		t.Fatalf("an in-window conversation did not materialize exactly: %v", got)
	}
	if fixture.remembersReleasedConversation(inWindow) {
		t.Fatal("a resumed in-window conversation stayed in the released ledger")
	}
}

// TestEvictedAdoptedConversationFailsClosedAndNeverStartsFresh pins the edge of
// the bounded window that matters most for the #409 contract: when an adopted
// Task's remembered conversation leaves the window, its exact native identity is
// given back AND the Task is marked lost, so a later instruction can never be
// answered by a substitute conversation.
func TestEvictedAdoptedConversationFailsClosedAndNeverStartsFresh(t *testing.T) {
	fixture := newAdoptionFixture(t, "pi")
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")
	adapter.fakeAdapter.releaseRetains = true
	scope := taskScopeFor("req-adopted")

	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-adopted"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}
	waitForDone(t, startTurn(rt, taskRequestEvent(1, scope, "req-adopted", "human-1")), "adopted Task turn")

	// Untouched scopes fill the live bound, so the adopted Task is the only
	// terminal scope and the next admission has to give its slot back.
	for index := 0; index < types.MaxLogicalTaskScopes-1; index++ {
		rt.acceptEvent(scopedEvent(int64(10+index), taskScopeFor("req-open-"+itoa(int64(index))), "open "+itoa(int64(index))))
	}
	rt.drainTurns()
	rt.acceptEvent(taskRequestEvent(200, taskScopeFor("req-after"), "req-after", "human-1"))
	rt.drainTurns()
	if !releasedScope(adapter.fakeAdapter, scope) {
		t.Fatalf("the adopted Task scope was never reclaimed: %v", adapter.fakeAdapter.releasedSnapshot())
	}

	// Push the adopted conversation out of the released window.
	for round := 0; round <= types.MaxReleasedTaskScopes; round++ {
		requestID := "req-window-" + itoa(int64(round))
		rt.acceptEvent(taskRequestEvent(int64(300+round), taskScopeFor(requestID), requestID, "human-1"))
		rt.drainTurns()
	}
	if adapter.fakeAdapter.hasRetainedScope(scope) {
		t.Fatal("an evicted adopted conversation kept its native identity")
	}
	if !rt.adoptedScopeLost(scope) {
		t.Fatal("an evicted adopted conversation was not marked lost")
	}

	// The next instruction fails closed: no session/new, no substitute turn, and
	// the truthful adopted-session error.
	waitForDone(t, startTurn(rt, scopedEvent(600, scope, "continue the native session")), "continued adopted turn")
	if got := adapter.count("new:" + scope); got != 0 {
		t.Fatalf("an evicted adopted Task started a fresh conversation: %v", adapter.recorded())
	}
	if got := adapter.count("materialize:" + scope); got != 0 {
		t.Fatalf("an evicted adopted Task pretended to re-materialize: %v", adapter.recorded())
	}
	if got := adapter.runCount(scope); got != 1 {
		t.Fatalf("an evicted adopted Task executed a substitute turn: %v", adapter.recorded())
	}
	if got := rt.Status().LastError; got != errAdoptedSessionUnavailable.Error() {
		t.Fatalf("an evicted adopted Task did not fail closed truthfully: %q", got)
	}
}
