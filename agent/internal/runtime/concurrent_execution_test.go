package runtime

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Bounded concurrent Task execution (#421).
 *
 * These tests pin the Runtime's scheduling contract against a scoped Harness
 * double that can genuinely execute several conversations at once:
 *
 *   - independent Tasks run together up to the bounded lane count;
 *   - the fail-safe serial policy keeps the pre-#421 behavior exactly;
 *   - one Task scope never executes two turns at once;
 *   - a Task with no lane is truthfully QUEUED, not apparently hanging;
 *   - an interrupt names one Task and never another;
 *   - one lane's failure does not destroy another lane;
 *   - losing the Room transport does not cancel local execution.
 */

// laneAdapter is a scoped Harness double that can execute several logical
// scopes at the same time. Each scope's turn blocks on its own gate until the
// test releases it, so concurrency is observed rather than timed.
type laneAdapter struct {
	mu            sync.Mutex
	generations   map[string]int64
	running       map[string]bool
	maxConcurrent int
	scopeOrder    []string
	gates         map[string]chan struct{}
	scopedErr     map[string]error
	cancels       []string
	legacyOnly    bool
	failNext      error
}

func newLaneAdapter() *laneAdapter {
	return &laneAdapter{
		generations: make(map[string]int64),
		running:     make(map[string]bool),
		gates:       make(map[string]chan struct{}),
		scopedErr:   make(map[string]error),
	}
}

func (a *laneAdapter) Name() string { return "lane" }
func (a *laneAdapter) Capabilities() *types.HarnessCapabilities {
	return &types.HarnessCapabilities{Text: true}
}
func (a *laneAdapter) EnsureSession() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.generations[roomScope] == 0 {
		a.generations[roomScope] = 1
	}
	return nil
}
func (a *laneAdapter) SessionGeneration() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.generations[roomScope]
}
func (a *laneAdapter) OnFailure(types.AdapterFailureHandler) {}

// Close releases every parked conversation. A test double that could outlive a
// failed assertion would otherwise deadlock Runtime.Stop, which correctly
// waits for in-flight turns to settle.
func (a *laneAdapter) Close() error {
	a.mu.Lock()
	gates := make([]chan struct{}, 0, len(a.gates))
	for _, gate := range a.gates {
		gates = append(gates, gate)
	}
	a.gates = make(map[string]chan struct{})
	a.mu.Unlock()
	for _, gate := range gates {
		close(gate)
	}
	return nil
}
func (a *laneAdapter) RunTurn(types.HarnessTurnInput, int64) (types.HarnessTurnResult, error) {
	return types.HarnessTurnResult{Text: "room-reply"}, nil
}
func (a *laneAdapter) CancelTurn() error {
	a.mu.Lock()
	a.cancels = append(a.cancels, roomScope)
	a.mu.Unlock()
	return nil
}

func (a *laneAdapter) EnsureSessionFor(scope string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.generations[scope] == 0 {
		a.generations[scope] = 1
	}
	return nil
}

func (a *laneAdapter) SessionGenerationFor(scope string) int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.generations[scope]
}

func (a *laneAdapter) RunTurnFor(scope string, _ types.HarnessTurnInput, _ int64) (types.HarnessTurnResult, error) {
	a.mu.Lock()
	if err := a.scopedErr[scope]; err != nil {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, err
	}
	a.running[scope] = true
	a.scopeOrder = append(a.scopeOrder, scope)
	if len(a.running) > a.maxConcurrent {
		a.maxConcurrent = len(a.running)
	}
	gate, ok := a.gates[scope]
	if !ok {
		gate = make(chan struct{})
		a.gates[scope] = gate
	}
	err := a.failNext
	a.failNext = nil
	a.mu.Unlock()

	defer func() {
		a.mu.Lock()
		delete(a.running, scope)
		a.mu.Unlock()
	}()
	<-gate
	if err != nil {
		return types.HarnessTurnResult{}, err
	}
	return types.HarnessTurnResult{Text: "reply-for-" + scope}, nil
}

