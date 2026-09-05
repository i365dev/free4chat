package runtime

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"time"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestReloadSpeechReplacesOptionalConfigWithoutTextLifecycleChange(t *testing.T) {
	initial := speech.Config{}
	rt := NewResidentRuntime(Options{Speech: &initial})
	rt.state = StateWaiting

	next := speech.Config{APIKey: "runtime-private-key", STTEnabled: true, TTSEnabled: true}
	rt.ReloadSpeech(next)

	if !rt.speechConfig.STTEnabled || !rt.speechConfig.TTSEnabled {
		t.Fatalf("speech config was not reloaded: %+v", rt.speechConfig)
	}
	if rt.state != StateWaiting {
		t.Fatalf("speech reload changed text lifecycle state: %s", rt.state)
	}
}

func TestReloadSpeechBeforeStopRebuildsThenStopTearsDown(t *testing.T) {
	rt := mediaRuntimeForReloadTest(t)
	rt.ReloadSpeech(speech.Config{APIKey: "runtime-private-key", STTEnabled: true, TTSEnabled: true})
	waitFor(t, time.Second, func() bool { return hasMediaController(rt) }, "media controller after reload")
	rt.Stop()
	if hasMediaController(rt) {
		t.Fatal("Stop must tear down a controller built by reload")
	}
}

func TestReloadSpeechCannotReviveStoppedRuntime(t *testing.T) {
	rt := mediaRuntimeForReloadTest(t)
	rt.Stop()

	done := make(chan struct{})
	go func() {
		rt.ReloadSpeech(speech.Config{APIKey: "runtime-private-key", STTEnabled: true, TTSEnabled: true})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reload did not return after Stop")
	}
	if hasMediaController(rt) {
		t.Fatal("reload created a controller after shutdown began")
	}
}

func TestConcurrentReloadAndStopLeaveNoMediaController(t *testing.T) {
	rt := mediaRuntimeForReloadTest(t)
	done := make(chan struct{})
	go func() {
		rt.ReloadSpeech(speech.Config{APIKey: "runtime-private-key", STTEnabled: true, TTSEnabled: true})
		close(done)
	}()
	rt.Stop()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("concurrent reload did not return")
	}
	if hasMediaController(rt) {
		t.Fatal("concurrent Stop left a media controller behind")
	}
}

