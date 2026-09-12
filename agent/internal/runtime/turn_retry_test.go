package runtime

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// turnLogRecorder captures the bounded turn diagnostics so tests can assert
// the expected event sequence and that no field ever carries work content.
type turnLogRecorder struct {
	mu     sync.Mutex
	events []string
	fields []map[string]string
}

func (l *turnLogRecorder) log(event string, details map[string]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	copied := make(map[string]string, len(details))
	for key, value := range details {
		copied[key] = value
	}
	l.events = append(l.events, event)
	l.fields = append(l.fields, copied)
}

func (l *turnLogRecorder) snapshot() ([]string, []map[string]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...), append([]map[string]string(nil), l.fields...)
}

func (l *turnLogRecorder) count(event string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	total := 0
	for _, recorded := range l.events {
		if recorded == event {
			total++
		}
	}
	return total
}

// fieldsFor returns the details of every recorded occurrence of one event.
func (l *turnLogRecorder) fieldsFor(event string) []map[string]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]string
	for index, recorded := range l.events {
		if recorded == event {
			out = append(out, l.fields[index])
		}
	}
	return out
}

// newTurnRetryRuntime starts a resident-stream runtime whose bounded retry
// delay is effectively zero, so the autonomous retry policy is exercised
// without wall-clock waits. Only the delay is overridden; attempts, scope, and
// budget stay production-shaped.
func newTurnRetryRuntime(
	t *testing.T,
	adapter types.HarnessAdapter,
	client types.Free4ChatClient,
	logger LogFunc,
) *ResidentRuntime {
	t.Helper()
	rt := NewResidentRuntime(Options{
		InstanceID: "turn-retry",
		RoomID:     "room-turn-retry",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
		Log:        logger,
	})
	rt.turnRetryDelay = func(int) time.Duration { return time.Millisecond }
	return rt
}

// silentLog keeps focused tests from writing diagnostics to the test log.
func silentLog(string, map[string]string) {}

func newResidentTurnRetryClient(t *testing.T) (*residentTestClient, *residentTestStream) {
	t.Helper()
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	return client, stream
}

func addressedEnvelope(event types.RoomEvent) types.WaitResult {
	return types.WaitResult{
		Events:    []types.RoomEvent{event},
		Cursor:    event.Sequence,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
}

// TestFailedHarnessTurnRetriesAutonomouslyWithoutNewRoomEvent is the core
// #364 B regression: a transient Harness failure must not wait for an
// unrelated future Room event before the pinned canonical turn is retried.
func TestFailedHarnessTurnRetriesAutonomouslyWithoutNewRoomEvent(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("transient ACP failure")}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	// A clearly observable delay proves the retry is clock-driven (and not a
	// side effect of another Room envelope) while staying fast.
	rt.turnRetryDelay = func(int) time.Duration { return 250 * time.Millisecond }
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	// Exactly one Room envelope is delivered. A second Harness attempt can
	// therefore only come from the Runtime's own bounded retry clock.
	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 3*time.Second, func() bool {
		return adapter.sessionsInt() == 1 && len(rt.pendingAddressedSnapshot()) == 1 &&
			log.count("turn_failed") == 1
	}, "first failed attempt stays unacknowledged")
	if got := rt.deliveredSeq(); got != 0 {
		t.Fatalf("failed turn advanced deliveredThrough to %d", got)
	}
	if sent := client.snapshotSent(); len(sent) != 0 {
		t.Fatalf("failed turn published a reply: %v", sent)
	}

	// The Harness recovers; the Runtime must retry by itself and acknowledge
	// exactly once with exactly one public reply.
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	waitFor(t, 3*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshot()) == 0 &&
			rt.deliveredSeq() == 1 &&
			len(client.snapshotSent()) == 1
	}, "autonomous retry delivered the canonical turn once")

	time.Sleep(50 * time.Millisecond)
	if got := adapter.sessionsInt(); got != 2 {
		t.Fatalf("expected exactly one retry, Harness ran %d times", got)
	}
	if sent := client.snapshotSent(); len(sent) != 1 {
		t.Fatalf("the public reply must not be duplicated: %v", sent)
	}
	if got := log.count("retry_scheduled"); got != 1 {
		t.Fatalf("expected exactly one retry_scheduled event, got %d", got)
	}
	if got := log.count("retry_started"); got != 1 {
		t.Fatalf("expected exactly one retry_started event, got %d", got)
	}
}