func (a *laneAdapter) CancelTurnFor(scope string) error {
	a.mu.Lock()
	a.cancels = append(a.cancels, scope)
	a.mu.Unlock()
	return nil
}

// TurnOwnerFor reports the executing scope for a conversation. Every scope of
// this double has its own conversation, so ownership is only ever itself.
func (a *laneAdapter) TurnOwnerFor(string) (string, bool) { return "", false }

// release lets the CURRENT turn of one scope finish. The gate is removed, so a
// later turn of the same scope parks on a fresh one and the test can observe
// each turn separately.
func (a *laneAdapter) release(scope string) {
	a.mu.Lock()
	gate := a.gates[scope]
	delete(a.gates, scope)
	a.mu.Unlock()
	if gate != nil {
		close(gate)
	}
}

func (a *laneAdapter) concurrentPeak() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.maxConcurrent
}

func (a *laneAdapter) runCount(scope string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	count := 0
	for _, recorded := range a.scopeOrder {
		if recorded == scope {
			count++
		}
	}
	return count
}

func (a *laneAdapter) isRunning(scope string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running[scope]
}

func (a *laneAdapter) cancelledScopes() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.cancels...)
}

func (a *laneAdapter) failScope(scope string, err error) {
	a.mu.Lock()
	a.scopedErr[scope] = err
	a.mu.Unlock()
}

func newLaneRuntime(t *testing.T, adapter types.HarnessAdapter, policy types.TaskExecutionPolicy) (*ResidentRuntime, *executionClient) {
	t.Helper()
	client := newExecutionClient()
	rt := NewResidentRuntime(Options{
		InstanceID:    "concurrent-execution",
		RoomID:        "room-concurrent-execution",
		Name:          "Agent",
		Client:        client,
		Adapter:       adapter,
		TaskExecution: policy,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)
	return rt, client
}

func crossSessionPolicy(lanes int) types.TaskExecutionPolicy {
	return types.TaskExecutionPolicy{
		Probe:         types.TaskExecutionProbeVerifiedCrossSession,
		Concurrency:   types.TaskExecutionCrossSession,
		MaxConcurrent: lanes,
	}
}

func waitForRunning(t *testing.T, adapter *laneAdapter, scopes ...string) {
	t.Helper()
	waitFor(t, 3*time.Second, func() bool {
		for _, scope := range scopes {
			if !adapter.isRunning(scope) {
				return false
			}
		}
		return true
	}, "scoped Harness turns to execute")
}

// TestCrossSessionPolicyRunsTwoIndependentTasksTogether is the core #421
// capability: Task B must make progress while unrelated Task A is still
// running.
func TestCrossSessionPolicyRunsTwoIndependentTasksAreTogether(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 30, "task:req-A", "A instruction")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 31, "task:req-B", "B instruction")
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	if peak := adapter.concurrentPeak(); peak != 2 {
		t.Fatalf("two independent Tasks must execute together, peak was %d", peak)
	}
	adapter.release("task:req-A")
	adapter.release("task:req-B")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	waitForScopeSettled(t, rt, adapter, "task:req-B", 1)
}

