// Package media owns the in-process realtime media plane: the Pion
// PeerConnection engine (ported from the proven experiments/pion-cloudflare
// implementation), the Cloudflare SFU REST client, the shared-session media
// bridge, and the grant controller. ONE shared session serves both Meeting
// Notes (Human audio ingress) and Voice Reply (Agent audio egress); the
// initial bootstrap is receive-only and the outbound track is armed only at
// voice-grant activation.
package media

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/pion/opus"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	stunURL           = "stun:stun.cloudflare.com:3478"
	gatherTimeout     = 20 * time.Second
	connectTimeout    = 30 * time.Second
	answerGatherGrace = 2 * time.Second

	// Outbound voice pacing (#83): Opus frames are 20 ms apart on the wire;
	// the writer emits them at wall-clock pace instead of bursting whatever
	// PCM arrived in one chunk. After a stall longer than paceResyncAfter
	// the schedule rebaselines rather than bursting to catch up.
	frameDuration   = 20 * time.Millisecond
	paceResyncAfter = 250 * time.Millisecond

	// opusFrameSamples is one 20 ms frame at 48 kHz mono.
	opusFrameSamples = 960

	// maxQueuePcmBytes bounds the async PCM queue (~21s @24k): enough
	// prefetch to smooth any HTTP burstiness, small enough to stay bounded.
	maxQueuePcmBytes = 1 << 20
)

// Description carries an SDP document across the REST boundary.
type Description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// CodecInfo describes one remote track's codec.
type CodecInfo struct {
	MimeType  string
	ClockRate int
	Channels  int
}

// AudioFrameEvent is one decoded remote RTP payload, attributed by MID.
type AudioFrameEvent struct {
	MID     string
	Payload []byte
	Codec   CodecInfo
}

// TrackEvent announces a remote track.
type TrackEvent struct {
	Kind  string // "audio" | "video"
	MID   string
	Codec CodecInfo
	SSRC  uint32
}

// EngineEvents carries the callback surface the bridge needs.
type EngineEvents struct {
	// OnConnectionStateChange reports Pion connection states (safe names).
	OnConnectionStateChange func(state string)
	// OnICEStateChange reports ICE states (safe names).
	OnICEStateChange func(state string)
	// OnTrack announces one remote track.
	OnTrack func(TrackEvent)
	// OnAudioFrame delivers one decoded RTP payload for an audio MID.
	OnAudioFrame func(AudioFrameEvent)
}

// Engine is the in-process Pion PeerConnection (no JSONL boundary). It is a
// pure media engine: SDP in/out, RTP in/out, zero HTTP, zero secrets.
type Engine struct {
	pc     *webrtc.PeerConnection
	ev     EngineEvents
	log    func(event string, details map[string]string)
	dcOpen chan struct{}

	mu                sync.Mutex
	outbound          *webrtc.TrackLocalStaticSample
	publishOn         bool
	encoder           *opus.Encoder
	pcmWriteCalls     uint64
	pcmInputBytes     uint64
	opusFramesWritten uint64
	rtpCounts         map[string]uint64
	nowFn             func() time.Time
	sleepFn           func(time.Duration)
	pacer             *framePacer
	closed            bool

	// Async paced writer: WritePCM only enqueues; the writer goroutine owns
	// framing/carry and emits Opus frames at exact 20 ms cadence. This
	// decouples the TTS stream's bursty arrival from the RTP send timeline —
	// inline pacing made the HTTP reader stall between bursts, starving the
	// browser jitter buffer and producing PLC "robot voice" artifacts.
	writerMu      sync.Mutex
	queue         chan []byte
	queueBytes    int
	carry         []byte
	writerRunning bool
	writerStop    chan struct{}
	writerDone    chan struct{}
}

// framePacer spaces outbound Opus frames one frame-duration apart (ported
// verbatim from the experiment; clock/sleeper injection keeps tests
// deterministic).
type framePacer struct {
	mu    sync.Mutex
	now   func() time.Time
	sleep func(time.Duration)
	next  time.Time
}

func newFramePacer(now func() time.Time, sleep func(time.Duration)) *framePacer {
	return &framePacer{now: now, sleep: sleep}
}