func mediaRuntimeForReloadTest(t *testing.T) *ResidentRuntime {
	t.Helper()
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		RoomID: "room", Name: "Agent", Client: client, Adapter: adapter,
		SiteOrigin: "https://www.free4.chat",
	})
	handleJSON, err := json.Marshal(map[string]string{
		"room": "room", "participantId": "agent", "participantToken": "token",
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	rt.participantHandle = base64.RawURLEncoding.EncodeToString(handleJSON)
	rt.participantID = "agent"
	rt.state = StateWaiting
	rt.mu.Unlock()
	return rt
}

func hasMediaController(rt *ResidentRuntime) bool {
	rt.mediaMu.Lock()
	defer rt.mediaMu.Unlock()
	return rt.mediaController != nil
}

// fakeClient scripts wait_for_events responses and records lifecycle calls.
type fakeClient struct {
	mu    sync.Mutex
	waits int
	joins int
	sent  []string
	// sentTargets mirrors sent: the explicit targets (#165) each reply
	// carried, nil for ordinary unaddressed sends.
	sentTargets [][]string
	// hostsSeen records the #176 Runtime Host projection each join carried
	// (nil = legacy caller); hostUpdates records hot-reload pushes.
	hostsSeen   []*types.RuntimeHostProjection
	hostUpdates []types.RuntimeHostProjection
	leftRoom    bool
	leaveCalls  int
	leaveErr    error
	closed      bool
	capsSeen    [][]string
	script      []waitStep
	defaultOK   bool
	// sendHook observes every SendText in order (tests may inject).
	sendHook func(text string)
	// sendFailuresRemaining makes the NEXT N SendText calls fail (#228:
	// deterministic send-failure scripting).
	sendFailuresRemaining int
	contextResult         types.RoomContextReadResult
	contextErr            error
	contextCalls          int
	contextOptions        []types.RoomContextReadOptions
}

type transcriptClient struct {
	*fakeClient
	roomInfo types.RoomInfo
	roomErr  error
	appends  []types.LiveTranscriptSegment
}

func (c *transcriptClient) RoomInfo(string) (types.RoomInfo, error) {
	return c.roomInfo, c.roomErr
}

func (c *transcriptClient) AppendLiveTranscript(_ string, epoch int64, segmentID, sourceParticipantID, text string) error {
	c.appends = append(c.appends, types.LiveTranscriptSegment{
		SegmentID: segmentID, Epoch: epoch, ParticipantID: sourceParticipantID, Text: text,
	})
	return nil
}

func TestLiveTranscriptRefreshAndProducerPublishingAreBoundedAndGenerationGated(t *testing.T) {
	client := &transcriptClient{fakeClient: &fakeClient{}, roomInfo: types.RoomInfo{
		Exists: true,
		LiveTranscriptSegments: []types.LiveTranscriptSegment{{
			SegmentID: "lt_shared", Epoch: 3, Sequence: 8, ParticipantID: "human", Speaker: "Human", Text: "Shared decision.", CreatedAt: 9,
		}},
	}}
	rt := NewResidentRuntime(Options{RoomID: "room", Client: client, Adapter: &fakeAdapter{name: "pi"}})
	input := &types.HarnessTurnInput{}
	rt.attachLiveTranscript(input)
	if input.LiveTranscript == nil || len(input.LiveTranscript.Segments) != 1 || input.LiveTranscript.Segments[0].Text != "Shared decision." {
		t.Fatalf("fresh room shared transcript missing: %#v", input.LiveTranscript)
	}

	rt.mu.Lock()
	rt.participantHandle = "private-handle"
	rt.liveTranscript = types.LiveTranscriptInfo{Active: true, Epoch: 3}
	rt.liveTranscriptProducing = true
	rt.sttGeneration = 4
	rt.mu.Unlock()
	rt.publishLiveTranscriptSegment(4, "human", "Committed locally")
	if len(client.appends) != 1 || client.appends[0].Epoch != 3 || client.appends[0].ParticipantID != "human" {
		t.Fatalf("expected one authenticated append, got %#v", client.appends)
	}

	// A Stop/reassignment increments the logical producer state before a late
	// provider callback can publish; no stale segment reaches Room control.
	rt.mu.Lock()
	rt.liveTranscriptProducing = false
	rt.mu.Unlock()
	rt.publishLiveTranscriptSegment(4, "human", "Must be dropped")
	if len(client.appends) != 1 {
		t.Fatalf("stale generation published after revocation: %#v", client.appends)
	}
}

func TestTranscriptDeltasAdvanceOnlyAfterSuccessfulHarnessTurn(t *testing.T) {
	client := &transcriptClient{fakeClient: &fakeClient{}, roomInfo: types.RoomInfo{
		Exists: true,
		LiveTranscriptSegments: []types.LiveTranscriptSegment{{
			Sequence: 8, ParticipantID: "human", Speaker: "Ada", Text: "first shared speech",
		}},
	}}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-transcript", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	store := speech.NewTranscriptStore(t.TempDir() + "/meeting.jsonl")
	defer store.Dispose()
	if err := store.Ready(); err != nil {
		t.Fatalf("meeting store ready: %v", err)
	}
	rt.transcript = store
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	store.Record(speech.AudioSource{ParticipantID: "human", ParticipantName: "Ada"}, "first local speech")

	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	if len(captured) != 1 || captured[0].LiveTranscript == nil || len(captured[0].LiveTranscript.Segments) != 1 ||
		captured[0].MeetingTranscript == nil || len(captured[0].MeetingTranscript.Segments) != 1 {
		t.Fatalf("first transcript deltas missing: %#v", captured)
	}

	// Unchanged shared/local transcript state is absent from a later turn.
	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()
	if captured[1].LiveTranscript != nil || captured[1].MeetingTranscript != nil {
		t.Fatalf("unchanged transcript snapshots replayed: %#v", captured[1])
	}

	client.roomInfo.LiveTranscriptSegments = append(client.roomInfo.LiveTranscriptSegments,
		types.LiveTranscriptSegment{Sequence: 9, ParticipantID: "human", Speaker: "Ada", Text: "new shared speech"})
	store.Record(speech.AudioSource{ParticipantID: "human", ParticipantName: "Ada"}, "new local speech")
	adapter.mu.Lock()
	adapter.turnErr = errors.New("ambiguous")
	adapter.mu.Unlock()
	rt.acceptEvent(roomEvent(3, true))
	rt.drainTurns()
	if len(captured) != 3 || captured[2].LiveTranscript.Segments[0].Sequence != 9 ||
		captured[2].MeetingTranscript.Segments[0].Sequence != 2 {
		t.Fatalf("new transcript deltas missing from failed turn: %#v", captured)
	}
	meeting, live := rt.transcriptDeliveryMarkers()
	if meeting != 1 || live != 8 {
		t.Fatalf("failed turn acknowledged transcript delta: meeting=%d live=%d", meeting, live)
	}

	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.drainTurns()
	if len(captured) != 4 || captured[3].LiveTranscript.Segments[0].Sequence != 9 ||
		captured[3].MeetingTranscript.Segments[0].Sequence != 2 {
		t.Fatalf("failed transcript delta was not retried: %#v", captured)
	}
	meeting, live = rt.transcriptDeliveryMarkers()
	if meeting != 2 || live != 9 {
		t.Fatalf("successful retry did not acknowledge transcript delta: meeting=%d live=%d", meeting, live)
	}
}

func TestTranscriptDeliveryFloorsSurviveRepeatedACPReplacement(t *testing.T) {
	client := &transcriptClient{fakeClient: &fakeClient{}, roomInfo: types.RoomInfo{
		Exists: true,
		LiveTranscriptSegments: []types.LiveTranscriptSegment{{
			Sequence: 100, ParticipantID: "human", Speaker: "Ada", Text: "old shared speech",
		}},
	}}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-transcript-replacement", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	store := speech.NewTranscriptStore(t.TempDir() + "/meeting.jsonl")
	defer store.Dispose()
	if err := store.Ready(); err != nil {
		t.Fatalf("meeting store ready: %v", err)
	}
	rt.transcript = store
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	store.Record(speech.AudioSource{ParticipantID: "human", ParticipantName: "Ada"}, "old local speech")

	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	// The initial retained ACP session successfully consumes the old local and
	// Room-wide transcript state.
	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	if len(captured) != 1 || captured[0].MeetingTranscript == nil ||
		captured[0].MeetingTranscript.Segments[0].Sequence != 1 || captured[0].LiveTranscript == nil ||
		captured[0].LiveTranscript.Segments[0].Sequence != 100 {
		t.Fatalf("initial transcript delivery mismatch: %#v", captured)
	}

	// A replacement gets only the newly committed delta, but its turn fails
	// before acknowledgement.
	adapter.recreateSession()
	store.Record(speech.AudioSource{ParticipantID: "human", ParticipantName: "Ada"}, "new local speech")
	client.roomInfo.LiveTranscriptSegments = append(client.roomInfo.LiveTranscriptSegments,
		types.LiveTranscriptSegment{Sequence: 101, ParticipantID: "human", Speaker: "Ada", Text: "new shared speech"})
	adapter.mu.Lock()
	adapter.turnErr = errors.New("ambiguous")
	adapter.mu.Unlock()
	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()
	if len(captured) != 2 || captured[1].MeetingTranscript == nil ||
		captured[1].MeetingTranscript.Segments[0].Sequence != 2 || captured[1].LiveTranscript == nil ||
		captured[1].LiveTranscript.Segments[0].Sequence != 101 {
		t.Fatalf("failed replacement did not receive only its new transcript delta: %#v", captured)
	}

	// Replacing ACP again must retain the original pull-only floors despite the
	// failed session resetting its delivered markers; only the failed delta is
	// proactively retried.
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	adapter.recreateSession()
	rt.drainTurns()
	if len(captured) != 3 || captured[2].MeetingTranscript == nil ||
		len(captured[2].MeetingTranscript.Segments) != 1 || captured[2].MeetingTranscript.Segments[0].Sequence != 2 ||
		captured[2].LiveTranscript == nil || len(captured[2].LiveTranscript.Segments) != 1 ||
		captured[2].LiveTranscript.Segments[0].Sequence != 101 {
		t.Fatalf("second replacement replayed old transcript bulk: %#v", captured)
	}
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

func (c *fakeClient) ReadRoomContext(_ string, options types.RoomContextReadOptions) (types.RoomContextReadResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.contextCalls++
	c.contextOptions = append(c.contextOptions, options)
	return c.contextResult, c.contextErr
}

func (c *fakeClient) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection) (types.JoinResult, error) {
	c.mu.Lock()
	c.hostsSeen = append(c.hostsSeen, host)
	c.mu.Unlock()
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

func (c *fakeClient) UpdateRuntimeHost(_ string, host types.RuntimeHostProjection) error {
	c.mu.Lock()
	c.hostUpdates = append(c.hostUpdates, host)
	c.mu.Unlock()
	return nil
}

func (c *fakeClient) WaitForEvents(handle string, cursor int64, timeoutSeconds int) (types.WaitResult, error) {
	var step waitStep
	scripted := false
	func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if len(c.script) > 0 {
			step = c.script[0]
			c.script = c.script[1:]
			scripted = true
		}
	}()
	if !scripted {
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

func (c *fakeClient) SendText(_ string, text string, targets []string) (types.SendTextResult, error) {
	c.mu.Lock()
	if c.sendFailuresRemaining > 0 {
		c.sendFailuresRemaining--
		c.mu.Unlock()
		return types.SendTextResult{}, errors.New("send failed")
	}
	c.mu.Unlock()
	c.sent = append(c.sent, text)
	c.sentTargets = append(c.sentTargets, append([]string(nil), targets...))
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
	defer c.mu.Unlock()
	c.leaveCalls++
	if c.leaveErr != nil {
		return c.leaveErr
	}
	c.leftRoom = true
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
	// turnTargets scripts TargetParticipantIDs per turn (#165); nil entries
	// keep the reply unaddressed.
	turnTargets [][]string
	// turnResults scripts complete Harness results for lifecycle tests. When
	// absent, the legacy reply-N/turnTargets behavior stays unchanged.
	turnResults []types.HarnessTurnResult
	onFail      func(error)
	sessions    int
	generation  int64
	// replaceBeforeRun simulates a process/session replacement in the narrow
	// interval after Runtime.EnsureSession but before it can bind RunTurn.
	replaceBeforeRun bool
	stopped          bool
	delay            time.Duration
}

// adapterRunTurnHook lets individual tests observe the exact enriched turn
// input handed to the Harness (nil in most tests).
var adapterRunTurnHook func(*fakeAdapter, types.HarnessTurnInput)

func (a *fakeAdapter) Name() string { return a.name }

func (a *fakeAdapter) Capabilities() *types.HarnessCapabilities { return a.caps }

func (a *fakeAdapter) EnsureSession() error {
	a.mu.Lock()
	if a.generation == 0 {
		a.generation = 1
	}
	a.mu.Unlock()
	return nil
}

func (a *fakeAdapter) SessionGeneration() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.generation
}

func (a *fakeAdapter) RunTurn(input types.HarnessTurnInput, expectedGeneration int64) (types.HarnessTurnResult, error) {
	a.mu.Lock()
	if a.replaceBeforeRun {
		a.generation++
		a.replaceBeforeRun = false
	}
	if expectedGeneration <= 0 || a.generation != expectedGeneration {
		a.mu.Unlock()
		return types.HarnessTurnResult{}, types.ErrHarnessSessionGenerationChanged
	}
	a.mu.Unlock()
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
	count := a.sessions
	if count > 0 && len(a.turnResults) >= count {
		result := a.turnResults[count-1]
		result.TargetParticipantIDs = append([]string(nil), result.TargetParticipantIDs...)
		a.mu.Unlock()
		return result, nil
	}
	var targets []string
	if count > 0 && len(a.turnTargets) >= count {
		targets = append([]string(nil), a.turnTargets[count-1]...)
	}
	a.mu.Unlock()
	return types.HarnessTurnResult{
		Text:                 "reply-" + itoa(int64(count)),
		TargetParticipantIDs: targets,
	}, nil
}

func (a *fakeAdapter) sessionsInt() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions
}

func (a *fakeAdapter) recreateSession() {
	a.mu.Lock()
	if a.generation == 0 {
		a.generation = 1
	}
	a.generation++
	a.mu.Unlock()
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

// snapshotSentTargets mirrors snapshotSent with the explicit targets (#165)
// each send carried.
func (c *fakeClient) snapshotSentTargets() [][]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]string(nil), c.sentTargets...)
}

