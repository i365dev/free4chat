package runtime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/types"
)

type participantTransportStartResult struct {
	projection types.RuntimeParticipantTransportProjection
	err        error
}

type scriptedParticipantTransport struct {
	result  participantTransportStartResult
	started chan participantTransportStartResult
	once    sync.Once
	mu      sync.Mutex
	closes  int
}

type scriptedUpdatableParticipantTransport struct {
	*scriptedParticipantTransport
	updates       chan types.RuntimeParticipantTransportProjection
	updateResults chan error
}

func newScriptedParticipantTransport(err error) *scriptedParticipantTransport {
	return &scriptedParticipantTransport{
		result:  participantTransportStartResult{err: err},
		started: make(chan participantTransportStartResult, 1),
	}
}

func newScriptedUpdatableParticipantTransport(err error) *scriptedUpdatableParticipantTransport {
	return &scriptedUpdatableParticipantTransport{
		scriptedParticipantTransport: newScriptedParticipantTransport(err),
		updates:                      make(chan types.RuntimeParticipantTransportProjection, 4),
		updateResults:                make(chan error, 16),
	}
}

func (t *scriptedParticipantTransport) Start(_ context.Context, projection types.RuntimeParticipantTransportProjection) error {
	t.once.Do(func() {
		t.started <- participantTransportStartResult{projection: projection, err: t.result.err}
	})
	return t.result.err
}

func (t *scriptedParticipantTransport) Close() {
	t.mu.Lock()
	t.closes++
	t.mu.Unlock()
}

func (t *scriptedParticipantTransport) closeCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closes
}

func (t *scriptedParticipantTransport) startResults() <-chan participantTransportStartResult {
	return t.started
}

func (t *scriptedUpdatableParticipantTransport) Update(_ context.Context, projection types.RuntimeParticipantTransportProjection) error {
	t.updates <- projection
	select {
	case err := <-t.updateResults:
		return err
	default:
		return nil
	}
}

func awaitParticipantTransportUpdate(t *testing.T, transport *scriptedUpdatableParticipantTransport) types.RuntimeParticipantTransportProjection {
	t.Helper()
	select {
	case projection := <-transport.updates:
		return projection
	case <-time.After(2 * time.Second):
		t.Fatal("participant transport update did not run")
		return types.RuntimeParticipantTransportProjection{}
	}
}

func participantTransportTestProjection(humanID, sessionID string) types.RuntimeParticipantTransportProjection {
	return types.RuntimeParticipantTransportProjection{
		Routes: []types.RuntimeParticipantTransportRoute{{
			AppInstanceID:      "generated:123e4567-e89b-12d3-a456-426614174000",
			BundleRevision:     1,
			TaskRequestID:      "task-origin",
			AgentParticipantID: "agent-a",
			HumanParticipantID: humanID,
			RuntimeHostID:      "11111111-2222-3333-4444-555555555555",
			CapabilityIDs:      []string{"printer_status"},
		}},
		Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: humanID, SessionID: sessionID}},
	}
}

func configureParticipantTransportRuntime(t *testing.T, rt *ResidentRuntime, delay time.Duration) {
	t.Helper()
	rt.options.CapabilityHandler = reconnectParticipantCapabilityHandler{}
	rt.options.SiteOrigin = "https://example.invalid"
	rt.participantTransportRetryDelay = func(int) time.Duration { return delay }
	rt.mu.Lock()
	rt.participantID = "agent-a"
	rt.participantHandle = "eyJyb29tIjoicm9vbSIsInBhcnRpY2lwYW50SWQiOiJhZ2VudC1hIiwicGFydGljaXBhbnRUb2tlbiI6InRlc3QtdG9rZW4ifQ"
	rt.mu.Unlock()
}

func awaitParticipantTransportStart(t *testing.T, transport interface {
	startResults() <-chan participantTransportStartResult
}) participantTransportStartResult {
	t.Helper()
	select {
	case result := <-transport.startResults():
		return result
	case <-time.After(2 * time.Second):
		t.Fatal("participant transport did not start")
		return participantTransportStartResult{}
	}
}