func (p *framePacer) pace() {
	p.mu.Lock()
	now := p.now()
	if p.next.IsZero() || now.Sub(p.next) >= paceResyncAfter {
		p.next = now.Add(frameDuration)
		p.mu.Unlock()
		return
	}
	wait := p.next.Sub(now)
	p.mu.Unlock()
	if wait > 0 {
		p.sleep(wait)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if after := p.next.Add(frameDuration); after.After(now) {
		p.next = after
	} else {
		p.next = now.Add(frameDuration)
	}
}

// NewEngine builds an idle engine.
func NewEngine(events EngineEvents, log func(event string, details map[string]string)) *Engine {
	if log == nil {
		log = func(string, map[string]string) {}
	}
	return &Engine{
		ev:        events,
		log:       log,
		dcOpen:    make(chan struct{}),
		rtpCounts: make(map[string]uint64),
		nowFn:     time.Now,
		sleepFn:   time.Sleep,
		queue:     make(chan []byte, 128),
	}
}

// Create builds the PeerConnection with Cloudflare-aligned defaults.
// Meeting Notes bootstrap is receive-only: the outbound voice track stays
// UNARMED until ArmPublish (voice-grant activation).
func (e *Engine) Create() error {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{stunURL}}},
	})
	if err != nil {
		return err
	}
	e.pc = pc
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		if e.ev.OnICEStateChange != nil {
			e.ev.OnICEStateChange(state.String())
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if e.ev.OnConnectionStateChange != nil {
			e.ev.OnConnectionStateChange(state.String())
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		e.handleIncomingTrack(track, receiver)
	})
	return nil
}

// CreateServerEventsChannel creates the server-events DataChannel BEFORE any
// offer exists (frozen invariant).
func (e *Engine) CreateServerEventsChannel() error {
	dc, err := e.pc.CreateDataChannel("server-events", nil)
	if err != nil {
		return fmt.Errorf("create server-events datachannel: %w", err)
	}
	dc.OnOpen(func() {
		select {
		case <-e.dcOpen:
		default:
			close(e.dcOpen)
		}
	})
	return nil
}

// CreateLocalOffer runs offer -> SetLocalDescription without waiting for
// full gathering (renegotiations reuse the established transport).
func (e *Engine) CreateLocalOffer() (*Description, error) {
	offer, err := e.pc.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("createOffer: %w", err)
	}
	if err := e.pc.SetLocalDescription(offer); err != nil {
		return nil, fmt.Errorf("setLocalDescription(offer): %w", err)
	}
	ld := e.pc.LocalDescription()
	if ld == nil {
		return nil, fmt.Errorf("localDescription nil after offer")
	}
	return &Description{Type: ld.Type.String(), SDP: ld.SDP}, nil
}

// GatherCompleteOffer runs offer -> SetLocalDescription -> full ICE gather,
// returning the gathered local offer.
func (e *Engine) GatherCompleteOffer() (*Description, error) {
	gathered := make(chan struct{})
	var once sync.Once
	e.pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			once.Do(func() { close(gathered) })
		}
	})
	if _, err := e.CreateLocalOffer(); err != nil {
		return nil, err
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		return nil, fmt.Errorf("ice gathering timed out after %s", gatherTimeout)
	}
	ld := e.pc.LocalDescription()
	if ld == nil {
		return nil, fmt.Errorf("localDescription nil after gathering")
	}
	return &Description{Type: ld.Type.String(), SDP: ld.SDP}, nil
}

// ApplyRemote follows the ACTUAL type of the received description:
// answer -> SetRemoteDescription; offer -> SetRemoteDescription, CreateAnswer,
// SetLocalDescription, and returns the local answer for PUT /renegotiate.
func (e *Engine) ApplyRemote(remote Description) (applied string, answer *Description, err error) {
	if remote.SDP == "" || remote.Type == "" {
		return "", nil, fmt.Errorf("empty remote session description")
	}
	switch remote.Type {
	case "answer":
		if err := e.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: remote.SDP}); err != nil {
			return "", nil, fmt.Errorf("setRemoteDescription(answer): %w", err)
		}
		return "answer", nil, nil
	case "offer":
		if err := e.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: remote.SDP}); err != nil {
			return "", nil, fmt.Errorf("setRemoteDescription(offer): %w", err)
		}
		if got := e.pc.SignalingState(); got != webrtc.SignalingStateHaveRemoteOffer {
			return "", nil, fmt.Errorf("signaling state after remote offer = %s, want have-remote-offer", got)
		}
		ans, err := e.pc.CreateAnswer(nil)
		if err != nil {
			return "", nil, fmt.Errorf("createAnswer: %w", err)
		}
		if err := e.pc.SetLocalDescription(ans); err != nil {
			return "", nil, fmt.Errorf("setLocalDescription(answer): %w", err)
		}
		waitAnswerGather(e.pc)
		ld := e.pc.LocalDescription()
		return "offer", &Description{Type: "answer", SDP: ld.SDP}, nil
	default:
		return "", nil, fmt.Errorf("unexpected remote description type %q", remote.Type)
	}
}

