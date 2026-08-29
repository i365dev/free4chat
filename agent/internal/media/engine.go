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

	mu             sync.Mutex
	outbound       *webrtc.TrackLocalStaticSample
	publishOn      bool
	pubGeneration  uint64 // bumped on every activate/deactivate (grant boundary)
	turnGeneration uint64 // bumped on every CancelTurn (utterance boundary)
	// Turn admission is a TRUE MONOTONIC WATERMARK within one publication
	// session: highestAdmitted never decreases; cancelledThrough is the max
	// cancelled token. A token <= cancelledThrough or < highestAdmitted is
	// stale by construction — no bounded set can evict a live guard.
	highestAdmitted   uint64
	cancelledThrough  uint64
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
	queueRing     []queueItem
	writerNotify  chan struct{} // wakeup for the writer (item available)
	writerSpace   chan struct{} // wakeup for producers (space freed)
	queueBytes    int
	carry         []byte
	writerRunning bool
	writerStop    chan struct{}
	writerDone    chan struct{}

	// Safe pacing diagnostics (electric-audio investigation): wall-clock gap
	// count between paced frames (rebaseline events) and encode failures.
	// Never RTP values, SDP, or payload content.
	pacedGapCount uint64
	encodeErrors  uint64
	silenceFills  uint64
	fillRun       uint64 // consecutive fills (bounded)
	turnOpen      bool
	// turnInvalidated closes as soon as the active turn is cancelled or its
	// publication is revoked. A flush marker may already be inside a paced
	// writer sleep at that point, so its waiter must not depend on the writer
	// waking before it can release the host voice gate.
	turnInvalidated chan struct{}
}

// framePacer spaces outbound Opus frames one frame-duration apart (ported
// verbatim from the experiment; clock/sleeper injection keeps tests
// deterministic).
type framePacer struct {
	mu    sync.Mutex
	now   func() time.Time
	sleep func(time.Duration)
	next  time.Time
	onGap func() // rebaseline observer (safe counters only)
}

func newFramePacer(now func() time.Time, sleep func(time.Duration)) *framePacer {
	return &framePacer{now: now, sleep: sleep}
}

// scheduled reports whether the pacer has an active frame schedule
// (mid-stream), used to detect gaps that need silence filling.
func (p *framePacer) scheduled() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.next.IsZero()
}

func (p *framePacer) pace() {
	p.mu.Lock()
	now := p.now()
	hadNext := !p.next.IsZero()
	stale := hadNext && now.Sub(p.next) >= paceResyncAfter
	if !hadNext || stale {
		p.next = now.Add(frameDuration)
		p.mu.Unlock()
		if stale && p.onGap != nil {
			p.onGap()
		}
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
		ev:           events,
		log:          log,
		dcOpen:       make(chan struct{}),
		rtpCounts:    make(map[string]uint64),
		nowFn:        time.Now,
		sleepFn:      time.Sleep,
		writerNotify: make(chan struct{}, 1),
		writerSpace:  make(chan struct{}, 1),
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
	e.pubGeneration++
	e.invalidateTurnLocked()
	e.pacer = newFramePacer(e.nowFn, e.sleepFn)
	e.pacer.onGap = func() {
		e.mu.Lock()
		e.pacedGapCount++
		e.mu.Unlock()
	}
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
	e.pubGeneration++
	e.turnGeneration++
	e.turnOpen = false
	e.highestAdmitted = 0
	e.cancelledThrough = 0
	e.invalidateTurnLocked()
	e.mu.Unlock()
	e.clearQueueAndCarry()
}

// queueItem carries one queued PCM chunk or a flush marker, tagged with the
// publication generation it was written under. A stale generation is
// discarded by the writer — audio from a revoked grant must never survive
// reactivation.
type queueItem struct {
	gen     uint64 // publication generation at enqueue
	turnGen uint64 // turn generation at enqueue (utterance boundary)
	token   uint64 // turn ADMISSION token (speaker turn identity)
	data    []byte // nil = flush marker
	// flushDone is present only for a caller that must wait until the paced
	// writer consumes this marker. It is buffered so cancellation/revocation
	// can unblock the waiter without depending on it being scheduled first.
	flushDone chan error
}

func finishFlush(item queueItem, err error) {
	if item.flushDone == nil {
		return
	}
	select {
	case item.flushDone <- err:
	default:
	}
}

// enqueueItem appends one item under the single queue lock, with BOUNDED
// BLOCKING backpressure: when the ring is at its byte cap, the producer
// waits for the paced writer to free space (real-time throttling) instead
// of rejecting — rejecting truncated long replies mid-sentence in
// production. The byte budget is mutated in the SAME critical section as
// the ring itself, so enqueue / consume / clear can never drift the
// accounting.
func (e *Engine) enqueueItem(item queueItem) error {
	for {
		space, stop := func() (chan struct{}, chan struct{}) {
			e.writerMu.Lock()
			defer e.writerMu.Unlock()
			if item.data == nil || e.queueBytes+len(item.data) <= maxQueuePcmBytes {
				if item.data != nil {
					e.queueBytes += len(item.data)
				}
				e.queueRing = append(e.queueRing, item)
				select {
				case e.writerNotify <- struct{}{}:
				default:
				}
				return nil, nil
			}
			return e.writerSpace, e.writerStop
		}()
		if space == nil {
			return nil // enqueued
		}
		select {
		case <-space:
			if item.turnGen != e.currentTurnGeneration() ||
				(item.token != 0 && item.token != e.currentAdmittedTurn()) {
				// A cancelled turn's blocked write woke after the queue was
				// cleared: its PCM is stale and must never be enqueued.
				return nil
			}
			continue
		case <-stop:
			return errPublishNotActive
		}
	}
}

// popItem removes the front item, decrementing its reservation exactly once.
func (e *Engine) popItem() (queueItem, bool) {
	e.writerMu.Lock()
	defer e.writerMu.Unlock()
	if len(e.queueRing) == 0 {
		return queueItem{}, false
	}
	item := e.queueRing[0]
	e.queueRing = e.queueRing[1:]
	if item.data != nil {
		e.queueBytes -= len(item.data)
	}
	select {
	case e.writerSpace <- struct{}{}:
	default:
	}
	return item, true
}

// generationLocked snapshots the current publication generation.
func (e *Engine) generationLocked() uint64 {
	return e.pubGeneration
}

// currentGeneration reads the generation under lock.
func (e *Engine) currentGeneration() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pubGeneration
}

