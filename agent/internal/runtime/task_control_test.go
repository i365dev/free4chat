package runtime

import (
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task-scoped remote interrupt (#409): the Runtime cancels a Harness turn
 * only when its own serialized admission currently records exactly that Task
 * scope as the active turn. A stale, duplicated, wrong-Task, or turn-less
 * control is a local no-op and is never retained for a later turn.
 */

// interruptAdapter wraps the shared fake adapter with an observable cancel
// counter. CancelTurn also releases the blocked turn, which models the real
// contract: cancelling the turn the Runtime owns is what ends that turn.
//
// Scoped Harness turns in the shared fake never block on turnWait, so this
// adapter parks them in the scoped run hook instead: the turn is genuinely
// in flight (after the Runtime's admission boundary) until the gate opens.
type interruptAdapter struct {
	*fakeAdapter
	cancelMu sync.Mutex
	cancels  int
	gateMu   sync.Mutex
	// gates is a queue of per-turn barriers: a test can arm the successor's
	// barrier before releasing the current turn, so both turns are
	// deterministically observable.
	gates   []chan struct{}
	current chan struct{}
	// Optional barriers for the deterministic TOCTOU test: CancelTurn reports
	// entry and then blocks until released.
	cancelEntered chan struct{}
	cancelRelease chan struct{}
	// holdTurn keeps a parked Harness turn parked even after CancelTurn
	// returns, so a test can observe the post-dispatch phase deterministically.
	holdTurn chan struct{}
	// turnFinished signals that a parked Harness turn body returned.
	turnFinished chan struct{}
	// cancelIgnored makes the yield request a no-op the Harness accepts and
	// ignores; cancelErr makes the request itself fail (#484 weak-cancel tests).
	cancelIgnored bool
	cancelErr     error
}

// holdTurns parks the NEXT turn body until the returned channel is closed, so a
// test can observe state that exists only while the turn is still active. It is
// the locked counterpart of assigning holdTurn directly.
// releaseAllTurns unblocks every parked turn this double is holding, so a test
// that fails before releasing its gates still tears down promptly instead of
// deadlocking ResidentRuntime.Stop on a parked turn. Double closes are ignored:
// a test that already released a gate must not turn cleanup into a panic.
func (a *interruptAdapter) releaseAllTurns() {
	a.gateMu.Lock()
	open := make([]chan struct{}, 0, 2+len(a.gates))
	if a.current != nil {
		open = append(open, a.current)
		a.current = nil
	}
	open = append(open, a.gates...)
	a.gates = nil
	if a.holdTurn != nil {
		open = append(open, a.holdTurn)
		a.holdTurn = nil
	}
	a.gateMu.Unlock()
	for _, gate := range open {
		closeGateIgnoringDoubleClose(gate)
	}
}

func closeGateIgnoringDoubleClose(gate chan struct{}) {
	defer func() { _ = recover() }()
	close(gate)
}

func (a *interruptAdapter) holdTurns() chan struct{} {
	hold := make(chan struct{})
	a.gateMu.Lock()
	a.holdTurn = hold
	a.gateMu.Unlock()
	return hold
}

func (a *interruptAdapter) ignoreCancel() {
	a.cancelMu.Lock()
	a.cancelIgnored = true
	a.cancelMu.Unlock()
}

func (a *interruptAdapter) failCancel(err error) {
	a.cancelMu.Lock()
	a.cancelErr = err
	a.cancelMu.Unlock()
}

func newInterruptAdapter() *interruptAdapter {
	adapter := &interruptAdapter{fakeAdapter: &fakeAdapter{name: "pi"}}
	adapter.fakeAdapter.scopedRunHook = func(string) { adapter.waitTurn() }
	adapter.blockNextTurn()
	return adapter
}

func (a *interruptAdapter) CancelTurn() error {
	a.cancelMu.Lock()
	a.cancels++
	ignored := a.cancelIgnored
	cancelErr := a.cancelErr
	a.cancelMu.Unlock()
	if cancelErr != nil {
		return cancelErr
	}
	if ignored {
		// The Harness accepted the yield request and ignored it: the turn stays
		// parked until the test settles it.
		return nil
	}
	if a.cancelEntered != nil {
		a.cancelEntered <- struct{}{}
	}
	if a.cancelRelease != nil {
		<-a.cancelRelease
	}
	a.releaseTurn()
	return nil
}

func (a *interruptAdapter) cancelCount() int {
	a.cancelMu.Lock()
	defer a.cancelMu.Unlock()
	return a.cancels
}

// blockNextTurn arms a fresh barrier so the next Harness turn parks until
// CancelTurn (or the test) releases it.
func (a *interruptAdapter) blockNextTurn() {
	gate := make(chan struct{})
	a.gateMu.Lock()
	a.gates = append(a.gates, gate)
	a.gateMu.Unlock()
}

func (a *interruptAdapter) waitTurn() {
	a.gateMu.Lock()
	if len(a.gates) > 0 {
		a.current = a.gates[0]
		a.gates = a.gates[1:]
	}
	gate := a.current
	hold := a.holdTurn
	a.gateMu.Unlock()
	if gate != nil {
		<-gate
	}
	if hold != nil {
		<-hold
	}
	if a.turnFinished != nil {
		select {
		case a.turnFinished <- struct{}{}:
		default:
		}
	}
}

// releaseTurn releases the CURRENT parked turn, or the oldest barrier that has
// not been taken yet. Gates armed for a successor stay armed.
func (a *interruptAdapter) releaseTurn() {
	a.gateMu.Lock()
	gate := a.current
	a.current = nil
	if gate == nil && len(a.gates) > 0 {
		gate = a.gates[0]
		a.gates = a.gates[1:]
	}
	a.gateMu.Unlock()
	if gate == nil {
		return
	}
	select {
	case <-gate:
	default:
		close(gate)
	}
}

// runCount reports how many Harness turns ran for one scope.
func (a *interruptAdapter) runCount(scope string) int {
	_, details := a.scopedRunSnapshot()
	return len(details[scope])
}

func newTaskInterruptRuntime() (*ResidentRuntime, *interruptAdapter) {
	adapter := newInterruptAdapter()
	rt := NewResidentRuntime(Options{
		InstanceID: "task-interrupt",
		RoomID:     "room-task-interrupt",
		Name:       "Agent",
		Client:     &fakeClient{},
		Adapter:    adapter,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	return rt, adapter
}

// startTurn admits one event and runs the serial drain in the background, so
// the test can observe and act on the turn while it is still running.
func startTurn(rt *ResidentRuntime, event types.RoomEvent) chan struct{} {
	done := make(chan struct{})
	rt.acceptEvent(event)
	go func() {
		rt.drainTurns()
		close(done)
	}()
	return done
}

func waitForDone(t *testing.T, done chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("timeout waiting for %s", message)
	}
}

func waitForActiveScope(t *testing.T, rt *ResidentRuntime, scope string) {
	t.Helper()
	waitFor(t, 2*time.Second, func() bool {
		rt.activityMu.Lock()
		defer rt.activityMu.Unlock()
		_, active := rt.activities[scope]
		return active
	}, "active Runtime turn for "+scope)
}

// activeScope returns the ONE scope with an executing turn. It is empty when
// none or more than one exists: a multi-lane resident has no single active
// scope, and a test that assumed otherwise would be asserting the pre-#421
// serial model.
func activeScope(rt *ResidentRuntime) string {
	rt.activityMu.Lock()
	defer rt.activityMu.Unlock()
	if len(rt.activities) != 1 {
		return ""
	}
	for scope := range rt.activities {
		return scope
	}
	return ""
}

// activeTurnSequence reports the canonical turn the given scope executes now.
func activeTurnSequence(rt *ResidentRuntime, scope string) int64 {
	rt.activityMu.Lock()
	defer rt.activityMu.Unlock()
	return rt.activities[scope].sequence
}

func interruptControl(taskRequestID string, turnSequence int64) *types.ResidentTaskControl {
	return &types.ResidentTaskControl{
		Kind:          types.ResidentTaskControlInterrupt,
		TaskRequestID: taskRequestID,
		TurnSequence:  turnSequence,
	}
}

func TestTaskInterruptCancelsTheOwnedTaskTurnAndKeepsTheTaskUsable(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(1, "task:req-T", "start a long task"))
	waitForActiveScope(t, rt, "task:req-T")
	generation := adapter.scopedGenerationSnapshot("task:req-T")

	rt.applyResidentTaskControl(interruptControl("req-T", 1))

	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("matching interrupt must cancel exactly once, got %d", got)
	}
	waitForDone(t, drained, "cancelled turn to unwind")
	// The cancelled turn settles; the retained Task scope survives and the
	// same Task can run another turn afterwards.
	if got := activeScope(rt); got != "" {
		t.Fatalf("a cancelled turn must not stay active: %q", got)
	}
	if got := adapter.scopedGenerationSnapshot("task:req-T"); got != generation || got == 0 {
		t.Fatalf("interrupt must not recreate the retained Task session: %d -> %d", generation, got)
	}
	adapter.blockNextTurn()
	followUp := startTurn(rt, scopedEvent(2, "task:req-T", "continue the same task"))
	waitFor(t, 2*time.Second, func() bool { return adapter.runCount("task:req-T") >= 2 }, "follow-up turn in the same Task")
	adapter.releaseTurn()
	waitForDone(t, followUp, "follow-up turn to finish")
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the follow-up turn must not be cancelled by the earlier interrupt: %d", got)
	}
}

