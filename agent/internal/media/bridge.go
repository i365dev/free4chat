package media

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
)

const (
	// DefaultPollIntervalMs is the grant/subscription poll cadence.
	DefaultPollIntervalMs = 5000
	// statsFlushIntervalMs bounds per-track stats events.
	statsFlushIntervalMs = 2000
	// voicePrimingSilenceBytes is one 20 ms mono S16LE silence frame: a
	// bounded, non-user priming packet letting Cloudflare observe the
	// publication before the first audible PCM chunk.
	voicePrimingSilenceBytes = 960
	// maxPendingVoicePcmBytes bounds buffered real PCM while publication
	// activation is pending.
	maxPendingVoicePcmBytes = 8 * 1024 * 1024
)

// EngineLike is the in-process Pion engine boundary (fake-able for tests).
type EngineLike interface {
	Create() error
	CreateServerEventsChannel() error
	GatherCompleteOffer() (*Description, error)
	CreateLocalOffer() (*Description, error)
	ApplyRemote(remote Description) (string, *Description, error)
	WaitConnected(ctx context.Context, timeout time.Duration) error
	ArmPublish() error
	LocalPublishMid() string
	ActivatePublish() error
	DeactivatePublish()
	CancelTurn(token uint64)
	ValidateTurn(token uint64) bool
	WritePCM(chunk []byte, token uint64) error
	FlushAudio(token uint64) error
	// FlushAudioAndWait returns only once the paced writer has consumed the
	// final marker. Host-level Agent Voice serialization depends on this
	// acknowledgement: enqueueing the marker alone leaves prior PCM audible.
	FlushAudioAndWait(token uint64) error
	PublishCounts() map[string]uint64
	RtpCounts() map[string]uint64
	Close()
}

// EngineFactory creates the engine with its event wiring.
type EngineFactory func(events EngineEvents) (EngineLike, error)

// BridgeEvents carries the safe event surface the controller wires.
type BridgeEvents struct {
	// OnAudioFrame delivers one attributed decoded audio frame (SFU Opus).
	OnAudioFrame func(source speech.AudioSource, frame speech.AudioFrame)
	// OnTrackStarted fires when a subscribed Human track binds to RTP.
	OnTrackStarted func(source speech.AudioSource)
	// OnTrackEnded fires when a Human track disappears (left or bridge stop).
	OnTrackEnded func(source speech.AudioSource)
	// OnStateChange reports safe connection state names.
	OnStateChange func(event string, state string)
}

// BridgeOptions configures the shared-session media bridge.
type BridgeOptions struct {
	SiteOrigin   string
	Handle       DecodedHandle
	Rest         RestClientLike
	CreateEngine EngineFactory
	Events       BridgeEvents
	// Publish configures the outbound voice track (nil = Meeting Notes only).
	Publish        *PublishConfig
	PollIntervalMs int
	Log            func(event string, details map[string]string)
	// Now is injectable for deterministic stats tests.
	Now func() time.Time
}

// PublishConfig is the Agent Voice publication shape.
type PublishConfig struct {
	TrackName string
}

// pendingPcmItem buffers one pre-announcement PCM chunk together with the
// turn token that produced it: a stale item must never be drained under a
// later turn's token.
type pendingPcmItem struct {
	token uint64
	data  []byte
}

type pendingTrack struct {
	participantID   string
	participantName string
	trackName       string
	expectedMid     string
	hasExpectedMid  bool
}

type subscription struct {
	key             string
	participantID   string
	participantName string
	trackName       string
	mid             string
	frameCount      int
	byteCount       int
	firstTimestamp  *uint32
	lastTimestamp   *uint32
	lastFlushAt     time.Time
}

func subscriptionKey(participantID, sessionID, trackName string) string {
	return participantID + ":" + sessionID + ":" + trackName
}