func hasParticipantTransportDiagnostic(
	logs *turnLogRecorder,
	transition string,
	generation string,
) bool {
	for _, fields := range logs.fieldsFor("runtime_participant_transport_diagnostic") {
		if fields["transition"] == transition &&
			fields["projection_generation"] == generation {
			return true
		}
	}
	return false
}

func TestParticipantTransportRetriesSameProjectionWithoutRoomEnvelope(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 10*time.Millisecond)
	defer rt.Stop()

	first := newScriptedParticipantTransport(errors.New("transient signaling failure"))
	second := newScriptedParticipantTransport(nil)
	transports := []*scriptedParticipantTransport{first, second}
	var mu sync.Mutex
	var factoryCalls int
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		mu.Lock()
		defer mu.Unlock()
		factoryCalls++
		if factoryCalls > len(transports) {
			t.Error("participant transport retry created an unexpected transport")
			return nil
		}
		return transports[factoryCalls-1]
	}

	projection := participantTransportTestProjection("human-a", "session-a")
	rt.observeRuntimeParticipantTransport(projection)
	if got := awaitParticipantTransportStart(t, first); got.err == nil {
		t.Fatal("first transport Start unexpectedly succeeded")
	}
	if got := awaitParticipantTransportStart(t, second); got.err != nil {
		t.Fatalf("retry Start failed: %v", got.err)
	} else if got.projection.Routes[0].HumanParticipantID != "human-a" {
		t.Fatalf("retry used a different projection: %+v", got.projection)
	}

	rt.mu.Lock()
	current := rt.participantTransport
	rt.mu.Unlock()
	if current != second {
		t.Fatal("successful retry did not retain exactly one current transport")
	}
	mu.Lock()
	defer mu.Unlock()
	if factoryCalls != 2 {
		t.Fatalf("transport factory calls = %d, want exactly 2", factoryCalls)
	}
}

func TestParticipantTransportEmptyProjectionTearsDownAndRestoredProjectionRestarts(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 10*time.Millisecond)
	defer rt.Stop()
	logs := &turnLogRecorder{}
	rt.log = logs.log

	first := newScriptedUpdatableParticipantTransport(nil)
	second := newScriptedUpdatableParticipantTransport(nil)
	transports := []*scriptedUpdatableParticipantTransport{first, second}
	factoryCalls := 0
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		factoryCalls++
		if factoryCalls > len(transports) {
			t.Error("projection recovery created an unexpected transport")
			return nil
		}
		return transports[factoryCalls-1]
	}

	initial := participantTransportTestProjection("human-a", "session-a")
	rt.observeRuntimeParticipantTransport(initial)
	if got := awaitParticipantTransportStart(t, first); got.err != nil {
		t.Fatalf("generation 1 Start failed: %v", got.err)
	}
	waitFor(t, time.Second, func() bool {
		return hasParticipantTransportDiagnostic(logs, "start_succeeded", "1")
	}, "generation 1 start success")

	// A Human refresh temporarily removes the last eligible source. The empty
	// projection must retire the old transport and leave a clear diagnostic.
	rt.observeRuntimeParticipantTransport(types.RuntimeParticipantTransportProjection{})
	if got := first.closeCount(); got != 1 {
		t.Fatalf("empty projection closed transport %d times, want 1", got)
	}
	rt.mu.Lock()
	current, started := rt.participantTransport, rt.participantTransportStarted
	rt.mu.Unlock()
	if current != nil || started {
		t.Fatalf("empty projection retained transport: current=%v started=%v", current != nil, started)
	}

	restored := participantTransportTestProjection("human-a", "session-b")
	rt.observeRuntimeParticipantTransport(restored)
	if got := awaitParticipantTransportStart(t, second); got.err != nil {
		t.Fatalf("restored generation Start failed: %v", got.err)
	}
	waitFor(t, time.Second, func() bool {
		return hasParticipantTransportDiagnostic(logs, "start_succeeded", "3")
	}, "restored generation start success")
	rt.mu.Lock()
	current, started = rt.participantTransport, rt.participantTransportStarted
	rt.mu.Unlock()
	if current != second || !started || factoryCalls != 2 {
		t.Fatalf("restored projection did not start a fresh transport: current=%v started=%v factoryCalls=%d", current == second, started, factoryCalls)
	}

	changed := logs.fieldsFor("runtime_participant_transport_diagnostic")
	var generationDecisions []map[string]string
	for _, fields := range changed {
		if fields["transition"] == "projection_generation_changed" {
			generationDecisions = append(generationDecisions, fields)
		}
	}
	if len(generationDecisions) != 3 {
		t.Fatalf("projection generation diagnostics = %d, want 3", len(generationDecisions))
	}
	if got := generationDecisions[1]; got["projection_generation"] != "2" || got["route_count"] != "0" || got["source_count"] != "0" || got["decision"] != "teardown_empty" || got["old_transport_present"] != "true" || got["old_transport_started"] != "true" {
		t.Fatalf("empty generation diagnostic = %#v", got)
	}
	if got := generationDecisions[2]; got["projection_generation"] != "3" || got["route_count"] != "1" || got["source_count"] != "1" || got["decision"] != "restart_new" || got["old_transport_present"] != "false" || got["old_transport_started"] != "false" {
		t.Fatalf("restored generation diagnostic = %#v", got)
	}
	for _, eventFields := range changed {
		for _, value := range eventFields {
			for _, forbidden := range []string{"human-a", "session-a", "session-b", "agent-a"} {
				if strings.Contains(value, forbidden) {
					t.Fatalf("transport diagnostics leaked %q in %q", forbidden, value)
				}
			}
		}
	}
}

