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
	Client        types.Free4ChatClient // RoomInfo (sanitized room state)
	RoomID        string
	ParticipantID string
	SiteOrigin    string
	Handle        DecodedHandle
	// PollIntervalMs defaults to 5s.
	PollIntervalMs int
	// OnAudioFrame receives attributed SFU audio frames (wire to the
	// transcriber).
	OnAudioFrame func(source speech.AudioSource, frame speech.AudioFrame)
	// OnTrackStarted/Ended mirror media bridge events (transcriber wiring).
	OnTrackStarted func(source speech.AudioSource)
	OnTrackEnded   func(source speech.AudioSource)
	// OnGrantActivated fires once per successful grant activation (the
	// runtime uses it to check speech readiness at grant time).
	OnGrantActivated func()
	// Voice configures outbound Voice Reply (nil = Meeting Notes only).
	Voice *VoiceConfig
	// Log receives bounded safe events.
	Log func(event string, details map[string]string)
	// Now injectable for tests.
	Now func() time.Time
	// CreateBridge injectable for tests (real production wiring default).
	CreateBridge func() (*Bridge, error)
}

// VoiceConfig is the outbound voice surface.
type VoiceConfig struct {
	TrackName         string
	CreateTtsProvider func() (speech.StreamingTtsProvider, error)
	MaxChunkChars     int
	OnSpeakerEvent    func(voice.SpeakerEvent)
}

// Controller owns the Runtime-side half of the media lifecycle: it polls
// room_info for the Meeting Notes and voiceReply grants and starts/stops the
// ONE shared Bridge accordingly. This is the ONLY thing that decides when
// this process may hold an active media session — authorization always comes
// from the room-visible grant, never from a local decision.
type Controller struct {
	options ControllerOptions
	log     func(event string, details map[string]string)

	mu                 sync.Mutex
	state              string // idle | starting | running
	generation         int
	grantEpoch         *int64
	voiceEpoch         *int64
	voiceObservedEpoch *int64
	voiceObservedInit  bool
	bridge             *Bridge
	speaker            *voice.Speaker
	voiceStarting      bool
	stopped            bool
	cancel             context.CancelFunc
	now                func() time.Time
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

// Start runs the first poll synchronously, then arms the ticker — a caller
// awaiting Start sees the first authorization check settle deterministically.
func (c *Controller) Start(parent context.Context) {
	c.mu.Lock()
	if !c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = false
	c.mu.Unlock()

	ctx, cancel := context.WithCancel(parent)
	c.mu.Lock()
	c.cancel = cancel
	c.mu.Unlock()

	c.poll()
	interval := c.options.PollIntervalMs
	if interval <= 0 {
		interval = DefaultPollIntervalMs
	}
	go func() {
		ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.poll()
			}
		}
	}()
}

// Stop tears everything down (bridge + speaker), bounded.
func (c *Controller) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	cancel := c.cancel
	c.cancel = nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	c.teardownBridge()
}

// CurrentVoiceOutput returns the speakable output while a voiceReply grant
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