// Bridge owns the ONE shared Pion PeerConnection / Cloudflare Agent session
// serving both grants. Meeting Notes controls Human-audio subscribe/input;
// Agent Voice controls this Agent's local publish/output. Exactly one session
// exists whenever EITHER grant is live.
type Bridge struct {
	options BridgeOptions
	log     func(event string, details map[string]string)
	rest    RestClientLike
	engine  EngineLike
	now     func() time.Time

	mu          sync.Mutex
	mySessionID string
	stopped     bool
	subs        map[string]*subscription
	pending     map[string]*pendingTrack
	negotiation *sync.Mutex
	cancel      context.CancelFunc

	// voice publication state
	voiceAnnounced       bool
	voicePrimingSent     bool
	voicePadSent         bool
	voiceConfirmFlight   chan struct{}
	pendingVoicePCM      []pendingPcmItem
	pendingVoicePCMBytes int
	pcmWriteCalls        int
	pcmInputBytes        int
	// Diagnostics counters (bytes): received from the sink, enqueued while
	// unannounced, drained from the pending buffer, and handed to the engine.
	voiceBytesReceived int
	voiceBytesBuffered int
	voiceBytesDrained  int
}

// NewBridge builds an idle bridge.
func NewBridge(options BridgeOptions) *Bridge {
	log := options.Log
	if log == nil {
		log = func(string, map[string]string) {}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Bridge{
		options:     options,
		log:         log,
		rest:        options.Rest,
		now:         now,
		subs:        make(map[string]*subscription),
		pending:     make(map[string]*pendingTrack),
		negotiation: &sync.Mutex{},
		// A fresh bridge is not running until Start succeeds.
		stopped: true,
	}
}

// Start bootstraps the shared session. Transactional: any failure tears down
// every partial resource before returning, so a later Start begins fresh.
// The initial PC is receive-only; the gathered LOCAL offer is submitted to
// datachannels/establish; the returned description's actual type decides the
// answer path. A voiceReply-only room's meeting_notes_not_authorized on the
// first discovery poll is tolerated (the shared session stays valid).
func (b *Bridge) Start(parent context.Context) error {
	b.mu.Lock()
	if !b.stopped {
		b.mu.Unlock()
		return nil
	}
	b.stopped = false
	b.mu.Unlock()

	ctx, cancel := context.WithCancel(parent)
	b.cancel = cancel

	fail := func(err error) error {
		b.resetToStopped()
		return err
	}

	engine, err := b.options.CreateEngine(EngineEvents{
		OnTrack:      b.handleIncomingTrack,
		OnAudioFrame: b.handleAudioFrame,
		OnConnectionStateChange: func(state string) {
			if b.options.Events.OnStateChange != nil {
				b.options.Events.OnStateChange("peerconnection_state", state)
			}
		},
		OnICEStateChange: func(state string) {
			if b.options.Events.OnStateChange != nil {
				b.options.Events.OnStateChange("ice_state", state)
			}
		},
	})
	if err != nil {
		return fail(err)
	}
	b.engine = engine
	if err := engine.CreateServerEventsChannel(); err != nil {
		return fail(err)
	}
	offer, err := engine.GatherCompleteOffer()
	if err != nil {
		return fail(err)
	}
	// Bounded bootstrap stage diagnostics (electric-audio investigation):
	// presence/attempt/outcome only — never SDP content or IDs.
	b.log("media_bootstrap_stage", map[string]string{
		"stage":                  "gathered_offer_present",
		"gathered_offer_present": "1",
	})
	sessionID, err := b.rest.CreateAgentSession()
	if err != nil {
		return fail(err)
	}
	b.mu.Lock()
	b.mySessionID = sessionID
	b.mu.Unlock()
	b.log("media_bootstrap_stage", map[string]string{"stage": "session_created"})

	b.log("media_bootstrap_stage", map[string]string{"stage": "establish_attempted"})
	transport, err := b.rest.EstablishDataChannelTransport(sessionID, *offer, PurposeAgentTransport)
	if err != nil {
		b.log("media_bootstrap_stage", map[string]string{
			"stage":                 "establish_failed",
			"establish_result_code": bootstrapErrorClass(err),
		})
		return fail(err)
	}
	b.log("media_bootstrap_stage", map[string]string{
		"stage":                 "establish_ok",
		"establish_result_code": "ok",
		"description_type":      transport.Type,
	})
	if transport.Type == "offer" {
		applied, answer, applyErr := engine.ApplyRemote(transport)
		if applyErr != nil || applied != "offer" || answer == nil {
			if applyErr == nil {
				applyErr = errors.New("missing local answer after remote offer")
			}
			return fail(applyErr)
		}
		if err := b.rest.Renegotiate(sessionID, *answer, PurposeAgentTransport); err != nil {
			return fail(err)
		}
	} else {
		if _, _, applyErr := engine.ApplyRemote(transport); applyErr != nil {
			return fail(applyErr)
		}
	}
	// The proven Pion runbook's stage E is a real readiness boundary, not
	// merely a diagnostic convenience. A successful SDP exchange only means
	// Cloudflare accepted the description; before ICE/DTLS reaches connected,
	// TrackLocal.WriteSample can accept PCM locally while no RTP is capable of
	// leaving the Runtime. Do not expose a Voice speaker (or begin Room-media
	// discovery) until that transport is actually connected.
	if err := engine.WaitConnected(ctx, connectTimeout); err != nil {
		b.log("media_bootstrap_stage", map[string]string{
			"stage": "peerconnection_connect_failed",
		})
		return fail(err)
	}
	b.log("media_bootstrap_stage", map[string]string{
		"stage": "peerconnection_connected",
	})

	if err := b.poll(); err != nil && !isHumanMediaDiscoveryDenied(err) {
		return fail(err)
	}

	go b.pollLoop(ctx)
	return nil
}

func (b *Bridge) pollLoop(ctx context.Context) {
	interval := b.options.PollIntervalMs
	if interval <= 0 {
		interval = DefaultPollIntervalMs
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = b.poll()
		}
	}
}