// TestSerialPolicyKeepsThePreConcurrencyModel proves the fail-safe default:
// an unverified Harness still runs exactly one turn at a time, and the Task
// waiting for capacity reports the truthful QUEUED phase instead of looking
// hung.
func TestSerialPolicyKeepsThePreConcurrencyModel(t *testing.T) {
	adapter := newLaneAdapter()
	rt, client := newLaneRuntime(t, adapter, types.TaskExecutionPolicy{
		Probe:       types.TaskExecutionProbeUnverified,
		Concurrency: types.TaskExecutionSerial,
	})

	startScopedTurn(rt, 40, "task:req-A", "A instruction")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 41, "task:req-B", "B instruction")

	queued := waitForExecution(t, client, "req-B", "queued Task projection", func(p types.TaskExecutionProjection) bool {
		return p.Phase == types.TaskExecutionPhaseQueued
	})
	if queued.CurrentTurnSequence != 0 || queued.QueuedCount != 1 {
		t.Fatalf("a Task with no lane must report queued with a real depth: %+v", queued)
	}
	if adapter.isRunning("task:req-B") {
		t.Fatal("a serial policy must not execute a second Task")
	}
	if peak := adapter.concurrentPeak(); peak != 1 {
		t.Fatalf("a serial policy executed %d turns at once", peak)
	}

	adapter.release("task:req-A")
	waitForRunning(t, adapter, "task:req-B")
	if peak := adapter.concurrentPeak(); peak != 1 {
		t.Fatalf("a serial policy executed %d turns at once", peak)
	}
	adapter.release("task:req-B")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	waitForScopeSettled(t, rt, adapter, "task:req-B", 1)
}

// TestOneScopeNeverExecutesTwoTurnsAtOnce is the per-conversation
// serialization invariant: a follow-up instruction for a Task waits for that
// Task's own turn.
func TestOneScopeNeverExecutesTwoTurnsAtOnce(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 50, "task:req-A", "first")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 51, "task:req-A", "second")

	// The follow-up must NOT start while the first turn of the same Task runs,
	// no matter how many scheduling passes observe it.
	for attempt := 0; attempt < 20; attempt++ {
		rt.launchTurns()
		time.Sleep(2 * time.Millisecond)
	}
	if runs := adapter.runCount("task:req-A"); runs != 1 {
		t.Fatalf("one Task executed %d turns at once", runs)
	}
	if peak := adapter.concurrentPeak(); peak != 1 {
		t.Fatalf("one Task reached %d concurrent turns", peak)
	}

	// Once the first settles, the queued follow-up runs — serially, never
	// beside it.
	adapter.release("task:req-A")
	waitFor(t, 10*time.Second, func() bool { return adapter.runCount("task:req-A") == 2 }, "the follow-up turn to run")
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 2)
	if peak := adapter.concurrentPeak(); peak != 1 {
		t.Fatalf("a follow-up overlapped its predecessor: peak %d", peak)
	}
}

// TestInterruptNamesExactlyOneTask proves #421 interrupt ownership survives
// concurrency: interrupting Task A must never cancel Task B.
func TestInterruptNamesExactlyOneTask(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 60, "task:req-A", "A")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 61, "task:req-B", "B")
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	rt.applyResidentTaskControl(interruptControl("req-A", 60))

	waitFor(t, 3*time.Second, func() bool {
		for _, scope := range adapter.cancelledScopes() {
			if scope == "task:req-A" {
				return true
			}
		}
		return false
	}, "Task A's cancel dispatch")
	for _, scope := range adapter.cancelledScopes() {
		if scope == "task:req-B" {
			t.Fatal("interrupting Task A also cancelled Task B")
		}
	}
	if !adapter.isRunning("task:req-B") {
		t.Fatal("Task B stopped executing when Task A was interrupted")
	}
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	adapter.release("task:req-B")
	waitForScopeSettled(t, rt, adapter, "task:req-B", 1)
}

// TestOneLaneFailureDoesNotDestroyAnotherLane proves failure isolation: a
// failing Task must not take a healthy independent Task down with it.
func TestOneLaneFailureDoesNotDestroyAnotherLane(t *testing.T) {
	adapter := newLaneAdapter()
	rt, client := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 70, "task:req-A", "A")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 71, "task:req-B", "B")
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	// Lane A fails while lane B is still executing.
	adapter.failScope("task:req-A", errors.New("lane A failed"))
	adapter.release("task:req-A")
	waitFor(t, 10*time.Second, func() bool { return !adapter.isRunning("task:req-A") }, "the failing lane to end")
	if !adapter.isRunning("task:req-B") {
		t.Fatal("a lane A failure destroyed the healthy lane B")
	}
	adapter.release("task:req-B")
	waitForScopeSettled(t, rt, adapter, "task:req-B", 1)

	// Task B completed truthfully even though Task A failed in the same pass.
	if _, ok := client.latest("req-B"); !ok {
		t.Fatal("the healthy Task published no execution projection")
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-B"); len(got) != 0 {
		t.Fatalf("the healthy Task's instruction was not acknowledged: %v", got)
	}
}

