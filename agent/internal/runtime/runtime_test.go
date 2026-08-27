package runtime

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// fakeClient scripts wait_for_events responses and records lifecycle calls.
type fakeClient struct {
	mu        sync.Mutex
	waits     int
	joins     int
	sent      []string
	leftRoom  bool
	closed    bool
	capsSeen  [][]string
	script    []waitStep
	defaultOK bool
	// sendHook observes every SendText in order (tests may inject).
	sendHook func(text string)
}

type waitStep struct {
	err    error
	events []types.RoomEvent
	roster []types.ParticipantRosterEntry
	// gate blocks delivery until closed (deterministic mid-flight tests).
	gate chan struct{}
}

func (c *fakeClient) Connect() error               { return nil }
func (c *fakeClient) ListTools() ([]string, error) { return nil, nil }

func (c *fakeClient) RoomInfo(string) (types.RoomInfo, error) {
	return types.RoomInfo{Exists: true}, nil
}

func (c *fakeClient) JoinRoom(roomID, name string, capabilities []string) (types.JoinResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.joins++
	j := types.JoinResult{
		ParticipantID:     fmt.Sprintf("agent-%d", c.joins),
		ParticipantHandle: fmt.Sprintf("secret-%d", c.joins),
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	}
	if c.joins == 2 {
		j.Cursor = 10 // fresh cursor after lease loss; no replay allowed
	}
	if capabilities != nil {
		c.capsSeen = append(c.capsSeen, append([]string(nil), capabilities...))
	} else {
		c.capsSeen = append(c.capsSeen, nil)
	}
	return j, nil
}

func (c *fakeClient) CreateRoom(string, []string) (types.CreateRoomResult, error) {
	return types.CreateRoomResult{}, nil
}

func (c *fakeClient) WaitForEvents(handle string, cursor int64, timeoutSeconds int) (types.WaitResult, error) {
	var step waitStep
	func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if len(c.script) > 0 {
			step = c.script[0]
			c.script = c.script[1:]
		}
	}()
	if len(c.script) == 0 && step.err == nil && step.events == nil && step.roster == nil {
		// Unscripted polls spin quickly with an unchanged cursor.
		time.Sleep(3 * time.Millisecond)
		return types.WaitResult{Cursor: cursor, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, nil
	}
	if step.err != nil {
		return types.WaitResult{}, step.err
	}
	if step.gate != nil {
		<-step.gate
	}
	wait := types.WaitResult{
		Events:       step.events,
		Cursor:       cursor,
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
		Participants: step.roster,
	}
	for _, event := range step.events {
		if event.Sequence > wait.Cursor {
			wait.Cursor = event.Sequence
		}
	}
	return wait, nil
}

func (c *fakeClient) SendText(_ string, text string) (types.SendTextResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, text)
	if c.sendHook != nil {
		c.sendHook(text)
	}
	return types.SendTextResult{Sequence: int64(len(c.sent))}, nil
}

func (*fakeClient) ReadAttachment(_, _ string) (types.AttachmentRead, error) {
	return types.AttachmentRead{Data: "Zm9v", MimeType: "image/png"}, nil
}

func (*fakeClient) UpdateCapabilities(handle string, capabilities []string) error {
	return nil
}

func (*fakeClient) SendCollabRequest(string, types.CollabRequestArgs) (types.CollabRequestOutcome, error) {
	return types.CollabRequestOutcome{RequestID: "req-1", Sequence: 1}, nil
}

func (*fakeClient) SendCollabResponse(string, types.CollabResponseArgs) (types.SendTextResult, error) {
	return types.SendTextResult{Sequence: 1}, nil
}

func (*fakeClient) SendCollabResult(string, types.CollabResultArgs) (types.SendTextResult, error) {
	return types.SendTextResult{Sequence: 1}, nil
}

func (*fakeClient) UploadAttachment(string, types.AttachmentUpload) (types.UploadedAttachment, error) {
	return types.UploadedAttachment{}, nil
}

