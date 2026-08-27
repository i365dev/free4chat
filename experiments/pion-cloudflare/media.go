package main

import (
	"encoding/base64"
	"encoding/json"
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
	onTrackTimeout    = 15 * time.Second

	// Outbound voice pacing (#83 review): Opus frames are 20 ms apart on the
	// wire; the writer must emit them at wall-clock pace instead of bursting
	// whatever PCM arrived in one chunk. After a stall longer than
	// paceResyncAfter the schedule rebaselines rather than bursting to catch
	// up.
	frameDuration   = 20 * time.Millisecond
	paceResyncAfter = 250 * time.Millisecond
)

// MediaSpike owns the single Pion PeerConnection under test. It is a pure
// media engine: SDP in/out via the stdio protocol, zero HTTP, zero secrets.
type MediaSpike struct {
	pc          *webrtc.PeerConnection
	tracer      *Tracer
	emitEvent   func(map[string]any)
	dcOpen      chan struct{}
	dcState     string
	expectedMid string

	mu          sync.Mutex
	onTrackInfo map[string]any
	rtpCounts   map[string]uint64
	offered     bool
	outbound    *webrtc.TrackLocalStaticSample
	publishOn   bool
	encoder     *opus.Encoder
	pcmCarry    []byte
	// Outbound wall-clock pacing (#83 review): injectable for deterministic
	// tests; production uses time.Now/time.Sleep.
	nowFn   func() time.Time
	sleepFn func(time.Duration)
	pacer   *framePacer
}

// framePacer spaces outbound Opus frames one frame-duration apart in
// wall-clock time so an arbitrarily fast PCM burst streams at speaking pace.
// The first frame of a schedule goes out immediately; later frames wait for
// their slot; a stall longer than paceResyncAfter rebaselines instead of
// bursting catch-up frames. Clock/sleeper injection keeps tests deterministic.
type framePacer struct {
	mu    sync.Mutex
	now   func() time.Time
	sleep func(time.Duration)
	next  time.Time // zero until the first paced frame
}

func newFramePacer(
	now func() time.Time,
	sleep func(time.Duration),
) *framePacer {
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

func NewMediaSpike(tracer *Tracer, emitEvent func(map[string]any)) (*MediaSpike, error) {
	s := &MediaSpike{
		tracer:    tracer,
		emitEvent: emitEvent,
		dcOpen:    make(chan struct{}),
		rtpCounts: make(map[string]uint64),
		nowFn:     time.Now,
		sleepFn:   time.Sleep,
	}
	s.pacer = newFramePacer(s.nowFn, s.sleepFn)
	return s, nil
}

// Create builds the PeerConnection with Cloudflare-aligned defaults and
// wires every state callback into both the dump journal and stdout events.
func (s *MediaSpike) Create() error {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{stunURL}}},
	})
	if err != nil {
		return err
	}
	s.pc = pc
	// Meeting Notes bootstrap is receive-only: the initial offer must NOT
	// carry an outbound voice m-line, so Create() leaves the publish track
	// unarmed. ArmPublish() is called explicitly (arm-publish op) right
	// before the voice offer (#83 shared session); no RTP flows until an
	// authorised activation.

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			s.tracer.Event(map[string]any{"event": "ice_gathering_complete"})
			return
		}
		s.tracer.AppendJSONL("ice-candidates.jsonl", map[string]any{
			"candidate": c.ToJSON().Candidate,
			"sdpMid":    c.SDPMid,
			"sdpMLine":  c.SDPMLineIndex,
		})
	})

	pc.OnICEGatheringStateChange(func(state webrtc.ICEGatheringState) {
		s.tracer.Event(map[string]any{"event": "ice_gathering_state", "state": state.String()})
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		s.tracer.Event(map[string]any{"event": "ice_connection_state", "state": state.String()})
		fmt.Fprintf(osStderr, "      ice=%s\n", state.String())
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		s.tracer.Event(map[string]any{"event": "peerconnection_state", "state": state.String()})
		fmt.Fprintf(osStderr, "      pc=%s\n", state.String())
	})

	s.pc.OnTrack(s.handleIncomingTrack)

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		s.tracer.Info("remote datachannel opened label=%q", dc.Label())
		dc.OnOpen(func() {
			s.mu.Lock()
			s.dcState = "open"
			s.mu.Unlock()
			select {
			case <-s.dcOpen:
			default:
				close(s.dcOpen)
			}
		})
		dc.OnClose(func() {
			s.mu.Lock()
			s.dcState = "closed"
			s.mu.Unlock()
		})
	})
	return nil
}