// TestTransportLossDoesNotCancelLocalExecution is the #421 resumability
// requirement: browser/Room transport presence is not execution ownership.
func TestTransportLossDoesNotCancelLocalExecution(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 80, "task:req-A", "long running")
	waitForRunning(t, adapter, "task:req-A")

	// The resident transport is torn down exactly as a Room/resident socket
	// loss does it: media and presentation state fail closed.
	rt.failClosedResidentMediaState()
	rt.clearActivity()

	if !adapter.isRunning("task:req-A") {
		t.Fatal("losing the Room transport cancelled the local Harness turn")
	}
	if cancels := adapter.cancelledScopes(); len(cancels) != 0 {
		t.Fatalf("a transport loss dispatched a Harness cancel: %v", cancels)
	}
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	if got := rt.pendingAddressedSnapshotFor("task:req-A"); len(got) != 0 {
		t.Fatalf("the surviving turn was not acknowledged: %v", got)
	}
}

// TestReconnectReconciliationRepublishesExecutionState proves a reconnected
// Runtime re-states the CURRENT truth once, instead of the browser polling and
// instead of the Room keeping a deleted projection forever.
func TestReconnectReconciliationRepublishesExecutionState(t *testing.T) {
	adapter := newLaneAdapter()
	rt, client := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 90, "task:req-A", "long running")
	waitForRunning(t, adapter, "task:req-A")
	waitForExecution(t, client, "req-A", "running projection", func(p types.TaskExecutionProjection) bool {
		return p.Phase == types.TaskExecutionPhaseRunning
	})

	before := client.projectionCount()
	rt.republishTaskExecutions()
	waitFor(t, 2*time.Second, func() bool {
		return client.projectionCount() > before
	}, "reconciliation republication")

	latest, ok := client.latest("req-A")
	if !ok || latest.Phase != types.TaskExecutionPhaseRunning || latest.CurrentTurnSequence != 90 {
		t.Fatalf("reconciliation must re-state the running turn: %+v", latest)
	}
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
}

// TestLegacyAdapterKeepsWorkingUnderTheConcurrencyPolicy proves rolling
// compatibility: an adapter that implements only the mandatory HarnessAdapter
// seam is unaffected by the #421 scheduler.
func TestLegacyAdapterKeepsWorkingUnderTheConcurrencyPolicy(t *testing.T) {
	legacy := &legacyOnlyAdapter{}
	rt, _ := newLaneRuntime(t, legacy, crossSessionPolicy(2))

	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	if legacy.runCalls != 1 {
		t.Fatalf("a legacy adapter must still run the default Room turn, got %d", legacy.runCalls)
	}
	if got := rt.pendingAddressedSnapshot(); len(got) != 0 {
		t.Fatalf("a legacy adapter's turn was not acknowledged: %v", got)
	}
}

// TestTurnLaneCountIsClampedToTheProductBound proves no launcher policy can
// widen the bounded lane count past the product ceiling.
func TestTurnLaneCountIsClampedToTheProductBound(t *testing.T) {
	cases := []struct {
		name     string
		policy   types.TaskExecutionPolicy
		override int
		want     int
	}{
		{"zero value is serial", types.TaskExecutionPolicy{}, 0, 1},
		{"serial ignores max", types.TaskExecutionPolicy{Concurrency: types.TaskExecutionSerial, MaxConcurrent: 8}, 0, 1},
		{"cross session without a bound is one", types.TaskExecutionPolicy{Concurrency: types.TaskExecutionCrossSession}, 0, 1},
		{"cross session uses its bound", crossSessionPolicy(2), 0, 2},
		{"over the ceiling is clamped", types.TaskExecutionPolicy{Concurrency: types.TaskExecutionCrossSession, MaxConcurrent: 64}, 0, MaxTurnLanes},
		{"probe override is clamped too", crossSessionPolicy(2), 4, MaxTurnLanes},
		{"override of one keeps it serial", crossSessionPolicy(2), 1, 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := resolveTurnLanes(testCase.policy, testCase.override); got != testCase.want {
				t.Fatalf("resolveTurnLanes(%+v, %d) = %d, want %d", testCase.policy, testCase.override, got, testCase.want)
			}
		})
	}
}