// Stop tears the bridge down (bounded): engine close, event emission for
// active subscriptions, pending PCM discard.
func (b *Bridge) Stop() {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		return
	}
	b.stopped = true
	b.mu.Unlock()
	b.resetToStopped()
}

func (b *Bridge) resetToStopped() {
	b.mu.Lock()
	cancel := b.cancel
	b.cancel = nil
	subs := make([]*subscription, 0, len(b.subs))
	for _, sub := range b.subs {
		subs = append(subs, sub)
	}
	b.subs = make(map[string]*subscription)
	b.pending = make(map[string]*pendingTrack)
	b.mySessionID = ""
	b.voiceAnnounced = false
	b.voicePrimingSent = false
	b.pendingVoicePCM = nil
	b.pendingVoicePCMBytes = 0
	engine := b.engine
	b.engine = nil
	b.stopped = true
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if engine != nil {
		engine.Close()
	}
	for _, sub := range subs {
		if b.options.Events.OnTrackEnded != nil {
			b.options.Events.OnTrackEnded(speech.AudioSource{
				ParticipantID:   sub.participantID,
				ParticipantName: sub.participantName,
				TrackName:       sub.trackName,
			})
		}
	}
}

// Poll discovers Human media and subscribes every audio track exactly once
// (reserved before negotiation so racing polls cannot duplicate).
func (b *Bridge) poll() error {
	participants, err := b.rest.RoomMedia()
	if err != nil {
		return err
	}
	b.reconcileEnded(participants)
	for _, participant := range participants {
		for _, track := range participant.Tracks {
			if track.Kind != "audio" {
				continue
			}
			if err := b.subscribe(participant, track.TrackName); err != nil {
				// A failed single-track subscribe is logged per-track by the
				// subscriber; the bridge keeps serving other tracks.
				continue
			}
		}
	}
	return nil
}