func TestTaskInterruptCanSettleAndRecoverTwiceInTheSameTask(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	for _, turn := range []struct {
		sequence int64
		text     string
	}{
		{1, "first long turn"},
		{2, "second long turn"},
	} {
		// The adapter arms the first turn at construction. Every successor needs
		// its own gate so the exact interrupt sees an in-flight Runtime turn.
		if turn.sequence > 1 {
			adapter.blockNextTurn()
		}
		drained := startTurn(rt, scopedEvent(turn.sequence, "task:req-T", turn.text))
		waitForActiveScope(t, rt, "task:req-T")
		rt.applyResidentTaskControl(interruptControl("req-T", turn.sequence))
		waitForDone(t, drained, "interrupted turn to settle")
		if got := activeScope(rt); got != "" {
			t.Fatalf("turn %d remained active after its interrupt: %q", turn.sequence, got)
		}
	}

	if got := adapter.cancelCount(); got != 2 {
		t.Fatalf("two exact interrupts must dispatch two cancels, got %d", got)
	}
	adapter.blockNextTurn()
	followUp := startTurn(rt, scopedEvent(3, "task:req-T", "follow-up after two interrupts"))
	waitForActiveScope(t, rt, "task:req-T")
	if got := adapter.runCount("task:req-T"); got != 3 {
		t.Fatalf("follow-up must run exactly once after two recoveries, got %d runs", got)
	}
	adapter.releaseTurn()
	waitForDone(t, followUp, "follow-up after repeated interrupts")
}