// snapshotHosts mirrors snapshotSent with the #176 Runtime Host projection
// each join carried (nil = legacy caller).
func (c *fakeClient) snapshotHosts() []*types.RuntimeHostProjection {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*types.RuntimeHostProjection(nil), c.hostsSeen...)
}

// snapshotHostUpdates mirrors snapshotSent with the #176 hot-reload
// projection pushes.
func (c *fakeClient) snapshotHostUpdates() []types.RuntimeHostProjection {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]types.RuntimeHostProjection(nil), c.hostUpdates...)
}

// #165: structured targets decided by the Harness must ride the reply into
// send_text; the runtime neither drops nor rewrites them.
func TestAddressedTurnReplyCarriesExplicitTargets(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi", turnTargets: [][]string{{"peer-hermes", "peer-codex"}}}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-targets",
		RoomID:      "test-targets",
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

	targets := client.snapshotSentTargets()
	if len(targets) != 1 {
		t.Fatalf("exactly-once send violated: %v", client.snapshotSent())
	}
	if len(targets[0]) != 2 || targets[0][0] != "peer-hermes" || targets[0][1] != "peer-codex" {
		t.Fatalf("explicit targets must reach send_text unchanged: %v", targets[0])
	}
}

// #165: a Harness result without targets stays an ordinary unaddressed send.
func TestUnaddressedReplyKeepsNoTargets(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-plain",
		RoomID:      "test-plain",
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

	targets := client.snapshotSentTargets()
	if len(targets) != 1 || targets[0] != nil {
		t.Fatalf("plain reply must carry no targets: %v", targets)
	}
}