// TestRepeatedHarnessFailureExhaustsBoundedRetryAndStops pins the bounded
// budget: a persistently failing Harness must end in a truthful local state
// instead of spinning forever.
func TestRepeatedHarnessFailureExhaustsBoundedRetryAndStops(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: &harness.TurnTimeoutError{TimeoutMs: 120_000}}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 5*time.Second, func() bool {
		return adapter.sessionsInt() == 1+maxTurnRetryAttempts && log.count("turn_retry_exhausted") == 1
	}, "bounded retry budget consumed")

	// No spinning: the clock is not re-armed for the same canonical turn.
	time.Sleep(150 * time.Millisecond)
	if got := adapter.sessionsInt(); got != 1+maxTurnRetryAttempts {
		t.Fatalf("exhausted retry budget kept spinning: %d Harness turns", got)
	}
	if got := log.count("retry_scheduled"); got != maxTurnRetryAttempts {
		t.Fatalf("retry_scheduled events = %d, want %d", got, maxTurnRetryAttempts)
	}
	if got := log.count("turn_retry_exhausted"); got != 1 {
		t.Fatalf("expected exactly one turn_retry_exhausted event, got %d", got)
	}
	// A failed turn is never acknowledged, and the resident reports the
	// truthful bounded local failure state.
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("exhausted failure acknowledged the pending turn: %v", got)
	}
	if got := rt.deliveredSeq(); got != 0 {
		t.Fatalf("exhausted failure advanced deliveredThrough to %d", got)
	}
	status := rt.Status()
	if status.LastError == "" || status.State != StateReconnecting {
		t.Fatalf("exhausted retry did not end in a truthful local state: %+v", status)
	}
	if len(client.snapshotSent()) != 0 {
		t.Fatalf("failed turns must never publish a reply: %v", client.snapshotSent())
	}
}

// TestLaterRoomEventCannotResetTheRetryBudgetForTheSameTurn proves the budget
// belongs to the canonical (scope, sequence) turn: once that turn's bounded
// autonomous recovery is exhausted, later unrelated Room traffic can neither
// re-execute it nor grant it a fresh budget. The canonical turn stays pending
// and unacknowledged in a truthful reconnect state until an explicit recovery
// boundary — a new addressed trigger for the same scope — re-arms it.
func TestLaterRoomEventCannotResetTheRetryBudgetForTheSameTurn(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("persistent ACP failure")}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 5*time.Second, func() bool {
		return adapter.sessionsInt() == 1+maxTurnRetryAttempts &&
			log.count("turn_retry_exhausted") == 1
	}, "bounded retry budget consumed")
	exhaustedRuns := adapter.sessionsInt()
	if !rt.turnRecoveryClosed(roomScope, 1) {
		t.Fatal("exhausted canonical turn did not close its autonomous recovery")
	}

	// Two later Room envelopes carry only unaddressed events. They may
	// re-enter the drain, but the exhausted canonical turn must not run again:
	// no extra Harness execution, no extra retry budget, no extra diagnostic.
	stream.results <- addressedEnvelope(roomEvent(2, false))
	stream.results <- addressedEnvelope(roomEvent(3, false))
	waitFor(t, 3*time.Second, func() bool {
		return rt.currentCursor() >= 3
	}, "later unaddressed Room envelopes ingested")
	time.Sleep(200 * time.Millisecond)
	if got := adapter.sessionsInt(); got != exhaustedRuns {
		t.Fatalf("unrelated later Room traffic re-executed the exhausted turn: %d Harness turns", got)
	}
	if got := log.count("turn_started"); got != exhaustedRuns {
		t.Fatalf("unrelated later Room traffic started another turn: %d turn_started", got)
	}
	if got := log.count("retry_scheduled"); got != maxTurnRetryAttempts {
		t.Fatalf("unrelated later Room traffic re-armed the retry clock: %d retry_scheduled", got)
	}
	if got := log.count("turn_failed"); got != exhaustedRuns {
		t.Fatalf("unrelated later Room traffic recorded another failure: %d turn_failed", got)
	}
	// The bounded diagnostic contract holds for every attempt so far.
	for _, event := range []string{"turn_started", "turn_failed"} {
		for _, fields := range log.fieldsFor(event) {
			attempt, err := strconv.Atoi(fields["retryAttempt"])
			if err != nil || attempt < 0 || attempt > maxTurnRetryAttempts {
				t.Fatalf("%s reported an out-of-bound retryAttempt: %+v", event, fields)
			}
		}
	}

	// The exhausted turn is never silently acknowledged: it stays pinned with
	// a truthful error/reconnecting state until an explicit recovery boundary.
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("exhausted turn must stay pending and unacknowledged: %v", got)
	}
	if got := rt.deliveredSeq(); got != 0 {
		t.Fatalf("exhausted turn advanced deliveredThrough to %d", got)
	}
	if sent := client.snapshotSent(); len(sent) != 0 {
		t.Fatalf("exhausted turn published a reply: %v", sent)
	}
	if status := rt.Status(); status.LastError == "" || status.State != StateReconnecting {
		t.Fatalf("exhausted turn lost its truthful reconnect state: %+v", status)
	}

	// An explicit recovery boundary — a new addressed trigger for the same
	// scope — re-arms the pinned canonical turn, which is then delivered in
	// FIFO order once the Harness recovers.
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	stream.results <- addressedEnvelope(roomEvent(4, true))
	waitFor(t, 3*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshot()) == 0 && rt.deliveredSeq() == 4 &&
			len(client.snapshotSent()) == 2
	}, "explicit re-address delivered the pinned canonical turn")
	if got := log.count("turn_retry_exhausted"); got != 1 {
		t.Fatalf("re-armed turn reported an extra exhausted budget: %d", got)
	}
	if got := rt.turnRecoveryClosed(roomScope, 1); got {
		t.Fatal("re-armed canonical turn stayed closed after its explicit recovery boundary")
	}
}

