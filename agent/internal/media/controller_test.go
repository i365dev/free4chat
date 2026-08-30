package media

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// fakeRoomClient scripts RoomInfo responses.
type fakeRoomClient struct {
	mu        sync.Mutex
	mnActive  bool
	mnAvail   bool
	mnAgent   string
	mnStarted int64
	vrActive  bool
	vrAvail   bool
	vrAgent   string
	vrStarted int64
	live      types.LiveTranscriptInfo
	err       error
}

func (f *fakeRoomClient) setRoom(mnActive, mnAvail, mnAgent string, mnStarted int64,
	vrActive, vrAvail, vrAgent string, vrStarted int64, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mnActive = mnActive == "on"
	f.mnAvail = mnAvail == "on"
	f.mnAgent = mnAgent
	f.mnStarted = mnStarted
	f.vrActive = vrActive == "on"
	f.vrAvail = vrAvail == "on"
	f.vrAgent = vrAgent
	f.vrStarted = vrStarted
	f.err = err
}

func (f *fakeRoomClient) RoomInfo(string) (types.RoomInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return types.RoomInfo{}, f.err
	}
	return types.RoomInfo{
		Exists: true,
		MeetingNotes: types.MeetingNotesInfo{
			Active: f.mnActive, AgentParticipantID: f.mnAgent, StartedAt: f.mnStarted,
		},
		MeetingNotesMediaAvailable: f.mnAvail,
		AgentVoice: func() map[string]types.AgentVoiceGrant {
			if !f.vrActive || f.vrAgent == "" || f.vrStarted <= 0 {
				return map[string]types.AgentVoiceGrant{}
			}
			return map[string]types.AgentVoiceGrant{
				f.vrAgent: {EnabledAt: f.vrStarted},
			}
		}(),
		AgentVoiceMediaAvailable: f.vrAvail,
		LiveTranscript:           f.live,
	}, nil
}

func (*fakeRoomClient) Connect() error               { return nil }
func (*fakeRoomClient) ListTools() ([]string, error) { return nil, nil }
func (*fakeRoomClient) JoinRoom(string, string, []string, *types.RuntimeHostProjection) (types.JoinResult, error) {
	return types.JoinResult{}, errors.New("not used")
}
func (*fakeRoomClient) UpdateRuntimeHost(string, types.RuntimeHostProjection) error {
	return nil
}
func (*fakeRoomClient) CreateRoom(string, []string) (types.CreateRoomResult, error) {
	return types.CreateRoomResult{}, errors.New("not used")
}
func (*fakeRoomClient) WaitForEvents(string, int64, int) (types.WaitResult, error) {
	time.Sleep(20 * time.Millisecond)
	return types.WaitResult{Cursor: 0, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, nil
}
func (*fakeRoomClient) SendText(string, string, []string) (types.SendTextResult, error) {
	return types.SendTextResult{}, nil
}
func (*fakeRoomClient) ReadAttachment(string, string) (types.AttachmentRead, error) {
	return types.AttachmentRead{}, errors.New("not used")
}
func (*fakeRoomClient) UpdateCapabilities(string, []string) error { return nil }
func (*fakeRoomClient) SendCollabRequest(string, types.CollabRequestArgs) (types.CollabRequestOutcome, error) {
	return types.CollabRequestOutcome{}, nil
}
func (*fakeRoomClient) SendCollabResponse(string, types.CollabResponseArgs) (types.SendTextResult, error) {
	return types.SendTextResult{}, nil
}
func (*fakeRoomClient) SendCollabResult(string, types.CollabResultArgs) (types.SendTextResult, error) {
	return types.SendTextResult{}, nil
}
func (*fakeRoomClient) UploadAttachment(string, types.AttachmentUpload) (types.UploadedAttachment, error) {
	return types.UploadedAttachment{}, errors.New("not used")
}
func (*fakeRoomClient) PublishSurface(string, types.SurfacePublishPayload) (types.RoomSurfaceMetadataV1, error) {
	return types.RoomSurfaceMetadataV1{}, errors.New("not used")
}
func (*fakeRoomClient) ClearSurface(string) error { return nil }
func (*fakeRoomClient) ReadSurface(string, string, string) (types.SurfaceReadResult, error) {
	return types.SurfaceReadResult{}, errors.New("not used")
}
func (*fakeRoomClient) LeaveRoom(string) error { return nil }
func (*fakeRoomClient) Close() error           { return nil }

type testLiveTranscriptCoordinator struct {
	mu     sync.Mutex
	leases map[string]struct {
		epoch int64
		owner string
	}
}

func (c *testLiveTranscriptCoordinator) Acquire(roomID, hostID string, epoch int64, instanceID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.leases == nil {
		c.leases = map[string]struct {
			epoch int64
			owner string
		}{}
	}
	key := roomID + "\x00" + hostID
	current, ok := c.leases[key]
	if !ok || current.epoch != epoch {
		c.leases[key] = struct {
			epoch int64
			owner string
		}{epoch: epoch, owner: instanceID}
		return true
	}
	return current.owner == instanceID
}

func (c *testLiveTranscriptCoordinator) Release(roomID, hostID string, epoch int64, instanceID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := roomID + "\x00" + hostID
	if current, ok := c.leases[key]; ok && current.epoch == epoch && current.owner == instanceID {
		delete(c.leases, key)
	}
}

// controllerHarness tracks bridge lifecycles through real fake-backed bridges.
type controllerHarness struct {
	mu      sync.Mutex
	engines []*fakeEngine
	rests   []*fakeRest
	bridges int
}

func (h *controllerHarness) createBridge() (*Bridge, error) {
	engine := newFakeEngine()
	engine.mid = "9"
	rest := newFakeRest()
	h.mu.Lock()
	h.engines = append(h.engines, engine)
	h.rests = append(h.rests, rest)
	h.bridges++
	h.mu.Unlock()
	options := testBridgeOptions(engine, rest, &PublishConfig{TrackName: "agent-voice"})
	bridge := NewBridge(options)
	return bridge, nil
}

func (h *controllerHarness) bridgeCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bridges
}

