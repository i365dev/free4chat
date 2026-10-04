package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

type residentTestStream struct {
	mu             sync.Mutex
	results        chan types.WaitResult
	closed         chan struct{}
	closeOnce      sync.Once
	heartbeats     chan int64
	sessionResults []types.ResidentSessionResult
	receiveErr     error
}

func newResidentTestStream() *residentTestStream {
	return &residentTestStream{
		results:    make(chan types.WaitResult, 4),
		closed:     make(chan struct{}),
		heartbeats: make(chan int64, 16),
	}
}

func (s *residentTestStream) Receive(ctx context.Context) (types.WaitResult, error) {
	if s.receiveErr != nil {
		return types.WaitResult{}, s.receiveErr
	}
	select {
	case result := <-s.results:
		return result, nil
	case <-s.closed:
		return types.WaitResult{}, errors.New("resident test stream closed")
	case <-ctx.Done():
		return types.WaitResult{}, ctx.Err()
	}
}

// SendSessionResult records one private session-control reply. The test stream
// accepts it on the same channel as the outbound heartbeat-equivalent so a test
// can assert the exact bounded result the Room would receive.
func (s *residentTestStream) SendSessionResult(_ context.Context, result types.ResidentSessionResult) error {
	s.mu.Lock()
	s.sessionResults = append(s.sessionResults, result)
	s.mu.Unlock()
	return nil
}

func (s *residentTestStream) Heartbeat(ctx context.Context, cursor int64) error {
	select {
	case s.heartbeats <- cursor:
		return nil
	case <-s.closed:
		return errors.New("resident test stream closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sessionResultSnapshot returns the private session-control replies this test
// stream has received.
func (s *residentTestStream) sessionResultSnapshot() []types.ResidentSessionResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]types.ResidentSessionResult(nil), s.sessionResults...)
}

func (s *residentTestStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

type residentTestClient struct {
	*fakeClient
	streams       chan *residentTestStream
	mu            sync.Mutex
	openCount     int
	openCursors   []int64
	openParticIDs []string
}

// residentExecutionTestClient combines the real resident transport seam with
// the Runtime execution projection sink so reconnect regressions assert the
// same state the Room and Browser consume.
type residentExecutionTestClient struct {
	*residentTestClient
	execution *executionClient
}

func (c *residentExecutionTestClient) UpdateTaskExecution(roomID string, projection types.TaskExecutionProjection) error {
	return c.execution.UpdateTaskExecution(roomID, projection)
}

type parsedLeaseResidentClient struct {
	*free4chat.Client
	stream types.ResidentEventStream
}

func (c *parsedLeaseResidentClient) OpenResidentEventStream(
	context.Context,
	string,
	int64,
) (types.ResidentEventStream, error) {
	return c.stream, nil
}

func (c *residentTestClient) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection, features *types.RuntimeFeatureProjection) (types.JoinResult, error) {
	joined, err := c.fakeClient.JoinRoom(roomID, name, capabilities, host, features)
	joined.AgentLeaseMs = 30 // Deliberately differs from the 90s compatibility fallback.
	return joined, err
}