// currentTurnGeneration reads the utterance-boundary generation.
func (e *Engine) currentTurnGeneration() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.turnGeneration
}

// currentAdmittedTurn reads the admitted turn token.
func (e *Engine) currentAdmittedTurn() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.highestAdmitted
}

// admitTurn validates one write against the turn-admission state. Returns
// false when the token belongs to a cancelled turn (stale PCM must not be
// admitted); a NEW token admits a fresh turn; the same token continues it.
func (e *Engine) admitTurn(token uint64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if token == 0 {
		return true // token-less callers (pre-token tests) keep legacy semantics
	}
	if token <= e.cancelledThrough {
		return false // this exact turn was cancelled (or an older one)
	}
	if token < e.highestAdmitted {
		return false // monotonic: below the watermark is always stale
	}
	if token > e.highestAdmitted {
		// A genuinely NEW turn: advance the watermark and open the window.
		e.highestAdmitted = token
		e.turnOpen = true
	}
	return true
}

// validateTurn is the non-mutating admission check for the bridge boundary:
// buffering decisions must reject stale tokens without admitting anything.
func (e *Engine) ValidateTurn(token uint64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if token == 0 {
		return true
	}
	if token <= e.cancelledThrough {
		return false
	}
	if token < e.highestAdmitted {
		return false
	}
	return true
}

// silenceFillCount exposes the gap-fill counter for tests.
func (e *Engine) silenceFillCount() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.silenceFills
}