func TestTaskInterruptIgnoresANonMatchingTask(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(1, "task:req-U", "working on U"))
	waitForActiveScope(t, rt, "task:req-U")

	rt.applyResidentTaskControl(interruptControl("req-T", 1))

	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("an interrupt for another Task must not cancel: %d", got)
	}
	if got := activeScope(rt); got != "task:req-U" {
		t.Fatalf("a non-matching interrupt disturbed the running turn: %q", got)
	}
	adapter.releaseTurn()
	waitForDone(t, drained, "unrelated turn to finish")
}

func TestTaskInterruptWithoutAnActiveTurnIsANoOp(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	rt.applyResidentTaskControl(interruptControl("req-T", 1))

	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("an interrupt without an active turn must be a no-op: %d", got)
	}
	if got := adapter.runCount("task:req-T"); got != 0 {
		t.Fatalf("an interrupt must never create a turn: %d", got)
	}
}

// TestTaskInterruptIsEdgeTriggeredNotAPendingIntent is the safety property
// that matters most: a duplicated or late click must never cancel a future
// turn that happens to reuse the same Task scope.
func TestTaskInterruptIsEdgeTriggeredNotAPendingIntent(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	first := startTurn(rt, scopedEvent(1, "task:req-T", "first turn"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.applyResidentTaskControl(interruptControl("req-T", 1))
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("first interrupt must cancel once, got %d", got)
	}
	waitForDone(t, first, "first turn to unwind")

	// Duplicate/late: the same Task still exists, but it owns no turn right
	// now, so these controls are local no-ops and are never retained.
	rt.applyResidentTaskControl(interruptControl("req-T", 1))
	rt.applyResidentTaskControl(interruptControl("req-T", 1))
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("duplicate interrupts must not cancel again, got %d", got)
	}

	// The decisive check: a new turn for the same Task starts afterwards and
	// must run untouched, proving no stale click was queued as intent.
	adapter.blockNextTurn()
	second := startTurn(rt, scopedEvent(2, "task:req-T", "next turn after a stale click"))
	waitForActiveScope(t, rt, "task:req-T")
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("a stale interrupt must not cancel a later turn in the same Task, got %d", got)
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("a stale interrupt disturbed the later turn: %q", got)
	}
	adapter.releaseTurn()
	waitForDone(t, second, "second turn to finish")
}