func (h *controllerHarness) engineAt(i int) *fakeEngine {
	h.mu.Lock()
	defer h.mu.Unlock()
	if i < 0 || i >= len(h.engines) {
		return nil
	}
	return h.engines[i]
}

func (h *controllerHarness) restAt(i int) *fakeRest {
	h.mu.Lock()
	defer h.mu.Unlock()
	if i < 0 || i >= len(h.rests) {
		return nil
	}
	return h.rests[i]
}

func newControllerHarness(t *testing.T, client *fakeRoomClient, voiceCfg *VoiceConfig) (*Controller, *controllerHarness) {
	t.Helper()
	harness := &controllerHarness{}
	controller := NewController(ControllerOptions{
		Client:         client,
		RoomID:         "room",
		ParticipantID:  "agent",
		SiteOrigin:     "https://www.free4.chat",
		Handle:         DecodedHandle{Room: "room", ParticipantID: "agent", ParticipantToken: "tok"},
		PollIntervalMs: 10,
		Voice:          voiceCfg,
		Log:            func(string, map[string]string) {},
		CreateBridge:   harness.createBridge,
		Now:            time.Now,
	})
	return controller, harness
}

func voiceConfigAlwaysReady() *VoiceConfig {
	return &VoiceConfig{
		TrackName: "agent-voice",
		CreateTtsProvider: func() (speech.StreamingTtsProvider, error) {
			return &fakeTtsProviderForMedia{}, nil
		},
		OnSpeakerEvent: func(voice.SpeakerEvent) {},
	}
}

// fakeTtsProviderForMedia emits a couple of PCM chunks then completes.
type fakeTtsProviderForMedia struct{}

func (*fakeTtsProviderForMedia) CreateSession() (speech.StreamingTtsSession, error) {
	return &fakeTtsSessionForMedia{}, nil
}

type fakeTtsSessionForMedia struct{}

func (s *fakeTtsSessionForMedia) Synthesize(text string, emit func(speech.TtsAudioChunk) error) error {
	for i := 0; i < 2; i++ {
		if err := emit(speech.TtsAudioChunk{Codec: "pcm_s16le", SampleRateHz: 24000, Channels: 1, Data: make([]byte, 960)}); err != nil {
			return err
		}
	}
	return nil
}

func (s *fakeTtsSessionForMedia) Close() error { return nil }