func TestParticipantTransportUpdateSupersededBeforeStartIsDiagnosed(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	logs := &turnLogRecorder{}
	rt.log = logs.log
	transport := newScriptedUpdatableParticipantTransport(nil)
	projection := participantTransportTestProjection("human-a", "session-a")

	rt.updateRuntimeParticipantTransport(
		transport,
		transport,
		projection,
		"superseded-signature",
		9,
	)

	fields := logs.fieldsFor("runtime_participant_transport_diagnostic")
	if len(fields) != 1 {
		t.Fatalf("diagnostic events = %d, want 1", len(fields))
	}
	if fields[0]["transition"] != "update_superseded_before_start" || fields[0]["projection_generation"] != "9" || fields[0]["route_count"] != "1" || fields[0]["source_count"] != "1" || fields[0]["decision"] != "update_existing" {
		t.Fatalf("superseded update diagnostic = %#v", fields[0])
	}
	if got := len(transport.updates); got != 0 {
		t.Fatalf("superseded update reached transport; update calls = %d", got)
	}
}

func TestParticipantTransportProjectionUpdatesExistingTransportInPlace(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 10*time.Millisecond)
	defer rt.Stop()
	transport := newScriptedUpdatableParticipantTransport(nil)
	factoryCalls := 0
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		factoryCalls++
		return transport
	}
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial transport Start failed: %v", got.err)
	}
	next := participantTransportTestProjection("human-a", "session-a")
	next.Routes[0].BundleRevision = 2
	next.Routes = append(next.Routes, types.RuntimeParticipantTransportRoute{
		AppInstanceID: next.Routes[0].AppInstanceID, BundleRevision: 2,
		TaskRequestID: next.Routes[0].TaskRequestID, AgentParticipantID: "agent-a",
		HumanParticipantID: "human-b", RuntimeHostID: next.Routes[0].RuntimeHostID,
		CapabilityIDs: []string{"printer_status"},
	})
	next.Sources = append(next.Sources, types.RuntimeParticipantTransportSource{ParticipantID: "human-b", SessionID: "session-b"})
	rt.observeRuntimeParticipantTransport(next)
	select {
	case updated := <-transport.updates:
		if len(updated.Routes) != 2 || len(updated.Sources) != 2 || updated.Routes[1].HumanParticipantID != "human-b" {
			t.Fatalf("existing transport received incomplete projection: %+v", updated)
		}
	case <-time.After(time.Second):
		t.Fatal("late Human projection did not update the current transport")
	}
	rt.mu.Lock()
	current := rt.participantTransport
	rt.mu.Unlock()
	if current != transport || factoryCalls != 1 {
		t.Fatalf("projection update restarted transport: current=%T factoryCalls=%d", current, factoryCalls)
	}

	// A Human reconnect receives a fresh Room-projected SFU session while the
	// originating Runtime transport remains active. The new source must reach
	// the current transport so it can negotiate a replacement private pair.
	reconnected := next
	reconnected.Sources = append([]types.RuntimeParticipantTransportSource(nil), next.Sources...)
	reconnected.Sources[1].SessionID = "session-b-reconnected"
	rt.observeRuntimeParticipantTransport(reconnected)
	select {
	case updated := <-transport.updates:
		if len(updated.Sources) != 2 || updated.Sources[1].SessionID != "session-b-reconnected" {
			t.Fatalf("reconnected Human session did not update the current transport: %+v", updated.Sources)
		}
	case <-time.After(time.Second):
		t.Fatal("reconnected Human projection did not update the current transport")
	}
	rt.mu.Lock()
	current = rt.participantTransport
	rt.mu.Unlock()
	if current != transport || factoryCalls != 1 {
		t.Fatalf("reconnect restarted the participant transport: current=%T factoryCalls=%d", current, factoryCalls)
	}
}