// startScopedTurn admits one addressed instruction for a Task scope and runs
// the bounded scheduler ONCE, without waiting for quiescence.
//
// Waiting for quiescence would be wrong here: a settling turn legitimately
// refills its freed lane, so a blocking drain can absorb later work and make a
// test observe the wrong moment. These tests therefore assert on observed
// Harness execution instead.
func startScopedTurn(rt *ResidentRuntime, sequence int64, scope, text string) {
	rt.acceptEvent(scopedEvent(sequence, scope, text))
	rt.launchTurns()
}

// waitForScopeSettled waits until ONE scope has executed wantRuns turns and is
// no longer executing. It deliberately does not require the whole Runtime to be
// idle: with several lanes an independent Task is expected to still be running.
func waitForScopeSettled(t *testing.T, rt *ResidentRuntime, adapter *laneAdapter, scope string, wantRuns int) {
	t.Helper()
	waitFor(t, 10*time.Second, func() bool {
		return adapter.runCount(scope) >= wantRuns && !adapter.isRunning(scope)
	}, "the scoped Harness turn to settle")
}

// TestAdoptedSessionContinuationUnderCrossSessionConcurrency re-pins the #420
// contract under the #421 execution model: an adopted Task still loads its
// exact native conversation and issues ZERO session/new, even while an
// unrelated Task executes at the same time on another lane.
func TestAdoptedSessionContinuationUnderCrossSessionConcurrency(t *testing.T) {
	fixture := newDiscoveryFixtureWithPolicy(t, "", crossSessionPolicy(2))
	rt, adapter := fixture.rt, fixture.adapter
	setRoster(rt, "human-1")

	// The Human selected a local session for Task B (#420 preparation).
	if err := rt.ArmPreparedSessionAdoption("native-pi-1", "/workspace", "human-1", "req-B"); err != nil {
		t.Fatalf("arm prepared adoption: %v", err)
	}

	// Task A occupies one lane and stays blocked inside its Harness turn. The
	// gate is always released, so a failed assertion can never leave the
	// Runtime's Stop waiting on an in-flight turn.
	gate := fixture.holdNextScopedTurn()
	var gateOnce sync.Once
	openGate := func() { gateOnce.Do(func() { close(gate) }) }
	defer openGate()
	startScopedTurn(rt, 1, "task:req-A", "A instruction")
	waitForActiveScope(t, rt, "task:req-A")

	// Task B's canonical trigger is accepted and must make progress on the
	// second lane while A is still running.
	rt.acceptEvent(taskRequestEvent(2, "task:req-B", "req-B", "human-1"))
	if snap := rt.pendingAdoptionSnapshot(); snap == nil || !snap.claimed {
		t.Fatalf("Task B's accepted trigger did not claim its preparation: %+v", snap)
	}
	rt.launchTurns()
	waitFor(t, 3*time.Second, func() bool {
		return adapter.runCount("task:req-B") == 1
	}, "the adopted Task to execute on its own lane")
	if !rt.scopeRunning("task:req-A") {
		t.Fatal("the unrelated Task stopped running when the adopted Task started")
	}

	openGate()
	waitFor(t, 5*time.Second, func() bool {
		return adapter.runCount("task:req-A") == 1 && !rt.scopeRunning("task:req-A")
	}, "Task A to settle")

	// #420 invariants, unchanged by concurrency:
	loads := adapter.loadCalls()
	if len(loads) != 1 || loads[0].scope != "task:req-B" {
		t.Fatalf("the adopted Task must load its exact native session once: %+v", loads)
	}
	if loads[0].sessionID != "native-pi-1" {
		t.Fatalf("the adopted Task loaded the wrong native session: %+v", loads[0])
	}
	// ZERO session/new for the adopted scope: its first turn continues an
	// existing conversation and must never present as a new one.
	adapter.fakeAdapter.mu.Lock()
	news := append([]bool(nil), adapter.fakeAdapter.scopedSessionNews["task:req-B"]...)
	adapter.fakeAdapter.mu.Unlock()
	if len(news) == 0 {
		t.Fatal("the adopted Task never rendered a turn")
	}
	for index, isNew := range news {
		if isNew {
			t.Fatalf("the adopted Task rendered turn %d as a NEW session", index)
		}
	}
	// The adopted scope's OWN record must be exactly one load plus its turns:
	// never a "new:" entry. The unrelated Task A is expected to create its own
	// fresh conversation, which is not this Task's business.
	var adopted []string
	for _, event := range adapter.recorded() {
		if strings.HasSuffix(event, ":task:req-B") {
			adopted = append(adopted, event)
		}
	}
	if len(adopted) != 2 || adopted[0] != "load:task:req-B" || adopted[1] != "run:task:req-B" {
		t.Fatalf("the adopted Task did not continue its exact native session: %v", adopted)
	}
}