func waitController(t *testing.T, timeout time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", message)
}

func TestControllerLiveTranscriptElectsOneVerifiedSameHostProducer(t *testing.T) {
	client := &fakeRoomClient{live: types.LiveTranscriptInfo{
		Active: true, ProducerRuntimeHostID: "host-a", StartedByHumanParticipantID: "human", Epoch: 7, StartedAt: 9,
	}}
	coordinator := &testLiveTranscriptCoordinator{}
	harness := &controllerHarness{}
	var mu sync.Mutex
	states := map[string][]bool{}
	newLiveController := func(instanceID string) *Controller {
		return NewController(ControllerOptions{
			Client:                    client,
			RoomID:                    "room",
			ParticipantID:             instanceID,
			SiteOrigin:                "https://www.free4.chat",
			Handle:                    DecodedHandle{Room: "room", ParticipantID: instanceID, ParticipantToken: "tok"},
			RuntimeHostID:             "host-a",
			RuntimeInstanceID:         instanceID,
			LiveTranscriptCoordinator: coordinator,
			CanProduceLiveTranscript:  func() bool { return true },
			PollIntervalMs:            10_000,
			CreateBridge:              harness.createBridge,
			Log:                       func(string, map[string]string) {},
			OnLiveTranscriptState: func(_ types.LiveTranscriptInfo, producing bool) {
				mu.Lock()
				states[instanceID] = append(states[instanceID], producing)
				mu.Unlock()
			},
		})
	}
	first := newLiveController("agent-a")
	second := newLiveController("agent-b")
	defer second.Stop()
	defer first.Stop()
	first.Start(t.Context())
	waitController(t, time.Second, func() bool { return harness.bridgeCount() == 1 }, "first live producer")
	second.Start(t.Context())
	time.Sleep(20 * time.Millisecond)
	if got := harness.bridgeCount(); got != 1 {
		t.Fatalf("same Host must have one media producer bridge, got %d", got)
	}
	mu.Lock()
	firstStates := append([]bool(nil), states["agent-a"]...)
	secondStates := append([]bool(nil), states["agent-b"]...)
	mu.Unlock()
	if len(firstStates) == 0 || !firstStates[0] || len(secondStates) != 0 {
		t.Fatalf("unexpected producer ownership edges: first=%v second=%v", firstStates, secondStates)
	}

	// A Host mismatch is not a local failover trigger: neither resident may
	// produce for a Room grant naming another Runtime Host.
	client.mu.Lock()
	client.live.ProducerRuntimeHostID = "host-b"
	client.live.Epoch = 8
	client.mu.Unlock()
	first.poll()
	second.poll()
	mu.Lock()
	firstStates = append([]bool(nil), states["agent-a"]...)
	secondStates = append([]bool(nil), states["agent-b"]...)
	mu.Unlock()
	if last := firstStates[len(firstStates)-1]; last || len(secondStates) != 0 {
		t.Fatalf("remote Host grant must not produce locally: first=%v second=%v", firstStates, secondStates)
	}
}

func TestControllerMeetingNotesGrantStartsAndRevocationStopsBridge(t *testing.T) {
	client := &fakeRoomClient{}
	controller, harness := newControllerHarness(t, client, nil)
	defer controller.Stop()

	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.Start(t.Context())
	if harness.bridgeCount() != 0 {
		t.Fatal("no grant must mean no media session")
	}

	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool { return harness.bridgeCount() == 1 }, "bridge start")
	firstEngine := harness.engineAt(0)
	if firstEngine == nil || firstEngine.closeCalls != 0 {
		t.Fatal("bridge must be running under the MN grant")
	}

	// Revocation: grant off -> teardown of the shared session.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.poll()
	waitController(t, 2*time.Second, func() bool { return firstEngine.closeCalls == 1 }, "bridge stop")
}