func TestUnchangedParticipantTransportProjectionDoesNotUpdateOrReplaceTransport(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 10*time.Millisecond)
	defer rt.Stop()
	transport := newScriptedUpdatableParticipantTransport(nil)
	factoryCalls := 0
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		factoryCalls++
		return transport
	}
	projection := participantTransportTestProjection("human-a", "session-a")
	rt.observeRuntimeParticipantTransport(projection)
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial participant transport Start failed: %v", got.err)
	}

	// The Room projection contract has no Generated App stateRevision field;
	// when Room recomputes the same projection after an App state write, the
	// Runtime JSON signature remains identical and no media update is needed.
	rt.observeRuntimeParticipantTransport(projection)
	select {
	case got := <-transport.updates:
		t.Fatalf("unchanged participant transport projection triggered Update: %+v", got)
	case <-time.After(40 * time.Millisecond):
	}
	rt.mu.Lock()
	current := rt.participantTransport
	rt.mu.Unlock()
	if current != transport || factoryCalls != 1 {
		t.Fatalf("unchanged projection replaced transport: current=%T factoryCalls=%d", current, factoryCalls)
	}
}

func TestParticipantTransportUpdateRetriesAutonomouslyWithoutRoomEnvelope(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 10*time.Millisecond)
	defer rt.Stop()
	transport := newScriptedUpdatableParticipantTransport(nil)
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport { return transport }
	initial := participantTransportTestProjection("human-a", "session-a")
	rt.observeRuntimeParticipantTransport(initial)
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial transport Start failed: %v", got.err)
	}
	transport.updateResults <- errors.New("temporary allocation failure")
	lateHuman := participantTransportTestProjection("human-a", "session-a")
	lateHuman.Routes = append(lateHuman.Routes, types.RuntimeParticipantTransportRoute{
		AppInstanceID: lateHuman.Routes[0].AppInstanceID, BundleRevision: 1,
		TaskRequestID: lateHuman.Routes[0].TaskRequestID, AgentParticipantID: "agent-a",
		HumanParticipantID: "human-b", RuntimeHostID: lateHuman.Routes[0].RuntimeHostID,
		CapabilityIDs: []string{"printer_status"},
	})
	lateHuman.Sources = append(lateHuman.Sources, types.RuntimeParticipantTransportSource{ParticipantID: "human-b", SessionID: "session-b"})
	rt.observeRuntimeParticipantTransport(lateHuman)
	if got := awaitParticipantTransportUpdate(t, transport); len(got.Sources) != 2 {
		t.Fatalf("first update projection = %+v, want both Humans", got.Sources)
	}
	if got := awaitParticipantTransportUpdate(t, transport); len(got.Sources) != 2 || got.Sources[1].SessionID != "session-b" {
		t.Fatalf("autonomous retry projection = %+v", got.Sources)
	}
	rt.mu.Lock()
	current := rt.participantTransport
	rt.mu.Unlock()
	if current != transport {
		t.Fatal("successful in-place retry replaced the participant transport")
	}
	select {
	case <-transport.updates:
		t.Fatal("update retried more than once after its successful retry")
	case <-time.After(30 * time.Millisecond):
	}
}