// poll samples room_info and reconciles grants (fail-closed on error).
func (c *Controller) poll() {
	c.mu.Lock()
	stopped := c.stopped
	c.mu.Unlock()
	if stopped {
		return
	}

	authorized := false
	var epoch *int64
	vrAuthorized := false
	var vrEpoch *int64

	info, err := c.options.Client.RoomInfo(c.options.RoomID)
	if err != nil {
		// A transient room_info failure fails closed for BOTH grants.
		authorized = false
		vrAuthorized = false
		c.log("voice_reply_room_info_failed", map[string]string{"code": safeDiagnosticCode(err)})
	} else {
		if c.options.Voice != nil {
			vrTargetsSelf := info.VoiceReply.AgentParticipantID == c.options.ParticipantID
			vrAuthorized = info.VoiceReplyMediaAvailable &&
				info.VoiceReply.Active && vrTargetsSelf
			if info.VoiceReply.StartedAt > 0 {
				value := info.VoiceReply.StartedAt
				vrEpoch = &value
			}
			c.mu.Lock()
			epochChanged := c.voiceObservedInit && !int64Equal(c.voiceObservedEpoch, vrEpoch)
			c.voiceObservedEpoch = vrEpoch
			c.voiceObservedInit = true
			c.mu.Unlock()
			c.log("voice_reply_state", map[string]string{
				"voice_reply_media_available":     bool01(info.VoiceReplyMediaAvailable),
				"voice_reply_active":              bool01(info.VoiceReply.Active),
				"voice_reply_targets_self":        bool01(vrTargetsSelf),
				"voice_reply_grant_epoch_present": bool01(vrEpoch != nil),
				"voice_reply_grant_epoch_changed": bool01(epochChanged),
			})
		}
		authorized = info.MeetingNotesMediaAvailable &&
			info.MeetingNotes.Active &&
			info.MeetingNotes.AgentParticipantID == c.options.ParticipantID
		if info.MeetingNotes.StartedAt > 0 {
			value := info.MeetingNotes.StartedAt
			epoch = &value
		}
	}

	c.mu.Lock()
	stopped = c.stopped
	c.mu.Unlock()
	if stopped {
		return
	}

	anyGrantActive := authorized || vrAuthorized
	if !anyGrantActive {
		c.mu.Lock()
		c.grantEpoch = nil
		c.mu.Unlock()
		c.teardownBridge()
		return
	}

	// MN epoch change between polls => the server already closed the old
	// grant's subscriptions: rebuild the whole shared session.
	c.mu.Lock()
	mnStale := authorized && c.state != "idle" && !int64Equal(c.grantEpoch, epoch)
	if mnStale {
		c.mu.Unlock()
		c.teardownBridge()
		c.mu.Lock()
	}
	if authorized {
		c.grantEpoch = epoch
	}
	c.mu.Unlock()

	c.ensureRunning()
	c.mu.Lock()
	running := c.state == "running"
	c.mu.Unlock()
	if !running {
		return
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
	c.mu.Unlock()

	bridge, err := c.buildBridge()
	if err != nil {
		c.mu.Lock()
		if c.generation == generation {
			c.state = "idle"
		}
		c.mu.Unlock()
		c.log("meeting_notes_media_start_failed", map[string]string{"code": safeDiagnosticCode(err)})
		return
	}
	c.mu.Lock()
	c.bridge = bridge
	c.mu.Unlock()

	if err := bridge.Start(context.Background()); err != nil {
		c.mu.Lock()
		c.bridge = nil
		if c.generation == generation {
			c.state = "idle"
		}
		c.mu.Unlock()
		c.log("meeting_notes_media_start_failed", map[string]string{
			"code":  safeDiagnosticCode(err),
			"error": sanitizeStartError(err),
		})
		return
	}
	c.mu.Lock()
	if c.generation != generation {
		c.mu.Unlock()
		bridge.Stop()
		return
	}
	c.state = "running"
	c.mu.Unlock()
	c.log("meeting_notes_media_started", nil)
	if c.options.OnGrantActivated != nil {
		c.options.OnGrantActivated()
	}
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
		CreateSink: func() (voice.Sink, error) {
			return &bridgeVoiceSink{bridge: bridge}, nil
		},
		MaxChunkChars: voiceConfig.MaxChunkChars,
		OnEvent:       voiceConfig.OnSpeakerEvent,
	})
	c.mu.Lock()
	c.speaker = speaker
	c.voiceStarting = false
	c.mu.Unlock()
	c.log("voice_reply_started", nil)
}

// bridgeVoiceSink adapts the shared bridge to the speaker sink boundary.
type bridgeVoiceSink struct {
	bridge *Bridge
}

func (s *bridgeVoiceSink) WriteAudio(chunk speech.TtsAudioChunk) error {
	if chunk.Codec != "pcm_s16le" {
		return errors.New("unsupported_chunk")
	}
	return s.bridge.WriteVoicePcm(chunk.Data)
}

func (s *bridgeVoiceSink) EndTurn() error    { return s.bridge.FlushVoice() }
func (s *bridgeVoiceSink) CancelTurn() error { s.bridge.CancelVoiceTurn(); return nil }
func (s *bridgeVoiceSink) Close() error      { return nil }

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
	if c.state == "idle" {
		c.mu.Unlock()
		return
	}
	wasRunning := c.state == "running"
	bridge := c.bridge
	c.bridge = nil
	c.state = "idle"
	c.mu.Unlock()
	if wasRunning && bridge != nil {
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