// TestPermanentHarnessFailureKeepsTruthfulReconnectingState is the #364 B
// status regression: a permanent, non-retryable Harness failure leaves its
// canonical turn pinned, so the drain's deferred state restoration must not
// overwrite the reported reconnect state with a healthy "waiting".
func TestPermanentHarnessFailureKeepsTruthfulReconnectingState(t *testing.T) {
	adapter := &legacyOnlyAdapter{}
	rt := newTurnRetryRuntime(t, adapter, &fakeClient{}, silentLog)
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.acceptEvent(scopedEvent(1, "task:T", "T1"))
	rt.drainTurns()

	status := rt.Status()
	if status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("permanent Harness failure did not report a truthful reconnect state: %+v", status)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("permanent Harness failure acknowledged its canonical turn: %v", got)
	}
	if adapter.ensureCalls != 0 || adapter.runCalls != 0 {
		t.Fatalf("legacy adapter reached a task-scope turn: ensure=%d run=%d", adapter.ensureCalls, adapter.runCalls)
	}
	if !rt.turnRecoveryClosed("task:T", 1) {
		t.Fatal("permanent Harness failure left its autonomous recovery open")
	}

	// Unrelated later Room traffic must neither re-execute the permanently
	// failed canonical turn nor downgrade the truthful state to waiting.
	rt.acceptEvent(roomEvent(2, false))
	rt.drainTurns()
	status = rt.Status()
	if status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("unrelated Room traffic downgraded the permanent failure state: %+v", status)
	}
	if adapter.ensureCalls != 0 || adapter.runCalls != 0 {
		t.Fatalf("unrelated Room traffic re-executed the permanently failed turn: ensure=%d run=%d", adapter.ensureCalls, adapter.runCalls)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("permanently failed turn was silently acknowledged: %v", got)
	}
	if !rt.turnRecoveryClosed("task:T", 1) {
		t.Fatal("unrelated Room traffic reopened a permanently closed recovery")
	}

	// A transport rejoin is not an explicit recovery boundary either: it must
	// not downgrade the parked turn's truthful state.
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent-2", ParticipantHandle: "secret-2", Cursor: 10})
	status = rt.Status()
	if status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("transport rejoin downgraded the permanent failure state: %+v", status)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("transport rejoin acknowledged the parked turn: %v", got)
	}
}

// TestTransportRetryKeepsPermanentHarnessFailureReconnecting covers the other
// state restoration point: the resident transport reconnect/back-off must not
// downgrade a permanent Harness failure back to a healthy waiting state.
func TestTransportRetryKeepsPermanentHarnessFailureReconnecting(t *testing.T) {
	first := newResidentTestStream()
	second := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 2),
	}
	client.streams <- first
	client.streams <- second
	adapter := &legacyOnlyAdapter{}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-permanent-failure",
		RoomID:     "room-permanent-failure",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()
	waitFor(t, 3*time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream open")

	// A task-scope addressed trigger fails permanently and parks its turn.
	first.results <- addressedEnvelope(scopedEvent(1, "task:T", "T1"))
	waitFor(t, 3*time.Second, func() bool {
		return rt.turnRecoveryClosed("task:T", 1)
	}, "permanent Harness failure parked its canonical turn")

	// The transport then drops; the reconnect back-off restores local state.
	if err := first.Close(); err != nil {
		t.Fatalf("close resident stream: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open >= 2
	}, "resident reconnect after transport loss")
	if status := rt.Status(); status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("transport recovery downgraded a permanent Harness failure: %+v", status)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("transport recovery acknowledged the parked turn: %v", got)
	}
	if adapter.runCalls != 0 {
		t.Fatalf("transport recovery ran the unsupported task turn: %d", adapter.runCalls)
	}
}