func TestParticipantTransportUpdateRetryIsFencedByNewerProjection(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 80*time.Millisecond)
	defer rt.Stop()
	transport := newScriptedUpdatableParticipantTransport(nil)
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport { return transport }
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial transport Start failed: %v", got.err)
	}
	transport.updateResults <- errors.New("temporary update failure")
	projectionN := participantTransportTestProjection("human-a", "session-a")
	projectionN.Routes[0].BundleRevision = 2
	rt.observeRuntimeParticipantTransport(projectionN)
	_ = awaitParticipantTransportUpdate(t, transport)
	projectionN1 := participantTransportTestProjection("human-a", "session-a")
	projectionN1.Routes[0].BundleRevision = 3
	rt.observeRuntimeParticipantTransport(projectionN1)
	if got := awaitParticipantTransportUpdate(t, transport); got.Routes[0].BundleRevision != 3 {
		t.Fatalf("new projection update = revision %d, want 3", got.Routes[0].BundleRevision)
	}
	time.Sleep(120 * time.Millisecond)
	if got := len(transport.updates); got != 0 {
		t.Fatalf("stale retry crossed the newer projection; queued updates = %d", got)
	}
}

func TestParticipantTransportUpdateRetryStopsAndIsBounded(t *testing.T) {
	t.Run("stops with runtime", func(t *testing.T) {
		rt, _ := newResidentFenceRuntime(t)
		configureParticipantTransportRuntime(t, rt, 40*time.Millisecond)
		transport := newScriptedUpdatableParticipantTransport(nil)
		rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport { return transport }
		rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
		_ = awaitParticipantTransportStart(t, transport)
		transport.updateResults <- errors.New("temporary update failure")
		rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-b", "session-b"))
		_ = awaitParticipantTransportUpdate(t, transport)
		if !rt.beginStop("") {
			t.Fatal("Runtime did not enter stopped state")
		}
		time.Sleep(60 * time.Millisecond)
		if got := len(transport.updates); got != 0 {
			t.Fatalf("update retry ran after Runtime stop; queued updates = %d", got)
		}
		rt.releaseResources()
	})

	t.Run("exhausts after bounded retries", func(t *testing.T) {
		rt, _ := newResidentFenceRuntime(t)
		configureParticipantTransportRuntime(t, rt, time.Millisecond)
		defer rt.Stop()
		transport := newScriptedUpdatableParticipantTransport(nil)
		rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport { return transport }
		rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
		_ = awaitParticipantTransportStart(t, transport)
		for range participantTransportRetryLimit + 1 {
			transport.updateResults <- errors.New("persistent update failure")
		}
		projection := participantTransportTestProjection("human-b", "session-b")
		rt.observeRuntimeParticipantTransport(projection)
		for range participantTransportRetryLimit + 1 {
			_ = awaitParticipantTransportUpdate(t, transport)
		}
		time.Sleep(25 * time.Millisecond)
		if got := len(transport.updates); got != 0 {
			t.Fatalf("retry exceeded configured limit; queued updates = %d", got)
		}
		rt.mu.Lock()
		got := rt.participantTransportRetryCount
		rt.mu.Unlock()
		if got != participantTransportRetryLimit {
			t.Fatalf("retry count = %d, want bounded limit %d", got, participantTransportRetryLimit)
		}
	})
}