func (c *residentTestClient) OpenResidentEventStream(
	ctx context.Context,
	participantHandle string,
	cursor int64,
) (types.ResidentEventStream, error) {
	c.mu.Lock()
	c.openCount++
	c.openCursors = append(c.openCursors, cursor)
	c.openParticIDs = append(c.openParticIDs, participantHandle)
	c.mu.Unlock()
	select {
	case stream := <-c.streams:
		return stream, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *residentTestClient) residentOpenSnapshot() (int, []int64, []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.openCount, append([]int64(nil), c.openCursors...), append([]string(nil), c.openParticIDs...)
}

func TestResidentRuntimeUsesEventStreamAndControlProjectionsDoNotWakeHarness(t *testing.T) {
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-stream",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	if got := rt.residentHeartbeatInterval(); got != 10*time.Millisecond {
		t.Fatalf("server lease was not converted to one-third heartbeat: %s", got)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream open")
	stream.results <- types.WaitResult{
		MediaState: &types.ResidentMediaState{
			MediaAvailable: true,
			MeetingNotes:   types.ResidentMeetingNotesState{Active: true, StartedAt: 7},
		},
		RuntimeParticipantTransport: types.RuntimeParticipantTransportProjection{
			Routes: []types.RuntimeParticipantTransportRoute{{
				AppInstanceID:      "generated:123e4567-e89b-12d3-a456-426614174000",
				BundleRevision:     1,
				TaskRequestID:      "task-origin",
				AgentParticipantID: "agent-a",
				HumanParticipantID: "human-a",
				RuntimeHostID:      "11111111-2222-3333-4444-555555555555",
				CapabilityIDs:      []string{"printer_status"},
			}},
			Sources: []types.RuntimeParticipantTransportSource{{ParticipantID: "human-a", SessionID: "human-session"}},
		},
		Cursor: 0, ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	time.Sleep(50 * time.Millisecond)
	if got := adapter.sessionsInt(); got != 0 {
		t.Fatalf("media or participant transport control state must not wake Harness, turns=%d", got)
	}
	rt.mu.Lock()
	transport := rt.participantTransport
	rt.mu.Unlock()
	if transport != nil {
		t.Fatal("Runtime without a local capability handler must fail closed")
	}
	stream.results <- types.WaitResult{
		Events: []types.RoomEvent{roomEvent(1, true)},
		Cursor: 1, ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	waitFor(t, time.Second, func() bool { return len(client.snapshotSent()) == 1 }, "resident reply")
	waitFor(t, time.Second, func() bool { return len(stream.heartbeats) > 0 }, "lease heartbeat")
	client.mu.Lock()
	open := client.openCount
	client.mu.Unlock()
	client.fakeClient.mu.Lock()
	waits := client.fakeClient.waits
	client.fakeClient.mu.Unlock()
	if open != 1 || waits != 0 {
		t.Fatalf("resident Runtime must use the event stream only: opens=%d waits=%d", open, waits)
	}
	rt.Stop()
	select {
	case <-stream.closed:
	case <-time.After(time.Second):
		t.Fatal("Stop did not close the resident event stream")
	}
}

func TestResidentRuntimeRetriesHumanTaskAcceptanceOnHeartbeat(t *testing.T) {
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{
			collabResponseErrors: []error{errors.New("temporary acceptance failure"), nil},
		},
		streams: make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-human-task-retry",
		RoomID:     "room-human-task-retry",
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

	event := scopedEvent(1, "task:T", "Investigate this")
	event.Type = "action"
	event.Participant = types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman}
	event.Collab = &types.WireCollabEvent{
		RequestID:           "request-T",
		Kind:                types.CollabRequest,
		FromParticipantID:   "human",
		TargetParticipantID: "agent-1",
	}
	// There is intentionally exactly one Room envelope. The second accepted
	// call must be caused by the resident lease heartbeat, not another event.
	stream.results <- types.WaitResult{
		Events:    []types.RoomEvent{event},
		Cursor:    1,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}

	waitFor(t, time.Second, func() bool {
		responses := client.snapshotCollabResponses()
		runs, _ := adapter.scopedRunSnapshot()
		status := rt.Status()
		return len(responses) == 2 &&
			len(runs) == 1 &&
			len(rt.pendingAddressedSnapshotFor("task:T")) == 0 &&
			status.LastError == "" &&
			status.State == StateWaiting
	}, "heartbeat acceptance retry and single Harness turn")
	if len(stream.heartbeats) == 0 {
		t.Fatal("accepted retry completed without a resident heartbeat")
	}
	status := rt.Status()
	if status.LastError != "" || status.State != StateWaiting {
		t.Fatalf("successful acceptance retry left stale Runtime state: %+v", status)
	}
}

func TestResidentMediaReplaySerializesWithTransportFailClosed(t *testing.T) {
	rt := NewResidentRuntime(Options{})
	rt.observeResidentMediaState(&types.ResidentMediaState{
		MediaAvailable: true,
		MeetingNotes:   types.ResidentMeetingNotesState{Active: true, StartedAt: 7},
	})

	entered := make(chan struct{})
	release := make(chan struct{})
	replayDone := make(chan struct{})
	go func() {
		rt.replayResidentMediaStateWithBarrier(func() {
			close(entered)
			<-release
		})
		close(replayDone)
	}()
	<-entered

	failClosedDone := make(chan struct{})
	go func() {
		rt.failClosedResidentMediaState()
		close(failClosedDone)
	}()
	select {
	case <-failClosedDone:
		t.Fatal("fail-closed must wait for an in-flight replay application")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	<-replayDone
	<-failClosedDone

	rt.residentMediaStateMu.Lock()
	valid := rt.residentMediaStateValid
	rt.residentMediaStateMu.Unlock()
	if valid {
		t.Fatal("transport fail-closed must invalidate the replay cache")
	}
}

func TestResidentMediaReplaySerializesWithNewInactiveState(t *testing.T) {
	rt := NewResidentRuntime(Options{})
	rt.observeResidentMediaState(&types.ResidentMediaState{
		MediaAvailable: true,
		MeetingNotes:   types.ResidentMeetingNotesState{Active: true, StartedAt: 7},
	})

	entered := make(chan struct{})
	release := make(chan struct{})
	replayDone := make(chan struct{})
	go func() {
		rt.replayResidentMediaStateWithBarrier(func() {
			close(entered)
			<-release
		})
		close(replayDone)
	}()
	<-entered

	inactiveDone := make(chan struct{})
	go func() {
		rt.observeResidentMediaState(&types.ResidentMediaState{})
		close(inactiveDone)
	}()
	select {
	case <-inactiveDone:
		t.Fatal("new inactive state must wait for an in-flight replay application")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	<-replayDone
	<-inactiveDone

	rt.residentMediaStateMu.Lock()
	state := rt.residentMediaState
	valid := rt.residentMediaStateValid
	rt.residentMediaStateMu.Unlock()
	if !valid || state.MediaAvailable || state.MeetingNotes.Active {
		t.Fatalf("new inactive state lost after replay: valid=%v state=%+v", valid, state)
	}
}

func TestResidentRuntimeUsesLeaseParsedFromMCPJoin(t *testing.T) {
	const leaseMs = 30
	handlePayload, err := json.Marshal(map[string]string{
		"room":             "room",
		"participantId":    "agent-1",
		"participantToken": "token-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	participantHandle := base64.RawURLEncoding.EncodeToString(handlePayload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode MCP request: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if body.Method == "tools/list" {
			// Derived from the client's own handshake contract so this double
			// cannot silently fall behind it.
			names := free4chat.RequiredToolNames()
			tools := make([]map[string]string, 0, len(names))
			for _, name := range names {
				tools = append(tools, map[string]string{"name": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{"tools": tools},
			})
			return
		}
		payload := map[string]any{}
		if body.Method == "tools/call" && body.Params.Name == "join_room" {
			payload = map[string]any{
				"participantHandle": participantHandle,
				"participant":       map[string]any{"id": "agent-1"},
				"cursor":            float64(0),
				"expiresAt":         float64(time.Now().Add(time.Hour).UnixMilli()),
				"agentLeaseMs":      float64(leaseMs),
			}
		}
		text, _ := json.Marshal(payload)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []any{map[string]any{"type": "text", "text": string(text)}},
			},
		})
	}))
	t.Cleanup(server.Close)

	stream := newResidentTestStream()
	client := &parsedLeaseResidentClient{
		Client: free4chat.New(server.URL),
		stream: stream,
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-parsed-lease",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	if got := rt.residentHeartbeatInterval(); got != 10*time.Millisecond {
		t.Fatalf("MCP lease was not parsed into heartbeat interval: %s", got)
	}
	waitFor(t, time.Second, func() bool { return len(stream.heartbeats) > 0 }, "parsed lease heartbeat")
	rt.Stop()
}

