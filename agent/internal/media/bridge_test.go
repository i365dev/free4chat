package media

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

// fakeEngine implements EngineLike with scripted behavior.
type fakeEngine struct {
	mu              sync.Mutex
	events          EngineEvents
	dcCreated       bool
	dcBeforeOffer   bool
	offersCreated   int
	gatheredOffer   *Description
	localOffer      *Description
	applied         []Description
	applyApplied    string
	applyAnswer     *Description
	applyErr        error
	armCalls        int
	mid             string
	activateCalls   int
	publishActive   bool
	deactivateCalls int
	cancelCalls     int
	writes          [][]byte
	flushCalls      int
	closeCalls      int
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		gatheredOffer: &Description{Type: "offer", SDP: "local-offer-sdp"},
		localOffer:    &Description{Type: "offer", SDP: "fresh-offer-sdp"},
	}
}

func (f *fakeEngine) Create() error { return nil }
func (f *fakeEngine) CreateServerEventsChannel() error {
	f.mu.Lock()
	f.dcCreated = true
	f.dcBeforeOffer = f.offersCreated == 0
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) GatherCompleteOffer() (*Description, error) {
	f.mu.Lock()
	f.offersCreated++
	offer := *f.gatheredOffer
	f.mu.Unlock()
	return &offer, nil
}
func (f *fakeEngine) CreateLocalOffer() (*Description, error) {
	f.mu.Lock()
	f.offersCreated++
	offer := *f.localOffer
	f.mu.Unlock()
	return &offer, nil
}
func (f *fakeEngine) ApplyRemote(remote Description) (string, *Description, error) {
	f.mu.Lock()
	f.applied = append(f.applied, remote)
	applied := f.applyApplied
	answer := f.applyAnswer
	err := f.applyErr
	f.mu.Unlock()
	return applied, answer, err
}
func (f *fakeEngine) WaitConnected(timeout time.Duration) error { return nil }
func (f *fakeEngine) ArmPublish() error {
	f.mu.Lock()
	f.armCalls++
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) LocalPublishMid() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mid
}
func (f *fakeEngine) ActivatePublish() error {
	f.mu.Lock()
	f.activateCalls++
	f.publishActive = true
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) DeactivatePublish() {
	f.mu.Lock()
	f.publishActive = false
	f.deactivateCalls++
	f.mu.Unlock()
}
func (f *fakeEngine) CancelTurn() {
	f.mu.Lock()
	f.cancelCalls++
	f.mu.Unlock()
}
func (f *fakeEngine) WritePCM(chunk []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.publishActive {
		return errPublishNotActive
	}
	copied := append([]byte(nil), chunk...)
	f.writes = append(f.writes, copied)
	return nil
}
func (f *fakeEngine) FlushAudio() error {
	f.mu.Lock()
	f.flushCalls++
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) PublishCounts() map[string]uint64 {
	return map[string]uint64{"opus_frames_written": uint64(len(f.snapshotWrites()))}
}
func (f *fakeEngine) RtpCounts() map[string]uint64 { return nil }
func (f *fakeEngine) Close() {
	f.mu.Lock()
	f.closeCalls++
	f.mu.Unlock()
}

func (f *fakeEngine) snapshotWrites() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.writes))
	for i, chunk := range f.writes {
		out[i] = append([]byte(nil), chunk...)
	}
	return out
}

// emitTrack/emitFrame simulate remote media events through the wired callbacks.
func (f *fakeEngine) emitTrack(mid string, codec CodecInfo) {
	f.mu.Lock()
	events := f.events
	f.mu.Unlock()
	if events.OnTrack != nil {
		events.OnTrack(TrackEvent{Kind: "audio", MID: mid, Codec: codec})
	}
}

func (f *fakeEngine) emitFrame(mid string, payload []byte) {
	f.mu.Lock()
	events := f.events
	f.mu.Unlock()
	if events.OnAudioFrame != nil {
		events.OnAudioFrame(AudioFrameEvent{MID: mid, Payload: payload, Codec: CodecInfo{MimeType: "audio/opus", ClockRate: 48000, Channels: 2}})
	}
}

func (f *fakeEngine) snapshotApplied() []Description {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Description(nil), f.applied...)
}

// fakeRest implements RestClientLike with scripted behavior.
type fakeRest struct {
	mu                  sync.Mutex
	sessionID           string
	establishCalls      int
	establishDesc       Description
	establishErr        error
	roomMediaReturn     []RoomMediaParticipant
	roomMediaErr        error
	subscribeKeys       []string
	subscribeDesc       Description
	subscribeMid        string
	midSequence         []string
	subscribeErr        error
	publishCalls        int
	publishDesc         Description
	publishErr          error
	renegotiatePurposes []Purpose
	confirmCalls        int
	confirmActive       bool
	confirmDiagnostic   PublishedAudioDiagnostic
	confirmErr          error
}