func TestControllerStopWithActiveSubscriptionDoesNotBlockMediaLifecycleMutex(t *testing.T) {
	client := &fakeRoomClient{}
	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	engine := newFakeEngine()
	rest := newFakeRest()
	rest.roomMediaReturn = []RoomMediaParticipant{{
		ParticipantID: "human", Name: "Ada", SessionID: "human-session",
		Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}},
	}}
	var mediaMu sync.Mutex
	ended := make(chan struct{}, 1)
	controller := NewController(ControllerOptions{
		Client:         client,
		RoomID:         "room",
		ParticipantID:  "agent",
		PollIntervalMs: 10_000,
		CreateBridge: func() (*Bridge, error) {
			options := testBridgeOptions(engine, rest, nil)
			options.Events.OnTrackEnded = func(speech.AudioSource) {
				mediaMu.Lock()
				defer mediaMu.Unlock()
				ended <- struct{}{}
			}
			return NewBridge(options), nil
		},
	})
	controller.Start(t.Context())
	waitController(t, time.Second, func() bool {
		return len(rest.snapshotSubscribes()) == 1
	}, "active Human subscription")
	engine.emitTrack("0", CodecInfo{MimeType: "audio/opus", ClockRate: 48000, Channels: 2})

	// restartMediaController/releaseResources call Controller.Stop while their
	// own mediaMu is held. Model that exact lock shape and require shutdown to
	// return before the consumer can acquire it.
	mediaMu.Lock()
	done := make(chan struct{})
	go func() {
		controller.Stop()
		close(done)
	}()
	completed := false
	select {
	case <-done:
		completed = true
	case <-time.After(time.Second):
	}
	mediaMu.Unlock()
	if !completed {
		t.Fatal("Controller.Stop deadlocked on an active TrackEnded callback")
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("active subscription did not report TrackEnded after shutdown")
	}

	// A lifecycle restart remains possible after the old callback has drained;
	// teardown did not leave Controller state wedged behind mediaMu.
	controller.Start(t.Context())
	waitController(t, time.Second, func() bool {
		controller.mu.Lock()
		defer controller.mu.Unlock()
		return controller.state == "running"
	}, "controller restart after active subscription shutdown")
	controller.Stop()
}

func TestControllerStopCancelsStartingBridge(t *testing.T) {
	client := &fakeRoomClient{}
	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	engine := newFakeEngine()
	rest := newFakeRest()
	waitStarted := make(chan struct{})
	engine.waitFn = func(ctx context.Context, _ time.Duration) error {
		close(waitStarted)
		<-ctx.Done()
		return ctx.Err()
	}
	controller := NewController(ControllerOptions{
		Client:         client,
		RoomID:         "room",
		ParticipantID:  "agent",
		PollIntervalMs: 100,
		CreateBridge: func() (*Bridge, error) {
			return NewBridge(testBridgeOptions(engine, rest, nil)), nil
		},
	})
	startDone := make(chan struct{})
	go func() {
		controller.Start(context.Background())
		close(startDone)
	}()

	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		t.Fatal("controller never reached bridge connection wait")
	}
	controller.Stop()

	select {
	case <-startDone:
	case <-time.After(time.Second):
		t.Fatal("Controller.Stop must cancel a starting bridge")
	}
	if engine.closeCalls != 1 {
		t.Fatalf("starting bridge close calls = %d, want 1", engine.closeCalls)
	}
	if got := rest.snapshotRoomMediaCalls(); got != 0 {
		t.Fatalf("RoomMedia calls after cancelled bootstrap = %d, want 0", got)
	}
	controller.mu.Lock()
	state, bridge := controller.state, controller.bridge
	controller.mu.Unlock()
	if state != "idle" || bridge != nil {
		t.Fatalf("controller after Stop = state %q bridge %v, want idle nil", state, bridge)
	}
}

func TestControllerRoomInfoFailureFailsClosed(t *testing.T) {
	client := &fakeRoomClient{}
	controller, harness := newControllerHarness(t, client, nil)
	defer controller.Stop()

	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool { return harness.bridgeCount() == 1 }, "bridge start")

	client.setRoom("off", "off", "agent", 0, "off", "off", "agent", 0, errors.New("network"))
	controller.poll()
	firstEngine := harness.engineAt(0)
	waitController(t, 2*time.Second, func() bool { return firstEngine.closeCalls == 1 }, "fail-closed teardown")
}

