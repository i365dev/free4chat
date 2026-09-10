package media

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// ControllerOptions wires the media grant controller into the runtime.
type ControllerOptions struct {
	Client        types.Free4ChatClient // RoomInfo fallback (sanitized room state)
	RoomID        string
	ParticipantID string
	SiteOrigin    string
	Handle        DecodedHandle
	// UsePushedMediaState is true for the resident Runtime, whose existing
	// hibernatable event stream carries the current self-targeted media state.
	// The compatibility path keeps one startup RoomInfo observation for clients
	// that do not implement that stream, but never starts a recurring ticker.
	UsePushedMediaState bool
	// PollIntervalMs is retained for source compatibility with older injected
	// callers. Controller no longer starts a RoomInfo ticker, so this value is
	// ignored; BridgeOptions owns the independent SFU track-discovery cadence.
	PollIntervalMs int
	// RuntimeHostID is the room-scoped public host identity of this local
	// Runtime. Live Transcript must match it exactly.
	RuntimeHostID string
	// RuntimeInstanceID distinguishes local resident agents for the daemon
	// coordinator; it never reaches Room state or Harness input.
	RuntimeInstanceID string
	// LiveTranscriptCoordinator elects exactly one local producer for an
	// active (room, host, epoch) grant.
	LiveTranscriptCoordinator LiveTranscriptCoordinator
	// CanProduceLiveTranscript proves this daemon still holds the private
	// provider association for RuntimeHostID. Nil/false fails closed.
	CanProduceLiveTranscript func() bool
	// OnAudioFrame receives attributed SFU audio frames (wire to the
	// transcriber).
	OnAudioFrame func(source speech.AudioSource, frame speech.AudioFrame)
	// OnTrackStarted/Ended mirror media bridge events (transcriber wiring).
	OnTrackStarted func(source speech.AudioSource)
	OnTrackEnded   func(source speech.AudioSource)
	// OnGrantActivated fires on each grant activation EDGE (#171): a grant
	// newly targeting this participant, or a fresh epoch of it. The runtime
	// uses it to evaluate that grant's own speech prerequisite once — never
	// for an unchanged state observation.
	OnGrantActivated func(kind GrantKind)
	// OnLiveTranscriptState tells the runtime whether this resident owns the
	// active local producer lease. It is a state edge, never a Harness wakeup.
	OnLiveTranscriptState func(state types.LiveTranscriptInfo, producing bool)
	// Voice configures outbound Agent Voice (nil = Meeting Notes only).
	Voice *VoiceConfig
	// Log receives bounded safe events.
	Log func(event string, details map[string]string)
	// Now injectable for tests.
	Now func() time.Time
	// CreateBridge injectable for tests (real production wiring default).
	CreateBridge func() (*Bridge, error)
}

// LiveTranscriptCoordinator is implemented by the daemon-local ownership
// ledger. The Room controls Host selection; this interface only serializes
// residents within that one Host.
type LiveTranscriptCoordinator interface {
	Acquire(roomID, runtimeHostID string, epoch int64, instanceID string) bool
	Release(roomID, runtimeHostID string, epoch int64, instanceID string)
}

// VoiceConfig is the outbound voice surface.
type VoiceConfig struct {
	TrackName         string
	CreateTtsProvider func() (speech.StreamingTtsProvider, error)
	MaxChunkChars     int
	HostVoiceGate     voice.Gate
	OnSpeakerEvent    func(voice.SpeakerEvent)
}

// GrantKind identifies which room media grant produced an activation edge.
// Meeting Notes and Agent Voice are independent grants over one shared
// media bridge; each carries its own speech prerequisite.
type GrantKind string

const (
	GrantMeetingNotes   GrantKind = "meeting_notes"
	GrantAgentVoice     GrantKind = "agent_voice"
	GrantLiveTranscript GrantKind = "live_transcript"
	// Deprecated internal spelling retained only for existing adapter tests;
	// it maps to the participant-specific Agent Voice grant above.
	GrantVoiceReply = GrantAgentVoice
)

