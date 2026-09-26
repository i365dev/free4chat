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
 * Steer retry (#484).
 *
 * A steered instruction runs BEFORE earlier canonical entries, so it is
 * legitimately not the canonical head of pendingAddressed. The autonomous retry
 * validator must therefore ask "is this exact (scope, target) still pending and
 * undelivered?" — a head-based check silently drops the retry of a real
 * transient failure and leaves forward progress dependent on some unrelated
 * later Room event.
 *
 * These tests use the resident-stream runtime with a near-zero retry delay, so
 * the retry really is clock-driven and no extra Room event is delivered.
 */

// flakySteerAdapter fails the first N attempts of the marked instruction with a
// transient Harness error, then delegates to the ordinary interrupt double.
// Every attempt is recorded, including the failed ones, so the attempt order is
// observable separately from the successful delivery order.
type flakySteerAdapter struct {
	*interruptAdapter
	mu         sync.Mutex
	failMarker string
	failFirst  int
	failures   int
	order      map[string][]string
}

func newFlakySteerAdapter(marker string, failFirst int) *flakySteerAdapter {
	return &flakySteerAdapter{
		interruptAdapter: newInterruptAdapter(),
		failMarker:       marker,
		failFirst:        failFirst,
		order:            make(map[string][]string),
	}
}

func (a *flakySteerAdapter) RunTurnFor(scope string, input types.HarnessTurnInput, expectedGeneration int64) (types.HarnessTurnResult, error) {
	texts := make([]string, 0, len(input.Events))
	for _, event := range input.Events {
		if event.Text != "" {
			texts = append(texts, event.Text)
		}
	}
	joined := strings.Join(texts, ",")
	a.mu.Lock()
	a.order[scope] = append(a.order[scope], joined)
	failing := strings.Contains(joined, a.failMarker) && a.failures < a.failFirst
	if failing {
		a.failures++
	}
	a.mu.Unlock()
	if failing {
		return types.HarnessTurnResult{}, errors.New("transient Harness failure")
	}
	return a.interruptAdapter.RunTurnFor(scope, input, expectedGeneration)
}

func (a *flakySteerAdapter) attemptOrder(scope string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.order[scope]...)
}

// newSteerRetryRuntime starts a resident-stream runtime whose retry delay is
// effectively zero, so the bounded retry clock is exercised without wall-clock
// waits. Only the delay is overridden; attempts, scope, and budget stay
// production-shaped.
func newSteerRetryRuntime(t *testing.T, adapter *flakySteerAdapter) (*ResidentRuntime, *turnLogRecorder, *residentTestStream) {
	t.Helper()
	client, stream := newResidentTurnRetryClient(t)
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	rt.turnRetryDelay = func(int) time.Duration { return time.Millisecond }
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	t.Cleanup(rt.Stop)                              // LIFO: runs last.
	t.Cleanup(func() { adapter.releaseAllTurns() }) // unblocks parked turns first.
	return rt, log, stream
}

func waitForActiveTurnNumber(t *testing.T, rt *ResidentRuntime, scope string, want int64) {
	t.Helper()
	waitFor(t, 3*time.Second, func() bool {
		turn, ok := rt.activeTurnOf(scope)
		return ok && turn == want
	}, "active turn "+scope)
}

// steerStillUndelivered reports whether the exact canonical instruction is
// still waiting to be delivered.
func steerStillUndelivered(rt *ResidentRuntime, scope string, target int64) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	ref := rt.sessionRefLocked(scope)
	if ref == nil || ref.pendingContexts == nil {
		return false
	}
	context, ok := (*ref.pendingContexts)[target]
	return ok && !context.delivered
}

// TestSteerRetryIsTargetExactAndNeedsNoNewRoomEvent is the P1 regression: a
// steered instruction fails transiently while earlier canonical work is still
// queued behind it, and the autonomous retry must still deliver it.
//
//	CASE A: A ordinary, B ordinary, C steer
//	        C runs first, fails once, retries by itself, then A and B drain.
func TestSteerRetryIsTargetExactAndNeedsNoNewRoomEvent(t *testing.T) {
	const scope = "task:req-T"
	adapter := newFlakySteerAdapter("C", 1)
	rt, log, stream := newSteerRetryRuntime(t, adapter)

	// One envelope admits the whole canonical backlog; NOTHING else is ever
	// delivered, so only the Runtime's own retry clock can re-run C.
	stream.results <- addressedEnvelope(scopedEvent(1, scope, "N"))
	waitForActiveTurnNumber(t, rt, scope, 1)
	stream.results <- addressedEnvelope(scopedEvent(2, scope, "A"))
	stream.results <- addressedEnvelope(scopedEvent(3, scope, "B"))
	stream.results <- addressedEnvelope(scopedEvent(4, scope, "C"))
	waitFor(t, 3*time.Second, func() bool {
		return reflect.DeepEqual(rt.pendingAddressedSnapshotFor(scope), []int64{1, 2, 3, 4})
	}, "canonical backlog admitted")

	rt.applyResidentTaskControl(steerControl("req-T", 1, 4))
	assertNextDelivery(t, rt, scope, 4)
	// Releasing N is asynchronous, so the delivered prefix may already have
	// collapsed; what must never happen is a REORDER, so the ledger has to stay
	// the canonical admission order (a tail of it) with the steer in place.
	assertCanonicalLedgerSuffix(t, rt, scope, []int64{1, 2, 3, 4})

	// N yields, C runs first and fails once; the target-exact retry clock must
	// recover it without any further Room event.
	waitFor(t, 5*time.Second, func() bool { return log.count("retry_scheduled") == 1 }, "transient failure to arm the retry clock")
	waitFor(t, 5*time.Second, func() bool { return log.count("retry_started") == 1 }, "the target-exact retry to start")
	waitFor(t, 5*time.Second, func() bool {
		return rt.deliveredSeqFor(scope) == 4 && len(rt.pendingAddressedSnapshotFor(scope)) == 0
	}, "the steered Task to drain")

	if got := adapter.attemptOrder(scope); !reflect.DeepEqual(got, []string{"N", "C", "C", "A", "B"}) {
		t.Fatalf("attempt order = %v, want [N C C A B]", got)
	}
	// Successful deliveries only: C exactly once, never duplicated.
	_, details := adapter.scopedRunSnapshot()
	if got := details[scope]; !reflect.DeepEqual(got, []string{"N", "C", "A", "B"}) {
		t.Fatalf("successful delivery order = %v, want [N C A B]", got)
	}
	if got := log.count("retry_scheduled"); got != 1 {
		t.Fatalf("expected exactly one bounded retry, got %d", got)
	}
	if got := log.count("turn_retry_exhausted"); got != 0 {
		t.Fatalf("a single transient failure must not exhaust the retry budget: %v", log.events)
	}
	if got := rt.deliveredSeqFor(scope); got != 4 {
		t.Fatalf("delivery cursor = %d, want the last canonical instruction", got)
	}
}