// CreateServerEventsChannel creates the server-events DataChannel BEFORE any
// offer exists (#100 brief A; #101 §3).
func (s *MediaSpike) CreateServerEventsChannel() error {
	dc, err := s.pc.CreateDataChannel("server-events", nil)
	if err != nil {
		return fmt.Errorf("create server-events datachannel: %w", err)
	}
	dc.OnOpen(func() {
		s.mu.Lock()
		s.dcState = "open"
		s.mu.Unlock()
		select {
		case <-s.dcOpen:
		default:
			close(s.dcOpen)
		}
	})
	dc.OnClose(func() {
		s.mu.Lock()
		s.dcState = "closed"
		s.mu.Unlock()
	})
	s.tracer.Info("server-events datachannel created before offer")
	return nil
}

// GatherCompleteOffer runs stage B: offer -> SetLocalDescription -> wait for
// full ICE gathering so the emitted offer embeds every candidate.
func (s *MediaSpike) GatherCompleteOffer() (*sdpLike, error) {
	offer, err := s.pc.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("createOffer: %w", err)
	}
	gathered := make(chan struct{})
	var once sync.Once
	s.pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			once.Do(func() { close(gathered) })
		}
	})
	if err := s.pc.SetLocalDescription(offer); err != nil {
		return nil, fmt.Errorf("setLocalDescription(offer): %w", err)
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		return nil, fmt.Errorf("ice gathering timed out after %s", gatherTimeout)
	}
	ld := s.pc.LocalDescription()
	if ld == nil {
		return nil, fmt.Errorf("localDescription nil after gathering")
	}
	p := s.tracer.Dump("initial-local-offer.sdp", []byte(ld.SDP))
	s.tracer.Info("initial offer gathered (%d bytes) dumped to %s", len(ld.SDP), p)
	return &sdpLike{Type: ld.Type.String(), SDP: ld.SDP}, nil
}

// ApplyRemote follows the ACTUAL type of the received description instead of
// hard-coding direction (#101 §4).
//
// answer -> SetRemoteDescription; applied="answer", no answer returned.
// offer  -> SetRemoteDescription (assert have-remote-offer), CreateAnswer,
//
//	SetLocalDescription; applied="offer" + local answer SDP returned
//	for Node to submit via PUT /api/sfu/renegotiate.
func (s *MediaSpike) ApplyRemote(remote sdpLike, dumpBase string) (applied string, answer *sdpLike, err error) {
	if remote.SDP == "" || remote.Type == "" {
		return "", nil, fmt.Errorf("empty remote session description")
	}
	s.tracer.Dump(dumpBase+"-remote.sdp", []byte(remote.SDP))
	switch remote.Type {
	case "answer":
		if ss := s.pc.SignalingState(); ss != webrtc.SignalingStateHaveLocalOffer && ss != webrtc.SignalingStateStable {
			return "", nil, fmt.Errorf("unexpected signaling state %s for remote answer", ss)
		}
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: remote.SDP}); err != nil {
			return "", nil, fmt.Errorf("setRemoteDescription(answer): %w", err)
		}
		s.tracer.Info("remote ANSWER applied; signaling=%s", s.pc.SignalingState())
		return "answer", nil, nil

	case "offer":
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: remote.SDP}); err != nil {
			return "", nil, fmt.Errorf("setRemoteDescription(offer): %w", err)
		}
		if got := s.pc.SignalingState(); got != webrtc.SignalingStateHaveRemoteOffer {
			return "", nil, fmt.Errorf("signaling state after remote offer = %s, want have-remote-offer", got)
		}
		s.tracer.Info("remote OFFER applied; signaling=have-remote-offer")
		for i, t := range s.pc.GetTransceivers() {
			var hasRecv, hasSend bool
			if t.Receiver() != nil {
				hasRecv = true
			}
			if t.Sender() != nil {
				hasSend = true
			}
			fmt.Fprintf(osStderr, "      transceiver[%d] mid=%q kind=%s direction=%s recv=%v send=%v\n", i, t.Mid(), t.Kind(), t.Direction(), hasRecv, hasSend)
		}
		ans, err := s.pc.CreateAnswer(nil)
		if err != nil {
			return "", nil, fmt.Errorf("createAnswer: %w", err)
		}
		if err := s.pc.SetLocalDescription(ans); err != nil {
			return "", nil, fmt.Errorf("setLocalDescription(answer): %w", err)
		}
		waitAnswerGather(s.pc)
		if got := s.pc.SignalingState(); got != webrtc.SignalingStateStable {
			return "", nil, fmt.Errorf("signaling state after local answer = %s, want stable", got)
		}
		ld := s.pc.LocalDescription()
		s.tracer.Dump(dumpBase+"-local-answer.sdp", []byte(ld.SDP))
		return "offer", &sdpLike{Type: "answer", SDP: ld.SDP}, nil

	default:
		return "", nil, fmt.Errorf("unexpected remote description type %q", remote.Type)
	}
}