// TestClosedTurnRecoveryDoesNotBlockAnotherScope proves a canonical turn whose
// autonomous recovery is closed parks only its own scope: it is never
// re-executed, but a different scope's fresh addressed work still runs.
func TestClosedTurnRecoveryDoesNotBlockAnotherScope(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", turnErr: &harness.TurnTimeoutError{TimeoutMs: 120_000}}
	rt := newTurnRetryRuntime(t, adapter, &fakeClient{}, silentLog)
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.acceptEvent(scopedEvent(1, "task:T", "T1"))

	// Each direct drain entry is one attempt; the third spends the budget.
	for attempt := 0; attempt < 1+maxTurnRetryAttempts; attempt++ {
		rt.drainTurns()
	}
	if !rt.turnRecoveryClosed("task:T", 1) {
		t.Fatal("exhausted task turn did not close its autonomous recovery")
	}
	runs, _ := adapter.scopedRunSnapshot()
	if len(runs) != 1+maxTurnRetryAttempts {
		t.Fatalf("unexpected bounded attempt count: %v", runs)
	}

	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.acceptEvent(scopedEvent(2, "task:U", "U1"))
	rt.drainTurns()

	runs, details := adapter.scopedRunSnapshot()
	if len(runs) != 1+maxTurnRetryAttempts+1 || runs[len(runs)-1] != "task:U" {
		t.Fatalf("closed task scope blocked or re-ran another scope: %v", runs)
	}
	if !reflect.DeepEqual(details["task:U"], []string{"U1"}) {
		t.Fatalf("other scope received the wrong delta: %#v", details["task:U"])
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("closed task turn was silently acknowledged: %v", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:U"); len(got) != 0 {
		t.Fatalf("fresh task work was not delivered: %v", got)
	}
	if got := rt.deliveredSeqFor("task:U"); got != 2 {
		t.Fatalf("fresh task scope did not advance its own delivery: %d", got)
	}
	if got := rt.deliveredSeqFor("task:T"); got != 0 {
		t.Fatalf("closed task scope advanced delivery: %d", got)
	}
	// The parked turn keeps the resident truthful while the other scope
	// made progress.
	if status := rt.Status(); status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("closed recovery lost its truthful reconnect state: %+v", status)
	}
}