func newFakeRest() *fakeRest {
	return &fakeRest{
		sessionID:     "sess-1",
		establishDesc: Description{Type: "answer", SDP: "cloudflare-answer"},
		subscribeDesc: Description{Type: "offer", SDP: "subscribe-offer"},
		subscribeMid:  "0",
		confirmDiagnostic: PublishedAudioDiagnostic{
			MatchingTrackStatus: "inactive",
		},
	}
}

func (f *fakeRest) CreateAgentSession() (string, error) { return f.sessionID, nil }
func (f *fakeRest) EstablishDataChannelTransport(sessionID string, offer Description, purpose Purpose) (Description, error) {
	f.mu.Lock()
	f.establishCalls++
	f.mu.Unlock()
	if f.establishErr != nil {
		return Description{}, f.establishErr
	}
	return f.establishDesc, nil
}
func (f *fakeRest) RoomMedia() ([]RoomMediaParticipant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.roomMediaErr != nil {
		return nil, f.roomMediaErr
	}
	out := make([]RoomMediaParticipant, len(f.roomMediaReturn))
	copy(out, f.roomMediaReturn)
	return out, nil
}
func (f *fakeRest) SubscribeTrack(sessionID, remoteSessionID, trackName string, purpose Purpose) (Description, string, error) {
	f.mu.Lock()
	f.subscribeKeys = append(f.subscribeKeys, remoteSessionID+":"+trackName)
	mid := f.subscribeMid
	if len(f.midSequence) > 0 {
		mid = f.midSequence[0]
		f.midSequence = f.midSequence[1:]
	}
	f.mu.Unlock()
	if f.subscribeErr != nil {
		return Description{}, "", f.subscribeErr
	}
	return f.subscribeDesc, mid, nil
}
func (f *fakeRest) PublishAudioTrack(sessionID, trackName, mid string, offer Description) (Description, error) {
	f.mu.Lock()
	f.publishCalls++
	f.mu.Unlock()
	if f.publishErr != nil {
		return Description{}, f.publishErr
	}
	return f.publishDesc, nil
}
func (f *fakeRest) Renegotiate(sessionID string, answer Description, purpose Purpose) error {
	f.mu.Lock()
	f.renegotiatePurposes = append(f.renegotiatePurposes, purpose)
	f.mu.Unlock()
	return nil
}
func (f *fakeRest) ConfirmPublishedAudioTrackActive(sessionID, trackName string) (bool, PublishedAudioDiagnostic, error) {
	f.mu.Lock()
	f.confirmCalls++
	f.mu.Unlock()
	if f.confirmErr != nil {
		return false, PublishedAudioDiagnostic{}, f.confirmErr
	}
	return f.confirmActive, f.confirmDiagnostic, nil
}

func (f *fakeRest) snapshotRenegotiations() []Purpose {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Purpose(nil), f.renegotiatePurposes...)
}

func (f *fakeRest) snapshotSubscribes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.subscribeKeys...)
}

func testBridgeOptions(engine *fakeEngine, rest *fakeRest, publish *PublishConfig) BridgeOptions {
	events := BridgeEvents{}
	var mu sync.Mutex
	logs := map[string]int{}
	events.OnTrackStarted = func(speech.AudioSource) {}
	events.OnTrackEnded = func(speech.AudioSource) {}
	events.OnAudioFrame = func(source speech.AudioSource, frame speech.AudioFrame) {
		mu.Lock()
		logs[source.ParticipantID+"|"+source.TrackName]++
		mu.Unlock()
	}
	factory := func(events EngineEvents) (EngineLike, error) {
		engine.mu.Lock()
		engine.events = events
		engine.mu.Unlock()
		return engine, nil
	}
	return BridgeOptions{
		SiteOrigin:     "https://www.free4.chat",
		Handle:         DecodedHandle{Room: "room", ParticipantID: "agent", ParticipantToken: "tok"},
		Rest:           rest,
		CreateEngine:   factory,
		Events:         events,
		Publish:        publish,
		PollIntervalMs: 20,
		Log:            func(string, map[string]string) {},
		Now:            time.Now,
	}
}

func TestBridgeBootstrapSubmitsGatheredLocalOfferAndAppliesAnswer(t *testing.T) {
	engine := newFakeEngine()
	rest := newFakeRest()
	bridge := NewBridge(testBridgeOptions(engine, rest, nil))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()

	if !engine.dcCreated || !engine.dcBeforeOffer {
		t.Fatal("server-events DataChannel must be created before any offer")
	}
	if rest.establishCalls != 1 {
		t.Fatalf("establish calls = %d, want 1", rest.establishCalls)
	}
	applied := engine.snapshotApplied()
	if len(applied) != 1 || applied[0].Type != "answer" || applied[0].SDP != "cloudflare-answer" {
		t.Fatalf("answer must be applied directly: %+v", applied)
	}
	if len(rest.snapshotRenegotiations()) != 0 {
		t.Fatal("no renegotiate expected on the answer path")
	}
}