// waitAnswerGather gives answers a short best-effort gathering window.
// Renegotiations reuse the established transport so candidate-free answers
// are accepted (the official example submits immediately); never blocks long.
func waitAnswerGather(pc *webrtc.PeerConnection) {
	deadline := time.Now().Add(answerGatherGrace)
	for time.Now().Before(deadline) {
		if pc.ICEGatheringState() == webrtc.ICEGatheringStateComplete {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// WaitConnected blocks until PeerConnectionStateConnected (stage E), then
// records the nominated ICE candidate pair.
func (s *MediaSpike) WaitConnected(timeout time.Duration) error {
	deadline := time.After(timeout)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		if s.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			s.dumpSelectedPair()
			return nil
		}
		select {
		case <-deadline:
			return fmt.Errorf("peer connection did not reach connected within %s (state=%s ice=%s)",
				timeout, s.pc.ConnectionState(), s.pc.ICEConnectionState())
		case <-tick.C:
		}
	}
}

func (s *MediaSpike) dumpSelectedPair() {
	report := s.pc.GetStats()
	var pair map[string]any
	var localID, remoteID string
	for _, stat := range report {
		if ps, ok := stat.(webrtc.ICECandidatePairStats); ok {
			if ps.State == webrtc.StatsICECandidatePairStateSucceeded && ps.Nominated {
				localID = ps.LocalCandidateID
				remoteID = ps.RemoteCandidateID
				pair = map[string]any{"localCandidateId": localID, "remoteCandidateId": remoteID}
			}
		}
	}
	for _, stat := range report {
		if cs, ok := stat.(webrtc.ICECandidateStats); ok {
			if cs.ID == localID || cs.ID == remoteID {
				key := "local"
				if cs.ID == remoteID {
					key = "remote"
				}
				pair[key] = map[string]any{
					"candidateType": cs.CandidateType.String(),
					"protocol":      cs.Protocol,
					"address":       cs.IP,
					"port":          cs.Port,
				}
			}
		}
	}
	if pair != nil {
		s.tracer.DumpJSON("selected-candidate-pair", pair)
		s.tracer.Info("selected pair recorded")
	}
}

// handleIncomingTrack announces every remote track via an ontrack stdout
// event and immediately streams its RTP frames as ev:rtp events (multi-MID
// capable — one goroutine per mid).
func (s *MediaSpike) handleIncomingTrack(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	mid := ""
	if t := receiver.RTPTransceiver(); t != nil {
		mid = t.Mid()
	}
	codec := track.Codec()
	info := map[string]any{
		"kind":        track.Kind().String(),
		"mime":        codec.MimeType,
		"clockRate":   int(codec.ClockRate),
		"channels":    int(codec.Channels),
		"payloadType": int(codec.PayloadType),
		"ssrc":        uint32(track.SSRC()),
		"mid":         mid,
	}
	b, _ := json.Marshal(info)
	fmt.Fprintf(osStderr, "      ontrack %s\n", b)
	s.tracer.Event(map[string]any{"event": "ontrack", "track": info})
	if s.emitEvent != nil {
		s.emitEvent(map[string]any{"event": "ontrack", "track": info})
	}
	s.mu.Lock()
	s.onTrackInfo = info
	s.mu.Unlock()
	go s.forwardRtp(mid, track)
}

// OnTrackArm records an expected-MID hint (diagnostics only; all incoming
// tracks are forwarded regardless).
func (s *MediaSpike) OnTrackArm(expectedMid string) {
	s.mu.Lock()
	s.expectedMid = expectedMid
	s.mu.Unlock()
}

// forwardRTP streams every received packet for one remote track as a
// base64-payload ev:rtp stdout event until the track errors or closes.
func (s *MediaSpike) forwardRtp(mid string, track *webrtc.TrackRemote) {
	codec := track.Codec()
	var count, bytes uint64
	headerDumped := 0
	opusFile := newAppendFile(s.tracer.dir, "audio-mid"+mid+".opus")
	defer opusFile.close()
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			s.tracer.Event(map[string]any{"event": "rtp_track_ended", "mid": mid, "afterPackets": count, "error": err.Error()})
			fmt.Fprintf(osStderr, "      rtp mid=%s ended after %d packets: %v\n", mid, count, err)
			return
		}
		count++
		size := pkt.MarshalSize()
		bytes += uint64(size)
		s.mu.Lock()
		s.rtpCounts[mid] = count
		s.mu.Unlock()
		if headerDumped < 100 {
			s.tracer.AppendJSONL("rtp-headers-mid"+mid+".jsonl", map[string]any{
				"n":          count,
				"seq":        pkt.SequenceNumber,
				"ts":         pkt.Timestamp,
				"pt":         pkt.PayloadType,
				"ssrc":       pkt.SSRC,
				"size":       size,
				"payloadLen": len(pkt.Payload),
				"marker":     pkt.Marker,
			})
			headerDumped++
			opusFile.append(pkt.Payload)
		}
		if s.emitEvent != nil {
			s.emitEvent(map[string]any{
				"event":     "rtp",
				"mid":       mid,
				"seq":       pkt.SequenceNumber,
				"ts":        pkt.Timestamp,
				"pt":        int(pkt.PayloadType),
				"ssrc":      uint32(track.SSRC()),
				"marker":    pkt.Marker,
				"payload":   base64.StdEncoding.EncodeToString(pkt.Payload),
				"mime":      codec.MimeType,
				"clockRate": int(codec.ClockRate),
				"channels":  int(codec.Channels),
			})
		}
	}
}

