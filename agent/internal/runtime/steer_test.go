package runtime

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * STEER (#484).
 *
 * Interrupt asks the exact active turn to yield. Interrupt & Send is STEER: the
 * Human's replacement instruction is already canonical Task input, and the
 * Runtime must make it the next NOT-YET-STARTED instruction of that Task
 * instead of an ordinary FIFO follow-up. Cancellation is only one fallback way
 * to make the current turn yield sooner: a slow, ignored, or refused cancel
 * must never lose the steer.
 */

// newSteerRuntime is the shared interrupt double plus the cleanup that
// unblocks any turn a failing assertion left parked.
func newSteerRuntime(t *testing.T) (*ResidentRuntime, *interruptAdapter) {
	t.Helper()
	rt, adapter := newTaskInterruptRuntime()
	t.Cleanup(adapter.releaseAllTurns)
	return rt, adapter
}

func steerControl(taskRequestID string, turnSequence, steerSequence int64) *types.ResidentTaskControl {
	return &types.ResidentTaskControl{
		Kind:                     types.ResidentTaskControlSteer,
		TaskRequestID:            taskRequestID,
		TurnSequence:             turnSequence,
		SteerInstructionSequence: steerSequence,
	}
}

func turnTexts(t *testing.T, adapter *interruptAdapter, scope string) []string {
	t.Helper()
	_, details := adapter.scopedRunSnapshot()
	return details[scope]
}

func waitForTurnTexts(t *testing.T, adapter *interruptAdapter, scope string, want []string) {
	t.Helper()
	waitFor(t, 3*time.Second, func() bool {
		return reflect.DeepEqual(turnTexts(t, adapter, scope), want)
	}, "turn delivery order "+strings.Join(want, ","))
}

func TestSteerJumpsOrdinaryFollowUpsAfterTheActiveTurnSettles(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()

	// N is active. The Human then had already queued A and B, and only then
	// steered C — so canonical order is N, A, B, C.
	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "B"))
	rt.acceptEvent(scopedEvent(4, "task:req-T", "C"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 4))

	// Priority is decided BEFORE the turn settles: the running turn keeps the
	// head, and the steer is already the next not-yet-started instruction.
	// The canonical ledger is UNCHANGED: priority is an overlay, not a reorder.
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3, 4}) {
		t.Fatalf("steer rewrote the canonical ledger: %v", got)
	}
	// ...and the delivery decision is the steer.
	assertNextDelivery(t, rt, "task:req-T", 4)

	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	waitForTurnTexts(t, adapter, "task:req-T", []string{"N", "C", "A", "B"})
}

func TestSteerPreservesCanonicalOrderAmongMultipleSteers(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "C"))
	rt.acceptEvent(scopedEvent(4, "task:req-T", "D"))
	rt.acceptEvent(scopedEvent(5, "task:req-T", "B"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))
	rt.applyResidentTaskControl(steerControl("req-T", 1, 4))

	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3, 4, 5}) {
		t.Fatalf("steering rewrote the canonical ledger: %v", got)
	}
	// Steers keep canonical order among themselves and both stay ahead of the
	// ordinary follow-up.
	assertNextDelivery(t, rt, "task:req-T", 3)
	assertDeliveryOrder(t, rt, "task:req-T", []int64{3, 4, 2, 5})

	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	waitForTurnTexts(t, adapter, "task:req-T", []string{"N", "C", "D", "A", "B"})
}

// TestSteerSurvivesAnIgnoredCancel is the weak-cancel contract: the Harness
// accepts the yield request and ignores it. The steer must stay priority-next
// and run exactly once, immediately after the old turn eventually settles.
func TestSteerSurvivesAnIgnoredCancel(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()
	adapter.ignoreCancel()

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "C"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))

	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the fallback must still ask the exact turn to yield, got %d", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("an ignored cancel rewrote the canonical ledger: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-T", 3)
	// The ignored turn is still the active one, so nothing was falsely settled.
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("an ignored cancel must not settle the turn: %q", got)
	}

	// The old turn settles on its own, later.
	adapter.releaseTurn()
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	waitForTurnTexts(t, adapter, "task:req-T", []string{"N", "C", "A"})
}