// queueRingSnapshot exposes the pending item count for tests.
func (e *Engine) queueRingSnapshot() []queueItem {
	e.writerMu.Lock()
	defer e.writerMu.Unlock()
	return append([]queueItem(nil), e.queueRing...)
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
func (e *Engine) CancelTurn(token uint64) {
	// Utterance boundary. The watermark advances monotonically regardless.
	e.mu.Lock()
	if token != 0 && token > e.cancelledThrough {
		e.cancelledThrough = token
	}
	// A STALE LATE CANCEL (an older token arriving after a newer turn was
	// admitted) must NOT destroy the newer turn: it records the watermark
	// only — no generation bump, no window close, no queue/carry clear.
	// Cancelling the currently admitted turn (or a not-yet-admitted current
	// token) remains destructive.
	staleLate := token != 0 && e.highestAdmitted != 0 && token < e.highestAdmitted
	if staleLate {
		e.mu.Unlock()
		return
	}
	e.turnGeneration++
	e.turnOpen = false
	e.invalidateTurnLocked()
	e.mu.Unlock()
	e.clearQueueAndCarry()
}

// invalidateTurnLocked releases final-flush waiters immediately. Caller
// holds e.mu. The next accepted turn uses a fresh channel so a past cancel
// can never poison a later utterance.
func (e *Engine) invalidateTurnLocked() {
	if e.turnInvalidated != nil {
		close(e.turnInvalidated)
	}
	e.turnInvalidated = make(chan struct{})
}

// clearQueueAndCarry discards queued PCM and the partial frame so stale
// utterance audio can never leak into a later turn. The byte budget must
// stay consistent: every drained item is subtracted, and once the channel
// is empty the budget resets to zero (a concurrent enqueue after the drain
// re-increments it before its channel send, so the pair stays coherent).
func (e *Engine) clearQueueAndCarry() {
	// Single critical section: the carry, the ring, and the byte budget are
	// mutated together. queueBytes ends at exactly the sum of the drained
	// reservations subtracted from the previous total — arithmetically zero.
	e.writerMu.Lock()
	flushes := make([]queueItem, 0)
	e.carry = nil
	for _, item := range e.queueRing {
		if item.data != nil {
			e.queueBytes -= len(item.data)
		}
		if item.flushDone != nil {
			flushes = append(flushes, item)
		}
	}
	e.queueRing = nil
	e.writerMu.Unlock()
	for _, item := range flushes {
		finishFlush(item, errPublishNotActive)
	}
	select {
	case e.writerSpace <- struct{}{}:
	default:
	}
}

var errPublishNotActive = fmt.Errorf("voice publish is not activated")

// WritePCM accepts arbitrary-size S16LE 24 kHz mono chunks and enqueues
// them for the paced writer goroutine. Blocking backpressure: when the
// bounded queue is full, the call waits until the writer drains — the TTS
// stream flows smoothly at the pacing rate instead of stalling the HTTP
// reader mid-burst (which starved the browser jitter buffer).
func (e *Engine) WritePCM(chunk []byte, token uint64) error {
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
	if !e.admitTurn(token) {
		// A cancelled turn's late PCM must never be admitted — the
		// Speaker->Engine boundary race where an old TTS callback survives
		// its own cancel lands here.
		return errPublishNotActive
	}
	copied := append([]byte(nil), chunk...)
	e.mu.Lock()
	gen := e.pubGeneration
	turnGen := e.turnGeneration
	e.turnOpen = true
	e.mu.Unlock()
	e.writerMu.Lock()
	hasStop := e.writerStop != nil
	e.writerMu.Unlock()
	if !hasStop {
		return errPublishNotActive
	}
	return e.enqueueItem(queueItem{gen: gen, turnGen: turnGen, token: token, data: copied})
}

// FlushAudio enqueues a flush marker so the writer zero-pads and emits the
// buffered partial tail frame (normal completion only).
func (e *Engine) FlushAudio(token uint64) error {
	e.mu.Lock()
	active := e.publishOn
	e.mu.Unlock()
	if !active {
		return errPublishNotActive
	}
	e.mu.Lock()
	gen := e.pubGeneration
	turnGen := e.turnGeneration
	e.mu.Unlock()
	return e.enqueueItem(queueItem{gen: gen, turnGen: turnGen, token: token}) // data nil = flush marker
}

// FlushAudioAndWait enqueues the normal-completion marker then waits until
// the paced writer has consumed every preceding PCM item and processed that
// marker. This is the completion boundary for a host-local voice gate: the
// next Agent must not start publishing while this Agent's queued PCM is still
// audible. Revocation, cancellation, and Close all unblock this wait with a
// fail-closed error.
func (e *Engine) FlushAudioAndWait(token uint64) error {
	e.mu.Lock()
	active := e.publishOn
	gen := e.pubGeneration
	turnGen := e.turnGeneration
	invalidated := e.turnInvalidated
	e.mu.Unlock()
	if !active {
		return errPublishNotActive
	}
	ack := make(chan error, 1)
	if err := e.enqueueItem(queueItem{
		gen: gen, turnGen: turnGen, token: token, flushDone: ack,
	}); err != nil {
		return err
	}
	e.writerMu.Lock()
	stop := e.writerStop
	e.writerMu.Unlock()
	if stop == nil {
		return errPublishNotActive
	}
	select {
	case err := <-ack:
		return err
	case <-invalidated:
		return errPublishNotActive
	case <-stop:
		return errPublishNotActive
	}
}

func (e *Engine) publishActive() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.publishOn
}