// countingActivityClient records every transient publication a Runtime makes,
// so the #421 traffic claim ("a long Task is economically boring") is measured
// rather than asserted.
type countingActivityClient struct {
	*fakeClient
	mu         sync.Mutex
	activities []types.AgentActivityState
	executions int
}

func (c *countingActivityClient) UpdateAgentActivity(_ string, _ string, state types.AgentActivityState, _ int64) error {
	c.mu.Lock()
	c.activities = append(c.activities, state)
	c.mu.Unlock()
	return nil
}

func (c *countingActivityClient) UpdateTaskExecution(string, types.TaskExecutionProjection) error {
	c.mu.Lock()
	c.executions++
	c.mu.Unlock()
	return nil
}

func (c *countingActivityClient) counts() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.activities), c.executions
}

// TestLongRunningTaskPublishesOnlyMeaningfulStateChanges is the #421 cost
// fence: a Task that is simply WORKING must not generate a stream of Room
// state. Nothing here animates a spinner; there is no periodic publication at
// all, so a multi-hour Task costs the same tiny number of updates as a short
// one.
func TestLongRunningTaskPublishesOnlyMeaningfulStateChanges(t *testing.T) {
	adapter := newLaneAdapter()
	client := &countingActivityClient{fakeClient: &fakeClient{}}
	rt := NewResidentRuntime(Options{
		InstanceID:    "publication-cost",
		RoomID:        "room-publication-cost",
		Name:          "Agent",
		Client:        client,
		Adapter:       adapter,
		TaskExecution: crossSessionPolicy(2),
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)

	startScopedTurn(rt, 1, "task:req-A", "long instruction")
	waitForRunning(t, adapter, "task:req-A")

	// The Task stays in exactly one state for a long time. Nothing changes, so
	// nothing may be published: sampling well past the settle window must not
	// grow the counters.
	_, executionsAtStart := client.counts()
	time.Sleep(300 * time.Millisecond)
	_, executionsLater := client.counts()
	if executionsLater != executionsAtStart {
		t.Fatalf("a Task with no state change published %d extra updates", executionsLater-executionsAtStart)
	}

	// Letting it settle is the ONE further transition, and it is bounded.
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	activities, executions := client.counts()
	if executions > 4 {
		t.Fatalf("one Task turn published %d execution updates; expected a handful", executions)
	}
	if activities > 4 {
		t.Fatalf("one Task turn published %d activity updates; expected a handful", activities)
	}
}

// TestLongTaskNeverStarvesIndependentTasks is the #421 fairness property: a
// long-lived Task occupies ONE lane, so other Tasks keep making progress
// beside it and a queued Task is picked up as soon as a lane frees — without
// waiting for the long Task to finish.
func TestLongTaskNeverStarvesIndependentTasks(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	// Task A is the long one and never finishes during this test.
	startScopedTurn(rt, 1, "task:req-long", "long running")
	waitForRunning(t, adapter, "task:req-long")

	// Task B takes the second lane and finishes quickly.
	startScopedTurn(rt, 2, "task:req-short", "short work")
	waitForRunning(t, adapter, "task:req-long", "task:req-short")
	adapter.release("task:req-short")
	waitForScopeSettled(t, rt, adapter, "task:req-short", 1)

	// Task C was queued while both lanes were busy. It must now run on the
	// lane B freed, while the long Task is STILL executing.
	startScopedTurn(rt, 3, "task:req-third", "third work")
	waitForRunning(t, adapter, "task:req-third")
	if !adapter.isRunning("task:req-long") {
		t.Fatal("the long Task was disturbed by an independent Task")
	}
	adapter.release("task:req-third")
	waitForScopeSettled(t, rt, adapter, "task:req-third", 1)
	if !adapter.isRunning("task:req-long") {
		t.Fatal("the long Task stopped before it settled")
	}
	adapter.release("task:req-long")
	waitForScopeSettled(t, rt, adapter, "task:req-long", 1)
}

// TestInterruptAndSendIsolatesTheReplacementToItsOwnTask proves the #421
// combination: interrupting Task A and queueing its replacement must run that
// replacement exactly once, and must leave Task B's execution untouched.
func TestInterruptAndSendIsolatesTheReplacementToItsOwnTask(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	startScopedTurn(rt, 40, "task:req-A", "A first")
	waitForRunning(t, adapter, "task:req-A")
	startScopedTurn(rt, 41, "task:req-B", "B only")
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	// The Human interrupts A and immediately sends the replacement.
	rt.applyResidentTaskControl(interruptControl("req-A", 40))
	waitFor(t, 3*time.Second, func() bool {
		for _, scope := range adapter.cancelledScopes() {
			if scope == "task:req-A" {
				return true
			}
		}
		return false
	}, "Task A's interrupt dispatch")

	// The cancelled turn settles and its replacement is queued.
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
	startScopedTurn(rt, 42, "task:req-A", "A replacement")
	waitFor(t, 5*time.Second, func() bool { return adapter.runCount("task:req-A") == 2 }, "the replacement turn")
	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 2)

	// Task B never saw a cancel and never re-ran.
	for _, scope := range adapter.cancelledScopes() {
		if scope == "task:req-B" {
			t.Fatal("interrupting Task A cancelled Task B")
		}
	}
	if runs := adapter.runCount("task:req-B"); runs != 1 {
		t.Fatalf("Task B ran %d times; its work must be untouched", runs)
	}
	if !adapter.isRunning("task:req-B") {
		t.Fatal("Task B stopped while Task A was replaced")
	}
	adapter.release("task:req-B")
	waitForScopeSettled(t, rt, adapter, "task:req-B", 1)
}