// TestSteerSurvivesACancelWriteFailure: the replacement instruction is already
// canonical, so a cancel that cannot even be dispatched only changes how soon
// the steer runs — never whether it survives.
func TestSteerSurvivesACancelWriteFailure(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()
	adapter.failCancel(errors.New("cancel write failed"))

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "C"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))

	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("a failed cancel rewrote the canonical ledger: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-T", 3)
	// A refused yield is not an interruption: the exact turn keeps running.
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the fallback must attempt the yield once, got %d", got)
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("a failed cancel must not settle the turn: %q", got)
	}

	adapter.releaseTurn()
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	waitForTurnTexts(t, adapter, "task:req-T", []string{"N", "C", "A"})
}

// TestSteerLeavesAnotherTaskUntouched: steering Task A must not cancel,
// reorder, or serialize Task B.
func TestSteerLeavesAnotherTaskUntouched(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	rt.acceptEvent(scopedEvent(1, "task:req-A", "A"))
	rt.acceptEvent(scopedEvent(2, "task:req-B", "B"))
	drain := make(chan struct{})
	go func() {
		rt.drainTurns()
		close(drain)
	}()
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	rt.acceptEvent(scopedEvent(3, "task:req-A", "A-steer"))
	rt.applyResidentTaskControl(steerControl("req-A", 1, 3))

	if got := adapter.cancelledScopes(); !reflect.DeepEqual(got, []string{"task:req-A"}) {
		t.Fatalf("steer/cancel crossed the Task boundary: %v", got)
	}
	if !adapter.isRunning("task:req-B") {
		t.Fatal("steering Task A disturbed the active Task B")
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-B"); !reflect.DeepEqual(got, []int64{2}) {
		t.Fatalf("Task B pending work was reordered: %v", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-A"); !reflect.DeepEqual(got, []int64{1, 3}) {
		t.Fatalf("Task A ledger changed: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-A", 3)

	adapter.release("task:req-B")
	waitFor(t, 3*time.Second, func() bool { return !adapter.isRunning("task:req-B") }, "Task B to finish")
	// Task A yields and then runs its steered instruction, untouched by B.
	adapter.release("task:req-A")
	waitFor(t, 3*time.Second, func() bool { return adapter.runCount("task:req-A") >= 2 }, "Task A steer turn to start")
	adapter.release("task:req-A")
	waitFor(t, 3*time.Second, func() bool { return !adapter.isRunning("task:req-A") }, "Task A to finish")
	if got := adapter.cancelledScopes(); !reflect.DeepEqual(got, []string{"task:req-A"}) {
		t.Fatalf("Task A's steer leaked a cancel into another Task: %v", got)
	}
}

// TestSteerKeepsTheSameTaskSession: a steer is a delivery-priority decision, so
// the retained Task conversation is never replaced by it.
func TestSteerKeepsTheSameTaskSession(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	generation := adapter.scopedGenerationSnapshot("task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "C"))
	rt.applyResidentTaskControl(steerControl("req-T", 1, 2))

	adapter.releaseTurn()
	waitForDone(t, drained, "steered Task to drain")

	if got := adapter.scopedGenerationSnapshot("task:req-T"); got != generation {
		t.Fatalf("steer replaced the retained Task session: %d -> %d", generation, got)
	}
	// The first turn creates the Task conversation; the steer turn must reuse
	// it rather than materialize another one.
	if news := adapter.scopedSessionNewSnapshot("task:req-T"); len(news) != 2 || !news[0] || news[1] {
		t.Fatalf("steer did not reuse the retained Harness conversation: %v", news)
	}
}

// TestRepeatedSteerCyclesStayBounded runs several steer/redirect cycles and
// asserts the Runtime's own bookkeeping returns to a bounded steady state:
// no stale active turn, no duplicate pending entry, no stale control, and
// pending work bounded by the canonical instructions that are really waiting.
func TestRepeatedSteerCyclesStayBounded(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()

	sequence := int64(1)
	for cycle := 0; cycle < 5; cycle++ {
		if cycle > 0 {
			// The constructor armed only the first turn's gate.
			adapter.blockNextTurn()
		}
		hold := adapter.holdTurns()
		drained := startTurn(rt, scopedEvent(sequence, "task:req-T", "N"+string(rune('a'+cycle))))
		waitForActiveScope(t, rt, "task:req-T")
		sequence++
		rt.acceptEvent(scopedEvent(sequence, "task:req-T", "ordinary"))
		sequence++
		rt.acceptEvent(scopedEvent(sequence, "task:req-T", "steer"+string(rune('a'+cycle))))

		rt.applyResidentTaskControl(steerControl("req-T", sequence-2, sequence))
		// A duplicated/replayed steer cycle must not add a second promotion.
		rt.applyResidentTaskControl(steerControl("req-T", sequence-2, sequence))

		if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{sequence - 2, sequence - 1, sequence}) {
			t.Fatalf("cycle %d produced a duplicate or stale canonical ledger: %v", cycle, got)
		}
		assertNextDelivery(t, rt, "task:req-T", sequence)
		adapter.releaseTurn()
		close(hold)
		waitForDone(t, drained, "steered Task to drain")
		sequence++
	}

	waitFor(t, 3*time.Second, func() bool { return activeScope(rt) == "" }, "no stale active turn")
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); len(got) != 0 {
		t.Fatalf("steer cycles left pending work behind: %v", got)
	}
	rt.mu.Lock()
	pendingContexts := 0
	if ref := rt.sessionRefLocked("task:req-T"); ref != nil && ref.pendingContexts != nil {
		pendingContexts = len(*ref.pendingContexts)
	}
	rt.mu.Unlock()
	if pendingContexts != 0 {
		t.Fatalf("steer cycles left %d pending contexts", pendingContexts)
	}
	// Each cycle applies its steer control twice; the replayed control is a
	// bounded no-op, so there is exactly ONE yield request per cycle and no
	// state growth.
	if got := adapter.cancelCount(); got != 5 {
		t.Fatalf("a duplicate steer control must not request a second yield: got %d cancels", got)
	}
}

// nativeSteerAdapter records native steering delivery and keeps its own pending
// accounting observable, so the Runtime's native path can be pinned even though
// no currently pinned bridge implements it.
type nativeSteerAdapter struct {
	*interruptAdapter
	steerMu    sync.Mutex
	steered    []string
	steerErr   error
	steerCalls int
}

func (a *nativeSteerAdapter) SteerTurnFor(scope string, expectedTurnSequence int64, input types.HarnessTurnInput) error {
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	a.steerCalls++
	if a.steerErr != nil {
		return a.steerErr
	}
	for _, event := range input.Events {
		if event.Text != "" {
			a.steered = append(a.steered, fmt.Sprintf("%s@%d=%s", scope, expectedTurnSequence, event.Text))
		}
	}
	return nil
}

func (a *nativeSteerAdapter) steeredTexts() []string {
	a.steerMu.Lock()
	defer a.steerMu.Unlock()
	return append([]string(nil), a.steered...)
}

func (a *nativeSteerAdapter) setSteerErr(err error) {
	a.steerMu.Lock()
	a.steerErr = err
	a.steerMu.Unlock()
}

func newNativeSteerRuntime(t *testing.T) (*ResidentRuntime, *nativeSteerAdapter) {
	t.Helper()
	adapter := &nativeSteerAdapter{interruptAdapter: newInterruptAdapter()}
	rt := NewResidentRuntime(Options{
		InstanceID: "task-steer-native",
		RoomID:     "room-task-steer-native",
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
	t.Cleanup(adapter.releaseAllTurns)
	return rt, adapter
}

// TestNativeSteerDeliversOnceAndNeverReplays: when a Harness really understands
// steering, the guidance goes into the ACTIVE turn, is acknowledged exactly
// once, and is never executed again as its own queued turn.
func TestNativeSteerDeliversOnceAndNeverReplays(t *testing.T) {
	rt, adapter := newNativeSteerRuntime(t)
	defer rt.Stop()

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "ordinary"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "steer-now"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))

	if got := adapter.steeredTexts(); !reflect.DeepEqual(got, []string{"task:req-T@1=steer-now"}) {
		t.Fatalf("native steer did not deliver the canonical instruction once, with the exact turn: %v", got)
	}
	// The canonical ledger is untouched, and the delivered steer is recorded as
	// delivered instead of being reordered or dropped ahead of the ordinary
	// follow-up that is still undelivered behind it.
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("native steer rewrote the canonical ledger: %v", got)
	}
	if got := rt.deliveredSeqFor("task:req-T"); got != 0 {
		t.Fatalf("native steer advanced the canonical cursor past undelivered work: %d", got)
	}
	// A native steer does not cancel: the same turn keeps running.
	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("native steer must not cancel the active turn, got %d", got)
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("native steer settled the active turn: %q", got)
	}

	adapter.releaseTurn()
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	if got := turnTexts(t, adapter.interruptAdapter, "task:req-T"); !reflect.DeepEqual(got, []string{"N", "ordinary"}) {
		t.Fatalf("a natively delivered steer replayed as its own turn: %v", got)
	}
}