func TestHumanAddressedLifecycleLeaveIsConfirmedBeforeDaemonCleanup(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
		// A replay/stale later wait result must never produce a second leave or
		// a second reply after the first confirmed self-leave stops the loop.
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi", turnResults: []types.HarnessTurnResult{{
		Text:            "I left the Room and will not return.",
		LifecycleIntent: types.LifecycleIntentLeave,
	}}}
	cleanupDone := make(chan struct{})
	var rt *ResidentRuntime
	rt = NewResidentRuntime(Options{
		InstanceID: "inst-self-leave", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
		OnSelfLeave: func() {
			// This mirrors the daemon handoff: Stop runs after this turn can
			// return, so it never waits on its own loopWG goroutine.
			go func() {
				rt.Stop()
				close(cleanupDone)
			}()
		},
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	select {
	case <-cleanupDone:
	case <-time.After(2 * time.Second):
		t.Fatal("confirmed lifecycle leave deadlocked during cleanup")
	}

	if !client.leftRoomFlag() || client.leaveCallCount() != 1 {
		t.Fatalf("leave must be confirmed exactly once: left=%v calls=%d", client.leftRoomFlag(), client.leaveCallCount())
	}
	if sent := client.snapshotSent(); len(sent) != 0 {
		t.Fatalf("arbitrary Harness success body must never publish before leave: %v", sent)
	}
	if got := adapter.sessionsInt(); got != 1 || !adapter.closeConfirmed() {
		t.Fatalf("stale turn or adapter cleanup mismatch: turns=%d closed=%v", got, adapter.closeConfirmed())
	}
	if status := rt.Status(); status.State != StateStopped || status.ParticipantID != "" {
		t.Fatalf("confirmed leave must be terminal and clear public participation: %+v", status)
	}
	if joins := client.joinCount(); joins != 1 {
		t.Fatalf("intentional leave must not rejoin, got %d joins", joins)
	}
}

func TestLifecycleLeaveRequiresAddressedHumanAndNeverPublishesHarnessClaim(t *testing.T) {
	client := &fakeClient{}
	humanContext := roomEvent(1, false)
	agentAddress := roomEvent(2, true)
	agentAddress.Participant = types.ParticipantIdentity{ID: "agent-peer", Name: "Hermes", Kind: types.KindAgent}
	client.script = []waitStep{{events: []types.RoomEvent{humanContext, agentAddress}}}
	adapter := &fakeAdapter{name: "pi", turnResults: []types.HarnessTurnResult{{
		Text:            "I left the Room.",
		LifecycleIntent: types.LifecycleIntentLeave,
	}}}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-ineligible", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) == 1 }, "truthful lifecycle rejection")
	if client.leaveCallCount() != 0 || client.leftRoomFlag() {
		t.Fatalf("Agent-authored/non-addressed context must not invoke leave: calls=%d left=%v", client.leaveCallCount(), client.leftRoomFlag())
	}
	if sent := client.snapshotSent(); len(sent) != 1 || sent[0] != lifecycleLeaveFailureText {
		t.Fatalf("ineligible lifecycle must replace model claim with fixed truth: %v", sent)
	}
	if rt.Status().State == StateStopped {
		t.Fatal("ineligible lifecycle must leave the resident recoverable")
	}
	rt.Stop()
}

func TestLifecycleLeaveFailureKeepsResidentAndReportsFixedTruth(t *testing.T) {
	client := &fakeClient{leaveErr: errors.New("leave transport failed")}
	client.script = []waitStep{{events: []types.RoomEvent{roomEvent(1, true)}}}
	adapter := &fakeAdapter{name: "pi", turnResults: []types.HarnessTurnResult{{
		Text:            "Goodbye, I have disconnected.",
		LifecycleIntent: types.LifecycleIntentLeave,
	}}}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-leave-failure", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) == 1 }, "truthful lifecycle failure")
	if client.leaveCallCount() != 1 || client.leftRoomFlag() {
		t.Fatalf("failed self-leave must not be treated as success: calls=%d left=%v", client.leaveCallCount(), client.leftRoomFlag())
	}
	if sent := client.snapshotSent(); len(sent) != 1 || sent[0] != lifecycleLeaveFailureText {
		t.Fatalf("failure must not publish Harness success wording: %v", sent)
	}
	if status := rt.Status(); status.State == StateStopped || status.ParticipantID == "" {
		t.Fatalf("failed leave must remain a live recoverable resident: %+v", status)
	}
	if adapter.closeConfirmed() {
		t.Fatal("failed leave must not tear down the Harness")
	}
	// Restore normal fake transport so test teardown remains the existing
	// best-effort operator Stop path rather than another failed self-leave.
	client.mu.Lock()
	client.leaveErr = nil
	client.mu.Unlock()
	rt.Stop()
}

func TestLifecycleLeaveRejectsAmbiguousTargetsEvenFromCustomAdapter(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{{events: []types.RoomEvent{roomEvent(1, true)}}}
	adapter := &fakeAdapter{name: "pi", turnResults: []types.HarnessTurnResult{{
		Text:                 "I left and handed off.",
		TargetParticipantIDs: []string{"agent-peer"},
		LifecycleIntent:      types.LifecycleIntentLeave,
	}}}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-ambiguous", RoomID: "test", Name: "Pi",
		Client: client, Adapter: adapter, WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotSent()) == 1 }, "ambiguous lifecycle rejection")
	if client.leaveCallCount() != 0 || client.snapshotSent()[0] != lifecycleLeaveFailureText {
		t.Fatalf("ambiguous lifecycle result must fail closed: leaves=%d sent=%v", client.leaveCallCount(), client.snapshotSent())
	}
	rt.Stop()
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
	expired := make(chan struct{})
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-expiry", RoomID: "test", Name: "Agent",
		Client: client, Adapter: adapter, WaitSeconds: 1,
		OnRoomExpired: func() error { close(expired); return nil },
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	select {
	case <-expired:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for expiry notification")
	}

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