// Controller owns the Runtime-side half of the media lifecycle: it reconciles
// the Meeting Notes, Agent Voice, and Live Transcript grants and starts/stops
// the ONE shared Bridge accordingly. Resident Runtimes receive this state from
// the authenticated event stream; RoomInfo remains only as a one-shot
// compatibility bootstrap for non-resident clients. This is the ONLY thing
// that decides when this process may hold an active media session —
// authorization always comes from the room-visible grant, never from a local
// decision.
type Controller struct {
	options ControllerOptions
	log     func(event string, details map[string]string)

	reconcileMu        sync.Mutex
	mu                 sync.Mutex
	state              string // idle | starting | running
	generation         int
	grantEpoch         *int64
	voiceEpoch         *int64
	voiceObservedEpoch *int64
	voiceObservedInit  bool
	// liveEpoch is the epoch currently bound into the shared bridge; it is
	// distinct from the local lease/observation state so a callback cannot
	// hide a required Stop->Start rebuild.
	liveEpoch         *int64
	liveLeaseEpoch    *int64
	liveObservedEpoch *int64
	liveProducing     bool
	// #171 grant-announcement state: the last grant instance (kind + epoch)
	// whose activation edge was already reported, so an unchanged grant
	// never re-fires while observations continue. Re-armed when the grant stops
	// targeting this participant.
	mnAnnounced             bool
	mnAnnouncedEpoch        *int64
	vrAnnounced             bool
	vrAnnouncedEpoch        *int64
	bridge                  *Bridge
	speaker                 *voice.Speaker
	voiceStarting           bool
	stopped                 bool
	mediaStateObserved      bool
	lastMediaState          types.ResidentMediaState
	lastMediaStateConfirmed bool
	cancel                  context.CancelFunc
	ctx                     context.Context
	bridgeCancel            context.CancelFunc
	now                     func() time.Time
}

// NewController builds an idle controller.
func NewController(options ControllerOptions) *Controller {
	log := options.Log
	if log == nil {
		log = func(string, map[string]string) {}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Controller{
		options: options,
		log:     log,
		state:   "idle",
		now:     now,
		// A fresh controller is not polling until Start succeeds.
		stopped: true,
	}
}

// Start performs one compatibility bootstrap unless the Runtime is receiving
// its initial state from the resident event stream. It never arms a recurring
// RoomInfo ticker: subsequent transitions are pushed over that stream.
func (c *Controller) Start(parent context.Context) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	c.mu.Lock()
	if !c.stopped {
		c.mu.Unlock()
		cancel()
		return
	}
	c.stopped = false
	c.mediaStateObserved = false
	c.lastMediaState = types.ResidentMediaState{}
	c.lastMediaStateConfirmed = false
	c.cancel = cancel
	c.ctx = ctx
	c.mu.Unlock()

	if !c.options.UsePushedMediaState {
		c.poll()
	}
}

// Stop tears everything down (bridge + speaker), bounded.
func (c *Controller) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	c.mediaStateObserved = false
	c.lastMediaState = types.ResidentMediaState{}
	c.lastMediaStateConfirmed = false
	cancel := c.cancel
	c.cancel = nil
	c.ctx = nil
	c.mu.Unlock()
	c.releaseLiveTranscriptLease()
	if cancel != nil {
		cancel()
	}
	c.teardownBridge()
}

// CurrentVoiceOutput returns the speakable output while an Agent Voice grant
// is active; nil when inactive/starting (callers stay text-only).
func (c *Controller) CurrentVoiceOutput() *voice.Speaker {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.speaker
}

// VoicePublishStats exposes the shared bridge's safe counters for turn
// diagnostics (nil-safe).
func (c *Controller) VoicePublishStats() map[string]uint64 {
	c.mu.Lock()
	bridge := c.bridge
	c.mu.Unlock()
	if bridge == nil {
		return map[string]uint64{}
	}
	return bridge.VoicePublishStats()
}

// HasVoiceOutput is the side-effect-free readiness check.
func (c *Controller) HasVoiceOutput() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.speaker != nil
}