// TestNativeSteerFailureFallsBackWithoutLosingTheInstruction: a Harness that
// advertises the seam but cannot deliver must degrade to the generic fallback.
func TestNativeSteerFailureFallsBackWithoutLosingTheInstruction(t *testing.T) {
	rt, adapter := newNativeSteerRuntime(t)
	defer rt.Stop()
	adapter.setSteerErr(errors.New("native steer unavailable"))

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "ordinary"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "steer-now"))

	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))

	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("a failed native steer rewrote the canonical ledger: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-T", 3)
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the fallback must still ask the turn to yield, got %d", got)
	}

	adapter.releaseTurn()
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	if got := turnTexts(t, adapter.interruptAdapter, "task:req-T"); !reflect.DeepEqual(got, []string{"N", "steer-now", "ordinary"}) {
		t.Fatalf("the fallback lost the steer: %v", got)
	}
}

// TestSteerControlForAStaleTurnOrInstructionIsABoundedNoOp: the exact-turn rule
// and the canonical-instruction rule both fail closed. A control that names
// another turn, another Task, or an instruction this Runtime no longer holds
// must not reorder anything and must not interrupt anything.
func TestSteerControlForAStaleTurnOrInstructionIsABoundedNoOp(t *testing.T) {
	rt, adapter := newSteerRuntime(t)
	defer rt.Stop()

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "C"))

	for name, control := range map[string]*types.ResidentTaskControl{
		"another turn of the same Task":      steerControl("req-T", 99, 3),
		"another Task":                       steerControl("req-OTHER", 1, 3),
		"an instruction that is not pending": steerControl("req-T", 1, 4001),
		"no instruction identity":            {Kind: types.ResidentTaskControlSteer, TaskRequestID: "req-T", TurnSequence: 1},
	} {
		rt.applyResidentTaskControl(control)
		if got := adapter.cancelCount(); got != 0 {
			t.Fatalf("%s: a stale steer interrupted the active turn (%d cancels)", name, got)
		}
		if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
			t.Fatalf("%s: a stale steer changed the canonical ledger: %v", name, got)
		}
		assertNextDelivery(t, rt, "task:req-T", 1)
	}

	// The real control still works afterwards: fail-closed never wedges the
	// supervision path.
	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("the valid steer did not request a yield, got %d", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("the valid steer rewrote the canonical ledger: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-T", 3)
	adapter.releaseTurn()
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
}