func (b *Bridge) reconcileEnded(participants []RoomMediaParticipant) {
	live := make(map[string]bool)
	for _, participant := range participants {
		for _, track := range participant.Tracks {
			if track.Kind == "audio" {
				live[subscriptionKey(participant.ParticipantID, participant.SessionID, track.TrackName)] = true
			}
		}
	}
	b.mu.Lock()
	var ended []*subscription
	for key, sub := range b.subs {
		if !live[key] {
			delete(b.subs, key)
			ended = append(ended, sub)
		}
	}
	b.mu.Unlock()
	for _, sub := range ended {
		if b.options.Events.OnTrackEnded != nil {
			b.options.Events.OnTrackEnded(speech.AudioSource{
				ParticipantID:   sub.participantID,
				ParticipantName: sub.participantName,
				TrackName:       sub.trackName,
			})
		}
	}
}

func (b *Bridge) subscribe(participant RoomMediaParticipant, trackName string) error {
	key := subscriptionKey(participant.ParticipantID, participant.SessionID, trackName)
	b.mu.Lock()
	if _, exists := b.subs[key]; exists {
		b.mu.Unlock()
		return nil
	}
	// Reserve the slot before negotiation is queued so a racing poll cannot
	// queue a duplicate subscribe.
	b.subs[key] = &subscription{
		key:             key,
		participantID:   participant.ParticipantID,
		participantName: participant.Name,
		trackName:       trackName,
	}
	b.mu.Unlock()

	// WebRTC renegotiation must be serialized (same queue as the browser
	// client's enqueueNegotiation pattern).
	b.negotiation.Lock()
	defer b.negotiation.Unlock()

	b.mu.Lock()
	if b.stopped || b.engine == nil || b.mySessionID == "" {
		b.mu.Unlock()
		return errors.New("bridge_not_running")
	}
	sessionID := b.mySessionID
	engine := b.engine
	b.pending[key] = &pendingTrack{
		participantID:   participant.ParticipantID,
		participantName: participant.Name,
		trackName:       trackName,
	}
	b.mu.Unlock()

	offer, mid, err := b.rest.SubscribeTrack(sessionID, participant.SessionID, trackName, PurposeMeetingNotes)
	if err != nil {
		b.dropReservation(key)
		return err
	}
	b.mu.Lock()
	if pending := b.pending[key]; pending != nil {
		pending.expectedMid = mid
		pending.hasExpectedMid = mid != ""
	}
	b.mu.Unlock()
	applied, answer, err := engine.ApplyRemote(offer)
	if err != nil {
		b.dropReservation(key)
		return err
	}
	if applied == "offer" && answer != nil {
		if err := b.rest.Renegotiate(sessionID, *answer, PurposeMeetingNotes); err != nil {
			b.dropReservation(key)
			return err
		}
	}
	// Renegotiation accepted => subscription established upstream. Media
	// start (OnTrack/RTP) binds whenever the human actually sends packets;
	// silent participants must never trigger resubscribe loops.
	return nil
}

func (b *Bridge) dropReservation(key string) {
	b.mu.Lock()
	delete(b.pending, key)
	delete(b.subs, key)
	b.mu.Unlock()
}

// handleIncomingTrack binds an engine OnTrack to the pending subscription
// with the exact negotiated MID (entries without an expected MID keep the
// legacy first-arrival fallback for fakes).
func (b *Bridge) handleIncomingTrack(event TrackEvent) {
	if event.Kind != "audio" {
		return
	}
	b.mu.Lock()
	var bound *pendingTrack
	var boundKey string
	for key, pending := range b.pending {
		if pending.hasExpectedMid && pending.expectedMid != event.MID {
			continue
		}
		bound = pending
		boundKey = key
		break
	}
	if bound == nil {
		b.mu.Unlock()
		return
	}
	delete(b.pending, boundKey)
	sub := b.subs[boundKey]
	if sub != nil {
		sub.mid = event.MID
	}
	b.mu.Unlock()
	if sub == nil {
		return
	}
	if b.options.Events.OnTrackStarted != nil {
		b.options.Events.OnTrackStarted(speech.AudioSource{
			ParticipantID:   bound.participantID,
			ParticipantName: bound.participantName,
			TrackName:       bound.trackName,
		})
	}
}