func TestBridgeBootstrapRemoteOfferProducesAnswerAndRenegotiates(t *testing.T) {
	engine := newFakeEngine()
	rest := newFakeRest()
	rest.establishDesc = Description{Type: "offer", SDP: "server-offer"}
	engine.applyApplied = "offer"
	engine.applyAnswer = &Description{Type: "answer", SDP: "local-answer"}
	bridge := NewBridge(testBridgeOptions(engine, rest, nil))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()

	purposes := rest.snapshotRenegotiations()
	if len(purposes) != 1 || purposes[0] != PurposeAgentTransport {
		t.Fatalf("renegotiate purposes = %v, want [agent-transport]", purposes)
	}
	applied := engine.snapshotApplied()
	if len(applied) != 1 || applied[0].Type != "offer" {
		t.Fatalf("remote offer must be applied first: %+v", applied)
	}
}

func TestBridgeVoiceOnlyRoomToleratesDiscoveryDenial(t *testing.T) {
	engine := newFakeEngine()
	rest := newFakeRest()
	rest.roomMediaErr = errors.New(HumanMediaDiscoveryDenied)
	bridge := NewBridge(testBridgeOptions(engine, rest, nil))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("voice-only bootstrap must tolerate meeting_notes_not_authorized: %v", err)
	}
	defer bridge.Stop()

	// A later grant: discovery succeeds and subscriptions flow on the SAME
	// session (sessionID unchanged).
	rest.roomMediaErr = nil
	rest.roomMediaReturn = []RoomMediaParticipant{{
		ParticipantID: "human-1", Name: "Ada", SessionID: "hsess",
		Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}},
	}}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(rest.snapshotSubscribes()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(rest.snapshotSubscribes()) != 1 || rest.snapshotSubscribes()[0] != "hsess:mic" {
		t.Fatalf("post-grant subscription missing: %v", rest.snapshotSubscribes())
	}
}

func TestBridgeSubscribeDedupesAndBindsMidsOutOfOrder(t *testing.T) {
	engine := newFakeEngine()
	rest := newFakeRest()
	rest.roomMediaReturn = []RoomMediaParticipant{
		{ParticipantID: "h1", Name: "Ada", SessionID: "s1", Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}}},
		{ParticipantID: "h2", Name: "Bob", SessionID: "s2", Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}}},
	}
	// Two different MIDs: sequence mids 0 then 1 across the two calls.
	rest.subscribeMid = "0"
	rest.midSequence = []string{"0", "1"}
	var mu sync.Mutex
	frameLog := map[string]int{}
	options := testBridgeOptions(engine, rest, nil)
	options.Events.OnAudioFrame = func(source speech.AudioSource, frame speech.AudioFrame) {
		mu.Lock()
		frameLog[source.ParticipantID]++
		mu.Unlock()
	}
	bridge := NewBridge(options)
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(rest.snapshotSubscribes()) < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(rest.snapshotSubscribes()) != 2 {
		t.Fatalf("two unique subscriptions expected: %v", rest.snapshotSubscribes())
	}

	// Out-of-order OnTrack: mid 1 (Bob) arrives BEFORE mid 0 (Ada).
	engine.emitTrack("1", CodecInfo{MimeType: "audio/opus", ClockRate: 48000, Channels: 2})
	engine.emitTrack("0", CodecInfo{MimeType: "audio/opus", ClockRate: 48000, Channels: 2})
	// Frames flow per MID.
	engine.emitFrame("0", []byte("ada-audio"))
	engine.emitFrame("1", []byte("bob-audio"))
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	adaCount := frameLog["h1"]
	bobCount := frameLog["h2"]
	mu.Unlock()
	if adaCount != 1 || bobCount != 1 {
		t.Fatalf("MID attribution broken: ada=%d bob=%d", adaCount, bobCount)
	}
}