func (c *fakeClient) leaveCallCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.leaveCalls
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

func TestRetainedHarnessDeliveryAcknowledgesOnlySuccessfulTurn(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("ambiguous ACP failure")}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-delivery", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.acceptEvent(roomEvent(1, false))
	rt.acceptEvent(roomEvent(2, false))
	rt.acceptEvent(roomEvent(3, true))

	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.drainTurns()
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 3 {
		t.Fatalf("failed turn must retain its addressed target: %v", got)
	}
	if got := rt.deliveredSeq(); got != 0 {
		t.Fatalf("failed turn advanced deliveredThrough to %d", got)
	}
	if len(captured) != 1 || !captured[0].Session.New || len(captured[0].Events) != 3 {
		t.Fatalf("first session must receive bootstrap + full first delta: %#v", captured)
	}

	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.drainTurns()
	if got := rt.pendingAddressedSnapshot(); len(got) != 0 {
		t.Fatalf("successful retry did not acknowledge target: %v", got)
	}
	if got := rt.deliveredSeq(); got != 3 {
		t.Fatalf("successful retry did not advance deliveredThrough: %d", got)
	}
	if len(captured) != 2 || !captured[1].Session.New || len(captured[1].Events) != 3 {
		t.Fatalf("a failed bootstrap must retry the same unacknowledged delta with bootstrap context: %#v", captured)
	}

	rt.acceptEvent(roomEvent(4, true))
	rt.drainTurns()
	if len(captured) != 3 || captured[2].Session.New || len(captured[2].Events) != 1 || captured[2].Events[0].Sequence != 4 {
		t.Fatalf("later retained-session prompt must be a delta, got %#v", captured)
	}
}

