package runtime

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Stale resident reader ownership fence (#409 hardening).
 *
 * The resident transport has exactly ONE long-lived reader goroutine. A
 * reconnect installs a replacement stream while that reader can still be
 * unwinding, so a late frame or error from the abandoned transport must never
 * act on the replacement stream's Runtime state: it must not cancel a
 * replacement-era Room permission, apply a Task control, advance the Room
 * cursor, or change media/activity state.
 *
 * These tests drive the reader deterministically: Receive hands the test one
 * receipt per delivered frame, so an assertion runs only after the reader has
 * definitely consumed that frame. No sleeps decide a race.
 */

// gatedResidentStream is a fully test-controlled resident transport.
type gatedResidentStream struct {
	frames     chan any // types.WaitResult or error
	consumed   chan struct{}
	closed     chan struct{}
	closeOnce  sync.Once
	failHB     chan struct{}
	failHBOnce sync.Once
}

func newGatedResidentStream() *gatedResidentStream {
	return &gatedResidentStream{
		frames:   make(chan any, 4),
		consumed: make(chan struct{}, 4),
		closed:   make(chan struct{}),
		failHB:   make(chan struct{}),
	}
}

func (s *gatedResidentStream) Receive(ctx context.Context) (types.WaitResult, error) {
	select {
	case frame := <-s.frames:
		// Receipt first: the frame has been handed to the reader, so any
		// Runtime-side effect it produces happens after this signal.
		select {
		case s.consumed <- struct{}{}:
		default:
		}
		switch value := frame.(type) {
		case types.WaitResult:
			return value, nil
		case error:
			return types.WaitResult{}, value
		default:
			return types.WaitResult{}, errors.New("gated resident stream received an invalid frame")
		}
	case <-s.closed:
		return types.WaitResult{}, errors.New("gated resident stream closed")
	case <-ctx.Done():
		return types.WaitResult{}, ctx.Err()
	}
}

func (s *gatedResidentStream) SendSessionResult(context.Context, types.ResidentSessionResult) error {
	return nil
}

func (s *gatedResidentStream) Heartbeat(context.Context, int64) error {
	select {
	case <-s.failHB:
		return errors.New("gated resident heartbeat failed")
	default:
		return nil
	}
}

func (s *gatedResidentStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func (s *gatedResidentStream) failHeartbeats() {
	s.failHBOnce.Do(func() { close(s.failHB) })
}

// awaitConsumed blocks until the reader has taken one frame from this stream.
func (s *gatedResidentStream) awaitConsumed(t *testing.T) {
	t.Helper()
	select {
	case <-s.consumed:
	case <-time.After(2 * time.Second):
		t.Fatal("the resident reader never consumed the delivered frame")
	}
}

func newResidentFenceRuntime(t *testing.T) (*ResidentRuntime, *interruptAdapter) {
	t.Helper()
	rt, adapter := newTaskInterruptRuntime()
	// The abandoned reader's loop retires on its own short heartbeat clock.
	rt.mu.Lock()
	rt.agentLeaseMs = 30
	rt.mu.Unlock()
	return rt, adapter
}

// abandonResidentStream installs stream A, starts its single reader, then
// replaces A with stream B while the reader is still parked in Receive.
func abandonResidentStream(
	t *testing.T,
	rt *ResidentRuntime,
) (*gatedResidentStream, *gatedResidentStream) {
	t.Helper()
	streamA := newGatedResidentStream()
	if !rt.setResidentStream(streamA) {
		t.Fatal("stream A was not installed")
	}
	loopA := make(chan error, 1)
	go func() { loopA <- rt.consumeResidentEventStream(streamA) }()

	streamB := newGatedResidentStream()
	if !rt.setResidentStream(streamB) {
		t.Fatal("stream B was not installed")
	}
	if rt.isCurrentResidentStream(streamA) {
		t.Fatal("the replaced stream must not still be current")
	}
	if !rt.isCurrentResidentStream(streamB) {
		t.Fatal("the replacement stream must be current")
	}

	// Retire the abandoned loop deterministically once the assertions are done
	// (its reader is gone, so only its own heartbeat clock can wake it).
	t.Cleanup(func() {
		streamA.failHeartbeats()
		select {
		case <-loopA:
		case <-time.After(2 * time.Second):
			t.Error("the abandoned reader loop never retired")
		}
	})
	return streamA, streamB
}

func TestResidentStreamOwnershipFollowsInstallAndClear(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	defer rt.Stop()

	streamA := newGatedResidentStream()
	if !rt.setResidentStream(streamA) {
		t.Fatal("stream A was not installed")
	}
	if !rt.isCurrentResidentStream(streamA) {
		t.Fatal("an installed stream must be current")
	}
	streamB := newGatedResidentStream()
	if !rt.setResidentStream(streamB) {
		t.Fatal("stream B was not installed")
	}
	if rt.isCurrentResidentStream(streamA) || !rt.isCurrentResidentStream(streamB) {
		t.Fatal("ownership must follow the installed stream")
	}
	rt.clearResidentStream(streamA)
	if !rt.isCurrentResidentStream(streamB) {
		t.Fatal("clearing a stale stream must not release the current one")
	}
	rt.clearResidentStream(streamB)
	if rt.isCurrentResidentStream(streamB) {
		t.Fatal("a cleared stream must not stay current")
	}
}

type reconnectParticipantCapabilityHandler struct{}

func (reconnectParticipantCapabilityHandler) DescribeCapabilities() []types.RuntimeCapabilityProjection {
	return []types.RuntimeCapabilityProjection{{CapabilityID: "printer_status", Title: "Status", Version: "1", Observe: true, Actions: []types.RuntimeCapabilityAction{}}}
}

func (reconnectParticipantCapabilityHandler) HandleCapabilityRequest(context.Context, types.ResidentCapabilityRequest) (map[string]any, error) {
	return map[string]any{"status": "ready"}, nil
}

type reconnectParticipantTransport struct {
	started     chan struct{}
	startDone   chan struct{}
	allowReturn chan struct{}
	startErr    error
	startOnce   sync.Once
	returnOnce  sync.Once
	closeOnce   sync.Once
	closed      chan struct{}
	mu          sync.Mutex
	closeCalls  int
}

func newReconnectParticipantTransport(blockStart bool) *reconnectParticipantTransport {
	transport := &reconnectParticipantTransport{
		started:   make(chan struct{}),
		startDone: make(chan struct{}),
		closed:    make(chan struct{}),
	}
	if blockStart {
		transport.allowReturn = make(chan struct{})
		transport.startErr = errors.New("stale participant transport start")
	}
	return transport
}

func (t *reconnectParticipantTransport) Start(context.Context, types.RuntimeParticipantTransportProjection) error {
	t.startOnce.Do(func() { close(t.started) })
	defer close(t.startDone)
	if t.allowReturn != nil {
		<-t.allowReturn
	}
	return t.startErr
}

func (t *reconnectParticipantTransport) Close() {
	t.mu.Lock()
	t.closeCalls++
	first := t.closeCalls == 1
	t.mu.Unlock()
	if first {
		t.closeOnce.Do(func() { close(t.closed) })
	}
}

func (t *reconnectParticipantTransport) closeCallCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closeCalls
}

func (t *reconnectParticipantTransport) allowStartReturn() {
	if t.allowReturn != nil {
		t.returnOnce.Do(func() { close(t.allowReturn) })
	}
}

func TestResidentStreamReplacementRebuildsSameParticipantTransportProjection(t *testing.T) {
	rt, adapter := newResidentFenceRuntime(t)
	rt.options.CapabilityHandler = reconnectParticipantCapabilityHandler{}
	rt.options.SiteOrigin = "https://example.invalid"
	rt.mu.Lock()
	rt.participantID = "agent-a"
	rt.participantHandle = base64.RawURLEncoding.EncodeToString([]byte(`{"room":"room","participantId":"agent-a","participantToken":"test-token"}`))
	rt.mu.Unlock()
	oldTransport := newReconnectParticipantTransport(true)
	newTransport := newReconnectParticipantTransport(false)
	defer func() {
		oldTransport.allowStartReturn()
		select {
		case <-oldTransport.started:
			<-oldTransport.startDone
		default:
		}
		rt.Stop()
	}()
	factories := []*reconnectParticipantTransport{oldTransport, newTransport}
	rt.participantTransportFactory = func(media.DecodedHandle) participantDataTransport {
		if len(factories) == 0 {
			t.Fatal("replacement projection created more than one fresh transport")
		}
		transport := factories[0]
		factories = factories[1:]
		return transport
	}

	projection := types.RuntimeParticipantTransportProjection{
		Routes: []types.RuntimeParticipantTransportRoute{{
			AppInstanceID:      "generated:123e4567-e89b-12d3-a456-426614174000",
			BundleRevision:     1,
			TaskRequestID:      "task-origin",
			AgentParticipantID: "agent-a",
			RuntimeHostID:      "11111111-2222-3333-4444-555555555555",
			CapabilityIDs:      []string{"printer_status"},
		}},
	}
	result := types.WaitResult{RuntimeParticipantTransport: projection}
	streamA := newResidentTestStream()
	defer streamA.Close()
	if !rt.setResidentStream(streamA) {
		t.Fatal("initial resident stream was not installed")
	}
	if outcome, wake := rt.applyResidentFrame(streamA, result, nil); outcome != residentFrameApplied || wake {
		t.Fatalf("initial projection result = (%v, %v), want applied without Harness wake", outcome, wake)
	}
	select {
	case <-oldTransport.started:
	case <-time.After(time.Second):
		t.Fatal("initial participant transport did not start")
	}
	rt.mu.Lock()
	initial := rt.participantTransport
	rt.mu.Unlock()
	if initial != oldTransport {
		t.Fatal("Runtime did not retain the transport for the initial projection")
	}

	streamB := newResidentTestStream()
	if !rt.setResidentStream(streamB) {
		t.Fatal("replacement resident stream was not installed")
	}
	select {
	case <-oldTransport.closed:
	case <-time.After(time.Second):
		t.Fatal("resident stream replacement did not close the old participant transport")
	}
	rt.mu.Lock()
	if rt.participantTransport != nil || rt.participantTransportProjection != "" {
		rt.mu.Unlock()
		t.Fatal("resident stream replacement retained the old transport or projection signature")
	}
	rt.mu.Unlock()

	if outcome, wake := rt.applyResidentFrame(streamB, result, nil); outcome != residentFrameApplied || wake {
		t.Fatalf("replayed projection result = (%v, %v), want applied without Harness wake", outcome, wake)
	}
	select {
	case <-newTransport.started:
	case <-time.After(time.Second):
		t.Fatal("same projection on the replacement stream did not start a fresh participant transport")
	}

	// Let the stale asynchronous Start fail only after the fresh transport is
	// installed. Its completion must not clear or replace the new generation.
	oldTransport.allowStartReturn()
	select {
	case <-oldTransport.startDone:
	case <-time.After(time.Second):
		t.Fatal("stale participant transport Start did not finish")
	}
	waitFor(t, time.Second, func() bool { return oldTransport.closeCallCount() >= 2 }, "stale participant transport failure cleanup")
	rt.mu.Lock()
	current, signature := rt.participantTransport, rt.participantTransportProjection
	rt.mu.Unlock()
	if current != newTransport || signature == "" {
		t.Fatal("stale Start completion cleared or replaced the fresh participant transport")
	}
	if len(factories) != 0 {
		t.Fatalf("created %d participant transports, want exactly initial and fresh", 2-len(factories))
	}
	_, turns := adapter.scopedRunSnapshot()
	for scope, runs := range turns {
		if len(runs) != 0 {
			t.Fatalf("participant transport projection created Harness turns for %q: %v", scope, runs)
		}
	}
}

// TestApplyResidentFrameDropsEveryStaleStreamEffect pins the ownership fence
// synchronously, so each protected effect is asserted without any goroutine
// timing: a frame from a stream the Runtime no longer has installed must have
// no effect on permissions, Task control, or delivery state.
func TestApplyResidentFrameDropsEveryStaleStreamEffect(t *testing.T) {
	t.Run("task control", func(t *testing.T) {
		rt, adapter := newResidentFenceRuntime(t)
		defer rt.Stop()
		streamA, streamB := abandonResidentStream(t, rt)
		rt.beginActivity("task:req-T", 7)

		outcome, wake := rt.applyResidentFrame(
			streamA,
			types.WaitResult{TaskControl: interruptControl("req-T", 7)},
			nil,
		)

		if outcome != residentFrameDropped || wake {
			t.Fatalf("a stale frame must be dropped: outcome=%v wake=%v", outcome, wake)
		}
		if got := adapter.cancelCount(); got != 0 {
			t.Fatalf("a stale frame applied a Task control: %d cancels", got)
		}
		if got := activeScope(rt); got != "task:req-T" {
			t.Fatalf("a stale frame disturbed the replacement-era turn: %q", got)
		}
		// The current stream's own frame is still applied normally.
		if outcome, _ := rt.applyResidentFrame(
			streamB,
			types.WaitResult{TaskControl: interruptControl("req-T", 7)},
			nil,
		); outcome != residentFrameApplied {
			t.Fatalf("the current stream's frame must be applied: %v", outcome)
		}
		if got := adapter.cancelCount(); got != 1 {
			t.Fatalf("the current stream's control must cancel its turn: %d", got)
		}
	})

	t.Run("transport error", func(t *testing.T) {
		rt, _ := newResidentFenceRuntime(t)
		defer rt.Stop()
		streamA, _ := abandonResidentStream(t, rt)
		pending := &pendingRoomPermission{done: make(chan roomPermissionDecision, 1)}
		rt.permissionMu.Lock()
		rt.pendingPermissions["replacement-correlation"] = pending
		rt.permissionMu.Unlock()

		outcome, _ := rt.applyResidentFrame(
			streamA,
			types.WaitResult{},
			errors.New("abandoned transport failed"),
		)

		// The reader still reports its OWN transport failure so its loop can
		// finish; only the Runtime-visible effect is fenced.
		if outcome != residentFrameFailed {
			t.Fatalf("a stale transport error must not be applied: %v", outcome)
		}
		rt.permissionMu.Lock()
		remaining := len(rt.pendingPermissions)
		rt.permissionMu.Unlock()
		if remaining != 1 {
			t.Fatalf("a stale error cancelled a replacement-era permission: %d pending", remaining)
		}
		select {
		case decision := <-pending.done:
			t.Fatalf("a stale error resolved a replacement-era permission: %+v", decision)
		default:
		}
	})

	t.Run("events envelope", func(t *testing.T) {
		rt, _ := newResidentFenceRuntime(t)
		defer rt.Stop()
		streamA, _ := abandonResidentStream(t, rt)
		cursorBefore := rt.currentCursor()
		expiresBefore := rt.expiresAt

		outcome, wake := rt.applyResidentFrame(
			streamA,
			types.WaitResult{
				Events:     []types.RoomEvent{scopedEvent(9, "task:req-T", "stale")},
				Cursor:     9,
				ExpiresAt:  time.Now().Add(time.Hour).UnixMilli(),
				MediaState: &types.ResidentMediaState{MediaAvailable: true},
			},
			nil,
		)

		if outcome != residentFrameDropped || wake {
			t.Fatalf("a stale envelope must be dropped: outcome=%v wake=%v", outcome, wake)
		}
		if got := rt.currentCursor(); got != cursorBefore {
			t.Fatalf("a stale envelope advanced the Room cursor: %d -> %d", cursorBefore, got)
		}
		if rt.expiresAt != expiresBefore {
			t.Fatalf("a stale envelope changed delivery state: %d -> %d", expiresBefore, rt.expiresAt)
		}
		if got := adapterRunCountFor(rt); got != 0 {
			t.Fatalf("a stale envelope created Room work: %d", got)
		}
	})
}

func TestStaleResidentReaderCannotApplyATaskControl(t *testing.T) {
	rt, adapter := newResidentFenceRuntime(t)
	defer rt.Stop()
	streamA, streamB := abandonResidentStream(t, rt)

	// Replacement-era Runtime state: the Runtime owns Task turn 7.
	rt.beginActivity("task:req-T", 7)

	// The abandoned transport delivers a control that would match that turn.
	streamA.frames <- types.WaitResult{TaskControl: interruptControl("req-T", 7)}
	streamA.awaitConsumed(t)

	if got := adapter.cancelCount(); got != 0 {
		t.Fatalf("a stale reader applied a Task control: %d cancels", got)
	}
	if got := activeScope(rt); got != "task:req-T" {
		t.Fatalf("a stale reader disturbed the replacement-era turn: %q", got)
	}

	// The replacement stream's own reader is the one that may act.
	loopB := make(chan error, 1)
	go func() { loopB <- rt.consumeResidentEventStream(streamB) }()
	defer func() {
		_ = streamB.Close()
		select {
		case <-loopB:
		case <-time.After(2 * time.Second):
			t.Error("the replacement reader loop never retired")
		}
	}()
	streamB.frames <- types.WaitResult{TaskControl: interruptControl("req-T", 7)}
	waitFor(t, 2*time.Second, func() bool { return adapter.cancelCount() == 1 },
		"the current stream's own control to cancel its turn")
}

func TestStaleResidentReaderCannotCancelReplacementPermissions(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	defer rt.Stop()
	streamA, _ := abandonResidentStream(t, rt)

	// Replacement-era Runtime state: a turn is parked on a Room decision.
	pending := &pendingRoomPermission{done: make(chan roomPermissionDecision, 1)}
	rt.permissionMu.Lock()
	rt.pendingPermissions["replacement-correlation"] = pending
	rt.permissionMu.Unlock()

	// The abandoned transport reports its own death afterwards.
	streamA.frames <- errors.New("abandoned transport failed")
	streamA.awaitConsumed(t)

	rt.permissionMu.Lock()
	remaining := len(rt.pendingPermissions)
	rt.permissionMu.Unlock()
	if remaining != 1 {
		t.Fatalf("a stale reader cancelled a replacement-era permission: %d pending", remaining)
	}
	select {
	case decision := <-pending.done:
		t.Fatalf("a stale reader resolved a replacement-era permission: %+v", decision)
	default:
	}
}

func TestStaleResidentReaderCannotAdvanceReplacementDelivery(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	defer rt.Stop()
	streamA, _ := abandonResidentStream(t, rt)

	cursorBefore := rt.currentCursor()
	expiresBefore := rt.expiresAt

	streamA.frames <- types.WaitResult{
		Events:     []types.RoomEvent{scopedEvent(9, "task:req-T", "stale")},
		Cursor:     9,
		ExpiresAt:  time.Now().Add(time.Hour).UnixMilli(),
		MediaState: &types.ResidentMediaState{MediaAvailable: true},
	}
	streamA.awaitConsumed(t)

	if got := rt.currentCursor(); got != cursorBefore {
		t.Fatalf("a stale reader advanced the Room cursor: %d -> %d", cursorBefore, got)
	}
	if rt.expiresAt != expiresBefore {
		t.Fatalf("a stale reader advanced replacement delivery state: %d -> %d", expiresBefore, rt.expiresAt)
	}
	if got := adapterRunCountFor(rt); got != 0 {
		t.Fatalf("a stale reader created Room work: %d", got)
	}
}

// TestResidentReaderReportsItsOwnFailureAfterTheStreamWasCleared pins the
// shutdown path: Stop (and any reconnect) clears r.resident before the parked
// reader returns, and the reader must still report its own transport failure so
// its loop can finish. Effects stay fenced; only the signal is unconditional.
func TestResidentReaderReportsItsOwnFailureAfterTheStreamWasCleared(t *testing.T) {
	rt, _ := newResidentFenceRuntime(t)
	defer rt.Stop()

	stream := newGatedResidentStream()
	if !rt.setResidentStream(stream) {
		t.Fatal("the stream was not installed")
	}
	loop := make(chan error, 1)
	go func() { loop <- rt.consumeResidentEventStream(stream) }()

	// The Runtime releases the transport first, exactly like Stop/clear.
	rt.clearResidentStream(stream)
	if rt.isCurrentResidentStream(stream) {
		t.Fatal("a cleared stream must not stay current")
	}
	stream.frames <- errors.New("transport failed after clear")

	select {
	case err := <-loop:
		if err == nil {
			t.Fatal("a failed transport must finish the reader loop with its error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the reader loop never finished after its transport failed")
	}
	if got := rt.currentCursor(); got != 0 {
		t.Fatalf("a cleared reader advanced delivery state: %d", got)
	}
}

// adapterRunCountFor reports how many Harness turns the runtime's own adapter
// has run; the stale envelope must never reach the turn scheduler.
func adapterRunCountFor(rt *ResidentRuntime) int {
	adapter, ok := rt.options.Adapter.(*interruptAdapter)
	if !ok {
		return 0
	}
	_, details := adapter.scopedRunSnapshot()
	total := 0
	for _, entries := range details {
		total += len(entries)
	}
	return total
}