func waitAnswerGather(pc *webrtc.PeerConnection) {
	deadline := time.Now().Add(answerGatherGrace)
	for time.Now().Before(deadline) {
		if pc.ICEGatheringState() == webrtc.ICEGatheringStateComplete {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// WaitConnected blocks until connected or timeout.
func (e *Engine) WaitConnected(timeout time.Duration) error {
	deadline := time.After(timeout)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		if e.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return nil
		}
		select {
		case <-deadline:
			return fmt.Errorf("peer connection did not reach connected within %s (state=%s ice=%s)",
				timeout, e.pc.ConnectionState(), e.pc.ICEConnectionState())
		case <-tick.C:
		}
	}
}

// handleIncomingTrack announces a remote track and streams its RTP frames.
func (e *Engine) handleIncomingTrack(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	mid := ""
	if t := receiver.RTPTransceiver(); t != nil {
		mid = t.Mid()
	}
	codec := track.Codec()
	if e.ev.OnTrack != nil {
		e.ev.OnTrack(TrackEvent{
			Kind:  track.Kind().String(),
			MID:   mid,
			Codec: CodecInfo{MimeType: codec.MimeType, ClockRate: int(codec.ClockRate), Channels: int(codec.Channels)},
			SSRC:  uint32(track.SSRC()),
		})
	}
	go e.readRtp(mid, track)
}

func (e *Engine) readRtp(mid string, track *webrtc.TrackRemote) {
	codec := track.Codec()
	var count uint64
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		count++
		e.mu.Lock()
		e.rtpCounts[mid] = count
		e.mu.Unlock()
		if e.ev.OnAudioFrame != nil {
			payload := make([]byte, len(pkt.Payload))
			copy(payload, pkt.Payload)
			e.ev.OnAudioFrame(AudioFrameEvent{
				MID:     mid,
				Payload: payload,
				Codec:   CodecInfo{MimeType: codec.MimeType, ClockRate: int(codec.ClockRate), Channels: int(codec.Channels)},
			})
		}
	}
}

// RtpCounts returns per-MID packet counters (safe diagnostics).
func (e *Engine) RtpCounts() map[string]uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]uint64, len(e.rtpCounts))
	for mid, count := range e.rtpCounts {
		out[mid] = count
	}
	return out
}

// ArmPublish adds the single outbound Opus TrackLocal. Idempotent; callable
// at voice-grant activation — the fresh publication offer then carries the
// send m-line (the initial bootstrap offer stays receive-only).
func (e *Engine) ArmPublish() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.outbound != nil {
		return nil
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: "audio/opus", ClockRate: 48000, Channels: 2},
		"agent-voice", "free4chat-agent")
	if err != nil {
		return err
	}
	if _, err := e.pc.AddTrack(track); err != nil {
		return err
	}
	e.outbound = track
	return nil
}

// LocalPublishMid returns the negotiated mid of the armed outbound track.
func (e *Engine) LocalPublishMid() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, t := range e.pc.GetTransceivers() {
		if t.Sender() != nil && t.Sender().Track() != nil {
			return t.Mid()
		}
	}
	return ""
}

// ActivatePublish starts accepting PCM after a grant-authorised publish;
// resets carry and the frame pacer so a fresh utterance never inherits a
// stale schedule.
func (e *Engine) ActivatePublish() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.outbound == nil {
		return errPublishNotActive
	}
	if e.encoder == nil {
		enc, err := opus.NewEncoder(opus.WithSampleRate(48000), opus.WithChannels(1))
		if err != nil {
			return err
		}
		e.encoder = enc
	}
	e.publishOn = true
	e.pacer = newFramePacer(e.nowFn, e.sleepFn)
	e.writerMu.Lock()
	if !e.writerRunning {
		stop := make(chan struct{})
		done := make(chan struct{})
		e.writerStop = stop
		e.writerDone = done
		e.writerRunning = true
		go e.writerLoop(stop, done)
	}
	e.writerMu.Unlock()
	return nil
}

// DeactivatePublish discards any buffered frame immediately (revocation or
// turn cancellation must never emit stale audio).
func (e *Engine) DeactivatePublish() {
	e.mu.Lock()
	e.publishOn = false
	e.mu.Unlock()
	e.clearQueueAndCarry()
}

// queueBytesSnapshot exposes the soft byte budget for tests.
func (e *Engine) queueBytesSnapshot() int {
	e.writerMu.Lock()
	defer e.writerMu.Unlock()
	return e.queueBytes
}

// CancelTurn discards buffered partial-frame bytes WITHOUT deactivating
// publication: a cancelled utterance must never leak stale audio into a
// later turn, but the grant stays live.
func (e *Engine) CancelTurn() {
	e.clearQueueAndCarry()
}