// TestExplicitReAddressThenSuccessLeavesNoStaleClosedRecovery is the
// stale-truthful-state regression for the closed-recovery lifecycle: exhaustion
// parks a turn, an explicit same-scope re-address reopens it, the successful
// recovery deletes the last marker, and a later transport rejoin must then
// report the healthy waiting state. Branching on the marker map's non-nilness
// instead of its emptiness reported a stale "reconnecting" here, because the
// drained map is never reset to nil.
func TestExplicitReAddressThenSuccessLeavesNoStaleClosedRecovery(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", turnErr: &harness.TurnTimeoutError{TimeoutMs: 120_000}}
	rt := newTurnRetryRuntime(t, adapter, &fakeClient{}, silentLog)
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.acceptEvent(roomEvent(1, true))

	// Each direct drain entry is one attempt; the third spends the bounded
	// budget and parks the canonical turn.
	for attempt := 0; attempt < 1+maxTurnRetryAttempts; attempt++ {
		rt.drainTurns()
	}
	if !rt.turnRecoveryClosed(roomScope, 1) {
		t.Fatal("exhausted canonical turn did not close its autonomous recovery")
	}
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("parked canonical turn was silently acknowledged: %v", got)
	}

	// Step 2: an explicit same-scope re-address reopens the parked turn. The
	// Harness has recovered, so both the pinned turn and the new trigger are
	// delivered in FIFO order.
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()

	// Step 3: the successful recovery is complete BEFORE any rejoin — the
	// delivery markers advanced, no closed marker survives for a settled turn,
	// and the runtime already reports itself healthy.
	if got := rt.pendingAddressedSnapshot(); len(got) != 0 {
		t.Fatalf("explicit re-address did not deliver the pinned turn: %v", got)
	}
	if got := rt.deliveredSeq(); got != 2 {
		t.Fatalf("successful recovery advanced delivery to %d, want 2", got)
	}
	if rt.turnRecoveryClosed(roomScope, 1) {
		t.Fatal("delivered canonical turn kept a closed-recovery marker")
	}
	markers := closedTurnRecoverySnapshot(rt)
	if len(markers) != 0 {
		t.Fatalf("closed-recovery marker count = %d, want 0: %+v", len(markers), markers)
	}
	// A surviving marker would only be legitimate while its canonical turn is
	// still genuinely parked (unacknowledged).
	for _, key := range markers {
		if !containsSequence(rt.pendingAddressedSnapshotFor(key.scope), key.target) {
			t.Fatalf("closed-recovery marker outlived its settled turn: %+v", key)
		}
	}
	if status := rt.Status(); status.State != StateWaiting || status.LastError != "" {
		t.Fatalf("successful recovery left a stale local state: %+v", status)
	}

	// Step 4: a transport rejoin is not an explicit recovery boundary, but the
	// runtime holds no unresolved work any more, so it must report a healthy
	// waiting state with no resurrected Harness error.
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent-2", ParticipantHandle: "secret-2", Cursor: 10})
	status := rt.Status()
	if status.State != StateWaiting {
		t.Fatalf("transport rejoin after recovery reported State:%s, want %s", status.State, StateWaiting)
	}
	if status.LastError != "" {
		t.Fatalf("transport rejoin resurrected a stale Harness error: %+v", status)
	}

	// A genuinely still-parked turn must keep the truthful reconnect state:
	// the condition is unresolved work, not "never reconnecting again".
	adapter.mu.Lock()
	adapter.turnErr = &harness.TurnTimeoutError{TimeoutMs: 120_000}
	adapter.mu.Unlock()
	rt.acceptEvent(scopedEvent(3, "task:T", "T1"))
	for attempt := 0; attempt < 1+maxTurnRetryAttempts; attempt++ {
		rt.drainTurns()
	}
	parkedMarkers := closedTurnRecoverySnapshot(rt)
	if len(parkedMarkers) != 1 || parkedMarkers[0] != (canonicalTurnKey{scope: "task:T", target: 3}) {
		t.Fatalf("still-parked scope has the wrong marker set: %+v", parkedMarkers)
	}
	for _, key := range parkedMarkers {
		if !containsSequence(rt.pendingAddressedSnapshotFor(key.scope), key.target) {
			t.Fatalf("closed-recovery marker outlived its settled turn: %+v", key)
		}
	}
	if !rt.turnRecoveryClosed("task:T", 3) || rt.turnRecoveryClosed(roomScope, 2) {
		t.Fatalf("marker set does not match the genuinely parked turn: %+v", parkedMarkers)
	}
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent-3", ParticipantHandle: "secret-3", Cursor: 11})
	if status := rt.Status(); status.State != StateReconnecting || status.LastError == "" {
		t.Fatalf("a still-parked turn lost its truthful reconnect state: %+v", status)
	}
}

// closedTurnRecoverySnapshot returns the canonical turns whose autonomous
// recovery is still closed. It reports the marker set itself (not the map's
// non-nilness), so an empty-but-non-nil map is observed as empty.
func closedTurnRecoverySnapshot(rt *ResidentRuntime) []canonicalTurnKey {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	markers := make([]canonicalTurnKey, 0, len(rt.closedTurnRecovery))
	for key := range rt.closedTurnRecovery {
		markers = append(markers, key)
	}
	return markers
}

