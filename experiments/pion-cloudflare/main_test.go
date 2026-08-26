package main

import (
	"encoding/base64"
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

// #83: the JSONL publish ops must map onto the MediaSpike publication
// lifecycle with the same fail-closed behavior the methods enforce directly.
func TestHandleCmdPublishOpsRoundTripAndFailClosed(t *testing.T) {
	spike := newPublishSpike(t)

	pcm := make([]byte, 960) // exactly one 20 ms frame @ 24 kHz mono
	for i := range pcm {
		pcm[i] = byte(i % 251)
	}
	encoded := base64.StdEncoding.EncodeToString(pcm)

	if r := handleCmd(spike, testTracer(t), cmd{Op: "write-pcm", Payload: encoded}); r.OK {
		t.Fatal("write-pcm before activate-publish must fail closed")
	}

	// Create() already armed the outbound track pre-offer; arming again is
	// idempotent.
	if r := handleCmd(spike, testTracer(t), cmd{Op: "arm-publish"}); !r.OK {
		t.Fatalf("arm-publish: %+v", r)
	}
	if r := handleCmd(spike, testTracer(t), cmd{Op: "activate-publish"}); !r.OK {
		t.Fatalf("activate-publish: %+v", r)
	}
	if r := handleCmd(spike, testTracer(t), cmd{Op: "write-pcm", Payload: encoded}); !r.OK {
		t.Fatalf("write-pcm after activate: %+v", r)
	}
	if got := spike.PCMCarry(); len(got) != 0 {
		t.Fatalf("a full 20 ms frame must leave no carry, got %d bytes", len(got))
	}
	if r := handleCmd(spike, testTracer(t), cmd{Op: "flush-audio"}); !r.OK {
		t.Fatalf("flush-audio: %+v", r)
	}

	mid := handleCmd(spike, testTracer(t), cmd{Op: "local-mid"})
	if !mid.OK {
		t.Fatalf("local-mid: %+v", mid)
	}

	if r := handleCmd(spike, testTracer(t), cmd{Op: "deactivate-publish"}); !r.OK {
		t.Fatalf("deactivate-publish: %+v", r)
	}
	if r := handleCmd(spike, testTracer(t), cmd{Op: "write-pcm", Payload: encoded}); r.OK {
		t.Fatal("write-pcm after deactivate-publish must fail closed")
	}

	for _, bad := range []cmd{
		{Op: "write-pcm", Payload: "!!!not-base64!!!"},
		{Op: "write-pcm"},
	} {
		if r := handleCmd(spike, testTracer(t), bad); r.OK {
			t.Fatalf("malformed write-pcm (%+v) must fail closed", bad)
		}
	}
}

func TestLocalMidRespJSONShape(t *testing.T) {
	b, err := json.Marshal(resp{OK: true, Mid: "0"})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back["mid"] != "0" || back["ok"] != true {
		t.Fatalf("shape drift: %s", b)
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
