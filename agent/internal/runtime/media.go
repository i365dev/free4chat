package runtime

import (
	"context"
	"fmt"

	"github.com/i365dev/free4chat/agent/internal/media"
	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
	"github.com/i365dev/free4chat/agent/internal/types"
	"github.com/i365dev/free4chat/agent/internal/voice"
)

// restartMediaController rebuilds the media controller against a FRESH
// participant handle on every successful join/create adoption: a rejoin's
// fresh handle/participantId invalidates the previous controller
// (authorization is participant-bound), so the old one is stopped and its
// decoded token discarded first. A failure here is logged and never fails
// the join itself — media is strictly additive to text/ACP.
func (r *ResidentRuntime) restartMediaController(participantHandle string) {
	// Lock ordering is always mediaMu -> mu here and in releaseResources.
	// Stop sets stopped under mu before it waits for mediaMu, so a reload that
	// begins after shutdown cannot create a controller against a closed client.
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	r.mu.Lock()
	if r.stopped || participantHandle == "" || participantHandle != r.participantHandle {
		r.mu.Unlock()
		return
	}
	speechConfig := r.speechConfig
	roomID := r.resolvedRoomID
	if roomID == "" {
		roomID = r.options.RoomID
	}
	client := r.options.Client
	siteOrigin := r.options.SiteOrigin
	r.mu.Unlock()

	previous := r.mediaController
	r.mediaController = nil
	// A Bridge emits TrackEnded asynchronously during teardown. Invalidate
	// this controller's callbacks before Stop so they cannot touch the fresh
	// transcriber installed below after a reload/rejoin.
	r.mediaGeneration++
	mediaGeneration := r.mediaGeneration
	if previous != nil {
		previous.Stop()
	}
	// We already hold mediaMu, so do not route this reset through the
	// controller callback (which also acquires mediaMu).
	r.mu.Lock()
	r.liveTranscript = types.LiveTranscriptInfo{}
	r.liveTranscriptProducing = false
	r.mu.Unlock()
	if siteOrigin == "" {
		r.replaceTranscriberLocked(speech.Config{})
		return
	}
	handle, err := media.DecodeParticipantHandle(participantHandle)
	if err != nil {
		r.replaceTranscriberLocked(speech.Config{})
		r.log("media_controller_init_failed", map[string]string{
			"error": "invalid_participant_handle",
		})
		return
	}

	// One generation is used for both legacy Meeting Notes and Live
	// Transcript STT. The callback decides the committed-text destination;
	// it never duplicates a Live segment into the local Meeting Notes store.
	r.replaceTranscriberLocked(speechConfig)
	runtimeHostID := ""
	if host := r.CurrentHostProjection(); host != nil {
		runtimeHostID = host.RuntimeHostID
	}

	var voiceConfig *media.VoiceConfig
	voiceConfig = &media.VoiceConfig{
		TrackName:     "agent-voice",
		MaxChunkChars: 220,
		HostVoiceGate: r.options.HostVoiceGate,
		CreateTtsProvider: func() (speech.StreamingTtsProvider, error) {
			if !speechConfig.TTSEnabled {
				return nil, nil
			}
			return &doubao.TtsProvider{APIKey: speechConfig.APIKey, Voice: speechConfig.Voice}, nil
		},
		OnSpeakerEvent: r.logVoiceSpeakerEvent,
	}

	controller := media.NewController(media.ControllerOptions{
		Client:                    client,
		RoomID:                    roomID,
		ParticipantID:             handle.ParticipantID,
		SiteOrigin:                siteOrigin,
		Handle:                    handle,
		RuntimeHostID:             runtimeHostID,
		RuntimeInstanceID:         r.options.InstanceID,
		LiveTranscriptCoordinator: r.options.TranscriptProducers,
		CanProduceLiveTranscript: func() bool {
			return runtimeHostID != "" && r.providerHandles.Get(roomID, runtimeHostID) != ""
		},
		Log: r.log,
		OnAudioFrame: func(source speech.AudioSource, frame speech.AudioFrame) {
			r.withCurrentMediaGeneration(mediaGeneration, func() {
				if r.transcriber != nil {
					r.transcriber.AcceptAudio(source, frame)
				}
			})
		},
		OnTrackStarted: func(source speech.AudioSource) {
			r.withCurrentMediaGeneration(mediaGeneration, func() {
				if r.transcriber != nil {
					r.transcriber.TrackStarted(source)
				}
			})
		},
		OnTrackEnded: func(source speech.AudioSource) {
			r.withCurrentMediaGeneration(mediaGeneration, func() {
				if r.transcriber != nil {
					r.transcriber.TrackEnded(source)
				}
			})
		},
		OnGrantActivated: func(kind media.GrantKind) {
			if r.isCurrentMediaGeneration(mediaGeneration) {
				r.notifySpeechPrerequisite(kind)
			}
		},
		OnLiveTranscriptState: func(state types.LiveTranscriptInfo, producing bool) {
			r.setLiveTranscriptProducerForMediaGeneration(
				mediaGeneration,
				state,
				producing,
			)
		},
		Voice: voiceConfig,
	})
	r.mediaController = controller
	r.voiceSrc = controller
	// Non-blocking like the frozen Node reference: the first grant poll must
	// never gate join()/create() on a room_info round trip.
	go controller.Start(context.Background())
}