func TestResidentRuntimeReconnectPreservesParticipantAndCursor(t *testing.T) {
	first := newResidentTestStream()
	second := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 2),
	}
	client.streams <- first
	client.streams <- second
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-reconnect",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "first resident stream open")
	first.results <- types.WaitResult{
		Cursor: 7, ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	_ = first.Close()
	waitFor(t, 3*time.Second, func() bool {
		open, cursors, _ := client.residentOpenSnapshot()
		return open >= 2 && len(cursors) >= 2 && cursors[1] == 7
	}, "cursor-preserving resident reconnect")
	open, cursors, handles := client.residentOpenSnapshot()
	if open < 2 || cursors[0] != 0 || cursors[1] != 7 || handles[0] != handles[1] {
		t.Fatalf("reconnect lost resident identity/cursor: opens=%d cursors=%v", open, cursors)
	}
	client.fakeClient.mu.Lock()
	joins := client.fakeClient.joins
	client.fakeClient.mu.Unlock()
	if joins != 1 {
		t.Fatalf("transient stream close must not create a new participant: joins=%d", joins)
	}
	rt.Stop()
}

func TestResidentTransportReconnectKeepsExactActiveTaskTurn(t *testing.T) {
	first := newResidentTestStream()
	second := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 2),
	}
	client.streams <- first
	client.streams <- second
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-active-reconnect",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer rt.Stop()
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "first resident stream open")

	// The current turn belongs to the local Harness process. A Room transport
	// interruption may hide projections temporarily, but cannot erase identity.
	rt.beginActivity("task:req-T", 77)
	if err := first.Close(); err != nil {
		t.Fatalf("close resident stream: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open >= 2
	}, "resident stream reconnect")
	if sequence, active := rt.activeTurnOf("task:req-T"); !active || sequence != 77 {
		t.Fatalf("transport reconnect erased the exact active Task turn: sequence=%d active=%v", sequence, active)
	}
}