// poll is a one-shot compatibility/helper path. Resident Runtimes use
// ObserveMediaState instead, so an idle resident never sends room_info.
func (c *Controller) poll() {
	c.mu.Lock()
	stopped := c.stopped
	c.mu.Unlock()
	if stopped {
		return
	}
	info, err := c.options.Client.RoomInfo(c.options.RoomID)
	if err != nil {
		// A transient RoomInfo failure fails closed for both grants but does not
		// count as a confirmed inactive Room observation. This preserves the
		// activation-edge behavior of the old polling controller.
		c.log("voice_reply_room_info_failed", map[string]string{"code": safeDiagnosticCode(err)})
		c.observeMediaState(types.ResidentMediaState{}, false)
		return
	}
	c.observeMediaState(residentMediaStateFromRoomInfo(info, c.options.ParticipantID), true)
}

// ObserveMediaState reconciles one self-targeted state envelope from the
// resident event stream. Identical envelopes are ignored so ordinary event
// traffic does not restart media or emit repeated diagnostics.
func (c *Controller) ObserveMediaState(state types.ResidentMediaState) {
	c.observeMediaState(state, true)
}

// FailClosedMediaState stops local media after the resident event stream loses
// its authenticated state source. It deliberately is not a confirmed Room
// revocation, so a reconnect observing the same grant does not re-announce the
// grant prerequisite.
func (c *Controller) FailClosedMediaState() {
	c.observeMediaState(types.ResidentMediaState{}, false)
}

func (c *Controller) observeMediaState(
	state types.ResidentMediaState,
	confirmed bool,
) {
	c.reconcileMu.Lock()
	defer c.reconcileMu.Unlock()
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	if c.mediaStateObserved && c.lastMediaState == state &&
		(!confirmed || c.lastMediaStateConfirmed) {
		c.mu.Unlock()
		return
	}
	c.mediaStateObserved = true
	c.lastMediaState = state
	c.lastMediaStateConfirmed = confirmed
	c.mu.Unlock()
	c.reconcileMediaState(state, confirmed)
}

func residentMediaStateFromRoomInfo(
	info types.RoomInfo,
	participantID string,
) types.ResidentMediaState {
	state := types.ResidentMediaState{
		MediaAvailable: info.MeetingNotesMediaAvailable || info.AgentVoiceMediaAvailable,
		LiveTranscript: types.ResidentLiveTranscriptState{
			Active:                info.LiveTranscript.Active,
			ProducerRuntimeHostID: info.LiveTranscript.ProducerRuntimeHostID,
			Epoch:                 info.LiveTranscript.Epoch,
		},
		MeetingNotes: types.ResidentMeetingNotesState{
			Active: info.MeetingNotesMediaAvailable &&
				info.MeetingNotes.Active &&
				info.MeetingNotes.AgentParticipantID == participantID,
			StartedAt: info.MeetingNotes.StartedAt,
		},
	}
	if grant, ok := info.AgentVoice[participantID]; ok &&
		info.AgentVoiceMediaAvailable && grant.EnabledAt > 0 {
		state.AgentVoiceEnabledAt = grant.EnabledAt
	}
	return state
}