// TestInterruptReachesOnlyItsOwnTask: a plain Human Interrupt asks exactly one
// Task's active turn to yield. It never touches another active Task, and it
// never reorders that Task's pending work.
func TestInterruptReachesOnlyItsOwnTask(t *testing.T) {
	adapter := newLaneAdapter()
	rt, _ := newLaneRuntime(t, adapter, crossSessionPolicy(2))

	rt.acceptEvent(scopedEvent(1, "task:req-A", "A"))
	rt.acceptEvent(scopedEvent(2, "task:req-B", "B"))
	rt.acceptEvent(scopedEvent(3, "task:req-A", "A-follow-up"))
	go rt.drainTurns()
	waitForRunning(t, adapter, "task:req-A", "task:req-B")

	rt.applyResidentTaskControl(&types.ResidentTaskControl{
		Kind:          types.ResidentTaskControlInterrupt,
		TaskRequestID: "req-A",
		TurnSequence:  1,
	})

	if got := adapter.cancelledScopes(); !reflect.DeepEqual(got, []string{"task:req-A"}) {
		t.Fatalf("interrupt crossed the Task boundary: %v", got)
	}
	if !adapter.isRunning("task:req-B") {
		t.Fatal("interrupting Task A stopped Task B")
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-A"); !reflect.DeepEqual(got, []int64{1, 3}) {
		t.Fatalf("a plain interrupt reordered Task A pending work: %v", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-B"); !reflect.DeepEqual(got, []int64{2}) {
		t.Fatalf("a plain interrupt touched Task B pending work: %v", got)
	}

	// Task A yields, then its already-queued follow-up runs; Task B just
	// finishes. Neither needs the other to be released first.
	adapter.release("task:req-A")
	waitFor(t, 3*time.Second, func() bool { return adapter.runCount("task:req-A") >= 2 }, "Task A follow-up to start")
	adapter.release("task:req-A")
	adapter.release("task:req-B")
	waitFor(t, 3*time.Second, func() bool {
		return !adapter.isRunning("task:req-A") && !adapter.isRunning("task:req-B")
	}, "both Tasks to settle")
}

// assertNextDelivery proves which canonical instruction this scope would
// deliver next, without mutating anything.
func assertNextDelivery(t *testing.T, rt *ResidentRuntime, scope string, want int64) {
	t.Helper()
	rt.mu.Lock()
	target, ok := rt.nextPendingTargetLocked(scope, rt.sessionRefLocked(scope))
	rt.mu.Unlock()
	if !ok || target != want {
		t.Fatalf("next delivery for %s = %d (ok=%v), want %d", scope, target, ok, want)
	}
}

// assertDeliveryOrder proves the exact order the overlay will deliver the
// pending instructions in: steers in canonical order first, then the remaining
// ordinary work in canonical order. Nothing is mutated.
func assertDeliveryOrder(t *testing.T, rt *ResidentRuntime, scope string, want []int64) {
	t.Helper()
	rt.mu.Lock()
	ref := rt.sessionRefLocked(scope)
	running := int64(0)
	if lane, ok := rt.activeTurns[scope]; ok {
		running = lane.target
	}
	order := make([]int64, 0, len(*ref.pendingAddressed))
	for _, sequence := range *ref.pendingAddressed {
		if sequence == running {
			continue
		}
		context, ok := (*ref.pendingContexts)[sequence]
		if ok && (context.delivered || !context.steer) {
			continue
		}
		order = append(order, sequence)
	}
	for _, sequence := range *ref.pendingAddressed {
		if sequence == running {
			continue
		}
		context, ok := (*ref.pendingContexts)[sequence]
		if ok && (context.delivered || context.steer) {
			continue
		}
		order = append(order, sequence)
	}
	rt.mu.Unlock()
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("delivery overlay for %s = %v, want %v", scope, order, want)
	}
}