func (*fakeClient) PublishSurface(string, types.SurfacePublishPayload) (types.RoomSurfaceMetadataV1, error) {
	return types.RoomSurfaceMetadataV1{}, nil
}

func (*fakeClient) ClearSurface(string) error { return nil }

func (*fakeClient) ReadSurface(string, string, string) (types.SurfaceReadResult, error) {
	return types.SurfaceReadResult{}, nil
}

func (c *fakeClient) LeaveRoom(string) error {
	c.mu.Lock()
	c.leftRoom = true
	c.mu.Unlock()
	return nil
}

func (c *fakeClient) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}

// fakeAdapter records turns and can be scripted to fail.
type fakeAdapter struct {
	mu       sync.Mutex
	name     string
	caps     *types.HarnessCapabilities
	turnErr  error
	turnDtls []string // concatenated addressed texts per turn
	onFail   func(error)
	sessions int
	stopped  bool
	delay    time.Duration
}

// adapterRunTurnHook lets individual tests observe the exact enriched turn
// input handed to the Harness (nil in most tests).
var adapterRunTurnHook func(*fakeAdapter, types.HarnessTurnInput)

func (a *fakeAdapter) Name() string { return a.name }

func (a *fakeAdapter) Capabilities() *types.HarnessCapabilities { return a.caps }

func (a *fakeAdapter) EnsureSession() error { return nil }

func (a *fakeAdapter) RunTurn(input types.HarnessTurnInput) (types.HarnessTurnResult, error) {
	if hook := adapterRunTurnHook; hook != nil {
		hook(a, input)
	}
	a.mu.Lock()
	a.sessions++
	texts := make([]string, 0, len(input.Events))
	for _, event := range input.Events {
		if event.Text != "" {
			texts = append(texts, event.Text)
		}
	}
	combined := strings.Join(texts, ",")
	err := a.turnErr
	delay := a.delay
	a.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	if err != nil {
		return types.HarnessTurnResult{}, err
	}
	a.mu.Lock()
	a.turnDtls = append(a.turnDtls, combined)
	a.mu.Unlock()
	return types.HarnessTurnResult{Text: "reply-" + itoa(int64(a.sessionsInt()))}, nil
}

func (a *fakeAdapter) sessionsInt() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions
}

func (a *fakeAdapter) OnFailure(handler types.AdapterFailureHandler) {
	a.mu.Lock()
	a.onFail = handler
	a.mu.Unlock()
}

func (a *fakeAdapter) CancelTurn() error { return nil }

func (a *fakeAdapter) Close() error {
	a.mu.Lock()
	a.stopped = true
	a.mu.Unlock()
	return nil
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(3 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", message)
}

// pushWaitStep queues one scripted response; because scripted responses are
// consumed strictly in order, the next wait_for_events returns it.
func (c *fakeClient) pushWaitStep(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.script = append(c.script, waitStep{err: err})
}

func TestAddressedTurnDeliveredOnceAndReplied(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-1",
		RoomID:      "test",
		Name:        "Pi",
		Client:      client,
		Adapter:     adapter,
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) >= 1 }, "reply")
	rt.Stop()

	sent := client.snapshotSent()
	if len(sent) != 1 || sent[0] != "reply-1" {
		t.Fatalf("exactly-once reply violated: %v", sent)
	}
	status := rt.Status()
	if status.State != StateStopped || status.ParticipantID != "agent-1" || status.RoomID != "test" {
		t.Fatalf("status mismatch: %+v", status)
	}
	if strings.Contains(fmt.Sprintf("%v", status), "secret") {
		t.Fatal("capability value leaked into status")
	}
}

func (c *fakeClient) snapshotSent() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.sent...)
}

func TestUnaddressedTextWakesNothing(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, false)}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-quiet", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	time.Sleep(120 * time.Millisecond)
	rt.Stop()
	if got := adapter.sessionsInt(); got != 0 {
		t.Fatalf("unaddressed turn woke harness %d times", got)
	}
	if len(client.snapshotSent()) != 0 {
		t.Fatalf("unaddressed turn produced sends: %v", client.snapshotSent())
	}
}