func (s *MediaSpike) currentExpectedMid() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.expectedMid
}

// RtpCounts returns per-MID forwarded packet counters (rtp-stats op).
func (s *MediaSpike) RtpCounts() map[string]uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]uint64, len(s.rtpCounts))
	for mid, c := range s.rtpCounts {
		out[mid] = c
	}
	return out
}

// TrackInfo returns captured OnTrack metadata (nil if none matched yet).
func (s *MediaSpike) TrackInfo() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{}
	for k, v := range s.onTrackInfo {
		out[k] = v
	}
	return out
}

// DCOpened reports whether the server-events channel reached open.
func (s *MediaSpike) DCOpened() bool {
	select {
	case <-s.dcOpen:
		return true
	default:
		return false
	}
}

// Close tears the peer connection down.
func (s *MediaSpike) Close() {
	if s.pc != nil {
		_ = s.pc.Close()
	}
}                            // ---------- #83 outbound voice publication ----------
const opusFrameSamples = 960 // 20 ms @ 48 kHz mono
var errAlreadyOffered = fmt.Errorf("publish arming is only allowed before the first offer")
var errPublishNotActive = fmt.Errorf("voice publish is not activated")

func (s *MediaSpike) markOffered() {
	s.mu.Lock()
	s.offered = true
	s.mu.Unlock()
}

// ArmPublish adds the single outbound Opus TrackLocal before the first offer
// so every agent media session carries one send m-line (#83 shared session).
func (s *MediaSpike) ArmPublish() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outbound != nil {
		return nil
	}
	if s.offered {
		return errAlreadyOffered
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: "audio/opus", ClockRate: 48000, Channels: 2},
		"agent-voice", "free4chat-agent")
	if err != nil {
		return err
	}
	if _, err := s.pc.AddTrack(track); err != nil {
		return err
	}
	s.outbound = track
	return nil
}

func (s *MediaSpike) LocalPublishMid() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.pc.GetTransceivers() {
		if t.Sender() != nil && t.Sender().Track() != nil {
			return t.Mid()
		}
	}
	return ""
}