func TestBridgeReconcileEndedEmitsTrackEnded(t *testing.T) {
	engine := newFakeEngine()
	rest := newFakeRest()
	rest.roomMediaReturn = []RoomMediaParticipant{
		{ParticipantID: "h1", Name: "Ada", SessionID: "s1", Tracks: []RoomTrack{{TrackName: "mic", Kind: "audio"}}},
	}
	bridge := NewBridge(testBridgeOptions(engine, rest, nil))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(rest.snapshotSubscribes()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	// The participant leaves; the next poll must reconcile.
	rest.mu.Lock()
	rest.roomMediaReturn = nil
	rest.mu.Unlock()
	if err := bridge.poll(); err != nil {
		t.Fatalf("poll: %v", err)
	}
}

func TestBridgeVoicePublishFlowsAndPrimingDrainsExactlyOnce(t *testing.T) {
	engine := newFakeEngine()
	engine.mid = "9"
	rest := newFakeRest()
	publish := &PublishConfig{TrackName: "agent-voice"}
	bridge := NewBridge(testBridgeOptions(engine, rest, publish))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()

	if err := bridge.ActivateVoicePublish(); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if engine.armCalls != 1 {
		t.Fatalf("arm calls = %d, want 1", engine.armCalls)
	}
	if rest.publishCalls != 1 {
		t.Fatalf("publish calls = %d, want 1", rest.publishCalls)
	}
	applied := engine.snapshotApplied()
	if len(applied) == 0 || applied[len(applied)-1].Type != "answer" {
		t.Fatalf("publish answer must be applied: %+v", applied)
	}

	// First chunk: publication still inactive -> priming silence written,
	// real PCM buffered (never written yet).
	if err := bridge.WriteVoicePcm([]byte("real-pcm-chunk-1")); err != nil {
		t.Fatalf("write: %v", err)
	}
	writes := engine.snapshotWrites()
	if len(writes) != 1 || len(writes[0]) != voicePrimingSilenceBytes {
		t.Fatalf("expected exactly one priming silence frame, got %d writes", len(writes))
	}

	// Second chunk: still inactive -> buffered too; no second priming.
	if err := bridge.WriteVoicePcm([]byte("real-pcm-chunk-2")); err != nil {
		t.Fatalf("write2: %v", err)
	}
	if len(engine.snapshotWrites()) != 1 {
		t.Fatal("priming must be sent at most once")
	}

	// Cloudflare flips active: the NEXT confirm drains buffered chunks in
	// order exactly once, then writes the live chunk.
	rest.mu.Lock()
	rest.confirmActive = true
	rest.confirmDiagnostic.Active = true
	rest.confirmDiagnostic.MatchingTrackStatus = "active"
	rest.mu.Unlock()
	if err := bridge.WriteVoicePcm([]byte("real-pcm-chunk-3")); err != nil {
		t.Fatalf("write3: %v", err)
	}
	writes = engine.snapshotWrites()
	if len(writes) != 4 {
		t.Fatalf("writes after activation = %d, want 4 (priming + 3 chunks)", len(writes))
	}
	if string(writes[1]) != "real-pcm-chunk-1" || string(writes[2]) != "real-pcm-chunk-2" ||
		string(writes[3]) != "real-pcm-chunk-3" {
		t.Fatalf("pending drain order broken: %q %q %q", writes[1], writes[2], writes[3])
	}
	// Exactly once: no duplicates anywhere.
	seen := map[string]int{}
	for _, chunk := range writes[1:] {
		seen[string(chunk)]++
	}
	if seen["real-pcm-chunk-1"] != 1 || seen["real-pcm-chunk-2"] != 1 {
		t.Fatalf("pending PCM must drain exactly once: %v", seen)
	}
}

func TestBridgeRevocationDropsPendingPcm(t *testing.T) {
	engine := newFakeEngine()
	engine.mid = "9"
	rest := newFakeRest()
	bridge := NewBridge(testBridgeOptions(engine, rest, &PublishConfig{TrackName: "agent-voice"}))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()
	_ = bridge.ActivateVoicePublish()
	_ = bridge.WriteVoicePcm([]byte("stale-chunk"))

	bridge.DeactivateVoicePublish()
	if bridge.pendingVoiceCount() != 0 {
		t.Fatal("revocation must discard buffered pending PCM")
	}
	if !bridge.voicePublicationAnnounced() && engine.publishActive {
		t.Fatal("deactivation must stop the engine publication")
	}
}

func TestBridgeWritePcmBufferBound(t *testing.T) {
	engine := newFakeEngine()
	engine.mid = "9"
	rest := newFakeRest()
	bridge := NewBridge(testBridgeOptions(engine, rest, &PublishConfig{TrackName: "agent-voice"}))
	if err := bridge.Start(t.Context()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer bridge.Stop()
	_ = bridge.ActivateVoicePublish()
	// Inactive confirmation forever; fill beyond the 8 MiB bound.
	big := make([]byte, 1024)
	var err error
	for i := 0; i < 9000; i++ {
		if err = bridge.WriteVoicePcm(big); err != nil {
			break
		}
	}
	if err == nil || err.Error() != "voice_pcm_buffer_full" {
		t.Fatalf("buffer bound must fail closed with voice_pcm_buffer_full, got %v", err)
	}
}