// TestRetryAfterHarnessSessionReplacementRebootstrapsThePinnedDelta proves the
// bounded retry keeps ACP generation semantics safe: when the failed turn's
// recovery replaced the Harness session, the retry is a real session/new that
// bootstraps with the same unacknowledged delta.
func TestRetryAfterHarnessSessionReplacementRebootstrapsThePinnedDelta(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("transient ACP failure")}
	var captured []types.HarnessTurnInput
	originalHook := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = originalHook }()
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	rt.turnRetryDelay = func(int) time.Duration { return 200 * time.Millisecond }
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 3*time.Second, func() bool {
		return adapter.sessionsInt() == 1 && log.count("turn_failed") == 1
	}, "first failed attempt")
	// A timeout-recovery style replacement happens before the retry fires.
	adapter.recreateSession()
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()

	waitFor(t, 3*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshot()) == 0 && len(client.snapshotSent()) == 1
	}, "retry delivered the pinned delta into the replacement session")
	if len(captured) != 2 {
		t.Fatalf("expected two Harness turns, got %d", len(captured))
	}
	if !captured[1].Session.New {
		t.Fatalf("retry into a replaced session must re-bootstrap: %#v", captured[1].Session)
	}
	if len(captured[1].Events) != 1 || captured[1].Events[0].Sequence != 1 {
		t.Fatalf("retry lost the pinned delta: %#v", captured[1].Events)
	}
}

// TestTaskScopeRetryPreservesScopeAndCorrelation proves a Task-scoped turn
// never falls back to Room scope and keeps its canonical request correlation.
func TestTaskScopeRetryPreservesScopeAndCorrelation(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: &harness.TurnTimeoutError{TimeoutMs: 120_000}}
	rt := newTurnRetryRuntime(t, adapter, client, silentLog)
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	request := scopedEvent(1, "task:request-T", "Build the Live View")
	request.Type = "action"
	request.Participant = types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman}
	request.Collab = &types.WireCollabEvent{
		RequestID:           "request-T",
		Kind:                types.CollabRequest,
		FromParticipantID:   "human",
		TargetParticipantID: rt.currentParticipantID(),
	}
	stream.results <- addressedEnvelope(request)

	waitFor(t, 5*time.Second, func() bool {
		runs, _ := adapter.scopedRunSnapshot()
		return len(runs) == 1+maxTurnRetryAttempts
	}, "task-scope bounded retry budget consumed")

	runs, details := adapter.scopedRunSnapshot()
	if len(runs) != 1+maxTurnRetryAttempts {
		t.Fatalf("unexpected task-scope run count: %v", runs)
	}
	for scope := range details {
		if scope != "task:request-T" {
			t.Fatalf("task retry changed logical scope: %q", scope)
		}
	}
	if got := adapter.sessionsInt(); got != 0 {
		t.Fatalf("task retry fell back to the Room conversation: %d room turns", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:request-T"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("failed task turn was acknowledged: %v", got)
	}
	responses := client.snapshotCollabResponses()
	if len(responses) == 0 {
		t.Fatal("task turn never published its canonical acceptance")
	}
	for _, response := range responses {
		if response.RequestID != "request-T" {
			t.Fatalf("task retry lost canonical request correlation: %+v", response)
		}
	}
	if sent := client.snapshotSent(); len(sent) != 0 {
		t.Fatalf("failed task turns must not publish a reply: %v", sent)
	}
}

// TestSendFailureAfterCognitionDoesNotReplayHarnessTurn proves the
// acknowledgement boundary: a send failure after a successful RunTurn must
// never replay Harness cognition, and must not arm the retry clock.
func TestSendFailureAfterCognitionDoesNotReplayHarnessTurn(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	client.fakeClient.sendFailuresRemaining = 1
	adapter := &fakeAdapter{name: "pi"}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 3*time.Second, func() bool {
		return adapter.sessionsInt() == 1 && log.count("turn_failed") == 1
	}, "send failure recorded")
	time.Sleep(150 * time.Millisecond)

	if got := adapter.sessionsInt(); got != 1 {
		t.Fatalf("send failure replayed Harness cognition: %d turns", got)
	}
	if got := log.count("retry_scheduled"); got != 0 {
		t.Fatalf("send failure armed a cognition retry: %d retry_scheduled", got)
	}
	if got := log.count("turn_succeeded"); got != 1 {
		t.Fatalf("successful cognition must still be recorded once, got %d", got)
	}
	if got := len(rt.pendingAddressedSnapshot()); got != 0 || rt.deliveredSeq() != 1 {
		t.Fatalf("successful cognition was not acknowledged exactly once: pending=%d delivered=%d", got, rt.deliveredSeq())
	}
	failures := log.fieldsFor("turn_failed")
	if len(failures) != 1 || failures[0]["failureClass"] != "send" {
		t.Fatalf("send failure was not classified: %+v", failures)
	}
}