func (b *Bridge) handleAudioFrame(event AudioFrameEvent) {
	if event.Codec.MimeType == "" {
		return
	}
	// Map MID -> subscription for attribution. Frames for tracks not yet
	// bound (or already ended) are dropped, never misattributed.
	b.mu.Lock()
	var sub *subscription
	for _, candidate := range b.subs {
		// subscription->mid binding is tracked by pending; after binding the
		// engine reader keeps delivering frames by mid. Store mid on the
		// subscription at bind time.
		if candidate.mid == event.MID {
			sub = candidate
			break
		}
	}
	if sub == nil {
		b.mu.Unlock()
		return
	}
	sub.frameCount++
	sub.byteCount += len(event.Payload)
	now := b.now()
	flushStats := now.Sub(sub.lastFlushAt) >= statsFlushIntervalMs*time.Millisecond
	source := speech.AudioSource{
		ParticipantID:   sub.participantID,
		ParticipantName: sub.participantName,
		TrackName:       sub.trackName,
	}
	b.mu.Unlock()

	if b.options.Events.OnAudioFrame != nil {
		b.options.Events.OnAudioFrame(source, speech.AudioFrame{
			Codec:        "opus",
			SampleRateHz: event.Codec.ClockRate,
			Channels:     event.Codec.Channels,
			Data:         event.Payload,
		})
	}
	if flushStats {
		b.mu.Lock()
		count := sub.frameCount
		bytesCount := sub.byteCount
		sub.lastFlushAt = now
		b.mu.Unlock()
		b.log("audio_frame_stats", map[string]string{
			"frameCount": fmt.Sprintf("%d", count),
			"byteCount":  fmt.Sprintf("%d", bytesCount),
		})
	}
}

// VoicePublishCapable reports whether the bridge can publish outbound voice.
func (b *Bridge) VoicePublishCapable() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.options.Publish != nil && b.engine != nil && !b.stopped
}

// ActivateVoicePublish arms the outbound track (fresh offer -> local MID ->
// /tracks(local, voice-reply) -> apply returned description -> activate).
func (b *Bridge) ActivateVoicePublish() error {
	b.mu.Lock()
	if b.stopped || b.engine == nil || b.mySessionID == "" {
		b.mu.Unlock()
		return errors.New("bridge_not_running")
	}
	if b.options.Publish == nil {
		b.mu.Unlock()
		return errors.New("voice_publish_not_configured")
	}
	sessionID := b.mySessionID
	trackName := b.options.Publish.TrackName
	engine := b.engine
	b.voiceAnnounced = false
	b.voicePrimingSent = false
	b.voicePadSent = false
	b.pendingVoicePCM = nil
	b.pendingVoicePCMBytes = 0
	b.mu.Unlock()

	b.negotiation.Lock()
	defer b.negotiation.Unlock()

	diagnostic := map[string]string{}
	fail := func(stage string, err error) error {
		diagnostic["stage"] = stage
		b.log("voice_publish_failed", diagnostic)
		return err
	}
	if err := engine.ArmPublish(); err != nil {
		return fail("arm-publish", err)
	}
	diagnostic["arm_publish_ok"] = "1"
	offer, err := engine.CreateLocalOffer()
	if err != nil {
		return fail("offer", err)
	}
	diagnostic["voice_offer_created"] = "1"
	mid := engine.LocalPublishMid()
	if mid == "" {
		return fail("local-mid", errors.New("publish_mid_unavailable"))
	}
	diagnostic["local_mid_present"] = "1"
	description, err := b.rest.PublishAudioTrack(sessionID, trackName, mid, *offer)
	if err != nil {
		return fail("tracks-new", err)
	}
	diagnostic["tracks_new_ok"] = "1"
	if description.Type != "" {
		applied, answer, applyErr := engine.ApplyRemote(description)
		if applyErr != nil {
			return fail("remote-description", applyErr)
		}
		diagnostic["remote_description_applied"] = "1"
		if applied == "offer" && answer != nil {
			if err := b.rest.Renegotiate(sessionID, *answer, PurposeVoiceReply); err != nil {
				return fail("renegotiate", err)
			}
			diagnostic["renegotiate_ok"] = "1"
		}
	}
	if err := engine.ActivatePublish(); err != nil {
		return fail("activate-publish", err)
	}
	diagnostic["activate_publish_ok"] = "1"
	b.log("voice_publish_succeeded", diagnostic)
	return nil
}