func (r *ResidentRuntime) withCurrentMediaGeneration(
	generation uint64,
	callback func(),
) {
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	if r.mediaGeneration == generation {
		callback()
	}
}

func (r *ResidentRuntime) isCurrentMediaGeneration(generation uint64) bool {
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	return r.mediaGeneration == generation
}

// notifySpeechPrerequisite tells the room ONCE per grant activation edge
// (#171), evaluating exactly that grant's own speech prerequisite — Meeting
// Notes requires STT, Voice Reply requires TTS. It points at the agent's
// own session and never solicits secrets in room chat.
func (r *ResidentRuntime) notifySpeechPrerequisite(kind media.GrantKind) {
	notice := buildSpeechNotice(r.speechSnapshot(), kind)
	if notice == "" {
		return
	}
	handle := r.currentHandle()
	if handle == "" {
		return
	}
	// Best-effort; readiness stays authoritative. Unaddressed on purpose:
	// the notice is ordinary room context for everyone present.
	if _, err := r.options.Client.SendText(handle, notice, nil); err != nil {
		r.log("speech_notice_failed", nil)
	}
}

// buildSpeechNotice evaluates the speech prerequisite of the grant that
// activated (#171) and returns the room message, or "" when that
// prerequisite is satisfied. The shared media bridge is intentionally not
// split: the grant kind decides which local slot (STT or TTS) must exist.
func buildSpeechNotice(config speech.Config, kind media.GrantKind) string {
	switch kind {
	case media.GrantAgentVoice:
		if !config.TTSEnabled {
			return "Voice Reply was requested, but no text-to-speech provider is configured in my local runtime. I'll complete speech setup in my own session before speaking — please don't paste API keys into this room."
		}
		return ""
	default:
		if !config.STTEnabled {
			return "Meeting Notes was requested, but no speech-to-text provider is configured in my local runtime. I'll complete speech setup in my own session before transcribing — please don't paste API keys into this room."
		}
		return ""
	}
}

// logVoiceSpeakerEvent maps speaker lifecycle events to bounded safe logs.
func (r *ResidentRuntime) logVoiceSpeakerEvent(event voice.SpeakerEvent) {
	switch event.Type {
	case "turnStarted":
		r.log("voice_turn_started", map[string]string{"turn": fmt.Sprintf("%d", event.Turn)})
	case "turnFinished":
		r.log("voice_turn_finished", map[string]string{
			"turn":   fmt.Sprintf("%d", event.Turn),
			"chunks": fmt.Sprintf("%d", event.Chunks),
			"frames": fmt.Sprintf("%d", event.Frames),
		})
		r.logVoiceBridgeStats("voice_turn_finished")
	case "turnCancelled":
		r.log("voice_turn_cancelled", map[string]string{"turn": fmt.Sprintf("%d", event.Turn)})
	case "turnTruncated":
		r.log("voice_turn_truncated", map[string]string{
			"turn":          fmt.Sprintf("%d", event.Turn),
			"droppedChunks": fmt.Sprintf("%d", event.DroppedChunks),
		})
	case "turnFailed":
		r.log("voice_turn_failed", map[string]string{
			"turn": fmt.Sprintf("%d", event.Turn),
			"code": event.Code,
		})
		r.logVoiceBridgeStats("voice_turn_failed")
	}
}

// logVoiceBridgeStats attaches the bridge's safe byte counters to voice turn
// events (received/buffered/drained) for pipeline diagnosis.
func (r *ResidentRuntime) logVoiceBridgeStats(event string) {
	if r.mediaController == nil {
		return
	}
	stats := r.mediaController.VoicePublishStats()
	details := map[string]string{}
	for key, value := range stats {
		details[key] = fmt.Sprintf("%d", value)
	}
	r.log(event+"_stats", details)
}

// voiceOutput returns the current speakable output (nil when no live
// Agent Voice grant); callers stay text-only on nil.
func (r *ResidentRuntime) voiceOutput() *voice.Speaker {
	if r.voiceSrc == nil {
		return nil
	}
	return r.voiceSrc.CurrentVoiceOutput()
}

// attachTranscript injects the bounded runtime-local transcript snapshot
// into the Harness turn (Meeting Notes context).
func (r *ResidentRuntime) attachTranscript(input *types.HarnessTurnInput) {
	if r.transcript == nil {
		return
	}
	snapshot := r.transcript.Snapshot()
	segments := make([]types.HarnessTranscriptSegment, 0, len(snapshot.Segments))
	for _, segment := range snapshot.Segments {
		segments = append(segments, types.HarnessTranscriptSegment{
			ParticipantID: segment.ParticipantID,
			Speaker:       segment.Speaker,
			Text:          segment.Text,
		})
	}
	input.MeetingTranscript = &types.HarnessMeetingTranscript{
		Path:     snapshot.Path,
		Segments: segments,
	}
}