// clearQueueAndCarry discards queued PCM and the partial frame so stale
// utterance audio can never leak into a later turn. The byte budget must
// stay consistent: every drained item is subtracted, and once the channel
// is empty the budget resets to zero (a concurrent enqueue after the drain
// re-increments it before its channel send, so the pair stays coherent).
func (e *Engine) clearQueueAndCarry() {
	e.writerMu.Lock()
	e.carry = nil
	e.writerMu.Unlock()
	for {
		select {
		case chunk := <-e.queue:
			e.writerMu.Lock()
			e.queueBytes -= len(chunk)
			e.writerMu.Unlock()
		default:
			e.writerMu.Lock()
			e.queueBytes = 0
			e.writerMu.Unlock()
			return
		}
	}
}

var errPublishNotActive = fmt.Errorf("voice publish is not activated")

// WritePCM accepts arbitrary-size S16LE 24 kHz mono chunks and enqueues
// them for the paced writer goroutine. Blocking backpressure: when the
// bounded queue is full, the call waits until the writer drains — the TTS
// stream flows smoothly at the pacing rate instead of stalling the HTTP
// reader mid-burst (which starved the browser jitter buffer).
func (e *Engine) WritePCM(chunk []byte) error {
	e.mu.Lock()
	active := e.publishOn
	e.mu.Unlock()
	if !active {
		return errPublishNotActive
	}
	e.mu.Lock()
	e.pcmWriteCalls++
	e.pcmInputBytes += uint64(len(chunk))
	e.mu.Unlock()
	if len(chunk) == 0 {
		return nil
	}
	copied := append([]byte(nil), chunk...)
	e.writerMu.Lock()
	e.queueBytes += len(copied)
	space := e.queueBytes <= maxQueuePcmBytes
	e.writerMu.Unlock()
	if !space {
		return errors.New("engine_pcm_queue_full")
	}
	select {
	case e.queue <- copied:
		return nil
	case <-e.writerStop:
		return errPublishNotActive
	}
}

// FlushAudio enqueues a flush marker so the writer zero-pads and emits the
// buffered partial tail frame (normal completion only).
func (e *Engine) FlushAudio() error {
	e.mu.Lock()
	active := e.publishOn
	e.mu.Unlock()
	if !active {
		return errPublishNotActive
	}
	select {
	case e.queue <- nil: // nil = flush marker
		return nil
	case <-e.writerStop:
		return errPublishNotActive
	}
}

func (e *Engine) publishActive() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.publishOn
}

// PCMCarryLen exposes the writer's buffered unframed byte count (tests).
func (e *Engine) PCMCarry() int {
	e.writerMu.Lock()
	defer e.writerMu.Unlock()
	return len(e.carry)
}

// writerLoop is the single paced emitter: it owns framing/carry and writes
// one real Opus packet per 20 ms slot. After any paced wait it re-checks
// publication activation so a concurrent revocation stops the burst instead
// of emitting stale frames.
//
// LIFECYCLE INVARIANT: the loop exits ONLY when its stop channel closes.
// Every data-level error — including errPublishNotActive from a concurrent
// revoke+flush race, and per-frame encode/write failures — degrades the
// affected frame only; the writer stays alive so later grant activations
// keep working (a dead writer plus a one-shot start used to produce
// permanent silence).
func (e *Engine) writerLoop(stop, done chan struct{}) {
	defer func() {
		close(done)
		e.writerMu.Lock()
		if e.writerStop == stop {
			e.writerRunning = false
		}
		e.writerMu.Unlock()
	}()
	writer := func() *opus.Encoder {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.encoder
	}
	track := func() *webrtc.TrackLocalStaticSample {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.outbound
	}
	for {
		select {
		case <-stop:
			return
		case chunk := <-e.queue:
			if chunk == nil {
				// Flush marker: pad and emit the partial tail. A concurrent
				// revocation makes this a discard-only no-op — the loop
				// continues, never exits.
				if err := e.writerEmitCarry(track(), writer()); err != nil {
					_ = err // dropped frame; writer stays alive
				}
				continue
			}
			if err := e.writerWriteChunk(chunk, track(), writer()); err != nil {
				// Not-active or a transient encode/write failure: drop the
				// rest of this chunk and keep serving later grants.
				_ = err
				continue
			}
		}
	}
}