// DeactivateVoicePublish stops publication and discards buffered PCM.
func (b *Bridge) DeactivateVoicePublish() {
	b.mu.Lock()
	engine := b.engine
	b.voiceAnnounced = false
	b.voicePrimingSent = false
	b.voicePadSent = false
	b.pendingVoicePCM = nil
	b.pendingVoicePCMBytes = 0
	b.mu.Unlock()
	if engine != nil {
		engine.DeactivatePublish()
	}
}

// WriteVoicePcm feeds one synthesized PCM chunk: prime once, confirm
// publication, buffer while inactive (bounded), drain in order once active.
// token is the speaker turn identity used for engine-side turn admission.
func (b *Bridge) WriteVoicePcm(chunk []byte, token uint64) error {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		return errors.New("bridge_stopped")
	}
	b.pcmWriteCalls++
	b.pcmInputBytes += len(chunk)
	b.voiceBytesReceived += len(chunk)
	b.mu.Unlock()

	if err := b.primeVoicePublication(); err != nil {
		return err
	}
	b.confirmVoicePublicationActive()
	// Stale-turn admission at the bridge boundary: a delayed old callback
	// must not be buffered under a newer turn.
	if !b.validateTurn(token) {
		return errPublishNotActive
	}
	announced := b.voicePublicationAnnounced()
	if !announced {
		b.mu.Lock()
		b.voiceBytesBuffered += len(chunk)
		b.mu.Unlock()
		if err := b.enqueuePendingVoicePcm(chunk, token); err != nil {
			return err
		}
		return nil
	}
	if err := b.drainPendingVoicePcm(token); err != nil {
		return err
	}
	if err := b.writeEnginePcm(chunk, token); err != nil {
		return err
	}
	b.confirmVoicePublicationActive()
	return nil
}

// FlushVoice flushes the buffered tail with the frozen double-pass semantics.
func (b *Bridge) FlushVoice(token uint64) error {
	if err := b.primeVoicePublication(); err != nil {
		return err
	}
	b.confirmVoicePublicationActive()
	if err := b.drainPendingVoicePcm(token); err != nil {
		return err
	}
	flushErr := b.flushEngine(token)
	b.confirmVoicePublicationActive()
	if b.voicePublicationAnnounced() && b.pendingVoiceCount() > 0 {
		if err := b.drainPendingVoicePcm(token); err != nil && flushErr == nil {
			flushErr = err
		}
		if err := b.flushEngine(token); err != nil && flushErr == nil {
			flushErr = err
		}
	}
	return flushErr
}