func (c *Controller) reconcileMediaState(
	mediaState types.ResidentMediaState,
	roomInfoObserved bool,
) {
	authorized := mediaState.MediaAvailable && mediaState.MeetingNotes.Active
	var epoch *int64
	if mediaState.MeetingNotes.StartedAt > 0 {
		value := mediaState.MeetingNotes.StartedAt
		epoch = &value
	}
	vrAuthorized := c.options.Voice != nil &&
		mediaState.MediaAvailable && mediaState.AgentVoiceEnabledAt > 0
	var vrEpoch *int64
	if mediaState.AgentVoiceEnabledAt > 0 {
		value := mediaState.AgentVoiceEnabledAt
		vrEpoch = &value
	}
	liveInfo := types.LiveTranscriptInfo{
		Active:                mediaState.LiveTranscript.Active,
		ProducerRuntimeHostID: mediaState.LiveTranscript.ProducerRuntimeHostID,
		Epoch:                 mediaState.LiveTranscript.Epoch,
	}
	liveAuthorized := mediaState.MediaAvailable && c.acquireLiveTranscriptLease(liveInfo)
	if !liveAuthorized {
		c.releaseLiveTranscriptLease()
	}
	c.notifyLiveTranscriptState(liveInfo, liveAuthorized)

	if c.options.Voice != nil {
		c.mu.Lock()
		epochChanged := c.voiceObservedInit && !int64Equal(c.voiceObservedEpoch, vrEpoch)
		c.voiceObservedEpoch = vrEpoch
		c.voiceObservedInit = true
		c.mu.Unlock()
		c.log("voice_reply_state", map[string]string{
			"agent_voice_media_available":     bool01(mediaState.MediaAvailable),
			"agent_voice_enabled":             bool01(vrAuthorized),
			"voice_reply_targets_self":        bool01(vrEpoch != nil),
			"voice_reply_grant_epoch_present": bool01(vrEpoch != nil),
			"voice_reply_grant_epoch_changed": bool01(epochChanged),
		})
	}

	// #171: per-grant activation edges. Each grant announces ONCE per grant
	// instance (kind + epoch): a grant that stays active across observations
	// never re-fires; a stop/start (new epoch) or a reassignment to this
	// participant produces a fresh edge. Edges fire even while the shared
	// bridge is already running, so a second grant added later still gets
	// its own prerequisite evaluation without splitting the bridge.
	c.mu.Lock()
	stopped := c.stopped
	// A missing epoch (malformed/partial state) never participates in edge
	// comparison: an already-announced grant cannot re-fire from it.
	mnEdge := authorized &&
		(!c.mnAnnounced || (epoch != nil && !int64Equal(c.mnAnnouncedEpoch, epoch)))
	vrEdge := vrAuthorized &&
		(!c.vrAnnounced || (vrEpoch != nil && !int64Equal(c.vrAnnouncedEpoch, vrEpoch)))
	if mnEdge {
		c.mnAnnounced = true
		if epoch != nil {
			c.mnAnnouncedEpoch = epoch
		}
	} else if roomInfoObserved && !authorized {
		// Positively observed inactive: re-arm for a future grant instance.
		// A transport failure must NOT reach this branch.
		c.mnAnnounced = false
		c.mnAnnouncedEpoch = nil
	}
	if vrEdge {
		c.vrAnnounced = true
		if vrEpoch != nil {
			c.vrAnnouncedEpoch = vrEpoch
		}
	} else if roomInfoObserved && !vrAuthorized {
		// Positively observed inactive: re-arm for a future grant instance.
		// A transport failure must NOT reach this branch.
		c.vrAnnounced = false
		c.vrAnnouncedEpoch = nil
	}
	c.mu.Unlock()
	if stopped {
		return
	}
	if mnEdge && c.options.OnGrantActivated != nil {
		c.options.OnGrantActivated(GrantMeetingNotes)
	}
	if vrEdge && c.options.OnGrantActivated != nil {
		c.options.OnGrantActivated(GrantAgentVoice)
	}

	anyGrantActive := authorized || vrAuthorized || liveAuthorized
	if !anyGrantActive {
		c.mu.Lock()
		c.grantEpoch = nil
		c.liveEpoch = nil
		c.mu.Unlock()
		c.teardownBridge()
		return
	}

	// Epoch changes mean the server already closed the old grant's tracks.
	// Meeting Notes and Voice Reply need a whole-session rebuild. Live
	// Transcript needs only its remote subscriptions cleared when another
	// independent grant keeps the shared bridge alive.
	c.mu.Lock()
	mnStale := authorized && c.state != "idle" && !int64Equal(c.grantEpoch, epoch)
	vrStale := vrAuthorized && c.state != "idle" && !int64Equal(c.voiceEpoch, vrEpoch)
	liveWasBound := c.liveEpoch != nil
	liveStarted := liveAuthorized && !liveWasBound
	liveStale := liveAuthorized && liveWasBound && !int64Equal(c.liveEpoch, &liveInfo.Epoch)
	// A confirmed inactive Live Transcript state means the server is revoking
	// its remote subscriptions. A transport failure is deliberately excluded.
	liveStopped := roomInfoObserved && !liveAuthorized && liveWasBound
	rebuildBridge := mnStale || vrStale || (liveStale && !authorized && !vrAuthorized)
	if liveStopped {
		c.liveEpoch = nil
	}
	if authorized {
		c.grantEpoch = epoch
	}
	if liveAuthorized {
		value := liveInfo.Epoch
		c.liveEpoch = &value
	}
	bridge := c.bridge
	c.mu.Unlock()
	if rebuildBridge {
		// Production E2E proved that a Voice Reply Stop->Start re-grant does
		// not restore audible delivery when re-publishing on the same session.
		// A Live-only rotation follows the same fresh-session path.
		c.teardownBridge()
		bridge = nil
	}
	if !rebuildBridge && (liveStopped || liveStale) && bridge != nil {
		// Preserve Agent Voice and its PeerConnection; only forget the
		// server-revoked remote Human tracks. A new Live epoch will immediately
		// rediscover and subscribe below.
		bridge.ClearRemoteSubscriptions()
	}

	c.ensureRunning()
	c.mu.Lock()
	running := c.state == "running"
	bridge = c.bridge
	c.mu.Unlock()
	if !running {
		return
	}
	if !rebuildBridge && liveAuthorized && (liveStarted || liveStale) && bridge != nil {
		if err := bridge.RefreshRemoteSubscriptions(); err != nil {
			c.log("live_transcript_subscription_refresh_failed", map[string]string{
				"code": safeDiagnosticCode(err),
			})
		}
	}

	if c.options.Voice == nil || !vrAuthorized {
		c.teardownVoice()
		return
	}

	// VR epoch rotation: transport session stays valid, only the
	// publication restarts (discard old speaker, rebuild under new epoch).
	c.mu.Lock()
	epochRotated := !int64Equal(c.voiceEpoch, vrEpoch)
	if epochRotated {
		old := c.speaker
		c.speaker = nil
		c.voiceEpoch = vrEpoch
		c.mu.Unlock()
		if old != nil {
			old.Cancel()
			_ = old.Close()
		}
		if c.bridge != nil {
			c.bridge.DeactivateVoicePublish()
		}
	} else {
		c.mu.Unlock()
	}
	c.ensureVoice()
}