func TestControllerMeetingNotesEpochChangeRebuildsSession(t *testing.T) {
	client := &fakeRoomClient{}
	controller, harness := newControllerHarness(t, client, nil)
	defer controller.Stop()

	client.setRoom("on", "on", "agent", 111, "off", "on", "agent", 0, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool { return harness.bridgeCount() == 1 }, "bridge start")

	// Stop->Start between polls: same agent, NEW epoch. The whole shared
	// session must be rebuilt (server closed the old subscriptions).
	client.setRoom("on", "on", "agent", 222, "off", "on", "agent", 0, nil)
	controller.poll()
	waitController(t, 2*time.Second, func() bool { return harness.bridgeCount() == 2 }, "epoch rebuild")
	if got := harness.engineAt(0).closeCalls; got != 1 {
		t.Fatalf("stale session must be closed, closeCalls=%d", got)
	}
}

func TestControllerVoiceEpochRotationRebuildsSession(t *testing.T) {
	client := &fakeRoomClient{}
	controller, harness := newControllerHarness(t, client, voiceConfigAlwaysReady())
	defer controller.Stop()

	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 111, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool {
		return harness.bridgeCount() == 1 && controller.HasVoiceOutput()
	}, "voice ready")
	firstEngine := harness.engineAt(0)
	if firstEngine == nil || firstEngine.activateCalls != 1 {
		t.Fatalf("voice activation expected once, got %d", firstEngine.activateCalls)
	}

	// VR Stop->Start between polls: NEW epoch. The server revoked the old
	// publication, so the WHOLE shared session must be rebuilt (a fresh
	// agent-session + publication); re-publishing on the same session did
	// not restore audibility in production E2E.
	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 222, nil)
	controller.poll()
	waitController(t, 2*time.Second, func() bool {
		return harness.bridgeCount() == 2 && controller.HasVoiceOutput()
	}, "session rebuild")
	if got := harness.engineAt(0).closeCalls; got != 1 {
		t.Fatalf("old session must be closed on VR epoch rotation, closeCalls=%d", got)
	}
	second := harness.engineAt(1)
	if second == nil || second.activateCalls < 1 {
		t.Fatal("the rebuilt session must activate a fresh publication")
	}
}

func TestControllerLiveTranscriptEpochRotationResubscribesWithoutRestartingVoiceBridge(t *testing.T) {
	client := &fakeRoomClient{
		live: types.LiveTranscriptInfo{
			Active: true, ProducerRuntimeHostID: "host-a", StartedByHumanParticipantID: "human", Epoch: 7, StartedAt: 7,
		},
	}
	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 111, nil)
	coordinator := &testLiveTranscriptCoordinator{}
	harness := &controllerHarness{}
	var controller *Controller
	controller = NewController(ControllerOptions{
		Client:                    client,
		RoomID:                    "room",
		ParticipantID:             "agent",
		SiteOrigin:                "https://www.free4.chat",
		Handle:                    DecodedHandle{Room: "room", ParticipantID: "agent", ParticipantToken: "tok"},
		RuntimeHostID:             "host-a",
		RuntimeInstanceID:         "instance-a",
		LiveTranscriptCoordinator: coordinator,
		CanProduceLiveTranscript:  func() bool { return true },
		PollIntervalMs:            10_000,
		Voice:                     voiceConfigAlwaysReady(),
		CreateBridge: func() (*Bridge, error) {
			engine := newFakeEngine()
			engine.mid = "9"
			rest := newFakeRest()
			harness.mu.Lock()
			harness.engines = append(harness.engines, engine)
			harness.rests = append(harness.rests, rest)
			harness.bridges++
			harness.mu.Unlock()
			options := testBridgeOptions(engine, rest, &PublishConfig{TrackName: "agent-voice"})
			options.SubscribePurpose = controller.subscribePurpose
			return NewBridge(options), nil
		},
		Log: func(string, map[string]string) {},
	})
	defer controller.Stop()

	controller.Start(t.Context())
	waitController(t, time.Second, func() bool {
		return harness.bridgeCount() == 1 && controller.HasVoiceOutput()
	}, "Live Transcript epoch 7 and Voice shared bridge")
	engine := harness.engineAt(0)
	rest := harness.restAt(0)
	if engine == nil || rest == nil {
		t.Fatal("missing first shared bridge")
	}
	rest.mu.Lock()
	rest.roomMediaReturn = []RoomMediaParticipant{{
		ParticipantID: "human", Name: "Ada", SessionID: "human-session",
		Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}},
	}}
	rest.mu.Unlock()
	if err := controller.bridge.RefreshRemoteSubscriptions(); err != nil {
		t.Fatalf("initial Live Transcript subscribe: %v", err)
	}
	if got := rest.snapshotSubscribes(); len(got) != 1 {
		t.Fatalf("initial subscriptions = %v, want one", got)
	}
	if got := rest.snapshotSubscribePurposes(); len(got) != 1 || got[0] != PurposeLiveTranscript {
		t.Fatalf("initial subscribe purposes = %v, want live-transcript", got)
	}

	// The server revokes these RTP mids on Stop, but Voice keeps the shared
	// bridge and publication alive. The local bridge must forget just its
	// remote reservation rather than rebuilding the unrelated Voice session.
	client.mu.Lock()
	client.live = types.LiveTranscriptInfo{}
	client.mu.Unlock()
	controller.poll()
	if got := harness.bridgeCount(); got != 1 || engine.closeCalls != 0 || !controller.HasVoiceOutput() {
		t.Fatalf("Live Stop must preserve the Voice bridge: bridges=%d close=%d voice=%t", got, engine.closeCalls, controller.HasVoiceOutput())
	}

	client.mu.Lock()
	client.live = types.LiveTranscriptInfo{
		Active: true, ProducerRuntimeHostID: "host-a", StartedByHumanParticipantID: "human", Epoch: 8, StartedAt: 8,
	}
	client.mu.Unlock()
	controller.poll()
	if got := harness.bridgeCount(); got != 1 || engine.closeCalls != 0 || !controller.HasVoiceOutput() {
		t.Fatalf("Live Start epoch 8 must not restart Voice: bridges=%d close=%d voice=%t", got, engine.closeCalls, controller.HasVoiceOutput())
	}
	if got := rest.snapshotSubscribes(); len(got) != 2 {
		t.Fatalf("Human audio was not re-subscribed in epoch 8: %v", got)
	}
	if got := rest.snapshotSubscribePurposes(); len(got) != 2 || got[1] != PurposeLiveTranscript {
		t.Fatalf("new epoch subscribe purposes = %v, want second live-transcript", got)
	}
}