// TestStopCancelsTheArmedTurnRetryClock proves stop/leave cancels the pending
// retry cleanly instead of leaving a timer to fire after teardown.
func TestStopCancelsTheArmedTurnRetryClock(t *testing.T) {
	client, stream := newResidentTurnRetryClient(t)
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("persistent ACP failure")}
	rt := newTurnRetryRuntime(t, adapter, client, silentLog)
	// A long delay keeps the clock armed and sleeping while Stop runs.
	rt.turnRetryDelay = func(int) time.Duration { return 10 * time.Second }
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}

	stream.results <- addressedEnvelope(roomEvent(1, true))
	waitFor(t, 3*time.Second, func() bool {
		return adapter.sessionsInt() == 1
	}, "first failed attempt")

	stopped := make(chan struct{})
	go func() {
		rt.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not cancel the armed retry clock")
	}
	if got := adapter.sessionsInt(); got != 1 {
		t.Fatalf("retry ran after stop: %d Harness turns", got)
	}
	if status := rt.Status(); status.State != StateStopped {
		t.Fatalf("stopped runtime reported %q", status.State)
	}
}

// TestTurnDiagnosticsAreBoundedAndSecretFree pins the #364 C contract: the
// event sequence is locally reconstructable, every field is bounded, and no
// log line carries Room text, prompt content, paths, credentials, or
// participant/request identifiers.
func TestTurnDiagnosticsAreBoundedAndSecretFree(t *testing.T) {
	const messageSentinel = "SENTINEL-ROOM-MESSAGE-TEXT"
	client, stream := newResidentTurnRetryClient(t)
	attempts := 0
	adapter := &fakeAdapter{name: "pi", turnErr: &harness.TurnTimeoutError{TimeoutMs: 120_000}}
	// The scoped turn path uses the scoped hook; the first attempt fails with
	// the ACP timeout and the retry succeeds.
	adapter.scopedRunHook = func(string) {
		attempts++
		if attempts > 1 {
			adapter.mu.Lock()
			adapter.turnErr = nil
			adapter.mu.Unlock()
		}
	}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, client, log.log)
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer rt.Stop()

	event := scopedEvent(1, "task:request-SECRET", messageSentinel)
	event.Type = "action"
	event.Participant = types.ParticipantIdentity{ID: "human-SECRET", Name: "Ada-SECRET", Kind: types.KindHuman}
	event.Collab = &types.WireCollabEvent{
		RequestID:           "request-SECRET",
		Kind:                types.CollabRequest,
		FromParticipantID:   "human-SECRET",
		TargetParticipantID: rt.currentParticipantID(),
	}
	stream.results <- addressedEnvelope(event)

	waitFor(t, 5*time.Second, func() bool {
		return log.count("turn_succeeded") == 1 && len(rt.pendingAddressedSnapshotFor("task:request-SECRET")) == 0
	}, "timeout then successful retry")

	events, fields := log.snapshot()
	// The turn diagnostics are the bounded sequence this contract owns;
	// unrelated pre-existing events (message_persisted) stay separate.
	diagnosticEvents := map[string]bool{
		"turn_started": true, "turn_failed": true, "turn_succeeded": true,
		"retry_scheduled": true, "retry_started": true, "turn_retry_exhausted": true,
		"turn_context_unavailable": true,
	}
	turnEvents := make([]string, 0, len(events))
	turnFields := make([]map[string]string, 0, len(fields))
	for index, event := range events {
		if diagnosticEvents[event] {
			turnEvents = append(turnEvents, event)
			turnFields = append(turnFields, fields[index])
		}
	}
	// Expected bounded sequence: started -> failed -> retry_scheduled ->
	// retry_started -> started -> succeeded.
	order := []string{"turn_started", "turn_failed", "retry_scheduled", "retry_started", "turn_started", "turn_succeeded"}
	if len(turnEvents) != len(order) {
		t.Fatalf("diagnostic sequence = %v, want %v", turnEvents, order)
	}
	for index, want := range order {
		if turnEvents[index] != want {
			t.Fatalf("diagnostic event %d = %q, want %q (%v)", index, turnEvents[index], want, turnEvents)
		}
	}

	allowedClasses := map[string]bool{"timeout": true, "process": true, "session": true, "send": true, "other": true}
	for index, field := range turnFields {
		for key, value := range field {
			switch key {
			case "scopeKind":
				if value != "room" && value != "task" {
					t.Fatalf("%s has an out-of-vocabulary scopeKind %q", turnEvents[index], value)
				}
			case "failureClass":
				if !allowedClasses[value] {
					t.Fatalf("%s has an out-of-vocabulary failureClass %q", turnEvents[index], value)
				}
			case "retryAttempt":
				attempt, err := strconv.Atoi(value)
				if err != nil || attempt < 0 || attempt > maxTurnRetryAttempts {
					t.Fatalf("%s has an unbounded retryAttempt %q", turnEvents[index], value)
				}
			case "retryDelayMs":
				delay, err := strconv.Atoi(value)
				if err != nil || delay < 0 || delay > 10_000 {
					t.Fatalf("%s has an unbounded retryDelayMs %q", turnEvents[index], value)
				}
			case "elapsedMs":
				elapsed, err := strconv.Atoi(value)
				if err != nil || elapsed < 0 || elapsed > 600_000 {
					t.Fatalf("%s has an unbounded elapsedMs %q", turnEvents[index], value)
				}
			default:
				t.Fatalf("%s logged unexpected field %q", turnEvents[index], key)
			}
		}
	}
	if turnFields[1]["failureClass"] != turnFailureTimeout {
		t.Fatalf("ACP turn timeout was not classified explicitly: %+v", turnFields[1])
	}
	if turnFields[1]["scopeKind"] != "task" {
		t.Fatalf("task scope kind was not reported: %+v", turnFields[1])
	}
	if turnFields[2]["retryAttempt"] != "1" || turnFields[3]["retryAttempt"] != "1" {
		t.Fatalf("retry accounting mismatch: %+v %+v", turnFields[2], turnFields[3])
	}

	// No work content, path, credential, or identifier may appear anywhere.
	dump := diagnosticDump(t, events, fields)
	for _, secret := range []string{
		messageSentinel, "SECRET", "request-SECRET", "human-SECRET", "Ada-SECRET",
		"secret", "task:request", "/Users/", "participantHandle",
	} {
		if strings.Contains(dump, secret) {
			t.Fatalf("diagnostics leaked %q:\n%s", secret, dump)
		}
	}
}

