package runtime

import (
	"context"
	"errors"
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
}

func newScriptedParticipantTransport(err error) *scriptedParticipantTransport {
	return &scriptedParticipantTransport{
		result:  participantTransportStartResult{err: err},
		started: make(chan participantTransportStartResult, 1),
	}
}

func (t *scriptedParticipantTransport) Start(_ context.Context, projection types.RuntimeParticipantTransportProjection) error {
	t.once.Do(func() {
		t.started <- participantTransportStartResult{projection: projection, err: t.result.err}
	})
	return t.result.err
}

func (*scriptedParticipantTransport) Close() {}

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

func awaitParticipantTransportStart(t *testing.T, transport *scriptedParticipantTransport) participantTransportStartResult {
	t.Helper()
	select {
	case result := <-transport.started:
		return result
	case <-time.After(2 * time.Second):
		t.Fatal("participant transport did not start")
		return participantTransportStartResult{}
	}
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

func TestParticipantTransportRetryDoesNotCrossProjectionGeneration(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	configureParticipantTransportRuntime(t, rt, 250*time.Millisecond)
	defer rt.Stop()

	stale := newScriptedParticipantTransport(errors.New("transient signaling failure"))
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
