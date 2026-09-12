package runtime

import (
	"errors"
	"fmt"
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
// belongs to the canonical (scope, sequence) turn: later Room events may try
// the pending turn again, but they can never grant a fresh autonomous retry
// budget to the same still-pending turn.
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
		return adapter.sessionsInt() == 1+maxTurnRetryAttempts
	}, "bounded retry budget consumed")

	// Two later Room envelopes carry only unaddressed events. Each one may
	// re-enter the drain, but the same still-pending canonical turn gets no
	// further autonomous retry clock.
	stream.results <- addressedEnvelope(roomEvent(2, false))
	stream.results <- addressedEnvelope(roomEvent(3, false))
	waitFor(t, 3*time.Second, func() bool {
		return adapter.sessionsInt() == 3+maxTurnRetryAttempts
	}, "each later Room event attempts the pending turn at most once")
	time.Sleep(150 * time.Millisecond)
	if got := adapter.sessionsInt(); got != 3+maxTurnRetryAttempts {
		t.Fatalf("a later Room event reset the retry budget: %d Harness turns", got)
	}
	if got := log.count("retry_scheduled"); got != maxTurnRetryAttempts {
		t.Fatalf("later Room events re-armed the retry clock: %d retry_scheduled", got)
	}

	// The pinned canonical turn is still deliverable through its normal
	// trigger path once the Harness recovers.
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	stream.results <- addressedEnvelope(roomEvent(4, false))
	waitFor(t, 3*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshot()) == 0 && rt.deliveredSeq() == 1 &&
			len(client.snapshotSent()) == 1
	}, "recovered Harness delivered the pinned canonical turn once")
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