func diagnosticDump(t *testing.T, events []string, fields []map[string]string) string {
	t.Helper()
	var builder strings.Builder
	for index, event := range events {
		builder.WriteString(event)
		for key, value := range fields[index] {
			builder.WriteString(" " + key + "=" + value)
		}
		builder.WriteString("\n")
	}
	return builder.String()
}

// TestTurnFailureClassesAreBounded pins the stable classification vocabulary.
func TestTurnFailureClassesAreBounded(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"timeout", &harness.TurnTimeoutError{TimeoutMs: 120_000}, turnFailureTimeout},
		{"wrapped timeout", fmt.Errorf("outer: %w", &harness.TurnTimeoutError{TimeoutMs: 120_000}), turnFailureTimeout},
		{"process", &harness.ProcessError{Err: errors.New("ACP process exited")}, turnFailureProcess},
		{"wrapped process", fmt.Errorf("outer: %w", &harness.ProcessError{Err: errors.New("ACP process exited")}), turnFailureProcess},
		{"session", types.ErrHarnessSessionGenerationChanged, turnFailureSession},
		{"scoped session", errScopedHarnessUnsupported, turnFailureSession},
		{"other", errors.New("ambiguous"), turnFailureOther},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := turnFailureClassOf(testCase.err); got != testCase.want {
				t.Fatalf("turnFailureClassOf(%v) = %q, want %q", testCase.err, got, testCase.want)
			}
		})
	}
	if !permanentTurnFailure(errScopedHarnessUnsupported) {
		t.Fatal("a legacy adapter that cannot serve a task scope must not be retried")
	}
	if permanentTurnFailure(&harness.TurnTimeoutError{TimeoutMs: 1}) {
		t.Fatal("a transient timeout must stay retryable")
	}
}

// TestLegacyAdapterTaskScopeDoesNotArmTheRetryClock keeps the bounded retry
// from retrying a deterministic misconfiguration.
func TestLegacyAdapterTaskScopeDoesNotArmTheRetryClock(t *testing.T) {
	adapter := &legacyOnlyAdapter{}
	log := &turnLogRecorder{}
	rt := newTurnRetryRuntime(t, adapter, &fakeClient{}, log.log)
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.acceptEvent(scopedEvent(1, "task:T", "T1"))
	rt.drainTurns()
	if got := log.count("retry_scheduled"); got != 0 {
		t.Fatalf("permanent misconfiguration armed %d retries", got)
	}
	if got := log.count("turn_retry_exhausted"); got != 0 {
		t.Fatalf("permanent misconfiguration reported a retry budget: %d", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); len(got) != 1 {
		t.Fatalf("unretryable task turn was acknowledged: %v", got)
	}
}
