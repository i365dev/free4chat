package runtime

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/speech"
	"github.com/i365dev/free4chat/agent/internal/speech/doubao"
	"github.com/i365dev/free4chat/agent/internal/types"
)

// replaceTranscriberLocked starts a fresh local STT generation. Callers hold
// mediaMu, so an old media callback cannot send a committed segment after its
// grant epoch was replaced.
func (r *ResidentRuntime) replaceTranscriberLocked(config speech.Config) {
	previous := r.transcriber
	r.transcriber = nil
	r.mu.Lock()
	r.sttGeneration++
	generation := r.sttGeneration
	r.mu.Unlock()
	if previous != nil {
		previous.Close()
	}
	if !config.STTEnabled {
		return
	}
	provider := &doubao.SttProvider{APIKey: config.APIKey}
	r.transcriber = speech.NewTranscriber(provider, func(event speech.AttributedSttEvent) {
		r.handleSttEvent(generation, event)
	})
}

func (r *ResidentRuntime) handleSttEvent(generation uint64, event speech.AttributedSttEvent) {
	switch event.Event.Type {
	case "committed":
		text := strings.TrimSpace(event.Event.Text)
		if text == "" {
			return
		}
		if r.isCurrentLiveProducer(generation) {
			// The asynchronous publish keeps provider event forwarding and RTP
			// callbacks non-blocking. The generation/epoch is checked again for
			// every retry below.
			go r.publishLiveTranscriptSegment(generation, event.Source.ParticipantID, text)
		} else {
			// Legacy Meeting Notes remains local-only. A Live producer must not
			// write the same text to the local Meeting Notes store as well.
			r.mediaMu.Lock()
			if r.transcript != nil && !r.isCurrentLiveProducer(generation) {
				r.transcript.Record(event.Source, text)
			}
			r.mediaMu.Unlock()
		}
		r.log("stt_committed", map[string]string{"chars": strconv.Itoa(len(text))})
	case "error":
		if event.Event.Error != nil {
			r.log("stt_error", map[string]string{"code": event.Event.Error.Code})
		}
	}
}

func (r *ResidentRuntime) isCurrentLiveProducer(generation uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.stopped && r.liveTranscriptProducing && r.liveTranscript.Active &&
		r.liveTranscript.Epoch > 0 && r.sttGeneration == generation && r.participantHandle != ""
}

func (r *ResidentRuntime) liveProducerSnapshot(generation uint64) (string, int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || !r.liveTranscriptProducing || !r.liveTranscript.Active ||
		r.liveTranscript.Epoch <= 0 || r.sttGeneration != generation || r.participantHandle == "" {
		return "", 0, false
	}
	return r.participantHandle, r.liveTranscript.Epoch, true
}

// setLiveTranscriptProducer is invoked only by the grant controller on a
// local ownership edge. It resets the STT generation so late provider events
// cannot cross a Stop/reassign/epoch boundary.
func (r *ResidentRuntime) setLiveTranscriptProducer(state types.LiveTranscriptInfo, producing bool) {
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	r.setLiveTranscriptProducerLocked(state, producing)
}

// setLiveTranscriptProducerForMediaGeneration rejects a state edge emitted
// after that controller has been stopped or replaced. Bridge teardown emits
// TrackEnded asynchronously to avoid mediaMu self-deadlock, so all callbacks
// from a controller share this generation fence.
func (r *ResidentRuntime) setLiveTranscriptProducerForMediaGeneration(
	generation uint64,
	state types.LiveTranscriptInfo,
	producing bool,
) {
	r.mediaMu.Lock()
	defer r.mediaMu.Unlock()
	if r.mediaGeneration != generation {
		return
	}
	r.setLiveTranscriptProducerLocked(state, producing)
}

func (r *ResidentRuntime) setLiveTranscriptProducerLocked(
	state types.LiveTranscriptInfo,
	producing bool,
) {
	r.mu.Lock()
	changed := producing != r.liveTranscriptProducing ||
		(producing && (!r.liveTranscript.Active || r.liveTranscript.Epoch != state.Epoch))
	if changed {
		if producing {
			r.liveTranscript = state
		} else {
			r.liveTranscript = types.LiveTranscriptInfo{}
		}
		r.liveTranscriptProducing = producing
	}
	config := r.speechConfig
	r.mu.Unlock()
	if changed {
		r.replaceTranscriberLocked(config)
	}
}

func newLiveTranscriptSegmentID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return ""
	}
	return "lt_" + hex.EncodeToString(bytes)
}

// publishLiveTranscriptSegment retries only transient Room-control failures.
// The same generated id is reused across attempts, preserving DO idempotency.
func (r *ResidentRuntime) publishLiveTranscriptSegment(generation uint64, sourceParticipantID, text string) {
	segmentID := newLiveTranscriptSegmentID()
	if segmentID == "" || sourceParticipantID == "" {
		return
	}
	publisher, ok := r.options.Client.(types.LiveTranscriptAppendClient)
	if !ok {
		r.log("live_transcript_append_unavailable", nil)
		return
	}
	for attempt, delay := range []time.Duration{0, 150 * time.Millisecond, 400 * time.Millisecond} {
		if delay > 0 {
			timer := time.NewTimer(delay)
			<-timer.C
		}
		handle, epoch, active := r.liveProducerSnapshot(generation)
		if !active {
			return
		}
		err := publisher.AppendLiveTranscript(handle, epoch, segmentID, sourceParticipantID, text)
		if err == nil {
			r.log("live_transcript_committed", map[string]string{"attempt": strconv.Itoa(attempt + 1)})
			return
		}
		if free4chat.CodeOf(err) != free4chat.CodeTransient {
			r.log("live_transcript_append_rejected", map[string]string{"code": string(free4chat.CodeOf(err))})
			return
		}
	}
	r.log("live_transcript_append_failed", map[string]string{"code": "transient"})
}

// attachLiveTranscript refreshes Room-wide Live Transcript immediately before
// an addressed Harness turn, but injects only segments not yet successfully
// delivered to the retained Harness. A refresh failure never blocks ordinary
// collaboration and a returned marker is acknowledged only after RunTurn.
func (r *ResidentRuntime) attachLiveTranscript(input *types.HarnessTurnInput) int64 {
	roomID := r.activeRoomID()
	if roomID == "" {
		return 0
	}
	info, err := r.options.Client.RoomInfo(roomID)
	if err != nil {
		r.log("live_transcript_refresh_failed", map[string]string{"code": string(free4chat.CodeOf(err))})
		return 0
	}
	if len(info.LiveTranscriptSegments) == 0 {
		return 0
	}
	_, delivered := r.transcriptDeliveryMarkers()
	segments := make([]types.LiveTranscriptSegment, 0, len(info.LiveTranscriptSegments))
	var through int64
	for _, segment := range info.LiveTranscriptSegments {
		if segment.Sequence <= delivered {
			continue
		}
		segments = append(segments, segment)
		if segment.Sequence > through {
			through = segment.Sequence
		}
	}
	if len(segments) == 0 {
		return 0
	}
	input.LiveTranscript = &types.HarnessLiveTranscript{Segments: segments}
	return through
}