func TestHarnessGenerationReplacementRebuildsBootstrapBeforePrompt(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-generation-race", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	adapter.mu.Lock()
	adapter.replaceBeforeRun = true
	adapter.mu.Unlock()
	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 2 {
		t.Fatalf("generation mismatch acknowledged pending work: %v", got)
	}
	if len(captured) != 1 {
		t.Fatalf("stale non-bootstrap prompt reached a replacement session: %#v", captured)
	}

	rt.drainTurns()
	if len(captured) != 2 || !captured[1].Session.New {
		t.Fatalf("replacement generation did not receive bootstrap context: %#v", captured)
	}
	if len(captured[1].Events) != 1 || captured[1].Events[0].Sequence != 2 {
		t.Fatalf("replacement generation received the wrong Room delta: %#v", captured[1].Events)
	}
}

func TestFailedTurnPinsContextAcrossQueueSaturationAndBufferEviction(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("ambiguous ACP failure")}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-pinned-context", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.acceptEvent(roomEvent(1, false))
	rt.acceptEvent(roomEvent(2, false))
	rt.acceptEvent(roomEvent(3, true))
	rt.drainTurns()
	for sequence := int64(4); sequence < int64(4+MaxPendingTurns+defaultMaxEvents); sequence++ {
		rt.acceptEvent(roomEvent(sequence, true))
	}
	if got := rt.pendingAddressedSnapshot(); len(got) != MaxPendingTurns || got[0] != 3 {
		t.Fatalf("queue saturation evicted the failed head: %v", got)
	}

	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.drainTurns()
	if len(captured) < 2 || len(captured[1].Events) != 3 {
		t.Fatalf("failed turn did not retry its pinned delta: %#v", captured)
	}
	for index, event := range captured[1].Events {
		if event.Sequence != int64(index+1) {
			t.Fatalf("pinned retry lost sequence %d: %#v", index+1, captured[1].Events)
		}
	}
}

func TestPendingTurnRecoversEvictedContextFromRoomHistory(t *testing.T) {
	client := &fakeClient{contextResult: types.RoomContextReadResult{Room: types.RoomContextWindow{
		Events: []types.RoomEvent{
			roomEvent(1, false), roomEvent(2, false), roomEvent(3, true),
		},
	}}}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-context-recovery", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	rt.mu.Lock()
	rt.pendingAddressed = []int64{3}
	rt.pendingContexts = map[int64]pendingTurnContext{3: {after: 0, target: 3}}
	rt.mu.Unlock()
	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.drainTurns()
	client.mu.Lock()
	contextCalls := client.contextCalls
	contextOptions := append([]types.RoomContextReadOptions(nil), client.contextOptions...)
	client.mu.Unlock()
	if contextCalls != 1 || len(captured) != 1 || len(captured[0].Events) != 3 {
		t.Fatalf("evicted pending context was not recovered: calls=%d turns=%#v", contextCalls, captured)
	}
	if len(contextOptions) != 1 || contextOptions[0].AfterSequence == nil || *contextOptions[0].AfterSequence != 0 ||
		contextOptions[0].BeforeSequence == nil || *contextOptions[0].BeforeSequence != 4 {
		t.Fatalf("pending recovery did not request the forward zero cursor range: %#v", contextOptions)
	}
}

func TestSendFailureDoesNotReplaySuccessfulHarnessDelivery(t *testing.T) {
	client := &fakeClient{sendFailuresRemaining: 1}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-send-boundary", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()

	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	if rt.deliveredSeq() != 1 || len(rt.pendingAddressedSnapshot()) != 0 {
		t.Fatalf("RunTurn success must acknowledge context before SendText: delivered=%d pending=%v", rt.deliveredSeq(), rt.pendingAddressedSnapshot())
	}
	// There is no pending trigger to replay merely because the reply failed.
	rt.drainTurns()
	if len(captured) != 1 {
		t.Fatalf("send failure replayed an already-successful Harness prompt: %#v", captured)
	}

	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()
	if len(captured) != 2 || len(captured[1].Events) != 1 || captured[1].Events[0].Sequence != 2 {
		t.Fatalf("recovery prompt replayed old context after send failure: %#v", captured)
	}
}

func TestRoomRejoinPreservesSurvivingHarnessDeliveryState(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("turn lost")}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-rejoin", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent-1", ParticipantHandle: "secret-1", Cursor: 0})
	rt.acceptEvent(roomEvent(1, true))
	var captured []types.HarnessTurnInput
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
	}
	defer func() { adapterRunTurnHook = original }()
	rt.drainTurns()

	// A fresh Room credential/cursor is a transport rejoin, not a session/new.
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent-2", ParticipantHandle: "secret-2", Cursor: 10})
	if got := rt.pendingAddressedSnapshot(); len(got) != 1 || got[0] != 1 || rt.deliveredSeq() != 0 {
		t.Fatalf("rejoin discarded unacknowledged Harness work: pending=%v delivered=%d", got, rt.deliveredSeq())
	}
	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.drainTurns()
	if len(captured) != 2 || !captured[1].Session.New {
		t.Fatalf("Room rejoin must retry an unacknowledged bootstrap: %#v", captured)
	}
}

