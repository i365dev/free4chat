package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	stunURL           = "stun:stun.cloudflare.com:3478"
	gatherTimeout     = 20 * time.Second
	connectTimeout    = 30 * time.Second
	answerGatherGrace = 2 * time.Second
	onTrackTimeout    = 15 * time.Second
)

// MediaSpike owns the single Pion PeerConnection under test. It is a pure
// media engine: SDP in/out via the stdio protocol, zero HTTP, zero secrets.
type MediaSpike struct {
	pc         *webrtc.PeerConnection
	tracer     *Tracer
	emitEvent  func(map[string]any)
	dcOpen     chan struct{}
	dcState    string
	expectedMid string

	mu          sync.Mutex
	onTrackInfo map[string]any
	rtpCounts   map[string]uint64
}

func NewMediaSpike(tracer *Tracer, emitEvent func(map[string]any)) (*MediaSpike, error) {
	s := &MediaSpike{
		tracer:    tracer,
		emitEvent: emitEvent,
		dcOpen:     make(chan struct{}),
		rtpCounts:  make(map[string]uint64),
	}
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
//           SetLocalDescription; applied="offer" + local answer SDP returned
//           for Node to submit via PUT /api/sfu/renegotiate.
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
				"event":   "rtp",
				"mid":     mid,
				"seq":     pkt.SequenceNumber,
				"ts":      pkt.Timestamp,
				"pt":      int(pkt.PayloadType),
				"ssrc":    uint32(track.SSRC()),
				"marker":  pkt.Marker,
				"payload": base64.StdEncoding.EncodeToString(pkt.Payload),
				"mime":    codec.MimeType,
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
}