// writerWriteChunk frames one queued PCM chunk at 20 ms cadence. The byte
// budget is decremented for the WHOLE chunk before any frame is emitted, so
// a mid-chunk revocation (frames dropped, carry cleared by the caller)
// never leaves the budget inflated.
func (e *Engine) writerWriteChunk(chunk []byte, track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) error {
	e.writerMu.Lock()
	e.queueBytes -= len(chunk)
	data := append(e.carry, chunk...)
	e.carry = nil
	const frame24kBytes = 960
	frames := len(data) / frame24kBytes
	e.carry = append([]byte(nil), data[frames*frame24kBytes:]...)
	e.writerMu.Unlock()

	for f := 0; f < frames; f++ {
		e.pacer.pace()
		if !e.publishActive() {
			return errPublishNotActive
		}
		frame := data[f*frame24kBytes : (f+1)*frame24kBytes]
		if err := e.writerEmitFrame(frame, track, enc); err != nil {
			return err
		}
	}
	return nil
}

// writerEmitCarry zero-pads the partial tail and emits it in its own slot.
func (e *Engine) writerEmitCarry(track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) error {
	e.writerMu.Lock()
	carry := e.carry
	e.carry = nil
	e.writerMu.Unlock()
	if len(carry) == 0 {
		return nil
	}
	if len(carry)%2 == 1 {
		carry = append(carry, 0)
	}
	e.pacer.pace()
	if !e.publishActive() {
		return errPublishNotActive
	}
	padded := make([]byte, 960)
	copy(padded, carry)
	return e.writerEmitFrame(padded, track, enc)
}

// writerEmitFrame resamples and encodes exactly one 20 ms frame.
func (e *Engine) writerEmitFrame(frame []byte, track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) error {
	if track == nil || enc == nil {
		return errPublishNotActive
	}
	up := Resample24To48(frame)
	out := make([]byte, 2000)
	n, err := enc.Encode(up, out)
	if err != nil {
		return err
	}
	if err := track.WriteSample(media.Sample{Data: out[:n], Duration: frameDuration}); err != nil {
		return err
	}
	e.mu.Lock()
	e.opusFramesWritten++
	e.mu.Unlock()
	return nil
}

// PublishCounts returns application-level PCM/Opus counters and, when Pion
// exposes an audio outbound RTP stats object, its authoritative counters.
// A successful TrackLocal.WriteSample is NOT itself proof a packet left the
// process; the outbound_rtp_* counters are only reported when Pion provides
// them.
func (e *Engine) PublishCounts() map[string]uint64 {
	e.mu.Lock()
	counts := map[string]uint64{
		"pcm_write_calls":     e.pcmWriteCalls,
		"pcm_input_bytes":     e.pcmInputBytes,
		"opus_frames_written": e.opusFramesWritten,
	}
	pc := e.pc
	e.mu.Unlock()
	if pc == nil {
		return counts
	}
	var packets, bytes uint64
	var found bool
	for _, stat := range pc.GetStats() {
		outbound, ok := stat.(webrtc.OutboundRTPStreamStats)
		if !ok || outbound.Kind != "audio" {
			continue
		}
		found = true
		packets += uint64(outbound.PacketsSent)
		bytes += outbound.BytesSent
	}
	if found {
		counts["outbound_rtp_packets"] = packets
		counts["outbound_rtp_bytes"] = bytes
	}
	return counts
}

// Close tears the peer connection down.
func (e *Engine) Close() {
	e.mu.Lock()
	alreadyClosed := e.closed
	e.closed = true
	pc := e.pc
	e.mu.Unlock()
	if alreadyClosed {
		return
	}
	e.writerMu.Lock()
	stop := e.writerStop
	done := e.writerDone
	e.writerMu.Unlock()
	if stop != nil {
		select {
		case <-stop:
		default:
			close(stop)
		}
		if done != nil {
			select {
			case <-done:
			case <-time.After(2 * time.Second):
			}
		}
	}
	if pc != nil {
		_ = pc.Close()
	}
}

// Resample24To48 upsamples S16LE 24 kHz mono to 48 kHz mono by deterministic
// linear interpolation (ported verbatim from the experiment).
func Resample24To48(in []byte) []byte {
	samples := len(in) / 2
	if samples == 0 {
		return nil
	}
	out := make([]byte, samples*2*2)
	for i := 0; i < samples*2; i++ {
		pos := i / 2
		var v int16
		if i%2 == 0 || pos+1 >= samples {
			v = int16(binary.LittleEndian.Uint16(in[pos*2:]))
		} else {
			a := int32(int16(binary.LittleEndian.Uint16(in[pos*2:])))
			b := int32(int16(binary.LittleEndian.Uint16(in[pos*2+2:])))
			v = int16((a + b) / 2)
		}
		binary.LittleEndian.PutUint16(out[i*2:], uint16(v))
	}
	return out
}