func TestTaskInterruptRejectsUnusableCorrelationIDs(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(1, "task:req-T", "active turn"))
	waitForActiveScope(t, rt, "task:req-T")

	for _, control := range []*types.ResidentTaskControl{
		nil,
		{Kind: types.ResidentTaskControlInterrupt},
		{Kind: types.ResidentTaskControlInterrupt, TaskRequestID: " req-T ", TurnSequence: 1},
		{Kind: types.ResidentTaskControlInterrupt, TaskRequestID: "req-T\u0000", TurnSequence: 1},
		{Kind: types.ResidentTaskControlKind("steer"), TaskRequestID: "req-T", TurnSequence: 1},
		// #409 exact-turn identity: a control without a positive, safe turn
		// sequence may not widen into "any turn of this Task".
		{Kind: types.ResidentTaskControlInterrupt, TaskRequestID: "req-T"},
		{Kind: types.ResidentTaskControlInterrupt, TaskRequestID: "req-T", TurnSequence: -1},
		{Kind: types.ResidentTaskControlInterrupt, TaskRequestID: "req-T", TurnSequence: types.MaxResidentTurnSequence + 1},
	} {
		rt.applyResidentTaskControl(control)
	}
	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("unusable controls must not cancel anything, got %d", got)
	}
	adapter.releaseTurn()
	waitForDone(t, drained, "unrelated active turn to finish")
}

// buildTaskInterruptFakeLauncher builds the scripted ACP child in its
// "hold the turn until session/cancel arrives" mode.
func buildTaskInterruptFakeLauncher(t *testing.T) types.AgentLauncher {
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
		Environment: map[string]string{"FAKE_MODE": "cancel"},
	}
}