// runningTargetFor reports the canonical instruction this scope is executing.
func runningTargetFor(rt *ResidentRuntime, scope string) int64 {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if lane, ok := rt.activeTurns[scope]; ok {
		return lane.target
	}
	return 0
}

func waitForRunningTarget(t *testing.T, rt *ResidentRuntime, scope string, want int64) {
	t.Helper()
	waitFor(t, 3*time.Second, func() bool { return runningTargetFor(rt, scope) == want },
		fmt.Sprintf("%s to execute turn %d", scope, want))
}

func waitForDeliveredThrough(t *testing.T, rt *ResidentRuntime, scope string, want int64) {
	t.Helper()
	waitFor(t, 3*time.Second, func() bool { return rt.deliveredSeqFor(scope) == want },
		fmt.Sprintf("%s delivery cursor to reach %d", scope, want))
}

// TestSteerDeliversOutOfCanonicalOrderWithoutBreakingTheLedger is the #484
// canonical-storage contract, with a later instruction arriving mid-drain:
//
//	N active, A and B already queued, C steers, D arrives before A/B drain.
//
// Required: execution N -> C -> A -> B -> D, canonical storage [N, A, B, C, D]
// throughout, C exactly once, A and B never skipped, and a delivery cursor that
// never jumps over the undelivered ordinary work.
func TestSteerDeliversOutOfCanonicalOrderWithoutBreakingTheLedger(t *testing.T) {
	rt, adapter := newSteerRuntime(t)

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
	rt.acceptEvent(scopedEvent(3, "task:req-T", "B"))
	rt.acceptEvent(scopedEvent(4, "task:req-T", "C"))
	rt.applyResidentTaskControl(steerControl("req-T", 1, 4))

	// Canonical storage is untouched; only the delivery decision changes.
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{1, 2, 3, 4}) {
		t.Fatalf("steer rewrote the canonical ledger: %v", got)
	}
	assertNextDelivery(t, rt, "task:req-T", 4)
	assertDeliveryOrder(t, rt, "task:req-T", []int64{4, 2, 3})

	// C runs BEFORE the ordinary follow-ups that were queued earlier.
	adapter.blockNextTurn() // parks C, so its delivery is observable
	close(hold)
	waitForRunningTarget(t, rt, "task:req-T", 4)
	// N is delivered and collapsed, but the cursor must NOT move over A/B.
	if got := rt.deliveredSeqFor("task:req-T"); got != 1 {
		t.Fatalf("the cursor advanced past undelivered follow-ups while C ran: %d", got)
	}

	// Park A next so the post-C ledger state is observable.
	adapter.blockNextTurn()
	adapter.releaseTurn()
	waitForRunningTarget(t, rt, "task:req-T", 2)
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{2, 3, 4}) {
		t.Fatalf("delivering C out of order changed canonical storage: %v", got)
	}
	if got := rt.deliveredSeqFor("task:req-T"); got != 1 {
		t.Fatalf("the cursor jumped to C while A/B were still undelivered: %d", got)
	}

	// D arrives while A is running and B is still undelivered.
	rt.acceptEvent(scopedEvent(5, "task:req-T", "D"))
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); !reflect.DeepEqual(got, []int64{2, 3, 4, 5}) {
		t.Fatalf("a later instruction did not append canonically: %v", got)
	}

	// A and B still run, in canonical order, before D.
	adapter.blockNextTurn()
	adapter.releaseTurn()
	waitForRunningTarget(t, rt, "task:req-T", 3)
	waitForDeliveredThrough(t, rt, "task:req-T", 2)
	adapter.releaseTurn()
	waitForDone(t, drained, "steered Task to drain")

	texts := turnTexts(t, adapter, "task:req-T")
	if !reflect.DeepEqual(texts, []string{"N", "C", "A", "B", "D"}) {
		t.Fatalf("execution order = %v, want [N C A B D]", texts)
	}
	// C is delivered exactly once and never re-enters a later turn's context.
	if got := len(texts); got != 5 {
		t.Fatalf("a steered instruction was delivered more than once: %v", texts)
	}
	if texts[4] != "D" {
		t.Fatalf("D's context replayed earlier instructions: %q", texts[4])
	}
	if got := adapter.cancelCount(); got != 1 {
		t.Fatalf("a first steer must request exactly one best-effort yield, got %d", got)
	}
	// The cursor ends exactly at the last delivered instruction, with nothing
	// left in the ledger.
	waitForDeliveredThrough(t, rt, "task:req-T", 5)
	if got := rt.pendingAddressedSnapshotFor("task:req-T"); len(got) != 0 {
		t.Fatalf("the canonical ledger did not drain: %v", got)
	}
}