// CancelVoiceTurn discards the cancelled turn's buffered audio without
// deactivating the publication. Pending items are filtered by their
// ORIGINATING token: a late cancel for an older turn removes ONLY that
// turn's items and never destroys a newer turn's pending prefix
// (pendingVoicePCMBytes stays exact).
func (b *Bridge) CancelVoiceTurn(token uint64) {
	b.mu.Lock()
	if token != 0 {
		kept := b.pendingVoicePCM[:0]
		for _, item := range b.pendingVoicePCM {
			if item.token != token {
				kept = append(kept, item)
			} else {
				b.pendingVoicePCMBytes -= len(item.data)
			}
		}
		b.pendingVoicePCM = kept
	} else {
		b.pendingVoicePCM = nil
		b.pendingVoicePCMBytes = 0
	}
	engine := b.engine
	b.mu.Unlock()
	if engine != nil {
		engine.CancelTurn(token)
	}
}

// VoicePublishStats merges bridge and engine counters (safe diagnostics).
func (b *Bridge) VoicePublishStats() map[string]uint64 {
	b.mu.Lock()
	stats := map[string]uint64{
		"pcm_write_calls":      uint64(b.pcmWriteCalls),
		"pcm_input_bytes":      uint64(b.pcmInputBytes),
		"voice_bytes_received": uint64(b.voiceBytesReceived),
		"voice_bytes_buffered": uint64(b.voiceBytesBuffered),
		"voice_bytes_drained":  uint64(b.voiceBytesDrained),
	}
	engine := b.engine
	b.mu.Unlock()
	if engine != nil {
		for key, value := range engine.PublishCounts() {
			if _, exists := stats[key]; !exists {
				stats[key] = value
			}
		}
	}
	return stats
}

func (b *Bridge) primeVoicePublication() error {
	b.mu.Lock()
	if b.options.Publish == nil || b.voicePrimingSent || b.voiceAnnounced {
		b.mu.Unlock()
		return nil
	}
	b.voicePrimingSent = true
	b.mu.Unlock()
	// One bounded synthetic silence frame before user audio; never audible.
	return b.writeEnginePcm(make([]byte, voicePrimingSilenceBytes), 0)
}

// padAfterAnnounce writes a bounded synthetic-silence pad (25 frames =
// 500 ms) once per publication, AFTER Cloudflare confirms the publisher
// active. The browser still needs trackPublished -> subscribe ->
// renegotiate (~1 s) before the SFU routes audio to it; frames sent inside
// that window are dropped. Padding absorbs the drop window so the first
// real words survive — production E2E showed the head of the first reply
// (1-3 words) being lost otherwise, independent of how long the human
// waited before speaking. The pad is silence, never user speech.
func (b *Bridge) padAfterAnnounce() {
	b.mu.Lock()
	if b.options.Publish == nil || !b.voiceAnnounced || b.voicePadSent {
		b.mu.Unlock()
		return
	}
	b.voicePadSent = true
	b.mu.Unlock()
	const padFrames = 25
	silence := make([]byte, voicePrimingSilenceBytes)
	for i := 0; i < padFrames; i++ {
		if err := b.writeEnginePcm(silence, 0); err != nil {
			return
		}
	}
}

func (b *Bridge) confirmVoicePublicationActive() {
	b.mu.Lock()
	if b.options.Publish == nil || b.voiceAnnounced || b.mySessionID == "" || b.rest == nil {
		b.mu.Unlock()
		return
	}
	if b.voiceConfirmFlight != nil {
		// Single-flight: await the in-progress check instead of duplicating.
		flight := b.voiceConfirmFlight
		b.mu.Unlock()
		<-flight
		return
	}
	sessionID := b.mySessionID
	trackName := b.options.Publish.TrackName
	flight := make(chan struct{})
	b.voiceConfirmFlight = flight
	b.mu.Unlock()

	go func() {
		defer close(flight)
		active, diagnostic, err := b.rest.ConfirmPublishedAudioTrackActive(sessionID, trackName)
		if err != nil {
			// Readiness is advisory; leave the flag false so a later write
			// or final flush can retry without failing the voice turn.
			b.mu.Lock()
			b.voiceConfirmFlight = nil
			b.mu.Unlock()
			return
		}
		firstAnnounce := false
		if active {
			b.mu.Lock()
			if !b.voiceAnnounced {
				firstAnnounce = true
			}
			b.voiceAnnounced = true
			b.mu.Unlock()
		}
		if firstAnnounce {
			b.padAfterAnnounce()
		}
		b.log("voice_publish_cloudflare_check", map[string]string{
			"publisher_session_lookup_ok": bool01(diagnostic.PublisherSessionLookupOK),
			"matching_track_found":        bool01(diagnostic.MatchingTrackFound),
			"matching_track_status":       diagnostic.MatchingTrackStatus,
			"matching_track_has_mid":      bool01(diagnostic.MatchingTrackHasMid),
			"active":                      bool01(diagnostic.Active),
		})
		b.mu.Lock()
		b.voiceConfirmFlight = nil
		b.mu.Unlock()
	}()
	<-flight
}