func TestTimedOutTurnDoesNotReplyNorReplay(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "hermes", turnErr: errors.New("ACP turn timed out")}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-timeout", RoomID: "test", Name: "Hermes",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool {
		return rt.Status().State == StateWaiting && len(client.snapshotSent()) == 0 &&
			adapter.sessionsInt() >= 1
	}, "turn release")
	rt.Stop()

	if len(client.snapshotSent()) != 0 {
		t.Fatalf("timed-out turn must not send: %v", client.snapshotSent())
	}
}

func TestLeaseExpiryRejoinsWithFreshCursorWithoutReplay(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{err: &free4chat.Error{Message: "invalid participant", Code: free4chat.CodeInvalidParticipantHandle}},
	}
	adapter := &fakeAdapter{name: "claude"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-rejoin", RoomID: "test", Name: "Agent",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return client.joinCount() >= 2 }, "second join")
	rt.Stop()

	if client.joinCount() < 2 {
		t.Fatal("lease expiry must trigger rejoin")
	}
	if got := adapter.sessionsInt(); got != 0 {
		t.Fatalf("historical events must not replay into turns: %d", got)
	}
}

func (c *fakeClient) joinCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.joins
}

func TestRoomExpiryReleasesResources(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{err: &free4chat.Error{Message: "expired", Code: free4chat.CodeRoomExpired}},
	}
	adapter := &fakeAdapter{name: "pi"}
	expired := false
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-expiry", RoomID: "test", Name: "Agent",
		Client: client, Adapter: adapter, WaitSeconds: 1,
		OnRoomExpired: func() error { expired = true; return nil },
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return expired }, "expiry notification")

	if rt.Status().LastError != "room_expired" {
		t.Fatalf("expected room_expired lastError, got %q", rt.Status().LastError)
	}
	// Node cleanupResources also makes a best-effort leaveRoom attempt while
	// the handle is still held (expiry/network loss are clean terminations
	// and failures are swallowed); mirror that in the assertion.
	if !client.leftRoomFlag() || !client.closedFlag() {
		t.Fatalf("expiry cleanup mismatch: left=%v closed=%v", client.leftRoomFlag(), client.closedFlag())
	}
	if !adapter.closeConfirmed() {
		t.Fatal("adapter must be closed on expiry")
	}
}

func (c *fakeClient) leftRoomFlag() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.leftRoom
}

func (c *fakeClient) closedFlag() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (a *fakeAdapter) closeConfirmed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped
}

func TestCapabilitiesAdvertisedUpdatedAndSurviveRejoin(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{err: &free4chat.Error{Message: "invalid participant", Code: free4chat.CodeInvalidParticipantHandle}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID:   "inst-caps",
		RoomID:       "test",
		Name:         "Agent",
		Client:       client,
		Adapter:      adapter,
		WaitSeconds:  1,
		Capabilities: []string{"code"},
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	// Join #1 is the initial start; wait #1 fails with an invalid handle and
	// triggers join #2 — still advertising the ORIGINAL list.
	waitFor(t, 2*time.Second, func() bool { return client.joinCount() >= 2 }, "rejoin")

	// Update the advertised list while resident; a LATER lease-expiry rejoin
	// must carry the new tokens, never the stale ones.
	if err := rt.UpdateCapabilities([]string{"research", "ops"}); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	client.pushWaitStep(&free4chat.Error{Message: "invalid participant", Code: free4chat.CodeInvalidParticipantHandle})
	waitFor(t, 2*time.Second, func() bool { return client.joinCount() >= 3 }, "post-update rejoin")
	rt.Stop()

	client.mu.Lock()
	allCaps := append([][]string(nil), client.capsSeen...)
	client.mu.Unlock()
	if len(allCaps) < 3 {
		t.Fatalf("expected three joins, got %d", len(allCaps))
	}
	if len(allCaps[0]) != 1 || allCaps[0][0] != "code" {
		t.Fatalf("initial advertisement mismatch: %v", allCaps[0])
	}
	if len(allCaps[1]) != 1 || allCaps[1][0] != "code" {
		t.Fatalf("pre-update rejoin mismatch: %v", allCaps[1])
	}
	last := allCaps[len(allCaps)-1]
	if len(last) != 2 || last[0] != "research" || last[1] != "ops" {
		t.Fatalf("rejoin must advertise the latest list: %v", last)
	}
}

func TestSequentialAddressedTurnsDeliverInOrder(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{
			roomEvent(1, true),
			roomEvent(2, false),
			roomEvent(3, true),
		}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-order", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) >= 2 }, "two replies")
	rt.Stop()

	sent := client.snapshotSent()
	if len(sent) != 2 || sent[0] != "reply-1" || sent[1] != "reply-2" {
		t.Fatalf("ordered delivery broken: %v", sent)
	}
	details := adapter.turnSnapshot()
	if len(details) != 2 || details[0] != "message-1" {
		t.Fatalf("first turn context mismatch: %v", details)
	}
	if !strings.Contains(details[1], "message-2") || !strings.Contains(details[1], "message-3") {
		t.Fatalf("second turn must carry unaddressed context too: %v", details[1])
	}
}

func (a *fakeAdapter) turnSnapshot() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.turnDtls...)
}