// TestExecutionContextResyncRepublishesWithoutTouchingSessionControl is the
// Runtime half of the DO-hibernation recovery (#421).
//
// The Room's transient execution projections are memory-only, so after a
// hibernation a returning Human sees nothing even though this Runtime never
// reconnected and the local Harness kept working. The Room therefore sends ONE
// fire-and-forget `task-execution-resync` frame, and the Runtime answers it by
// re-stating the CURRENT execution truth of every Task scope it owns.
//
// The frame is a separate family from #409/#420 session control: it holds no
// correlation, consumes none, and leaves a live pending session control
// strictly alone.
func TestExecutionContextResyncRepublishesWithoutTouchingSessionControl(t *testing.T) {
	adapter := newLaneAdapter()
	client := newExecutionClient()
	rt := NewResidentRuntime(Options{
		InstanceID:    "execution-resync",
		RoomID:        "room-execution-resync",
		Name:          "Agent",
		Client:        client,
		Adapter:       adapter,
		TaskExecution: crossSessionPolicy(2),
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	t.Cleanup(rt.Stop)

	startScopedTurn(rt, 1, "task:req-A", "long running")
	waitForRunning(t, adapter, "task:req-A")
	waitForExecution(t, client, "req-A", "running projection", func(p types.TaskExecutionProjection) bool {
		return p.Phase == types.TaskExecutionPhaseRunning
	})

	// Hold a live #420 discovery correlation, exactly as a Human browsing
	// sessions would while a Task keeps running.
	rt.mu.Lock()
	rt.sessionControlBusy = true
	pending := []harness.ACPSessionInfo{{SessionID: "native-pi-1", Cwd: "/workspace"}}
	rt.taskSessionPages["page-live"] = taskSessionPage{
		pending: pending,
		human:   "human-1",
		expires: time.Now().Add(time.Minute).UnixMilli(),
	}
	rt.mu.Unlock()

	before := client.projectionCount()
	// The Room's fire-and-forget trigger.
	if outcome, _ := rt.applyResidentFrame(nil, types.WaitResult{TaskExecutionResync: true}, nil); !isAppliedResidentFrame(outcome) {
		t.Fatalf("the resync frame was not applied: %v", outcome)
	}
	waitFor(t, 3*time.Second, func() bool {
		return client.projectionCount() > before
	}, "the runtime to re-state its execution truth")

	latest, ok := client.latest("req-A")
	if !ok || latest.Phase != types.TaskExecutionPhaseRunning || latest.CurrentTurnSequence != 1 {
		t.Fatalf("reconciliation must re-state the running turn: %+v", latest)
	}

	// The #420 correlation is untouched: the frame carries no request id and
	// can neither consume nor overwrite one.
	rt.mu.Lock()
	busy := rt.sessionControlBusy
	page, pageLive := rt.taskSessionPages["page-live"]
	rt.mu.Unlock()
	if !busy {
		t.Fatal("the reconciliation trigger cleared a live session-control correlation")
	}
	if !pageLive || page.human != "human-1" || len(page.pending) != 1 {
		t.Fatalf("the reconciliation trigger disturbed the session page cache: %+v", page)
	}

	adapter.release("task:req-A")
	waitForScopeSettled(t, rt, adapter, "task:req-A", 1)
}

// TestRuntimeAdvertisesExecutionContextReconciliation proves the additive
// feature a new Room needs before it may send the private trigger. Without it a
// Room must send nothing, because agent-v0.5.34 would receive an unknown frame.
func TestRuntimeAdvertisesExecutionContextReconciliation(t *testing.T) {
	rt := NewResidentRuntime(Options{
		InstanceID: "feature-projection",
		RoomID:     "room-feature-projection",
		Name:       "Agent",
		Client:     &fakeClient{},
		Adapter:    &legacyOnlyAdapter{},
	})
	t.Cleanup(rt.Stop)

	features := rt.CurrentRuntimeFeatures()
	if features == nil {
		t.Fatal("a Runtime must advertise its execution reconciliation support")
	}
	if !features.TaskExecutionReconciliation {
		t.Fatalf("execution reconciliation was not advertised: %+v", features)
	}
	// The #420 feature is independent and follows the launcher policy, which is
	// disabled here: advertising reconciliation must not imply continuation.
	if features.TaskSessionContinuation {
		t.Fatalf("reconciliation must not fabricate Task Session Continuation: %+v", features)
	}
	if features.Empty() {
		t.Fatal("a projection with a true feature must not report empty")
	}
}

// isAppliedResidentFrame reports whether one frame outcome reached the Runtime.
func isAppliedResidentFrame(outcome residentFrameOutcome) bool {
	return outcome == residentFrameApplied
}