// steerLogRecorder captures the bounded task_steer_* diagnostics.
type steerLogRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *steerLogRecorder) log(event string, _ map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *steerLogRecorder) count(event string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := 0
	for _, recorded := range r.events {
		if recorded == event {
			total++
		}
	}
	return total
}

// TestSteerDistinguishesPromotionAlreadyNextAndDuplicate covers the three
// control outcomes (#484): a first steer that must jump ordinary work, a first
// steer whose instruction was going to be next anyway, and a replayed control.
// Each first application requests exactly one best-effort yield; a duplicate
// changes nothing and requests none.
func TestSteerDistinguishesPromotionAlreadyNextAndDuplicate(t *testing.T) {
	for name, testCase := range map[string]struct {
		ordinaryQueued bool
		wantNext       int64
		wantOrder      []int64
	}{
		"first steer must jump ordinary work": {ordinaryQueued: true, wantNext: 4, wantOrder: []int64{4, 2}},
		"first steer was already next":        {ordinaryQueued: false, wantNext: 3, wantOrder: []int64{3}},
	} {
		t.Run(name, func(t *testing.T) {
			rt, adapter := newSteerRuntime(t)
			logged := &steerLogRecorder{}
			rt.log = logged.log

			hold := adapter.holdTurns()
			drained := startTurn(rt, scopedEvent(1, "task:req-T", "N"))
			waitForActiveScope(t, rt, "task:req-T")
			if testCase.ordinaryQueued {
				rt.acceptEvent(scopedEvent(2, "task:req-T", "A"))
			}
			rt.acceptEvent(scopedEvent(testCase.wantNext, "task:req-T", "C"))

			rt.applyResidentTaskControl(steerControl("req-T", 1, testCase.wantNext))
			assertNextDelivery(t, rt, "task:req-T", testCase.wantNext)
			assertDeliveryOrder(t, rt, "task:req-T", testCase.wantOrder)
			if got := adapter.cancelCount(); got != 1 {
				t.Fatalf("a first steer must request exactly one yield, got %d", got)
			}
			if got := logged.count("task_steer_fallback"); got != 1 {
				t.Fatalf("the first steer was not reported once: %v", logged.events)
			}

			// Replaying the SAME control is a bounded no-op.
			rt.applyResidentTaskControl(steerControl("req-T", 1, testCase.wantNext))
			if got := adapter.cancelCount(); got != 1 {
				t.Fatalf("a duplicate steer requested a second yield: %d", got)
			}
			if got := logged.count("task_steer_duplicate"); got != 1 {
				t.Fatalf("the duplicate was not reported as such: %v", logged.events)
			}
			assertNextDelivery(t, rt, "task:req-T", testCase.wantNext)

			adapter.releaseTurn()
			close(hold)
			waitForDone(t, drained, "steered Task to drain")
		})
	}
}