func TestControllerVoiceSpeakerSpeaksThroughBridgeAndRevocationStops(t *testing.T) {
	client := &fakeRoomClient{}
	controller, harness := newControllerHarness(t, client, voiceConfigAlwaysReady())
	defer controller.Stop()

	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 111, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool { return controller.HasVoiceOutput() }, "voice ready")

	output := controller.CurrentVoiceOutput()
	if output == nil {
		t.Fatal("voice output must exist under an active voiceReply grant")
	}
	output.Speak("hello from the agent")
	firstEngine := harness.engineAt(0)
	waitController(t, 2*time.Second, func() bool {
		return len(firstEngine.snapshotWrites()) > 0
	}, "synthesized PCM reaching the shared engine")

	// Revocation: grant off -> speaker torn down, publication deactivated.
	client.setRoom("off", "on", "agent", 0, "off", "on", "agent", 0, nil)
	controller.poll()
	waitController(t, 2*time.Second, func() bool {
		return !controller.HasVoiceOutput() && firstEngine.deactivateCalls >= 1
	}, "voice teardown")
}

func TestControllerVoiceWithoutTtsProviderStaysTextOnly(t *testing.T) {
	client := &fakeRoomClient{}
	voiceCfg := &VoiceConfig{
		TrackName: "agent-voice",
		CreateTtsProvider: func() (speech.StreamingTtsProvider, error) {
			return nil, nil // speech not configured
		},
		OnSpeakerEvent: func(voice.SpeakerEvent) {},
	}
	controller, harness := newControllerHarness(t, client, voiceCfg)
	defer controller.Stop()

	client.setRoom("off", "on", "agent", 0, "on", "on", "agent", 111, nil)
	controller.Start(t.Context())
	waitController(t, 2*time.Second, func() bool { return harness.bridgeCount() == 1 }, "bridge start")
	time.Sleep(50 * time.Millisecond)
	if controller.HasVoiceOutput() {
		t.Fatal("missing TTS provider must stay text-only")
	}
}