// ActivatePublish starts accepting PCM after a grant-authorised publish;
// DeactivatePublish discards any buffered frame immediately (revocation /
// turn cancellation must never emit stale audio). Activation also restarts
// the frame pacer so a fresh utterance never inherits a stale schedule.
func (s *MediaSpike) ActivatePublish() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outbound == nil {
		return errPublishNotActive
	}
	if s.encoder == nil {
		enc, err := opus.NewEncoder(opus.WithSampleRate(48000), opus.WithChannels(1))
		if err != nil {
			return err
		}
		s.encoder = enc
	}
	s.publishOn = true
	s.pcmCarry = nil
	s.pacer = newFramePacer(s.nowFn, s.sleepFn)
	return nil
}

func (s *MediaSpike) DeactivatePublish() {
	s.mu.Lock()
	s.publishOn = false
	s.pcmCarry = nil
	s.mu.Unlock()
}

// CancelTurn discards buffered partial-frame bytes WITHOUT deactivating
// publication: a cancelled utterance must never leak stale audio into a
// later turn, but the grant stays live and later turns keep flowing.
// (DeactivatePublish remains the full cooperative-revocation path.)
func (s *MediaSpike) CancelTurn() {
	s.mu.Lock()
	s.pcmCarry = nil
	s.mu.Unlock()
}

// WritePCM accepts arbitrary-size S16LE 24 kHz mono chunks (odd trailing
// bytes are carried), frames at 20 ms (960 B), resamples x2 to 48 kHz mono
// and writes one real Opus packet per frame at wall-clock pace (#83 review
// blocker 3): the first frame goes out immediately, later frames are spaced
// one frame-duration apart via the injectable pacer.
func (s *MediaSpike) WritePCM(chunk []byte) error {
	s.mu.Lock()
	track, enc := s.outbound, s.encoder
	pacer := s.pacer
	active := s.publishOn
	s.mu.Unlock()
	if !active || track == nil || enc == nil {
		return errPublishNotActive
	}
	data := append(s.takeCarry(), chunk...)
	const frame24kBytes = 960
	frames := len(data) / frame24kBytes
	s.setCarry(data[frames*frame24kBytes:])
	for f := 0; f < frames; f++ {
		pacer.pace()
		// Re-check after any paced wait: a concurrent DeactivatePublish
		// must stop the burst instead of emitting stale frames.
		if !s.publishActive() {
			return errPublishNotActive
		}
		frame := data[f*frame24kBytes : (f+1)*frame24kBytes]
		up := Resample24To48(frame)
		out := make([]byte, 2000)
		n, err := enc.Encode(up, out)
		if err != nil {
			return err
		}
		if err := track.WriteSample(media.Sample{Data: out[:n], Duration: frameDuration}); err != nil {
			return err
		}
	}
	return nil
}

// FlushAudio zero-pads a final partial frame (normal completion only) and
// emits it in its own paced slot so the utterance tail keeps RTP cadence.
func (s *MediaSpike) FlushAudio() error {
	carry := s.takeCarryAll()
	if len(carry) == 0 {
		return nil
	}
	if len(carry)%2 == 1 {
		carry = append(carry, 0)
	}
	s.pacer.pace()
	if !s.publishActive() {
		return errPublishNotActive
	}
	padded := make([]byte, 960)
	copy(padded, carry)
	up := Resample24To48(padded)
	out := make([]byte, 2000)
	n, err := s.encodeWith(up, out)
	if err != nil {
		return err
	}
	return s.writeSample(out[:n])
}

func (s *MediaSpike) publishActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishOn
}

func (s *MediaSpike) takeCarry() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.pcmCarry
	s.pcmCarry = nil
	return c
}
func (s *MediaSpike) takeCarryAll() []byte { return s.takeCarry() }

// PCMCarry exposes buffered unframed bytes for tests.
func (s *MediaSpike) PCMCarry() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.pcmCarry...)
}
func (s *MediaSpike) setCarry(c []byte) { s.mu.Lock(); s.pcmCarry = c; s.mu.Unlock() }
func (s *MediaSpike) encodeWith(in, out []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.encoder.Encode(in, out)
}
func (s *MediaSpike) writeSample(b []byte) error {
	s.mu.Lock()
	t := s.outbound
	active := s.publishOn
	s.mu.Unlock()
	if !active || t == nil {
		return errPublishNotActive
	}
	return t.WriteSample(media.Sample{Data: b, Duration: 20 * time.Millisecond})
}