func int64Equal(a, b *int64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// acquireLiveTranscriptLease first verifies the public Host/epoch projection,
// then the local private provider association, and finally the daemon-local
// single-producer lease. Every failure is fail closed.
func (c *Controller) acquireLiveTranscriptLease(state types.LiveTranscriptInfo) bool {
	if !state.Active || state.Epoch <= 0 || state.ProducerRuntimeHostID == "" ||
		state.ProducerRuntimeHostID != c.options.RuntimeHostID ||
		c.options.RuntimeInstanceID == "" || c.options.LiveTranscriptCoordinator == nil ||
		c.options.CanProduceLiveTranscript == nil || !c.options.CanProduceLiveTranscript() {
		return false
	}
	if !c.options.LiveTranscriptCoordinator.Acquire(
		c.options.RoomID, c.options.RuntimeHostID, state.Epoch, c.options.RuntimeInstanceID) {
		return false
	}
	value := state.Epoch
	c.mu.Lock()
	c.liveLeaseEpoch = &value
	c.mu.Unlock()
	return true
}

// releaseLiveTranscriptLease only releases the exact epoch this resident
// acquired. It is safe to call on every failed observation and during shutdown.
func (c *Controller) releaseLiveTranscriptLease() {
	if c.options.LiveTranscriptCoordinator == nil || c.options.RuntimeHostID == "" || c.options.RuntimeInstanceID == "" {
		return
	}
	c.mu.Lock()
	epoch := c.liveLeaseEpoch
	c.liveLeaseEpoch = nil
	c.mu.Unlock()
	if epoch != nil {
		c.options.LiveTranscriptCoordinator.Release(
			c.options.RoomID, c.options.RuntimeHostID, *epoch, c.options.RuntimeInstanceID)
	}
}

// notifyLiveTranscriptState only crosses the runtime boundary on a producer
// state edge or epoch rotation. It never wakes a Harness turn.
func (c *Controller) notifyLiveTranscriptState(state types.LiveTranscriptInfo, producing bool) {
	c.mu.Lock()
	changed := producing != c.liveProducing ||
		(producing && (c.liveObservedEpoch == nil || *c.liveObservedEpoch != state.Epoch))
	if changed {
		c.liveProducing = producing
		if producing {
			value := state.Epoch
			c.liveObservedEpoch = &value
		} else {
			c.liveObservedEpoch = nil
		}
	}
	c.mu.Unlock()
	if changed && c.options.OnLiveTranscriptState != nil {
		if !producing {
			state = types.LiveTranscriptInfo{}
		}
		c.options.OnLiveTranscriptState(state, producing)
	}
}

// ensureRunning builds and starts the shared bridge exactly once (the
// synchronous state check before any await prevents racing polls from
// double-starting).
func (c *Controller) ensureRunning() {
	c.mu.Lock()
	if c.state != "idle" {
		c.mu.Unlock()
		return
	}
	c.state = "starting"
	c.generation++
	generation := c.generation
	parent := c.ctx
	if parent == nil {
		parent = context.Background()
	}
	bridgeCtx, bridgeCancel := context.WithCancel(parent)
	c.bridgeCancel = bridgeCancel
	c.mu.Unlock()

	bridge, err := c.buildBridge()
	if err != nil {
		bridgeCancel()
		c.mu.Lock()
		if c.generation == generation {
			c.state = "idle"
			c.bridgeCancel = nil
		}
		c.mu.Unlock()
		c.log("meeting_notes_media_start_failed", map[string]string{"code": safeDiagnosticCode(err)})
		return
	}
	c.mu.Lock()
	if c.stopped || c.generation != generation || c.state != "starting" {
		c.mu.Unlock()
		bridgeCancel()
		bridge.Stop()
		return
	}
	c.bridge = bridge
	c.mu.Unlock()

	if err := bridge.Start(bridgeCtx); err != nil {
		bridgeCancel()
		c.mu.Lock()
		if c.bridge == bridge {
			c.bridge = nil
		}
		if c.generation == generation && c.state == "starting" {
			c.state = "idle"
			c.bridgeCancel = nil
		}
		c.mu.Unlock()
		c.log("meeting_notes_media_start_failed", map[string]string{
			"code":  safeDiagnosticCode(err),
			"error": sanitizeStartError(err),
		})
		return
	}
	c.mu.Lock()
	if c.stopped || c.generation != generation || c.state != "starting" || c.bridge != bridge {
		c.mu.Unlock()
		bridgeCancel()
		bridge.Stop()
		return
	}
	c.state = "running"
	c.mu.Unlock()
	c.log("meeting_notes_media_started", nil)
}

func (c *Controller) buildBridge() (*Bridge, error) {
	if c.options.CreateBridge != nil {
		return c.options.CreateBridge()
	}
	return NewBridge(BridgeOptions{
		SiteOrigin: c.options.SiteOrigin,
		Handle:     c.options.Handle,
		Rest:       NewSfuRestClient(c.options.SiteOrigin, c.options.Handle),
		CreateEngine: func(events EngineEvents) (EngineLike, error) {
			engine := NewEngine(events, c.log)
			if err := engine.Create(); err != nil {
				return nil, err
			}
			return engine, nil
		},
		Events: BridgeEvents{
			OnAudioFrame:   c.options.OnAudioFrame,
			OnTrackStarted: c.options.OnTrackStarted,
			OnTrackEnded:   c.options.OnTrackEnded,
			OnStateChange: func(event, state string) {
				c.log(event, map[string]string{"state": state})
			},
		},
		SubscribePurpose: c.subscribePurpose,
		Publish: func() *PublishConfig {
			if c.options.Voice == nil {
				return nil
			}
			return &PublishConfig{TrackName: c.options.Voice.TrackName}
		}(),
		PollIntervalMs: c.options.PollIntervalMs,
		Log:            c.log,
		Now:            c.now,
	}), nil
}

// subscribePurpose is sampled by the Bridge for each remote Human track.
// The live producer is the narrowest current authorization; Meeting Notes
// remains the compatibility fallback for its independent legacy grant.
func (c *Controller) subscribePurpose() Purpose {
	c.mu.Lock()
	live := c.liveProducing
	c.mu.Unlock()
	if live {
		return PurposeLiveTranscript
	}
	return PurposeMeetingNotes
}

// ensureVoice resolves the TTS provider and builds the speaker on the active
// shared bridge (grant-gated, single-flight).
func (c *Controller) ensureVoice() {
	voiceConfig := c.options.Voice
	c.mu.Lock()
	bridge := c.bridge
	if voiceConfig == nil || bridge == nil || c.voiceStarting || c.speaker != nil ||
		c.state != "running" {
		c.mu.Unlock()
		return
	}
	c.voiceStarting = true
	c.mu.Unlock()

	provider, err := voiceConfig.CreateTtsProvider()
	if err != nil || provider == nil {
		c.log("voice_reply_tts_unresolved", map[string]string{"voice_reply_tts_resolved": "0"})
		c.mu.Lock()
		c.voiceStarting = false
		c.mu.Unlock()
		return
	}
	c.log("voice_reply_tts_resolved", map[string]string{"voice_reply_tts_resolved": "1"})
	if err := bridge.ActivateVoicePublish(); err != nil {
		c.log("voice_reply_start_failed", map[string]string{"code": safeDiagnosticCode(err)})
		c.mu.Lock()
		c.voiceStarting = false
		c.mu.Unlock()
		return
	}
	speaker := voice.NewSpeaker(voice.Options{
		Provider: provider,
		// Per-turn sink: the speaker hands its turn token to the factory,
		// binding every write to the exact utterance that produced it.
		CreateSink: func(token uint64) (voice.Sink, error) {
			return &bridgeVoiceSink{bridge: bridge, token: token}, nil
		},
		MaxChunkChars: voiceConfig.MaxChunkChars,
		Gate:          voiceConfig.HostVoiceGate,
		OnEvent:       voiceConfig.OnSpeakerEvent,
	})
	c.mu.Lock()
	c.speaker = speaker
	c.voiceStarting = false
	c.mu.Unlock()
	c.log("voice_reply_started", nil)
}

// bridgeVoiceSink adapts the shared bridge to the speaker sink boundary.
// Each sink instance is bound to exactly ONE speaker turn: its token rides
// every engine write, so a stale TTS callback that survives its own cancel
// is rejected at the engine's turn admission instead of being admitted as
// a new turn.
type bridgeVoiceSink struct {
	bridge *Bridge
	token  uint64
}

func (s *bridgeVoiceSink) WriteAudio(chunk speech.TtsAudioChunk) error {
	if chunk.Codec != "pcm_s16le" {
		return errors.New("unsupported_chunk")
	}
	return s.bridge.WriteVoicePcm(chunk.Data, s.token)
}

func (s *bridgeVoiceSink) EndTurn() error { return s.bridge.FlushVoice(s.token) }
func (s *bridgeVoiceSink) CancelTurn() error {
	s.bridge.CancelVoiceTurn(s.token)
	return nil
}
func (s *bridgeVoiceSink) Close() error { return nil }

func (c *Controller) teardownVoice() {
	c.mu.Lock()
	speaker := c.speaker
	c.speaker = nil
	c.voiceEpoch = nil
	bridge := c.bridge
	c.mu.Unlock()
	if speaker != nil {
		speaker.Cancel()
		_ = speaker.Close()
	}
	if bridge != nil {
		bridge.DeactivateVoicePublish()
	}
	c.log("voice_reply_stopped", nil)
}

func (c *Controller) teardownBridge() {
	c.teardownVoice()
	c.mu.Lock()
	c.generation++
	bridge := c.bridge
	bridgeCancel := c.bridgeCancel
	c.bridge = nil
	c.bridgeCancel = nil
	c.state = "idle"
	c.mu.Unlock()
	if bridgeCancel != nil {
		bridgeCancel()
	}
	if bridge != nil {
		bridge.Stop()
		c.log("meeting_notes_media_stopped", nil)
	}
}

// sanitizeStartError keeps the raw (already sanitized by the REST client)
// error string, bounded — used only for start-failure diagnosis.
func sanitizeStartError(err error) string {
	message := err.Error()
	if len(message) > 160 {
		message = message[:160]
	}
	return message
}

func safeDiagnosticCode(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "timeout"):
		return "timeout"
	case strings.Contains(message, "unsupported_chunk"):
		return "unsupported_chunk"
	case strings.Contains(message, "downstream_not_ready"):
		return "downstream_not_ready"
	case strings.Contains(message, "not authorized") ||
		strings.Contains(message, "not_authorized"):
		return "not_authorized"
	case strings.Contains(message, "decoding"):
		return "decoding_error"
	case strings.Contains(message, "network"):
		return "network_error"
	default:
		return "operation_failed"
	}
}