func TestNewHarnessSessionBootstrapsWithoutReplayingPriorRoomDelta(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-session", RoomID: "room", Name: "Pi",
		Client: client, Adapter: adapter,
	})
	rt.adoptJoin(types.JoinResult{ParticipantID: "agent", ParticipantHandle: "secret", Cursor: 0})
	var captured []types.HarnessTurnInput
	var deliveredAtRun []int64
	original := adapterRunTurnHook
	adapterRunTurnHook = func(_ *fakeAdapter, input types.HarnessTurnInput) {
		captured = append(captured, input)
		deliveredAtRun = append(deliveredAtRun, rt.deliveredSeq())
	}
	defer func() { adapterRunTurnHook = original }()

	rt.acceptEvent(roomEvent(1, true))
	rt.drainTurns()
	adapter.recreateSession()
	rt.acceptEvent(roomEvent(2, true))
	rt.drainTurns()
	if len(captured) != 2 || !captured[0].Session.New || !captured[1].Session.New {
		t.Fatalf("bootstrap must follow actual ACP session generations: %#v", captured)
	}
	if len(captured[1].Events) != 1 || captured[1].Events[0].Sequence != 2 {
		t.Fatalf("new Harness session automatically replayed prior Room delta: %#v", captured[1].Events)
	}
	if len(deliveredAtRun) != 2 || deliveredAtRun[1] != 0 {
		t.Fatalf("new Harness session inherited prior delivery acknowledgement: %v", deliveredAtRun)
	}
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

// #176 Phase A (as corrected by #178 review): joins carry the Room-scoped
// runtimeHostId DERIVED from the private root seed (never the raw seed);
// speech hot reload pushes the updated readiness without rejoining; the
// same root + Room always derives the same id.
func TestRuntimeHostProjectionJoinAndHotReload(t *testing.T) {
	client := &fakeClient{}
	adapter := &fakeAdapter{name: "pi"}
	seed := "33333333-4444-5555-6666-777777777777"
	derived, err := types.DeriveRuntimeHostID(seed, "test-host")
	if err != nil {
		t.Fatalf("derive failed: %v", err)
	}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-host",
		RoomID:      "test-host",
		Name:        "Pi",
		Client:      client,
		Adapter:     adapter,
		WaitSeconds: 1,
		HostSeed:    seed,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	// The projection rides the JOIN itself; no addressed turn is needed.
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotHosts()) >= 1 }, "join with host projection")

	hosts := client.snapshotHosts()
	if len(hosts) == 0 || hosts[0] == nil {
		t.Fatalf("join must carry the host projection, got %v", hosts)
	}
	if hosts[0].RuntimeHostID != derived {
		t.Fatalf("join must carry the DERIVED room-scoped id: got %s want %s (seed %s)",
			hosts[0].RuntimeHostID, derived, seed)
	}

	// Speech hot reload: readiness changes push an updated projection for
	// the SAME derived room-scoped id.
	rt.ReloadSpeech(speech.Config{STTEnabled: true, TTSEnabled: true})
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotHostUpdates()) >= 1 }, "host update push")
	updates := client.snapshotHostUpdates()
	if updates[0].RuntimeHostID != derived ||
		!updates[0].Speech.STT || !updates[0].Speech.TTS {
		t.Fatalf("hot reload must push updated readiness, got %+v", updates[0])
	}

	// The in-memory projection is consistent for every reader of this host.
	current := rt.CurrentHostProjection()
	if current == nil || current.RuntimeHostID != derived || !current.Speech.TTS {
		t.Fatalf("current projection must reflect reloaded readiness: %+v", current)
	}
	rt.Stop()
}

// #178 review fix 5: with no seed (legacy caller) the projection is simply
// absent — the text join is never blocked by the host path.
func TestRuntimeWithoutSeedJoinsWithoutHostProjection(t *testing.T) {
	client := &fakeClient{}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-noseed",
		RoomID:      "test-noseed",
		Name:        "Pi",
		Client:      client,
		Adapter:     &fakeAdapter{name: "pi"},
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return len(client.snapshotHosts()) >= 1 }, "join")
	if hosts := client.snapshotHosts(); len(hosts) != 1 || hosts[0] != nil {
		t.Fatalf("seedless runtime must join without a projection, got %v", hosts)
	}
	if rt.CurrentHostProjection() != nil {
		t.Fatal("seedless runtime must project nothing")
	}
	rt.Stop()
}

// #228: a recovered transient wait error must not linger in status, and
// participation age survives transient retries and lease recovery.
func TestTransientWaitErrorClearsAfterRecovery(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{err: errors.New("Connection closed: this Durable Object instance is no longer active.")},
	}
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-lasterr",
		RoomID:      "test-lasterr",
		Name:        "Pi",
		Client:      client,
		Adapter:     adapter,
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		return rt.Status().LastError != ""
	}, "transient wait error recorded")

	// Recovery: the next successful wait clears the stale error and keeps
	// the participation timestamp.
	waitFor(t, 5*time.Second, func() bool {
		return rt.Status().LastError == ""
	}, "recovered transient wait error cleared")

	since := rt.Status().ParticipatingSince
	if since <= 0 {
		t.Fatalf("participatingSince must be set after join: %d", since)
	}
	rt.Stop()
}