// TestTaskInterruptCancelsARealACPTurn is the deterministic end-to-end proof
// of the product claim without a real model: a REAL ACP adapter turn is held
// open by the scripted child, and the private resident control is what ends it
// through the existing CancelTurn seam. The Task scope and its retained
// session survive, so the Task stays usable afterwards.
func TestTaskInterruptCancelsARealACPTurn(t *testing.T) {
	launcher := buildTaskInterruptFakeLauncher(t)
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	adapter := harness.NewACPAdapter(launcher, t.TempDir(), harness.AdapterOptions{
		TurnTimeoutMs: 10_000, CancelGraceMs: 100,
	})
	settled := make(chan string, 1)
	client.fakeClient.sendHook = func(text string) { settled <- text }
	rt := NewResidentRuntime(Options{
		InstanceID: "task-interrupt-acp",
		RoomID:     "room-task-interrupt-acp",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream open")

	const taskID = "req-T-0001"
	stream.results <- types.WaitResult{
		Events: []types.RoomEvent{
			scopedEvent(1, "task:"+taskID, "cancel-test: hold this turn"),
		},
		Cursor:     1,
		ExpiresAt:  time.Now().Add(time.Hour).UnixMilli(),
		MediaState: &types.ResidentMediaState{MediaAvailable: true},
	}
	waitForActiveScope(t, rt, "task:"+taskID)

	// The Human clicks Interrupt: the Room's private control frame arrives
	// while the real ACP turn is still parked on its prompt. Only a real
	// session/cancel makes the scripted child return, so a settled turn is the
	// proof that the exact dispatch reached the Harness.
	stream.results <- types.WaitResult{TaskControl: interruptControl(taskID, 1)}
	waitForResidentTurnToSettle(t, rt)
	if got := activeScope(rt); got != "" {
		t.Fatalf("cancelled ACP turn stayed active: %q", got)
	}
	// A cancelled turn's tail text is never published as an Agent reply.
	select {
	case text := <-settled:
		t.Fatalf("a cancelled turn's output must be suppressed, got %q", text)
	default:
	}
	// The intentionally interrupted trigger is consumed, not retried.
	if scope, target, ok := rt.nextRunnableTurn(); ok {
		t.Fatalf("an interrupted trigger stayed pending: %s/%d", scope, target)
	}
	rt.taskExecutionMu.Lock()
	outcome := rt.taskExecutionFacts["task:"+taskID].lastOutcome
	rt.taskExecutionMu.Unlock()
	if outcome != types.TaskExecutionOutcomeInterrupted {
		t.Fatalf("intentional settlement was not recorded: %q", outcome)
	}
	// The Task itself remains open: its retained ACP session is still there,
	// so the interrupt neither deleted the Task nor recreated a conversation.
	if generation := adapter.SessionGenerationFor("task:" + taskID); generation == 0 {
		t.Fatal("interrupt discarded the retained Task harness session")
	}
}

// TestResidentTaskControlInterruptsThroughThePrivateStream proves the frame
// reaches the authority boundary through the resident envelope path while the
// owning turn is still running, and that a control is not a Room event: it
// advances no cursor and creates no turn.
func TestResidentTaskControlInterruptsThroughThePrivateStream(t *testing.T) {
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	adapter := newInterruptAdapter()
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-task-interrupt",
		RoomID:     "room-resident-task-interrupt",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream open")

	stream.results <- types.WaitResult{
		Events:     []types.RoomEvent{scopedEvent(1, "task:req-T", "long resident turn")},
		Cursor:     1,
		ExpiresAt:  time.Now().Add(time.Hour).UnixMilli(),
		MediaState: &types.ResidentMediaState{MediaAvailable: true},
	}
	waitForActiveScope(t, rt, "task:req-T")
	cursorBefore := rt.currentCursor()

	stream.results <- types.WaitResult{TaskControl: interruptControl("req-T", 1)}
	waitFor(t, 2*time.Second, func() bool { return adapter.cancelCount() == 1 }, "interrupt delivered through the resident stream")

	if got := rt.currentCursor(); got != cursorBefore {
		t.Fatalf("a task control must not advance the Room cursor: %d -> %d", cursorBefore, got)
	}
	if got := adapter.runCount("task:req-T"); got != 1 {
		t.Fatalf("a task control must not create a turn: %d", got)
	}
}

// TestTaskInterruptForAPreviousTurnNeverCancelsTheNextTurn is the decisive
// exact-turn test: a control that names the PREVIOUS turn of the same Task
// must not cancel the turn that is running now, even though the Task scope
// matches exactly.
func TestTaskInterruptForAPreviousTurnNeverCancelsTheNextTurn(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()

	// Turn seq=1 runs and finishes normally, with no interrupt at all.
	first := startTurn(rt, scopedEvent(1, "task:req-T", "first turn"))
	waitForActiveScope(t, rt, "task:req-T")
	adapter.releaseTurn()
	waitForDone(t, first, "first turn to finish")

	// Turn seq=2 for the SAME Task starts and is still running.
	adapter.blockNextTurn()
	second := startTurn(rt, scopedEvent(2, "task:req-T", "second turn"))
	waitForActiveScope(t, rt, "task:req-T")

	// The Room/network delays the old control until now.
	rt.applyResidentTaskControl(interruptControl("req-T", 1))

	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("a control naming the previous turn must never cancel the current one, got %d", got)
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("the current turn was disturbed: %q", got)
	}
	sequence := activeTurnSequence(rt, "task:req-T")
	if sequence != 2 {
		t.Fatalf("active turn identity changed to %d", sequence)
	}

	// The current turn is still legitimately interruptible by its own control.
	rt.applyResidentTaskControl(interruptControl("req-T", 2))
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the exact current turn must still be cancelable, got %d", got)
	}
	waitForDone(t, second, "second turn to unwind")
}