// currentPacer snapshots the publication's pacing state under the same lock
// that replaces it on reactivation. The writer deliberately runs the copied
// pacer outside that lock: a concurrent revoke/restart may make its frame
// stale, and the post-pace generation checks below will then discard it.
func (e *Engine) currentPacer() *framePacer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pacer
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
		item, ok := e.popItem()
		if !ok {
			// Mid-turn gap fill: a stalled TTS stream would leave a hole in
			// the RTP timeline that the browser conceals with PLC (the
			// "crackle" artifact). A synthetic silence frame keeps the
			// cadence; never user speech; stops at the flush boundary.
			if e.fillSilenceIfMidTurn(track(), writer()) {
				continue
			}
			select {
			case <-stop:
				return
			case <-e.writerNotify:
				continue
			}
		}
		{
			if item.gen != e.currentGeneration() ||
				item.turnGen != e.currentTurnGeneration() ||
				(item.token != 0 && item.token != e.currentAdmittedTurn()) {
				// Stale grant, stale utterance, or cancelled-turn PCM:
				// discard entirely (popItem released the reservation).
				finishFlush(item, errPublishNotActive)
				continue
			}
			if item.data != nil {
				// Real audio resets the bounded fill window.
				e.mu.Lock()
				e.fillRun = 0
				e.mu.Unlock()
			}
			if item.data == nil {
				// Flush marker: pad and emit the partial tail. A concurrent
				// revocation makes this a discard-only no-op — the loop
				// continues, never exits.
				err := e.writerEmitCarry(
					item.gen,
					item.turnGen,
					item.token,
					track(),
					writer(),
				)
				e.mu.Lock()
				e.turnOpen = false
				e.mu.Unlock()
				finishFlush(item, err)
				continue
			}
			if err := e.writerWriteChunk(item.gen, item.turnGen, item.token, item.data, track(), writer()); err != nil {
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
func (e *Engine) writerWriteChunk(gen, turnGen, token uint64, chunk []byte, track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) error {
	e.writerMu.Lock()
	data := append(e.carry, chunk...)
	e.carry = nil
	const frame24kBytes = 960
	frames := len(data) / frame24kBytes
	e.carry = append([]byte(nil), data[frames*frame24kBytes:]...)
	e.writerMu.Unlock()

	for f := 0; f < frames; f++ {
		pacer := e.currentPacer()
		if pacer == nil {
			return errPublishNotActive
		}
		pacer.pace()
		// The activation flag, the PUBLICATION generation AND the TURN
		// generation must all still match: a cancel or revoke landing
		// between paced waits discards the stale burst before any frame
		// goes out.
		if !e.publishActive() || e.currentGeneration() != gen ||
			e.currentTurnGeneration() != turnGen ||
			(token != 0 && token != e.currentAdmittedTurn()) {
			return errPublishNotActive
		}
		frame := data[f*frame24kBytes : (f+1)*frame24kBytes]
		if err := e.writerEmitFrame(frame, track, enc); err != nil {
			e.mu.Lock()
			e.encodeErrors++
			e.mu.Unlock()
			return err
		}
	}
	return nil
}

// writerEmitCarry zero-pads the partial tail and emits it in its own slot.
// It carries the item generations through the paced wait: a revoke followed
// by a new publication can otherwise make publishActive true again before the
// old tail wakes, which would leak prior-turn PCM into the new grant.
func (e *Engine) writerEmitCarry(gen, turnGen, token uint64, track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) error {
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
	pacer := e.currentPacer()
	if pacer == nil {
		return errPublishNotActive
	}
	pacer.pace()
	// Re-validate after the paced wait: a cancel landing DURING the wait
	// must discard the pending tail before any sample goes out.
	if !e.publishActive() ||
		e.currentGeneration() != gen ||
		e.currentTurnGeneration() != turnGen ||
		(token != 0 && !e.ValidateTurn(token)) {
		return errPublishNotActive
	}
	padded := make([]byte, 960)
	copy(padded, carry)
	return e.writerEmitFrame(padded, track, enc)
}

// maxConsecutiveSilenceFills bounds a mid-turn fill run to ~1 s: real
// network stalls stay covered without ever streaming unbounded silence.
const maxConsecutiveSilenceFills = 50

// fillSilenceIfMidTurn emits one paced synthetic silence frame when the
// ring drained mid-utterance (turnOpen + active pacer schedule).
func (e *Engine) fillSilenceIfMidTurn(track *webrtc.TrackLocalStaticSample, enc *opus.Encoder) bool {
	e.mu.Lock()
	if e.fillRun >= maxConsecutiveSilenceFills {
		e.mu.Unlock()
		return false
	}
	open := e.turnOpen && e.publishOn
	e.mu.Unlock()
	pacer := e.currentPacer()
	if !open || pacer == nil || !pacer.scheduled() {
		return false
	}
	pacer.pace()
	// Re-check after the paced wait: a cancel during the wait must stop the
	// fill before any silence frame is emitted.
	e.mu.Lock()
	stillOpen := e.turnOpen && e.publishOn
	e.mu.Unlock()
	if !stillOpen {
		return false
	}
	frame := make([]byte, 960) // 20 ms of silence @24k mono
	if err := e.writerEmitFrame(frame, track, enc); err != nil {
		return false
	}
	e.mu.Lock()
	e.silenceFills++
	e.fillRun++
	e.mu.Unlock()
	return true
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
		"paced_gap_count":     e.pacedGapCount,
		"encode_errors":       e.encodeErrors,
		"silence_fills":       e.silenceFills,
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