// #228 (review round 3): lastError provenance — each subsystem's SUCCESS
// clears only its OWN error. A successful wait never hides a Harness/send
// failure; a successful turn/send clears exactly its own source.

func TestHarnessFailureSurvivesSuccessfulWait(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("harness exploded")}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-harness",
		RoomID:      "test-harness",
		Name:        "Pi",
		Client:      client,
		Adapter:     adapter,
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		return rt.Status().LastError == "harness exploded"
	}, "harness-origin error recorded")

	// Successful long-polls must NOT erase the harness failure.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if rt.Status().LastError != "harness exploded" {
			t.Fatalf("successful wait must not clear a harness-origin failure")
		}
		time.Sleep(20 * time.Millisecond)
	}
	rt.Stop()
}

func TestHarnessFailureClearsAfterSuccessfulTurn(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{
			roomEvent(1, true),
			roomEvent(2, true),
		}},
	}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("harness exploded")}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-h2",
		RoomID:      "test-h2",
		Name:        "Pi",
		Client:      client,
		Adapter:     adapter,
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	// Sequencing via the adapter hook: turn 1 runs with turnErr set and
	// FAILS; the hook clears turnErr inside RunTurn so turn 2 (same drain)
	// SUCCEEDS — deterministic fail->success without wall-clock polling.
	// A bare LastError=="exploded" poll can miss the transient window
	// because both events arrive in one poll step.
	var sawFailure atomic.Bool
	originalHook := adapterRunTurnHook
	adapterRunTurnHook = func(a *fakeAdapter, input types.HarnessTurnInput) {
		a.mu.Lock()
		hadErr := a.turnErr != nil
		a.turnErr = nil // only the FIRST turn fails
		a.mu.Unlock()
		if hadErr {
			sawFailure.Store(true)
		}
	}
	defer func() { adapterRunTurnHook = originalHook }()

	waitFor(t, 5*time.Second, func() bool {
		return sawFailure.Load() && adapter.sessionsInt() >= 2
	}, "fail->success turn sequence executed")

	// Turn 2 succeeded and must have cleared the harness-origin error.
	waitFor(t, 5*time.Second, func() bool {
		return rt.Status().LastError == ""
	}, "successful turn clears harness-origin error")
	rt.Stop()
}

func TestSendFailureSurvivesSuccessfulWait(t *testing.T) {
	client := &fakeClient{}
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
	}
	client.sendFailuresRemaining = 1
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-send",
		RoomID:      "test-send",
		Name:        "Pi",
		Client:      client,
		Adapter:     &fakeAdapter{name: "pi"},
		WaitSeconds: 1,
	})
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rt.mu.Lock()
		lastErr := rt.lastError
		src := rt.lastErrorSource
		sends := len(client.snapshotSent())
		rt.mu.Unlock()
		t.Logf("send poll: lastError=%q src=%q sends=%d", lastErr, src, sends)
		if lastErr == "send failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Successful long-polls must NOT erase the send failure.
	keepDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(keepDeadline) {
		if rt.Status().LastError != "send failed" {
			t.Fatalf("successful wait must not clear a send-origin failure")
		}
		time.Sleep(20 * time.Millisecond)
	}
	rt.Stop()
}

func TestSendFailureClearsAfterSuccessfulSend(t *testing.T) {
	client := &fakeClient{}
	// Two steps with a GATE between them: the first event's send fails, the
	// test asserts the failure is recorded, then opens the gate so the
	// second event's send succeeds and clears the error — deterministically
	// ordered, no racy intermediate window.
	gate := make(chan struct{})
	client.script = []waitStep{
		{events: []types.RoomEvent{roomEvent(1, true)}},
		{events: []types.RoomEvent{roomEvent(2, true)}, gate: gate},
	}
	rt := NewResidentRuntime(Options{
		InstanceID:  "inst-send2",
		RoomID:      "test-send2",
		Name:        "Pi",
		Client:      client,
		Adapter:     &fakeAdapter{name: "pi"},
		WaitSeconds: 1,
	})
	client.sendFailuresRemaining = 1
	if err := rt.Start(); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		return rt.Status().LastError == "send failed"
	}, "send-origin error recorded")

	// The gate blocks event 2's delivery until the test opens it.
	close(gate)
	waitFor(t, 5*time.Second, func() bool {
		return rt.Status().LastError == ""
	}, "successful send clears send-origin error")
	rt.Stop()
}

// #228: participatingSince is set once per lifecycle and preserved across
// adoptJoin (lease-expiry reconnects reuse it).
func TestParticipatingSinceSetOncePerLifecycle(t *testing.T) {
	client := &fakeClient{}
	rt := NewResidentRuntime(Options{
		InstanceID: "inst-age",
		RoomID:     "test-age",
		Name:       "Pi",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	joined := types.JoinResult{
		ParticipantID:     "agent-1",
		ParticipantHandle: "secret-1",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	}
	rt.adoptJoin(joined)
	first := rt.Status().ParticipatingSince
	if first <= 0 {
		t.Fatalf("participatingSince must be set on first join")
	}
	time.Sleep(5 * time.Millisecond)
	rt.adoptJoin(joined)
	second := rt.Status().ParticipatingSince
	if second != first {
		t.Fatalf("participatingSince must be preserved across reconnects: %d vs %d", first, second)
	}
}