func TestResidentReconnectPreservesExactRunningTaskProjectionAndSteerTarget(t *testing.T) {
	first := newResidentTestStream()
	second := newResidentTestStream()
	transport := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 2),
	}
	transport.streams <- first
	transport.streams <- second
	client := &residentExecutionTestClient{
		residentTestClient: transport,
		execution:          newExecutionClient(),
	}
	adapter := newInterruptAdapter()
	hold := adapter.holdTurns()
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-projection-reconnect",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeGateIgnoringDoubleClose(hold)
		adapter.releaseAllTurns()
		rt.Stop()
	}()
	waitFor(t, time.Second, func() bool {
		open, _, _ := transport.residentOpenSnapshot()
		return open == 1
	}, "initial resident stream")

	const activeSequence int64 = 77
	const queuedSequence int64 = 78
	drained := startTurn(rt, scopedEvent(activeSequence, "task:req-T", "long running instruction A"))
	waitForExecution(t, client.execution, "req-T", "Harness turn A projected running", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == activeSequence && p.Phase == types.TaskExecutionPhaseRunning
	})
	rt.acceptEvent(scopedEvent(queuedSequence, "task:req-T", "queued Human instruction B"))
	beforeReconnect := waitForExecution(t, client.execution, "req-T", "instruction B queued behind A", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == activeSequence && p.Phase == types.TaskExecutionPhaseRunning && p.QueuedCount == 1
	})
	if beforeReconnect.CurrentTurnSequence != activeSequence || adapter.runCount("task:req-T") != 1 {
		t.Fatalf("the fixture did not establish the running A + queued B incident: projection=%+v runs=%d", beforeReconnect, adapter.runCount("task:req-T"))
	}

	if err := first.Close(); err != nil {
		t.Fatalf("drop resident stream: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		open, _, _ := transport.residentOpenSnapshot()
		return open >= 2
	}, "resident stream reconnect")
	reconnected := waitForExecution(t, client.execution, "req-T", "reconciled running Task projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == activeSequence && p.Phase == types.TaskExecutionPhaseRunning && p.QueuedCount == 1
	})
	if reconnected.CurrentTurnSequence != activeSequence || reconnected.Phase != types.TaskExecutionPhaseRunning || reconnected.QueuedCount != 1 {
		t.Fatalf("reconnect did not preserve the exact Room-facing projection: %+v", reconnected)
	}
	if adapter.cancelCount() != 0 || adapter.runCount("task:req-T") != 1 {
		t.Fatalf("ordinary transport reconnect interrupted/restarted A or ran B: cancels=%d runs=%d", adapter.cancelCount(), adapter.runCount("task:req-T"))
	}

	// The control carried on the replacement stream still targets the exact
	// current turn A. Its explicit interrupt is observable while the hold keeps
	// the Harness call in flight; B remains pending until A actually settles.
	second.results <- types.WaitResult{TaskControl: interruptControl("req-T", activeSequence)}
	interrupting := waitForExecution(t, client.execution, "req-T", "exact-turn interrupt projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == activeSequence && p.Phase == types.TaskExecutionPhaseInterrupting
	})
	if interrupting.QueuedCount != 1 || adapter.cancelCount() != 1 || adapter.runCount("task:req-T") != 1 {
		t.Fatalf("the reconnected control missed exact A or started B early: projection=%+v cancels=%d runs=%d", interrupting, adapter.cancelCount(), adapter.runCount("task:req-T"))
	}

	adapter.blockNextTurn()
	closeGateIgnoringDoubleClose(hold)
	waitFor(t, 2*time.Second, func() bool { return adapter.runCount("task:req-T") == 2 }, "queued instruction B after A settles")
	startedB := waitForExecution(t, client.execution, "req-T", "instruction B running", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == queuedSequence && p.Phase == types.TaskExecutionPhaseRunning
	})
	if startedB.QueuedCount != 0 {
		t.Fatalf("the settled A remained counted behind itself: %+v", startedB)
	}
	adapter.releaseTurn()
	waitForDone(t, drained, "A and B to settle")
	if adapter.runCount("task:req-T") != 2 {
		t.Fatalf("normal progression replayed a Task instruction: runs=%d", adapter.runCount("task:req-T"))
	}
}

func TestResidentRuntimeDoesNotReconnectAfterTerminalEventProtocolError(t *testing.T) {
	stream := newResidentTestStream()
	stream.receiveErr = &free4chat.Error{
		Message: "resident event stream rejected the event envelope",
		Code:    free4chat.CodeToolError,
	}
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-terminal-frame",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		return rt.Status().State == StateStopped
	}, "terminal resident protocol error")
	open, _, _ := client.residentOpenSnapshot()
	if open != 1 {
		t.Fatalf("terminal resident protocol error must not reconnect: opens=%d", open)
	}
	rt.Stop()
}

func TestResidentRuntimeStopCancelsEventStreamHandshake(t *testing.T) {
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream),
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-stop-handshake",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream handshake")

	done := make(chan struct{})
	go func() {
		rt.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel the resident event stream handshake")
	}
}