// TestTaskInterruptDispatchIsAtomicWithTurnTransition pins the local TOCTOU
// boundary deterministically: once an interrupt has matched the exact turn,
// that turn cannot complete its active->idle transition (and no successor turn
// can become active) until the CancelTurn() dispatch has returned.
func TestTaskInterruptDispatchIsAtomicWithTurnTransition(t *testing.T) {
	rt, adapter := newTaskInterruptRuntime()
	defer rt.Stop()
	adapter.cancelEntered = make(chan struct{}, 1)
	adapter.cancelRelease = make(chan struct{})
	adapter.turnFinished = make(chan struct{}, 1)
	// Always release the blocked dispatch, even when an assertion fails: a
	// broken invariant must fail this test, not deadlock it.
	var releaseOnce sync.Once
	releaseDispatch := func() {
		releaseOnce.Do(func() { close(adapter.cancelRelease) })
	}
	// Registered after `defer rt.Stop()`, so it runs FIRST: a broken invariant
	// must fail this test instead of blocking shutdown on the parked dispatch.
	defer releaseDispatch()

	first := startTurn(rt, scopedEvent(1, "task:req-T", "turn to interrupt"))
	waitForActiveScope(t, rt, "task:req-T")

	dispatched := make(chan struct{})
	go func() {
		// Blocks inside CancelTurn until cancelRelease is closed.
		rt.applyResidentTaskControl(interruptControl("req-T", 1))
		close(dispatched)
	}()
	select {
	case <-adapter.cancelEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("interrupt never entered CancelTurn")
	}

	// The owned Harness turn now returns on its own while the dispatch is
	// still in flight. Its active->idle transition must not complete yet.
	adapter.releaseTurn()
	select {
	case <-adapter.turnFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("the owned Harness turn never returned")
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("turn identity was cleared inside the dispatch boundary: %q", got)
	}
	sequence := activeTurnSequence(rt, "task:req-T")
	if sequence != 1 {
		t.Fatalf("a successor turn became active inside the dispatch boundary: %d", sequence)
	}

	releaseDispatch()
	select {
	case <-dispatched:
	case <-time.After(2 * time.Second):
		t.Fatal("interrupt dispatch never returned")
	}
	waitForDone(t, first, "interrupted turn to unwind")
	if got := activeScope(rt); got != "" {
		t.Fatalf("turn identity outlived its turn: %q", got)
	}
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("exactly one cancel must be dispatched, got %d", got)
	}

	// A successor turn for the same Task now runs and is never cancelled by
	// the already-completed dispatch.
	adapter.blockNextTurn()
	second := startTurn(rt, scopedEvent(2, "task:req-T", "successor turn"))
	waitForActiveScope(t, rt, "task:req-T")
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the completed dispatch leaked into the successor turn: %d", got)
	}
	adapter.releaseTurn()
	waitForDone(t, second, "successor turn to finish")
}