func TestAttachmentEnrichmentImageResolvedInRuntime(t *testing.T) {
	event := roomEvent(1, true)
	event.Type = "image"
	event.Attachment = &types.RoomAttachmentMetadata{
		ID: "att-1", FileName: "image.png", MimeType: "image/png", Size: 10,
	}
	client := &fakeClient{}
	client.script = []waitStep{{events: []types.RoomEvent{event}}}
	adapter := &fakeAdapter{name: "pi"}
	var sawImage bool
	done := make(chan struct{})
	original := adapterRunTurnHook
	adapterRunTurnHook = func(a *fakeAdapter, input types.HarnessTurnInput) {
		defer close(done)
		sawImage = input.Events[0].Image != nil && input.Events[0].Image.Data == "Zm9v"
	}
	defer func() { adapterRunTurnHook = original }()

	rt := NewResidentRuntime(Options{
		InstanceID: "inst-image", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		rt.Stop()
		t.Fatal("turn never ran")
	}
	rt.Stop()
	if !sawImage {
		t.Fatal("image block was not resolved before the Harness turn")
	}
}

// TestCapabilityHandleNeverEscapesRuntime pins the core security invariant:
// the bearer capability appears in no log line, no status payload, and no
// Harness turn projection.
func TestCapabilityHandleNeverEscapesRuntime(t *testing.T) {
	logLines := []string{}
	var logMu sync.Mutex
	logFunc := func(event string, details map[string]string) {
		logMu.Lock()
		defer logMu.Unlock()
		line := event
		for key, value := range details {
			line += " " + key + "=" + value
		}
		logLines = append(logLines, line)
	}

	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-secure", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
		Log: logFunc,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) >= 1 }, "reply")
	statusJSON := mustJSON(t, rt.Status())
	rt.Stop()

	handle := client.currentJoinedHandle()
	if handle == "" {
		t.Fatal("test setup: no joined handle to guard")
	}
	for _, surface := range []struct {
		name string
		body string
	}{
		{"logs", strings.Join(logLines, "\n")},
		{"status", statusJSON},
	} {
		if strings.Contains(surface.body, handle) {
			t.Fatalf("capability value leaked into %s:\n%s", surface.name, surface.body)
		}
	}
	for _, input := range adapter.turnSnapshot() {
		if strings.Contains(input, handle) {
			t.Fatal("capability value leaked into Harness turn input")
		}
	}
}

// currentJoinedHandle returns the most recent joined capability value.
func (c *fakeClient) currentJoinedHandle() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	joins := c.joins
	if joins == 0 {
		return ""
	}
	return "secret-" + itoa(int64(joins))
}
