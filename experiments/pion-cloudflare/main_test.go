package main

import (
	"encoding/json"
	"testing"
)

func testTracer(t *testing.T) *Tracer {
	tr, err := NewTracer(t.TempDir())
	if err != nil {
		t.Fatalf("tracer: %v", err)
	}
	return tr
}

// #101 §4: never hard-code the expected description direction.
func TestApplyRemoteRejectsUnknownType(t *testing.T) {
	spike := &MediaSpike{tracer: testTracer(t)}
	_, _, err := spike.ApplyRemote(sdpLike{Type: "pranswer", SDP: "v=0"}, "x")
	if err == nil {
		t.Fatal("expected error for unexpected description type")
	}
	_, _, err = spike.ApplyRemote(sdpLike{Type: "offer", SDP: ""}, "x")
	if err == nil {
		t.Fatal("expected error for empty SDP")
	}
}

func TestHandleCmdUnknownOp(t *testing.T) {
	spike, _ := NewMediaSpike(testTracer(t), func(map[string]any) {})
	r := handleCmd(spike, testTracer(t), cmd{Op: "nope"})
	if r.OK || r.Error != "unknown op: nope" {
		t.Fatalf("unexpected resp: %+v", r)
	}
}

func TestHandleCmdPingBeforeInit(t *testing.T) {
	spike, _ := NewMediaSpike(testTracer(t), func(map[string]any) {})
	r := handleCmd(spike, testTracer(t), cmd{Op: "ping"})
	if !r.OK || r.State != "nil" {
		t.Fatalf("ping before init should report state=nil: %+v", r)
	}
}

func TestRtpStatsReportJSONShape(t *testing.T) {
	b, err := json.Marshal(rtpStatsReport{Packets: 5, Bytes: 500})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back["packets"] != float64(5) || back["bytes"] != float64(500) {
		t.Fatalf("shape drift: %s", b)
	}
}
