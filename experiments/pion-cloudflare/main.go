package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// pion-cloudflare is the MEDIA ENGINE half of the issue #100 Phase 1 spike.
// It is a pure child process: it speaks line-delimited JSON on stdin/stdout,
// owns ONLY the Pion PeerConnection (SDP create/apply, OnTrack, ReadRTP),
// and performs zero HTTP and holds zero credentials — Node owns all
// Free4Chat communication, exactly like the Phase 2 boundary (#100 §14).
//
// stdout protocol:
//
//	{"id":N,"ok":true,...}      command responses
//	{"ev":...}                  async events (pc-state / ice-state / ontrack)
//
// Human-readable diagnostics + full SDP dumps go to stderr and -dump-dir.

type cmd struct {
	ID       int64  `json:"id"`
	Op       string `json:"op"`
	Type     string `json:"type,omitempty"`
	SDP      string `json:"sdp,omitempty"`
	Mid      string `json:"mid,omitempty"`
	Seconds  int    `json:"seconds,omitempty"`
	TimeoutS int    `json:"timeoutMs,omitempty"`
}

type resp struct {
	ID          int64             `json:"id"`
	OK          bool              `json:"ok"`
	Error       string            `json:"error,omitempty"`
	Offer       *sdpLike          `json:"offer,omitempty"`
	Answer      *sdpLike          `json:"answer,omitempty"`
	AppliedType string            `json:"appliedType,omitempty"`
	State       string            `json:"state,omitempty"`
	Counts      map[string]uint64 `json:"counts,omitempty"`

	Track map[string]any `json:"track,omitempty"`
}

type sdpLike struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type rtpStatsReport struct {
	Packets     uint64 `json:"packets"`
	Bytes       uint64 `json:"bytes"`
	FirstSeq    uint16 `json:"firstSeq"`
	LastSeq     uint16 `json:"lastSeq"`
	FirstTS     uint32 `json:"firstTs"`
	LastTS      uint32 `json:"lastTs"`
	SeqAdvanced bool   `json:"seqAdvanced"`
	TSAdvanced  bool   `json:"tsAdvanced"`
}

func main() {
	dumpDir := flag.String("dump-dir", "", "diagnostic dump dir (default /tmp/free4chat-pion/run-<ts>)")
	flag.Parse()
	if *dumpDir == "" {
		*dumpDir = filepath.Join("/tmp/free4chat-pion", fmt.Sprintf("run-%d", time.Now().Unix()))
	}
	tracer, err := NewTracer(*dumpDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tracer setup failed: %v\n", err)
		os.Exit(1)
	}
	defer tracer.Close()

	out := &stdWriter{mu: sync.Mutex{}, w: bufio.NewWriter(os.Stdout)}
	spike, err := NewMediaSpike(tracer, out.emitEvent)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	for sc.Scan() {
		line := trimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c cmd
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			out.write(resp{OK: false, Error: "bad_command_json: " + err.Error()})
			continue
		}
		r := handleCmd(spike, tracer, c)
		r.ID = c.ID
		out.write(r)
		if c.Op == "close" {
			return
		}
	}
}

func handleCmd(spike *MediaSpike, tracer *Tracer, c cmd) resp {
	switch c.Op {
	case "ping":
		state := "nil"
		if spike.pc != nil {
			state = spike.pc.ConnectionState().String()
		}
		return resp{OK: true, State: state}

	case "init":
		tracer.Stagef("A", "creating PeerConnection + server-events DataChannel (before any offer)")
		if spike.pc == nil {
			if err := spike.Create(); err != nil {
				return resp{OK: false, Error: err.Error()}
			}
		}
		if err := spike.CreateServerEventsChannel(); err != nil {
			return resp{OK: false, Error: "stage A datachannel: " + err.Error()}
		}
		return resp{OK: true}

	case "create-offer":
		tracer.Stagef("B", "CreateOffer + SetLocalDescription + full ICE gathering")
		sdp, err := spike.GatherCompleteOffer()
		if err != nil {
			return resp{OK: false, Error: "stage B: " + err.Error()}
		}
		return resp{OK: true, Offer: sdp}

	case "apply-remote":
		if c.SDP == "" || c.Type == "" {
			return resp{OK: false, Error: "apply-remote requires type+sdp"}
		}
		applied, answer, err := spike.ApplyRemote(sdpLike{Type: c.Type, SDP: c.SDP}, dumpBaseFor(c.Type))
		if err != nil {
			return resp{OK: false, Error: err.Error()}
		}
		r := resp{OK: true, AppliedType: applied}
		if answer != nil {
			r.Answer = answer
		}
		return r

	case "arm-track":
		spike.OnTrackArm(c.Mid)
		return resp{OK: true}

	case "wait-connected":
		timeout := time.Duration(c.TimeoutS) * time.Millisecond
		if timeout <= 0 {
			timeout = connectTimeout
		}
		if err := spike.WaitConnected(timeout); err != nil {
			return resp{OK: false, Error: "stage E: " + err.Error()}
		}
		return resp{OK: true, State: spike.pc.ConnectionState().String()}

	case "rtp-stats":
		counts := spike.RtpCounts()
		return resp{OK: true, Counts: counts}

	case "close":
		spike.Close()
		return resp{OK: true}

	default:
		return resp{OK: false, Error: "unknown op: " + c.Op}
	}
}

func dumpBaseFor(remoteType string) string {
	if remoteType == "offer" {
		return "track-remote-offer"
	}
	return "initial-cloudflare-answer"
}

type stdWriter struct {
	mu sync.Mutex
	w  *bufio.Writer
}

func (s *stdWriter) write(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintln(s.w, string(b))
	s.w.Flush()
}

func (s *stdWriter) emitEvent(ev map[string]any) {
	ev["ev"] = ev["event"]
	delete(ev, "event")
	s.write(ev)
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