func TestParticipantTransportRetryExhaustionAllowsIdenticalProjectionRecovery(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, time.Millisecond)
	defer rt.Stop()
	logs := &turnLogRecorder{}
	rt.log = logs.log
	transport := newScriptedUpdatableParticipantTransport(nil)
	factoryCalls := 0
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		factoryCalls++
		return transport
	}
	h1 := participantTransportTestProjection("human-a", "session-secret-H1")
	rt.observeRuntimeParticipantTransport(h1)
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial H1 Start failed: %v", got.err)
	}
	h2 := participantTransportTestProjection("human-b", "session-secret-H2")
	for range participantTransportRetryLimit + 1 {
		transport.updateResults <- errors.New("raw provider error SECRET-error")
	}
	rt.observeRuntimeParticipantTransport(h2)
	for range participantTransportRetryLimit + 1 {
		_ = awaitParticipantTransportUpdate(t, transport)
	}
	waitFor(t, 2*time.Second, func() bool { return logs.count("runtime_participant_transport_retry_exhausted") == 1 }, "one retry exhaustion diagnostic")

	rt.mu.Lock()
	current, started := rt.participantTransport, rt.participantTransportStarted
	signature, retryCount, timer := rt.participantTransportProjection, rt.participantTransportRetryCount, rt.participantTransportRetryTimer
	rt.mu.Unlock()
	if current != transport || !started || signature != "" || retryCount != participantTransportRetryLimit || timer != nil {
		t.Fatalf("exhaustion changed recovery contract: same=%v started=%v signature=%q retries=%d timer=%v", current == transport, started, signature, retryCount, timer)
	}
	if factoryCalls != 1 || transport.closeCount() != 0 {
		t.Fatalf("exhaustion rebuilt/closed transport: factory calls=%d closes=%d", factoryCalls, transport.closeCount())
	}

	// The identical H2 projection is new after exhaustion clears its signature;
	// it is retried on the original started transport and can recover in place.
	rt.observeRuntimeParticipantTransport(h2)
	if got := awaitParticipantTransportUpdate(t, transport); got.Sources[0].SessionID != "session-secret-H2" {
		t.Fatalf("replay applied unexpected projection: %+v", got)
	}
	waitFor(t, time.Second, func() bool {
		return logs.count("runtime_participant_transport_diagnostic") > 0 && logs.count("runtime_participant_transport_retry_exhausted") == 1
	}, "replayed update")
	rt.mu.Lock()
	current, started = rt.participantTransport, rt.participantTransportStarted
	rt.mu.Unlock()
	if current != transport || !started || factoryCalls != 1 {
		t.Fatalf("identical replay did not recover on same transport: same=%v started=%v factory calls=%d", current == transport, started, factoryCalls)
	}

	_, fields := logs.snapshot()
	exhausted := logs.fieldsFor("runtime_participant_transport_retry_exhausted")
	if len(exhausted) != 1 {
		t.Fatalf("retry exhaustion diagnostics = %d, want exactly one", len(exhausted))
	}
	want := map[string]string{
		"transition": "update_retry_exhausted", "failure_class": "other", "transport_started": "true",
		"recovery_owner": "future_room_projection", "waiting_for_room_projection": "true",
	}
	for key, value := range want {
		if exhausted[0][key] != value {
			t.Errorf("exhaustion field %q = %q, want %q", key, exhausted[0][key], value)
		}
	}
	for _, eventFields := range fields {
		for _, value := range eventFields {
			for _, forbidden := range []string{"session-secret", "SECRET-error", "human-a", "human-b", "agent-a"} {
				if strings.Contains(value, forbidden) {
					t.Fatalf("diagnostics leaked %q in %q", forbidden, value)
				}
			}
		}
	}
}