func bool01(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

// validateTurn checks the engine's admission state before buffering or
// writing: stale tokens are rejected at the bridge boundary.
func (b *Bridge) validateTurn(token uint64) bool {
	b.mu.Lock()
	engine := b.engine
	b.mu.Unlock()
	if engine == nil {
		return false
	}
	return engine.ValidateTurn(token)
}

func (b *Bridge) voicePublicationAnnounced() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.voiceAnnounced
}

func (b *Bridge) pendingVoiceCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.pendingVoicePCM)
}

func (b *Bridge) enqueuePendingVoicePcm(chunk []byte, token uint64) error {
	if len(chunk) == 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pendingVoicePCMBytes+len(chunk) > maxPendingVoicePcmBytes {
		return errors.New("voice_pcm_buffer_full")
	}
	copied := append([]byte(nil), chunk...)
	b.pendingVoicePCM = append(b.pendingVoicePCM, pendingPcmItem{token: token, data: copied})
	b.pendingVoicePCMBytes += len(copied)
	return nil
}

func (b *Bridge) drainPendingVoicePcm(token uint64) error {
	for {
		b.mu.Lock()
		if !b.voiceAnnounced || len(b.pendingVoicePCM) == 0 {
			b.mu.Unlock()
			return nil
		}
		item := b.pendingVoicePCM[0]
		b.pendingVoicePCM = b.pendingVoicePCM[1:]
		b.pendingVoicePCMBytes -= len(item.data)
		b.mu.Unlock()
		if item.token != token {
			// A stale pending item can never drain under a later turn's
			// token; discard it without touching the engine.
			continue
		}
		b.mu.Lock()
		b.voiceBytesDrained += len(item.data)
		b.mu.Unlock()
		if err := b.writeEnginePcm(item.data, token); err != nil {
			return err
		}
	}
}

func (b *Bridge) writeEnginePcm(chunk []byte, token uint64) error {
	b.mu.Lock()
	engine := b.engine
	b.mu.Unlock()
	if engine == nil {
		return errors.New("bridge_not_running")
	}
	return engine.WritePCM(chunk, token)
}

func (b *Bridge) flushEngine(token uint64) error {
	b.mu.Lock()
	engine := b.engine
	b.mu.Unlock()
	if engine == nil {
		return errors.New("bridge_not_running")
	}
	return engine.FlushAudioAndWait(token)
}

// bootstrapErrorClass maps a sanitized bootstrap failure onto a bounded
// classification (never the response body or SDP).
func bootstrapErrorClass(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "decoding"):
		return "decoding_error"
	case strings.Contains(message, "timeout"):
		return "timeout"
	case strings.Contains(message, "not_authorized") ||
		strings.Contains(message, "not authorized"):
		return "not_authorized"
	case strings.Contains(message, "rate_limited"):
		return "rate_limited"
	case strings.Contains(message, "network"):
		return "network_error"
	default:
		return "other"
	}
}

func isHumanMediaDiscoveryDenied(err error) bool {
	return err != nil && strings.Contains(err.Error(), HumanMediaDiscoveryDenied)
}