// TestSteerRetryStaysWithinTheBoundedBudget covers CASE B: a steered
// instruction that keeps failing must stop inside the existing retry budget,
// without unbounded state growth, and must not acknowledge or skip the ordinary
// work waiting behind it.
func TestSteerRetryStaysWithinTheBoundedBudget(t *testing.T) {
	const scope = "task:req-T"
	adapter := newFlakySteerAdapter("C", 99) // every C attempt fails
	rt, log, stream := newSteerRetryRuntime(t, adapter)

	stream.results <- addressedEnvelope(scopedEvent(1, scope, "N"))
	waitForActiveTurnNumber(t, rt, scope, 1)
	stream.results <- addressedEnvelope(scopedEvent(2, scope, "A"))
	stream.results <- addressedEnvelope(scopedEvent(3, scope, "B"))
	stream.results <- addressedEnvelope(scopedEvent(4, scope, "C"))
	waitFor(t, 3*time.Second, func() bool {
		return reflect.DeepEqual(rt.pendingAddressedSnapshotFor(scope), []int64{1, 2, 3, 4})
	}, "canonical backlog admitted")
	rt.applyResidentTaskControl(steerControl("req-T", 1, 4))

	waitFor(t, 5*time.Second, func() bool { return log.count("turn_retry_exhausted") == 1 }, "the bounded retry budget to be spent")
	// The steer's recovery is closed, but the ordinary work behind it is NOT
	// skipped: a later drain (any Room traffic re-enters the serial drain)
	// delivers A and B, while the undelivered steer stays pending exactly once.
	stream.results <- addressedEnvelope(roomEvent(50, false))
	waitFor(t, 5*time.Second, func() bool { return rt.deliveredSeqFor(scope) == 3 }, "ordinary work to drain past the closed steer")
	time.Sleep(150 * time.Millisecond)

	if got := adapter.attemptOrder(scope); !reflect.DeepEqual(got, []string{"N", "C", "C", "C", "A", "B"}) {
		t.Fatalf("attempt order = %v, want [N C C C A B] (initial + bounded retries)", got)
	}

	rt.mu.Lock()
	ledger := []int64{}
	if ref := rt.sessionRefLocked(scope); ref != nil && ref.pendingAddressed != nil {
		ledger = append(ledger, (*ref.pendingAddressed)...)
	}
	retryStates := len(rt.turnRetries)
	pendingContexts := 0
	if ref := rt.sessionRefLocked(scope); ref != nil && ref.pendingContexts != nil {
		pendingContexts = len(*ref.pendingContexts)
	}
	rt.mu.Unlock()

	// The repeatedly failing steer stays pending and undelivered EXACTLY once,
	// with bounded Runtime bookkeeping and no unbounded retry loop.
	if !reflect.DeepEqual(ledger, []int64{4}) {
		t.Fatalf("canonical ledger after the bounded failure = %v, want the undelivered steer only", ledger)
	}
	if pendingContexts != 1 {
		t.Fatalf("pending contexts = %d, want exactly the undelivered steer", pendingContexts)
	}
	if retryStates > 1 {
		t.Fatalf("retry bookkeeping grew to %d entries", retryStates)
	}
	if !steerStillUndelivered(rt, scope, 4) {
		t.Fatal("a failed steer was reported as delivered")
	}
	if got := log.count("retry_started"); got != maxTurnRetryAttempts {
		t.Fatalf("retry attempts started = %d, want the bounded budget %d", got, maxTurnRetryAttempts)
	}
}

// assertCanonicalLedgerSuffix proves the canonical ledger is still the admitted
// order: either the whole backlog, or a collapsed TAIL of it. A ledger that is
// not a suffix would mean steering physically reordered canonical storage.
func assertCanonicalLedgerSuffix(t *testing.T, rt *ResidentRuntime, scope string, admitted []int64) {
	t.Helper()
	ledger := rt.pendingAddressedSnapshotFor(scope)
	if len(ledger) > len(admitted) {
		t.Fatalf("ledger %v is longer than the admitted order %v", ledger, admitted)
	}
	tail := admitted[len(admitted)-len(ledger):]
	if !reflect.DeepEqual(ledger, tail) {
		t.Fatalf("ledger %v is not the canonical tail of the admitted order %v", ledger, admitted)
	}
}
