package media

import (
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
		VoiceReply: types.VoiceReplyInfo{
			Active: f.vrActive, AgentParticipantID: f.vrAgent, StartedAt: f.vrStarted,
		},
		VoiceReplyMediaAvailable: f.vrAvail,
	}, nil
}

func (*fakeRoomClient) Connect() error               { return nil }
func (*fakeRoomClient) ListTools() ([]string, error) { return nil, nil }
func (*fakeRoomClient) JoinRoom(string, string, []string) (types.JoinResult, error) {
	return types.JoinResult{}, errors.New("not used")
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