func TestParticipantTransportUpdateFailureLogsBoundedStageAndProviderClass(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, time.Second)
	defer rt.Stop()
	logs := &turnLogRecorder{}
	rt.log = logs.log
	transport := newScriptedUpdatableParticipantTransport(nil)
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport { return transport }
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-secret-H1"))
	if got := awaitParticipantTransportStart(t, transport); got.err != nil {
		t.Fatalf("initial transport Start failed: %v", got.err)
	}
	transport.updateResults <- &media.ParticipantTransportFailure{
		Class:              media.ParticipantTransportFailureAllocationFailed,
		Stage:              media.ParticipantTransportFailureStageAllocateReplacement,
		ProviderErrorClass: "repeated_local_track_error",
	}
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-b", "session-secret-H2"))
	_ = awaitParticipantTransportUpdate(t, transport)
	waitFor(t, time.Second, func() bool { return logs.count("runtime_participant_transport_update_failed") == 1 }, "bounded update failure diagnostic")
	fields := logs.fieldsFor("runtime_participant_transport_update_failed")
	if len(fields) != 1 {
		t.Fatalf("update failure diagnostics = %d, want one", len(fields))
	}
	want := map[string]string{
		"transition": "update_failed", "failure_class": "allocation_failed",
		"failure_stage": "allocate_replacement", "provider_error_class": "repeated_local_track_error",
	}
	for key, value := range want {
		if fields[0][key] != value {
			t.Errorf("diagnostic %q = %q, want %q", key, fields[0][key], value)
		}
	}
	for _, value := range fields[0] {
		for _, forbidden := range []string{"session-secret", "participant", "private", "description"} {
			if strings.Contains(value, forbidden) {
				t.Fatalf("diagnostic leaked %q in %q", forbidden, value)
			}
		}
	}
}

func TestClassifyParticipantTransportFailureUsesTypedAllowlistOnly(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "allocation", err: &media.ParticipantTransportFailure{Class: media.ParticipantTransportFailureAllocationFailed}, want: "allocation_failed"},
		{name: "ready timeout", err: &media.ParticipantTransportFailure{Class: media.ParticipantTransportFailureChannelReadyTimeout}, want: "channel_ready_timeout"},
		{name: "context", err: context.DeadlineExceeded, want: "context_cancelled"},
		{name: "arbitrary provider text", err: errors.New("session stale SECRET-session"), want: "other"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyParticipantTransportFailure(test.err); got != test.want {
				t.Fatalf("failure class = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParticipantTransportRetryDoesNotCrossProjectionGeneration(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 250*time.Millisecond)
	defer rt.Stop()

	stale := newScriptedUpdatableParticipantTransport(errors.New("transient signaling failure"))
	current := newScriptedParticipantTransport(nil)
	var mu sync.Mutex
	var factoryCalls int
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		mu.Lock()
		defer mu.Unlock()
		factoryCalls++
		if factoryCalls == 1 {
			return stale
		}
		if factoryCalls == 2 {
			return current
		}
		t.Error("stale projection retry started after projection replacement")
		return nil
	}

	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
	if got := awaitParticipantTransportStart(t, stale); got.err == nil {
		t.Fatal("first transport Start unexpectedly succeeded")
	}
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-b", "session-b"))
	if got := awaitParticipantTransportStart(t, current); got.err != nil {
		t.Fatalf("replacement projection Start failed: %v", got.err)
	} else if got.projection.Routes[0].HumanParticipantID != "human-b" {
		t.Fatalf("replacement transport started stale projection: %+v", got.projection)
	}

	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if factoryCalls != 2 {
		t.Fatalf("transport factory calls = %d, want no stale retry", factoryCalls)
	}
	rt.mu.Lock()
	got := rt.participantTransport
	rt.mu.Unlock()
	if got != current {
		t.Fatal("stale retry replaced the current projection transport")
	}
}

func TestParticipantTransportRetryStopsWithRuntime(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 25*time.Millisecond)

	first := newScriptedParticipantTransport(errors.New("transient signaling failure"))
	var mu sync.Mutex
	factoryCalls := 0
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		mu.Lock()
		defer mu.Unlock()
		factoryCalls++
		return first
	}
	rt.observeRuntimeParticipantTransport(participantTransportTestProjection("human-a", "session-a"))
	if got := awaitParticipantTransportStart(t, first); got.err == nil {
		t.Fatal("first transport Start unexpectedly succeeded")
	}
	if !rt.beginStop("") {
		t.Fatal("Runtime did not enter stopped state")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if factoryCalls != 1 {
		t.Fatalf("transport retry ran after Runtime stop; factory calls = %d", factoryCalls)
	}
	rt.releaseResources()
}
